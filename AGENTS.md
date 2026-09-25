# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.

**When a change is done, ship it without being asked: commit, push to `main`
and pull it into the main checkout (see [Shipping](#shipping)).** Work left
uncommitted in a worktree never reaches the extension Chrome loads.

## Goal

LichessDotCom is a Chrome extension (Manifest V3) that gives lichess.org a
**modern, Chess.com-style experience**. Lichess keeps its features: free
analysis, open data, no ads. The user gets the polished Chess.com UI they're
used to:

- Chess.com's look: dark palette, green board, Neo pieces, bold gradient buttons,
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
- **Make every page playful.** A modernized page should feel fun, like
  Chess.com's, not just re-skinned: color per section, icons on gradient
  tiles, cards, pills, and ideally nice illustrations (Neo pieces, Lichess's
  3D emoji, photos, little boards). Practice, simuls and the forum set the
  tone. Every side menu (`.subnav`) gets an icon per link on a tile tinted
  in its own color: add the menu to the shared rule in `pages.css`, then set
  `--cdc-nav-icon` and `--cdc-nav-color` per link in the page's CSS.
- **Hover feels the same everywhere.** A hovered card lifts, and the icon
  tile on it (or on a menu link) hops: `rotate(-6deg) scale(1.08)` on cards,
  `translateY(-2px) rotate(-8deg) scale(1.08)` on menu links, both with
  `transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)`. Reuse
  these values rather than inventing new ones.
- **Motion is never reduced.** `prefers-reduced-motion` changes nothing:
  every animation and transition runs, ours and Lichess's. Never write a
  `prefers-reduced-motion` query, in CSS or `matchMedia`. `motion.js`
  makes every reduced-motion query, Lichess's included, answer as if the
  user asked for nothing (see "Lichess reduces motion" below).
- **Only the content scrolls.** On a page that scrolls and has a side panel
  (a side menu, a help card) and a main title or header at the top, the
  side panel and the title stay put and only the content moves, as in an
  app: never the whole page. Pin them with `position: sticky` (see
  `simul.css`), or make the content its own scrolling area.
- **Every chart is modern.** Lichess draws its graphs with Chart.js into a
  `<canvas>`: flat, in its own colors and out of reach of CSS. Any graph we
  meet gets redrawn in SVG from the page's own data (usually
  `#page-init-data`), in the look the profile's rating chart set
  (`ratingchart.js`, `distribution.js`, `dashboard.js`): smooth curves or
  rounded columns over a gradient in the series' color (the same color for
  the same rating everywhere), a faint dashed grid, chips as the legend, a
  frosted tooltip on hover, and an entrance animation. Labels come from Lichess's `i18n.site` and
  numbers from `Intl`, so the chart speaks the page's language. Hide
  Lichess's canvas only once ours is in, so a data change falls back to
  theirs.

## Layout of the repo

