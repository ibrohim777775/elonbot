import { createHash, randomBytes } from "node:crypto";
import { Config } from "./config";
import { Database, one, Queryable } from "./db";
import { MiniAppUser, validateInitData } from "./miniapp-auth";
import { Failure } from "./telegram";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const valid = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
export class AdminAuth {
  constructor(readonly config: Config, readonly database: Database) {}
  authorize(user: MiniAppUser) {
    if (!this.config.adminIds.includes(String(user.id))) throw new Failure("FORBIDDEN");
  }
  async link(user: MiniAppUser, db: Queryable = this.database) {
    this.authorize(user);
    const token = randomBytes(32).toString("base64url");
    await db.query(`INSERT INTO admin_browser_tokens(token_hash,admin_telegram_id,first_name,kind,expires_at)
      VALUES($1,$2,$3,'login',now()+interval '5 minutes')`, [hash(token), String(user.id), user.first_name]);
    return { url: `${this.config.baseUrl}/admin#login=${token}`, expiresIn: 300 };
  }
  private cookieName() { return new URL(this.config.baseUrl).protocol === "https:" ? "__Host-elonbot_admin" : "elonbot_admin"; }
  private token(cookie: string) { return cookie.split(";").map(x => x.trim()).find(x => x.startsWith(this.cookieName() + "="))?.slice(this.cookieName().length + 1) ?? ""; }
  cookie(token: string, clear = false) {
    return `${this.cookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${new URL(this.config.baseUrl).protocol === "https:" ? "; Secure" : ""}`;
  }
  async exchange(token: unknown) {
    if (!valid(token)) throw new Failure("UNAUTHORIZED");
    return this.database.transaction(async db => {
      const row = await one(db, "DELETE FROM admin_browser_tokens WHERE token_hash=$1 AND kind='login' AND expires_at>now() RETURNING *", [hash(token)]);
      if (!row) throw new Failure("AUTH_EXPIRED");
      this.authorize({ id: Number(row.admin_telegram_id), first_name: row.first_name });
      const session = randomBytes(32).toString("base64url");
      await db.query(`INSERT INTO admin_browser_tokens(token_hash,admin_telegram_id,first_name,kind,expires_at)
        VALUES($1,$2,$3,'session',now()+interval '12 hours')`, [hash(session), row.admin_telegram_id, row.first_name]);
      return this.cookie(session);
    });
  }
  async authenticate(header: string, cookie = "") {
    if (header) {
      if (!header.startsWith("tma ")) throw new Failure("UNAUTHORIZED");
      const user = validateInitData(header.slice(4), this.config.botToken); this.authorize(user); return user;
    }
    const token = this.token(cookie);
    if (!valid(token)) throw new Failure("UNAUTHORIZED");
    const row = await one(this.database, "SELECT admin_telegram_id,first_name FROM admin_browser_tokens WHERE token_hash=$1 AND kind='session' AND expires_at>now()", [hash(token)]);
    if (!row) throw new Failure("AUTH_EXPIRED");
    const user = { id: Number(row.admin_telegram_id), first_name: row.first_name }; this.authorize(user); return user;
  }
  async logout(cookie: string) {
    const token = this.token(cookie);
    if (valid(token)) await this.database.query("DELETE FROM admin_browser_tokens WHERE token_hash=$1 AND kind='session'", [hash(token)]);
    return this.cookie("", true);
  }
}
