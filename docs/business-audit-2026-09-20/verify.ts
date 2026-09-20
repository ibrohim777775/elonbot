// Audit probes: isolated PGlite and mocked Telegram only. Run from the repository root.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Accounts } from "../../app/accounts";
import { createBot } from "../../app/bot";
import { Delivery } from "../../app/delivery";
import { one } from "../../app/db";
import { Groups } from "../../app/groups";
import { TelegramService, peer } from "../../app/telegram";
import { announcement, config, seed, testDatabase } from "../../app/tests/helpers";

async function main() {
  if (!Object.hasOwn(config, "maxDaily")) throw new Error("Historical audit: run this probe against commit 94482aa before the daily quota was retired. Current delivery rules are covered by app/tests/delivery.test.ts.");
  const { pg, database } = await testDatabase();
  const results: Record<string, unknown>[] = [];
  try {
    await seed(database);
    await database.query("UPDATE users SET language='ru' WHERE id=1");
    let sentCount = 0;
    const deletedMessageIds: number[] = [];
    const accounts = new Accounts(config, { async execute(method, params) {
      if (method === "delete") { deletedMessageIds.push(...params.messageIds); return { ok: true }; }
      assert.equal(method, "send"); return { messageIds: [++sentCount] };
    } });
    const delivery = new Delivery(database, { ...config, maxDaily: 1 }, accounts, {} as any);
    const botCalls: any[] = [];
    const bot = createBot(config, database, accounts, new Groups(accounts), {
      run: async () => {}, removePublished: delivery.removePublished.bind(delivery),
    } as any);
    bot.api.config.use(async (_previous, method, payload: any) => {
      botCalls.push({ method, ...payload });
      if (method === "getMe") return { ok: true, result: { id: 123456789, is_bot: true, first_name: "Audit" } } as any;
      return { ok: true, result: { message_id: botCalls.length, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } } as any;
    });
    await bot.init(); let updateId = 900000;
    const callback = (data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), from: { id: 101, is_bot: false, first_name: "Audit" }, data, chat_instance: "audit",
      message: { message_id: 1, date: 0, chat: { id: 101, type: "private" }, text: "Menu" },
    } } as any);

    const first = await announcement(database, "1", ["1"]);
    await delivery.run(); assert.equal(sentCount, 1);
    const second = await announcement(database, "1", ["1"]);
    await delivery.run(); assert.equal(sentCount, 1, "The second ad is initially blocked by the quota");
    await callback(`ann:delete_confirm:${first}`);
    await callback(`ann:delete_messages:no:${first}`);
    const countedAfterDelete = (await one(database, "SELECT count(*)::int n FROM delivery_logs WHERE sender_telegram_id=101 AND sent_at>now()-interval '1 day'")).n;
    assert.equal(countedAfterDelete, 0);
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [second]);
    await delivery.run(); assert.equal(sentCount, 2);
    results.push({ finding: "Deleted announcement resets usage", configuredDailyLimit: 1, countedAfterDelete, actualMockDeliveriesWithinDay: sentCount, verified: true });

    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=now()-interval '8 days',trial_ends_at=now()-interval '1 day' WHERE id=1");
    const offset = botCalls.length;
    await callback(`ann:show:${second}`);
    const card = botCalls.slice(offset).find(call => call.method === "editMessageText");
    assert.ok(card);
    const buttons = card.reply_markup.inline_keyboard.flat().map((button: any) => button.text);
    assert.ok(!buttons.some((label: string) => /приостанов|пауза|запустить/i.test(label)));
    assert.ok(!/тариф|ист[её]к|ожидан|последн|следующ/i.test(card.text));
    results.push({ finding: "Expired announcement card lacks delivery state and pause", text: card.text, buttons, verified: true });

    await database.query("UPDATE users SET paid_until='2100-01-01' WHERE id=1");
    await database.query("DELETE FROM announcements WHERE user_id=1");
    const draft = { kind: "announcement", step: "confirm", text: "X".repeat(4096), contact_name: "Contact", interval: 5, groups: ["1"], mode: "scheduled" };
    await database.query("UPDATE user_states SET data=$1,updated_at=now() WHERE user_id=1", [JSON.stringify(draft)]);
    await callback("ann:confirm");
    const accepted = await one(database, "SELECT * FROM announcements WHERE user_id=1");
    assert.ok(accepted, "Draft with a valid body and contacts is accepted");
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [accepted.id]);
    const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
    let notifications = 0;
    const lengthAccounts = new Accounts(config, { async execute(method, params) {
      assert.equal(method, "send");
      return (service as any).send({}, peer("-100123", "111"), params);
    } });
    const lengthDelivery = new Delivery(database, config, lengthAccounts, { async sendMessage() { notifications++; } } as any);
    await lengthDelivery.run();
    const failure = await one(database, "SELECT status,error_code FROM delivery_logs WHERE announcement_id=$1", [accepted.id]);
    assert.equal(failure.error_code, "MESSAGE_TOO_LONG"); assert.equal(failure.status, "failed"); assert.equal(notifications, 0);
    results.push({ finding: "Body validation excludes appended contact", acceptedBodyCharacters: accepted.text.length, error: failure.error_code, userNotifications: notifications, verified: true });

    await database.query("DELETE FROM announcements WHERE user_id=1");
    const singleGroup = await announcement(database, "1", ["1"]);
    await database.query("INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,sent_at,status,sender_telegram_id,telegram_message_ids) VALUES($1,1,now(),now(),'sent',101,'[4001]')", [singleGroup]);
    const promptOffset = botCalls.length;
    await callback("groups:delete:1");
    const prompt = botCalls.slice(promptOffset).find(call => call.method === "editMessageText").text;
    await callback("groups:delete_confirm:1");
    assert.equal(await one(database, "SELECT id FROM announcements WHERE id=$1", [singleGroup]), undefined);
    assert.deepEqual(deletedMessageIds, [4001]);
    results.push({ finding: "Disconnecting the last group deletes announcement and published messages", confirmationText: prompt, mockDeletedMessageIds: deletedMessageIds, announcementDeleted: true, verified: true });
  } finally { await pg.close(); }
  await writeFile("docs/business-audit-2026-09-20/verification.json", JSON.stringify({ environment: "PGlite + mocked Telegram; no production data or sends", results }, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
