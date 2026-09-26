import { lockUser, one, Queryable } from "./db";
import { messageLength } from "./content";
import { Language } from "./i18n";
import { Failure } from "./telegram";

export const promotion = { days: 30, messages: 100 } as const;
export const promotionSettings = (db: Queryable) => one(db, "SELECT * FROM promotion_settings WHERE id=1");
export const enrollment = (db: Queryable, userId: string) => one(db, "SELECT * FROM promotion_enrollments WHERE user_id=$1", [userId]);
export async function savePromotionSettings(db: Queryable, adminId: string, payload: any) {
  if (typeof payload?.enabled !== "boolean" || !Number.isSafeInteger(payload.revision)) throw new Failure("INVALID_REQUEST");
  const texts = [payload.text_uz, payload.text_ru];
  if (texts.some(text => typeof text !== "string" || !text.trim() || text.length > 500 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))) throw new Failure("INVALID_REQUEST");
  const result = await one(db, `UPDATE promotion_settings SET enabled=$1,text_uz=$2,text_ru=$3,
    revision=revision+1,updated_by=$4,updated_at=now() WHERE id=1 AND revision=$5 RETURNING *`,
    [payload.enabled, payload.text_uz.trim(), payload.text_ru.trim(), adminId, payload.revision]);
  if (!result) throw new Failure("CONFLICT");
  return result;
}
export async function promotionEligible(db: Queryable, userId: string) {
  return !!await one(db, `SELECT 1 FROM users u WHERE id=$1 AND paid_until IS NULL
    AND (trial_started_at IS NULL OR trial_started_at>now()-interval '30 days')
    AND NOT EXISTS(SELECT 1 FROM tariff_events WHERE user_id=u.id AND action='activate')
    AND NOT EXISTS(SELECT 1 FROM promotion_enrollments WHERE user_id=u.id)`, [userId]);
}
export function promotionFooter(settings: any, language: Language, botUsername: string) {
  if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new Failure("INVALID_REQUEST");
  return `${settings[`text_${language}`]}\nhttps://t.me/${botUsername}`;
}
export async function promotionOffer(db: Queryable, userId: string, language: Language, botUsername?: string) {
  const settings = await promotionSettings(db);
  if (!botUsername || !settings.enabled || !await promotionEligible(db, userId)) return null;
  return { revision: settings.revision, footer: promotionFooter(settings, language, botUsername), language };
}
// Called inside the bot update transaction, with the same per-user lock as delivery and billing.
export async function acceptPromotion(db: Queryable, userId: string, language: Language, botUsername: string, revision: number) {
  await lockUser(db, userId);
  const existing = await enrollment(db, userId);
  if (existing) return existing; // Duplicate taps can never extend or reset the offer.
  const settings = await one(db, "SELECT * FROM promotion_settings WHERE id=1 FOR SHARE");
  if (!settings.enabled || settings.revision !== revision) throw new Failure("PROMOTION_CHANGED");
  if (!await promotionEligible(db, userId)) throw new Failure("PROMOTION_INELIGIBLE");
  const footer = promotionFooter(settings, language, botUsername);
  const active = (await db.query("SELECT * FROM announcements WHERE user_id=$1 AND status='active'", [userId])).rows;
  if (active.some(ad => messageLength({ ...ad, promotion_footer: footer }) > 4096)) throw new Failure("PROMOTION_CONTENT_TOO_LONG");
  const row = await one(db, `INSERT INTO promotion_enrollments(user_id,ends_at,settings_revision,language,footer)
    VALUES($1,now()+interval '30 days',$2,$3,$4) RETURNING *`, [userId, revision, language, footer]);
  await db.query(`UPDATE users SET trial_started_at=COALESCE(trial_started_at,now()),trial_ends_at=$2,updated_at=now() WHERE id=$1`, [userId, row.ends_at]);
  return row;
}
export async function pendingPromotionFooter(db: Queryable, userId: string): Promise<string> {
  const row = await enrollment(db, userId);
  return row && row.sent_count < promotion.messages ? row.footer : "";
}
// The caller holds the delivery lock until both receipt and counter are committed.
// Reserve unfinished publications so retries cannot take the total above 100.
export async function preparePromotionDelivery(db: Queryable, userId: string, log: any): Promise<string | null> {
  if (log.promotion_footer != null) return log.promotion_footer;
  const row = await enrollment(db, userId);
  let footer = "";
  if (row && row.sent_count < promotion.messages) {
    const pending = await one(db, `SELECT count(*)::int n FROM delivery_logs l JOIN announcements a ON a.id=l.announcement_id
      WHERE a.user_id=$1 AND a.status<>'deleted' AND l.status='rate_limited' AND l.promotion_footer<>''`, [userId]);
    if (row.sent_count + pending.n >= promotion.messages) return null;
    // A publication that began before consent keeps its original caption/text on retry.
    if (!(log.telegram_message_ids?.length)) footer = row.footer;
  }
  await db.query("UPDATE delivery_logs SET promotion_footer=$2 WHERE id=$1", [log.id, footer]);
  log.promotion_footer = footer;
  return footer;
}
