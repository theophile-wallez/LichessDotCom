// Page-world script: Chess.com-style shapes on any board, and checkmate.
//
// - Right-clicked squares: Chess.com fills the square, Lichess rings it with a
//   circle. The fill goes under the pieces, like Chess.com's.
// - Arrows: Chess.com's shape and colors, a thick 80% opaque arrow starting at
//   the edge of the origin square, L-shaped for knight moves. Only once the
//   button is released: Lichess draws the arrow as you drag, Chess.com doesn't.
// - Checkmate: a red badge with a mated king on the king's square, then after a
//   moment the square turns red under a "Checkmate" label.
//
// Chessground's own shapes are hidden (see styles/board.css) and read back from
// its svg, rather than from a controller: their coordinates are already in board
// units with the orientation applied, and it's the only source a game page has
// (unlike the analysis page, it exposes no controller, so no `state.drawable`).
// The Game Review adds its own arrows by square through `window.cdcReviewArrows`
// ([{ orig, dest, brush }], brush 'best' or 'engine'), and checkmate needs
// `site.analysis`.

(() => {
  const fr = (document.documentElement.lang || '').startsWith('fr');
  const MATE_LABEL = fr ? 'Échec et mat' : 'Checkmate';
  const MATE_DELAY = 2500;

  // Lichess brush -> Chess.com color, keyed by the stroke chessground paints
  // with, since brush names don't survive into the svg. Lichess's default
  // (green) is Chess.com's default orange, and its fourth color (yellow)
  // Chess.com's green.
  const ARROW_COLORS = {
    '#15781B': '255,170,0', // green, the default brush
    '#882020': '248,85,63', // red
    '#003088': '72,193,249', // blue
    '#e68f00': '159,207,63', // yellow
    '#4a4a4a': '200,200,200', // grey
    '#68217a': '170,110,210', // purple
    '#ee2080': '238,32,128', // pink
    '#ffffff': '255,255,255', // white
  };
  // Squares start from Chess.com's red instead, the color it highlights with:
  // the default brush takes the red, and Lichess's red brush the freed orange.
  const MARK_COLORS = { ...ARROW_COLORS, '#15781B': '235,97,80', '#882020': '255,170,0' };
  const REVIEW_COLOR = '159,207,63'; // the review's best move, Chess.com's green
  const ENGINE_COLOR = ARROW_COLORS['#003088']; // its engine's move, as Lichess's pale blue
  // Chessground fades the pale brushes it draws the engine's own arrows with to
  // 0.4, and the shape being dragged to 0.9; only the former should look faint.
  const alpha = el => (+(el.getAttribute('opacity') ?? 1) < 0.7 ? 0.5 : 0.8);
  // Chessground hashes each shape into its group as width, height, then whether
  // it's hilited, which is how it draws the one being dragged.
  const dragged = el => (el.parentNode.getAttribute('cgHash') || '').split(',')[2] === 'true';

  // In squares: shaft width, head width and length, gap before the origin.
  const SHAFT = 0.22, HEAD_W = 0.52, HEAD_L = 0.34, START = 0.35;

  const FILES = 'abcdefgh';
  // Board coordinates, in squares from the top left corner as shown.
  const center = (key, white) => {
    const f = FILES.indexOf(key[0]), r = +key[1] - 1;
    return white ? [f + 0.5, 7.5 - r] : [7.5 - f, r + 0.5];
  };

  // Polygon for an arrow along points [from, (corner,) tip], so overlapping
  // parts aren't drawn twice.
  function arrowPoints(pts) {
    const unit = (a, b) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    };
    const perp = u => [-u[1], u[0]];
    const add = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
    const tip = pts[pts.length - 1];
    const uFirst = unit(pts[0], pts[1]);
    const uLast = unit(pts[pts.length - 2], tip);
    const start = add(pts[0], uFirst, START);
    const base = add(tip, uLast, -HEAD_L);
    const n1 = perp(uFirst), n2 = perp(uLast), h = SHAFT / 2;
    const left = [add(start, n1, h)], right = [add(start, n1, -h)];
    if (pts.length === 3) {
      const miter = [n1[0] + n2[0], n1[1] + n2[1]];
      left.push(add(pts[1], miter, h));
      right.push(add(pts[1], miter, -h));
    }
    left.push(add(base, n2, h), add(base, n2, HEAD_W / 2), tip);
    right.push(add(base, n2, -h), add(base, n2, -HEAD_W / 2));
    return [...left, ...right.reverse()].map(p => p[0].toFixed(3) + ',' + p[1].toFixed(3)).join(' ');
  }

  function arrow([a, b, color, opacity]) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    // Knight moves: along the long leg first, then the short one.
    const knight = (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
    const corner = Math.abs(dx) > Math.abs(dy) ? [b[0], a[1]] : [a[0], b[1]];
    const pts = knight ? [a, corner, b] : [a, b];
    return `<polygon points="${arrowPoints(pts)}" fill="rgba(${color},${opacity})"/>`;
  }

  const MATE_ICON = `<svg viewBox="0 0 24 24"><g fill="#000">
    <path d="M3 8.5h1.5v9H3zM5.8 8.5h1.5v9H5.8zM1.5 10.6h7.3v1.5H1.5zM1.5 13.9h7.3v1.5H1.5z"/>
    <path d="M15.1 2h1.8v5h-1.8zM13.5 3.3h5v1.7h-5z"/>
    <path d="M9.6 12.6c0-2.5 2.6-3.6 4.6-2.3.8.5 1.4 1.3 1.8 2.1.4-.8 1-1.6 1.8-2.1 2-1.3 4.6-.2 4.6 2.3 0 2.6-2.2 4.8-2.9 5.5h-7c-.7-.7-2.9-2.9-2.9-5.5z"/>
    <rect x="12.1" y="18.8" width="7.8" height="2.4" rx="0.8"/></g></svg>`;

  // The mated king's square, if the current position is checkmate.
  function matedKing(node) {
    if (!node?.san?.endsWith('#') || !node.fen) return null;
    const [placement, turn] = node.fen.split(' ');
    const king = turn === 'w' ? 'K' : 'k';
    const rows = placement.split('/');
    for (let i = 0; i < 8; i++) {
      let f = 0;
      for (const ch of rows[i]) {
        if (/\d/.test(ch)) f += +ch;
        else if (ch === king) return FILES[f] + (8 - i);
        else f++;
      }
    }
    return null;
  }

  const layer = document.createElement('div');
  layer.id = 'cdc-shapes';
  const marks = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  marks.setAttribute('class', 'cdc-marks');
  marks.setAttribute('viewBox', '0 0 8 8');
  const html = document.documentElement;
  const started = Date.now();
  let last = '', mateNode = null, mateAt = 0, seen = false;

  function frame() {
    const container = document.querySelector('main .main-board cg-container');
    const svg = container?.querySelector('svg.cg-shapes');
    // No board: stop looking after a while.
    if (seen || Date.now() - started < 30000) requestAnimationFrame(frame);
    if (!svg) return;
    seen = true;
    // The fills belong under the pieces, the arrows over them (see board.css).
    if (marks.parentNode !== container) container.appendChild(marks);
    if (layer.parentNode !== container) container.appendChild(layer);
    html.classList.add('cdc-shapes');

    const white = !container.closest('.cg-wrap')?.classList.contains('orientation-black');
    const ctrl = window.site?.analysis;
    // During the Game Review, only its own arrows, not Lichess's engine's. They
    // sit in the same svg as the hand-drawn ones, in a pale brush. (Matched by
    // their squares against `autoShapes`, they flashed on every move: the svg
    // still holds the last position's for a frame.)
    const reviewing = html.classList.contains('cdc-review-moves') || html.classList.contains('cdc-review-summary');
    const auto = el => reviewing && alpha(el) < 0.8;

    // Chessground's shapes are in square units from the viewBox's own corner,
    // and an arrow's ends are pulled in from the centers: round back to them.
    const [ox, oy] = (svg.getAttribute('viewBox') || '-4 -4 8 8').split(/\s+/).map(Number);
    const square = (el, x, y) =>
      [Math.floor(+el.getAttribute(x) - ox) + 0.5, Math.floor(+el.getAttribute(y) - oy) + 0.5];

    const fills = [];
    for (const c of svg.querySelectorAll('circle')) {
      if (auto(c)) continue;
      const [x, y] = square(c, 'cx', 'cy');
      const color = MARK_COLORS[c.getAttribute('stroke')] || MARK_COLORS['#15781B'];
      fills.push(`<rect x="${x - 0.5}" y="${y - 0.5}" width="1" height="1" fill="rgba(${color},${alpha(c)})"/>`);
    }
    const arrows = [];
    for (const l of svg.querySelectorAll('line')) {
      if (dragged(l)) continue; // not until the button is released
      if (auto(l)) continue;
      const a = square(l, 'x1', 'y1'), b = square(l, 'x2', 'y2');
      arrows.push([a, b, ARROW_COLORS[l.getAttribute('stroke')] || ARROW_COLORS['#15781B'], alpha(l)]);
    }
    for (const s of window.cdcReviewArrows || []) {
      const engine = s.brush === 'engine';
      arrows.push([center(s.orig, white), center(s.dest, white), engine ? ENGINE_COLOR : REVIEW_COLOR, engine ? 0.5 : 0.8]);
    }

    const king = matedKing(ctrl?.node);
    if (king && ctrl.node !== mateNode) (mateNode = ctrl.node), (mateAt = Date.now());
    if (!king) mateNode = null;
    const phase = !king ? 0 : Date.now() - mateAt < MATE_DELAY ? 1 : 2;
    html.classList.toggle('cdc-mate', !!king);

    const key = JSON.stringify([fills, arrows, king, phase]);
    if (key === last) return;
    last = key;

    let mate = '';
    if (king) {
      const [x, y] = center(king, white).map(v => (v - 0.5) * 12.5);
      const pos = `left:${x}%;top:${y}%`;
      mate =
        phase === 1
          ? `<div class="cdc-mate__badge" style="left:${x + 12.5}%;top:${y}%">${MATE_ICON}</div>`
          : `<div class="cdc-mate__square" style="${pos}"><div class="cdc-mate__icon">${MATE_ICON}</div></div>
             <div class="cdc-mate__label" style="left:${x + 6.25}%;top:${y + 1.1}%">${MATE_LABEL}</div>`;
    }
    const arrowSvg = arrows.length
      ? `<svg class="cdc-shapes__arrows" viewBox="0 0 8 8">${arrows.map(arrow).join('')}</svg>`
      : '';
    marks.innerHTML = fills.join('');
    layer.innerHTML = arrowSvg + mate;
  }

  requestAnimationFrame(frame);
})();
