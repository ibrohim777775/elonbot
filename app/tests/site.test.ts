import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../accounts";
import { loadConfig } from "../config";
import { promotionSettings, savePromotionSettings } from "../promotion";
import { createHttpServer } from "../server";
import { sitePage } from "../site";
import { config, testDatabase } from "./helpers";

test("public site has complete localized HTML, canonical URLs, structured data and isolated private routes", async () => {
  const { pg, database } = await testDatabase();
  const settings = { ...config, siteUrl: "https://elon.example", siteIndexable: true };
  const accounts = new Accounts(settings, { async execute() { throw new Error("No real Telegram"); } });
  const server = createHttpServer(settings, database, accounts, async () => { throw new Error("No bot updates"); }, () => true);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const [path, destination] of [["/", "/uz"], ["/uz/", "/uz"], ["/ru/", "/ru"]]) {
      const response = await fetch(base + path, { redirect: "manual" });
      assert.equal(response.status, 301); assert.equal(response.headers.get("location"), destination);
    }
    for (const lang of ["uz", "ru"]) {
      const response = await fetch(`${base}/${lang}`, { headers: { host: "attacker.test" } });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-language"), lang);
      assert.match(response.headers.get("x-robots-tag")!, /^index, follow/);
      assert.ok(html.includes(`<html lang="${lang}">`));
      assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
      assert.ok(html.includes(`rel="canonical" href="https://elon.example/${lang}"`));
      for (const alternate of ["uz", "ru", "x-default"]) assert.ok(html.includes(`hreflang="${alternate}"`));
      assert.ok(html.includes("https://t.me/elonyuborishbot"));
      assert.ok(html.includes('data-promotion-limit="100"'));
      assert.ok(!html.includes("{{")); assert.ok(!html.includes("attacker.test"));
      const structured = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1];
      const graph = JSON.parse(structured)["@graph"];
      assert.equal(graph.find((item: any) => item["@type"] === "Service").offers[0].price, 20000);
      assert.ok(!structured.includes("aggregateRating"));
      assert.ok(response.headers.get("content-security-policy")!.includes(`'sha256-${createHash("sha256").update(structured).digest("base64")}'`));
      assert.ok(!html.includes("telegram-web-app.js"));
      assert.equal((await fetch(`${base}/${lang}`, { method: "HEAD" })).status, 200);
    }
    const robots = await (await fetch(base + "/robots.txt")).text();
    assert.match(robots, /Sitemap: https:\/\/elon.example\/sitemap.xml/);
    assert.match(robots, /Disallow: \/admin/);
    const sitemap = await (await fetch(base + "/sitemap.xml")).text();
    assert.equal((sitemap.match(/<loc>/g) ?? []).length, 2);
    assert.ok(sitemap.includes("https://elon.example/uz")); assert.ok(sitemap.includes("https://elon.example/ru"));
    for (const path of ["/app", "/account", "/admin", "/health"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200); assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    }
    for (const name of ["site.css", "site.js", "favicon.svg", "share-uz.png", "share-ru.png"]) {
      const response = await fetch(`${base}/site-assets/${name}`), bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200); assert.ok(bytes.length > 0);
      const head = await fetch(`${base}/site-assets/${name}`, { method: "HEAD" });
      assert.equal(Number(head.headers.get("content-length")), bytes.length); assert.equal(await head.text(), "");
      if (name.endsWith(".png")) { assert.equal(bytes.readUInt32BE(16), 1200); assert.equal(bytes.readUInt32BE(20), 630); }
    }
    await savePromotionSettings(database, "101", { ...await promotionSettings(database), message_limit: 27, text_ru: '<script>alert("x")</script>', text_uz: 'X & <b>Y</b>' });
    for (const lang of ["uz", "ru"]) {
      const html = await (await fetch(`${base}/${lang}`)).text();
      assert.ok(html.includes('data-promotion-limit="27"'));
      assert.ok(!html.includes('<script>alert("x")</script>')); assert.ok(!html.includes("updated_by"));
      assert.ok(html.includes(lang === "ru" ? "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;" : "X &amp; &lt;b&gt;Y&lt;/b&gt;"));
    }
    await savePromotionSettings(database, "101", { ...await promotionSettings(database), enabled: false });
    const disabled = await (await fetch(base + "/ru")).text();
    assert.ok(!disabled.includes('data-promotion-limit=')); assert.ok(!disabled.includes('id="promotion-terms"'));
    assert.match(disabled, /7 дней/); assert.match(disabled, /20\s*000/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); }
});

test("development site is not indexed and unavailable terms never produce a false promotion", async () => {
  const unavailable: any = { async query() { throw new Error("test unavailable"); } };
  for (const ready of [false, true]) {
    const { html } = await sitePage("uz", config, unavailable, ready);
    assert.ok(html.includes('content="noindex, nofollow"'));
    assert.ok(!html.includes('data-promotion-limit=')); assert.ok(!html.includes("{{"));
  }
});

test("public configuration validates origins and indexing stays off outside production", () => {
  const env = { BOT_TOKEN: config.botToken, DATABASE_URL: config.databaseUrl, TELEGRAM_API_ID: "1234", TELEGRAM_API_HASH: config.apiHash,
    SESSION_ENCRYPTION_KEY: config.encryptionKey.toString("base64"), WEBHOOK_BASE_URL: config.baseUrl, WEBHOOK_SECRET: config.webhookSecret };
  assert.equal(loadConfig(env).siteUrl, config.baseUrl); assert.equal(loadConfig(env).siteIndexable, false);
  assert.equal(loadConfig({ ...env, APP_ENV: "production" }).siteIndexable, true);
  assert.equal(loadConfig({ ...env, APP_ENV: "production", SITE_INDEXABLE: "false" }).siteIndexable, false);
  assert.equal(loadConfig({ ...env, PUBLIC_SITE_URL: "https://elon.example/", PUBLIC_BOT_USERNAME: "@elonyuborishbot" }).siteUrl, "https://elon.example");
  for (const PUBLIC_SITE_URL of ["http://elon.example", "https://user:pass@elon.example", "https://elon.example/path", "https://elon.example/?key=x", "javascript:bad"]) {
    assert.throws(() => loadConfig({ ...env, PUBLIC_SITE_URL }));
  }
  assert.throws(() => loadConfig({ ...env, PUBLIC_BOT_USERNAME: "<script>" }));
  assert.throws(() => loadConfig({ ...env, SITE_INDEXABLE: "yes" }));
});
