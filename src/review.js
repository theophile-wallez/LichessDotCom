// Page-world script: Chess.com-style "Game Review" on Lichess analysis pages.
//
// - Runs Lichess's own Stockfish 19 build (the one its analysis board uses) on
//   every mainline position, with MultiPV 2, and caches the results per game.
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
// the same badges on the board and in the move list (see "live").
//
// Navigation and state go through `site.analysis` (Lichess's AnalyseCtrl).

(() => {
  const GAME = /^\/[a-zA-Z0-9]{8}(?:[a-zA-Z0-9]{4})?(?:\/(?:white|black))?\/?$/;
  if (!GAME.test(location.pathname) && !/^\/analysis(?:\/|$)/.test(location.pathname)) return;

  const ENGINE = { root: 'npm/stockfish-web', js: 'sf_19_smallnet.js', depth: 16, movetime: 1500 };
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
      }
    : {
        review: 'Game Review', start: 'Start Review', next: 'Next', explain: 'Explain', best: 'Best',
        analysing: 'Analyzing game…', players: 'Players', accuracy: 'Accuracy',
        anonymous: 'Anonymous', close: 'Close review', back: 'Back', coach: 'Change coach',
        intro: "Let's review this game!", bestWas: '{m} was best.',
        engineError: 'The engine failed to start.',
        liveIntro: 'Play a move and I’ll tell you what I think.', thinking: 'Let me look at this move…',
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
  // The coach blinks, and its face shows the verdict (review.css): a mood
  // per class. The face eases into it once per move, not again when the same
  // move is re-rendered (Explain, a new coach). `at` names the move: its
  // ply, or its path.
  const MOODS = {
    brilliant: 'delight', great: 'delight', best: 'happy', excellent: 'happy', good: 'calm', book: 'calm',
    inaccuracy: 'doubt', mistake: 'worry', miss: 'worry', blunder: 'shock',
  };
  // Under the lids, the brows and mouth the expressions move, each over a
  // patch of skin that hides it where it was.
  const FACE = ['patch', 'part']
    .flatMap(k => ['brow-l', 'brow-r', 'mouth'].map(f => `<i class="cdc-coach__${k} cdc-coach__${k}--${f}"></i>`))
    .concat(['l', 'r'].map(s => `<i class="cdc-coach__lid cdc-coach__lid--${s}"></i>`))
    .join('');
  let reacted = '';
  const coachAvatar = (cls, at) => {
    const mood = MOODS[cls] || '';
    const key = mood && `${at}|${cls}`;
    const react = key && key !== reacted;
    reacted = key;
    // The panel is re-rendered often (every percent of the analysis): start
    // the idle loops where the clock is, so a render doesn't reset a blink.
    const style = `--cdc-idle:${(-(performance.now() / 1000) % 7).toFixed(2)}s${mood ? `;--cdc-mood-c:${CLS[cls].color}` : ''}`;
    return `<button class="cdc-coach__avatar${react ? ' cdc-coach__avatar--react' : ''}" data-cdc="coach" data-coach="${coach}"${mood ? ` data-mood="${mood}"` : ''} style="${style}" title="${esc(T.coach)}" aria-label="${esc(T.coach)}"><span class="cdc-coach__face">${FACE}</span></button>`;
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
    analyse(fen) {
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
          this.mod.uci(`go depth ${ENGINE.depth} movetime ${ENGINE.movetime}`);
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
    return {
      ply: node.ply, san: node.san, uci: node.uci, color, cls, loss,
      accuracy: cls === 'book' ? 100 : moveAccuracy(loss),
      best: a.best, bestSan: uciToSan(prev.fen, a.best), eval: b,
      before: a, node, prev, prevMove,
    };
  }

  function classify(ctrl, positions, bookPly) {
    const chess960 = ctrl.data.game.variant?.key === 'chess960';
    const nodes = ctrl.mainline;
    const moves = [];
    for (let i = 1; i < nodes.length; i++) {
      const move = judge(nodes[i - 1], nodes[i], positions[i - 1], positions[i], moves[i - 2], i <= bookPly, chess960);
      moves.push({ ...move, ply: i });
    }
    const accuracy = color => {
      const accs = moves.filter(m => m.color === color).map(m => m.accuracy);
      if (!accs.length) return null;
      const mean = accs.reduce((s, x) => s + x, 0) / accs.length;
      const harmonic = accs.length / accs.reduce((s, x) => s + 1 / Math.max(x, 1), 0);
      return (mean + harmonic) / 2;
    };
    const counts = { w: {}, b: {} };
    for (const m of moves) counts[m.color][m.cls] = (counts[m.color][m.cls] || 0) + 1;
    return { moves, positions, accuracy: { w: accuracy('w'), b: accuracy('b') }, counts };
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
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const stream = { key: '', shown: 0, timer: 0 };

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
      stream.shown = calm.matches ? Infinity : 0;
    }
    let i = 0;
    return parts
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

  // After a render: drop what doesn't fit, then carry on typing.
  function startStream() {
    const sub = dom.panel.querySelector('.cdc-bubble__sub');
    if (!sub) return;
    if (sub.scrollHeight > sub.clientHeight + 1) sub.querySelector('.cdc-say--drop')?.remove();
    if (stream.shown < sub.querySelectorAll('.cdc-w').length && !stream.timer) stream.timer = setInterval(tickStream, 35);
  }

  function tickStream() {
    const words = dom.panel.querySelectorAll('.cdc-bubble__sub .cdc-w');
    const w = words[stream.shown++];
    if (w) w.className = 'cdc-w cdc-w--in';
    if (stream.shown >= words.length) {
      clearInterval(stream.timer);
      stream.timer = 0;
    }
  }

  // ------------------------------------------------------------- UI ---

  const html = document.documentElement;
  const state = {
    mode: 'summary', review: null, progress: 0, error: null, lastKey: '',
    explain: false, playing: null, revealed: new Set(),
    bestOf: null, // mainline ply whose best move is shown on the board
  };

  function setMode(mode) {
    state.mode = mode;
    // The summary is shown until the user moves; then the move-by-move review.
    state.summaryPly = site.analysis?.node.ply;
    if (mode !== 'moves') stopPlaying();
    html.classList.remove('cdc-review-normal', 'cdc-review-summary', 'cdc-review-moves', 'cdc-review-live');
    html.classList.add('cdc-review-' + mode);
    render(true);
  }

  function stopPlaying() {
    clearInterval(state.playing);
    state.playing = null;
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

  // `review.total` (positions in the game) lets a partial analysis fill the
  // graph from the left while it runs.
  function graphSvg(review, ply, width, height) {
    const n = (review.total || review.positions.length) - 1 || 1;
    const x = i => (i / n) * width;
    const y = wp => height - (Math.max(0, Math.min(100, wp)) / 100) * height;
    const pts = review.positions.map((p, i) => `${x(i).toFixed(1)},${y(p.wp).toFixed(1)}`);
    const end = x(review.positions.length - 1).toFixed(1);
    const area = pts.length ? `M0,${height} L${pts.join(' L')} L${end},${height} Z` : '';
    const dots = review.moves
      .filter(m => GRAPH_DOTS.has(m.cls))
      .map(m => `<circle cx="${x(m.ply).toFixed(1)}" cy="${y(review.positions[m.ply].wp).toFixed(1)}" r="3.5" fill="${CLS[m.cls].color}"/>`)
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
    const n = review.positions.length - 1;
    const plyAt = e => {
      const r = container.getBoundingClientRect();
      return Math.max(0, Math.min(n, Math.round(((e.clientX - r.left - padX / 2) / width) * n)));
    };
    const tip = container.lastElementChild;
    container.onmousemove = e => {
      const i = plyAt(e);
      tip.textContent = formatEval(review.positions[i]) || '0.00';
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

  // The engine's best move instead of the game's, played on the board as a
  // (hidden) variation, like Chess.com's "Best" button.
  function bestShown(ctrl) {
    const m = state.bestOf && state.review?.moves[state.bestOf - 1];
    const chess960 = ctrl.data.game.variant?.key === 'chess960';
    if (!m || ctrl.onMainline || ctrl.node.ply !== state.bestOf) return null;
    return normUci(ctrl.node.uci, chess960) === m.best ? m : null;
  }

  function showBest(ctrl) {
    if (bestShown(ctrl)) return jump(ctrl, state.bestOf);
    const ply = ctrl.node.ply;
    const m = state.review?.moves[ply - 1];
    if (!m?.best || typeof ctrl.playUci !== 'function') return;
    jump(ctrl, ply - 1);
    state.bestOf = ply;
    ctrl.playUci(m.best);
    ctrl.redraw?.();
  }

  function jump(ctrl, ply) {
    ctrl.jumpToMain(ply);
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
  // a quote from the coach, the graph filling in, and the counts at zero.
  function renderSummary(ctrl) {
    const p = players(ctrl);
    const r = state.review;
    const loading = !r && !state.error;
    const pct = Math.round(state.progress * 100);
    const say = state.error ? esc(state.error) : loading ? esc(QUOTE) : esc(T.intro);
    const acc = c => (r?.accuracy[c] == null ? '&nbsp;' : r.accuracy[c].toFixed(1));
    const rows = CLASSES.map(
      c => `<tr><td class="cdc-t-label">${esc(c.label)}</td>
        <td class="cdc-t-num" style="color:${c.color}">${r?.counts.w[c.key] || 0}</td>
        <td class="cdc-t-icon">${icon(c.key)}</td>
        <td class="cdc-t-num" style="color:${c.color}">${r?.counts.b[c.key] || 0}</td></tr>`,
    ).join('');
    // Only the classification rows scroll: they're a table of their own, with
    // the same fixed columns as the one above so the two line up.
    const cols = '<colgroup><col class="cdc-t-c-label"><col><col class="cdc-t-c-icon"><col></colgroup>';
    dom.panel.innerHTML = `${header(T.review, 'normal')}
      <div class="cdc-coach cdc-coach--summary">${coachAvatar()}
        <div class="cdc-bubble"><p class="cdc-bubble__say">${say}</p></div></div>
      <div class="cdc-review__top">
        <div class="cdc-review__graph cdc-summary-graph">${loading ? `<span class="cdc-summary-pct">${pct}%</span>` : ''}</div>
        <table class="cdc-review__table">${cols}
          <tr class="cdc-t-names"><td></td><td>${esc(playerName(p.w))}</td><td></td><td>${esc(playerName(p.b))}</td></tr>
          <tr><td class="cdc-t-label">${esc(T.players)}</td><td><span class="cdc-avatar"></span></td><td></td><td><span class="cdc-avatar"></span></td></tr>
          <tr><td class="cdc-t-label">${esc(T.accuracy)}</td>
            <td><span class="cdc-acc cdc-acc--w">${acc('w')}</span></td><td></td>
            <td><span class="cdc-acc cdc-acc--b">${acc('b')}</span></td></tr>
          <tr class="cdc-t-sep"><td colspan="4"></td></tr>
        </table>
      </div>
      <div class="cdc-review__body">
        <table class="cdc-review__table${loading ? ' cdc-review__table--loading' : ''}">${cols}${rows}</table>
      </div>
      <div class="cdc-review__foot"><button class="cdc-btn cdc-btn--green" data-cdc="moves" ${r ? '' : 'disabled'}>${esc(T.start)}</button></div>`;
    const g = dom.panel.querySelector('.cdc-summary-graph');
    if (r) mountGraph(g, r, ctrl.node.ply, ctrl);
    else if (loading) {
      const partial = { positions: state.partial || [], moves: [], total: ctrl.mainline.length };
      const box = g.getBoundingClientRect();
      g.insertAdjacentHTML('beforeend', graphSvg(partial, 0, Math.max(100, Math.floor(box.width)), Math.max(40, Math.floor(box.height))));
    }
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
    const move = ctrl.onMainline && ply > 0 ? r?.moves[ply - 1] : null;
    const shown = bestShown(ctrl);
    let bubble;
    if (!r) bubble = `<p class="cdc-bubble__title">${esc(T.analysing)} ${Math.round(state.progress * 100)}%</p>`;
    else if (shown)
      bubble = `<div class="cdc-bubble__row">${icon('best')}
          <p class="cdc-bubble__title">${title(CLS.best, ctrl.node.san)}</p>
          ${evalChip(r.positions[shown.ply - 1])}</div>`;
    else if (!move) bubble = `<p class="cdc-bubble__title">${esc(T.intro)}</p>`;
    else {
      const good = GOOD.has(move.cls);
      // Explain swaps the remark for the opening's name, or the move that
      // was best: the bubble has room for two lines under the title.
      const hint = !state.explain
        ? ''
        : move.cls === 'book'
          ? state.openingName || ''
          : !good && move.bestSan
            ? T.bestWas.replace('{m}', mv(move.bestSan, move.color))
            : '';
      bubble = verdict(ctrl, move, hint);
    }
    const atEnd = ctrl.onMainline && ply >= ctrl.mainline.length - 1;
    const canBest = shown || (move && move.best && !GOOD.has(move.cls));
    dom.panel.innerHTML = `${header(T.review, 'summary')}
      <div class="cdc-coach">${coachAvatar(!shown && move?.cls, ply)}<div class="cdc-bubble">${bubble}</div></div>
      <div class="cdc-review__nav">
        <button class="cdc-btn${state.explain ? ' cdc-btn--on' : ''}" data-cdc="explain">${svgIcon('bulb')}${esc(T.explain)}</button>
        <button class="cdc-btn${shown ? ' cdc-btn--on' : ''}" data-cdc="best" ${canBest ? '' : 'disabled'}>${svgIcon('star')}${esc(T.best)}</button>
        <button class="cdc-btn cdc-btn--green" data-cdc="next" ${atEnd ? 'disabled' : ''}>${svgIcon('arrow')}${esc(T.next)}</button>
      </div>`;
    dom.controls.innerHTML = ['first', 'prev', state.playing ? 'pause' : 'play', 'next', 'last']
      .map(a => `<button class="cdc-btn" data-cdc="${a === 'pause' ? 'play' : a}">${svgIcon(a)}</button>`)
      .join('');
    if (r) mountGraph(dom.graphBox, r, ply, ctrl);
    else dom.graphBox.innerHTML = '';
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
      : !r
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
    const pos = isLive ? null : shown ? r.positions[shown.ply - 1] : r && onMain ? r.positions[ply] : null;
    html.classList.toggle('cdc-evalbar-on', !!pos);
    if (pos) {
      const whiteShare = pos.wp;
      dom.bar.classList.toggle('cdc-evalbar--flip', orientation === 'black');
      dom.bar.querySelector('.cdc-evalbar__fill').style.height = whiteShare + '%';
      const label = dom.bar.querySelector('.cdc-evalbar__label');
      label.textContent = barLabel(pos);
      label.className = 'cdc-evalbar__label ' + (whiteShare >= 50 ? 'cdc-evalbar__label--white' : 'cdc-evalbar__label--black');
    }

    // Board overlay.
    const move = isLive
      ? judgeAt(ctrl, ctrl.path)
      : shown ? { ...shown, cls: 'best' } : r && onMain && ply > 0 && reviewing ? r.moves[ply - 1] : null;
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
    // The best move, drawn by board.js with the other arrows.
    const showBest = move && move.best && !GOOD.has(move.cls);
    window.cdcReviewArrows = showBest ? [{ orig: move.best.slice(0, 2), dest: move.best.slice(2, 4), brush: 'best' }] : [];

    // Move list badges.
    if (isLive) liveBadges(ctrl);
    else if (r) {
      const tree = document.querySelector('main.analyse .tview2');
      const mainMoves = tree ? [...tree.querySelectorAll(':scope > move:not(.empty)')] : [];
      mainMoves.forEach((m, i) => {
        const mv = r.moves[i];
        if (!mv || m.dataset.cdcCls === mv.cls) return;
        const c = CLS[mv.cls];
        m.dataset.cdcCls = mv.cls;
        m.style.setProperty('--c', c.color);
        m.style.setProperty('--i', c.img);
        const badge = LIST_BADGES.has(mv.cls) && !(mv.cls === 'book' && r.moves[i + 1]?.cls === 'book');
        if (badge) m.dataset.cdcBadge = '';
        else delete m.dataset.cdcBadge;
      });
    }
  }

  function render(force) {
    const ctrl = site.analysis;
    if (!ctrl || !ensureAttached(ctrl)) return;
    if (state.mode === 'summary' && ctrl.node.ply !== state.summaryPly) return setMode('moves');
    if (state.mode === 'live') pump(ctrl);
    const key =
      state.mode === 'live'
        ? ['live', ctrl.path, liveDigest(judgeAt(ctrl, ctrl.path)), live.error].join('|')
        : [state.mode, ctrl.node.ply, ctrl.onMainline, ctrl.getOrientation(), !!state.review, Math.round(state.progress * 100), state.error, state.explain, !!state.playing].join('|');
    if (force || key !== state.lastKey) {
      state.lastKey = key;
      if (state.mode === 'summary') renderSummary(ctrl);
      else if (state.mode === 'moves') renderMoves(ctrl);
      else if (state.mode === 'live') renderLive(ctrl);
      else renderNormal(ctrl);
      startStream();
      fitBubble();
    }
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
      // Each coach words the remarks their own way.
      if (state.mode === 'moves' || state.mode === 'live') render(true);
      return;
    }
    const last = ctrl.mainline.length - 1;
    if (act !== 'play') stopPlaying();
    if (act === 'play') togglePlay(ctrl);
    else if (act === 'explain') state.explain = !state.explain;
    else if (act === 'first') jump(ctrl, 0);
    else if (act === 'last') jump(ctrl, last);
    // Off the mainline (e.g. showing the best move): back to the game's move,
    // or on to the next one.
    else if (act === 'prev') jump(ctrl, ctrl.onMainline ? Math.max(0, ctrl.node.ply - 1) : Math.min(last, ctrl.node.ply));
    else if (act === 'next') jump(ctrl, Math.min(last, ctrl.node.ply + 1));
    else if (act === 'best') showBest(ctrl);
    else {
      // Starting the review goes to the first move.
      if (act === 'moves' && (!ctrl.onMainline || ctrl.node.ply === 0)) jump(ctrl, 1);
      setMode(act);
    }
    render(true);
  };
  dom.panel.addEventListener('click', onClick);
  dom.controls.addEventListener('click', onClick);


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
    engine: null, busy: false, bookBusy: false, noBook: false, error: null,
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

  const openingAt = (ctrl, path) => {
    for (; path; path = path.slice(0, -2)) {
      const name = live.books.get(ctrl.tree.nodeAtPath(path).fen)?.name;
      if (name) return name;
    }
    return '';
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
      move.opening = openingAt(ctrl, path);
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
      const node = wanted(ctrl).find(n => !live.evals.has(n.fen));
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
      if (!live.engine) {
        const engine = new Engine();
        engine.chess960 = ctrl.data.game.variant?.key === 'chess960';
        await engine.boot();
        live.engine = engine;
      }
      live.evals.set(fen, toRecord(fen, await live.engine.analyse(fen)));
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
      live.books.set(fen, { book: d.white + d.draws + d.black >= BOOK_GAMES, name: d.opening?.name || '' });
    } catch {
      live.noBook = true;
    }
    live.bookBusy = false;
    changed();
  }

  // Badges in Lichess's move list, variations included: each move carries
  // its path in the tree.
  function liveBadges(ctrl) {
    for (const m of treeMoves()) {
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

  async function analyseGame(ctrl) {
    const game = ctrl.data.game;
    const nodes = ctrl.mainline;
    const cacheKey = `cdc-review:${game.id}:${nodes.length}:v${CACHE_VERSION}`;

    let bookPly = 0;
    try {
      const res = await fetch(`/game/export/${game.id}?opening=true&moves=false&clocks=false&evals=false`, {
        headers: { Accept: 'application/json' },
      });
      const info = await res.json();
      bookPly = info.opening?.ply || 0;
      state.openingName = info.opening?.name || '';
    } catch {}

    let positions = null;
    try {
      positions = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    } catch {}

    if (!positions || positions.length !== nodes.length) {
      const engine = new Engine();
      engine.chess960 = game.variant?.key === 'chess960';
      try {
        await engine.boot();
      } catch (err) {
        console.error('[LichessDotCom] engine boot failed', err);
        state.error = T.engineError;
        render(true);
        return;
      }
      positions = [];
      for (let i = 0; i < nodes.length; i++) {
        positions.push(toRecord(nodes[i].fen, await engine.analyse(nodes[i].fen)));
        state.partial = positions;
        state.progress = (i + 1) / nodes.length;
        render();
      }
      engine.destroy();
      state.revealed.add('summary'); // it already filled in while loading
      try {
        localStorage.setItem(cacheKey, JSON.stringify(positions));
      } catch {}
    }
    state.review = classify(ctrl, positions, bookPly);
    render(true);
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
        render(true);
      }
    });
  }

  const started = Date.now();
  (function wait() {
    if (window.site?.analysis?.mainline && document.querySelector('main.analyse .analyse__board')) start();
    else if (Date.now() - started < 30000) setTimeout(wait, 100);
  })();
})();
