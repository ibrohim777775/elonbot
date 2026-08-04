"""Telegram permission verification and group connection use cases."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from aiogram import Bot
from aiogram.types import Chat, ChatMember
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.enums import ChatType
from elonbot.database.models import TelegramGroup, User
from elonbot.repositories.groups import connect_group
from elonbot.services.limits import can_connect_group


class GroupConnectionResult(StrEnum):
    """Possible results of a group connection verification."""

    CONNECTED = "connected"
    USER_NOT_ADMIN = "user_not_admin"
    BOT_CANNOT_POST = "bot_cannot_post"
    LIMIT_REACHED = "limit_reached"


@dataclass(frozen=True)
class GroupConnectionOutcome:
    """Result returned to the handler after verification."""

    result: GroupConnectionResult
    group: TelegramGroup | None = None


def is_administrator(member: ChatMember) -> bool:
    """Return whether a chat member is an owner or administrator."""
    return str(member.status) in {"creator", "owner", "administrator"}


def can_bot_post(member: ChatMember) -> bool:
    """Return whether the bot's membership status permits group messages."""
    status = str(member.status)
    if status in {"left", "kicked", "banned"}:
        return False
    if status in {"creator", "owner", "administrator"}:
        return bool(getattr(member, "can_post_messages", True))
    if status == "restricted":
        return bool(getattr(member, "can_send_messages", False))
    return status == "member"


async def verify_and_connect_group(
    *, bot: Bot, session: AsyncSession, user: User, chat: Chat, connector_telegram_id: int
) -> GroupConnectionOutcome:
    """Verify Telegram access before persisting a user-to-group connection."""
    connector_member = await bot.get_chat_member(chat_id=chat.id, user_id=connector_telegram_id)
    if not is_administrator(connector_member):
        return GroupConnectionOutcome(GroupConnectionResult.USER_NOT_ADMIN)

    bot_profile = await bot.get_me()
    bot_member = await bot.get_chat_member(chat_id=chat.id, user_id=bot_profile.id)
    if not can_bot_post(bot_member):
        return GroupConnectionOutcome(GroupConnectionResult.BOT_CANNOT_POST)

    if not await can_connect_group(session, user.id):
        return GroupConnectionOutcome(GroupConnectionResult.LIMIT_REACHED)

    group = await connect_group(
        session,
        user_id=user.id,
        connected_by_telegram_id=connector_telegram_id,
        chat_id=chat.id,
        title=chat.title or str(chat.id),
        chat_type=ChatType(chat.type),
    )
    return GroupConnectionOutcome(GroupConnectionResult.CONNECTED, group)
