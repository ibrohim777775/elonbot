import { one, Queryable } from "./db";
import { Failure } from "./telegram";
export const tariff = { trialDays: 7, paidDays: 30, priceSum: 20_000 } as const;
export interface Plan { trial_started_at?: Date | string | null; trial_ends_at?: Date | string | null; paid_until?: Date | string | null }
export function planState(user: Plan, now = Date.now()) {
  const trialUntil = user.trial_ends_at ? new Date(user.trial_ends_at).getTime() : 0;
  const paidUntil = user.paid_until ? new Date(user.paid_until).getTime() : 0;
  const until = Math.max(trialUntil, paidUntil);
  return { status: paidUntil > now ? "paid" : trialUntil > now ? "trial" : user.trial_started_at ? "expired" : "not_started",
    allowed: until > now, until: until || null };
}
export async function requireCreationAccess(db: Queryable, userId: string, startTrial = false) {
  let user = await one(db, "SELECT trial_started_at,trial_ends_at,paid_until FROM users WHERE id=$1", [userId]);
  if (!user) throw new Failure("NOT_FOUND");
  if (startTrial && !user.trial_started_at) user = await one(db, `UPDATE users SET trial_started_at=now(),trial_ends_at=now()+interval '7 days'
    WHERE id=$1 AND trial_started_at IS NULL RETURNING trial_started_at,trial_ends_at,paid_until`, [userId]) ?? user;
  if (!planState(user).allowed && user.trial_started_at) throw new Failure("SUBSCRIPTION_EXPIRED");
  return user as Plan;
}
