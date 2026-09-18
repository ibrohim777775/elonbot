"""Lookup helpers for replies to bot-published announcements."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.models import Announcement, DeliveryLog, TelegramGroup, User


async def get_announcement_reply_owner(
    session: AsyncSession, *, chat_id: int, replied_message_id: int
) -> int | None:
    """Return the announcement owner's Telegram ID when a group message replies to a delivery."""
    rows = await session.execute(
        select(DeliveryLog.telegram_message_id, DeliveryLog.telegram_message_ids, User.telegram_id)
        .join(Announcement, Announcement.id == DeliveryLog.announcement_id)
        .join(User, User.id == Announcement.user_id)
        .join(TelegramGroup, TelegramGroup.id == DeliveryLog.group_id)
        .where(TelegramGroup.chat_id == chat_id)
    )
    for message_id, message_ids, owner_telegram_id in rows:
        ids = list(message_ids or ([message_id] if message_id else []))
        if replied_message_id in ids:
            return owner_telegram_id
    return None
