import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { one } from "../db";
import { Delivery } from "../delivery";
import { Groups } from "../groups";
import { Failure } from "../telegram";
import { addGroups, announcement, config, seed, testDatabase } from "./helpers";

test("delivery never exceeds 30 targets across retries, even for a legacy oversized announcement", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const ids = await addGroups(database, 33);
    const id = await announcement(database, "1", ids);
    const sent: string[] = [];
    const accounts = new Accounts(config, { async execute(_method, params) {
      sent.push(params.chatId); return { messageIds: [sent.length] };
    } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    await delivery.run();
    assert.equal(sent.length, 20); // The independent per-minute rate limit still applies.
    assert.ok((await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at);
    // Lost access in the first page must not replace that recipient with a 31st group after a retry.
    await database.query("UPDATE user_groups SET can_post=false WHERE user_id=1 AND group_id=1");
    await database.query("UPDATE delivery_logs SET sent_at=now()-interval '2 minutes' WHERE announcement_id=$1", [id]);
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    await new Delivery(database, config, accounts, {} as any).run();
    assert.equal(sent.length, 30); assert.equal(new Set(sent).size, 30);
    const delivered = (await database.query("SELECT group_id FROM delivery_logs WHERE announcement_id=$1 AND status='sent' ORDER BY group_id", [id])).rows.map(g => String(g.group_id));
    assert.deepEqual(delivered, ids.slice(0, 30));
    assert.equal((await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at, null);
    assert.equal((await one(database, "SELECT count(*)::int n FROM user_groups WHERE user_id=1")).n, 35);
  } finally { await pg.close(); }
});

test("outside daily hours no messages or photos are requested; other announcements stay independent", async context => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const limited = await announcement(database, "1", ["1"]); await announcement(database, "2", ["1"]);
    await database.query("UPDATE announcements SET send_start_minute=420,send_end_minute=1320,photo_file_ids='[\"photo\"]' WHERE id=$1", [limited]);
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-01T18:00:00Z") });
    const calls: any[] = [];
    const accounts = new Accounts(config, { async execute(_method, params) { calls.push(params); return { messageIds: [1] }; } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    (delivery as any).downloadPhotos = async (ids: string[]) => { assert.equal(ids.length, 0); return []; };
    await delivery.run();
    assert.deepEqual(calls.map(c => c.userId), ["2"]);
    const a = await one(database, "SELECT * FROM announcements WHERE id=$1", [limited]);
    assert.equal(a.next_run_at.toISOString(), "2030-06-02T02:00:00.000Z");
    assert.equal(a.last_run_at, null); assert.equal(a.delivery_cycle_at, null);
    assert.equal((await one(database, "SELECT count(*)::int n FROM delivery_logs WHERE announcement_id=$1", [limited])).n, 0);
  } finally { context.mock.timers.reset(); await pg.close(); }
});

test("a batch crossing closing time resumes next morning without repeating completed groups", async context => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE announcements SET send_start_minute=420,send_end_minute=1320 WHERE id=$1", [id]);
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-01T16:59:59Z") });
    const calls: any[] = [];
    const accounts = new Accounts(config, { async execute(_method, params) {
      calls.push(params);
      if (calls.length === 1) context.mock.timers.setTime(Date.parse("2030-06-01T17:00:00Z"));
      return { messageIds: [calls.length] };
    } });
    await new Delivery(database, config, accounts, {} as any).run();
    assert.equal(calls.length, 1); assert.equal(calls[0].sendBefore, Date.parse("2030-06-01T17:00:00Z"));
    const a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(a.next_run_at.toISOString(), "2030-06-02T02:00:00.000Z"); assert.ok(a.delivery_cycle_at);
    context.mock.timers.setTime(Date.parse("2030-06-02T02:00:00Z"));
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    await new Delivery(database, config, accounts, {} as any).run();
    assert.deepEqual(calls.map(c => c.chatId), ["-100123", "-100456"]);
    assert.ok(calls[1].deliveryKey.endsWith(a.delivery_cycle_at.toISOString()));
    assert.equal((await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at, null);
  } finally { context.mock.timers.reset(); await pg.close(); }
});

test("photo preparation crossing the window and a late FloodWait both defer until opening", async context => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]);
    await database.query("UPDATE announcements SET send_start_minute=420,send_end_minute=1320,photo_file_ids='[\"photo\"]' WHERE id=$1", [id]);
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-01T16:59:59Z") });
    let calls = 0;
    const accounts = new Accounts(config, { async execute() { calls++; throw new Failure("FLOOD_WAIT", 120); } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    (delivery as any).downloadPhotos = async () => { context.mock.timers.setTime(Date.parse("2030-06-01T17:00:00Z")); return ["photo-payload"]; };
    await delivery.run(); assert.equal(calls, 0);
    let a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(a.next_run_at.toISOString(), "2030-06-02T02:00:00.000Z");
    assert.equal((await one(database, "SELECT error_code FROM delivery_logs WHERE announcement_id=$1", [id])).error_code, "OUTSIDE_SEND_WINDOW");
    assert.equal((await one(database, "SELECT retry_after FROM telegram_accounts WHERE user_id=1")).retry_after, null);
    context.mock.timers.setTime(Date.parse("2030-06-02T16:59:00Z"));
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second',photo_file_ids=NULL WHERE id=$1", [id]);
    await new Delivery(database, config, accounts, {} as any).run();
    a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.equal(calls, 1); assert.equal(a.next_run_at.toISOString(), "2030-06-03T02:00:00.000Z");
    // The account-wide Telegram cooldown is not extended to this announcement's next opening.
    assert.equal((await one(database, "SELECT retry_after FROM telegram_accounts WHERE user_id=1")).retry_after.toISOString(), "2030-06-02T17:01:00.000Z");
  } finally { context.mock.timers.reset(); await pg.close(); }
});

