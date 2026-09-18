import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Broadcasts } from "../broadcasts";
import { Admin } from "../admin";
import { one } from "../db";
import { config, seed, testDatabase } from "./helpers";

const payload = (audience = "all", userIds: string[] = []) => ({ textRu: "Бот снова работает! Нажмите /start", textUz: "Bot yana ishlayapti! /start ni bosing", audience, userIds, requestId: randomUUID() });
test("broadcast preview snapshots all or selected users, validates input, requires confirmation and keeps language-specific templates", async () => {
  const { pg, database } = await testDatabase(); const sends: any[] = [];
  const api = { async sendMessage(id: string, text: string) { sends.push({ id, text }); return { message_id: sends.length }; } } as any;
  const broadcasts = new Broadcasts(database, api), admin = new Admin(config, database, {} as any, api);
  try {
    await seed(database); await database.query("UPDATE users SET language='ru',paid_until=NULL WHERE id=1");
    await database.query("DELETE FROM telegram_accounts");
    const templates = await broadcasts.templates(); assert.equal(templates.rows[0].name, "Бот снова работает");
    assert.match(templates.rows[0].text_ru, /\/start/); assert.match(templates.rows[0].text_uz, /\/start/);
    const saved = await broadcasts.saveTemplate({ ...payload(), name: "Custom" });
    assert.equal((await broadcasts.saveTemplate({ ...payload(), name: "Custom" })).id, saved.id);
    await assert.rejects(broadcasts.saveTemplate({ ...payload(), textRu: "Changed", name: "Custom" }), { code: "TEMPLATE_NAME_USED" });
    const input = payload(), draft = await broadcasts.create("101", input);
    assert.deepEqual(await broadcasts.create("101", input), draft);
    await assert.rejects(broadcasts.create("202", input), { code: "CONFLICT" });
    await assert.rejects(broadcasts.create("101", { ...input, textRu: "Changed" }), { code: "CONFLICT" });
    await broadcasts.run(); assert.equal(sends.length, 0);
    await database.query("INSERT INTO users(telegram_id,first_name) VALUES(303,'New after preview')");
    const detail = await broadcasts.detail(draft.id, 1); assert.equal(detail.total, 2); assert.equal(detail.counts.ru, 1); assert.equal(detail.counts.uz, 1);
    for (const bad of [{ ...payload(), textRu: " " }, { ...payload(), textUz: "x".repeat(3501) }, payload("selected"), payload("all", ["1"]), payload("selected", ["999"]), { ...payload(), audience: "invalid" }]) {
      await assert.rejects(broadcasts.create("101", bad));
    }
    await assert.rejects(admin.handle("POST", "/admin-api/broadcasts", { id: 202, first_name: "Other" }, payload()), { code: "FORBIDDEN" });
    await assert.rejects(admin.handle("POST", `/admin-api/broadcasts/${draft.id}/start`, { id: 202, first_name: "Other" }, {}), { code: "FORBIDDEN" });
    await assert.rejects(admin.handle("POST", "/admin-api/broadcast-templates", { id: 202, first_name: "Other" }, { ...payload(), name: "Hidden" }), { code: "FORBIDDEN" });
    await broadcasts.action(draft.id, "start", "101"); await broadcasts.action(draft.id, "start", "101");
    await broadcasts.run(); assert.deepEqual(sends, [{ id: "101", text: input.textRu }]);
    await database.query("UPDATE broadcast_clock SET next_send_at=now()");
    await new Broadcasts(database, api).run();
    assert.deepEqual(sends[1], { id: "202", text: input.textUz }); assert.equal(sends.length, 2);
    assert.equal((await broadcasts.detail(draft.id, 1)).status, "completed");
    await broadcasts.action(draft.id, "start", "101"); await broadcasts.run(); assert.equal(sends.length, 2);
    const selected = await broadcasts.create("101", payload("selected", ["2", "2"]));
    assert.equal((await broadcasts.detail(selected.id, 1)).total, 1);
    await database.query("UPDATE broadcasts SET created_at=now()-interval '25 hours' WHERE id=$1", [selected.id]);
    await assert.rejects(broadcasts.action(selected.id, "start", "101"), { code: "PREVIEW_EXPIRED" });
    assert.equal((await broadcasts.list(1)).total, 2);
  } finally { await pg.close(); }
});

