-- Hurdle worker schema. Idempotent: applied at every boot. Web reads these tables; never rename columns.

CREATE TABLE IF NOT EXISTS vaults (
  address        text PRIMARY KEY,
  curator        text NOT NULL,
  pool_id        text NOT NULL,
  created_block  bigint NOT NULL,
  created_tx     text NOT NULL,
  carry_bps      integer,
  min_bond_bps   integer,
  max_tick_dev   integer,
  epoch_seconds  bigint,
  label          text
);

CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  vault      text NOT NULL,
  block      bigint NOT NULL,
  tx         text NOT NULL,
  log_index  integer NOT NULL,
  ts         timestamptz NOT NULL,
  name       text NOT NULL,
  args       jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx, log_index)
);
CREATE INDEX IF NOT EXISTS events_vault_block_idx ON events (vault, block DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS events_name_idx ON events (name);

CREATE TABLE IF NOT EXISTS snapshots (
  vault        text NOT NULL,
  block        bigint NOT NULL,
  ts           timestamptz NOT NULL,
  nav          numeric,
  bond         numeric,
  bond_value   numeric,
  deficit      numeric,
  fired        boolean,
  total_supply numeric,
  lo           integer,
  hi           integer,
  tick         integer,
  PRIMARY KEY (vault, block)
);
CREATE INDEX IF NOT EXISTS snapshots_vault_ts_idx ON snapshots (vault, ts DESC);

CREATE TABLE IF NOT EXISTS pool_ticks (
  block       bigint PRIMARY KEY,
  ts          timestamptz NOT NULL,
  tick        integer NOT NULL,
  sqrt_price  numeric NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_ticks_ts_idx ON pool_ticks (ts DESC);

CREATE TABLE IF NOT EXISTS keeper_runs (
  id      bigserial PRIMARY KEY,
  ts      timestamptz NOT NULL DEFAULT now(),
  action  text NOT NULL,
  vault   text,
  tx      text,
  ok      boolean NOT NULL,
  note    text
);
-- skipped: the keeper simulated the call, it would revert for an expected reason (note = decoded error name); not a failure.
ALTER TABLE keeper_runs ADD COLUMN IF NOT EXISTS skipped boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS keeper_runs_ts_idx ON keeper_runs (ts DESC);

CREATE TABLE IF NOT EXISTS cursor (
  name   text PRIMARY KEY,
  block  bigint NOT NULL
);
