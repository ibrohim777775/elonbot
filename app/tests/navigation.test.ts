import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { createBot } from "../bot";
import { Database, one } from "../db";
import { Groups } from "../groups";
import { t } from "../i18n";
import { botCommands } from "../commands";
import { announcement, config, seed, testDatabase } from "./helpers";

async function harness(database: Database) {
  const sent: any[] = []; let updateId = 0, runs = 0;
  const accounts = new Accounts(config, { async execute() { throw new Error("No Telegram requests expected"); } });
  const makeBot = async () => {
    const bot = createBot(config, database, accounts, new Groups(accounts), { async run() { runs++; } } as any);
    bot.api.config.use(async (_previous, method, payload: any) => {
      sent.push({ method, ...payload });
      if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot", username: "test_bot" } } as any;
      return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
    });
    await bot.init(); return bot;
  };
  let bot = await makeBot();
  const callback = (data: string, owner = 101) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: String(updateId), from: { id: owner, is_bot: false, first_name: "User" }, data, chat_instance: "one",
    message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu" },
  } } as any);
  const last = () => sent.filter(s => s.text).at(-1);
  const buttons = () => last().reply_markup.inline_keyboard.flat();
  return {
    callback, last, buttons, runs: () => runs,
    restart: async () => { bot = await makeBot(); },
    draft: async () => (await one(database, "SELECT data FROM user_states WHERE user_id=1")).data,
    back: async () => {
      const back = buttons().find((b: any) => /(?:Назад|Orqaga)$/.test(b.text));
      assert.ok(back, "The current screen must have a back button");
      await callback(back.callback_data);
    },
    message: (fields: string | object) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 0, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "User" },
      ...(typeof fields === "string" ? { text: fields, ...(fields.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: fields.length }] } : {}) } : fields),
    } } as any),
  };
}

test("back buttons and /back preserve an album draft through every creation step and restart", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await database.query("UPDATE users SET paid_until=NULL,language='ru' WHERE id=1");
    const h = await harness(database);
    await h.callback("ann:create");
    for (const id of ["photo-one", "photo-two"]) await h.message({ forward_origin: { type: "hidden_user", sender_user_name: "Source", date: 0 },
      photo: [{ file_id: id, file_unique_id: id, width: 100, height: 100 }], ...(id === "photo-one" ? { caption: "Saved album" } : {}) });
    await h.back(); assert.equal((await h.draft()).step, "content");
    await h.callback("ann:content_done");
    await h.callback("ann:group:1"); await h.callback("ann:group:2"); await h.callback("ann:groups_done");
    await h.back(); assert.deepEqual((await h.draft()).groups, ["1", "2"]);
    await h.callback("ann:groups_done"); await h.callback("ann:interval:20");
    await h.callback("ann:clock:start:manual"); await h.back();
    assert.equal((await h.draft()).step, "window_start"); assert.equal((await h.draft()).clockManual, undefined);
    await h.callback("ann:clock:start:420"); await h.callback("ann:clock:end:1320");
    await h.callback("ann:first:scheduled"); await h.callback("ann:save_template:yes");
    await h.restart(); await h.back(); assert.equal((await h.draft()).step, "save_template");
    await h.callback("ann:save_template:no"); await h.message("/back");
    for (const step of ["first_run", "window_end", "window_start", "interval", "groups", "content"]) {
      await h.back(); assert.equal((await h.draft()).step, step);
    }
    await h.message("Назад"); assert.equal((await h.draft()).step, "draft");
    assert.ok(h.buttons().some((b: any) => b.callback_data === "wizard:resume"));
    await h.back(); assert.equal(h.last().text, t("start.choose_section", {}, "ru"));
    await h.message("Мои объявления"); await h.callback("wizard:resume");
    const draft = await h.draft();
    assert.equal(draft.text, "Saved album"); assert.deepEqual(draft.photoMessageIds, [2, 3]); assert.equal(draft.photos, undefined);
    assert.deepEqual(draft.groups, ["1", "2"]); assert.equal(draft.interval, 20);
    assert.equal(draft.send_start_minute, 420); assert.equal(draft.send_end_minute, 1320);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 0);
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    assert.equal(h.runs(), 0);
    await h.callback("ann:content_done"); await h.callback("ann:groups_done"); await h.callback("ann:interval:20");
    await h.callback("ann:window:all"); await h.callback("ann:first:scheduled");
    await h.callback("wizard:back:interval"); // An old message cannot move a different current step.
    assert.equal((await h.draft()).step, "confirm");
    await h.callback("ann:confirm");
    const ad = await one(database, "SELECT * FROM announcements");
    assert.equal(ad.text, "Saved album"); assert.deepEqual(ad.photo_message_ids, draft.photoMessageIds); assert.deepEqual(ad.photo_file_ids, []);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 0);
    assert.ok((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at);
  } finally { await pg.close(); }
});

