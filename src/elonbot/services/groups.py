"""Telegram permission verification and group connection use cases."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError
from aiogram.types import Chat, ChatMember
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.enums import ChatType
from elonbot.database.models import TelegramGroup, User
from elonbot.repositories.groups import (
    connect_group,
    get_active_group_by_chat_id,
    get_active_group_by_id,
    has_user_group_connection,
    list_available_groups_for_user,
)
from elonbot.services.limits import can_connect_group


class GroupConnectionResult(StrEnum):
    """Possible results of a group connection verification."""

    CONNECTED = "connected"
    USER_NOT_MEMBER = "user_not_member"
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
    known_group = await get_active_group_by_chat_id(session, chat.id)
    if known_group is not None:
        if not await has_user_group_connection(session, user_id=user.id, group_id=known_group.id):
            if not await can_connect_group(session, user.id):
                return GroupConnectionOutcome(GroupConnectionResult.LIMIT_REACHED)
        group = await connect_group(
            session,
            user_id=user.id,
            connected_by_telegram_id=connector_telegram_id,
            chat_id=chat.id,
            title=chat.title or known_group.title,
            chat_type=ChatType(chat.type),
            slow_mode_delay=known_group.slow_mode_delay,
            bot_is_admin=known_group.bot_is_admin,
        )
        return GroupConnectionOutcome(GroupConnectionResult.CONNECTED, group)

    try:
        bot_profile = await bot.get_me()
        bot_member = await bot.get_chat_member(chat_id=chat.id, user_id=bot_profile.id)
    except (TelegramBadRequest, TelegramForbiddenError):
        return GroupConnectionOutcome(GroupConnectionResult.BOT_CANNOT_POST)
    if not can_bot_post(bot_member):
        return GroupConnectionOutcome(GroupConnectionResult.BOT_CANNOT_POST)

    if not await can_connect_group(session, user.id):
        return GroupConnectionOutcome(GroupConnectionResult.LIMIT_REACHED)

    try:
        chat_info = await bot.get_chat(chat.id)
        slow_mode_delay = int(getattr(chat_info, "slow_mode_delay", 0) or 0)
    except (TelegramBadRequest, TelegramForbiddenError):
        # The bot can still connect the group; Telegram's 429 response remains the final authority.
        slow_mode_delay = 0

    group = await connect_group(
        session,
        user_id=user.id,
        connected_by_telegram_id=connector_telegram_id,
        chat_id=chat.id,
        title=chat.title or str(chat.id),
        chat_type=ChatType(chat.type),
        slow_mode_delay=slow_mode_delay,
        bot_is_admin=is_administrator(bot_member),
    )
    return GroupConnectionOutcome(GroupConnectionResult.CONNECTED, group)


async def connect_known_group_for_user(
    *, bot: Bot, session: AsyncSession, user: User, group_id: int, connector_telegram_id: int
) -> GroupConnectionOutcome:
    """Connect a user to a group already known to have the bot installed."""
    group = await get_active_group_by_id(session, group_id)
    if group is None:
        return GroupConnectionOutcome(GroupConnectionResult.BOT_CANNOT_POST)
    try:
        connector_member = await bot.get_chat_member(chat_id=group.chat_id, user_id=connector_telegram_id)
    except (TelegramBadRequest, TelegramForbiddenError):
        return GroupConnectionOutcome(GroupConnectionResult.USER_NOT_MEMBER)
    if str(connector_member.status) in {"left", "kicked", "banned"}:
        return GroupConnectionOutcome(GroupConnectionResult.USER_NOT_MEMBER)
    if not await has_user_group_connection(session, user_id=user.id, group_id=group.id):
        if not await can_connect_group(session, user.id):
            return GroupConnectionOutcome(GroupConnectionResult.LIMIT_REACHED)
    connected_group = await connect_group(
        session,
        user_id=user.id,
        connected_by_telegram_id=connector_telegram_id,
        chat_id=group.chat_id,
        title=group.title,
        chat_type=group.chat_type,
        slow_mode_delay=group.slow_mode_delay,
        bot_is_admin=group.bot_is_admin,
    )
    return GroupConnectionOutcome(GroupConnectionResult.CONNECTED, connected_group)


async def discover_known_groups_for_user(
    *, bot: Bot, session: AsyncSession, user: User
) -> None:
    """Automatically connect the user to known groups where they are a member."""
    for group in await list_available_groups_for_user(session, user.id):
        try:
            member = await bot.get_chat_member(chat_id=group.chat_id, user_id=user.telegram_id)
        except (TelegramBadRequest, TelegramForbiddenError):
            continue
        if str(member.status) in {"left", "kicked", "banned"}:
            continue
        known_group = await get_active_group_by_id(session, group.id)
        if known_group is None:
            continue
        await connect_group(
            session,
            user_id=user.id,
            connected_by_telegram_id=user.telegram_id,
            chat_id=known_group.chat_id,
            title=known_group.title,
            chat_type=known_group.chat_type,
            slow_mode_delay=known_group.slow_mode_delay,
            bot_is_admin=known_group.bot_is_admin,
        )
