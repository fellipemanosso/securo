"""place future installments on the bill the bank forecasts

Revision ID: 116
Revises: 115
"""

import calendar
from datetime import date

from alembic import op
from sqlalchemy import text

revision = "116"
down_revision = "115"
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
    # Itaú sends future installments ahead of billing, dated on the due date
    # of the bill they land on, with billForecastDate naming that bill. The
    # forecast was only trusted when it fell after the bill of the row's own
    # date, which is that due date, so 10/12 of a February purchase dated
    # 11/12 went on January instead of December. The forecast now counts
    # against the original purchase date.
    connection = op.get_bind()
    select_page = text(
        """
        SELECT t.id, t.date, t.installment_purchase_date,
               t.raw_data::jsonb -> 'creditCardMetadata' ->> 'billForecastDate' AS forecast,
               a.statement_close_day, a.payment_due_day
        FROM transactions AS t
        JOIN accounts AS a ON a.id = t.account_id
        WHERE a.type = 'credit_card'
          AND a.payment_due_day IS NOT NULL
          AND t.source = 'sync'
          AND t.bill_id IS NULL
          AND t.effective_bill_date IS NULL
          AND t.installment_purchase_date IS NOT NULL
          AND jsonb_typeof(t.raw_data::jsonb) = 'object'
          AND jsonb_typeof(t.raw_data::jsonb -> 'creditCardMetadata') = 'object'
          AND (t.raw_data::jsonb -> 'creditCardMetadata' ->> 'billForecastDate')
              ~ '^[0-9]{4}-(0[1-9]|1[0-2])'
          AND (CAST(:last_id AS UUID) IS NULL OR t.id > CAST(:last_id AS UUID))
        ORDER BY t.id
        LIMIT :limit
        """
    )
    place = text(
        """
        UPDATE transactions
        SET effective_bill_date = :due,
            effective_bill_date_source = 'provider',
            effective_date = :due
        WHERE id = :id
        """
    )
    last_id = None
    while batch := connection.execute(
        select_page, {"last_id": last_id, "limit": _BATCH_SIZE}
    ).all():
        placed = []
        for row in batch:
            forecast = _clamp_day(
                int(row.forecast[:4]), int(row.forecast[5:7]), row.payment_due_day
            )
            purchase_due = _cycle_due(
                row.installment_purchase_date, row.statement_close_day, row.payment_due_day
            )
            if forecast > purchase_due:
                placed.append({"id": row.id, "due": forecast})
        if placed:
            connection.execute(place, placed)
        last_id = str(batch[-1].id)


def downgrade() -> None:
    # A sync places the same installments again; there is nothing to undo.
    pass
