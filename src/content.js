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
  const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };
  const LETTER = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q' };
  const PIECES = 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/';
  const captured = { top: null, bottom: null };
  let lastCaptured = '';

  const capturedHtml = (color, missing, lead) =>
    Object.keys(START)
      .filter(role => missing[role] > 0)
      .map(role => {
        const img = `${PIECES}${color[0]}${LETTER[role]}.png`;
        const piece = `<img src="${img}" alt="" draggable="false">`;
        return `<div class="cdc-captured__group">${piece.repeat(missing[role])}</div>`;
      })
      .join('') + (lead > 0 ? `<span class="cdc-captured__score">+${lead}</span>` : '');

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
    // A player shows the pieces of the other color that are gone.
    const missing = color =>
      Object.fromEntries(Object.keys(START).map(r => [r, Math.max(0, START[r] - (onBoard[color][r] || 0))]));
    const html = {
      top: capturedHtml(bottomColor, missing(bottomColor), material[topColor] - material[bottomColor]),
      bottom: capturedHtml(topColor, missing(topColor), material[bottomColor] - material[topColor]),
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
  const times = { id: null, spent: null, tries: 0, loading: false };
  const formatSpent = cs => {
    const s = cs / 100;
    return s < 60 ? s.toFixed(1) + 's' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const loadTimes = async id => {
    times.loading = true;
    try {
      const res = await fetch(`/game/export/${id}?moves=false&clocks=true&evals=false&opening=false`, {
        headers: { Accept: 'application/json' },
      });
      const game = await res.json();
      const clocks = game.clocks || [];
      const initial = (game.clock?.initial || 0) * 100, inc = (game.clock?.increment || 0) * 100;
      times.clock = game.clock || null;
      // Lichess's clock only starts after each side's first move.
      times.spent = clocks.map((c, i) => Math.max(0, i < 2 ? initial - c : clocks[i - 2] + inc - c));
    } catch {
      times.spent = [];
    }
    times.loading = false;
  };
  const syncMoveTimes = () => {
    const result = document.querySelector('main.round .result-wrap');
    const list = result?.parentElement;
    if (!list) return;
    const id = location.pathname.slice(1, 9);
    if (times.id !== id) Object.assign(times, { id, spent: null, clock: null, tries: 0 });
    // The list starts with a move number; the moves are the other tag.
    const indexTag = list.firstElementChild?.tagName;
    const moves = [...list.children].filter(m => m.tagName !== indexTag && m !== result && !m.classList.contains('empty'));
    // Right after the game ends, the export can lag the last move: retry.
    if (!times.loading && (!times.spent || (times.spent.length < moves.length && times.spent.length && times.tries < 5))) {
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
  const newGameLabel = clock => {
    const min = +(clock.initial / 60).toFixed(2);
    const tc = clock.increment ? `${min} | ${clock.increment}` : clock.initial < 60 ? `${clock.initial} s` : `${min} min`;
    return (document.documentElement.lang || '').startsWith('fr') ? `Nouvelle en ${tc}` : `New ${tc}`;
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

  // Home page hero card (see styles/home.css).
  const HERO_TEXT = (document.documentElement.lang || '').startsWith('fr')
    ? {
        eyebrow: 'Gratuit · Sans publicité · Open source',
        title: 'Jouer aux échecs en ligne',
        titleUser: 'Prêt pour une partie, {name} ?',
        sub: 'Affrontez des milliers de joueurs du monde entier, résolvez des problèmes et progressez, entièrement gratuitement.',
      }
    : {
        eyebrow: 'Free · No ads · Open source',
        title: 'Play chess online',
        titleUser: 'Ready to play, {name}?',
        sub: 'Take on thousands of players worldwide, solve puzzles and improve, completely free.',
      };
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
    syncPowertip();
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
