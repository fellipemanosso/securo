"""Migration 111 on real PostgreSQL through asyncpg, as production runs it."""
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
    / "111_recompute_credit_card_effective_dates.py"
)
_SPEC = importlib.util.spec_from_file_location("cc_effective_dates_migration", _MIGRATION_PATH)
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


async def test_recomputes_card_effective_dates_across_pages(session, test_user, monkeypatch):
    # Several pages exercise the batched UPDATE that asyncpg rejected on a
    # streaming cursor in production.
    monkeypatch.setattr(migration, "_BATCH_SIZE", 2)
    card = Account(
        id=uuid.uuid4(), user_id=test_user.id, name="Card", type="credit_card",
        balance=Decimal("0"), currency="BRL", statement_close_day=10, payment_due_day=17,
    )
    session.add(card)
    purchases = {
        date(2026, 5, 1): date(2026, 5, 17),
        date(2026, 5, 9): date(2026, 5, 17),
        date(2026, 5, 10): date(2026, 6, 17),
        date(2026, 5, 11): date(2026, 6, 17),
        date(2026, 12, 10): date(2027, 1, 17),
    }
    rows = {
        purchase: Transaction(
            id=uuid.uuid4(), user_id=test_user.id, account_id=card.id,
            description="Compra", amount=Decimal("10"), date=purchase,
            effective_date=purchase, type="debit", currency="BRL", source="manual",
            status="posted", created_at=datetime.now(timezone.utc),
        )
        for purchase in purchases
    }
    session.add_all(rows.values())
    await session.flush()

    await _upgrade(session, monkeypatch)

    stored = dict(
        (await session.execute(
            select(Transaction.date, Transaction.effective_date)
            .where(Transaction.account_id == card.id)
            .execution_options(populate_existing=True)
        )).all()
    )
    assert stored == purchases
