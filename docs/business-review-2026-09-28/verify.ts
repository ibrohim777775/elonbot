// Read-only product review: temporary database and fake Telegram, no production credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Admin } from "../../app/admin";
import { Accounts } from "../../app/accounts";
import { createBot } from "../../app/bot";
import { Groups } from "../../app/groups";
import { one } from "../../app/db";
import { tariffCatalog, userGroupLimit } from "../../app/tariffs";
import { config, seed, testDatabase } from "../../app/tests/helpers";

async function main() {
  const { pg, database } = await testDatabase();
  try {
    await seed(database);
    await database.query("UPDATE users SET paid_until=NULL,trial_started_at=NULL,trial_ends_at=NULL");
    const catalog = await tariffCatalog(database);
    const admin = new Admin(config, database, {} as any, {} as any);
    const activate = (planCode: string) => admin.handle("POST", "/admin-api/users/1/tariff", { id: 101, first_name: "Audit" }, {
      action: "activate", planCode, catalogRevision: catalog.revision, requestId: randomUUID(), note: "Isolated review fixture",
    });
    const started = Date.now();
    for (let n = 0; n < 3; n++) await activate("basic");
    const upgrade = await activate("pro");
    const days = Math.round((new Date(upgrade.paid_until).getTime() - started) / 86400000);
    const amount = Number((await one(database, "SELECT sum(amount_sum) total FROM tariff_events WHERE user_id=1")).total);
    assert.equal(days, 120); assert.equal(amount, 135000); assert.equal(await userGroupLimit(database,"1"), 300);
    await activate("basic");
    const afterDowngrade = await userGroupLimit(database,"1");
    assert.equal(afterDowngrade, 30);

    const accounts = new Accounts(config, { async execute() { throw new Error("Live Telegram forbidden in review"); } });
    const bot = createBot(config, database, accounts, new Groups(accounts), { async run() {} } as any);
    const messages: { method: string; text: string }[] = [];
    bot.api.config.use(async (_, method, payload: any) => {
      if (payload.text) messages.push({ method, text: payload.text });
      return { ok: true, result: method === "getMe" ? { id:123456789,is_bot:true,first_name:"Audit",username:"elonbot_test" }
        : { message_id:1,date:0,chat:{id:303,type:"private"},text:payload.text ?? "" } } as any;
    });
    await bot.init();
    await bot.handleUpdate({ update_id:70001, message:{ message_id:1,date:0,chat:{id:303,type:"private"},
      from:{id:303,is_bot:false,first_name:"Audit",language_code:"ru"},text:"/start ru_ad_test",entities:[{type:"bot_command",offset:0,length:6}] } } as any);
    const initial = await one(database, "SELECT id,language FROM users WHERE telegram_id=303");
    assert.equal(initial.language,"uz");
    const firstMessages = messages.splice(0);
    await bot.handleUpdate({update_id:70002,callback_query:{id:"audit",from:{id:303,is_bot:false,first_name:"Audit"},data:"welcome_language:ru",chat_instance:"audit",message:{message_id:1,date:0,chat:{id:303,type:"private"},text:"Language"}}} as any);
    assert.equal((await one(database,"SELECT language FROM users WHERE telegram_id=303")).language,"ru");
    const afterLanguage = messages.splice(0);

    const botSource = await readFile("app/bot.ts","utf8");
    const site = await readFile("public/site/ru/index.html","utf8");
    const links = [...site.matchAll(/href="([^"]+)"/g)].map(m=>m[1]).filter(h=>h.includes("BOT_URL"));
    assert.ok(links.length > 5 && links.every(h=>h==="{{BOT_URL}}"));
    assert.equal(botSource.includes("ctx.match"),false);
    const schema = (await database.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (column_name ILIKE '%utm%' OR column_name ILIKE '%campaign%' OR column_name ILIKE '%referr%')")).rows;
    const out = {
      date: "2026-09-28", environment: "PGlite + fake Telegram; no production data or external sends",
      pricing: catalog.plans, paidUpgrade: { basicPeriods:3,proPeriods:1,totalDays:days,totalSum:amount,immediateGroupLimit:300,allProReferenceSum:300000 },
      subsequentBasicActivation: { immediateGroupLimit: afterDowngrade },
      onboarding: { russianTelegramClient:true,startParameter:"ru_ad_test",initialLanguage:initial.language,
        firstMessages:firstMessages.map(m=>({method:m.method,length:m.text.length,text:m.text})),
        afterLanguageSelection:afterLanguage.map(m=>({method:m.method,length:m.text.length,text:m.text})) },
      attribution: { ctaCount:links.length,distinctBotLinks:[...new Set(links)],ctxMatchUsed:false,campaignColumns:schema },
      economicAssumptions: { serverUsdPerMonth:10,calculationUzsPerUsd:12000,notAnExchangeQuote:true,
        serverOnlyCustomers:catalog.plans.map(p=>({plan:p.code,count:Math.ceil(10*12000/p.price_sum)})) },
    };
    await writeFile("docs/business-review-2026-09-28/verification.json", JSON.stringify(out,null,2)+"\n");
    console.log(JSON.stringify({status:"passed",days,amount,upgradeLimit:300,downgradeLimit:afterDowngrade,initialLanguage:initial.language,afterLanguageMessages:afterLanguage.length,distinctCtaLinks:[...new Set(links)],campaignColumns:schema.length}));
  } finally { await pg.close(); }
}
void main();
