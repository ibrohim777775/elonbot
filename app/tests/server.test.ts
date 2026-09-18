import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../accounts";
import { createHttpServer } from "../server";
import { config, testDatabase } from "./helpers";

test("HTTP login uses private no-store page and rejects invalid webhooks and requests", async () => {
  const { pg, database } = await testDatabase();
  const accounts = new Accounts(config, { async execute() { throw new Error("No real Telegram call allowed"); } });
  let updates = 0;
  const server = createHttpServer(config, database, accounts, async () => { updates++; }, () => true);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const [language, expected] of [["uz", "Elonbotdan qanday foydalaniladi?"], ["ru", "Как пользоваться Elonbot?"]]) {
      const help = await fetch(`${base}/help?lang=${language}`);
      assert.equal(help.status, 200); assert.equal(help.headers.get("x-frame-options"), null);
      assert.match(help.headers.get("content-security-policy")!, /frame-ancestors https:\/\/web.telegram.org/);
      const html = await help.text(); assert.ok(html.includes(expected)); assert.ok(html.includes('id="guide"'));
      assert.ok(!html.includes("{{")); assert.equal(updates, 0);
    }
    for (const asset of ["help.css", "help.js"]) assert.equal((await fetch(`${base}/app-assets/${asset}`)).status, 200);
    const page = await fetch(`${base}/account`);
    assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(await page.text(), /Telegram akkauntingizni ulang/);
    const script = await fetch(`${base}/account-assets/account.js`);
    assert.match(await script.text(), /history.replaceState/);
    const bad = await fetch(`${base}/webhook/${config.webhookSecret}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ update_id: 1 }) });
    assert.equal(bad.status, 403); assert.equal(updates, 0);
    const good = await fetch(`${base}/webhook/${config.webhookSecret}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": config.webhookSecret }, body: JSON.stringify({ update_id: 1 }) });
    assert.equal(good.status, 200); assert.equal(updates, 1);
    const crossOrigin = await fetch(`${base}/account/login`, { method: "POST", headers: { origin: "https://attacker.test" }, body: "{}" });
    assert.equal(crossOrigin.status, 403);
    const malformed = await fetch(`${base}/account/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "secret", action: "password", value: "private-password" }) });
    assert.equal(malformed.status, 400); assert.ok(!(await malformed.text()).includes("private-password"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await pg.close();
  }
});
