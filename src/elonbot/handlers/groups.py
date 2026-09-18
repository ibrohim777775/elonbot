"""Handlers for connecting, listing, and disconnecting Telegram groups."""

from __future__ import annotations

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError, TelegramRetryAfter
from aiogram.filters import Command, StateFilter
from aiogram.types import CallbackQuery, ChatMemberUpdated, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.bot.keyboards import (
    group_details_keyboard,
    group_disconnect_confirmation_keyboard,
    groups_keyboard,
)
from elonbot.locales.translator import translate
from elonbot.repositories.groups import (
    disconnect_group,
    get_user_group,
    list_available_groups_for_user,
    list_announcements_orphaned_by_group_disconnect,
    list_user_groups,
    observe_group_access,
)
from elonbot.repositories.announcements import list_delivery_message_ids
from elonbot.repositories.users import get_user_by_telegram_id
from elonbot.database.enums import ChatType
from elonbot.services.groups import (
    GroupConnectionResult,
    can_bot_post,
    connect_known_group_for_user,
    discover_known_groups_for_user,
    verify_and_connect_group,
)
from elonbot.services.users import register_activity

router = Router(name="groups")


@router.my_chat_member(F.chat.type.in_({"group", "supergroup", "channel"}))
async def track_bot_membership(update: ChatMemberUpdated, session: AsyncSession) -> None:
    """Record bot access changes when Telegram adds or removes the bot from a chat."""
    await observe_group_access(
        session,
        chat_id=update.chat.id,
        title=update.chat.title or str(update.chat.id),
        chat_type=ChatType(update.chat.type),
        bot_can_post=can_bot_post(update.new_chat_member),
    )


async def show_groups(message: Message, session: AsyncSession) -> None:
    """Render the connected groups list for a private-chat user."""
    if message.from_user is None:
        return
    user = await get_user_by_telegram_id(session, message.from_user.id)
    if user is None:
        return

    groups = await list_user_groups(session, user.id)
    if not groups:
        await message.answer(translate("groups.empty"), reply_markup=groups_keyboard([]))
        return

    await message.answer(
        translate("groups.title"),
        reply_markup=groups_keyboard([(group.id, group.title) for group in groups]),
    )


@router.message(StateFilter(None), F.chat.type == "private", F.text == translate("menu.groups"))
async def groups_menu(message: Message, session: AsyncSession, bot: Bot) -> None:
    """Open the current user's connected groups list."""
    if message.from_user is not None:
        user = await register_activity(session, message.from_user)
        await discover_known_groups_for_user(bot=bot, session=session, user=user)
    await show_groups(message, session)


@router.callback_query(F.data == "groups:add")
async def add_group(callback: CallbackQuery, session: AsyncSession, bot: Bot) -> None:
    """Offer already known groups, then explain how to add a new one."""
    if callback.message is None or callback.from_user is None:
        return
    # Membership checks can require several Telegram API requests.
    await callback.answer()
    user = await get_user_by_telegram_id(session, callback.from_user.id)
    available_groups = await list_available_groups_for_user(session, user.id) if user else []
    eligible_groups = []
    for group in available_groups:
        try:
            member = await bot.get_chat_member(chat_id=group.chat_id, user_id=callback.from_user.id)
        except (TelegramBadRequest, TelegramForbiddenError):
            continue
        if str(member.status) not in {"left", "kicked", "banned"}:
            eligible_groups.append(group)
    if eligible_groups:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=group.title, callback_data=f"groups:connect_known:{group.id}")]
            for group in eligible_groups
        ])
        try:
            await callback.message.edit_text(translate("groups.select_known"), reply_markup=keyboard)
        except TelegramBadRequest as error:
            if "message is not modified" not in str(error).lower():
                raise
    else:
        await callback.message.answer(translate("groups.connect_instruction"))


@router.callback_query(F.data.startswith("groups:connect_known:"))
async def connect_known_group(callback: CallbackQuery, session: AsyncSession, bot: Bot) -> None:
    """Connect the callback user to one of the bot's already known groups."""
    if callback.from_user is None or callback.message is None:
        return
    try:
        group_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user = await get_user_by_telegram_id(session, callback.from_user.id)
    if user is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    outcome = await connect_known_group_for_user(
        bot=bot,
        session=session,
        user=user,
        group_id=group_id,
        connector_telegram_id=callback.from_user.id,
    )
    messages = {
        GroupConnectionResult.CONNECTED: "groups.connection_success",
        GroupConnectionResult.USER_NOT_MEMBER: "groups.user_not_member",
        GroupConnectionResult.USER_NOT_ADMIN: "groups.user_not_admin",
        GroupConnectionResult.BOT_CANNOT_POST: "groups.bot_cannot_post",
        GroupConnectionResult.LIMIT_REACHED: "validation.limit_reached",
    }
    await callback.message.edit_text(translate(messages[outcome.result]))
    await callback.answer()


