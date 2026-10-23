import { DatabaseSync } from 'node:sqlite';
import type { AtlasEvent, QueryClass } from '../shared/types';
import { rangeStart, type TimeRange } from '../shared/types';

export interface DbOptions { path: string; cacheMb?: number; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queries (
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,   -- unix ms
  sub       INTEGER NOT NULL,   -- ns remainder within the ms (exact dedupe)
  instance  TEXT    NOT NULL,
  client    TEXT    NOT NULL,
  domain    TEXT    NOT NULL,
  qtype     TEXT    NOT NULL,
  cls       TEXT    NOT NULL,
  dest_key  TEXT,               -- "lat,lon" to 2 dp, same as placeKey()
  dest_lat  REAL,
  dest_lon  REAL,
  dest_city TEXT,
  dest_cc   TEXT,
  dest_country TEXT
);
-- Exact-once import: AdGuard entries repeat on every overlapping page.
CREATE UNIQUE INDEX IF NOT EXISTS ux_queries ON queries(instance, ts, sub, client, domain, qtype);
-- Range scans: covering indexes so aggregations never touch the table.
CREATE INDEX IF NOT EXISTS ix_ts_cls    ON queries(ts, cls);
CREATE INDEX IF NOT EXISTS ix_ts_client ON queries(ts, client, cls);
CREATE INDEX IF NOT EXISTS ix_ts_domain ON queries(ts, domain, cls);
CREATE INDEX IF NOT EXISTS ix_ts_cc     ON queries(ts, dest_cc, cls);
CREATE INDEX IF NOT EXISTS ix_ts_place  ON queries(ts, dest_key);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;
