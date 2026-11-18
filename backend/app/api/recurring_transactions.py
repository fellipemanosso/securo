import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_async_session
from app.core.workspace_context import (
    WorkspaceContext,
    current_workspace,
    current_writable_workspace,
)
from app.schemas.recurring_month import RecurringMonthOccurrence
from app.schemas.recurring_transaction import (
    RecurringTransactionCreate,
    RecurringTransactionRead,
    RecurringTransactionUpdate,
)
from app.schemas.transaction import TransactionRead
from app.services import recurring_month_service, recurring_transaction_service, transaction_service

router = APIRouter(prefix="/api/recurring-transactions", tags=["recurring-transactions"])


@router.get("", response_model=list[RecurringTransactionRead])
async def list_recurring_transactions(
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    return await recurring_transaction_service.get_recurring_transactions(session, ctx.workspace.id)


@router.get("/month-status", response_model=list[RecurringMonthOccurrence])
async def get_recurring_month_status(
    month: date = Query(..., description="Any day of the month, YYYY-MM-DD"),
    account_ids: Optional[list[uuid.UUID]] = Query(None),
    ctx: WorkspaceContext = Depends(current_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    """Each recurring occurrence of the month: paid, pending or overdue."""
    return await recurring_month_service.get_month_status(
        session, ctx.workspace.id, ctx.user_id, month, account_ids
    )


@router.post("", response_model=RecurringTransactionRead, status_code=status.HTTP_201_CREATED)
async def create_recurring_transaction(
    data: RecurringTransactionCreate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        return await recurring_transaction_service.create_recurring_transaction(
            session, ctx.workspace.id, ctx.user_id, data
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.patch("/{recurring_id}", response_model=RecurringTransactionRead)
async def update_recurring_transaction(
    recurring_id: uuid.UUID,
    data: RecurringTransactionUpdate,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        recurring = await recurring_transaction_service.update_recurring_transaction(
            session, recurring_id, ctx.workspace.id, data
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not recurring:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurring transaction not found")
    return recurring


@router.delete("/{recurring_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recurring_transaction(
    recurring_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    deleted = await recurring_transaction_service.delete_recurring_transaction(
        session, recurring_id, ctx.workspace.id
    )
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurring transaction not found")


@router.post("/{recurring_id}/pay", response_model=TransactionRead)
async def pay_recurring_transaction(
    recurring_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    try:
        transaction = await recurring_transaction_service.mark_next_occurrence_paid(
            session, recurring_id, ctx.workspace.id, ctx.user_id
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    if not transaction:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recurring transaction not found")
    return await transaction_service.get_transaction(
        session, transaction.id, ctx.workspace.id
    )


@router.post("/generate")
async def generate_recurring_transactions(
    ctx: WorkspaceContext = Depends(current_writable_workspace),
    session: AsyncSession = Depends(get_async_session),
):
    # The button is an explicit request, so it also covers schedules whose
    # auto-generate toggle is off; the hourly task skips those. It is scoped
    # to the workspace this request was authorized to write to.
    count = await recurring_transaction_service.generate_pending(
        session, ctx.user_id, include_manual=True, workspace_id=ctx.workspace.id
    )
    return {"generated": count}
