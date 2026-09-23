import "dotenv/config";
import { normalizeIp } from "./http-security";

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const number = (key: string, fallback: number) => {
    const value = Number(env[key] || fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
    return value;
  };
  const key = required("SESSION_ENCRYPTION_KEY");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) throw new Error("SESSION_ENCRYPTION_KEY must be 32 random bytes in base64");
  const baseUrl = required("WEBHOOK_BASE_URL").replace(/\/$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(env.APP_ENV === "development" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("WEBHOOK_BASE_URL requires HTTPS");
  const apiHash = required("TELEGRAM_API_HASH");
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) throw new Error("Invalid TELEGRAM_API_HASH");
  const webhookSecret = required("WEBHOOK_SECRET");
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) throw new Error("WEBHOOK_SECRET requires 16-256 URL-safe characters");
  const adminIds = (env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (adminIds.some(id => !/^\d+$/.test(id))) throw new Error("Invalid ADMIN_IDS");
  const host = env.HOST?.trim() || "127.0.0.1";
  if (!normalizeIp(host)) throw new Error("HOST must be an IP address");
  const trustedProxyIps = (env.TRUSTED_PROXY_IPS ?? "127.0.0.1,::1").split(",").map(ip => ip.trim()).filter(Boolean);
  if (trustedProxyIps.some(ip => !normalizeIp(ip))) throw new Error("TRUSTED_PROXY_IPS must contain exact IP addresses");
  return {
    botToken: required("BOT_TOKEN"),
    databaseUrl: required("DATABASE_URL").replace(/^postgresql\+asyncpg:/, "postgresql:"),
    databaseSsl: env.DATABASE_SSL === "true", baseUrl, webhookSecret,
    apiId: number("TELEGRAM_API_ID", 0), apiHash, encryptionKey: Buffer.from(key, "base64"),
    port: number("PORT", 8000), host, trustedProxyIps, adminIds,
    maxMessages: number("MAX_MESSAGES_PER_MINUTE", 20),
    maxChatMessages: number("MAX_MESSAGES_PER_CHAT_PER_MINUTE", 1),
    maxAnnouncements: number("MAX_ACTIVE_ANNOUNCEMENTS_PER_USER", 10),
    maxGroupsPerAnnouncement: number("MAX_GROUPS_PER_ANNOUNCEMENT", 30),
  };
}
export type Config = ReturnType<typeof loadConfig>;
