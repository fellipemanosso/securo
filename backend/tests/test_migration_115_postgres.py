"""Migration 115 on real PostgreSQL: installment purchase dates in Brasília."""
import importlib.util
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy import select, text

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.transaction import Transaction

pytestmark = pytest.mark.asyncio

_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic"
    / "versions"
    / "115_pluggy_local_purchase_dates.py"
)
_SPEC = importlib.util.spec_from_file_location("pluggy_purchase_dates_migration", _MIGRATION_PATH)
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


async def test_one_bradesco_purchase_gets_one_purchase_date(session, test_user, monkeypatch):
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="pluggy", external_id="item",
        institution_name="Bradesco", credentials={}, status="active",
        created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.flush()
    card = Account(
        id=uuid.uuid4(), user_id=test_user.id, connection_id=conn.id, name="Card",
        type="credit_card", balance=Decimal("0"), currency="BRL",
    )
    session.add(card)
    await session.flush()

    def installment(number: int, stored: date, purchase: str) -> Transaction:
        return Transaction(
            id=uuid.uuid4(), user_id=test_user.id, account_id=card.id,
            description="NOVA *NOVA", amount=Decimal("153.62"), date=date(2026, 7, 15),
            effective_date=date(2026, 7, 15), type="debit", currency="BRL", source="sync",
            status="posted", installment_number=number, total_installments=10,
            installment_purchase_date=stored,
            raw_data={"creditCardMetadata": {"purchaseDate": purchase}},
            created_at=datetime.now(timezone.utc),
        )

    rows = [
        installment(1, date(2026, 6, 16), "2026-06-16T00:43:54.067Z"),
        installment(3, date(2026, 6, 15), "2026-06-15T03:00:00.000Z"),
        installment(4, date(2026, 6, 16), "2026-06-16T00:32:23.047Z"),
    ]
    session.add_all(rows)
    await session.flush()

    await _upgrade(session, monkeypatch)

    purchase_dates = set(
        (
            await session.execute(
                select(Transaction.installment_purchase_date).where(
                    Transaction.account_id == card.id
                )
            )
        ).scalars()
    )
    assert purchase_dates == {date(2026, 6, 15)}
