import { Api } from "grammy";
import { Config } from "./config";
import { Database, lockUser, one } from "./db";
import { planState, tariff } from "./billing";
import { photosOf } from "./delivery";
import { MiniAppUser } from "./miniapp-auth";
import { AdminAuth } from "./admin-auth";
import { Broadcasts } from "./broadcasts";
import { Support, requestId } from "./support";
import { Failure } from "./telegram";

const statusSql = `CASE WHEN paid_until>now() THEN 'paid' WHEN trial_ends_at>now() THEN 'trial'
  WHEN trial_started_at IS NOT NULL THEN 'expired' ELSE 'not_started' END`;
const profile = "u.id,u.telegram_id,u.username,u.first_name,u.language,u.created_at,u.updated_at,u.last_activity_at,u.trial_started_at,u.trial_ends_at,u.paid_until";
function pageOf(query: URLSearchParams) {
  const page = Number(query.get("page") ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Failure("INVALID_REQUEST");
  return page;
}
function idOf(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,17}$/.test(value)) throw new Failure("INVALID_REQUEST");
  return value;
}
export class Admin {
  readonly browser: AdminAuth;
  readonly broadcasts: Broadcasts;
  constructor(readonly config: Config, readonly database: Database, readonly support: Support, readonly api: Api) {
    this.browser = new AdminAuth(config, database); this.broadcasts = new Broadcasts(database, api);
  }
  authorize(identity: MiniAppUser) {
    if (!this.config.adminIds.includes(String(identity.id))) throw new Failure("FORBIDDEN");
  }
  authenticate(header: string, cookie = "") {
    return this.browser.authenticate(header, cookie);
  }
  async handle(method: string, path: string, identity: MiniAppUser, payload: any, query = new URLSearchParams()) {
    this.authorize(identity);
    const db = this.database, page = pageOf(query), offset = (page - 1) * 20;
    if (method === "POST" && path === "/admin-api/browser-link") return this.browser.link(identity);
    if (path === "/admin-api/broadcast-templates") {
      if (method === "GET") return this.broadcasts.templates();
      if (method === "POST") return this.broadcasts.saveTemplate(payload);
    }
    if (path === "/admin-api/broadcasts") {
      if (method === "GET") return this.broadcasts.list(page);
      if (method === "POST") return this.broadcasts.create(String(identity.id), payload);
    }
    const broadcast = /^\/admin-api\/broadcasts\/([1-9][0-9]{0,17})(?:\/(start|cancel))?$/.exec(path);
    if (broadcast) {
      if (method === "GET" && !broadcast[2]) return this.broadcasts.detail(broadcast[1], page);
      if (method === "POST" && (broadcast[2] === "start" || broadcast[2] === "cancel")) return this.broadcasts.action(broadcast[1], broadcast[2], String(identity.id));
      throw new Failure("NOT_FOUND");
    }
    if (method === "GET" && path === "/admin-api/overview") {
      const users = await one(db, `SELECT count(*)::int AS users,count(*) FILTER(WHERE paid_until>now())::int AS paid,
        count(*) FILTER(WHERE NOT COALESCE(paid_until>now(),false) AND trial_ends_at>now())::int AS trial,
        count(*) FILTER(WHERE (${statusSql})='expired')::int AS expired FROM users`);
      const totals = await one(db, `SELECT (SELECT count(*)::int FROM telegram_accounts) accounts,
        (SELECT count(*)::int FROM groups) groups,(SELECT count(*)::int FROM announcements) announcements,
        (SELECT count(*)::int FROM templates) templates,
        (SELECT count(*)::int FROM delivery_logs WHERE status='sent' AND sent_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') sent_today,
        (SELECT count(*)::int FROM delivery_logs WHERE status='failed' AND created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent') failed_today,
        (SELECT count(*)::int FROM support_messages WHERE direction='in' AND read_at IS NULL) unread,
        (SELECT COALESCE(sum(amount_sum),0)::text FROM tariff_events WHERE action='activate') activations_sum`);
      return { ...users, ...totals, tariff, admin: identity.first_name };
    }
    if (method === "GET" && path === "/admin-api/users") {
      const search = (query.get("search") ?? "").trim().replace(/^@/, "").slice(0, 100), status = query.get("status") ?? "";
      if (!["", "paid", "trial", "expired", "not_started"].includes(status)) throw new Failure("INVALID_REQUEST");
      const where = `($1='' OR concat_ws(' ',u.first_name,u.username,u.telegram_id::text) ILIKE '%'||$1||'%') AND ($2='' OR (${statusSql})=$2)`;
      const rows = (await db.query(`SELECT ${profile},(${statusSql}) AS plan_status,
        EXISTS(SELECT 1 FROM telegram_accounts ta WHERE ta.user_id=u.id) AS connected,
        (SELECT count(*)::int FROM announcements a WHERE a.user_id=u.id AND a.status<>'deleted') AS announcements,
        (SELECT count(*)::int FROM user_groups ug WHERE ug.user_id=u.id AND ug.is_active) AS groups,
        (SELECT count(*)::int FROM support_messages s WHERE s.user_id=u.id AND direction='in' AND read_at IS NULL) AS unread
        FROM users u WHERE ${where} ORDER BY u.last_activity_at DESC,u.id DESC LIMIT 20 OFFSET $3`, [search, status, offset])).rows;
      return { rows, page, total: (await one(db, `SELECT count(*)::int n FROM users u WHERE ${where}`, [search, status])).n };
    }
    if (method === "GET" && path === "/admin-api/inbox") {
      const rows = (await db.query(`SELECT u.id,u.telegram_id,u.first_name,u.username,s.text,s.kind,s.created_at,s.direction,s.delivery_status,
        (SELECT count(*)::int FROM support_messages m WHERE m.user_id=u.id AND direction='in' AND read_at IS NULL) unread
        FROM users u JOIN LATERAL(SELECT * FROM support_messages WHERE user_id=u.id ORDER BY id DESC LIMIT 1) s ON true
        ORDER BY s.id DESC LIMIT 20 OFFSET $1`, [offset])).rows;
      return { rows, page, total: (await one(db, "SELECT count(DISTINCT user_id)::int n FROM support_messages")).n };
    }
    const match = /^\/admin-api\/users\/([1-9][0-9]{0,17})(?:\/(records|messages|read|reply|tariff))?$/.exec(path);
    if (!match) throw new Failure("NOT_FOUND");
    const id = idOf(match[1]);
    const user = await one(db, `SELECT ${profile} FROM users u WHERE u.id=$1`, [id]);
    if (!user) throw new Failure("NOT_FOUND");
    if (method === "GET" && !match[2]) {
      const account = await one(db, "SELECT telegram_id,created_at,updated_at,retry_after FROM telegram_accounts WHERE user_id=$1", [id]);
      const draft = await one(db, `SELECT data->>'kind' AS kind,data->>'step' AS step,updated_at FROM user_states WHERE user_id=$1 AND updated_at>now()-interval '1 day'`, [id]);
      return { user, plan: planState(user), tariff, account, draft };
    }
    if (method === "GET" && match[2] === "records") return this.records(id, query.get("kind") ?? "announcements", page);
    if (method === "GET" && match[2] === "messages") {
      const before = query.get("before") ? idOf(query.get("before")) : "9223372036854775807";
      const rows = (await db.query(`SELECT id,direction,text,kind,file_name,(file_id IS NOT NULL) has_file,telegram_message_id,
        admin_telegram_id,delivery_status,error_code,read_at,created_at FROM support_messages WHERE user_id=$1 AND id<$2 ORDER BY id DESC LIMIT 51`, [id, before])).rows;
      return { rows: rows.slice(0, 50).reverse(), hasOlder: rows.length > 50 };
    }
    if (method === "POST" && match[2] === "read") {
      const through = idOf(String(payload.throughId));
      await db.query("UPDATE support_messages SET read_at=now() WHERE user_id=$1 AND direction='in' AND read_at IS NULL AND id<=$2", [id, through]);
      return { ok: true };
    }
    if (method === "POST" && match[2] === "reply") return this.support.reply(id, String(identity.id), payload);
    if (method === "POST" && match[2] === "tariff") {
      const key = requestId(payload.requestId), action = payload.action, note = payload.note ?? "";
      if (!["activate", "revoke"].includes(action) || typeof note !== "string" || note.length > 500) throw new Failure("INVALID_REQUEST");
      return db.transaction(async tx => {
        await lockUser(tx, id);
        // Also serialize request IDs reused for different users.
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`elonbot:tariff:${key}`]);
        const previous = await one(tx, "SELECT * FROM tariff_events WHERE request_id=$1", [key]);
        if (previous) {
          if (String(previous.user_id) !== id || previous.action !== action || previous.note !== note) throw new Failure("CONFLICT");
          return previous;
        }
        const before = await one(tx, "SELECT paid_until FROM users WHERE id=$1 FOR UPDATE", [id]);
        const after = await one(tx, `UPDATE users SET paid_until=${action === "activate" ? "GREATEST(now(),trial_ends_at,paid_until)+interval '30 days'" : "NULL"},updated_at=now() WHERE id=$1 RETURNING paid_until`, [id]);
        return one(tx, `INSERT INTO tariff_events(user_id,admin_telegram_id,request_id,action,amount_sum,previous_until,paid_until,note)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, String(identity.id), key, action,
          action === "activate" ? tariff.priceSum : 0, before.paid_until, after.paid_until, note]);
      });
    }
    throw new Failure("NOT_FOUND");
  }
  private async records(id: string, kind: string, page: number) {
    const sources: Record<string, { from: string; fields: string; order: string }> = {
      announcements: { from: "announcements a", fields: `a.*,(SELECT json_agg(json_build_object('id',g.id,'title',g.title,'chat_id',g.chat_id)) FROM announcement_groups ag JOIN groups g ON g.id=ag.group_id WHERE ag.announcement_id=a.id) groups`, order: "a.id DESC" },
      templates: { from: "templates a", fields: `a.*,(SELECT json_agg(json_build_object('id',g.id,'title',g.title,'chat_id',g.chat_id)) FROM template_groups tg JOIN groups g ON g.id=tg.group_id WHERE tg.template_id=a.id) groups`, order: "a.id DESC" },
      groups: { from: "user_groups a JOIN groups g ON g.id=a.group_id", fields: "g.id,g.chat_id,g.title,g.chat_type,g.slow_mode_delay,g.verified_at,a.can_post,a.is_admin,a.is_active,a.connected_at,a.connected_by_telegram_id,a.retry_after", order: "a.id DESC" },
      deliveries: { from: "delivery_logs l JOIN announcements a ON a.id=l.announcement_id JOIN groups g ON g.id=l.group_id", fields: "l.id,l.announcement_id,l.scheduled_at,l.sent_at,l.created_at,l.status,l.error_code,l.telegram_message_id,l.telegram_message_ids,l.sender_telegram_id,g.title,g.chat_id", order: "l.id DESC" },
      tariffs: { from: "tariff_events a", fields: "a.id,a.admin_telegram_id,a.action,a.amount_sum,a.previous_until,a.paid_until,a.note,a.created_at", order: "a.id DESC" },
      notifications: { from: "reply_notifications a", fields: "a.chat_id,a.message_id,a.created_at", order: "a.created_at DESC" },
    };
    const source = sources[kind]; if (!source) throw new Failure("INVALID_REQUEST");
    const rows = (await this.database.query(`SELECT ${source.fields} FROM ${source.from} WHERE a.user_id=$1 ORDER BY ${source.order} LIMIT 20 OFFSET $2`, [id, (page - 1) * 20])).rows;
    if (["announcements", "templates"].includes(kind)) for (const row of rows) {
      row.photo_count = photosOf(row).length; delete row.photo_file_id; delete row.photo_file_ids;
    }
    return { rows, page, total: (await one(this.database, `SELECT count(*)::int n FROM ${source.from} WHERE a.user_id=$1`, [id])).n };
  }
  async file(path: string, identity: MiniAppUser) {
    this.authorize(identity);
    const match = /^\/admin-api\/files\/(support|announcements|templates)\/([1-9][0-9]{0,17})\/([0-3])$/.exec(path);
    if (!match) throw new Failure("NOT_FOUND");
    const table = match[1] === "support" ? "support_messages" : match[1];
    const row = await one(this.database, `SELECT * FROM ${table} WHERE id=$1`, [match[2]]);
    const fileId = row && (table === "support_messages" ? Number(match[3]) === 0 && row.file_id : photosOf(row)[Number(match[3])]);
    if (!fileId) throw new Failure("NOT_FOUND");
    const meta = await this.api.getFile(fileId);
    if (!meta.file_path || (meta.file_size ?? 0) > 20 * 1024 * 1024) throw new Failure("FILE_TOO_LARGE");
    const response = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${meta.file_path}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || !response.body) throw new Failure("FILE_UNAVAILABLE");
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Failure("FILE_TOO_LARGE"); }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { reader.releaseLock(); }
    return { data: Buffer.concat(chunks), name: row.file_name ?? (table !== "support_messages" || row.kind === "photo" ? "photo.jpg" : "attachment"),
      type: table !== "support_messages" || row.kind === "photo" ? "image/jpeg" : "application/octet-stream" };
  }
}
