"""APScheduler lifecycle wrapper for the persistent delivery service."""

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from elonbot.scheduler.delivery import DeliveryService


def create_scheduler(delivery_service: DeliveryService) -> AsyncIOScheduler:
    """Create a scheduler that checks PostgreSQL for due work every 30 seconds."""
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        delivery_service.process_due,
        trigger="interval",
        seconds=30,
        id="deliver_due_announcements",
        max_instances=1,
        coalesce=True,
        replace_existing=True,
    )
    return scheduler
