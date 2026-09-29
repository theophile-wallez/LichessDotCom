# AGENTS.md

Instructions for AI coding agents (and humans) working on LichessDotCom. Read
this file whole before changing anything. The code's design is detailed in
[docs/architecture.md](docs/architecture.md), the Game Review's in
[src/page/review/README.md](src/page/review/README.md).

## The project in brief

- A browser extension (Manifest V3, Chrome and Firefox) that gives
  lichess.org Chess.com's look and feel, plus a Game Review with a coach.
- TypeScript 7, bundled by rolldown (`scripts/build.ts`) into
  `dist/<target>/`. The browser loads the build, never `src/`.
- Two scripts run in each Lichess tab, in two JavaScript worlds that share
  only the DOM and `window.postMessage`: `src/content` (isolated world: the
  extension's APIs and files) and `src/page` (page world: Lichess's own
  objects). `src/shared` serves both and never touches `chrome.*`.
  `src/background` is the service worker. `src/styles` is joined into
  `content.css`.

## The quality bar

This codebase is held to professional standards: every change must read as
if a senior engineer wrote it for code review. It was rewritten once already
because a contributor called it AI-generated and unclean. Don't let it slide
back. `pnpm check` enforces much of what follows; the rest is on you.

**Types**

- Strict TypeScript. Never `any`, never a type assertion (`as`, `<T>x`, `!`,
  `as const`), never `@ts-ignore` or a lint-disable comment.
