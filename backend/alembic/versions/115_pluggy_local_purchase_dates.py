"""date Pluggy installment purchases on the Brazilian calendar day

Revision ID: 115
Revises: 114
"""

from datetime import date, datetime, timedelta, timezone

from alembic import op
from sqlalchemy import text

revision = "115"
down_revision = "114"
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


def upgrade() -> None:
    # creditCardMetadata.purchaseDate is a UTC timestamp, and a bank may send
    # one purchase at different times across its installments (Bradesco:
    # 2026-06-16T00:43Z and 2026-06-15T03:00Z, both 15/06 in Brasília). Read
    # as the UTC day, one purchase became two and its installments were
    # forecast twice.
    connection = op.get_bind()
    select_page = text(
        """
        SELECT t.id, t.installment_purchase_date,
               t.raw_data::jsonb -> 'creditCardMetadata' ->> 'purchaseDate' AS raw_purchase
        FROM transactions AS t
        JOIN accounts AS a ON a.id = t.account_id
        JOIN bank_connections AS c ON c.id = a.connection_id
        WHERE c.provider = 'pluggy'
          AND t.source = 'sync'
          AND t.installment_purchase_date IS NOT NULL
          AND jsonb_typeof(t.raw_data::jsonb) = 'object'
          AND jsonb_typeof(t.raw_data::jsonb -> 'creditCardMetadata') = 'object'
          AND (t.raw_data::jsonb -> 'creditCardMetadata' ->> 'purchaseDate')
              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
          AND (CAST(:last_id AS UUID) IS NULL OR t.id > CAST(:last_id AS UUID))
        ORDER BY t.id
        LIMIT :limit
        """
    )
    redate = text("UPDATE transactions SET installment_purchase_date = :day WHERE id = :id")
    last_id = None
    while batch := connection.execute(
        select_page, {"last_id": last_id, "limit": _BATCH_SIZE}
    ).all():
        moved = []
        for row in batch:
            try:
                local = _local_date(row.raw_purchase)
            except ValueError:
                continue
            if local != row.installment_purchase_date:
                moved.append({"id": row.id, "day": local})
        if moved:
            connection.execute(redate, moved)
        last_id = str(batch[-1].id)


def downgrade() -> None:
    # The UTC day was the defect; there is nothing worth restoring.
    pass