test("FloodWait resumes the same cycle without duplicating a successful group", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    const calls: any[] = []; let limited = true;
    const accounts = new Accounts(config, { async execute(method, p) {
      calls.push({ method, ...p });
      if (p.chatId === "-100456" && limited) { limited = false; throw new Failure("FLOOD_WAIT", 120); }
      return { messageIds: [calls.length + 10] };
    } });
    const bot = { sendMessage: async () => { throw new Error("Bot must not publish"); } } as any;
    const delivery = new Delivery(database, config, accounts, bot);
    await delivery.run();
    assert.deepEqual(calls.map(c => c.chatId), ["-100123", "-100456"]);
    assert.equal(calls[0].session, "session-1"); assert.equal(calls[0].expectedId, "101");
    const a = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.ok(a.delivery_cycle_at); assert.ok(a.next_run_at > new Date());
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second'");
    await database.query("UPDATE telegram_accounts SET retry_after=NULL");
    // A newly created scheduler simulates restart; previous successful delivery remains in the DB.
    await new Delivery(database, config, accounts, bot).run();
    assert.equal(calls.length, 3); assert.equal(calls[2].chatId, "-100456");
    assert.equal(calls[1].deliveryKey, calls[2].deliveryKey);
    assert.equal((await one(database, "SELECT count(*)::int n FROM delivery_logs WHERE status='sent'")).n, 2);
    assert.equal((await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at, null);
  } finally { await pg.close(); }
});
test("same group uses separate accounts, hashes and per-user access failures", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await announcement(database, "1", ["1"]); await announcement(database, "2", ["1"]);
    const calls: any[] = [];
    const accounts = new Accounts(config, { async execute(method, p) {
      calls.push(p); if (p.userId === "1") throw new Failure("CHAT_WRITE_FORBIDDEN"); return { messageIds: [22] };
    } });
    await new Delivery(database, config, accounts, { sendMessage: async () => {} } as any).run();
    assert.deepEqual(calls.map(c => [c.userId, c.accessHash, c.session]), [["1", "111", "session-1"], ["2", "222", "session-2"]]);
    const connections = (await database.query("SELECT user_id,can_post FROM user_groups WHERE group_id=1 ORDER BY user_id")).rows;
    assert.deepEqual(connections.map(c => c.can_post), [false, true]);
  } finally { await pg.close(); }
});
test("disconnected users and paused announcements are never sent", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await announcement(database, "1"); const second = await announcement(database, "2", ["1"]);
    await database.query("DELETE FROM telegram_accounts WHERE user_id=1");
    await database.query("UPDATE announcements SET status='paused' WHERE id=$1", [second]);
    let sends = 0;
    const accounts = new Accounts(config, { async execute() { sends++; return { messageIds: [1] }; } });
    await new Delivery(database, config, accounts, {} as any).run(); assert.equal(sends, 0);
  } finally { await pg.close(); }
});
test("discovery requires explicit selection and refreshes only the user's permissions", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    const groups = new Groups(new Accounts(config, { async execute() { return { groups: [
      { chatId: "-100123", title: "Changed", chatType: "supergroup", canPost: false, isAdmin: false, accessHash: "new" },
      { chatId: "-100999", title: "New", chatType: "supergroup", canPost: true, isAdmin: false, accessHash: "999" },
    ] }; } }));
    const found = await groups.discover(database, "1");
    assert.equal((await groups.list(database, "1")).length, 2);
    assert.equal((await groups.list(database, "2"))[0].can_post, true);
    await groups.connect(database, "1", found.groups[1]);
    assert.equal((await groups.list(database, "1")).length, 3);
  } finally { await pg.close(); }
});
test("deletion selects the original sender and refuses another owner's announcements", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]);
    await database.query(`INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status,telegram_message_ids,sender_telegram_id)
      VALUES($1,1,now(),'sent','[1,2]',101),($1,1,now()-interval '1 minute','sent','[3]',NULL)`, [id]);
    const calls: any[] = [], botDeletes: any[] = [];
    const accounts = new Accounts(config, { async execute(method, p) { calls.push({ method, ...p }); return {}; } });
    const delivery = new Delivery(database, config, accounts, { deleteMessage: async (...args: any[]) => botDeletes.push(args) } as any);
    await delivery.removePublished(database, "2", id); assert.equal(calls.length, 0); assert.equal(botDeletes.length, 0);
    await delivery.removePublished(database, "1", id);
    assert.equal(calls[0].method, "delete"); assert.equal(calls[0].session, "session-1"); assert.deepEqual(calls[0].messageIds, [1, 2]);
    assert.deepEqual(botDeletes, [["-100123", 3]]);
  } finally { await pg.close(); }
});

