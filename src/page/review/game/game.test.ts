import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { StoredRecordCodec } from '#page/review/evaluation/stored.ts';
import { UNIT_CASES } from '#page/review/fixtures/unit-cases.ts';
import { builtSession, fakeGame, newSession } from '#page/review/fixtures/unit-review.ts';
import type { JudgedMove } from '#page/review/session.ts';
import { nearly } from '#shared/testing/numbers.ts';
import { nextJob } from './analyse-game.ts';
import { cacheRecords, readCachedRecords } from './cache.ts';
import { lookUpCloud } from './cloud-lookup.ts';
import { readExport } from './export.ts';
import { seedBooks } from './work.ts';
// What the original script built from the same records.
import legacy from './fixtures/legacy.json' with { type: 'json' };

afterEach(() => {
  Reflect.deleteProperty(window, 'site');
  localStorage.clear();
});

const short = (color: string): string => (color === 'white' ? 'w' : 'b');

const PHASE_KEYS: Readonly<Record<string, string>> = {
  opening: 'o',
  tactics: 't',
  strategy: 's',
  endgame: 'e',
};

const byLegacyKeys = <T>(
  record: Readonly<Record<string, T>>,
  keys: (key: string) => string,
): Record<string, T> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [keys(key), value]));

const moveOf = (move: JudgedMove | undefined): unknown =>
  move && {
    ply: move.ply,
    cls: move.moveClass,
    loss: move.loss,
    accuracy: move.accuracy,
    best: move.best,
    previous: move.previousMove ? [move.previousMove.ply, move.previousMove.moveClass] : null,
  };

describe('refresh', () => {
  it.each(UNIT_CASES.builds.map((build, i) => [build.game, build, legacy.builds[i]]))(
    'builds %s’s review as the original did',
    (_, build, expected) => {
      const session = builtSession(build);
      const { review, progress, version, revealed } = session.view;
      if (!review) throw new Error('no review');
      const rating = review.rating;
      const port = {
        moves: [...review.moves].map(moveOf),
        draft: [...review.draft].map(moveOf),
        total: review.total,
        complete: review.complete,
        positions: z.encode(z.array(z.nullable(StoredRecordCodec)), [...review.positions]),
        accuracy: byLegacyKeys(review.accuracy, short),
        counts: byLegacyKeys(review.counts, short),
        rating:
          rating &&
          Object.fromEntries(
            Object.entries(rating).map(([color, player]) => [
              short(color),
              player && {
                elo: player.elo,
                phases: byLegacyKeys(player.phases, key => PHASE_KEYS[key] ?? key),
              },
            ]),
          ),
        progress,
        version,
        revealed: [...revealed],
      };
      // Holes and undefined as JSON has them, as the recording does.
      expect(JSON.parse(JSON.stringify(port))).toEqual(nearly(expected));
    },
  );
});

describe('nextJob', () => {
  it.each(UNIT_CASES.jobs.map((job, i) => [i, job, legacy.jobs[i]]))(
    'picks job %i as the original did',
    (_, job, expected) => {
      const { fixture, ctrl, facade } = fakeGame(job.game);
      ctrl.jumpToMain(job.ply);
      const session = newSession();
      session.work.nodes = facade.mainline;
      for (const i of job.deep) session.work.deep[i] = fixture.records[i];
      for (const i of job.rough) session.work.rough[i] = fixture.records[i];
      session.work.cloudAt = job.cloudAt ?? Infinity;
      const found = nextJob({ work: session.work, mode: job.mode, analysis: facade });
      expect(found && [found.index, found.deep]).toEqual(expected);
    },
  );
});

