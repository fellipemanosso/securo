import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.reports import _add_years
from app.core.app_clock import app_today
from app.core.database import get_async_session
from app.core.workspace_context import (
    WorkspaceContext,
    current_workspace,
    current_writable_workspace,
)
from app.schemas.account import (
    AccountCardRead,
    AccountCardUpdate,
    AccountCreate,
    AccountRead,
    AccountRunningBalancePoint,
    AccountSummary,
    AccountUpdate,
    CreditCardBillRead,
    CreditCardBillWrite,
    CreditCardTimelineRead,
    InstallmentForecastRead,
    LoanBalanceAdjustment,
    LoanBalanceUpdate,
    LoanScheduleRead,
)
from app.services import account_service
from app.services.admin_service import get_credit_card_accounting_mode
from app.services.credit_card_timeline import (
    CreditCardTimeline,
    StaleCycleKeyError,
)
from app.services.credit_card_service import cc_cycle_bill_due_dates
from app.services.fx_rate_service import _resolve_rate
from app.services.installment_forecast import forecast_installments, on_bill

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

# Same cap as the reports' custom range (`_MAX_CUSTOM_RANGE_YEARS`), counted
# the same way: the series has one point per day. The account page charts the
# latest part of a longer range (#1202).
_MAX_RUNNING_BALANCE_YEARS = 10


