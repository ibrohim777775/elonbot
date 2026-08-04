"""Announcement creation, listing, pause, resume, and deletion handlers."""

from datetime import timedelta

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.bot.keyboards import templates_keyboard
from elonbot.database.base import utc_now
from elonbot.database.enums import AnnouncementStatus, FirstRunMode
from elonbot.handlers.announcement_states import AnnouncementStates
from elonbot.locales.translator import translate
from elonbot.repositories.announcements import (
    create_announcement,
    delete_announcement,
    get_announcement,
    list_announcements,
    set_announcement_status,
    update_announcement,
)
from elonbot.repositories.groups import list_user_groups
from elonbot.repositories.templates import create_template, get_template, list_templates
from elonbot.repositories.users import get_user_by_telegram_id
from elonbot.services.limits import can_create_announcement

router = Router(name="announcements")
INTERVALS = (5, 10, 15, 20, 60, 120, 180, 300, 480)
MAX_TEXT_LENGTH = 4096
MAX_CAPTION_LENGTH = 1024


async def _user_id(session: AsyncSession, telegram_id: int) -> int | None:
    user = await get_user_by_telegram_id(session, telegram_id)
    return user.id if user else None


def _creation_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=translate("announcements.from_template"), callback_data="ann:create:template")],
        [InlineKeyboardButton(text=translate("announcements.new_text"), callback_data="ann:create:text")],
        [InlineKeyboardButton(text=translate("announcements.photo_message"), callback_data="ann:create:photo")],
    ])


def _interval_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"{value} daqiqa" if value < 60 else f"{value // 60} soat", callback_data=f"ann:interval:{value}")]
        for value in INTERVALS
    ])


async def _begin_contact(message: Message, state: FSMContext) -> None:
    await state.set_state(AnnouncementStates.contact)
    await message.answer(translate("announcements.send_contact"))


@router.message(F.chat.type == "private", F.text == translate("menu.announcements"))
async def announcements_menu(message: Message, session: AsyncSession) -> None:
    if message.from_user is None:
        return
    user_id = await _user_id(session, message.from_user.id)
    announcements = await list_announcements(session, user_id) if user_id else []
    rows = [[InlineKeyboardButton(text=a.text[:40], callback_data=f"ann:show:{a.id}")] for a in announcements]
    rows.append([InlineKeyboardButton(text=translate("announcements.create"), callback_data="ann:create")])
    await message.answer(
        translate("announcements.title") if announcements else translate("announcements.empty"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows),
    )


@router.callback_query(F.data == "ann:create")
async def create_menu(callback: CallbackQuery) -> None:
    if callback.message:
        await callback.message.answer(translate("announcements.create"), reply_markup=_creation_keyboard())
    await callback.answer()


