# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

## Goal

LichessDotCom is a Chrome extension (Manifest V3) that gives lichess.org a
**modern, Chess.com-style experience**. Lichess keeps its features: free
analysis, open data, no ads. The user gets the polished Chess.com UI they're
used to:

- Chess.com's look: dark palette, green board, Neo pieces, bold 3D buttons,
  a fixed left sidebar and roomy player bars with avatars and clocks.
- Chess.com's layout: board on the left, one right-hand panel with moves,
  controls and chat, and a page that **never scrolls**. Everything fits the
  viewport, like a native app.
- Chess.com's feel: its move sounds, and a Game Review ("Bilan") with an eval
  graph, accuracy, move classifications, a coach bubble, board badges and an
  eval bar.

When in doubt, compare against Chess.com screenshots and match them. The bar
is "a Chess.com user wouldn't notice they're on Lichess".

## Principles

- **Never move Lichess's DOM nodes.** Lichess renders with snabbdom (a virtual
  DOM); moving its nodes breaks updates. Re-arrange with CSS instead: make
  containers `display: contents` and place their children in one grid.
  Adding our own elements (prefixed `cdc-`) next to Lichess's is fine.
- **CSS first, JS only when needed.** JS is for things CSS can't do:
  sounds, measuring sizes, captured pieces, the Game Review.
- **Don't bundle Chess.com assets.** Pieces and avatars load from Chess.com's
  CDN at runtime, and sounds are fetched by the background worker on first use.
  The repo stays free of their artwork and audio.
- **Use Lichess's own capabilities** rather than reinventing them. For
  example, the Game Review runs the Stockfish 19 build Lichess already serves,
  and navigates through Lichess's analysis controller (`site.analysis`).
- **Work in every language.** Lichess localizes text *and* some URLs
  (`/fr/training`), so never match on text or exact hrefs. Match on structure
  (`:nth-of-type`), classes, or how an href ends (`a[href$='/training']`).
- **Desktop first.** The Chess.com layout applies at ≥ 1020px. Below that,
  Lichess's mobile layout is kept, with our theme, board and pieces.

## Layout of the repo

| Path | What it does |
| --- | --- |
| `manifest.json` | Content scripts: CSS + `content.js` (isolated world), `page.js` + `board.js` + `review.js` (page world). |
| `src/background.js` | Service worker: downloads the Chess.com sounds, caches them as base64. |
| `src/content.js` | Isolated world: forwards sounds to the page, measures sizes for the grids, builds captured pieces, the home hero and the font remapping. |
| `src/page.js` | Page world: wraps `site.sound` to play the right Chess.com sound per move. |
| `src/board.js` | Page world: analysis arrows redrawn Chess.com-style, checkmate badge and label. |
| `src/review.js` | Page world: Game Review (engine, classification, panel, board overlays, eval bar). |
| `src/styles/theme.css` | Overrides Lichess's `--c-*` color variables, fonts, buttons. |
| `src/styles/sidebar.css` | Lichess's top header → Chess.com's left sidebar. |
| `src/styles/board.css` | Board, pieces, highlights, move hints, arrows, coordinates. |
| `src/styles/game.css` | Game page (`main.round`) grid, player bars, clocks, moves, chat. |
| `src/styles/analysis.css` | Analysis page (`main.analyse`) grid. |
| `src/styles/review.css` | Game Review panel, eval bar, board annotations. |
| `src/styles/pages.css` | Modern look for every other page (headings, side menus, tabs, tables, forms, dialogs, lobby, editor, tournaments). |
| `src/styles/home.css` | Home page (`main.lobby`) as a 12-column card dashboard; the hero is added by `content.js`. |

There is no build step and no dependencies: plain JS and CSS, loaded unpacked.

## Conventions

- Prefix our classes, ids, CSS variables and `localStorage` keys with `cdc`
  (`.cdc-captured`, `--cdc-board`, `cdc-review:<id>`). Chess.com colors live in
  `--cdc-*` variables in `theme.css`; reuse them instead of hard-coding.
- Content-script CSS **loses ties** with Lichess's CSS, so most overrides need
  `!important`. Scope rules tightly (`main.round …`, `main.analyse …`) so they
  don't leak to other pages.
- Match the surrounding style: short comments that explain *why*, sections
  separated by `/* ---- name --- */` banners, 2-space indentation.