- Every piece of data from outside (JSON, fetch responses, `postMessage`,
  storage, `#page-init-data`, Lichess's globals) is validated with a
  zod/mini schema (`import { z } from 'zod/mini'`), and its type is
  `z.infer` of that schema, not written by hand.
- Lichess's live objects keep their identity: narrow them with
  `createGuard(schema)` (`#shared/guards.ts`), not a parse, which copies.
- DOM lookups narrow with `instanceof` through `queryOne`, `queryAll` and
  `closestTo` (`#shared/dom.ts`).

**Structure**

- One concern per module. Pure logic (parsing, geometry, text, rules) lives
  apart from the code that touches the DOM, so it can be tested alone.
- A feature is a folder under `src/content/` or `src/page/` whose module
  exports a `Feature`, listed in the world's `index.ts` in start order.
  Content features that follow the page register with `onEveryTick`
  (`#content/sync-loop.ts`).
- Code used by more than one feature goes in `src/shared/`; look there
  before writing a helper. Test-only helpers go in `src/shared/testing/`.
- Imports across folders use the `#` aliases of `package.json`'s `imports`
  (`#shared/…`, `#content/…`, `#page/…`, `#background/…`, `#scripts/…`,
  `#manifest`), never `../`. `./` is for the same folder or a folder below
  it. Keep the `.ts` extension.
- At most 250 lines of code per file and 60 per function, 4 parameters (use
  an options object), complexity 15, no nested ternaries. Split by what the
  code does, not to dodge the limit.

**Names and comments**

- Names say what things are: `square`, `whiteShare`, `moveTimes`, never
  `sq`, `ws`, `mt`. One letter only for loop indexes (`i`, `j`, `k`),
  coordinates (`x`, `y`) and type parameters.
- Comments are short and plain, and say why: a Lichess quirk, a browser
  pitfall, a constraint that isn't visible in the code. One or two lines is
  the norm. Never narrate what the code does, never write essays, and never
  use an odd, flowery or "AI" voice. A module may open with a few lines on
  what it's for.

**DOM, performance and security**

- Never move or remove Lichess's DOM nodes (snabbdom breaks). Add our own,
  prefixed `cdc`, and rearrange with CSS.
- The content script runs on every page and its tasks every 250 ms: a task
  must cost next to nothing when nothing changed. Write only what changes
  (`setData`, `setStyleProperty`, `classList.toggle(name, force)`), and
  avoid layout reads in hot paths. No endless `requestAnimationFrame` or
  animation loops, no `:has()` in hot places (see the pitfalls).
- Markup built as text goes through the escaping `html` template
  (`#shared/html.ts`); `trustedHtml` is for constants only. A message
  handler checks `event.source === window` and validates with a schema
  (`#shared/protocol.ts` does both).
- Everything of ours is prefixed `cdc`: classes, ids, data attributes, CSS
  variables, storage keys (listed in `StorageKey` / `SessionKey`).

**Tests**

- Every change ships with tests. Unit tests sit next to the code
  (`name.test.ts`, vitest in happy-dom): logic through its exports, DOM
  features by building the markup Lichess serves and checking what we add.
  User-visible flows get an end-to-end test in `tests/e2e`.
- See each new test fail once before trusting it: a test that can't fail is
  not a test. Assert on real outputs, not on a mock's own answers.
- `fixtures/legacy*.json` are outputs recorded from the original code. They
  are the reference for behavior: never regenerate them from the new code.
  If a change must alter one, it's a deliberate behavior change: say so in
  the commit. Compare their fractions through `nearly`
  (`#shared/testing/numbers.ts`): `Math.exp` and `Math.log` differ in the
  last bit between macOS and Linux.
- No fixed real-time sleeps in tests: wait for the thing you need.

**Docs**

- When you change what `AGENTS.md`, `docs/architecture.md`, a README or a
  comment describes, update it in the same change.

## Definition of done

A change is done when all of these hold:

- [ ] `pnpm check` passes: types, lint, formatting, source rules, unit tests.
- [ ] New or changed behavior is covered by tests you've seen fail without
      the change.
- [ ] User-visible changes are checked live on lichess.org with the built
      extension (`pnpm build`, then Playwright): at the viewports under
      [Testing on lichess.org](#testing-on-lichessorg), with screenshots
      looked at, and `pnpm test:e2e` passes.
- [ ] Docs match the code. No throwaway files are left in the repo.
- [ ] It's shipped (see [Shipping](#shipping)).

## Commands

| Command                         | What it does                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm install`                  | installs the dependencies (Node 24 first, and `corepack enable` for pnpm)        |
| `pnpm build`                    | builds `dist/chrome` with source maps (`--target firefox`, `--release`, `--out`) |
| `pnpm dev`                      | the same, rebuilt on every change                                                |
| `pnpm check`                    | typecheck, lint, format check, source rules, unit tests                          |
| `pnpm test` / `pnpm test:watch` | unit tests                                                                       |
| `pnpm test:e2e`                 | end-to-end tests on lichess.org (build first)                                    |
| `pnpm test:e2e:fast`            | the same, without the `@slow` ones (the engine's)                                |
| `pnpm test:firefox`             | Firefox smoke test of `dist/firefox` (after `pnpm build --target firefox`)       |
| `pnpm lint:fix` / `pnpm format` | fix what oxlint and oxfmt can                                                    |
| `pnpm package`                  | release zips of every target into `dist/`, plus the sources zip                  |
| `pnpm store:render`             | renders the store images from `store/templates`                                  |

## Where things go

| Path              | What it holds                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/manifest.ts` | the manifest of each target, and `BASE_VERSION`                                                                                                                                                                                                                                                                                                   |
| `src/content/`    | the isolated-world script: `boards` (board and piece picker), `bootstrap`, `layout` (`MARKS`, `HAS`, inset, zoom, controls height), `game`, `analysis`, `pages`, `ui` (tooltips, hover card, tab bars), `sounds`, `charts`, `coach` (the coach's face), `dev` (auto-reload), `platform` (the extension APIs it uses), `sidebar` (the Donate item) |
| `src/page/`       | the page-world script: `motion`, `sounds`, `board` (shapes, checkmate), `review`, `charts`, and `lichess/`, typed facades over Lichess's globals                                                                                                                                                                                                  |
| `src/shared/`     | helpers for both worlds (DOM, markup, messages, storage, chess, charts), `testing/` for tests                                                                                                                                                                                                                                                     |
| `src/background/` | the service worker: auto-reload, old cache cleanup                                                                                                                                                                                                                                                                                                |
| `src/styles/`     | one stylesheet per page or part, a folder of partials past 400 lines, joined in `index.css`'s order                                                                                                                                                                                                                                               |
| `public/`         | copied into each build: `_locales/`, `icons/`, `img/` (`boards`, `pieces`, `icons`, `coaches`), `sounds/`                                                                                                                                                                                                                                         |
| `scripts/`        | build, package, typecheck, source rules, version, store publishing and rendering                                                                                                                                                                                                                                                                  |
| `tests/e2e/`      | Playwright tests on lichess.org                                                                                                                                                                                                                                                                                                                   |
| `tools/`          | Python generators, run by hand: `boards/fetch.py`, `assets/fetch.py`, `coach-rig/extract.py`, `game-rating/`                                                                                                                                                                                                                                      |
| `store/`          | the store images and their HTML templates                                                                                                                                                                                                                                                                                                         |
| `.github/`        | CI (`ci.yml`), releases and store submissions (`release.yml`), Dependabot                                                                                                                                                                                                                                                                         |

**Recipes**

- _A content feature:_ a folder in `src/content/`, a module exporting a
  `Feature`, an entry in `src/content/index.ts` at the right place in the
  start order, tests beside it.
- _A page feature:_ the same in `src/page/`. Read Lichess's objects through
  `src/page/lichess/` (add to its facades rather than reading `window` ad
  hoc).
- _Data between the worlds:_ a schema and a pair of post / listen functions
  in `src/shared/protocol.ts`.
- _A stylesheet:_ a file in `src/styles/`, imported from `index.css` at its
  place in the cascade.
- _A storage key:_ in `StorageKey` or `SessionKey` (`src/shared/storage.ts`).
- _A tab bar that slides:_ an entry in `TAB_BARS`
  (`src/content/ui/tab-bars.ts`), then its look in CSS (see "Tabs slide").
- _An image or a sound:_ never a remote URL. Boards and piece sets go in
  `src/content/boards/catalog.json`, then `tools/boards/fetch.py`; icons are
  named in the CSS (`img/icons/<name>.svg`) and sounds in
  `src/shared/sounds.ts`, then `tools/assets/fetch.py`.
- _A chart:_ redrawn in SVG from the page's data, in the rating chart's look
  (see "Every chart is modern"), with `src/shared/charts/`.

## Product rules

The goal is a **modern Lichess, modelled on Chess.com**: a user of that site
wouldn't notice they're on Lichess. When in doubt, compare with Chess.com and
match it. Lichess keeps its features: free analysis, open data, no ads.

- **The look:** dark palette, green board, Neo pieces, bold gradient
  buttons, a fixed left sidebar, roomy player bars with avatars and clocks.
- **The layout:** board on the left, one right-hand panel (moves, controls,
  chat), and a page that never scrolls: everything fits the viewport, like a
  native app. Add nothing below the board.
- **The feel:** its move sounds, and a Game Review ("Bilan") with an eval
  graph, accuracy, move classes, a coach bubble, board badges and an eval
  bar.
- **CSS first**, JS only for what CSS can't do (sounds, measuring, captured
  pieces, the review).
- **Every asset is bundled**: no host permission, nothing loaded from
  another site at run time (Lichess's own assets aside).
- **Use Lichess's own capabilities** (its Stockfish build, its analysis
  controller) rather than reinventing them.
- **Every language:** Lichess localizes text and some URLs (`/fr/training`).
  Never match on text or exact hrefs: match on structure, classes, or how an
  href ends (`a[href$='/training']`).
- **Desktop first:** our layout from 1020px; below, Lichess's mobile layout
  with our theme, board and pieces.
- **Playful pages:** a color per section, icons on gradient tiles, cards,
  pills, illustrations (Neo pieces, Lichess's 3D emoji, little boards).
  Practice, simuls and the forum set the tone. Every side menu (`.subnav`)
  gets an icon per link on a tile in its own color: add the menu to the
  shared rule in `styles/pages/headings-menus.css`, then set
  `--cdc-nav-icon` and `--cdc-nav-color` per link.
- **Cards stay dark:** never fill a card's background with green or red;
  color a badge, a tile or the title instead (buttons aside).
- **Hover feels the same everywhere:** a card lifts and its icon tile hops,
  `rotate(-6deg) scale(1.08)` on cards, `translateY(-2px) rotate(-8deg)
scale(1.08)` on menu links, both
  `transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)`.
- **Tabs slide:** a tab bar's highlight is one piece that slides to the tab
  picked (`0.35s cubic-bezier(0.22, 1, 0.36, 1)`). Register the bar in
  `TAB_BARS`; its CSS gives the piece the active tab's look (`--cdc-tab-bg`,
  `-shadow`, `-radius`, `-line`) and takes that look off the active tab
  under `[data-cdc-tabs]` (`styles/theme/tooltips-and-tabs.css`).
- **Motion is never reduced:** never write a `prefers-reduced-motion` query.
  `src/page/motion` makes every such query answer as if nothing were asked.
- **Only the content scrolls:** a page's side panel and title stay put while
  its content scrolls (`position: sticky`, as in `styles/simul`, or a
  scrolling content area).
- **Every chart is modern:** Lichess's Chart.js canvases are redrawn in SVG
  from the page's data (`content/charts/rating-chart`,
  `page/charts/distribution`, `content/charts/radar`): smooth curves or
  rounded columns over a gradient in the series' color (the same color for
  the same rating everywhere), a faint dashed grid, chips as the legend, a
  frosted tooltip, an entrance animation, labels from `i18n.site`, numbers
  from `Intl`. Hide Lichess's canvas only once ours is in.

