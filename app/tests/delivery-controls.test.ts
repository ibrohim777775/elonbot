import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { createBot } from "../bot";
import { Groups } from "../groups";
import { Delivery } from "../delivery";
import { Database, one } from "../db";
import { messageLength } from "../content";
import { announcementState } from "../announcement-state";
import { t } from "../i18n";
import { Failure } from "../telegram";
import { announcement, config, seed, testDatabase } from "./helpers";

async function client(database: Database, delivery: any = { async run() {}, async removePublished() { throw new Error("Must preserve publications"); } }) {
  const accounts = new Accounts(config, { async execute() { throw new Error("No live Telegram calls"); } });
  const bot = createBot(config, database, accounts, new Groups(accounts), delivery), messages: any[] = [];
  bot.api.config.use(async (_, method, payload: any) => {
    messages.push({ method, ...payload });
    return { ok: true, result: method === "getMe" ? { id: 123456789, is_bot: true, first_name: "Bot" }
      : { message_id: 500, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
  });
  await bot.init(); let updateId = 1000;
  const callback = (data: string, owner = 101) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: String(updateId), from: { id: owner, is_bot: false, first_name: "User" }, data, chat_instance: "one",
    message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu" },
  } } as any);
  const message = (fields: any) => bot.handleUpdate({ update_id: ++updateId, message: {
    message_id: updateId, date: 0, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "User" }, ...fields,
  } } as any);
  return { callback, message, messages };
}

test("disconnecting the last group preserves the ad, publication receipts, other owners and manual pauses", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]), manual = await announcement(database, "1", ["1"]);
    const other = await announcement(database, "2", ["1"]);
    await database.query("UPDATE announcements SET status='paused',pause_reason='manual' WHERE id=$1", [manual]);
    await database.query(`INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status,sent_at,telegram_message_ids,sender_telegram_id)
      VALUES($1,1,now(),'sent',now(),'[77]',101)`, [id]);
    const ui = await client(database);
    await ui.callback("groups:delete_confirm:1");
    const a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(a.status, "paused"); assert.equal(a.pause_reason, "no_groups"); assert.equal(a.text, "Hello <world>");
    assert.deepEqual((await one(database, "SELECT telegram_message_ids FROM delivery_logs WHERE announcement_id=$1", [id])).telegram_message_ids, [77]);
    assert.equal((await one(database, "SELECT pause_reason FROM announcements WHERE id=$1", [manual])).pause_reason, "manual");
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [other])).status, "active");
    await ui.callback(`ann:resume:${id}`);
    assert.equal(ui.messages.at(-1).text, t("validation.group_required"));
    await ui.callback(`ann:edit_groups:${id}`); await ui.callback("ann:group:2"); await ui.callback("ann:groups_done");
    await ui.callback(`ann:resume:${id}`);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "active");
  } finally { await pg.close(); }
});

test("pause and resume enforce ownership and access while retaining a partial cycle without duplicates", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    const calls: string[] = [];
    const accounts = new Accounts(config, { async execute(_method, p) { calls.push(p.chatId); return { messageIds: [calls.length] }; } });
    const delivery = new Delivery(database, { ...config, maxMessages: 1 }, accounts, {} as any);
    await delivery.run(); assert.equal(calls.length, 1);
    const initial = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    const ui = await client(database);
    await ui.callback(`ann:pause:${id}`, 202);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "active");
    await ui.callback(`ann:pause:${id}`); await delivery.run(); assert.equal(calls.length, 1);
    await database.query("UPDATE users SET trial_started_at=now()-interval '8 days',trial_ends_at=now()-interval '1 day',paid_until=NULL WHERE id=1");
    await ui.callback(`ann:resume:${id}`);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "paused");
    await database.query("UPDATE users SET paid_until=now()+interval '1 day' WHERE id=1");
    await database.query("UPDATE delivery_usage SET sent_at=now()-interval '2 minutes'");
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    await ui.callback(`ann:resume:${id}`);
    assert.equal((await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at.toISOString(), initial.delivery_cycle_at.toISOString());
    await delivery.run(); assert.deepEqual(calls, ["-100123", "-100456"]);
    const result = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(result.last_delivery_summary.sent, 2); assert.equal(result.last_delivery_summary.waiting, 0);
    assert.match(await announcementState(database, result, "ru"), /Отправлено: 2/);
    const notices = (await database.query("SELECT payload FROM user_notifications ORDER BY id")).rows;
    assert.deepEqual(notices.map(n => [n.payload.summary.sent, n.payload.summary.waiting]), [[1, 1], [2, 0]]);
  } finally { await pg.close(); }
});