@router.callback_query(F.data == "ann:create:text")
async def create_text(callback: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(AnnouncementStates.content_text)
    if callback.message:
        await callback.message.answer(translate("announcements.send_text"))
    await callback.answer()


@router.callback_query(F.data == "ann:create:photo")
async def create_photo(callback: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(AnnouncementStates.content_photo)
    if callback.message:
        await callback.message.answer(translate("announcements.send_ready_photo"))
    await callback.answer()


@router.callback_query(F.data == "ann:create:template")
async def choose_template(callback: CallbackQuery, session: AsyncSession) -> None:
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _user_id(session, callback.from_user.id)
    templates = await list_templates(session, user_id) if user_id else []
    rows = [[InlineKeyboardButton(text=t.text[:40], callback_data=f"ann:template:{t.id}")] for t in templates]
    await callback.message.answer(
        translate("templates.empty") if not rows else translate("announcements.from_template"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows) if rows else None,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:template:"))
async def apply_template(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.from_user is None or callback.message is None:
        return
    try:
        template_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    template = await get_template(session, user_id=user_id, template_id=template_id) if user_id else None
    if template is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(text=template.text, photo_file_id=template.photo_file_id)
    await _begin_contact(callback.message, state)
    await callback.answer()


@router.message(AnnouncementStates.content_text, F.chat.type == "private", F.text)
async def receive_text(message: Message, state: FSMContext) -> None:
    if not message.text:
        return
    if len(message.text) > MAX_TEXT_LENGTH:
        await message.answer(translate("common.error"))
        return
    await state.update_data(text=message.text, photo_file_id=None)
    await _begin_contact(message, state)


@router.message(AnnouncementStates.content_photo, F.chat.type == "private", F.photo)
async def receive_photo(message: Message, state: FSMContext) -> None:
    if not message.photo:
        return
    await state.update_data(photo_file_id=message.photo[-1].file_id)
    if message.caption:
        if len(message.caption) > MAX_CAPTION_LENGTH:
            await message.answer(translate("common.error"))
            return
        await state.update_data(text=message.caption)
        await _begin_contact(message, state)
    else:
        await state.set_state(AnnouncementStates.content_photo_caption)
        await message.answer(translate("announcements.photo_without_caption"))


@router.message(AnnouncementStates.content_photo_caption, F.chat.type == "private", F.text)
async def receive_photo_caption(message: Message, state: FSMContext) -> None:
    if not message.text:
        return
    await state.update_data(text=message.text)
    await _begin_contact(message, state)


@router.message(AnnouncementStates.contact, F.chat.type == "private", F.text)
async def receive_contact(message: Message, state: FSMContext) -> None:
    if not message.text:
        return
    value = message.text.strip()
    if value.startswith("@") or "t.me/" in value:
        await state.update_data(contact_telegram=value, contact_phone=None)
    else:
        await state.update_data(contact_phone=value, contact_telegram=None)
    await state.set_state(AnnouncementStates.contact_name)
    await message.answer(translate("announcements.send_name"))


@router.message(AnnouncementStates.contact_name, F.chat.type == "private", F.text)
async def receive_name(message: Message, state: FSMContext, session: AsyncSession) -> None:
    name = None if message.text == translate("common.skip") else message.text
    await state.update_data(contact_name=name)
    await _ask_groups(message, state, session)


async def _ask_groups(message: Message, state: FSMContext, session: AsyncSession) -> None:
    if message.from_user is None:
        return
    user_id = await _user_id(session, message.from_user.id)
    groups = await list_user_groups(session, user_id) if user_id else []
    if not groups:
        await message.answer(translate("announcements.no_groups"))
        return
    await state.set_state(AnnouncementStates.groups)
    await state.update_data(selected_group_ids=[])
    await message.answer(translate("announcements.select_groups"), reply_markup=_groups_keyboard(groups, []))


def _groups_keyboard(groups: list, selected: list[int]) -> InlineKeyboardMarkup:
    rows = []
    for group in groups:
        marker = "✅ " if group.id in selected else ""
        rows.append([InlineKeyboardButton(text=f"{marker}{group.title}", callback_data=f"ann:group:{group.id}")])
    rows.append([InlineKeyboardButton(text=translate("common.done"), callback_data="ann:groups_done")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


@router.callback_query(AnnouncementStates.groups, F.data.startswith("ann:group:"))
async def toggle_group(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.from_user is None or callback.message is None:
        return
    try:
        group_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    groups = await list_user_groups(session, user_id) if user_id else []
    if group_id not in {group.id for group in groups}:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    selected = list((await state.get_data()).get("selected_group_ids", []))
    selected = [item for item in selected if item != group_id] if group_id in selected else [*selected, group_id]
    await state.update_data(selected_group_ids=selected)
    await callback.message.edit_reply_markup(reply_markup=_groups_keyboard(groups, selected))
    await callback.answer()


@router.callback_query(AnnouncementStates.groups, F.data == "ann:groups_done")
async def finish_groups(callback: CallbackQuery, state: FSMContext) -> None:
    selected = (await state.get_data()).get("selected_group_ids", [])
    if not selected:
        await callback.answer(translate("validation.group_required"), show_alert=True)
        return
    await state.set_state(AnnouncementStates.interval)
    if callback.message:
        await callback.message.answer(translate("announcements.select_interval"), reply_markup=_interval_keyboard())
    await callback.answer()


@router.callback_query(AnnouncementStates.interval, F.data.startswith("ann:interval:"))
async def select_interval(callback: CallbackQuery, state: FSMContext) -> None:
    try:
        interval = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if interval not in INTERVALS:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(interval_minutes=interval)
    await state.set_state(AnnouncementStates.save_template)
    if callback.message:
        await callback.message.answer(
            translate("announcements.save_template"),
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text=translate("common.yes"), callback_data="ann:save_template:yes"),
                InlineKeyboardButton(text=translate("common.no"), callback_data="ann:save_template:no"),
            ]]),
        )
    await callback.answer()


@router.callback_query(AnnouncementStates.save_template, F.data.startswith("ann:save_template:"))
async def select_template_save(callback: CallbackQuery, state: FSMContext) -> None:
    save_template = (callback.data or "").endswith(":yes")
    await state.update_data(save_template=save_template)
    await state.set_state(AnnouncementStates.first_run)
    if callback.message:
        data = await state.get_data()
        if data.get("photo_file_id"):
            await callback.message.answer_photo(data["photo_file_id"], caption=data["text"][:1024])
            if len(data["text"]) > 1024:
                await callback.message.answer(data["text"])
        else:
            await callback.message.answer(data["text"])
        await callback.message.answer(
            translate("announcements.select_first_run"),
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text=translate("announcements.immediate"), callback_data="ann:first:immediate"),
                InlineKeyboardButton(text=translate("announcements.scheduled"), callback_data="ann:first:scheduled"),
            ]]),
        )
    await callback.answer()


