"""Canonical credit-card statement timeline.

The interface deliberately returns domain items rather than query parameters.  Callers
never choose statement precedence or reconstruct billing-cycle windows themselves.
"""

from __future__ import annotations

import calendar
import uuid
from dataclasses import dataclass, replace
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal, Optional, Sequence

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.services._query_filters import counts_on_bill, not_on_hidden_cards


@dataclass(frozen=True)
class TimelineItem:
    account_id: uuid.UUID
    due_month: str
    kind: Literal["statement", "projection", "unavailable"]
    cycle_key: Optional[str]
    start: Optional[date]
    end: Optional[date]
    closing_date: Optional[date]
    due_date: Optional[date]
    amount: Optional[Decimal]
    primary_amount: Optional[Decimal]
    source: Optional[Literal["bank", "manual"]]
    record_id: Optional[uuid.UUID]
    status: Optional[Literal["open", "paid"]]
    editable: bool
    unavailable_reason: Optional[
        Literal["past_statement_missing", "missing_close_config", "missing_due_config"]
    ]


@dataclass(frozen=True)
class CardTimeline:
    items: tuple[TimelineItem, ...]
    default_key: Optional[str]


@dataclass(frozen=True)
class CycleScope:
    account_id: uuid.UUID
    cycle_key: str
    bill_id: Optional[uuid.UUID]
    start: date
    end: date
    projection: bool


class StaleCycleKeyError(ValueError):
    pass


def _month_start(value: date) -> date:
    return value.replace(day=1)


def _next_month(value: date) -> date:
    return date(value.year + (value.month == 12), 1 if value.month == 12 else value.month + 1, 1)


def _months(first: date, last: date):
    current = _month_start(first)
    end = _month_start(last)
    while current <= end:
        yield current
        current = _next_month(current)


