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
// Navigation and state go through `site.analysis` (Lichess's AnalyseCtrl).

(() => {
  if (!/^\/[a-zA-Z0-9]{8}(?:[a-zA-Z0-9]{4})?(?:\/(?:white|black))?\/?$/.test(location.pathname)) return;

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
      }
    : {
        review: 'Game Review', start: 'Start Review', next: 'Next', explain: 'Explain', best: 'Best',
        analysing: 'Analyzing game…', players: 'Players', accuracy: 'Accuracy',
        anonymous: 'Anonymous', close: 'Close review', back: 'Back', coach: 'Change coach',
        intro: "Let's review this game!", bestWas: '{m} was best.',
        engineError: 'The engine failed to start.',
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
  const coachAvatar = () =>
    `<button class="cdc-coach__avatar" data-cdc="coach" data-coach="${coach}" title="${esc(T.coach)}" aria-label="${esc(T.coach)}"></button>`;

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
  CLS.book.text = '#312e2b';

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

  function classify(ctrl, positions, bookPly) {
    const chess960 = ctrl.data.game.variant?.key === 'chess960';
    const nodes = ctrl.mainline;
    const moves = [];
    for (let i = 1; i < nodes.length; i++) {
      const node = nodes[i], prev = nodes[i - 1];
      const color = prev.fen.split(' ')[1];
      const a = positions[i - 1], b = positions[i];
      const before = pov(a.wp, color), after = pov(b.wp, color);
      const loss = Math.max(0, before - after);
      const second = a.wp2 === null ? null : pov(a.wp2, color);
      const isBest = normUci(node.uci, chess960) === a.best;
      let cls;
      if (i <= bookPly) cls = 'book';
      else if (isBest || loss < 0.5) {
        if (after >= 50 && before < 95 && loss < 2 && isSacrifice(prev.fen, node.fen, node.uci)) cls = 'brilliant';
        else if (second !== null && before - second >= 15 && before < 97 && after > 25) cls = 'great';
        else cls = 'best';
      } else if (loss < 2) cls = 'excellent';
      else if (loss < 5) cls = 'good';
      else if (loss < 10) cls = 'inaccuracy';
      else if (loss < 20) cls = 'mistake';
      else cls = 'blunder';
      const prevMove = moves[i - 2];
      if ((cls === 'mistake' || cls === 'blunder') && prevMove && prevMove.loss >= 10 && before >= 60) cls = 'miss';
      moves.push({
        ply: i, san: node.san, uci: node.uci, color, cls, loss,
        accuracy: cls === 'book' ? 100 : moveAccuracy(loss),
        best: a.best, bestSan: uciToSan(prev.fen, a.best), eval: b,
      });
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
    html.classList.remove('cdc-review-normal', 'cdc-review-summary', 'cdc-review-moves');
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

  function renderMoves(ctrl) {
    const r = state.review;
    const ply = ctrl.node.ply;
    const move = ctrl.onMainline && ply > 0 ? r?.moves[ply - 1] : null;
    const shown = bestShown(ctrl);
    let bubble;
    if (!r) bubble = `<p class="cdc-bubble__title">${esc(T.analysing)} ${Math.round(state.progress * 100)}%</p>`;
    else if (shown)
      bubble = `<div class="cdc-bubble__row">${icon('best')}
          <p class="cdc-bubble__title" style="color:${CLS.best.color}">${esc(CLS.best.sentence.replace('{m}', ctrl.node.san))}</p>
          <span class="cdc-bubble__eval">${esc(formatEval(r.positions[shown.ply - 1]))}</span></div>`;
    else if (!move) bubble = `<p class="cdc-bubble__title">${esc(T.intro)}</p>`;
    else {
      const c = CLS[move.cls];
      const good = GOOD.has(move.cls);
      const sub =
        move.cls === 'book'
          ? esc(state.openingName || '')
          : !good && move.bestSan
            ? esc(T.bestWas.replace('{m}', move.bestSan))
            : '';
      bubble = `<div class="cdc-bubble__row">${icon(move.cls)}
          <p class="cdc-bubble__title" style="color:${c.text || c.color}">${esc(c.sentence.replace('{m}', move.san))}</p>
          <span class="cdc-bubble__eval">${esc(formatEval(move.eval))}</span></div>
        ${sub && state.explain ? `<p class="cdc-bubble__sub">${sub}</p>` : ''}`;
    }
    const atEnd = ctrl.onMainline && ply >= ctrl.mainline.length - 1;
    const canBest = shown || (move && move.best && !GOOD.has(move.cls));
    dom.panel.innerHTML = `${header(T.review, 'summary')}
      <div class="cdc-coach">${coachAvatar()}<div class="cdc-bubble">${bubble}</div></div>
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

  // Eval bar, board badge / arrow / square colors, move list badges.
  function renderBoard(ctrl) {
    const r = state.review;
    const ply = ctrl.node.ply;
    const onMain = ctrl.onMainline;
    const orientation = ctrl.getOrientation();
    const reviewing = state.mode !== 'normal';

    const shown = bestShown(ctrl);

    // Eval bar. The best move keeps the eval of the position before it.
    const pos = shown ? r.positions[shown.ply - 1] : r && onMain ? r.positions[ply] : null;
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
    const move = shown ? { ...shown, cls: 'best' } : r && onMain && ply > 0 && reviewing ? r.moves[ply - 1] : null;
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
    if (r) {
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
    const key = [state.mode, ctrl.node.ply, ctrl.onMainline, ctrl.getOrientation(), !!state.review, Math.round(state.progress * 100), state.error, state.explain, !!state.playing].join('|');
    if (force || key !== state.lastKey) {
      state.lastKey = key;
      if (state.mode === 'summary') renderSummary(ctrl);
      else if (state.mode === 'moves') renderMoves(ctrl);
      else renderNormal(ctrl);
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

  let lastWidth = 0;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - lastWidth) > 4) {
      lastWidth = window.innerWidth;
      render(true);
    }
  });

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
    if (ctrl.synthetic || !ctrl.data?.game?.id || !ctrl.mainline || ctrl.mainline.length < 2) return;
    if (!['standard', 'fromPosition', 'chess960'].includes(ctrl.data.game.variant?.key)) return;
    html.classList.add('cdc-review');
    setMode('summary');
    setInterval(() => render(), 150);
    analyseGame(ctrl);
  }

  const started = Date.now();
  (function wait() {
    if (window.site?.analysis?.mainline && document.querySelector('main.analyse .analyse__board')) start();
    else if (Date.now() - started < 30000) setTimeout(wait, 100);
  })();
})();
