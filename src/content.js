// Isolated-world content script.
// 1. Gets the Chess.com sounds from the background worker and forwards them to
//    the page-world script (page.js), which hooks Lichess's sound player.
// 2. Keeps a CSS variable in sync with the height of the game controls, which
//    the game layout grid needs (see styles/game.css).
// 3. Renders Chess.com-style captured pieces in the player bars, and the
//    analysis board's players.
// 4. When loaded unpacked, reloads the extension after a ship changed its files.

(() => {
  const MSG_SOUNDS = 'cdc:sounds';
  const MSG_PAGE_READY = 'cdc:page-ready';

  // Lichess sets light (300) weights on Roboto / Noto Sans all over the site;
  // Chess.com's text is solid. Re-point those families (and our own 'CDC Sans')
  // at the system UI font so light weights render as regular. These faces must
  // come after Lichess's own @font-face rules to win, hence appended at the end
  // of <head> rather than shipped in the manifest CSS.
  const FONT_FACES = ['Roboto', 'Noto Sans', 'CDC Sans']
    .map(family =>
      [
        ['100 450', "local('Segoe UI'), local('SegoeUI'), local('Helvetica Neue'), local('Roboto')"],
        ['451 650', "local('Segoe UI Semibold'), local('SegoeUI-Semibold'), local('HelveticaNeue-Medium'), local('Roboto Medium')"],
        ['651 850', "local('Segoe UI Bold'), local('SegoeUI-Bold'), local('HelveticaNeue-Bold'), local('Roboto Bold')"],
        ['851 1000', "local('Segoe UI Black'), local('SegoeUI-Black'), local('HelveticaNeue-Bold'), local('Roboto Black')"],
      ]
        .map(([weight, src]) => `@font-face{font-family:'${family}';font-weight:${weight};src:${src}}`)
        .join(''),
    )
    .join('');
  const addFonts = () => {
    const style = document.createElement('style');
    style.id = 'cdc-fonts';
    style.textContent = FONT_FACES;
    document.head.appendChild(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addFonts);
  else addFonts();

  // Lichess TV (styles/tv.css): its channels slide in when TV is opened, not
  // each time it loads again, from a channel link (the referrer is TV) or
  // for the next game (Lichess reloads the page). `cdc-tv-still` stops it.
  if (/\/tv(\/|$)/.test(location.pathname)) {
    const nav = performance.getEntriesByType('navigation')[0];
    let fromTv = false;
    try {
      fromTv = new URL(document.referrer).origin === location.origin && /\/tv(\/|$)/.test(new URL(document.referrer).pathname);
    } catch {}
    if (fromTv || nav?.type === 'reload') document.documentElement.classList.add('cdc-tv-still');
  }

  // Donate as a sidebar item of its own (styles/sidebar.css). Lichess's lone
  // Donate link after the nav is missing for patrons and on zen pages, but the
  // flyout's copy is there for everyone except kids: copy its label and link.
  const addDonate = () => {
    const nav = document.getElementById('topnav');
    const patron = nav?.querySelector('a.community-patron');
    if (!patron || document.getElementById('cdc-donate')) return;
    const donate = document.createElement('a');
    donate.id = 'cdc-donate';
    donate.href = patron.href;
    donate.textContent = patron.textContent.trim();
    nav.after(donate);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addDonate);
  else addDonate();

  // The coach's face on a practice drill (styles/practice-run.css): the Game
  // Review's coach, kept by review.js under the same key, or picked at random
  // the first time.
  let coach = +localStorage.getItem('cdc-coach');
  if (!(coach >= 1 && coach <= 4)) {
    coach = 1 + Math.floor(Math.random() * 4);
    localStorage.setItem('cdc-coach', coach);
  }
  document.documentElement.dataset.cdcCoach = coach;

  // The FIDE players' and federations' rank (styles/fide.css) counts the rows
  // on the page, so a list opened on a later page (/fide?page=3) starts from
  // that page's first row, at 30 a page, and hands out no medals.
  const fidePage =
    /\/fide(\/federation)?$/.test(location.pathname) && +new URLSearchParams(location.search).get('page');
  if (fidePage > 1) {
    document.documentElement.dataset.cdcFideSkip = (fidePage - 1) * 30;
    document.documentElement.style.setProperty('--cdc-fide-skip', (fidePage - 1) * 30);
  }

  // The board's size (game.css, analysis.css, puzzle.css): as big as the
  // window allows, unless resized by hand. Lichess's own zoom pref may date
  // from its layout, so it's not used: a drag on the board's handle starts
  // from our size, and its `---zoom` on body is copied to `--cdc-zoom` and
  // kept under our own key. Dragged back to full, the key goes.
  const ZOOM_KEY = 'cdc-board-zoom';
  const setZoom = z => {
    if (z >= 100) document.documentElement.style.removeProperty('--cdc-zoom');
    else document.documentElement.style.setProperty('--cdc-zoom', z);
  };
  const savedZoom = localStorage.getItem(ZOOM_KEY);
  if (savedZoom !== null) setZoom(+savedZoom);
  let zooming = null;
  const startZoom = e => {
    if (zooming || !e.target.closest?.('cg-resize')) return;
    // Capture phase: before Lichess's handler reads the zoom to start from.
    document.body.style.setProperty('---zoom', getComputedStyle(document.documentElement).getPropertyValue('--cdc-zoom') || 100);
    zooming = new MutationObserver(() => {
      const z = parseInt(document.body.style.getPropertyValue('---zoom'));
      if (!(z >= 0)) return;
      setZoom(z);
      if (z >= 100) localStorage.removeItem(ZOOM_KEY);
      else localStorage.setItem(ZOOM_KEY, z);
      window.dispatchEvent(new Event('resize'));
    });
    zooming.observe(document.body, { attributes: true, attributeFilter: ['style'] });
    const stop = () => {
      zooming.disconnect();
      zooming = null;
    };
    document.addEventListener(e.type === 'touchstart' ? 'touchend' : 'mouseup', stop, { once: true });
  };
  document.addEventListener('mousedown', startZoom, true);
  document.addEventListener('touchstart', startZoom, { capture: true, passive: true });

  let sounds = null;

  const postSounds = () => {
    if (sounds) window.postMessage({ type: MSG_SOUNDS, sounds }, location.origin);
  };

  window.addEventListener('message', e => {
    if (e.source === window && e.data?.type === MSG_PAGE_READY) postSounds();
  });

  chrome.runtime.sendMessage({ type: 'cdc:get-sounds' }, res => {
    if (chrome.runtime.lastError || !res?.sounds || !Object.keys(res.sounds).length) return;
    sounds = res.sounds;
    postSounds();
  });

  // The right-hand panel stacks moves / controls / chat in fixed grid rows, so
  // the controls row height has to be definite. Measure it and expose it.
  let lastHeight = -1;
  const syncControlsHeight = () => {
    const main = document.querySelector('main.round, main.analyse');
    if (!main) return;
    const controls = main.querySelector('.rcontrols, .analyse__controls');
    const height = controls ? Math.ceil(controls.getBoundingClientRect().height) : 0;
    if (height !== lastHeight) {
      lastHeight = height;
      main.style.setProperty('--cdc-controls-h', height + 'px');
    }
  };
  // Chess.com-style captured pieces under each player's name: the opponent's
  // pieces that are no longer on the board, grouped by type, plus the lead.
  const START = { pawn: 8, knight: 2, bishop: 2, rook: 2, queen: 1 };
  // Variants that start with other pieces, per color. Crazyhouse shows none:
  // taken pieces change sides into the pockets, which show them.
  const VARIANT_START = {
    racingKings: { white: { ...START, pawn: 0 }, black: { ...START, pawn: 0 } },
    horde: { white: { pawn: 36, knight: 0, bishop: 0, rook: 0, queen: 0 }, black: START },
  };
  const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };
  const LETTER = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q' };
  const PIECES = 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/';
  const captured = { top: null, bottom: null };
  let lastCaptured = '';

  const group = (color, letter, n) => {
    const piece = `<img src="${PIECES}${color[0]}${letter}.png" alt="" draggable="false">`;
    return `<div class="cdc-captured__group">${piece.repeat(n)}</div>`;
  };
  const capturedHtml = (color, missing, lead, checks = 0) =>
    Object.keys(START)
      .filter(role => missing[role] > 0)
      .map(role => group(color, LETTER[role], missing[role]))
      .join('') +
    (checks > 0 ? group(color, 'k', checks) : '') +
    (lead > 0 ? `<span class="cdc-captured__score">+${lead}</span>` : '');

  const syncCaptured = () => {
    const main = document.querySelector('main.round, main.analyse');
    const wrap = main?.querySelector('.round__app__board .cg-wrap, .analyse__board > .cg-wrap');
    const board = wrap?.querySelector('cg-board');
    // On the analysis board, only under the players of a game.
    if (!board || (main.matches('.analyse') && !main.querySelector(':scope > .cdc-player'))) return;
    const onBoard = { white: {}, black: {} };
    const material = { white: 0, black: 0 };
    for (const p of board.querySelectorAll('piece:not(.ghost):not(.fading)')) {
      const color = p.classList.contains('white') ? 'white' : 'black';
      const role = Object.keys(START).find(r => p.classList.contains(r));
      if (!role) continue;
      onBoard[color][role] = (onBoard[color][role] || 0) + 1;
      material[color] += VALUE[role];
    }
    const bottomColor = wrap.classList.contains('orientation-black') ? 'black' : 'white';
    const topColor = bottomColor === 'white' ? 'black' : 'white';
    // The game page says the variant on its app, the analysis board on main.
    const variant = /\bvariant-(\w+)/.exec(main.querySelector('.round__app')?.className || main.className)?.[1];
    const start = color => VARIANT_START[variant]?.[color] || START;
    // A player shows the pieces of the other color that are gone.
    const missing = color =>
      Object.fromEntries(Object.keys(START).map(r => [r, Math.max(0, start(color)[r] - (onBoard[color][r] || 0))]));
    // Three-check: Lichess counts the checks a side gave as kings in its
    // material difference, which the bars hide. Kings of the other color,
    // like the pieces taken.
    const checks = side => (variant === 'threeCheck' ? main.querySelectorAll(`.material-${side} mpiece.king`).length : 0);
    const html =
      variant === 'crazyhouse'
        ? { top: '', bottom: '' }
        : {
            top: capturedHtml(bottomColor, missing(bottomColor), material[topColor] - material[bottomColor], checks('top')),
            bottom: capturedHtml(topColor, missing(topColor), material[bottomColor] - material[topColor], checks('bottom')),
          };
    for (const side of ['top', 'bottom']) {
      if (!captured[side] || captured[side].parentNode !== main) {
        captured[side] = document.createElement('div');
        captured[side].className = `cdc-captured cdc-captured--${side}`;
        main.appendChild(captured[side]);
        lastCaptured = '';
      }
    }
    const key = html.top + '|' + html.bottom;
    if (key === lastCaptured) return;
    lastCaptured = key;
    captured.top.innerHTML = html.top;
    captured.bottom.innerHTML = html.bottom;
  };

  // The analysis board's player bars, like the game page's (see
  // styles/playerbar.css). Lichess names the players only in the game info,
  // which analysis.css hides: each one is copied into a bar of our own, in
  // the markup of the round's `.ruser` so both pages share one style.
  const players = { top: null, bottom: null };
  let lastPlayers = '';

  const fillPlayer = (bar, source) => {
    const link = source?.querySelector('a.user-link');
    if (!link) {
      // Anonymous, or the computer.
      const name = document.createElement('name');
      name.textContent = source?.textContent.trim() || '';
      bar.replaceChildren(name);
      return;
    }
    const a = link.cloneNode(true);
    const rating = a.querySelector('.rating')?.textContent.replace(/[()\s]/g, '');
    const diff = a.querySelector('good, bad');
    a.querySelectorAll('.rating, good, bad').forEach(el => el.remove());
    // The title's badge has its own margin: drop the non-breaking space.
    for (const node of a.childNodes)
      if (node.nodeType === Node.TEXT_NODE) node.data = node.data.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');
    const parts = [a];
    if (rating) {
      const el = document.createElement('rating');
      el.textContent = rating;
      parts.push(el);
    }
    if (diff) parts.push(diff);
    bar.replaceChildren(...parts);
  };

  const syncPlayers = () => {
    const main = document.querySelector('main.analyse');
    const wrap = main?.querySelector('.analyse__board > .cg-wrap');
    const meta = main?.querySelector('.game__meta__players');
    if (!wrap || !meta || main.querySelector('.practice__side')) return;
    for (const side of ['top', 'bottom']) {
      if (!players[side] || players[side].parentNode !== main) {
        players[side] = document.createElement('div');
        players[side].className = `cdc-player cdc-player--${side}`;
        main.appendChild(players[side]);
        lastPlayers = '';
      }
    }
    // Flipping the board swaps them.
    const bottom = wrap.classList.contains('orientation-black') ? 'black' : 'white';
    const key = bottom + meta.innerHTML;
    if (key === lastPlayers) return;
    lastPlayers = key;
    fillPlayer(players.top, meta.querySelector(`.player.${bottom === 'white' ? 'black' : 'white'}`));
    fillPlayer(players.bottom, meta.querySelector(`.player.${bottom}`));
  };

  // Move times, like Chess.com once a game is over: the time spent on each
  // move, with a bar scaled to the longest think (see styles/game.css).
  // Lichess's round data has no clock history, so it comes from the export.
  // The move list is snabbdom's: only attributes are added, and they're put
  // back whenever it re-renders.
  const times = { id: null, spent: null, clock: null, tries: 0, loading: false, at: 0 };
  const formatSpent = cs => {
    const s = cs / 100;
    return s < 60 ? s.toFixed(1) + 's' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  // The game's id. TV plays its games at /tv/<channel>, so the path won't
  // do: the analysis button (there once a game is over) links to the game.
  const gameId = () => {
    const link = document.querySelector('main.round :is(i5d, rm6) a.analysis')?.getAttribute('href');
    return /^\/([A-Za-z0-9]{8})/.exec(link || location.pathname)?.[1] || null;
  };
  const loadTimes = async id => {
    times.loading = true;
    try {
      const res = await fetch(`/game/export/${id}?moves=false&clocks=true&evals=false&opening=false`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(res.status);
      const game = await res.json();
      if (times.id !== id) return;
      const clocks = game.clocks || [];
      const initial = (game.clock?.initial || 0) * 100, inc = (game.clock?.increment || 0) * 100;
      times.clock = game.clock || null;
      // Lichess's clock only starts after each side's first move.
      times.spent = clocks.map((c, i) => Math.max(0, i < 2 ? initial - c : clocks[i - 2] + inc - c));
    } catch {
      // Tried again below.
    } finally {
      times.loading = false;
      times.at = Date.now();
    }
  };
  const syncMoveTimes = () => {
    const result = document.querySelector('main.round .result-wrap');
    const list = result?.parentElement;
    const id = list && gameId();
    if (!id) return;
    if (times.id !== id) Object.assign(times, { id, spent: null, clock: null, tries: 0, at: 0 });
    // The list starts with a move number; the moves are the other tag.
    const indexTag = list.firstElementChild?.tagName;
    const moves = [...list.children].filter(m => m.tagName !== indexTag && m !== result && !m.classList.contains('empty'));
    // Right after the game ends, the export can fail or lag the last move:
    // try again, a second apart. A game without a clock has no times.
    const missing = !times.spent || (times.clock && times.spent.length < moves.length);
    if (missing && !times.loading && times.tries < 5 && Date.now() - times.at > 1000) {
      times.tries++;
      loadTimes(id);
    }
    const spent = times.spent;
    if (!spent?.length) return;
    const max = Math.max(...spent) || 1;
    moves.forEach((m, i) => {
      if (spent[i] == null) return;
      const label = formatSpent(spent[i]);
      if (m.dataset.cdcTime === label) return;
      m.dataset.cdcTime = label;
      m.style.setProperty('--cdc-time', (spent[i] / max).toFixed(3));
    });
    list.dataset.cdcTimes = '';
  };

  // Chess.com's "New 10 min" next to Rematch. Lichess only offers "New
  // opponent" for lobby and pool games; otherwise add a button doing what it
  // does, a lobby seek like this game (`/?hook_like=<id>`). Either one gets
  // the time control as its label. The clock comes with the move times.
  // Short, as Chess.com's: it gets half a narrow panel. Where it has to wrap,
  // the time control stays in one piece: no-break spaces, and a word joiner
  // after the bar, which lines may otherwise break after.
  const newGameLabel = clock => {
    const min = +(clock.initial / 60).toFixed(2);
    const tc = (clock.increment ? `${min} | ${clock.increment}` : clock.initial < 60 ? `${clock.initial} s` : `${min} min`)
      .replace(/ /g, '\u00a0')
      .replace('|', '|\u2060');
    return (document.documentElement.lang || '').startsWith('fr') ? `Nouvelle ${tc}` : `New ${tc}`;
  };
  const syncNewGame = () => {
    const follow = document.querySelector('main.round .rcontrols .follow-up');
    if (!follow || !times.clock) return;
    const label = newGameLabel(times.clock);
    const lichess = follow.querySelector('.new-opponent');
    if (lichess) {
      if (lichess.dataset.cdcLabel !== label) lichess.dataset.cdcLabel = label;
      return;
    }
    // Players only: a spectator's follow-up has no rematch button.
    if (!follow.querySelector('.rematch') || follow.querySelector('.cdc-new-game')) return;
    const a = document.createElement('a');
    a.className = 'fbt cdc-new-game';
    a.href = `/?hook_like=${times.id}`;
    a.textContent = label;
    follow.prepend(a);
  };

  // Country flags in the player bars, like Chess.com. The round data has no
  // country, so it comes from the players' profiles (`/api/users` takes a
  // batch of names), as an emoji. The bar is snabbdom's: the flag is an
  // attribute shown by CSS, put back whenever the bar is re-rendered.
  const flags = new Map();
  const SPECIAL_FLAGS = {
    'GB-ENG': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'GB-SCT': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    'GB-WLS': '🏴󠁧󠁢󠁷󠁬󠁳󠁿',
    _rainbow: '🏳️‍🌈',
    _transgender: '🏳️‍⚧️',
    _pirate: '🏴‍☠️',
    '_united-nations': '🇺🇳',
    _earth: '🌍',
  };
  // Two letters are regional indicators; anything else without an emoji
  // (Lichess's own flag, regions) shows nothing.
  const flagEmoji = code =>
    SPECIAL_FLAGS[code] ||
    (/^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map(c => 0x1f1a5 + c.charCodeAt(0))) : '');
  const loadFlags = async names => {
    names.forEach(n => flags.set(n, null));
    try {
      const res = await fetch('/api/users', { method: 'POST', body: names.join(',') });
      const users = await res.json();
      names.forEach(n => flags.set(n, ''));
      for (const u of users) flags.set(u.id, flagEmoji(u.profile?.flag));
    } catch {
      names.forEach(n => flags.set(n, ''));
    }
  };
  const syncFlags = () => {
    const bars = [...document.querySelectorAll('main.round .ruser, main.analyse > .cdc-player')];
    const nameOf = bar => bar.querySelector('a.user-link')?.pathname.split('/').pop().toLowerCase();
    const missing = bars.map(nameOf).filter(n => n && !flags.has(n));
    if (missing.length) loadFlags(missing);
    for (const bar of bars) {
      const flag = flags.get(nameOf(bar)) || '';
      if ((bar.dataset.cdcFlag || '') !== flag) bar.dataset.cdcFlag = flag;
    }
  };

  // Chessground shrinks the board to whole pixels per square and leaves the
  // remainder as an inset inside its wrapper. Expose it so the player bars and
  // the eval bar line up with the squares, not the wrapper.
  let lastInset = '';
  const syncBoardInset = () => {
    const main = document.querySelector('main.round, main.analyse');
    const container = main?.querySelector('.main-board cg-container');
    const wrap = container?.closest('.cg-wrap');
    if (!wrap) return;
    const c = container.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    const inset = [c.top - w.top, w.right - c.right, w.bottom - c.bottom, c.left - w.left].map(v => Math.max(0, Math.round(v)));
    const key = inset.join(',');
    if (key === lastInset) return;
    lastInset = key;
    ['t', 'r', 'b', 'l'].forEach((side, i) => main.style.setProperty(`--cdc-inset-${side}`, inset[i] + 'px'));
  };

  // Lichess's eval bar, Game Review-style (styles/board.css): its score, read
  // from the engine line, written like Chess.com's ("1.2", "M3") at the
  // leading side's end. And the puzzle's session chips, one sideways-scrolling
  // row: keep the latest in view.
  let lastChips = 0;
  const syncPuzzle = () => {
    const main = document.querySelector('main.puzzle, main.analyse');
    if (!main) return;
    const gauge = main.querySelector('.eval-gauge');
    if (gauge) {
      const score = (main.querySelector('.ceval pearl')?.textContent || '').trim();
      const m = /^(#)?([+\-−])?(\d+(?:\.\d+)?)$/.exec(score);
      const label = m ? (m[1] ? 'M' : '') + m[3] : '';
      const lead = m && (m[2] === '-' || m[2] === '−') ? 'black' : 'white';
      if ((gauge.dataset.cdcEval || '') !== label) gauge.dataset.cdcEval = label;
      if (gauge.dataset.cdcLead !== lead) gauge.dataset.cdcLead = lead;
    }
    const session = main.querySelector('.puzzle__session');
    const chips = session?.childElementCount || 0;
    if (chips !== lastChips) {
      lastChips = chips;
      if (session) session.scrollLeft = session.scrollWidth;
    }
  };

  // Home page hero card (see styles/home.css), in the page's language: the
  // ones home.css also names the cards and speeds in, English otherwise.
  const HERO_TEXTS = {
    en: {
      eyebrow: 'Free · No ads · Open source',
      title: 'Play chess online',
      titleUser: 'Ready to play, {name}?',
      sub: 'Take on thousands of players worldwide, solve puzzles and improve, completely free.',
    },
    fr: {
      eyebrow: 'Gratuit · Sans publicité · Open source',
      title: 'Jouer aux échecs en ligne',
      titleUser: 'Prêt pour une partie, {name} ?',
      sub: 'Affrontez des milliers de joueurs du monde entier, résolvez des problèmes et progressez, entièrement gratuitement.',
    },
    de: {
      eyebrow: 'Kostenlos · Werbefrei · Open Source',
      title: 'Schach online spielen',
      titleUser: 'Bereit für eine Partie, {name}?',
      sub: 'Spiele gegen Tausende Gegner aus aller Welt, löse Aufgaben und werde besser, völlig kostenlos.',
    },
    es: {
      eyebrow: 'Gratis · Sin anuncios · Código abierto',
      title: 'Juega al ajedrez en línea',
      titleUser: '¿Listo para jugar, {name}?',
      sub: 'Enfréntate a miles de jugadores de todo el mundo, resuelve problemas y mejora, totalmente gratis.',
    },
    pt: {
      eyebrow: 'Grátis · Sem anúncios · Código aberto',
      title: 'Jogue xadrez online',
      titleUser: 'Pronto para jogar, {name}?',
      sub: 'Enfrente milhares de jogadores do mundo todo, resolva problemas e evolua, totalmente grátis.',
    },
  };
  const HERO_TEXT = HERO_TEXTS[(document.documentElement.lang || '').slice(0, 2)] || HERO_TEXTS.en;
  const syncHero = () => {
    const main = document.querySelector('main.lobby');
    if (!main || main.querySelector(':scope > .cdc-hero')) return;
    const user = document.body.dataset.user;
    const hero = document.createElement('section');
    hero.className = 'cdc-hero';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'cdc-hero__eyebrow';
    eyebrow.textContent = HERO_TEXT.eyebrow;
    const title = document.createElement('h1');
    title.className = 'cdc-hero__title';
    title.textContent = user ? HERO_TEXT.titleUser.replace('{name}', user) : HERO_TEXT.title;
    const sub = document.createElement('p');
    sub.className = 'cdc-hero__sub';
    sub.textContent = HERO_TEXT.sub;
    hero.append(eyebrow, title, sub);
    main.prepend(hero);
  };

  // Coach cards (see styles/coach.css): Lichess writes the title as plain text
  // in the name ("FM Hans Renette"). Chess.com shows it as a badge. The
  // picture's alt starts with the title, which catches names without one.
  // Pages are server-rendered (and appended by infinite scroll), not snabbdom,
  // so editing the name's text is safe.
  const TITLES = new Set(['GM', 'IM', 'FM', 'CM', 'NM', 'WGM', 'WIM', 'WFM', 'WCM', 'WNM', 'LM', 'BOT']);
  const syncCoachTitles = () => {
    for (const name of document.querySelectorAll('.coach-widget .coach-name:not([data-cdc-title])')) {
      const title = name.closest('.coach-widget').querySelector('img.picture')?.alt.split(' ')[0];
      name.dataset.cdcTitle = TITLES.has(title) ? title : '';
      if (!name.dataset.cdcTitle) continue;
      const text = name.firstChild;
      if (text?.nodeType === Node.TEXT_NODE && text.data.startsWith(title + ' '))
        text.data = text.data.slice(title.length + 1);
      const badge = document.createElement('span');
      badge.className = 'cdc-coach-title';
      badge.textContent = title;
      name.prepend(badge);
    }
  };

  // Swiss tournaments (see styles/swiss.css, swiss-show.css): a tournament's
  // rounds ("5/10 rounds", digits in every language) as a progress bar, on
  // the home's cards and in a tournament's info panel, where the bar spans
  // the paragraph around the count. Both are server-rendered, so styling
  // Lichess's elements is safe. A tournament's page rewrites its count in
  // place when a round starts, so the count read last is kept, not a flag.
  const syncSwissRounds = () => {
    const counts = document.querySelectorAll('.swiss-home .swisses .rounds, main.swiss .swiss__meta__round');
    for (const rounds of counts) {
      const text = rounds.textContent;
      if (rounds.dataset.cdcRounds === text) continue;
      rounds.dataset.cdcRounds = text;
      const m = text.match(/(\d+)\s*\/\s*(\d+)/);
      const bar = rounds.matches('.swiss__meta__round') ? rounds.parentElement : rounds;
      if (m && +m[2]) bar.style.setProperty('--cdc-progress', Math.min(100, (100 * m[1]) / m[2]) + '%');
    }
  };

  // A Swiss tournament from 1260px (see styles/swiss-show.css): the page
  // doesn't scroll, its middle column does. Page keys act on the focused
  // scroller, so the column takes the focus once, unless something has it.
  const syncSwissFocus = () => {
    const column = document.querySelector('main.swiss .swiss__main:not([tabindex])');
    if (!column || !matchMedia('(min-width: 1260px)').matches) return;
    column.tabIndex = -1;
    if (document.activeElement === document.body) column.focus({ preventScroll: true });
  };

  // A Swiss tournament's standings (see styles/swiss-show.css): the leaders'
  // ranks in medal colors. CSS can't tell which page of the standings it's
  // on (the pager's buttons go while searching), so the rank's own text
  // says. Rows are keyed by player and re-ranked live, hence every tick.
  const syncSwissMedals = () => {
    for (const rank of document.querySelectorAll('main.swiss .swiss__standing td.rank')) {
      const text = rank.textContent.trim();
      const medal = text === '1' || text === '2' || text === '3' ? text : null;
      if (medal && rank.dataset.cdcMedal !== medal) rank.dataset.cdcMedal = medal;
      else if (!medal && 'cdcMedal' in rank.dataset) delete rank.dataset.cdcMedal;
    }
  };

  // Lichess TV (see styles/tv.css): the channels' column scrolls on its
  // own, so the channel on air is scrolled into view, once it has a height.
  // Below 1260px it shows the tiles alone: each one's name and champion go
  // in its tooltip. Server-rendered, and TV reloads for its next game.
  const syncTvChannels = () => {
    const list = document.querySelector('main.tv-single .subnav__inner:not([data-cdc-tv])');
    if (!list?.clientHeight) return;
    list.dataset.cdcTv = '';
    for (const a of list.querySelectorAll('a.tv-channel')) {
      const name = a.querySelector('strong')?.textContent.trim();
      const champion = a.querySelector('.champion')?.textContent.replace(/\s+/g, ' ').trim();
      if (name) a.dataset.cdcTip = champion ? `${name} · ${champion}` : name;
    }
    const active = list.querySelector('a.tv-channel.active');
    if (active) list.scrollTop = active.offsetTop - (list.clientHeight - active.offsetHeight) / 2;
  };

  // Forum index (see styles/forum.css): the categories become cards and
  // their table header goes, so each count gets its column's name ("Topics",
  // "Posts", translated) to show as a label. Server-rendered, so it's safe.
  const syncForumLabels = () => {
    for (const table of document.querySelectorAll('main.forum table.categs:not([data-cdc-labels])')) {
      table.dataset.cdcLabels = '';
      const names = [...(table.tHead?.rows[0]?.cells || [])].map(th => th.textContent.trim());
      for (const row of table.tBodies[0]?.rows || [])
        for (const td of row.cells) if (names[td.cellIndex]) td.dataset.cdcLabel = names[td.cellIndex];
    }
  };

  // Profile hover card (see styles/powertip.css): Lichess right-aligns the
  // eight ratings in fixed columns by padding the short ones with non-breaking
  // spaces ("&nbsp;&nbsp;&nbsp;?"). Our chips center their value, so the
  // padding has to go, and an unrated chip is dimmed instead of left blank.
  // Lichess rebuilds the card's HTML on every hover, so an observer catches it
  // before the paint: polling would show the padded value first.
  const cleanRatings = tip => {
    for (const span of tip.querySelectorAll('.upt__info__ratings > span')) {
      const text = span.textContent.replace(/\u00a0/g, '').trim();
      if (span.textContent !== text) span.textContent = text;
      span.dataset.cdcRating = text === '?' || text === '-' ? 'none' : 'rated';
    }
  };
  // Lichess picks the card's side (below, above, beside the name) from its
  // size when placed, and keeps the last side tried when none fits. Our card
  // is taller than Lichess's, and grows once placed (a player in a game gets
  // a mini board, drawn afterwards), so it can hang past the window's edge.
  // Pull it back in: below the name, else above, else against the edge.
  const TIP_MARGIN = 8;
  let tipAnchor = null;
  document.addEventListener('mouseover', e => {
    const anchor = e.target.closest?.('a, [data-href]');
    if (anchor && !anchor.closest('#powerTip')) tipAnchor = anchor;
  }, true);
  const fitPowertip = tip => {
    if (getComputedStyle(tip).visibility !== 'visible') return;
    const r = tip.getBoundingClientRect();
    const maxTop = innerHeight - TIP_MARGIN - r.height, maxLeft = innerWidth - TIP_MARGIN - r.width;
    if (r.top >= TIP_MARGIN && r.top <= maxTop && r.left >= TIP_MARGIN && r.left <= maxLeft) return;
    let top = Math.max(TIP_MARGIN, Math.min(r.top, maxTop));
    const a = tipAnchor?.isConnected && tipAnchor.getBoundingClientRect();
    // Above or below the name (not beside it): stay clear of it if possible.
    if (a && r.left < a.right && r.right > a.left) {
      if (a.bottom + 10 <= maxTop) top = a.bottom + 10;
      else if (a.top - 10 - r.height >= TIP_MARGIN) top = a.top - 10 - r.height;
    }
    const left = Math.max(TIP_MARGIN, Math.min(r.left, maxLeft));
    tip.style.top = (parseFloat(tip.style.top) || 0) + top - r.top + 'px';
    tip.style.left = (parseFloat(tip.style.left) || 0) + left - r.left + 'px';
  };
  let watchedTip = null;
  const syncPowertip = () => {
    // Lichess only adds #powerTip on the first hover (or on idle, on the pages
    // that preload the cards).
    const tip = document.getElementById('powerTip');
    if (!tip || tip === watchedTip) return;
    watchedTip = tip;
    new MutationObserver(records => {
      if (records.some(r => r.type === 'childList')) cleanRatings(tip);
      fitPowertip(tip);
    }).observe(tip, { childList: true, attributes: true, attributeFilter: ['style'] });
    new ResizeObserver(() => fitPowertip(tip)).observe(tip);
    cleanRatings(tip);
  };

  // Chess.com-style tooltips on the page's buttons (see styles/theme.css),
  // instead of the browser's slow, unstyled `title`. On hover the title moves
  // to `data-cdc-tip`, so the native one never shows. Snabbdom only sets the
  // title again if it changes, and the next hover moves it again.
  const tooltip = document.createElement('div');
  tooltip.className = 'cdc-tooltip';
  tooltip.setAttribute('aria-hidden', 'true');
  let tooltipFor = null, tooltipTimer = 0, tooltipHiddenAt = 0;
  const hideTooltip = () => {
    clearTimeout(tooltipTimer);
    if (tooltipFor && tooltip.classList.contains('cdc-tooltip--on')) tooltipHiddenAt = Date.now();
    tooltipFor = null;
    tooltip.classList.remove('cdc-tooltip--on');
  };
  const showTooltip = el => {
    const text = el.dataset.cdcTip;
    const key = text.match(/^(.*\S)\s*\((\S)\)$/);
    tooltip.textContent = key ? key[1] : text;
    if (key) tooltip.appendChild(document.createElement('kbd')).textContent = key[2];
    if (!tooltip.isConnected) document.body.appendChild(tooltip);
    const a = el.getBoundingClientRect(), t = tooltip.getBoundingClientRect();
    const below = a.top - 8 - t.height < TIP_MARGIN;
    const left = Math.max(TIP_MARGIN, Math.min(a.left + a.width / 2 - t.width / 2, innerWidth - TIP_MARGIN - t.width));
    tooltip.dataset.side = below ? 'below' : 'above';
    tooltip.style.top = (below ? a.bottom + 8 : a.top - 8 - t.height) + 'px';
    tooltip.style.left = left + 'px';
    tooltip.style.setProperty('--cdc-tooltip-arrow', `${a.left + a.width / 2 - left}px`);
    tooltip.classList.add('cdc-tooltip--on');
  };
  document.addEventListener('mouseover', e => {
    let el = e.target.closest?.('main :is(button:is([title], [data-cdc-tip]), a.tv-channel[data-cdc-tip])');
    // TV's channels only need theirs while their names are hidden (tv.css).
    if (el?.matches('a') && !matchMedia('(max-width: 1259.98px)').matches) el = null;
    if (el === tooltipFor) return;
    hideTooltip();
    if (!el) return;
    if (el.title) {
      el.dataset.cdcTip = el.title;
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title);
      el.removeAttribute('title');
    }
    if (!el.dataset.cdcTip) return;
    tooltipFor = el;
    // A short wait before the first one, none when going from button to button.
    tooltipTimer = setTimeout(() => showTooltip(el), Date.now() - tooltipHiddenAt < 400 ? 0 : 250);
  }, true);
  document.addEventListener('mouseout', e => e.relatedTarget || hideTooltip());
  document.addEventListener('pointerdown', hideTooltip, true);
  document.addEventListener('scroll', hideTooltip, true);
  const syncTooltip = () => {
    // Snabbdom replaced the button under the pointer.
    if (tooltipFor && !tooltipFor.isConnected) hideTooltip();
  };

  setInterval(() => {
    syncControlsHeight();
    syncPlayers();
    syncCaptured();
    syncMoveTimes();
    syncNewGame();
    syncFlags();
    syncBoardInset();
    syncPuzzle();
    syncHero();
    syncCoachTitles();
    syncSwissRounds();
    syncSwissMedals();
    syncSwissFocus();
    syncForumLabels();
    syncTvChannels();
    syncPowertip();
    syncTooltip();
  }, 250);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncHero);
  else syncHero();

  // Unpacked only: when the tab gets focus, ask the background worker whether
  // the files on disk changed (a ship pulled main). If so it reloads the
  // extension, and the tab reloads once the new version is in.
  if (!('update_url' in chrome.runtime.getManifest())) {
    const reloadWhenOrphaned = () => {
      const wait = setInterval(() => {
        if (chrome.runtime?.id) return;
        clearInterval(wait);
        setTimeout(() => location.reload(), 250);
      }, 100);
    };
    const checkForUpdate = () => {
      if (document.visibilityState !== 'visible') return;
      // Orphaned by an extension reload started from another tab.
      if (!chrome.runtime?.id) return location.reload();
      chrome.runtime.sendMessage({ type: 'cdc:dev-check' }).then(
        res => res?.reload && reloadWhenOrphaned(),
        () => {},
      );
    };
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);
    checkForUpdate();
  }
})();
