"""per-card last four digits on transactions, with a per-account card table

Revision ID: 110
Revises: 109
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "110"
down_revision = "109"
branch_labels = None
depends_on = None

# Pluggy sends the card of each credit-card charge at
# creditCardMetadata.cardNumber. raw_data may hold any JSON value (or a plain
# `json` column on older databases), so only objects whose cardNumber is a
# string or number are read.
_CARD_NUMBER = "(raw_data::jsonb -> 'creditCardMetadata' -> 'cardNumber')"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    transaction_columns = {column["name"] for column in inspector.get_columns("transactions")}
    if "card_last4" not in transaction_columns:
        op.add_column("transactions", sa.Column("card_last4", sa.String(8), nullable=True))

    if "account_cards" not in inspector.get_table_names():
        op.create_table(
            "account_cards",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "workspace_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "account_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("accounts.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("last4", sa.String(8), nullable=False),
            sa.Column("alias", sa.String(100), nullable=True),
            sa.Column("is_hidden", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("account_id", "last4", name="uq_account_cards_account_last4"),
        )
        op.create_index("ix_account_cards_workspace_id", "account_cards", ["workspace_id"])
        op.create_index("ix_account_cards_account_id", "account_cards", ["account_id"])

    bind.execute(
        sa.text(
            f"""
            UPDATE transactions
            SET card_last4 = right({_CARD_NUMBER} #>> '{{}}', 4)
            WHERE raw_data IS NOT NULL
              AND card_last4 IS NULL
              AND jsonb_typeof(raw_data::jsonb) = 'object'
              AND jsonb_typeof(raw_data::jsonb -> 'creditCardMetadata') = 'object'
              AND jsonb_typeof({_CARD_NUMBER}) IN ('string', 'number')
              AND length({_CARD_NUMBER} #>> '{{}}') > 0
            """
        )
    )
    bind.execute(
        sa.text(
            """
            INSERT INTO account_cards (id, workspace_id, account_id, last4, is_hidden, created_at, updated_at)
            SELECT gen_random_uuid(), workspace_id, account_id, card_last4, false, now(), now()
            FROM (
                SELECT DISTINCT workspace_id, account_id, card_last4
                FROM transactions
                WHERE card_last4 IS NOT NULL AND workspace_id IS NOT NULL
            ) AS seen
            ON CONFLICT (account_id, last4) DO NOTHING
            """
        )
    )


def downgrade() -> None:
    op.drop_table("account_cards")
    op.drop_column("transactions", "card_last4")
