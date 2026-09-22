// Page-world script: Chess.com-style arrows and checkmate on analysis boards.
//
// - Arrows: chessground's arrows (drawn with the right mouse button, engine
//   lines, and the Game Review's best move) are hidden and redrawn with
//   Chess.com's shape and colors: a thick 80% opaque arrow starting at the edge
//   of the origin square, L-shaped for knight moves.
// - Checkmate: a red badge with a mated king on the king's square, then after a
//   moment the square turns red under a "Checkmate" label.
//
// Shapes come from `site.analysis.chessground.state.drawable`. The review adds
// its own arrows through `window.cdcReviewArrows` ([{ orig, dest, brush }]).

(() => {
  const fr = (document.documentElement.lang || '').startsWith('fr');
  const MATE_LABEL = fr ? 'Échec et mat' : 'Checkmate';
  const MATE_DELAY = 2500;

  // Lichess brush -> Chess.com color. Lichess's default (green) is Chess.com's
  // default orange, and its fourth color (yellow) Chess.com's green.
  const COLORS = {
    green: '255,170,0',
    red: '248,85,63',
    blue: '72,193,249',
    yellow: '159,207,63',
    best: '159,207,63',
    paleGreen: '255,170,0',
    paleRed: '248,85,63',
    paleBlue: '72,193,249',
    paleGrey: '200,200,200',
    purple: '170,110,210',
    pink: '238,32,128',
    white: '255,255,255',
  };
  const opacity = brush => (/^pale/.test(brush) ? 0.5 : 0.8);

  // In squares: shaft width, head width and length, gap before the origin.
  const SHAFT = 0.22, HEAD_W = 0.52, HEAD_L = 0.34, START = 0.35;

  const FILES = 'abcdefgh';
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

  function arrow(orig, dest, brush, white) {
    const a = center(orig, white), b = center(dest, white);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    // Knight moves: along the long leg first, then the short one.
    const knight = (Math.abs(dx) === 1 && Math.abs(dy) === 2) || (Math.abs(dx) === 2 && Math.abs(dy) === 1);
    const corner = Math.abs(dx) > Math.abs(dy) ? [b[0], a[1]] : [a[0], b[1]];
    const pts = knight ? [a, corner, b] : [a, b];
    const color = COLORS[brush] || COLORS.green;
    return `<polygon points="${arrowPoints(pts)}" fill="rgba(${color},${opacity(brush)})"/>`;
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
  const html = document.documentElement;
  const started = Date.now();
  let last = '', mateNode = null, mateAt = 0, seen = false;

  function frame() {
    const ctrl = window.site?.analysis;
    const cg = ctrl?.chessground;
    const container = document.querySelector('main.analyse .main-board cg-container');
    // Not an analysis board: stop looking after a while.
    if (seen || Date.now() - started < 30000) requestAnimationFrame(frame);
    if (!cg?.state || !container) return;
    seen = true;
    if (layer.parentNode !== container) container.appendChild(layer);
    html.classList.add('cdc-arrows');

    const d = cg.state.drawable;
    const white = cg.state.orientation === 'white';
    const shapes = [...(d.shapes || []), ...(d.autoShapes || []), ...(window.cdcReviewArrows || [])];
    if (d.current) shapes.push(d.current); // the arrow being drawn
    const arrows = shapes
      .filter(s => s.orig && s.dest && s.orig !== s.dest && !s.customSvg && !s.piece)
      .map(s => [s.orig, s.dest, s.brush || 'green']);

    const king = matedKing(ctrl.node);
    if (king && ctrl.node !== mateNode) (mateNode = ctrl.node), (mateAt = Date.now());
    if (!king) mateNode = null;
    const phase = !king ? 0 : Date.now() - mateAt < MATE_DELAY ? 1 : 2;
    html.classList.toggle('cdc-mate', !!king);

    const key = JSON.stringify([white, arrows, king, phase]);
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
    const svg = arrows.length
      ? `<svg class="cdc-shapes__arrows" viewBox="0 0 8 8">${arrows.map(a => arrow(...a, white)).join('')}</svg>`
      : '';
    layer.innerHTML = svg + mate;
  }

  requestAnimationFrame(frame);
})();