@router.callback_query(AnnouncementStates.first_run, F.data.startswith("ann:first:"))
async def create_finished_announcement(
    callback: CallbackQuery, state: FSMContext, session: AsyncSession
) -> None:
    if callback.from_user is None or callback.message is None:
        return
    mode_name = (callback.data or "").rsplit(":", 1)[-1]
    if mode_name not in {FirstRunMode.IMMEDIATE.value, FirstRunMode.SCHEDULED.value}:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    data = await state.get_data()
    if user_id is None or not data.get("text") or not data.get("selected_group_ids"):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if not await can_create_announcement(session, user_id):
        await callback.answer(translate("validation.limit_reached"), show_alert=True)
        return
    mode = FirstRunMode(mode_name)
    interval = int(data["interval_minutes"])
    next_run_at = utc_now() if mode == FirstRunMode.IMMEDIATE else utc_now() + timedelta(minutes=interval)
    announcement = await create_announcement(
        session,
        user_id=user_id,
        text=data["text"],
        photo_file_id=data.get("photo_file_id"),
        contact_phone=data.get("contact_phone"),
        contact_telegram=data.get("contact_telegram"),
        contact_name=data.get("contact_name"),
        interval_minutes=interval,
        first_run_mode=mode,
        next_run_at=next_run_at,
        group_ids=data["selected_group_ids"],
    )
    if data.get("save_template"):
        await create_template(
            session, user_id=user_id, text=data["text"], photo_file_id=data.get("photo_file_id")
        )
    await state.clear()
    await callback.message.answer(translate("announcements.created"))
    await callback.answer()


@router.callback_query(F.data.startswith("ann:show:"))
async def show_announcement(callback: CallbackQuery, session: AsyncSession) -> None:
    if callback.from_user is None or callback.message is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    announcement = await get_announcement(session, user_id=user_id, announcement_id=announcement_id) if user_id else None
    if announcement is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    active = announcement.status == AnnouncementStatus.ACTIVE
    status = translate("announcements.active" if active else "announcements.paused")
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=translate("announcements.stop" if active else "announcements.start"), callback_data=f"ann:toggle:{announcement.id}")],
        [InlineKeyboardButton(text=translate("common.edit"), callback_data=f"ann:edit:{announcement.id}")],
        [InlineKeyboardButton(text=translate("common.delete"), callback_data=f"ann:delete:{announcement.id}")],
        [InlineKeyboardButton(text=translate("common.back"), callback_data="ann:list")],
    ])
    await callback.message.answer(
        translate("announcements.details", text=announcement.text, status=status, interval=announcement.interval_minutes, groups=len(announcement.group_links)),
        reply_markup=keyboard,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:edit:"))
async def edit_announcement_placeholder(callback: CallbackQuery) -> None:
    """Open the announcement field-selection menu."""
    if callback.message:
        announcement_id = (callback.data or "").rsplit(":", 1)[-1]
        await callback.message.answer(
            translate("announcements.edit_menu"),
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text=translate("announcements.edit_text"), callback_data=f"ann:edit_text:{announcement_id}")],
                [InlineKeyboardButton(text=translate("announcements.edit_contact"), callback_data=f"ann:edit_contact:{announcement_id}")],
                [InlineKeyboardButton(text=translate("announcements.edit_name"), callback_data=f"ann:edit_name:{announcement_id}")],
                [InlineKeyboardButton(text=translate("announcements.edit_groups"), callback_data=f"ann:edit_groups:{announcement_id}")],
                [InlineKeyboardButton(text=translate("announcements.edit_interval"), callback_data=f"ann:edit_interval:{announcement_id}")],
            ]),
        )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:edit_interval:"))
async def edit_interval_start(callback: CallbackQuery, state: FSMContext) -> None:
    if callback.message is None:
        return
    announcement_id = (callback.data or "").rsplit(":", 1)[-1]
    await state.update_data(edit_announcement_id=int(announcement_id))
    await state.set_state(AnnouncementStates.editing_interval)
    await callback.message.answer(translate("announcements.select_interval"), reply_markup=_interval_keyboard())
    await callback.answer()


