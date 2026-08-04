"""Handlers for connecting, listing, and disconnecting Telegram groups."""

from __future__ import annotations

from aiogram import Bot, F, Router
from aiogram.filters import Command, StateFilter
from aiogram.types import CallbackQuery, ChatMemberUpdated, Message
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
    list_user_groups,
    observe_group_access,
)
from elonbot.repositories.users import get_user_by_telegram_id
from elonbot.database.enums import ChatType
from elonbot.services.groups import (
    GroupConnectionResult,
    can_bot_post,
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
async def groups_menu(message: Message, session: AsyncSession) -> None:
    """Open the current user's connected groups list."""
    if message.from_user is not None:
        await register_activity(session, message.from_user)
    await show_groups(message, session)


@router.callback_query(F.data == "groups:add")
async def add_group(callback: CallbackQuery) -> None:
    """Explain the verified group connection flow."""
    if callback.message is not None:
        await callback.message.answer(translate("groups.connect_instruction"))
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
        GroupConnectionResult.USER_NOT_ADMIN: "groups.user_not_admin",
        GroupConnectionResult.BOT_CANNOT_POST: "groups.bot_cannot_post",
        GroupConnectionResult.LIMIT_REACHED: "validation.limit_reached",
    }
    await message.answer(translate(messages[outcome.result]))


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
        translate("groups.details", title=group.title, status=status, chat_id=group.chat_id),
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
async def delete_group(callback: CallbackQuery, session: AsyncSession) -> None:
    """Disconnect one group from the callback user after confirmation."""
    if callback.from_user is None or callback.message is None or callback.data is None:
        return
    try:
        group_id = int(callback.data.rsplit(":", maxsplit=1)[1])
    except ValueError:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    user = await get_user_by_telegram_id(session, callback.from_user.id)
    disconnected = await disconnect_group(session, user_id=user.id, group_id=group_id) if user else False
    if not disconnected:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    await callback.message.edit_text(translate("groups.disconnected"))
    await callback.answer()
