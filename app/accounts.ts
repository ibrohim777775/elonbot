import { createHash, randomBytes } from "node:crypto";
import { Config } from "./config";
import { decryptSession, encryptSession } from "./crypto";
import { Database, lockUser, one, Queryable } from "./db";
import { Failure, safeError } from "./telegram";

export interface TelegramTransport { execute(method: string, params: Record<string, any>): Promise<any> }
export const authErrors = new Set(["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "SESSION_EXPIRED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "ACCOUNT_MISMATCH"]);
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Accounts {
  constructor(readonly config: Config, readonly telegram: TelegramTransport) {}
  async params(db: Queryable, userId: string) {
    const account = await one(db, "SELECT * FROM telegram_accounts WHERE user_id=$1", [userId]);
    if (!account) throw new Failure("LOGIN_REQUIRED");
    return { userId, expectedId: String(account.telegram_id),
      session: decryptSession(account.encrypted_session, this.config.encryptionKey, userId) };
  }
  async invalidate(db: Queryable, userId: string) {
    await db.query("DELETE FROM telegram_accounts WHERE user_id=$1", [userId]);
    await db.query("UPDATE user_groups SET can_post=false WHERE user_id=$1", [userId]);
  }
  async link(db: Queryable, userId: string) {
    if (await one(db, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [userId])) throw new Failure("ALREADY_CONNECTED");
    const token = randomBytes(32).toString("base64url");
    await db.query(`INSERT INTO account_logins(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')
      ON CONFLICT(user_id) DO UPDATE SET token_hash=$1,expires_at=now()+interval '10 minutes',attempts=0`, [tokenHash(token), userId]);
    return `${this.config.baseUrl}/account#${token}`;
  }
  async login(database: Database, token: string, action: string, value: string) {
    if (!/^[\w-]{43}$/.test(token) || !["begin", "code", "password"].includes(action) || !value || value.length > 256) throw new Failure("INVALID_LOGIN_STEP");
    // Return the failure after committing, so failed attempts cannot bypass the limit.
    const outcome = await database.transaction(async db => {
      const owner = await one(db, "SELECT user_id FROM account_logins WHERE token_hash=$1", [tokenHash(token)]);
      if (!owner) return new Failure("LOGIN_EXPIRED");
      await lockUser(db, String(owner.user_id));
      const login = await one(db, `SELECT l.*,u.telegram_id FROM account_logins l JOIN users u ON u.id=l.user_id
        WHERE token_hash=$1 AND expires_at>now() FOR UPDATE OF l`, [tokenHash(token)]);
      if (!login || login.attempts >= 10) return new Failure("LOGIN_EXPIRED");
      await db.query("UPDATE account_logins SET attempts=attempts+1 WHERE token_hash=$1", [tokenHash(token)]);
      try {
        if (await one(db, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [login.user_id])) return new Failure("ALREADY_CONNECTED");
        const result = await this.telegram.execute(`login.${action}`, {
          key: tokenHash(token), value, expectedId: String(login.telegram_id),
        });
        if (result.stage === "done") {
          if (String(result.telegramId) !== String(login.telegram_id)) throw new Failure("ACCOUNT_MISMATCH");
          await db.query("INSERT INTO telegram_accounts(user_id,telegram_id,encrypted_session) VALUES($1,$2,$3)",
            [login.user_id, login.telegram_id, encryptSession(result.session, this.config.encryptionKey, String(login.user_id))]);
          await db.query("DELETE FROM account_logins WHERE user_id=$1", [login.user_id]);
        }
        return { stage: result.stage };
      } catch (error) { return safeError(error); }
    });
    if (outcome instanceof Failure) throw outcome;
    return outcome;
  }
  async logout(db: Queryable, userId: string) {
    try { await this.telegram.execute("logout", await this.params(db, userId)); }
    catch (error) { if (!authErrors.has(safeError(error).code) && safeError(error).code !== "LOGIN_REQUIRED") throw safeError(error); }
    await this.invalidate(db, userId);
    await db.query("DELETE FROM account_logins WHERE user_id=$1", [userId]);
  }
  async restore(database: Database) {
    for (const row of (await database.query("SELECT user_id FROM telegram_accounts")).rows) {
      await database.transaction(async db => {
        const userId = String(row.user_id);
        await lockUser(db, userId);
        try { await this.telegram.execute("restore", await this.params(db, userId)); }
        catch (error) {
          if (authErrors.has(safeError(error).code)) await this.invalidate(db, userId);
          else console.error("account_restore_failed", { userId, code: safeError(error).code });
        }
      });
    }
  }
}
