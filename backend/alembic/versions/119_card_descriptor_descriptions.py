"""name C6 card purchases after the merchant instead of the purchase kind

C6 sends every card purchase through Pluggy as "Compra a Vista sem Juros
MasterCard" and puts the merchant descriptor only in `descriptionRaw`. Sync
now takes the descriptor; rows already stored are renamed here the same way
(whitespace runs collapsed, trailing country dropped). Rows whose description
the user changed are left alone. The generic label is restorable from
`raw_data->>'description'`, which the downgrade does.

Revision ID: 119
Revises: 118
"""

from alembic import op

revision = "119"
down_revision = "118"
branch_labels = None
depends_on = None

_GENERIC = r"'^compra\y.*\y(mastercard|visa|elo)$'"
_DESCRIPTOR = (
    "regexp_replace(btrim(regexp_replace(raw_data->>'descriptionRaw', '\\s+', ' ', 'g')),"
    " '\\s+BRA$', '')"
)


def upgrade() -> None:
    op.execute(
        f"""
        UPDATE transactions
        SET description = {_DESCRIPTOR},
            original_description = {_DESCRIPTOR}
        WHERE description ~* {_GENERIC}
          AND description = original_description
          AND {_DESCRIPTOR} <> ''
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE transactions
        SET description = raw_data->>'description',
            original_description = raw_data->>'description'
        WHERE raw_data->>'description' ~* {_GENERIC}
          AND description = original_description
          AND description = {_DESCRIPTOR}
        """
    )
