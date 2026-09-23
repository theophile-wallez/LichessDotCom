# LichessDotCom

A Chrome extension that makes [Lichess](https://lichess.org) look and sound like Chess.com.

- **Board**: Chess.com's green board (`#ebecd0` / `#739552`), yellow last-move highlights, dot and ring move hints, and red premove squares.
- **Pieces**: Chess.com "Neo" pieces.
- **Sounds**: Chess.com's move, opponent move, capture, castle, promotion, check, game start and end, 10-seconds-left and notification sounds. The right sound is picked for every move.
- **Layout**:
  - A fixed left sidebar with flyout menus replaces the top header.
  - Player bars with an avatar, title badge, rating, Chess.com-style captured pieces and clock sit above and below the board, aligned with its edges.
  - One right-hand panel holds the move list, the game controls and the **chat**.
  - Like Chess.com, game and analysis pages never scroll: everything fits the window. Lichess's below-the-board extras (crosstable, game info, share & export, computer analysis chart) are hidden.
- **Home page**: a modern dashboard with a hero card (big title, Play / Friend / Computer buttons, live counters), the featured game and daily puzzle as cards, chunky time-control tiles, and blog, news, streams and tournaments below.
- **Coaches**: the coach directory is a grid of Chess.com-style cards: photo, title badge, headline, location, languages, ratings, rate and last seen.
- **Teams**: team lists are a grid of club cards: avatar tile (the team's flair or a tinted group icon), name, intro and member count.
- **Studies**: study lists are a grid of cards (flair tile, name, likes and author, chapters and members) under a one-row toolbar; the list view becomes dense rows.
- **Blog**: posts read like Chess.com articles; the blog lists (community, by month, by topic, a user's blog) are grids of post cards with segmented filters.
- **Practice**: Chess.com's playful lesson look: a color per section, white icons on bouncy gradient tiles, progress pills, green checks and a green progress bar under Chess.com's Drills illustration.
- **Theme**: Chess.com's dark palette, fonts and 3D green buttons across the whole site. Every page is modernized: solid bold text instead of Lichess's thin fonts, pill side menus, clean tabs and tables, card tiles, Chess.com-style dropdown menus, and Chess.com's colorful icons in the sidebar menus.
- **Game Review**: on any finished game's analysis page, a Chess.com-style review powered by Stockfish 19 running in your browser:
  - A summary with the eval graph, both players' accuracy and counts of brilliant, great, best, excellent, good, book, inaccuracy, mistake, miss and blunder moves.
  - A move-by-move review with a coach bubble, classification badges in the move list and on the board, colored move squares, a best-move arrow and a Chess.com eval bar.

The game page (`/<gameId>`, including TV) and the analysis page (`/analysis` and finished games) get the full Chess.com layout. Every other page gets the theme, sidebar, board and pieces.

## Install

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Open or reload lichess.org.

When loaded unpacked, the extension reloads itself whenever its files change (for example after a `git pull`): focus a Lichess tab and it picks up the new code.

Tip: Lichess's _coordinates_ setting (Preferences → Display) picks between Chess.com's inside coordinates (the default) and outside coordinates.

## How it works

| File | Role |
| --- | --- |
| `src/styles/theme.css` | Overrides Lichess's `--c-*` color variables, fonts and buttons. |
| `src/styles/sidebar.css` | Turns `#top` into a fixed left sidebar (≥ 1020px wide). |
| `src/styles/board.css` | Board, pieces, square highlights, move hints, arrows, coordinates. |
| `src/styles/game.css` | Game page layout (`main.round`). |
| `src/styles/analysis.css` | Analysis page layout (`main.analyse`). |
| `src/styles/review.css` | Game Review panel, eval bar and board annotations. |
| `src/styles/pages.css` | Modern look for every other page: headings, side menus, tabs, tables, forms, lobby tiles. |
| `src/styles/dropdowns.css` | One Chess.com-style menu for every dropdown: filters, native selects, the variant picker, search suggestions. |
| `src/styles/home.css` | Home page redesigned as a card dashboard with a hero, featured game and daily puzzle. |
| `src/styles/coach.css` | Coach directory as a grid of coach cards with title badges. |
| `src/styles/teams.css` | Team lists as a grid of club cards. |
| `src/styles/study.css` | Study lists as a grid of study cards. |
| `src/styles/friends.css` | Player lists (following, blocks) as friend cards. |
| `src/styles/blog.css` | Blog posts as Chess.com-style articles, and the blog lists as grids of post cards. |
| `src/styles/practice.css` | Practice page as playful, colorful lesson cards. |
| `src/background.js` | Downloads the Chess.com sounds once and caches them in `chrome.storage.local`. |
| `src/content.js` | Passes the sounds to the page and measures the controls height for the layout grid. |
| `src/page.js` | Runs in the page and wraps `site.sound` so each event plays the matching Chess.com sound. |
| `src/board.js` | Runs in the page: redraws analysis arrows like Chess.com (L-shaped for knights) and shows checkmate on the king. |
| `src/review.js` | Runs in the page: analyzes the game with Stockfish, classifies moves and renders the Game Review. |

The layouts use `display: contents` on Lichess's containers so the board, player bars, clocks, moves and chat can be arranged in one CSS grid. No DOM nodes are moved, which keeps Lichess's virtual DOM happy.

For sounds, `page.js` wraps Lichess's `site.sound.move()` and `site.sound.play()`. When a move lands, it reads the board's last-move squares and pieces from the DOM (chessground's `cgKey`). From that it tells your moves from your opponent's and detects castling, promotion and check, just as Chess.com does.

For the Game Review, `review.js` loads the same Stockfish 19 build (`sf_19_smallnet`) that Lichess's analysis board uses, through Lichess's own asset loader. It evaluates every mainline position (depth 16, two lines) and caches the results per game in `localStorage`, so a game is only analyzed once (about 20 seconds for 50 moves). Moves are classified from how much win probability they lose, following Chess.com's categories. "Brilliant" means a best move that sacrifices a piece; "great" means the only good move. Navigation goes through Lichess's analysis controller (`site.analysis`).

No Chess.com artwork or audio is bundled here. Pieces load from Chess.com's CDN at runtime, and the sounds are fetched by the extension on first use.

## Caveats

- Lichess obfuscates some move-list tag names (currently `i5d`, `aPp`, `qZM`, `Z7yx`, `bo3`) and occasionally renames them. If the move list loses its styling after a Lichess update, update those names in `src/styles/game.css`.
- Below 1020px the Lichess mobile layout is kept, with the theme, board and pieces applied.
- See [AGENTS.md](AGENTS.md) for the project goals, conventions and Lichess pitfalls.
- Not affiliated with Chess.com or Lichess. Chess.com's name, pieces and sounds belong to Chess.com.

## License

[MIT](LICENSE)
