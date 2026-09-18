"""ORM models for users, groups, templates, announcements, and deliveries."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from elonbot.database.base import Base, utc_now
from elonbot.database.enums import (
    AnnouncementStatus,
    ChatType,
    DeliveryStatus,
    FirstRunMode,
)

if TYPE_CHECKING:
    from sqlalchemy.orm import Relationship


def enum_values(enum_class: type[StrEnum]) -> list[str]:
    """Store the enum values used by the PostgreSQL enum types, not member names."""
    return [member.value for member in enum_class]


class TimestampMixin:
    """Add creation and modification timestamps to a model."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, onupdate=utc_now, server_default=func.now()
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False, index=True)
    username: Mapped[str | None] = mapped_column(String(255))
    first_name: Mapped[str | None] = mapped_column(String(255))
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )

    group_connections: Mapped[list[UserGroup]] = relationship(back_populates="user")
    templates: Mapped[list[Template]] = relationship(back_populates="user", cascade="all, delete-orphan")
    announcements: Mapped[list[Announcement]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class TelegramGroup(Base):
    __tablename__ = "groups"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    chat_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    chat_type: Mapped[ChatType] = mapped_column(
        Enum(ChatType, name="chat_type", values_callable=enum_values), nullable=False
    )
    bot_can_post: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    bot_is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    slow_mode_delay: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user_connections: Mapped[list[UserGroup]] = relationship(back_populates="group")
    announcement_links: Mapped[list[AnnouncementGroup]] = relationship(back_populates="group")
    deliveries: Mapped[list[DeliveryLog]] = relationship(back_populates="group")


class UserGroup(Base):
    __tablename__ = "user_groups"
    __table_args__ = (UniqueConstraint("user_id", "group_id", name="uq_user_groups_user_group"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)
    connected_by_telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")

    user: Mapped[User] = relationship(back_populates="group_connections")
    group: Mapped[TelegramGroup] = relationship(back_populates="user_connections")


class Template(TimestampMixin, Base):
    __tablename__ = "templates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    photo_file_id: Mapped[str | None] = mapped_column(Text)
    photo_file_ids: Mapped[list[str] | None] = mapped_column(JSON)

    user: Mapped[User] = relationship(back_populates="templates")


class Announcement(TimestampMixin, Base):
    __tablename__ = "announcements"
    __table_args__ = (
        CheckConstraint("interval_minutes > 0", name="ck_announcements_positive_interval"),
        Index("ix_announcements_status_next_run_at", "status", "next_run_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    photo_file_id: Mapped[str | None] = mapped_column(Text)
    photo_file_ids: Mapped[list[str] | None] = mapped_column(JSON)
    contact_phone: Mapped[str | None] = mapped_column(String(32))
    contact_telegram: Mapped[str | None] = mapped_column(String(255))
    contact_name: Mapped[str | None] = mapped_column(String(255))
    interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[AnnouncementStatus] = mapped_column(
        Enum(AnnouncementStatus, name="announcement_status", values_callable=enum_values),
        nullable=False,
        default=AnnouncementStatus.ACTIVE,
        server_default=AnnouncementStatus.ACTIVE.value,
    )
    first_run_mode: Mapped[FirstRunMode] = mapped_column(
        Enum(FirstRunMode, name="first_run_mode", values_callable=enum_values), nullable=False
    )
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="announcements")
    group_links: Mapped[list[AnnouncementGroup]] = relationship(
        back_populates="announcement", cascade="all, delete-orphan"
    )
    deliveries: Mapped[list[DeliveryLog]] = relationship(
        back_populates="announcement", cascade="all, delete-orphan"
    )


class AnnouncementGroup(Base):
    __tablename__ = "announcement_groups"
    __table_args__ = (UniqueConstraint("announcement_id", "group_id", name="uq_announcement_groups"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    announcement_id: Mapped[int] = mapped_column(
        ForeignKey("announcements.id", ondelete="CASCADE"), nullable=False
    )
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)

    announcement: Mapped[Announcement] = relationship(back_populates="group_links")
    group: Mapped[TelegramGroup] = relationship(back_populates="announcement_links")


class DeliveryLog(Base):
    __tablename__ = "delivery_logs"
    __table_args__ = (
        Index("ix_delivery_logs_announcement_scheduled", "announcement_id", "scheduled_at"),
        UniqueConstraint(
            "announcement_id", "group_id", "scheduled_at", name="uq_delivery_logs_schedule_group"
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    announcement_id: Mapped[int] = mapped_column(
        ForeignKey("announcements.id", ondelete="CASCADE"), nullable=False
    )
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[DeliveryStatus] = mapped_column(
        Enum(DeliveryStatus, name="delivery_status", values_callable=enum_values), nullable=False
    )
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    telegram_message_ids: Mapped[list[int] | None] = mapped_column(JSON)
    error_code: Mapped[str | None] = mapped_column(String(128))
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utc_now, server_default=func.now()
    )

    announcement: Mapped[Announcement] = relationship(back_populates="deliveries")
    group: Mapped[TelegramGroup] = relationship(back_populates="deliveries")
