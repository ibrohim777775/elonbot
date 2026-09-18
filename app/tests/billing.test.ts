import { test } from "node:test";
import assert from "node:assert/strict";
import { createBot } from "../bot";
import { Accounts } from "../accounts";
import { Groups } from "../groups";
import { Support } from "../support";
import { Delivery } from "../delivery";
import { planState, requireCreationAccess } from "../billing";
import { one } from "../db";
import { Failure } from "../telegram";
import { t } from "../i18n";
import { parseClockTime } from "../schedule";
import { announcement, config, seed, testDatabase } from "./helpers";

test("manual time accepts hours and minutes, allows 24:00 only as the end", () => {
  assert.equal(parseClockTime("7"), 420); assert.equal(parseClockTime("07:30"), 450);
  assert.equal(parseClockTime("24:00", true), 1440);
  for (const value of ["24:00", "-1", "7:99", "25", "7.5", ""]) assert.equal(parseClockTime(value), undefined);
  assert.equal(parseClockTime("24:01", true), undefined);
});

test("trial starts once on first confirmed announcement; support preserves drafts and works after expiry; admin command is restricted", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await database.query("UPDATE users SET paid_until=NULL");
    const accounts = new Accounts(config, { async execute() { throw new Error("No real account actions"); } });
    const sent: any[] = [], support = new Support(database, config, {} as any);
    support.notify = async () => {};
    const bot = createBot(config, database, accounts, new Groups(accounts), { run: async () => {} } as any, support);
    bot.api.config.use(async (_previous, method, payload: any) => {
      sent.push({ method, ...payload });
      if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot" } } as any;
      return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
    });
    await bot.init(); let updateId = 0;
    const message = (text: string, extra = {}, owner = 101) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 0, from: { id: owner, is_bot: false, first_name: "User" }, chat: { id: owner, type: "private" }, text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}), ...extra,
    } } as any);
    const callback = (data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: { id: String(updateId), from: { id: 101, is_bot: false, first_name: "User" }, data, chat_instance: "one", message: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: "Menu" } } } as any);
    await message("/start"); await callback("ann:create");
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    await message(t("menu.support")); await message("Please help");
    assert.equal((await one(database, "SELECT text FROM support_messages WHERE user_id=1")).text, "Please help");
    const draft = (await one(database, "SELECT data FROM user_states WHERE user_id=1")).data;
    assert.equal(draft.kind, "announcement"); assert.equal(draft.step, "content"); assert.equal(draft.text, undefined);
    await callback("support:done"); await message("First announcement");
    await callback("ann:group:1"); await callback("ann:groups_done"); await callback("ann:interval:5");
    await message("7:30"); await callback("ann:clock:end:1440");
    await callback("ann:first:scheduled"); await callback("ann:save_template:no");
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    await callback("ann:confirm");
    const user = await one(database, "SELECT * FROM users WHERE id=1");
    assert.equal(user.trial_ends_at.getTime() - user.trial_started_at.getTime(), 7 * 86400000);
    assert.equal(planState(user).status, "trial");
    const ad = await one(database, "SELECT * FROM announcements WHERE user_id=1");
    assert.equal(ad.text, "First announcement"); assert.equal(ad.send_start_minute, 450); assert.equal(ad.send_end_minute, 1440);
    await database.query("DELETE FROM announcements WHERE user_id=1");
    await requireCreationAccess(database, "1", true);
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at.getTime(), user.trial_started_at.getTime());
    // Expire while an already-open creation draft exists: confirmation must also enforce access.
    const pending = { kind: "announcement", step: "confirm", text: "Expired draft", interval: 5, groups: ["1"], mode: "scheduled" };
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify(pending)]);
    await database.query("UPDATE users SET trial_ends_at=now()-interval '1 second' WHERE id=1");
    await callback("ann:confirm"); assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    assert.match(sent.at(-1).text, /Tarif muddati tugadi/);
    await callback("ann:create"); assert.match(sent.at(-1).text, /Tarif muddati tugadi/);
    await message("/support"); await message("Please activate tariff");
    assert.equal((await one(database, "SELECT count(*)::int n FROM support_messages WHERE user_id=1")).n, 2);
    await callback("support:done");
    await database.query("INSERT INTO support_messages(user_id,direction,text,telegram_message_id,delivery_status) VALUES(1,'out','Admin answer',900,'sent')");
    await message("Reply without support mode", { reply_to_message: { message_id: 900, date: 0, chat: { id: 101, type: "private" }, text: "Admin answer" } });
    assert.equal((await one(database, "SELECT count(*)::int n FROM support_messages WHERE user_id=1 AND direction='in'")).n, 3);
    await message("/admin"); assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].web_app.url, `${config.baseUrl}/admin`);
    await message("/admin", {}, 202); assert.equal(sent.at(-1).text, t("common.access_denied"));
  } finally { await pg.close(); }
});

