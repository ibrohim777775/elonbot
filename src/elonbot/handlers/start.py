"""Handlers for the first private conversation with a user."""

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.bot.keyboards import main_menu_keyboard
from elonbot.locales.translator import translate
from elonbot.services.users import register_activity

router = Router(name="start")


@router.message(F.chat.type == "private", CommandStart())
@router.message(F.chat.type == "private", Command("boshlash"))
async def start_command(message: Message, session: AsyncSession) -> None:
    """Register the user and show the Uzbek welcome message with main menu."""
    if message.from_user is None:
        return

    await register_activity(session, message.from_user)
    await message.answer(
        f"{translate('start.welcome')}\n\n{translate('start.choose_section')}",
        reply_markup=main_menu_keyboard(),
    )