## Lichess pitfalls

Learned the hard way. Check here before touching the area concerned.

- **Obfuscated tags.** The game move list's tag names change between Lichess
  releases (now `i5d`, `aPp`, `qZM`, `Z7yx`, `bo3`, active class `a1t`):
  `styles/game/move-list.css` lists old and new ones in `:is()`. If the move
  list loses its style, find the new names in Lichess's round bundle.
- **Coordinates.** Lichess swaps `body.coords-out` for `coords-in` while its
  eval gauge shows (`forceInnerCoords`). On desktop
  `styles/board/coordinates.css` draws both outside, sized by
  `--cdc-coords-size`; a layout leaves them room under
  `body:is(.coords-in, .coords-out)` (a gutter for the ranks,
  `--cdc-coords-off` for the files). Below 1020px they stay where Lichess
  puts them.
- **Board inset.** Chessground shrinks the board to whole pixels per square,
  so `cg-container` sits a few px inside its wrapper:
  `content/layout/board-inset.ts` measures it into `--cdc-inset-{t,r,b,l}`.
  Align anything with the squares through those.
- **Definite grid rows.** The right panel's rows need known heights: the
  controls' is measured into `--cdc-controls-h`. Lichess sets an inline
  `height` on the analysis chat: override it.
- **CSP.** Images load from anywhere; audio and `fetch` only from Lichess's
  domains, `blob:` and `data:`, not even the extension's files. So
  `content/sounds` reads the sounds and `page/sounds` plays them as `blob:`
  URLs. Cross-origin data would need the background worker and a host
  permission.
