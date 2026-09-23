import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export function normalizeIp(value: string): string | undefined {
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes("%")) return undefined;
  const ip = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(ip);
  if (!mapped) return ip;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function clientAddressResolver(trustedProxyIps: string[]) {
  const trusted = new Set(trustedProxyIps.map(normalizeIp));
  return (request: Pick<IncomingMessage, "socket" | "headers">) => {
    const remote = normalizeIp(request.socket.remoteAddress ?? "") ?? "unknown";
    if (!trusted.has(remote)) return remote;
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded !== "string") return remote;
    const chain = forwarded.split(",").map(value => normalizeIp(value.trim()));
    if (chain.length > 32 || chain.some(ip => !ip)) return remote;
    // Walk from our peer towards the visitor. Never trust a prefix supplied by a visitor.
    let address = remote;
    for (let i = chain.length - 1; i >= 0 && trusted.has(address); i--) address = chain[i]!;
    return address;
  };
}

export class RequestLimits {
  private buckets = new Map<string, { at: number; count: number }>();
  allow(key: string, limit: number, now = Date.now()) {
    for (const [id, bucket] of this.buckets) if (now - bucket.at >= 60_000) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Bound memory without turning a full map into a global login lockout.
      if (this.buckets.size >= 10_000) this.buckets.delete(this.buckets.keys().next().value!);
      bucket = { at: now, count: 0 }; this.buckets.set(key, bucket);
    }
    return ++bucket.count <= limit;
  }
}
