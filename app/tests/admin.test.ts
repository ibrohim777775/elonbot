import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Admin } from "../admin";
import { Support } from "../support";
import { Accounts } from "../accounts";
import { createHttpServer } from "../server";
import { one } from "../db";
import { announcement, config, seed, testDatabase } from "./helpers";
import { signedInitData } from "./miniapp-fixtures";

test("admin HTTP requires a signed allowlisted identity for every action, serves safe paginated business data", async () => {
  const { pg, database } = await testDatabase();
  let sends = 0, files = 0;
  const api = { async sendMessage() { return { message_id: ++sends + 500 }; }, async getFile() { files++; throw new Error("No real files"); } } as any;
  const support = new Support(database, config, api), admin = new Admin(config, database, support, api);
  const accounts = new Accounts(config, { async execute() { throw new Error("No real Telegram"); } });
  const server = createHttpServer(config, database, accounts, async () => {}, () => true, undefined, admin);
  try {
    await seed(database); const ad = await announcement(database);
    await database.query("UPDATE announcements SET photo_file_ids='[\"secret-file-id\"]' WHERE id=$1", [ad]);
    await database.query("INSERT INTO templates(user_id,text) VALUES(1,'Saved text'),(2,'Private to second')");
    await database.query("UPDATE templates SET interval_minutes=20,first_run_mode='scheduled',send_start_minute=420,send_end_minute=1320 WHERE user_id=1");
    await database.query("INSERT INTO template_groups(template_id,group_id) SELECT id,2 FROM templates WHERE user_id=1");
    await database.query("INSERT INTO user_states(user_id,data) VALUES(1,'{\"kind\":\"announcement\",\"step\":\"content\",\"candidates\":[{\"accessHash\":\"secret-hash\"}]}')");
    await database.query("INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status) VALUES($1,1,now(),'failed')", [ad]);
    await database.query("INSERT INTO reply_notifications(user_id,chat_id,message_id) VALUES(1,-100123,21)");
    await support.receive(database, "1", { message_id: 123, text: "How to pay?" } as any);
    await support.receive(database, "2", { message_id: 123, text: "Other user" } as any);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const request = async (path: string, payload?: any, identity = 101, extra = {}) => {
      const response = await fetch(url + path, { method: payload === undefined ? "GET" : "POST", headers: { Authorization: `tma ${signedInitData(identity)}`, "Content-Type": "application/json", ...extra }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as any };
    };
    assert.equal((await request("/admin-api/overview", undefined, 101, { Authorization: "" })).status, 401);
    assert.equal((await request("/admin-api/overview", undefined, 101, { Authorization: `tma ${signedInitData(101, Math.floor(Date.now() / 1000) - 3601)}` })).status, 401);
    assert.equal((await request("/admin-api/overview", undefined, 101, { Origin: "https://evil.test" })).status, 403);
    for (const [path, payload] of [["/admin-api/overview", undefined], ["/admin-api/users/1", undefined], ["/admin-api/users/1/messages", undefined], ["/admin-api/files/announcements/1/0", undefined], ["/admin-api/users/1/tariff", { action: "activate", requestId: randomUUID() }], ["/admin-api/users/1/reply", { text: "hello", requestId: randomUUID() }], ["/admin-api/users/1/read", { throughId: "100" }]] as const) {
      assert.equal((await request(path, payload, 202)).status, 403);
    }
    assert.equal(sends, 0); assert.equal(files, 0);
    assert.equal((await request("/api/users/1/tariff", {})).status, 503);
    const summary = await request("/admin-api/overview");
    assert.equal(summary.status, 200); assert.equal(summary.body.users, 2); assert.equal(summary.body.unread, 2); assert.equal(summary.body.failed_today, 1);
    const users = await request("/admin-api/users?search=101&status=paid"); assert.equal(users.body.total, 1); assert.equal(String(users.body.rows[0].telegram_id), "101");
    assert.equal((await request("/admin-api/users?status=bad")).status, 400);
    assert.equal((await request("/admin-api/users?page=-1")).status, 400);
    assert.equal((await request("/admin-api/users?search=%27%20OR%201%3D1--")).body.total, 0);
    const profile = await request("/admin-api/users/1"); assert.equal(profile.body.draft.step, "content");
    for (const kind of ["announcements", "groups", "templates", "deliveries", "tariffs", "notifications"]) {
      const result = await request(`/admin-api/users/1/records?kind=${kind}`); assert.equal(result.status, 200, kind);
      assert.doesNotMatch(JSON.stringify(result.body), /encrypted_session|access_hash|secret-file-id|Private to second|secret-hash/);
      if (kind === "announcements") { assert.equal(result.body.rows[0].photo_count, 1); assert.equal(result.body.rows[0].groups.length, 2); }
      if (kind === "templates") {
        assert.equal(result.body.rows[0].interval_minutes, 20); assert.equal(result.body.rows[0].first_run_mode, "scheduled");
        assert.equal(result.body.rows[0].send_start_minute, 420); assert.equal(result.body.rows[0].send_end_minute, 1320);
        assert.deepEqual(result.body.rows[0].groups.map((g: any) => g.title), ["Group two"]);
      }
    }
    assert.doesNotMatch(JSON.stringify(profile), /encrypted_session|secret-hash/);
    assert.equal((await request("/admin-api/users/1/records?kind=telegram_accounts")).status, 400);
    assert.equal((await request("/admin-api/users/999")).status, 404);
    assert.equal((await request("/admin-api/inbox")).body.total, 2);
    const messages = await request("/admin-api/users/1/messages"); assert.equal(messages.body.rows.length, 1); assert.equal(messages.body.rows[0].text, "How to pay?");
    await request("/admin-api/users/1/read", { throughId: String(messages.body.rows[0].id) });
    assert.equal((await request("/admin-api/overview")).body.unread, 1);
    assert.equal((await one(database, "SELECT read_at FROM support_messages WHERE user_id=2")).read_at, null);
    const key = randomUUID();
    assert.equal((await request("/admin-api/users/1/reply", { text: "Answer", requestId: key })).body.delivery_status, "sent");
    await request("/admin-api/users/1/reply", { text: "Answer", requestId: key }); assert.equal(sends, 1);
    assert.equal((await request("/admin-api/users/2/reply", { text: "Answer", requestId: key })).status, 409);
    const html = await fetch(url + "/admin"); assert.equal(html.status, 200); assert.match(await html.text(), /admin-assets\/admin.js/);
    assert.equal(html.headers.get("x-frame-options"), null); assert.match(html.headers.get("content-security-policy")!, /frame-ancestors https:\/\/web.telegram.org/);
    // More than one page remains reachable, including large Telegram IDs returned as strings.
    await database.query("INSERT INTO users(telegram_id,first_name) SELECT 1000+i,'Extra '||i FROM generate_series(1,22) i");
    const page2 = await request("/admin-api/users?page=2"); assert.equal(page2.body.rows.length, 4); assert.equal(page2.body.total, 24);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); }
});

