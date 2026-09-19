import { Api as BotApi } from "grammy";
import { Accounts, authErrors } from "./accounts";
import { Config } from "./config";
import { Database, one, Queryable } from "./db";
import { Failure, safeError } from "./telegram";
import { t, languageOf } from "./i18n";
import { logError } from "./log";
import { nextSendingTime, sendingDeadline } from "./schedule";
import { planState } from "./billing";
import { photosOf, photoMessageIds, photoCount } from "./media";
export { photosOf } from "./media";

export function renderText(announcement: Record<string, any>) {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts = [escape(announcement.text)];
  if (announcement.contact_name) parts.push(`\n${escape(announcement.contact_name)}`);
  if (announcement.contact_phone) parts.push(`Tel: ${escape(announcement.contact_phone)}`);
  if (announcement.contact_telegram) {
    const contact = announcement.contact_telegram.trim();
    const match = /^(?:@|(?:https?:\/\/)?t\.me\/)?([A-Za-z0-9_]{4,32})\/?$/.exec(contact);
    parts.push(match ? `Telegram: <a href="https://t.me/${match[1]}">@${match[1]}</a>` : `Telegram: ${escape(contact)}`);
  }
  return parts.join("\n");
}
export class Delivery {
  private running?: Promise<void>;
  constructor(readonly database: Database, readonly config: Config, readonly accounts: Accounts, readonly bot: BotApi) {}
  run(): Promise<void> {
    if (!this.running) this.running = this.process().finally(() => { this.running = undefined; });
    return this.running;
  }
  async wait() { await this.running; }
  private async process() {
    const due = await this.database.query(`SELECT a.id,a.user_id FROM announcements a JOIN telegram_accounts ta ON ta.user_id=a.user_id JOIN users u ON u.id=a.user_id
      WHERE a.status='active' AND a.next_run_at<=now() AND (ta.retry_after IS NULL OR ta.retry_after<=now())
      AND (u.trial_ends_at>now() OR u.paid_until>now())
      ORDER BY a.next_run_at LIMIT 100`);
    for (const row of due.rows) {
      await this.database.transaction(async db => {
        const locked = await one(db, "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok", [`elonbot:user:${row.user_id}`]);
        if (!locked.ok) return;
        const a = await one(db, "SELECT * FROM announcements WHERE id=$1 AND status='active' AND next_run_at<=now() FOR UPDATE", [row.id]);
        if (!a) return;
        const user = await one(db, "SELECT trial_started_at,trial_ends_at,paid_until,language FROM users WHERE id=$1", [a.user_id]);
        const plan = planState(user);
        if (!plan.allowed) return;
        a.subscriptionBefore = plan.until;
        a.language = languageOf(user.language);
        const account = await one(db, "SELECT * FROM telegram_accounts WHERE user_id=$1", [a.user_id]);
        if (!account || (account.retry_after && account.retry_after > new Date())) return;
        const now = new Date(), allowed = nextSendingTime(now, a);
        if (allowed > now) {
          await db.query("UPDATE announcements SET next_run_at=$2,updated_at=now() WHERE id=$1", [a.id, allowed]);
          return;
        }
        const cycle = a.delivery_cycle_at ?? a.next_run_at;
        // Keep the logical schedule identity stable while next_run_at backs off.
        await db.query("UPDATE announcements SET delivery_cycle_at=$2 WHERE id=$1", [a.id, cycle]);
        // Bound the target set before permissions/retries so a resumed legacy cycle cannot add extra recipients.
        const groups = (await db.query(`SELECT g.*,ug.access_hash,ug.retry_after FROM (
          SELECT group_id FROM announcement_groups WHERE announcement_id=$1 ORDER BY group_id LIMIT $3
        ) ag
          JOIN groups g ON g.id=ag.group_id JOIN user_groups ug ON ug.group_id=g.id AND ug.user_id=$2
          WHERE ug.is_active AND ug.can_post ORDER BY g.id`, [a.id, a.user_id, this.config.maxGroupsPerAnnouncement])).rows;
        // Reuse the downloaded album for every target in this run; release it after the announcement.
        let photos: Promise<string[]> | undefined;
        const loadPhotos = () => photos ??= photoMessageIds(a).length
          ? this.accounts.telegram.execute("photos.read", { ownerId: String(account.telegram_id), messageIds: photoMessageIds(a) })
          : this.downloadPhotos(photosOf(a));
        let retry: Date | undefined;
        for (const group of groups) {
          if (Date.now() >= a.subscriptionBefore) { retry = new Date(Date.now() + 60_000); break; }
          const now = new Date(), allowed = nextSendingTime(now, a);
          if (allowed > now) { retry = allowed; break; }
          const log = await one(db, "SELECT * FROM delivery_logs WHERE announcement_id=$1 AND group_id=$2 AND scheduled_at=$3", [a.id, group.id, cycle]);
          if (log && ["sent", "failed", "skipped"].includes(log.status)) continue;
          if (group.retry_after && group.retry_after > new Date()) { retry = group.retry_after; continue; }
          const limit = await this.rateLimit(db, String(account.telegram_id), group.id);
          if (limit) { retry = limit; break; }
          const result = await this.sendOne(db, a, group, cycle, log, loadPhotos);
          if (result) { retry = result; break; }
          if (a.sourceMissing) break;
          if (!await one(db, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [a.user_id])) break;
        }
        await db.query(`UPDATE announcements SET last_run_at=now(),next_run_at=$2,
          delivery_cycle_at=$3,updated_at=now() WHERE id=$1`,
          [a.id, nextSendingTime(retry ?? new Date(Date.now() + a.interval_minutes * 60_000), a), retry ? cycle : null]);
      });
    }
  }
  private async rateLimit(db: Queryable, sender: string, groupId: string): Promise<Date | undefined> {
    const counts = await one(db, `SELECT count(*) FILTER(WHERE sent_at>now()-interval '1 minute')::int AS minute,
      count(*) FILTER(WHERE sent_at>now()-interval '1 minute' AND group_id=$2)::int AS chat,
      count(*)::int AS daily FROM delivery_logs WHERE sender_telegram_id=$1 AND sent_at>now()-interval '1 day'`, [sender, groupId]);
    if (counts.daily >= this.config.maxDaily) return new Date(Date.now() + 3600_000);
    if (counts.minute >= this.config.maxMessages || counts.chat >= this.config.maxChatMessages) return new Date(Date.now() + 60_000);
  }
  private async downloadPhotos(ids: string[]) {
    const result: string[] = [];
    for (const id of ids) {
      const file = await this.bot.getFile(id);
      if (!file.file_path || (file.file_size ?? 0) > 10 * 1024 * 1024) throw new Failure("PHOTO_UNAVAILABLE");
      const response = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Failure("PHOTO_UNAVAILABLE");
      const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 10 * 1024 * 1024) { await reader.cancel(); throw new Failure("PHOTO_UNAVAILABLE"); }
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { reader.releaseLock(); }
      result.push(Buffer.concat(chunks).toString("base64"));
    }
    return result;
  }
  private async sendOne(db: Queryable, a: any, group: any, cycle: Date, previous: any, loadPhotos: () => Promise<string[]>) {
    const params = await this.accounts.params(db, String(a.user_id));
    const log = previous ?? await one(db, `INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status,sender_telegram_id)
      VALUES($1,$2,$3,'rate_limited',$4) RETURNING *`, [a.id, group.id, cycle, params.expectedId]);
    try {
      const deadline = sendingDeadline(new Date(), a);
      if (Date.now() >= a.subscriptionBefore) throw new Failure("SUBSCRIPTION_EXPIRED");
      if (deadline !== undefined && Date.now() >= deadline) throw new Failure("OUTSIDE_SEND_WINDOW");
      const count = photoCount(a);
      // Only the trailing text remains when Telegram already acknowledged all photos.
      const photos = count && (log.telegram_message_ids?.length ?? 0) >= count
        ? Array<string>(count).fill("") : await loadPhotos();
      if (Date.now() >= a.subscriptionBefore) throw new Failure("SUBSCRIPTION_EXPIRED");
      if (deadline !== undefined && Date.now() >= deadline) throw new Failure("OUTSIDE_SEND_WINDOW");
      const sent = await this.accounts.telegram.execute("send", {
        ...params, chatId: String(group.chat_id), accessHash: group.access_hash, text: renderText(a),
        photos, messageIds: log.telegram_message_ids ?? [], sendBefore: deadline, subscriptionBefore: a.subscriptionBefore,
        deliveryKey: `${a.user_id}:${a.id}:${group.id}:${cycle.toISOString()}`,
      });
      await db.query(`UPDATE delivery_logs SET status='sent',sent_at=now(),telegram_message_id=$2,telegram_message_ids=$3,
        error_code=NULL,error_message=NULL WHERE id=$1`, [log.id, sent.messageIds.at(-1), JSON.stringify(sent.messageIds)]);
    } catch (error) {
      const failure = safeError(error);
      const outsideWindow = failure.code === "OUTSIDE_SEND_WINDOW";
      const expired = failure.code === "SUBSCRIPTION_EXPIRED";
      if (!outsideWindow && !expired) logError("telegram_send_failed", failure);
      const ids = failure.messageIds.length ? failure.messageIds : log.telegram_message_ids ?? [];
      const transient = expired || outsideWindow || failure.seconds > 0 || ["TELEGRAM_UNAVAILABLE", "PHOTO_SOURCE_UNAVAILABLE", "SEND_RESULT_UNKNOWN"].includes(failure.code);
      await db.query(`UPDATE delivery_logs SET status=$2,error_code=$3::text,error_message=$3::text,telegram_message_ids=$4,
        telegram_message_id=$5,sent_at=CASE WHEN $6 THEN now() ELSE sent_at END WHERE id=$1`,
        [log.id, transient ? "rate_limited" : "failed", failure.code, JSON.stringify(ids), ids.at(-1) ?? null, ids.length > 0]);
      if (failure.code === "PHOTO_SOURCE_MISSING") {
        a.sourceMissing = true;
        await db.query("UPDATE announcements SET status='paused' WHERE id=$1", [a.id]);
        await this.bot.sendMessage(params.expectedId, t("delivery.photo_source_missing", {}, a.language), {
          reply_markup: { inline_keyboard: [[{ text: t("announcements.edit_photo", {}, a.language), callback_data: `ann:edit_photo:${a.id}` }]] },
        }).catch(() => {});
      } else if (authErrors.has(failure.code)) {
        await this.accounts.invalidate(db, String(a.user_id));
        await this.bot.sendMessage(params.expectedId, t("account.expired", {}, a.language)).catch(() => {});
      } else if (["CHAT_WRITE_FORBIDDEN", "USER_BANNED_IN_CHANNEL", "CHANNEL_PRIVATE", "CHAT_ADMIN_REQUIRED", "USER_NOT_PARTICIPANT"].includes(failure.code)) {
        await db.query("UPDATE user_groups SET can_post=false WHERE user_id=$1 AND group_id=$2", [a.user_id, group.id]);
        await this.bot.sendMessage(params.expectedId, t("delivery.group_access_lost", {}, a.language)).catch(() => {});
      }
      if (transient) {
        if (outsideWindow) return nextSendingTime(new Date(), a);
        const retry = new Date(Date.now() + Math.max(60, failure.seconds) * 1000);
        if (failure.code.startsWith("SLOWMODE_WAIT")) await db.query("UPDATE user_groups SET retry_after=$3 WHERE user_id=$1 AND group_id=$2", [a.user_id, group.id, retry]);
        else if (failure.seconds > 0) await db.query("UPDATE telegram_accounts SET retry_after=$2 WHERE user_id=$1", [a.user_id, retry]);
        return retry;
      }
    }
  }
  async removePublished(db: Queryable, userId: string, announcementId: string): Promise<number> {
    const records = (await db.query(`SELECT l.*,g.chat_id,ug.access_hash FROM delivery_logs l
      JOIN announcements a ON a.id=l.announcement_id JOIN groups g ON g.id=l.group_id
      LEFT JOIN user_groups ug ON ug.user_id=a.user_id AND ug.group_id=g.id
      WHERE a.id=$1 AND a.user_id=$2`, [announcementId, userId])).rows;
    let failed = 0;
    for (const record of records) {
      const messageIds = record.telegram_message_ids ?? (record.telegram_message_id ? [Number(record.telegram_message_id)] : []);
      if (!messageIds.length) continue;
      try {
        if (record.sender_telegram_id === null) {
          // Only historical Bot API messages are removed by the bot.
          for (const id of messageIds) await this.bot.deleteMessage(String(record.chat_id), id);
        } else {
          const params = await this.accounts.params(db, userId);
          if (String(record.sender_telegram_id) !== params.expectedId) throw new Failure("ACCOUNT_MISMATCH");
          await this.accounts.telegram.execute("delete", { ...params, chatId: String(record.chat_id), accessHash: record.access_hash, messageIds });
        }
      } catch { failed += messageIds.length; }
    }
    return failed;
  }
}
