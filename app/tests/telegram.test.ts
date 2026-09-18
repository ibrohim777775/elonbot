import { test } from "node:test";
import assert from "node:assert/strict";
import { Api, errors } from "teleproto";
import bigInt from "big-integer";
import * as utils from "teleproto/Utils";
import { Failure, peer, randomId, safeError, TelegramService } from "../telegram";
import { logError } from "../log";

function updates(ids: number[]) {
  return new Api.Updates({ updates: ids.map((id, i) => new Api.UpdateMessageID({ id, randomId: bigInt(i + 1) })), users: [], chats: [], date: 0, seq: 0 });
}

test("closing time during upload or a partial send stops the next publication and preserves IDs", async context => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2030-06-01T16:59:59Z") });
  const deadline = Date.parse("2030-06-01T17:00:00Z");
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  const input = { text: "Caption", photos: [Buffer.from("photo").toString("base64")], deliveryKey: "cycle", sendBefore: deadline };
  let publishes = 0;
  const client = {
    async uploadFile() {
      context.mock.timers.setTime(deadline);
      return new Api.InputFile({ id: bigInt(1), parts: 1, name: "photo.jpg", md5Checksum: "" });
    },
    async invoke() { publishes++; return updates([41]); },
  };
  await assert.rejects((service as any).send(client, peer("-100123", "99"), input), { code: "OUTSIDE_SEND_WINDOW" });
  assert.equal(publishes, 0);
  context.mock.timers.setTime(deadline - 1000);
  client.uploadFile = async () => new Api.InputFile({ id: bigInt(1), parts: 1, name: "photo.jpg", md5Checksum: "" });
  client.invoke = async () => { publishes++; context.mock.timers.setTime(deadline); return updates([41]); };
  await assert.rejects((service as any).send(client, peer("-100123", "99"), { ...input, text: "X".repeat(1100) }), (error: Failure) => {
    assert.equal(error.code, "OUTSIDE_SEND_WINDOW"); assert.deepEqual(error.messageIds, [41]); return true;
  });
  assert.equal(publishes, 1, "The trailing text must wait until the next window");
});
test("transport keeps chat IDs precise and requires the user's access hash", () => {
  const target = peer("-1009876543210", "-987654321098765432");
  assert.ok(target instanceof Api.InputPeerChannel);
  assert.equal(target.channelId.toString(), "9876543210");
  assert.equal(target.accessHash.toString(), "-987654321098765432");
  assert.throws(() => peer("-1009876543210"), { code: "GROUP_REFRESH_REQUIRED" });
  assert.throws(() => peer("101"), { code: "INVALID_GROUP" });
  assert.equal(randomId("user:cycle:group").toString(), randomId("user:cycle:group").toString());
  assert.notEqual(randomId("user:cycle:group").toString(), randomId("other:cycle:group").toString());
});

