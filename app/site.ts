import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Config } from "./config";
import { TariffPlan } from "./tariffs";
import { one, Queryable } from "./db";
import { Language } from "./i18n";
import { logError } from "./log";

const escape = (value: string | number) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
export const siteRobots = (config: Config) => config.siteIndexable ? "index, follow, max-image-preview:large" : "noindex, nofollow";

// The site itself is plain HTML/CSS/JS. Only current public terms and deployment URLs
// are substituted before sending the HTML, so the content is complete without JavaScript.
export async function sitePage(language: Language, config: Config, db: Queryable, ready = true) {
  let settings: { enabled: boolean; message_limit: number; text_uz: string; text_ru: string; plans: TariffPlan[] } | undefined;
  if (ready) {
    try { settings = await one(db, `SELECT enabled,message_limit,text_uz,text_ru,
      (SELECT json_agg(p ORDER BY sort_order) FROM tariff_plans p) plans FROM promotion_settings WHERE id=1`); }
    catch (error) { logError("site_promotion_unavailable", error); }
  }
  let html = await readFile(`public/site/${language}/index.html`, "utf8");
  if (!settings?.enabled) html = html.replace(/<!-- PROMOTION_START -->[\s\S]*?<!-- PROMOTION_END -->/g, "");
  if (!settings) html = html.replace(/<!-- PAID_START -->[\s\S]*?<!-- PAID_END -->/g, "");
  const botUrl = `https://t.me/${config.publicBotUsername}`;
  const plans = settings?.plans ?? [], basic = plans.find(p => p.code === "basic");
  const structured = JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "WebSite", "@id": `${config.siteUrl}/#website`, name: "Elonbot", url: `${config.siteUrl}/uz`, inLanguage: ["uz", "ru"] },
    { "@type": "Organization", "@id": `${config.siteUrl}/#organization`, name: "Elonbot", url: config.siteUrl, sameAs: [botUrl] },
    { "@type": "Service", "@id": `${config.siteUrl}/${language}#service`, name: language === "ru" ? "Отправка объявлений в Telegram по расписанию" : "Telegram guruhlariga jadval bo'yicha e'lon yuborish",
      url: `${config.siteUrl}/${language}`, provider: { "@id": `${config.siteUrl}/#organization` },
      offers: plans.map(p => ({ "@type": "Offer", price: p.price_sum, priceCurrency: "UZS", url: `${config.siteUrl}/${language}#plan-${p.code}`,
        description: language === "ru" ? `До ${p.group_limit} групп в одном объявлении на 30 дней. Без автоматического списания.` : `Bitta e'lon uchun ${p.group_limit} tagacha guruh, 30 kun. Avtomatik pul yechilmaydi.` })) },
  ] }).replace(/</g, "\\u003c");
  const fields: Record<string, string> = {
    SITE_URL: escape(config.siteUrl), BOT_URL: escape(botUrl), ROBOTS: siteRobots(config), YEAR: String(new Date().getUTCFullYear()),
    GROUP_LIMIT: plans.length ? String(Math.max(...plans.map(p => p.group_limit))) : "—",
    BASIC_GROUP_LIMIT: String(basic?.group_limit ?? "—"), PROMOTION_LIMIT: String(settings?.message_limit ?? ""),
    PROMOTION_FOOTER: settings ? escape(`${settings[`text_${language}`]}\n${botUrl}`) : "", STRUCTURED_DATA: structured,
  };
  for (const p of plans) {
    fields[`${p.code.toUpperCase()}_PRICE`] = new Intl.NumberFormat(language === "ru" ? "ru-RU" : "uz-UZ").format(p.price_sum);
    fields[`${p.code.toUpperCase()}_GROUPS`] = String(p.group_limit);
  }
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => fields[key] ?? "");
  const hash = createHash("sha256").update(structured).digest("base64");
  return { html, csp: `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'` };
}
export function robotsTxt(config: Config) {
  return config.siteIndexable
    ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /api/\nDisallow: /app$\nDisallow: /webhook/\nDisallow: /health\n\nSitemap: ${config.siteUrl}/sitemap.xml\n`
    : "User-agent: *\nDisallow: /\n";
}
export function siteMap(config: Config) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["uz", "ru"].map(lang => `<url><loc>${escape(config.siteUrl)}/${lang}</loc></url>`).join("")}</urlset>`;
}
