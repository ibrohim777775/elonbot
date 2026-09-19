import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { createBot } from "../bot";
import { Database, one } from "../db";
import { Delivery } from "../delivery";
import { Groups } from "../groups";
import { t } from "../i18n";
import { MiniApp } from "../miniapp";
import { announcement, config, seed, testDatabase } from "./helpers";

test("full album wizard, persistent state, duplicate updates, editing and ownership", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    const accounts = new Accounts(config, { async execute() { throw new Error("Unexpected real-account operation"); } });
    const sent: any[] = [];
    const delivery = { run: async () => {}, removePublished: async () => 0 } as unknown as Delivery;
    const makeBot = async () => {
      const bot = createBot(config, database, accounts, new Groups(accounts), delivery);
      bot.api.config.use(async (_previous, method, payload: any) => {
        sent.push({ method, ...payload });
        if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Elonbot", username: "elonbot_test" } } as any;
        return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
      });
      await bot.init(); return bot;
    };
    let bot = await makeBot(); let updateId = 0;
    const sender = (id = 101) => ({ id, is_bot: false, first_name: "User" });
    const callback = async (data: string, owner = 101) => {
      const update = { update_id: ++updateId, callback_query: { id: String(updateId), from: sender(owner), data, chat_instance: "one",
        message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu", from: { id: 123456789, is_bot: true, first_name: "Bot" } } } };
      await bot.handleUpdate(update as any); return update;
    };
    const message = async (fields: any) => {
      await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 0, chat: { id: 101, type: "private" }, from: sender(), ...fields } } as any);
    };
    await callback("ann:create");
    for (let i = 0; i < 4; i++) await message({ photo: [{ file_id: `photo-${i}`, file_unique_id: String(i), width: 100, height: 100 }], ...(i === 0 ? { caption: "Saved album" } : {}) });
    // Rebuild the bot half way through; draft comes from PostgreSQL.
    bot = await makeBot();
    await callback("ann:photos_done"); await callback("ann:group:1"); await callback("ann:groups_done");
    await callback("ann:interval:5"); await callback("ann:window:420:1320");
    assert.equal(sent.at(-1).text, t("announcements.select_first_run"));
    await callback("ann:first:scheduled"); await callback("ann:save_template:yes");
    const confirm = await callback("ann:confirm"); await bot.handleUpdate(confirm as any);
    const a = await one(database, "SELECT * FROM announcements");
    assert.equal(a.text, "Saved album"); assert.equal(a.interval_minutes, 5); assert.ok(a.next_run_at > new Date());
    assert.deepEqual(a.photo_file_ids, ["photo-0", "photo-1", "photo-2", "photo-3"]);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 1);
    assert.deepEqual((await one(database, "SELECT photo_file_ids FROM templates")).photo_file_ids, a.photo_file_ids);
    assert.ok(sent.filter(s => ["sendMessage", "sendPhoto", "editMessageText"].includes(s.method)).every(s => Number(s.chat_id) > 0));
    await callback(`ann:edit_text:${a.id}`, 202);
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=2")).data.editId, undefined);
    await callback(`ann:edit_text:${a.id}`); await message({ text: "Edited text" });
    assert.equal((await one(database, "SELECT text FROM announcements")).text, "Edited text");
    const template = await one(database, "SELECT * FROM templates");
    assert.equal(template.interval_minutes, 5); assert.equal(template.first_run_mode, "scheduled");
    assert.equal(template.send_start_minute, 420); assert.equal(template.send_end_minute, 1320);
    assert.deepEqual((await database.query("SELECT group_id FROM template_groups WHERE template_id=$1", [template.id])).rows.map(g => String(g.group_id)), ["1"]);
    const beforeReuse = sent.length;
    await callback("ann:create"); await callback("ann:create:template"); await callback(`ann:template:${template.id}`);
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.step, "confirm");
    assert.match(sent.at(-1).text, /Group one \(-100123\)/);
    assert.ok(!sent.slice(beforeReuse).some(s => s.text === t("announcements.save_template")));
    bot = await makeBot(); // Template settings must survive a restart with the draft.
    await callback("ann:confirm");
    const reused = await one(database, "SELECT * FROM announcements WHERE id<>$1", [a.id]);
    assert.equal(reused.text, "Saved album"); assert.deepEqual(reused.photo_file_ids, a.photo_file_ids);
    assert.equal(reused.interval_minutes, template.interval_minutes); assert.equal(reused.first_run_mode, template.first_run_mode);
    assert.equal(reused.send_start_minute, template.send_start_minute); assert.equal(reused.send_end_minute, template.send_end_minute);
    assert.deepEqual((await database.query("SELECT group_id FROM announcement_groups WHERE announcement_id=$1", [reused.id])).rows.map(g => String(g.group_id)), ["1"]);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 1);
    await callback(`templates:show:${template.id}`);
    assert.deepEqual(sent.at(-1).reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data),
      [`templates:use:${template.id}`, `templates:delete:${template.id}`, "templates:list"]);
    for (const action of ["edit_text", "edit_photo", "remove_photo", "edit_contact", "edit_name", "settings"]) {
      await callback(`templates:${action}:${template.id}`);
      assert.equal(sent.at(-1).text, t("common.not_found"));
    }
    // A pending edit from an older release cannot update the saved template after restart.
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify({ table: "templates", editId: String(template.id), step: "edit_photo" })]);
    bot = await makeBot();
    await message({ photo: [{ file_id: "replacement", file_unique_id: "replacement", width: 100, height: 100 }], caption: "Changed caption" });
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify({ kind: "template", templateId: String(template.id), step: "confirm", text: "Changed template", groups: ["2"], interval: 60, mode: "immediate" })]);
    await callback("templates:save");
    assert.deepEqual(await one(database, "SELECT * FROM templates WHERE id=$1", [template.id]), template);
    assert.deepEqual((await database.query("SELECT group_id FROM template_groups WHERE template_id=$1", [template.id])).rows.map(g => String(g.group_id)), ["1"]);
    // A subsequent original announcement still offers saving a new template.
    await callback("ann:create"); await message({ text: "New original announcement" });
    await callback("ann:group:1"); await callback("ann:groups_done"); await callback("ann:interval:5"); await callback("ann:window:all");
    await callback("ann:first:immediate");
    assert.equal(sent.at(-1).text, t("announcements.save_template"));
    // All menu entries are still Uzbek, plus account management.
    assert.equal(t("menu.announcements"), "E'lonlarim");
    assert.equal(t("menu.account"), "Telegram akkaunt");
  } finally { await pg.close(); }
});

