import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Accounts } from "../accounts";
import { Admin } from "../admin";
import { createBot } from "../bot";
import { requireCreationAccess } from "../billing";
import { one } from "../db";
import { Delivery } from "../delivery";
import { Groups } from "../groups";
import { acceptPromotion, promotionOffer } from "../promotion";
import { saveTariffCatalog, tariffCatalog, userGroupLimit } from "../tariffs";
import { Failure, safeError } from "../telegram";
import { sitePage } from "../site";
import { addGroups, announcement, config, seed, testDatabase } from "./helpers";

test("catalog prices and group limits are editable, but accepted paid periods and receipts keep their terms", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await database.query("UPDATE users SET paid_until=NULL");
    const admin = new Admin(config, database, {} as any, {} as any), who = { id: 101, first_name: "Admin" };
    const original = await tariffCatalog(database);
    assert.deepEqual(original.plans.map(p => [p.group_limit,p.price_sum]), [[30,20000],[100,50000],[300,75000]]);
    await assert.rejects(admin.handle("POST", "/admin-api/tariffs", { id: 202, first_name: "User" }, original), { code: "FORBIDDEN" });
    const payload = { action: "activate", planCode: "standard", catalogRevision: original.revision, requestId: randomUUID() };
    const paid = await admin.handle("POST", "/admin-api/users/1/tariff", who, payload);
    assert.equal(paid.amount_sum, 50000); assert.equal(paid.group_limit, 100);
    assert.equal(await userGroupLimit(database, "1"), 100);
    const revised = { ...original, plans: original.plans.map(p => p.code === "standard" ? { ...p, group_limit: 120, price_sum: 60000 } : p) };
    await admin.handle("POST", "/admin-api/tariffs", who, revised);
    assert.equal(await userGroupLimit(database, "1"), 100);
    assert.deepEqual(await admin.handle("POST", "/admin-api/users/1/tariff", who, payload), paid, "Retried activations preserve the price and never extend twice");
    await assert.rejects(admin.handle("POST", "/admin-api/users/2/tariff", who, { ...payload, requestId: randomUUID() }), { code: "CONFLICT" });
    await assert.rejects(admin.handle("POST", "/admin-api/users/1/tariff", who, { ...payload, planCode: "pro" }), { code: "CONFLICT" });
    const fresh = await admin.handle("POST", "/admin-api/users/2/tariff", who, { ...payload, catalogRevision: 2, requestId: randomUUID(), price_sum: 1, group_limit: 9999 });
    assert.equal(fresh.amount_sum, 60000); assert.equal(await userGroupLimit(database, "2"), 120);
    for (const language of ["ru", "uz"] as const) {
      const { html } = await sitePage(language, config, database);
      assert.match(html, /60\s*000/); assert.ok(html.includes('id="plan-standard"')); assert.ok(html.includes("120")); assert.ok(html.includes("300"));
      assert.ok(!html.includes("{{")); assert.ok(!html.includes("50 000"));
    }
    const settings = await tariffCatalog(database);
    for (const invalid of [0,-1,2.5,"100",2_147_483_648]) {
      await assert.rejects(saveTariffCatalog(database, "101", { ...settings, plans: settings.plans.map(p => p.code === "basic" ? { ...p, group_limit: invalid } : p) }), { code: "INVALID_REQUEST" });
      await assert.rejects(saveTariffCatalog(database, "101", { ...settings, plans: settings.plans.map(p => p.code === "basic" ? { ...p, price_sum: invalid } : p) }), { code: "INVALID_REQUEST" });
    }
    await assert.rejects(saveTariffCatalog(database, "101", original), { code: "CONFLICT" });
    assert.deepEqual(await tariffCatalog(database), settings);
  } finally { await pg.close(); }
});