test("broadcast worker honors Telegram cooldown, distinguishes definite rejection and uncertain delivery, and recovers without duplicate sends", async () => {
  const { pg, database } = await testDatabase(); let calls = 0, mode = "rate";
  const api = { async sendMessage() { calls++; if (mode === "rate") throw { error_code: 429, parameters: { retry_after: 120 } };
    if (mode === "blocked") throw { error_code: 403 }; if (mode === "unknown") throw new Error("Connection lost"); return { message_id: 500 + calls }; } } as any;
  const broadcasts = new Broadcasts(database, api);
  const advance = () => database.query("UPDATE broadcast_clock SET next_send_at=now()");
  try {
    await seed(database); const first = await broadcasts.create("101", payload()); await broadcasts.action(first.id, "start", "101");
    await broadcasts.run(); await broadcasts.run(); assert.equal(calls, 1);
    assert.ok(new Date((await one(database, "SELECT next_send_at FROM broadcast_clock")).next_send_at).getTime() > Date.now() + 110000);
    assert.equal((await broadcasts.detail(first.id, 1)).counts.pending, 2);
    mode = "ok"; await advance(); await broadcasts.run(); assert.equal(calls, 2);
    mode = "blocked"; await advance(); await broadcasts.run();
    const done = await broadcasts.detail(first.id, 1); assert.equal(done.status, "completed"); assert.equal(done.counts.sent, 1); assert.equal(done.counts.failed, 1);
    const second = await broadcasts.create("101", payload()); await broadcasts.action(second.id, "start", "101");
    mode = "unknown"; await advance(); await broadcasts.run();
    assert.equal((await broadcasts.detail(second.id, 1)).counts.unknown, 1);
    // Model a process that stopped after committing its next recipient claim.
    await database.query("UPDATE broadcast_recipients SET status='sending',updated_at=now()-interval '6 minutes' WHERE broadcast_id=$1 AND status='pending'", [second.id]);
    const before = calls; await advance(); await new Broadcasts(database, api).run();
    assert.equal(calls, before); assert.equal((await broadcasts.detail(second.id, 1)).counts.unknown, 2);
    assert.equal((await broadcasts.detail(second.id, 1)).status, "completed");
  } finally { await pg.close(); }
});

test("parallel workers claim once and cancellation prevents further deliveries including a rate-limited in-flight request", async () => {
  const { pg, database } = await testDatabase(); let calls = 0;
  let claimed!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { claimed = resolve; });
  const network = new Promise<void>(resolve => { finish = resolve; });
  const api = { async sendMessage() { calls++; claimed(); await network; throw { error_code: 429, parameters: { retry_after: 10 } }; } } as any;
  const worker = new Broadcasts(database, api), second = new Broadcasts(database, api);
  try {
    await seed(database); const batch = await worker.create("101", payload()); await worker.action(batch.id, "start", "101");
    const sending = worker.run(); await started;
    await database.query("UPDATE broadcast_clock SET next_send_at=now()"); await second.run(); assert.equal(calls, 1);
    await worker.action(batch.id, "cancel", "101"); finish(); await sending; await second.run();
    assert.equal(calls, 1); const result = await worker.detail(batch.id, 1);
    assert.equal(result.status, "cancelled"); assert.equal(result.counts.cancelled, 2);
    await assert.rejects(worker.action(batch.id, "start", "101"), { code: "CONFLICT" });
  } finally { finish(); await worker.wait(); await pg.close(); }
});
