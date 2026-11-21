export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function log(scope: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} [${scope}] ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === "string" ? extra : JSON.stringify(extra, replacer));
}

/** JSON replacer: bigint -> decimal string. */
export function replacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

export function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { shortMessage?: string; message?: string };
    return (o.shortMessage || o.message || String(e)).split("\n")[0].slice(0, 400);
  }
  return String(e).slice(0, 400);
}

function isRateLimit(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const o = cur as { code?: number; status?: number; message?: string; cause?: unknown; details?: string };
    if (o.code === -32016 || o.code === -32005 || o.status === 429) return true;
    const m = `${o.message ?? ""} ${o.details ?? ""}`.toLowerCase();
    if (m.includes("rate limit") || m.includes("too many requests") || m.includes("429")) return true;
    cur = o.cause;
  }
  return false;
}

function isTransient(e: unknown): boolean {
  if (isRateLimit(e)) return true;
  const m = errMsg(e).toLowerCase();
  return /timeout|timed out|fetch failed|econnreset|econnrefused|enotfound|socket|network|502|503|504|http request failed/.test(m);
}

/** Retry with exponential backoff + jitter on rate limits (-32016/429) and transient network errors. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 7): Promise<T> {
  let delay = 1000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      const wait = Math.min(delay, 30_000) + Math.floor(Math.random() * 400);
      log("rpc", `${label}: ${isRateLimit(e) ? "rate limited" : "transient error"} (attempt ${i}/${attempts}), retry in ${wait}ms: ${errMsg(e)}`);
      await sleep(wait);
      delay *= 2;
    }
  }
}