describe('the game’s export', () => {
  it('reads the opening and the server analysis, White’s view', () => {
    const text = JSON.stringify({
      opening: { ply: 7, name: 'Italian Game' },
      analysis: [{ eval: 30 }, { mate: 2 }, { mate: -1 }, {}, { eval: -500 }],
    });
    const found = readExport(text, 5);
    expect(found?.bookPly).toBe(7);
    expect(found?.openingName).toBe('Italian Game');
    expect(found?.rough[1]).toMatchObject({ cp: 30, secondLineWinChance: null, best: null });
    const noLine = { secondLineWinChance: null, best: null };
    expect(found?.rough[2]).toEqual({ mate: 2, whiteWinChance: 100, ...noLine });
    expect(found?.rough[3]).toEqual({ mate: -1, whiteWinChance: 0, ...noLine });
    expect(found?.rough[4]).toBeUndefined();
    // Past the game's last position.
    expect(found?.rough[5]).toBeUndefined();
  });

  it('reads what it can of an odd one, and nothing of an error page', () => {
    expect(readExport('{"opening":{"ply":"3"},"analysis":7}', 10)).toEqual({
      bookPly: 0,
      openingName: '',
      rough: [],
    });
    expect(readExport('<!doctype html>', 10)).toBeNull();
  });
});

describe('seedBooks', () => {
  it('marks the game’s book moves for the moves played off it, the last one named', () => {
    const { fixture, facade } = fakeGame('opera');
    const session = newSession();
    session.work.bookPly = 2;
    session.view.openingName = 'Open Game';
    seedBooks(session, facade);
    const fen = (i: number): string => fixture.nodes[i]?.fen ?? '';
    expect(session.live.books.get(fen(1))).toEqual({ book: true, name: '', eco: '' });
    expect(session.live.books.get(fen(2))).toEqual({ book: true, name: 'Open Game', eco: '' });
    expect(session.live.books.get(fen(3))).toEqual({ book: false, name: '', eco: '' });
    expect(session.live.books.has(fen(0))).toBe(false);
  });
});

describe('the cache', () => {
  it('keeps a finished game’s records under the original’s key and format, and reads back only a whole game', () => {
    const records = [
      { cp: 20, whiteWinChance: 51.8, secondLineWinChance: 50, best: 'e2e4' },
      { mate: -2, whiteWinChance: 0, secondLineWinChance: null, best: null },
    ];
    cacheRecords('abcdefgh', 2, records);
    expect(localStorage.getItem('cdc-review:abcdefgh:2:v1')).toBe(
      '[{"cp":20,"wp":51.8,"wp2":50,"best":"e2e4"},{"mate":-2,"wp":0,"wp2":null,"best":null}]',
    );
    expect(readCachedRecords('abcdefgh', 2)).toEqual(records);
    expect(readCachedRecords('abcdefgh', 3)).toBeNull();
    localStorage.setItem('cdc-review:abcdefgh:3:v1', '[1,2,3]');
    expect(readCachedRecords('abcdefgh', 3)).toBeNull();
  });
});

describe('the cloud', () => {
  it('takes the opening’s positions it knows, and stops after three misses', async () => {
    const { fixture, facade } = fakeGame('opera');
    const session = newSession();
    session.work.nodes = facade.mainline;
    const known = new Set([0, 1, 3].map(i => fixture.nodes[i]?.fen ?? ''));
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<(url: string) => Promise<Response>>(async url => {
        const fen = decodeURIComponent(/fen=([^&]+)/.exec(url)?.[1] ?? '');
        asked.push(fen);
        return known.has(fen)
          ? Response.json({ pvs: [{ moves: 'e1h1 e8g8', cp: 12 }] })
          : new Response('', { status: 404 });
      }),
    );
    await lookUpCloud(session, facade);
    expect(asked).toHaveLength(7);
    expect(session.work.deep.flatMap((record, i) => (record ? [i] : []))).toEqual([0, 1, 3]);
    // White's view, castling in the engine's notation.
    expect(session.work.deep[1]).toMatchObject({ cp: 12, best: 'e1g1' });
    expect(session.work.cloudAt).toBe(Infinity);
  });

  it('ends at a refusal', async () => {
    const { facade } = fakeGame('opera');
    const session = newSession();
    session.work.nodes = facade.mainline;
    const fetch = vi.fn<() => Promise<Response>>(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    await lookUpCloud(session, facade);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
