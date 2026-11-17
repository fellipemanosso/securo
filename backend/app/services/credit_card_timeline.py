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

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.bank_connection import BankConnection
from app.models.credit_card_bill import CreditCardBill
from app.models.transaction import Transaction
from app.services._query_filters import counts_on_bill, not_on_hidden_cards
from app.services.credit_card_service import cc_cycle_bill_due_dates


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
        user_id: Optional[uuid.UUID] = None,
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

        result: dict[uuid.UUID, CardTimeline] = {}
        current_month = _month_start(as_of)
        for account in accounts:
            items: list[TimelineItem] = []
            for month in _months(due_from, due_to):
                month_key = month.strftime("%Y-%m")
                matching = by_account_month.get((account.id, month_key), ())
                if matching:
                    bill = _canonical_bill(matching)
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
                            amount=bill.total_amount,
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
        projection_items = [
            item
            for timeline in result.values()
            for item in timeline.items
            if item.kind == "projection" and item.start is not None and item.end is not None
        ]
        if projection_items:
            range_start = min(item.start for item in projection_items if item.start is not None)
            range_end = max(item.end for item in projection_items if item.end is not None)
            transactions = list(
                (
                    await session.execute(
                        select(Transaction).where(
                            Transaction.account_id.in_(ids),
                            or_(
                                and_(
                                    Transaction.date >= range_start,
                                    Transaction.date <= range_end,
                                ),
                                # Placed on a later bill than its purchase
                                # date, e.g. a Pix no crédito.
                                Transaction.effective_bill_date >= range_start,
                            ),
                            Transaction.bill_id.is_(None),
                            Transaction.source != "opening_balance",
                            # The same charges the cycle's bill total counts:
                            # an unpaired card payment is a repayment of older
                            # debt, not a refund on this bill.
                            counts_on_bill(),
                            not_on_hidden_cards(),
                        )
                    )
                )
                .scalars()
                .all()
            )
            by_account: dict[uuid.UUID, list[Transaction]] = {}
            for transaction in transactions:
                if transaction.account_id is not None:
                    by_account.setdefault(transaction.account_id, []).append(transaction)
            projected_by_account: dict[uuid.UUID, list] = {}
            if user_id is not None:
                from app.services.dashboard_service import get_projected_transactions

                recurring = await get_projected_transactions(
                    session,
                    workspace_id,
                    user_id,
                    from_date=range_start,
                    to_date=range_end,
                )
                for projection in recurring:
                    if projection.account_id and not projection.category_treat_as_transfer:
                        projected_by_account.setdefault(
                            uuid.UUID(projection.account_id), []
                        ).append(projection)
            accounts_by_id = {account.id: account for account in accounts}
            for account_id, timeline in tuple(result.items()):
                account = accounts_by_id[account_id]
                account_transactions = by_account.get(account_id, ())
                projected_items = []
                for item in timeline.items:
                    if item.kind != "projection" or item.start is None or item.end is None:
                        projected_items.append(item)
                        continue
                    # Same membership as the cycle's transaction list: a bill
                    # placement counts on the bill whose (previous due, due]
                    # range holds it, an unplaced charge by purchase date.
                    cycle = cc_cycle_bill_due_dates(
                        item.start,
                        item.end,
                        account.statement_close_day,
                        account.payment_due_day,
                    )
                    by_due = cycle is not None and not cycle["degenerate"]
                    total = Decimal("0")
                    for transaction in account_transactions:
                        placement = transaction.effective_bill_date
                        if by_due and placement is not None:
                            member = cycle["prev"] < placement <= cycle["this"]
                        else:
                            member = item.start <= (placement or transaction.date) <= item.end
                        if member:
                            total += (
                                transaction.amount
                                if transaction.type == "debit"
                                else -transaction.amount
                            )
                    for projection in projected_by_account.get(account_id, ()):
                        bucket = date.fromisoformat(projection.date)
                        if item.start <= bucket <= item.end:
                            amount = Decimal(str(projection.amount))
                            total += amount if projection.type == "debit" else -amount
                    projected_items.append(replace(item, amount=total))
                result[account_id] = CardTimeline(
                    tuple(projected_items), timeline.default_key
                )
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
