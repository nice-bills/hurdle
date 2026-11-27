import { formatUnits } from "viem";

export const short = (a?: string | null, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "");

export function fmtNum(x: number | null | undefined, max = 2, min = 0) {
  if (x == null || !Number.isFinite(x)) return "–";
  return x.toLocaleString("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });
}

/** Smart precision for token amounts. */
export function fmtToken(raw: bigint | string | null | undefined, decimals: number, maxSig = 4) {
  if (raw == null) return "–";
  const v = Number(formatUnits(BigInt(raw), decimals));
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1000) return fmtNum(v, 0);
  if (abs >= 1) return fmtNum(v, maxSig);
  if (abs >= 0.0001) return v.toLocaleString("en-US", { maximumSignificantDigits: maxSig });
  if (abs < 1e-8) return "<0.00000001";
  return v.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 9 });
}
export const fmtEth = (raw: bigint | string | null | undefined, sig = 4) => fmtToken(raw, 18, sig);

export function fmtUsd(x: number | null | undefined, compact = false) {
  if (x == null || !Number.isFinite(x)) return "–";
  if (compact && Math.abs(x) >= 10_000)
    return "$" + x.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const a = Math.abs(x);
  return "$" + x.toLocaleString("en-US", { minimumFractionDigits: a < 10 && a > 0 ? 2 : 0, maximumFractionDigits: a >= 100 ? 0 : 2 });
}

/** Signed percent from a fraction (0.0123 -> +1.23%). Uses a real minus sign. */
export function fmtSignedPct(f: number | null | undefined, d = 2) {
  if (f == null || !Number.isFinite(f)) return "–";
  const v = f * 100;
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return (0).toFixed(d) + "%";
  return (v > 0 ? "+" : "−") + s + "%";
}
/** Signed basis points from a fraction. */
export function fmtSignedBp(f: number | null | undefined, d = 1) {
  if (f == null || !Number.isFinite(f)) return "–";
  const v = f * 10_000;
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return (0).toFixed(d) + " bp";
  return (v > 0 ? "+" : "−") + s + " bp";
}
export const fmtPct = (f: number | null | undefined, d = 2) =>
  f == null || !Number.isFinite(f) ? "–" : (f * 100).toFixed(d) + "%";

export function fmtDuration(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

export function ago(ts: number, now = Date.now() / 1000) {
  const s = Math.max(0, now - ts);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}

export const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 16).replace("T", " ") + " UTC";
