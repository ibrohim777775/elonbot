import { Accounts, authErrors } from "./accounts";
import { lockUser, one, Queryable } from "./db";
import { Failure, safeError } from "./telegram";

export interface AccountGroup {
  chatId: string; title: string; chatType: "group" | "supergroup";
  accessHash: string | null; canPost: boolean; isAdmin: boolean;
}
export interface GroupDiscovery { groups: AccountGroup[]; cached: boolean; retryAfter?: Date }
const cacheTtl = 5 * 60_000;
const refreshInterval = 60_000;
export class Groups {
  constructor(readonly accounts: Accounts) {}
  async discover(db: Queryable, userId: string, refresh = false): Promise<GroupDiscovery> {
    const readCache = () => one(db, `SELECT c.* FROM telegram_accounts a
      LEFT JOIN telegram_group_cache c ON c.user_id=a.user_id WHERE a.user_id=$1`, [userId]);
    const cachedResult = (cached: any): GroupDiscovery | undefined => {
    if (!cached) throw new Failure("LOGIN_REQUIRED");
    const retryAfter = cached.retry_after && new Date(cached.retry_after);
    if (retryAfter && retryAfter.getTime() > Date.now()) {
      if (cached.groups !== null) return { groups: cached.groups, cached: true, retryAfter };
      throw new Failure("GROUPS_RATE_LIMITED", Math.ceil((retryAfter.getTime() - Date.now()) / 1000));
    }
    if (cached.groups !== null && Date.now() - new Date(cached.fetched_at).getTime() < (refresh ? refreshInterval : cacheTtl)) {
      return { groups: cached.groups, cached: true };
    }
    };
    let cached = await readCache();
    const hit = cachedResult(cached); if (hit) return hit;
    // Cached menus need no delivery lock. A real refresh coordinates with logout and permission changes.
    await lockUser(db, userId);
    // Another Mini App request may have refreshed the cache while this request waited.
    cached = await readCache();
    const refreshed = cachedResult(cached); if (refreshed) return refreshed;
    let groups: AccountGroup[];
    try { groups = (await this.accounts.telegram.execute("groups", await this.accounts.params(db, userId))).groups; }
    catch (error) {
      const failure = safeError(error);
      console.error("group_discovery_failed", { code: failure.code, seconds: failure.seconds });
      if (authErrors.has(failure.code)) await this.accounts.invalidate(db, userId);
      if (failure.seconds > 0) {
        const retryAfter = new Date(Date.now() + failure.seconds * 1000);
        await db.query(`INSERT INTO telegram_group_cache(user_id,retry_after) VALUES($1,$2)
          ON CONFLICT(user_id) DO UPDATE SET retry_after=$2`, [userId, retryAfter]);
        if (cached.groups !== null) return { groups: cached.groups, cached: true, retryAfter };
        throw new Failure("GROUPS_RATE_LIMITED", failure.seconds);
      }
      throw failure;
    }
    // Only existing user connections are refreshed; discovery never subscribes a user automatically.
    const data = JSON.stringify(groups);
    await db.query(`WITH discovered AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS r("chatId" bigint,"canPost" boolean,"isAdmin" boolean,"accessHash" text)
    ) UPDATE user_groups ug SET can_post=COALESCE(d."canPost",false),is_admin=COALESCE(d."isAdmin",false),access_hash=COALESCE(d."accessHash",ug.access_hash)
      FROM groups g LEFT JOIN discovered d ON d."chatId"=g.chat_id
      WHERE ug.user_id=$1 AND ug.group_id=g.id`, [userId, data]);
    await db.query(`UPDATE groups g SET title=d.title,verified_at=now()
      FROM jsonb_to_recordset($2::jsonb) AS d("chatId" bigint,title text)
      WHERE g.chat_id=d."chatId" AND EXISTS(SELECT 1 FROM user_groups ug WHERE ug.group_id=g.id AND ug.user_id=$1)`, [userId, data]);
    await db.query(`INSERT INTO telegram_group_cache(user_id,groups,fetched_at) VALUES($1,$2,clock_timestamp())
      ON CONFLICT(user_id) DO UPDATE SET groups=$2,fetched_at=clock_timestamp(),retry_after=NULL`, [userId, data]);
    return { groups, cached: false };
  }
  async connect(db: Queryable, userId: string, group: AccountGroup) {
    if (!group.canPost) throw new Failure("CHAT_WRITE_FORBIDDEN");
    const record = await one(db, `INSERT INTO groups(chat_id,title,chat_type) VALUES($1,$2,$3)
      ON CONFLICT(chat_id) DO UPDATE SET title=$2,verified_at=now() RETURNING id`, [group.chatId, group.title, group.chatType]);
    const owner = await one(db, "SELECT telegram_id FROM users WHERE id=$1", [userId]);
    await db.query(`INSERT INTO user_groups(user_id,group_id,connected_by_telegram_id,can_post,is_admin,access_hash)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,group_id) DO UPDATE SET is_active=true,can_post=$4,is_admin=$5,access_hash=$6`,
      [userId, record.id, owner.telegram_id, group.canPost, group.isAdmin, group.accessHash]);
  }
  list(db: Queryable, userId: string) {
    return db.query(`SELECT g.*,ug.can_post,ug.is_admin,ug.access_hash,ug.retry_after FROM groups g JOIN user_groups ug ON ug.group_id=g.id
      WHERE ug.user_id=$1 AND ug.is_active ORDER BY g.title,g.id`, [userId]).then(r => r.rows);
  }
}
