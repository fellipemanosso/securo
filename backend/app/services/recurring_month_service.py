"""Where each recurring commitment of a month stands: paid, pending or overdue.

A month's occurrences come from two places, the same two the dashboard
projections read. An occurrence that already has a linked transaction
(generated, paid by hand or matched to a bank charge) is that transaction;
one that does not is projected from the schedule's pointer, exactly as
``dashboard_service.get_projected_transactions`` projects it, so the month
page and the dashboard never disagree about what is still expected.
"""
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.app_clock import app_today
from app.core.config import get_settings
from app.models.category import Category
from app.models.recurring_transaction import RecurringTransaction
from app.models.transaction import Transaction
from app.models.user import User
from app.schemas.recurring_month import RecurringMonthOccurrence, RecurringOccurrenceStatus
from app.services.dashboard_service import _month_range
from app.services.fx_rate_service import _resolve_rate
from app.services._query_filters import not_on_hidden_cards
from app.services.recurring_transaction_service import get_occurrences_in_range


def occurrence_status(due: date, today: date, settled: bool) -> RecurringOccurrenceStatus:
    """Paid once settled; otherwise overdue when its date has passed."""
    if settled:
        return "paid"
    return "overdue" if due < today else "pending"


def is_settled(transaction: Transaction, today: date) -> bool:
    """Whether a linked transaction means the occurrence was paid.

    A row dated after today is still a forecast (generate-ahead). A pending
    placeholder Securo generated on a bank-synced account waits for the bank
    to confirm the charge, so it is not paid yet. A real charge, even one the
    bank still lists as pending, already happened.
    """
    if transaction.date > today:
        return False
    return not (transaction.source == "recurring" and transaction.status == "pending")


async def get_month_status(
    session: AsyncSession,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    month: date,
    account_ids: Optional[list[uuid.UUID]] = None,
) -> list[RecurringMonthOccurrence]:
    """Every recurring occurrence of ``month``, linked or still expected.

    ``account_ids`` narrows to the active collection's accounts; an empty list
    means a collection without accounts, so nothing is returned.
    """
    if account_ids is not None and len(account_ids) == 0:
        return []
    month_start, month_end = _month_range(month)
    today = app_today()

    # Every linked row settles its occurrence, but one charged to a hidden
    # card (Cartão Oculto) is not listed: hiding the card takes the payment,
    # and the occurrence it settled, off the screen.
    linked_stmt = select(Transaction, not_on_hidden_cards().label("visible")).where(
        Transaction.workspace_id == workspace_id,
        Transaction.recurring_transaction_id.is_not(None),
        Transaction.date >= month_start,
        Transaction.date < month_end,
    )
    if account_ids:
        linked_stmt = linked_stmt.where(Transaction.account_id.in_(account_ids))
    linked_rows = (await session.execute(linked_stmt)).all()
    linked = [tx for tx, _ in linked_rows]
    visible_linked = [tx for tx, visible in linked_rows if visible]
    linked_ids = {tx.recurring_transaction_id for tx in linked}

    # Active schedules project what is still expected; a schedule ended
    # after this month's payment still owns that payment.
    recurring_stmt = (
        select(RecurringTransaction)
        .outerjoin(Category, RecurringTransaction.category_id == Category.id)
        .where(
            RecurringTransaction.workspace_id == workspace_id,
            or_(
                RecurringTransaction.is_active == True,  # noqa: E712
                RecurringTransaction.id.in_(linked_ids),
            ),
            or_(
                RecurringTransaction.category_id.is_(None),
                Category.is_ignored.is_not(True),
            ),
        )
        .options(selectinload(RecurringTransaction.category))
    )
    if account_ids:
        recurring_stmt = recurring_stmt.where(RecurringTransaction.account_id.in_(account_ids))
    recurring_list = list((await session.execute(recurring_stmt)).scalars().all())

    user = await session.get(User, user_id)
    primary_currency = user.primary_currency if user else get_settings().default_currency
    rates: dict[str, Optional[Decimal]] = {}

    async def to_primary(amount: Decimal, currency: str) -> Optional[float]:
        if currency == primary_currency:
            return float(amount)
        if currency not in rates:
            rates[currency] = await _resolve_rate(session, currency, primary_currency)
        rate = rates[currency]
        if rate is None:
            return None
        return float((Decimal(str(amount)) * rate).quantize(Decimal("0.01")))

    linked_by_recurring: dict[uuid.UUID, list[Transaction]] = {}
    for tx in visible_linked:
        linked_by_recurring.setdefault(tx.recurring_transaction_id, []).append(tx)
    materialized = {(tx.recurring_transaction_id, tx.date) for tx in linked}

    occurrences: list[RecurringMonthOccurrence] = []
    for rec in recurring_list:
        category = rec.category
        expected_primary = await to_primary(rec.amount, rec.currency)
        base = {
            "recurring_id": rec.id,
            "description": rec.description,
            "account_id": rec.account_id,
            "category_id": rec.category_id,
            "category_name": category.name if category else None,
            "category_icon": category.icon if category else None,
            "category_color": category.color if category else None,
            "type": rec.type,
            "frequency": rec.frequency,
            "currency": rec.currency,
            "expected_amount": float(rec.amount),
            "expected_amount_primary": expected_primary,
        }
        for tx in linked_by_recurring.get(rec.id, ()):
            settled = is_settled(tx, today)
            paid_primary = (
                float(tx.amount) if tx.currency == primary_currency
                else float(tx.amount_primary) if tx.amount_primary is not None
                else None
            )
            occurrences.append(RecurringMonthOccurrence(
                **base,
                date=tx.date,
                status=occurrence_status(tx.date, today, settled),
                transaction_id=tx.id,
                paid_amount=float(tx.amount) if settled else None,
                paid_amount_primary=paid_primary if settled else None,
            ))
        if not rec.is_active:
            continue
        for occurrence in get_occurrences_in_range(
            start=rec.next_occurrence,
            frequency=rec.frequency,
            end_date=rec.end_date,
            range_start=month_start,
            range_end=month_end,
            intended_day=rec.day_of_month or rec.start_date.day,
            weekend_adjustment=rec.weekend_adjustment,
        ):
            if (rec.id, occurrence) in materialized:
                continue
            occurrences.append(RecurringMonthOccurrence(
                **base,
                date=occurrence,
                status=occurrence_status(occurrence, today, False),
            ))

    occurrences.sort(key=lambda item: (item.date, item.description.lower()))
    return occurrences
