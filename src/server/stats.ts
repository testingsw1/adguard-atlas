import type { DatabaseSync } from 'node:sqlite';
import {
  BUCKETS,
  QUERY_CLASSES,
  rangeMs,
  type AtlasEvent,
  type Detail,
  type Place,
  type QueryClass,
  type Row,
  type StatsQuery,
  type StatsResponse,
} from '../shared/types';

/** Places are drawn from memory on the canvas; this is the ceiling per frame. */
const PLACE_LIMIT = 800;

/** How many rows the live feed can show; the browser keeps the newest of them. */
const FEED_LIMIT = 300;

/** Long enough for a domain, short enough to keep the LIKE scan bounded. */
const TEXT_LIMIT = 128;

interface Clause {
  sql: string[];
  args: (string | number)[];
}

function rowsOf<T>(db: DatabaseSync, sql: string, args: (string | number)[]): T[] {
  return db.prepare(sql).all(...args) as unknown as T[];
}

function oneOf<T>(db: DatabaseSync, sql: string, args: (string | number)[]): T | undefined {
  return db.prepare(sql).get(...args) as unknown as T | undefined;
}

function and(clause: Clause): string {
  return clause.sql.map((c) => `(${c})`).join(' AND ');
}

function add(clause: Clause, sql: string, ...args: (string | number)[]): Clause {
  return { sql: [...clause.sql, sql], args: [...clause.args, ...args] };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * The filters that apply to every counter: range, device, instance, free text.
 * The text search is deliberately here and not in the browser: it runs over the
 * whole archive, so a domain that resolved last week is still found today.
 */
function baseClause(q: StatsQuery, since: number, until: number): Clause {
  let clause: Clause = { sql: ['ts >= ?', 'ts <= ?'], args: [since, until] };
  if (q.device) clause = add(clause, 'client = ?', q.device);
  if (q.instance) clause = add(clause, 'instance = ?', q.instance);
  const text = (q.text ?? '').slice(0, TEXT_LIMIT).toLowerCase();
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const pattern = `%${escapeLike(word)}%`;
    clause = add(
      clause,
      `(domain LIKE ? ESCAPE '\\' OR LOWER(client) LIKE ? ESCAPE '\\')`,
      pattern,
      pattern,
    );
  }
  return clause;
}

/** A class the user switched off disappears from the totals, not from byClass. */
function withVisible(base: Clause, hidden: QueryClass[]): Clause {
  if (hidden.length === 0) return base;
  return add(base, `cls NOT IN (${hidden.map(() => '?').join(', ')})`, ...hidden);
}

function toRow(cc: string | undefined) {
  return (r: { key: string; label: string | null; n: number; blk: number | null }): Row => ({
    key: r.key,
    label: r.label ?? r.key,
    count: r.n,
    blocked: r.blk ?? 0,
    ...(cc !== undefined ? { cc } : {}),
  });
}

interface FeedRow {
  id: number;
  ts: number;
  sub: number;
  instance: string;
  client: string;
  domain: string;
  qtype: string;
  cls: QueryClass;
  dest_lat: number | null;
  dest_lon: number | null;
  dest_city: string | null;
  dest_cc: string | null;
  dest_country: string | null;
}

/**
 * Every number the counters show, aggregated by SQLite straight from the disk
 * indexes, plus the newest matches for the feed so the free-text filter covers
 * the whole archive rather than whatever happens to be in RAM.
 */
