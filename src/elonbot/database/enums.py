"""Database enum values used by the announcement domain."""

from enum import StrEnum


class ChatType(StrEnum):
    GROUP = "group"
    SUPERGROUP = "supergroup"
    CHANNEL = "channel"


class AnnouncementStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    DELETED = "deleted"


class FirstRunMode(StrEnum):
    IMMEDIATE = "immediate"
    SCHEDULED = "scheduled"


class DeliveryStatus(StrEnum):
    SENT = "sent"
    FAILED = "failed"
    RATE_LIMITED = "rate_limited"
    SKIPPED = "skipped"
