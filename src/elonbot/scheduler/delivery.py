"""Persistent scheduled delivery of announcements to Telegram groups."""

from __future__ import annotations

from datetime import timedelta

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from elonbot.database.base import utc_now
from elonbot.database.enums import AnnouncementStatus, DeliveryStatus
from elonbot.database.models import Announcement, AnnouncementGroup, DeliveryLog


def render_delivery_text(announcement: Announcement) -> str:
    """Build user-facing announcement text with optional contact details."""
    parts = [announcement.text]
    if announcement.contact_name:
        parts.append(f"\n{announcement.contact_name}")
    if announcement.contact_phone:
        parts.append(f"Tel: {announcement.contact_phone}")
    if announcement.contact_telegram:
        parts.append(f"Telegram: {announcement.contact_telegram}")
    return "\n".join(parts)


class DeliveryService:
    """Processes due rows from PostgreSQL in a single idempotent transaction."""

    def __init__(self, bot: Bot, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.bot = bot
        self.session_factory = session_factory

    async def process_due(self) -> None:
        """Deliver all currently due announcements and schedule their next run."""
        async with self.session_factory() as session:
            now = utc_now()
            result = await session.execute(
                select(Announcement)
                .where(
                    Announcement.status == AnnouncementStatus.ACTIVE,
                    Announcement.next_run_at.is_not(None),
                    Announcement.next_run_at <= now,
                )
                .options(selectinload(Announcement.group_links).selectinload(AnnouncementGroup.group))
                .with_for_update(skip_locked=True)
            )
            for announcement in result.scalars().unique():
                scheduled_at = announcement.next_run_at
                if scheduled_at is None:
                    continue
                for link in announcement.group_links:
                    if not link.group.is_active or not link.group.bot_can_post:
                        continue
                    await self._deliver_one(session, announcement, link.group.id, link.group.chat_id, scheduled_at)
                announcement.last_run_at = now
                announcement.next_run_at = now + timedelta(minutes=announcement.interval_minutes)
            await session.commit()

    async def _deliver_one(
        self, session: AsyncSession, announcement: Announcement, group_id: int, chat_id: int, scheduled_at
    ) -> None:
        """Send one idempotent group message and write its delivery result."""
        existing = await session.scalar(
            select(DeliveryLog.id).where(
                DeliveryLog.announcement_id == announcement.id,
                DeliveryLog.group_id == group_id,
                DeliveryLog.scheduled_at == scheduled_at,
            )
        )
        if existing is not None:
            return
        log = DeliveryLog(
            announcement_id=announcement.id,
            group_id=group_id,
            scheduled_at=scheduled_at,
            status=DeliveryStatus.FAILED,
        )
        session.add(log)
        try:
            text = render_delivery_text(announcement)
            if announcement.photo_file_id:
                if len(text) <= 1024:
                    sent = await self.bot.send_photo(chat_id, announcement.photo_file_id, caption=text)
                else:
                    await self.bot.send_photo(chat_id, announcement.photo_file_id)
                    sent = await self.bot.send_message(chat_id, text)
            else:
                sent = await self.bot.send_message(chat_id, text)
            log.status = DeliveryStatus.SENT
            log.sent_at = utc_now()
            log.telegram_message_id = sent.message_id
        except TelegramRetryAfter as error:
            log.status = DeliveryStatus.RATE_LIMITED
            log.error_code = "429"
            log.error_message = str(error)
            announcement.next_run_at = utc_now() + timedelta(seconds=error.retry_after)
        except TelegramForbiddenError as error:
            log.status = DeliveryStatus.FAILED
            log.error_code = "forbidden"
            log.error_message = str(error)
        except Exception as error:
            log.status = DeliveryStatus.FAILED
            log.error_code = type(error).__name__
            log.error_message = str(error)[:1000]
