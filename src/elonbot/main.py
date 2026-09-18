"""FastAPI webhook application and Telegram bot lifecycle."""

from contextlib import asynccontextmanager
from secrets import compare_digest

from aiogram import Bot
from aiogram.types import Update
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi import HTTPException, Request

from elonbot.bot.commands import set_user_commands
from elonbot.bot.dispatcher import create_dispatcher
from elonbot.config import get_settings
from elonbot.database.session import get_session_factory
from elonbot.scheduler.delivery import DeliveryService
from elonbot.scheduler.service import create_scheduler


def create_app() -> FastAPI:
    """Create the HTTP application used by Render and Telegram webhooks."""
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        settings = get_settings()
        bot = Bot(token=settings.bot_token.get_secret_value())
        dispatcher = create_dispatcher(get_session_factory())
        scheduler = create_scheduler(DeliveryService(bot, get_session_factory()))
        await set_user_commands(bot)
        await bot.set_webhook(
            url=f"{settings.webhook_base_url.rstrip('/')}/webhook/{settings.webhook_secret.get_secret_value()}",
            secret_token=settings.webhook_secret.get_secret_value(),
            allowed_updates=dispatcher.resolve_used_update_types(),
        )
        scheduler.start()
        application.state.bot = bot
        application.state.dispatcher = dispatcher
        application.state.webhook_secret = settings.webhook_secret.get_secret_value()
        application.state.scheduler = scheduler
        try:
            yield
        finally:
            scheduler.shutdown(wait=False)
            await bot.session.close()

    application = FastAPI(title="Elonbot", docs_url=None, redoc_url=None, lifespan=lifespan)

    @application.get("/health", include_in_schema=False)
    async def health() -> JSONResponse:
        """Return a lightweight Render and Google Apps Script health response."""
        return JSONResponse({"status": "ok"})

    @application.post("/webhook/{secret}", include_in_schema=False)
    async def telegram_webhook(secret: str, request: Request) -> JSONResponse:
        """Validate and dispatch one Telegram Bot API webhook update."""
        if not compare_digest(secret, request.app.state.webhook_secret):
            raise HTTPException(status_code=403)
        header_secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if header_secret is None or not compare_digest(header_secret, request.app.state.webhook_secret):
            raise HTTPException(status_code=403)
        update = Update.model_validate(await request.json(), context={"bot": request.app.state.bot})
        await request.app.state.dispatcher.feed_update(request.app.state.bot, update)
        return JSONResponse({"ok": True})

    return application


app = create_app()
