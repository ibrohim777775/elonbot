"""Announcement creation, listing, pause, resume, and deletion handlers."""

from datetime import timedelta

from aiogram import Bot, F, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
)
from sqlalchemy.ext.asyncio import AsyncSession

from elonbot.bot.keyboards import main_menu_keyboard, templates_keyboard
from elonbot.database.base import utc_now
from elonbot.database.session import get_session_factory
from elonbot.database.enums import AnnouncementStatus, FirstRunMode
from elonbot.handlers.announcement_states import AnnouncementStates
from elonbot.locales.translator import translate
from elonbot.repositories.announcements import (
    create_announcement,
    delete_announcement,
    get_announcement,
    list_delivery_message_ids,
    list_announcements,
    replace_announcement_groups,
    set_announcement_status,
    update_announcement,
)
from elonbot.repositories.groups import list_user_groups
from elonbot.repositories.templates import create_template, get_template, list_templates
from elonbot.repositories.users import get_user_by_telegram_id
from elonbot.services.limits import can_create_announcement
from elonbot.services.groups import discover_known_groups_for_user
from elonbot.scheduler.delivery import DeliveryService

router = Router(name="announcements")
INTERVALS = (5, 10, 15, 20, 60, 120, 180, 300, 480)
MAX_TEXT_LENGTH = 4096
MAX_CAPTION_LENGTH = 1024
MAX_PHOTOS = 4


async def _user_id(session: AsyncSession, telegram_id: int) -> int | None:
    user = await get_user_by_telegram_id(session, telegram_id)
    return user.id if user else None


def _announcements_keyboard(announcements: list) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text=announcement.text[:40], callback_data=f"ann:show:{announcement.id}")]
        for announcement in announcements
    ]
    rows.append([InlineKeyboardButton(text=translate("announcements.create"), callback_data="ann:create")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


async def _return_to_announcements(
    message: Message, session: AsyncSession, user_id: int, notice: str
) -> None:
    """Confirm an action and show a fresh list rather than an obsolete card."""
    announcements = await list_announcements(session, user_id)
    title = translate("announcements.title") if announcements else translate("announcements.empty")
    text = f"{notice}\n\n{title}"
    if message.from_user and message.from_user.is_bot:
        try:
            await message.edit_text(text, reply_markup=_announcements_keyboard(announcements))
        except TelegramBadRequest as error:
            # Telegram can deliver the same callback again after a slow network request.
            if "message is not modified" not in str(error).lower():
                raise
    else:
        await message.answer(text, reply_markup=_announcements_keyboard(announcements))


def _creation_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=translate("announcements.from_template"), callback_data="ann:create:template")],
    ])


def _interval_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"{value} daqiqa" if value < 60 else f"{value // 60} soat", callback_data=f"ann:interval:{value}")]
        for value in INTERVALS
    ])


def _contact_keyboard(username: str | None) -> ReplyKeyboardMarkup:
    """Offer Telegram's secure contact-sharing button and the known username."""
    rows = [[KeyboardButton(text=translate("announcements.share_phone"), request_contact=True)]]
    if username:
        rows.append([KeyboardButton(text=f"@{username}")])
    return ReplyKeyboardMarkup(keyboard=rows, resize_keyboard=True, one_time_keyboard=True)


async def _begin_contact(message: Message, state: FSMContext) -> None:
    await state.set_state(AnnouncementStates.contact)
    await message.answer(
        translate("announcements.send_contact"),
        reply_markup=_contact_keyboard(message.from_user.username if message.from_user else None),
    )


@router.message(F.chat.type == "private", F.text == translate("menu.announcements"))
async def announcements_menu(message: Message, session: AsyncSession) -> None:
    if message.from_user is None:
        return
    user_id = await _user_id(session, message.from_user.id)
    announcements = await list_announcements(session, user_id) if user_id else []
    await message.answer(
        translate("announcements.title") if announcements else translate("announcements.empty"),
        reply_markup=_announcements_keyboard(announcements),
    )


