import { test } from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api } from "teleproto";
import { Accounts } from "../accounts";
import { Admin } from "../admin";
import { createBot } from "../bot";
import { one } from "../db";
import { Delivery } from "../delivery";
import { Groups } from "../groups";
import { Failure, TelegramService } from "../telegram";
import { announcement, config, seed, testDatabase } from "./helpers";

const ids = Array.from({ length: 10 }, (_, i) => 101 + i);
const sourceMessage = (id: number, owner = 101) => new Api.Message({ id, date: 0, message: "Caption",
  peerId: new Api.PeerUser({ userId: bigInt(owner) }),
  media: new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: bigInt(id), accessHash: bigInt(1),
    fileReference: Buffer.from("reference"), date: 0, sizes: [], dcId: 1 }) }),
});

test("photo reader uses bot authorization, checks ownership of the whole album and keeps requested order in memory", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "hash", botToken: "123:token" });
  let connects = 0, auths = 0, downloads = 0, destroyed = 0;
  let messages: Api.TypeMessage[] = ids.map(id => sourceMessage(id)).reverse();
  const client = {
    connected: false,
    async connect() { this.connected = true; connects++; },
    async destroy() { destroyed++; },
    async invoke(request: any) {
      assert.ok(request.getBytes().length);
      if (request instanceof Api.auth.ImportBotAuthorization) { auths++; assert.equal(request.botAuthToken, "123:token"); return {}; }
      assert.ok(request instanceof Api.messages.GetMessages);
      assert.deepEqual(request.id.map((input: any) => input.id), ids);
      return { messages };
    },
    async downloadMedia(message: Api.Message, options: any) {
      assert.equal(options.outputFile, undefined); assert.ok(options.signal instanceof AbortSignal);
      downloads++; return Buffer.from(`photo-${message.id}`);
    },
  };
  (service as any).make = (session?: string) => { assert.equal(session, undefined); return client; };
  try {
    const photos = await service.execute("photos.read", { ownerId: "101", messageIds: ids }) as string[];
    assert.deepEqual(photos.map((photo: string) => Buffer.from(photo, "base64").toString()), ids.map(id => `photo-${id}`));
    client.connected = false;
    await service.execute("photos.read", { ownerId: "101", messageIds: ids });
    assert.equal(auths, 1); assert.equal(connects, 2); assert.equal(downloads, 20);
    messages[9] = sourceMessage(ids[0], 202);
    await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: ids }), { code: "PHOTO_SOURCE_MISSING" });
    messages[9] = new Api.MessageEmpty({ id: ids[0] });
    await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: ids }), { code: "PHOTO_SOURCE_MISSING" });
    assert.equal(downloads, 20, "No photo may be downloaded until the entire source set belongs to the owner");
    for (const invalid of [[], [...ids, 111], [0], [1, 1], ["1"], [-1], [2147483648]]) {
      await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: invalid }), { code: "INVALID_PHOTO_SOURCE" });
    }
  } finally { await service.close(); }
  assert.equal(destroyed, 1);
});

test("bot source-reader errors cannot masquerade as publishing-account authentication errors", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "hash", botToken: "123:token" });
  let destroys = 0, failLogin = true;
  (service as any).make = () => ({ connected: true, async connect() {}, async destroy() { destroys++; },
    async invoke(request: any) {
      if (!failLogin && request instanceof Api.auth.ImportBotAuthorization) return {};
      throw { errorMessage: "AUTH_KEY_UNREGISTERED" };
    },
  });
  await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: [1] }), { code: "PHOTO_SOURCE_UNAVAILABLE" });
  await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: [1] }), { code: "PHOTO_SOURCE_UNAVAILABLE" });
  assert.equal(destroys, 2, "Failed bot logins must be retried with a fresh client");
  failLogin = false;
  await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: [1] }), { code: "PHOTO_SOURCE_UNAVAILABLE" });
  await assert.rejects(service.execute("photos.read", { ownerId: "101", messageIds: [1] }), { code: "PHOTO_SOURCE_UNAVAILABLE" });
  assert.equal(destroys, 4, "Revoked cached reader sessions must also be discarded");
  await service.close();
});

test("delivery fetches source messages once per cycle; deleted sources pause the ad without sending text or unlinking its account", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE announcements SET photo_message_ids=$2 WHERE id=$1", [id, JSON.stringify(ids)]);
    let reads = 0, sends = 0, failure = ""; const notices: any[] = [];
    const accounts = new Accounts(config, { async execute(method, params) {
      if (method === "photos.read") {
        reads++; assert.deepEqual(params, { ownerId: "101", messageIds: ids });
        if (failure) throw new Failure(failure);
        return ids.map(id => Buffer.from(`photo-${id}`).toString("base64"));
      }
      assert.equal(method, "send"); assert.equal(params.expectedId, "101"); assert.equal(params.photos.length, 10);
      sends++; return { messageIds: ids.map(id => id + sends * 100) };
    } });
    const delivery = new Delivery(database, { ...config, maxChatMessages: 100 }, accounts, {
      async getFile() { throw new Error("New photos must not use saved file IDs"); },
      async sendMessage(...args: any[]) { notices.push(args); },
    } as any);
    await delivery.run(); assert.equal(reads, 1); assert.equal(sends, 2);
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    failure = "PHOTO_SOURCE_UNAVAILABLE"; await delivery.run();
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "active");
    assert.equal(notices.length, 0);
    await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1", [id]);
    failure = "PHOTO_SOURCE_MISSING"; await delivery.run(); await delivery.run();
    assert.equal(reads, 3); assert.equal(sends, 2); assert.equal(notices.length, 1);
    assert.equal((await one(database, "SELECT status FROM announcements WHERE id=$1", [id])).status, "paused");
    assert.equal((await one(database, "SELECT count(*)::int n FROM telegram_accounts WHERE user_id=1")).n, 1);
    assert.equal(notices[0][2].reply_markup.inline_keyboard[0][0].callback_data, `ann:edit_photo:${id}`);
  } finally { await pg.close(); }
});