test("announcement window is saved through the bot, resumes drafts, validates edits and isolates owners", async context => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-01T18:00:00Z") }); // 23:00 Tashkent
    const accounts = new Accounts(config, { async execute() { throw new Error("No real Telegram calls"); } });
    const sent: any[] = [];
    const makeBot = async () => {
      const bot = createBot(config, database, accounts, new Groups(accounts), { run: async () => {} } as any);
      bot.api.config.use(async (_previous, method, payload: any) => {
        sent.push({ method, ...payload });
        if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot" } } as any;
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
      });
      await bot.init(); return bot;
    };
    let bot = await makeBot(), updateId = 0;
    const callback = (data: string, owner = 101) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), from: { id: owner, is_bot: false, first_name: "User" }, data, chat_instance: "one",
      message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu" },
    } } as any);
    const message = (text: string) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 0, from: { id: 101, is_bot: false, first_name: "User" }, chat: { id: 101, type: "private" }, text,
    } } as any);
    await callback("ann:create"); await message("Daily announcement");
    await callback("ann:group:1"); await callback("ann:groups_done"); await callback("ann:interval:5");
    assert.equal(sent.at(-1).text, t("announcements.window_start", { start: "00:00" }));
    await callback("ann:clock:start:manual"); await message("25:00");
    assert.equal(sent.at(-1).text, t("announcements.clock_invalid"));
    await callback("ann:clock:start:420");
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.step, "window_end");
    await callback("ann:clock:back"); await message("7");
    await callback("ann:clock:end:manual"); await message("22:00"); bot = await makeBot();
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.send_start_minute, 420);
    await callback("ann:first:immediate"); await callback("ann:save_template:no");
    assert.match(sent.at(-1).text, /07:00–22:00/);
    await callback("ann:confirm");
    const a = await one(database, "SELECT * FROM announcements WHERE user_id=1");
    assert.equal(a.send_start_minute, 420); assert.equal(a.send_end_minute, 1320);
    assert.equal(a.next_run_at.toISOString(), "2030-06-02T02:00:00.000Z");
    await callback(`ann:edit_window:${a.id}`, 202); await callback("ann:window:all", 202);
    assert.equal((await one(database, "SELECT send_end_minute FROM announcements WHERE id=$1", [a.id])).send_end_minute, 1320);
    await callback(`ann:edit_window:${a.id}`); await callback("ann:window:custom"); await message("22:15-07:30");
    assert.match(sent.at(-1).text, /22:15–07:30/);
    assert.equal((await one(database, "SELECT send_start_minute FROM announcements WHERE id=$1", [a.id])).send_start_minute, 1335);
    await callback(`ann:edit_window:${a.id}`); await callback("ann:window:all");
    const edited = await one(database, "SELECT * FROM announcements WHERE id=$1", [a.id]);
    assert.equal(edited.send_start_minute, null); assert.equal(edited.send_end_minute, null);
    assert.equal(edited.text, "Daily announcement"); assert.equal(edited.interval_minutes, 5);
  } finally { context.mock.timers.reset(); await pg.close(); }
});

