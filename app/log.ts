export interface ErrorDiagnostic { type: string; reason?: string; causeCode?: string }
const symbolicCode = (value: unknown): string | undefined => typeof value === "string" && /^[A-Z_0-9]{2,80}$/.test(value) ? value : undefined;
const typeName = (value: unknown): string | undefined => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : undefined;

// Recognize fixed SDK/network messages without copying message text or RPC arguments into a log.
export function errorDiagnostic(error: unknown): ErrorDiagnostic {
  const value = error as { name?: string; code?: unknown; message?: unknown; cause?: unknown };
  const cause = value?.cause as { code?: unknown } | undefined;
  const causeCode = symbolicCode(value?.code) ?? symbolicCode(cause?.code);
  const message = typeof value?.message === "string" ? value.message : "";
  let reason: string | undefined;
  if (/^Cannot send requests while disconnected\./.test(message) || /^Cannot send [\w.]+: sender for dc \d+ is disconnected$/.test(message) || /^(?:Disconnected from dc \d+|Could not reconnect to dc \d+|Connection to dc \d+ was lost)$/.test(message)) reason = "DISCONNECTED";
  else if (/^Request was unsuccessful \d+ time\(s\)$/.test(message)) reason = "REQUEST_RETRIES_EXHAUSTED";
  else if (/^(TIMEOUT|Timeout|Request timed out|Connection timed out)$/.test(message) || value?.name === "TimeoutError") reason = "TIMEOUT";
  else if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(causeCode ?? "")) reason = "NETWORK_ERROR";
  return { type: typeName(value?.name) ?? "UnknownError", ...(reason ? { reason } : {}), ...(causeCode ? { causeCode } : {}) };
}

export function errorFrames(error: unknown) {
  const stack = (error as { stack?: unknown })?.stack;
  return typeof stack === "string" ? stack.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 6).join("\n") : undefined;
}

// Error objects can contain RPC arguments, SQL values and session credentials. Never serialize them.
export function logError(event: string, error: unknown) {
  const value = error as { name?: string; code?: string; errorMessage?: string; seconds?: number; message?: string; stack?: string; cause?: { code?: string }; diagnostic?: ErrorDiagnostic; operation?: string };
  const symbolic = value?.errorMessage ?? value?.code ?? value?.cause?.code;
  const code = typeof symbolic === "string" && /^[A-Z_0-9]{2,80}$/.test(symbolic) ? symbolic : "UNEXPECTED_ERROR";
  const message = value?.message && /^(Missing [A-Z_]+|Invalid [A-Z_]+|SESSION_ENCRYPTION_KEY must be 32 random bytes in base64|WEBHOOK_BASE_URL requires HTTPS|WEBHOOK_SECRET requires 16-256 URL-safe characters)$/.test(value.message) ? value.message : undefined;
  const frames = errorFrames(error);
  const diagnostic = value?.diagnostic ?? errorDiagnostic(error);
  const errorType = typeName(diagnostic.type), reason = symbolicCode(diagnostic.reason), causeCode = symbolicCode(diagnostic.causeCode);
  const operation = typeof value?.operation === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(value.operation) ? value.operation : undefined;
  console.error(`[${new Date().toISOString()}] ${event}`, { code, ...(message ? { message } : {}), ...(value?.seconds ? { seconds: value.seconds } : {}),
    ...(operation ? { operation } : {}), ...(errorType ? { errorType } : {}), ...(reason ? { reason } : {}), ...(causeCode && causeCode !== code ? { causeCode } : {}) });
  if (frames) console.error(frames);
}