test("an album is downloaded once per announcement and reused for all target groups", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE announcements SET photo_file_ids=$2 WHERE id=$1", [id, JSON.stringify(["one", "two"])]);
    const calls: any[] = []; let downloads = 0;
    const accounts = new Accounts(config, { async execute(_method, p) { calls.push(p); return { messageIds: [10, 11] }; } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    (delivery as any).downloadPhotos = async (ids: string[]) => { downloads++; assert.deepEqual(ids, ["one", "two"]); return ["payload-1", "payload-2"]; };
    await delivery.run();
    assert.equal(downloads, 1); assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(c => c.photos), [["payload-1", "payload-2"], ["payload-1", "payload-2"]]);
  } finally { await pg.close(); }
});

test("resuming text after acknowledged photos does not download the album again", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]);
    const sources = Array.from({ length: 10 }, (_, i) => i + 100), sentIds = sources.map(id => id + 100);
    await database.query("UPDATE announcements SET text=$2,photo_message_ids=$3 WHERE id=$1", [id, "A".repeat(1100), JSON.stringify(sources)]);
    await database.query(`INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status,sender_telegram_id,telegram_message_ids)
      SELECT id,1,next_run_at,'rate_limited',101,$2 FROM announcements WHERE id=$1`, [id, JSON.stringify(sentIds)]);
    const calls: any[] = [];
    const accounts = new Accounts(config, { async execute(method, p) {
      assert.equal(method, "send", "Already published photos must not be fetched from source messages again");
      calls.push(p); return { messageIds: [...sentIds, 999] };
    } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    (delivery as any).downloadPhotos = async () => { throw new Error("Already published photos must not be downloaded"); };
    await delivery.run();
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].messageIds, sentIds); assert.equal(calls[0].photos.length, 10);
    assert.equal((await one(database, "SELECT status FROM delivery_logs WHERE announcement_id=$1", [id])).status, "sent");
  } finally { await pg.close(); }
});
