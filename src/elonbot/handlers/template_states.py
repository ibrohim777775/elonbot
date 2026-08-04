"""FSM states used by template creation and editing."""

from aiogram.fsm.state import State, StatesGroup


class TemplateStates(StatesGroup):
    """States for receiving template content from a user."""

    creating_text = State()
    creating_photo = State()
    creating_photo_caption = State()
    editing_text = State()
    editing_photo = State()
