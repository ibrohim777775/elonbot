import { createHash } from "node:crypto";
import bigInt from "big-integer";
import { Api, errors, TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { Logger, LogLevel } from "teleproto/extensions/Logger";
import { HTMLParser } from "teleproto/extensions/html";
import { CustomFile } from "teleproto/client/uploads";
import { computeCheck } from "teleproto/Password";
import { ErrorDiagnostic, errorDiagnostic, errorFrames, logError } from "./log";
import { maxAnnouncementPhotos } from "./media";

export class Failure extends Error {
  diagnostic?: ErrorDiagnostic;
  operation?: string;
  constructor(public code: string, public seconds = 0, public messageIds: number[] = []) {
    super(code);
    this.name = "Failure";
  }
}

export function safeError(error: unknown): Failure {
  if (error instanceof Failure) return error;
  const e = error as { errorMessage?: string; seconds?: number };
  const rpcCode = typeof e?.errorMessage === "string" ? e.errorMessage : undefined;
  const code = error instanceof errors.SlowModeWaitError ? "SLOWMODE_WAIT" : error instanceof errors.FloodWaitError ? "FLOOD_WAIT" :
    rpcCode?.startsWith("RECAPTCHA_CHECK") ? "CAPTCHA_REQUIRED" : rpcCode && /^[A-Z][A-Z_0-9]{1,80}$/.test(rpcCode) ? rpcCode : "TELEGRAM_UNAVAILABLE";
  const seconds = Number(e?.seconds);
  const failure = new Failure(code, Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
  // Keep only safe diagnostics and the original call site; never retain the raw error/request as cause.
  failure.diagnostic = errorDiagnostic(error);
  const frames = errorFrames(error);
  if (frames) failure.stack = `${failure.name}: ${failure.code}\n${frames}`;
  return failure;
}

export function randomId(key: string) {
  return bigInt(createHash("sha256").update(key).digest().readBigInt64BE().toString());
}

export function peer(chatId: string, accessHash?: string | null): Api.TypeInputPeer {
  if (chatId.startsWith("-100")) {
    if (!accessHash) throw new Failure("GROUP_REFRESH_REQUIRED");
    return new Api.InputPeerChannel({ channelId: bigInt(chatId.slice(4)), accessHash: bigInt(accessHash) });
  }
  if (!/^-[1-9]\d*$/.test(chatId)) throw new Failure("INVALID_GROUP");
  return new Api.InputPeerChat({ chatId: bigInt(chatId.slice(1)) });
}

type Pending = { client: TelegramClient<StringSession>; ownerId: string; phone: string; hash: string; expires: number; stage: "starting" | "code" | "password" };
type Live = { client: TelegramClient<StringSession>; session: string; touched: number };

export class TelegramService {
  private pending = new Map<string, Pending>();
  private clients = new Map<string, Live>();
  private mediaClient?: Promise<TelegramClient<StringSession>>;
  constructor(private credentials: { apiId: number; apiHash: string; botToken?: string } = {
    apiId: Number(process.env.TELEGRAM_API_ID), apiHash: process.env.TELEGRAM_API_HASH ?? "", botToken: process.env.BOT_TOKEN,
  }) {}

  private make(session = "") {
    const client = new TelegramClient(new StringSession(session), this.credentials.apiId, this.credentials.apiHash, {
      connectionRetries: 2, requestRetries: 3, floodSleepThreshold: 0,
      baseLogger: new Logger(LogLevel.NONE), deviceModel: "Elonbot", appVersion: "1.0",
    });
    client.onError = async error => { logError("telegram_client_error", safeError(error)); };
    return client;
  }

  async cleanup() {
    for (const [key, value] of this.pending) if (value.expires < Date.now()) {
      await this.cancelLogin(key);
    }
    // Keep authorized connections ready for the next scheduled publication.
  }

  async close() {
    await Promise.allSettled([...this.pending.values(), ...this.clients.values()].map(v => v.client.destroy()));
    this.pending.clear(); this.clients.clear();
    if (this.mediaClient) await this.mediaClient.then(client => client.destroy()).catch(() => {});
  }

  private async botMediaClient() {
    if (!this.mediaClient) {
      this.mediaClient = (async () => {
        if (!this.credentials.botToken) throw new Failure("PHOTO_SOURCE_UNAVAILABLE");
        const client = this.make();
        try {
          await client.connect();
          await client.invoke(new Api.auth.ImportBotAuthorization({ flags: 0, apiId: this.credentials.apiId,
            apiHash: this.credentials.apiHash, botAuthToken: this.credentials.botToken }));
          return client;
        } catch (error) { await client.destroy(); throw error; }
      })();
      this.mediaClient.catch(() => { this.mediaClient = undefined; });
    }
    const client = await this.mediaClient;
    if (!client.connected) await client.connect();
    return client;
  }

  private async sourcePhotos(p: Record<string, any>) {
    const ids = p.messageIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > maxAnnouncementPhotos || new Set(ids).size !== ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) || !/^[1-9]\d*$/.test(String(p.ownerId))) {
      throw new Failure("INVALID_PHOTO_SOURCE");
    }
    try {
      // Bot API IDs belong to the bot account, not to the publishing user's MTProto session.
      const client = await this.botMediaClient();
      const result = await client.invoke(new Api.messages.GetMessages({ id: ids.map(id => new Api.InputMessageID({ id })) }));
      if (!("messages" in result)) throw new Failure("PHOTO_SOURCE_MISSING");
      const messages = ids.map(id => result.messages.find(message => message.id === id));
      for (const message of messages) {
        if (!(message instanceof Api.Message) || !(message.peerId instanceof Api.PeerUser) ||
          message.peerId.userId.toString() !== String(p.ownerId) || !(message.media instanceof Api.MessageMediaPhoto) ||
          !(message.media.photo instanceof Api.Photo)) throw new Failure("PHOTO_SOURCE_MISSING");
      }
      const photos: string[] = [];
      for (const message of messages) {
        const data = await client.downloadMedia(message as Api.Message, {
          signal: AbortSignal.timeout(30_000),
          progressCallback: async received => { if (received.greater(10 * 1024 * 1024)) throw new Failure("PHOTO_SOURCE_UNAVAILABLE"); },
        });
        if (!Buffer.isBuffer(data) || !data.length || data.length > 10 * 1024 * 1024) throw new Failure("PHOTO_SOURCE_UNAVAILABLE");
        photos.push(data.toString("base64"));
      }
      return photos;
    } catch (error) {
      const failure = safeError(error);
      if (["MESSAGE_ID_INVALID", "MSG_ID_INVALID"].includes(failure.code)) throw new Failure("PHOTO_SOURCE_MISSING");
      if (["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED"].includes(failure.code)) {
        const expired = this.mediaClient; this.mediaClient = undefined;
        if (expired) await expired.then(client => client.destroy()).catch(() => {});
      }
      if (["PHOTO_SOURCE_MISSING", "PHOTO_SOURCE_UNAVAILABLE", "TELEGRAM_UNAVAILABLE"].includes(failure.code) || failure.seconds) throw failure;
      // A bot-reader authentication failure must never invalidate a user's publishing account.
      throw new Failure("PHOTO_SOURCE_UNAVAILABLE");
    }
  }

  private async finish(key: string, expectedId: string) {
    const flow = this.pending.get(key);
    if (!flow || flow.ownerId !== expectedId) throw new Failure("LOGIN_EXPIRED");
    const me = await flow.client.getMe();
    if (this.pending.get(key) !== flow) throw new Failure("LOGIN_EXPIRED");
    if (me.bot || me.id.toString() !== expectedId) {
      try { await flow.client.logOut(); } finally { await this.cancelLogin(key); }
      throw new Failure("ACCOUNT_MISMATCH");
    }
    const session = flow.client.session.save();
    this.pending.delete(key);
    await flow.client.destroy();
    return { stage: "done", session, telegramId: me.id.toString() };
  }

  private async cancelLogin(key: string) {
    const flow = this.pending.get(key);
    if (flow) {
      this.pending.delete(key);
      await flow.client.destroy();
    }
    return { ok: true };
  }

  async login(action: string, p: Record<string, any>) {
    const key = String(p.key);
    const ownerId = String(p.expectedId);
    if (!/^[1-9]\d*$/.test(ownerId)) throw new Failure("INVALID_LOGIN_STEP");
    if (action === "begin") {
      if (this.pending.has(key)) throw new Failure("LOGIN_ALREADY_STARTED");
      const phone = String(p.value).replace(/[\s()-]/g, "");
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Failure("PHONE_NUMBER_INVALID");
      const previous = [...this.pending].find(([, flow]) => flow.ownerId === ownerId);
      if (this.pending.size - (previous ? 1 : 0) >= 100) throw new Failure("LOGIN_CAPACITY_REACHED");
      const client = this.make();
      const flow: Pending = { client, ownerId, phone, hash: "", expires: Date.now() + 600_000, stage: "starting" };
      // Reserve capacity and replace the owner's old flow before any asynchronous work.
      if (previous) this.pending.delete(previous[0]);
      this.pending.set(key, flow);
      const current = () => { if (this.pending.get(key) !== flow || flow.expires < Date.now()) throw new Failure("LOGIN_EXPIRED"); };
      try {
        if (previous) await previous[1].client.destroy();
        current();
        await client.connect();
        current();
        const sent = await client.sendCode(this.credentials, phone);
        current();
        if (sent.emailRequired || sent.emailCodeSent) throw new Failure("EMAIL_LOGIN_UNSUPPORTED");
        flow.hash = sent.phoneCodeHash; flow.stage = "code";
        return { stage: "code" };
      } catch (error) {
        if (this.pending.get(key) === flow) this.pending.delete(key);
        await client.destroy();
        throw error;
      }
    }
    const flow = this.pending.get(key);
    if (!flow || flow.ownerId !== ownerId) throw new Failure("LOGIN_EXPIRED");
    if (flow.expires < Date.now()) { await this.cancelLogin(key); throw new Failure("LOGIN_EXPIRED"); }
    if (action !== flow.stage) throw new Failure("INVALID_LOGIN_STEP");
    if (action === "code") {
      try {
        const result = await flow.client.invoke(new Api.auth.SignIn({
          phoneNumber: flow.phone, phoneCodeHash: flow.hash, phoneCode: String(p.value),
        }));
        if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new Failure("EXISTING_ACCOUNT_REQUIRED");
      } catch (error) {
        if (safeError(error).code === "SESSION_PASSWORD_NEEDED") {
          flow.stage = "password";
          return { stage: "password" };
        }
        throw error;
      }
    } else {
      const parameters = await flow.client.invoke(new Api.account.GetPassword());
      await flow.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(parameters, String(p.value)) }));
    }
    return this.finish(key, String(p.expectedId));
  }

  private async client(p: Record<string, any>) {
    const key = String(p.userId);
    let live = this.clients.get(key);
    if (live && live.session !== p.session) {
      await live.client.destroy();
      this.clients.delete(key);
      live = undefined;
    }
    if (!live) {
      const client = this.make(p.session);
      try {
        await client.connect();
        const me = await client.getMe();
        if (me.bot || me.id.toString() !== String(p.expectedId)) throw new Failure("ACCOUNT_MISMATCH");
        live = { client, session: p.session, touched: Date.now() };
        this.clients.set(key, live);
      } catch (error) { await client.destroy(); throw error; }
    }
    // A cached session is not proof of a live socket. Recover after reconnect attempts were exhausted.
    // Reuse the authorized client, handlers and session; the scheduler retains the same delivery IDs.
    if (!live.client.connected) {
      try { await live.client.connect(); }
      catch (error) { const failure = safeError(error); failure.operation = "connect"; throw failure; }
    }
    live.touched = Date.now();
    return live.client;
  }

  async groups(p: Record<string, any>) {
    const client = await this.client(p);
    const groups = [];
    for await (const dialog of client.iterDialogs({})) {
      const entity = dialog.entity;
      if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) continue;
      if (entity instanceof Api.Channel && !entity.megagroup) continue;
      if (entity.left || (entity instanceof Api.Chat && (entity.deactivated || entity.migratedTo))) continue;
      const admin = Boolean(entity.creator || entity.adminRights);
      const ownBans = entity instanceof Api.Channel ? entity.bannedRights : undefined;
      const bans = ownBans ?? entity.defaultBannedRights;
      const canPost = admin || !(bans?.sendMessages || bans?.sendPlain || bans?.viewMessages);
      groups.push({
        chatId: dialog.id!.toString(), title: entity.title,
        chatType: entity instanceof Api.Channel ? "supergroup" : "group",
        accessHash: entity instanceof Api.Channel ? entity.accessHash?.toString() : null,
        canPost, isAdmin: admin,
      });
    }
    return { groups };
  }

  async execute(method: string, p: Record<string, any>) {
    if (method === "health") return { ok: true };
    if (method === "photos.read") return this.sourcePhotos(p);
    if (method === "login.cancel") return this.cancelLogin(String(p.key));
    if (method.startsWith("login.")) return this.login(method.slice(6), p);
    if (method === "groups") return this.groups(p);
    const client = await this.client(p);
    if (method === "restore") return { ok: true };
    if (method === "logout") {
      await client.logOut();
      this.clients.delete(String(p.userId));
      await client.destroy();
      return { ok: true };
    }
    const target = peer(String(p.chatId), p.accessHash);
    if (method === "delete") {
      // Basic-group IDs are account-local; only owned delivery records reach here.
      await client.deleteMessages(target, p.messageIds, { revoke: true });
      return { ok: true };
    }
    if (method !== "send") throw new Failure("UNKNOWN_METHOD");
    return this.send(client, target, p);
  }

  private async send(client: TelegramClient, target: Api.TypeInputPeer, p: Record<string, any>) {
    const [text, entities] = HTMLParser.parse(p.text);
    if (text.length > 4096) throw new Failure("MESSAGE_TOO_LONG");
    const photos: string[] = p.photos ?? [];
    const sendAs = target instanceof Api.InputPeerChannel ? new Api.InputPeerSelf() : undefined;
    if (photos.length > maxAnnouncementPhotos) throw new Failure("TOO_MANY_PHOTOS");
    const ids: number[] = [...(p.messageIds ?? [])];
    let step = 0;
    let operation = "send";
    const checkWindow = () => {
      if (typeof p.subscriptionBefore === "number" && Date.now() >= p.subscriptionBefore) throw new Failure("SUBSCRIPTION_EXPIRED", 0, ids);
      if (typeof p.sendBefore === "number" && Date.now() >= p.sendBefore) throw new Failure("OUTSIDE_SEND_WINDOW", 0, ids);
    };
    const invoke = async (request: any, count: number) => {
      // Resume known partial results without repeating the photo/album.
      if (ids.length >= step + count) { step += count; return; }
      checkWindow();
      operation = request.className;
      const result = await client.invoke(request) as Api.TypeUpdates;
      const updates = "updates" in result ? result.updates : [];
      const sent = updates.filter((u): u is Api.UpdateMessageID => u instanceof Api.UpdateMessageID).map(u => u.id);
      if (result instanceof Api.UpdateShortSentMessage) sent.push(result.id);
      if (sent.length !== count) throw new Failure("SEND_RESULT_UNKNOWN", 0, ids);
      ids.push(...sent);
      step += count;
    };
    try {
      const caption = text.length <= 1024 ? text : "";
      if (photos.length && ids.length < photos.length) {
        const media: Api.InputSingleMedia[] = [];
        for (let index = 0; index < photos.length; index++) {
          checkWindow();
          const buffer = Buffer.from(photos[index], "base64");
          operation = "uploadFile";
          const file = await client.uploadFile({ file: new CustomFile(`photo-${index}.jpg`, buffer.length, "", buffer), workers: 1 });
          const uploaded = new Api.InputMediaUploadedPhoto({ file });
          if (photos.length === 1) {
            await invoke(new Api.messages.SendMedia({ peer: target, media: uploaded,
              message: caption, entities: caption ? entities : [], sendAs,
              randomId: randomId(`${p.deliveryKey}:photo:0`),
            }), 1);
          } else {
            operation = "messages.UploadMedia";
            const result = await client.invoke(new Api.messages.UploadMedia({ peer: target, media: uploaded }));
            if (!(result instanceof Api.MessageMediaPhoto) || !(result.photo instanceof Api.Photo)) throw new Failure("PHOTO_UNAVAILABLE");
            media.push(new Api.InputSingleMedia({
              media: new Api.InputMediaPhoto({ id: new Api.InputPhoto({ id: result.photo.id, accessHash: result.photo.accessHash, fileReference: result.photo.fileReference }) }),
              randomId: randomId(`${p.deliveryKey}:photo:${index}`), message: index === 0 ? caption : "",
              entities: index === 0 && caption ? entities : [],
            }));
          }
        }
        if (media.length) await invoke(new Api.messages.SendMultiMedia({
          peer: target, multiMedia: media, sendAs,
        }), media.length);
      } else { step = photos.length; }
      if (!photos.length || !caption) await invoke(new Api.messages.SendMessage({
        peer: target, message: text, entities, randomId: randomId(`${p.deliveryKey}:text`), sendAs,
      }), 1);
      return { messageIds: ids };
    } catch (error) {
      const failure = safeError(error);
      failure.messageIds = ids;
      failure.operation = operation;
      throw failure;
    }
  }
}
