"""Application configuration loaded from environment variables."""

from functools import lru_cache

from pydantic import Field, PostgresDsn, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Validated runtime settings."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    bot_token: SecretStr = Field(alias="BOT_TOKEN")
    database_url: PostgresDsn = Field(alias="DATABASE_URL")
    webhook_base_url: str = Field(alias="WEBHOOK_BASE_URL")
    webhook_secret: SecretStr = Field(alias="WEBHOOK_SECRET")
    admin_ids: tuple[int, ...] = Field(default=(), alias="ADMIN_IDS")

    max_messages_per_minute: int = Field(default=20, ge=1, alias="MAX_MESSAGES_PER_MINUTE")
    max_messages_per_chat_per_minute: int = Field(
        default=1, ge=1, alias="MAX_MESSAGES_PER_CHAT_PER_MINUTE"
    )
    max_active_announcements_per_user: int = Field(
        default=10, ge=1, alias="MAX_ACTIVE_ANNOUNCEMENTS_PER_USER"
    )
    max_groups_per_user: int = Field(default=20, ge=1, alias="MAX_GROUPS_PER_USER")
    max_deliveries_per_user_per_day: int = Field(
        default=500, ge=1, alias="MAX_DELIVERIES_PER_USER_PER_DAY"
    )
    app_env: str = Field(default="development", alias="APP_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    @field_validator("admin_ids", mode="before")
    @classmethod
    def parse_admin_ids(cls, value: object) -> tuple[int, ...]:
        """Convert comma-separated ADMIN_IDS into a tuple of Telegram IDs."""
        if value in (None, ""):
            return ()
        if isinstance(value, str):
            return tuple(int(item.strip()) for item in value.split(",") if item.strip())
        if isinstance(value, (list, tuple)):
            return tuple(int(item) for item in value)
        raise ValueError("ADMIN_IDS must be a comma-separated list of integer IDs")


@lru_cache
def get_settings() -> Settings:
    """Return one settings object per application process."""
    return Settings()
