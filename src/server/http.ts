import { readdirSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  QUERY_CLASSES,
  parseRange,
  type ClientConfig,
  type QueryClass,
  type SnapshotMessage,
  type StatsQuery,
  type StatsResponse,
} from '../shared/types';

/**
 * Section 7. Nothing is loaded from anywhere but this origin, and the page may only
 * connect back to it. React writes styles through the CSSOM, which `style-src 'self'`
 * allows; there are no inline scripts or style attributes in the markup.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // A page full of someone's DNS queries has no business in a search index.
  'X-Robots-Tag': 'noindex, nofollow',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.webmanifest']);

interface Asset {
  body: Buffer;
  gzip?: Buffer;
  type: string;
  cache: string;
}

export const CONFIG_PLACEHOLDER = '__ATLAS_CONFIG__';

/** Stable, unhashed URL for the stylesheet a user keeps in the volume. */
export const CUSTOM_CSS_PATH = '/custom.css';
const CUSTOM_CSS_LINK = '<link rel="stylesheet" href="./custom.css">';

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Our link goes immediately before `</head>`, which puts it after the hashed
 * bundle: at equal specificity the later file wins, so an override in
 * /data/custom.css takes effect without touching the built stylesheet.
 */
function injectCustomCss(html: string): string {
  if (html.includes('custom.css')) return html;
  return html.replace(/<\/head>/i, `  ${CUSTOM_CSS_LINK}\n</head>`);
}

/** The bundle is a few megabytes: read it once, serve it from memory. */
function loadAssets(dir: string, config: ClientConfig): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const relPath = posix.join(rel, name);
      const full = join(dir, relPath);
      if (statSync(full).isDirectory()) {
        walk(relPath);
        continue;
      }
      const ext = extname(name).toLowerCase();
      let body = readFileSync(full);
      if (relPath === 'index.html') {
        const html = body
          .toString('utf8')
          .replace(CONFIG_PLACEHOLDER, escapeAttribute(JSON.stringify(config)));
        body = Buffer.from(injectCustomCss(html), 'utf8');
      }
      assets.set('/' + relPath, {
        body,
        gzip: COMPRESSIBLE.has(ext) ? gzipSync(body, { level: 9 }) : undefined,
        type: TYPES[ext] ?? 'application/octet-stream',
        // Vite puts a content hash in everything under /assets/.
        cache: relPath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    }
  };
  walk('');
  return assets;
}

export interface Stream {
  /** What a newly connected tab receives first (F21). */
  snapshot: () => SnapshotMessage;
}

export interface AppServerOptions {
  staticDir: string;
  clientConfig: ClientConfig;
  /** Absent in demo mode: the browser generates its own events. */
  stream?: Stream;
  /** Absent without an archive: the counters then come from the browser's RAM. */
  stats?: (query: StatsQuery) => StatsResponse;
  /** A stylesheet read from disk per request, so it can be edited without a rebuild. */
  customCss?: string;
  health: () => Record<string, unknown>;
  maxStreamClients?: number;
}

export interface AppServer {
  server: http.Server;
  /** Push to every connected browser. */
  broadcast: (event: 'events' | 'status', data: unknown) => void;
  clientCount: () => number;
  close: () => Promise<void>;
}

function readStatsQuery(params: URLSearchParams): StatsQuery {
  const query: StatsQuery = { range: parseRange(params.get('range')) };
  if (params.has('device')) query.device = params.get('device');
  if (params.has('instance')) query.instance = params.get('instance');
  if (params.has('text')) query.text = params.get('text') ?? '';
  if (params.has('country')) query.country = params.get('country') ?? '';
  if (params.has('countryName')) query.countryName = params.get('countryName') ?? '';
  if (params.has('place')) query.place = params.get('place') ?? '';
  const hidden = (params.get('hidden') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c): c is QueryClass => (QUERY_CLASSES as readonly string[]).includes(c));
  if (hidden.length > 0) query.hidden = hidden;
  return query;
}

/**
 * Read on every request rather than cached: the file is a few kilobytes, and a
 * plain refresh should pick up an edit. A missing file is not an error — it just
 * means no overrides — so the browser never logs a 404 for a linked stylesheet.
 */
function readCustomCss(file: string | undefined): string {
  if (!file) return '/* no custom stylesheet configured */\n';
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return `/* ${file} does not exist: no overrides */\n`;
    return `/* cannot read ${file} (${code ?? 'error'}) */\n`;
  }
}

export function createAppServer(options: AppServerOptions): AppServer {
  const assets = loadAssets(options.staticDir, options.clientConfig);
  const clients = new Set<http.ServerResponse>();
  const maxClients = options.maxStreamClients ?? 64;

  const send = (res: http.ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let url: URL;
    let path: string;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
      path = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, 'Bad request');
      return;
    }

    if (path === '/healthz') {
      send(res, 200, JSON.stringify(options.health()), 'application/json; charset=utf-8');
      return;
    }

    // The user's stylesheet. `no-store`, because the point is to see edits at once.
    if (path === CUSTOM_CSS_PATH) {
      send(res, 200, readCustomCss(options.customCss), 'text/css; charset=utf-8');
      return;
    }

    // Every counter the page shows: SQLite aggregates it, the browser only displays it.
    if (path === '/api/stats') {
      if (!options.stats) {
        send(res, 404, 'Not found');
        return;
      }
      try {
        const stats = options.stats(readStatsQuery(url.searchParams));
        send(res, 200, JSON.stringify(stats), 'application/json; charset=utf-8');
      } catch {
        send(res, 500, 'The stats query failed');
      }
      return;
    }

    if (path === '/api/events') {
      if (!options.stream || req.method === 'HEAD') {
        send(res, 404, 'Not found');
        return;
      }
      if (clients.size >= maxClients) {
        send(res, 503, 'Too many open streams');
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(options.stream.snapshot())}\n\n`);
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return;
    }

    const asset = assets.get(path === '/' ? '/index.html' : path);
    if (!asset) {
      send(res, 404, 'Not found');
      return;
    }
    const gzip = asset.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const body = gzip ? asset.gzip! : asset.body;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': asset.type,
      'Content-Length': body.length,
      'Cache-Control': asset.cache,
      ...(asset.gzip ? { Vary: 'Accept-Encoding' } : {}),
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  // Keeps proxies from closing an idle stream on a quiet network.
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref();

  return {
    server,
    broadcast(event, data) {
      if (clients.size === 0) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) res.write(frame);
    },
    clientCount: () => clients.size,
    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
