import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import uz from "../uz.json";
import ru from "../ru.json";
import { t, withLanguage, changeLanguage, languageOf } from "../i18n";
import { Accounts } from "../accounts";
import { createBot } from "../bot";
import { Groups } from "../groups";
import { Delivery } from "../delivery";
import { Support } from "../support";
import { MiniApp } from "../miniapp";
import { one } from "../db";
import { Failure } from "../telegram";
import { botCommands } from "../commands";
import { announcement, config, seed, testDatabase } from "./helpers";

test("Russian catalog covers all Uzbek keys and keeps interpolation placeholders intact", () => {
  const flatten = (value: any, prefix = ""): Record<string, string> => Object.assign({}, ...Object.entries(value).map(([key, item]) =>
    typeof item === "string" ? { [prefix + key]: item } : flatten(item, `${prefix}${key}.`)));
  const left = flatten(uz), right = flatten(ru);
  assert.deepEqual(Object.keys(left).sort(), Object.keys(right).sort());
  for (const [key, text] of Object.entries(left)) {
    assert.ok(right[key].trim(), key);
    assert.deepEqual((text.match(/\{\w+\}/g) ?? []).sort(), (right[key].match(/\{\w+\}/g) ?? []).sort(), key);
  }
  assert.equal(languageOf("ru-RU"), "ru"); assert.equal(languageOf("en"), "uz");
});

test("concurrent asynchronous updates never mix user languages, including errors and switching", async () => {
  await Promise.all([withLanguage("ru", async () => { await setImmediate(); assert.equal(t("menu.groups"), "Группы"); changeLanguage("uz"); await setImmediate(); assert.equal(t("menu.groups"), "Guruhlar"); }),
    withLanguage("ru", async () => { await setImmediate(); await setImmediate(); assert.equal(t("menu.groups"), "Группы"); }),
    withLanguage("uz", async () => { try { await setImmediate(); throw new Error("test"); } catch { assert.equal(t("common.error"), uz.common.error); } })]);
  assert.equal(t("menu.groups"), "Guruhlar");
});