test("menus stay available during delivery; callback is acknowledged before waiting to delete", { timeout: 30_000 }, async () => {
  const { pg, database } = await testDatabase();
  let releaseDelivery!: () => void, reachedLock!: () => void;
  const released = new Promise<void>(resolve => { releaseDelivery = resolve; });
  const waiting = new Promise<void>(resolve => { reachedLock = resolve; });
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]);
    const events: string[] = []; let requireDeliveryLock = false;
    const observed: Database = { ...database, transaction: fn => database.transaction(db => fn({
      async query(sql, values) {
        events.push("query");
        if (values?.[0] === "elonbot:user:1") {
          assert.ok(requireDeliveryLock, "Viewing menus must not wait for the account's delivery lock");
          events.push("waiting_for_delivery"); reachedLock(); await released;
        }
        return db.query(sql, values);
      },
    })) };
    const accounts = new Accounts(config, { async execute() { throw new Error("Menus must not access the user account API"); } });
    const bot = createBot(config, observed, accounts, new Groups(accounts), { run: async () => {} } as any);
    const messages: any[] = [];
    bot.api.config.use(async (_previous, method, payload: any) => {
      events.push(method); messages.push({ method, ...payload });
      if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot" } } as any;
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
    });
    await bot.init(); let updateId = 0;
    const callback = (data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), from: { id: 101, is_bot: false, first_name: "User" }, data, chat_instance: "one",
      message: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: "Menu" },
    } } as any);
    for (const action of ["groups:list", "groups:show:1", "ann:list", "templates:list", "ann:create"]) {
      events.length = 0;
      await callback(action);
      assert.equal(events[0], "answerCallbackQuery");
      assert.ok(messages.some(m => m.method === "editMessageText"));
    }
    requireDeliveryLock = true; events.length = 0;
    const deletion = callback(`ann:delete_confirm:${id}`);
    await waiting;
    assert.equal(events[0], "answerCallbackQuery");
    assert.ok(!events.includes("editMessageText"), "Deletion is not confirmed until the current delivery finishes");
    releaseDelivery(); await deletion;
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "deleted");
  } finally { releaseDelivery(); await pg.close(); }
});

test("bot opens the group-only Mini App without Telegram requests and resumes the announcement draft", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); let calls = 0;
    const accounts = new Accounts(config, { async execute(method) {
      assert.equal(method, "groups"); calls++;
      return { groups: [123, 456, 789].map(id => ({ chatId: `-100${id}`, title: `Group ${id}`, chatType: "supergroup",
        canPost: true, isAdmin: false, accessHash: String(id) })) };
    } });
    const sent: any[] = [];
    const bot = createBot(config, database, accounts, new Groups(accounts), { run: async () => {} } as any);
    bot.api.config.use(async (_previous, method, payload: any) => {
      sent.push({ method, ...payload });
      if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot" } } as any;
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
    });
    await bot.init(); let updateId = 0;
    const from = { id: 101, is_bot: false, first_name: "User" };
    const callback = (data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), from, data, chat_instance: "one",
      message: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: "Menu" },
    } } as any);
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: 1, date: 0,
      from, chat: { id: 101, type: "private" }, text: t("menu.groups") } } as any);
    assert.equal(calls, 0);
    const draft = { kind: "announcement", step: "groups", text: "Keep this draft", photos: ["photo-1"], groups: ["1"] };
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify(draft)]);
    await callback("groups:add"); await callback("groups:refresh");
    assert.equal(calls, 0);
    const keyboard = sent.at(-1).reply_markup.inline_keyboard;
    assert.equal(keyboard[0][0].web_app.url, config.baseUrl + "/app");
    assert.equal(keyboard[1][0].callback_data, "groups:continue");
    assert.deepEqual((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data, draft);
    const mini = new MiniApp(config, database, new Groups(accounts));
    await mini.handle("POST", "/api/groups/connect", { id: 101, first_name: "User" }, { chatId: "-100789" });
    await callback("groups:continue");
    assert.equal(calls, 1);
    assert.equal(sent.at(-1).text, t("announcements.select_groups", { count: 1, limit: 30 }));
    assert.ok(sent.at(-1).reply_markup.inline_keyboard.flat().some((b: any) => b.text === "Group 789"));
    assert.deepEqual((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data, { ...draft, groupPage: 0 });
    await database.query("UPDATE user_states SET data='{}' WHERE user_id=1");
    await callback("groups:continue"); assert.equal(sent.at(-1).text, t("groups.title"));
  } finally { await pg.close(); }
});
