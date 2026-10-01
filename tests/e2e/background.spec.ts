import type { BrowserContext, Worker } from '@playwright/test';
import { DEV_CHECK_TYPE, DevCheckResponseSchema } from '#shared/dev-check.ts';
import { expect, test } from './fixtures.ts';
import { evaluateInContentScript } from './support/content-world.ts';
import { runsDevReload } from './support/extension.ts';
import { openLichess } from './support/lichess.ts';

// The background worker. The dev auto-reload itself would need a real
// rebuild, so it isn't tested here; its bookkeeping and its replies to the
// tabs are, where it runs: in a dev build, not in the release one CI tests.

const LOADED_KEY = 'dev:loaded';
// Read once: the build doesn't change during a run.
const DEV_RELOAD = runsDevReload();
// Long enough for the worker's install work (its async cleanup) to log an error.
const SETTLE_MS = 1000;

async function startedWorker(context: BrowserContext): Promise<Worker> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  expect(new URL(worker.url()).pathname).toBe('/background.js');
  return worker;
}

/** The worker's console errors from now on. */
function errorsOf(worker: Worker): string[] {
  const errors: string[] = [];
  worker.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('the background worker starts, its dev reload only where it runs', async ({ context }) => {
  const worker = await startedWorker(context);
  const errors = errorsOf(worker);
  // The install cleanup's listener; the dev reload's is the worker's only message listener.
  const listening = await worker.evaluate(() => ({
    installed: chrome.runtime.onInstalled.hasListeners(),
    message: chrome.runtime.onMessage.hasListeners(),
  }));
  expect(listening).toEqual({ installed: true, message: DEV_RELOAD });
  await worker.evaluate(
    async milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    SETTLE_MS,
  );
  expect(errors).toEqual([]);
});

test.describe('the dev reload', () => {
  // Skipped before the browser starts.
  test.skip(!DEV_RELOAD, 'this build has no dev reload');

  test('tells a tab its files haven’t changed', async ({ context, page }) => {
    const worker = await startedWorker(context);
    const errors = errorsOf(worker);
    // Once installed, it keeps a digest of the code it runs: a SHA-1, in base64.
    const loaded = (): Promise<unknown> =>
      worker.evaluate(async key => (await chrome.storage.session.get(key))[key], LOADED_KEY);
    await expect.poll(loaded).toMatch(/^[A-Za-z0-9+/]{27}=$/);

    // A Lichess tab asks whether to reload, as its content script does on focus.
    await openLichess(page, '/');
    const answer = await evaluateInContentScript(
      page,
      `chrome.runtime.sendMessage({ type: '${DEV_CHECK_TYPE}' })`,
    );
    expect(DevCheckResponseSchema.parse(answer)).toEqual({ reload: false });
    expect(errors).toEqual([]);
  });
});
