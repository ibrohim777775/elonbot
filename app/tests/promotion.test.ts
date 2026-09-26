import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Accounts } from "../accounts";
import { Admin } from "../admin";
import { createBot } from "../bot";
import { messageLength, renderText } from "../content";
import { Database, one } from "../db";
import { Delivery } from "../delivery";
import { Groups } from "../groups";
import { migrate } from "../migrate";
import { acceptPromotion, enrollment, promotionOffer, promotionSettings, savePromotionSettings } from "../promotion";
import { Support } from "../support";
import { Failure } from "../telegram";
import { addGroups, announcement, config, seed, testDatabase } from "./helpers";

const join = (db: Database, user = "1", language: "ru" | "uz" = "uz", revision = 1) =>
  db.transaction(tx => acceptPromotion(tx, user, language, "elonbot_test", revision));
async function prepare(db: Database) {
  await seed(db); await db.query("UPDATE users SET paid_until=NULL");
}
async function client(database: Database) {
  const accounts = new Accounts(config, { async execute() { throw new Error("No live Telegram"); } });
  const bot = createBot(config, database, accounts, new Groups(accounts), { async run() {} } as any), messages: any[] = [];
  bot.api.config.use(async (_, method, payload: any) => {
    messages.push({ method, ...payload });
    return { ok: true, result: method === "getMe" ? { id: 123456789, is_bot: true, first_name: "Bot", username: "elonbot_test" }
      : { message_id: 500, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
  });
  await bot.init(); let updateId = 2000;
  const callback = (data: string, owner = 101) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: String(updateId), from: { id: owner, is_bot: false, first_name: "User" }, data, chat_instance: "one",
    message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu" },
  } } as any);
  return { callback, messages, bot };
}

test("promotion requires explicit consent, replaces the remaining trial, and is immutable and one-time", async () => {
  const { pg, database } = await testDatabase();
  try {
    await prepare(database);
    const ui = await client(database), draft = { kind: "announcement", step: "content", text: "My draft" };
    await database.query("INSERT INTO user_states(user_id,data) VALUES(1,$1)", [JSON.stringify(draft)]);
    await ui.callback("settings:tariff");
    assert.match(ui.messages.at(-1).text, /https:\/\/t.me\/elonbot_test/);
    assert.match(ui.messages.at(-1).text, /100/);
    assert.equal(await enrollment(database, "1"), undefined);
    await ui.callback("promo:decline");
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    const original = await promotionSettings(database);
    await savePromotionSettings(database, "101", { ...original, text_uz: "Yangi yozuv", text_ru: "Новая подпись" });
    await ui.callback("promo:accept:1:uz"); // Outdated button must display fresh terms first.
    assert.equal(await enrollment(database, "1"), undefined);
    assert.match(ui.messages.at(-1).text, /Yangi yozuv/);
    await ui.callback("language:ru"); await ui.callback("promo:accept:2:uz");
    assert.equal(await enrollment(database, "1"), undefined);
    assert.match(ui.messages.at(-1).text, /Новая подпись/);
    await database.query("UPDATE users SET trial_started_at=now()-interval '3 days',trial_ends_at=now()+interval '4 days' WHERE id=1");
    await ui.callback("promo:accept:2:ru");
    const accepted = await enrollment(database, "1");
    assert.equal(accepted.ends_at.getTime() - accepted.accepted_at.getTime(), 30 * 86400000);
    assert.equal(accepted.footer, "Новая подпись\nhttps://t.me/elonbot_test");
    assert.equal((await one(database, "SELECT trial_ends_at FROM users WHERE id=1")).trial_ends_at.getTime(), accepted.ends_at.getTime());
    assert.deepEqual((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data, draft);
    await ui.callback("promo:accept:2:ru");
    assert.deepEqual(await enrollment(database, "1"), accepted);
    await ui.callback("promo:decline");
    assert.deepEqual(await enrollment(database, "1"), accepted);
    assert.match(ui.messages.at(-1).text, /Вы подключили бесплатный месяц/);
    await migrate(database); await migrate(database);
    assert.deepEqual(await enrollment(database, "1"), accepted);
    assert.equal((await promotionSettings(database)).text_ru, "Новая подпись");
  } finally { await pg.close(); }
});

test("offer is shown after first language selection, but never activated by onboarding", async () => {
  const { pg, database } = await testDatabase();
  try {
    const ui = await client(database);
    await ui.callback("menu:main"); // First interaction shows language selection only.
    assert.equal((await one(database, "SELECT count(*)::int n FROM promotion_enrollments")).n, 0);
    await ui.callback("welcome_language:uz");
    assert.match(ui.messages.at(-1).text, /Birinchi oy bepul/);
    assert.equal(ui.messages.at(-1).reply_markup.inline_keyboard[0][0].callback_data, "promo:accept:1:uz");
    assert.equal((await one(database, "SELECT trial_started_at FROM users")).trial_started_at, null);
  } finally { await pg.close(); }
});

test("paid history, expired first month and disabled offers are ineligible; settings require admin and fresh revision", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    assert.equal(await promotionOffer(database, "1", "ru", "elonbot_test"), null);
    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=now()-interval '31 days',trial_ends_at=now()-interval '24 days' WHERE id=1");
    await assert.rejects(join(database), { code: "PROMOTION_INELIGIBLE" });
    await database.query("UPDATE users SET trial_started_at=NULL,trial_ends_at=NULL WHERE id=1");
    await database.query(`INSERT INTO tariff_events(user_id,admin_telegram_id,request_id,action,amount_sum)
      VALUES(1,101,$1,'activate',20000)`, [randomUUID()]);
    await assert.rejects(join(database), { code: "PROMOTION_INELIGIBLE" });
    const api = { async getMe() { return { username: "elonbot_test" }; } } as any;
    const admin = new Admin(config, database, new Support(database, config, api), api), identity = { id: 101, first_name: "Admin" };
    const settings = await admin.handle("GET", "/admin-api/promotion", identity, {});
    assert.equal(settings.bot_username, "elonbot_test");
    await assert.rejects(admin.handle("POST", "/admin-api/promotion", { ...identity, id: 202 }, settings), { code: "FORBIDDEN" });
    await assert.rejects(admin.handle("POST", "/admin-api/promotion", identity, { ...settings, text_ru: " " }), { code: "INVALID_REQUEST" });
    await assert.rejects(admin.handle("POST", "/admin-api/promotion", identity, { ...settings, text_ru: "x".repeat(501) }), { code: "INVALID_REQUEST" });
    await admin.handle("POST", "/admin-api/promotion", identity, { ...settings, enabled: false });
    await assert.rejects(admin.handle("POST", "/admin-api/promotion", identity, settings), { code: "CONFLICT" });
    await database.query("UPDATE users SET paid_until=NULL WHERE id=2");
    assert.equal(await promotionOffer(database, "2", "uz", "elonbot_test"), null);
    await assert.rejects(join(database, "2", "uz", 2), { code: "PROMOTION_CHANGED" });
  } finally { await pg.close(); }
});