| Path | What it does |
| --- | --- |
| `manifest.json` | Content scripts: CSS + `content.js` + `dashboard.js` + `ratingchart.js` + `lib/lottie_light.min.js` + `coach-lottie.js` + `coach.js` (isolated world), `motion.js` + `page.js` + `board.js` + `review.js` + `distribution.js` (page world). |
| `img/coaches/` | The Game Review coach's faces (`coach-<n>.webp`), their plates (`coach-<n>-plate.webp`: the portrait with its brows and mouth painted out) and `rig.json` (the features traced out of each portrait: brows as sprites, lips and lids as curves, their colours), all web-accessible so `review.css` and `coach.js` can load them. Generated by `tools/coach-rig/extract.py`. |
| `lib/lottie_light.min.js` | lottie-web 5.13's light player (MIT, `lib/lottie-web.LICENSE.md`), vendored as is: SVG rendering, no expressions, no `eval`. |
| `src/coach-lottie.js` | Isolated world, pure: builds a coach's face as Lottie animations from its rig. The brows and mouth (every mood's pose, a transition between any two moods laid out as one Eulerian circuit, a talking loop per mood), the lids' poses, and a blink loop. At rest every feature is the portrait's own, so the neutral face is the portrait. |
| `src/coach.js` | Isolated world: plays the rig in the coach's avatar as `review.js` posts which coach it is, its mood (per verdict) and whether it's talking (the comment typing out): a new mood eases in from the last, talking stops at the end of a syllable, the blinks run on their own. |
| `tools/coach-rig/extract.py` | Run once when a portrait changes (needs numpy and opencv-python-headless): traces its features into `img/coaches/rig.json` and paints its plate. |
| `tools/game-rating/` | The Game Review's game rating, calibrated on Lichess's own games (needs python-chess, numpy and scipy): `extract.py` judges every move of a database slice with Stockfish evals as `review.js` does (loss, phase, tactics), `fit.py` fits the odds of each loss band per rating and writes them into `review.js`'s `RATING_MODEL` line. Rerun both if the judging or the phases change. |
| `src/background.js` | Service worker: downloads the Chess.com sounds, caches them as base64. |
| `src/content.js` | Isolated world: forwards sounds to the page, measures sizes for the grids, builds captured pieces, fetches a finished game's move times (and its time control, for the "New 10 min" button), the players' country flags (from their profiles), the analysis board's players (copied from the hidden game info), the home hero, coach title badges, the Swiss list's and a Swiss tournament's round progress and medal ranks, the forum index's count labels, the hover card's rating chips and its fit in the window, the eval bar's score, the font remapping, the FIDE lists' (players, federations) rank offset on a later page, and which coach (`data-cdc-coach` on `<html>`) reads a practice drill's goal, and the sidebar's Donate item (copied from the flyout's, as Lichess's own lone link is missing for patrons and on game pages). |
| `src/dashboard.js` | Isolated world: the puzzle dashboard's theme radar, redrawn as SVG from the page's init JSON (Lichess draws it into a canvas). |
| `src/ratingchart.js` | Isolated world: the rating history chart (profile, rating stats page), redrawn in SVG from the page's init JSON, or the stats page's `loadEsm` call (Lichess draws it with Chart.js into a canvas): smooth curves over gradients, range pills, one chip per rating, a hover tooltip. |
| `src/distribution.js` | Page world: the weekly rating distribution (`/stat/rating/distribution/<perf>`), redrawn in SVG from the page's init JSON (Lichess draws it with Chart.js into a canvas): a rounded column per 25 points in the rating's color, the cumulative curve, pills for your rating and the player you came from, a hover tooltip. Page world for Lichess's translated labels (`i18n.site`). |
| `src/motion.js` | Page world, first: motion is never reduced. Reduced-motion queries answer as if the user asked for nothing, in `matchMedia` and in Lichess's sheets (each one loaded again with CORS, its rules rewritten, the original switched off). |
| `src/page.js` | Page world: wraps `site.sound` to play the right Chess.com sound per move, plus premove / illegal / game-start, which Lichess has no sound for. |
| `src/board.js` | Page world: every main board's shapes redrawn Chess.com-style (right-clicked squares filled, arrows), checkmate badge and label. |
| `src/review.js` | Page world: Game Review (engine, classification, panel, the coach's comment per move: how the evaluation moved plus one fact from the board and the engine, its pieces drawn as Neo pieces and its moves as chips, typed out word by word, board overlays, eval bar), and Chess.com's game rating under the summary's counts: the rating each side played at and a verdict per phase (opening, tactics, strategy, endgame, by Lichess's own divider), from `RATING_MODEL`. A move played off the game shows in the review's move list as a variation (Lichess's comments and computer lines stay hidden) and is judged like the game's, badge, best-move arrow and eval bar included. On the free analysis board (`/analysis`) the same coach judges each move as it's played, variations included, with the badges on the board and in Lichess's move list, and, signed in, the opening's name (from the masters explorer) over the move list. |
| `src/styles/theme.css` | Overrides Lichess's `--c-*` color variables, fonts, buttons. |
| `src/styles/sidebar.css` | Lichess's top header → Chess.com's left sidebar, and the user menu (dasher) as a Chess.com menu. |
| `src/styles/board.css` | Board, pieces, highlights, move hints, arrows, coordinates, and Lichess's eval bar drawn like the Game Review's. |
| `src/styles/playerbar.css` | The player bars' look, shared by the game page (`.ruser`, `.rclock`) and the analysis board (`.cdc-player`, `.analyse__clock`): avatar, title, name, flag, rating, captured pieces and the clock. Each page only places them. |
| `src/styles/game.css` | Game page (`main.round`) grid, where the player bars and clocks sit, moves, chat, and the game-over panel (Game Review button, move times); crazyhouse's pockets in a strip right of the board, and zen mode. |
| `src/styles/analysis.css` | Analysis page (`main.analyse`) grid (with the game page's player bars when there are players or clocks), engine header and lines, move list (glyph badges, comment cards) and controls; a study's chapters and a broadcast round's games in the panel's last row. |
| `src/styles/explorer.css` | The opening explorer (`.explorer-box`) as Chess.com's: the databases as pill tabs, the opening on a card behind a green book tile, roomy move rows with a rounded white / draw / black bar, the games with a colored square per player and a result pill, and the settings as grey / green buttons. Open, it takes what it needs, up to 40% of the analysis panel. |
| `src/styles/review.css` | Game Review panel, eval bar, board annotations, and the free analysis board's coach over Lichess's panel. The coach's avatar: the portrait, swapped for its plate once `coach.js` has the rig over it, and the marks over its head per verdict (sparkles, "?", "!", a drop of sweat). |
| `src/styles/pages.css` | Modern look for every other page (headings, side menus, tabs, tables, forms, dialogs, lobby, editor, tournaments), the puzzle modes (Storm, Racer, the coordinate trainer) sized beside the sidebar, and Lichess's static pages (about, FAQ, variants, streamers…) with their side menu and title pinned. The side menus of the community pages, broadcasts, puzzles and account settings get an icon per link on a tile tinted in its own color (Chess.com's color icons, or Lichess's 3D emoji for the account settings); each page's CSS picks its links' icons. |
| `src/styles/dropdowns.css` | Every dropdown as one menu style: Lichess's `.mselect`, native `<select>` (via `appearance: base-select`) and autocomplete lists. |
| `src/styles/powertip.css` | The profile hover card (`#powerTip`, filled with `/@/<user>/mini`) as a Chess.com player card. |
| `src/styles/profile.css` | Player profile (`main.page-menu` + `.user-show`) as a Chess.com member page: a hero card (avatar, name, awards, counters, actions), the side ratings as a full-width strip of rating cards, the about card and rating chart, pill tabs, the activity timeline and the game rows. |
| `src/styles/ratingchart.css` | The SVG rating chart of `ratingchart.js`: chips, range pills, curves and their wipe-in / morph animations, the tooltip. Hides Lichess's chart only once ours is in. |
| `src/styles/distribution.css` | The rating distribution page (`.rating-stats`) and the SVG chart of `distribution.js`: columns that rise in, the curve drawing itself, marker pills. Reuses the chips, grid and tooltip of `ratingchart.css`. |
| `src/styles/home.css` | Home page (`main.lobby`) as a 12-column card dashboard, with quick pairing as Chess.com's time-control picker (same-size buttons, three to a row); the hero is added by `content.js`. |
| `src/styles/coach.css` | Coach directory (`main.coach-list`) as a grid of coach cards; the title badges are split out of the names by `content.js`. |
| `src/styles/teams.css` | Team lists (`main.team-list`) as a grid of club cards with avatar tiles. |
| `src/styles/study.css` | Study lists (`.study-index`) as a grid of study cards, the compact list view, the toolbar, topics and staff picks. |
| `src/styles/friends.css` | Player lists (following, blocks, favourite opponents) as Chess.com friend cards with avatars and an online dot. |
| `src/styles/friendbox.css` | The online friends box (`#friend_box`, bottom right, signed in only) as a Chess.com dock: a tab on the window's bottom edge with a green dot and a chevron, opening into rows with an avatar, the online dot on its corner, the title badge and a round TV button while they play. |
| `src/styles/puzzle.css` | Puzzles (`main.puzzle`): from 1260px a non-scrolling grid (one side card, the eval bar left of the board, analysis-style), a status banner, chunky hint / solution / vote buttons, the themes as a list of rows, and the move buttons pinned inside the panel. |
| `src/styles/blog.css` | Blog posts (`.ublog-post`) as Chess.com-style articles, and the blog lists. |
| `src/styles/practice.css` | Practice (`.practice-app`, `.practice-side`) as playful lesson cards: a color per section, white icons on gradient tiles, progress pills. |
| `src/styles/practice-run.css` | Inside a lesson (`main.analyse` + `.practice__side`): one lesson panel with the chapter list as numbered steps, the gamebook coach in a white bubble with the octopus, and a drill's goal read out by the Game Review's coach in a white bubble, and its status. |
| `src/styles/learn.css` | Learn (`#learn-app`, one app for both views): the map (`.learn--map`) in the Practice look, a color per category, white pieces on gradient tiles, star pills; inside a stage (`.learn--run`) the stage list and the goal panel as cards, the levels as pills. |
| `src/styles/puzzles.css` | Puzzle themes (`.puzzle-themes`) and puzzles by opening (`.puzzle-openings`) in the Practice look: a color per section, theme cards, a card per opening family, opening chips; from 1020px the title and the side menu stay in view on scroll. |
| `src/styles/dashboard.css` | Puzzle dashboard (`.puzzle-dashboard`): stat tiles, per-theme rows, and the panel around `dashboard.js`'s radar. |
| `src/styles/broadcast.css` | Broadcasts (`.relay-index` lists, calendar, FIDE pages, info pages) as event cards with a LIVE pill, and a broadcast's own page (`main.analyse.has-relay-tour`, no board) in two columns beside the sidebar. |
| `src/styles/swiss.css` | Swiss tournaments home (`main.swiss-home`): now playing / starting soon as tournament cards (time-control tile, rounds progress bar, player chip), the explanations as point cards, a comparison card and a grid of FAQ cards. |
| `src/styles/swiss-show.css` | A Swiss tournament (`main.swiss`), in Lichess's three columns: the info panel as a card (time-control tile, rounds progress bar, condition chips), a header with a countdown chip, the standings with a colored square per round and medal-colored leaders, the podium, the stats and player cards, and the mini boards with Chess.com clocks. From 1260px the page doesn't scroll: only the middle column does, its title pinned. |
| `src/styles/leaderboard.css` | Players leaderboard (`/player`, `.community`) in the Practice look: a card per leaderboard with its icon white on a tile in its own color, medals for the top three, and the online players in a sticky side card with rating chips. Tournament winners (`/tournament/leaderboard`, `.tournament-leaderboards`) reuse the same cards, with a gold / silver / bronze cup per yearly / monthly / weekly winner, the tournament as a pill, and the side menu and title pinned while the cards scroll. Tournament shields (`/tournament/shields`, `.tournament-shields`) are the same cards with a shield-shaped tile (colored by how the category link ends, as the header has no icon) and a gold mini-shield for the current holder; a shield's history (`/tournament/shields/<perf>`, `main.tournament-categ-shields`) is a grid of gold shield cards, the holder's across the top. The side menu these pages share (leaderboard, rating stats, tournament winners and shields, bots, FIDE players) gives each link Chess.com's color icon on a tile tinted in its own color (the tiles are in `pages.css`). |
| `src/styles/fide.css` | FIDE players (`/fide`, `.fide-players`) as Chess.com's top players: a row card per player with a rank (medals for the top three, only when sorted by a rating; `content.js` offsets it when the list opens on a later `?page=`), a rounded photo (Chess.com's avatar when FIDE has none), title badge, name and flag, the sorted-by rating in white, and the sort links as pills with time-control icons. The side menu, the title with the search and the column pills stay put while the rows scroll. The federations (`/fide/federation`, `.fide-federations`) are the same ranking: a row card per federation with its rank (medals for the top three), a big round flag, the player count and the three top-10 ratings, the title and column heads pinned. A federation's page (`.fide-federation`) has a pinned header (round flag, name, player count pill) and its rank per time control as stat cards, the time control's icon white on a tile of its color. |
| `src/styles/bots.css` | Online bots (`/player/bots`, `.bots`) as bot cards: a Neo piece white on a gradient tile (gold for the featured bots, otherwise a color and a piece per card), a green dot when online, ratings as chips, a clipped bio and a green Play button. Each section's title stays in view over its own cards. |
| `src/styles/simul.css` | Simuls home (`main.simul-list`) in the Practice look: a color per section (yours, open, in progress, finished), each simul a card whose tile is a stack of little boards with a Neo piece on it, a dashed "host a simul" card, the title pinned while the list scrolls, and the help as a sticky card with Fischer's photo as a polaroid and the rules as numbered steps. |
| `src/styles/forum.css` | The forum, every page of it: the index as a card per category (a color and one of Lichess's 3D emoji each, counts as chips, the last post as a footer), a category's topics as rows with the reply count in a speech bubble, a topic's posts as cards with avatars and pill reactions, the reply box, the new topic form's warnings as tip tiles, and the search results. |
| `src/styles/patron.css` | The Patron page (`/patron`, `main.page-menu.plan`): Lichess's green banner as a dark hero card with gold wings that flap, the pitch and the checkout as two cards (for whom / how often as segmented tracks like the game setup, the amounts as tiles, a big Donate button), the FAQ as a card per question with a 3D emoji on a tile in its own color, both patron lists as chips tinted with each patron's wing color, the new patrons in a side card that stays put and scrolls in place, and a patron's wing color picker. |
| `src/styles/racer.css` | Puzzle Racer: the home (`main.racer-home`) as two cards, each a little race scene (a sky in its color, hills, a road with a finish line, Lichess's own vehicle from its `racer-car` font, which boosts down the road on hover); a race (`.racer`) with your vehicle on a tile in your car's color, a white Chess.com clock, a green combo bar with pill levels, a gold rank pill, and the track as lanes of asphalt with a finish line and score chips. From 1020px the board leaves the track room, so the page doesn't scroll. |
| `src/styles/storm.css` | Puzzle Storm: a run (`.storm--play`) in one grid with what the page puts under it, the board beside a right-hand column of the side panel, the highscores as tiles (all-time in gold) and the About pill, so the page doesn't scroll; the sidebar's Puzzle Rush icon where Lichess draws its tornado (the panel's tile, the end score, Play again, a new highscore, the reload screen), bold white numbers instead of the storm font, bonus / malus pills. The side panel, clock, combo and puzzles played are Racer's (`racer.css` shares those rules with `.storm`). Also the run's end (`main.storm--end`) and the dashboard (`/storm/dashboard`). |

There is no build step and no dependencies: plain JS and CSS, loaded unpacked.
The one library, lottie-web's player, is vendored in `lib/` as it ships; the
coaches' rig is traced by a script that only runs when a portrait changes.

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
- **Coordinates.** Lichess swaps `body.coords-out` for `coords-in` while its
  eval gauge shows (analysis, puzzles: `forceInnerCoords`), so a player who
  chose "outside" saw them jump inside and back from move to move. On desktop
  `board.css` draws both classes outside, like Chess.com, sized by
  `--cdc-coords-size`; a layout leaves them room under
  `body:is(.coords-in, .coords-out)` (a gutter left of the board for the
  ranks, `--cdc-coords-off` under it for the files). Only `coords-no` has none.
  Below 1020px they stay where Lichess puts them: moved left of the board,
  they fell off a phone's screen.
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
  Time-control icons are Lichess font glyphs in `[data-icon]::before`
  (`\e059` ultrabullet, `\e032` bullet, `\e008` blitz, `\e002` rapid,
  `\e00a` classical, `\e019` correspondence). `theme.css` masks them with
  Chess.com's game-time icons in `--cdc-mode-color`; set that variable on the
  `::before` to recolor one in context.
- **Practice lessons are analysis pages.** `/practice/…` renders `main.analyse`
  with `.practice__side` (the chapter list) plus either `.gamebook` (an
  interactive lesson: comment, feedback, mascot) or `.practice-box` (a drill
  against the engine). `.practice-box` alone doesn't identify one — "practice
  with computer" adds the same box to any analysis board — so scope on
  `.practice__side`. A drill's goal sits in `.analyse__underboard`, which
  `analysis.css` hides. Rows of the panel need a definite height to be shares
  of the board: `1fr` in a container sized by its content just grows.
- **Game over.** The round page's end-of-game buttons are `.rcontrols >
  .follow-up` (rematch, new opponent, tournament link, then the analysis
  link, always last), a column flexbox in Lichess's CSS. "New opponent" only
  exists for lobby and pool games; otherwise `content.js` adds its own
  `/?hook_like=<id>` button, prepended so the analysis link stays last. The round data has
  no clock history, so move times come from `/game/export/<id>?clocks=true`.
  In a scrolling grid, a track like `minmax(30px, auto)` never grows past its
  fixed minimum once the content overflows: put the minimum on the items.
- **Two worlds.** `content.js` can't see page JS objects (`site`, chessground's
  `cgKey` expandos); `page.js`, `board.js` and `review.js` can. Communicate with
  `window.postMessage`. Page-world scripts can't call `chrome.runtime.getURL`
  either: to show a bundled image, list it in `web_accessible_resources` and
  load it from manifest CSS with
  `url('chrome-extension://__MSG_@@extension_id__/<path>')`.
- **Buttons.** Chess.com's buttons are a gradient with a 1px top highlight,
  a 1px darker bottom edge and a soft drop shadow, not a solid 3D ledge.
  The recipe lives in `--cdc-btn-{green,grey,red}[-hover|-shadow]` in
  `theme.css`: use those for anything button-like instead of flat colors.
  Where Lichess glues a button to an input (`.copy-me`, search forms) or
  stacks buttons flush (editor actions), drop the shadow or add a gap.
- **Scroll state.** Once the page scrolls down, Lichess adds `.hide` to `#top`,
  which hides `#topnav` and the dropdowns with `visibility`, `opacity` *and*
  `pointer-events: none`. The sidebar is fixed, so `sidebar.css` forces all
  three back; forgetting `pointer-events` leaves a visible but dead sidebar.
- **JS-sized widgets.** The home blog carousel sets each card's width from
  the carousel's `clientWidth`, which counts padding. Inset it with a
  transparent border, not padding, or the last card is clipped.
- **lottie-web.** It rewrites the animation data it's given, so the data
  must share no objects (`coach-lottie.js` gives each animation its own JSON
  copy); a layer built on shared ones just doesn't draw. After
  `playSegments`, `goToAndStop(frame, true)` counts from that segment's first
  frame, not the animation's: `resetSegments(true)` first. A segment stops a
  frame short of its end, so land on the pose by hand. And a lid can't blink
  by squashing its shut outline, except fast: the in-betweens are a flat
  band. Resting lids morph their outline; only the blink scales.
- **Useful page APIs.** `site.sound` is Lichess's sound player, and
  `site.analysis` is the analysis controller (`mainline`, `node.ply`, `path`,
  `nodeList`, `tree.nodeAtPath`,
  `jumpToMain`, `getOrientation`; `jumpToMain` doesn't scroll the move list),
  and `site.analysis.chessground.state.drawable` holds the arrows (`shapes`,
  `autoShapes`, `current`), and the engine is at
  `npm/stockfish-web/sf_19_smallnet.js`. **Only the analysis page has a
  controller**: a game page exposes none, so anything that must work on both
  reads the board's DOM instead (`board.js` does).
- **The free analysis board.** `/analysis` is `main.analyse` with
  `site.analysis.synthetic` set and a game id of `synthetic`: no game to
  export, and a tree that grows as the user plays. Every `move` in its move
  list, variations included, carries its tree path in a `p` attribute
  (`tree.nodeAtPath(p)`). Opening names come from
  `explorer.fetchMasterOpening(fen)`, which fails with a 401 when signed out.
- **Chessground's shapes.** They live in `cg-container > svg.cg-shapes`, one `g`
  per shape: a circle (a right-clicked square) or a line (an arrow), in square
  units from the viewBox's corner (`-4 -4 8 8`), *with the orientation already
  applied* — so reading them needs to know nothing about the position. An
  arrow's ends are pulled in from the square centers; round back to them. The
  group's `cgHash` is `width,height,hilite,orig,dest,brush…`, and `hilite` is
  how chessground draws the shape being dragged: that third field is the only
  thing telling it apart from a finished one. Engine arrows (`autoShapes`) come
  with a pale brush, hence an `opacity` below 1; a hand-drawn one is always
  solid.
- **Hover cards.** All of them come from one `powertip.ts`, but each kind has
  its own popup element: the **user** card is `#powerTip` (server HTML from
  `/@/<user>/mini`), games are `#miniGame`, board previews `#miniBoard`, lobby
  hooks `#hook`. The card is re-fetched and re-`innerHTML`'d on every hover, so
  editing its text is safe, but it has to be re-done each time: watch the
  popup with a `MutationObserver` on `childList`, don't poll (a poll shows the
  untouched markup first). Lichess also only creates the element on the first
  hover.
- **`<script id="page-init-data">`.** Whatever data a page hands its JS module
  (the game, the puzzle dashboard's radar…) is inlined there as JSON, *not* in
  the `loadEsm(…)` call — with exceptions: the rating stats page still passes
  its chart's data inside `loadEsm('chart.ratingHistory', …)`, which
  `ratingchart.js` reads too. Lichess removes the element once its module has
  read it. Grab it while the page parses (a `MutationObserver` from
  `document_start`); keeping the node is enough, its text stays readable after
  Lichess takes it out of the document.
- **Profiles.** A profile's two richest blocks, the **rating chart** and the
  **activity feed**, are only served to a *signed-in* visitor: logged out, both
  containers are rendered empty. To see them, inject plausible markup into
  `.angle-content .activity` and `#us_profile` on the live page (the shapes are
  in `modules/activity/.../ActivityUi.scala` and `PerfStatUi.ratingHistoryContainer`).
  Two more traps: the awards are `position: absolute` on `main.page-menu`, to
  escape `.user-show { overflow: hidden }` — once the box no longer clips they
  can flow, but each kind carries margins tuned for that absolute strip. And
  `bits.dropdownOverflow` decides how many action buttons fit by adding them
  until `.user-actions`'s `offsetWidth` grows, so **don't change that element's
  flex sizing** — only what's inside it.
- **A box made transparent still clips.** Lichess's `.box` (and boxes like
  `.lobby__side`) carry `overflow: hidden` for their rounded corners. Once our
  CSS drops their background, that clip cuts what the cards inside draw past
  their edges — hover shadows, focus rings, dot halos — and it makes the box
  the scroll container of any `position: sticky` inside it, which then never
  sticks. Add `overflow: visible !important` with the transparent background.
  Then check for a closed `.mselect__list`: hidden but still laid out, it can
  widen the page once nothing clips it (anchor it with `inset-inline: auto 0`).
- **A page that must not scroll.** Lichess's hidden hover cards (`#powerTip`,
  `#miniGame`) sit at the document's end and leave about 40px to scroll, so a
  layout that fits the window still needs `html, body { overflow: hidden }`
  (as `game.css` and `swiss-show.css` do), with every column scrolling in
  place. A `sticky` title can't leave its parent: to pin it over more than
  its card, make the card `display: contents` and draw it from its pieces.
- **Boards sized to the window.** Lichess sizes its boards from the whole
  window's width (`---col2-uniboard-width`…), as if there were no sidebar:
  Storm, Racer, the coordinate trainer, Learn and the puzzle page ran past
  the window's right edge, their ranks under the sidebar. Cap the board's
  column by what the sidebar leaves (`100vw - var(--cdc-sidebar-w)`, the
  page's margins, the side panel) and give the ranks their gutter.
- **The board's resize handle.** `cg-resize` sets `---zoom` (0–100) on
  `body`, which Lichess's CSS turns into `---board-scale` (25% to 100%) and
  saves as a pref. That pref may date from Lichess's layout (it made boards
  tiny), so ours ignore it: the board takes all the room it's given until
  dragged, and `content.js` keeps the dragged size under `cdc-board-zoom`,
  as `--cdc-zoom`. A layout that sizes its own board multiplies by
  `var(--cdc-board-scale, 1)` (board.css), or the handle does nothing. And size it
  with `dvh`, not `vh`: on a Meta Quest or a phone `100vh` is taller than
  what the browser shows, and the board ran off the bottom.
- **Pinned titles.** A sticky title widened by negative inline margins, to
  cover the cards' shadows passing under it, runs past the window at 1024px,
  where the page's gutter is only ~10px. Widen it with side box-shadows in
  the page's color instead: they don't widen the page.
- **The page's background.** Lichess draws a few things behind the page with
  a negative z-index (the game page's clock faces). `theme.css` paints the
  page's color on `html` and leaves `body` clear: painting `body` hid them.
- **Lichess reduces motion.** Under `prefers-reduced-motion: reduce` its
  site CSS has `*, :before, :after { transition: none !important;
  animation: none !important }` (ours included), its header stops being
  sticky, and its scripts check `matchMedia`. `motion.js` undoes all of it:
  `matchMedia` answers `reduce` as false and `no-preference` as true, and
  since a script can't edit a cross-origin sheet's rules (Lichess's links
  have no `crossorigin`), each Lichess sheet is loaded again with CORS, its
  reduced-motion media rules rewritten the same way, and the original
  switched off (`link.disabled`). Setting `crossorigin` or `href` again on
  the original doesn't make Chrome refetch it. Until the copy loads (a few
  ms, from the cache), Lichess's rule still applies, which is why our
  `transition`s are `!important`; keep writing them that way.
- **Lichess's light theme.** An anonymous visitor on a light OS gets
  Lichess's light theme (`html.light`), and so does headless Chrome. Our
  variables override its colors, but its own `.light …` rules still apply
  here and there (a light strip, a darkened illustration): check both themes.
- **800px exactly.** Lichess's phone menu (`.mselect`) applies up to
  `max-width: 800px`, so a desktop rule from `min-width: 800px` applies at
  800 as well: start those at `800.02px`.
- **Variants.** Crazyhouse's pockets sit in grid areas `mat-top` /
  `mat-bot`, which the game grid must place (`game.css`). Three-check's
  checks are kings in Lichess's `.material`, which our player bars hide
  (`content.js` adds them to the captured pieces). Racing Kings and Horde
  start with other pieces than the standard set.
- **Zen mode** (`body.zenable.zen`) hides all but the board, the clocks and
  the controls, the sidebar included, and our `!important` layout rules
  bring them back unless they yield to it (`game.css`).
- **TV.** `/tv` and `/tv/<channel>` show a game whose id isn't in the URL:
  take it from the move list's analysis link.
- **A `main.analyse` without a board.** A broadcast's own page (overview,
  boards, players) is `main.analyse.is-relay.has-relay-tour`: the analysis
  layout must leave it alone (`broadcast.css` gives it its two columns back).
- **Picker names.** lila puts a picker's name in its `mselect`'s id
  (`#…__day-select`), not in its class.

## Testing

Branded Chrome ignores `--load-extension`, but Playwright's Chromium
(`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`) honours it:
`launchPersistentContext` with `--load-extension=<worktree>` runs the real
extension, content scripts and all. Otherwise, verify by driving
a headless Chrome over the DevTools protocol. The CSS is injected (prepended,
so Lichess still wins ties, as it does with a real content script) and the
page-world scripts are evaluated, then screenshots and measurements are taken
on live pages:

- a game: pick one from `https://lichess.org/api/tv/channels`
- analysis: a finished game, e.g. `https://lichess.org/tKlG0mrQ/black`
- the home page, in several languages (`Accept-Language` fr/en/de)

Pages that need an account (the puzzle dashboard) redirect, so they can't be
driven live. Rebuild them locally instead: take a public page's shell for the
header and sidebar, drop in the markup its Scala template produces (in
`lichess-org/lila`), link Lichess's own stylesheet for that page
(`assets/css/<key>.<hash>.css`, hashes in `assets/compiled/manifest.*.js`)
before ours, and strip the shell's CSP `<meta>` or the stand-in scripts are
blocked. Have the page measure itself and read the numbers back with
`--dump-dom`: overflow is easier to check in numbers than in a screenshot.

Check at 1024×768, 1366×640, 1600×900, 1920×1080 and 2560×1440: nothing
overflows, the page doesn't scroll, and bars and the eval bar line up with the
board. Check both sides of each breakpoint the page's CSS uses (1019 / 1020,
1259 / 1260, 800 / 801), and 390 and 800 wide for Lichess's mobile layout,
which must survive our theme. Chess.com's CDN rejects the `HeadlessChrome`
user agent, so override it to a normal Chrome UA for every request, or images
will look broken when they aren't.
Headless Chrome also reports `prefers-reduced-motion: reduce`, like the
user's own Chrome: evaluate `motion.js` first, or Lichess turns every
animation off. Check that animations run under `reduce` too, exactly as
under `no-preference`. Sample a transition frame by frame in the page
(`requestAnimationFrame`), not with one round trip per sample. It
reports a light color scheme too (emulate `dark` as well, see "Lichess's
light theme"), and Playwright hides the scrollbars in headless mode
(`ignoreDefaultArgs: ['--hide-scrollbars']` brings them back): a layout that
only fits without a scrollbar looks fine there, not in a real Chrome.

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
4. Finish with a short summary of what was done. There's no need to reload
   the extension by hand: when loaded unpacked, it reloads itself (and the
   tab) as soon as a Lichess tab gets focus after its files changed.
