"""Handlers for text and photo announcement templates."""

from __future__ import annotations

from aiogram import F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.bot.keyboards import (
    template_creation_keyboard,
    template_delete_confirmation_keyboard,
    template_details_keyboard,
    templates_keyboard,
)
from elonbot.handlers.template_states import TemplateStates
from elonbot.locales.translator import translate
from elonbot.repositories.templates import (
    create_template,
    delete_template,
    get_template,
    list_templates,
    remove_template_photo,
    update_template_photo,
    update_template_text,
)
from elonbot.repositories.users import get_user_by_telegram_id
from elonbot.services.users import register_activity

router = Router(name="templates")
MAX_PHOTO_CAPTION_LENGTH = 1024
MAX_TEMPLATE_PHOTOS = 4


def _template_rows(templates: list) -> list[tuple[int, str, bool]]:
    """Convert ORM templates into keyboard rows."""
    return [(template.id, template.text, template.photo_file_id is not None) for template in templates]


async def _current_user_id(session: AsyncSession, telegram_id: int) -> int | None:
    user = await get_user_by_telegram_id(session, telegram_id)
    return user.id if user else None


async def _show_template_list_message(message: Message, session: AsyncSession) -> None:
    """Send the template list to a private-chat user."""
    if message.from_user is None:
        return
    user_id = await _current_user_id(session, message.from_user.id)
    templates = await list_templates(session, user_id) if user_id else []
    text = translate("templates.title") if templates else translate("templates.empty")
    await message.answer(text, reply_markup=templates_keyboard(_template_rows(templates)))


async def _show_template_card(callback: CallbackQuery, template_id: int, session: AsyncSession) -> None:
    """Show one owned template, sending its photo when present."""
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    template = await get_template(session, user_id=user_id, template_id=template_id) if user_id else None
    if template is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return

    text = translate("templates.details", text=template.text)
    keyboard = template_details_keyboard(template.id, template.photo_file_id is not None)
    if template.photo_file_id:
        if len(text) <= MAX_PHOTO_CAPTION_LENGTH:
            await callback.message.answer_photo(
                template.photo_file_id, caption=text, reply_markup=keyboard
            )
        else:
            await callback.message.answer_photo(template.photo_file_id)
            await callback.message.answer(text, reply_markup=keyboard)
    else:
        await callback.message.edit_text(text, reply_markup=keyboard)
    await callback.answer()


@router.message(StateFilter(None), F.chat.type == "private", F.text == translate("menu.templates"))
async def templates_menu(message: Message, session: AsyncSession) -> None:
    """Open the current user's template list."""
    if message.from_user is not None:
        await register_activity(session, message.from_user)
    await _show_template_list_message(message, session)


@router.callback_query(F.data == "templates:list")
async def templates_list(callback: CallbackQuery, session: AsyncSession) -> None:
    """Return to the template list."""
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    templates = await list_templates(session, user_id) if user_id else []
    text = translate("templates.title") if templates else translate("templates.empty")
    keyboard = templates_keyboard(_template_rows(templates))
    if callback.message.text is None:
        # Template cards with photos cannot be converted to a text message by edit_text.
        try:
            await callback.message.delete()
        except TelegramBadRequest:
            pass
        await callback.message.answer(text, reply_markup=keyboard)
    else:
        try:
            await callback.message.edit_text(text, reply_markup=keyboard)
        except TelegramBadRequest as error:
            if "message is not modified" not in str(error).lower():
                raise
    await callback.answer()


@router.callback_query(F.data == "templates:create")
async def template_create_menu(callback: CallbackQuery, state: FSMContext) -> None:
    """Start template creation with the same content flow as announcements."""
    await state.clear()
    await state.set_state(TemplateStates.creating_text)
    if callback.message is not None:
        await callback.message.edit_text(translate("announcements.create_instruction"))
    await callback.answer()


@router.callback_query(F.data == "templates:create_text")
async def create_text_template(callback: CallbackQuery, state: FSMContext) -> None:
    """Ask for the text of a new template."""
    await state.set_state(TemplateStates.creating_text)
    if callback.message is not None:
        await callback.message.answer(translate("templates.send_text"))
    await callback.answer()


