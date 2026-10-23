import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { placeKey, type AtlasEvent } from '../shared/types';

/**
 * The archive. Every query AdGuard Home ever hands us lands here and stays here;
 * nothing except the live arc buffer is thrown away.
 *
 * Uses `node:sqlite` (Node >= 22.13, built into the image) so the container needs
 * no native module and no build toolchain.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queries (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  sub          INTEGER NOT NULL DEFAULT 0,
  instance     TEXT    NOT NULL,
  client       TEXT    NOT NULL,
  domain       TEXT    NOT NULL,
  qtype        TEXT    NOT NULL,
  cls          TEXT    NOT NULL,
  dest_key     TEXT,
  dest_lat     REAL,
  dest_lon     REAL,
  dest_city    TEXT,
  dest_cc      TEXT,
  dest_country TEXT
);

-- Exactly-once import: polled pages overlap, and the backfill re-reads the log.
CREATE UNIQUE INDEX IF NOT EXISTS ux_queries
  ON queries(instance, ts, sub, client, domain, qtype);

-- Every counter is a range scan over one of these.
CREATE INDEX IF NOT EXISTS ix_ts_cls      ON queries(ts, cls);
CREATE INDEX IF NOT EXISTS ix_ts_instance ON queries(ts, instance);
CREATE INDEX IF NOT EXISTS ix_ts_client   ON queries(ts, client, cls);
CREATE INDEX IF NOT EXISTS ix_ts_domain   ON queries(ts, domain, cls);
CREATE INDEX IF NOT EXISTS ix_ts_cc       ON queries(ts, dest_cc, cls);
CREATE INDEX IF NOT EXISTS ix_ts_place    ON queries(ts, dest_key);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface DbOptions {
  path: string;
  /** SQLite page cache, MB. */
  cacheMb?: number;
}

export class Db
