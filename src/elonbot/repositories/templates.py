"""Persistence operations for a user's reusable announcement templates."""

from __future__ import annotations

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.database.models import Template


async def list_templates(session: AsyncSession, user_id: int) -> list[Template]:
    """Return all templates belonging to a user."""
    result = await session.execute(
        select(Template).where(Template.user_id == user_id).order_by(Template.updated_at.desc())
    )
    return list(result.scalars())


async def get_template(session: AsyncSession, *, user_id: int, template_id: int) -> Template | None:
    """Get a template only when it belongs to the specified user."""
    result = await session.execute(
        select(Template).where(Template.id == template_id, Template.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def create_template(
    session: AsyncSession, *, user_id: int, text: str, photo_file_id: str | None = None
) -> Template:
    """Create a text or one-photo template."""
    template = Template(user_id=user_id, text=text, photo_file_id=photo_file_id)
    session.add(template)
    await session.flush()
    return template


async def update_template_text(
    session: AsyncSession, *, user_id: int, template_id: int, text: str
) -> bool:
    """Update a template's text only if the user owns it."""
    result = await session.execute(
        update(Template)
        .where(Template.id == template_id, Template.user_id == user_id)
        .values(text=text)
    )
    return result.rowcount == 1


async def update_template_photo(
    session: AsyncSession, *, user_id: int, template_id: int, photo_file_id: str, text: str | None
) -> bool:
    """Replace a template photo and optionally replace text with a new caption."""
    values: dict[str, str] = {"photo_file_id": photo_file_id}
    if text:
        values["text"] = text
    result = await session.execute(
        update(Template).where(Template.id == template_id, Template.user_id == user_id).values(**values)
    )
    return result.rowcount == 1


async def remove_template_photo(session: AsyncSession, *, user_id: int, template_id: int) -> bool:
    """Remove a photo from a template owned by the current user."""
    result = await session.execute(
        update(Template)
        .where(Template.id == template_id, Template.user_id == user_id)
        .values(photo_file_id=None)
    )
    return result.rowcount == 1


async def delete_template(session: AsyncSession, *, user_id: int, template_id: int) -> bool:
    """Delete one template only if it belongs to the current user."""
    result = await session.execute(
        delete(Template).where(Template.id == template_id, Template.user_id == user_id)
    )
    return result.rowcount == 1
