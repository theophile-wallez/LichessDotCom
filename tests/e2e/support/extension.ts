import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ManifestSchema } from '#manifest';
import { DEV_CHECK_TYPE } from '#shared/dev-check.ts';
import { chromium, type BrowserContext, type BrowserContextOptions } from '@playwright/test';

// Where the build under test is, and how Chromium must be launched to load it.

/**
 * The unpacked extension: dist/chrome, or the folder CDC_EXTENSION_DIR names.
 * A private build keeps a `pnpm dev` running elsewhere from reloading the
 * extension, and the tabs with it, in the middle of a run.
 */
export const EXTENSION_DIR = path.resolve(
  process.env['CDC_EXTENSION_DIR'] ??
    path.join(import.meta.dirname, '..', '..', '..', 'dist', 'chrome'),
);

const readIn = (file: string): string | null => {
  const at = path.join(EXTENSION_DIR, file);
  return existsSync(at) ? readFileSync(at, 'utf8') : null;
};

/**
 * Whether this build runs the dev reload, as its worker decides: the dev
 * reload's code in the bundle (a release build drops it) and the storage
 * permission (src/background/index.ts). False for a build not there yet,
 * which `assertBuilt` reports.
 */
export function runsDevReload(): boolean {
  const worker = readIn('background.js');
  const manifest = readIn('manifest.json');
  if (worker === null || manifest === null) return false;
  const { permissions = [] } = ManifestSchema.parse(JSON.parse(manifest));
  return worker.includes(DEV_CHECK_TYPE) && permissions.includes('storage');
}

/** Fails early, rather than with every test timing out on an unstyled page. */
export function assertBuilt(): void {
  if (!existsSync(path.join(EXTENSION_DIR, 'manifest.json')))
    throw new Error(`No extension in ${EXTENSION_DIR}: build it first (pnpm build).`);
}

// Lichess serves its mobile layout to headless Chrome's own user agent.
export const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const LAUNCH_ARGS: readonly string[] = [
  `--disable-extensions-except=${EXTENSION_DIR}`,
  `--load-extension=${EXTENSION_DIR}`,
  '--mute-audio',
];

/** What the extension's own files are served from. */
export const EXTENSION_ORIGIN = 'chrome-extension://';

type Option<K extends keyof BrowserContextOptions> = NonNullable<BrowserContextOptions[K]>;

export interface LaunchOptions {
  readonly baseURL?: string | undefined;
  readonly viewport: Option<'viewport'> | null;
  readonly locale?: string | undefined;
  readonly colorScheme: Option<'colorScheme'> | null;
  readonly reducedMotion: Option<'reducedMotion'> | null;
}

/** A fresh Chromium profile with the built extension loaded, as a user would have it. */
export async function launchWithExtension(options: LaunchOptions): Promise<BrowserContext> {
  assertBuilt();
  const { baseURL, viewport, locale, colorScheme, reducedMotion } = options;
  // `channel: 'chromium'` is what loads extensions: Playwright's default
  // headless shell drops them without a word.
  return chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [...LAUNCH_ARGS],
    // Headless, Playwright hides the scrollbars: a layout that only fits
    // without them would pass here and overflow in a real Chrome.
    ignoreDefaultArgs: ['--hide-scrollbars'],
    userAgent: DESKTOP_CHROME,
    ...(baseURL === undefined ? {} : { baseURL }),
    viewport,
    colorScheme,
    reducedMotion,
    ...(locale === undefined ? {} : { locale }),
  });
}