test("new free periods use the base tariff; old trial and promotion quotas survive catalog changes", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); await database.query("UPDATE users SET paid_until=NULL");
    await requireCreationAccess(database, "1", true);
    assert.equal(await userGroupLimit(database, "1"), 30);
    const oldOffer = (await promotionOffer(database, "2", "uz", "elonbot_test"))!;
    const catalog = await tariffCatalog(database);
    await saveTariffCatalog(database, "101", { ...catalog, plans: catalog.plans.map(p => p.code === "basic" ? { ...p, group_limit: 45, price_sum: 25000 } : p) });
    assert.equal(await userGroupLimit(database, "1"), 30);
    assert.equal(await userGroupLimit(database, "2"), 45);
    await assert.rejects(database.transaction(db => acceptPromotion(db, "2", "uz", "elonbot_test", oldOffer.revision)), { code: "PROMOTION_CHANGED" });
    const offer = (await promotionOffer(database, "2", "uz", "elonbot_test"))!;
    assert.equal(offer.groups, 45);
    const accepted = await database.transaction(db => acceptPromotion(db, "2", "uz", "elonbot_test", offer.revision));
    assert.equal(accepted.group_limit, 45);
    const next = await tariffCatalog(database);
    await saveTariffCatalog(database, "101", { ...next, plans: next.plans.map(p => p.code === "basic" ? { ...p, group_limit: 20 } : p) });
    assert.equal(await userGroupLimit(database, "2"), 45);
    await database.query("UPDATE users SET paid_until=now()+interval '1 day',paid_group_limit=100 WHERE id=1");
    assert.equal(await userGroupLimit(database, "1"), 100);
    await database.query("UPDATE users SET paid_until=now()-interval '1 second' WHERE id=1");
    assert.equal(await userGroupLimit(database, "1"), 30);
  } finally { await pg.close(); }
});

test("bot selection, stale drafts, templates and resume enforce the user's purchased group limit", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const ids = await addGroups(database, 100);
    await database.query("UPDATE users SET paid_group_limit=100,paid_plan_code='standard' WHERE id=1");
    const accounts = new Accounts(config, { async execute() { throw new Error("No live Telegram"); } });
    const bot = createBot(config, database, accounts, new Groups(accounts), { async run() {} } as any), messages: any[] = [];
    bot.api.config.use(async (_,method,payload: any) => {
      messages.push(payload);
      return { ok: true, result: method === "getMe" ? { id: 123456789,is_bot:true,first_name:"Test",username:"elonbot_test" }
        : { message_id: 1,date:0,chat:{id:101,type:"private"},text:payload.text ?? "" } } as any;
    });
    await bot.init(); let updateId=10000;
    const callback=(data:string)=>bot.handleUpdate({update_id:++updateId,callback_query:{id:String(updateId),from:{id:101,is_bot:false,first_name:"Test"},data,chat_instance:"one",message:{message_id:1,date:0,chat:{id:101,type:"private"},text:"Menu"}}} as any);
    const draft={kind:"announcement",step:"groups",text:"Paid announcement",groups:ids.slice(0,99),interval:5,mode:"scheduled"};
    await database.query("INSERT INTO user_states(user_id,data) VALUES(1,$1)",[JSON.stringify(draft)]);
    await callback(`ann:group:${ids[99]}`);
    assert.equal((await one(database,"SELECT data FROM user_states WHERE user_id=1")).data.groups.length,100);
    await callback(`ann:group:${ids[100]}`);
    assert.equal((await one(database,"SELECT data FROM user_states WHERE user_id=1")).data.groups.length,100);
    assert.match(messages.at(-1).text,/100/);
    await database.query("UPDATE users SET paid_group_limit=30 WHERE id=1");
    await database.query("UPDATE user_states SET data=$1 WHERE user_id=1",[JSON.stringify({...draft,groups:ids.slice(0,100),step:"confirm"})]);
    await callback("ann:confirm");
    assert.equal((await one(database,"SELECT count(*)::int n FROM announcements")).n,0);
    assert.match(messages.at(-1).text,/30/);
    const ad=await announcement(database,"1",ids.slice(0,100));
    await database.query("UPDATE announcements SET status='paused' WHERE id=$1",[ad]);
    await callback(`ann:resume:${ad}`);
    assert.equal((await one(database,"SELECT status FROM announcements WHERE id=$1",[ad])).status,"paused");
    await database.query("INSERT INTO templates(id,user_id,text,interval_minutes,first_run_mode) VALUES(1,1,'Saved',5,'scheduled')");
    for(const id of ids.slice(0,100)) await database.query("INSERT INTO template_groups(template_id,group_id) VALUES(1,$1)",[id]);
    await callback("templates:use:1");
    assert.equal((await one(database,"SELECT data FROM user_states WHERE user_id=1")).data.step,"groups");
    assert.equal((await one(database,"SELECT count(*)::int n FROM announcements")).n,1);
  } finally { await pg.close(); }
});

