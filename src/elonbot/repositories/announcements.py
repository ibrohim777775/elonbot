"""Persistence operations for user announcements."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from elonbot.database.enums import AnnouncementStatus, FirstRunMode
from elonbot.database.models import Announcement, AnnouncementGroup, DeliveryLog, TelegramGroup


async def list_announcements(session: AsyncSession, user_id: int) -> list[Announcement]:
    result = await session.execute(
        select(Announcement)
        .where(Announcement.user_id == user_id, Announcement.status != AnnouncementStatus.DELETED)
        .options(selectinload(Announcement.group_links))
        .order_by(Announcement.updated_at.desc())
    )
    return list(result.scalars())


async def get_announcement(
    session: AsyncSession, *, user_id: int, announcement_id: int
) -> Announcement | None:
    result = await session.execute(
        select(Announcement)
        .where(
            Announcement.id == announcement_id,
            Announcement.user_id == user_id,
            Announcement.status != AnnouncementStatus.DELETED,
        )
        .options(selectinload(Announcement.group_links))
    )
    return result.scalar_one_or_none()


async def create_announcement(
    session: AsyncSession,
    *,
    user_id: int,
    text: str,
    photo_file_id: str | None,
    photo_file_ids: list[str] | None,
    contact_phone: str | None,
    contact_telegram: str | None,
    contact_name: str | None,
    interval_minutes: int,
    first_run_mode: FirstRunMode,
    next_run_at: datetime,
    group_ids: list[int],
) -> Announcement:
    announcement = Announcement(
        user_id=user_id,
        text=text,
        photo_file_id=photo_file_id,
        photo_file_ids=photo_file_ids,
        contact_phone=contact_phone,
        contact_telegram=contact_telegram,
        contact_name=contact_name,
        interval_minutes=interval_minutes,
        first_run_mode=first_run_mode,
        next_run_at=next_run_at,
        status=AnnouncementStatus.ACTIVE,
    )
    session.add(announcement)
    await session.flush()
    session.add_all(
        [AnnouncementGroup(announcement_id=announcement.id, group_id=group_id) for group_id in group_ids]
    )
    await session.flush()
    return announcement


async def set_announcement_status(
    session: AsyncSession, *, user_id: int, announcement_id: int, status: AnnouncementStatus
) -> bool:
    values: dict[str, object] = {"status": status}
    if status == AnnouncementStatus.PAUSED:
        values["next_run_at"] = None
    result = await session.execute(
        update(Announcement)
        .where(Announcement.id == announcement_id, Announcement.user_id == user_id)
        .values(**values)
    )
    return result.rowcount == 1


async def delete_announcement(session: AsyncSession, *, user_id: int, announcement_id: int) -> bool:
    result = await session.execute(
        delete(Announcement).where(Announcement.id == announcement_id, Announcement.user_id == user_id)
    )
    return result.rowcount == 1


async def list_delivery_message_ids(
    session: AsyncSession, *, user_id: int, announcement_id: int
) -> list[tuple[int, list[int]]]:
    """Return sent Telegram message IDs only for an announcement owned by the user."""
    rows = await session.execute(
        select(DeliveryLog.telegram_message_id, DeliveryLog.telegram_message_ids, TelegramGroup.chat_id)
        .join(Announcement, Announcement.id == DeliveryLog.announcement_id)
        .join(TelegramGroup, TelegramGroup.id == DeliveryLog.group_id)
        .where(Announcement.id == announcement_id, Announcement.user_id == user_id)
    )
    result: list[tuple[int, list[int]]] = []
    for message_id, message_ids, chat_id in rows:
        result.append((chat_id, list(message_ids or ([message_id] if message_id else []))))
    return result


async def update_announcement(
    session: AsyncSession, *, user_id: int, announcement_id: int, **values: object
) -> bool:
    """Update selected announcement fields only when the current user owns it."""
    result = await session.execute(
        update(Announcement)
        .where(Announcement.id == announcement_id, Announcement.user_id == user_id)
        .values(**values)
    )
    return result.rowcount == 1


async def replace_announcement_groups(
    session: AsyncSession, *, user_id: int, announcement_id: int, group_ids: list[int]
) -> bool:
    """Replace selected groups for an owned announcement."""
    announcement = await get_announcement(session, user_id=user_id, announcement_id=announcement_id)
    if announcement is None:
        return False
    await session.execute(delete(AnnouncementGroup).where(AnnouncementGroup.announcement_id == announcement_id))
    session.add_all([AnnouncementGroup(announcement_id=announcement_id, group_id=group_id) for group_id in group_ids])
    return True