@router.callback_query(AnnouncementStates.editing_interval, F.data.startswith("ann:interval:"))
async def edit_interval_save(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.from_user is None:
        return
    interval = int((callback.data or "").rsplit(":", 1)[-1])
    data = await state.get_data()
    user_id = await _user_id(session, callback.from_user.id)
    if user_id and interval in INTERVALS:
        await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], interval_minutes=interval, next_run_at=utc_now() + timedelta(minutes=interval))
        await callback.answer(translate("templates.updated"), show_alert=True)
    await state.clear()


async def _begin_field_edit(callback: CallbackQuery, state: FSMContext, field: str) -> None:
    if callback.from_user is None or callback.message is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(edit_announcement_id=announcement_id)
    state_map = {"text": AnnouncementStates.editing_text, "contact": AnnouncementStates.editing_contact, "name": AnnouncementStates.editing_name, "photo": AnnouncementStates.editing_photo}
    await state.set_state(state_map[field])
    await callback.message.answer(translate("announcements.send_text" if field == "text" else "announcements.send_contact" if field == "contact" else "announcements.send_name" if field == "name" else "announcements.send_ready_photo"))
    await callback.answer()


@router.callback_query(F.data.startswith("ann:edit_text:"))
async def edit_text_start(callback: CallbackQuery, state: FSMContext) -> None:
    await _begin_field_edit(callback, state, "text")


@router.callback_query(F.data.startswith("ann:edit_contact:"))
async def edit_contact_start(callback: CallbackQuery, state: FSMContext) -> None:
    await _begin_field_edit(callback, state, "contact")


@router.callback_query(F.data.startswith("ann:edit_name:"))
async def edit_name_start(callback: CallbackQuery, state: FSMContext) -> None:
    await _begin_field_edit(callback, state, "name")


@router.callback_query(F.data.startswith("ann:edit_photo:"))
async def edit_photo_start(callback: CallbackQuery, state: FSMContext) -> None:
    await _begin_field_edit(callback, state, "photo")


@router.message(AnnouncementStates.editing_text, F.text)
async def edit_text_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.text and len(message.text) <= MAX_TEXT_LENGTH:
        user_id = await _user_id(session, message.from_user.id)
        if user_id and await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], text=message.text):
            await message.answer(translate("templates.updated"))
    await state.clear()


@router.message(AnnouncementStates.editing_contact, F.text)
async def edit_contact_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.text:
        user_id = await _user_id(session, message.from_user.id)
        values = {"contact_telegram": message.text, "contact_phone": None} if message.text.startswith("@") else {"contact_phone": message.text, "contact_telegram": None}
        if user_id:
            await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], **values)
            await message.answer(translate("templates.updated"))
    await state.clear()


@router.message(AnnouncementStates.editing_name, F.text)
async def edit_name_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.text:
        user_id = await _user_id(session, message.from_user.id)
        if user_id:
            await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], contact_name=message.text)
            await message.answer(translate("templates.updated"))
    await state.clear()


@router.message(AnnouncementStates.editing_photo, F.photo)
async def edit_photo_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.photo:
        user_id = await _user_id(session, message.from_user.id)
        values = {"photo_file_id": message.photo[-1].file_id}
        if message.caption and len(message.caption) <= MAX_CAPTION_LENGTH:
            values["text"] = message.caption
        if user_id:
            await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], **values)
            await message.answer(translate("templates.updated"))
    await state.clear()


@router.callback_query(F.data == "ann:list")
async def announcement_list_back(callback: CallbackQuery) -> None:
    """Acknowledge return to the persistent main menu."""
    await callback.answer()


@router.callback_query(F.data.startswith("ann:toggle:"))
async def toggle_announcement(callback: CallbackQuery, session: AsyncSession) -> None:
    if callback.from_user is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    announcement = await get_announcement(session, user_id=user_id, announcement_id=announcement_id) if user_id else None
    if announcement is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    new_status = AnnouncementStatus.PAUSED if announcement.status == AnnouncementStatus.ACTIVE else AnnouncementStatus.ACTIVE
    if new_status == AnnouncementStatus.ACTIVE:
        announcement.next_run_at = utc_now() + timedelta(minutes=announcement.interval_minutes)
        announcement.status = new_status
    else:
        await set_announcement_status(session, user_id=user_id, announcement_id=announcement_id, status=new_status)
    await callback.answer(translate("announcements.paused" if new_status == AnnouncementStatus.PAUSED else "announcements.active"), show_alert=True)


@router.callback_query(F.data.startswith("ann:delete:"))
async def delete_announcement_handler(callback: CallbackQuery, session: AsyncSession) -> None:
    if callback.from_user is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    deleted = user_id is not None and await delete_announcement(session, user_id=user_id, announcement_id=announcement_id)
    await callback.answer(translate("announcements.deleted" if deleted else "common.not_found"), show_alert=not deleted)