test("expired access excludes deliveries and photo requests; renewal resumes existing announcements", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]); await announcement(database, "2", ["1"]);
    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=now()-interval '8 days',trial_ends_at=now()-interval '1 day' WHERE id=1");
    await database.query("UPDATE announcements SET photo_file_ids='[\"photo\"]' WHERE id=$1", [id]);
    const calls: any[] = [];
    const accounts = new Accounts(config, { async execute(_method, params) { calls.push(params); return { messageIds: [99] }; } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    (delivery as any).downloadPhotos = async (ids: string[]) => { assert.equal(ids.length, 0); return []; };
    await delivery.run(); assert.deepEqual(calls.map(c => c.userId), ["2"]);
    assert.equal((await one(database, "SELECT status,last_run_at FROM announcements WHERE id=$1", [id])).last_run_at, null);
    await database.query("UPDATE users SET paid_until=now()+interval '30 days' WHERE id=1");
    (delivery as any).downloadPhotos = async () => ["fake"];
    await delivery.run(); assert.deepEqual(calls.map(c => c.userId), ["2", "1"]);
    assert.ok(calls[1].subscriptionBefore > Date.now());
  } finally { await pg.close(); }
});

test("expiry during photo preparation or partial publication preserves the cycle and acknowledged IDs", async context => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "1", ["1"]);
    const now = Date.now(), deadline = now + 10_000;
    await database.query("UPDATE users SET paid_until=$1 WHERE id=1", [new Date(deadline)]);
    await database.query("UPDATE announcements SET photo_file_ids='[\"photo\"]' WHERE id=$1", [id]);
    context.mock.timers.enable({ apis: ["Date"], now });
    const calls: any[] = []; let partial = false;
    const accounts = new Accounts(config, { async execute(_method, params) {
      calls.push(params);
      if (partial) throw new Failure("SUBSCRIPTION_EXPIRED", 0, [41]);
      return { messageIds: [41, 42] };
    } });
    const delivery = new Delivery(database, config, accounts, {} as any);
    (delivery as any).downloadPhotos = async () => { context.mock.timers.setTime(deadline); return ["fake"]; };
    await delivery.run(); assert.equal(calls.length, 0);
    let log = await one(database, "SELECT * FROM delivery_logs WHERE announcement_id=$1", [id]);
    assert.equal(log.error_code, "SUBSCRIPTION_EXPIRED"); assert.equal(log.status, "rate_limited");
    const cycle = (await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at;
    await database.query("UPDATE users SET paid_until='2100-01-01' WHERE id=1");
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    (delivery as any).downloadPhotos = async () => ["fake"];
    partial = true; await delivery.run();
    log = await one(database, "SELECT * FROM delivery_logs WHERE announcement_id=$1", [id]);
    assert.deepEqual(log.telegram_message_ids, [41]);
    assert.equal((await one(database, "SELECT delivery_cycle_at FROM announcements WHERE id=$1", [id])).delivery_cycle_at.getTime(), cycle.getTime());
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    // Partial sends count toward the group rate limit; advance the stored accounting time too.
    await database.query("UPDATE delivery_logs SET sent_at=now()-interval '2 minutes' WHERE announcement_id=$1", [id]);
    partial = false; await delivery.run();
    assert.deepEqual(calls.at(-1).messageIds, [41]);
    assert.equal((await one(database, "SELECT status FROM delivery_logs WHERE announcement_id=$1", [id])).status, "sent");
    assert.equal((await one(database, "SELECT count(*)::int n FROM telegram_accounts WHERE user_id=1")).n, 1);
  } finally { context.mock.timers.reset(); await pg.close(); }
});
