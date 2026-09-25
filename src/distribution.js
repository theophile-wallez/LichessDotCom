// Page-world script for the weekly rating distribution
// (/stat/rating/distribution/<perf>).
//
// Lichess draws it with Chart.js into a <canvas>: a bitmap, so CSS can't touch
// it. The page module's JSON is small (`{freq, myRating, otherRating,
// otherPlayer}`, `freq` being the players per 25 points from 400), so read it
// and draw our own chart in SVG, in the look of the profile's rating chart
// (ratingchart.js): one rounded column per 25 points over a gradient in the
// rating's color, the cumulative share as a smooth curve, a marker for your
// rating (and the player you came from), legend chips and a frosted tooltip.
// It runs in the page world for Lichess's own translated labels
// (`i18n.site`), which the isolated world can't see. Lichess's canvas is only
// hidden once ours is in (see styles/distribution.css).

(() => {
  if (!/\/stat\/rating\/distribution\//.test(location.pathname)) return;

  const MIN = 400;
  const STEP = 25;
  // Plot padding: room for the player counts on the left, the shares on the
  // right, the ratings below.
  const PAD = { t: 18, r: 48, b: 30, l: 50 };
  // Room above the columns for each marker's pill.
  const MARK_H = 30;
  // The profile chart's color for each rating, so Blitz is the same blue on
  // both pages.
  const COLORS = {
    ultraBullet: '#c084fc', bullet: '#f5a93b', blitz: '#45a3f5', rapid: '#81b64c', classical: '#2dd4bf',
    correspondence: '#fcd34d', crazyhouse: '#f472b6', chess960: '#a98bf0', kingOfTheHill: '#d6a36b',
    threeCheck: '#fb7185', antichess: '#94a3b8', atomic: '#f87171', horde: '#a3e635', racingKings: '#67e8f9',
  };
  const CUMUL = '#f1f1f0';
  // Neutral markers: every color is some rating's.
  const MINE = '#ffffff';
  const OTHER = '#bab9b8';

  const lang = document.documentElement.lang || undefined;
  const NUM = new Intl.NumberFormat(lang);
  const COMPACT = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  const PCT = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 1 });
  const PCT0 = new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 0 });

  const esc = s =>
    String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  // Lichess's translations, English if they ever move.
  const t = (key, en) => {
    const v = window.i18n?.site?.[key];
    return typeof v === 'string' ? v : en;
  };

  // ------------------------------------------------------------ scales ---

  const niceMax = max => {
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw);
    return { step, hi: Math.ceil(max / step) * step };
  };

  // Monotone cubic through the points (as in ratingchart.js): smooth, but a
  // share that only grows never dips between two points.
  const curve = pts => {
    const n = pts.length;
    const dx = [], m = [];
    for (let k = 0; k < n - 1; k++) {
      dx[k] = pts[k + 1][0] - pts[k][0];
      m[k] = (pts[k + 1][1] - pts[k][1]) / dx[k];
    }
    const tan = [m[0]];
    for (let k = 1; k < n - 1; k++) {
      tan[k] =
        m[k - 1] * m[k] <= 0
          ? 0
          : (3 * (dx[k - 1] + dx[k])) / ((2 * dx[k] + dx[k - 1]) / m[k - 1] + (dx[k] + 2 * dx[k - 1]) / m[k]);
    }
    tan[n - 1] = m[n - 2];
    const f = v => Math.round(v * 10) / 10;
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let k = 0; k < n - 1; k++) {
      const h = dx[k] / 3;
      d += `C${f(pts[k][0] + h)},${f(pts[k][1] + tan[k] * h)},${f(pts[k + 1][0] - h)},${f(pts[k + 1][1] - tan[k + 1] * h)},${f(pts[k + 1][0])},${f(pts[k + 1][1])}`;
    }
    return d;
  };

  // A column with its top corners rounded, standing on the axis.
  const column = (x, y, w, bottom) => {
    const r = Math.min(3, w / 2, (bottom - y) / 2);
    const f = v => Math.round(v * 10) / 10;
    return `M${f(x)},${f(bottom)}V${f(y + r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + w - r)}` +
      `Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(bottom)}Z`;
  };

  // ------------------------------------------------------------ chart ---

  const mount = (host, data) => {
    const freq = data.freq;
    const n = freq.length;
    const max = MIN + n * STEP;
    const total = freq.reduce((a, b) => a + b, 0);
    // Share of the players rated below the end of each column.
    const cumul = [];
    freq.reduce((acc, v, i) => (cumul[i] = (acc + v) / total, acc + v), 0);
    const perf = location.pathname.match(/\/distribution\/(\w+)/)?.[1];
    const color = COLORS[perf] || COLORS.blitz;
    const bin = r => Math.max(0, Math.min(n - 1, Math.floor((r - MIN) / STEP)));
    // A rating off the chart (Lichess caps the top) stands at its edge.
    const at = r => Math.max(MIN, Math.min(max, r));
    const markers = [];
    if (Number.isFinite(data.myRating))
      markers.push({ cls: 'mine', color: MINE, rating: data.myRating, label: t('yourRating', 'Your rating') });
    if (Number.isFinite(data.otherRating) && typeof data.otherPlayer === 'string')
      markers.push({ cls: 'other', color: OTHER, rating: data.otherRating, label: data.otherPlayer });
    // Your part of the players: the columns up to your rating stay lit.
    const lit = markers.length ? bin(markers[0].rating) : n - 1;
    const PT = PAD.t + markers.length * MARK_H;

    const root = document.createElement('div');
    root.className = 'cdc-dist';
    root.style.setProperty('--c', color);
    const chip = (c, name, value) =>
      `<span class="cdc-rchart__chip cdc-dist__chip" style="--c:${c}"><span class="cdc-rchart__swatch"></span>` +
      `<span class="cdc-rchart__name">${esc(name)}</span>${value ? `<strong>${esc(value)}</strong>` : ''}</span>`;
    root.innerHTML =
      '<div class="cdc-dist__legend">' +
      chip(color, t('players', 'Players'), NUM.format(total)) +
      chip(CUMUL, t('cumulative', 'Cumulative'), '') +
      '</div>' +
      '<div class="cdc-dist__plot"><svg class="cdc-dist__svg" aria-hidden="true"></svg>' +
      '<div class="cdc-dist__marks"></div><div class="cdc-rchart__tip cdc-dist__tip"></div></div>';
    host.appendChild(root);
    host.classList.add('cdc-dist-on');
    host.closest('.rating-stats')?.style.setProperty('--cdc-dist-c', color);
    const plot = root.querySelector('.cdc-dist__plot');
    const svg = root.querySelector('svg');
    const marks = root.querySelector('.cdc-dist__marks');
    const tip = root.querySelector('.cdc-dist__tip');

    let view = null;

    const draw = animate => {
      const width = Math.max(240, Math.round(plot.clientWidth));
      const height = Math.max(200, Math.round(plot.clientHeight));
      const w = width - PAD.l - PAD.r, bottom = height - PAD.b, h = bottom - PT;
      const y = niceMax(Math.max(...freq));
      const x = r => PAD.l + ((r - MIN) / (max - MIN)) * w;
      const yy = v => bottom - (v / y.hi) * h;
      const yc = s => bottom - s * h;
      const bw = w / n;
      const gap = bw > 6 ? Math.min(3, bw * 0.22) : 0.5;
      view = { width, x, yy, yc, bw };

      // Every 100 points, or fewer when they'd collide.
      const every = [100, 200, 500].find(s => (w / (max - MIN)) * s >= 44) || 500;
      const xlabels = [];
      for (let r = Math.ceil(MIN / every) * every; r <= max; r += every)
        xlabels.push(`<text class="cdc-rchart__xlabel" x="${x(r)}" y="${height - 9}">${r}</text>`);
      const grid = [];
      for (let v = 0; v <= y.hi + y.step / 2; v += y.step)
        grid.push(
          `<line class="cdc-rchart__grid${v ? '' : ' cdc-dist__base'}" x1="${PAD.l}" x2="${width - PAD.r}" y1="${yy(v)}" y2="${yy(v)}"/>` +
            `<text class="cdc-rchart__ylabel" x="${PAD.l - 10}" y="${yy(v)}">${v ? COMPACT.format(v) : 0}</text>`,
        );
      const shares = [0.25, 0.5, 0.75, 1]
        .map(s => `<text class="cdc-dist__slabel" x="${width - PAD.r + 10}" y="${yc(s)}">${PCT0.format(s)}</text>`)
        .join('');
      const bars = freq
        .map((v, i) =>
          `<path class="cdc-dist__bar${i > lit ? ' cdc-dist__bar--dim' : ''}" data-i="${i}" style="--k:${i}" ` +
          `d="${column(PAD.l + i * bw + gap / 2, yy(v), Math.max(0.5, bw - gap), bottom)}"/>`)
        .join('');
      const cumulPts = [[x(MIN), yc(0)], ...cumul.map((s, i) => [x(MIN + (i + 1) * STEP), yc(s)])];

      svg.setAttribute('width', width);
      svg.setAttribute('height', height);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.innerHTML =
        `<defs><linearGradient id="cdc-dist-g" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${PT}" y2="${bottom}">` +
        `<stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity="0.35"/></linearGradient></defs>` +
        `<g class="cdc-rchart__axis">${grid.join('')}${xlabels.join('')}${shares}</g>` +
        `<g class="cdc-dist__bars">${bars}</g>` +
        markers
          .map(m => `<line class="cdc-dist__mline" style="--c:${m.color}" x1="${x(at(m.rating))}" x2="${x(at(m.rating))}" y1="${markers.indexOf(m) * MARK_H + 24}" y2="${bottom}"/>`)
          .join('') +
        `<path class="cdc-dist__cumul" pathLength="1" d="${curve(cumulPts)}"/>` +
        '<circle class="cdc-dist__dot" r="4.5"/>' +
        `<rect class="cdc-rchart__hit" x="${PAD.l}" y="${PT}" width="${w}" height="${h}"/>`;
      // The markers' labels are HTML, pills over the top of their line.
      marks.innerHTML = markers
        .map(m => `<span class="cdc-dist__mark cdc-dist__mark--${m.cls}" style="--c:${m.color}">${esc(m.label)} <strong>${NUM.format(m.rating)}</strong></span>`)
        .join('');
      [...marks.children].forEach((el, k) => {
        const mx = x(at(markers[k].rating));
        const left = Math.max(PAD.l, Math.min(width - PAD.r - el.offsetWidth, mx - el.offsetWidth / 2));
        el.style.transform = `translate(${Math.round(left)}px, ${k * MARK_H}px)`;
      });
      svg.classList.toggle('cdc-dist__svg--intro', !!animate);
      root.classList.toggle('cdc-dist--intro', !!animate);
    };

    // Hover: the column under the pointer, and the columns up to it lit (the
    // share of players rated below it, which the curve also reads).
    const hover = e => {
      const s = view;
      const px = e.clientX - svg.getBoundingClientRect().left;
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - PAD.l) / s.bw)));
      svg.classList.add('cdc-dist__svg--hover');
      for (const b of svg.querySelectorAll('.cdc-dist__bar')) {
        const k = +b.dataset.i;
        b.classList.toggle('cdc-dist__bar--on', k === i);
        b.classList.toggle('cdc-dist__bar--dim', k > i);
      }
      const dot = svg.querySelector('.cdc-dist__dot');
      dot.setAttribute('cx', s.x(MIN + (i + 1) * STEP));
      dot.setAttribute('cy', s.yc(cumul[i]));
      const lo = MIN + i * STEP;
      tip.innerHTML =
        `<div class="cdc-rchart__tipdate">${lo}–${lo + STEP - 1}</div>` +
        `<div class="cdc-rchart__tiprow" style="--c:${color}"><span class="cdc-rchart__swatch"></span>` +
        `<span>${esc(t('players', 'Players'))}</span><strong>${NUM.format(freq[i])}</strong></div>` +
        `<div class="cdc-rchart__tiprow" style="--c:${CUMUL}"><span class="cdc-rchart__swatch"></span>` +
        `<span>${esc(t('cumulative', 'Cumulative'))}</span><strong>${PCT.format(cumul[i])}</strong></div>`;
      tip.classList.add('cdc-rchart__tip--on');
      const cx = PAD.l + (i + 0.5) * s.bw;
      const tw = tip.offsetWidth;
      const left = cx + 16 + tw > s.width - PAD.r ? cx - 16 - tw : cx + 16;
      tip.style.transform = `translate(${Math.round(left)}px, ${PT + 24}px)`;
    };
    const leave = () => {
      svg.classList.remove('cdc-dist__svg--hover');
      tip.classList.remove('cdc-rchart__tip--on');
      for (const b of svg.querySelectorAll('.cdc-dist__bar')) {
        b.classList.remove('cdc-dist__bar--on');
        b.classList.toggle('cdc-dist__bar--dim', +b.dataset.i > lit);
      }
    };
    svg.addEventListener('pointermove', hover);
    svg.addEventListener('pointerleave', leave);

    let last = '';
    new ResizeObserver(() => {
      const size = `${Math.round(plot.clientWidth)}x${Math.round(plot.clientHeight)}`;
      if (size === last) return;
      const first = !last;
      last = size;
      draw(first);
    }).observe(plot);
  };

  // ------------------------------------------------------------ boot ---

  // Lichess's page module reads its JSON out of #page-init-data and then
  // removes it, so hold on to the node while the page is still parsing (see
  // dashboard.js). Its text is only complete at DOMContentLoaded.
  const loading = document.readyState === 'loading';
  let initData = loading ? null : document.getElementById('page-init-data');
  const initObserver = new MutationObserver(() => {
    initData = document.getElementById('page-init-data');
    if (initData) initObserver.disconnect();
  });

  const boot = () => {
    initObserver.disconnect();
    const host = document.getElementById('rating_distribution');
    let json = null;
    try {
      json = host && initData ? JSON.parse(initData.textContent) : null;
    } catch {}
    initData = null;
    const freq = json?.freq;
    if (!Array.isArray(freq) || freq.length < 2 || !freq.every(Number.isFinite) || !freq.some(v => v > 0)) return;
    if (host.querySelector('.cdc-dist')) return;
    mount(host, json);
  };

  if (loading) {
    initObserver.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