test("back cancels edits without changing saved announcements and works in empty lists and support", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    const saved = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    const h = await harness(database);
    for (const field of ["text", "photo", "contact", "name", "groups", "interval", "window"]) {
      await h.callback(`ann:edit_${field}:${id}`); await h.back();
      assert.equal((await h.draft()).step, "edit_menu");
      await h.back(); assert.deepEqual(await h.draft(), {});
    }
    await h.callback(`ann:edit_window:${id}`); await h.callback("ann:clock:start:420");
    await h.back(); assert.equal((await h.draft()).step, "window_start");
    await h.back(); await h.back();
    assert.deepEqual(await one(database, "SELECT * FROM announcements WHERE id=$1", [id]), saved);
    await h.callback(`ann:edit:${id}`, 202); assert.equal(h.last().text, t("common.not_found"));
    await h.callback("templates:list"); await h.back(); assert.equal(h.last().text, t("start.choose_section"));
    await h.callback("support:open"); await h.message("Orqaga");
    assert.equal((await h.draft()).support, undefined);
    assert.equal((await one(database, "SELECT count(*)::int n FROM support_messages")).n, 0);
    await database.query("UPDATE user_groups SET can_post=false WHERE user_id=1");
    await h.callback("ann:create"); await h.message("Keep without groups");
    assert.equal(h.last().text, t("announcements.no_groups"));
    await h.back(); assert.equal((await h.draft()).step, "content");
    assert.equal((await h.draft()).text, "Keep without groups");
    await h.message("/cancel"); assert.deepEqual(await h.draft(), {});
    await h.message("/back"); assert.equal(h.last().text, t("start.choose_section"));
    for (const language of ["ru", "uz"] as const) {
      assert.ok(botCommands(language).some(c => c.command === "back"));
      assert.ok(botCommands(language).some(c => c.command === "cancel"));
    }
  } finally { await pg.close(); }
});

test("back from template selection and launch preserves source templates without creating announcements", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const h = await harness(database);
    await h.callback("ann:create"); await h.callback("ann:create:template");
    await h.back(); assert.equal((await h.draft()).step, "content");
    await h.callback("templates:create"); await h.message("Template content");
    await h.callback("ann:group:1"); await h.callback("ann:groups_done"); await h.callback("ann:interval:5");
    await h.callback("ann:window:all"); await h.callback("ann:first:scheduled");
    await h.back(); assert.equal((await h.draft()).step, "first_run");
    await h.callback("templates:save"); assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 0);
    await h.callback("ann:first:scheduled"); await h.callback("templates:save");
    const template = await one(database, "SELECT * FROM templates");
    await h.callback(`templates:use:${template.id}`); await h.restart(); await h.back();
    assert.deepEqual(await h.draft(), {});
    assert.deepEqual(await one(database, "SELECT * FROM templates"), template);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    assert.equal(h.runs(), 0);
  } finally { await pg.close(); }
});
