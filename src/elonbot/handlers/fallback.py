"""Fallback messages for unsupported Telegram commands."""

from aiogram import F, Router
from aiogram.exceptions import TelegramRetryAfter
from aiogram.types import CallbackQuery, Message

from elonbot.locales.translator import translate

router = Router(name="fallback")


@router.message(F.chat.type == "private", F.text.startswith("/"))
async def unknown_private_command(message: Message) -> None:
    """Explain unsupported commands without exposing internal command handling."""
    await message.answer(translate("commands.unknown"))


@router.message(F.chat.type.in_({"group", "supergroup", "channel"}), F.text.startswith("/"))
async def group_command_redirect(message: Message) -> None:
    """Keep all group commands except the earlier connection command out of the UI."""
    try:
        await message.answer(translate("commands.private_only"))
    except TelegramRetryAfter:
        return


@router.callback_query()
async def expired_callback(callback: CallbackQuery) -> None:
    """Acknowledge buttons from completed or replaced wizard screens safely."""
    await callback.answer(translate("common.not_found"), show_alert=True)
