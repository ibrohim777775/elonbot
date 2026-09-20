import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Admin } from "../admin";
import { one } from "../db";
import { enqueueNotification, Notifications } from "../notifications";
import { announcement, config, seed, testDatabase } from "./helpers";

test("trial and paid reminders deduplicate across restarts and expiration is notified once", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=now()-interval '6 days',trial_ends_at=now()+interval '12 hours' WHERE id=1");
    await database.query("UPDATE users SET language='ru',paid_until=now()+interval '10 hours' WHERE id=2");
    const messages: any[] = [], api = { async sendMessage(...args: any[]) { messages.push(args); return { message_id: messages.length }; } } as any;
    const worker = new Notifications(database, api);
    await worker.maintain(); await new Notifications(database, api).maintain();
    assert.equal((await one(database, "SELECT count(*)::int n FROM user_notifications")).n, 2);
    await worker.run(); await worker.run(); await worker.run();
    assert.equal(messages.length, 2);
    assert.match(messages.find(m => m[0] === "101")[1], /Sinov muddati/);
    assert.match(messages.find(m => m[0] === "202")[1], /Тариф действует/);
    await database.query("UPDATE users SET trial_ends_at=now()-interval '1 second' WHERE id=1");
    await worker.maintain(); await worker.run(); await worker.maintain(); await worker.run();
    assert.equal(messages.length, 3); assert.match(messages[2][1], /Avtomatik yuborish to‘xtadi/);
  } finally { await pg.close(); }
});

test("renewal skips stale reminders, confirms once and never resumes manually paused ads", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const active = await announcement(database), paused = await announcement(database);
    await database.query("UPDATE announcements SET status='paused',pause_reason='manual' WHERE id=$1", [paused]);
    await database.query("UPDATE users SET language='ru',paid_until=now()-interval '1 second' WHERE id=1");
    const messages: any[] = [], api = { async sendMessage(...args: any[]) { messages.push(args); return { message_id: 1 }; } } as any;
    const worker = new Notifications(database, api);
    await worker.maintain();
    const admin = new Admin(config, database, {} as any, api), payload = { action: "activate", requestId: randomUUID() };
    await admin.handle("POST", "/admin-api/users/1/tariff", { id: 101, first_name: "Admin" }, payload);
    await admin.handle("POST", "/admin-api/users/1/tariff", { id: 101, first_name: "Admin" }, payload);
    await worker.run(); await worker.run(); await worker.run();
    assert.equal(messages.length, 1); assert.match(messages[0][1], /Тариф активирован/); assert.match(messages[0][1], /группами: 1/);
    assert.deepEqual((await database.query("SELECT status FROM user_notifications ORDER BY id")).rows.map(r => r.status), ["skipped", "sent"]);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [paused])).status, "paused");
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [active])).status, "active");
  } finally { await pg.close(); }
});

test("notification outbox retries definite 429 responses but not blocked or uncertain sends", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    const user = await one(database, "SELECT paid_until FROM users WHERE id=1"), payload = { until: user.paid_until.toISOString() };
    let calls = 0, mode = "rate";
    const api = { async sendMessage() {
      calls++;
      if (mode === "rate") throw { error_code: 429, parameters: { retry_after: 60 } };
      if (mode === "blocked") throw { error_code: 403 };
      if (mode === "unknown") throw new Error("Response lost after sending");
      return { message_id: 123 };
    } } as any;
    const worker = new Notifications(database, api);
    await enqueueNotification(database, "1", "one", "tariff_activated", payload);
    await Promise.all([worker.run(), worker.run()]); assert.equal(calls, 1);
    assert.equal((await one(database, "SELECT status FROM user_notifications WHERE dedup_key='one'")).status, "pending");
    await worker.run(); assert.equal(calls, 1);
    mode = "ok"; await database.query("UPDATE user_notifications SET available_at=now()-interval '1 second'");
    await new Notifications(database, api).run(); assert.equal(calls, 2);
    mode = "blocked"; await enqueueNotification(database, "1", "two", "tariff_activated", payload); await worker.run();
    mode = "unknown"; await enqueueNotification(database, "1", "three", "tariff_activated", payload); await worker.run();
    await worker.run(); assert.equal(calls, 4);
    assert.deepEqual((await database.query("SELECT status FROM user_notifications ORDER BY id")).rows.map(r => r.status), ["sent", "failed", "unknown"]);
    await enqueueNotification(database, "1", "four", "tariff_activated", payload);
    await database.query("UPDATE user_notifications SET status='sending',updated_at=now()-interval '6 minutes' WHERE dedup_key='four'");
    await worker.maintain(); await worker.run(); assert.equal(calls, 4);
    assert.equal((await one(database, "SELECT status FROM user_notifications WHERE dedup_key='four'")).status, "unknown");
  } finally { await pg.close(); }
});

test("delivery notifications use the owner's current language, skip deleted ads and retain only counts", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database), deleted = await announcement(database);
    const summary = { cycle: new Date().toISOString(), total: 3, sent: 1, waiting: 1, failed: 0, unavailable: 1,
      updatedAt: new Date().toISOString(), complete: false, firstCycle: true, health: "attention" };
    await enqueueNotification(database, "1", "result", "delivery_result", { announcementId: id, summary, recovered: true });
    await enqueueNotification(database, "1", "deleted", "delivery_result", { announcementId: deleted, summary });
    await database.query("UPDATE users SET language='ru' WHERE id=1");
    await database.query("DELETE FROM announcements WHERE id=$1", [deleted]);
    const messages: any[] = [], worker = new Notifications(database, { async sendMessage(...args: any[]) { messages.push(args); return { message_id: 1 }; } } as any);
    await worker.run(); await worker.run(); assert.equal(messages.length, 1);
    assert.equal(messages[0][0], "101"); assert.match(messages[0][1], /Ожидают отправки: 1/);
    assert.match(messages[0][1], /Отправка восстановлена/);
    assert.equal(messages[0][2].reply_markup.inline_keyboard[0][0].callback_data, `ann:show:${id}`);
    assert.doesNotMatch(JSON.stringify((await database.query("SELECT payload FROM user_notifications")).rows), /Hello|file_id|photo/);
    await database.query("INSERT INTO delivery_usage VALUES(999,101,-100123,now()-interval '2 days')");
    await worker.maintain(); assert.equal((await one(database, "SELECT count(*)::int n FROM delivery_usage")).n, 0);
  } finally { await pg.close(); }
});
