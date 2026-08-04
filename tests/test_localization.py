from elonbot.locales.translator import load_catalog, translate


def test_uzbek_catalog_contains_main_menu_labels() -> None:
    assert translate("menu.announcements") == "E'lonlarim"
    assert translate("menu.templates") == "Shablonlar"
    assert translate("menu.groups") == "Guruhlar"


def test_catalog_contains_only_strings_or_nested_catalogs() -> None:
    catalog = load_catalog()

    assert isinstance(catalog["start"]["welcome"], str)
    assert isinstance(catalog["commands"]["boshlash"], str)
