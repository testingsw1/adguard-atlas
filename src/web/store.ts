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
 * flight. Without this the view drops back to the RAM buffer for a frame and the
 * counters flash to zero on every keystroke of the text filter.
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

/**
 * The unique index's key, so a live arrival and its archived copy count as the
 * same query when the two lists are merged for the feed.
 */
function eventKey(e: AtlasEvent): string {
  return `${e.instance}|${e.t}|${e.sub ?? 0}|${e.client}|${e.domain}|${e.qtype}`;
}

/**
 * Two sources, on purpose:
 *
 *  - RAM holds the last few minutes, and only those, to feed the arcs as they
 *    arrive;
 *  - the server's SQLite archive, over `/api/stats`, answers every counter, the
 *    map's places and the feed for whatever range is selected.
 *
 * In the demo there is no archive, so `compute()` alone produces the view.
 */
export class AtlasStore {
  private events: AtlasEvent[] = [];
  private listeners = new Set<() => void>();
  private liveListeners = new Set<(e: AtlasEvent) => void>();
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private clockOffset = 0;
  private computedAt = 0;
  private aliases = new Map<string, string>();
  private snapshot: Snapshot;

  private windowMs: number;
  private stats: StatsResponse | null = null;
  private statsKey = '';
  private statsAt = 0;
  private statsSeq = 0;
  private statsEnabled = false;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(windowMs: number, initial: { privacy?: boolean; theme?: Theme } = {}) {
    this.windowMs = windowMs;
    this.snapshot = {
      view: this.compute(defaultFilters(), null),
      filters: defaultFilters(),
      selection: null,
      paused: false,
      privacy: initial.privacy ?? false,
      theme: initial.theme ?? 'dark',
      status: null,
      connection: 'connecting',
      ready: false,
    };
  }

  // --- React binding ------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  private set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  /** Called for every live event that passes the filters, as it arrives. */
  onLive(listener: (e: AtlasEvent) => void): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  start(intervalMs = 450): () => void {
    this.timer = setInterval(() => this.flush(), intervalMs);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }

  /** Recompute the view if anything changed, or if time alone moved the window. */
  flush(force = false): void {
    const idle = !this.dirty && !force;
    if (idle && (this.events.length === 0 || Date.now() - this.computedAt < 2000)) return;
    this.dirty = false;
    this.computedAt = Date.now();
    this.prune();
    this.set({ view: this.compute(this.snapshot.filters, this.snapshot.selection) });
  }

  // --- archive-backed counters --------------------------------------------

  /** Turns on `/api/stats`: every counter then comes from SQLite, not from RAM. */
  enableServerStats(intervalMs = 2000): () => void {
    this.statsEnabled = true;
    this.queueStats(0);
    const timer = setInterval(() => void this.refreshStats(), intervalMs);
    return () => clearInterval(timer);
  }

