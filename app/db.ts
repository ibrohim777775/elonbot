import { Pool, PoolClient } from "pg";
import type { Config } from "./config";
import { logError } from "./log";

export interface Queryable {
  query(sql: string, values?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T>;
}
export class Postgres implements Database {
  readonly pool: Pool;
  constructor(config: Pick<Config, "databaseUrl" | "databaseSsl">) {
    this.pool = new Pool({ connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined, max: 10 });
    this.pool.on("error", error => logError("database_connection_error", error));
  }
  query(sql: string, values?: any[]) { return this.pool.query(sql, values); }
  async transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try { await db.query("BEGIN"); const result = await fn(db); await db.query("COMMIT"); return result; }
    catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }
  close() { return this.pool.end(); }
}
export async function one(db: Queryable, sql: string, values: any[] = []) {
  return (await db.query(sql, values)).rows[0];
}
export async function lockUser(db: Queryable, userId: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`elonbot:user:${userId}`]);
}
