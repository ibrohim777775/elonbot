import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Accounts } from "../accounts";
import { Admin } from "../admin";
import { loadConfig } from "../config";
import { clientAddressResolver, normalizeIp, RequestLimits } from "../http-security";
import { createHttpServer } from "../server";
import { Failure, TelegramService } from "../telegram";
import { config, testDatabase } from "./helpers";

test("malformed request targets return 400 and leave HTTP and update processing available", async () => {
  const unused = {} as any;
  let updates = 0;
  const server = createHttpServer(config, unused, unused, async () => { updates++; }, () => true);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as any).port;
  try {
    for (const target of ["//[", "//attacker.test/health", "/\\attacker.test/health", "http://attacker.test/health"]) {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setEncoding("utf8"); socket.setTimeout(3000, () => socket.destroy(new Error("HTTP request timed out")));
      const ended = once(socket, "end"); let reply = "";
      socket.on("data", data => { reply += data; });
      socket.end(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      await ended;
      assert.match(reply, /^HTTP\/1\.1 400/);
      const healthy = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(healthy.status, 200); await healthy.arrayBuffer();
    }
    const response = await fetch(`http://127.0.0.1:${port}/webhook/${config.webhookSecret}`, {
      method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": config.webhookSecret },
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(response.status, 200); await response.arrayBuffer(); assert.equal(updates, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("forwarded addresses require trusted peers and discard attacker-controlled prefixes", () => {
  const resolve = clientAddressResolver(["127.0.0.1", "::1", "10.0.0.2"]);
  const request = (remote: string, forwarded?: string) => ({ socket: { remoteAddress: remote }, headers: { "x-forwarded-for": forwarded } } as any);
  assert.equal(resolve(request("198.51.100.1", "192.0.2.1")), "198.51.100.1");
  assert.equal(resolve(request("127.0.0.1", "192.0.2.1, 198.51.100.1")), "198.51.100.1");
  assert.equal(resolve(request("::ffff:127.0.0.1", "192.0.2.1, 10.0.0.2")), "192.0.2.1");
  assert.equal(resolve(request("::1", "bad, 198.51.100.1")), "::1");
  assert.equal(resolve(request("127.0.0.1")), "127.0.0.1");
  assert.equal(resolve(request("127.0.0.1", Array(33).fill("192.0.2.1").join(","))), "127.0.0.1");
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:0:1"), "2001:db8::1");
  assert.equal(normalizeIp("::ffff:c000:201"), "192.0.2.1");
  assert.equal(clientAddressResolver([])(request("127.0.0.1", "192.0.2.1")), "127.0.0.1");
});

test("configuration defaults to local ingress and rejects ambiguous proxy trust", () => {
  const env = { BOT_TOKEN: config.botToken, DATABASE_URL: config.databaseUrl, TELEGRAM_API_ID: String(config.apiId),
    TELEGRAM_API_HASH: config.apiHash, WEBHOOK_BASE_URL: config.baseUrl, WEBHOOK_SECRET: config.webhookSecret,
    SESSION_ENCRYPTION_KEY: config.encryptionKey.toString("base64") };
  assert.equal(loadConfig(env).host, "127.0.0.1");
  assert.deepEqual(loadConfig(env).trustedProxyIps, ["127.0.0.1", "::1"]);
  assert.equal(loadConfig({ ...env, HOST: "0.0.0.0" }).host, "0.0.0.0");
  assert.deepEqual(loadConfig({ ...env, TRUSTED_PROXY_IPS: "" }).trustedProxyIps, []);
  for (const value of ["*", "true", "10.0.0.0/8", "localhost", "127.0.0.1,broken"]) {
    assert.throws(() => loadConfig({ ...env, TRUSTED_PROXY_IPS: value }));
  }
});

test("login flooding through a trusted proxy does not block a different visitor or admin", async () => {
  const { pg, database } = await testDatabase();
  let telegramCalls = 0;
  const accounts = new Accounts(config, { async execute() { telegramCalls++; return { stage: "code" }; } });
  const admin = new Admin(config, database, {} as any, {} as any);
  const server = createHttpServer(config, database, accounts, async () => {}, () => true, undefined, admin);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (path: string, payload: object, ip: string) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json",
      origin: config.baseUrl, "x-admin-request": "1", "x-forwarded-for": ip }, body: JSON.stringify(payload) });
    await response.arrayBuffer(); return response.status;
  };
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101)");
    const token = (await accounts.link(database, "1")).split("#")[1];
    for (const path of ["/account/login", "/admin-api/session"]) {
      const payload = { token: "x".repeat(43), action: "begin", value: "+998901234567" };
      for (let i = 0; i < 30; i++) assert.equal(await post(path, payload, `203.0.113.${i}, 192.0.2.10`), path.startsWith("/account") ? 400 : 401);
      assert.equal(await post(path, payload, "203.0.113.250, 192.0.2.10"), 429);
    }
    assert.equal(await post("/account/login", { token, action: "begin", value: "+998901234567" }, "198.51.100.20"), 200);
    assert.equal(telegramCalls, 1);
    const link = await admin.browser.link({ id: 101, first_name: "Test" });
    assert.equal(await post("/admin-api/session", { token: link.url.split("#login=")[1] }, "198.51.100.20"), 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); }
});

