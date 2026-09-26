// Page-world script: Chess.com-style "Game Review" on Lichess analysis pages.
//
// - Runs Lichess's own Stockfish 19 build (the one its analysis board uses) on
//   every mainline position, with MultiPV 2, and caches the results per game.
//   Lichess's cloud gives the opening's positions for free; a quick pass (or
//   the game's server analysis) draws the graph within seconds; the move on
//   the board goes first, so the review can start at once, each move judged
//   as soon as its positions are in.
// - Classifies each move like Chess.com (book, brilliant, great, best,
//   excellent, good, inaccuracy, mistake, miss, blunder) from win-probability
//   loss, and computes per-player accuracy.
// - Renders a summary panel (graph, accuracy, counts), shown until the user
//   moves; then a move-by-move review (coach bubble, explain / best / next,
//   move list badges, graph, controls), board annotations (badge, colored squares,
//   best-move arrow) and a Chess.com eval bar.
//
// On the free analysis board (/analysis) there's no game to review: the
// coach judges each move as it's played instead, variations included, with
// the same badges on the board and in the move list (see "live"). The review
// judges the same way the moves played off the game, which its move list
// shows as variations, like Chess.com's.
//
// Navigation and state go through `site.analysis` (Lichess's AnalyseCtrl).

(() => {
  const GAME = /^\/[a-zA-Z0-9]{8}(?:[a-zA-Z0-9]{4})?(?:\/(?:white|black))?\/?$/;
  if (!GAME.test(location.pathname) && !/^\/analysis(?:\/|$)/.test(location.pathname)) return;

  const ENGINE = { root: 'npm/stockfish-web', js: 'sf_19_smallnet.js', depth: 16, movetime: 1500 };
  // The graph's first draft: enough to show the game's trend, in seconds.
  const QUICK = { depth: 12, movetime: 500 };
  const CACHE_VERSION = 1;

  // ------------------------------------------------------------ i18n ---

  const fr = (document.documentElement.lang || '').startsWith('fr');
  const T = fr
    ? {
        review: 'Bilan', start: 'Démarrer le bilan', next: 'Suivant', explain: 'Expliquer', best: 'Meilleur',
        analysing: 'Analyse de la partie…', players: 'Joueurs', accuracy: 'Précision',
        anonymous: 'Anonyme', close: 'Fermer le bilan', back: 'Retour', coach: 'Changer de coach',
        intro: 'Passons en revue cette partie !', bestWas: 'Le meilleur coup était {m}.',
        engineError: "Le moteur n'a pas pu démarrer.",
        liveIntro: 'Joue un coup, je te dirai ce que j’en pense.', thinking: 'Voyons ce coup…',
        startPosition: 'Position de départ', more: 'Voir tous les coups', less: 'Voir moins',
        gameRating: 'Classement de la partie', gameRatingTip: 'Donne une estimation du classement d’un joueur d’après une seule partie.',
        phases: { o: 'Ouverture', t: 'Exercices tactiques', s: 'Stratégie', e: 'Finale' },
      }
    : {
        review: 'Game Review', start: 'Start Review', next: 'Next', explain: 'Explain', best: 'Best',
        analysing: 'Analyzing game…', players: 'Players', accuracy: 'Accuracy',
        anonymous: 'Anonymous', close: 'Close review', back: 'Back', coach: 'Change coach',
        intro: "Let's review this game!", bestWas: '{m} was best.',
        engineError: 'The engine failed to start.',
        liveIntro: 'Play a move and I’ll tell you what I think.', thinking: 'Let me look at this move…',
        startPosition: 'Starting position', more: 'Show all moves', less: 'Show less',
        gameRating: 'Game Rating', gameRatingTip: 'An estimate of a player’s rating based on a single game.',
        phases: { o: 'Opening', t: 'Tactics', s: 'Strategy', e: 'Endgame' },
      };

  // What the coach says while the game is analyzed, like Chess.com.
  const QUOTES = fr
    ? [
        '« Moins il y a de pièces sur l’échiquier, plus un pion passé gagne en puissance. » – José Raúl Capablanca',
        '« Les fautes sont là, sur l’échiquier, attendant d’être commises. » – Savielly Tartakower',
        '« Personne n’a jamais gagné une partie en abandonnant. » – Savielly Tartakower',
        '« La menace est plus forte que son exécution. » – Aron Nimzowitsch',
        '« Entre l’ouverture et la finale, les dieux ont placé le milieu de partie. » – Siegbert Tarrasch',
      ]
    : [
        '"The passed pawn increases in strength as the number of pieces on the board diminishes." – José Raúl Capablanca',
        '"The mistakes are there, waiting to be made." – Savielly Tartakower',
        '"No one ever won a game by resigning." – Savielly Tartakower',
        '"The threat is stronger than the execution." – Aron Nimzowitsch',
        '"Between the opening and the end game, the gods have placed the middle game." – Siegbert Tarrasch',
      ];
  const QUOTE = QUOTES[Math.floor(Math.random() * QUOTES.length)];

  // The coach's face, one of img/coaches/coach-<n>.webp (set by review.css).
  // Picked at random the first time, then kept; clicking it picks the next.
  const COACHES = 4;
  let coach = +localStorage.getItem('cdc-coach');
  if (!(coach >= 1 && coach <= COACHES)) {
    coach = 1 + Math.floor(Math.random() * COACHES);
    localStorage.setItem('cdc-coach', coach);
  }
  // The coach's face shows the verdict: a mood per class, played by
  // coach.js (the isolated world, where the extension's files are in reach)
  // with the rig of coach-lottie.js, which also has the coach talk while the
  // comment types out. Its marks over the head (review.css) pop up once per
  // move, not again when the same move is re-rendered (Explain, a new
  // coach). `at` names the move: its ply, or its path.
  const MOODS = {
    brilliant: 'delight', great: 'delight', best: 'happy', excellent: 'happy',
    inaccuracy: 'doubt', mistake: 'worry', miss: 'worry', blunder: 'shock',
  };
  let reacted = '';
  const coachAvatar = (cls, at) => {
    const mood = MOODS[cls] || '';
    const key = mood && `${at}|${cls}`;
    const react = key && key !== reacted;
    reacted = key;
    return `<button class="cdc-coach__avatar${react ? ' cdc-coach__avatar--react' : ''}" data-cdc="coach" data-coach="${coach}" data-mood="${mood || 'neutral'}"${mood ? ` style="--cdc-mood-c:${CLS[cls].color}"` : ''} title="${esc(T.coach)}" aria-label="${esc(T.coach)}"><span class="cdc-coach__face"></span></button>`;
  };
  // The panel is re-rendered on every change (every percent of the analysis
  // even), but the coach is one element, kept: a new render only hands it
  // the new mood, so its animation carries on instead of starting over.
  let avatar = null;
  function keepAvatar() {
    const fresh = dom.panel.querySelector('.cdc-coach__avatar');
    if (!fresh) return;
    if (avatar && avatar !== fresh) {
      for (const a of ['data-coach', 'data-mood', 'style'])
        if (fresh.hasAttribute(a)) avatar.setAttribute(a, fresh.getAttribute(a));
        else avatar.removeAttribute(a);
      avatar.classList.remove('cdc-coach__avatar--react');
      if (fresh.classList.contains('cdc-coach__avatar--react')) {
        void avatar.offsetWidth; // restart the marks' animation
        avatar.classList.add('cdc-coach__avatar--react');
      }
      fresh.replaceWith(avatar);
    } else avatar = fresh;
    tellCoach();
  }
  const tellCoach = () => {
    if (avatar?.isConnected)
      window.postMessage({ cdc: 'coach', coach: +avatar.dataset.coach, mood: avatar.dataset.mood, talking: !!stream.timer }, '*');
  };

  // key, color, label, sentence ({m} = move), in Chess.com's summary order.
  const CLASSES = [
    ['brilliant', '#26c2a3', fr ? 'Brillant' : 'Brilliant', fr ? '{m} est brillant !' : '{m} is brilliant!'],
    ['great', '#749bbf', fr ? 'Excellent' : 'Great', fr ? '{m} est un excellent coup' : '{m} is a great move'],
    ['book', '#d5a47d', fr ? 'Théorique' : 'Book', fr ? '{m} est un coup théorique' : '{m} is a book move'],
    ['best', '#81b64c', fr ? 'Meilleur' : 'Best', fr ? '{m} est le meilleur coup' : '{m} is best'],
    ['excellent', '#81b64c', fr ? 'Très bien' : 'Excellent', fr ? '{m} est très bien' : '{m} is excellent'],
    ['good', '#95b776', fr ? 'Bon' : 'Good', fr ? '{m} est bon' : '{m} is good'],
    ['inaccuracy', '#f7c631', fr ? 'Imprécision' : 'Inaccuracy', fr ? '{m} est une imprécision' : '{m} is an inaccuracy'],
    ['mistake', '#ffa459', fr ? 'Erreur' : 'Mistake', fr ? '{m} est une erreur' : '{m} is a mistake'],
    ['miss', '#ff7769', fr ? 'Manqué' : 'Miss', fr ? '{m} est un coup manqué' : '{m} is a miss'],
    ['blunder', '#fa412d', fr ? 'Gaffe' : 'Blunder', fr ? '{m} est une gaffe' : '{m} is a blunder'],
  ].map(([key, color, label, sentence]) => ({ key, color, label, sentence }));
  const CLS = Object.fromEntries(CLASSES.map(c => [c.key, c]));
  // The counts shown over the Game Review button, like Chess.com.
  const COUNTED = ['brilliant', 'great', 'best'];
  const countLabel = (key, n) =>
    fr
      ? `${n} ${{ brilliant: n > 1 ? 'coups brillants' : 'coup brillant', great: n > 1 ? 'excellents coups' : 'excellent coup', best: n > 1 ? 'meilleurs coups' : 'meilleur coup' }[key]}`
      : `${n} ${CLS[key].label}`;
  // The summary's rows before its chevron is opened, like Chess.com: the
  // standouts and the errors. A brilliant move joins them when there is one.
  const SUMMARY_ROWS = new Set(['great', 'best', 'excellent', 'mistake', 'miss', 'blunder']);
  const GRAPH_DOTS = new Set(['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder']);
  // Move list badges; book only on the last book move, like Chess.com.
  const LIST_BADGES = new Set([...GRAPH_DOTS, 'book']);
  // Moves that need no correction: no best-move arrow or button.
  const GOOD = new Set(['brilliant', 'great', 'best', 'book']);

  // Chess.com's own icons: a shadowed circle, and white glyphs whose shadow is
  // the same glyphs half a unit lower.
  const ICONS = {
    brilliant: [
      'M12.57,14.1a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0L10,14.34A.41.41,0,0,1,10,14.1V12.2A.32.32,0,0,1,10,12a.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H10.35a.31.31,0,0,1-.34-.31L9.86,3.4A.36.36,0,0,1,10,3.16a.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H12.3a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z',
      'M8.07,14.1a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.2a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2A.31.31,0,0,1,8,12a.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13ZM8,10.17a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H5.85a.31.31,0,0,1-.34-.31L5.36,3.4a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H7.8a.35.35,0,0,1,.25.1.36.36,0,0,1,.09.24Z',
    ],
    book: [
      'M8.45,5.4c-1-.75-2.51-1.09-4.83-1.09H3V13h.58a8.09,8.09,0,0,1,4.83,1.17Z',
      'M9.54,14.19A8.14,8.14,0,0,1,14.38,13H15V4.31h-.58c-2.31,0-3.81.34-4.84,1.09Z',
    ],
    great: [
      'M10.32,14.1a.27.27,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0H8l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.2a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H8.1a.31.31,0,0,1-.34-.31L7.61,3.4a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0h2.11a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z',
    ],
    best: [
      'M9,2.93A.5.5,0,0,0,8.73,3a.46.46,0,0,0-.17.22L7.24,6.67l-3.68.19A.52.52,0,0,0,3.3,7a.53.53,0,0,0-.16.23.45.45,0,0,0,0,.28.44.44,0,0,0,.15.23L6.15,10l-1,3.56a.45.45,0,0,0,0,.28.46.46,0,0,0,.17.22.41.41,0,0,0,.26.09.43.43,0,0,0,.27-.08l3.09-2,3.09,2a.46.46,0,0,0,.53,0,.46.46,0,0,0,.17-.22.53.53,0,0,0,0-.28l-1-3.56L14.71,7.7a.44.44,0,0,0,.15-.23.45.45,0,0,0,0-.28A.53.53,0,0,0,14.7,7a.52.52,0,0,0-.26-.1l-3.68-.2L9.44,3.23A.46.46,0,0,0,9.27,3,.5.5,0,0,0,9,2.93Z',
    ],
    mistake: [
      'M9.92,14.52a.27.27,0,0,1,0,.12.41.41,0,0,1-.07.11.32.32,0,0,1-.23.09H7.7a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.69a.32.32,0,0,1,.09-.23l.1-.07.12,0H9.59a.32.32,0,0,1,.23.09.61.61,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6,6,6,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.24.24,0,0,1,0,.12.17.17,0,0,1-.06.1.3.3,0,0,1-.1.07l-.12,0H7.79l-.12,0a.3.3,0,0,1-.1-.07.26.26,0,0,1-.07-.1.37.37,0,0,1,0-.12v-.35a2.42,2.42,0,0,1,.13-.84,2.55,2.55,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.73,7.73,0,0,0,.64-.64,1,1,0,0,0,.26-.67.77.77,0,0,0-.07-.34A.75.75,0,0,0,9.48,6a1.16,1.16,0,0,0-.72-.24,1.61,1.61,0,0,0-.49.07A3,3,0,0,0,7.86,6a1.41,1.41,0,0,0-.29.18l-.11.09a.5.5,0,0,1-.24.06A.31.31,0,0,1,7,6.19L6,5a.29.29,0,0,1,0-.4,1.36,1.36,0,0,1,.21-.2A3.07,3.07,0,0,1,6.81,4a5.38,5.38,0,0,1,.89-.37,3.75,3.75,0,0,1,1.2-.17,4.07,4.07,0,0,1,1.2.19,4,4,0,0,1,1.09.56,2.76,2.76,0,0,1,.78.92,2.82,2.82,0,0,1,.28,1.28A3,3,0,0,1,12.12,7.35Z',
    ],
    blunder: [
      'M14.74,5A2.58,2.58,0,0,0,14,4a3.76,3.76,0,0,0-1.09-.56,4.07,4.07,0,0,0-1.2-.19,3.92,3.92,0,0,0-1.18.17,5.87,5.87,0,0,0-.9.37,3,3,0,0,0-.32.2,3.46,3.46,0,0,1,.42.63,3.29,3.29,0,0,1,.36,1.47.31.31,0,0,0,.19-.06L10.37,6a2.9,2.9,0,0,1,.29-.19,3.89,3.89,0,0,1,.41-.17,1.55,1.55,0,0,1,.48-.07,1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26.8.8,0,0,1,.07.34,1,1,0,0,1-.25.67,7.71,7.71,0,0,1-.65.63,6.2,6.2,0,0,0-.48.43,2.93,2.93,0,0,0-.45.54,2.55,2.55,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83v.35a.24.24,0,0,0,0,.12.35.35,0,0,0,.17.17l.12,0h1.71l.12,0a.23.23,0,0,0,.1-.07.21.21,0,0,0,.06-.1.27.27,0,0,0,0-.12V10.3a1,1,0,0,1,.26-.7q.27-.28.66-.63a5.79,5.79,0,0,0,.51-.48,4.51,4.51,0,0,0,.48-.6,2.56,2.56,0,0,0,.36-.72,2.81,2.81,0,0,0,.14-1A2.66,2.66,0,0,0,14.74,5Z',
      'M12.38,12.15H10.5l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0h1.88a.24.24,0,0,0,.12,0,.26.26,0,0,0,.11-.07.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V12.46a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,12.38,12.15Z',
      'M6.79,12.15H4.91l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0H6.79a.24.24,0,0,0,.12,0A.26.26,0,0,0,7,14.51a.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V12.46a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,6.79,12.15Z',
      'M8.39,4A3.76,3.76,0,0,0,7.3,3.48a4.07,4.07,0,0,0-1.2-.19,3.92,3.92,0,0,0-1.18.17,5.87,5.87,0,0,0-.9.37,3.37,3.37,0,0,0-.55.38l-.21.19a.32.32,0,0,0,0,.41l1,1.2a.26.26,0,0,0,.2.12.48.48,0,0,0,.24-.06L4.78,6a2.9,2.9,0,0,1,.29-.19l.4-.17A1.66,1.66,0,0,1,6,5.56a1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26A.77.77,0,0,1,7,6.4a1,1,0,0,1-.26.67,7.6,7.6,0,0,1-.64.63,6.28,6.28,0,0,0-.49.43,2.93,2.93,0,0,0-.45.54,2.72,2.72,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83v.35a.43.43,0,0,0,0,.12.39.39,0,0,0,.08.1.18.18,0,0,0,.1.07.21.21,0,0,0,.12,0H6.72l.12,0a.23.23,0,0,0,.1-.07.36.36,0,0,0,.07-.1.5.5,0,0,0,0-.12V10.3a1,1,0,0,1,.27-.7A8,8,0,0,1,8,9c.18-.15.35-.31.52-.48A7,7,0,0,0,9,7.89a3.23,3.23,0,0,0,.36-.72,3.07,3.07,0,0,0,.13-1A2.66,2.66,0,0,0,9.15,5,2.58,2.58,0,0,0,8.39,4Z',
    ],
    excellent: [
      'M13.79,10.84c0-.2.4-.53.4-.94S14,9.22,14,9.08a2.06,2.06,0,0,0,.18-.83,1,1,0,0,0-.3-.69,1.13,1.13,0,0,0-.55-.2,10.29,10.29,0,0,1-2.07,0c-.37-.23,0-1.18.18-1.7s.51-2.12-.77-2.43c-.69-.17-.66.37-.78.9-.05.21-.09.43-.13.57A5,5,0,0,1,7.05,7.73a1.57,1.57,0,0,1-.42.18v4.94A7.23,7.23,0,0,1,8,13c.52.12.91.25,1.44.33a11.11,11.11,0,0,0,1.62.16,6.65,6.65,0,0,0,1.18,0,1.09,1.09,0,0,0,1-.59.66.66,0,0,0,.06-.2,1.63,1.63,0,0,1,.07-.3c.13-.28.37-.3.5-.68S13.74,11,13.79,10.84Z',
      'M5.49,7.59H4.31a.5.5,0,0,0-.5.5v4.56a.5.5,0,0,0,.5.5H5.49a.5.5,0,0,0,.5-.5V8.09A.5.5,0,0,0,5.49,7.59Z',
    ],
    good: [
      'M15.11,6.31,9.45,12,7.79,13.63a.39.39,0,0,1-.28.11.39.39,0,0,1-.27-.11L2.89,9.28A.39.39,0,0,1,2.78,9a.39.39,0,0,1,.11-.27L4.28,7.35a.34.34,0,0,1,.12-.09l.15,0a.37.37,0,0,1,.15,0,.38.38,0,0,1,.13.09L7.52,10l5.65-5.65a.38.38,0,0,1,.13-.09.37.37,0,0,1,.15,0,.4.4,0,0,1,.15,0,.34.34,0,0,1,.12.09l1.39,1.38a.41.41,0,0,1,.08.13.33.33,0,0,1,0,.15.4.4,0,0,1,0,.15A.5.5,0,0,1,15.11,6.31Z',
    ],
    inaccuracy: [
      'M13.66,14.3a.28.28,0,0,1,0,.13.23.23,0,0,1-.08.11.28.28,0,0,1-.11.08l-.12,0h-2l-.13,0a.27.27,0,0,1-.1-.08A.36.36,0,0,1,11,14.3V12.4a.59.59,0,0,1,0-.13.36.36,0,0,1,.07-.1l.1-.08.13,0h2a.33.33,0,0,1,.23.1.39.39,0,0,1,.08.1.28.28,0,0,1,0,.13Zm-.12-3.93a.31.31,0,0,1,0,.13.3.3,0,0,1-.07.1.3.3,0,0,1-.23.08H11.43a.31.31,0,0,1-.34-.31L10.94,3.6A.5.5,0,0,1,11,3.36l.11-.08.13,0h2.11a.35.35,0,0,1,.26.1.41.41,0,0,1,.08.24Z',
      'M7.65,14.32a.27.27,0,0,1,0,.12.26.26,0,0,1-.07.11l-.1.07-.13,0H5.43a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.49a.36.36,0,0,1,.09-.23l.1-.07.12,0H7.32a.32.32,0,0,1,.23.09.3.3,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6A4.85,4.85,0,0,1,8.48,9a8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.21.21,0,0,1,0,.12.17.17,0,0,1-.06.1.23.23,0,0,1-.1.07l-.12,0H5.53a.21.21,0,0,1-.12,0,.18.18,0,0,1-.1-.07.2.2,0,0,1-.08-.1.37.37,0,0,1,0-.12v-.35a2.68,2.68,0,0,1,.13-.84,2.91,2.91,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.84,7.84,0,0,0,.65-.64,1,1,0,0,0,.25-.67.77.77,0,0,0-.07-.34.67.67,0,0,0-.23-.27,1.16,1.16,0,0,0-.72-.24A1.61,1.61,0,0,0,6,5.61a3,3,0,0,0-.41.18A1.75,1.75,0,0,0,5.3,6l-.11.09A.5.5,0,0,1,5,6.12.31.31,0,0,1,4.74,6l-1-1.21a.3.3,0,0,1,0-.4A1.36,1.36,0,0,1,4,4.18a3.07,3.07,0,0,1,.56-.38,5.49,5.49,0,0,1,.9-.37,3.69,3.69,0,0,1,1.19-.17A3.92,3.92,0,0,1,8.93,4a2.85,2.85,0,0,1,.77.92A2.82,2.82,0,0,1,10,6.21,3,3,0,0,1,9.85,7.15Z',
    ],
    miss: [
      'M13.99,12.01s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-1.37,1.37s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-3.06-3.06-3.06,3.06s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-1.37-1.37c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l3.06-3.06-3.06-3.06c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l1.37-1.37c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l3.06,3.06,3.06-3.06c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l1.37,1.37s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-3.06,3.06,3.06,3.06Z',
    ],
  };
  for (const [key, paths] of Object.entries(ICONS)) {
    const glyphs = paths.map(d => `<path d="${d}"/>`).join('');
    const c = CLS[key];
    c.svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19">
      <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
      <path fill="${c.color}" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
      <g opacity="${key === 'book' ? 0.3 : 0.2}" transform="translate(0 .5)">${glyphs}</g>
      <g fill="${key === 'miss' ? '#f1f2f2' : '#fff'}">${glyphs}</g></svg>`;
    c.img = `url("data:image/svg+xml,${encodeURIComponent(c.svg)}")`;
  }

  const SVG = {
    first: '<path d="M5 4h3v16H5zM20 4v16L9 12z"/>',
    prev: '<path d="M15.6 3.5 7.1 12l8.5 8.5 2.3-2.3-6.2-6.2 6.2-6.2z"/>',
    play: '<path d="M7 3.5v17L20.5 12z"/>',
    pause: '<path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/>',
    next: '<path d="M8.4 3.5 16.9 12l-8.5 8.5-2.3-2.3 6.2-6.2-6.2-6.2z"/>',
    last: '<path d="M16 4h3v16h-3zM4 4v16l11-8z"/>',
    star: '<path d="M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zm0 2a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15zm0 2.2-1.6 3.6-3.9.4 2.9 2.6-.8 3.9 3.4-2 3.4 2-.8-3.9 2.9-2.6-3.9-.4z"/>',
    bulb: '<path d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2zM9 19.5h6V21a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z"/>',
    arrow: '<path d="M3 10.5h13.1l-5.3-5.3L13 3l9 9-9 9-2.2-2.2 5.3-5.3H3z"/>',
  };
  const svgIcon = name => `<svg class="cdc-i" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd">${SVG[name]}</svg>`;

  const esc = s =>
    String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ----------------------------------------------------------- chess ---

  const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  function parseFen(fen) {
    const [placement, turn] = fen.split(' ');
    const board = {};
    placement.split('/').forEach((row, i) => {
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) file += +ch;
        else {
          board['abcdefgh'[file] + (8 - i)] = { color: ch === ch.toUpperCase() ? 'w' : 'b', type: ch.toLowerCase() };
          file++;
        }
      }
    });
    return { board, turn };
  }

  const sq = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? 'abcdefgh'[f] + (r + 1) : null);
  const fr2 = s => ['abcdefgh'.indexOf(s[0]), +s[1] - 1];

  // Values of `color`'s pieces attacking `target`.
  function attackers(board, target, color) {
    const [tf, tr] = fr2(target);
    const found = [];
    const at = (f, r) => {
      const k = sq(f, r);
      return k ? board[k] : undefined;
    };
    const take = (p, ...types) => p && p.color === color && types.includes(p.type) && found.push(VALUES[p.type] || 100);
    const dir = color === 'w' ? -1 : 1;
    take(at(tf - 1, tr + dir), 'p');
    take(at(tf + 1, tr + dir), 'p');
    for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) take(at(tf + df, tr + dr), 'n');
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    dirs.forEach(([df, dr]) => take(at(tf + df, tr + dr), 'k'));
    dirs.forEach(([df, dr], i) => {
      for (let f = tf + df, r = tr + dr; sq(f, r); f += df, r += dr) {
        const p = at(f, r);
        if (!p) continue;
        take(p, 'q', i < 4 ? 'r' : 'b');
        break;
      }
    });
    return found;
  }

  // A sound piece sacrifice: the moved piece can be taken by something cheaper,
  // or for free, and it wasn't just a trade.
  function isSacrifice(fenBefore, fenAfter, uci) {
    const before = parseFen(fenBefore).board;
    const after = parseFen(fenAfter).board;
    const dest = uci.slice(2, 4);
    const piece = after[dest];
    if (!piece || piece.type === 'p' || piece.type === 'k') return false;
    const value = VALUES[piece.type];
    const captured = before[dest] ? VALUES[before[dest].type] : 0;
    if (captured >= value) return false;
    const enemy = piece.color === 'w' ? 'b' : 'w';
    const hits = attackers(after, dest, enemy);
    if (!hits.length) return false;
    const guards = attackers(after, dest, piece.color);
    return Math.min(...hits) < value || !guards.length;
  }

  // Readable move from UCI (piece letter, capture, destination; no disambiguation).
  function uciToSan(fen, uci) {
    if (!uci) return '';
    const { board } = parseFen(fen);
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const p = board[from];
    if (!p) return uci;
    if (p.type === 'k' && Math.abs(fr2(from)[0] - fr2(to)[0]) >= 2) return fr2(to)[0] > fr2(from)[0] ? 'O-O' : 'O-O-O';
    if (p.type === 'k' && board[to]?.type === 'r' && board[to].color === p.color) return fr2(to)[0] > fr2(from)[0] ? 'O-O' : 'O-O-O';
    const capture = !!board[to] || (p.type === 'p' && from[0] !== to[0]);
    const promo = uci[4] ? '=' + uci[4].toUpperCase() : '';
    if (p.type === 'p') return (capture ? from[0] + 'x' : '') + to + promo;
    return p.type.toUpperCase() + (capture ? 'x' : '') + to;
  }

  // Lichess encodes castling as king-takes-rook; Stockfish (non-960) as king two squares.
  const normUci = (uci, chess960) =>
    !uci || chess960 ? uci : ({ e1h1: 'e1g1', e1a1: 'e1c1', e8h8: 'e8g8', e8a8: 'e8c8' })[uci] || uci;

  // ------------------------------------------------------------ math ---

  const winPct = cp => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
  const pov = (wpWhite, color) => (color === 'w' ? wpWhite : 100 - wpWhite);
  const moveAccuracy = loss => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));

  function formatEval(e) {
    if (!e) return '';
    if (e.mate !== undefined) return e.mate === 0 ? '#' : (e.mate > 0 ? '+M' : '-M') + Math.abs(e.mate);
    const v = e.cp / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  function barLabel(e) {
    if (!e) return '';
    if (e.mate !== undefined) return e.mate === 0 ? '' : 'M' + Math.abs(e.mate);
    return Math.abs(e.cp / 100).toFixed(1);
  }

  // ---------------------------------------------------------- engine ---

  class Engine {
    constructor() {
      this.queue = Promise.resolve();
    }

    async boot() {
      const { root, js } = ENGINE;
      const url = site.asset.url(`${root}/${js}`, { documentOrigin: true });
      let max = 32767, memory;
      for (;;) {
        try {
          memory = new WebAssembly.Memory({ shared: true, initial: 1536, maximum: max });
          break;
        } catch (e) {
          if (max <= 1536 || !(e instanceof RangeError)) throw e;
          max = Math.ceil(max * 0.75);
        }
      }
      const mod = await (await import(url)).default({
        wasmMemory: memory,
        locateFile: f => site.asset.url(`${root}/${f}`),
        mainScriptUrlOrBlob: url,
      });
      for (let i = 0; ; i++) {
        const net = mod.getRecommendedNnue(i);
        if (!net) break;
        const buf = await (await fetch(site.asset.url(`lifat/nnue/${net}`))).arrayBuffer();
        mod.setNnueBuffer(new Uint8Array(buf), i);
      }
      mod.listen = line => this.onLine?.(line);
      this.mod = mod;
      const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
      mod.uci('uci');
      mod.uci(`setoption name Threads value ${threads}`);
      mod.uci('setoption name Hash value 64');
      mod.uci('setoption name MultiPV value 2');
      if (this.chess960) mod.uci('setoption name UCI_Chess960 value true');
      mod.uci('ucinewgame');
    }

    // Resolves to { lines: [{ cp | mate, pv }] } from the side to move's view.
    analyse(fen, { depth, movetime } = ENGINE) {
      const run = () =>
        new Promise(resolve => {
          const lines = [];
          this.onLine = line => {
            if (line.startsWith('bestmove')) {
              this.onLine = null;
              resolve({ lines: lines.filter(Boolean), bestmove: line.split(' ')[1] });
              return;
            }
            if (!line.startsWith('info') || !/ score /.test(line) || / (lower|upper)bound/.test(line)) return;
            const multipv = +(line.match(/ multipv (\d+)/)?.[1] || 1);
            const cp = line.match(/ score cp (-?\d+)/);
            const mate = line.match(/ score mate (-?\d+)/);
            const pv = (line.match(/ pv (.+)$/)?.[1] || '').trim().split(/\s+/).filter(Boolean);
            lines[multipv - 1] = cp ? { cp: +cp[1], pv } : { mate: +mate[1], pv };
          };
          this.mod.uci(`position fen ${fen}`);
          this.mod.uci(`go depth ${depth} movetime ${movetime}`);
        });
      return (this.queue = this.queue.then(run));
    }

    destroy() {
      this.mod?.uci('quit');
    }
  }

  // Engine output for one position -> white-POV record.
  function toRecord(fen, result) {
    const white = fen.split(' ')[1] === 'w';
    const sign = white ? 1 : -1;
    const [l1, l2] = result.lines;
    const whiteEval = l => {
      if (!l) return null;
      if (l.mate !== undefined) {
        // "mate 0": the side to move is mated.
        if (l.mate === 0) return { mate: 0, wp: white ? 0 : 100 };
        const m = l.mate * sign;
        return { mate: m, wp: m > 0 ? 100 : 0 };
      }
      const cp = l.cp * sign;
      return { cp, wp: winPct(cp) };
    };
    let e1 = whiteEval(l1);
    if (!e1) e1 = { cp: 0, wp: 50 }; // stalemate / no legal move
    const e2 = whiteEval(l2);
    return { ...e1, wp2: e2 ? e2.wp : null, best: l1?.pv?.[0] || null };
  }

  // -------------------------------------------------------- classify ---

  const RANK = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];

  // A mate of five moves or fewer comes out exact at our depth; a longer one
  // comes out long (a mate in 8 as a mate in 12), so only a move's short
  // side is trusted.
  const SURE_MATE = 5;

  // The verdict a move deserves from mate distances, or null. The win
  // probability can't see them: a slower mate is 100% all the same, a mate
  // let in sooner 0%, and such moves came out best. With a sure mate, the
  // winner is judged by the moves given away (losing the mate altogether
  // counts as many); the loser, when it lets a sure mate in though it held
  // out clearly longer, by how soon. Never worse than an inaccuracy: the
  // game is won or lost all the same.
  function mateVerdict(a, b, color) {
    if (!a.mate || b.mate === 0) return null;
    const s = color === 'w' ? 1 : -1, before = a.mate * s;
    const after = b.mate === undefined ? (before > 0 ? Infinity : 0) : b.mate * s;
    if (before > 0 && before <= SURE_MATE && after > 0) {
      const lost = after - (before - 1);
      return lost <= 0 ? null : lost <= 2 ? 'excellent' : lost <= 5 ? 'good' : 'inaccuracy';
    }
    if (before < 0 && after < 0 && -after <= SURE_MATE && after - before >= 3) return -after <= 2 ? 'inaccuracy' : 'good';
    return null;
  }

  // One move, from `prev` to `node`: `a` and `b` are the engine's records of
  // the two positions, `prevMove` the opponent's move just before (a miss
  // fails to punish it). The nodes and records ride along for the coach.
  function judge(prev, node, a, b, prevMove, book, chess960) {
    const color = prev.fen.split(' ')[1];
    const before = pov(a.wp, color), after = pov(b.wp, color);
    const loss = Math.max(0, before - after);
    const second = a.wp2 === null ? null : pov(a.wp2, color);
    const isBest = normUci(node.uci, chess960) === a.best;
    let cls;
    if (book) cls = 'book';
    else if (isBest || loss < 0.5) {
      if (after >= 50 && before < 95 && loss < 2 && isSacrifice(prev.fen, node.fen, node.uci)) cls = 'brilliant';
      else if (second !== null && before - second >= 15 && before < 97 && after > 25) cls = 'great';
      else cls = 'best';
    } else if (loss < 2) cls = 'excellent';
    else if (loss < 5) cls = 'good';
    else if (loss < 10) cls = 'inaccuracy';
    else if (loss < 20) cls = 'mistake';
    else cls = 'blunder';
    if ((cls === 'mistake' || cls === 'blunder') && prevMove && prevMove.loss >= 10 && before >= 60) cls = 'miss';
    // A mate missed or let in: `slower` when that's what the verdict says.
    const mated = isBest || book ? null : mateVerdict(a, b, color);
    if (mated && RANK.indexOf(cls) < RANK.indexOf(mated)) cls = mated;
    const slower = !!mated && cls === mated;
    return {
      ply: node.ply, san: node.san, uci: node.uci, color, cls, loss, slower,
      accuracy: cls === 'book' ? 100 : moveAccuracy(loss),
      best: a.best, bestSan: uciToSan(prev.fen, a.best), eval: b,
      before: a, node, prev, prevMove,
    };
  }

  // ----------------------------------------------------- game rating ---

  // Chess.com's "Game Rating": the rating a player played at in this one
  // game, and a verdict on each phase of it, compared with what's expected
  // at their rating. The odds come from Lichess's own games, fitted by
  // tools/game-rating: per speed, how often a move at a given rating falls
  // in each loss band (best … blunder), by phase and by whether the mover
  // was lost, level or winning. A game's moves make a likelihood over the
  // level it was played at, a level drawn around the player's rating (`tau`
  // wide, also fitted), and the estimate is the posterior's mean. Without a
  // rating (an anonymous player, the AI) the population is the prior.
  // The phases and the tactics must stay in step with extract.py.
  const RATING_MODEL = {"pop":{"bullet":[1782,449],"blitz":[1643,438],"rapid":[1493,387],"classical":[1641,306]},"tau":{"bullet":775,"blitz":550,"rapid":450,"classical":350},"cuts":{"o":[357,182,-69,-284,-500],"t":[203,96,-38,-186,-346],"s":[225,80,-66,-204,-344],"e":[237,63,-78,-224,-402]},"theta":{"bullet":[[[-0.445,-0.107,0.012],[-0.732,-0.241,-0.001],[-1.511,-0.292,-0.018],[-3.115,-0.406,0.015],[-7.075,-0.027,-1.73]],[[-0.248,-0.002,-0.009],[-0.312,-0.099,-0.023],[-0.814,-0.237,-0.017],[-1.432,-0.389,-0.007],[-2.023,-0.615,0.018]],[[-0.785,0.006,-0.016],[-1.311,-0.073,-0.014],[-1.885,-0.062,-0.044],[-2.107,-0.052,-0.041],[-1.308,-0.141,-0.032]],[[-1.038,0.0,-0.016],[-1.294,-0.03,-0.014],[-1.859,0.043,-0.051],[-2.954,0.125,-0.057],[-8.163,-0.052,-2.036]],[[-0.791,0.009,-0.004],[-1.218,-0.019,-0.02],[-1.203,-0.061,-0.03],[-0.959,-0.158,-0.011],[-0.849,-0.326,0.01]],[[-1.192,0.026,-0.006],[-1.853,-0.084,0.013],[-2.239,-0.05,-0.024],[-2.339,0.011,-0.047],[-1.458,-0.095,-0.032]],[[-0.224,0.0,-0.019],[-0.53,0.044,-0.033],[-1.395,0.111,-0.047],[-2.887,0.211,-0.082],[-7.883,0.001,-1.987]],[[-0.29,-0.03,-0.0],[-0.116,-0.086,-0.01],[-0.254,-0.161,-0.011],[-0.654,-0.217,-0.014],[-1.248,-0.352,0.007]],[[-0.621,-0.022,-0.015],[-1.129,-0.023,-0.03],[-1.899,-0.018,-0.026],[-2.64,0.036,-0.043],[-2.483,-0.078,-0.037]],[[-0.958,0.053,-0.056],[-1.387,0.088,-0.047],[-2.313,0.123,-0.033],[-3.695,0.181,-0.014],[-8.557,-1.124,-3.982]],[[-0.671,-0.032,-0.031],[-0.822,-0.097,-0.03],[-1.02,-0.131,-0.037],[-1.089,-0.225,-0.016],[-1.091,-0.275,0.015]],[[-1.115,0.028,-0.012],[-1.936,-0.002,-0.014],[-2.767,0.027,-0.032],[-3.43,0.029,-0.038],[-2.462,-0.041,-0.004]]],"blitz":[[[-0.626,-0.131,0.013],[-0.834,-0.185,0.034],[-1.521,-0.217,0.026],[-3.117,-0.155,0.132],[-6.842,0.268,-1.58]],[[-0.28,-0.012,-0.028],[-0.407,-0.16,-0.062],[-0.985,-0.381,-0.064],[-1.692,-0.613,-0.052],[-2.532,-0.944,-0.021]],[[-0.858,-0.054,-0.013],[-1.421,-0.14,-0.007],[-1.898,-0.202,-0.022],[-1.924,-0.133,-0.036],[-1.341,-0.25,-0.01]],[[-1.096,-0.017,-0.013],[-1.302,-0.024,-0.012],[-1.833,-0.016,-0.031],[-2.922,0.007,-0.04],[-8.28,-0.052,-2.963]],[[-0.826,-0.018,-0.005],[-1.297,-0.09,-0.012],[-1.34,-0.167,-0.023],[-1.145,-0.278,-0.023],[-1.172,-0.52,-0.011]],[[-1.119,0.067,0.002],[-1.902,-0.031,0.023],[-2.282,-0.069,0.003],[-2.343,-0.023,-0.019],[-1.572,-0.163,-0.028]],[[-0.276,-0.053,-0.016],[-0.469,-0.001,-0.008],[-1.206,0.04,-0.007],[-2.596,0.103,-0.036],[-8.005,0.015,-1.756]],[[-0.375,-0.035,-0.012],[-0.258,-0.128,-0.027],[-0.433,-0.243,-0.029],[-0.843,-0.363,-0.036],[-1.519,-0.569,-0.031]],[[-0.672,0.007,-0.014],[-1.155,-0.057,-0.031],[-1.828,-0.031,-0.005],[-2.47,0.032,-0.043],[-2.403,-0.169,-0.022]],[[-1.015,0.088,-0.063],[-1.366,0.131,-0.055],[-2.234,0.165,-0.043],[-3.471,0.154,-0.06],[-9.043,-0.249,-3.385]],[[-0.935,-0.075,-0.005],[-1.185,-0.135,-0.025],[-1.427,-0.22,-0.029],[-1.54,-0.315,-0.015],[-1.535,-0.452,-0.004]],[[-1.072,0.158,-0.04],[-1.991,0.117,-0.027],[-2.789,0.089,-0.026],[-3.434,0.127,-0.035],[-2.595,-0.005,-0.017]]],"rapid":[[[-0.64,-0.108,0.029],[-0.801,-0.164,0.035],[-1.484,-0.216,0.024],[-2.981,-0.174,0.11],[-6.842,0.535,-1.547]],[[-0.297,-0.011,-0.033],[-0.424,-0.187,-0.056],[-0.98,-0.461,-0.046],[-1.615,-0.714,-0.046],[-2.398,-1.087,-0.03]],[[-0.909,-0.042,0.031],[-1.516,-0.185,0.012],[-1.924,-0.169,0.003],[-1.958,-0.173,-0.07],[-1.498,-0.301,0.019]],[[-1.066,-0.024,-0.031],[-1.329,-0.034,0.019],[-1.904,-0.037,0.003],[-3.049,-0.057,0.014],[-8.444,0.072,-1.827]],[[-0.821,-0.027,-0.017],[-1.294,-0.112,-0.028],[-1.341,-0.22,-0.031],[-1.164,-0.388,-0.021],[-1.188,-0.68,0.021]],[[-1.144,0.077,0.005],[-1.97,-0.12,0.053],[-2.403,-0.138,0.017],[-2.484,-0.084,-0.011],[-1.75,-0.261,-0.018]],[[-0.267,-0.072,-0.065],[-0.489,-0.011,-0.022],[-1.254,0.021,-0.039],[-2.725,0.072,-0.028],[-7.918,0.024,-1.796]],[[-0.383,-0.044,-0.012],[-0.262,-0.17,-0.048],[-0.421,-0.321,-0.047],[-0.829,-0.475,-0.044],[-1.477,-0.75,-0.026]],[[-0.695,-0.008,-0.025],[-1.219,-0.085,-0.032],[-1.937,-0.088,-0.036],[-2.576,-0.02,-0.068],[-2.517,-0.227,-0.028]],[[-1.065,0.128,-0.084],[-1.418,0.164,-0.078],[-2.328,0.176,-0.05],[-3.553,0.181,-0.084],[-9.159,0.075,-2.739]],[[-0.975,-0.089,-0.02],[-1.25,-0.158,-0.049],[-1.489,-0.266,-0.048],[-1.586,-0.386,-0.047],[-1.603,-0.602,0.016]],[[-1.105,0.218,-0.076],[-2.076,0.116,-0.053],[-2.942,0.086,-0.026],[-3.581,0.137,-0.091],[-2.781,-0.097,-0.015]]],"classical":[[[-0.588,-0.2,0.028],[-0.648,-0.359,0.076],[-1.459,-0.043,0.066],[-2.776,0.064,0.139],[-5.019,0.145,-0.971]],[[-0.316,-0.049,-0.03],[-0.366,-0.28,-0.146],[-0.848,-0.651,-0.169],[-1.392,-0.949,-0.183],[-2.074,-1.377,-0.246]],[[-0.831,-0.106,-0.017],[-1.383,-0.213,-0.06],[-1.981,-0.128,0.108],[-2.027,-0.188,0.038],[-1.341,-0.617,-0.276]],[[-1.014,0.022,-0.074],[-1.301,-0.099,-0.044],[-2.029,0.059,0.016],[-3.166,-0.169,-0.212],[-6.39,-0.125,-1.295]],[[-0.826,0.038,-0.09],[-1.288,-0.196,0.014],[-1.344,-0.409,0.013],[-1.075,-0.502,-0.091],[-1.07,-0.983,-0.061]],[[-1.125,0.104,-0.039],[-1.945,-0.122,-0.012],[-2.452,-0.119,-0.027],[-2.64,0.007,-0.123],[-1.87,-0.24,-0.126]],[[-0.25,0.015,-0.078],[-0.547,0.01,-0.101],[-1.338,0.107,-0.137],[-2.775,0.105,-0.106],[-5.912,-0.156,-1.188]],[[-0.43,0.031,-0.066],[-0.255,-0.097,-0.14],[-0.39,-0.401,-0.117],[-0.753,-0.623,-0.122],[-1.416,-0.913,-0.1]],[[-0.787,0.069,-0.018],[-1.305,-0.126,-0.027],[-2.059,0.092,-0.141],[-2.78,0.059,-0.02],[-2.618,-0.211,-0.052]],[[-1.126,0.22,-0.158],[-1.541,0.294,-0.083],[-2.51,0.273,-0.106],[-3.743,0.096,-0.072],[-7.203,-0.318,-1.37]],[[-0.956,0.004,-0.154],[-1.183,-0.044,-0.285],[-1.398,-0.3,-0.227],[-1.51,-0.428,-0.29],[-1.497,-0.668,-0.323]],[[-1.235,0.309,-0.066],[-2.288,0.198,0.015],[-3.125,0.103,-0.152],[-3.835,-0.011,0.013],[-2.936,-0.113,-0.231]]]}};
  const RATING_BANDS = [0.5, 2, 5, 10, 20];
  const PHASES = ['o', 't', 's', 'e']; // opening, tactics, strategy, endgame
  const RATING_GRID = Array.from({ length: 311 }, (_, i) => 100 + 10 * i);
  const RATING_SPEED = { ultraBullet: 'bullet', bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'classical', correspondence: 'classical' };

  // Lichess's own phases (scalachess's Divider): the middlegame starts once
  // pieces are traded or developed, or the two camps mix; the endgame once
  // six pieces or fewer are left, kings and pawns aside.
  function divide(fens) {
    const count = (board, keep) => Object.entries(board).filter(([s, p]) => keep(s, p)).length;
    const minors = b => count(b, (s, p) => p.type !== 'k' && p.type !== 'p');
    const sparse = b => count(b, (s, p) => p.color === 'w' && s[1] === '1') < 4 || count(b, (s, p) => p.color === 'b' && s[1] === '8') < 4;
    const score = (y, w, k) =>
      w === 0 ? [0, 1 + y, y < 6 ? 2 + (6 - y) : 0, y < 7 ? 3 + (7 - y) : 0, y < 7 ? 3 + (7 - y) : 0][k] || 0
      : w === 1 ? [1 + (8 - y), 5 + Math.abs(4 - y), 4 + (7 - y), 5 + (7 - y)][k] || 0
      : w === 2 ? [y > 2 ? 2 + (y - 2) : 0, 4 + (y - 1), 7][k] || 0
      : w === 3 ? [y > 1 ? 3 + (y - 1) : 0, 5 + (y - 1)][k] || 0
      : w === 4 && k === 0 && y > 1 ? 3 + (y - 1) : 0;
    const mixedness = b => {
      let acc = 0;
      for (let y = 0; y < 7; y++)
        for (let x = 0; x < 7; x++) {
          const n = { w: 0, b: 0 };
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const p = b[sq(x + dx, y + dy)];
            if (p) n[p.color]++;
          }
          acc += score(y + 1, n.w, n.b);
        }
      return acc;
    };
    const boards = fens.map(f => parseFen(f).board);
    let middle = boards.findIndex(b => minors(b) <= 10 || sparse(b) || mixedness(b) > 150);
    const end = middle < 0 ? -1 : boards.findIndex(b => minors(b) <= 6);
    if (middle >= 0 && end >= 0 && middle >= end) middle = -1;
    return { middle, end };
  }

  // A position with a tactic in it: the side to move is in check, the last
  // move threw away 10% or more (a chance to punish it), or a piece hangs
  // (a knight, bishop, rook or queen attacked, and either undefended or
  // attacked by something cheaper). Pins aside, as `attackers` has them.
  function tactical(fen, prevLoss) {
    const { board, turn } = parseFen(fen);
    const enemy = c => (c === 'w' ? 'b' : 'w');
    const king = Object.keys(board).find(s => board[s].type === 'k' && board[s].color === turn);
    if (prevLoss >= 10 || (king && attackers(board, king, enemy(turn)).length)) return true;
    return Object.entries(board).some(([s, p]) => {
      if (p.type === 'p' || p.type === 'k') return false;
      const hits = attackers(board, s, enemy(p.color));
      return hits.length > 0 && (Math.min(...hits) < VALUES[p.type] || !attackers(board, s, p.color).length);
    });
  }

  // log p(loss band | rating) per context (phase × lost / level / winning)
  // over RATING_GRID, per speed, computed the first time it's needed.
  const ratingOdds = {};
  function oddsFor(speed) {
    if (ratingOdds[speed]) return ratingOdds[speed];
    const [lo, hi] = [-1.6, 2.2]; // the fit is quadratic in there, linear beyond
    const q = x => (x < lo ? lo * lo + 2 * lo * (x - lo) : x > hi ? hi * hi + 2 * hi * (x - hi) : x * x);
    return (ratingOdds[speed] = RATING_MODEL.theta[speed].map(ctx =>
      RATING_GRID.map(r => {
        const x = (r - 1500) / 500;
        const logits = [0, ...ctx.map(([a, b, c]) => a + b * x + c * q(x))];
        const max = Math.max(...logits);
        const sum = Math.log(logits.reduce((s, l) => s + Math.exp(l - max), 0)) + max;
        return logits.map(l => l - sum);
      }),
    ));
  }

  const posteriorMean = (ll, mu, sd) => {
    const post = ll.map((l, i) => l - 0.5 * ((RATING_GRID[i] - mu) / sd) ** 2);
    const max = Math.max(...post);
    let w = 0, s = 0;
    post.forEach((p, i) => {
      const e = Math.exp(p - max);
      w += e;
      s += e * RATING_GRID[i];
    });
    return s / w;
  };

  // { w, b }: each player's { elo, phases: { o, t, s, e } }, a phase's verdict
  // being a class key (best … blunder, or book for a book-only opening), or
  // null when the player made no move in that phase.
  function rateGame(ctrl, moves) {
    const speed = RATING_SPEED[ctrl.data.game.speed] || 'blitz';
    const odds = oddsFor(speed);
    const tau = RATING_MODEL.tau[speed];
    const [popMu, popSd] = RATING_MODEL.pop[speed];
    const { middle, end } = divide(ctrl.mainline.map(n => n.fen));
    const scored = moves.map((m, i) => {
      if (m.cls === 'book') return { color: m.color, phase: 'k' };
      const pos = m.ply - 1; // the phase of the position it was played from
      const prev = moves[i - 1];
      const phase =
        end >= 0 && pos >= end ? 'e'
        : middle < 0 || pos < middle ? 'o'
        : tactical(m.prev.fen, prev && prev.cls !== 'book' ? prev.loss : 0) ? 't' : 's';
      const before = pov(m.before.wp, m.color);
      const ctx = PHASES.indexOf(phase) * 3 + (before < 20 ? 0 : before > 80 ? 2 : 1);
      const band = RATING_BANDS.findIndex(t => m.loss < t);
      return { color: m.color, phase, ctx, band: band < 0 ? RATING_BANDS.length : band };
    });
    const likelihood = list => RATING_GRID.map((_, g) => list.reduce((s, m) => s + odds[m.ctx][g][m.band], 0));
    const p = players(ctrl);
    const rate = color => {
      const own = scored.filter(m => m.color === color);
      const played = own.filter(m => m.phase !== 'k');
      if (!played.length) return null;
      const rating = p[color]?.rating;
      const est = rating ? posteriorMean(likelihood(played), rating, tau) : posteriorMean(likelihood(played), popMu, Math.hypot(popSd, tau));
      // Each phase against what's expected at the player's rating (or, for
      // an unrated one, at the level of their whole game).
      const anchor = rating || est;
      const phases = {};
      for (const ph of PHASES) {
        const inPhase = played.filter(m => m.phase === ph);
        if (!inPhase.length) {
          phases[ph] = ph === 'o' && own.some(m => m.phase === 'k') ? 'book' : null;
          continue;
        }
        const diff = posteriorMean(likelihood(inPhase), anchor, tau) - anchor;
        const cut = RATING_MODEL.cuts[ph].findIndex(c => diff >= c);
        phases[ph] = ['best', 'excellent', 'good', 'inaccuracy', 'mistake'][cut] || 'blunder';
      }
      return { elo: Math.round(est / 50) * 50, phases };
    };
    return { w: rate('w'), b: rate('b') };
  }

  // --------------------------------------------------- coach remarks ---

  // A short comment under the coach's verdict. Each classification has its
  // pool, and some situations (mate, castling, a capture…) their own: the
  // strongest replace the classification's, the others mix with it. The pick
  // hashes the game, the move and the coach, so it's stable across redraws
  // and each coach words things their own way.
  const REMARKS = fr
    ? {
        brilliant: [
          'Un sacrifice qui fonctionne. Magnifique.',
          'Waouh ! Du matériel donné pour une attaque gagnante.',
          'Il fallait oser, et ça paie.',
          'Le genre de coup dont on se souvient.',
          'Voir aussi loin, chapeau.',
          'Superbe. Le moteur est bien d’accord.',
          'Le matériel passe, l’idée reste.',
          'Peu de joueurs oseraient jouer ça.',
        ],
        great: [
          'Le seul coup qui tient tout ensemble.',
          'Belle trouvaille ! Tout le reste était moins bon.',
          'Le seul bon coup de la position.',
          'Précis. Rien d’autre ne tenait ici.',
          'Un moment critique, bien négocié.',
          'Bien vu ! Ce n’était pas facile à trouver.',
          'Le coup qu’un maître aurait choisi.',
          'Sous la pression, la bonne réponse.',
        ],
        book: [
          'Un coup d’ouverture bien connu.',
          'Tout droit sorti des livres d’ouverture.',
          'De la théorie : les grands maîtres jouent ça tout le temps.',
          'Un choix solide, qui a fait ses preuves.',
          'On suit les lignes principales.',
          'Du jeu d’ouverture classique.',
          'Toujours dans la théorie. Jusqu’ici, tout va bien.',
          'Un coup joué dans des milliers de parties.',
        ],
        best: [
          'Exactement ce que voulait le moteur.',
          'Le coup du moteur. Bien joué.',
          'Impossible de faire mieux.',
          'Dans le mille.',
          'C’est le coup le plus précis.',
          'Propre et précis.',
          'Parfait. Continue comme ça !',
          'Rien de mieux ici.',
          'Simple et fort.',
        ],
        excellent: [
          'Tout près du meilleur coup.',
          'Un coup fort, la position reste sous contrôle.',
          'Très bien. Le moteur chipote à peine.',
          'Presque parfait.',
          'Une suite sensée et solide.',
          'Bien joué, la position reste saine.',
          'Bon jugement ici.',
          'Du jeu solide. Continue.',
        ],
        good: [
          'Un coup correct, mais il y avait mieux.',
          'Jouable, sans être le plus précis.',
          'Ça va, juste un peu lent.',
          'D’accord, mais ça lâche un tout petit peu.',
          'Pas mal, mais il y avait plus actif.',
          'Ça marche, mais la position offrait plus.',
          'Un choix raisonnable.',
          'Sûr, quoiqu’un peu passif.',
        ],
        inaccuracy: [
          'Pas le plus précis : un peu d’avantage s’envole.',
          'Un petit faux pas. Il y avait une idée plus forte.',
          'Hmm, ça laisse respirer l’adversaire.',
          'Jouable, mais ça passe à côté de l’essentiel.',
          'Un peu imprécis. Il y avait un meilleur plan.',
          'L’emprise se relâche un peu.',
          'Pas une catastrophe, mais pas idéal non plus.',
          'Un peu négligent. Regarde de plus près.',
        ],
        mistake: [
          'Une erreur, qui donne un vrai avantage à l’adversaire.',
          'Aïe, ça remet l’adversaire dans la partie.',
          'Un faux pas qui coûte cher.',
          'Ça change beaucoup l’évaluation.',
          'Vérifie d’abord les réponses de l’adversaire.',
          'La position méritait plus d’attention.',
          'Ça offre une belle occasion à l’adversaire.',
          'Attention ! Ce coup a un défaut concret.',
        ],
        miss: [
          'L’adversaire s’est trompé, mais ce n’est pas puni.',
          'Une occasion manquée d’en profiter.',
          'Il y avait une punition bien plus forte.',
          'L’erreur de l’adversaire reste impunie.',
          'L’adversaire s’en tire à bon compte.',
          'Si près ! L’occasion était sous tes yeux.',
          'Une occasion qui s’envole.',
          'Demande-toi toujours : qu’a permis son dernier coup ?',
        ],
        blunder: [
          'Une gaffe, qui gâche la position.',
          'Oh non ! Ça coûte très cher.',
          'C’est une grosse erreur.',
          'Ça renverse la partie.',
          'Aïe. L’adversaire doit être ravi.',
          'Cherche les menaces avant de jouer.',
          'Celle-là fait mal.',
          'Prends le temps de respirer avant chaque coup.',
        ],
        mate: [
          'Échec et mat ! La partie est finie.',
          'Et c’est mat. Bien joué !',
          'Échec et mat. Une fin parfaite.',
          'Le roi n’a plus de case. Mat !',
        ],
        allowsMate: [
          'Ça permet un mat forcé.',
          'Un mat se prépare maintenant contre ce roi.',
          'Attention : le roi est pris dans un filet de mat.',
          'Ce coup tombe dans un mat forcé.',
        ],
        missedMate: [
          'Il y avait un mat forcé ici !',
          'Un mat était sur l’échiquier.',
          'Un échec et mat s’est échappé.',
          'Le mat était là. Regarde d’abord les échecs !',
        ],
        mating: [
          'Le filet de mat se resserre.',
          'Le mat arrive. Continue !',
          'Encore un pas vers le mat.',
          'Plus d’échappatoire pour le roi.',
        ],
        castle: [
          'Le roque : roi à l’abri, tour en jeu.',
          'Bon moment pour mettre le roi à l’abri.',
          'La sécurité d’abord. Bien roqué.',
          'Les tours vont pouvoir se connecter.',
        ],
        promote: [
          'Une nouvelle dame entre en jeu !',
          'Promotion ! Ce pion est allé jusqu’au bout.',
          'Le long voyage du pion paie enfin.',
        ],
        check: [
          'Un échec qui garde l’initiative.',
          'Échec ! L’adversaire doit répondre.',
          'Du jeu forcé : les échecs sont puissants.',
        ],
        capture: [
          'Prendre est la bonne décision ici.',
          'Une bonne prise.',
          'Du matériel encaissé. Bien vu.',
        ],
        badCapture: [
          'Cette prise a un inconvénient caché.',
          'Toutes les prises ne sont pas bonnes.',
          'Prendre du matériel ici est risqué.',
        ],
        winning: [
          'C’est gagnant. Reste concentré.',
          'La position est gagnante maintenant.',
          'Il ne reste qu’à conclure calmement.',
        ],
        losing: [
          'La position est maintenant très dure à tenir.',
          'Ça laisse une position perdante.',
        ],
        earlyQueen: ['Sortir la dame si tôt est risqué.', 'La dame sort trop tôt : elle va se faire chasser.'],
        earlyKing: ['Bouger le roi si tôt coûte le roque.', 'Le roi ferait mieux de rester à l’abri.'],
      }
    : {
        brilliant: [
          'A sacrifice that works. Beautiful.',
          'Wow! Giving up material for a winning attack.',
          'That took courage, and it pays off.',
          'The kind of move people remember.',
          'Seeing that far ahead, impressive.',
          'Stunning. The engine agrees.',
          'Material is temporary; this idea isn’t.',
          'Few players would dare to play this.',
        ],
        great: [
          'The only move that holds everything together.',
          'Great find! Everything else was worse.',
          'The one good move in the position.',
          'Precise. Nothing else holds here.',
          'A critical moment, handled perfectly.',
          'Sharp eyes! This was hard to see.',
          'That’s the move a master would pick.',
          'Under pressure, the right answer.',
        ],
        book: [
          'A well-known opening move.',
          'Straight out of the opening books.',
          'Theory. Grandmasters play this all the time.',
          'A solid, time-tested choice.',
          'Following the main lines.',
          'Classic opening play.',
          'Still in theory. So far, so good.',
          'A move played in thousands of games.',
        ],
        best: [
          'Exactly what the engine wanted.',
          'The engine’s top move. Well played.',
          'Couldn’t have done better.',
          'Spot on.',
          'That’s the most accurate move.',
          'Clean and precise.',
          'Just right. Keep it up!',
          'Nothing better here.',
          'Strong and simple.',
        ],
        excellent: [
          'Very close to the best move.',
          'A strong move that keeps things under control.',
          'Very good. The engine barely disagrees.',
          'Almost perfect.',
          'A sensible, strong continuation.',
          'Nicely done, the position stays healthy.',
          'Good judgment here.',
          'Solid play. Keep going.',
        ],
        good: [
          'A decent move, but there was something better.',
          'Playable, though not the most precise.',
          'It’s fine, just a little slow.',
          'Okay, but it gives away a tiny bit.',
          'Not bad, but there was a more active idea.',
          'It works, but the position offered more.',
          'A reasonable choice.',
          'Safe, if a bit passive.',
        ],
        inaccuracy: [
          'Not the most accurate: some edge slips away.',
          'A small slip. There was a stronger idea.',
          'Hmm, this gives the opponent some air.',
          'Playable, but it misses the point of the position.',
          'A little imprecise. There was a better plan.',
          'This loosens the grip a little.',
          'Not a disaster, but not ideal either.',
          'A bit careless. Take a closer look.',
        ],
        mistake: [
          'A mistake that hands over a real advantage.',
          'Ouch, this lets the opponent back in.',
          'That’s a costly slip.',
          'This changes the evaluation a lot.',
          'Check the opponent’s replies first.',
          'The position deserved more care here.',
          'This gives the opponent a clear chance.',
          'Careful! That move has a concrete flaw.',
        ],
        miss: [
          'The opponent slipped, but it goes unpunished.',
          'A missed chance to take advantage.',
          'There was a much stronger punishment.',
          'The opponent’s mistake goes unpunished.',
          'That lets the opponent off the hook.',
          'So close! The chance was right there.',
          'An opportunity slips away.',
          'Always ask: what did their last move allow?',
        ],
        blunder: [
          'A blunder that throws away the position.',
          'Oh no! This loses a lot.',
          'That’s a serious error.',
          'This turns the game around.',
          'Ouch. The opponent must be delighted.',
          'Check for threats before moving.',
          'This one hurts.',
          'Take a breath before each move.',
        ],
        mate: [
          'Checkmate! Game over.',
          'And that’s mate. Well played!',
          'Checkmate. A perfect finish.',
          'The king has nowhere to go. Mate!',
        ],
        allowsMate: [
          'This allows a forced checkmate.',
          'Now there’s a mate coming against this king.',
          'Careful: the king is in a mating net now.',
          'This walks into a forced mate.',
        ],
        missedMate: [
          'There was a forced checkmate here!',
          'There was a mate on the board.',
          'A checkmate slipped away.',
          'Mate was available. Look for checks first!',
        ],
        mating: [
          'The mating net tightens.',
          'Mate is coming. Keep going!',
          'One step closer to checkmate.',
          'No escape for the king now.',
        ],
        castle: [
          'Castling: king safe, rook in the game.',
          'Good time to tuck the king away.',
          'Safety first. Nice castle.',
          'The rooks can now connect.',
        ],
        promote: [
          'A new queen joins the fight!',
          'Promotion! That pawn went all the way.',
          'The pawn’s long journey pays off.',
        ],
        check: [
          'A check that keeps the initiative.',
          'Check! The opponent has to respond.',
          'Forcing play. Checks are powerful.',
        ],
        capture: ['Taking is right here.', 'A good capture.', 'Cashing in. Well spotted.'],
        badCapture: [
          'This capture has a hidden downside.',
          'Not every capture is a good one.',
          'Grabbing material here is risky.',
        ],
        winning: ['This is winning. Stay focused.', 'The position is winning now.', 'Now just convert calmly.'],
        losing: ['The position is now very hard to hold.', 'This leaves a losing position.'],
        earlyQueen: ['Bringing the queen out this early is risky.', 'The queen is out early and will get chased.'],
        earlyKing: ['Moving the king this early costs castling.', 'The king would rather stay safe.'],
      };

  // French puts a space before ! ? : ;, which mustn't wrap away from its word.
  const typo = s => (fr ? s.replace(/ ([!?:;])/g, '\u00a0$1') : s);

  const hash = s => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  function remark(ctrl, move) {
    const R = REMARKS, san = move.san;
    const sign = move.color === 'w' ? 1 : -1;
    const before = move.before, after = move.eval;
    const mateFor = e => e.mate !== undefined && e.mate * sign > 0;
    const bad = ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(move.cls);
    let only;
    if (san.includes('#')) only = R.mate;
    else if (bad && after.mate !== undefined && after.mate * sign < 0) only = R.allowsMate;
    else if (mateFor(before)) only = mateFor(after) ? R.mating : R.missedMate;
    const ctx = [];
    const wp = pov(after.wp, move.color);
    if (!bad) {
      if (san.startsWith('O-O')) ctx.push(...R.castle);
      if (san.includes('=Q')) ctx.push(...R.promote);
      if (san.includes('+')) ctx.push(...R.check);
      if (san.includes('x')) ctx.push(...R.capture);
      if (wp >= 90) ctx.push(...R.winning);
    } else {
      if (san.includes('x')) ctx.push(...R.badCapture);
      if (san[0] === 'Q' && move.node.ply <= 12) ctx.push(...R.earlyQueen);
      if (san[0] === 'K' && move.node.ply <= 20) ctx.push(...R.earlyKing);
      if (wp <= 10) ctx.push(...R.losing);
    }
    const seed = `${ctrl.data.game.id}:${move.ply}:${move.uci}:${coach}`;
    const pool = only || (ctx.length && hash(seed + ':ctx') % 2 ? ctx : R[move.cls]);
    return typo(pool[hash(seed) % pool.length]);
  }

  // ---------------------------------------------------- explanations ---

  // Full sentences under the verdict, like Chess.com's coach: how the
  // evaluation moved, and one concrete fact from the board and the engine
  // (a piece left hanging, a mate allowed or missed, the better move, a
  // mistake punished, what a capture won). The pools above only fill in
  // when a good move has nothing concrete to say.
  const PIECE = fr
    ? { p: ['pion'], n: ['cavalier'], b: ['fou'], r: ['tour', 'f'], q: ['dame', 'f'], k: ['roi'] }
    : { p: ['pawn'], n: ['knight'], b: ['bishop'], r: ['rook'], q: ['queen'], k: ['king'] };
  const fem = t => PIECE[t][1] === 'f';
  // Pieces, moves and squares go into the text as [[…]] tokens, which
  // streamHtml draws as Neo pieces, move chips and bold squares: a beginner
  // sees which piece, and whose, without reading the notation.
  const pc = (t, c) => (c ? `[[p:${c}${t}]]` : '');
  const name = (t, c) => pc(t, c) + PIECE[t][0];
  const the = (t, c) => (fr ? (fem(t) ? 'la ' : 'le ') : 'the ') + name(t, c);
  const one = (t, c) => (fr ? (fem(t) ? 'une ' : 'un ') : 'a ') + name(t, c);
  const mv = (san, c) => `[[m:${c}:${san}]]`;
  const sqr = s => `[[s:${s}]]`;
  const side = c => (fr ? (c === 'w' ? 'les Blancs' : 'les Noirs') : c === 'w' ? 'White' : 'Black');
  const sides = c => (fr ? (c === 'w' ? 'des Blancs' : 'des Noirs') : c === 'w' ? 'White’s' : 'Black’s');
  const cap = s => s[0].toUpperCase() + s.slice(1);

  // White's view of an evaluation, from -4 (Black mates) to 4 (White mates).
  function level(e) {
    if (e.mate !== undefined) return e.mate > 0 || (e.mate === 0 && e.wp > 50) ? 4 : -4;
    const w = e.wp;
    return (w >= 90 ? 3 : w >= 70 ? 2 : w >= 58 ? 1 : 0) - (w <= 10 ? 3 : w <= 30 ? 2 : w <= 42 ? 1 : 0);
  }
  const NOUN = fr
    ? ['', 'un léger avantage', 'un net avantage', 'une position gagnante', 'un mat forcé']
    : ['', 'a slight edge', 'a clear advantage', 'a winning position', 'a forced mate'];
  const noun = (l, e) =>
    Math.abs(l) === 4 && e.mate ? (fr ? `un mat en ${Math.abs(e.mate)}` : `a mate in ${Math.abs(e.mate)}`) : NOUN[Math.abs(l)];
  const de = s => (fr ? s.replace(/^un(e?) /, 'd’un$1 ') : s);

  // How the move changed the game, e.g. "The game was balanced, but now
  // Black has a clear advantage."
  function trajectory(eb, ea, mover, seed) {
    const b = level(eb), a = level(ea);
    const who = l => (l > 0 ? 'w' : 'b');
    const nb = noun(b, eb), na = noun(a, ea);
    if (b === a) {
      const still = !a
        ? fr
          ? ['La partie reste équilibrée.', 'L’équilibre tient toujours.', 'Les chances restent égales.']
          : ['The game stays balanced.', 'It’s still an even game.', 'The balance holds.']
        : fr
          ? [`${cap(side(who(a)))} ont toujours ${na}.`, `${cap(side(who(a)))} gardent ${na}.`]
          : [`${side(who(a))} still has ${na}.`, `${side(who(a))} keeps ${na}.`];
      return still[seed % still.length];
    }
    if (!b) {
      const good = who(a) === mover;
      return fr
        ? `La partie était équilibrée, ${good ? 'et' : 'mais'} maintenant ${side(who(a))} ont ${na}.`
        : `The game was balanced, ${good ? 'and' : 'but'} now ${side(who(a))} has ${na}.`;
    }
    if (!a)
      return fr
        ? `${cap(side(who(b)))} avaient ${nb}, mais la partie est maintenant équilibrée.`
        : `${side(who(b))} had ${nb}, but the game is now balanced.`;
    if (who(a) === who(b)) {
      const s = side(who(a));
      if (Math.abs(a) > Math.abs(b)) return fr ? `${cap(s)} passent ${de(nb)} à ${na}.` : `${s} goes from ${nb} to ${na}.`;
      return fr ? `${cap(s)} avaient ${nb}, il ne leur reste qu’${na}.` : `${s} had ${nb}; now it’s only ${na}.`;
    }
    return fr
      ? `${cap(side(who(b)))} avaient ${nb}, mais maintenant ${side(who(a))} ont ${na}.`
      : `${side(who(b))} had ${nb}, but now ${side(who(a))} has ${na}.`;
  }

  // One thing the board or the engine shows about the move, or null.
  function fact(move) {
    const { node, prev } = move;
    const me = move.color, them = me === 'w' ? 'b' : 'w', sign = me === 'w' ? 1 : -1;
    const before = parseFen(prev.fen).board, after = parseFen(node.fen).board;
    const eb = move.before, ea = move.eval;
    const san = move.san, dest = move.uci.slice(2, 4);
    const best = move.bestSan ? mv(move.bestSan, me) : '';
    const reply = ea.best;
    const replySan = reply ? mv(uciToSan(node.fen, reply), them) : '';
    const mates = (e, s) => e.mate !== undefined && e.mate * s > 0;

    if (san.includes('#'))
      return fr
        ? `Échec et mat : le roi ${them === 'w' ? 'blanc' : 'noir'} n’a plus aucune case.`
        : `Checkmate: the ${them === 'w' ? 'white' : 'black'} king has nowhere to go.`;

    // A sure mate missed, or one let in (judge's `slower`). The defense's
    // length goes unsaid: long mates come out longer than they are.
    if (move.slower && best)
      return mates(eb, sign)
        ? fr ? `${best} matait en ${eb.mate * sign}.` : `${best} mated in ${eb.mate * sign}.`
        : fr ? `${best} tenait plus longtemps.` : `${best} held out longer.`;

    if (!GOOD.has(move.cls) && move.cls !== 'excellent' && move.cls !== 'good') {
      if (mates(ea, -sign) && !mates(eb, -sign) && replySan)
        return fr
          ? `${cap(side(them))} peuvent maintenant forcer le mat, à commencer par ${replySan}.`
          : `${side(them)} can now force mate, starting with ${replySan}.`;
      if (mates(eb, sign) && !mates(ea, sign) && best)
        return fr ? `${best} forçait le mat en ${Math.abs(eb.mate)}.` : `${best} would have forced mate in ${Math.abs(eb.mate)}.`;
      if (move.cls === 'miss' && best)
        return fr
          ? `Le dernier coup ${sides(them)} était une erreur, et ${best} l’aurait puni.`
          : `${sides(them)} last move was a mistake, and ${best} would have punished it.`;
      const victim = reply && after[reply.slice(2, 4)];
      if (move.loss >= 10 && victim?.color === me && VALUES[victim.type] >= 3 && victim.type !== 'k') {
        const to = reply.slice(2, 4), at = sqr(to);
        if (!attackers(after, to, me).length)
          return fr
            ? `${cap(the(victim.type, me))} en ${at} n’est plus défendu${fem(victim.type) ? 'e' : ''} : ${replySan} ${fem(victim.type) ? 'la' : 'le'} gagne.`
            : `The ${name(victim.type, me)} on ${at} is left undefended: ${replySan} wins it.`;
        if (Math.min(...attackers(after, to, them)) < VALUES[victim.type])
          return fr
            ? `${cap(side(them))} répondent ${replySan} et gagnent ${the(victim.type, me)} en ${at}.`
            : `${side(them)} answers ${replySan} and wins the ${name(victim.type, me)} on ${at}.`;
      }
      if (!best) return null;
      const taken = move.best && before[move.best.slice(2, 4)];
      if (taken && taken.color === them && taken.type !== 'p')
        return fr
          ? `${best}, qui prend ${the(taken.type, them)}, était plus fort.`
          : `${best}, taking the ${name(taken.type, them)}, was stronger.`;
      if (move.cls === 'inaccuracy') return fr ? `${best} était plus précis.` : `${best} was more precise.`;
      return fr ? `Il fallait jouer ${best}.` : `${best} was the better move.`;
    }

    const prevMove = move.prevMove;
    if (['brilliant', 'great', 'best'].includes(move.cls) && ['mistake', 'blunder', 'miss'].includes(prevMove?.cls))
      return fr ? `Il punit aussitôt l’erreur ${sides(them)}.` : `It punishes ${sides(them)} mistake right away.`;
    const moved = after[dest];
    if (move.cls === 'brilliant' && moved)
      return fr
        ? `${cap(the(moved.type, me))} est offert${fem(moved.type) ? 'e' : ''}, et ${side(them)} ne peuvent pas ${fem(moved.type) ? 'la' : 'le'} prendre sans risque.`
        : `The ${name(moved.type, me)} is offered, and ${side(them)} can’t safely take it.`;
    if (move.cls === 'great')
      return level(ea) * sign >= 2
        ? fr ? 'Tout autre coup laissait filer l’avantage.' : 'Every other move would have let the advantage slip.'
        : fr ? `Tout autre coup mettait ${side(me)} en difficulté.` : `Every other move would have left ${side(me)} worse off.`;
    const promo = san.match(/=([QRBN])/);
    if (promo)
      return fr
        ? `Le pion devient ${one(promo[1].toLowerCase(), me)}.`
        : `The pawn promotes to ${one(promo[1].toLowerCase(), me)}.`;
    if (san.startsWith('O-O'))
      return fr ? 'Le roi est à l’abri, et la tour entre en jeu.' : 'The king is safe, and the rook joins the game.';
    if (san.includes('x') && moved) {
      const victim = before[dest] || { type: 'p' }; // en passant
      if (prev.san?.includes('x') && prev.uci?.slice(2, 4) === dest) return fr ? `Il reprend en ${sqr(dest)}.` : `It takes back on ${sqr(dest)}.`;
      if (!attackers(before, dest, them).length)
        return fr ? `Il gagne ${one(victim.type, them)} sans contrepartie.` : `It wins ${one(victim.type, them)} for free.`;
      if (VALUES[victim.type] > VALUES[moved.type])
        return fr
          ? `Il gagne ${one(victim.type, them)} contre ${one(moved.type, me)}.`
          : `It wins ${one(victim.type, them)} for ${one(moved.type, me)}.`;
    }
    if (san.includes('+')) return fr ? `L’échec force ${side(them)} à réagir.` : `The check forces ${side(them)} to respond.`;
    if (move.cls === 'good' && best) return fr ? `${best} était un peu plus précis.` : `${best} was a little more precise.`;
    return null;
  }

  // The coach's comment: [sentence, droppable?] pairs. The trajectory is the
  // one dropped when the bubble has no room for both.
  function explanation(ctrl, move) {
    const opening = move.opening ?? state.openingName;
    if (move.cls === 'book')
      return [[remark(ctrl, move)], ...(opening ? [[`${fr ? 'Ouverture' : 'Opening'}: ${opening}.`, true]] : [])];
    const f = fact(move);
    if (move.san.includes('#')) return [[f]];
    const seed = hash(`${ctrl.data.game.id}:${move.ply}:${move.uci}:${coach}:t`);
    const t = [trajectory(move.before, move.eval, move.color, seed), true];
    if (!GOOD.has(move.cls) && move.cls !== 'excellent' && move.cls !== 'good') return f ? [t, [f]] : [[t[0]]];
    return [[f || remark(ctrl, move)], t];
  }

  // ------------------------------------------------------- streaming ---

  // The comment is typed out word by word, like a chat reply. Every word is
  // laid out from the start, hidden until its turn, so the bubble has its
  // final size at once and stays put while the text comes in.
  // `dropped`: the droppable sentence didn't fit and stays out of every
  // redraw of this comment, so `shown` keeps counting the same words.
  const stream = { key: '', shown: 0, timer: 0, dropped: false };

  // Chess.com's Neo pieces, from its CDN like the board's.
  const pieceImg = cp => `<img class="cdc-pc" alt="" src="https://images.chesscomfiles.com/chess-themes/pieces/neo/150/${cp}.png">`;
  function token(kind, v) {
    if (kind === 'p') return pieceImg(v);
    if (kind === 's') return `<b class="cdc-sq">${v}</b>`;
    // A move: the piece that moves, then the notation, a promotion's piece
    // drawn too.
    const [c, san] = [v[0], v.slice(2)];
    const t = san.startsWith('O-O') ? 'k' : /^[KQRBN]/.test(san) ? san[0].toLowerCase() : 'p';
    const text = san.replace(/^[KQRBN]/, '').replace(/=([QRBN])/, (_, p) => '=' + pieceImg(c + p.toLowerCase()));
    return `<span class="cdc-mv">${pieceImg(c + t)}${text}</span>`;
  }

  function streamHtml(parts) {
    const key = parts.map(p => p[0]).join('|');
    if (key !== stream.key) {
      stream.key = key;
      stream.shown = 0;
      stream.dropped = false;
    }
    let i = 0;
    return parts
      .filter(([, drop]) => !(drop && stream.dropped))
      .map(([text, drop]) => {
        const words = typo(text).match(/\S+\s*/g) || [];
        const html = words
          .map(w => {
            const word = esc(w).replace(/\[\[(\w):(.+?)\]\]/g, (_, k, v) => token(k, v));
            return `<span class="cdc-w${i++ >= stream.shown ? ' cdc-w--off' : ''}">${word}</span>`;
          })
          .join('');
        return `<span class="cdc-say${drop ? ' cdc-say--drop' : ''}">${html} </span>`;
      })
      .join('');
  }

  // After a render: drop what doesn't fit, then carry on typing. Clamped
  // lines overflow by a whole line; a move chip pokes a pixel or so
  // out of the last line, which isn't a reason to drop anything.
  function startStream() {
    const sub = dom.panel.querySelector('.cdc-bubble__sub');
    if (!sub) return;
    const drop = sub.querySelector('.cdc-say--drop');
    if (drop && sub.scrollHeight > sub.clientHeight + (parseFloat(getComputedStyle(sub).lineHeight) || 18) / 2) {
      drop.remove();
      stream.dropped = true;
      // The words typed so far, without it: the ones still on show.
      if (stream.shown !== Infinity) stream.shown = sub.querySelectorAll('.cdc-w:not(.cdc-w--off)').length;
    }
    if (stream.shown < sub.querySelectorAll('.cdc-w').length && !stream.timer) {
      stream.timer = setInterval(tickStream, 35);
      tellCoach();
    }
  }

  function tickStream() {
    const words = dom.panel.querySelectorAll('.cdc-bubble__sub .cdc-w');
    const w = words[stream.shown++];
    if (w) w.className = 'cdc-w cdc-w--in';
    if (stream.shown >= words.length) {
      clearInterval(stream.timer);
      stream.timer = 0;
      tellCoach();
    }
  }

  // A new width: a comment already typed out is laid out afresh, whole,
  // so a sentence dropped for want of room comes back if there's room now.
  // Mid-way, it stays as it is: its words would be counted anew.
  function refitStream() {
    if (stream.timer) return;
    stream.dropped = false;
    stream.shown = Infinity;
  }

  // ------------------------------------------------------------- UI ---

  const html = document.documentElement;
  // The desktop layout, the only one with room for the review (review.css).
  const wide = matchMedia('(min-width: 1020px)');
  const state = {
    mode: 'summary', review: null, progress: 0, version: 0, error: null, lastKey: '',
    explain: false, playing: null, revealed: new Set(),
    bestOf: null, // { path, move }: the move whose best is shown on the board
    allRows: false, // the summary's chevron is open
  };

  function setMode(mode) {
    state.mode = mode;
    // The summary is shown until the user moves; then the move-by-move review.
    state.summaryPly = site.analysis?.node.ply;
    if (mode !== 'moves') stopPlaying();
    if (mode === 'moves') closeTools();
    html.classList.remove('cdc-review-normal', 'cdc-review-summary', 'cdc-review-moves', 'cdc-review-live');
    html.classList.add('cdc-review-' + mode);
    render(true);
  }

  function stopPlaying() {
    clearInterval(state.playing);
    state.playing = null;
  }

  // The move-by-move review stands in for Lichess's tools and controls.
  // Left open, their menu took its move list, and "practice with computer"
  // would even play moves, both with their buttons hidden: they close. (The
  // summary hides the tools whole, so a page opened in practice keeps it.)
  function closeTools() {
    const ctrl = site.analysis;
    if (!ctrl) return;
    if (typeof ctrl.actionMenu === 'function' && ctrl.actionMenu()) ctrl.actionMenu(false);
    if (ctrl.practice) ctrl.togglePractice?.(false);
    ctrl.redraw?.();
  }

  function togglePlay(ctrl) {
    if (state.playing) return stopPlaying();
    const step = () => {
      const last = ctrl.mainline.length - 1;
      if (!ctrl.onMainline || ctrl.node.ply >= last) return stopPlaying(), render(true);
      jump(ctrl, ctrl.node.ply + 1);
    };
    state.playing = setInterval(step, 1200);
    step();
  }

  const el = (tag, attrs = {}, htmlText = '') => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.innerHTML = htmlText;
    return e;
  };

  const dom = {
    panel: el('div', { id: 'cdc-review' }),
    graphBox: el('div', { id: 'cdc-review-graph' }),
    controls: el('div', { id: 'cdc-review-controls' }),
    bar: el('div', { id: 'cdc-evalbar' }, '<div class="cdc-evalbar__fill"></div><span class="cdc-evalbar__label"></span>'),
    overlay: el('div', { id: 'cdc-board-overlay' }),
    opening: el('div', { id: 'cdc-opening' }),
  };

  function ensureAttached(ctrl) {
    const main = document.querySelector('main.analyse');
    const board = main?.querySelector('.analyse__board');
    if (!main || !board) return false;
    for (const node of [dom.panel, dom.graphBox, dom.controls, dom.bar]) if (node.parentNode !== main) main.appendChild(node);
    if (dom.overlay.parentNode !== board) board.appendChild(dom.overlay);
    return true;
  }

  const playerName = p => p?.user?.username || p?.name || (p?.ai ? `Stockfish ${p.ai}` : T.anonymous);

  function players(ctrl) {
    const d = ctrl.data;
    const byColor = { [d.player.color]: d.player, [d.opponent.color]: d.opponent };
    return { w: byColor.white, b: byColor.black };
  }

  // `review.total` (positions in the game) spaces the graph for the whole
  // game while its analysis fills in: a position not known yet leaves a gap.
  function graphSvg(review, ply, width, height) {
    const n = (review.total || review.positions.length) - 1 || 1;
    const x = i => ((i / n) * width).toFixed(1);
    const y = wp => (height - (Math.max(0, Math.min(100, wp)) / 100) * height).toFixed(1);
    const runs = [];
    review.positions.forEach((p, i) => {
      if (!p) return;
      if (!review.positions[i - 1]) runs.push([]);
      runs[runs.length - 1].push(i);
    });
    const area = runs
      .map(r => `M${x(r[0])},${height} L${r.map(i => `${x(i)},${y(review.positions[i].wp)}`).join(' L')} L${x(r[r.length - 1])},${height} Z`)
      .join(' ');
    const dots = (review.draft || review.moves)
      .filter(m => m && GRAPH_DOTS.has(m.cls) && review.positions[m.ply])
      .map(m => `<circle cx="${x(m.ply)}" cy="${y(review.positions[m.ply].wp)}" r="3.5" fill="${CLS[m.cls].color}"/>`)
      .join('');
    const marker = ply > 0 ? `<line x1="${x(ply)}" x2="${x(ply)}" y1="0" y2="${height}" stroke="#81b64c" stroke-width="2"/>` : '';
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#403d39"/>
      <path d="${area}" fill="#fff"/>
      <line x1="0" x2="${width}" y1="${height / 2}" y2="${height / 2}" stroke="#8b8987" stroke-width="1" opacity="0.6"/>
      ${marker}${dots}</svg>`;
  }

  function mountGraph(container, review, ply, ctrl) {
    const cs = getComputedStyle(container);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const width = Math.max(100, Math.floor(container.clientWidth - padX));
    const height = Math.max(40, Math.floor(container.clientHeight - padY));
    container.innerHTML = graphSvg(review, ply, width, height) + '<span class="cdc-graph-tip"></span>';
    // The first time each graph shows, it draws itself from left to right.
    const kind = container === dom.graphBox ? 'moves' : 'summary';
    if (!state.revealed.has(kind)) {
      state.revealed.add(kind);
      container.firstElementChild.classList.add('cdc-graph-reveal');
    }
    const n = (review.total || review.positions.length) - 1;
    const plyAt = e => {
      const r = container.getBoundingClientRect();
      return Math.max(0, Math.min(n, Math.round(((e.clientX - r.left - padX / 2) / width) * n)));
    };
    const tip = container.lastElementChild;
    container.onmousemove = e => {
      const i = plyAt(e);
      const p = review.positions[i];
      if (!p) return void (tip.style.display = 'none');
      tip.textContent = formatEval(p) || '0.00';
      tip.style.display = 'block';
      const x = padX / 2 + (i / (n || 1)) * width;
      tip.style.left = Math.max(padX / 2, Math.min(container.clientWidth - padX / 2 - tip.offsetWidth, x - tip.offsetWidth / 2)) + 'px';
    };
    container.onmouseleave = () => (tip.style.display = 'none');
    container.onclick = e => {
      stopPlaying();
      jump(ctrl, plyAt(e));
      if (state.mode === 'summary') setMode('moves');
    };
  }

  // The move on the board: the game's, from the review, or one played off
  // it, judged as it comes (see "live"). Null until then.
  function reviewMove(ctrl) {
    if (!state.review || !ctrl.path) return null;
    return (ctrl.onMainline ? state.review.moves[ctrl.node.ply - 1] : judgeAt(ctrl, ctrl.path)) || null;
  }

  // The engine's best move instead of the one played, played on the board
  // as a variation, like Chess.com's "Best" button.
  function bestShown(ctrl) {
    const b = state.bestOf;
    const chess960 = ctrl.data.game.variant?.key === 'chess960';
    if (!b || ctrl.path === b.path || ctrl.path !== b.path.slice(0, -2) + ctrl.node.id) return null;
    return normUci(ctrl.node.uci, chess960) === b.move.best ? b.move : null;
  }

  function showBest(ctrl) {
    if (bestShown(ctrl)) return goTo(ctrl, state.bestOf.path);
    const m = reviewMove(ctrl);
    if (!m?.best || typeof ctrl.playUci !== 'function') return;
    state.bestOf = { path: ctrl.path, move: m };
    goTo(ctrl, ctrl.path.slice(0, -2));
    ctrl.playUci(m.best);
    ctrl.redraw?.();
  }

  // Where the arrows lead, along the line on the board: from the best move
  // shown, back to the move it stands for, or on to the one after that.
  function stepPath(ctrl, dir) {
    const from = bestShown(ctrl) ? state.bestOf.path : ctrl.path;
    if (dir < 0) return from === ctrl.path ? (from ? from.slice(0, -2) : null) : from;
    const next = ctrl.tree.nodeAtPath(from).children[0];
    return next ? from + next.id : null;
  }

  function jump(ctrl, ply) {
    ctrl.jumpToMain(ply);
    ctrl.redraw?.();
  }

  function goTo(ctrl, path) {
    ctrl.userJump(path);
    ctrl.redraw?.();
  }

  const icon = cls => `<span class="cdc-cls-icon">${CLS[cls].svg}</span>`;

  // Back and close as drawn icons of one size: the font's "←" is a sliver
  // next to its "✕".
  const headIcon = d =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const BACK_ICON = headIcon('M19 12H5M11 5l-7 7 7 7');
  const CLOSE_ICON = headIcon('M6 6l12 12M18 6 6 18');

  function header(title, back) {
    return `<div class="cdc-review__head">
      ${back ? `<button class="cdc-review__back" data-cdc="${back}" title="${esc(T.back)}" aria-label="${esc(T.back)}">${BACK_ICON}</button>` : '<span></span>'}
      <div class="cdc-review__title"><span class="cdc-review__star">★</span>${esc(title)}</div>
      <button class="cdc-review__close" data-cdc="normal" title="${esc(T.close)}" aria-label="${esc(T.close)}">${CLOSE_ICON}</button>
    </div>`;
  }

  // Like Chess.com, the summary keeps its layout while the game is analyzed:
  // a quote from the coach, the graph, the accuracy and the counts filling
  // in, first from the quick pass's draft, then at full depth. The game
  // rating waits for the last move; the review can start at once.
  function renderSummary(ctrl) {
    const p = players(ctrl);
    const r = state.review;
    const loading = !r?.complete && !state.error;
    const pct = Math.round(state.progress * 100);
    const say = state.error ? esc(state.error) : loading ? esc(QUOTE) : esc(T.intro);
    const acc = c => (r?.accuracy[c] == null ? '&nbsp;' : r.accuracy[c].toFixed(1));
    const brilliant = r && (r.counts.w.brilliant || r.counts.b.brilliant);
    const rows = CLASSES.filter(c => state.allRows || SUMMARY_ROWS.has(c.key) || (c.key === 'brilliant' && brilliant)).map(
      c => `<tr><td class="cdc-t-label">${esc(c.label)}</td>
        <td class="cdc-t-num" style="color:${c.color}">${r?.counts.w[c.key] || 0}</td>
        <td class="cdc-t-icon">${icon(c.key)}</td>
        <td class="cdc-t-num" style="color:${c.color}">${r?.counts.b[c.key] || 0}</td></tr>`,
    ).join('');
    const more = state.allRows ? T.less : T.more;
    const toggle = `<tr class="cdc-t-more"><td colspan="4"><button class="cdc-review__more${state.allRows ? ' cdc-review__more--open' : ''}" data-cdc="rows" title="${esc(more)}" aria-label="${esc(more)}" aria-expanded="${state.allRows}">${headIcon('M6 9l6 6 6-6')}</button></td></tr>
      <tr class="cdc-t-sep"><td colspan="4"></td></tr>`;
    // Under them, as on Chess.com: the rating each side played at, then a
    // verdict per phase, as the icon of the class it deserves (a phase the
    // game never reached goes once it's analyzed).
    const elo = c => r?.rating?.[c]?.elo ?? '&nbsp;';
    const phase = (c, ph) => {
      const cls = r?.rating?.[c]?.phases[ph];
      return cls ? icon(cls) : '';
    };
    const rating = `<tr class="cdc-t-rating"><td class="cdc-t-label"><span data-cdc-tip="${esc(T.gameRatingTip)}">${esc(T.gameRating)}</span></td>
        <td><span class="cdc-acc cdc-acc--w">${elo('w')}</span></td><td></td>
        <td><span class="cdc-acc cdc-acc--b">${elo('b')}</span></td></tr>
      <tr class="cdc-t-sep"><td colspan="4"></td></tr>
      ${PHASES.filter(ph => !r?.rating || r.rating.w?.phases[ph] || r.rating.b?.phases[ph]).map(ph => `<tr class="cdc-t-phase"><td class="cdc-t-label">${esc(T.phases[ph])}</td><td>${phase('w', ph)}</td><td></td><td>${phase('b', ph)}</td></tr>`).join('')}`;
    // Only the classification rows scroll: they're a table of their own, with
    // the same fixed columns as the one above so the two line up.
    const cols = '<colgroup><col class="cdc-t-c-label"><col><col class="cdc-t-c-icon"><col></colgroup>';
    dom.panel.innerHTML = `${header(T.review, 'normal')}
      <div class="cdc-coach cdc-coach--summary">${coachAvatar()}
        <div class="cdc-bubble"><p class="cdc-bubble__say">${say}</p></div></div>
      <div class="cdc-review__top">
        <div class="cdc-review__graph cdc-summary-graph"></div>
        <table class="cdc-review__table">${cols}
          <tr class="cdc-t-names"><td></td><td title="${esc(playerName(p.w))}">${esc(playerName(p.w))}</td><td></td><td title="${esc(playerName(p.b))}">${esc(playerName(p.b))}</td></tr>
          <tr><td class="cdc-t-label">${esc(T.players)}</td><td><span class="cdc-avatar"></span></td><td></td><td><span class="cdc-avatar"></span></td></tr>
          <tr><td class="cdc-t-label">${esc(T.accuracy)}</td>
            <td><span class="cdc-acc cdc-acc--w">${acc('w')}</span></td><td></td>
            <td><span class="cdc-acc cdc-acc--b">${acc('b')}</span></td></tr>
          <tr class="cdc-t-sep"><td colspan="4"></td></tr>
        </table>
      </div>
      <div class="cdc-review__body">
        <table class="cdc-review__table${loading ? ' cdc-review__table--loading' : ''}">${cols}${rows}${toggle}${rating}</table>
      </div>
      <div class="cdc-review__foot"><button class="cdc-btn cdc-btn--green" data-cdc="moves" ${r && !state.error ? '' : 'disabled'}>${esc(T.start)}</button></div>`;
    const g = dom.panel.querySelector('.cdc-summary-graph');
    if (r) mountGraph(g, r, ctrl.node.ply, ctrl);
    if (loading) g.insertAdjacentHTML('afterbegin', `<span class="cdc-summary-pct">${pct}%</span>`);
  }

  // The verdict, with the move's piece as a solid figurine like Chess.com,
  // drawn by Lichess's "Noto Chess" font. Only the icon is colored.
  const FIGURINES = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' };
  const title = (c, san) =>
    esc(typo(c.sentence)).replace('{m}', esc(san).replace(/[KQRBN]/g, p => `<span class="cdc-fig">${FIGURINES[p]}</span>`));

  // Like Chess.com, the score is dark when Black is better.
  const evalChip = e =>
    `<span class="cdc-bubble__eval${(e?.mate ?? e?.cp ?? 0) < 0 || (e?.mate === 0 && e.wp < 50) ? ' cdc-bubble__eval--black' : ''}">${esc(formatEval(e))}</span>`;

  // The bubble for a judged move: icon, verdict and score, then the comment.
  const verdict = (ctrl, move, hint) =>
    `<div class="cdc-bubble__row">${icon(move.cls)}
      <p class="cdc-bubble__title">${title(CLS[move.cls], move.san)}</p>
      ${evalChip(move.eval)}</div>
    <p class="cdc-bubble__sub">${streamHtml(hint ? [[hint]] : explanation(ctrl, move))}</p>`;

  function renderMoves(ctrl) {
    const r = state.review;
    const ply = ctrl.node.ply;
    const move = reviewMove(ctrl);
    const shown = bestShown(ctrl);
    let bubble;
    if (!r) bubble = `<p class="cdc-bubble__title">${esc(T.analysing)} ${Math.round(state.progress * 100)}%</p>`;
    else if (shown)
      bubble = `<div class="cdc-bubble__row">${icon('best')}
          <p class="cdc-bubble__title">${title(CLS.best, ctrl.node.san)}</p>
          ${evalChip(shown.before)}</div>`;
    else if (!move) {
      // A move waits for the engine, the game's included while it runs.
      const say = !ctrl.path ? T.intro : (ctrl.onMainline ? state.error : live.error) || T.thinking;
      bubble = `<p class="cdc-bubble__title">${esc(say)}</p>`;
    } else {
      const good = GOOD.has(move.cls);
      // Explain swaps the remark for the opening's name, or the move that
      // was best: the bubble has room for two lines under the title.
      const hint = !state.explain
        ? ''
        : move.cls === 'book'
          ? (move.opening ?? state.openingName) || ''
          : !good && move.bestSan
            ? T.bestWas.replace('{m}', mv(move.bestSan, move.color))
            : '';
      bubble = verdict(ctrl, move, hint);
    }
    const atEnd = !stepPath(ctrl, 1);
    const canBest = shown || (move && move.best && !GOOD.has(move.cls));
    dom.panel.innerHTML = `${header(T.review, 'summary')}
      <div class="cdc-coach">${coachAvatar(!shown && move?.cls, ctrl.path)}<div class="cdc-bubble">${bubble}</div></div>
      <div class="cdc-review__nav">
        <button class="cdc-btn${state.explain ? ' cdc-btn--on' : ''}" data-cdc="explain">${svgIcon('bulb')}${esc(T.explain)}</button>
        <button class="cdc-btn${shown ? ' cdc-btn--on' : ''}" data-cdc="best" ${canBest ? '' : 'disabled'}>${svgIcon('star')}${esc(T.best)}</button>
        <button class="cdc-btn cdc-btn--green" data-cdc="next" ${atEnd ? 'disabled' : ''}>${svgIcon('arrow')}${esc(T.next)}</button>
      </div>`;
    dom.controls.innerHTML = ['first', 'prev', state.playing ? 'pause' : 'play', 'next', 'last']
      .map(a => `<button class="cdc-btn" data-cdc="${a === 'pause' ? 'play' : a}">${svgIcon(a)}</button>`)
      .join('');
    movesGraph(ctrl, true);
    // jumpToMain doesn't scroll Lichess's move list; keep the move in view.
    requestAnimationFrame(() => {
      const box = document.querySelector('main.analyse .analyse__moves');
      const active = box?.querySelector('move.active');
      if (!active) return;
      const top = active.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTop = top - box.clientHeight / 2 + active.offsetHeight / 2;
    });
  }

  // Review closed: like Chess.com's analysis tab, the player's best moves
  // over a big Game Review button.
  function renderNormal(ctrl) {
    const r = state.review;
    const color = ctrl.getOrientation()[0];
    const line = state.error
      ? `<span class="cdc-review__progress">${esc(state.error)}</span>`
      : !r?.complete
        ? `<span class="cdc-review__progress">${esc(T.analysing)} ${Math.round(state.progress * 100)}%</span>`
        : COUNTED.filter(k => r.counts[color][k])
            .map(k => `<span class="cdc-review__count" style="color:${CLS[k].color}">${icon(k)}${esc(countLabel(k, r.counts[color][k]))}</span>`)
            .join('');
    dom.panel.innerHTML = `<div class="cdc-review__counts">${line}</div>
      <button class="cdc-btn cdc-btn--green cdc-review__open" data-cdc="summary"><span class="cdc-review__star">★</span>${esc(T.review)}</button>`;
  }

  // The free analysis board: the coach judges the move on the board, over
  // Lichess's own engine lines and moves.
  function renderLive(ctrl) {
    const move = judgeAt(ctrl, ctrl.path);
    const bubble = live.error
      ? `<p class="cdc-bubble__title">${esc(live.error)}</p>`
      : !ctrl.path
        ? `<p class="cdc-bubble__title">${esc(T.liveIntro)}</p>`
        : !move
          ? `<p class="cdc-bubble__title">${esc(T.thinking)}</p>`
          : verdict(ctrl, move);
    dom.panel.innerHTML = `<div class="cdc-coach">${coachAvatar(!live.error && move?.cls, ctrl.path)}<div class="cdc-bubble">${bubble}</div></div>`;
  }

  // Eval bar, board badge / arrow / square colors, move list badges.
  function renderBoard(ctrl) {
    const r = state.review;
    const ply = ctrl.node.ply;
    const onMain = ctrl.onMainline;
    const orientation = ctrl.getOrientation();
    const reviewing = state.mode !== 'normal';
    const isLive = state.mode === 'live';

    const shown = isLive ? null : bestShown(ctrl);

    // Eval bar. The best move keeps the eval of the position before it. The
    // free board keeps Lichess's, fed by its live engine.
    const pos = isLive || !r ? null : shown ? shown.before : onMain ? r.positions[ply] : reviewing ? live.evals.get(ctrl.node.fen) : null;
    html.classList.toggle('cdc-evalbar-on', !!pos);
    if (pos) {
      const whiteShare = pos.wp;
      dom.bar.classList.toggle('cdc-evalbar--flip', orientation === 'black');
      dom.bar.querySelector('.cdc-evalbar__fill').style.height = whiteShare + '%';
      const label = dom.bar.querySelector('.cdc-evalbar__label');
      label.textContent = barLabel(pos);
      label.className = 'cdc-evalbar__label ' + (whiteShare >= 50 ? 'cdc-evalbar__label--white' : 'cdc-evalbar__label--black');
    }

    // Board overlay. Below 1020px Lichess's mobile layout has no room for
    // the review's panel (review.css hides it), and so no way to close the
    // review: the board stays Lichess's too.
    const move = !wide.matches
      ? null
      : isLive
        ? judgeAt(ctrl, ctrl.path)
        : shown ? { ...shown, cls: 'best' } : reviewing ? reviewMove(ctrl) : null;
    html.dataset.cdcCls = move ? move.cls : '';
    let overlay = '';
    if (move) {
      const toXY = key => {
        const [f, rk] = fr2(key);
        return orientation === 'white' ? [f, 7 - rk] : [7 - f, rk];
      };
      const node = ctrl.node;
      let dest = node.uci.slice(2, 4);
      if (node.san.startsWith('O-O')) dest = (node.san.startsWith('O-O-O') ? 'c' : 'g') + node.uci[1];
      const [dx, dy] = toXY(dest);
      const c = CLS[move.cls];
      overlay = `<div class="cdc-badge" style="left:${(dx + 1) * 12.5}%;top:${dy * 12.5}%">${c.svg}</div>`;
    }
    if (dom.overlay.innerHTML !== overlay) dom.overlay.innerHTML = overlay;
    // The best move, drawn by board.js with the other arrows. Off the game's
    // moves, the engine's move from here too, as the free board has Lichess's.
    const showBest = move && move.best && !GOOD.has(move.cls);
    const arrows = showBest ? [{ orig: move.best.slice(0, 2), dest: move.best.slice(2, 4), brush: 'best' }] : [];
    const next = wide.matches && reviewing && r && !onMain ? live.evals.get(ctrl.node.fen)?.best : null;
    if (next) arrows.push({ orig: next.slice(0, 2), dest: next.slice(2, 4), brush: 'engine' });
    window.cdcReviewArrows = arrows;

    // Move list badges.
    if (isLive) {
      liveBadges(ctrl);
      renderOpening(ctrl);
    }
    else if (r) {
      const tree = document.querySelector('main.analyse .tview2');
      const mainMoves = tree ? [...tree.querySelectorAll(':scope > move:not(.empty)')] : [];
      mainMoves.forEach((m, i) => {
        const mv = r.draft[i];
        if (!mv || m.dataset.cdcCls === mv.cls) return;
        const c = CLS[mv.cls];
        m.dataset.cdcCls = mv.cls;
        m.style.setProperty('--c', c.color);
        m.style.setProperty('--i', c.img);
        const badge = LIST_BADGES.has(mv.cls) && !(mv.cls === 'book' && r.draft[i + 1]?.cls === 'book');
        if (badge) m.dataset.cdcBadge = '';
        else delete m.dataset.cdcBadge;
      });
      if (!tree) return;
      // Rows striped per move number, so a variation in between doesn't
      // shift the stripes (review.css).
      let even = false;
      for (const el of tree.children) {
        if (el.tagName === 'INDEX') even = parseInt(el.textContent, 10) % 2 === 0;
        if (el.tagName !== 'INTERRUPT' && even !== 'cdcEven' in el.dataset) mark(el, 'cdcEven', even);
      }
      // The variations played here show, not Lichess's computer lines.
      for (const l of tree.querySelectorAll('interrupt line')) {
        const p = l.querySelector('move[p]')?.getAttribute('p');
        const own = !!p && !ctrl.tree.nodeAtPath(p)?.comp;
        if (own !== 'cdcVar' in l.dataset) mark(l, 'cdcVar', own);
      }
      liveBadges(ctrl, [...tree.querySelectorAll('interrupt line[data-cdc-var] move[p]')]);
    }
  }

  const mark = (el, key, on) => (on ? (el.dataset[key] = '') : delete el.dataset[key]);

  // The move-by-move graph, drawn again as the analysis fills it in. Only
  // the graph: redrawing the panel would restart what's hovered or clicked.
  function movesGraph(ctrl, force) {
    const r = state.review;
    if (!r) return void (dom.graphBox.innerHTML = '');
    if (!force && dom.graphBox.dataset.v === String(state.version)) return;
    dom.graphBox.dataset.v = state.version;
    mountGraph(dom.graphBox, r, ctrl.node.ply, ctrl);
  }

  function render(force) {
    const ctrl = site.analysis;
    if (!ctrl || !ensureAttached(ctrl)) return;
    if (state.mode === 'summary' && ctrl.node.ply !== state.summaryPly) return setMode('moves');
    // Off the game's moves, the review judges them like the free board.
    if (state.mode === 'live' || (state.mode === 'moves' && state.review)) pump(ctrl);
    // The summary and the closed panel show the analysis's progress, in
    // steps (a graph position known, the next percent of the full depth);
    // the review only the move on the board.
    const r = state.review;
    const known = r ? r.positions.filter(Boolean).length : 0;
    const progress = state.mode === 'moves' ? '' : [Math.round(state.progress * 100), Math.round((known / ctrl.mainline.length) * 20), !!r?.complete];
    const key =
      state.mode === 'live'
        ? ['live', ctrl.path, liveDigest(judgeAt(ctrl, ctrl.path)), live.error].join('|')
        : [state.mode, ctrl.path, ctrl.onMainline, ctrl.getOrientation(), !!r, progress, state.error, state.explain, !!state.playing,
            liveDigest(reviewMove(ctrl)), live.error].join('|');
    if (force || key !== state.lastKey) {
      state.lastKey = key;
      hideTip();
      // A button the render leaves as it was stays the same element, so a
      // click spanning a redraw still lands (the summary's Start button
      // redraws with every step of the analysis).
      const kept = new Map([...dom.panel.querySelectorAll('button[data-cdc]:not([data-cdc="coach"])')].map(b => [b.outerHTML, b]));
      if (state.mode === 'summary') renderSummary(ctrl);
      else if (state.mode === 'moves') renderMoves(ctrl);
      else if (state.mode === 'live') renderLive(ctrl);
      else renderNormal(ctrl);
      for (const b of dom.panel.querySelectorAll('button[data-cdc]:not([data-cdc="coach"])')) {
        const old = kept.get(b.outerHTML);
        if (old && old !== b) b.replaceWith(old);
      }
      keepAvatar();
      startStream();
      fitBubble();
    }
    if (state.mode === 'moves') movesGraph(ctrl);
    renderBoard(ctrl);
  }

  // The coach's bubble is centered on its tail, which stays at the coach's
  // chin (review.css); CSS can't read an element's height, so hand it over.
  // It only moves the bubble, never resizes it, so it can't loop.
  const bubbleSize = new ResizeObserver(entries => {
    for (const e of entries) e.target.style.setProperty('--cdc-bubble-h', `${e.borderBoxSize[0].blockSize}px`);
  });
  function fitBubble() {
    bubbleSize.disconnect();
    const bubble = dom.panel.querySelector('.cdc-bubble');
    if (bubble) bubbleSize.observe(bubble);
  }

  const onClick = e => {
    const btn = e.target.closest('[data-cdc]');
    if (!btn || btn.disabled) return;
    const ctrl = site.analysis;
    const act = btn.dataset.cdc;
    if (act === 'coach') {
      coach = (coach % COACHES) + 1;
      localStorage.setItem('cdc-coach', coach);
      btn.dataset.coach = coach;
      tellCoach();
      // Each coach words the remarks their own way.
      if (state.mode === 'moves' || state.mode === 'live') render(true);
      return;
    }
    const last = ctrl.mainline.length - 1;
    if (act !== 'play') stopPlaying();
    if (act === 'play') togglePlay(ctrl);
    else if (act === 'explain') state.explain = !state.explain;
    else if (act === 'rows') state.allRows = !state.allRows;
    else if (act === 'first') jump(ctrl, 0);
    else if (act === 'last') jump(ctrl, last);
    else if (act === 'prev' || act === 'next') {
      const path = stepPath(ctrl, act === 'prev' ? -1 : 1);
      if (path !== null) goTo(ctrl, path);
    } else if (act === 'best') showBest(ctrl);
    else {
      // Starting the review goes to the first move.
      if (act === 'moves' && (!ctrl.onMainline || ctrl.node.ply === 0)) jump(ctrl, 1);
      setMode(act);
    }
    render(true);
  };
  dom.panel.addEventListener('click', onClick);
  dom.controls.addEventListener('click', onClick);

  // Chess.com's tooltip: dark, over what it explains, its tail pointing at
  // it. On <body>, as the panel's rows scroll and would clip it.
  const tip = el('div', { id: 'cdc-tip', role: 'tooltip' });
  const hideTip = () => tip.remove();
  dom.panel.addEventListener('pointerover', e => {
    const t = e.target.closest('[data-cdc-tip]');
    if (!t) return;
    tip.textContent = t.dataset.cdcTip;
    document.body.appendChild(tip);
    const a = t.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, a.left + a.width / 2 - w / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${a.top - tip.offsetHeight - 10}px`;
    tip.style.setProperty('--cdc-tip-x', `${a.left + a.width / 2 - left}px`);
  });
  dom.panel.addEventListener('pointerout', e => {
    const t = e.target.closest('[data-cdc-tip]');
    if (t && !t.contains(e.relatedTarget)) hideTip();
  });
  dom.panel.addEventListener('scroll', hideTip, true);


  // ------------------------------------------------------------ live ---

  // The free analysis board has no game to review up front: its tree grows
  // as the user plays. So every position is analyzed once, by FEN, the one
  // on the board first, and every move of the tree is judged from its two
  // positions as soon as they're known.
  const BOOK_PLIES = 30; // deeper than this, no move is "book"
  const BOOK_GAMES = 10; // master games a position needs to be "book"
  const live = {
    evals: new Map(), // fen -> engine record
    books: new Map(), // fen -> { book, name } from Lichess's masters database
    judged: new Map(), // path -> { node, move }
    engine: null, booting: null, busy: false, bookBusy: false, noBook: false, error: null,
  };

  function changed() {
    live.judged.clear();
    render();
  }

  // Whether the move to `path` is a book move: every move up to it is played
  // in master games. Undefined while that's still being looked up.
  function bookAt(ctrl, path) {
    let book = true;
    for (let i = 2; i <= path.length && book; i += 2) {
      const node = ctrl.tree.nodeAtPath(path.slice(0, i));
      if (live.noBook || node.ply > BOOK_PLIES) return false;
      book = live.books.get(node.fen)?.book;
    }
    return book;
  }

  // The last named opening along `path`: a move out of the book keeps the
  // name of the line it left.
  const openingAt = (ctrl, path) => {
    for (; path; path = path.slice(0, -2)) {
      const b = live.books.get(ctrl.tree.nodeAtPath(path).fen);
      if (b?.name) return b;
    }
    return null;
  };

  // The move to `path`, judged, or null until its positions are analyzed.
  function judgeAt(ctrl, path) {
    if (!path) return null;
    const node = ctrl.tree.nodeAtPath(path);
    if (node.id !== path.slice(-2)) return null; // a stale path
    const hit = live.judged.get(path);
    if (hit?.node === node) return hit.move;
    const up = path.slice(0, -2), prev = ctrl.tree.nodeAtPath(up);
    const a = live.evals.get(prev.fen), b = live.evals.get(node.fen), book = bookAt(ctrl, path);
    let move = null;
    if (a && b && book !== undefined) {
      move = judge(prev, node, a, b, judgeAt(ctrl, up), book, ctrl.data.game.variant?.key === 'chess960');
      move.opening = openingAt(ctrl, path)?.name || '';
    }
    live.judged.set(path, { node, move });
    return move;
  }

  // What the bubble shows, to redraw it only when that changes.
  const liveDigest = m => (m ? [m.cls, formatEval(m.eval), m.eval.best, m.best, m.opening, m.prevMove?.cls].join(',') : '');

  const treeMoves = () => [...document.querySelectorAll('main.analyse .tview2 move[p]')];

  // Positions to analyze, most urgent first: the move on the board (its
  // position, the one before, and the one before that for a miss), the next
  // move, the rest of the line, then everything else in the move list.
  function wanted(ctrl) {
    const path = ctrl.nodeList, out = [];
    const after = [];
    for (let n = ctrl.node.children[0]; n; n = n.children[0]) after.push(n);
    out.push(...path.slice(-3).reverse(), ...after.slice(0, 1), ...path.slice(0, -3).reverse(), ...after.slice(1));
    out.push(...ctrl.mainline);
    for (const m of treeMoves()) out.push(ctrl.tree.nodeAtPath(m.getAttribute('p')));
    return out;
  }

  // The first position along `path` not yet looked up in the masters
  // database, while the line is still in it.
  function bookGap(ctrl, path) {
    for (let i = 2; i <= path.length; i += 2) {
      const node = ctrl.tree.nodeAtPath(path.slice(0, i));
      if (node.ply > BOOK_PLIES) return null;
      const b = live.books.get(node.fen);
      if (!b) return node.fen;
      if (!b.book) return null;
    }
    return null;
  }

  function pump(ctrl) {
    if (!live.busy && !live.error) {
      // A game's own positions are its analysis's to run (analyseGame).
      const game = ctrl.synthetic ? null : new Set(work.nodes.map(n => n.fen));
      const node = wanted(ctrl).find(n => !live.evals.has(n.fen) && !game?.has(n.fen));
      if (node) analyseLive(ctrl, node.fen);
    }
    if (!live.bookBusy && !live.noBook) {
      let line = ctrl.path;
      for (let n = ctrl.node.children[0]; n; n = n.children[0]) line += n.id;
      const paths = [line, ctrl.mainline.slice(1).map(n => n.id).join(''), ...treeMoves().map(m => m.getAttribute('p'))];
      for (const p of paths) {
        const fen = bookGap(ctrl, p);
        if (fen) return lookUpBook(ctrl, fen);
      }
    }
  }

  async function analyseLive(ctrl, fen) {
    live.busy = true;
    try {
      const engine = await engineFor(ctrl);
      live.evals.set(fen, toRecord(fen, await engine.analyse(fen)));
    } catch (err) {
      console.error('[LichessDotCom] engine failed', err);
      live.error = T.engineError;
    }
    live.busy = false;
    changed();
  }

  // Lichess's opening explorer, as its analysis board uses it. The masters
  // database needs an account: signed out, no move is book. A lookup that
  // hangs gives up too, or the moves waiting on it would never be judged.
  async function lookUpBook(ctrl, fen) {
    live.bookBusy = true;
    try {
      const late = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000));
      const d = await Promise.race([ctrl.explorer.fetchMasterOpening(fen), late]);
      live.books.set(fen, { book: d.white + d.draws + d.black >= BOOK_GAMES, name: d.opening?.name || '', eco: d.opening?.eco || '' });
    } catch {
      live.noBook = true;
    }
    live.bookBusy = false;
    changed();
  }

  // The opening's name over Lichess's move list, like Chess.com's. It comes
  // from the masters database, which needs an account: signed out, there's
  // no line at all. It's ours, appended to Lichess's panel and put above
  // the moves by review.css, so Lichess's own children never move.
  function renderOpening(ctrl) {
    const tools = document.querySelector('main.analyse .analyse__tools');
    if (!tools) return;
    if (dom.opening.parentNode !== tools) tools.appendChild(dom.opening);
    const o = !ctrl.explorer?.isAuth?.() || live.noBook
      ? null
      : ctrl.path ? openingAt(ctrl, ctrl.path) : { name: window.i18n?.site?.startPosition || T.startPosition, eco: '' };
    const key = o ? `${o.eco}|${o.name}` : '';
    if (dom.opening.dataset.key === key) return;
    dom.opening.dataset.key = key;
    html.classList.toggle('cdc-opening-on', !!o);
    if (!o) return void (dom.opening.innerHTML = '');
    // "Ruy Lopez: Morphy Defense": the family bold, then the variation.
    const [family, ...rest] = o.name.split(': ');
    dom.opening.title = o.name;
    dom.opening.style.setProperty('--i', CLS.book.img);
    dom.opening.innerHTML = `<i class="cdc-opening__icon"></i>${o.eco ? `<span class="cdc-opening__eco">${esc(o.eco)}</span>` : ''}<span class="cdc-opening__name"><b>${esc(family)}</b>${rest.length ? `: ${esc(rest.join(': '))}` : ''}</span>`;
  }

  // Badges in Lichess's move list, variations included: each move carries
  // its path in the tree.
  function liveBadges(ctrl, moves = treeMoves()) {
    for (const m of moves) {
      const path = m.getAttribute('p');
      const mv = judgeAt(ctrl, path);
      const cls = mv?.cls || '';
      const next = mv?.node.children[0];
      const badge = !!mv && LIST_BADGES.has(cls) && !(cls === 'book' && next && bookAt(ctrl, path + next.id) === true);
      if ((m.dataset.cdcCls || '') === cls && 'cdcBadge' in m.dataset === badge) continue;
      if (!mv) {
        delete m.dataset.cdcCls;
        delete m.dataset.cdcBadge;
        continue;
      }
      m.dataset.cdcCls = cls;
      m.style.setProperty('--c', CLS[cls].color);
      m.style.setProperty('--i', CLS[cls].img);
      if (badge) m.dataset.cdcBadge = '';
      else delete m.dataset.cdcBadge;
    }
  }

  // ------------------------------------------------------------ main ---

  // The game's analysis, filled in as it comes. `deep` is what verdicts are
  // made from: the engine at full depth, or Lichess's cloud. `rough` only
  // stands in on the graph and the eval bar until then: the quick pass, or
  // the game's own server analysis. A deep record is never replaced, so a
  // move, once judged, stays as it is.
  const work = { nodes: [], deep: [], rough: [], moves: [], bookPly: 0, cloudAt: Infinity };

  async function analyseGame(ctrl) {
    const game = ctrl.data.game;
    const nodes = (work.nodes = ctrl.mainline);
    const cacheKey = `cdc-review:${game.id}:${nodes.length}:v${CACHE_VERSION}`;

    try {
      const res = await fetch(`/game/export/${game.id}?opening=true&moves=false&clocks=false&evals=true`, {
        headers: { Accept: 'application/json' },
      });
      const info = await res.json();
      work.bookPly = info.opening?.ply || 0;
      state.openingName = info.opening?.name || '';
      // Lichess's server analysis, when someone asked for it: every position
      // after a move, from White's view, one line only (no second best to
      // tell a great move by, the best move only after a mistake). Enough
      // for the graph at once, not for the verdicts.
      (info.analysis || []).forEach((e, i) => {
        if (i + 1 >= nodes.length) return;
        if (e.mate !== undefined) work.rough[i + 1] = { mate: e.mate, wp: e.mate > 0 ? 100 : 0, wp2: null, best: null };
        else if (e.eval !== undefined) work.rough[i + 1] = { cp: e.eval, wp: winPct(e.eval), wp2: null, best: null };
      });
    } catch {}
    seedBooks(ctrl);

    let cached = null;
    try {
      cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    } catch {}
    if (cached?.length === nodes.length) cached.forEach((p, i) => setDeep(i, p));
    refresh(ctrl);
    if (state.review.complete) return;

    if (game.variant?.key !== 'chess960') lookUpCloud(ctrl);
    let engine;
    try {
      engine = await engineFor(ctrl);
    } catch (err) {
      console.error('[LichessDotCom] engine boot failed', err);
      state.error = T.engineError;
      render(true);
      return;
    }
    for (;;) {
      const job = nextJob(ctrl);
      if (!job) {
        if (state.review.complete) break;
        await new Promise(resolve => setTimeout(resolve, 100)); // the cloud has the rest in hand
        continue;
      }
      const [i, deep] = job;
      const rec = toRecord(nodes[i].fen, await engine.analyse(nodes[i].fen, deep ? ENGINE : QUICK));
      if (deep) setDeep(i, rec);
      else work.rough[i] = rec;
      refresh(ctrl);
    }
    try {
      localStorage.setItem(cacheKey, JSON.stringify(work.deep));
    } catch {}
  }

  // The next position for the engine, as [index, deep]. First the ones the
  // move on the board is judged from (its position, the one before, the one
  // before that for a miss) and the next move's; then a quick pass over the
  // whole game for the graph; then the rest at full depth, from the start.
  // The cloud goes ahead through the opening: the engine leaves it the few
  // positions it's about to look up.
  function nextJob(ctrl) {
    const { nodes, deep, rough, cloudAt } = work;
    const missing = i => i >= 0 && i < nodes.length && !deep[i];
    if (state.mode === 'moves') {
      const main = ctrl.nodeList.slice(-3).filter(n => nodes[n.ply] === n).map(n => n.ply).reverse();
      if (ctrl.onMainline) main.push(ctrl.node.ply + 1);
      const i = main.find(missing);
      if (i !== undefined) return [i, true];
    }
    const cloudSoon = i => i >= cloudAt && i <= cloudAt + 3;
    for (let i = 0; i < nodes.length; i++) if (!deep[i] && !rough[i] && !cloudSoon(i)) return [i, false];
    for (let i = 0; i < nodes.length; i++) if (!deep[i] && !cloudSoon(i)) return [i, true];
    return null;
  }

  function setDeep(i, rec) {
    if (work.deep[i]) return;
    work.deep[i] = rec;
    live.evals.set(work.nodes[i].fen, rec);
    live.judged.clear();
  }

  // Judges every move whose positions are in, and rebuilds the review from
  // what's known. A move needs the position before it and its own, plus the
  // one before that for the opponent's last move (a miss fails to punish
  // it; that move's own verdict can wait, as a miss counts like the
  // mistake or blunder it is).
  function refresh(ctrl) {
    const { nodes, deep, rough, moves, bookPly } = work;
    const chess960 = ctrl.data.game.variant?.key === 'chess960';
    const at = (i, prevMove) => ({ ...judge(nodes[i - 1], nodes[i], deep[i - 1], deep[i], prevMove, i <= bookPly, chess960), ply: i });
    for (let i = 1; i < nodes.length; i++) {
      if (moves[i - 1] || !deep[i - 1] || !deep[i] || (i >= 2 && !deep[i - 2])) continue;
      moves[i - 1] = at(i, i >= 2 ? moves[i - 2] || at(i - 1) : undefined);
    }
    moves.forEach((m, k) => m && moves[k - 1] && (m.prevMove = moves[k - 1]));
    // Until then, a draft from the quick pass (or the server analysis):
    // the graph's dots, the move list's badges, the counts and the accuracy
    // show it at once, and each of its moves gives way to the full depth's.
    // The coach, the board and the game rating wait for the full depth.
    const rec = i => deep[i] || rough[i];
    const draft = [];
    for (let i = 1; i < nodes.length; i++) {
      if (moves[i - 1] || !rec(i - 1) || !rec(i)) {
        draft[i - 1] = moves[i - 1];
        continue;
      }
      const m = judge(nodes[i - 1], nodes[i], rec(i - 1), rec(i), draft[i - 2], i <= bookPly, chess960);
      draft[i - 1] = { ...m, ply: i, draft: true };
    }
    const judged = draft.filter(Boolean);
    const accuracy = color => {
      const accs = judged.filter(m => m.color === color).map(m => m.accuracy);
      if (!accs.length) return null;
      const mean = accs.reduce((s, x) => s + x, 0) / accs.length;
      const harmonic = accs.length / accs.reduce((s, x) => s + 1 / Math.max(x, 1), 0);
      return (mean + harmonic) / 2;
    };
    const counts = { w: {}, b: {} };
    for (const m of judged) counts[m.color][m.cls] = (counts[m.color][m.cls] || 0) + 1;
    const complete = moves.filter(Boolean).length === nodes.length - 1;
    state.review = {
      moves, draft, total: nodes.length, complete,
      positions: nodes.map((_, i) => deep[i] || rough[i] || null),
      accuracy: { w: accuracy('w'), b: accuracy('b') }, counts,
      rating: complete ? state.review?.rating || rateGame(ctrl, moves) : null,
    };
    state.progress = deep.filter(Boolean).length / nodes.length;
    state.version++;
    if (complete) state.revealed.add('summary');
  }

  // Lichess's cloud: evaluations someone has already run deep, which for a
  // game means its opening, until it leaves the known lines. The API takes
  // one position a request, and Lichess asks for one request at a time; a
  // few misses in a row and the game has left them. A refusal (too many
  // requests) ends it too.
  async function lookUpCloud(ctrl) {
    const { nodes } = work;
    let misses = 0;
    for (let i = 0; i < nodes.length && misses < 3; i++) {
      work.cloudAt = i;
      if (work.deep[i]) continue;
      const fen = nodes[i].fen;
      try {
        const res = await fetch(`/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=2`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 404) {
          misses++;
          continue;
        }
        if (!res.ok) break;
        const d = await res.json();
        if (!d.pvs?.length) {
          misses++;
          continue;
        }
        misses = 0;
        setDeep(i, toRecord(fen, fromCloud(fen, d)));
        refresh(ctrl);
      } catch {
        break;
      }
    }
    work.cloudAt = Infinity;
  }

  // The cloud's lines are from White's view, castling as king takes rook.
  function fromCloud(fen, d) {
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
    return {
      lines: d.pvs.map(p => {
        const pv = p.moves.split(' ').map(u => normUci(u, false));
        return p.mate !== undefined ? { mate: p.mate * sign, pv } : { cp: p.cp * sign, pv };
      }),
    };
  }

  // One engine for the page, booted once: the game's analysis and the
  // moves played off it share it, one position at a time.
  function engineFor(ctrl) {
    return (live.booting ||= (async () => {
      const engine = new Engine();
      engine.chess960 = ctrl.data.game.variant?.key === 'chess960';
      await engine.boot();
      return (live.engine = engine);
    })());
  }

  // The moves played off the game are judged like the free board's: its
  // book moves are known, and its positions as they're analyzed.
  function seedBooks(ctrl) {
    const nodes = ctrl.mainline, bookPly = work.bookPly;
    for (let i = 1; i <= bookPly && i < nodes.length; i++)
      live.books.set(nodes[i].fen, { book: true, name: i === bookPly ? state.openingName : '', eco: '' });
    if (nodes[bookPly + 1]) live.books.set(nodes[bookPly + 1].fen, { book: false, name: '', eco: '' });
    live.judged.clear();
  }

  function start() {
    const ctrl = site.analysis;
    if (!['standard', 'fromPosition', 'chess960'].includes(ctrl.data?.game?.variant?.key)) return;
    if (ctrl.synthetic) {
      if (ctrl.tree) run('live');
      return;
    }
    if (!ctrl.data.game.id || !ctrl.mainline || ctrl.mainline.length < 2) return;
    run('summary');
    analyseGame(ctrl);
  }

  // Only once the review runs: a render on a page it doesn't run on (a
  // variant, a game without moves) would show its panel with nothing in it.
  function run(mode) {
    html.classList.add('cdc-review');
    setMode(mode);
    setInterval(() => render(), 150);
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (Math.abs(window.innerWidth - lastWidth) > 4) {
        lastWidth = window.innerWidth;
        refitStream();
        render(true);
      }
    });
    // Out of the mobile layout, where the panel was hidden (review.css): the
    // graph and the comment were laid out at no size at all.
    wide.addEventListener('change', () => {
      lastWidth = window.innerWidth;
      refitStream();
      render(true);
    });
  }

  const started = Date.now();
  (function wait() {
    if (window.site?.analysis?.mainline && document.querySelector('main.analyse .analyse__board')) start();
    else if (Date.now() - started < 30000) setTimeout(wait, 100);
  })();
})();