test("admin activates exactly 30 paid days for 20000 sum, extends remaining access, records changes and deduplicates requests", async () => {
  const { pg, database } = await testDatabase();
  const admin = new Admin(config, database, {} as any, {} as any), identity = { id: 101, first_name: "Admin" };
  const action = (payload: any, user = "1") => admin.handle("POST", `/admin-api/users/${user}/tariff`, identity, payload);
  try {
    await seed(database);
    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=now(),trial_ends_at=now()+interval '7 days' WHERE id=1");
    const trial = await one(database, "SELECT trial_ends_at FROM users WHERE id=1");
    const payload = { action: "activate", note: "Paid in cash", requestId: randomUUID() };
    const first: any = await action(payload); const retry: any = await action(payload);
    assert.equal(first.amount_sum, 20000); assert.equal(String(first.id), String(retry.id));
    assert.equal(first.paid_until.getTime() - trial.trial_ends_at.getTime(), 30 * 86400000);
    assert.equal(String(first.admin_telegram_id), "101");
    const second: any = await action({ action: "activate", requestId: randomUUID() });
    assert.equal(second.paid_until.getTime() - first.paid_until.getTime(), 30 * 86400000);
    await assert.rejects(action({ ...payload, note: "changed" }), { code: "CONFLICT" });
    await assert.rejects(action(payload, "2"), { code: "CONFLICT" });
    await assert.rejects(action({ action: "activate", requestId: "bad" }), { code: "INVALID_REQUEST" });
    await assert.rejects(admin.handle("POST", "/admin-api/users/1/tariff", { id: 202, first_name: "Not admin" }, payload), { code: "FORBIDDEN" });
    await action({ action: "revoke", requestId: randomUUID() });
    const revoked = await one(database, "SELECT paid_until,trial_ends_at FROM users WHERE id=1");
    assert.equal(revoked.paid_until, null); assert.equal(revoked.trial_ends_at.getTime(), trial.trial_ends_at.getTime());
    assert.equal((await one(database, "SELECT count(*)::int n FROM tariff_events")).n, 3);
    const summary: any = await admin.handle("GET", "/admin-api/overview", identity, {}); assert.equal(summary.activations_sum, "40000");
  } finally { await pg.close(); }
});