test("exactly the first 100 successful group publications get a footer across announcements; deletion does not reset it", async () => {
  const { pg, database } = await testDatabase();
  try {
    await prepare(database); const consent = await join(database);
    const ids = (await addGroups(database, 100)).slice(0, 101);
    for (let i = 0; i < ids.length; i += 30) await announcement(database, "1", ids.slice(i, i + 30));
    const calls: any[] = [], accounts = new Accounts(config, { async execute(method, params) {
      assert.equal(method, "send"); calls.push(params); return { messageIds: [calls.length] };
    } });
    const delivery = new Delivery(database, { ...config, maxMessages: 1000, maxChatMessages: 1000 }, accounts, {} as any);
    await delivery.run();
    assert.equal(calls.length, 101);
    assert.equal(calls.filter(call => call.text.endsWith(consent.footer)).length, 100);
    assert.equal(calls[100].text, "Hello &lt;world&gt;");
    assert.equal((await enrollment(database, "1")).sent_count, 100);
    assert.ok((await database.query("SELECT text FROM announcements")).rows.every(row => row.text === "Hello <world>"));
    await delivery.run(); assert.equal(calls.length, 101);
    await database.query("DELETE FROM announcements WHERE user_id=1");
    await announcement(database, "1", ["1"]); await delivery.run();
    assert.equal(calls.at(-1).text, "Hello &lt;world&gt;");
    assert.equal((await enrollment(database, "1")).sent_count, 100);
  } finally { await pg.close(); }
});

test("partial album reserves the last signature, retries keep consented text after expiry and renewal, and count once", async () => {
  const { pg, database } = await testDatabase();
  try {
    await prepare(database); const consent = await join(database);
    await database.query("UPDATE promotion_enrollments SET sent_count=99 WHERE user_id=1");
    const first = await announcement(database, "1", ["1"]), second = await announcement(database, "1", ["2"]);
    await database.query("UPDATE announcements SET text=$2,photo_message_ids='[10,11]' WHERE id=$1", [first, "x".repeat(1100)]);
    const calls: any[] = []; let interrupted = true;
    const accounts = new Accounts(config, { async execute(method, params) {
      if (method === "photos.read") return ["photo1", "photo2"];
      calls.push(params);
      if (params.chatId === "-100123" && interrupted) throw new Failure("SEND_RESULT_UNKNOWN", 0, [41, 42]);
      return { messageIds: params.chatId === "-100123" ? [41, 42, 43] : [50] };
    } });
    const settings = { ...config, maxMessages: 1000, maxChatMessages: 1000 };
    await new Delivery(database, settings, accounts, {} as any).run();
    assert.equal(calls.length, 1, "The other announcement must wait for the reserved 100th publication");
    assert.equal((await enrollment(database, "1")).sent_count, 99);
    await savePromotionSettings(database, "101", { ...await promotionSettings(database), text_uz: "Different text", enabled: false });
    await database.query("UPDATE users SET trial_ends_at=now()-interval '1 second' WHERE id=1");
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE user_id=1");
    await new Delivery(database, settings, accounts, {} as any).run(); assert.equal(calls.length, 1);
    await database.query("UPDATE users SET paid_until=now()+interval '30 days' WHERE id=1");
    interrupted = false;
    for (let i = 0; i < 2; i++) {
      await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1 OR (id=$2 AND delivery_cycle_at IS NOT NULL)", [second, first]);
      await new Delivery(database, settings, accounts, {} as any).run();
    }
    const resumed = calls.filter(call => call.chatId === "-100123");
    assert.equal(resumed.length, 2); assert.equal(resumed[1].text, resumed[0].text);
    assert.ok(resumed[1].text.endsWith(consent.footer)); assert.deepEqual(resumed[1].messageIds, [41, 42]);
    assert.equal(resumed[1].deliveryKey, resumed[0].deliveryKey);
    assert.equal((await enrollment(database, "1")).sent_count, 100);
    assert.ok(calls.filter(call => call.chatId === "-100456").every(call => !call.text.includes("t.me/elonbot_test")));
    assert.ok(calls.some(call => call.chatId === "-100456"));
  } finally { await pg.close(); }
});

