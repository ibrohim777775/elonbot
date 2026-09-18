"""Factory for the aiogram dispatcher and its shared middleware."""

from aiogram import Dispatcher
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from elonbot.handlers.middlewares import DatabaseSessionMiddleware
from elonbot.handlers.groups import router as groups_router
from elonbot.handlers.announcements import router as announcements_router
from elonbot.handlers.fallback import router as fallback_router
from elonbot.handlers.replies import router as replies_router
from elonbot.handlers.start import router as start_router
from elonbot.handlers.templates import router as templates_router
from elonbot.handlers.statistics import router as statistics_router


def create_dispatcher(session_factory: async_sessionmaker[AsyncSession]) -> Dispatcher:
    """Build the dispatcher with registered routers and database session handling."""
    dispatcher = Dispatcher()
    dispatcher.update.outer_middleware(DatabaseSessionMiddleware(session_factory))
    dispatcher.include_router(start_router)
    dispatcher.include_router(announcements_router)
    dispatcher.include_router(groups_router)
    dispatcher.include_router(templates_router)
    dispatcher.include_router(statistics_router)
    dispatcher.include_router(replies_router)
    dispatcher.include_router(fallback_router)
    return dispatcher