- **Thin fonts.** Lichess sets weight 300 on Roboto / Noto Sans.
  `content/bootstrap/fonts.ts` appends `@font-face` rules pointing them (and
  `CDC Sans`) at the system font; they must come after Lichess's, hence not
  in the manifest CSS.
- **Icons.** The sidebar's icons are Chess.com's, named after its nav data
  (`"icon":{"name":…}`). Time-control icons are Lichess font glyphs in
  `[data-icon]::before` (`\e059` ultrabullet, `\e032` bullet, `\e008` blitz,
  `\e002` rapid, `\e00a` classical, `\e019` correspondence), masked with our
  icons in `styles/theme/game-modes.css`: set `--cdc-mode-color` on the
  `::before` to recolor one.
- **Practice lessons are analysis pages.** `/practice/…` is `main.analyse`
  with `.practice__side` and either `.gamebook` (a lesson) or
  `.practice-box` (a drill). "Practice with computer" adds `.practice-box`
  to any analysis board, so scope on `.practice__side`. A drill's goal sits
  in `.analyse__underboard`, which our layout hides. Panel rows need a
  definite height: `1fr` in a content-sized container just grows.
- **Game over.** The end-of-game buttons are `.rcontrols > .follow-up`
  (rematch, new opponent, tournament, then the analysis link, always last).
  "New opponent" exists only for lobby and pool games; otherwise
  `content/game/new-game.ts` prepends its own `/?hook_like=<id>` button. The
  round data has no clock history: move times come from
  `/game/export/<id>?clocks=true`. In a scrolling grid, a track like
  `minmax(30px, auto)` never grows past its minimum: put the minimum on the
  items.