test("permanent failures do not count; opting out keeps ordinary publications untouched", async () => {
  const { pg, database } = await testDatabase();
  try {
    await prepare(database); await join(database);
    await database.query("UPDATE promotion_enrollments SET sent_count=99 WHERE user_id=1");
    await announcement(database); await announcement(database, "2", ["1"]);
    await database.query("UPDATE users SET trial_started_at=now(),trial_ends_at=now()+interval '7 days' WHERE id=2");
    const calls: any[] = [], accounts = new Accounts(config, { async execute(_method, params) {
      calls.push(params);
      if (params.userId === "1" && params.chatId === "-100123") throw new Failure("CHAT_WRITE_FORBIDDEN");
      return { messageIds: [calls.length] };
    } });
    await new Delivery(database, { ...config, maxChatMessages: 1000 }, accounts, { async sendMessage() {} } as any).run();
    assert.equal((await enrollment(database, "1")).sent_count, 100);
    assert.equal((await one(database, "SELECT count(*)::int n FROM delivery_logs WHERE status='sent' AND promotion_footer<>''")).n, 1);
    assert.equal(calls.find(call => call.userId === "2").text, "Hello &lt;world&gt;");
    assert.equal(await enrollment(database, "2"), undefined);
  } finally { await pg.close(); }
});

test("HTML in the footer stays plain text; consent and wizard enforce the full Telegram message length", async () => {
  const { pg, database } = await testDatabase();
  try {
    await prepare(database);
    await savePromotionSettings(database, "101", { ...await promotionSettings(database), text_uz: "<b>Bot</b> & yordam" });
    const id = await announcement(database, "1", ["1"]);
    await database.query("UPDATE announcements SET text=$2 WHERE id=$1", [id, "x".repeat(4096)]);
    await assert.rejects(join(database, "1", "uz", 2), { code: "PROMOTION_CONTENT_TOO_LONG" });
    assert.equal(await enrollment(database, "1"), undefined);
    await database.query("UPDATE announcements SET status='paused' WHERE id=$1", [id]);
    const joined = await join(database, "1", "uz", 2);
    const record = { text: "😀", promotion_footer: joined.footer };
    assert.match(renderText(record), /&lt;b&gt;Bot&lt;\/b&gt; &amp; yordam/);
    assert.equal(messageLength(record), 4 + joined.footer.length);
    const ui = await client(database);
    const draft = { kind: "announcement", step: "confirm", text: "x".repeat(4096), groups: ["1"], interval: 5, mode: "scheduled" };
    await database.query("INSERT INTO user_states(user_id,data) VALUES(1,$1)", [JSON.stringify(draft)]);
    await ui.callback("ann:confirm");
    assert.match(ui.messages.at(-1).text, /4096/);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 1);
    await ui.callback(`ann:resume:${id}`);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "paused");
  } finally { await pg.close(); }
});

test("deleting an interrupted announcement releases its reservation without resetting completed promotions", async () => {
  const { pg, database } = await testDatabase();
  try {
    await prepare(database); await join(database);
    await database.query("UPDATE promotion_enrollments SET sent_count=99 WHERE user_id=1");
    const first = await announcement(database, "1", ["1"]), next = await announcement(database, "1", ["2"]);
    const accounts = new Accounts(config, { async execute(_method, params) {
      if (params.chatId === "-100123") throw new Failure("SEND_RESULT_UNKNOWN");
      return { messageIds: [51] };
    } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    await delivery.run();
    assert.equal((await enrollment(database, "1")).sent_count, 99);
    await database.query("UPDATE announcements SET status='deleted',next_run_at=NULL WHERE id=$1", [first]);
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [next]);
    await delivery.run();
    assert.equal((await enrollment(database, "1")).sent_count, 100);
    assert.equal((await one(database, "SELECT status FROM delivery_logs WHERE announcement_id=$1", [next])).status, "sent");
  } finally { await pg.close(); }
});