test("request counters expire and a full map cannot lock out all visitors", () => {
  const limits = new RequestLimits();
  assert.equal(limits.allow("one", 1, 0), true); assert.equal(limits.allow("one", 1, 1), false);
  assert.equal(limits.allow("one", 1, 60_000), true);
  for (let i = 0; i < 10_010; i++) assert.equal(limits.allow(`visitor:${i}`, 1, 60_000), true);
  assert.equal(limits.allow("new-visitor", 1, 60_000), true);
});

test("new links cancel previous clients and cannot reset persistent per-user code limits", async () => {
  const { pg, database } = await testDatabase();
  const telegram = new TelegramService({ apiId: 1, apiHash: "test" });
  let created = 0, destroyed = 0;
  (telegram as any).make = () => { created++; return { async connect() {}, async sendCode() { return { phoneCodeHash: "test" }; }, async destroy() { destroyed++; } }; };
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101),(2,202)");
    const accounts = new Accounts(config, telegram);
    for (let i = 0; i < 3; i++) {
      const token = (await accounts.link(database, "1")).split("#")[1];
      assert.equal((await accounts.login(database, token, "begin", "+998901234567")).stage, "code");
      assert.equal(created - destroyed, 1);
    }
    const restarted = new Accounts(config, telegram);
    const token = (await restarted.link(database, "1")).split("#")[1];
    assert.equal(destroyed, 3);
    await assert.rejects(restarted.login(database, token, "begin", "+998901234567"), (error: Failure) => error.code === "RATE_LIMITED" && error.seconds > 0);
    assert.equal(created, 3);
    const other = (await restarted.link(database, "2")).split("#")[1];
    assert.equal((await restarted.login(database, other, "begin", "+998901234568")).stage, "code");
    await restarted.logout(database, "2");
    assert.equal(created, destroyed, "Disconnect also closes unfinished login clients");
  } finally { await telegram.close(); await pg.close(); }
});