@router.callback_query(F.data == "ann:create")
async def create_menu(callback: CallbackQuery, state: FSMContext) -> None:
    """Start creation: select a template or send text/photo directly."""
    # A new wizard must never inherit images or groups from an abandoned one.
    await state.clear()
    await state.set_state(AnnouncementStates.content_text)
    if callback.message:
        await callback.message.edit_text(
            translate("announcements.create_instruction"), reply_markup=_creation_keyboard()
        )
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
    await callback.message.edit_text(
        translate("templates.empty") if not rows else translate("announcements.from_template"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=rows) if rows else None,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:template:"))
async def apply_template(callback: CallbackQuery, state: FSMContext, session: AsyncSession, bot: Bot) -> None:
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
    await state.update_data(
        text=template.text,
        photo_file_id=template.photo_file_id,
        photo_file_ids=template.photo_file_ids
        or ([template.photo_file_id] if template.photo_file_id else None),
    )
    await _ask_groups(callback.message, state, session, bot=bot, telegram_id=callback.from_user.id)
    await callback.answer()


@router.message(AnnouncementStates.content_text, F.chat.type == "private", F.text)
async def receive_text(message: Message, state: FSMContext, session: AsyncSession, bot: Bot) -> None:
    if not message.text:
        return
    if len(message.text) > MAX_TEXT_LENGTH:
        await message.answer(translate("common.error"))
        return
    await state.update_data(text=message.text, photo_file_id=None, photo_file_ids=None)
    await _ask_groups(message, state, session, bot=bot)


@router.message(
    F.chat.type == "private",
    F.photo,
    StateFilter(AnnouncementStates.content_text, AnnouncementStates.content_photo),
)
async def receive_photo(message: Message, state: FSMContext, session: AsyncSession) -> None:
    if not message.photo:
        return
    data = await state.get_data()
    photo_file_ids = list(data.get("photo_file_ids") or [])
    if len(photo_file_ids) >= MAX_PHOTOS:
        await message.answer(translate("announcements.photo_limit"))
        return
    photo_file_ids.append(message.photo[-1].file_id)
    await state.update_data(photo_file_id=photo_file_ids[0], photo_file_ids=photo_file_ids)
    if message.caption and not data.get("text"):
        if len(message.caption) > MAX_CAPTION_LENGTH:
            await message.answer(translate("common.error"))
            return
        await state.update_data(text=message.caption)
    if not (await state.get_data()).get("text"):
        await state.set_state(AnnouncementStates.content_photo_caption)
        await message.answer(translate("announcements.photo_without_caption"))
        return
    await state.set_state(AnnouncementStates.content_photo)
    await message.answer(
        translate("announcements.photos_continue"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("common.done"), callback_data="ann:photos_done")
        ]]),
    )


@router.message(AnnouncementStates.content_photo_caption, F.chat.type == "private", F.text)
async def receive_photo_caption(message: Message, state: FSMContext, session: AsyncSession) -> None:
    if not message.text:
        return
    await state.update_data(text=message.text)
    await state.set_state(AnnouncementStates.content_photo)
    await message.answer(
        translate("announcements.photos_continue"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("common.done"), callback_data="ann:photos_done")
        ]]),
    )


@router.callback_query(AnnouncementStates.content_photo, F.data == "ann:photos_done")
async def finish_photos(callback: CallbackQuery, state: FSMContext, session: AsyncSession, bot: Bot) -> None:
    if callback.message is None:
        return
    data = await state.get_data()
    if not data.get("photo_file_ids") or not data.get("text"):
        await callback.answer(translate("common.error"), show_alert=True)
        return
    await _ask_groups(
        callback.message, state, session, bot=bot, telegram_id=callback.from_user.id if callback.from_user else None
    )
    await callback.answer()


async def _save_contact(message: Message, state: FSMContext, value: str, is_telegram: bool) -> None:
    if not value:
        return
    if is_telegram:
        await state.update_data(contact_telegram=value, contact_phone=None)
    else:
        await state.update_data(contact_phone=value, contact_telegram=None)
    await state.set_state(AnnouncementStates.contact_name)
    await message.answer(
        translate("announcements.send_name"),
        reply_markup=ReplyKeyboardMarkup(
            keyboard=[[KeyboardButton(text=translate("common.skip"))]],
            resize_keyboard=True,
            one_time_keyboard=True,
        ),
    )