def _clamped(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def _closing_for_due(due: date, close_day: int) -> date:
    same_month = _clamped(due.year, due.month, close_day)
    if same_month < due:
        return same_month
    year, month = _previous_month(due.year, due.month)
    return _clamped(year, month, close_day)


def _cycle_for_due(
    due: date,
    close_day: Optional[int],
    closing: Optional[date],
    previous_closing: Optional[date] = None,
) -> tuple[date, date, date] | None:
    close = closing or (_closing_for_due(due, close_day) if close_day else None)
    if close is None:
        return None
    if previous_closing is not None and previous_closing < close:
        # The bank's own previous close opens this cycle, so consecutive
        # statements tile without gaps or overlaps when the close day moves.
        return previous_closing, close - timedelta(days=1), close
    previous_year, previous_month = _previous_month(close.year, close.month)
    previous_close = _clamped(previous_year, previous_month, close_day or close.day)
    return previous_close, close - timedelta(days=1), close


def _canonical_bill(bills: Sequence[CreditCardBill]) -> CreditCardBill:
    return max(bills, key=lambda bill: (bill.source == "bank", bill.due_date, bill.updated_at))


async def displayed_bill_amounts(
    session: AsyncSession, bills: Sequence[CreditCardBill]
) -> dict[uuid.UUID, Decimal]:
    """The Fatura amount every screen shows for each bill, by bill id.

    A bank bill shows the bank's total less the net of the Cartão Oculto
    charges the bank linked to it (`Transaction.bill_id`): the lists leave
    those charges out, so the Fatura does too. Only the display changes:
    payment matching, the paid status, the balance and the limit keep the
    bank's real `total_amount`. A manual bill is the user's own figure,
    entered against the amounts on screen, so it stands as typed.

    One query for all the bills, summed like the card's bill side
    (`get_account_summary`): debits add, credits subtract, in the account's
    currency.
    """
    amounts = {bill.id: bill.total_amount for bill in bills}
    bank_ids = [bill.id for bill in bills if bill.source == "bank"]
    if not bank_ids:
        return amounts
    effective_amount = case(
        (Transaction.currency == Account.currency, Transaction.amount),
        else_=func.coalesce(Transaction.amount_primary, Transaction.amount),
    )
    hidden = await session.execute(
        select(
            Transaction.bill_id,
            func.sum(
                case(
                    (Transaction.type == "credit", -func.abs(effective_amount)),
                    else_=func.abs(effective_amount),
                )
            ),
        )
        .join(Account, Account.id == Transaction.account_id)
        .where(
            Transaction.bill_id.in_(bank_ids),
            Transaction.source != "opening_balance",
            counts_on_bill(),
            ~not_on_hidden_cards(),
        )
        .group_by(Transaction.bill_id)
    )
    for bill_id, net in hidden.all():
        if net is not None:
            amounts[bill_id] -= Decimal(str(net))
    return amounts


class CreditCardTimeline:
    """Deep module for statement selection and cycle identity."""

    @staticmethod
    async def index(
        session: AsyncSession,
        workspace_id: uuid.UUID,
        account_ids: Sequence[uuid.UUID],
        *,
        due_from: date,
        due_to: date,
        as_of: date,
    ) -> dict[uuid.UUID, CardTimeline]:
        if due_from > due_to:
            raise ValueError("due_from must not be after due_to")
        ids = tuple(dict.fromkeys(account_ids))
        if not ids:
            return {}

        accounts = list(
            (
                await session.execute(
                    select(Account)
                    .outerjoin(
                        BankConnection,
                        Account.connection_id == BankConnection.id,
                    )
                    .where(
                        or_(
                            Account.workspace_id == workspace_id,
                            BankConnection.workspace_id == workspace_id,
                        ),
                        Account.id.in_(ids),
                        Account.type == "credit_card",
                    )
                )
            )
            .scalars()
            .all()
        )
        bills = list(
            (
                await session.execute(
                    select(CreditCardBill).where(
                        CreditCardBill.workspace_id == workspace_id,
                        CreditCardBill.account_id.in_([account.id for account in accounts]),
                    )
                )
            )
            .scalars()
            .all()
        )
        by_account_month: dict[tuple[uuid.UUID, str], list[CreditCardBill]] = {}
        for bill in bills:
            key = (bill.account_id, bill.due_date.strftime("%Y-%m"))
            by_account_month.setdefault(key, []).append(bill)
        first_month, last_month = due_from.strftime("%Y-%m"), due_to.strftime("%Y-%m")
        statements = {
            key: _canonical_bill(matching)
            for key, matching in by_account_month.items()
            if first_month <= key[1] <= last_month
        }
        displayed = await displayed_bill_amounts(session, list(statements.values()))

        result: dict[uuid.UUID, CardTimeline] = {}
        current_month = _month_start(as_of)
        for account in accounts:
            items: list[TimelineItem] = []
            for month in _months(due_from, due_to):
                month_key = month.strftime("%Y-%m")
                bill = statements.get((account.id, month_key))
                if bill is not None:
                    previous_year, previous_month = _previous_month(month.year, month.month)
                    previous_bills = by_account_month.get(
                        (account.id, f"{previous_year:04d}-{previous_month:02d}"), ()
                    )
                    cycle = _cycle_for_due(
                        bill.due_date,
                        account.statement_close_day,
                        bill.closing_date,
                        _canonical_bill(previous_bills).closing_date if previous_bills else None,
                    )
                    items.append(
                        TimelineItem(
                            account_id=account.id,
                            due_month=month_key,
                            kind="statement",
                            cycle_key=f"bill:{bill.id}",
                            start=cycle[0] if cycle else None,
                            end=cycle[1] if cycle else None,
                            closing_date=cycle[2] if cycle else bill.closing_date,
                            due_date=bill.due_date,
                            amount=displayed[bill.id],
                            primary_amount=None,
                            source=bill.source,
                            record_id=bill.id,
                            status=bill.status,
                            editable=bill.source == "manual",
                            unavailable_reason=None,
                        )
                    )
                    continue

                due_day = account.payment_due_day
                close_day = account.statement_close_day
                due = _clamped(month.year, month.month, due_day) if due_day else None
                cycle = _cycle_for_due(due, close_day, None) if due else None
                past = month < current_month
                kind = "unavailable" if past or cycle is None else "projection"
                reason = (
                    "past_statement_missing"
                    if past
                    else "missing_due_config"
                    if due_day is None
                    else "missing_close_config"
                    if close_day is None
                    else None
                )
                cycle_key = f"cycle:{cycle[2].isoformat()}" if cycle else None
                items.append(
                    TimelineItem(
                        account_id=account.id,
                        due_month=month_key,
                        kind=kind,
                        cycle_key=cycle_key,
                        start=cycle[0] if cycle else None,
                        end=cycle[1] if cycle else None,
                        closing_date=cycle[2] if cycle else None,
                        due_date=due,
                        amount=Decimal("0") if kind == "projection" else None,
                        primary_amount=None,
                        source=None,
                        record_id=None,
                        status=None,
                        editable=False,
                        unavailable_reason=reason,
                    )
                )

            default_key = next(
                (
                    item.cycle_key
                    for item in items
                    if item.cycle_key is not None
                    and item.kind == "statement"
                    and item.due_date is not None
                    and item.due_date >= as_of
                ),
                None,
            )
            if default_key is None:
                default_key = next(
                    (
                        item.cycle_key
                        for item in items
                        if item.cycle_key is not None
                        and item.kind == "projection"
                        and item.start is not None
                        and item.end is not None
                        and item.start <= as_of <= item.end
                    ),
                    None,
                )
            result[account.id] = CardTimeline(tuple(items), default_key)
        # A Projeção de Fatura is what the cycle's summary projects: the same
        # number the card page and the month view read through the cycle key,
        # so no screen can total the cycle its own way. The import is local
        # because account_service imports this module.
        from app.services.account_service import get_account_summary

        for account_id, timeline in tuple(result.items()):
            projected_items = []
            for item in timeline.items:
                if item.kind == "projection" and item.start is not None and item.end is not None:
                    summary = await get_account_summary(
                        session,
                        account_id,
                        workspace_id,
                        date_from=item.start,
                        date_to=item.end,
                        unbilled_only=True,
                    )
                    if summary is not None:
                        item = replace(
                            item,
                            amount=Decimal(str(summary["projected_expenses"])).quantize(
                                Decimal("0.01")
                            ),
                        )
                projected_items.append(item)
            result[account_id] = CardTimeline(tuple(projected_items), timeline.default_key)
        return result

    @staticmethod
    async def resolve(
        session: AsyncSession,
        workspace_id: uuid.UUID,
        account_id: uuid.UUID,
        cycle_key: str,
    ) -> CycleScope:
        if cycle_key.startswith("bill:"):
            try:
                bill_id = uuid.UUID(cycle_key.removeprefix("bill:"))
            except ValueError as error:
                raise StaleCycleKeyError("Invalid cycle key") from error
            row = (
                await session.execute(
                    select(CreditCardBill, Account)
                    .join(Account, Account.id == CreditCardBill.account_id)
                    .where(
                        CreditCardBill.id == bill_id,
                        CreditCardBill.account_id == account_id,
                        CreditCardBill.workspace_id == workspace_id,
                    )
                )
            ).first()
            if row is None:
                raise StaleCycleKeyError("Cycle key is stale")
            bill, account = row
            canonical = await CreditCardTimeline.index(
                session,
                workspace_id,
                [account_id],
                due_from=bill.due_date,
                due_to=bill.due_date,
                as_of=bill.due_date,
            )
            item = canonical[account_id].items[0]
            if item.record_id != bill.id or item.start is None or item.end is None:
                raise StaleCycleKeyError("Cycle key is stale")
            return CycleScope(account_id, cycle_key, bill.id, item.start, item.end, False)

        if cycle_key.startswith("cycle:"):
            try:
                close = date.fromisoformat(cycle_key.removeprefix("cycle:"))
            except ValueError as error:
                raise StaleCycleKeyError("Invalid cycle key") from error
            account = await session.scalar(
                select(Account).where(
                    Account.id == account_id,
                    Account.workspace_id == workspace_id,
                    Account.type == "credit_card",
                )
            )
            if account is None or not account.statement_close_day:
                raise StaleCycleKeyError("Cycle key is stale")
            expected_close = _clamped(
                close.year, close.month, account.statement_close_day
            )
            if close != expected_close:
                raise StaleCycleKeyError("Cycle key is stale")
            previous_year, previous_month = _previous_month(close.year, close.month)
            start = _clamped(
                previous_year, previous_month, account.statement_close_day
            )
            return CycleScope(
                account_id, cycle_key, None, start, close - timedelta(days=1), True
            )

        raise StaleCycleKeyError("Invalid cycle key")
