"""recolor categories that sit in a group to the group's color

A new category filed in a group now takes that group's color. Categories
created before that kept their own color, so they are brought in line here.
Colors the user picked for a category are overwritten; the previous values
are not recorded anywhere, so this migration cannot restore them.

Revision ID: 118
Revises: 117
"""

from alembic import op

revision = "118"
down_revision = "117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE categories AS c
        SET color = g.color
        FROM category_groups AS g
        WHERE c.group_id = g.id
        """
    )


def downgrade() -> None:
    # The replaced colors were not kept, so there is nothing to restore.
    pass
