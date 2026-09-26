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
import { renderText, messageLength } from "./content";
import { DeliverySummary } from "./announcement-state";
import { enqueueNotification } from "./notifications";
import { preparePromotionDelivery } from "./promotion";
export { photosOf } from "./media";
export { renderText } from "./content";
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
        // Freeze recipients for the whole cycle, including groups with lost permissions.
        if (!a.cycle_initialized) {
          await db.query(`INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,status,sender_telegram_id)
            SELECT $1,group_id,$2,'rate_limited',$3 FROM announcement_groups WHERE announcement_id=$1
            ORDER BY group_id LIMIT $4 ON CONFLICT(announcement_id,group_id,scheduled_at) DO NOTHING`,
            [a.id, cycle, account.telegram_id, this.config.maxGroupsPerAnnouncement]);
          await db.query("UPDATE announcements SET cycle_initialized=true WHERE id=$1", [a.id]);
        }
        const groups = (await db.query(`SELECT g.*,ug.access_hash,ug.retry_after,
          (ug.is_active AND ug.can_post AND ag.group_id IS NOT NULL) AS available FROM delivery_logs l
          JOIN groups g ON g.id=l.group_id LEFT JOIN user_groups ug ON ug.group_id=g.id AND ug.user_id=$2
          LEFT JOIN announcement_groups ag ON ag.announcement_id=l.announcement_id AND ag.group_id=g.id
          WHERE l.announcement_id=$1 AND l.scheduled_at=$3 ORDER BY g.id`, [a.id, a.user_id, cycle])).rows;
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
          if (!group.available) {
            await db.query("UPDATE delivery_logs SET status='skipped',error_code='GROUP_UNAVAILABLE' WHERE id=$1", [log.id]);
            continue;
          }
          if (group.retry_after && group.retry_after > new Date()) { retry = group.retry_after; continue; }
          const limit = await this.rateLimit(db, String(account.telegram_id), String(group.chat_id));
          if (limit) {
            await db.query("UPDATE delivery_logs SET error_code=COALESCE(error_code,'LOCAL_RATE_LIMIT') WHERE id=$1", [log.id]);
            retry = limit; continue;
          }
          const result = await this.sendOne(db, a, group, cycle, log, loadPhotos);
          if (result) { retry = result; break; }
          if (a.sourceMissing || a.invalidContent) break;
          if (!await one(db, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [a.user_id])) break;
        }
        if (a.sourceMissing || a.invalidContent) await db.query(`UPDATE delivery_logs SET status='failed',error_code=$3
          WHERE announcement_id=$1 AND scheduled_at=$2 AND status='rate_limited'`,
          [a.id, cycle, a.sourceMissing ? "PHOTO_SOURCE_MISSING" : "MESSAGE_TOO_LONG"]);
        const available = await one(db, `SELECT 1 FROM announcement_groups ag JOIN user_groups ug ON ug.group_id=ag.group_id
          WHERE ag.announcement_id=$1 AND ug.user_id=$2 AND ug.is_active AND ug.can_post LIMIT 1`, [a.id, a.user_id]);
        if (!available) await db.query("UPDATE announcements SET status='paused',pause_reason='no_groups' WHERE id=$1 AND status='active'", [a.id]);
        const counts = await one(db, `SELECT count(*)::int total,
          count(*) FILTER(WHERE status='sent')::int sent, count(*) FILTER(WHERE status='rate_limited')::int waiting,
          count(*) FILTER(WHERE status='failed')::int failed, count(*) FILTER(WHERE status='skipped')::int unavailable,
          count(*) FILTER(WHERE status='rate_limited' AND error_code IS NOT NULL AND error_code NOT IN ('LOCAL_RATE_LIMIT','OUTSIDE_SEND_WINDOW'))::int problems
          FROM delivery_logs WHERE announcement_id=$1 AND scheduled_at=$2`, [a.id, cycle]);
        const old: DeliverySummary | null = a.last_delivery_summary;
        const summary: DeliverySummary = { cycle: cycle.toISOString(), total: counts.total, sent: counts.sent, waiting: counts.waiting,
          failed: counts.failed, unavailable: counts.unavailable, updatedAt: new Date().toISOString(), complete: !counts.waiting,
          firstCycle: !old || (old.cycle === cycle.toISOString() && old.firstCycle),
          health: counts.failed || counts.unavailable || counts.problems || !available ? "attention" : "ok" };
        // A pending cycle has not yet proved recovery from the previous failure.
        if (old?.health === "attention" && summary.waiting) summary.health = "attention";
        const phase = summary.complete ? "complete" : "progress";
        if (summary.firstCycle || (old ? old.health !== summary.health : summary.health === "attention")) {
          await enqueueNotification(db, String(a.user_id), `delivery:${a.id}:${summary.cycle}:${phase}:${summary.health}`,
            "delivery_result", { announcementId: String(a.id), summary, recovered: old?.health === "attention" && summary.health === "ok" });
        }
        if (!summary.complete) retry ??= new Date(Date.now() + 60_000);
        else retry = undefined;
        await db.query(`UPDATE announcements SET last_run_at=now(),next_run_at=$2,delivery_cycle_at=$3,
          cycle_initialized=$4,last_delivery_summary=$5,updated_at=now() WHERE id=$1`,
          [a.id, nextSendingTime(retry ?? new Date(Date.now() + a.interval_minutes * 60_000), a),
            summary.complete ? null : cycle, !summary.complete, JSON.stringify(summary)]);
      });
    }
  }
  private async rateLimit(db: Queryable, sender: string, groupId: string): Promise<Date | undefined> {
    const counts = await one(db, `SELECT count(*)::int AS minute,
      count(*) FILTER(WHERE chat_id=$2)::int AS chat
      FROM delivery_usage WHERE sender_telegram_id=$1 AND sent_at>now()-interval '1 minute'`, [sender, groupId]);
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
      const footer = await preparePromotionDelivery(db, String(a.user_id), log);
      if (footer === null) return new Date(Date.now() + 60_000);
      const content = { ...a, promotion_footer: footer };
      if (messageLength(content) > 4096) throw new Failure("MESSAGE_TOO_LONG");
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
        ...params, chatId: String(group.chat_id), accessHash: group.access_hash, text: renderText(content),
        photos, messageIds: log.telegram_message_ids ?? [], sendBefore: deadline, subscriptionBefore: a.subscriptionBefore,
        deliveryKey: `${a.user_id}:${a.id}:${group.id}:${cycle.toISOString()}`,
      });
      await db.query(`UPDATE delivery_logs SET status='sent',sent_at=now(),telegram_message_id=$2,telegram_message_ids=$3,
        error_code=NULL,error_message=NULL WHERE id=$1`, [log.id, sent.messageIds.at(-1), JSON.stringify(sent.messageIds)]);
      if (footer) await db.query("UPDATE promotion_enrollments SET sent_count=sent_count+1 WHERE user_id=$1", [a.user_id]);
    } catch (error) {
      const failure = safeError(error);
      const outsideWindow = failure.code === "OUTSIDE_SEND_WINDOW";
      const expired = failure.code === "SUBSCRIPTION_EXPIRED";
      if (!outsideWindow && !expired) logError("telegram_send_failed", failure);
      const ids = failure.messageIds.length ? failure.messageIds : log.telegram_message_ids ?? [];
      const transient = expired || outsideWindow || failure.seconds > 0 || ["TELEGRAM_UNAVAILABLE", "PHOTO_SOURCE_UNAVAILABLE", "SEND_RESULT_UNKNOWN"].includes(failure.code);
      await db.query(`UPDATE delivery_logs SET status=$2,error_code=$3::text,error_message=$3::text,telegram_message_ids=$4,
        telegram_message_id=$5,sent_at=CASE WHEN $6 THEN now() ELSE sent_at END WHERE id=$1`,
        [log.id, transient ? "rate_limited" : "failed", failure.code, JSON.stringify(ids), ids.at(-1) ?? null, ids.length > (log.telegram_message_ids?.length ?? 0)]);
      if (failure.code === "PHOTO_SOURCE_MISSING") {
        a.sourceMissing = true;
        await db.query("UPDATE announcements SET status='paused',pause_reason='photo_source_missing' WHERE id=$1", [a.id]);
        await this.bot.sendMessage(params.expectedId, t("delivery.photo_source_missing", {}, a.language), {
          reply_markup: { inline_keyboard: [[{ text: t("announcements.edit_photo", {}, a.language), callback_data: `ann:edit_photo:${a.id}` }]] },
        }).catch(() => {});
      } else if (failure.code === "MESSAGE_TOO_LONG") {
        a.invalidContent = true;
        await db.query("UPDATE announcements SET status='paused',pause_reason='invalid_content' WHERE id=$1", [a.id]);
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