- **Two worlds.** `src/content` can't see page objects (`site`,
  chessground's `cgKey` expandos); `src/page` can, but can't call
  `chrome.runtime.getURL`. They talk through the messages of
  `src/shared/protocol.ts`. To show a bundled image from the page world,
  list it in `web_accessible_resources` and load it from CSS with
  `url('chrome-extension://__MSG_@@extension_id__/<path>')`, or read the
  base URL the content script puts in `data-cdc-assets` on `<html>`.
- **Buttons.** A gradient with a 1px top highlight, a 1px darker bottom edge
  and a soft shadow, not a 3D ledge: use
  `--cdc-btn-{green,grey,red}[-hover|-shadow]` (`styles/theme/base.css`).
  Where Lichess glues a button to an input or stacks buttons flush, drop the
  shadow or add a gap.
- **Scroll state.** Once scrolled, Lichess adds `.hide` to `#top`, hiding
  `#topnav` and the dropdowns with `visibility`, `opacity` and
  `pointer-events: none`. Our sidebar is fixed, so `styles/sidebar` restores
  all three; forget `pointer-events` and the sidebar is visible but dead.
- **JS-sized widgets.** The home blog carousel sizes its cards from its
  `clientWidth`, which counts padding: inset it with a transparent border,
  not padding.
- **lottie-web.** It rewrites the data it's given, so animations must share
  no objects (`content/coach/lottie` builds every object fresh; a test
  checks). After `playSegments`, `goToAndStop(frame, true)` counts from the
  segment's start: `resetSegments(true)` first. A segment stops a frame
  short of its end: land on the pose by hand. A lid can't blink by
  squashing its shut outline except fast; resting lids morph their outline,
  only the blink scales.
- **Firefox.** Its own build (`pnpm build --target firefox`) from the same
  sources. The CSS names bundled files as
  `chrome-extension://__MSG_@@extension_id__/…`, which the build rewrites:
  never build an extension URL another way. Firefox ignores
  `::-webkit-scrollbar`, and `scrollbar-color` would disable those rules in
  Chrome, so it's set for Firefox only (`@supports (-moz-appearance: none)`).
  Firefox injects the content scripts into open tabs on install or update,
  where an older copy's page script still runs:
  `content/bootstrap/late-reload.ts` reloads such a tab.
- **Page APIs.** `site.sound` is the sound player; `site.analysis` the
  analysis controller (`mainline`, `node`, `path`, `nodeList`,
  `tree.nodeAtPath`, `jumpToMain`, which doesn't scroll the move list,
  `getOrientation`), with the arrows in `chessground.state.drawable`; the
  engine is `npm/stockfish-web/sf_19_smallnet.js`. Only analysis pages have
  a controller: code that must also work on game pages reads the board's
  DOM (`page/board` does).
- **The cloud eval.** `/api/cloud-eval?fen=…&multiPv=2`: no account, one
  position per request, one request at a time; a 404 means nobody analyzed
  it (in a game: out of the opening). Scores are White's view, castling is
  king-takes-rook. The export's `evals=true` gives the server analysis when
  there is one: one line per position, no second best.
