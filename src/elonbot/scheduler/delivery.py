"""Persistent scheduled delivery of announcements to Telegram groups."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta
from html import escape
import logging
import re

from aiogram import Bot
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from aiogram.types import InputMediaPhoto
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import selectinload

from elonbot.database.base import utc_now
from elonbot.database.enums import AnnouncementStatus, DeliveryStatus
from elonbot.config import get_settings
from elonbot.database.models import Announcement, AnnouncementGroup, DeliveryLog, TelegramGroup, User
from elonbot.services.limits import can_deliver_today

logger = logging.getLogger(__name__)
PHONE_PATTERN = re.compile(r"\+?\d[\d\s()\-]{6,}\d")
BOT_TOKEN_PATTERN = re.compile(r"\b\d{6,}:[A-Za-z0-9_-]{20,}\b")
USERNAME_PATTERN = re.compile(r"^@?([A-Za-z0-9_]{5,32})$")
TME_PATTERN = re.compile(r"^(?:https?://)?t\.me/([A-Za-z0-9_]{5,32})/?$")


def sanitize_error_message(error: Exception) -> str:
    """Prevent Telegram tokens and complete phone numbers from reaching logs or the database."""
    text = BOT_TOKEN_PATTERN.sub("[bot-token]", str(error))
    return PHONE_PATTERN.sub("[phone]", text)[:1000]


def render_delivery_text(announcement: Announcement) -> str:
    """Build HTML-safe delivery text with an optional clickable Telegram profile."""
    parts = [escape(announcement.text)]
    if announcement.contact_name:
        parts.append(f"\n{escape(announcement.contact_name)}")
    if announcement.contact_phone:
        parts.append(f"Tel: {escape(announcement.contact_phone)}")
    if announcement.contact_telegram:
        contact = announcement.contact_telegram.strip()
        match = USERNAME_PATTERN.fullmatch(contact) or TME_PATTERN.fullmatch(contact)
        if match:
            username = match.group(1)
            parts.append(f'Telegram: <a href="https://t.me/{username}">@{username}</a>')
        else:
            parts.append(f"Telegram: {escape(contact)}")
    return "\n".join(parts)


class DeliveryService:
    """Processes due rows from PostgreSQL in a single idempotent transaction."""

    def __init__(self, bot: Bot, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self.bot = bot
        self.session_factory = session_factory
        self.sent_at: deque[tuple[float, int]] = deque()

    def _within_rate_limit(self, chat_id: int) -> bool:
        """Apply the configured global and per-chat one-minute limits."""
        now = utc_now().timestamp()
        while self.sent_at and self.sent_at[0][0] <= now - 60:
            self.sent_at.popleft()
        settings = get_settings()
        return (
            len(self.sent_at) < settings.max_messages_per_minute
            and sum(previous_chat == chat_id for _, previous_chat in self.sent_at)
            < settings.max_messages_per_chat_per_minute
        )

    async def process_due(self) -> None:
        """Deliver all currently due announcements and schedule their next run."""
        async with self.session_factory() as session:
            now = utc_now()
            result = await session.execute(
                select(Announcement)
                .where(
                    Announcement.status != AnnouncementStatus.DELETED,
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
                retry_at: datetime | None = None
                for link in announcement.group_links:
                    if not link.group.is_active or not link.group.bot_can_post:
                        continue
                    if not await can_deliver_today(session, announcement.user_id):
                        logger.warning("delivery_daily_limit", extra={"announcement_id": announcement.id})
                        break
                    if not self._within_rate_limit(link.group.chat_id):
                        retry_at = now + timedelta(minutes=1)
                        break
                    if not link.group.bot_is_admin:
                        retry_at = await self._slow_mode_retry_at(
                            session, link.group.id, link.group.slow_mode_delay, now
                        )
                        if retry_at is not None:
                            break
                    retry_at = await self._deliver_one(
                        session, announcement, link.group.id, link.group.chat_id, scheduled_at
                    )
                    if retry_at is not None:
                        break
                announcement.last_run_at = now
                announcement.next_run_at = retry_at or now + timedelta(minutes=announcement.interval_minutes)
            await session.commit()

    async def _slow_mode_retry_at(
        self, session: AsyncSession, group_id: int, slow_mode_delay: int, now: datetime
    ) -> datetime | None:
        """Respect a group's Slow Mode when the bot is not an administrator."""
        if slow_mode_delay <= 0:
            return None
        last_sent_at = await session.scalar(
            select(func.max(DeliveryLog.sent_at)).where(
                DeliveryLog.group_id == group_id,
                DeliveryLog.status == DeliveryStatus.SENT,
            )
        )
        if last_sent_at is None:
            return None
        allowed_at = last_sent_at + timedelta(seconds=slow_mode_delay)
        return allowed_at if allowed_at > now else None

    async def _deliver_one(
        self, session: AsyncSession, announcement: Announcement, group_id: int, chat_id: int, scheduled_at
    ) -> datetime | None:
        """Send one idempotent group message and write its delivery result."""
        existing = await session.scalar(
            select(DeliveryLog.id).where(
                DeliveryLog.announcement_id == announcement.id,
                DeliveryLog.group_id == group_id,
                DeliveryLog.scheduled_at == scheduled_at,
            )
        )
        if existing is not None:
            return None
        log = DeliveryLog(
            announcement_id=announcement.id,
            group_id=group_id,
            scheduled_at=scheduled_at,
            status=DeliveryStatus.FAILED,
        )
        session.add(log)
        try:
            text = render_delivery_text(announcement)
            sent_messages = []
            photo_file_ids = announcement.photo_file_ids or (
                [announcement.photo_file_id] if announcement.photo_file_id else []
            )
            if len(photo_file_ids) > 1:
                media = [InputMediaPhoto(media=photo_file_id) for photo_file_id in photo_file_ids]
                if len(text) <= 1024:
                    media[0].caption = text
                    media[0].parse_mode = "HTML"
                messages = await self.bot.send_media_group(chat_id, media=media)
                sent_messages.extend(messages)
                sent = messages[-1]
                if len(text) > 1024:
                    sent = await self.bot.send_message(chat_id, text, parse_mode="HTML")
                    sent_messages.append(sent)
            elif photo_file_ids:
                if len(text) <= 1024:
                    sent = await self.bot.send_photo(chat_id, photo_file_ids[0], caption=text, parse_mode="HTML")
                    sent_messages.append(sent)
                else:
                    photo = await self.bot.send_photo(chat_id, photo_file_ids[0])
                    sent_messages.append(photo)
                    sent = await self.bot.send_message(chat_id, text, parse_mode="HTML")
                    sent_messages.append(sent)
            else:
                sent = await self.bot.send_message(chat_id, text, parse_mode="HTML")
                sent_messages.append(sent)
            log.status = DeliveryStatus.SENT
            log.sent_at = utc_now()
            log.telegram_message_id = sent.message_id
            log.telegram_message_ids = [message.message_id for message in sent_messages]
            self.sent_at.append((utc_now().timestamp(), chat_id))
            return None
        except TelegramRetryAfter as error:
            log.status = DeliveryStatus.RATE_LIMITED
            log.error_code = "429"
            log.error_message = "Telegram rate limit exceeded"
            return utc_now() + timedelta(seconds=error.retry_after)
        except TelegramForbiddenError:
            log.status = DeliveryStatus.FAILED
            log.error_code = "forbidden"
            log.error_message = "Bot cannot post in this group"
            await session.execute(
                update(TelegramGroup).where(TelegramGroup.id == group_id).values(is_active=False, bot_can_post=False)
            )
            owner_telegram_id = await session.scalar(
                select(User.telegram_id).where(User.id == announcement.user_id)
            )
            if owner_telegram_id is not None:
                try:
                    await self.bot.send_message(owner_telegram_id, "Guruhga yuborish to'xtatildi: botda huquq yo'q.")
                except Exception:
                    logger.warning("delivery_owner_notification_failed", extra={"announcement_id": announcement.id})
            return None
        except Exception as error:
            log.status = DeliveryStatus.FAILED
            log.error_code = type(error).__name__
            log.error_message = sanitize_error_message(error)
            logger.exception(
                "delivery_failed", extra={"announcement_id": announcement.id, "group_id": group_id}
            )
            return None