test("subscription expiry between album and trailing text stops publication without losing acknowledged IDs", async context => {
  const deadline = Date.now() + 1000;
  context.mock.timers.enable({ apis: ["Date"], now: deadline - 1000 });
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) }); let publishes = 0;
  const client = { async uploadFile() { return new Api.InputFile({ id: bigInt(1), parts: 1, name: "photo.jpg", md5Checksum: "" }); },
    async invoke() { publishes++; context.mock.timers.setTime(deadline); return updates([41]); } };
  await assert.rejects((service as any).send(client, peer("-100123", "99"), {
    text: "X".repeat(1100), photos: [Buffer.from("photo").toString("base64")], deliveryKey: "paid-cycle", subscriptionBefore: deadline,
  }), (error: Failure) => { assert.equal(error.code, "SUBSCRIPTION_EXPIRED"); assert.deepEqual(error.messageIds, [41]); return true; });
  assert.equal(publishes, 1);
});
test("real Teleproto SlowMode and FloodWait errors retain separate scopes", () => {
  assert.deepEqual([safeError(new errors.SlowModeWaitError({ capture: 20, request: new Api.help.GetConfig() })).code, safeError(new errors.SlowModeWaitError({ capture: 20, request: new Api.help.GetConfig() })).seconds], ["SLOWMODE_WAIT", 20]);
  assert.equal(safeError(new errors.FloodWaitError({ capture: 60, request: new Api.help.GetConfig() })).code, "FLOOD_WAIT");
});
test("raw album publication uses user sender, escaped caption and stable per-photo random IDs", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  const requests: any[] = []; let uploaded = 0;
  const client = {
    async uploadFile() { return new Api.InputFile({ id: bigInt(++uploaded), parts: 1, name: "photo.jpg", md5Checksum: "" }); },
    async invoke(request: any) {
      await request.resolve({ getInputEntity: async (entity: any) => entity } as any, utils);
      assert.ok(request.getBytes().length > 0, "Real Teleproto requests must serialize before they can be sent");
      requests.push(request);
      if (request instanceof Api.messages.UploadMedia) return new Api.MessageMediaPhoto({ photo: new Api.Photo({
        id: bigInt(uploaded), accessHash: bigInt(123), fileReference: Buffer.from("ref"), date: 0, sizes: [], dcId: 1,
      }) });
      assert.ok(request instanceof Api.messages.SendMultiMedia); return updates([11, 12, 13, 14]);
    },
  };
  const params = { text: "A &amp; B", photos: Array(4).fill(Buffer.from("photo").toString("base64")), deliveryKey: "cycle" };
  const result = await (service as any).send(client, peer("-100123", "99"), params);
  assert.deepEqual(result.messageIds, [11, 12, 13, 14]);
  const album = requests.at(-1);
  assert.ok(album.sendAs instanceof Api.InputPeerSelf);
  assert.deepEqual(album.multiMedia.map((m: any) => m.message), ["A & B", "", "", ""]);
  assert.equal(new Set(album.multiMedia.map((m: any) => m.randomId.toString())).size, 4);
});
test("long photo caption resumes only the text after a partial send", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  const requests: any[] = []; let fail = true, uploads = 0;
  const client = {
    async uploadFile() { uploads++; return new Api.InputFile({ id: bigInt(1), parts: 1, name: "photo.jpg", md5Checksum: "" }); },
    async invoke(request: any) {
      requests.push(request);
      if (request instanceof Api.messages.SendMedia) return updates([10]);
      if (fail) { fail = false; throw new errors.SlowModeWaitError({ capture: 30, request: new Api.help.GetConfig() }); }
      return updates([11]);
    },
  };
  const params = { text: "X".repeat(1100), photos: [Buffer.from("photo").toString("base64")], deliveryKey: "cycle" };
  let failure: Failure | undefined;
  try { await (service as any).send(client, peer("-100123", "99"), params); } catch (error) { failure = error as Failure; }
  assert.equal(failure?.code, "SLOWMODE_WAIT"); assert.deepEqual(failure?.messageIds, [10]);
  const result = await (service as any).send(client, peer("-100123", "99"), { ...params, messageIds: failure!.messageIds });
  assert.deepEqual(result.messageIds, [10, 11]); assert.equal(uploads, 1);
  assert.equal(requests[1].randomId.toString(), requests[2].randomId.toString());
});
test("phone/code authentication handles 2FA step and rejects a different Telegram owner", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  let logout = false;
  const client = { connect: async () => {}, destroy: async () => {},
    sendCode: async () => ({ phoneCodeHash: "hash" }),
    invoke: async () => { throw new errors.SessionPasswordNeededError({ request: new Api.help.GetConfig() }); },
    getMe: async () => ({ id: bigInt(202), bot: false }), logOut: async () => { logout = true; },
    session: { save: () => "session" },
  };
  (service as any).make = () => client;
  assert.equal((await service.login("begin", { key: "one", value: "+998901234567" })).stage, "code");
  assert.equal((await service.login("code", { key: "one", value: "12345", expectedId: "101" })).stage, "password");
  await assert.rejects((service as any).finish("one", "101"), { code: "ACCOUNT_MISMATCH" });
  assert.equal(logout, true);
});

