import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { placeKey, type AtlasEvent } from '../shared/types';

/**
 * The archive. Every query AdGuard Home hands us lands here and stays here,
 * until the row cap (or KEEP_DAYS) rolls the oldest ones off.
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

-- The free-text filter is a LIKE scan, which no index can seek into; this one at
-- least covers it, so the scan reads index pages and never the table itself.
CREATE INDEX IF NOT EXISTS ix_ts_text     ON queries(ts, domain, client);

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
  /** SQLite page cache in MB. Explicit, because the container limit is what matters. */
  cacheMb?: number;
  /** Keep at most this many rows; 0 means no row cap. */
  maxRows?: number;
  /** Called after the cap removed rows, for the log. */
  onTrim?: (removed: number) => void;
}

export class Db {
  readonly handle: DatabaseSync;
  private readonly insert: ReturnType<DatabaseSync['prepare']>;
  private readonly maxRows: number;
  /** Trim in batches rather than on every insert: the scan is not free. */
  private readonly trimEvery: number;
  private readonly onTrim?: (removed: number) => void;
  private sinceTrim = 0;
  /** `at: 0` forces a recount; it is invalidated by every write and by each trim. */
  private counted = { at: 0, rows: 0 };

  constructor(options: DbOptions) {
    const cacheMb = Math.min(256, Math.max(8, options.cacheMb ?? 64));
    this.maxRows = Math.max(0, options.maxRows ?? 1_000_000);
    // A tenth of the cap, at least 5000 rows: during a large backfill this keeps
    // the overshoot small without scanning the rowid index every page.
    this.trimEvery = Math.max(5_000, Math.floor(this.maxRows / 10));
    this.onTrim = options.onTrim;

    this.handle = new DatabaseSync(options.path);
    this.handle.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -${cacheMb * 1000};
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

    if (fresh.length > 0) {
      this.counted.at = 0;
      this.sinceTrim += fresh.length;
      if (this.maxRows > 0 && this.sinceTrim >= this.trimEvery) {
        this.sinceTrim = 0;
        const removed = this.trimTo(this.maxRows);
        if (removed > 0) this.onTrim?.(removed);
      }
    }
    return fresh;
  }

  /**
   * Deletes the oldest rows until at most `maxRows` remain.
   *
   * `id` is the rowid, so the newest rows are the highest ids and one comparison
   * finds the cut. Freed pages are reused by later inserts, which is why the file
   * settles near the size of the cap instead of growing forever; no VACUUM needed.
   */
  trimTo(maxRows: number): number {
    if (maxRows <= 0) return 0;
    const edge = this.handle
      .prepare('SELECT id FROM queries ORDER BY id DESC LIMIT 1 OFFSET ?')
      .get(maxRows) as unknown as { id: number } | undefined;
    if (!edge) return 0;
    const result = this.handle.prepare('DELETE FROM queries WHERE id <= ?').run(edge.id);
    const removed = Number(result.changes);
    if (removed > 0) {
      this.counted.at = 0;
      // Let the planner refresh its statistics after a large delete.
      try {
        this.handle.exec('PRAGMA optimize');
      } catch {
        // advisory only
      }
    }
    return removed;
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

  /** Retention by age, only used when KEEP_DAYS is set. */
  prune(before: number): number {
    const result = this.handle.prepare('DELETE FROM queries WHERE ts < ?').run(before);
    const removed = Number(result.changes);
    if (removed > 0) this.counted.at = 0;
    return removed;
  }

  close(): void {
    try {
      this.handle.exec('PRAGMA optimize');
      this.handle.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // nothing left to checkpoint
    }
    this.handle.close();
  }
}
