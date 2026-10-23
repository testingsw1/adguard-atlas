import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { log } from './log';

/**
 * The built stylesheet, mirrored into the volume so it can be edited without a
 * rebuild.
 *
 * Vite emits `<link rel="stylesheet" href="./assets/index-<hash>.css">`. Instead
 * of adding a second stylesheet, the server finds that exact file, copies it to
 * /data/atlas.css the first time, and from then on answers the *same URL* with
 * the contents of the volume copy. The page needs no change, the cascade is
 * unchanged, and `Cache-Control: no-store` makes a refresh show an edit.
 */
export interface StylesOverride {
  /** The URL the page asks for, e.g. `/assets/index-Ca3f9b2Q.css`. */
  url: string;
  /** Absolute path of the editable copy, e.g. `/data/atlas.css`. */
  file: string;
  /** Current contents of the copy, or null to fall back to the built asset. */
  read: () => string | null;
}

const LINK = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;
const HREF = /href=["']([^"']+)["']/i;

/** The first stylesheet linked in index.html, which is the app's single bundle. */
function primaryHref(html: string): string | null {
  LINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK.exec(html)) !== null) {
    const href = HREF.exec(match[0])?.[1];
    if (!href) continue;
    const clean = href.split(/[?#]/)[0];
    if (clean && clean.endsWith('.css')) return clean;
  }
  return null;
}

export function installStyles(options: { staticDir: string; file: string }): StylesOverride | null {
  let html: string;
  try {
    html = readFileSync(join(options.staticDir, 'index.html'), 'utf8');
  } catch {
    log.warn(`stylesheet: cannot read ${options.staticDir}/index.html, volume styling is off`);
    return null;
  }

  const href = primaryHref(html);
  if (!href) {
    log.warn('stylesheet: index.html links no stylesheet, volume styling is off');
    return null;
  }

  const relative = href.replace(/^\.?\//, '');
  const url = posix.normalize('/' + relative);
  const source = join(options.staticDir, relative);

  if (!existsSync(options.file)) {
    try {
      const css = readFileSync(source, 'utf8');
      mkdirSync(dirname(options.file), { recursive: true });
      writeFileSync(options.file, css, { mode: 0o644 });
      log.info(`stylesheet: copied ${relative} to ${options.file}; edit it and refresh, no rebuild needed`);
    } catch (err) {
      log.warn(`stylesheet: cannot seed ${options.file} from ${source}: ${(err as Error).message}`);
      return null;
    }
  } else {
    log.info(`stylesheet: serving ${options.file} instead of the built ${relative}`);
    log.info(`stylesheet: delete ${options.file} to go back to the stylesheet compiled into the image`);
  }

  let complained = false;
  return {
    url,
    file: options.file,
    read() {
      try {
        return readFileSync(options.file, 'utf8');
      } catch (err) {
        if (!complained) {
          complained = true;
          log.warn(
            `stylesheet: cannot read ${options.file} (${(err as NodeJS.ErrnoException).code ?? 'error'}); ` +
              'using the built stylesheet',
          );
        }
        return null;
      }
    },
  };
}