@router.callback_query(F.data == "templates:create_photo")
async def create_photo_template(callback: CallbackQuery, state: FSMContext) -> None:
    """Ask for a new photo template or a forwarded ready message."""
    await state.set_state(TemplateStates.creating_photo)
    if callback.message is not None:
        await callback.message.answer(translate("templates.send_photo"))
    await callback.answer()


@router.message(TemplateStates.creating_text, F.chat.type == "private", F.text)
async def receive_text_template(message: Message, state: FSMContext, session: AsyncSession) -> None:
    """Persist a text template received during creation."""
    if message.from_user is None or not message.text:
        return
    user_id = await _current_user_id(session, message.from_user.id)
    if user_id is None:
        return
    await create_template(session, user_id=user_id, text=message.text)
    await state.clear()
    await message.answer(translate("templates.created"))


@router.message(
    F.chat.type == "private",
    F.photo,
    StateFilter(TemplateStates.creating_text, TemplateStates.creating_photo),
)
async def receive_photo_template(message: Message, state: FSMContext, session: AsyncSession) -> None:
    """Collect up to four template photos, as for an announcement."""
    if message.from_user is None or not message.photo:
        return
    data = await state.get_data()
    photo_file_ids = list(data.get("photo_file_ids") or [])
    if len(photo_file_ids) >= MAX_TEMPLATE_PHOTOS:
        await message.answer(translate("announcements.photo_limit"))
        return
    photo_file_ids.append(message.photo[-1].file_id)
    if message.caption and not data.get("text"):
        await state.update_data(text=message.caption)
    await state.update_data(photo_file_ids=photo_file_ids, photo_file_id=photo_file_ids[0])
    if not (await state.get_data()).get("text"):
        await state.set_state(TemplateStates.creating_photo_caption)
        await message.answer(translate("templates.send_caption"))
        return
    await state.set_state(TemplateStates.creating_photo)
    await message.answer(
        translate("announcements.photos_continue"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("common.done"), callback_data="templates:photos_done")
        ]]),
    )


@router.message(TemplateStates.creating_photo, F.chat.type == "private")
async def require_template_photo(message: Message) -> None:
    """Reject unsupported input while a photo is expected."""
    await message.answer(translate("templates.photo_required"))


@router.message(TemplateStates.creating_photo_caption, F.chat.type == "private", F.text)
async def receive_photo_template_caption(
    message: Message, state: FSMContext, session: AsyncSession
) -> None:
    """Store a deferred caption with the previously received template photo."""
    if message.from_user is None or not message.text:
        return
    user_id = await _current_user_id(session, message.from_user.id)
    data = await state.get_data()
    photo_file_ids = list(data.get("photo_file_ids") or [])
    if user_id is None or not photo_file_ids:
        await state.clear()
        return
    await state.update_data(text=message.text)
    await state.set_state(TemplateStates.creating_photo)
    await message.answer(
        translate("announcements.photos_continue"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("common.done"), callback_data="templates:photos_done")
        ]]),
    )


