"""Migration 112 on real PostgreSQL: which charges it places on their forecast bill."""
import importlib.util
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.account import Account
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction

pytestmark = pytest.mark.asyncio

_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic"
    / "versions"
    / "112_provider_bill_forecast.py"
)
_SPEC = importlib.util.spec_from_file_location("provider_bill_forecast_migration", _MIGRATION_PATH)
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


def _charge(card, user_id, raw_data, **fields) -> Transaction:
    return Transaction(
        id=uuid.uuid4(), user_id=user_id, account_id=card.id, description="Compra",
        amount=Decimal("10"), date=date(2026, 10, 31), effective_date=date(2026, 11, 9),
        type="debit", currency="BRL", source="sync", status="pending",
        raw_data=raw_data, created_at=datetime.now(timezone.utc), **fields,
    )


def _forecast(month) -> dict:
    return {"creditCardMetadata": {"billForecastDate": month}}


async def test_places_unbilled_charges_and_keeps_bills_and_manual_placements(
    session, test_user, monkeypatch
):
    card = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="Card", type="credit_card",
        balance=Decimal("0"), currency="BRL", statement_close_day=2, payment_due_day=31,
    )
    session.add(card)
    await session.flush()
    bill = CreditCardBill(
        user_id=test_user.id, account_id=card.id, external_id="bill-nov",
        due_date=date(2026, 11, 30), total_amount=Decimal("10"), currency="BRL",
    )
    session.add(bill)
    await session.flush()
    rows = {
        "forecast": _charge(card, test_user.id, _forecast("2027-01")),
        "short_month": _charge(card, test_user.id, _forecast("2027-02")),
        "billed": _charge(card, test_user.id, _forecast("2027-01"), bill_id=bill.id),
        "manual": _charge(
            card, test_user.id, _forecast("2027-01"), effective_bill_date=date(2026, 12, 31)
        ),
        "malformed": _charge(card, test_user.id, _forecast("2027-13")),
        "not_an_object": _charge(card, test_user.id, ["2027-01"]),
    }
    session.add_all(rows.values())
    await session.flush()

    await _upgrade(session, monkeypatch)

    stored = {
        row.id: row
        for row in (
            await session.execute(
                select(
                    Transaction.id,
                    Transaction.effective_bill_date,
                    Transaction.effective_bill_date_source,
                    Transaction.effective_date,
                ).where(Transaction.account_id == card.id)
            )
        ).all()
    }

    def placement(name):
        row = stored[rows[name].id]
        return row.effective_bill_date, row.effective_bill_date_source, row.effective_date

    nov = date(2026, 11, 9)
    assert placement("forecast") == (date(2027, 1, 31), "provider", date(2027, 1, 31))
    assert placement("short_month") == (date(2027, 2, 28), "provider", date(2027, 2, 28))
    assert placement("billed") == (None, None, nov)
    assert placement("manual") == (date(2026, 12, 31), "manual", nov)
    assert placement("malformed") == (None, None, nov)
    assert placement("not_an_object") == (None, None, nov)
