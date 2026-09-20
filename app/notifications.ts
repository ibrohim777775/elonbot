import { Api } from "grammy";
import { Database, one, Queryable } from "./db";
import { planState } from "./billing";
import { displayTime, summaryText } from "./announcement-state";
import { languageOf, t } from "./i18n";

export async function enqueueNotification(db: Queryable, userId: string, key: string, kind: string, payload: object) {
  await db.query(`INSERT INTO user_notifications(user_id,dedup_key,kind,payload) VALUES($1,$2,$3,$4)
    ON CONFLICT(dedup_key) DO NOTHING`, [userId, key, kind, JSON.stringify(payload)]);
}

export class Notifications {
  private running?: Promise<void>;
  constructor(readonly database: Database, readonly api: Api) {}
  run() {
    return this.running ??= this.process().finally(() => { this.running = undefined; });
  }
  async wait() { await this.running; }
  async maintain() {
    // An interrupted request may already have reached Telegram. Do not send it twice.
    await this.database.query(`UPDATE user_notifications SET status='unknown',error_code='INTERRUPTED',updated_at=now()
      WHERE status='sending' AND updated_at<now()-interval '5 minutes'`);
    await this.database.query("DELETE FROM delivery_usage WHERE sent_at<now()-interval '1 day'");
    const users = (await this.database.query(`SELECT id,trial_started_at,trial_ends_at,paid_until FROM users
      WHERE GREATEST(trial_ends_at,paid_until)<=now()+interval '1 day'
      AND (GREATEST(trial_ends_at,paid_until)>now()-interval '1 day'
        OR EXISTS(SELECT 1 FROM announcements a WHERE a.user_id=users.id AND a.status='active'))`)).rows;
    for (const user of users) {
      const plan = planState(user);
      if (!plan.until) continue;
      const until = new Date(plan.until).toISOString(), kind = plan.allowed ? "tariff_expiring" : "tariff_expired";
      await enqueueNotification(this.database, String(user.id), `${kind}:${user.id}:${until}`, kind, { until, trial: plan.status === "trial" });
    }
  }
  private async process() {
    const notice = await this.database.transaction(async db => {
      const row = await one(db, `SELECT * FROM user_notifications WHERE status='pending' AND available_at<=now()
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (row) await db.query("UPDATE user_notifications SET status='sending',updated_at=now() WHERE id=$1", [row.id]);
      return row;
    });
    if (!notice) return;
    const finish = (status: string, code: string | null = null, messageId: number | null = null) => this.database.query(
      "UPDATE user_notifications SET status=$2,error_code=$3,telegram_message_id=$4,updated_at=now() WHERE id=$1",
      [notice.id, status, code, messageId]);
    try {
      const user = await one(this.database, "SELECT * FROM users WHERE id=$1", [notice.user_id]);
      if (!user) { await finish("skipped"); return; }
      const language = languageOf(user.language), plan = planState(user), p = notice.payload;
      let text: string, button: { text: string; callback_data: string };
      if (notice.kind.startsWith("tariff_")) {
        if (!plan.until || new Date(plan.until).toISOString() !== p.until
          || (notice.kind === "tariff_expiring" && !plan.allowed)
          || (notice.kind === "tariff_expired" && plan.allowed)) { await finish("skipped"); return; }
        const eligible = await one(this.database, `SELECT count(*)::int n FROM announcements a WHERE a.user_id=$1 AND a.status='active'
          AND EXISTS(SELECT 1 FROM telegram_accounts ta WHERE ta.user_id=a.user_id)
          AND EXISTS(SELECT 1 FROM announcement_groups ag JOIN user_groups ug ON ug.group_id=ag.group_id
            WHERE ag.announcement_id=a.id AND ug.user_id=a.user_id AND ug.is_active AND ug.can_post)`, [user.id]);
        const key = notice.kind === "tariff_activated" ? "tariff.notification_activated"
          : notice.kind === "tariff_expired" ? "tariff.notification_expired"
          : p.trial ? "tariff.notification_trial" : "tariff.notification_expiring";
        text = t(key, { until: displayTime(p.until, language), count: eligible.n }, language);
        button = { text: t("menu.tariff", {}, language), callback_data: "settings:tariff" };
      } else {
        const ad = await one(this.database, "SELECT id,status FROM announcements WHERE id=$1 AND user_id=$2", [p.announcementId, user.id]);
        if (!ad || ad.status === "deleted") { await finish("skipped"); return; }
        text = `${t("delivery.notification", { id: ad.id, time: displayTime(p.summary.updatedAt, language) }, language)}\n${summaryText(p.summary, language)}`;
        if (p.recovered) text = `${t("delivery.recovered", {}, language)}\n${text}`;
        button = { text: t("delivery.open_announcement", {}, language), callback_data: `ann:show:${ad.id}` };
      }
      const message = await this.api.sendMessage(String(user.telegram_id), text, { reply_markup: { inline_keyboard: [[button]] } });
      await finish("sent", null, message.message_id);
    } catch (error) {
      const failure = error as any, code = Number(failure.error_code ?? failure.error?.error_code);
      const seconds = Number(failure.parameters?.retry_after ?? failure.error?.parameters?.retry_after);
      if (code === 429 && seconds > 0) {
        await this.database.query(`UPDATE user_notifications SET status='pending',error_code='RATE_LIMITED',
          available_at=$2,updated_at=now() WHERE id=$1`, [notice.id, new Date(Date.now() + seconds * 1000)]);
      } else await finish([400, 401, 403, 404].includes(code) ? "failed" : "unknown", Number.isFinite(code) ? `TELEGRAM_${code}` : "RESULT_UNKNOWN");
    }
  }
}
