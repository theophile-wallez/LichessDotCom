// Isolated-world content script.
// 1. Gets the Chess.com sounds from the background worker and forwards them to
//    the page-world script (page.js), which hooks Lichess's sound player.
// 2. Keeps a CSS variable in sync with the height of the game controls, which
//    the game layout grid needs (see styles/game.css).
// 3. Renders Chess.com-style captured pieces in the game page's player bars.
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
    const main = document.querySelector('main.round');
    const wrap = main?.querySelector('.round__app__board .cg-wrap');
    const board = wrap?.querySelector('cg-board');
    if (!board) return;
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

  setInterval(() => {
    syncControlsHeight();
    syncCaptured();
    syncBoardInset();
    syncHero();
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