export function collectStats(db: DatabaseSync, q: StatsQuery, now = Date.now()): StatsResponse {
  const bounds = oneOf<{ oldest: number | null }>(db, 'SELECT MIN(ts) AS oldest FROM queries', []);
  const oldest = bounds?.oldest ?? now;
  const span = rangeMs(q.range);
  const since = span === null ? oldest : Math.max(oldest, now - span);
  const hidden = q.hidden ?? [];

  const base = baseClause(q, since, now);
  const visible = withVisible(base, hidden);

  // --- classes and the headline numbers ---

  const byClass: Record<QueryClass, number> = { allowed: 0, blocked: 0, local: 0, noanswer: 0 };
  for (const row of rowsOf<{ cls: QueryClass; n: number }>(
    db,
    `SELECT cls, COUNT(*) AS n FROM queries WHERE ${and(base)} GROUP BY cls`,
    base.args,
  )) {
    byClass[row.cls] = row.n;
  }

  const total = QUERY_CLASSES.filter((c) => !hidden.includes(c)).reduce((sum, c) => sum + byClass[c], 0);
  const seen = QUERY_CLASSES.reduce((sum, c) => sum + byClass[c], 0);

  const minute = add(visible, 'ts >= ?', Math.max(now - 60_000, since));
  const perMinute =
    oneOf<{ n: number }>(db, `SELECT COUNT(*) AS n FROM queries WHERE ${and(minute)}`, minute.args)?.n ?? 0;

  // --- sparkline ---

  const bucketMs = Math.max(1, (now - since) / BUCKETS);
  const buckets: [number, number, number][] = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
  for (const row of rowsOf<{ b: number; a: number | null; bl: number | null; o: number | null }>(
    db,
    `SELECT CAST((ts - ?) / ? AS INTEGER) AS b,
            SUM(cls = 'allowed') AS a,
            SUM(cls = 'blocked') AS bl,
            SUM(cls NOT IN ('allowed', 'blocked')) AS o
       FROM queries WHERE ${and(visible)} GROUP BY b`,
    [since, bucketMs, ...visible.args],
  )) {
    const index = Math.min(BUCKETS - 1, Math.max(0, row.b));
    buckets[index] = [row.a ?? 0, row.bl ?? 0, row.o ?? 0];
  }

  // --- top lists ---

  const topDomains = rowsOf<{ key: string; label: string | null; n: number; blk: number | null }>(
    db,
    `SELECT domain AS key, domain AS label, COUNT(*) AS n, SUM(cls = 'blocked') AS blk
       FROM queries WHERE ${and(visible)}
      GROUP BY domain ORDER BY n DESC, domain ASC LIMIT ?`,
    [...visible.args, 6],
  ).map(toRow(undefined));

  const topDevices = rowsOf<{ key: string; label: string | null; n: number; blk: number | null }>(
    db,
    `SELECT client AS key, client AS label, COUNT(*) AS n, SUM(cls = 'blocked') AS blk
       FROM queries WHERE ${and(visible)}
      GROUP BY client ORDER BY n DESC, client ASC LIMIT ?`,
    [...visible.args, 6],
  ).map(toRow(undefined));

  const topCountries = rowsOf<{ key: string; label: string | null; n: number; blk: number | null; cc: string }>(
    db,
    `SELECT dest_cc AS key, dest_country AS label, COUNT(*) AS n, SUM(cls = 'blocked') AS blk, dest_cc AS cc
       FROM queries WHERE ${and(visible)} AND dest_cc IS NOT NULL
      GROUP BY dest_cc ORDER BY n DESC, dest_cc ASC LIMIT ?`,
    [...visible.args, 6],
  ).map((r) => ({ ...toRow(r.cc)(r), cc: r.cc }));

  const countries =
    oneOf<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT dest_cc) AS n FROM queries WHERE ${and(visible)} AND dest_cc IS NOT NULL`,
      visible.args,
    )?.n ?? 0;

  // --- what the map draws ---

  const places: Place[] = rowsOf<{
    key: string;
    lat: number | null;
    lon: number | null;
    city: string | null;
    country: string | null;
    cc: string | null;
    n: number;
    last: number;
  }>(
    db,
    `SELECT dest_key AS key, dest_lat AS lat, dest_lon AS lon, dest_city AS city,
            dest_country AS country, dest_cc AS cc, COUNT(*) AS n, MAX(ts) AS last
       FROM queries WHERE ${and(visible)} AND dest_key IS NOT NULL
      GROUP BY dest_key ORDER BY n DESC LIMIT ?`,
    [...visible.args, PLACE_LIMIT],
  )
    .filter((p) => p.lat !== null && p.lon !== null)
    .map((p) => ({
      key: p.key,
      lat: p.lat as number,
      lon: p.lon as number,
      city: p.city ?? undefined,
      country: p.country ?? undefined,
      cc: p.cc ?? undefined,
      count: p.n,
      last: p.last,
    }));

  // --- the feed: newest matches anywhere in the range ---

  const feed: AtlasEvent[] = rowsOf<FeedRow>(
    db,
    `SELECT id, ts, sub, instance, client, domain, qtype, cls,
            dest_lat, dest_lon, dest_city, dest_cc, dest_country
       FROM queries WHERE ${and(visible)}
      ORDER BY ts DESC, id DESC LIMIT ?`,
    [...visible.args, FEED_LIMIT],
  ).map((r) => {
    const event: AtlasEvent = {
      // Prefixed so an archived row can never collide with a live SSE id.
      id: `q${r.id}`,
      t: r.ts,
      sub: r.sub,
      instance: r.instance,
      client: r.client,
      domain: r.domain,
      qtype: r.qtype,
      cls: r.cls,
    };
    if (r.dest_lat !== null && r.dest_lon !== null) {
      event.dest = {
        lat: r.dest_lat,
        lon: r.dest_lon,
        city: r.dest_city ?? undefined,
        country: r.dest_country ?? undefined,
        cc: r.dest_cc ?? undefined,
      };
    }
    return event;
  });

  // --- the filter dropdowns: never narrowed by their own selection ---

  const devices = rowsOf<{ client: string }>(
    db,
    'SELECT DISTINCT client FROM queries WHERE ts >= ? AND ts <= ? ORDER BY client',
    [since, now],
  ).map((r) => r.client);

  const instances = rowsOf<{ instance: string }>(
    db,
    'SELECT DISTINCT instance FROM queries WHERE ts >= ? AND ts <= ? ORDER BY instance',
    [since, now],
  ).map((r) => r.instance);

  // --- click-through ---

  let detail: Detail | null = null;
  const isPlace = q.place !== undefined;
  const isCountry = q.country !== undefined;
  if (isPlace || isCountry) {
    const scope = isPlace
      ? add(visible, 'dest_key = ?', q.place as string)
      : add(visible, 'dest_cc = ?', q.country as string);

    const detailTotal =
      oneOf<{ n: number }>(db, `SELECT COUNT(*) AS n FROM queries WHERE ${and(scope)}`, scope.args)?.n ?? 0;

    const domains = rowsOf<{ key: string; label: string | null; n: number; blk: number | null }>(
      db,
      `SELECT domain AS key, domain AS label, COUNT(*) AS n, SUM(cls = 'blocked') AS blk
         FROM queries WHERE ${and(scope)}
        GROUP BY domain ORDER BY n DESC, domain ASC LIMIT ?`,
      [...scope.args, 14],
    ).map(toRow(undefined));

    const devicesHere = rowsOf<{ key: string; label: string | null; n: number; blk: number | null }>(
      db,
      `SELECT client AS key, client AS label, COUNT(*) AS n, SUM(cls = 'blocked') AS blk
         FROM queries WHERE ${and(scope)}
        GROUP BY client ORDER BY n DESC, client ASC LIMIT ?`,
      [...scope.args, 10],
    ).map(toRow(undefined));

    let title: string;
    let subtitle = '';
    let cities: Row[] = [];

    if (isPlace) {
      const meta = oneOf<{ city: string | null; country: string | null }>(
        db,
        'SELECT dest_city AS city, dest_country AS country FROM queries WHERE dest_key = ? LIMIT 1',
        [q.place as string],
      );
      title = meta?.city || meta?.country || 'Selected place';
      subtitle = meta?.city ? (meta.country ?? '') : '';
    } else {
      cities = rowsOf<{ key: string; label: string | null; n: number; blk: number | null }>(
        db,
        `SELECT dest_key AS key, dest_city AS label, COUNT(*) AS n, SUM(cls = 'blocked') AS blk
           FROM queries WHERE ${and(scope)} AND dest_key IS NOT NULL
          GROUP BY dest_key ORDER BY n DESC LIMIT ?`,
        [...scope.args, 6],
      ).map((r) => toRow(undefined)({ ...r, label: r.label ?? 'Unknown place' }));
      title = q.countryName || q.country || 'Selected country';
      subtitle = cities.length > 0 ? `${cities.length} ${cities.length === 1 ? 'place' : 'places'}` : '';
    }

    detail = { title, subtitle, total: detailTotal, domains, devices: devicesHere, cities };
  }

  return {
    range: q.range,
    since,
    until: now,
    total,
    byClass,
    blockedShare: seen > 0 ? byClass.blocked / seen : 0,
    perMinute,
    buckets,
    topCountries,
    topDomains,
    topDevices,
    countries,
    devices,
    instances,
    places,
    detail,
    feed,
  };
}