test("failed steps stay counted across links and restarts, then recover after the window", async () => {
  const { pg, database } = await testDatabase(); let attempts = 0;
  const transport = { async execute(method: string) { if (method === "login.cancel") return { ok: true }; attempts++; throw new Failure("PHONE_CODE_INVALID"); } };
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101)");
    for (let i = 0; i < 10; i++) {
      const accounts = new Accounts(config, transport);
      const token = (await accounts.link(database, "1")).split("#")[1];
      await assert.rejects(accounts.login(database, token, "code", "bad"), { code: "PHONE_CODE_INVALID" });
    }
    const accounts = new Accounts(config, transport), token = (await accounts.link(database, "1")).split("#")[1];
    await assert.rejects(accounts.login(database, token, "code", "bad"), { code: "RATE_LIMITED" });
    assert.equal(attempts, 10);
    await database.query("UPDATE account_login_limits SET window_started_at=now()-interval '11 minutes'");
    await assert.rejects(accounts.login(database, token, "code", "bad"), { code: "PHONE_CODE_INVALID" });
    assert.equal(attempts, 11);
  } finally { await pg.close(); }
});

test("concurrent Telegram logins reserve capacity before connecting and release failed slots", async () => {
  const telegram = new TelegramService({ apiId: 1, apiHash: "test" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  (telegram as any).make = () => ({ connect: () => gate, async sendCode() { return { phoneCodeHash: "test" }; }, async destroy() {} });
  try {
    const pending = Array.from({ length: 100 }, (_, i) => telegram.login("begin", { key: String(i), expectedId: String(i + 1), value: "+998901234567" }));
    await assert.rejects(telegram.login("begin", { key: "extra", expectedId: "200", value: "+998901234567" }), { code: "LOGIN_CAPACITY_REACHED" });
    release(); await Promise.all(pending);
    await telegram.execute("login.cancel", { key: "0" });
    (telegram as any).make = () => ({ async connect() { throw new Failure("TELEGRAM_UNAVAILABLE"); }, async destroy() {} });
    await assert.rejects(telegram.login("begin", { key: "extra", expectedId: "200", value: "+998901234567" }), { code: "TELEGRAM_UNAVAILABLE" });
    assert.equal((telegram as any).pending.size, 99);
  } finally { release(); await telegram.close(); }
});

test("superseding an in-flight login cannot resurrect it or retain more than one slot", async () => {
  const telegram = new TelegramService({ apiId: 1, apiHash: "test" });
  let release!: () => void, created = 0, codes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  (telegram as any).make = () => { const first = ++created === 1; return {
    async connect() { if (first) await gate; }, async sendCode() { codes++; return { phoneCodeHash: "test" }; }, async destroy() {},
  }; };
  try {
    const old = telegram.login("begin", { key: "old", expectedId: "101", value: "+998901234567" }).catch(error => error);
    await telegram.login("begin", { key: "new", expectedId: "101", value: "+998901234567" });
    release(); assert.equal((await old).code, "LOGIN_EXPIRED");
    assert.equal((telegram as any).pending.size, 1); assert.equal(codes, 1);
    await assert.rejects(telegram.login("code", { key: "new", expectedId: "202", value: "12345" }), { code: "LOGIN_EXPIRED" });
    await telegram.execute("login.cancel", { key: "new" });
    assert.equal((telegram as any).pending.size, 0);
  } finally { release(); await telegram.close(); }
});

test("expired login clients are destroyed before further code submission", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const telegram = new TelegramService({ apiId: 1, apiHash: "test" });
  let destroyed = 0, submissions = 0;
  (telegram as any).make = () => ({ async connect() {}, async sendCode() { return { phoneCodeHash: "test" }; },
    async invoke() { submissions++; }, async destroy() { destroyed++; } });
  try {
    await telegram.login("begin", { key: "expired", expectedId: "101", value: "+998901234567" });
    context.mock.timers.setTime(1_600_001);
    await assert.rejects(telegram.login("code", { key: "expired", expectedId: "101", value: "12345" }), { code: "LOGIN_EXPIRED" });
    assert.equal(destroyed, 1); assert.equal(submissions, 0);
    await telegram.login("begin", { key: "cleanup", expectedId: "101", value: "+998901234567" });
    context.mock.timers.setTime(2_200_002); await telegram.cleanup();
    assert.equal(destroyed, 2); assert.equal((telegram as any).pending.size, 0);
  } finally { await telegram.close(); }
});
