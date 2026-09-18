"""Store group Slow Mode and whether the bot is an administrator.

Revision ID: 20260805_0005
Revises: 20260805_0004
Create Date: 2026-08-05 00:00:00
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260805_0005"
down_revision: str | Sequence[str] | None = "20260805_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "groups", sa.Column("slow_mode_delay", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "groups", sa.Column("bot_is_admin", sa.Boolean(), nullable=False, server_default=sa.false())
    )


def downgrade() -> None:
    op.drop_column("groups", "bot_is_admin")
    op.drop_column("groups", "slow_mode_delay")
