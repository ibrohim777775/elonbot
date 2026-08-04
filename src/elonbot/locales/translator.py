"""Loading and formatting localized user-facing strings."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


CATALOG_DIRECTORY = Path(__file__).parent
DEFAULT_LOCALE = "uz"


@lru_cache
def load_catalog(locale: str = DEFAULT_LOCALE) -> dict[str, Any]:
    """Load one JSON message catalog from the packaged locales directory."""
    if not locale.replace("_", "").isalnum():
        raise ValueError("Locale contains unsupported characters")

    catalog_path = CATALOG_DIRECTORY / f"{locale}.json"
    with catalog_path.open(encoding="utf-8") as catalog_file:
        return json.load(catalog_file)


def translate(key: str, /, locale: str = DEFAULT_LOCALE, **values: object) -> str:
    """Return a localized string by dotted key and interpolate its values."""
    value: Any = load_catalog(locale)
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            raise KeyError(f"Unknown localization key: {key}")
        value = value[part]

    if not isinstance(value, str):
        raise TypeError(f"Localization key does not contain text: {key}")
    return value.format(**values)