@router.message(F.chat.type.in_({"group", "supergroup"}), Command("guruh_ulash"))
async def connect_group_command(message: Message, bot: Bot, session: AsyncSession) -> None:
    """Verify group and administrator permissions, then connect the group."""
    if message.from_user is None:
        return

    user = await register_activity(session, message.from_user)
    outcome = await verify_and_connect_group(
        bot=bot,
        session=session,
        user=user,
        chat=message.chat,
        connector_telegram_id=message.from_user.id,
    )
    messages = {
        GroupConnectionResult.CONNECTED: "groups.connection_success",
        GroupConnectionResult.USER_NOT_MEMBER: "groups.user_not_member",
        GroupConnectionResult.USER_NOT_ADMIN: "groups.user_not_admin",
        GroupConnectionResult.BOT_CANNOT_POST: "groups.bot_cannot_post",
        GroupConnectionResult.LIMIT_REACHED: "validation.limit_reached",
    }
    try:
        await message.answer(translate(messages[outcome.result]))
    except TelegramRetryAfter:
        # Do not return HTTP 500: Telegram would retry the same command and hit Flood Control again.
        return


@router.callback_query(F.data.startswith("groups:show:"))
async def show_group(callback: CallbackQuery, session: AsyncSession) -> None:
    """Show one group after verifying that it belongs to the callback user."""
    if callback.from_user is None or callback.message is None or callback.data is None:
        return
    try:
        group_id = int(callback.data.rsplit(":", maxsplit=1)[1])
    except ValueError:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    user = await get_user_by_telegram_id(session, callback.from_user.id)
    group = await get_user_group(session, user_id=user.id, group_id=group_id) if user else None
    if group is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    status = translate("groups.connected") if group.is_active and group.bot_can_post else translate("groups.unavailable")
    await callback.message.edit_text(
        translate(
            "groups.details",
            title=group.title,
            status=status,
            slow_mode=f"{group.slow_mode_delay} soniya" if group.slow_mode_delay else "yo'q",
            chat_id=group.chat_id,
        ),
        reply_markup=group_details_keyboard(group.id),
    )
    await callback.answer()


@router.callback_query(F.data == "groups:list")
async def return_to_group_list(callback: CallbackQuery, session: AsyncSession) -> None:
    """Return from one group card to the current user's group list."""
    if callback.from_user is None or callback.message is None:
        return
    user = await get_user_by_telegram_id(session, callback.from_user.id)
    groups = await list_user_groups(session, user.id) if user else []
    text = translate("groups.title") if groups else translate("groups.empty")
    await callback.message.edit_text(
        text,
        reply_markup=groups_keyboard([(group.id, group.title) for group in groups]),
    )
    await callback.answer()


@router.callback_query(F.data.startswith("groups:delete:"))
async def request_group_deletion(callback: CallbackQuery, session: AsyncSession) -> None:
    """Request confirmation for a group connection removal."""
    if callback.from_user is None or callback.message is None or callback.data is None:
        return
    try:
        group_id = int(callback.data.rsplit(":", maxsplit=1)[1])
    except ValueError:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    user = await get_user_by_telegram_id(session, callback.from_user.id)
    group = await get_user_group(session, user_id=user.id, group_id=group_id) if user else None
    if group is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    await callback.message.edit_text(
        translate("groups.disconnect_confirm"),
        reply_markup=group_disconnect_confirmation_keyboard(group.id),
    )
    await callback.answer()


@router.callback_query(F.data.startswith("groups:delete_confirm:"))
async def delete_group(callback: CallbackQuery, session: AsyncSession, bot: Bot) -> None:
    """Disconnect one group from the callback user after confirmation."""
    if callback.from_user is None or callback.message is None or callback.data is None:
        return
    try:
        group_id = int(callback.data.rsplit(":", maxsplit=1)[1])
    except ValueError:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    user = await get_user_by_telegram_id(session, callback.from_user.id)
    if user is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    orphaned_announcement_ids = await list_announcements_orphaned_by_group_disconnect(
        session, user_id=user.id, group_id=group_id
    )
    messages_to_delete = []
    for announcement_id in orphaned_announcement_ids:
        messages_to_delete.extend(
            await list_delivery_message_ids(session, user_id=user.id, announcement_id=announcement_id)
        )

    # Deleting historical messages can take a while, so answer the callback first.
    await callback.answer()
    disconnected = await disconnect_group(session, user_id=user.id, group_id=group_id)
    if not disconnected:
        return

    for chat_id, message_ids in messages_to_delete:
        for message_id in message_ids:
            try:
                await bot.delete_message(chat_id, message_id)
            except Exception:
                # Database removal must still succeed if Telegram rejects an old message.
                continue

    try:
        await callback.message.edit_text(translate("groups.disconnected"))
    except TelegramBadRequest as error:
        if "message is not modified" not in str(error).lower():
            raise