test("support stores duplicate-safe incoming media and distinguishes rejected versus uncertain replies without retrying Telegram", async () => {
  const { pg, database } = await testDatabase(); let calls = 0, mode = "failed";
  const api = { async sendMessage() { calls++; if (mode === "failed") throw { error_code: 403 }; throw new Error("Connection dropped after send"); } } as any;
  const support = new Support(database, config, api);
  try {
    await seed(database);
    const message = { message_id: 1, caption: "Receipt", photo: [{ file_id: "small" }, { file_id: "large" }] } as any;
    await support.receive(database, "1", message); await support.receive(database, "1", message);
    assert.equal((await one(database, "SELECT count(*)::int n FROM support_messages")).n, 1);
    assert.equal((await one(database, "SELECT file_id FROM support_messages")).file_id, "large");
    const fail = { text: "Try", requestId: randomUUID() };
    assert.equal((await support.reply("1", "101", fail)).delivery_status, "failed");
    await support.reply("1", "101", fail); assert.equal(calls, 1);
    mode = "unknown";
    const uncertain = { text: "Maybe sent", requestId: randomUUID() };
    assert.equal((await support.reply("1", "101", uncertain)).delivery_status, "unknown");
    await support.reply("1", "101", uncertain); assert.equal(calls, 2);
    await database.query("INSERT INTO support_messages(user_id,direction,text,delivery_status,updated_at) VALUES(1,'out','Interrupted','sending',now()-interval '6 minutes')");
    await support.recover(); assert.equal((await one(database, "SELECT delivery_status FROM support_messages WHERE text='Interrupted'")).delivery_status, "unknown");
    assert.equal(calls, 2);
    for (let i = 2; i < 54; i++) await support.receive(database, "1", { message_id: i, text: `Message ${i}` } as any);
    const admin = new Admin(config, database, support, api), identity = { id: 101, first_name: "Admin" };
    const recent: any = await admin.handle("GET", "/admin-api/users/1/messages", identity, {});
    assert.equal(recent.rows.length, 50); assert.equal(recent.hasOlder, true);
    const earlier: any = await admin.handle("GET", "/admin-api/users/1/messages", identity, {}, new URLSearchParams({ before: String(recent.rows[0].id) }));
    assert.ok(earlier.rows.length > 0); assert.equal(earlier.hasOlder, false);
    assert.ok(Number(earlier.rows.at(-1).id) < Number(recent.rows[0].id));
  } finally { await pg.close(); }
});

test("admin media proxy serves only stored attachments and enforces authorization and download size", async context => {
  const { pg, database } = await testDatabase(); let downloads = 0, oversized = false;
  const api = { async getFile(fileId: string) { assert.equal(fileId, "saved-photo"); return { file_path: "photos/test.jpg", file_size: oversized ? 21 * 1024 * 1024 : 4 }; } } as any;
  const admin = new Admin(config, database, {} as any, api), identity = { id: 101, first_name: "Admin" };
  context.mock.method(globalThis, "fetch", async (url: any) => {
    assert.equal(String(url), `https://api.telegram.org/file/bot${config.botToken}/photos/test.jpg`);
    downloads++; return new Response(Buffer.from([255, 216, 255, 217]));
  });
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE announcements SET photo_file_ids='[\"saved-photo\"]' WHERE id=$1", [id]);
    await assert.rejects(admin.file(`/admin-api/files/announcements/${id}/0`, { id: 202, first_name: "Other" }), { code: "FORBIDDEN" });
    assert.equal(downloads, 0);
    const photo = await admin.file(`/admin-api/files/announcements/${id}/0`, identity);
    assert.equal(photo.type, "image/jpeg"); assert.equal(photo.data.length, 4); assert.equal(downloads, 1);
    await assert.rejects(admin.file(`/admin-api/files/announcements/${id}/1`, identity), { code: "NOT_FOUND" });
    await assert.rejects(admin.file("/admin-api/files/telegram_accounts/1/0", identity), { code: "NOT_FOUND" });
    oversized = true;
    await assert.rejects(admin.file(`/admin-api/files/announcements/${id}/0`, identity), { code: "FILE_TOO_LARGE" });
    assert.equal(downloads, 1);
  } finally { await pg.close(); }
});
