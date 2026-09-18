import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Accounts } from "../accounts";
import { one } from "../db";
import { Groups } from "../groups";
import { logError } from "../log";
import { MiniApp } from "../miniapp";
import { validateInitData } from "../miniapp-auth";
import { createHttpServer } from "../server";
import { Failure } from "../telegram";
import { announcement, config, seed, testDatabase } from "./helpers";
import { signedInitData } from "./miniapp-fixtures";

test("Mini App authenticates signed owner, rejects tampering, replay age and duplicate fields", () => {
  const valid = signedInitData();
  assert.equal(validateInitData(valid, config.botToken).id, 101);
  for (const value of [valid.replace("101", "202"), valid + "&auth_date=1", "", valid.replace("test-signature", "changed")]) {
    assert.throws(() => validateInitData(value, config.botToken), { code: "UNAUTHORIZED" });
  }
  assert.throws(() => validateInitData(valid, "wrong-token"), { code: "UNAUTHORIZED" });
  for (const date of [Math.floor(Date.now() / 1000) - 3601, Math.floor(Date.now() / 1000) + 60]) {
    assert.throws(() => validateInitData(signedInitData(101, date), config.botToken), { code: "AUTH_EXPIRED" });
  }
});

test("group-only HTTP API binds permissions to owner and keeps bot data intact", async () => {
  const { pg, database } = await testDatabase();
  let calls = 0;
  const localConfig = { ...config, maxGroups: 3 };
  const accounts = new Accounts(localConfig, { async execute(method, params) {
    assert.equal(method, "groups"); calls++;
    const ids = params.userId === "1" ? [123, 456, 789, 888, 999] : [123, 444];
    return { groups: ids.map(id => ({ chatId: `-100${id}`, title: `Group ${id}`, chatType: "supergroup",
      accessHash: `secret-hash-${params.userId}`, canPost: id !== 888, isAdmin: false })) };
  } });
  const server = createHttpServer(localConfig, database, accounts, async () => {}, () => true, new MiniApp(localConfig, database, new Groups(accounts)));
  try {
    await seed(database); await announcement(database);
    await database.query("INSERT INTO templates(user_id,text) VALUES(1,'Keep template')");
    await database.query("INSERT INTO user_states(user_id,data) VALUES(1,'{\"step\":\"content\",\"text\":\"Keep draft\"}')");
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const request = async (path: string, data?: any, id = 101, extra: Record<string, string> = {}) => {
      const response = await fetch(url + path, { method: data === undefined ? "GET" : "POST", headers: {
        Authorization: `tma ${signedInitData(id)}`, "Content-Type": "application/json", ...extra,
      }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: response.status, body: await response.json() as any };
    };
    assert.equal((await request("/api/state", undefined, 101, { Authorization: "" })).status, 401);
    assert.equal((await request("/api/state", undefined, 101, { Origin: "https://other.test" })).status, 403);
    assert.equal((await request("/api/state", undefined, 303)).body.error, "LOGIN_REQUIRED");
    const state = await request("/api/state");
    assert.equal(state.body.accountConnected, true); assert.equal(state.body.connected.length, 2); assert.equal(calls, 0);
    const discovery = await request("/api/groups/discover", {});
    assert.equal(discovery.body.groups.length, 5);
    assert.ok(!JSON.stringify(discovery).includes("secret-hash")); assert.ok(!JSON.stringify(state).includes("session"));
    assert.equal((await request("/api/groups/connect", { chatId: "-100444", userId: "2" })).status, 404);
    assert.equal((await request("/api/groups/connect", { chatId: "-100888", canPost: true })).body.error, "CHAT_WRITE_FORBIDDEN");
    assert.equal((await request("/api/groups/connect", { chatId: "-100789" })).status, 200);
    assert.equal((await request("/api/groups/connect", { chatId: "-100789" })).status, 200);
    assert.equal((await request("/api/groups/connect", { chatId: "-100999" })).body.error, "GROUP_LIMIT");
    assert.equal(calls, 1, "Adding groups must reuse the same Telegram list");
    assert.equal((await request("/api/state", undefined, 202)).body.connected.length, 1);
    assert.equal((await request("/api/groups/connect", { chatId: "-100789" }, 202)).status, 404);
    for (const path of ["/api/announcements/create", "/api/templates/create", "/api/account/login", "/api/groups/delete", "/api/media/upload"]) {
      assert.equal((await request(path, {})).status, 404);
    }
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 1);
    assert.equal((await one(database, "SELECT text FROM templates")).text, "Keep template");
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.text, "Keep draft");
    const page = await fetch(url + "/app");
    assert.equal(page.status, 200); assert.equal(page.headers.get("x-frame-options"), null);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors https:\/\/web.telegram.org/);
    assert.equal((await fetch(url + "/account")).headers.get("x-frame-options"), "DENY");
    await database.query("DELETE FROM telegram_accounts WHERE user_id=1");
    assert.equal((await request("/api/state")).body.accountConnected, false);
    assert.equal((await request("/api/groups/discover", {})).body.error, "LOGIN_REQUIRED");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); }
});

test("Mini App commits discovery cooldowns and does not retry Telegram on repeated opens", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); let calls = 0;
    const accounts = new Accounts(config, { async execute() { calls++; throw new Failure("FLOOD_WAIT", 120); } });
    const mini = new MiniApp(config, database, new Groups(accounts));
    for (let i = 0; i < 2; i++) await assert.rejects(mini.handle("POST", "/api/groups/discover", { id: 101, first_name: "Test" }, { refresh: true }), { code: "GROUPS_RATE_LIMITED" });
    assert.equal(calls, 1);
    assert.ok((await one(database, "SELECT retry_after FROM telegram_group_cache WHERE user_id=1")).retry_after > new Date());
    assert.equal((await one(database, "SELECT retry_after FROM telegram_accounts WHERE user_id=1")).retry_after, null);
  } finally { await pg.close(); }
});

test("terminal errors include source locations without request secrets or SQL parameters", () => {
  const original = console.error; const lines: unknown[][] = [];
  console.error = (...args) => { lines.push(args); };
  try {
    logError("request_failed", Object.assign(new Error("token=private-token password=private-password"), { code: "ECONNREFUSED", query: "private-query", params: ["private-session"] }));
    const output = JSON.stringify(lines);
    assert.match(output, /ECONNREFUSED/); assert.match(output, /miniapp.test.ts/); assert.ok(!output.includes("private-"));
  } finally { console.error = original; }
});
