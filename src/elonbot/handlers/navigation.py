"""Reusable FSM navigation helpers that preserve collected draft data."""

from __future__ import annotations

from typing import Final

from aiogram.fsm.context import FSMContext


NAVIGATION_HISTORY_KEY: Final = "_navigation_history"


async def remember_screen(state: FSMContext, screen: str) -> None:
    """Append the current logical screen before moving to another one."""
    data = await state.get_data()
    history = list(data.get(NAVIGATION_HISTORY_KEY, []))
    history.append(screen)
    await state.update_data(**{NAVIGATION_HISTORY_KEY: history})


async def previous_screen(state: FSMContext) -> str | None:
    """Return the previous screen without clearing the rest of the draft data."""
    data = await state.get_data()
    history = list(data.get(NAVIGATION_HISTORY_KEY, []))
    if not history:
        return None

    previous = history.pop()
    await state.update_data(**{NAVIGATION_HISTORY_KEY: history})
    return previous
