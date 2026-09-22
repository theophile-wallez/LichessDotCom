// Page-world script: Chess.com-style "Game Review" on Lichess analysis pages.
//
// - Runs Lichess's own Stockfish 19 build (the one its analysis board uses) on
//   every mainline position, with MultiPV 2, and caches the results per game.
// - Classifies each move like Chess.com (book, brilliant, great, best,
//   excellent, good, inaccuracy, mistake, miss, blunder) from win-probability
//   loss, and computes per-player accuracy.
// - Renders a summary panel (graph, accuracy, counts), a move-by-move review
//   (coach bubble, next/previous), board annotations (badge, colored squares,
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
        review: 'Bilan', start: 'Démarrer le bilan', next: 'Suivant', prev: 'Précédent',
        analysing: 'Analyse de la partie…', players: 'Joueurs', accuracy: 'Précision',
        anonymous: 'Anonyme', open: 'Bilan de la partie', close: 'Fermer le bilan',
        intro: 'Passons en revue cette partie !', bestWas: 'Le meilleur coup était {m}.',
        engineError: "Le moteur n'a pas pu démarrer.",
      }
    : {
        review: 'Game Review', start: 'Start Review', next: 'Next', prev: 'Previous',
        analysing: 'Analyzing game…', players: 'Players', accuracy: 'Accuracy',
        anonymous: 'Anonymous', open: 'Game Review', close: 'Close review',
        intro: "Let's review this game!", bestWas: '{m} was best.',
        engineError: 'The engine failed to start.',
      };

  // key, color, icon, label, sentence ({m} = move)
  const CLASSES = [
    ['brilliant', '#26c2a3', '!!', fr ? 'Brillant' : 'Brilliant', fr ? '{m} est brillant !' : '{m} is brilliant!'],
    ['great', '#749bbf', '!', fr ? 'Excellent' : 'Great', fr ? '{m} est un excellent coup' : '{m} is a great move'],
    ['best', '#81b64c', '★', fr ? 'Meilleur' : 'Best', fr ? '{m} est le meilleur coup' : '{m} is best'],
    ['excellent', '#96bc4b', '✓', fr ? 'Très bon' : 'Excellent', fr ? '{m} est très bon' : '{m} is excellent'],
    ['good', '#96af8b', '✓', fr ? 'Bon' : 'Good', fr ? '{m} est bon' : '{m} is good'],
    ['book', '#a88865', '≡', fr ? 'Théorique' : 'Book', fr ? '{m} est un coup théorique' : '{m} is a book move'],
    ['inaccuracy', '#f7c045', '?!', fr ? 'Imprécision' : 'Inaccuracy', fr ? '{m} est une imprécision' : '{m} is an inaccuracy'],
    ['mistake', '#ffa459', '?', fr ? 'Erreur' : 'Mistake', fr ? '{m} est une erreur' : '{m} is a mistake'],
    ['miss', '#ff7769', '✕', fr ? 'Manqué' : 'Miss', fr ? '{m} est un coup manqué' : '{m} is a miss'],
    ['blunder', '#fa412d', '??', fr ? 'Gaffe' : 'Blunder', fr ? '{m} est une gaffe' : '{m} is a blunder'],
  ].map(([key, color, icon, label, sentence]) => ({ key, color, icon, label, sentence }));
  const CLS = Object.fromEntries(CLASSES.map(c => [c.key, c]));
  const GRAPH_DOTS = new Set(['brilliant', 'great', 'inaccuracy', 'mistake', 'miss', 'blunder']);

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
  const state = { mode: 'summary', review: null, progress: 0, error: null, lastKey: '' };

  function setMode(mode) {
    state.mode = mode;
    html.classList.remove('cdc-review-normal', 'cdc-review-summary', 'cdc-review-moves');
    html.classList.add('cdc-review-' + mode);
    render(true);
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
    bar: el('div', { id: 'cdc-evalbar' }, '<div class="cdc-evalbar__fill"></div><span class="cdc-evalbar__label"></span>'),
    overlay: el('div', { id: 'cdc-board-overlay' }),
  };

  function ensureAttached(ctrl) {
    const main = document.querySelector('main.analyse');
    const board = main?.querySelector('.analyse__board');
    if (!main || !board) return false;
    for (const node of [dom.panel, dom.graphBox, dom.bar]) if (node.parentNode !== main) main.appendChild(node);
    if (dom.overlay.parentNode !== board) board.appendChild(dom.overlay);
    return true;
  }

  const playerName = p => p?.user?.username || p?.name || (p?.ai ? `Stockfish ${p.ai}` : T.anonymous);

  function players(ctrl) {
    const d = ctrl.data;
    const byColor = { [d.player.color]: d.player, [d.opponent.color]: d.opponent };
    return { w: byColor.white, b: byColor.black };
  }

  function graphSvg(review, ply, width, height) {
    const n = review.positions.length - 1 || 1;
    const x = i => (i / n) * width;
    const y = wp => height - (Math.max(0, Math.min(100, wp)) / 100) * height;
    const pts = review.positions.map((p, i) => `${x(i).toFixed(1)},${y(p.wp).toFixed(1)}`);
    const area = `M0,${height} L${pts.join(' L')} L${width},${height} Z`;
    const dots = review.moves
      .filter(m => GRAPH_DOTS.has(m.cls))
      .map(m => `<circle cx="${x(m.ply).toFixed(1)}" cy="${y(review.positions[m.ply].wp).toFixed(1)}" r="3.5" fill="${CLS[m.cls].color}" stroke="#fff" stroke-width="1"/>`)
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
    container.innerHTML = graphSvg(review, ply, width, height);
    container.onclick = e => {
      const r = container.getBoundingClientRect();
      const n = review.positions.length - 1;
      const target = Math.round(((e.clientX - r.left) / r.width) * n);
      jump(ctrl, Math.max(0, Math.min(n, target)));
      if (state.mode === 'summary') setMode('moves');
    };
  }

  function jump(ctrl, ply) {
    ctrl.jumpToMain(ply);
    ctrl.redraw?.();
  }

  const icon = cls => `<span class="cdc-cls-icon" style="--c:${CLS[cls].color}">${CLS[cls].icon}</span>`;

  function header(title, back) {
    return `<div class="cdc-review__head">
      ${back ? `<button class="cdc-review__back" data-cdc="${back}" title="${esc(T.close)}">←</button>` : '<span></span>'}
      <div class="cdc-review__title"><span class="cdc-review__star">★</span>${esc(title)}</div>
      <button class="cdc-review__close" data-cdc="normal" title="${esc(T.close)}">✕</button>
    </div>`;
  }

  function renderSummary(ctrl) {
    const p = players(ctrl);
    const r = state.review;
    let body;
    if (state.error) body = `<p class="cdc-review__msg">${esc(state.error)}</p>`;
    else if (!r)
      body = `<div class="cdc-review__progress"><p>${esc(T.analysing)}</p>
        <div class="cdc-progress"><div style="width:${Math.round(state.progress * 100)}%"></div></div>
        <p class="cdc-review__pct">${Math.round(state.progress * 100)}%</p></div>`;
    else {
      const acc = c => (r.accuracy[c] === null ? '—' : r.accuracy[c].toFixed(1));
      const rows = CLASSES.map(
        c => `<tr><td class="cdc-t-label">${esc(c.label)}</td>
          <td class="cdc-t-num" style="color:${c.color}">${r.counts.w[c.key] || 0}</td>
          <td class="cdc-t-icon">${icon(c.key)}</td>
          <td class="cdc-t-num" style="color:${c.color}">${r.counts.b[c.key] || 0}</td></tr>`,
      ).join('');
      body = `<div class="cdc-review__graph cdc-summary-graph"></div>
        <table class="cdc-review__table">
          <tr class="cdc-t-names"><td></td><td>${esc(playerName(p.w))}</td><td></td><td>${esc(playerName(p.b))}</td></tr>
          <tr><td class="cdc-t-label">${esc(T.players)}</td><td><span class="cdc-avatar"></span></td><td></td><td><span class="cdc-avatar"></span></td></tr>
          <tr><td class="cdc-t-label">${esc(T.accuracy)}</td>
            <td><span class="cdc-acc cdc-acc--w">${acc('w')}</span></td><td></td>
            <td><span class="cdc-acc cdc-acc--b">${acc('b')}</span></td></tr>
          <tr class="cdc-t-sep"><td colspan="4"></td></tr>
          ${rows}
        </table>`;
    }
    dom.panel.innerHTML = `${header(T.review, 'normal')}
      <div class="cdc-review__body">${body}</div>
      <div class="cdc-review__foot"><button class="cdc-btn cdc-btn--green" data-cdc="moves" ${r ? '' : 'disabled'}>${esc(T.start)}</button></div>`;
    const g = dom.panel.querySelector('.cdc-summary-graph');
    if (g && r) mountGraph(g, r, ctrl.node.ply, ctrl);
  }

  function renderMoves(ctrl) {
    const r = state.review;
    const ply = ctrl.node.ply;
    const move = ctrl.onMainline && ply > 0 ? r?.moves[ply - 1] : null;
    let bubble;
    if (!r) bubble = `<p class="cdc-bubble__title">${esc(T.analysing)} ${Math.round(state.progress * 100)}%</p>`;
    else if (!move) bubble = `<p class="cdc-bubble__title">${esc(T.intro)}</p>`;
    else {
      const c = CLS[move.cls];
      const good = ['brilliant', 'great', 'best', 'book'].includes(move.cls);
      const sub =
        move.cls === 'book'
          ? esc(state.openingName || '')
          : !good && move.bestSan
            ? esc(T.bestWas.replace('{m}', move.bestSan))
            : '';
      bubble = `<div class="cdc-bubble__row">${icon(move.cls)}
          <p class="cdc-bubble__title" style="color:${c.color}">${esc(c.sentence.replace('{m}', move.san))}</p>
          <span class="cdc-bubble__eval">${esc(formatEval(move.eval))}</span></div>
        ${sub ? `<p class="cdc-bubble__sub">${sub}</p>` : ''}`;
    }
    dom.panel.innerHTML = `${header(T.review, 'summary')}
      <div class="cdc-coach"><div class="cdc-coach__avatar"></div><div class="cdc-bubble">${bubble}</div></div>
      <div class="cdc-review__nav">
        <button class="cdc-btn" data-cdc="prev">${esc(T.prev)}</button>
        <button class="cdc-btn cdc-btn--green" data-cdc="next">${esc(T.next)} →</button>
      </div>`;
    if (r) mountGraph(dom.graphBox, r, ply, ctrl);
    else dom.graphBox.innerHTML = '';
  }

  function renderNormal() {
    dom.panel.innerHTML = `<button class="cdc-review__open" data-cdc="summary"><span class="cdc-review__star">★</span>${esc(T.open)}</button>`;
  }

  // Eval bar, board badge / arrow / square colors, move list badges.
  function renderBoard(ctrl) {
    const r = state.review;
    const ply = ctrl.node.ply;
    const onMain = ctrl.onMainline;
    const orientation = ctrl.getOrientation();
    const reviewing = state.mode !== 'normal';

    // Eval bar.
    const pos = r && onMain ? r.positions[ply] : null;
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
    const move = r && onMain && ply > 0 && reviewing ? r.moves[ply - 1] : null;
    html.dataset.cdcCls = move ? move.cls : '';
    let overlay = '';
    if (move) {
      const toXY = key => {
        const [f, rk] = fr2(key);
        return orientation === 'white' ? [f, 7 - rk] : [7 - f, rk];
      };
      const node = ctrl.mainline[ply];
      let dest = node.uci.slice(2, 4);
      if (node.san.startsWith('O-O')) dest = (node.san.startsWith('O-O-O') ? 'c' : 'g') + node.uci[1];
      const [dx, dy] = toXY(dest);
      let arrow = '';
      if (!['best', 'brilliant', 'great', 'book'].includes(move.cls) && move.best) {
        const [ax, ay] = toXY(move.best.slice(0, 2));
        const [bx, by] = toXY(move.best.slice(2, 4));
        const x1 = ax + 0.5, y1 = ay + 0.5, x2 = bx + 0.5, y2 = by + 0.5;
        const len = Math.hypot(x2 - x1, y2 - y1) || 1;
        const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
        const hx = x2 - ux * 0.42, hy = y2 - uy * 0.42;
        arrow = `<svg class="cdc-arrow" viewBox="0 0 8 8">
          <line x1="${x1 + ux * 0.2}" y1="${y1 + uy * 0.2}" x2="${hx}" y2="${hy}" stroke-width="0.2" stroke-linecap="butt"/>
          <polygon points="${x2},${y2} ${hx - uy * 0.25},${hy + ux * 0.25} ${hx + uy * 0.25},${hy - ux * 0.25}"/></svg>`;
      }
      overlay = `${arrow}<div class="cdc-badge" style="left:${(dx + 1) * 12.5}%;top:${dy * 12.5}%;--c:${CLS[move.cls].color}">${CLS[move.cls].icon}</div>`;
    }
    if (dom.overlay.innerHTML !== overlay) dom.overlay.innerHTML = overlay;

    // Move list badges.
    if (r) {
      const tree = document.querySelector('main.analyse .tview2');
      const mainMoves = tree ? [...tree.querySelectorAll(':scope > move:not(.empty)')] : [];
      mainMoves.forEach((m, i) => {
        const mv = r.moves[i];
        if (mv && m.dataset.cdcCls !== mv.cls) {
          m.dataset.cdcCls = mv.cls;
          m.style.setProperty('--c', CLS[mv.cls].color);
          m.dataset.cdcIcon = CLS[mv.cls].icon;
        }
      });
    }
  }

  function render(force) {
    const ctrl = site.analysis;
    if (!ctrl || !ensureAttached(ctrl)) return;
    const key = [state.mode, ctrl.node.ply, ctrl.onMainline, ctrl.getOrientation(), !!state.review, Math.round(state.progress * 100), state.error].join('|');
    if (force || key !== state.lastKey) {
      state.lastKey = key;
      if (state.mode === 'summary') renderSummary(ctrl);
      else if (state.mode === 'moves') renderMoves(ctrl);
      else renderNormal();
    }
    renderBoard(ctrl);
  }

  dom.panel.addEventListener('click', e => {
    const btn = e.target.closest('[data-cdc]');
    if (!btn || btn.disabled) return;
    const ctrl = site.analysis;
    const act = btn.dataset.cdc;
    if (act === 'prev') jump(ctrl, Math.max(0, ctrl.node.ply - 1));
    else if (act === 'next') jump(ctrl, Math.min(ctrl.mainline.length - 1, ctrl.onMainline ? ctrl.node.ply + 1 : 0));
    else {
      if (act === 'moves' && !ctrl.onMainline) jump(ctrl, 0);
      setMode(act);
    }
    render(true);
  });

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
        state.progress = (i + 1) / nodes.length;
        render();
      }
      engine.destroy();
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
