"""A card whose connector sends no cycle days takes them from its bank bills.

C6 through Pluggy sends the due day (1) but no closing day. Its bills carry
both dates: the latest closed on 2026-10-24 and was due on 2026-11-01.
"""

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.transaction import Transaction
from app.providers.base import AccountData, BillData, TransactionData
from app.services.connection_service import sync_connection


def _bill(external_id: str, closing: date, due: date) -> BillData:
    return BillData(
        external_id=external_id, due_date=due, closing_date=closing,
        total_amount=Decimal("100"), currency="BRL",
    )


async def _sync(session, test_user, test_workspace, conn, *, close_day, txns, bills):
    provider = AsyncMock()
    provider.refresh_credentials = AsyncMock(return_value={"token": "t"})
    provider.get_accounts = AsyncMock(return_value=[
        AccountData(
            external_id="c6", name="BANDEIRADO", type="credit_card",
            balance=Decimal("0"), currency="BRL",
            statement_close_day=close_day, payment_due_day=1,
        )
    ])
    provider.get_transactions = AsyncMock(return_value=txns)
    provider.get_bills = AsyncMock(return_value=bills)
    with patch("app.services.connection_service.get_provider", return_value=provider), \
         patch("app.services.connection_service.detect_transfer_pairs", new_callable=AsyncMock), \
         patch("app.services.connection_service.stamp_primary_amount", new_callable=AsyncMock), \
         patch("app.services.connection_service.apply_rules_to_transaction", new_callable=AsyncMock):
        await sync_connection(session, conn.id, test_workspace.id, test_user.id)


async def _connection(session, test_user) -> BankConnection:
    conn = BankConnection(
        id=uuid.uuid4(), user_id=test_user.id, provider="test",
        external_id="item", institution_name="C6", credentials={"token": "t"},
        status="active", created_at=datetime.now(timezone.utc),
    )
    session.add(conn)
    await session.commit()
    return conn


BILLS = [
    _bill("bill-oct", date(2026, 9, 25), date(2026, 10, 1)),
    _bill("bill-nov", date(2026, 10, 24), date(2026, 11, 1)),
]


@pytest.mark.asyncio
async def test_missing_closing_day_comes_from_the_latest_bill_and_places_open_charges(
    session, test_user, test_workspace
):
    conn = await _connection(session, test_user)
    open_charge = TransactionData(
        external_id="open", description="Mercado", amount=Decimal("50"),
        date=date(2026, 11, 10), type="debit", currency="BRL",
    )

    await _sync(
        session, test_user, test_workspace, conn,
        close_day=None, txns=[open_charge], bills=BILLS,
    )

    card = (await session.execute(select(Account).where(Account.external_id == "c6"))).scalar_one()
    assert (card.statement_close_day, card.payment_due_day) == (24, 1)
    charge = (
        await session.execute(select(Transaction).where(Transaction.external_id == "open"))
    ).scalar_one()
    # Closes 2026-11-24, due on the 1st after it.
    assert charge.effective_date == date(2026, 12, 1)


@pytest.mark.asyncio
async def test_a_closing_day_the_bank_sends_is_kept(session, test_user, test_workspace):
    conn = await _connection(session, test_user)

    await _sync(session, test_user, test_workspace, conn, close_day=20, txns=[], bills=BILLS)

    card = (await session.execute(select(Account).where(Account.external_id == "c6"))).scalar_one()
    assert card.statement_close_day == 20