test("300 recipients drain sequentially in rate-limited batches and resume after FloodWait without duplicate successes", async () => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const ids=(await addGroups(database,298));
    await database.query("UPDATE users SET paid_group_limit=300,paid_plan_code='pro' WHERE id=1");
    const ad=await announcement(database,"1",ids), sent=new Set<string>(); let calls=0,active=0,maxActive=0,waited=false;
    const accounts=new Accounts(config,{async execute(method,params){
      assert.equal(method,"send"); calls++; active++; maxActive=Math.max(active,maxActive);
      try {
        if(!waited && sent.size===12){waited=true;throw new Failure("FLOOD_WAIT",125);}
        assert.ok(!sent.has(params.chatId)); sent.add(params.chatId); return {messageIds:[calls]};
      } finally {active--;}
    }});
    const worker=new Delivery(database,config,accounts,{} as any);
    await worker.run(); assert.equal(sent.size,12);
    await worker.run(); assert.equal(sent.size,12,"Account-level Telegram wait must block all retries");
    for(let cycle=0;cycle<16 && sent.size<300;cycle++){
      await database.query("UPDATE telegram_accounts SET retry_after=NULL WHERE user_id=1");
      await database.query("UPDATE delivery_usage SET sent_at=now()-interval '2 minutes'");
      await database.query("UPDATE announcements SET next_run_at=now()-interval '1 second' WHERE id=$1",[ad]);
      const before=sent.size; await worker.run(); assert.ok(sent.size-before<=20);
    }
    assert.equal(sent.size,300); assert.equal(calls,301); assert.equal(maxActive,1);
    assert.equal((await one(database,"SELECT last_delivery_summary FROM announcements WHERE id=$1",[ad])).last_delivery_summary.complete,true);
  } finally { await pg.close(); }
});

test("PeerFlood stops all active announcements instead of hammering remaining groups",async()=>{
  const {pg,database}=await testDatabase();
  try{
    await seed(database); await announcement(database); await announcement(database); let calls=0;
    const accounts=new Accounts(config,{async execute(){calls++;throw new Failure("PEER_FLOOD");}});
    const worker=new Delivery(database,config,accounts,{} as any); await worker.run(); await worker.run();
    assert.equal(calls,1);
    assert.ok((await database.query("SELECT status,pause_reason FROM announcements")).rows.every(a=>a.status==="paused"&&a.pause_reason==="telegram_restricted"));
    assert.equal((await one(database,"SELECT count(*)::int n FROM user_notifications WHERE kind='telegram_restricted'")).n,1);
    assert.equal(safeError({errorMessage:"FLOOD_PREMIUM_WAIT_123"}).seconds,123);
  }finally{await pg.close();}
});

test("paid group quota expires during a batch even when a longer free period remains", async ctx => {
  const { pg, database } = await testDatabase();
  try {
    await seed(database); const until = Date.now() + 60_000;
    await database.query("UPDATE users SET paid_until=$1,paid_group_limit=300,trial_started_at=now(),trial_ends_at=now()+interval '7 days',trial_group_limit=30 WHERE id=1", [new Date(until)]);
    await announcement(database); let calls = 0, deadline: number | undefined;
    const accounts = new Accounts(config, { async execute(_method, params) {
      calls++; deadline = params.subscriptionBefore;
      ctx.mock.method(Date, "now", () => until + 1);
      return { messageIds: [calls] };
    } });
    await new Delivery(database, config, accounts, {} as any).run();
    assert.equal(calls, 1, "Do not keep sending with an expired paid quota using the later trial deadline");
    assert.equal(deadline, until);
  } finally { ctx.mock.restoreAll(); await pg.close(); }
});