- **Mate distances.** Win probability can't grade a move between two mates,
  so the review reads mate distances, and our engine only gets short ones
  right (at depth 16, mate in 5 or fewer is exact; longer comes out longer).
  Trust a move's short side only (`SURE_MATE`, `page/review/judge/mate.ts`)
  and never print a long defense's length.
- **The free analysis board.** `/analysis` is `main.analyse` with
  `site.analysis.synthetic` set: no game to export, a tree that grows as the
  user plays. Each `move` in its list carries its tree path in `p`. Opening
  names come from `explorer.fetchMasterOpening(fen)`, a 401 when signed out.
- **Chessground's shapes.** `cg-container > svg.cg-shapes`, one `g` per
  shape (a circle for a marked square, a line for an arrow), in square units
  from the viewBox corner (`-4 -4 8 8`), orientation already applied. Arrow
  ends are pulled in from the centers: round back. The group's `cgHash` is
  `width,height,hilite,orig,dest,brush…`; `hilite` marks the shape being
  dragged. Engine arrows use a pale brush, so their `opacity` is below 1.
- **Hover cards.** Each kind has its own popup: the user card `#powerTip`
  (HTML from `/@/<user>/mini`), `#miniGame`, `#miniBoard`, `#hook`. The card
  is re-fetched and re-rendered on every hover and created on the first
  one: watch it with a `MutationObserver` on `childList`, never poll (a poll
  shows the raw markup first).
- **`#page-init-data`.** A page's module data is inlined there as JSON (the
  rating stats page also passes its chart data in
  `loadEsm('chart.ratingHistory', …)`), and Lichess removes the element once
  read. Capture the node while the page parses (`#shared/page-init-data.ts`);
  its text stays readable after removal.
- **Profiles.** Logged out, a profile's rating chart and activity feed are
  empty: to style them, inject plausible markup into
  `.angle-content .activity` and `#us_profile` (see lila's `ActivityUi.scala`
  and `PerfStatUi.ratingHistoryContainer`). The awards are
  `position: absolute` to escape `.user-show { overflow: hidden }`, with
  margins tuned for that. `bits.dropdownOverflow` counts how many action
  buttons fit from `.user-actions`'s `offsetWidth`: never change that
  element's flex sizing.
- **A transparent box still clips.** Lichess's `.box` (and `.lobby__side`…)
  have `overflow: hidden`: once transparent, the clip still cuts hover
  shadows and focus rings, and it traps `position: sticky`. Add
  `overflow: visible !important`, then check that a closed `.mselect__list`
  doesn't widen the page (anchor it with `inset-inline: auto 0`).
- **A page that must not scroll.** Lichess's hidden hover cards leave ~40px
  to scroll at the document's end, so a layout that fits still needs
  `html, body { overflow: hidden }` (as `styles/game` and
  `styles/swiss-show` do), each column scrolling in place. A sticky title
  can't leave its parent: to pin it over more, make the parent
  `display: contents`.
- **Boards sized to the window.** Lichess sizes some boards from the whole
  window's width, as if there were no sidebar (Storm, Racer, coordinates,
  Learn, puzzles): cap the board's column by what the sidebar leaves
  (`100vw - var(--cdc-sidebar-w)`, margins, side panel) and keep the ranks'
  gutter.
- **The board's resize handle.** `cg-resize` sets `---zoom` (0–100) on
  `body`, which Lichess turns into `---board-scale` and saves as a pref that
  may predate our layout. Ours ignores it: the board takes all its room
  until dragged, and `content/layout/board-zoom.ts` keeps the dragged size
  (`cdc-board-zoom`, `--cdc-zoom`). A layout that sizes its own board
  multiplies by `var(--cdc-board-scale, 1)`. Use `dvh`, not `vh`: on phones
  and headsets `100vh` is taller than the view.
- **Pinned titles.** Don't widen a sticky title with negative margins (it
  overflows at 1024px): use side box-shadows in the page's color.
