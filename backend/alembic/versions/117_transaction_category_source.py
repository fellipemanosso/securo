"""record how each transaction got its category

The categorization review shows, next to every category, whether a rule,
the bank, an import, a recurring bill or the user put it there, so the user
knows which ones to check. Nothing recorded that until now, so existing rows
start with no provenance rather than a guessed one.

Revision ID: 117
Revises: 116
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

revision = "117"
down_revision = "116"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "transactions", sa.Column("category_source", sa.String(length=12), nullable=True)
    )
    op.add_column(
        "transactions",
        sa.Column(
            "category_rule_id",
            UUID(as_uuid=True),
            sa.ForeignKey("rules.id", name="fk_transactions_category_rule_id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_constraint("fk_transactions_category_rule_id", "transactions", type_="foreignkey")
    op.drop_column("transactions", "category_rule_id")
    op.drop_column("transactions", "category_source")
