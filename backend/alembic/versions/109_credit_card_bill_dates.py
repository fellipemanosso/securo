"""store provider credit-card closing and forecast dates

Revision ID: 109
Revises: 108
"""

import sqlalchemy as sa

from alembic import op

revision = "109"
down_revision = "108"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("credit_card_bills")}
    if "closing_date" not in columns:
        op.add_column("credit_card_bills", sa.Column("closing_date", sa.Date(), nullable=True))
    if "forecast_date" not in columns:
        op.add_column("credit_card_bills", sa.Column("forecast_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("credit_card_bills", "forecast_date")
    op.drop_column("credit_card_bills", "closing_date")
