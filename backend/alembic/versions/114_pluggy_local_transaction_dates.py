"""date Pluggy transactions on the Brazilian calendar day

Revision ID: 114
Revises: 113
"""

import calendar
from datetime import date, datetime, timedelta, timezone

from alembic import op
from sqlalchemy import text

revision = "114"
down_revision = "113"
branch_labels = None
depends_on = None

_BATCH_SIZE = 1000
# Mirror of app.providers.pluggy._BRAZIL: UTC-3 all year since 2019.
_BRAZIL = timezone(timedelta(hours=-3))


def _local_date(value: str) -> date:
    """Mirror of app.providers.pluggy._local_transaction_date."""
    moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None or moment.time() == datetime.min.time():
        return moment.date()
    return moment.astimezone(_BRAZIL).date()


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
    # Pluggy sends timestamps in UTC; rows were dated on the UTC day, a day
    # late for anything bought after 21:00 in Brasília. Only rows still on the
    # UTC day of their stored timestamp move, so dates a connector rule set
    # on purpose (Mercado Pago installments) stay.
    connection = op.get_bind()
    select_page = text(
        """
        SELECT t.id, t.date, t.raw_data::jsonb ->> 'date' AS raw_date,
               t.bill_id, t.effective_bill_date,
               a.type AS account_type, a.statement_close_day, a.payment_due_day
        FROM transactions AS t
        JOIN accounts AS a ON a.id = t.account_id
        JOIN bank_connections AS c ON c.id = a.connection_id
        WHERE c.provider = 'pluggy'
          AND t.source = 'sync'
          AND t.raw_data IS NOT NULL
          AND jsonb_typeof(t.raw_data::jsonb) = 'object'
          AND (t.raw_data::jsonb ->> 'date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          AND (CAST(:last_id AS UUID) IS NULL OR t.id > CAST(:last_id AS UUID))
        ORDER BY t.id
        LIMIT :limit
        """
    )
    redate = text(
        "UPDATE transactions SET date = :date, effective_date = :effective_date WHERE id = :id"
    )
    last_id = None
    while batch := connection.execute(
        select_page, {"last_id": last_id, "limit": _BATCH_SIZE}
    ).all():
        moved = []
        for row in batch:
            try:
                local = _local_date(row.raw_date)
            except ValueError:
                continue
            if row.date != date.fromisoformat(row.raw_date[:10]) or local == row.date:
                continue
            if row.account_type != "credit_card":
                effective = local
            elif row.bill_id is None and row.effective_bill_date is None:
                effective = _cycle_due(local, row.statement_close_day, row.payment_due_day)
            else:
                # The bank's bill, or a placement, already fixes when it is paid.
                effective = None
            moved.append({"id": row.id, "date": local, "effective_date": effective})
        keep_effective = [m for m in moved if m["effective_date"] is None]
        if keep_effective:
            connection.execute(
                text("UPDATE transactions SET date = :date WHERE id = :id"),
                [{"id": m["id"], "date": m["date"]} for m in keep_effective],
            )
        recompute = [m for m in moved if m["effective_date"] is not None]
        if recompute:
            connection.execute(redate, recompute)
        last_id = str(batch[-1].id)


def downgrade() -> None:
    # The UTC day was the defect; there is nothing worth restoring.
    pass
