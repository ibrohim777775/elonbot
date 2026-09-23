import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { Config } from "../config";
import { Database, Queryable } from "../db";
import { encryptSession } from "../crypto";

export const config: Config = {
  botToken: "123456789:test_token", databaseUrl: "postgresql://localhost/test", databaseSsl: false,
  baseUrl: "https://example.test", webhookSecret: "test_secret_123456789", apiId: 12345,
  apiHash: "a".repeat(32), encryptionKey: Buffer.alloc(32, 7), port: 8000, host: "127.0.0.1", trustedProxyIps: ["127.0.0.1", "::1"],
  adminIds: ["101"], maxMessages: 20, maxChatMessages: 1, maxAnnouncements: 10, maxGroupsPerAnnouncement: 30,
};
export function adapter(pg: PGlite | any): Queryable {
  return { async query(sql, values = []) {
    if (sql.includes(";") && values.length === 0) {
      const results = await pg.exec(sql); const result = results.at(-1);
      return { rows: result?.rows ?? [], rowCount: result?.affectedRows ?? 0 };
    }
    const result = await pg.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  } };
}
export async function testDatabase() {
  const pg = new PGlite();
  await pg.exec(await readFile("migrations/001_typescript.sql", "utf8"));
  await pg.exec(await readFile("migrations/002_group_cache.sql", "utf8"));
  await pg.exec(await readFile("migrations/003_sending_window.sql", "utf8"));
  await pg.exec(await readFile("migrations/004_admin_billing_support.sql", "utf8"));
  await pg.exec(await readFile("migrations/005_user_language.sql", "utf8"));
  await pg.exec(await readFile("migrations/006_template_settings.sql", "utf8"));
  await pg.exec(await readFile("migrations/007_admin_browser_broadcasts.sql", "utf8"));
  await pg.exec(await readFile("migrations/008_photo_message_sources.sql", "utf8"));
  await pg.exec(await readFile("migrations/009_delivery_controls.sql", "utf8"));
  await pg.exec(await readFile("migrations/010_login_security.sql", "utf8"));
  const database: Database = { ...adapter(pg), transaction: fn => pg.transaction(tx => fn(adapter(tx))) };
  return { pg, database };
}
export async function seed(database: Queryable) {
  await database.query("INSERT INTO users(id,telegram_id,first_name) VALUES(1,101,'First'),(2,202,'Second')");
  // Unrelated transport tests also exercise clocks in 2030; subscription tests set their own dates.
  await database.query("UPDATE users SET paid_until='2100-01-01' WHERE id IN (1,2)");
  for (const [user, telegram] of [["1", "101"], ["2", "202"]]) await database.query(
    "INSERT INTO telegram_accounts(user_id,telegram_id,encrypted_session) VALUES($1,$2,$3)",
    [user, telegram, encryptSession(`session-${user}`, config.encryptionKey, user)]);
  await database.query("INSERT INTO groups(id,chat_id,title,chat_type) VALUES(1,-100123,'Group one','supergroup'),(2,-100456,'Group two','supergroup')");
  await database.query("SELECT setval(pg_get_serial_sequence('groups','id'),2)");
  await database.query("SELECT setval(pg_get_serial_sequence('users','id'),2)");
  await database.query(`INSERT INTO user_groups(user_id,group_id,connected_by_telegram_id,can_post,access_hash)
    VALUES(1,1,101,true,'111'),(1,2,101,true,'112'),(2,1,202,true,'222')`);
}
export async function announcement(db: Queryable, userId = "1", groups = ["1", "2"]) {
  const row = (await db.query(`INSERT INTO announcements(user_id,text,interval_minutes,first_run_mode,next_run_at)
    VALUES($1,'Hello <world>',5,'immediate',now()-interval '1 second') RETURNING id`, [userId])).rows[0];
  for (const group of groups) await db.query("INSERT INTO announcement_groups(announcement_id,group_id) VALUES($1,$2)", [row.id, group]);
  return String(row.id);
}
export async function addGroups(db: Queryable, count: number) {
  await db.query(`WITH added AS (
    INSERT INTO groups(chat_id,title,chat_type)
    SELECT -200000-n,'Group ' || lpad(n::text,3,'0'),'supergroup'::chat_type FROM generate_series(1,$1::int) n RETURNING id
  ) INSERT INTO user_groups(user_id,group_id,connected_by_telegram_id,can_post,access_hash)
    SELECT 1,id,101,true,'111' FROM added`, [count]);
  return (await db.query("SELECT group_id FROM user_groups WHERE user_id=1 ORDER BY group_id")).rows.map(g => String(g.group_id));
}
