import {
  BUCKETS,
  DEFAULT_RANGE,
  QUERY_CLASSES,
  placeKey,
  parseRange,
  type AtlasEvent,
  type Detail,
  type Place,
  type QueryClass,
  type Row,
  type ServerStatus,
  type StatsResponse,
  type TimeRange,
} from '../shared/types';
import type { ConnectionState } from './sources/types';

export { BUCKETS, placeKey };
export type { Detail, Place, Row };

export interface Filters {
  device: string | null;
  instance: string | null;
  classes: Record<QueryClass, boolean>;
  text: string;
  /** How far back the counters look. Ignored by the demo, which has only 15 minutes. */
  range: TimeRange;
}

export type Selection =
  | { kind: 'place'; key: string }
  | { kind: 'country'; cc: string; name: string; featureId?: string }
  | null;

export interface View {
  total: number;
  byClass: Record<QueryClass, number>;
  /** Share of blocked queries among everything that passes the non-class filters. */
  blockedShare: number;
  perMinute: number;
  /** Histogram over the range: [allowed, blocked, other] per bucket. */
  buckets: [number, number, number][];
  topCountries: Row[];
  topDomains: Row[];
  topDevices: Row[];
  countries: number;
  feed: AtlasEvent[];
  devices: string[];
  instances: string[];
  places: Place[];
  detail: Detail | null;
  /** Which range the numbers describe, and where it starts, for the axis. */
  range: TimeRange;
  since: number;
}

export type Theme = 'dark' | 'light';

export interface Snapshot {
  view: View;
  filters: Filters;
  selection: Selection;
  paused: boolean;
  privacy: boolean;
  theme: Theme;
  status: ServerStatus | null;
  connection: ConnectionState;
  /** False until the first snapshot has arrived. */
  ready: boolean;
}

export const FEED_SIZE = 70;
const MAX_EVENTS = 40_000;

/**
 * How long the previous SQLite answer may stay on screen while a new one is in
 * flight. Without this the view would drop back to the RAM buffer for a frame and
 * the counters would flash to zero on every keystroke.
 */
const STATS_GRACE_MS = 2000;

export function defaultFilters(): Filters {
  return {
    device: null,
    instance: null,
    classes: { allowed: true, blocked: true, local: true, noanswer: true },
    text: '',
    range: DEFAULT_RANGE,
  };
}

export function filtersActive(f: Filters): number {
  return (
    (f.device ? 1 : 0) +
    (f.instance ? 1 : 0) +
    (f.text.trim() ? 1 : 0) +
    (f.range !== DEFAULT_RANGE ? 1 : 0) +
    QUERY_CLASSES.filter((c) => !f.classes[c]).length
  );
}

/** F16: the filter text as lower-case words; each must appear in the domain or the device. */
export function textWords(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function top(map: Map<string, Row>, n: number): Row[] {
  return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, n);
}

function bump(map: Map<string, Row>, key: string, label: string, e: AtlasEvent, cc?: string): void {
  let row = map.get(key);
  if (!row) {
    row = { key, label, count: 0, blocked: 0, cc };
    map.set(key, row);
  }
  row.count++;
  if (e.cls === 'blocked') row.blocked++;
}

/** The unique index's key, so a live arrival and its archived copy are one row. */
function eventKey(e: AtlasEvent): string {
  return `${e.instance}|${e.t}|${e.sub ?? 0}|${e.client}|${e.domain}
