"""Administrator-only aggregate bot statistics."""

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import Message
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.config import get_settings
from elonbot.database.enums import AnnouncementStatus, DeliveryStatus
from elonbot.database.models import Announcement, DeliveryLog, TelegramGroup, User
from elonbot.locales.translator import translate

router = Router(name="statistics")


@router.message(F.chat.type == "private", Command("statistika"))
async def statistics(message: Message, session: AsyncSession) -> None:
    """Show aggregate statistics only to configured Telegram administrators."""
    if message.from_user is None or message.from_user.id not in get_settings().admin_ids:
        await message.answer(translate("common.access_denied"))
        return
    users = await session.scalar(select(func.count()).select_from(User))
    groups = await session.scalar(select(func.count()).select_from(TelegramGroup))
    active = await session.scalar(
        select(func.count()).select_from(Announcement).where(Announcement.status == AnnouncementStatus.ACTIVE)
    )
    paused = await session.scalar(
        select(func.count()).select_from(Announcement).where(Announcement.status == AnnouncementStatus.PAUSED)
    )
    sent = await session.scalar(
        select(func.count()).select_from(DeliveryLog).where(DeliveryLog.status == DeliveryStatus.SENT)
    )
    failed = await session.scalar(
        select(func.count()).select_from(DeliveryLog).where(DeliveryLog.status == DeliveryStatus.FAILED)
    )
    await message.answer(
        translate(
            "statistics.report",
            title=translate("statistics.title"),
            users=users,
            groups=groups,
            active=active,
            paused=paused,
            sent=sent,
            failed=failed,
        )
    )