  private queueStats(delay = 250): void {
    if (!this.statsEnabled) return;
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      void this.refreshStats();
    }, delay);
  }

  private keyOf(f: Filters, s: Selection): string {
    return JSON.stringify([f.range, f.device, f.instance, f.text.trim().toLowerCase(), f.classes, s]);
  }

  async refreshStats(): Promise<void> {
    if (!this.statsEnabled) return;
    const filters = this.snapshot.filters;
    const selection = this.snapshot.selection;
    const key = this.keyOf(filters, selection);
    const seq = ++this.statsSeq;

    const params = new URLSearchParams({ range: filters.range });
    if (filters.device) params.set('device', filters.device);
    if (filters.instance) params.set('instance', filters.instance);
    const text = filters.text.trim();
    if (text) params.set('text', text);
    const hidden = QUERY_CLASSES.filter((c) => !filters.classes[c]);
    if (hidden.length > 0) params.set('hidden', hidden.join(','));
    if (selection?.kind === 'country') {
      params.set('country', selection.cc);
      params.set('countryName', selection.name);
    }
    if (selection?.kind === 'place') params.set('place', selection.key);

    try {
      const res = await fetch(`api/stats?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const stats = (await res.json()) as StatsResponse;
      // A slower answer for older filters must not overwrite a newer one.
      if (seq !== this.statsSeq) return;
      this.stats = stats;
      this.statsKey = key;
      this.statsAt = Date.now();
      this.set({ view: this.compute(this.snapshot.filters, this.snapshot.selection) });
    } catch {
      // the next poll tries again; the last numbers stay on screen
    }
  }

  // --- data ---------------------------------------------------------------

  now(): number {
    return Date.now() + this.clockOffset;
  }

  reset(events: AtlasEvent[], sourceNow?: number): void {
    if (sourceNow !== undefined) this.clockOffset = sourceNow - Date.now();
    this.events = events.slice();
    this.prune();
    this.set({ ready: true, view: this.compute(this.snapshot.filters, this.snapshot.selection) });
    this.queueStats(0);
  }

  ingest(events: AtlasEvent[]): void {
    const filters = this.snapshot.filters;
    for (const e of events) {
      this.events.push(e);
      if (this.liveListeners.size > 0 && this.matches(e, filters)) {
        for (const l of this.liveListeners) l(e);
      }
    }
    this.dirty = true;
  }

  /** RAM keeps only what the arcs need; the archive keeps everything. */
  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop]!.t < cutoff) drop++;
    drop = Math.max(drop, this.events.length - MAX_EVENTS);
    if (drop > 0) this.events.splice(0, drop);
  }

  // --- ui state -----------------------------------------------------------

  setFilters(patch: Partial<Filters>): void {
    const filters = { ...this.snapshot.filters, ...patch };
    this.set({ filters, view: this.compute(filters, this.snapshot.selection) });
    this.queueStats();
  }

  setRange(range: TimeRange): void {
    this.setFilters({ range: parseRange(range) });
  }

  /**
   * The class rows in the counters: clicking one hides it (F16).
   */
  toggleClass(cls: QueryClass): void {
    const classes = { ...this.snapshot.filters.classes };
    classes[cls] = !classes[cls];
    this.setFilters({ classes });
  }

  /**
   * The legend: clicking a class shows only that one. Clicking it again, when it
   * is already the only one visible, brings the other three back. Both call sites
   * write the same `filters.classes`, so the legend and the class rows can never
   * disagree about what is hidden.
   */
  soloClass(cls: QueryClass): void {
    const classes = { ...this.snapshot.filters.classes };
    const alone = QUERY_CLASSES.every((c) => classes[c] === (c === cls));
    for (const c of QUERY_CLASSES) classes[c] = alone ? true : c === cls;
    this.setFilters({ classes });
  }

  clearFilters(): void {
    this.setFilters(defaultFilters());
  }

  select(selection: Selection): void {
    this.set({ selection, view: this.compute(this.snapshot.filters, selection) });
    this.queueStats();
  }

  setPaused(paused: boolean): void {
    this.set({ paused });
  }

  setPrivacy(privacy: boolean): void {
    // A domain typed into the filter would give away what masking hides.
    if (privacy && this.snapshot.filters.text) this.setFilters({ text: '' });
    this.set({ privacy });
  }

  setTheme(theme: Theme): void {
    this.set({ theme });
  }

  setStatus(status: ServerStatus): void {
    this.set({ status });
  }

  setConnection(connection: ConnectionState): void {
    if (connection !== this.snapshot.connection) this.set({ connection });
  }

  /** F19: a stable stand-in for a device name. */
  alias(device: string): string {
    let alias = this.aliases.get(device);
    if (!alias) {
      alias = `Device ${String(this.aliases.size + 1).padStart(2, '0')}`;
      this.aliases.set(device, alias);
    }
    return alias;
  }

  // --- derivation ---------------------------------------------------------

  /** Everything except the class filter. */
  private matchesBase(e: AtlasEvent, f: Filters, words: string[]): boolean {
    if (f.device && e.client !== f.device) return false;
    if (f.instance && e.instance !== f.instance) return false;
    if (words.length > 0) {
      const domain = e.domain.toLowerCase();
      const client = e.client.toLowerCase();
      for (const w of words) if (!domain.includes(w) && !client.includes(w)) return false;
    }
    return true;
  }

  matches(e: AtlasEvent, f: Filters = this.snapshot.filters): boolean {
    return f.classes[e.cls] && this.matchesBase(e, f, textWords(f.text));
  }

  /**
   * Live arrivals that the archived answer cannot contain yet go on top, so the
   * feed stays instant; anything the archive already returned is skipped by key.
   */
  private mergeFeed(archived: AtlasEvent[], filters: Filters, until: number): AtlasEvent[] {
    const seen = new Set(archived.map(eventKey));
    const live: AtlasEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && live.length < FEED_SIZE; i--) {
      const e = this.events[i]!;
      if (e.t <= until) break;
      if (!this.matches(e, filters)) continue;
      const key = eventKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      live.push(e);
    }
    return [...live, ...archived].slice(0, FEED_SIZE);
  }

  /** Overlays the SQLite answer; the last one survives briefly while a new one loads. */
  private withStats(view: View, filters: Filters, selection: Selection): View {
    const s = this.stats;
    if (!s) return view;
    const exact = this.statsKey === this.keyOf(filters, selection);
    if (!exact && Date.now() - this.statsAt > STATS_GRACE_MS) return view;
    return {
      ...view,
      total: s.total,
      byClass: s.byClass,
      blockedShare: s.blockedShare,
      perMinute: s.perMinute,
      buckets: s.buckets,
      topCountries: s.topCountries,
      topDomains: s.topDomains,
      topDevices: s.topDevices,
      countries: s.countries,
      devices: s.devices,
      instances: s.instances,
      places: s.places,
      detail: s.detail,
      feed: this.mergeFeed(s.feed, filters, s.until),
      range: s.range,
      since: s.since,
    };
  }

  private compute(filters: Filters, selection: Selection): View {
    const now = this.now();
    const start = now - this.windowMs;
    const bucketMs = this.windowMs / BUCKETS;
    const words = textWords(filters.text);

    const byClass: Record<QueryClass, number> = { allowed: 0, blocked: 0, local: 0, noanswer: 0 };
    const buckets: [number, number, number][] = Array.from({ length: BUCKETS }, () => [0, 0, 0]);
    const countries = new Map<string, Row>();
    const domains = new Map<string, Row>();
    const devices = new Map<string, Row>();
    const places = new Map<string, Place>();
    const allDevices = new Set<string>();
    const allInstances = new Set<string>();
    const detailDomains = new Map<string, Row>();
    const detailDevices = new Map<string, Row>();
    const detailCities = new Map<string, Row>();
    let detailTotal = 0;
    let detailPlace: Place | undefined;
    let total = 0;
    let perMinute = 0;

    for (const e of this.events) {
      allDevices.add(e.client);
      allInstances.add(e.instance);
      if (!this.matchesBase(e, filters, words)) continue;
      // Counted before the class filter, so hiding a class does not zero its own counter.
      byClass[e.cls]++;
      if (!filters.classes[e.cls]) continue;

      total++;
      if (e.t >= now - 60_000) perMinute++;
      const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor((e.t - start) / bucketMs)));
      buckets[b]![e.cls === 'allowed' ? 0 : e.cls === 'blocked' ? 1 : 2]++;
      bump(domains, e.domain, e.domain, e);
      bump(devices, e.client, e.client, e);

      const dest = e.dest;
      if (!dest) continue;
      const key = placeKey(dest);
      let place = places.get(key);
      if (!place) {
        place = { key, ...dest, count: 0, last: 0 };
        places.set(key, place);
      }
      place.count++;
      if (e.t > place.last) place.last = e.t;
      const countryKey = dest.cc ?? dest.country ?? '??';
      bump(countries, countryKey, dest.country ?? dest.cc ?? 'Unknown', e, dest.cc);

      const selected =
        selection?.kind === 'place'
          ? selection.key === key
          : selection?.kind === 'country'
            ? selection.cc !== '' && selection.cc === dest.cc
            : false;
      if (selected) {
        detailTotal++;
        detailPlace = place;
        bump(detailDomains, e.domain, e.domain, e);
        bump(detailDevices, e.client, e.client, e);
        bump(detailCities, key, dest.city ?? 'Unknown place', e);
      }
    }

    const feed: AtlasEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && feed.length < FEED_SIZE; i--) {
      const e = this.events[i]!;
      if (filters.classes[e.cls] && this.matchesBase(e, filters, words)) feed.push(e);
    }

    let detail: Detail | null = null;
    if (selection?.kind === 'place') {
      detail = {
        title: detailPlace?.city ?? detailPlace?.country ?? 'Selected place',
        subtitle: detailPlace?.city ? (detailPlace.country ?? '') : '',
        total: detailTotal,
        domains: top(detailDomains, 14),
        devices: top(detailDevices, 10),
        cities: [],
      };
    } else if (selection?.kind === 'country') {
      detail = {
        title: selection.name,
        subtitle: detailCities.size > 0 ? `${detailCities.size} ${detailCities.size === 1 ? 'place' : 'places'}` : '',
        total: detailTotal,
        domains: top(detailDomains, 14),
        devices: top(detailDevices, 10),
        cities: top(detailCities, 6),
      };
    }

    const seen = byClass.allowed + byClass.blocked + byClass.local + byClass.noanswer;
    const view: View = {
      total,
      byClass,
      blockedShare: seen > 0 ? byClass.blocked / seen : 0,
      perMinute,
      buckets,
      topCountries: top(countries, 6),
      topDomains: top(domains, 6),
      topDevices: top(devices, 6),
      countries: countries.size,
      feed,
      devices: [...allDevices].sort((a, b) => a.localeCompare(b)),
      instances: [...allInstances].sort((a, b) => a.localeCompare(b)),
      places: [...places.values()].sort((a, b) => b.count - a.count),
      detail,
      range: filters.range,
      since: start,
    };
    return this.withStats(view, filters, selection);
  }
}
