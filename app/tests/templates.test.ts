import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { createBot } from "../bot";
import { Database, one } from "../db";
import { Groups } from "../groups";
import { t } from "../i18n";
import { addGroups, config, seed, testDatabase } from "./helpers";

async function botHarness(database: Database) {
  const sent: any[] = []; let updateId = 0, runs = 0;
  const accounts = new Accounts(config, { async execute() { throw new Error("No real Telegram requests"); } });
  const makeBot = async () => {
    const bot = createBot(config, database, accounts, new Groups(accounts), { async run() { runs++; } } as any);
    bot.api.config.use(async (_previous, method, payload: any) => {
      sent.push({ method, ...payload });
      if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Bot" } } as any;
      return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: payload.chat_id ?? 101, type: "private" }, text: payload.text ?? "" } } as any;
    });
    await bot.init(); return bot;
  };
  let bot = await makeBot();
  return {
    sent, runs: () => runs,
    lastText: () => sent.filter(s => s.text).at(-1),
    restart: async () => { bot = await makeBot(); },
    callback: (data: string, owner = 101) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), from: { id: owner, is_bot: false, first_name: "User" }, data, chat_instance: "one",
      message: { message_id: 1, date: 0, chat: { id: owner, type: "private" }, text: "Menu" },
    } } as any),
    message: (text: string) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: updateId, date: 0, chat: { id: 101, type: "private" }, from: { id: 101, is_bot: false, first_name: "User" }, text,
    } } as any),
  };
}

test("large group lists paginate; creation and editing allow 30 recipients but reject 31", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const ids = await addGroups(database, 121);
    const h = await botHarness(database);
    const actions = () => h.lastText().reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data as string);
    const draft = async () => (await one(database, "SELECT data FROM user_states WHERE user_id=1")).data;
    const seen: string[] = [];
    for (let page = 0; page < Math.ceil(ids.length / 20); page++) {
      await h.callback(`groups:list_page:${page}`);
      assert.ok(actions().length <= 23);
      seen.push(...actions().filter((a: string) => a.startsWith("groups:show:")).map((a: string) => a.split(":")[2]));
    }
    assert.equal(new Set(seen).size, ids.length);
    await h.callback("ann:create"); await h.message("Thirty recipients");
    await h.callback("ann:groups_page:6");
    assert.ok(actions().includes("ann:group:1"));
    await h.callback("ann:group:1");
    await h.restart(); await h.callback("ann:groups_page:0");
    assert.deepEqual((await draft()).groups, ["1"]);
    for (const id of ids.slice(1, 30)) await h.callback(`ann:group:${id}`);
    assert.equal((await draft()).groups.length, 30);
    assert.match(h.lastText().text, /30\/30/);
    await h.callback(`ann:group:${ids[30]}`);
    assert.equal(h.lastText().text, t("validation.announcement_group_limit", { limit: 30 }));
    assert.equal((await draft()).groups.length, 30);
    await h.callback(`ann:group:${ids[0]}`); await h.callback(`ann:group:${ids[30]}`);
    assert.equal((await draft()).groups.length, 30);
    await h.callback("ann:groups_done"); await h.callback("ann:interval:5");
    await h.callback("ann:window:all"); await h.callback("ann:first:scheduled"); await h.callback("ann:save_template:no");
    const validDraft = await draft();
    // A draft saved by an older process is rechecked at final confirmation, including after a restart.
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify({ ...validDraft, groups: ids.slice(0, 31) })]);
    await h.restart(); await h.callback("ann:confirm");
    assert.equal(h.lastText().text, t("validation.announcement_group_limit", { limit: 30 }));
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify(validDraft)]);
    await h.callback("ann:confirm");
    const ad = await one(database, "SELECT * FROM announcements");
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcement_groups WHERE announcement_id=$1", [ad.id])).n, 30);
    await h.callback(`ann:edit_groups:${ad.id}`);
    const editDraft = await draft();
    await database.query("UPDATE users SET language='ru' WHERE id=1");
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify({ ...editDraft, groups: ids.slice(0, 31) })]);
    await h.callback("ann:groups_done");
    assert.equal(h.lastText().text, t("validation.announcement_group_limit", { limit: 30 }, "ru"));
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcement_groups WHERE announcement_id=$1", [ad.id])).n, 30);
    await h.callback(`ann:group:${ids[30]}`); await h.callback("ann:groups_done");
    assert.deepEqual((await database.query("SELECT group_id FROM announcement_groups WHERE announcement_id=$1 ORDER BY group_id", [ad.id])).rows.map(g => String(g.group_id)), ids.slice(0, 30));
  } finally { await pg.close(); }
});

