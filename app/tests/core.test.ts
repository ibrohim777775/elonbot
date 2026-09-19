import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts, tokenHash } from "../accounts";
import { loadConfig } from "../config";
import { decryptSession, encryptSession } from "../crypto";
import { one } from "../db";
import { renderText } from "../delivery";
import { migrate } from "../migrate";
import { Failure, safeError } from "../telegram";
import { announcement, config, seed, testDatabase } from "./helpers";

test("configuration requires API data and a durable valid key; legacy DB URL accepted", () => {
  const env = { BOT_TOKEN: config.botToken, DATABASE_URL: "postgresql+asyncpg://localhost/test", TELEGRAM_API_ID: "1234", TELEGRAM_API_HASH: config.apiHash,
    SESSION_ENCRYPTION_KEY: config.encryptionKey.toString("base64"), WEBHOOK_BASE_URL: config.baseUrl, WEBHOOK_SECRET: config.webhookSecret, ADMIN_IDS: "101, 202" };
  assert.equal(loadConfig(env).databaseUrl, "postgresql://localhost/test");
  assert.deepEqual(loadConfig(env).adminIds, ["101", "202"]);
  assert.equal(loadConfig({ ...env, MAX_GROUPS_PER_USER: "20" }).maxGroupsPerAnnouncement, 30);
  assert.equal(loadConfig({ ...env, MAX_GROUPS_PER_ANNOUNCEMENT: "15" }).maxGroupsPerAnnouncement, 15);
  assert.throws(() => loadConfig({ ...env, MAX_GROUPS_PER_ANNOUNCEMENT: "0" }));
  assert.throws(() => loadConfig({ ...env, TELEGRAM_API_ID: "" }));
  assert.throws(() => loadConfig({ ...env, SESSION_ENCRYPTION_KEY: "bad" }));
  assert.throws(() => loadConfig({ ...env, WEBHOOK_BASE_URL: "http://example.test" }));
});
test("AES-GCM session encryption rejects wrong owner, key and modified ciphertext", () => {
  const encrypted = encryptSession("secret-session", config.encryptionKey, "1");
  assert.equal(decryptSession(encrypted, config.encryptionKey, "1"), "secret-session");
  assert.ok(!encrypted.includes("secret-session"));
  assert.throws(() => decryptSession(encrypted, config.encryptionKey, "2"));
  assert.throws(() => decryptSession(encrypted, Buffer.alloc(32), "1"));
  assert.throws(() => decryptSession(encrypted.slice(0, -5) + "AAAAA", config.encryptionKey, "1"));
});
test("delivery formatting preserves HTML escaping and optional contacts", () => {
  assert.equal(renderText({ text: "A&B <sale>", contact_name: "Aziz", contact_phone: "+998901234567", contact_telegram: "@aziz" }),
    'A&amp;B &lt;sale&gt;\n\nAziz\nTel: +998901234567\nTelegram: <a href="https://t.me/aziz">@aziz</a>');
  assert.equal(safeError(new Error("password=super-secret")).code, "TELEGRAM_UNAVAILABLE");
});
test("migration is repeatable and preserves users, albums, schedules and prior bot deliveries", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    await database.query("INSERT INTO templates(user_id,text,photo_file_id,photo_file_ids) VALUES(1,'Old','one','[\"one\",\"two\"]')");
    await announcement(database, "1", ["1"]);
    // Existing TypeScript installs have already applied 001 but do not have the cache table.
    await database.query("DROP TABLE telegram_group_cache");
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
    await database.query("INSERT INTO schema_migrations(version) VALUES('001_typescript')");
    await migrate(database); await migrate(database);
    const trial = await one(database, "SELECT trial_started_at,trial_ends_at FROM users WHERE id=1");
    assert.equal(trial.trial_ends_at.getTime() - trial.trial_started_at.getTime(), 7 * 86400000);
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=2")).trial_started_at, null);
    await migrate(database);
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at.getTime(), trial.trial_started_at.getTime());
    assert.equal((await one(database, "SELECT count(*)::int n FROM users")).n, 2);
    assert.deepEqual((await one(database, "SELECT photo_file_ids FROM templates")).photo_file_ids, ["one", "two"]);
    assert.equal((await one(database, "SELECT count(*)::int n FROM schema_migrations")).n, 7);
    assert.equal((await one(database, "SELECT interval_minutes FROM templates")).interval_minutes, null);
    assert.equal((await one(database, "SELECT count(*)::int n FROM telegram_group_cache")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM telegram_accounts")).n, 2);
  } finally { await pg.close(); }
});
test("upgrade from the prior schema retains delivery history and requires user permission refresh", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query(`INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status,telegram_message_id,telegram_message_ids)
      VALUES($1,1,now(),'sent',42,'[41,42]')`, [id]);
    await pg.exec(`DROP TABLE telegram_group_cache,telegram_accounts,account_logins,user_states,processed_updates,reply_notifications;
      ALTER TABLE user_groups DROP COLUMN can_post,DROP COLUMN is_admin,DROP COLUMN access_hash,DROP COLUMN retry_after;
      ALTER TABLE announcements DROP COLUMN delivery_cycle_at;
      ALTER TABLE delivery_logs DROP COLUMN sender_telegram_id;`);
    await migrate(database);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 1);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcement_groups")).n, 2);
    const log = await one(database, "SELECT * FROM delivery_logs");
    assert.deepEqual(log.telegram_message_ids, [41, 42]); assert.equal(log.sender_telegram_id, null);
    assert.equal((await one(database, "SELECT count(*)::int n FROM user_groups WHERE can_post")).n, 0);
  } finally { await pg.close(); }
});
test("login binds owner, encrypts session, consumes link and counts wrong code attempts", async () => {
  const { pg, database } = await testDatabase();
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101)");
    const calls: any[] = [];
    const accounts = new Accounts(config, { async execute(method, params) {
      calls.push({ method, params });
      if (params.value === "bad") throw new Failure("PHONE_CODE_INVALID");
      return method === "login.begin" ? { stage: "code" } : { stage: "done", telegramId: "101", session: "raw-private-session" };
    } });
    const token = (await accounts.link(database, "1")).split("#")[1];
    assert.equal((await accounts.login(database, token, "begin", "+998901234567")).stage, "code");
    await assert.rejects(accounts.login(database, token, "code", "bad"), { code: "PHONE_CODE_INVALID" });
    assert.equal((await one(database, "SELECT attempts FROM account_logins")).attempts, 2);
    await accounts.login(database, token, "code", "12345");
    assert.equal(calls[0].params.expectedId, "101");
    const saved = await one(database, "SELECT encrypted_session FROM telegram_accounts");
    assert.ok(!saved.encrypted_session.includes("raw-private-session"));
    assert.equal((await accounts.params(database, "1")).session, "raw-private-session");
    await assert.rejects(accounts.login(database, token, "code", "12345"), { code: "LOGIN_EXPIRED" });
    const dump = JSON.stringify((await database.query("SELECT * FROM account_logins")).rows);
    assert.ok(!dump.includes(token));
  } finally { await pg.close(); }
});
test("expired, exhausted or mismatched login cannot save an account", async () => {
  const { pg, database } = await testDatabase();
  try {
    await database.query("INSERT INTO users(id,telegram_id) VALUES(1,101)");
    const accounts = new Accounts(config, { async execute() { return { stage: "done", telegramId: "202", session: "other" }; } });
    const token = (await accounts.link(database, "1")).split("#")[1];
    await assert.rejects(accounts.login(database, token, "code", "12345"), { code: "ACCOUNT_MISMATCH" });
    assert.equal((await one(database, "SELECT count(*)::int n FROM telegram_accounts")).n, 0);
    await database.query("UPDATE account_logins SET attempts=10 WHERE token_hash=$1", [tokenHash(token)]);
    await assert.rejects(accounts.login(database, token, "code", "12345"), { code: "LOGIN_EXPIRED" });
    await database.query("UPDATE account_logins SET attempts=0,expires_at=now()-interval '1 second'");
    await assert.rejects(accounts.login(database, token, "code", "12345"), { code: "LOGIN_EXPIRED" });
  } finally { await pg.close(); }
});