test("a cached disconnected client reconnects before sending without subscribing to group replies", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  let created = 0, connects = 0, reads = 0, handlers = 0, reconnectFails = false;
  const requests: any[] = [];
  const client = {
    connected: false,
    async connect() {
      connects++;
      if (reconnectFails) throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
      this.connected = true;
    },
    async getMe() { reads++; return { id: bigInt(101), bot: false }; },
    addEventHandler() { handlers++; },
    async destroy() { this.connected = false; },
    async invoke(request: any) {
      assert.equal(this.connected, true, "An unavailable cached connection must not be used to send");
      await request.resolve({ getInputEntity: async (entity: any) => entity } as any, utils);
      assert.ok(request.getBytes().length > 0);
      requests.push(request); return updates([42]);
    },
  };
  (service as any).make = (session: string) => { assert.equal(session, "saved-session"); created++; return client; };
  const identity = { userId: "1", expectedId: "101", session: "saved-session" };
  await service.execute("restore", identity);
  assert.equal(connects, 1);
  client.connected = false;
  const params = { ...identity, chatId: "-100123", accessHash: "99", text: "Plain text", deliveryKey: "same-cycle" };
  assert.deepEqual(await service.execute("send", params), { messageIds: [42] });
  assert.equal(connects, 2);
  await service.execute("restore", identity);
  assert.equal(connects, 2, "Healthy clients do not reconnect on each request");
  client.connected = false; reconnectFails = true;
  await assert.rejects(service.execute("send", params), (error: Failure) => {
    assert.equal(error.code, "TELEGRAM_UNAVAILABLE"); assert.equal(error.operation, "connect");
    assert.equal(error.diagnostic?.causeCode, "ECONNREFUSED"); return true;
  });
  assert.equal(requests.length, 1, "Failed reconnects do not attempt a publication");
  reconnectFails = false;
  await service.execute("send", params);
  assert.equal(created, 1); assert.equal(reads, 1); assert.equal(handlers, 0); assert.equal(connects, 4);
  assert.equal(requests[0].randomId.toString(), requests[1].randomId.toString());
  await service.close();
});

test("send failures preserve original diagnostics and partial IDs without disclosing requests", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  const originalError = Object.assign(new Error("Cannot send messages.SendMessage: sender for dc 4 is disconnected"), {
    request: { message: "private-announcement", session: "private-session" },
  });
  const client = { async invoke() { throw originalError; } };
  let failure!: Failure;
  try { await (service as any).send(client, peer("-100123", "99"), {
    text: "X".repeat(1100), photos: [""], messageIds: [41], deliveryKey: "same-cycle",
  }); } catch (error) { failure = error as Failure; }
  assert.equal(failure.code, "TELEGRAM_UNAVAILABLE"); assert.equal(failure.operation, "messages.SendMessage");
  assert.equal(failure.diagnostic?.reason, "DISCONNECTED"); assert.deepEqual(failure.messageIds, [41]);
  assert.equal(safeError(failure), failure);
  assert.match(failure.stack!, /telegram.test.ts/); assert.doesNotMatch(failure.stack!, /at safeError/);
  const logs: unknown[][] = []; const original = console.error;
  console.error = (...args) => { logs.push(args); };
  try {
    logError("telegram_send_failed", failure);
    logError("telegram_client_error", safeError(Object.assign(new TypeError("private-token private-phone"), {
      cause: Object.assign(new Error("private-session"), { code: "ECONNRESET" }),
    })));
  } finally { console.error = original; }
  const output = JSON.stringify(logs);
  assert.match(output, /DISCONNECTED/); assert.match(output, /messages.SendMessage/);
  assert.match(output, /TypeError/); assert.match(output, /ECONNRESET/); assert.doesNotMatch(output, /private-/);
  assert.doesNotMatch(JSON.stringify(failure), /private-/);
  assert.equal(safeError(new Error("Request was unsuccessful 3 time(s)")).diagnostic?.reason, "REQUEST_RETRIES_EXHAUSTED");
});

test("photo upload failures are distinguished from message submission", async () => {
  const service = new TelegramService({ apiId: 1, apiHash: "a".repeat(32) });
  const client = { async uploadFile() { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); } };
  await assert.rejects((service as any).send(client, peer("-100123", "99"), {
    text: "Caption", photos: [Buffer.from("photo").toString("base64")], deliveryKey: "cycle",
  }), (failure: Failure) => {
    assert.equal(failure.code, "TELEGRAM_UNAVAILABLE"); assert.equal(failure.operation, "uploadFile");
    assert.equal(failure.diagnostic?.causeCode, "ETIMEDOUT"); return true;
  });
});

