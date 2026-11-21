import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { WORKER_DIR, env } from "./config.js";
import { log } from "./util.js";

export type Db = Pick<pg.Pool, "query"> & { connect: pg.Pool["connect"]; end: pg.Pool["end"] };

export function makePool(url = env.databaseUrl): pg.Pool {
  if (!url) throw new Error("DATABASE_URL is not set");
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url) || url.includes("sslmode=disable");
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl: local ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  pool.on("error", (e) => log("db", `idle client error: ${e.message}`));
  return pool;
}

export async function applySchema(db: Db) {
  const sql = readFileSync(join(WORKER_DIR, "schema.sql"), "utf8");
  await db.query(sql);
  log("db", "schema applied");
}

export async function getCursor(db: Db, name: string): Promise<number | null> {
  const r = await db.query("SELECT block FROM cursor WHERE name=$1", [name]);
  return r.rows.length ? Number(r.rows[0].block) : null;
}
