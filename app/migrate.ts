import { readFile } from "node:fs/promises";
import { loadConfig } from "./config";
import { Database, Postgres } from "./db";
import { logError } from "./log";

export async function migrate(database: Database) {
  const migrations = await Promise.all(["001_typescript", "002_group_cache", "003_sending_window", "004_admin_billing_support", "005_user_language", "006_template_settings", "007_admin_browser_broadcasts", "008_photo_message_sources", "009_delivery_controls"].map(async version =>
    ({ version, sql: await readFile(`migrations/${version}.sql`, "utf8") })));
  await database.transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(809142026)");
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const { version, sql } of migrations) {
      if ((await db.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version])).rows.length) continue;
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
    }
  });
}
if (require.main === module) {
  const database = new Postgres(loadConfig());
  migrate(database).then(() => console.log("Migration complete"))
    .catch(error => { logError("migration_failed", error); process.exitCode = 1; })
    .finally(() => database.close());
}
