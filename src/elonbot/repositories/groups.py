"""Persistence operations for Telegram groups and user-group connections."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.base import utc_now
from elonbot.database.enums import AnnouncementStatus, ChatType
from elonbot.database.models import Announcement, AnnouncementGroup, TelegramGroup, UserGroup


@dataclass(frozen=True)
class ConnectedGroup:
    """A group visible in one user's group list."""

    id: int
    chat_id: int
    title: str
    bot_can_post: bool
    is_active: bool


async def connect_group(
    session: AsyncSession,
    *,
    user_id: int,
    connected_by_telegram_id: int,
    chat_id: int,
    title: str,
    chat_type: ChatType,
) -> TelegramGroup:
    """Upsert a Telegram group and create or reactivate the user's connection to it."""
    now = utc_now()
    group_statement = (
        insert(TelegramGroup)
        .values(
            chat_id=chat_id,
            title=title,
            chat_type=chat_type,
            bot_can_post=True,
            is_active=True,
            verified_at=now,
        )
        .on_conflict_do_update(
            index_elements=[TelegramGroup.chat_id],
            set_={
                "title": title,
                "chat_type": chat_type,
                "bot_can_post": True,
                "is_active": True,
                "verified_at": now,
            },
        )
        .returning(TelegramGroup)
    )
    group = (await session.execute(group_statement)).scalar_one()

    connection_statement = insert(UserGroup).values(
        user_id=user_id,
        group_id=group.id,
        connected_by_telegram_id=connected_by_telegram_id,
        connected_at=now,
        is_active=True,
    ).on_conflict_do_update(
        constraint="uq_user_groups_user_group",
        set_={
            "connected_by_telegram_id": connected_by_telegram_id,
            "connected_at": now,
            "is_active": True,
        },
    )
    await session.execute(connection_statement)
    return group


async def observe_group_access(
    session: AsyncSession,
    *,
    chat_id: int,
    title: str,
    chat_type: ChatType,
    bot_can_post: bool,
) -> None:
    """Persist the bot's latest known access state after a membership update."""
    now = utc_now()
    statement = insert(TelegramGroup).values(
        chat_id=chat_id,
        title=title,
        chat_type=chat_type,
        bot_can_post=bot_can_post,
        is_active=bot_can_post,
        verified_at=now,
    ).on_conflict_do_update(
        index_elements=[TelegramGroup.chat_id],
        set_={
            "title": title,
            "chat_type": chat_type,
            "bot_can_post": bot_can_post,
            "is_active": bot_can_post,
            "verified_at": now,
        },
    )
    await session.execute(statement)


async def list_user_groups(session: AsyncSession, user_id: int) -> list[ConnectedGroup]:
    """Return groups connected by the current user."""
    statement = (
        select(
            TelegramGroup.id,
            TelegramGroup.chat_id,
            TelegramGroup.title,
            TelegramGroup.bot_can_post,
            TelegramGroup.is_active,
        )
        .join(UserGroup, UserGroup.group_id == TelegramGroup.id)
        .where(UserGroup.user_id == user_id, UserGroup.is_active.is_(True))
        .order_by(TelegramGroup.title)
    )
    rows = (await session.execute(statement)).all()
    return [ConnectedGroup(*row) for row in rows]


async def get_user_group(
    session: AsyncSession, *, user_id: int, group_id: int
) -> ConnectedGroup | None:
    """Get a group only if it is connected by the specified user."""
    statement = (
        select(
            TelegramGroup.id,
            TelegramGroup.chat_id,
            TelegramGroup.title,
            TelegramGroup.bot_can_post,
            TelegramGroup.is_active,
        )
        .join(UserGroup, UserGroup.group_id == TelegramGroup.id)
        .where(
            UserGroup.user_id == user_id,
            UserGroup.group_id == group_id,
            UserGroup.is_active.is_(True),
        )
    )
    row = (await session.execute(statement)).one_or_none()
    return ConnectedGroup(*row) if row else None


async def disconnect_group(session: AsyncSession, *, user_id: int, group_id: int) -> bool:
    """Disconnect a group from one user and pause their empty announcements."""
    connection = await get_user_group(session, user_id=user_id, group_id=group_id)
    if connection is None:
        return False

    affected_announcements = (
        await session.execute(
            select(Announcement.id)
            .join(AnnouncementGroup, AnnouncementGroup.announcement_id == Announcement.id)
            .where(Announcement.user_id == user_id, AnnouncementGroup.group_id == group_id)
        )
    ).scalars().all()

    if affected_announcements:
        await session.execute(
            delete(AnnouncementGroup).where(
                AnnouncementGroup.group_id == group_id,
                AnnouncementGroup.announcement_id.in_(affected_announcements),
            )
        )
        for announcement_id in affected_announcements:
            remaining_link = await session.scalar(
                select(AnnouncementGroup.id).where(AnnouncementGroup.announcement_id == announcement_id)
            )
            if remaining_link is None:
                announcement = await session.get(Announcement, announcement_id)
                if announcement is not None:
                    announcement.status = AnnouncementStatus.PAUSED
                    announcement.next_run_at = None

    await session.execute(
        delete(UserGroup).where(UserGroup.user_id == user_id, UserGroup.group_id == group_id)
    )
    return True
