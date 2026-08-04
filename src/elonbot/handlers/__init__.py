"""Telegram update handlers."""

from elonbot.handlers.groups import router as groups_router
from elonbot.handlers.start import router as start_router
from elonbot.handlers.templates import router as templates_router

__all__ = ["announcements_router", "groups_router", "start_router", "templates_router"]
from elonbot.handlers.announcements import router as announcements_router
