import { one, Queryable } from "./db";
import { planState } from "./billing";
import { currentLanguage, Language, t } from "./i18n";
import { nextSendingTime } from "./schedule";

export function displayTime(value: Date | string | number | null | undefined, language = currentLanguage()) {
  return value == null ? t("delivery.never", {}, language) : new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "uz-UZ", {
    timeZone: "Asia/Tashkent", dateStyle: "short", timeStyle: "short",
  }).format(new Date(value));
}
export interface DeliverySummary {
  cycle: string; total: number; sent: number; waiting: number; failed: number; unavailable: number;
  updatedAt: string; complete: boolean; firstCycle: boolean; health: "ok" | "attention";
}
export function summaryText(summary: DeliverySummary, language: Language = currentLanguage()) {
  const { total, sent, waiting, failed, unavailable } = summary;
  return t("delivery.summary", { total, sent, waiting, failed, unavailable }, language);
}
export async function announcementState(db: Queryable, a: any, language = currentLanguage()) {
  const user = await one(db, "SELECT trial_started_at,trial_ends_at,paid_until FROM users WHERE id=$1", [a.user_id]);
  const account = await one(db, "SELECT retry_after FROM telegram_accounts WHERE user_id=$1", [a.user_id]);
  const available = await one(db, `SELECT count(*)::int n FROM announcement_groups ag JOIN user_groups ug ON ug.group_id=ag.group_id
    WHERE ag.announcement_id=$1 AND ug.user_id=$2 AND ug.is_active AND ug.can_post`, [a.id, a.user_id]);
  let reason = "scheduled", next: Date | null = a.next_run_at ? new Date(a.next_run_at) : null;
  if (a.status === "deleted") reason = "deleted";
  else if (a.status === "paused") reason = a.pause_reason || "manual";
  else if (!planState(user ?? {}).allowed) reason = "expired";
  else if (!account) reason = "account";
  else if (!available.n) reason = "no_groups";
  else {
    const now = new Date();
    if (account.retry_after && new Date(account.retry_after) > now) {
      reason = "telegram_wait";
      next = new Date(Math.max(next?.getTime() ?? 0, new Date(account.retry_after).getTime()));
    } else if (nextSendingTime(now, a) > now) reason = "window";
    else if (a.delivery_cycle_at) reason = "waiting";
    else if (!next || next <= now) reason = "ready";
    next = nextSendingTime(new Date(Math.max(Date.now(), next?.getTime() ?? 0)), a);
  }
  if (["deleted", "manual", "no_groups", "photo_source_missing", "invalid_content", "expired", "account"].includes(reason)) next = null;
  const last = await one(db, "SELECT max(sent_at) AS at FROM delivery_logs WHERE announcement_id=$1", [a.id]);
  return t("delivery.card_state", { state: t(`delivery.state.${reason}`, {}, language),
    last: displayTime(last.at, language), next: displayTime(next, language) }, language)
    + (a.last_delivery_summary ? `\n\n${t("delivery.last_result", {}, language)}\n${summaryText(a.last_delivery_summary, language)}` : "");
}