@router.message(AnnouncementStates.contact, F.chat.type == "private", F.contact)
async def receive_shared_contact(message: Message, state: FSMContext) -> None:
    if message.contact is None or message.from_user is None or message.contact.user_id != message.from_user.id:
        await message.answer(translate("validation.contact_required"))
        return
    await _save_contact(message, state, message.contact.phone_number, is_telegram=False)


@router.message(AnnouncementStates.contact, F.chat.type == "private", F.text)
async def receive_contact(message: Message, state: FSMContext) -> None:
    if not message.text:
        return
    value = message.text.strip()
    await _save_contact(message, state, value, is_telegram=value.startswith("@") or "t.me/" in value)


@router.message(AnnouncementStates.contact_name, F.chat.type == "private", F.text)
async def receive_name(message: Message, state: FSMContext, session: AsyncSession) -> None:
    name = None if message.text == translate("common.skip") else message.text
    await state.update_data(contact_name=name)
    await _ask_groups(message, state, session)


async def _ask_groups(
    message: Message, state: FSMContext, session: AsyncSession, bot: Bot | None = None, telegram_id: int | None = None
) -> None:
    owner_telegram_id = telegram_id or (message.from_user.id if message.from_user else None)
    if owner_telegram_id is None:
        return
    user_id = await _user_id(session, owner_telegram_id)
    if user_id is not None and bot is not None:
        user = await get_user_by_telegram_id(session, owner_telegram_id)
        if user is not None:
            await discover_known_groups_for_user(bot=bot, session=session, user=user)
    groups = await list_user_groups(session, user_id) if user_id else []
    if not groups:
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("groups.add"), callback_data="groups:add")
        ]])
        if telegram_id is not None:
            await message.edit_text(translate("groups.no_bot_groups"), reply_markup=keyboard)
        else:
            await message.answer(translate("groups.no_bot_groups"), reply_markup=keyboard)
        return
    await state.set_state(AnnouncementStates.groups)
    await state.update_data(selected_group_ids=[])
    if telegram_id is not None:
        await message.edit_text(
            translate("announcements.select_groups"), reply_markup=_groups_keyboard(groups, [])
        )
    else:
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
        await callback.message.edit_text(translate("announcements.select_interval"), reply_markup=_interval_keyboard())
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
        await callback.message.edit_text(
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
async def choose_first_run(callback: CallbackQuery, state: FSMContext) -> None:
    """Show the final announcement preview before persisting it."""
    mode_name = (callback.data or "").rsplit(":", 1)[-1]
    if mode_name not in {FirstRunMode.IMMEDIATE.value, FirstRunMode.SCHEDULED.value}:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(first_run_mode=mode_name)
    await state.set_state(AnnouncementStates.confirm)
    if callback.message:
        data = await state.get_data()
        preview = translate(
            "announcements.preview",
            text=data["text"],
            interval=data["interval_minutes"],
            groups=len(data["selected_group_ids"]),
        )
        await callback.message.answer(
            preview,
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text=translate("common.confirm"), callback_data="ann:confirm"),
                InlineKeyboardButton(text=translate("common.cancel"), callback_data="ann:cancel"),
            ]]),
        )
    await callback.answer()


@router.callback_query(AnnouncementStates.confirm, F.data == "ann:confirm")
async def create_finished_announcement(
    callback: CallbackQuery, state: FSMContext, session: AsyncSession, bot: Bot
) -> None:
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _user_id(session, callback.from_user.id)
    data = await state.get_data()
    if user_id is None or not data.get("text") or not data.get("selected_group_ids"):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if not await can_create_announcement(session, user_id):
        await callback.answer(translate("validation.limit_reached"), show_alert=True)
        return
    mode = FirstRunMode(data["first_run_mode"])
    interval = int(data["interval_minutes"])
    next_run_at = utc_now() if mode == FirstRunMode.IMMEDIATE else utc_now() + timedelta(minutes=interval)
    announcement = await create_announcement(
        session,
        user_id=user_id,
        text=data["text"],
        photo_file_id=data.get("photo_file_id"),
        photo_file_ids=data.get("photo_file_ids"),
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
    if mode == FirstRunMode.IMMEDIATE:
        # Commit the new row before delivery, so a restart cannot lose or duplicate the first run.
        await session.commit()
        await DeliveryService(bot, get_session_factory()).process_due()
    await state.clear()
    await callback.message.answer(translate("announcements.created"), reply_markup=main_menu_keyboard())
    await callback.answer()


@router.callback_query(AnnouncementStates.confirm, F.data == "ann:cancel")
async def cancel_creation(callback: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    await callback.answer(translate("common.cancel"), show_alert=True)


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
    keyboard = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=translate("common.edit"), callback_data=f"ann:edit:{announcement.id}")],
        [InlineKeyboardButton(text=translate("common.delete"), callback_data=f"ann:delete_request:{announcement.id}")],
        [InlineKeyboardButton(text=translate("common.back"), callback_data="ann:list")],
    ])
    await callback.message.edit_text(
        translate("announcements.details", text=announcement.text, interval=announcement.interval_minutes, groups=len(announcement.group_links)),
        reply_markup=keyboard,
    )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:edit:"))
