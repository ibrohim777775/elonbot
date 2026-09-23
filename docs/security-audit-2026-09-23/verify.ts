// Audit reproductions: localhost HTTP, in-memory PGlite, synthetic credentials and mocked Telegram.
// This deliberately verifies the vulnerable behavior at cf70065; it is not a production test suite.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Accounts } from "../../app/accounts";
import { Admin } from "../../app/admin";
import { TelegramService } from "../../app/telegram";
import { createHttpServer } from "../../app/server";
import { config, testDatabase } from "../../app/tests/helpers";

process.env.APP_ENV = "production";
const result: Record<string, unknown> = { commit: "cf70065", executedAt: new Date().toISOString(), node: process.version };
async function listen(server: Server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return (server.address() as any).port as number; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

async function malformedUrl() {
  const unavailable = { async query() { throw new Error("Database must not be reached"); } } as any;
  const server = createHttpServer(config, unavailable, unavailable, async () => {}, () => true);
  const port = await listen(server);
  let handler: (reason: any) => void = () => {};
  const rejection = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No unhandled rejection observed")), 3000);
    handler = reason => { clearTimeout(timer); resolve(reason.code); };
    process.once("unhandledRejection", handler);
  });
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await once(socket, "connect");
    socket.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    const code = await rejection; assert.equal(code, "ERR_INVALID_URL");
    const main = await readFile("app/main.ts", "utf8");
    assert.match(main, /process\.on\("unhandledRejection"[\s\S]*?void stop\(\)/);
    result.malformedUrl = { unhandledRejection: code, productionHandlerCallsStop: true, authenticationRequired: false };
  } finally { socket.destroy(); process.removeListener("unhandledRejection", handler); await close(server); }
}

async function sharedRateLimit() {
  const { pg, database } = await testDatabase();
  let telegramCalls = 0;
  const accounts = new Accounts(config, { async execute() { telegramCalls++; return { stage: "code" }; } });
  const admin = new Admin(config, database, {} as any, {} as any);
  const server = createHttpServer(config, database, accounts, async () => {}, () => true, undefined, admin);
  const port = await listen(server), url = `http://127.0.0.1:${port}`;
  const post = async (path: string, payload: object, ip: string) => {
    const response = await fetch(url + path, { method: "POST", headers: {
      "Content-Type": "application/json", Origin: new URL(config.baseUrl).origin,
      "X-Admin-Request": "1", "X-Forwarded-For": ip,
    }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101)");
    const token = (await accounts.link(database, "1")).split("#")[1];
    for (let n = 0; n < 30; n++) assert.equal((await post("/account/login", {
      token: "x".repeat(43), action: "begin", value: "+998901234567",
    }, "192.0.2.10")).status, 400);
    const legitimate = await post("/account/login", { token, action: "begin", value: "+998901234567" }, "198.51.100.20");
    assert.equal(legitimate.status, 429); assert.equal(telegramCalls, 0);
    const link = await admin.browser.link({ id: 101, first_name: "Test" });
    const adminToken = link.url.split("#login=")[1];
    for (let n = 0; n < 30; n++) assert.equal((await post("/admin-api/session", { token: "x".repeat(43) }, "192.0.2.10")).status, 401);
    const legitimateAdmin = await post("/admin-api/session", { token: adminToken }, "198.51.100.20");
    assert.equal(legitimateAdmin.status, 429);
    result.sharedProxyRateLimit = { rejectedAccountAttempts: 30, legitimateAccountStatus: legitimate.status,
      rejectedAdminAttempts: 30, legitimateAdminStatus: legitimateAdmin.status, telegramCalls };
  } finally { await close(server); await pg.close(); }
}

async function pendingLogins() {
  const { pg, database } = await testDatabase();
  const telegram = new TelegramService({ apiId: 1, apiHash: "fake" });
  let created = 0, destroyed = 0;
  (telegram as any).make = () => ({ async connect() { created++; }, async sendCode() { return { phoneCodeHash: "synthetic" }; }, async destroy() { destroyed++; } });
  const accounts = new Accounts(config, telegram);
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101),(2,202)");
    for (let n = 0; n < 100; n++) {
      const token = (await accounts.link(database, "1")).split("#")[1];
      await accounts.login(database, token, "begin", "+998901234567");
    }
    const otherToken = (await accounts.link(database, "2")).split("#")[1];
    await assert.rejects(accounts.login(database, otherToken, "begin", "+998901234568"), { code: "LOGIN_CAPACITY_REACHED" });
    assert.equal(created, 100); assert.equal(destroyed, 0);
    result.pendingLogins = { flowsByOneUser: created, supersededFlowsDestroyed: destroyed, otherUserFailure: "LOGIN_CAPACITY_REACHED",
      scope: "Application behavior with mocked Telegram; real Telegram and HTTP rate limits were not bypassed or load-tested." };
  } finally { await telegram.close(); await pg.close(); }
}

async function updateDependencyExecution() {
  // Only create an inert stand-in dependency in a new temporary folder, never run the update script.
  const dir = await mkdtemp(join(tmpdir(), "elonbot-security-audit-"));
  await mkdir(join(dir, "node_modules", "dotenv"), { recursive: true });
  await writeFile(join(dir, ".env"), "PORT=8000\n");
  await writeFile(join(dir, "node_modules", "dotenv", "index.js"), `require('node:fs').writeFileSync('dependency-loaded.txt','local test only');exports.parse=()=>({PORT:'8000'});`);
  const port = execFileSync(process.execPath, ["-e", `const fs=require('node:fs');const env=require('dotenv').parse(fs.readFileSync('.env'));process.stdout.write(env.PORT);`], { cwd: dir, encoding: "utf8" });
  assert.equal(port, "8000"); assert.equal(await readFile(join(dir, "dependency-loaded.txt"), "utf8"), "local test only");
  const script = await readFile("scripts/update-server.sh", "utf8");
  assert.match(script, /\$EUID -eq 0/); assert.match(script, /PORT=\$\(cd "\$STAGE" && node -e/);
  result.updateDependency = { stagingModuleExecuted: true, updateScriptRunsThisNodeCommandAsRoot: true,
    scope: "Benign local module-loading proof plus shell review; no elevated code or production update was executed.", temporaryDirectory: dir };
}

async function main() {
  await malformedUrl(); await sharedRateLimit(); await pendingLogins(); await updateDependencyExecution();
  await writeFile("docs/security-audit-2026-09-23/verification.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
