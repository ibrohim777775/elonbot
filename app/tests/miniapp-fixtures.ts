import { createHmac } from "node:crypto";
import { config } from "./helpers";

export function signedInitData(id = 101, date = Math.floor(Date.now() / 1000)) {
  const fields = new URLSearchParams({ auth_date: String(date), query_id: "test-query", signature: "test-signature",
    user: JSON.stringify({ id, first_name: "Test user", is_bot: false }) });
  fields.sort();
  const secret = createHmac("sha256", "WebAppData").update(config.botToken).digest();
  fields.set("hash", createHmac("sha256", secret).update([...fields].map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex"));
  return fields.toString();
}