test("oversized template drafts cannot save or launch; legacy templates allow reducing recipients for a new launch", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const ids = await addGroups(database, 29);
    const h = await botHarness(database);
    await h.callback("templates:create");
    const oversized = { kind: "template", step: "confirm", text: "Old draft", interval: 5, mode: "scheduled", groups: ids };
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1", [JSON.stringify(oversized)]);
    await h.callback("templates:save");
    assert.equal(h.lastText().text, t("validation.announcement_group_limit", { limit: 30 }));
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 0);
    const template = await one(database, "INSERT INTO templates(user_id,text,interval_minutes,first_run_mode) VALUES(1,'Legacy 31 groups',5,'scheduled') RETURNING id");
    await database.query("INSERT INTO template_groups(template_id,group_id) SELECT $1,unnest($2::bigint[])", [template.id, ids]);
    await h.callback(`templates:use:${template.id}`);
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.step, "groups");
    await h.callback("ann:confirm");
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    await h.callback(`ann:group:${ids[30]}`); await h.callback("ann:groups_done");
    await h.callback("ann:interval:5"); await h.callback("ann:window:all"); await h.callback("ann:first:scheduled");
    await h.callback("ann:confirm");
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcement_groups")).n, 30);
    assert.equal((await one(database, "SELECT count(*)::int n FROM template_groups WHERE template_id=$1", [template.id])).n, 31);
  } finally { await pg.close(); }
});

test("standalone template saves all settings without starting trial; launch copies contacts, groups and an overnight window", async context => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await database.query("UPDATE users SET paid_until=NULL WHERE id=1");
    const day = (await one(database, "SELECT now() current_time")).current_time.toISOString().slice(0, 10);
    context.mock.timers.enable({ apis: ["Date"], now: new Date(`${day}T07:00:00Z`) }); // 12:00 Tashkent, outside the window; same day as the DB trial clock.
    const h = await botHarness(database);
    await h.callback("templates:create"); await h.message("Ready for both groups");
    await h.callback("ann:group:1"); await h.callback("ann:group:2"); await h.callback("ann:groups_done");
    await h.callback("ann:interval:20"); await h.message("22:15-07:30"); await h.callback("ann:first:immediate");
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 0);
    assert.ok(!h.sent.some(s => s.text === t("announcements.save_template")));
    assert.match(h.lastText().text, /22:15–07:30/);
    assert.match(h.lastText().text, /Group one.*Group two/);
    await h.restart(); await h.callback("templates:save"); await h.callback("templates:save");
    const saved = await one(database, "SELECT * FROM templates");
    assert.equal(saved.text, "Ready for both groups"); assert.equal(saved.interval_minutes, 20);
    assert.equal(saved.send_start_minute, 1335); assert.equal(saved.send_end_minute, 450);
    assert.equal(saved.first_run_mode, "immediate");
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 1);
    assert.equal(h.runs(), 0);
    // Contacts saved by older versions still carry over, without exposing editing controls.
    await database.query("UPDATE templates SET contact_phone='+998901234567',contact_name='Contact name' WHERE id=$1", [saved.id]);
    const beforeUse = h.sent.length;
    await h.callback(`templates:use:${saved.id}`);
    assert.match(h.lastText().text, /Contact name\n\+998901234567/);
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.step, "confirm");
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    await h.restart(); await h.callback("ann:confirm"); await h.callback("ann:confirm");
    const ad = await one(database, "SELECT * FROM announcements");
    for (const field of ["text", "interval_minutes", "first_run_mode", "send_start_minute", "send_end_minute"]) assert.equal(ad[field], saved[field], field);
    assert.equal(ad.contact_phone, "+998901234567"); assert.equal(ad.contact_name, "Contact name");
    assert.equal(ad.next_run_at.toISOString(), `${day}T17:15:00.000Z`);
    assert.deepEqual((await database.query("SELECT group_id FROM announcement_groups WHERE announcement_id=$1 ORDER BY group_id", [ad.id])).rows.map(r => String(r.group_id)), ["1", "2"]);
    assert.ok((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 1);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 1);
    assert.equal(h.runs(), 1);
    assert.ok(!h.sent.slice(beforeUse).some(s => [t("announcements.save_template"), t("announcements.select_first_run"), t("announcements.select_groups", { count: 2, limit: 30 }), t("announcements.select_interval")].includes(s.text)));
  } finally { context.mock.timers.reset(); await pg.close(); }
});

