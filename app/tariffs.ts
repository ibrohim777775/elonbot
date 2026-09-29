import { Database, one, Queryable } from "./db";
import { Failure } from "./telegram";
export const planCodes = ["basic", "standard", "pro"] as const;
export type PlanCode = typeof planCodes[number];
export interface TariffPlan { code: PlanCode; group_limit: number; price_sum: number }
export interface TariffCatalog { revision: number; plans: TariffPlan[] }
export async function tariffCatalog(db: Queryable): Promise<TariffCatalog> {
  // One statement gives a consistent revision and prices even during an admin edit.
  const row = await one(db, `SELECT revision,(SELECT json_agg(p ORDER BY p.sort_order) FROM tariff_plans p) plans FROM tariff_catalog WHERE id=1`);
  return { revision: row.revision, plans: row.plans };
}
export async function baseGroupLimit(db: Queryable): Promise<number> {
  return (await one(db, "SELECT group_limit FROM tariff_plans WHERE code='basic'")).group_limit;
}
export async function userGroupLimit(db: Queryable, userId: string): Promise<number> {
  const row = await one(db, `SELECT CASE WHEN paid_until>now() THEN paid_group_limit
    WHEN trial_ends_at>now() THEN COALESCE(trial_group_limit,p.group_limit) ELSE p.group_limit END group_limit
    FROM users CROSS JOIN tariff_plans p WHERE users.id=$1 AND p.code='basic'`, [userId]);
  if (!row) throw new Failure("NOT_FOUND");
  return row.group_limit;
}
export async function saveTariffCatalog(database: Database, adminId: string, payload: any) {
  if (!Number.isSafeInteger(payload?.revision) || !Array.isArray(payload.plans) || payload.plans.length !== planCodes.length) throw new Failure("INVALID_REQUEST");
  for (const code of planCodes) {
    const rows = payload.plans.filter((p: any) => p?.code === code);
    if (rows.length !== 1 || [rows[0].group_limit, rows[0].price_sum].some(n => !Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647)) throw new Failure("INVALID_REQUEST");
  }
  return database.transaction(async db => {
    // Same lock order as promotion consent: its free group limit is also a term.
    await db.query("SELECT id FROM promotion_settings WHERE id=1 FOR UPDATE");
    const current = await one(db, "SELECT revision FROM tariff_catalog WHERE id=1 FOR UPDATE");
    if (current.revision !== payload.revision) throw new Failure("CONFLICT");
    const oldLimit = await baseGroupLimit(db);
    for (const p of payload.plans) await db.query("UPDATE tariff_plans SET group_limit=$2,price_sum=$3 WHERE code=$1", [p.code,p.group_limit,p.price_sum]);
    await db.query("UPDATE tariff_catalog SET revision=revision+1,updated_by=$1,updated_at=now() WHERE id=1", [adminId]);
    if (oldLimit !== await baseGroupLimit(db)) await db.query("UPDATE promotion_settings SET revision=revision+1,updated_at=now(),updated_by=$1 WHERE id=1", [adminId]);
    return tariffCatalog(db);
  });
}
