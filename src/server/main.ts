import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_VERSION, type ClientConfig, type ServerStatus } from '../shared/types';
import { AdGuardClient, Poller } from './adguard';
import { ConfigError, loadConfig, type Config } from './config';
import { Db } from './db';
import { MmdbLocator } from './geoip';
import { createAppServer } from './http';
import { Importer } from './importer';
import { log, setLogLevel } from './log';
import { Pipeline } from './pipeline';
import { Masker } from './privacy';
import { collectStats } from './stats';
import { EventWindow } from './window';
import { installStyles } from './styles';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  setLogLevel(config.logLevel);

  const staticDir = process.env.STATIC_DIR || resolve(__dirname, '../web');
  const startedAt = Date.now();

  // The built stylesheet, mirrored into the volume so it can be edited live.
  const styles = config.stylesPath ? installStyles({ staticDir, file: config.stylesPath }) : null;
  const stylesHealth = () =>
    styles ? { url: styles.url, file: styles.file, found: existsSync(styles.file) } : null;

  if (config.demo) {
    const clientConfig: ClientConfig = {
      mode: 'demo',
      home: config.home,
      windowMinutes: config.windowMinutes,
      liveBufferMinutes: config.windowMinutes,
      archive: false,
      view: config.view,
      privacyForced: config.privacyMode,
      version: APP_VERSION,
    };
    const app = createAppServer({
      staticDir,
      clientConfig,
      styles: styles ?? undefined,
      health: () => ({
        status: 'ok',
        mode: 'demo',
        version: APP_VERSION,
        uptimeSeconds: uptime(startedAt),
        view: config.view,
        styles: stylesHealth(),
      }),
    });
    listen(app, config.port, 'demo mode: synthetic traffic generated in the browser, no AdGuard Home is contacted');
    return;
  }

  // The archive. Without a writable mount the whole point of this build is lost,
  // so refuse to start rather than quietly forget every query.
  let db: Db;
  try {
    db = new Db({
      path: config.dbPath,
      cacheMb: config.cacheMb,
      maxRows: config.maxRows,
      onTrim: (removed) => log.info(`row cap: removed the ${removed} oldest queries (MAX ${config.maxRows})`),
    });
  } catch (err) {
    process.stderr.write(
      `Cannot open the database at ${config.dbPath}: ${(err as Error).message}\n` +
        'Mount a writable volume at /data (owned by uid 10001) or set ATLAS_DB to a writable path.\n',
    );
    process.exit(2);
  }
  log.info(
    `database: ${config.dbPath} (${db.count()} queries stored, ${config.cacheMb} MB cache, ` +
      `${config.maxRows > 0 ? `cap ${config.maxRows} rows` : 'no row cap'})`,
  );

  // Apply the cap once at startup, in case the limit was lowered since last run.
  if (config.maxRows > 0) {
    const removed = db.trimTo(config.maxRows);
    if (removed > 0) log.info(`row cap: removed ${removed} queries older than the newest ${config.maxRows}`);
  }

  const clientConfig: ClientConfig = {
    mode: 'live',
    home: config.home,
    windowMinutes: config.windowMinutes,
    liveBufferMinutes: config.liveBufferMinutes,
    archive: true,
    view: config.view,
    privacyForced: config.privacyMode,
    version: APP_VERSION,
  };

  let geo: MmdbLocator | undefined;
  try {
    geo = await MmdbLocator.open(config.geoipDb);
    log.info(`GeoIP database: ${config.geoipDb} (${geo.databaseType})`);
  } catch (err) {
    log.error(
      `Cannot open the GeoIP database at ${config.geoipDb} (${(err as NodeJS.ErrnoException).code ?? 'invalid file'}): queries will be stored and counted but nothing can be drawn on the map`,
    );
  }

  const live = new EventWindow(config.liveBufferMinutes * 60_000);
  const pipeline = new Pipeline({
    geo,
    masker: config.privacyMode ? new Masker() : undefined,
    ignoreClients: config.ignoreClients,
    ignoreDomains: config.ignoreDomains,
  });

  const pollers: Poller[] = [];
  const status = (): ServerStatus => ({
    instances: pollers.map((p) => p.currentStatus),
    geoip: geo !== undefined,
    archived: db.count(),
  });

  const app = createAppServer({
    staticDir,
    clientConfig,
    stream: { snapshot: () => ({ now: Date.now(), events: live.snapshot(), status: status() }) },
    stats: (query) => collectStats(db.handle, query),
    styles: styles ?? undefined,
    health: () => ({
      status: 'ok',
      mode: 'live',
      version: APP_VERSION,
      uptimeSeconds: uptime(startedAt),
      geoip: geo !== undefined,
      view: config.view,
      styles: stylesHealth(),
      db: {
        path: config.dbPath,
        queries: db.count(),
        bytes: db.bytes(),
        maxRows: config.maxRows,
        cacheMb: config.cacheMb,
      },
      instances: pollers.map((p) => ({ name: p.currentStatus.name, state: p.currentStatus.state })),
    }),
  });

  const importers: Importer[] = [];

  for (const instance of config.instances) {
    const client = new AdGuardClient(instance);
    const poller = new Poller(client, {
      name: instance.name,
      intervalMs: config.pollIntervalMs,
      onEntries: (entries) => {
        const events = pipeline.process(instance.name, entries);
        if (events.length === 0) return;

        // Disk first, so a restart loses nothing and duplicates are dropped here.
        let fresh = events;
        try {
          fresh = db.insertBatch(events);
        } catch (err) {
          log.error(`cannot write to ${config.dbPath}: ${(err as Error).message}`);
        }
        if (fresh.length === 0) return;

        live.push(fresh);
        app.broadcast('events', fresh);
        if (config.logLevel === 'debug') {
          for (const e of fresh) log.debug(`${e.instance} ${e.client} ${e.domain} ${e.cls}`);
        }
      },
      onStatus: (s) => {
        if (s.state === 'error') log.warn(`instance "${s.name}": ${s.message}`);
        else log.info(`instance "${s.name}": ${s.state}`);
        app.broadcast('status', status());
      },
    });
    pollers.push(poller);
    if (config.backfill) {
      importers.push(
        new Importer(client, db, (entries) => pipeline.process(instance.name, entries), {
          name: instance.name,
          maxPages: config.backfillPages,
          pauseMs: config.backfillPauseMs,
        }),
      );
    }
  }

  if (config.keepDays > 0) {
    const keepMs = config.keepDays * 86_400_000;
    const timer = setInterval(() => {
      const removed = db.prune(Date.now() - keepMs);
      if (removed > 0) log.info(`retention: removed ${removed} queries older than ${config.keepDays} days`);
    }, 3_600_000);
    timer.unref();
  }

  listen(
    app,
    config.port,
    `polling ${pollers.length} AdGuard Home instance(s) every ${config.pollIntervalMs} ms, opening on ${config.view}`,
    () => {
      for (const p of pollers) p.stop();
      db.close();
    },
  );
  for (const p of pollers) p.start();
  for (const importer of importers) void importer.run();
}

function uptime(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

function listen(app: ReturnType<typeof createAppServer>, port: number, what: string, onStop?: () => void): void {
  app.server.on('error', (err) => {
    log.error(`cannot listen on port ${port}: ${err.message}`);
    process.exit(1);
  });
  app.server.listen(port, () => log.info(`AdGuard Atlas ${APP_VERSION} listening on :${port} — ${what}`));

  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      log.info(`${signal} received, shutting down`);
      onStop?.();
      void app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