test("bot persists language across restarts, keeps drafts, handles both menu languages and localizes account links and errors", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    const accounts = new Accounts(config, { async execute() { throw new Error("No real Telegram"); } });
    const messages: any[] = [];
    const makeBot = async () => {
      const bot = createBot(config, database, accounts, new Groups(accounts), { run: async () => {} } as any);
      bot.api.config.use(async (_previous, method, payload: any) => {
        messages.push({ method, ...payload });
        if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot" } } as any;
        return { ok: true, result: { message_id: messages.length, date: 0, chat: { id: payload.chat_id ?? 101, type: "private" }, text: payload.text ?? "" } } as any;
      });
      await bot.init(); return bot;
    };
    let bot = await makeBot(), id = 0;
    const sender = (owner: number) => ({ id: owner, first_name: "User", is_bot: false, language_code: "ru" });
    const message = (text: string, owner = 101) => bot.handleUpdate({ update_id: ++id, message: { message_id: id, date: 0, from: sender(owner), chat: { id: owner, type: "private" }, text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}) } } as any);
    const callback = (data: string, owner = 101) => bot.handleUpdate({ update_id: ++id, callback_query: { id: String(id), from: sender(owner), data, chat_instance: "one", message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu" } } } as any);
    const lastText = () => messages.filter(m => typeof m.text === "string").at(-1);
    const assertMainMenu = (catalog: typeof ru) => {
      const labels = lastText().reply_markup.keyboard.flat().map((b: any) => b.text);
      assert.ok(labels.includes(catalog.menu.settings));
      for (const key of ["account", "tariff", "language"] as const) assert.ok(!labels.includes(catalog.menu[key]));
    };
    await callback("ann:create");
    const draft = (await one(database, "SELECT data FROM user_states WHERE user_id=1")).data;
    await message(uz.menu.settings); assert.equal(lastText().text, uz.settings.prompt);
    assert.deepEqual(lastText().reply_markup.inline_keyboard.flat().map((b: any) => b.text),
      [uz.menu.account, uz.menu.tariff, uz.menu.language, uz.common.back]);
    await callback("settings:account"); assert.equal(lastText().text, uz.account.disconnect_prompt);
    assert.equal(lastText().reply_markup.inline_keyboard.at(-1)[0].callback_data, "settings:open");
    await callback("settings:open"); assert.equal(lastText().text, uz.settings.prompt);
    await callback("settings:tariff"); assert.match(lastText().text, /Pullik tarif/);
    assert.equal(lastText().reply_markup.inline_keyboard.at(-1)[0].callback_data, "settings:open");
    await callback("settings:open"); await callback("settings:language");
    assert.equal(lastText().text, ru.language.choose);
    assert.equal(lastText().reply_markup.inline_keyboard.at(-1)[0].callback_data, "settings:open");
    await callback("language:ru");
    assert.equal((await one(database, "SELECT language FROM users WHERE id=1")).language, "ru");
    assert.deepEqual((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data, draft);
    assert.equal(lastText().text, ru.language.saved);
    assert.ok(lastText().reply_markup.keyboard.flat().some((b: any) => b.text === "Мои объявления"));
    assert.equal(lastText().reply_markup.is_persistent, true);
    assert.equal(lastText().reply_markup.keyboard.flat().find((b: any) => b.text === ru.menu.help).web_app.url, config.baseUrl + "/help?lang=ru");
    assertMainMenu(ru);
    assert.ok(botCommands("ru").some(c => c.command === "help" && c.description === ru.menu.help));
    for (const catalog of [ru, uz]) {
      const commands = botCommands(catalog === ru ? "ru" : "uz");
      assert.ok(commands.some(c => c.command === "settings" && c.description === catalog.menu.settings));
      assert.ok(!commands.some(c => ["account", "tariff", "language"].includes(c.command)));
    }
    await message("/settings"); assert.equal(lastText().text, ru.settings.prompt);
    assert.deepEqual(lastText().reply_markup.inline_keyboard.flat().map((b: any) => b.text),
      [ru.menu.account, ru.menu.tariff, ru.menu.language, ru.common.back]);
    await callback("menu:main"); assert.equal(lastText().text, ru.start.choose_section); assertMainMenu(ru);
    assert.deepEqual((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data, draft);
    await message("/help"); assert.equal(lastText().text, ru.help.prompt);
    assert.equal(lastText().reply_markup.inline_keyboard[0][0].web_app.url, config.baseUrl + "/help?lang=ru");
    assert.deepEqual((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data, draft);
    await message("Original announcement content");
    assert.equal(lastText().text, t("announcements.select_groups", { count: 0, limit: 30 }, "ru"));
    await callback("ann:group:1"); await callback("ann:groups_done");
    assert.equal(lastText().reply_markup.inline_keyboard[0][0].text, "5 мин.");
    await callback("ann:interval:5"); assert.equal(lastText().text, ru.announcements.window_start);
    await message("7"); assert.match(lastText().text, /Начало: 07:00/);
    await message("25:00"); assert.equal(lastText().text, ru.announcements.clock_invalid);
    bot = await makeBot(); await message("22"); assert.equal(lastText().text, ru.announcements.select_first_run);
    await callback("ann:first:scheduled"); assert.equal(lastText().text, ru.announcements.save_template);
    await callback("ann:save_template:no");
    assert.match(lastText().text, /Проверьте объявление/); assert.match(lastText().text, /Original announcement content/);
    await callback("ann:confirm"); assert.match(lastText().text, /Объявление создано/);
    await message("Guruhlar"); assert.equal(lastText().text, "Группы", "Old Uzbek reply-keyboard buttons remain usable");
    await message("Мои объявления"); assert.equal(lastText().text, ru.announcements.title);
    await message("/tariff", 202); assert.match(lastText().text, /Pullik tarif/);
    assert.equal((await one(database, "SELECT language FROM users WHERE id=2")).language, "uz", "Telegram locale must not overwrite an existing choice");
    const mini = new MiniApp(config, database, new Groups(accounts));
    assert.equal((await mini.handle("GET", "/api/state", { id: 101, first_name: "User" }) as any).language, "ru");
    await database.query("DELETE FROM telegram_accounts WHERE user_id=1");
    await message(ru.menu.help); assert.equal(lastText().text, ru.help.prompt);
    await callback("account:connect"); assert.match(lastText().reply_markup.inline_keyboard[0][0].url, /\/account\?lang=ru#/);
    await callback("ann:create"); assert.equal(lastText().text, ru.account.connect_prompt);
    await callback("language:invalid"); assert.equal(lastText().text, ru.common.not_found);
    await callback("language:uz");
    assert.equal(lastText().reply_markup.keyboard.flat().find((b: any) => b.text === uz.menu.help).web_app.url, config.baseUrl + "/help?lang=uz");
    assertMainMenu(uz);
    await message("Группы"); assert.equal(lastText().text, "Guruhlar");
    await message("/start", 303); assert.equal(lastText().text, ru.account.connect_prompt);
    assert.equal((await one(database, "SELECT language FROM users WHERE telegram_id=303")).language, "ru");
  } finally { await pg.close(); }
});

test("background delivery notices and administrator replies use each recipient's saved language", async () => {
  const { pg, database } = await testDatabase(); const sent: any[] = [];
  const api = { async sendMessage(chatId: string, text: string, options: any) { sent.push({ chatId, text, options }); return { message_id: sent.length }; } } as any;
  try {
    await seed(database); await database.query("UPDATE users SET language='ru' WHERE id=1");
    const support = new Support(database, config, api);
    await withLanguage("uz", () => support.reply("1", "101", { text: "Текст администратора", requestId: randomUUID() }));
    assert.equal(sent.at(-1).text, "✉️ Ответ администратора:\n\nТекст администратора");
    assert.equal(sent.at(-1).options.reply_markup.inline_keyboard[0][0].text, ru.support.answer);
    await withLanguage("ru", () => support.reply("2", "101", { text: "Original answer", requestId: randomUUID() }));
    assert.match(sent.at(-1).text, /Admin javobi/);
    await announcement(database, "1", ["1"]); await announcement(database, "2", ["1"]);
    const accounts = new Accounts(config, { async execute() { throw new Failure("CHAT_WRITE_FORBIDDEN"); } });
    const delivery = new Delivery(database, config, accounts, api);
    await withLanguage("ru", () => delivery.run());
    assert.equal(sent.find(s => s.text === ru.delivery.group_access_lost)?.chatId, "101");
    assert.equal(sent.find(s => s.text === uz.delivery.group_access_lost)?.chatId, "202");
  } finally { await pg.close(); }
});
