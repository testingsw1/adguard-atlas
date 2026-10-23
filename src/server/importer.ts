import type { AtlasEvent } from '../shared/types';
import type { QueryLogSource } from './adguard';
import { parseTimeNs, type RawEntry } from './classify';
import type { Db } from './db';
import { log } from './log';

export interface ImporterOptions {
  /** Display name of the instance, also the resume key. */
  name: string;
  pageLimit?: number;
  /** 0 = walk until AdGuard Home's log ends. */
  maxPages?: number;
  pauseMs?: number;
}

/**
 * "All events": AdGuard Home's query log only ever goes backwards, so the very
 * first run walks it from the newest entry to the oldest with `older_than`,
 * one page at a time, while the normal poller keeps the live view going.
 *
 * The unique index makes this idempotent: an interrupted import resumes from the
 * last page it finished, and anything already stored is silently skipped.
 */
export class Importer {
  private readonly name: string;
  private readonly pageLimit: number;
  private readonly maxPages: number;
  private readonly pauseMs: number;

  constructor(
    private readonly source: QueryLogSource,
    private readonly db: Db,
    private readonly map: (entries: RawEntry[]) => AtlasEvent[],
    options: ImporterOptions,
  ) {
    this.name = options.name;
    this.pageLimit = options.pageLimit ?? 1000;
    this.maxPages = options.maxPages ?? 0;
    this.pauseMs = options.pauseMs ?? 250;
  }

  private get cursorKey(): string {
    return `backfill.${this.name}.cursor`;
  }

  private get doneKey(): string {
    return `backfill.${this.name}.done`;
  }

  async run(): Promise<void> {
    if (this.db.meta(this.doneKey)) {
      log.info(`import "${this.name}": already complete`);
      return;
    }

    const cursor = this.db.meta(this.cursorKey);
    let olderThan: string | undefined = cursor ? new Date(Number(cursor)).toISOString() : undefined;
    let imported = 0;
    let pages = 0;

    log.info(
      `import "${this.name}": ${cursor ? `resuming at ${olderThan}` : 'starting from the newest entry'}`,
    );

    try {
      for (;;) {
        if (this.maxPages > 0 && pages >= this.maxPages) break;
        const page = await this.source.fetchQueryLog(this.pageLimit, olderThan);
        if (page.data.length === 0) break;
        pages++;

        imported += this.db.insertBatch(this.map(page.data)).length;

        const oldest = page.oldest || page.data[page.data.length - 1]?.time;
        // No progress means the log has ended, or the server ignores older_than.
        if (!oldest || oldest === olderThan) break;
        olderThan = oldest;

        const ns = parseTimeNs(oldest);
        if (ns !== null) this.db.setMeta(this.cursorKey, String(Number(ns / 1_000_000n)));

        if (pages % 20 === 0) {
          log.info(`import "${this.name}": ${imported} queries imported, reached ${oldest}`);
        }
        if (this.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
      }

      this.db.setMeta(this.doneKey, String(Date.now()));
      log.info(`import "${this.name}": complete, ${imported} new queries from ${pages} page(s)`);
    } catch (err) {
      log.warn(
        `import "${this.name}" stopped after ${imported} queries: ${(err as Error).message} (it resumes on restart)`,
      );
    }
  }
}
