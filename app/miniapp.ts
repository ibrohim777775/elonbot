import { Config } from "./config";
import { Database, lockUser, one } from "./db";
import { Groups } from "./groups";
import { MiniAppUser, validateInitData } from "./miniapp-auth";
import { Failure } from "./telegram";

// Mini App only adds groups. Account login, announcements and templates stay in the bot.
export class MiniApp {
  constructor(readonly config: Config, readonly database: Database, readonly groups: Groups) {}
  authenticate(authorization: string) {
    if (!authorization.startsWith("tma ")) throw new Failure("UNAUTHORIZED");
    return validateInitData(authorization.slice(4), this.config.botToken);
  }
  async handle(method: string, path: string, identity: MiniAppUser, data: any = {}) {
    if (!(method === "GET" && path === "/api/state") && !(method === "POST" && ["/api/groups/discover", "/api/groups/connect"].includes(path))) throw new Failure("NOT_FOUND");
    const user = await one(this.database, "SELECT id,language FROM users WHERE telegram_id=$1", [String(identity.id)]);
    if (!user) throw new Failure("LOGIN_REQUIRED");
    const userId = String(user.id);
    if (method === "GET") {
      const [account, connected] = await Promise.all([
        one(this.database, "SELECT 1 FROM telegram_accounts WHERE user_id=$1", [userId]),
        this.groups.list(this.database, userId),
      ]);
      return { accountConnected: !!account, language: user.language,
        connected: connected.map(g => ({ chatId: String(g.chat_id), title: g.title })) };
    }
    const connecting = path === "/api/groups/connect";
    if (connecting && (typeof data.chatId !== "string" || !/^-[1-9]\d{0,18}$/.test(data.chatId))) throw new Failure("INVALID_REQUEST");
    // Commit a discovery cooldown even if the first load has no cache to display.
    const outcome = await this.database.transaction(async db => {
      try {
        if (connecting) await lockUser(db, userId);
        const result = await this.groups.discover(db, userId, !connecting && data.refresh === true);
        if (connecting) {
          const group = result.groups.find(g => g.chatId === data.chatId);
          if (!group) throw new Failure("NOT_FOUND");
          await this.groups.connect(db, userId, group);
          return { group: { chatId: group.chatId, title: group.title } };
        }
        return { groups: result.groups.map(g => ({ chatId: g.chatId, title: g.title, canPost: g.canPost })),
          cached: result.cached, retryAt: result.retryAfter ?? null };
      } catch (error) { if (error instanceof Failure) return error; throw error; }
    });
    if (outcome instanceof Failure) throw outcome;
    return outcome;
  }
}
