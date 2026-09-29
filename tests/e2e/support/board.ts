import type { Locator, Page } from '@playwright/test';
import { boxOf, type Box } from './layout.ts';

// The main board, as the user sees it: squares by name, whichever side is at
// the bottom.

export type Orientation = 'white' | 'black';

const FILES = 'abcdefgh';

/** The middle of `square` on a board drawn in `board`, seen from `orientation`. */
export function squareCenter(
  board: Box,
  square: string,
  orientation: Orientation,
): { x: number; y: number } {
  const file = FILES.indexOf(square.charAt(0));
  const rank = Number(square.charAt(1)) - 1;
  if (file < 0 || rank < 0 || rank > 7) throw new Error(`no such square: ${square}`);
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  const size = (board.right - board.left) / 8;
  return { x: board.left + (column + 0.5) * size, y: board.top + (row + 0.5) * size };
}

/** Chessground's board wrapper, which says which side is at the bottom. */
export const boardWrap = (page: Page): Locator => page.locator('main .main-board .cg-wrap').first();

export async function orientationOf(page: Page): Promise<Orientation> {
  const classes = (await boardWrap(page).getAttribute('class')) ?? '';
  return classes.includes('orientation-black') ? 'black' : 'white';
}

/** Clicks a square of the main board: picks the piece on it, or moves the picked one there. */
export async function clickSquare(page: Page, square: string): Promise<void> {
  const board = await boxOf(page.locator('main .main-board cg-board').first());
  const { x, y } = squareCenter(board, square, await orientationOf(page));
  await page.mouse.click(x, y);
}

/** Plays a move by clicking its two squares, as a user can instead of dragging. */
export async function clickMove(page: Page, from: string, to: string): Promise<void> {
  await clickSquare(page, from);
  await clickSquare(page, to);
}
