from elonbot.locales.translator import translate


def test_start_text_is_uzbek_and_mentions_core_feature() -> None:
    welcome = translate("start.welcome")

    assert "Telegram" in welcome
    assert "avtomatik" in welcome
    assert translate("start.choose_section") == "Kerakli bo'limni tanlang."
