import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { one, Queryable } from "../db";
import { AccountGroup, Groups } from "../groups";
import { Failure } from "../telegram";
import { config, seed, testDatabase } from "./helpers";

const candidate: AccountGroup = { chatId: "-100123", title: "First group", chatType: "supergroup",
  accessHash: "111", canPost: true, isAdmin: false };

test("connecting and reconnecting groups stays unlimited beyond 30 recipients", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    const accounts = new Accounts(config, { async execute() { throw new Error("No Telegram requests expected"); } });
    const groups = new Groups(accounts);
    for (let i = 0; i < 60; i++) await groups.connect(database, "1", { ...candidate, chatId: `-200${i}`, title: `Extra ${i}` });
    await database.query("UPDATE user_groups SET is_active=false WHERE user_id=1 AND group_id=1");
    await groups.connect(database, "1", candidate);
    await groups.connect(database, "1", candidate);
    assert.equal((await groups.list(database, "1")).length, 62);
    assert.equal((await groups.list(database, "2")).length, 1);
    await assert.rejects(groups.connect(database, "1", { ...candidate, chatId: "-99999", canPost: false }), { code: "CHAT_WRITE_FORBIDDEN" });
  } finally { await pg.close(); }
});

test("group discovery batches hundreds of peers and reuses a per-account cache across restarts", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    let queries = 0; const calls: string[] = [];
    const measured: Queryable = { async query(sql, values) { queries++; return database.query(sql, values); } };
    const accounts = new Accounts(config, { async execute(_method, p) {
      calls.push(p.userId);
      return { groups: p.userId === "1" ? [candidate, ...Array.from({ length: 300 }, (_, i) =>
        ({ ...candidate, chatId: `-100${i + 1000}`, title: `Group ${i}` }))] : [{ ...candidate, title: "Second account", accessHash: "222" }] };
    } });
    let groups = new Groups(accounts);
    assert.equal((await groups.discover(measured, "1")).groups.length, 301);
    assert.ok(queries <= 7, `Expected a bounded number of queries, got ${queries}`);
    assert.equal((await groups.list(database, "1")).length, 2); // No implicit subscriptions.
    assert.equal((await one(database, "SELECT access_hash FROM user_groups WHERE user_id=1 AND group_id=2")).access_hash, "112");
    groups = new Groups(accounts);
    assert.equal((await groups.discover(database, "1")).cached, true);
    assert.equal((await groups.discover(database, "1", true)).cached, true); // Refresh button is throttled too.
    assert.deepEqual(calls, ["1"]);
    assert.equal((await groups.discover(database, "2")).groups[0].accessHash, "222");
    assert.deepEqual(calls, ["1", "2"]);
    await database.query("UPDATE telegram_group_cache SET fetched_at=now()-interval '61 seconds' WHERE user_id=1");
    assert.equal((await groups.discover(database, "1")).cached, true);
    assert.equal((await groups.discover(database, "1", true)).cached, false);
    await database.query("UPDATE telegram_group_cache SET fetched_at=now()-interval '6 minutes' WHERE user_id=1");
    assert.equal((await groups.discover(database, "1")).cached, false);
    assert.deepEqual(calls, ["1", "2", "1", "1"]);
  } finally { await pg.close(); }
});

test("discovery FloodWait persists without cached data and suppresses repeated API requests", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); let calls = 0;
    const accounts = new Accounts(config, { async execute() { calls++; throw new Failure("FLOOD_WAIT", 120); } });
    // As in the bot middleware, commit the cooldown before showing the recoverable failure.
    const outcome = await database.transaction(async db => {
      try { return await new Groups(accounts).discover(db, "1"); } catch (error) { return error; }
    });
    assert.ok(outcome instanceof Failure); assert.equal(outcome.code, "GROUPS_RATE_LIMITED"); assert.equal(outcome.seconds, 120);
    const cached = await one(database, "SELECT * FROM telegram_group_cache WHERE user_id=1");
    assert.equal(cached.groups, null); assert.ok(cached.retry_after > new Date());
    await assert.rejects(new Groups(accounts).discover(database, "1", true), (error: any) =>
      error.code === "GROUPS_RATE_LIMITED" && error.seconds > 0 && error.seconds <= 120);
    assert.equal(calls, 1);
    assert.equal((await one(database, "SELECT retry_after FROM telegram_accounts WHERE user_id=1")).retry_after, null);
    assert.equal((await one(database, "SELECT can_post FROM user_groups WHERE user_id=1 AND group_id=1")).can_post, true);
  } finally { await pg.close(); }
});

test("limited refresh keeps old groups available; logout clears cached hashes and cooldown", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); let calls = 0;
    const accounts = new Accounts(config, { async execute() {
      if (++calls > 1) throw new Failure("FLOOD_WAIT", 180);
      return { groups: [candidate] };
    } });
    const groups = new Groups(accounts);
    await groups.discover(database, "1");
    await database.query("UPDATE telegram_group_cache SET fetched_at=now()-interval '6 minutes'");
    const result = await groups.discover(database, "1");
    assert.deepEqual(result.groups, [candidate]); assert.equal(result.cached, true); assert.ok(result.retryAfter! > new Date());
    assert.deepEqual((await new Groups(accounts).discover(database, "1", true)).groups, [candidate]);
    assert.equal(calls, 2);
    await accounts.invalidate(database, "1");
    assert.equal(await one(database, "SELECT * FROM telegram_group_cache WHERE user_id=1"), undefined);
    await assert.rejects(groups.discover(database, "1"), { code: "LOGIN_REQUIRED" });
    assert.equal(calls, 2);
  } finally { await pg.close(); }
});