test("legacy templates supply content for a new announcement without changing the saved template", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await database.query("UPDATE users SET paid_until=NULL WHERE id=1");
    const legacy = await one(database, `INSERT INTO templates(user_id,text,photo_file_id,photo_file_ids,contact_telegram)
      VALUES(1,'Legacy album','old-1','["old-1","old-2"]','@legacy_contact') RETURNING id`);
    const h = await botHarness(database);
    await h.callback("ann:create"); await h.callback("ann:create:template"); await h.callback(`ann:template:${legacy.id}`);
    assert.ok(h.sent.some(s => s.text === t("templates.needs_settings")));
    assert.equal(h.lastText().text, t("announcements.select_groups", { count: 0, limit: 30 }));
    await h.callback("ann:confirm");
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    await h.callback("ann:group:2"); await h.callback("ann:groups_done");
    await h.callback("ann:interval:60"); await h.callback("ann:window:all"); await h.callback("ann:first:scheduled");
    const template = await one(database, "SELECT * FROM templates WHERE id=$1", [legacy.id]);
    assert.equal(template.text, "Legacy album"); assert.deepEqual(template.photo_file_ids, ["old-1", "old-2"]);
    assert.equal(template.contact_telegram, "@legacy_contact"); assert.equal(template.interval_minutes, null);
    assert.equal(template.first_run_mode, null); assert.equal(template.send_start_minute, null); assert.equal(template.send_end_minute, null);
    assert.equal((await one(database, "SELECT trial_started_at FROM users WHERE id=1")).trial_started_at, null);
    await h.callback("ann:confirm");
    const ad = await one(database, "SELECT * FROM announcements");
    assert.deepEqual(ad.photo_file_ids, template.photo_file_ids); assert.equal(ad.contact_telegram, "@legacy_contact");
    assert.equal(ad.first_run_mode, "scheduled"); assert.equal(ad.interval_minutes, 60); assert.equal(ad.send_start_minute, null);
    assert.deepEqual(await one(database, "SELECT * FROM templates WHERE id=$1", [legacy.id]), template);
    assert.ok(ad.next_run_at.getTime() >= Date.now() + 59 * 60_000);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 1);
    assert.ok(!h.sent.some(s => s.text === t("announcements.save_template")));
    assert.equal(h.runs(), 0);
  } finally { await pg.close(); }
});

test("template launch enforces ownership, expiry, active limit and group access; reconnecting leaves the saved selection intact", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    const template = await one(database, "INSERT INTO templates(user_id,text,interval_minutes,first_run_mode) VALUES(1,'Saved selection',10,'scheduled') RETURNING id");
    await database.query("INSERT INTO template_groups(template_id,group_id) VALUES($1,1),($1,2)", [template.id]);
    const h = await botHarness(database);
    for (const action of [`templates:use:${template.id}`, `templates:settings:${template.id}`, `templates:edit_contact:${template.id}`]) {
      await h.callback(action, 202); assert.equal(h.lastText().text, t("common.not_found"));
    }
    await h.callback("ann:create", 202); await h.callback(`ann:template:${template.id}`, 202);
    assert.equal(h.lastText().text, t("common.not_found"));
    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=now()-interval '8 days',trial_ends_at=now()-interval '1 day' WHERE id=1");
    await h.callback(`templates:use:${template.id}`); assert.ok(h.lastText().text.startsWith(t("tariff.expired")));
    await database.query("UPDATE users SET paid_until='2100-01-01' WHERE id=1");
    await h.callback(`templates:use:${template.id}`);
    await database.query("UPDATE users SET paid_until=NULL WHERE id=1");
    await h.callback("ann:confirm"); assert.ok(h.lastText().text.startsWith(t("tariff.expired")));
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    await database.query("UPDATE users SET paid_until='2100-01-01' WHERE id=1");
    await database.query("INSERT INTO announcements(user_id,text,interval_minutes,first_run_mode) SELECT 1,'Active',5,'scheduled' FROM generate_series(1,$1::int)", [config.maxAnnouncements]);
    await h.callback("ann:confirm"); assert.equal(h.lastText().text, t("validation.limit_reached"));
    await database.query("DELETE FROM announcements WHERE text='Active'");
    await database.query("DELETE FROM user_groups WHERE user_id=1 AND group_id=2");
    await h.callback("ann:confirm"); assert.equal(h.lastText().text, t("templates.groups_unavailable"));
    assert.ok(h.lastText().reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "groups:add"));
    await h.callback(`templates:use:${template.id}`); assert.equal(h.lastText().text, t("templates.groups_unavailable"));
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM template_groups")).n, 2);
    await h.callback(`templates:settings:${template.id}`); assert.equal(h.lastText().text, t("common.not_found"));
    await database.query("INSERT INTO user_groups(user_id,group_id,connected_by_telegram_id,can_post,access_hash) VALUES(1,2,101,true,'112')");
    await h.callback("groups:continue");
    assert.equal((await one(database, "SELECT data FROM user_states WHERE user_id=1")).data.step, "confirm");
    await h.callback("ann:confirm");
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements")).n, 1);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcement_groups")).n, 2);
    assert.equal((await one(database, "SELECT count(*)::int n FROM template_groups")).n, 2);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 1);
    // Template deletion keeps the independently running announcement and its selected groups.
    await h.callback(`templates:delete:${template.id}`); await h.callback(`templates:delete_confirm:${template.id}`);
    assert.equal((await one(database, "SELECT count(*)::int n FROM templates")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM template_groups")).n, 0);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcements WHERE status='active'")).n, 1);
    assert.equal((await one(database, "SELECT count(*)::int n FROM announcement_groups")).n, 2);
  } finally { await pg.close(); }
});