@router.callback_query(TemplateStates.creating_photo, F.data == "templates:photos_done")
async def finish_template_photos(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.from_user is None or callback.message is None:
        return
    data = await state.get_data()
    photo_file_ids = list(data.get("photo_file_ids") or [])
    user_id = await _current_user_id(session, callback.from_user.id)
    if user_id is None or not photo_file_ids or not data.get("text"):
        await callback.answer(translate("common.error"), show_alert=True)
        return
    await create_template(
        session,
        user_id=user_id,
        text=data["text"],
        photo_file_id=photo_file_ids[0],
        photo_file_ids=photo_file_ids,
    )
    await state.clear()
    await callback.message.answer(translate("templates.created"))
    await callback.answer()


@router.callback_query(F.data.startswith("templates:show:"))
async def show_template(callback: CallbackQuery, session: AsyncSession) -> None:
    """Open a selected template after parsing its ID."""
    try:
        template_id = int((callback.data or "").rsplit(":", maxsplit=1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await _show_template_card(callback, template_id, session)


@router.callback_query(F.data.startswith("templates:edit_text:"))
async def edit_template_text(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    """Request replacement text only for an owned template."""
    try:
        template_id = int((callback.data or "").rsplit(":", maxsplit=1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if callback.from_user is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    if user_id is None or not await get_template(session, user_id=user_id, template_id=template_id):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(template_id=template_id)
    await state.set_state(TemplateStates.editing_text)
    if callback.message is not None:
        await callback.message.answer(translate("templates.send_text"))
    await callback.answer()


@router.message(TemplateStates.editing_text, F.chat.type == "private", F.text)
async def receive_template_text_edit(message: Message, state: FSMContext, session: AsyncSession) -> None:
    """Save new text for an owned template."""
    if message.from_user is None or not message.text:
        return
    template_id = (await state.get_data()).get("template_id")
    user_id = await _current_user_id(session, message.from_user.id)
    updated = isinstance(template_id, int) and user_id is not None and await update_template_text(
        session, user_id=user_id, template_id=template_id, text=message.text
    )
    await state.clear()
    await message.answer(translate("templates.updated" if updated else "common.not_found"))


@router.callback_query(F.data.startswith("templates:edit_photo:"))
async def edit_template_photo(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    """Request a replacement photo for an owned template."""
    try:
        template_id = int((callback.data or "").rsplit(":", maxsplit=1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if callback.from_user is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    if user_id is None or not await get_template(session, user_id=user_id, template_id=template_id):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(template_id=template_id)
    await state.set_state(TemplateStates.editing_photo)
    if callback.message is not None:
        await callback.message.answer(translate("templates.send_photo"))
    await callback.answer()


@router.message(TemplateStates.editing_photo, F.chat.type == "private", F.photo)
async def receive_template_photo_edit(message: Message, state: FSMContext, session: AsyncSession) -> None:
    """Save a replacement photo and optionally replace text from its caption."""
    if message.from_user is None or not message.photo:
        return
    template_id = (await state.get_data()).get("template_id")
    user_id = await _current_user_id(session, message.from_user.id)
    updated = isinstance(template_id, int) and user_id is not None and await update_template_photo(
        session,
        user_id=user_id,
        template_id=template_id,
        photo_file_id=message.photo[-1].file_id,
        text=message.caption,
    )
    await state.clear()
    await message.answer(translate("templates.updated" if updated else "common.not_found"))


@router.message(TemplateStates.editing_photo, F.chat.type == "private")
async def require_replacement_template_photo(message: Message) -> None:
    """Reject unsupported input while a replacement photo is expected."""
    await message.answer(translate("templates.photo_required"))


@router.callback_query(F.data.startswith("templates:remove_photo:"))
async def remove_photo_from_template(callback: CallbackQuery, session: AsyncSession) -> None:
    """Remove only the photo from an owned template."""
    try:
        template_id = int((callback.data or "").rsplit(":", maxsplit=1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if callback.from_user is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    removed = user_id is not None and await remove_template_photo(
        session, user_id=user_id, template_id=template_id
    )
    await callback.answer(translate("templates.photo_removed" if removed else "common.not_found"), show_alert=not removed)


@router.callback_query(F.data.startswith("templates:delete:"))
async def request_template_deletion(callback: CallbackQuery, session: AsyncSession) -> None:
    """Show deletion confirmation after validating template ownership."""
    try:
        template_id = int((callback.data or "").rsplit(":", maxsplit=1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    template = await get_template(session, user_id=user_id, template_id=template_id) if user_id else None
    if template is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await callback.message.answer(
        translate("templates.delete_confirm"), reply_markup=template_delete_confirmation_keyboard(template.id)
    )
    await callback.answer()


@router.callback_query(F.data.startswith("templates:delete_confirm:"))
async def delete_selected_template(callback: CallbackQuery, session: AsyncSession) -> None:
    """Delete an owned template after confirmation."""
    try:
        template_id = int((callback.data or "").rsplit(":", maxsplit=1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _current_user_id(session, callback.from_user.id)
    deleted = user_id is not None and await delete_template(
        session, user_id=user_id, template_id=template_id
    )
    if not deleted:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await callback.message.edit_text(translate("templates.deleted"))
    await callback.answer()
