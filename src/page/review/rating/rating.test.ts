import { z } from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { fixtureGames, replay } from '#page/review/fixtures/replay.ts';
import { nearly } from '#shared/testing/numbers.ts';
import { ratingModel, type Speed } from './model.ts';
import { bandOdds, posteriorMean, RATING_GRID } from './odds.ts';
import { divide } from './phases.ts';
import { type GameRating, rateGame } from './rate-game.ts';
import { isTactical } from './tactical.ts';
// What the original script computed on the fixture games.
import legacy from './fixtures/legacy.json' with { type: 'json' };
import legacyRatings from './fixtures/legacy-rate-game.json' with { type: 'json' };

const games = fixtureGames();
const fensOf = (index: number): string[] => games[index]?.nodes.map(node => node.fen) ?? [];

describe('divide', () => {
  it('finds the phases the original found, on whole games and slices of them', () => {
    for (const [game, from, to, division] of legacy.divisions) {
      expect(divide(fensOf(Number(game)).slice(Number(from), Number(to)))).toEqual(division);
    }
  });

  it('has no middlegame that starts after the endgame', () => {
    const endgame = '8/8/4k3/8/8/2K5/8/8 w - - 0 60';
    expect(divide([endgame])).toEqual({ middle: -1, end: 0 });
    expect(divide([])).toEqual({ middle: -1, end: -1 });
  });
});

describe('isTactical', () => {
  it('sees the tactics the original saw', () => {
    const expected = [...legacy.tactical];
    for (const [index, game] of games.entries()) {
      for (const [i, node] of game.nodes.entries()) {
        if ((i + index) % 3 !== 0) continue;
        for (const loss of [0, 9.99, 10]) expect(isTactical(node.fen, loss)).toBe(expected.shift());
      }
    }
    expect(expected).toHaveLength(0);
  });

  it('counts a check, and a hanging piece', () => {
    expect(isTactical('4k3/8/8/8/8/8/8/4R1K1 b - - 0 1', 0)).toBe(true);
    expect(isTactical('4k3/8/8/3n4/8/2P5/8/6K1 w - - 0 1', 0)).toBe(false);
    expect(isTactical('4k3/8/8/3n4/2P5/8/8/6K1 w - - 0 1', 0)).toBe(true);
  });
});

describe('the odds', () => {
  it('match the original’s, per speed', () => {
    const speeds: readonly Speed[] = ['bullet', 'blitz', 'rapid', 'classical'];
    for (const speed of speeds) {
      const odds = bandOdds(speed);
      for (const [context, grid, band, value] of legacy.odds[speed]) {
        expect(odds[Number(context)]?.[Number(grid)]?.[Number(band)]).toEqual(nearly(value));
      }
    }
  });

  it('compute the original’s posterior means', () => {
    for (const [mean, deviation, expected] of legacy.posteriors) {
      const likelihood = RATING_GRID.map(
        (_, i) => -0.00001 * (i - 150) ** 2 * (Number(mean) / 1000) - (i % 7) * 0.01,
      );
      expect(posteriorMean(likelihood, Number(mean), Number(deviation))).toEqual(nearly(expected));
    }
  });

  it('read a well-formed model', () => {
    expect(ratingModel().theta.blitz).toHaveLength(12);
    expect(RATING_GRID).toHaveLength(311);
    expect(RATING_GRID.at(-1)).toBe(3200);
  });
});

const PhaseVerdictSchema = z.nullable(
  z.enum(['book', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder']),
);
const LegacyRatingSchema = z.nullable(
  z.object({
    elo: z.number(),
    phases: z.object({
      o: PhaseVerdictSchema,
      t: PhaseVerdictSchema,
      s: PhaseVerdictSchema,
      e: PhaseVerdictSchema,
    }),
  }),
);
const LegacyRatingsSchema = z.array(
  z.object({
    game: z.number(),
    speed: z.nullable(z.string()),
    white: z.nullable(z.number()),
    black: z.nullable(z.number()),
    rating: z.object({ w: LegacyRatingSchema, b: LegacyRatingSchema }),
  }),
);

function fromLegacy(rating: z.infer<typeof LegacyRatingSchema>): GameRating['white'] | null {
  if (!rating) return null;
  const { o, t, s, e } = rating.phases;
  return { elo: rating.elo, phases: { opening: o, tactics: t, strategy: s, endgame: e } };
}

describe('rateGame', () => {
  it('rates each player as the original did', () => {
    for (const { game, speed, white, black, rating } of LegacyRatingsSchema.parse(legacyRatings)) {
      const fixture = games[game];
      if (!fixture) throw new Error(`no game ${game}`);
      const ratings = {
        ...(white === null ? {} : { white }),
        ...(black === null ? {} : { black }),
      };
      const result = rateGame({
        speed: speed ?? undefined,
        fens: fensOf(game),
        moves: replay(fixture),
        ratings,
      });
      expect(result).toEqual({ white: fromLegacy(rating.w), black: fromLegacy(rating.b) });
    }
  });

  it('has nothing to say about a player without a move', () => {
    expect(rateGame({ speed: 'blitz', fens: [], moves: [], ratings: {} })).toEqual({
      white: null,
      black: null,
    });
  });
});
