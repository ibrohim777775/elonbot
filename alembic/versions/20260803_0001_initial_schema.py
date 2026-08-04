"""Create initial announcement bot schema.

Revision ID: 20260803_0001
Revises:
Create Date: 2026-08-03 00:00:00
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260803_0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


chat_type = sa.Enum("group", "supergroup", "channel", name="chat_type")
announcement_status = sa.Enum("active", "paused", "deleted", name="announcement_status")
first_run_mode = sa.Enum("immediate", "scheduled", name="first_run_mode")
delivery_status = sa.Enum("sent", "failed", "rate_limited", "skipped", name="delivery_status")


def upgrade() -> None:
    chat_type.create(op.get_bind(), checkfirst=True)
    announcement_status.create(op.get_bind(), checkfirst=True)
    first_run_mode.create(op.get_bind(), checkfirst=True)
    delivery_status.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("telegram_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=255)),
        sa.Column("first_name", sa.String(length=255)),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("telegram_id"),
    )
    op.create_index("ix_users_telegram_id", "users", ["telegram_id"])

    op.create_table(
        "groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("chat_type", chat_type, nullable=False),
        sa.Column("bot_can_post", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("verified_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("chat_id"),
    )

    op.create_table(
        "user_groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("group_id", sa.BigInteger(), sa.ForeignKey("groups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("connected_by_telegram_id", sa.BigInteger(), nullable=False),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.UniqueConstraint("user_id", "group_id", name="uq_user_groups_user_group"),
    )

    op.create_table(
        "templates",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("photo_file_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    op.create_table(
        "announcements",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("photo_file_id", sa.Text()),
        sa.Column("contact_phone", sa.String(length=32)),
        sa.Column("contact_telegram", sa.String(length=255)),
        sa.Column("contact_name", sa.String(length=255)),
        sa.Column("interval_minutes", sa.Integer(), nullable=False),
        sa.Column("status", announcement_status, nullable=False, server_default="active"),
        sa.Column("first_run_mode", first_run_mode, nullable=False),
        sa.Column("next_run_at", sa.DateTime(timezone=True)),
        sa.Column("last_run_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("contact_phone IS NOT NULL OR contact_telegram IS NOT NULL", name="ck_announcements_contact_required"),
        sa.CheckConstraint("interval_minutes > 0", name="ck_announcements_positive_interval"),
    )
    op.create_index("ix_announcements_next_run_at", "announcements", ["next_run_at"])
    op.create_index("ix_announcements_status_next_run_at", "announcements", ["status", "next_run_at"])

    op.create_table(
        "announcement_groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("announcement_id", sa.BigInteger(), sa.ForeignKey("announcements.id", ondelete="CASCADE"), nullable=False),
        sa.Column("group_id", sa.BigInteger(), sa.ForeignKey("groups.id", ondelete="CASCADE"), nullable=False),
        sa.UniqueConstraint("announcement_id", "group_id", name="uq_announcement_groups"),
    )

    op.create_table(
        "delivery_logs",
        sa.Column("id", sa.BigInteger(), sa.Identity(), primary_key=True),
        sa.Column("announcement_id", sa.BigInteger(), sa.ForeignKey("announcements.id", ondelete="CASCADE"), nullable=False),
        sa.Column("group_id", sa.BigInteger(), sa.ForeignKey("groups.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("status", delivery_status, nullable=False),
        sa.Column("telegram_message_id", sa.BigInteger()),
        sa.Column("error_code", sa.String(length=128)),
        sa.Column("error_message", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("announcement_id", "group_id", "scheduled_at", name="uq_delivery_logs_schedule_group"),
    )
    op.create_index("ix_delivery_logs_announcement_scheduled", "delivery_logs", ["announcement_id", "scheduled_at"])


def downgrade() -> None:
    op.drop_index("ix_delivery_logs_announcement_scheduled", table_name="delivery_logs")
    op.drop_table("delivery_logs")
    op.drop_table("announcement_groups")
    op.drop_index("ix_announcements_status_next_run_at", table_name="announcements")
    op.drop_index("ix_announcements_next_run_at", table_name="announcements")
    op.drop_table("announcements")
    op.drop_table("templates")
    op.drop_table("user_groups")
    op.drop_table("groups")
    op.drop_index("ix_users_telegram_id", table_name="users")
    op.drop_table("users")

    delivery_status.drop(op.get_bind(), checkfirst=True)
    first_run_mode.drop(op.get_bind(), checkfirst=True)
    announcement_status.drop(op.get_bind(), checkfirst=True)
    chat_type.drop(op.get_bind(), checkfirst=True)
