"""place unbilled credit-card charges on the bill the bank forecasts

Revision ID: 112
Revises: 111
"""

import logging

import sqlalchemy as sa

from alembic import op

revision = "112"
down_revision = "111"
branch_labels = None
depends_on = None

logger = logging.getLogger("alembic.runtime.migration")

# Pluggy's creditCardMetadata.billForecastDate: the "YYYY-MM" due month the
# bank expects to bill a charge on. raw_data may hold any JSON value (or a
# plain `json` column on older databases), so only objects whose forecast is a
# well-formed month are read; the casts are guarded because the planner may
# evaluate them before the WHERE clause filters malformed values out.
_FORECAST = "(t.raw_data::jsonb -> 'creditCardMetadata' ->> 'billForecastDate')"
_WELL_FORMED = f"{_FORECAST} ~ '^[0-9]{{4}}-(0[1-9]|1[0-2])'"


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in sa.inspect(bind).get_columns("transactions")}
    if "effective_bill_date_source" not in columns:
        op.add_column(
            "transactions",
            sa.Column("effective_bill_date_source", sa.String(10), nullable=True),
        )

    # Every placement so far was made by hand.
    bind.execute(
        sa.text(
            """
            UPDATE transactions
            SET effective_bill_date_source = 'manual'
            WHERE effective_bill_date IS NOT NULL
              AND effective_bill_date_source IS NULL
            """
        )
    )

    # Charges the bank has not billed yet go on the forecast bill: its due
    # day in the forecast month, clamped to the month's length. Rows on a bank
    # bill or placed by hand keep their bill.
    placed = bind.execute(
        sa.text(
            f"""
            UPDATE transactions AS target
            SET effective_bill_date = forecast.due_date,
                effective_bill_date_source = 'provider',
                effective_date = forecast.due_date
            FROM (
                SELECT t.id,
                       make_date(
                           month_start.y,
                           month_start.m,
                           LEAST(
                               a.payment_due_day,
                               EXTRACT(DAY FROM (
                                   make_date(month_start.y, month_start.m, 1)
                                   + INTERVAL '1 month' - INTERVAL '1 day'
                               ))::int
                           )
                       ) AS due_date
                FROM transactions AS t
                JOIN accounts AS a ON a.id = t.account_id
                CROSS JOIN LATERAL (
                    SELECT CASE WHEN {_WELL_FORMED}
                                THEN substr({_FORECAST}, 1, 4)::int END AS y,
                           CASE WHEN {_WELL_FORMED}
                                THEN substr({_FORECAST}, 6, 2)::int END AS m
                ) AS month_start
                WHERE a.type = 'credit_card'
                  AND a.payment_due_day IS NOT NULL
                  AND t.source = 'sync'
                  AND t.bill_id IS NULL
                  AND t.effective_bill_date IS NULL
                  AND t.raw_data IS NOT NULL
                  AND jsonb_typeof(t.raw_data::jsonb) = 'object'
                  AND jsonb_typeof(t.raw_data::jsonb -> 'creditCardMetadata') = 'object'
                  AND {_WELL_FORMED}
            ) AS forecast
            WHERE target.id = forecast.id
            """
        )
    )
    logger.info("Placed %s unbilled credit-card charges on their forecast bill", placed.rowcount)


def downgrade() -> None:
    op.execute(
        "UPDATE transactions SET effective_bill_date = NULL "
        "WHERE effective_bill_date_source = 'provider'"
    )
    op.drop_column("transactions", "effective_bill_date_source")
