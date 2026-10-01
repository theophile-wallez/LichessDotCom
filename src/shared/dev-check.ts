import { z } from 'zod/mini';

// A dev build's reload check: the content script asks the
// background worker over chrome.runtime whether the files on disk changed.
// Kept apart from protocol.ts, which uses `window`, so the worker can import it.

/** The dev reload's message, which only a bundle with the dev reload contains. */
export const DEV_CHECK_TYPE = 'cdc:dev-check';

export const DevCheckRequestSchema = z.object({ type: z.literal(DEV_CHECK_TYPE) });
export const DevCheckResponseSchema = z.object({ reload: z.boolean() });
export type DevCheckRequest = z.infer<typeof DevCheckRequestSchema>;
export type DevCheckResponse = z.infer<typeof DevCheckResponseSchema>;
