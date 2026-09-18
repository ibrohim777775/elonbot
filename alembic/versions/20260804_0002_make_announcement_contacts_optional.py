"""Allow announcements without a contact method.

Revision ID: 20260804_0002
Revises: 20260803_0001
Create Date: 2026-08-04 00:00:00
"""

from collections.abc import Sequence

from alembic import op


revision: str = "20260804_0002"
down_revision: str | Sequence[str] | None = "20260803_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_announcements_contact_required", "announcements", type_="check")


def downgrade() -> None:
    op.create_check_constraint(
        "ck_announcements_contact_required",
        "announcements",
        "contact_phone IS NOT NULL OR contact_telegram IS NOT NULL",
    )
