import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { placeKey, type AtlasEvent } from '../shared/types';

/**
 * The archive. Every query AdGuard Home ever hands us lands here and stays here;
 * only the live arc buffer is ever thrown away.
 *
 * Uses `node:sqlite` (built into Node >= 22.13, and into the image), so the
 * container needs no native module and no build toolchain at runtime.
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

-- Exactly-once import: polled pages overlap and the backfill re-reads the log.
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

const COLUMNS = [
  'ts',
  'sub',
  'instance',
  'client',
  'domain',
  'qtype',
  'cls',
  'dest_key',
  'dest_lat',
  'dest_lon',
  'dest_city',
  'dest_cc',
  'dest_country',
].join(', ');

export interface DbOptions {
  path: string;
  /** SQLite page cache, MB. */
  cacheMb?: number;
}

export class Db {
  readonly handle: DatabaseSync;
  private readonly insert: ReturnType<DatabaseSync['prepare']>;
  private counted = { at: 0, rows: 0 };

  constructor(options: DbOptions) {
    this.handle = new DatabaseSync(options.path);
    this.handle.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -${(options.cacheMb ?? 16) * 1000};
      PRAGMA busy_timeout = 5000;
    `);
    this.handle.exec(SCHEMA);
    this.insert = this.handle.prepare(
      `INSERT OR IGNORE INTO queries (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /**
   * Writes a batch in one transaction and returns the events that were actually
   * new. Duplicates (overlapping pages, a backfill crossing the live watermark)
   * come back empty, which is exactly what the live stream must not re-send.
   */
  insertBatch(events: AtlasEvent[]): AtlasEvent[] {
    if (events.length === 0) return [];
    const fresh: AtlasEvent[] = [];
    this.handle.exec('BEGIN IMMEDIATE');
    try {
      for (const e of events) {
        const dest = e.dest;
        const result = this.insert.run(
          e.t,
          e.sub ?? 0,
          e.instance,
          e.client,
          e.domain,
          e.qtype,
          e.cls,
          dest ? placeKey(dest) : null,
          dest?.lat ?? null,
          dest?.lon ?? null,
          dest?.city ?? null,
          dest?.cc ?? null,
          dest?.country ?? null,
        );
        if (Number(result.changes) === 1) fresh.push(e);
      }
      this.handle.exec('COMMIT');
    } catch (err) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        // the transaction is already gone
      }
      throw err;
    }
    return fresh;
  }

  meta(key: string): string | null {
    const row = this.handle.prepare('SELECT value FROM meta WHERE key = ?').get(key) as unknown as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.handle
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Row count, cached: it is only ever shown as a health number. */
  count(): number {
    const now = Date.now();
    if (now - this.counted.at < 30_000) return this.counted.rows;
    const row = this.handle.prepare('SELECT COUNT(*) AS n FROM queries').get() as unknown as { n: number };
    this.counted = { at: now, rows: row.n };
    return row.n;
  }

  /** Size of the main database file; the WAL is transient. */
  bytes(): number {
    try {
      return statSync(new URL(`file://${this.handle.location()}`).pathname).size;
    } catch {
      return 0;
    }
  }

  /** Retention: only used when KEEP_DAYS is set, so "unlimited" really is unlimited. */
  prune(before: number): number {
    const result = this.handle.prepare('DELETE FROM queries WHERE ts < ?').run(before);
    return Number(result.changes);
  }

  close(): void {
    try {
      this.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // nothing left to checkpoint
    }
    this.handle.close();
  }
}
