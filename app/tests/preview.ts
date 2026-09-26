// Isolated manual UI fixture. This entry point never creates a real Telegram client or delivery worker.
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { Accounts } from "../accounts";
import { Groups } from "../groups";
import { MiniApp } from "../miniapp";
import { createHttpServer } from "../server";
import { config, seed, testDatabase } from "./helpers";
import { signedInitData } from "./miniapp-fixtures";
import { Admin } from "../admin";
import { Support } from "../support";
import { announcement } from "./helpers";

async function main() {
  const { pg, database } = await testDatabase(); await seed(database);
  const names = ["Toshkent · E'lonlar", "Biznes hamkorlar", "Uy-joy va ijara", "IT hamjamiyati", "Avto bozor", "Mahalla yangiliklari"];
  const localConfig = { ...config };
  if (process.argv.includes("--ru")) await database.query("UPDATE users SET language='ru' WHERE id=1");
  await database.query("UPDATE users SET first_name='Азиз Каримов',username='aziz_demo',paid_until=now()+interval '18 days',trial_started_at=now()-interval '12 days',trial_ends_at=now()-interval '5 days' WHERE id=1");
  await database.query("UPDATE users SET first_name='Малика Рахимова',username='malika_demo',paid_until=NULL,trial_started_at=now()-interval '2 days',trial_ends_at=now()+interval '5 days' WHERE id=2");
  await database.query(`INSERT INTO users(telegram_id,first_name,username,trial_started_at,trial_ends_at) VALUES
    (303,'Сардор Алиев','sardor_demo',now()-interval '10 days',now()-interval '3 days'),(404,'Дилноза Юсупова',NULL,NULL,NULL)`);
  if (process.argv.includes("--browser")) await database.query("INSERT INTO users(telegram_id,first_name) SELECT 1000+i,'Тестовый пользователь '||i FROM generate_series(1,21)i");
  const ad = await announcement(database);
  await database.query("UPDATE announcements SET text='Продаётся квартира в Ташкенте.\n3 комнаты · 82 м² · Юнусабад\nПодробности — в личные сообщения.',send_start_minute=420,send_end_minute=1320,interval_minutes=60 WHERE id=$1", [ad]);
  await database.query("INSERT INTO templates(user_id,text) VALUES(1,'Сдаётся уютная квартира. Свежий ремонт, рядом метро.')");
  await database.query("INSERT INTO delivery_logs(announcement_id,group_id,scheduled_at,sent_at,status,sender_telegram_id,telegram_message_ids) VALUES($1,1,now()-interval '1 hour',now()-interval '1 hour','sent',101,'[5541]')", [ad]);
  let fakeMessage = 9000;
  const api = { async getMe() { return { username: "elonbot_test" }; }, async sendMessage() { return { message_id: ++fakeMessage }; }, async getFile() { throw new Error("Preview has no real Telegram media"); } } as any;
  const support = new Support(database, localConfig, api);
  await support.receive(database, "1", { message_id: 50, text: "Здравствуйте! Хочу продлить тариф на 30 дней. Как оплатить?" } as any);
  await support.receive(database, "2", { message_id: 60, text: "Добрый день. Подскажите, можно ли отправлять объявления только с 7 до 22?" } as any);
  const admin = new Admin(localConfig, database, support, api);
  const accounts = new Accounts(localConfig, { async execute(method) {
    if (method !== "groups") throw new Error("Preview only supports discovering fake groups");
    return { groups: names.map((title, i) => ({ title, chatId: `-100${[123, 456, 789, 888, 999, 777][i]}`,
      chatType: "supergroup", accessHash: "fake-hash", canPost: i !== 5, isAdmin: false })) };
  } });
  const server = createHttpServer(localConfig, database, accounts, async () => {}, () => true, new MiniApp(localConfig, database, new Groups(accounts)), admin);
  const handle = server.listeners("request")[0] as Function;
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    if (request.url === "/preview-telegram.js") {
      response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
      response.end(`window.Telegram={WebApp:{initData:${JSON.stringify(signedInitData())},ready(){},expand(){},close(){document.querySelector('#connected-count').textContent='Demo: botga qaytish';},BackButton:{show(){},onClick(){}},HapticFeedback:{notificationOccurred(){}}}};`); return;
    }
    if (request.url === "/app" || (request.url === "/admin" && !process.argv.includes("--browser"))) {
      void readFile(request.url === "/admin" ? "public/admin.html" : "public/app.html", "utf8").then(html => {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(html.replace("https://telegram.org/js/telegram-web-app.js", "/preview-telegram.js"));
      }).catch(() => { response.writeHead(500); response.end("Preview unavailable"); }); return;
    }
    handle(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  localConfig.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  console.log(`PREVIEW_URL=${localConfig.baseUrl}/app`);
  console.log(`ADMIN_PREVIEW_URL=${localConfig.baseUrl}/admin`);
  if (process.argv.includes("--browser")) console.log(`ADMIN_BROWSER_URL=${(await admin.browser.link({ id: 101, first_name: "Демо-администратор" })).url}`);
  const broadcasts = setInterval(() => { void admin.broadcasts.run().catch(console.error); }, 1000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    clearInterval(broadcasts);
    server.closeAllConnections(); server.close(() => { void admin.broadcasts.wait().then(() => pg.close()).then(() => process.exit(0)); });
  });
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