- **The page's background.** Lichess draws some things behind the page with
  a negative z-index (clock faces): paint the page's color on `html`, never
  on `body` (`styles/theme/base.css`).
- **Lichess reduces motion.** Under `prefers-reduced-motion: reduce` its CSS
  kills every transition and animation (ours too), its header stops being
  sticky, and its scripts ask `matchMedia`. `page/motion` answers `reduce`
  as false and `no-preference` as true, and, as a script can't edit a
  cross-origin sheet, reloads each Lichess sheet with CORS, rewrites its
  reduced-motion rules and disables the original. Until the copy loads,
  Lichess's rule applies: keep our `transition`s `!important`.
- **Lichess's light theme.** Anonymous visitors on a light OS, and headless
  Chrome, get `html.light`. Our variables override its colors, but its
  `.light …` rules still apply here and there: check both themes.
- **800px exactly.** Lichess's phone menu applies up to `max-width: 800px`:
  start desktop rules at `800.02px`, not `800px`.
- **Variants.** Crazyhouse's pockets are grid areas `mat-top` / `mat-bot`
  that the game grid must place (`styles/game`). Three-check's checks are
  kings in `.material`, which our bars hide: `content/game/captured.ts`
  shows them. Racing Kings and Horde start with other pieces.
- **Zen mode** (`body.zenable.zen`) hides all but the board, clocks and
  controls; our `!important` layout rules must yield to it (`styles/game`).
- **TV.** `/tv` and `/tv/<channel>` don't carry the game's id: take it from
  the move list's analysis link.
- **A `main.analyse` without a board.** A broadcast's page is
  `main.analyse.is-relay.has-relay-tour`: the analysis layout must leave it
  alone (`styles/broadcast`).
- **Tab bars redrawn on click.** The profile's games filter, the home
  lobby's tabs and the explorer's databases are replaced whole when a tab is
  picked, so nothing can slide: they stay out of `TAB_BARS`. Before adding a
  snabbdom bar, check in lila that neither it nor a parent changes its
  selector with the tab.
- **Picker names.** lila puts a picker's name in its `mselect`'s id
  (`#…__day-select`), not its class.
- **`:has()` slows the board.** Chrome re-checks a `:has()` whenever an
  element is added or removed under its anchor, restyling all the rule
  could style: on a board, every move. Every stylesheet loads on every page,
  so everywhere:
  - no `:has()` on `html`, `body`, `#main-wrap` or `main`: read a word of
    `data-cdc-has` on `<html>` instead (`html[data-cdc-has~='round']`),
    kept by `HAS` in `content/layout/has-flags.ts`;
  - no attribute selector, `:not()` or `*` inside a `:has()`: have `MARKS`
    (`content/layout/marks.ts`) copy what a rule needs onto the element
    (`data-cdc-nav`, `data-cdc-icon`, `data-cdc-href`…);
  - nothing inside a `:has()` that Lichess adds during a game (`piece`,
    `square`, `div`, `button`, `a`, the move list's tags), and no bare tag
    or `*` after one (`.x:has(.y) div` restyles every `div`);
  - no endless `requestAnimationFrame` or animation loop, and
    `classList.toggle(name, true)` rather than `add` on `<html>`.

  Check with DevTools' Performance panel over a few moves: a "Recalculate
  style" should touch ~15 elements, not hundreds.

## Testing on lichess.org

- The end-to-end tests (`tests/e2e`) and any one-off check use Playwright's
  Chromium with `dist/chrome` loaded (`tests/e2e/fixtures.ts`). Branded
  Chrome ignores `--load-extension`; Playwright's default headless shell
  drops extensions silently, hence `channel: 'chromium'`. Use a desktop
  user agent, or Lichess serves its mobile layout.
- Check the extension is in before trusting a screenshot: read a computed
  style one of our rules sets (on an analysis page, `.analyse__controls` has
  a 1px `border-top`).
- A finished game's analysis opens on the review's summary, which hides the
  move list: click "Start Review", or `[title="Close review"]` for Lichess's
  panel.
- Wait for elements, not for time: snabbdom draws after `load`. Scroll
  panels yourself (`.analyse__moves`' `scrollTop`) and screenshot with a
  `clip` on the element's `boundingBox()`.
- Viewports: 1024×768, 1366×640, 1600×900, 1920×1080 and 2560×1440, both
  sides of each breakpoint the page's CSS uses (1019 / 1020, 1259 / 1260,
  800 / 801), and 390 and 800 wide for the mobile layout. Nothing overflows,
  the page doesn't scroll, bars and the eval bar line up with the board.
- Headless Chrome reports `prefers-reduced-motion: reduce` (like the user's
  own Chrome) and a light color scheme: check animations under `reduce`
  (sample frames with `requestAnimationFrame`, in the page), and emulate
  `dark` too. Playwright hides scrollbars in headless mode
  (`ignoreDefaultArgs: ['--hide-scrollbars']` brings them back).
- Pages that need an account (the puzzle dashboard) can't be driven live:
  rebuild them locally from a public page's shell, the markup of lila's
  Scala template and Lichess's own stylesheet for the page
  (`assets/css/<key>.<hash>.css`), without the shell's CSP `<meta>`, and
  measure in numbers.
- The Game Review's Stockfish is nondeterministic (two runs differ on about
  a quarter of the verdicts by one step, the game rating by 100+ points):
  compare runs from the same `cdc-review:*` cache entry, which skips the
  engine, or against that spread.
