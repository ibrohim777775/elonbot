"""Forward group replies to the owner of the related announcement."""

import logging

from aiogram import Bot, F, Router
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.locales.translator import translate
from elonbot.repositories.replies import get_announcement_reply_owner

router = Router(name="announcement_replies")
logger = logging.getLogger(__name__)


def message_link(message: Message) -> str | None:
    """Build a Telegram jump link for public chats and supergroups."""
    if message.chat.username:
        return f"https://t.me/{message.chat.username}/{message.message_id}"
    chat_id = str(message.chat.id)
    if chat_id.startswith("-100"):
        return f"https://t.me/c/{chat_id[4:]}/{message.message_id}"
    return None


@router.message(F.chat.type.in_({"group", "supergroup"}), F.reply_to_message)
async def forward_announcement_reply(message: Message, bot: Bot, session: AsyncSession) -> None:
    """Copy a reply to the connected announcement owner and include a jump link."""
    if message.from_user is None or message.from_user.is_bot or message.reply_to_message is None:
        return
    replied_message_id = message.reply_to_message.message_id
    owner_telegram_id = await get_announcement_reply_owner(
        session, chat_id=message.chat.id, replied_message_id=replied_message_id
    )
    if owner_telegram_id is None or owner_telegram_id == message.from_user.id:
        logger.info(
            "Group reply does not match a published announcement",
            extra={
                "chat_id": message.chat.id,
                "message_id": message.message_id,
                "replied_message_id": replied_message_id,
            },
        )
        return
    try:
        await bot.copy_message(
            chat_id=owner_telegram_id, from_chat_id=message.chat.id, message_id=message.message_id
        )
    except Exception:
        # The link below is still useful when Telegram cannot copy protected content.
        logger.warning(
            "Could not copy a group reply to announcement owner",
            exc_info=True,
            extra={"chat_id": message.chat.id, "message_id": message.message_id},
        )
    link = message_link(message)
    markup = (
        InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("replies.open_in_group"), url=link)
        ]])
        if link
        else None
    )
    try:
        await bot.send_message(owner_telegram_id, translate("replies.received"), reply_markup=markup)
    except Exception:
        logger.warning(
            "Could not notify announcement owner about a group reply",
            exc_info=True,
            extra={"chat_id": message.chat.id, "message_id": message.message_id},
        )