test("editing collects ten forwarded photos until Done, supports cancellation and restores a paused announcement", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database);
    await database.query("UPDATE announcements SET photo_file_id='old',photo_file_ids='[\"old\"]' WHERE id=$1", [id]);
    const accounts = new Accounts(config, { async execute() { throw new Error("No real Telegram requests"); } });
    const bot = createBot(config, database, accounts, new Groups(accounts), { async run() {} } as any);
    bot.api.config.use(async (_, method, payload: any) => ({ ok: true, result: method === "getMe"
      ? { id: 123456789, is_bot: true, first_name: "Bot" }
      : { message_id: 500, date: 0, chat: { id: 101, type: "private" }, text: payload.text ?? "" } }) as any);
    await bot.init(); let updateId = 0;
    const chat = { id: 101, type: "private" }, from = { id: 101, is_bot: false, first_name: "User" };
    const callback = (data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: String(updateId), from, data, chat_instance: "one", message: { message_id: 1, date: 0, chat, text: "Menu" },
    } } as any);
    const photo = (messageId: number) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: messageId, date: 0, chat, from, media_group_id: "album", caption: "Updated album",
      forward_origin: { type: "hidden_user", sender_user_name: "Source", date: 0 },
      photo: [{ file_id: "must-not-store", file_unique_id: "unique", width: 100, height: 100 }],
    } } as any);
    await callback(`ann:edit_photo:${id}`); await photo(90); await callback("wizard:back:edit_photo");
    assert.equal((await one(database, "SELECT photo_file_id FROM announcements WHERE id=$1", [id])).photo_file_id, "old");
    await database.query("UPDATE announcements SET status='paused',pause_reason='photo_source_missing' WHERE id=$1", [id]);
    await callback(`ann:edit_photo:${id}`);
    for (const messageId of [...ids].reverse()) await photo(messageId);
    await photo(ids[0]); await photo(111);
    const draft = (await one(database, "SELECT data FROM user_states WHERE user_id=1")).data;
    assert.deepEqual(draft.photoMessageIds, ids); assert.doesNotMatch(JSON.stringify(draft), /must-not-store/);
    assert.equal((await one(database, "SELECT photo_file_id FROM announcements WHERE id=$1", [id])).photo_file_id, "old");
    await callback("ann:photos_done");
    const ad = await one(database, "SELECT * FROM announcements WHERE id=$1", [id]);
    assert.deepEqual(ad.photo_message_ids, ids); assert.equal(ad.photo_file_id, null); assert.deepEqual(ad.photo_file_ids, []);
    assert.equal(ad.text, "Updated album"); assert.equal(ad.status, "active");
  } finally { await pg.close(); }
});

test("admin serves the tenth source photo using its owner's chat and never exposes media IDs in lists", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const id = await announcement(database, "2", ["1"]);
    await database.query("UPDATE announcements SET photo_message_ids=$2 WHERE id=$1", [id, JSON.stringify(ids)]);
    let reads = 0;
    const admin = new Admin(config, database, {} as any, {} as any, { async execute(method, params) {
      reads++; assert.equal(method, "photos.read"); assert.deepEqual(params, { ownerId: "202", messageIds: [110] });
      return [Buffer.from("photo").toString("base64")];
    } });
    const identity = { id: 101, first_name: "Admin" };
    await assert.rejects(admin.file(`/admin-api/files/announcements/${id}/9`, { id: 202, first_name: "User" }), { code: "FORBIDDEN" });
    assert.equal(reads, 0);
    assert.equal((await admin.file(`/admin-api/files/announcements/${id}/9`, identity)).data.toString(), "photo");
    await assert.rejects(admin.file(`/admin-api/files/announcements/${id}/10`, identity), { code: "NOT_FOUND" });
    const result: any = await admin.handle("GET", "/admin-api/users/2/records", identity, {}, new URLSearchParams({ kind: "announcements" }));
    assert.equal(result.rows[0].photo_count, 10); assert.equal(result.rows[0].photo_message_ids, undefined);
    await assert.rejects(database.query("UPDATE announcements SET photo_message_ids=$2 WHERE id=$1", [id, JSON.stringify([...ids, 111])]));
  } finally { await pg.close(); }
});
