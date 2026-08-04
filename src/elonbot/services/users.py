"""User-related application services."""

from aiogram.types import User as TelegramUser
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.models import User
from elonbot.repositories.users import upsert_telegram_user


async def register_activity(session: AsyncSession, telegram_user: TelegramUser) -> User:
    """Register a bot user and update their latest activity timestamp."""
    return await upsert_telegram_user(session, telegram_user)
