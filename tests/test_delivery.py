from datetime import datetime

from sqlalchemy.dialects import postgresql
from elonbot.database.enums import AnnouncementStatus, FirstRunMode
from elonbot.database.models import Announcement
from elonbot.scheduler.delivery import render_delivery_text, sanitize_error_message


def test_render_delivery_text_includes_optional_contact_fields() -> None:
    announcement = Announcement(
        text="E'lon matni",
        contact_name="Aziz",
        contact_phone="+998901234567",
        contact_telegram="@aziz",
        interval_minutes=5,
        status=AnnouncementStatus.ACTIVE,
        first_run_mode=FirstRunMode.IMMEDIATE,
        next_run_at=datetime.now().astimezone(),
    )

    assert render_delivery_text(announcement) == (
        "E'lon matni\n\nAziz\nTel: +998901234567\n"
        'Telegram: <a href="https://t.me/aziz">@aziz</a>'
    )


def test_postgres_enum_uses_lowercase_domain_values() -> None:
    enum_type = Announcement.__table__.c.status.type
    processor = enum_type.bind_processor(postgresql.dialect())

    assert processor is not None
    assert processor(AnnouncementStatus.ACTIVE) == "active"


def test_error_sanitizer_masks_phone_and_bot_token() -> None:
    error = RuntimeError("send +998 90 123 45 67 with 123456:abcdefghijklmnopqrstuvwxyzABCDE")

    assert sanitize_error_message(error) == "send [phone] with [bot-token]"
