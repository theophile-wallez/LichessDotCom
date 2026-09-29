import { expect, test } from './fixtures.ts';
import { clickMove, clickSquare } from './support/board.ts';
import { computedStyle, openLichess } from './support/lichess.ts';

// The dots and rings that show where a picked piece can go. Chessground puts
// every class of a square on one element, so a hint on a highlighted square
// must draw over the highlight, not give way to it.

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test('a capture on the last move’s square shows its ring over the highlight', async ({ page }) => {
  await openLichess(page, '/analysis');
  await clickMove(page, 'e2', 'e4');
  await clickMove(page, 'd7', 'd5');
  // The pawn on e4 can take on d5.
  await clickSquare(page, 'e4');

  const capture = page.locator('main .main-board cg-board square.last-move.move-dest.oc');
  await expect(capture).toHaveCount(1);
  expect(await computedStyle(capture, 'background-image')).toContain('radial-gradient');
  expect(await computedStyle(capture, 'background-color')).not.toBe(TRANSPARENT);
});
