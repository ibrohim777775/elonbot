"""SQLAlchemy declarative base and common database helpers."""

from datetime import datetime, timezone

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Base class for all ORM models."""


def utc_now() -> datetime:
    """Return a timezone-aware UTC timestamp for application defaults."""
    return datetime.now(timezone.utc)
