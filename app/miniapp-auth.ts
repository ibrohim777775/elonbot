import { createHmac, timingSafeEqual } from "node:crypto";
import { Failure } from "./telegram";

export interface MiniAppUser { id: number; first_name: string; username?: string }
export function validateInitData(raw: string, botToken: string, now = Date.now()): MiniAppUser {
  if (!raw || raw.length > 16_384) throw new Failure("UNAUTHORIZED");
  const fields = new URLSearchParams(raw);
  const keys = [...fields.keys()];
  if (new Set(keys).size !== keys.length) throw new Failure("UNAUTHORIZED");
  const hash = fields.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Failure("UNAUTHORIZED");
  fields.delete("hash"); fields.sort();
  const check = [...fields.entries()].map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) throw new Failure("UNAUTHORIZED");
  const date = Number(fields.get("auth_date"));
  if (!Number.isSafeInteger(date) || date > now / 1000 + 30 || now / 1000 - date > 3600) throw new Failure("AUTH_EXPIRED");
  let user: any;
  try { user = JSON.parse(fields.get("user") ?? "null"); } catch { throw new Failure("UNAUTHORIZED"); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot || typeof user.first_name !== "string") throw new Failure("UNAUTHORIZED");
  return { id: user.id, first_name: user.first_name.slice(0, 255), username: typeof user.username === "string" ? user.username.slice(0, 255) : undefined };
}
