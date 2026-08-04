"""Persistence operations for Telegram bot users."""

from datetime import datetime

from aiogram.types import User as TelegramUser
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.base import utc_now
from elonbot.database.models import User


async def get_user_by_telegram_id(session: AsyncSession, telegram_id: int) -> User | None:
    """Find a local user by their immutable Telegram ID."""
    result = await session.execute(select(User).where(User.telegram_id == telegram_id))
    return result.scalar_one_or_none()


async def upsert_telegram_user(session: AsyncSession, telegram_user: TelegramUser) -> User:
    """Create or refresh a user record from a Telegram update and return it."""
    activity_at: datetime = utc_now()
    statement = (
        insert(User)
        .values(
            telegram_id=telegram_user.id,
            username=telegram_user.username,
            first_name=telegram_user.first_name,
            last_activity_at=activity_at,
        )
        .on_conflict_do_update(
            index_elements=[User.telegram_id],
            set_={
                "username": telegram_user.username,
                "first_name": telegram_user.first_name,
                "last_activity_at": activity_at,
                "updated_at": activity_at,
            },
        )
        .returning(User)
    )
    result = await session.execute(statement)
    return result.scalar_one()
