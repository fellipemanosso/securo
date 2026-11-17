"""Migration 114 on real PostgreSQL: which Pluggy rows move to the Brazilian day."""
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
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction

pytestmark = pytest.mark.asyncio

_MIGRATION_PATH = (
    Path(__file__).resolve().parent.parent
    / "alembic"
    / "versions"
    / "114_pluggy_local_transaction_dates.py"
)
_SPEC = importlib.util.spec_from_file_location("pluggy_local_dates_migration", _MIGRATION_PATH)
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


def _connection(user_id, provider: str) -> BankConnection:
    return BankConnection(
        id=uuid.uuid4(), user_id=user_id, provider=provider, external_id=f"item-{provider}",
        institution_name="Bank", credentials={}, status="active",
        created_at=datetime.now(timezone.utc),
    )


def _account(user_id, connection, account_type: str) -> Account:
    return Account(
        id=uuid.uuid4(), user_id=user_id, connection_id=connection.id, name=account_type,
        type=account_type, balance=Decimal("0"), currency="BRL",
        statement_close_day=24 if account_type == "credit_card" else None,
        payment_due_day=1 if account_type == "credit_card" else None,
    )


def _row(account, user_id, stored: date, raw_date: str, effective: date, **fields):
    return Transaction(
        id=uuid.uuid4(), user_id=user_id, account_id=account.id, description="Compra",
        amount=Decimal("10"), date=stored, effective_date=effective, type="debit",
        currency="BRL", source="sync", status="pending", raw_data={"date": raw_date},
        created_at=datetime.now(timezone.utc), **fields,
    )


async def test_moves_late_pluggy_purchases_to_the_brazilian_day(session, test_user, monkeypatch):
    pluggy, other = _connection(test_user.id, "pluggy"), _connection(test_user.id, "other")
    session.add_all([pluggy, other])
    await session.flush()
    card = _account(test_user.id, pluggy, "credit_card")
    checking = _account(test_user.id, pluggy, "checking")
    elsewhere = _account(test_user.id, other, "checking")
    session.add_all([card, checking, elsewhere])
    await session.flush()
    bill = CreditCardBill(
        user_id=test_user.id, account_id=card.id, external_id="bill-nov",
        due_date=date(2026, 11, 1), closing_date=date(2026, 10, 24),
        total_amount=Decimal("10"), currency="BRL",
    )
    session.add(bill)
    await session.flush()

    late = "2026-10-24T01:12:00.000Z"
    oct24, oct23 = date(2026, 10, 24), date(2026, 10, 23)
    rows = {
        "card_open": _row(card, test_user.id, oct24, late, date(2026, 12, 1)),
        "card_billed": _row(card, test_user.id, oct24, late, date(2026, 11, 1), bill_id=bill.id),
        "checking": _row(checking, test_user.id, oct24, late, oct24),
        "midnight": _row(checking, test_user.id, oct24, "2026-10-24T00:00:00.000Z", oct24),
        # Already moved off the UTC day on purpose (Mercado Pago installments).
        "shifted": _row(checking, test_user.id, date(2026, 12, 24), late, date(2026, 12, 24)),
        "other_provider": _row(elsewhere, test_user.id, oct24, late, oct24),
    }
    session.add_all(rows.values())
    await session.flush()

    await _upgrade(session, monkeypatch)

    stored = {
        row.id: (row.date, row.effective_date)
        for row in (
            await session.execute(select(Transaction.id, Transaction.date, Transaction.effective_date))
        ).all()
    }

    # Bought the day before the close now: on the November bill.
    assert stored[rows["card_open"].id] == (oct23, date(2026, 11, 1))
    assert stored[rows["card_billed"].id] == (oct23, date(2026, 11, 1))
    assert stored[rows["checking"].id] == (oct23, oct23)
    assert stored[rows["midnight"].id] == (oct24, oct24)
    assert stored[rows["shifted"].id] == (date(2026, 12, 24), date(2026, 12, 24))
    assert stored[rows["other_provider"].id] == (oct24, oct24)
