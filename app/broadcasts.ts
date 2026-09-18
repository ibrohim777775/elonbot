import { Api } from "grammy";
import { Database, one } from "./db";
import { Failure } from "./telegram";
import { requestId } from "./support";

function texts(payload: any) {
  if (typeof payload?.textRu !== "string" || typeof payload?.textUz !== "string") throw new Failure("INVALID_TEXT");
  const ru = payload.textRu.trim(), uz = payload.textUz.trim();
  if (!ru || !uz || ru.length > 3500 || uz.length > 3500) throw new Failure("INVALID_TEXT");
  return { ru, uz };
}
const counts = `count(*)::int total,
  count(*) FILTER(WHERE status='pending')::int pending,count(*) FILTER(WHERE status='sending')::int sending,
  count(*) FILTER(WHERE status='sent')::int sent,count(*) FILTER(WHERE status='failed')::int failed,
  count(*) FILTER(WHERE status='unknown')::int unknown,count(*) FILTER(WHERE status='cancelled')::int cancelled`;
export class Broadcasts {
  private running?: Promise<void>;
  constructor(readonly database: Database, readonly api: Api) {}
  async templates() { return { rows: (await this.database.query("SELECT * FROM broadcast_templates ORDER BY id")).rows }; }
  async saveTemplate(payload: any) {
    const text = texts(payload), name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > 100) throw new Failure("INVALID_REQUEST");
    const row = await one(this.database, `INSERT INTO broadcast_templates(name,text_ru,text_uz) VALUES($1,$2,$3)
      ON CONFLICT(name) DO NOTHING RETURNING *`, [name, text.ru, text.uz]);
    if (row) return row;
    const previous = await one(this.database, "SELECT * FROM broadcast_templates WHERE name=$1", [name]);
    if (previous.text_ru !== text.ru || previous.text_uz !== text.uz) throw new Failure("TEMPLATE_NAME_USED");
    return previous;
  }
  async create(adminId: string, payload: any) {
    const key = requestId(payload.requestId), text = texts(payload);
    if (!["all", "selected"].includes(payload.audience) || !Array.isArray(payload.userIds) || payload.userIds.length > 1000 ||
      payload.userIds.some((id: any) => typeof id !== "string" || !/^[1-9][0-9]{0,17}$/.test(id))) throw new Failure("INVALID_REQUEST");
    const ids = [...new Set<string>(payload.userIds)].sort();
    if (payload.audience === "selected" ? !ids.length : ids.length > 0) throw new Failure("INVALID_REQUEST");
    return this.database.transaction(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`elonbot:broadcast:${key}`]);
      const previous = await one(db, "SELECT * FROM broadcasts WHERE request_id=$1", [key]);
      if (previous) {
        if (String(previous.admin_telegram_id) !== adminId || previous.text_ru !== text.ru || previous.text_uz !== text.uz ||
          previous.audience !== payload.audience || JSON.stringify(previous.selected_ids) !== JSON.stringify(ids)) throw new Failure("CONFLICT");
        return { id: String(previous.id) };
      }
      if (payload.audience === "selected" && (await one(db, "SELECT count(*)::int n FROM users WHERE id=ANY($1::bigint[])", [ids])).n !== ids.length) throw new Failure("NOT_FOUND");
      const row = await one(db, `INSERT INTO broadcasts(request_id,admin_telegram_id,text_ru,text_uz,audience,selected_ids)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [key, adminId, text.ru, text.uz, payload.audience, JSON.stringify(ids)]);
      // Freeze the audience and language at preview time. New users cannot enter a confirmed batch.
      await db.query(`INSERT INTO broadcast_recipients(broadcast_id,user_id,telegram_id,language)
        SELECT $1,id,telegram_id,language FROM users WHERE $2='all' OR id=ANY($3::bigint[])`, [row.id, payload.audience, ids]);
      if (!(await one(db, "SELECT 1 FROM broadcast_recipients WHERE broadcast_id=$1 LIMIT 1", [row.id]))) throw new Failure("NO_RECIPIENTS");
      return { id: String(row.id) };
    });
  }
  async list(page: number) {
    return { page, total: (await one(this.database, "SELECT count(*)::int n FROM broadcasts")).n,
      rows: (await this.database.query(`SELECT b.*,c.* FROM broadcasts b
        CROSS JOIN LATERAL(SELECT ${counts} FROM broadcast_recipients WHERE broadcast_id=b.id)c
        ORDER BY b.id DESC LIMIT 20 OFFSET $1`, [(page - 1) * 20])).rows };
  }
  async detail(id: string, page: number) {
    const row = await one(this.database, "SELECT * FROM broadcasts WHERE id=$1", [id]);
    if (!row) throw new Failure("NOT_FOUND");
    const summary = await one(this.database, `SELECT ${counts},count(*) FILTER(WHERE language='ru')::int ru,
      count(*) FILTER(WHERE language='uz')::int uz FROM broadcast_recipients WHERE broadcast_id=$1`, [id]);
    const rows = (await this.database.query(`SELECT r.user_id,r.telegram_id,r.language,r.status,r.error_code,r.telegram_message_id,r.updated_at,u.first_name,u.username
      FROM broadcast_recipients r JOIN users u ON u.id=r.user_id WHERE r.broadcast_id=$1 ORDER BY r.user_id LIMIT 20 OFFSET $2`, [id, (page - 1) * 20])).rows;
    return { ...row, counts: summary, rows, page, total: summary.total };
  }
  async action(id: string, action: "start" | "cancel", adminId: string) {
    await this.database.transaction(async db => {
      // Same lock as claiming: cancellation prevents any further recipient from being claimed.
      await db.query("SELECT pg_advisory_xact_lock(709162026)");
      const row = await one(db, "SELECT * FROM broadcasts WHERE id=$1 FOR UPDATE", [id]);
      if (!row) throw new Failure("NOT_FOUND");
      if (action === "start") {
        if (["queued", "completed"].includes(row.status)) return;
        if (row.status !== "draft") throw new Failure("CONFLICT");
        if (Date.now() - new Date(row.created_at).getTime() > 86400000) throw new Failure("PREVIEW_EXPIRED");
        await db.query("UPDATE broadcasts SET status='queued',started_at=now(),started_by=$2 WHERE id=$1", [id, adminId]);
      } else if (["draft", "queued"].includes(row.status)) {
        await db.query("UPDATE broadcasts SET status='cancelled',finished_at=now() WHERE id=$1", [id]);
        await db.query("UPDATE broadcast_recipients SET status='cancelled',updated_at=now() WHERE broadcast_id=$1 AND status='pending'", [id]);
      }
    });
    return this.detail(id, 1);
  }
  run() {
    if (!this.running) this.running = this.sendOne().finally(() => { this.running = undefined; });
    return this.running;
  }
  async wait() { await this.running; }
  private async sendOne() {
    const db = this.database;
    const recipient = await db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(709162026)");
      // Bot API sends have no idempotency key. Never resend after an uncertain response or process crash.
      await tx.query(`UPDATE broadcast_recipients SET status='unknown',error_code='DELIVERY_UNCONFIRMED',updated_at=now()
        WHERE status='sending' AND updated_at<now()-interval '5 minutes'`);
      await tx.query(`UPDATE broadcasts b SET status='completed',finished_at=now() WHERE status='queued'
        AND NOT EXISTS(SELECT 1 FROM broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status IN ('pending','sending'))`);
      if (await one(tx, "SELECT 1 FROM broadcast_clock WHERE next_send_at>now()")) return;
      // Serialize across processes as well as in this process; reserve before making the network request.
      if (await one(tx, "SELECT 1 FROM broadcast_recipients WHERE status='sending' LIMIT 1")) return;
      const row = await one(tx, `SELECT r.*,b.text_ru,b.text_uz FROM broadcast_recipients r JOIN broadcasts b ON b.id=r.broadcast_id
        WHERE r.status='pending' AND b.status='queued' ORDER BY b.id,r.user_id LIMIT 1 FOR UPDATE OF r`);
      if (!row) return;
      await tx.query("UPDATE broadcast_recipients SET status='sending',attempts=attempts+1,updated_at=now() WHERE broadcast_id=$1 AND user_id=$2", [row.broadcast_id, row.user_id]);
      await tx.query("UPDATE broadcast_clock SET next_send_at=now()+interval '1 second' WHERE id=1");
      return row;
    });
    if (!recipient) return;
    let status = "sent", errorCode: string | null = null, messageId: number | null = null, retry = 0;
    try {
      const message = await this.api.sendMessage(String(recipient.telegram_id), recipient.language === "ru" ? recipient.text_ru : recipient.text_uz,
        { link_preview_options: { is_disabled: true } }, AbortSignal.timeout(30_000) as unknown as NonNullable<Parameters<Api["sendMessage"]>[3]>);
      messageId = message.message_id;
    } catch (error) {
      const code = (error as any)?.error_code;
      if (code === 429) {
        const seconds = Number((error as any)?.parameters?.retry_after);
        retry = Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 2147483647) : 60;
        status = "pending"; errorCode = "BOT_API_429";
      } else {
        const definite = [400, 401, 403, 404].includes(code);
        status = definite ? "failed" : "unknown"; errorCode = definite ? `BOT_API_${code}` : "DELIVERY_UNCONFIRMED";
      }
    }
    await db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(709162026)");
      const batch = await one(tx, "SELECT status FROM broadcasts WHERE id=$1", [recipient.broadcast_id]);
      if (retry && batch?.status === "cancelled") status = "cancelled";
      await tx.query(`UPDATE broadcast_recipients SET status=$3,error_code=$4,telegram_message_id=$5,updated_at=now()
        WHERE broadcast_id=$1 AND user_id=$2 AND status='sending'`, [recipient.broadcast_id, recipient.user_id, status, errorCode, messageId]);
      if (retry) await tx.query("UPDATE broadcast_clock SET next_send_at=GREATEST(next_send_at,now()+$1::int*interval '1 second') WHERE id=1", [retry]);
      await tx.query(`UPDATE broadcasts b SET status='completed',finished_at=now() WHERE id=$1 AND status='queued'
        AND NOT EXISTS(SELECT 1 FROM broadcast_recipients r WHERE r.broadcast_id=b.id AND r.status IN ('pending','sending'))`, [recipient.broadcast_id]);
    });
  }
}
