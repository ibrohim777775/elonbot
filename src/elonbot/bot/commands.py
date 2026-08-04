"""Telegram command registration."""

from aiogram import Bot
from aiogram.types import BotCommand

from elonbot.locales.translator import translate


async def set_user_commands(bot: Bot) -> None:
    """Register Uzbek command descriptions visible in the Telegram command menu."""
    await bot.set_my_commands(
        [
            BotCommand(command="boshlash", description=translate("commands.boshlash")),
            BotCommand(command="guruh_ulash", description=translate("commands.guruh_ulash")),
            BotCommand(command="statistika", description=translate("commands.statistika")),
        ]
    )
