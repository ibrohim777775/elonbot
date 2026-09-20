import { Api } from "grammy";
import { Admin } from "./admin";
import { Support } from "./support";
import { Accounts } from "./accounts";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { Postgres, one } from "./db";
import { Delivery } from "./delivery";
import { Groups } from "./groups";
import { t, languages, languageOf } from "./i18n";
import { botCommands } from "./commands";
import { migrate } from "./migrate";
import { logError } from "./log";
import { MiniApp } from "./miniapp";
import { createHttpServer } from "./server";
import { TelegramService } from "./telegram";
import { Notifications } from "./notifications";

async function main() {
  const config = loadConfig();
  const database = new Postgres(config);
  const telegram = new TelegramService({ apiId: config.apiId, apiHash: config.apiHash, botToken: config.botToken });
  const accounts = new Accounts(config, telegram);
  const api = new Api(config.botToken);
  const delivery = new Delivery(database, config, accounts, api);
  const notifications = new Notifications(database, api);
  const groups = new Groups(accounts);
  const support = new Support(database, config, api);
  const bot = createBot(config, database, accounts, groups, delivery, support);
  const admin = new Admin(config, database, support, api, telegram);
  const mini = new MiniApp(config, database, groups);
  let ready = false;
  const server = createHttpServer(config, database, accounts, update => bot.handleUpdate(update), () => ready, mini, admin);
  try {
  console.log("[startup] Applying database migrations…");
  await migrate(database);
  console.log("[startup] Connecting to Telegram…");
  await bot.init();
  for (const language of [undefined, ...languages]) await bot.api.setMyCommands(botCommands(language ?? "uz"), language ? { language_code: language } : {});
  for (const chatId of config.adminIds) {
    const user = await one(database, "SELECT language FROM users WHERE telegram_id=$1", [chatId]);
    await bot.api.setMyCommands(botCommands(languageOf(user?.language), true), { scope: { type: "chat", chat_id: chatId } }).catch(error => logError("admin_commands_failed", error));
  }
  await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: t("app.open"), web_app: { url: `${config.baseUrl}/app` } } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(config.port, "0.0.0.0", resolve); });
  await bot.api.setWebhook(`${config.baseUrl}/webhook/${config.webhookSecret}`, {
    secret_token: config.webhookSecret, allowed_updates: ["message", "callback_query"],
  });
  ready = true;
  } catch (error) {
    server.close(); await telegram.close(); await database.close(); throw error;
  }
  let maintenance: Promise<void> | undefined;
  const maintain = () => {
    if (maintenance) return;
    maintenance = (async () => {
      await telegram.cleanup(); await accounts.restore(database);
      await support.recover();
      await notifications.maintain();
      await database.query("DELETE FROM admin_browser_tokens WHERE expires_at<now()");
      await database.query("DELETE FROM account_logins WHERE expires_at<now()");
      await database.query("DELETE FROM processed_updates WHERE created_at<now()-interval '7 days'");
    })().catch(error => logError("account_maintenance_failed", error)).finally(() => { maintenance = undefined; });
  };
  maintain();
  const scheduler = setInterval(() => { void delivery.run().catch(error => logError("delivery_tick_failed", error)); }, 30_000);
  const upkeep = setInterval(maintain, 60_000);
  const broadcastWorker = setInterval(() => { void admin.broadcasts.run().catch(error => logError("broadcast_tick_failed", error)); }, 1000);
  const notificationWorker = setInterval(() => { void notifications.run().catch(error => logError("notification_tick_failed", error)); }, 1000);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true; ready = false;
    clearInterval(scheduler); clearInterval(upkeep); clearInterval(broadcastWorker);
    clearInterval(notificationWorker);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await maintenance; await delivery.wait(); await admin.broadcasts.wait(); await notifications.wait(); await telegram.close(); await database.close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void stop().catch(error => { logError("shutdown_failed", error); process.exitCode = 1; }); });
  process.on("unhandledRejection", error => { logError("unhandled_rejection", error); process.exitCode = 1; void stop().catch(failure => logError("shutdown_failed", failure)); });
  console.log(`[ready] HTTP: http://127.0.0.1:${config.port} | Mini App: ${config.baseUrl}/app`);
}
main().catch(error => { logError("startup_failed", error); process.exit(1); });
