import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { Accounts } from "./accounts";
import { Config } from "./config";
import { Database } from "./db";
import { Failure } from "./telegram";
import { logError } from "./log";
import { MiniApp } from "./miniapp";
import { Admin } from "./admin";
import { helpPage } from "./help";

const headers = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};
const appHeaders = { ...headers,
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org; form-action 'self'; base-uri 'none'",
};
// Telegram Web opens Mini Apps in a frame; the separate login-link page keeps its stricter policy.
delete (appHeaders as Partial<typeof headers>)["X-Frame-Options"];
export function equalSecret(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function body(request: IncomingMessage, limit: number) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Failure("INVALID_REQUEST");
  try { return JSON.parse((await bytes(request, limit)).toString("utf8")); } catch (error) {
    if (error instanceof Failure) throw error; throw new Failure("INVALID_REQUEST");
  }
}
async function bytes(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Failure("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { ...headers, "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
export function createHttpServer(config: Config, database: Database, accounts: Accounts, handleUpdate: (update: any) => Promise<void>, ready: () => boolean, mini?: MiniApp, admin?: Admin) {
  const assets: Record<string, [string, string]> = {
    "/admin": ["public/admin.html", "text/html; charset=utf-8"],
    "/admin-assets/admin.js": ["public/admin.js", "text/javascript; charset=utf-8"],
    "/admin-assets/admin-broadcasts.js": ["public/admin-broadcasts.js", "text/javascript; charset=utf-8"],
    "/admin-assets/admin.css": ["public/admin.css", "text/css; charset=utf-8"],
    "/account": ["public/account.html", "text/html; charset=utf-8"],
    "/account-assets/account.js": ["public/account.js", "text/javascript; charset=utf-8"],
    "/account-assets/account.css": ["public/account.css", "text/css; charset=utf-8"],
    "/": ["public/app.html", "text/html; charset=utf-8"],
    "/app": ["public/app.html", "text/html; charset=utf-8"],
    "/app-assets/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
    "/app-assets/app.css": ["public/app.css", "text/css; charset=utf-8"],
    "/app-assets/help.css": ["public/help.css", "text/css; charset=utf-8"],
    "/app-assets/help.js": ["public/help.js", "text/javascript; charset=utf-8"],
  };
  const rate = new Map<string, { at: number; count: number }>();
  return createServer({ requestTimeout: 180_000, headersTimeout: 15_000 }, async (request, response) => {
    const started = Date.now();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const label = path.startsWith("/webhook/") ? "/webhook/:secret" : path;
    if (process.env.APP_ENV !== "production") response.on("finish", () => {
      console.log(`[http] ${request.method} ${label} ${response.statusCode} ${Date.now() - started}ms`);
    });
    try {
      if (request.method === "GET" && path === "/health") { json(response, ready() ? 200 : 503, { status: ready() ? "ok" : "starting" }); return; }
      if (request.method === "GET" && path === "/help") {
        const content = await helpPage(new URL(request.url!, "http://localhost").searchParams.get("lang"));
        response.writeHead(200, { ...appHeaders, "Content-Type": "text/html; charset=utf-8" }); response.end(content); return;
      }
      if (request.method === "GET" && assets[path]) {
        const [file, mime] = assets[path];
        const content = await readFile(file);
        response.writeHead(200, { ...(path.startsWith("/account") ? headers : appHeaders), "Content-Type": mime }); response.end(content); return;
      }
      if (path.startsWith("/api/") || path.startsWith("/admin-api/")) {
        const service = path.startsWith("/admin-api/") ? admin : mini;
        if (!service || !ready()) { json(response, 503, { error: "STARTING" }); return; }
        if (request.headers.origin && request.headers.origin !== new URL(config.baseUrl).origin) { json(response, 403, { error: "INVALID_ORIGIN" }); return; }
        const authorization = String(request.headers.authorization ?? ""), cookie = String(request.headers.cookie ?? "");
        if (service instanceof Admin && request.method !== "GET" && (!authorization || path === "/admin-api/session")) {
          if (request.headers.origin !== new URL(config.baseUrl).origin || request.headers["x-admin-request"] !== "1") {
            json(response, 403, { error: "INVALID_ORIGIN" }); return;
          }
        }
        if (service instanceof Admin && path === "/admin-api/session" && request.method === "POST") {
          const key = `admin-login:${request.socket.remoteAddress ?? "unknown"}`, now = Date.now();
          for (const [id, value] of rate) if (now - value.at > 60_000) rate.delete(id);
          const bucket = rate.get(key) ?? { at: now, count: 0 }; rate.set(key, bucket);
          if (++bucket.count > 30 || rate.size > 10_000) { json(response, 429, { error: "RATE_LIMITED", seconds: 60 }); return; }
          const payload = await body(request, 4096);
          const sessionCookie = await service.browser.exchange(payload?.token);
          response.setHeader("Set-Cookie", sessionCookie); json(response, 200, { ok: true }); return;
        }
        if (service instanceof Admin && path === "/admin-api/logout" && request.method === "POST") {
          response.setHeader("Set-Cookie", await service.browser.logout(cookie)); json(response, 200, { ok: true }); return;
        }
        const identity = service instanceof Admin ? await service.authenticate(authorization, cookie) : service.authenticate(authorization);
        const bucketKey = `user:${identity.id}`;
        const now = Date.now();
        for (const [key, value] of rate) if (now - value.at > 60_000) rate.delete(key);
        const bucket = rate.get(bucketKey) ?? { at: now, count: 0 };
        rate.set(bucketKey, bucket);
        if (++bucket.count > 180) { json(response, 429, { error: "RATE_LIMITED", seconds: 60 }); return; }
        if (service instanceof Admin && request.method === "GET" && path.startsWith("/admin-api/files/")) {
          const file = await service.file(path, identity);
          response.writeHead(200, { ...headers, "Content-Type": file.type,
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, "%27")}` });
          response.end(file.data); return;
        }
        const payload = request.method === "GET" ? {} : await body(request, 64 * 1024);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Failure("INVALID_REQUEST");
        const result = service instanceof Admin
          ? await service.handle(request.method ?? "GET", path, identity, payload, new URL(request.url!, "http://localhost").searchParams)
          : await service.handle(request.method ?? "GET", path, identity, payload);
        json(response, 200, result); return;
      }
      if (request.method === "POST" && path === "/account/login") {
        if (request.headers.origin && request.headers.origin !== new URL(config.baseUrl).origin) { json(response, 403, { error: "INVALID_ORIGIN" }); return; }
        const ip = request.socket.remoteAddress ?? "unknown";
        const now = Date.now();
        for (const [key, value] of rate) if (now - value.at > 60_000) rate.delete(key);
        const bucket = rate.get(ip) ?? { at: now, count: 0 };
        if (++bucket.count > 30 || rate.size > 10_000) { json(response, 429, { error: "RATE_LIMITED", seconds: 60 }); return; }
        rate.set(ip, bucket);
        const payload = await body(request, 4096);
        if (!payload || [payload.token, payload.action, payload.value].some(x => typeof x !== "string")) throw new Failure("INVALID_REQUEST");
        const result = await accounts.login(database, payload.token, payload.action, payload.value);
        json(response, 200, result); return;
      }
      // Keep the existing webhook URL shape, including old Render configuration.
      if (request.method === "POST" && path.startsWith("/webhook/")) {
        const secret = String(request.headers["x-telegram-bot-api-secret-token"] ?? "");
        if (!equalSecret(path.slice(9), config.webhookSecret) || !equalSecret(secret, config.webhookSecret)) { json(response, 403, { error: "FORBIDDEN" }); return; }
        if (!ready()) { json(response, 503, { error: "STARTING" }); return; }
        const update = await body(request, 1024 * 1024);
        if (!update || !Number.isSafeInteger(update.update_id)) throw new Failure("INVALID_REQUEST");
        await handleUpdate(update); json(response, 200, { ok: true }); return;
      }
      json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof Failure) {
        if (error.seconds || !["NOT_FOUND", "UNAUTHORIZED", "AUTH_EXPIRED"].includes(error.code)) logError("request_rejected", error);
        const status = ["UNAUTHORIZED", "AUTH_EXPIRED"].includes(error.code) ? 401 : error.code === "FORBIDDEN" ? 403 : error.code === "CONFLICT" ? 409 : error.code === "NOT_FOUND" ? 404 : error.seconds ? 429 : 400;
        json(response, status, { error: error.code, seconds: error.seconds });
      } else { logError("request_failed", error); json(response, 500, { error: "TEMPORARY_ERROR" }); }
    }
  });
}
