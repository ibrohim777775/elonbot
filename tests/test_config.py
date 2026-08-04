from elonbot.config import Settings


def test_settings_parses_admin_ids() -> None:
    settings = Settings(
        BOT_TOKEN="123456:token",
        DATABASE_URL="postgresql+asyncpg://user:pass@localhost:5432/elonbot",
        WEBHOOK_BASE_URL="https://example.onrender.com",
        WEBHOOK_SECRET="secret",
        ADMIN_IDS="1, 22,333",
    )

    assert settings.admin_ids == (1, 22, 333)


def test_settings_uses_default_product_limits() -> None:
    settings = Settings(
        BOT_TOKEN="123456:token",
        DATABASE_URL="postgresql+asyncpg://user:pass@localhost:5432/elonbot",
        WEBHOOK_BASE_URL="https://example.onrender.com",
        WEBHOOK_SECRET="secret",
    )

    assert settings.max_messages_per_minute == 20
    assert settings.max_groups_per_user == 20