- Keep the page non-scrolling. If you add something to the game or analysis
  layout, it must fit inside the grid; don't add rows below the board.

## Lichess pitfalls (learned the hard way)

- **Obfuscated tags.** The game move list uses scrambled tag names that change
  between Lichess releases (currently `i5d`, `aPp`, `qZM`, `Z7yx`, `bo3`,
  active class `a1t`). `game.css` lists old and new names with `:is()`. If the
  move list loses its styling, find the new names in Lichess's round bundle.
- **Board inset.** Chessground shrinks the board to whole pixels per square,
  so `cg-container` sits a few px inside its wrapper. `content.js` measures it
  into `--cdc-inset-{t,r,b,l}`; use those to align anything with the squares.
- **Definite grid rows.** The right panel stacks items in fixed rows beside
  the board, so every row height must be known: controls height is measured
  into `--cdc-controls-h`. Lichess also sets an inline `height` on the analysis
  chat, which must be overridden.
- **CSP.** Images may load from anywhere (`img-src *`). Audio and `fetch` may
  only reach Lichess's domains plus `blob:` and `data:`. Cross-origin data
  must come from the background worker.
- **Thin fonts.** Lichess sets weight 300 on Roboto / Noto Sans everywhere.
  `content.js` appends `@font-face` rules re-pointing those families (and
  `CDC Sans`) at the system UI font. They must come *after* Lichess's faces,
  which is why they're not in the manifest CSS.
- **Icons.** Sidebar icons are Chess.com's own
  (`https://assets-ds.chess.com/color-icons/<name>.svg`). The names come from
  the nav data embedded in chess.com pages (`"icon":{"name":…}`).
- **Two worlds.** `content.js` can't see page JS objects (`site`, chessground's
  `cgKey` expandos); `page.js`, `board.js` and `review.js` can. Communicate with
  `window.postMessage`.
- **3D buttons in groups.** Every `.button` gets Chess.com's 4px bottom
  edge. Where Lichess glues a button to an input (`.copy-me`, search forms)
  or stacks buttons flush (editor actions), that edge overlaps its
  neighbour: flatten it or add a gap.
- **Useful page APIs.** `site.sound` is Lichess's sound player, and
  `site.analysis` is the analysis controller (`mainline`, `node.ply`,
  `jumpToMain`, `getOrientation`; `jumpToMain` doesn't scroll the move list),
  and `site.analysis.chessground.state.drawable` holds the arrows (`shapes`,
  `autoShapes`, `current`). Game data is in
  `<script id="page-init-data">`, and the engine is at
  `npm/stockfish-web/sf_19_smallnet.js`.

## Testing

Branded Chrome ignores `--load-extension`, so changes are verified by driving
a headless Chrome over the DevTools protocol. The CSS is injected (prepended,
so Lichess still wins ties, as it does with a real content script) and the
page-world scripts are evaluated, then screenshots and measurements are taken
on live pages:

- a game: pick one from `https://lichess.org/api/tv/channels`
- analysis: a finished game, e.g. `https://lichess.org/tKlG0mrQ/black`
- the home page, in several languages (`Accept-Language` fr/en/de)

Check at 1366×640, 1600×900 and 1920×1080: nothing overflows, the page doesn't
scroll, and bars and the eval bar line up with the board. Chess.com's CDN
rejects the `HeadlessChrome` user agent, so override it to a normal Chrome UA
for every request, or images will look broken when they aren't.
Headless Chrome also reports `prefers-reduced-motion: reduce`, which makes
Lichess turn animations off; emulate `no-preference` to check animations.

Before committing, syntax-check every JS file (e.g. `new Function(src)` in the
browser) and parse `manifest.json`. Finally, load the extension unpacked in
`chrome://extensions`.

## Shipping

When you consider the work done, ship it. Don't wait to be asked, and don't
open a PR:

1. Commit, merge `origin/main` in, and push to `main` (`git push origin
   HEAD:main`, a fast-forward).
2. Pull `main` into the main checkout, which is where Chrome loads the unpacked
   extension. Otherwise the user keeps testing the old code.
3. Clean the worktree: remove any `node_modules` and other throwaway files
   (test scripts, screenshots, browser profiles) you created.
4. Finish with a short summary of what was done, and remind the user to reload
   the extension in `chrome://extensions`.
