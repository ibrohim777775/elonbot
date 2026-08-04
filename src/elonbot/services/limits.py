"""Product-level limits independent from Telegram API limits."""

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.config import get_settings
from elonbot.database.base import utc_now
from elonbot.database.enums import AnnouncementStatus
from elonbot.database.models import Announcement, DeliveryLog, UserGroup


async def can_create_announcement(session: AsyncSession, user_id: int) -> bool:
    """Check the configured active-announcement limit for one user."""
    count = await session.scalar(
        select(func.count()).select_from(Announcement).where(
            Announcement.user_id == user_id, Announcement.status == AnnouncementStatus.ACTIVE
        )
    )
    return (count or 0) < get_settings().max_active_announcements_per_user


async def can_connect_group(session: AsyncSession, user_id: int) -> bool:
    """Check the configured connected-group limit for one user."""
    count = await session.scalar(
        select(func.count()).select_from(UserGroup).where(
            UserGroup.user_id == user_id, UserGroup.is_active.is_(True)
        )
    )
    return (count or 0) < get_settings().max_groups_per_user


async def can_deliver_today(session: AsyncSession, user_id: int) -> bool:
    """Check the daily delivery quota for the announcement owner."""
    since = utc_now() - timedelta(days=1)
    count = await session.scalar(
        select(func.count())
        .select_from(DeliveryLog)
        .join(Announcement, Announcement.id == DeliveryLog.announcement_id)
        .where(Announcement.user_id == user_id, DeliveryLog.created_at >= since)
    )
    return (count or 0) < get_settings().max_deliveries_per_user_per_day