- Firefox: Puppeteer loads `dist/firefox` over WebDriver BiDi
  (`puppeteer.launch({ browser: 'firefox' })`, then
  `browser.installExtension(path)`); the dev auto-reload drops its session.

## Shipping

When the work is done (see [Definition of done](#definition-of-done)), ship
it without being asked. Don't open a PR.

1. Commit with a short message in English (a one-line summary under ~70
   characters, in the imperative: "Fix the eval bar on flipped boards"; a
   body only when the why isn't obvious), without a `Co-Authored-By`
   trailer. Rebase onto `origin/main` (`git fetch origin &&
git rebase origin/main`, never a merge: `main` stays a straight line) and
   push as a fast-forward (`git push origin HEAD:main`). If `main` moved,
   fetch, rebase and push again.
2. In the main checkout, `git pull --ff-only`, then
   `pnpm install --frozen-lockfile && pnpm build`: Chrome loads its
   `dist/chrome`, and reloads itself when a Lichess tab next gets focus.
   Once only, on the first pull that brings this layout: Chrome's unpacked
   entry still points at the checkout's root, whose `manifest.json` that
   pull removes, so the old worker reloads it into an error. Tell the user
   to remove that entry in `chrome://extensions` and load
   `<main checkout>/dist/chrome` instead (the extension id changes with the
   path). Drop this note once the main checkout loads `dist/chrome`.
3. Remove any throwaway files you created.
4. Don't bump the version: CI stamps `<BASE_VERSION>.<patch>` into each
   release and publishes it as `v<version>`, the patch counting the commits
   since `BASE_VERSION` (`src/manifest.ts`) last changed. Raise `BASE_VERSION`
   only for a big change: that commit is `.0`, the next ones `.1`, `.2`…
5. Finish with a short summary of what was done.

Pushing to `main` doesn't reach the stores. Send a version there only when
the user asks (each store reviews it, and the Chrome Web Store refuses a new
version while one is in review): tag the commit of `main` with the version
it gets.

```bash
git fetch origin
v=$(node scripts/version.ts --ref origin/main)
git tag "store-$v" origin/main && git push origin "store-$v"
```

The release workflow checks the tag, then sends the store zip to the Chrome
Web Store (`scripts/store/publish-chrome.ts`, secrets `CWS_SERVICE_ACCOUNT`
and `CWS_PUBLISHER_ID`) and the Firefox zip with its sources to Firefox
Add-ons (`web-ext sign`, secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`).
Each goes live once approved; the listings are edited by hand.
