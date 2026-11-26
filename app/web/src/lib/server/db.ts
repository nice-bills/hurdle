import { Pool } from "pg";
import type { KeeperRun, VaultEvent } from "@/lib/types";

const url = process.env.DATABASE_URL;
const g = globalThis as unknown as { __hurdlePg?: Pool | null; __hurdlePgDownUntil?: number };

function needsSsl(u: string) {
  if (process.env.DATABASE_SSL === "false") return false;
  if (process.env.DATABASE_SSL === "true") return true;
  return /sslmode=require/.test(u) || /\.render\.com/.test(u);
}

export function pool(): Pool | null {
  if (!url) return null;
  if ((g.__hurdlePgDownUntil ?? 0) > Date.now()) return null;
  if (g.__hurdlePg === undefined) {
    g.__hurdlePg = new Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 30_000,
      ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
    });
    g.__hurdlePg.on("error", () => {});
  }
  return g.__hurdlePg;
}

/** Runs a query; on any failure marks the DB down for 30 s so callers fall back to RPC quickly. */
export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[] | null> {
  const p = pool();
  if (!p) return null;
  try {
    const r = await p.query(sql, params);
    return r.rows as T[];
  } catch (e) {
    console.warn("[db] query failed, falling back to RPC:", (e as Error).message);
    g.__hurdlePgDownUntil = Date.now() + 30_000;
    return null;
  }
}

export type DbVault = {
  address: string; curator: string; pool_id: string; created_block: string; created_tx: string;
  carry_bps: number | null; min_bond_bps: number | null; max_tick_dev: number | null; epoch_seconds: string | null; label: string | null;
};

export async function dbVaults() {
  return q<DbVault>("SELECT * FROM vaults ORDER BY created_block ASC");
}

type DbEvent = { vault: string; block: string; tx: string; log_index: number; ts: Date; name: string; args: Record<string, unknown> };
const toEvent = (r: DbEvent): VaultEvent => ({
  name: r.name,
  block: Number(r.block),
  tx: r.tx,
  logIndex: r.log_index,
  ts: Math.floor(new Date(r.ts).getTime() / 1000),
  args: Object.fromEntries(Object.entries(r.args ?? {}).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : String(v)])),
});

export async function dbEvents(vault?: string): Promise<VaultEvent[] | null> {
  const rows = vault
    ? await q<DbEvent>("SELECT vault, block, tx, log_index, ts, name, args FROM events WHERE lower(vault) = lower($1) ORDER BY block ASC, log_index ASC", [vault])
    : await q<DbEvent>("SELECT vault, block, tx, log_index, ts, name, args FROM events ORDER BY block ASC, log_index ASC");
  return rows ? rows.map((r) => ({ ...toEvent(r), args: { ...toEvent(r).args, vault: r.vault.toLowerCase() } })) : null;
}

export async function dbCursorBlock() {
  const r = await q<{ block: string }>("SELECT max(block) AS block FROM cursor");
  return r && r[0]?.block != null ? Number(r[0].block) : null;
}

export async function dbSnapshots(vault: string, bondDecimals = 18, limit = 720) {
  const r = await q<{ ts: Date; nav: string | null; bond_value: string | null }>(
    "SELECT ts, nav, bond_value FROM snapshots WHERE lower(vault) = lower($1) ORDER BY ts DESC LIMIT $2",
    [vault, limit],
  );
  if (!r) return null;
  return r
    .reverse()
    .map((x) => {
      const nav = x.nav ? Number(x.nav) / 10 ** bondDecimals : 0;
      const bv = x.bond_value ? Number(x.bond_value) / 10 ** bondDecimals : null;
      return { ts: Math.floor(new Date(x.ts).getTime() / 1000), nav, bondBps: bv != null && nav > 0 ? (bv / nav) * 10_000 : null };
    });
}

export async function dbPoolTicks(sinceSec: number, poolId: string) {
  const r = await q<{ ts: Date; tick: number }>(
    "SELECT ts, tick FROM pool_ticks WHERE pool_id = $2 AND ts >= to_timestamp($1) ORDER BY ts ASC LIMIT 2000",
    [sinceSec, poolId.toLowerCase()],
  );
  return r ? r.map((x) => ({ ts: Math.floor(new Date(x.ts).getTime() / 1000), tick: x.tick })) : null;
}

export async function dbKeeper(vault?: string, limit = 12): Promise<KeeperRun[] | null> {
  type Row = { ts: Date; action: string; vault: string | null; tx: string | null; ok: boolean; skipped?: boolean; note: string | null };
  // SELECT *: `skipped` only exists once the worker has applied its schema, and the web must not break before that.
  const r = vault
    ? await q<Row>("SELECT * FROM keeper_runs WHERE lower(vault) = lower($1) ORDER BY ts DESC LIMIT $2", [vault, limit])
    : await q<Row>("SELECT * FROM keeper_runs ORDER BY ts DESC LIMIT $1", [limit]);
  return r
    ? r.map((x) => ({ ts: Math.floor(new Date(x.ts).getTime() / 1000), action: x.action, vault: x.vault, tx: x.tx, ok: x.ok, skipped: Boolean(x.skipped), note: x.note }))
    : null;
}