async def edit_announcement_placeholder(callback: CallbackQuery, session: AsyncSession) -> None:
    """Open the announcement field-selection menu."""
    if callback.message and callback.from_user:
        try:
            announcement_id = int((callback.data or "").rsplit(":", 1)[-1])
        except (IndexError, ValueError):
            await callback.answer(translate("common.not_found"), show_alert=True)
            return
        user_id = await _user_id(session, callback.from_user.id)
        if user_id is None or await get_announcement(session, user_id=user_id, announcement_id=announcement_id) is None:
            await callback.answer(translate("common.not_found"), show_alert=True)
            return
        await callback.message.edit_text(
            translate("announcements.edit_menu"),
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[
                [InlineKeyboardButton(text=translate("announcements.edit_text"), callback_data=f"ann:edit_text:{announcement_id}")],
                [InlineKeyboardButton(text=translate("announcements.edit_groups"), callback_data=f"ann:edit_groups:{announcement_id}")],
                [InlineKeyboardButton(text=translate("announcements.edit_interval"), callback_data=f"ann:edit_interval:{announcement_id}")],
            ]),
        )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:edit_interval:"))
async def edit_interval_start(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.message is None or callback.from_user is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[-1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    if user_id is None or await get_announcement(session, user_id=user_id, announcement_id=announcement_id) is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(edit_announcement_id=announcement_id)
    await state.set_state(AnnouncementStates.editing_interval)
    await callback.message.edit_text(translate("announcements.select_interval"), reply_markup=_interval_keyboard())
    await callback.answer()


@router.callback_query(AnnouncementStates.editing_interval, F.data.startswith("ann:interval:"))
async def edit_interval_save(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.from_user is None:
        return
    try:
        interval = int((callback.data or "").rsplit(":", 1)[-1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        await state.clear()
        return
    data = await state.get_data()
    user_id = await _user_id(session, callback.from_user.id)
    if user_id and interval in INTERVALS:
        updated = await update_announcement(
            session,
            user_id=user_id,
            announcement_id=data["edit_announcement_id"],
            interval_minutes=interval,
            next_run_at=utc_now() + timedelta(minutes=interval),
        )
        if updated and callback.message is not None:
            await _return_to_announcements(callback.message, session, user_id, translate("templates.updated"))
        await callback.answer(translate("templates.updated") if updated else translate("common.not_found"), show_alert=True)
        await state.clear()
        return
    await callback.answer(translate("common.not_found"), show_alert=True)
    await state.clear()


@router.callback_query(F.data.startswith("ann:edit_groups:"))
async def edit_groups_start(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
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
    groups = await list_user_groups(session, user_id)
    selected = [link.group_id for link in announcement.group_links]
    await state.update_data(
        edit_announcement_id=announcement_id,
        edit_interval_minutes=announcement.interval_minutes,
        selected_group_ids=selected,
    )
    await state.set_state(AnnouncementStates.editing_groups)
    await callback.message.edit_text(translate("announcements.select_groups"), reply_markup=_edit_groups_keyboard(groups, selected))
    await callback.answer()


def _edit_groups_keyboard(groups: list, selected: list[int]) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(text=f"{'✅ ' if group.id in selected else ''}{group.title}", callback_data=f"ann:edit_group:{group.id}")]
        for group in groups
    ]
    rows.append([InlineKeyboardButton(text=translate("common.done"), callback_data="ann:edit_groups_done")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


@router.callback_query(AnnouncementStates.editing_groups, F.data.startswith("ann:edit_group:"))
async def edit_groups_toggle(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
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
    await callback.message.edit_reply_markup(reply_markup=_edit_groups_keyboard(groups, selected))
    await callback.answer()


@router.callback_query(AnnouncementStates.editing_groups, F.data == "ann:edit_groups_done")
async def edit_groups_save(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    if callback.from_user is None:
        return
    data = await state.get_data()
    group_ids = list(data.get("selected_group_ids", []))
    if not group_ids:
        await callback.answer(translate("validation.group_required"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    announcement_id = data.get("edit_announcement_id")
    if user_id is None or not isinstance(announcement_id, int):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    updated = await replace_announcement_groups(
        session, user_id=user_id, announcement_id=announcement_id, group_ids=group_ids
    )
    if updated:
        await update_announcement(
            session,
            user_id=user_id,
            announcement_id=announcement_id,
            next_run_at=utc_now() + timedelta(minutes=int(data["edit_interval_minutes"])),
        )
    await state.clear()
    if updated and callback.message is not None:
        await _return_to_announcements(callback.message, session, user_id, translate("templates.updated"))
    await callback.answer(translate("common.not_found") if not updated else None, show_alert=not updated)


async def _begin_field_edit(
    callback: CallbackQuery, state: FSMContext, session: AsyncSession, field: str
) -> None:
    if callback.from_user is None or callback.message is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    if user_id is None or await get_announcement(session, user_id=user_id, announcement_id=announcement_id) is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    await state.update_data(edit_announcement_id=announcement_id)
    state_map = {"text": AnnouncementStates.editing_text, "contact": AnnouncementStates.editing_contact, "name": AnnouncementStates.editing_name, "photo": AnnouncementStates.editing_photo}
    await state.set_state(state_map[field])
    await callback.message.answer(translate("announcements.send_text" if field == "text" else "announcements.send_contact" if field == "contact" else "announcements.send_name" if field == "name" else "announcements.send_ready_photo"))
    await callback.answer()


@router.callback_query(F.data.startswith("ann:edit_text:"))
async def edit_text_start(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    await _begin_field_edit(callback, state, session, "text")


@router.callback_query(F.data.startswith("ann:edit_contact:"))
async def edit_contact_start(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    await callback.answer(translate("common.not_found"), show_alert=True)


@router.callback_query(F.data.startswith("ann:edit_name:"))
async def edit_name_start(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    await callback.answer(translate("common.not_found"), show_alert=True)


@router.callback_query(F.data.startswith("ann:edit_photo:"))
async def edit_photo_start(callback: CallbackQuery, state: FSMContext, session: AsyncSession) -> None:
    await callback.answer(translate("common.not_found"), show_alert=True)


@router.message(AnnouncementStates.editing_text, F.text)
async def edit_text_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.text and len(message.text) <= MAX_TEXT_LENGTH:
        user_id = await _user_id(session, message.from_user.id)
        if user_id and await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], text=message.text):
            await _return_to_announcements(message, session, user_id, translate("templates.updated"))
    await state.clear()


@router.message(AnnouncementStates.editing_contact, F.text)
async def edit_contact_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.text:
        user_id = await _user_id(session, message.from_user.id)
        values = {"contact_telegram": message.text, "contact_phone": None} if message.text.startswith("@") else {"contact_phone": message.text, "contact_telegram": None}
        if user_id:
            updated = await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], **values)
            if updated:
                await _return_to_announcements(message, session, user_id, translate("templates.updated"))
    await state.clear()


@router.message(AnnouncementStates.editing_name, F.text)
async def edit_name_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.text:
        user_id = await _user_id(session, message.from_user.id)
        if user_id:
            updated = await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], contact_name=message.text)
            if updated:
                await _return_to_announcements(message, session, user_id, translate("templates.updated"))
    await state.clear()


@router.message(AnnouncementStates.editing_photo, F.photo)
async def edit_photo_save(message: Message, state: FSMContext, session: AsyncSession) -> None:
    data = await state.get_data()
    if message.from_user and message.photo:
        user_id = await _user_id(session, message.from_user.id)
        photo_file_id = message.photo[-1].file_id
        # Delivery uses ``photo_file_ids`` first, so replace the complete album too.
        values = {"photo_file_id": photo_file_id, "photo_file_ids": [photo_file_id]}
        if message.caption and len(message.caption) <= MAX_CAPTION_LENGTH:
            values["text"] = message.caption
        if user_id:
            updated = await update_announcement(session, user_id=user_id, announcement_id=data["edit_announcement_id"], **values)
            if updated:
                await _return_to_announcements(message, session, user_id, translate("templates.updated"))
    await state.clear()


@router.callback_query(F.data == "ann:list")
async def announcement_list_back(callback: CallbackQuery, session: AsyncSession) -> None:
    """Return from an announcement card to the current user's fresh list."""
    if callback.from_user is None or callback.message is None:
        return
    user_id = await _user_id(session, callback.from_user.id)
    if user_id is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    announcements = await list_announcements(session, user_id)
    await callback.message.edit_text(
        translate("announcements.title") if announcements else translate("announcements.empty"),
        reply_markup=_announcements_keyboard(announcements),
    )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:toggle:"))
async def retired_toggle_action(callback: CallbackQuery) -> None:
    """Safely reject stop/start buttons left in the chat history."""
    await callback.answer(translate("common.not_found"), show_alert=True)


@router.callback_query(F.data.startswith("ann:delete_request:"))
async def request_announcement_deletion(callback: CallbackQuery, session: AsyncSession) -> None:
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
    await callback.message.edit_text(
        translate("announcements.delete_confirm"),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=translate("common.yes"), callback_data=f"ann:delete_confirm:{announcement_id}"),
            InlineKeyboardButton(text=translate("common.no"), callback_data=f"ann:show:{announcement_id}"),
        ]]),
    )
    await callback.answer()


@router.callback_query(F.data.startswith("ann:delete_confirm:"))
async def delete_announcement_handler(callback: CallbackQuery, session: AsyncSession, bot: Bot) -> None:
    if callback.from_user is None:
        return
    try:
        announcement_id = int((callback.data or "").rsplit(":", 1)[1])
    except (IndexError, ValueError):
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    if user_id is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    # Stop the announcement first, then let the owner decide what to do with past messages.
    await callback.answer()
    stopped = await set_announcement_status(
        session,
        user_id=user_id,
        announcement_id=announcement_id,
        status=AnnouncementStatus.DELETED,
    )
    if not stopped:
        return
    if callback.message is not None:
        await callback.message.edit_text(
            translate("announcements.delete_sent_prompt"),
            reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(
                    text=translate("common.yes"), callback_data=f"ann:delete_messages:yes:{announcement_id}"
                ),
                InlineKeyboardButton(
                    text=translate("common.no"), callback_data=f"ann:delete_messages:no:{announcement_id}"
                ),
            ]]),
        )


@router.callback_query(F.data.startswith("ann:delete_messages:"))
async def finish_announcement_deletion(callback: CallbackQuery, session: AsyncSession, bot: Bot) -> None:
    """Optionally remove historical group messages after an announcement is stopped."""
    if callback.from_user is None:
        return
    parts = (callback.data or "").split(":")
    if len(parts) != 4 or parts[2] not in {"yes", "no"}:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    try:
        announcement_id = int(parts[3])
    except ValueError:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    user_id = await _user_id(session, callback.from_user.id)
    if user_id is None:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    # Historical cleanup can be slow; acknowledge the choice before deleting messages.
    await callback.answer()
    if parts[2] == "yes":
        for chat_id, message_ids in await list_delivery_message_ids(
            session, user_id=user_id, announcement_id=announcement_id
        ):
            for message_id in message_ids:
                try:
                    await bot.delete_message(chat_id, message_id)
                except Exception:
                    continue
    deleted = await delete_announcement(session, user_id=user_id, announcement_id=announcement_id)
    if not deleted:
        await callback.answer(translate("common.not_found"), show_alert=True)
        return
    if callback.message is not None:
        await _return_to_announcements(callback.message, session, user_id, translate("announcements.deleted"))
