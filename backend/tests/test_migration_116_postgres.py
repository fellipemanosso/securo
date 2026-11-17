"""Migration 116 on real PostgreSQL: future installments on their forecast bill."""
import importlib.util
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.account import Account
from app.models.transaction import Transaction

pytestmark = pytest.mark.asyncio

_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic"
    / "versions"
    / "116_place_forecast_installments.py"
)
_SPEC = importlib.util.spec_from_file_location("forecast_installments_migration", _MIGRATION_PATH)
assert _SPEC is not None and _SPEC.loader is not None
migration = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(migration)


@pytest_asyncio.fixture
async def session(postgres_sessions):
    async with postgres_sessions() as session:
        yield session
        await session.rollback()


@pytest.fixture
def clean_db(postgres_sessions):
    """The reused user fixture starts in a fresh per-test PostgreSQL schema."""


async def _upgrade(session, monkeypatch) -> None:
    schema = session.bind.get_execution_options()["schema_translate_map"][None]
    conn = await session.connection()
    # The migration's raw SQL bypasses schema_translate_map.
    await conn.execute(text(f'SET LOCAL search_path TO "{schema}"'))

    def run(sync_conn):
        monkeypatch.setattr(migration.op, "get_bind", lambda: sync_conn)
        migration.upgrade()

    await conn.run_sync(run)


async def test_places_itau_installments_and_leaves_c6_charges(session, test_user, monkeypatch):
    itau = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="LATAM PASS", type="credit_card",
        balance=Decimal("0"), currency="BRL", statement_close_day=4, payment_due_day=11,
    )
    c6 = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="BANDEIRADO", type="credit_card",
        balance=Decimal("0"), currency="BRL", statement_close_day=24, payment_due_day=1,
    )
    session.add_all([itau, c6])
    await session.flush()

    def installment(card, stored, effective, number, purchase, forecast) -> Transaction:
        return Transaction(
            id=uuid.uuid4(), user_id=test_user.id, account_id=card.id, description="Parcela",
            amount=Decimal("10"), date=stored, effective_date=effective, type="debit",
            currency="BRL", source="sync", status="pending",
            installment_number=number, total_installments=12,
            installment_purchase_date=purchase,
            raw_data={"creditCardMetadata": {"billForecastDate": forecast}},
            created_at=datetime.now(timezone.utc),
        )

    rafaela = installment(
        itau, date(2026, 12, 11), date(2027, 1, 11), 10, date(2026, 2, 4), "2026-12"
    )
    # C6's forecast names the bill that closed before the purchase.
    jussara = installment(
        c6, date(2026, 10, 28), date(2026, 12, 1), 1, date(2026, 10, 28), "2026-10"
    )
    session.add_all([rafaela, jussara])
    await session.flush()

    await _upgrade(session, monkeypatch)

    stored = {
        row.id: (row.effective_bill_date, row.effective_bill_date_source, row.effective_date)
        for row in (
            await session.execute(
                select(
                    Transaction.id,
                    Transaction.effective_bill_date,
                    Transaction.effective_bill_date_source,
                    Transaction.effective_date,
                )
            )
        ).all()
    }
    assert stored[rafaela.id] == (date(2026, 12, 11), "provider", date(2026, 12, 11))
    assert stored[jussara.id] == (None, None, date(2026, 12, 1))
