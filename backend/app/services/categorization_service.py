"""What the categorization review needs beyond the transaction list.

Two questions the list cannot answer one row at a time: which category the
user's own history points to for each uncategorized row, and which other
transactions look like a row the user just recategorized.

"Looks like" is the same everywhere: the same payee when the row has one,
otherwise the same description (ignoring case and surrounding spaces), and
always the same direction, since a refund from a shop is not filed like the
purchase. Transfers, split rows, ignored rows and generated balance rows are
left out: none of them is categorized one row at a time.
"""

import uuid
from typing import Optional

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mortgage_payment_allocation import MORTGAGE_PRINCIPAL_SOURCE
from app.models.transaction import Transaction
from app.schemas.transaction import CategorySuggestion, SimilarTransaction
from app.services.category_service import get_assignable_category_ids


def _description_key(description: str) -> str:
    return description.strip().lower()


def _description_column() -> ColumnElement[str]:
    return func.lower(func.trim(Transaction.description))


def _categorizable(workspace_id: uuid.UUID) -> tuple[ColumnElement[bool], ...]:
    return (
        Transaction.workspace_id == workspace_id,
        Transaction.transfer_pair_id.is_(None),
        Transaction.has_category_lines.is_(False),
        Transaction.is_ignored.is_(False),
        Transaction.source.not_in(("opening_balance", MORTGAGE_PRINCIPAL_SOURCE)),
    )


def _pick(
    counts: dict[tuple, list[tuple[uuid.UUID, int, object]]], key: tuple
) -> Optional[tuple[uuid.UUID, int]]:
    """The most used category for `key`; the most recently used breaks a tie."""
    candidates = counts.get(key)
    if not candidates:
        return None
    category_id, uses, _ = max(candidates, key=lambda item: (item[1], item[2]))
    return category_id, uses


async def suggest_categories(
    session: AsyncSession, workspace_id: uuid.UUID, transaction_ids: list[uuid.UUID]
) -> list[CategorySuggestion]:
    """For each listed uncategorized row, the category its look-alikes went to.

    One grouped query per kind of match for the whole page, never one per row.
    The payee wins when both match. Only categories the user can still pick
    are suggested, and rows already categorized get nothing.
    """
    if not transaction_ids:
        return []
    filters = _categorizable(workspace_id)
    targets = (
        await session.execute(
            select(
                Transaction.id,
                Transaction.payee_id,
                Transaction.description,
                Transaction.type,
            ).where(
                *filters,
                Transaction.id.in_(transaction_ids),
                Transaction.category_id.is_(None),
            )
        )
    ).all()
    if not targets:
        return []

    assignable = await get_assignable_category_ids(session, workspace_id)
    if not assignable:
        return []
    history = (
        *filters,
        Transaction.category_id.in_(assignable),
    )

    by_payee: dict[tuple, list[tuple[uuid.UUID, int, object]]] = {}
    payee_ids = {row.payee_id for row in targets if row.payee_id is not None}
    if payee_ids:
        rows = await session.execute(
            select(
                Transaction.payee_id,
                Transaction.type,
                Transaction.category_id,
                func.count(),
                func.max(Transaction.date),
            )
            .where(*history, Transaction.payee_id.in_(payee_ids))
            .group_by(Transaction.payee_id, Transaction.type, Transaction.category_id)
        )
        for payee_id, tx_type, category_id, uses, last_used in rows:
            by_payee.setdefault((payee_id, tx_type), []).append((category_id, uses, last_used))

    by_description: dict[tuple, list[tuple[uuid.UUID, int, object]]] = {}
    keys = {_description_key(row.description) for row in targets if row.description.strip()}
    if keys:
        description = _description_column()
        rows = await session.execute(
            select(
                description,
                Transaction.type,
                Transaction.category_id,
                func.count(),
                func.max(Transaction.date),
            )
            .where(*history, description.in_(keys))
            .group_by(description, Transaction.type, Transaction.category_id)
        )
        for key, tx_type, category_id, uses, last_used in rows:
            by_description.setdefault((key, tx_type), []).append((category_id, uses, last_used))

    suggestions: list[CategorySuggestion] = []
    for row in targets:
        match = (
            _pick(by_payee, (row.payee_id, row.type)) if row.payee_id is not None else None
        )
        matched_by = "payee"
        if match is None:
            match = _pick(by_description, (_description_key(row.description), row.type))
            matched_by = "description"
        if match is None:
            continue
        category_id, uses = match
        suggestions.append(
            CategorySuggestion(
                transaction_id=row.id,
                category_id=category_id,
                uses=uses,
                matched_by=matched_by,
            )
        )
    return suggestions


async def similar_transactions(
    session: AsyncSession, workspace_id: uuid.UUID, transaction_id: uuid.UUID
) -> Optional[list[SimilarTransaction]]:
    """Every other transaction, in any month, that looks like this one.

    None when the transaction is not in the workspace. The caller narrows the
    list to a month and to the rows not yet in the new category, so it can say
    how many a change would touch before making it.
    """
    anchor = (
        await session.execute(
            select(
                Transaction.payee_id, Transaction.description, Transaction.type
            ).where(Transaction.id == transaction_id, Transaction.workspace_id == workspace_id)
        )
    ).first()
    if anchor is None:
        return None
    same = (
        Transaction.payee_id == anchor.payee_id
        if anchor.payee_id is not None
        else _description_column() == _description_key(anchor.description)
    )
    rows = await session.execute(
        select(Transaction.id, Transaction.category_id, Transaction.date)
        .where(
            *_categorizable(workspace_id),
            Transaction.id != transaction_id,
            Transaction.type == anchor.type,
            same,
        )
        .order_by(Transaction.date.desc(), Transaction.id)
    )
    return [
        SimilarTransaction(id=row.id, category_id=row.category_id, date=row.date)
        for row in rows
    ]
