"""Migration 113 on real PostgreSQL: which bank forecasts it keeps."""
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
    / "113_drop_non_deferring_bill_forecasts.py"
)
_SPEC = importlib.util.spec_from_file_location("non_deferring_forecasts_migration", _MIGRATION_PATH)
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


def _card(user_id, close_day: int, due_day: int) -> Account:
    return Account(
        id=uuid.uuid4(), user_id=user_id, name="Card", type="credit_card",
        balance=Decimal("0"), currency="BRL",
        statement_close_day=close_day, payment_due_day=due_day,
    )


def _placed(card, user_id, purchase: date, placement: date) -> Transaction:
    return Transaction(
        id=uuid.uuid4(), user_id=user_id, account_id=card.id, description="Compra",
        amount=Decimal("10"), date=purchase, effective_date=placement,
        type="debit", currency="BRL", source="sync", status="pending",
        effective_bill_date=placement, effective_bill_date_source="provider",
        created_at=datetime.now(timezone.utc),
    )


async def test_keeps_deferring_forecasts_and_drops_the_rest(session, test_user, monkeypatch):
    c6 = _card(test_user.id, close_day=24, due_day=1)
    nubank = _card(test_user.id, close_day=2, due_day=9)
    session.add_all([c6, nubank])
    await session.flush()
    rows = {
        # C6: forecast "2026-10" for a purchase after the October close.
        "c6_open": _placed(c6, test_user.id, date(2026, 10, 27), date(2026, 10, 1)),
        # Nubank: forecast equal to cycle math defers nothing either.
        "nubank_regular": _placed(nubank, test_user.id, date(2026, 10, 20), date(2026, 11, 9)),
        # Nubank Pix no crédito, billed two bills later.
        "nubank_pix": _placed(nubank, test_user.id, date(2026, 10, 31), date(2027, 1, 9)),
    }
    session.add_all(rows.values())
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

    assert stored[rows["c6_open"].id] == (None, None, date(2026, 12, 1))
    assert stored[rows["nubank_regular"].id] == (None, None, date(2026, 11, 9))
    assert stored[rows["nubank_pix"].id] == (date(2027, 1, 9), "provider", date(2027, 1, 9))
