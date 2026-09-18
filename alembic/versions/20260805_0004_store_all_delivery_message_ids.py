"""Store every Telegram message ID created by one delivery attempt.

Revision ID: 20260805_0004
Revises: 20260805_0003
Create Date: 2026-08-05 00:00:00
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa

revision: str = "20260805_0004"
down_revision: str | Sequence[str] | None = "20260805_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

def upgrade() -> None:
    op.add_column("delivery_logs", sa.Column("telegram_message_ids", sa.JSON(), nullable=True))
    op.execute("UPDATE delivery_logs SET telegram_message_ids = json_build_array(telegram_message_id) WHERE telegram_message_id IS NOT NULL")

def downgrade() -> None:
    op.drop_column("delivery_logs", "telegram_message_ids")
