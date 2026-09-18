"""FSM states for the new announcement wizard."""

from aiogram.fsm.state import State, StatesGroup


class AnnouncementStates(StatesGroup):
    content_text = State()
    content_photo = State()
    content_photo_caption = State()
    contact = State()
    contact_name = State()
    groups = State()
    interval = State()
    save_template = State()
    first_run = State()
    confirm = State()
    editing_text = State()
    editing_contact = State()
    editing_name = State()
    editing_photo = State()
    editing_interval = State()
    editing_groups = State()
