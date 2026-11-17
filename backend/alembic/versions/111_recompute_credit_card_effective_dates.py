"""recompute credit-card effective dates for the canonical timeline

Revision ID: 111
Revises: 110
"""

import calendar
from datetime import date

from alembic import op
from sqlalchemy import text

revision = "111"
down_revision = "110"
branch_labels = None
depends_on = None

_BATCH_SIZE = 1000


def _clamp_day(year: int, month: int, day: int) -> date:
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


def _effective_date(tx_date: date, close_day: int, due_day: int) -> date:
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
    connection = op.get_bind()
    rows = connection.execution_options(stream_results=True).execute(
        text(
            """
            SELECT t.id, t.date, a.statement_close_day, a.payment_due_day
            FROM transactions AS t
            JOIN accounts AS a ON a.id = t.account_id
            WHERE a.type = 'credit_card'
              AND a.statement_close_day IS NOT NULL
              AND a.payment_due_day IS NOT NULL
            ORDER BY t.id
            """
        )
    )
    while batch := rows.fetchmany(_BATCH_SIZE):
        connection.execute(
            text("UPDATE transactions SET effective_date = :effective_date WHERE id = :id"),
            [
                {
                    "id": row.id,
                    "effective_date": _effective_date(
                        row.date, row.statement_close_day, row.payment_due_day
                    ),
                }
                for row in batch
            ],
        )


def downgrade() -> None:
    # effective_date is derived data; there is no obsolete value worth restoring.
    pass
