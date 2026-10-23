/** Types shared by the server and the front end. */

export type QueryClass = 'allowed' | 'blocked' | 'local' | 'noanswer';

export const QUERY_CLASSES: readonly QueryClass[] = ['allowed', 'blocked', 'local', 'noanswer'];

export const APP_VERSION = '0.2.0';
export const REPO_URL = 'https://github.com/marska/adguard-atlas';

/** Buckets in the sparkline over the selected range. */
export const BUCKETS = 60;

/** Where an answer points, as far as the GeoIP database knows. */
export interface Destination {
  lat: number;
  lon: number;
  city?: string;
  country?: string;
  /** ISO 3166-1 alpha-2 */
  cc?: string;
}

/** One DNS query, classified and located. */
export interface AtlasEvent {
  id: string;
  /** Unix time in milliseconds */
  t: number;
  /** Nanoseconds within that millisecond, so two queries in one ms stay distinct. */
  sub?: number;
  /** Display name of the AdGuard Home instance */
  instance: string;
  /** Device name, or its IP address when AdGuard Home has no name for it */
  client: string;
  domain: string;
  qtype: string;
  cls: QueryClass;
  dest?: Destination;
}

export interface InstanceStatus {
  name: string;
  state: 'connecting' | 'ok' | 'error';
  message?: string;
  lastOk?: number;
}

export interface ServerStatus {
  instances: InstanceStatus[];
  /** false when no GeoIP database could be opened: nothing can be located */
  geoip: boolean;
  /** Rows in the archive, when the server has one. */
  archived?: number;
}

export interface SnapshotMessage {
  /** Server clock, so a browser with a wrong clock still windows correctly */
  now: number;
  events: AtlasEvent[];
  status: ServerStatus;
}

/** Which of the two layouts the page opens in. */
export type AtlasView = 'map' | 'stats';

/** `VIEW` is forgiving: anything that is not "map" means the stats dashboard. */
export function parseView(raw: string | null | undefined): AtlasView {
  return (raw ?? '').trim().toLowerCase() === 'map' ? 'map' : 'stats';
}

/** Injected into index.html by the server (or at build time for the static demo). */
export interface ClientConfig {
  mode: 'live' | 'demo';
  home: { lat: number; lon: number; label: string };
  /** Only sizes the demo generator now; live counters come from the selected range. */
  windowMinutes: number;
  /** How much live traffic the server keeps in RAM for the arcs. */
  liveBufferMinutes: number;
  /** False when the archive is unavailable and counters fall back to RAM. */
  archive: boolean;
  /** The default view, from `VIEW`; the brand button switches it per tab. */
  view: AtlasView;
  privacyForced: boolean;
  version: string;
}

/** Where the demo's invented household lives when nothing else is configured. */
export const DEMO_HOME = { lat: 48.21, lon: 16.37 };

export const DEFAULT_WINDOW_MINUTES = 15;

/** The configuration baked into the static demo build. */
export const STATIC_DEMO_CONFIG: ClientConfig = {
  mode: 'demo',
  home: { ...DEMO_HOME, label: 'Home' },
  windowMinutes: DEFAULT_WINDOW_MINUTES,
  liveBufferMinutes: 15,
  archive: false,
  view: 'stats',
  privacyForced: false,
  version: APP_VERSION,
};

// --- time ranges ------------------------------------------------------------

export type TimeRange = '15m' | '1h' | '24h' | '7d' | 'all';

export const TIME_RANGES: readonly TimeRange[] = ['15m', '1h', '24h', '7d', 'all'];

/** What the select shows. */
export const RANGE_LABEL: Record<TimeRange, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  all: 'Unlimited',
};

/** What the counters show, in as few words as possible. */
export const RANGE_SHORT: Record<TimeRange, string> = {
  '15m': '15 min',
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  all: 'all time',
};

export const DEFAULT_RANGE: TimeRange = '15m';

export function parseRange(raw: string | null | undefined): TimeRange {
  return TIME_RANGES.includes(raw as TimeRange) ? (raw as TimeRange) : DEFAULT_RANGE;
}

/** Length of a range in milliseconds; null means "from the oldest stored query". */
export function rangeMs(range: TimeRange): number | null {
  switch (range) {
    case '15m':
      return 15 * 60_000;
    case '1h':
      return 60 * 60_000;
    case '24h':
      return 24 * 60 * 60_000;
    case '7d':
      return 7 * 24 * 60 * 60_000;
    default:
      return null;
  }
}

// --- shapes both sides share (the counters) ---------------------------------

/** One bar in a top list. */
export interface Row {
  key: string;
  label: string;
  count: number;
  blocked: number;
  cc?: string;
}

export interface Place {
  key: string;
  lat: number;
  lon: number;
  city?: string;
  country?: string;
  cc?: string;
  count: number;
  last: number;
}

export interface Detail {
  title: string;
  subtitle: string;
  total: number;
  domains: Row[];
  devices: Row[];
  cities: Row[];
}

export function placeKey(dest: { lat: number; lon: number }): string {
  return `${dest.lat.toFixed(2)},${dest.lon.toFixed(2)}`;
}

/** What the browser asks for; the server answers with StatsResponse. */
export interface StatsQuery {
  range: TimeRange;
  device?: string | null;
  instance?: string | null;
  /** Free text: every word must appear in the domain or the device name. */
  text?: string;
  /** Classes the user has switched off: they are excluded from the totals. */
  hidden?: QueryClass[];
  /** `country` and `place` open the click-through panel; both may be empty strings. */
  country?: string;
  countryName?: string;
  place?: string;
}

/** Everything the counters need, computed by SQLite over the selected range. */
export interface StatsResponse {
  range: TimeRange;
  since: number;
  until: number;
  total: number;
  byClass: Record<QueryClass, number>;
  /** Blocked share among everything that passes the non-class filters. */
  blockedShare: number;
  perMinute: number;
  buckets: [number, number, number][];
  topCountries: Row[];
  topDomains: Row[];
  topDevices: Row[];
  countries: number;
  devices: string[];
  instances: string[];
  places: Place[];
  detail: Detail | null;
  /**
   * The newest matching queries in the whole selected range, not just the live
   * buffer: this is what makes the free-text filter search every stored query.
   */
  feed: AtlasEvent[];
}
