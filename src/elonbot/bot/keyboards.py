"""Telegram keyboards constructed from localized labels."""

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup

from elonbot.locales.translator import translate


def main_menu_keyboard() -> ReplyKeyboardMarkup:
    """Create the persistent three-section bottom menu."""
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text=translate("menu.announcements"))],
            [KeyboardButton(text=translate("menu.templates"))],
            [KeyboardButton(text=translate("menu.groups"))],
        ],
        resize_keyboard=True,
        input_field_placeholder=translate("start.choose_section"),
    )


def back_keyboard(callback_data: str = "navigation:back") -> InlineKeyboardMarkup:
    """Create a reusable inline back button for wizard and detail screens."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=translate("common.back"),
                    callback_data=callback_data,
                )
            ]
        ]
    )


def groups_keyboard(groups: list[tuple[int, str]]) -> InlineKeyboardMarkup:
    """Create group list controls for the current user's connected groups."""
    rows = [
        [InlineKeyboardButton(text=title, callback_data=f"groups:show:{group_id}")]
        for group_id, title in groups
    ]
    rows.append(
        [InlineKeyboardButton(text=translate("groups.add"), callback_data="groups:add")]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def group_details_keyboard(group_id: int) -> InlineKeyboardMarkup:
    """Create controls for one group connection."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=translate("common.delete"),
                    callback_data=f"groups:delete:{group_id}",
                )
            ],
            [InlineKeyboardButton(text=translate("common.back"), callback_data="groups:list")],
        ]
    )


def group_disconnect_confirmation_keyboard(group_id: int) -> InlineKeyboardMarkup:
    """Create confirmation controls before removing a group connection."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=translate("common.yes"),
                    callback_data=f"groups:delete_confirm:{group_id}",
                ),
                InlineKeyboardButton(
                    text=translate("common.no"),
                    callback_data=f"groups:show:{group_id}",
                ),
            ]
        ]
    )


def templates_keyboard(templates: list[tuple[int, str, bool]]) -> InlineKeyboardMarkup:
    """Create controls for the current user's template list."""
    rows = []
    for template_id, text, has_photo in templates:
        short_text = text.replace("\n", " ").strip()[:40]
        label = f"{translate('templates.photo_mark')} {short_text}" if has_photo else short_text
        rows.append([InlineKeyboardButton(text=label, callback_data=f"templates:show:{template_id}")])
    rows.append(
        [InlineKeyboardButton(text=translate("templates.create"), callback_data="templates:create")]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def template_creation_keyboard() -> InlineKeyboardMarkup:
    """Create controls for selecting a text or photo template."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=translate("templates.text"), callback_data="templates:create_text")],
            [
                InlineKeyboardButton(
                    text=translate("templates.photo_message"),
                    callback_data="templates:create_photo",
                )
            ],
            [InlineKeyboardButton(text=translate("common.back"), callback_data="templates:list")],
        ]
    )


def template_details_keyboard(template_id: int, has_photo: bool) -> InlineKeyboardMarkup:
    """Create controls for viewing and editing one template."""
    rows = [
        [
            InlineKeyboardButton(
                text=translate("templates.edit_text"), callback_data=f"templates:edit_text:{template_id}"
            )
        ],
        [
            InlineKeyboardButton(
                text=translate("templates.replace_photo"), callback_data=f"templates:edit_photo:{template_id}"
            )
        ],
    ]
    if has_photo:
        rows.append(
            [
                InlineKeyboardButton(
                    text=translate("templates.remove_photo"),
                    callback_data=f"templates:remove_photo:{template_id}",
                )
            ]
        )
    rows.extend(
        [
            [
                InlineKeyboardButton(
                    text=translate("common.delete"), callback_data=f"templates:delete:{template_id}"
                )
            ],
            [InlineKeyboardButton(text=translate("common.back"), callback_data="templates:list")],
        ]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def template_delete_confirmation_keyboard(template_id: int) -> InlineKeyboardMarkup:
    """Create confirmation controls before deleting a template."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=translate("common.yes"),
                    callback_data=f"templates:delete_confirm:{template_id}",
                ),
                InlineKeyboardButton(
                    text=translate("common.no"),
                    callback_data=f"templates:show:{template_id}",
                ),
            ]
        ]
    )