@router.get("/credit-card-timeline", response_model=list[CreditCardTimelineRead])
async def get_credit_card_timeline(
    account_ids: list[uuid.UUID] = Query(...),
    due_from: date = Query(..., alias="from"),
    due_to: date = Query(..., alias="to"),
    as_of: Optional[date] = Query(None),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    timelines = await CreditCardTimeline.index(
        session,
        ctx.workspace.id,
        account_ids,
        due_from=due_from,
        due_to=due_to,
        as_of=as_of or app_today(),
    )
    return [
        CreditCardTimelineRead(
            account_id=account_id,
            items=list(timeline.items),
            default_key=timeline.default_key,
        )
        for account_id, timeline in timelines.items()
    ]


@router.get("", response_model=list[AccountRead])
async def list_accounts(
    include_closed: bool = False,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    accounts = await account_service.get_accounts(session, ctx.workspace.id, include_closed=include_closed)
    for acc in accounts:
        await _convert_to_primary(session, acc, ctx.user.primary_currency)
    return accounts


async def _convert_to_primary(session: AsyncSession, acc: dict, primary_currency: str) -> None:
    """Fill the primary-currency balance and open bill of a serialized account."""
    if acc["currency"] == primary_currency:
        return
    # Use the real rate only: the 1:1 fallback would present a foreign
    # balance as already converted (issue #1165). Leaving it unset makes
    # the UI show the native currency and flag the missing rate.
    rate = await _resolve_rate(session, acc["currency"], primary_currency)
    if rate is None:
        acc["fx_fallback"] = True
        return
    converted = Decimal(str(acc["current_balance"])) * rate
    acc["balance_primary"] = float(converted.quantize(Decimal("0.01")))
    if acc["open_bill_total"] is not None:
        bill = Decimal(str(acc["open_bill_total"])) * rate
        acc["open_bill_total_primary"] = float(bill.quantize(Decimal("0.01")))


@router.get("/{account_id}/summary", response_model=AccountSummary)
async def get_account_summary(
    account_id: uuid.UUID,
    date_from: Optional[str] = Query(None, alias="from", description="YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, alias="to", description="YYYY-MM-DD"),
    cycle_key: Optional[str] = Query(None),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    from_date = date.fromisoformat(date_from) if date_from else None
    to_date = date.fromisoformat(date_to) if date_to else None
    bill_id = None
    unbilled_only = False
    if cycle_key is not None:
        try:
            scope = await CreditCardTimeline.resolve(
                session, ctx.workspace.id, account_id, cycle_key
            )
        except StaleCycleKeyError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        from_date, to_date = scope.start, scope.end
        bill_id = scope.bill_id
        unbilled_only = scope.projection
    summary = await account_service.get_account_summary(
        session,
        account_id,
        ctx.workspace.id,
        date_from=from_date,
        date_to=to_date,
        bill_id=bill_id,
        unbilled_only=unbilled_only,
    )
    if not summary:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")

    account = await account_service.get_account(session, account_id, ctx.workspace.id)
    primary_currency = ctx.user.primary_currency
    if account and account.currency != primary_currency:
        # Same rule as list_accounts: without a real rate, leave the *_primary
        # fields unset instead of returning 1:1 values as if converted (#1165).
        rate = await _resolve_rate(session, account.currency, primary_currency)
        if rate is None:
            summary["fx_fallback"] = True
        else:
            for field in (
                "current_balance", "opening_balance", "monthly_income",
                "monthly_expenses", "projected_income", "projected_expenses",
            ):
                converted = Decimal(str(summary[field])) * rate
                summary[f"{field}_primary"] = float(converted.quantize(Decimal("0.01")))

    return summary


@router.get(
    "/{account_id}/installment-forecasts",
    response_model=list[InstallmentForecastRead],
)
async def get_installment_forecasts(
    account_id: uuid.UUID,
    cycle_key: str = Query(...),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Installments the bank will bill on this statement but has not sent."""
    try:
        scope = await CreditCardTimeline.resolve(
            session, ctx.workspace.id, account_id, cycle_key
        )
    except StaleCycleKeyError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    account = await account_service.get_account(session, account_id, ctx.workspace.id)
    if account is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    # Only statement projections are still open to forecasts: a bank
    # statement already says what it billed.
    cycle = cc_cycle_bill_due_dates(
        scope.start, scope.end, account.statement_close_day, account.payment_due_day
    ) if scope.projection else None
    if cycle is None or cycle["degenerate"]:
        return []
    forecasts = on_bill(
        await forecast_installments(session, [account.id]), cycle["prev"], cycle["this"]
    )
    return [
        InstallmentForecastRead(
            key=forecast.key,
            description=forecast.description,
            amount=float(forecast.amount),
            currency=forecast.currency,
            type=forecast.type,
            purchase_date=forecast.purchase_date,
            due_date=forecast.due_date,
            installment_number=forecast.installment_number,
            total_installments=forecast.total_installments,
            category_id=forecast.category_id,
            card_last4=forecast.card_last4,
        )
        for forecast in forecasts
    ]


@router.get("/{account_id}/balance-history")
async def get_account_balance_history(
    account_id: uuid.UUID,
    date_from: Optional[str] = Query(None, alias="from", description="YYYY-MM-DD"),
    date_to: Optional[str] = Query(None, alias="to", description="YYYY-MM-DD"),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    from_date = date.fromisoformat(date_from) if date_from else None
    to_date = date.fromisoformat(date_to) if date_to else None
    history = await account_service.get_account_balance_history(
        session, account_id, ctx.workspace.id, date_from=from_date, date_to=to_date,
    )
    if history is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")

    account = await account_service.get_account(session, account_id, ctx.workspace.id)
    primary_currency = ctx.user.primary_currency
    if account and account.currency != primary_currency:
        for point in history:
            point_date = date.fromisoformat(point["date"])
            rate = await _resolve_rate(session, account.currency, primary_currency, point_date)
            if rate is None:
                point["fx_fallback"] = True
            else:
                converted = Decimal(str(point["balance"])) * rate
                point["balance_primary"] = float(converted.quantize(Decimal("0.01")))

    return history


@router.get("/{account_id}/running-balance", response_model=list[AccountRunningBalancePoint])
async def get_account_running_balance(
    account_id: uuid.UUID,
    date_from: Optional[date] = Query(None, alias="from"),
    date_to: Optional[date] = Query(None, alias="to"),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Daily balance matching the transaction list's `running_balance` (#1202).

    Missing bounds default like the summary's: month start to today.
    """
    today = app_today()
    date_from = date_from or today.replace(day=1)
    date_to = date_to or today
    if date_to < date_from:
        raise HTTPException(status_code=422, detail="to must be on or after from")
    if date_to > _add_years(date_from, _MAX_RUNNING_BALANCE_YEARS):
        raise HTTPException(
            status_code=422,
            detail=f"Range is too wide (max {_MAX_RUNNING_BALANCE_YEARS} years)",
        )

    accounting_mode = await get_credit_card_accounting_mode(session)
    try:
        series = await account_service.get_account_running_balance(
            session, account_id, ctx.workspace.id, ctx.user.primary_currency,
            date_from, date_to, accounting_mode=accounting_mode,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if series is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    return series




@router.get("/{account_id}/cards", response_model=list[AccountCardRead])
async def get_account_cards(
    account_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Every card seen on the account's transactions, newest activity first."""
    cards = await account_service.get_account_cards(session, account_id, ctx.workspace.id)
    if cards is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    return cards


@router.patch("/{account_id}/cards/{last4}", response_model=AccountCardRead)
async def update_account_card(
    account_id: uuid.UUID,
    last4: str,
    data: AccountCardUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    card = await account_service.update_account_card(
        session, account_id, ctx.workspace.id, last4, data,
    )
    if card is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Card not found")
    return card


@router.post("/{account_id}/bills", response_model=CreditCardBillRead)
async def create_manual_account_bill(
    account_id: uuid.UUID,
    data: CreditCardBillWrite,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        bill = await account_service.upsert_manual_credit_card_bill(
            session, account_id, ctx.workspace.id, ctx.user_id, data,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    if bill is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Credit-card account not found")
    return bill


@router.delete("/{account_id}/bills/{bill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_manual_account_bill(
    account_id: uuid.UUID,
    bill_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    deleted = await account_service.delete_manual_credit_card_bill(
        session, account_id, bill_id, ctx.workspace.id,
    )
    if deleted is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Manual bill adjustment not found")
    if not deleted:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provider bills cannot be deleted")


@router.get("/{account_id}/loan-schedule", response_model=LoanScheduleRead)
async def get_loan_schedule(
    account_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    schedule = await account_service.get_loan_schedule(session, account_id, ctx.workspace.id)
    if schedule is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Loan account not found")
    return schedule


@router.post("/{account_id}/loan-balance", response_model=LoanBalanceAdjustment)
async def adjust_loan_balance(
    account_id: uuid.UUID,
    data: LoanBalanceUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        result = await account_service.adjust_loan_balance(
            session, account_id, ctx.workspace.id, ctx.user_id, data
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Loan account not found")
    return result


@router.get("/{account_id}", response_model=AccountRead)
async def get_account(
    account_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    account = await account_service.get_account_with_balances(session, account_id, ctx.workspace.id)
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    await _convert_to_primary(session, account, ctx.user.primary_currency)
    return account


@router.post("", response_model=AccountRead, status_code=status.HTTP_201_CREATED)
async def create_account(
    data: AccountCreate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        account = await account_service.create_account(session, ctx.workspace.id, ctx.user_id, data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return account_service.serialize_account(account, None, None)


@router.patch("/{account_id}", response_model=AccountRead)
async def update_account(
    account_id: uuid.UUID,
    data: AccountUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        account = await account_service.update_account(session, account_id, ctx.workspace.id, data)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    # Re-read post-commit so the response resolves the institution/display
    # name pair exactly like GET (update_account leaves the row expired).
    account = await account_service.get_account_with_balances(session, account_id, ctx.workspace.id)
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    return account


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        deleted = await account_service.delete_account(session, account_id, ctx.workspace.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")


@router.post("/{account_id}/close", response_model=AccountRead)
async def close_account(
    account_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        account = await account_service.close_account(session, account_id, ctx.workspace.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    return account


@router.post("/{account_id}/reopen", response_model=AccountRead)
async def reopen_account(
    account_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        account = await account_service.reopen_account(session, account_id, ctx.workspace.id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    return account
