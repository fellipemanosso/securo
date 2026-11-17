"""Upcoming installments of synced credit-card purchases.

Banks send an installment only once it is billed (C6 through Pluggy sends
installment k when it lands on a statement, never k+1 ahead of time), so a
statement projection built from synced rows misses the installments of older
purchases. This module derives them from the latest installment synced for
each purchase. Nothing is stored: as soon as the bank sends installment k+1,
the forecast for it disappears because k+1 is the new latest one.
"""

from __future__ import annotations

import calendar
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.app_clock import app_today
from app.models.account import Account
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.services._query_filters import not_on_hidden_cards


@dataclass(frozen=True)
class InstallmentForecast:
    key: str
    account_id: uuid.UUID
    description: str
    amount: Decimal
    currency: str
    type: str
    purchase_date: date
    due_date: date
    installment_number: int
    total_installments: int
    category_id: Optional[uuid.UUID]
    card_last4: Optional[str]


def _months_later(value: date, months: int, day: int) -> date:
    month_index = value.month - 1 + months
    year, month = value.year + month_index // 12, month_index % 12 + 1
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


async def forecast_installments(
    session: AsyncSession,
    account_ids: Sequence[uuid.UUID],
) -> list[InstallmentForecast]:
    """Installments still to be billed on the given connected credit cards.

    A purchase is identified by card, purchase date and installment count.
    Its latest synced installment k fixes the bill it is on; installment
    k + j goes on the bill j months later. Bills already closed are left out:
    a missing installment there is the bank's record, not a forecast.
    """
    if not account_ids:
        return []
    accounts = {
        account.id: account
        for account in (
            await session.execute(
                select(Account).where(
                    Account.id.in_(account_ids),
                    Account.type == "credit_card",
                    Account.connection_id.is_not(None),
                )
            )
        ).scalars()
    }
    if not accounts:
        return []

    bills = list(
        (
            await session.execute(
                select(CreditCardBill).where(CreditCardBill.account_id.in_(accounts))
            )
        ).scalars()
    )
    due_by_bill = {bill.id: bill.due_date for bill in bills}
    today = app_today()
    last_closed_due: dict[uuid.UUID, date] = {}
    for bill in bills:
        if bill.source == "bank" and bill.closing_date is not None and bill.closing_date < today:
            current = last_closed_due.get(bill.account_id)
            if current is None or bill.due_date > current:
                last_closed_due[bill.account_id] = bill.due_date

    rows = (
        await session.execute(
            select(Transaction).where(
                Transaction.account_id.in_(accounts),
                Transaction.source == "sync",
                Transaction.is_ignored.is_(False),
                Transaction.installment_number.is_not(None),
                Transaction.total_installments.is_not(None),
                Transaction.installment_purchase_date.is_not(None),
                not_on_hidden_cards(),
            )
        )
    ).scalars()
    purchases: dict[tuple, list[Transaction]] = defaultdict(list)
    for row in rows:
        purchases[
            (row.account_id, row.card_last4, row.installment_purchase_date, row.total_installments)
        ].append(row)

    forecasts: list[InstallmentForecast] = []
    for (account_id, _, purchase_date, total), installments in purchases.items():
        latest_number = max(row.installment_number for row in installments)
        if latest_number >= total:
            continue
        account = accounts[account_id]
        closed_due = last_closed_due.get(account_id)
        # Two purchases on the same card and day with the same count share a
        # key; each latest row carries its own purchase forward.
        latest_rows = sorted(
            (row for row in installments if row.installment_number == latest_number),
            key=lambda row: str(row.id),
        )
        for row in latest_rows:
            base_due = (
                due_by_bill.get(row.bill_id)
                if row.bill_id is not None
                else None
            ) or row.effective_bill_date or row.effective_date
            due_day = account.payment_due_day or base_due.day
            for later in range(1, total - latest_number + 1):
                due = _months_later(base_due, later, due_day)
                if closed_due is not None and due <= closed_due:
                    continue
                number = latest_number + later
                forecasts.append(
                    InstallmentForecast(
                        key=f"{row.id}:{number}",
                        account_id=account_id,
                        description=row.description,
                        amount=row.amount,
                        currency=row.currency,
                        type=row.type,
                        purchase_date=purchase_date,
                        due_date=due,
                        installment_number=number,
                        total_installments=total,
                        category_id=row.category_id,
                        card_last4=row.card_last4,
                    )
                )
    return forecasts


def on_bill(forecasts: Sequence[InstallmentForecast], previous_due: date, due: date):
    """The forecasts billed on the statement due on `due`.

    Same rule as a bill placement: due after the previous statement's due
    date and on or before this one's."""
    return [forecast for forecast in forecasts if previous_due < forecast.due_date <= due]