test("editing photos preserves a manual pause and resuming enforces the active announcement limit", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]);
    await database.query("UPDATE announcements SET status='paused',pause_reason='manual' WHERE id=$1", [id]);
    const ui = await client(database);
    await ui.callback(`ann:edit_photo:${id}`);
    await ui.message({ caption: "New photo", forward_origin: { type: "hidden_user", sender_user_name: "Source", date: 0 },
      photo: [{ file_id: "not-saved", file_unique_id: "one", width: 100, height: 100 }] });
    await ui.callback("ann:photos_done");
    const a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(a.status, "paused"); assert.equal(a.pause_reason, "manual"); assert.equal(a.photo_message_ids.length, 1);
    for (let n = 0; n < config.maxAnnouncements; n++) await announcement(database, "1", ["1"]);
    await ui.callback(`ann:resume:${id}`);
    assert.equal(ui.messages.at(-1).text, t("validation.limit_reached"));
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "paused");
  } finally { await pg.close(); }
});

test("full rendered length includes contacts; invalid edits and legacy oversized sends leave content safe", async () => {
  assert.equal(messageLength({ text: "<&".repeat(2048) }), 4096);
  assert.equal(messageLength({ text: "😀".repeat(2048) }), 4096);
  assert.equal(messageLength({ text: "Hi", contact_telegram: "https://t.me/username" }), "Hi\nTelegram: @username".length);
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE announcements SET text=$2 WHERE id=$1", [id, "A".repeat(4096)]);
    const ui = await client(database);
    await ui.callback(`ann:edit_name:${id}`); await ui.message({ text: "Seller" });
    assert.equal(ui.messages.at(-1).text, t("validation.message_too_long"));
    assert.equal((await one(database, "SELECT contact_name FROM announcements WHERE id=$1", [id])).contact_name, null);
    await database.query("UPDATE announcements SET contact_name='Legacy contact' WHERE id=$1", [id]);
    const accounts = new Accounts(config, { async execute() { throw new Error("Must reject before requesting Telegram"); } });
    await new Delivery(database, config, accounts, {} as any).run();
    const a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(a.status, "paused"); assert.equal(a.pause_reason, "invalid_content");
    assert.equal(a.last_delivery_summary.failed, 2); assert.equal(a.last_delivery_summary.waiting, 0);
    await ui.callback(`ann:edit_text:${id}`); await ui.message({ text: "Corrected" }); await ui.callback(`ann:resume:${id}`);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "active");
  } finally { await pg.close(); }
});

test("deleting announcements and their logs cannot reset account or chat minute quotas", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const first = await announcement(database, "1", ["1"]);
    let sends = 0;
    const accounts = new Accounts(config, { async execute() { return { messageIds: [++sends] }; } });
    await new Delivery(database, config, accounts, {} as any).run(); assert.equal(sends, 1);
    await database.query("DELETE FROM announcements WHERE id=$1", [first]);
    assert.equal((await one(database, "SELECT count(*)::int n FROM delivery_logs")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM delivery_usage")).n, 1);
    const sameChat = await announcement(database, "1", ["1"]);
    await new Delivery(database, config, accounts, {} as any).run(); assert.equal(sends, 1);
    const otherChat = await announcement(database, "1", ["2"]);
    await new Delivery(database, { ...config, maxMessages: 1 }, accounts, {} as any).run(); assert.equal(sends, 1);
    await database.query("UPDATE delivery_usage SET sent_at=now()-interval '2 minutes'");
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id IN ($1,$2)", [sameChat, otherChat]);
    await new Delivery(database, config, accounts, {} as any).run(); assert.equal(sends, 3);
  } finally { await pg.close(); }
});

test("delivery reports unavailable groups and failures and emits recovery once instead of every cycle", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE user_groups SET can_post=false WHERE user_id=1 AND group_id=2");
    let fail = true;
    const accounts = new Accounts(config, { async execute() { if (fail) throw new Failure("BAD_REQUEST"); return { messageIds: [42] }; } });
    const delivery = new Delivery(database, { ...config, maxChatMessages: 100 }, accounts, {} as any);
    await delivery.run();
    const summary = (await one(database, "SELECT last_delivery_summary s FROM announcements WHERE id=$1", [id])).s;
    assert.deepEqual([summary.total, summary.sent, summary.failed, summary.unavailable, summary.waiting], [2, 0, 1, 1, 0]);
    fail = false; await database.query("UPDATE user_groups SET can_post=true WHERE user_id=1");
    // Waiting for the local minute quota does not prove that the Telegram error is resolved.
    await database.query("INSERT INTO delivery_usage VALUES(999,101,-100123,now())");
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    await new Delivery(database, { ...config, maxMessages: 1 }, accounts, {} as any).run();
    assert.equal((await one(database, "SELECT count(*)::int n FROM user_notifications")).n, 1);
    await database.query("UPDATE delivery_usage SET sent_at=now()-interval '2 minutes'");
    for (let i = 0; i < 2; i++) {
      await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]); await delivery.run();
    }
    const notices = (await database.query("SELECT payload FROM user_notifications ORDER BY id")).rows;
    assert.deepEqual(notices.map(n => n.payload.summary.health), ["attention", "ok"]);
    assert.equal(notices[1].payload.recovered, true);
    assert.equal((await one(database, "SELECT last_delivery_summary s FROM announcements WHERE id=$1", [id])).s.sent, 2);
  } finally { await pg.close(); }
});
