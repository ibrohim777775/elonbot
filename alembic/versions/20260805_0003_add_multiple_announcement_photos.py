"""Store up to four Telegram photo IDs for an announcement.

Revision ID: 20260805_0003
Revises: 20260804_0002
Create Date: 2026-08-05 00:00:00
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260805_0003"
down_revision: str | Sequence[str] | None = "20260804_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("announcements", sa.Column("photo_file_ids", sa.JSON(), nullable=True))
    op.execute(
        "UPDATE announcements SET photo_file_ids = json_build_array(photo_file_id) "
        "WHERE photo_file_id IS NOT NULL"
    )
    op.add_column("templates", sa.Column("photo_file_ids", sa.JSON(), nullable=True))
    op.execute(
        "UPDATE templates SET photo_file_ids = json_build_array(photo_file_id) WHERE photo_file_id IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("templates", "photo_file_ids")
    op.drop_column("announcements", "photo_file_ids")
