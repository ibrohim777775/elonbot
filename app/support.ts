import { Api, InlineKeyboard } from "grammy";
import { Message } from "grammy/types";
import { Config } from "./config";
import { Database, one, Queryable } from "./db";
import { Failure } from "./telegram";
import { t, languageOf } from "./i18n";

export function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Failure("INVALID_REQUEST");
  return value.toLowerCase();
}
export class Support {
  private notified = new Map<string, number>();
  constructor(readonly database: Database, readonly config: Config, readonly api: Api) {}
  async receive(db: Queryable, userId: string, message: Message) {
    const media = message.photo?.at(-1) ?? message.document ?? message.voice ?? message.audio ?? message.video;
    if (!message.text && !media) throw new Failure("SUPPORT_CONTENT_REQUIRED");
    return one(db, `INSERT INTO support_messages(user_id,direction,text,kind,file_id,file_name,telegram_message_id)
      VALUES($1,'in',$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [userId, message.text ?? message.caption ?? "",
      message.photo ? "photo" : message.document ? "document" : message.voice ? "voice" : message.audio ? "audio" : message.video ? "video" : "text",
      media?.file_id ?? null, media && "file_name" in media ? media.file_name : null, message.message_id]);
  }
  async isReply(db: Queryable, userId: string, messageId?: number) {
    return messageId !== undefined && !!await one(db, "SELECT 1 FROM support_messages WHERE user_id=$1 AND direction='out' AND telegram_message_id=$2", [userId, messageId]);
  }
  async notify(userId: string) {
    const now = Date.now();
    for (const [id, time] of this.notified) if (now - time > 60_000) this.notified.delete(id);
    if (this.notified.has(userId)) return;
    this.notified.set(userId, now);
    const user = await one(this.database, "SELECT telegram_id,first_name FROM users WHERE id=$1", [userId]);
    if (!user) return;
    for (const admin of this.config.adminIds) {
      const owner = await one(this.database, "SELECT language FROM users WHERE telegram_id=$1", [admin]);
      const language = languageOf(owner?.language);
      await this.api.sendMessage(admin, t("support.admin_notification", { name: user.first_name ?? String(user.telegram_id), id: String(user.telegram_id) }, language),
        { reply_markup: new InlineKeyboard().webApp(t("admin.conversation", {}, language), `${this.config.baseUrl}/admin#user=${userId}&tab=messages`) }).catch(() => {});
    }
  }
  async reply(userId: string, adminId: string, payload: any) {
    const key = requestId(payload.requestId);
    if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.trim().length > 3500) throw new Failure("INVALID_TEXT");
    const text = payload.text.trim();
    const user = await one(this.database, "SELECT telegram_id,language FROM users WHERE id=$1", [userId]);
    if (!user) throw new Failure("NOT_FOUND");
    // Commit the request before calling the non-idempotent Bot API. HTTP retries must never send twice.
    const row = await one(this.database, `INSERT INTO support_messages(user_id,direction,text,admin_telegram_id,request_id,delivery_status)
      VALUES($1,'out',$2,$3,$4,'sending') ON CONFLICT(request_id) DO NOTHING RETURNING id`, [userId, text, adminId, key]);
    if (!row) {
      const previous = await one(this.database, "SELECT id,user_id,text,delivery_status,error_code FROM support_messages WHERE request_id=$1", [key]);
      if (String(previous.user_id) !== userId || previous.text !== text) throw new Failure("CONFLICT");
      return previous;
    }
    try {
      const language = languageOf(user.language);
      const sent = await this.api.sendMessage(String(user.telegram_id), t("support.admin_reply", { text }, language), {
        reply_markup: new InlineKeyboard().text(t("support.answer", {}, language), "support:open"),
      });
      await this.database.query("UPDATE support_messages SET delivery_status='sent',telegram_message_id=$2,updated_at=now() WHERE id=$1", [row.id, sent.message_id]);
    } catch (error) {
      const code = (error as any)?.error_code;
      const definite = Number.isInteger(code) && [400, 401, 403, 404, 429].includes(code);
      await this.database.query("UPDATE support_messages SET delivery_status=$2,error_code=$3,updated_at=now() WHERE id=$1",
        [row.id, definite ? "failed" : "unknown", definite ? `BOT_API_${code}` : "DELIVERY_UNCONFIRMED"]);
    }
    return one(this.database, "SELECT id,delivery_status,error_code FROM support_messages WHERE id=$1", [row.id]);
  }
  async recover() {
    await this.database.query(`UPDATE support_messages SET delivery_status='unknown',error_code='DELIVERY_UNCONFIRMED',updated_at=now()
      WHERE direction='out' AND delivery_status='sending' AND updated_at<now()-interval '5 minutes'`);
  }
}
