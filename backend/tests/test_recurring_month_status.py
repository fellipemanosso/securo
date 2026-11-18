"""Where each recurring commitment of a month stands (Mês page)."""
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.services.recurring_month_service import get_month_status

TODAY = date(2026, 11, 18)
NOVEMBER = date(2026, 11, 1)


@pytest.fixture(autouse=True)
def _frozen_today(monkeypatch):
    monkeypatch.setattr("app.services.recurring_month_service.app_today", lambda: TODAY)


@pytest_asyncio.fixture
async def account(session: AsyncSession, test_user, test_workspace) -> Account:
    account = Account(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Conta",
        type="checking",
        balance=Decimal("0"),
        currency="BRL",
    )
    session.add(account)
    await session.commit()
    return account


async def _recurring(
    session: AsyncSession,
    owner: Account,
    description: str,
    amount: str,
    next_occurrence: date,
    *,
    type: str = "debit",
    is_active: bool = True,
    category_id: Optional[uuid.UUID] = None,
) -> RecurringTransaction:
    recurring = RecurringTransaction(
        id=uuid.uuid4(),
        user_id=owner.user_id,
        workspace_id=owner.workspace_id,
        account_id=owner.id,
        category_id=category_id,
        description=description,
        amount=Decimal(amount),
        currency="BRL",
        type=type,
        frequency="monthly",
        start_date=date(2026, 1, next_occurrence.day),
        next_occurrence=next_occurrence,
        is_active=is_active,
    )
    session.add(recurring)
    await session.commit()
    return recurring


async def _linked(
    session: AsyncSession,
    recurring: RecurringTransaction,
    amount: str,
    on: date,
    *,
    source: str = "manual",
    status: str = "posted",
) -> Transaction:
    transaction = Transaction(
        id=uuid.uuid4(),
        user_id=recurring.user_id,
        workspace_id=recurring.workspace_id,
        account_id=recurring.account_id,
        description=recurring.description,
        amount=Decimal(amount),
        currency="BRL",
        date=on,
        type=recurring.type,
        source=source,
        status=status,
        recurring_transaction_id=recurring.id,
    )
    session.add(transaction)
    await session.commit()
    return transaction


@pytest.mark.asyncio
async def test_month_status_paid_pending_and_overdue(
    session: AsyncSession, test_user, test_workspace, account
):
    rent = await _recurring(session, account, "Aluguel", "1500", date(2026, 12, 5))
    rent_payment = await _linked(session, rent, "1500", date(2026, 11, 5))
    internet = await _recurring(session, account, "Internet", "120", date(2026, 11, 10))
    gym = await _recurring(session, account, "Academia", "90", date(2026, 11, 25))
    salary = await _recurring(
        session, account, "Salário", "5000", date(2026, 12, 5), type="credit"
    )
    await _linked(session, salary, "5100", date(2026, 11, 5))

    rows = await get_month_status(session, test_workspace.id, test_user.id, NOVEMBER)
    by_id = {row.recurring_id: row for row in rows}

    assert len(rows) == 4
    assert by_id[rent.id].status == "paid"
    assert by_id[rent.id].transaction_id == rent_payment.id
    assert by_id[rent.id].paid_amount == 1500
    assert by_id[internet.id].status == "overdue"
    assert by_id[internet.id].date == date(2026, 11, 10)
    assert by_id[internet.id].paid_amount is None
    assert by_id[gym.id].status == "pending"
    assert by_id[gym.id].expected_amount == 90
    # Paid amount is what moved, the expected one stays the schedule's.
    assert by_id[salary.id].status == "paid"
    assert by_id[salary.id].expected_amount == 5000
    assert by_id[salary.id].paid_amount == 5100
    assert by_id[salary.id].paid_amount_primary == 5100
    assert [row.date for row in rows] == sorted(row.date for row in rows)


@pytest.mark.asyncio
async def test_unconfirmed_and_future_links_are_not_paid(
    session: AsyncSession, test_user, test_workspace, account
):
    # A placeholder Securo generated on a synced account waits for the bank.
    streaming = await _recurring(session, account, "Streaming", "40", date(2026, 12, 12))
    placeholder = await _linked(
        session, streaming, "40", date(2026, 11, 12), source="recurring", status="pending"
    )
    # A real charge the bank still lists as pending already happened.
    phone = await _recurring(session, account, "Celular", "60", date(2026, 12, 8))
    await _linked(session, phone, "60", date(2026, 11, 8), source="sync", status="pending")
    # Generate-ahead row dated later this month is still a forecast.
    school = await _recurring(session, account, "Escola", "800", date(2026, 12, 28))
    await _linked(session, school, "800", date(2026, 11, 28), source="recurring")

    rows = await get_month_status(session, test_workspace.id, test_user.id, NOVEMBER)
    by_id = {row.recurring_id: row for row in rows}

    assert by_id[streaming.id].status == "overdue"
    assert by_id[streaming.id].transaction_id == placeholder.id
    assert by_id[streaming.id].paid_amount is None
    assert by_id[phone.id].status == "paid"
    assert by_id[school.id].status == "pending"
    assert by_id[school.id].paid_amount is None


@pytest.mark.asyncio
async def test_ignored_inactive_and_filtered_schedules_stay_out(
    session: AsyncSession, test_user, test_workspace, account
):
    ignored = Category(
        id=uuid.uuid4(),
        user_id=test_user.id,
        workspace_id=test_workspace.id,
        name="Ignorada",
        icon="x",
        color="#000000",
        is_ignored=True,
    )
    session.add(ignored)
    await session.commit()
    await _recurring(
        session, account, "Ignorada", "10", date(2026, 11, 20), category_id=ignored.id
    )
    await _recurring(session, account, "Encerrada", "10", date(2026, 11, 20), is_active=False)
    # Ended after paying this month: the payment still belongs to it.
    ended = await _recurring(
        session, account, "Encerrada paga", "30", date(2026, 12, 3), is_active=False
    )
    await _linked(session, ended, "30", date(2026, 11, 3))

    rows = await get_month_status(session, test_workspace.id, test_user.id, NOVEMBER)
    assert [(row.recurring_id, row.status) for row in rows] == [(ended.id, "paid")]

    assert await get_month_status(
        session, test_workspace.id, test_user.id, NOVEMBER, account_ids=[]
    ) == []
    assert await get_month_status(
        session, test_workspace.id, test_user.id, NOVEMBER, account_ids=[uuid.uuid4()]
    ) == []


@pytest.mark.asyncio
async def test_month_status_endpoint(
    client, auth_headers, session: AsyncSession, test_user, test_workspace, account
):
    await _recurring(session, account, "Internet", "120", date(2026, 11, 10))

    response = await client.get(
        "/api/recurring-transactions/month-status",
        params={"month": "2026-11-01", "account_ids": [str(account.id)]},
        headers=auth_headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["status"] == "overdue"
    assert body[0]["date"] == "2026-11-10"
    assert body[0]["expected_amount"] == 120
