"""keep a bank bill forecast only when it defers the charge

Revision ID: 113
Revises: 112
"""

import calendar
from datetime import date

from alembic import op
from sqlalchemy import text

revision = "113"
down_revision = "112"
branch_labels = None
depends_on = None

_BATCH_SIZE = 1000


def _clamp_day(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _cycle_due(tx_date: date, close_day, due_day) -> date:
    """Mirror of credit_card_service.compute_effective_date."""
    if not close_day or not due_day:
        return tx_date
    close = _clamp_day(tx_date.year, tx_date.month, close_day)
    if close <= tx_date:
        close = _clamp_day(
            tx_date.year + (tx_date.month == 12),
            1 if tx_date.month == 12 else tx_date.month + 1,
            close_day,
        )
    due = _clamp_day(close.year, close.month, due_day)
    if due <= close:
        due = _clamp_day(
            close.year + (close.month == 12),
            1 if close.month == 12 else close.month + 1,
            due_day,
        )
    return due


def upgrade() -> None:
    # Migration 112 placed every charge on its billForecastDate. C6 sends a
    # month whose bill had closed before the purchase, which hid its open
    # charges on a past bill. A forecast now only counts when it defers the
    # charge past its cycle-math bill; the others go back to cycle math.
    connection = op.get_bind()
    # Keyset pages instead of a server-side cursor: asyncpg cannot run the
    # batched UPDATE while a streaming cursor is open.
    select_page = text(
        """
        SELECT t.id, t.date, t.effective_bill_date,
               a.statement_close_day, a.payment_due_day
        FROM transactions AS t
        JOIN accounts AS a ON a.id = t.account_id
        WHERE t.effective_bill_date_source = 'provider'
          AND (CAST(:last_id AS UUID) IS NULL OR t.id > CAST(:last_id AS UUID))
        ORDER BY t.id
        LIMIT :limit
        """
    )
    unplace = text(
        """
        UPDATE transactions
        SET effective_bill_date = NULL,
            effective_bill_date_source = NULL,
            effective_date = :effective_date
        WHERE id = :id
        """
    )
    last_id = None
    while batch := connection.execute(
        select_page, {"last_id": last_id, "limit": _BATCH_SIZE}
    ).all():
        stale = []
        for row in batch:
            cycle_due = _cycle_due(row.date, row.statement_close_day, row.payment_due_day)
            if row.effective_bill_date <= cycle_due:
                stale.append({"id": row.id, "effective_date": cycle_due})
        if stale:
            connection.execute(unplace, stale)
        last_id = str(batch[-1].id)


def downgrade() -> None:
    # The dropped forecasts named bills that had closed before the purchase;
    # there is nothing worth restoring.
    pass
