// Isolated-world content script for the rating history chart, on a profile
// (/@/<user>) and on a rating's stats page (/@/<user>/perf/<type>).
//
// Lichess draws it with Chart.js into a <canvas>, with a noUiSlider under it:
// a bitmap, so CSS can't touch its colors or curves. The ratings it charts are
// the page module's JSON (`{data: [{name, points: [[y, m, d, rating], …]}, …]}`,
// plus `singlePerfName` on a stats page), so read those and draw our own chart
// in SVG instead, like dashboard.js does for the puzzle radar: smooth curves
// over a gradient, a guide line and a tooltip on hover, range pills, and one
// chip per rating (its current value and the change over the range; a click
// hides or shows it). Lichess's chart is only hidden once ours is in place
// (see styles/ratingchart.css), so if the data ever moves we fall back to theirs.

(() => {
  const DAY = 86400000;
  // Series come in a fixed order (their names are translated, so Lichess styles
  // them by position too): UltraBullet, Bullet, Blitz, Rapid, Classical,
  // Correspondence, Crazyhouse, Chess960, King of the Hill, Three-check,
  // Antichess, Atomic, Horde, Racing Kings, Puzzle.
  const COLORS = [
    '#c084fc', '#f5a93b', '#45a3f5', '#81b64c', '#2dd4bf', '#fcd34d', '#f472b6', '#a98bf0',
    '#d6a36b', '#fb7185', '#94a3b8', '#f87171', '#a3e635', '#67e8f9', '#f06a4a',
  ];
  const RANGES = [
    ['1M', end => addMonths(end, -1)],
    ['3M', end => addMonths(end, -3)],
    ['6M', end => addMonths(end, -6)],
    ['YTD', end => Date.UTC(new Date(end).getUTCFullYear(), 0, 1)],
    ['1Y', end => addMonths(end, -12)],
    ['ALL', (end, first) => first],
  ];
  const RANGE_KEY = 'cdc-rchart:range';
  // Plot padding: room for the rating labels on the left, the dates below.
  const PAD = { t: 14, r: 14, b: 28, l: 46 };
  const HEIGHT = 300;
  // Samples across the plot: daily up to this many days, coarser beyond.
  const MAX_SAMPLES = 180;

  const lang = document.documentElement.lang || undefined;
  const fmt = opts => new Intl.DateTimeFormat(lang, { timeZone: 'UTC', ...opts });
  const FMT_DAY = fmt({ day: 'numeric', month: 'short' });
  const FMT_MONTH = fmt({ month: 'short' });
  const FMT_MONTH_YEAR = fmt({ month: 'short', year: 'numeric' });
  const FMT_YEAR = fmt({ year: 'numeric' });
  const FMT_FULL = fmt({ day: 'numeric', month: 'short', year: 'numeric' });

  const esc = s =>
    String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const addMonths = (t, n) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate());
  };
  const today = () => {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const signed = n => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

  // ------------------------------------------------------------ data ---

  const parseSeries = json => {
    const data = json?.data;
    if (!Array.isArray(data) || !data.length) return null;
    const series = [];
    for (const [i, s] of data.entries()) {
      if (typeof s?.name !== 'string' || !Array.isArray(s.points)) return null;
      const points = s.points
        .filter(p => Array.isArray(p) && p.length >= 4 && p.every(Number.isFinite))
        .map(([y, m, d, r]) => [Date.UTC(y, m, d), r])
        .sort((a, b) => a[0] - b[0]);
      if (points.length) series.push({ i, name: s.name, color: COLORS[i % COLORS.length], points });
    }
    if (json.singlePerfName) return series.filter(s => s.name === json.singlePerfName);
    return series;
  };

  // One time grid shared by every series of a range, so a series' path keeps
  // the same shape of commands when the rating scale changes (the curves can
  // then morph, see `d` in the CSS). A series' value at a sample is its last
  // rating on or before that day: its rating then.
  const sampleRange = (series, start, end) => {
    const step = Math.max(1, Math.ceil((end - start) / DAY / MAX_SAMPLES)) * DAY;
    const times = [];
    for (let t = start; t < end; t += step) times.push(t);
    times.push(end);
    const anyPlayed = series.some(s => s.points.some(([t]) => t >= start && t <= end));
    const rows = [];
    for (const s of series) {
      // A rating not played in the range only shows if none was: then it's the
      // flat line of where each rating stands.
      if (anyPlayed && !s.points.some(([t]) => t >= start && t <= end)) continue;
      let k = -1;
      const values = times.map(t => {
        while (k + 1 < s.points.length && s.points[k + 1][0] <= t) k++;
        return k < 0 ? null : s.points[k][1];
      });
      if (values.some(v => v !== null)) rows.push({ ...s, values });
    }
    return { times, rows };
  };

  // ------------------------------------------------------------ scales ---

  const niceTicks = (min, max) => {
    if (min === max) [min, max] = [min - 20, max + 20];
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const raw = (max - min) / 4;
    const step = [5, 10, 20, 25, 50, 100, 150, 200, 250, 300, 400, 500, 1000].find(s => s >= raw) || 1000;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
    return { lo, hi, ticks };
  };

  // Month or year starts across the range, thinned so labels don't collide.
  const timeTicks = (start, end, width) => {
    const days = (end - start) / DAY;
    const ticks = [];
    if (days <= 45) {
      for (let k = 1; k < 5; k++) {
        const t = Math.round((start + ((end - start) * k) / 5) / DAY) * DAY;
        ticks.push([t, FMT_DAY.format(t)]);
      }
    } else if (days <= 800) {
      const d = new Date(start);
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      for (; t <= end; t = addMonths(t, 1)) {
        const jan = new Date(t).getUTCMonth() === 0;
        ticks.push([t, (jan ? FMT_MONTH_YEAR : FMT_MONTH).format(t)]);
      }
    } else {
      for (let y = new Date(start).getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= end; y++) {
        const t = Date.UTC(y, 0, 1);
        ticks.push([t, FMT_YEAR.format(t)]);
      }
    }
    const room = Math.max(1, Math.floor(width / 72));
    const every = Math.ceil(ticks.length / room);
    return ticks.filter((_, k) => k % every === 0);
  };

  // Monotone cubic through the points (Fritsch–Carlson, as d3's monotoneX):
  // smooth, but never overshooting a rating it didn't reach.
  const curve = pts => {
    const n = pts.length;
    if (n === 1) return `M${pts[0][0]},${pts[0][1]}h0.01`;
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

  // ------------------------------------------------------------ chart ---

  const mount = (host, series) => {
    const first = Math.min(...series.map(s => s.points[0][0]));
    const end = Math.max(today(), ...series.map(s => s.points[s.points.length - 1][0]));
    const rangeStart = key => Math.max(first, RANGES.find(([k]) => k === key)[1](end, first));
    const saved = localStorage.getItem(RANGE_KEY);
    const state = {
      // Lichess's default: three months, unless the history is shorter.
      range: RANGES.some(([k]) => k === saved) ? saved : first < addMonths(end, -3) ? '3M' : 'ALL',
      hidden: new Set(),
    };

    const root = document.createElement('div');
    root.className = 'cdc-rchart';
    root.innerHTML =
      '<div class="cdc-rchart__top"><div class="cdc-rchart__legend"></div>' +
      `<div class="cdc-rchart__ranges"><span class="cdc-rchart__thumb"></span>${RANGES.map(([k]) => `<button type="button" data-range="${k}">${k}</button>`).join('')}</div></div>` +
      '<div class="cdc-rchart__plot"><svg class="cdc-rchart__svg" aria-hidden="true"></svg><div class="cdc-rchart__tip"></div></div>';
    host.appendChild(root);
    host.classList.add('cdc-rchart-on');
    const legend = root.querySelector('.cdc-rchart__legend');
    const plot = root.querySelector('.cdc-rchart__plot');
    const svg = root.querySelector('svg');
    const tip = root.querySelector('.cdc-rchart__tip');

    let view = null; // What's drawn: the range's samples and the scales.

    // The active range's highlight is one element sliding under the pills,
    // from the previous choice to the new one. Placed without a transition the
    // first time (and whenever the pills reflow), so it doesn't fly in.
    const thumb = root.querySelector('.cdc-rchart__thumb');
    let thumbKey = '';
    const placeThumb = () => {
      const b = root.querySelector('[data-range].active');
      if (!b) return;
      const key = `${b.offsetLeft},${b.offsetTop},${b.offsetWidth}`;
      if (key === thumbKey) return;
      const slide = !!thumbKey && root.dataset.cdcSlide === '1';
      thumb.classList.toggle('cdc-rchart__thumb--still', !slide);
      thumb.style.width = `${b.offsetWidth}px`;
      thumb.style.height = `${b.offsetHeight}px`;
      thumb.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
      thumbKey = key;
      delete root.dataset.cdcSlide;
    };

    const layout = () => {
      const width = Math.max(200, Math.round(plot.clientWidth));
      const start = rangeStart(state.range);
      const { times, rows } = sampleRange(series, start, end);
      return { width, start, times, rows };
    };

    const scales = v => {
      const shown = v.rows.filter(r => !state.hidden.has(r.i));
      const values = shown.flatMap(r => r.values).filter(x => x !== null);
      const y = niceTicks(Math.min(...values), Math.max(...values));
      const w = v.width - PAD.l - PAD.r, h = HEIGHT - PAD.t - PAD.b;
      const x = t => PAD.l + ((t - v.start) / Math.max(DAY, end - v.start)) * w;
      const yy = r => PAD.t + (1 - (r - y.lo) / (y.hi - y.lo)) * h;
      return { ...v, y, x, yy, bottom: PAD.t + h, shown };
    };

    const paths = (s, r) => {
      const pts = [];
      r.values.forEach((val, j) => val !== null && pts.push([s.x(s.times[j]), s.yy(val)]));
      const line = curve(pts);
      const area = `${line}L${pts[pts.length - 1][0]},${s.bottom}L${pts[0][0]},${s.bottom}Z`;
      const ys = pts.map(p => p[1]);
      return { line, area, top: Math.min(...ys), low: Math.max(...ys) };
    };

    const setD = (el, d) => {
      el.style.d = `path("${d}")`;
    };

    // Full redraw: a new range or a new width. `animate` wipes the curves in.
    const draw = animate => {
      const s = (view = scales(layout()));
      const xlabels = timeTicks(s.start, end, s.width - PAD.l - PAD.r)
        .filter(([t]) => s.x(t) > PAD.l + 16 && s.x(t) < s.width - PAD.r - 16)
        .map(([t, label]) => `<text class="cdc-rchart__xlabel" x="${s.x(t)}" y="${HEIGHT - 8}">${esc(label)}</text>`)
        .join('');
      const defs = s.rows
        .map(r => `<linearGradient id="cdc-rg-${r.i}" gradientUnits="userSpaceOnUse" x1="0" x2="0">` +
          `<stop offset="0" stop-color="${r.color}" stop-opacity="0.3"/>` +
          `<stop offset="1" stop-color="${r.color}" stop-opacity="0"/></linearGradient>`)
        .join('');
      const groups = s.rows
        .map(r => `<g class="cdc-rchart__series" data-i="${r.i}" style="--c:${r.color}">` +
          `<path class="cdc-rchart__area" fill="url(#cdc-rg-${r.i})"/>` +
          `<path class="cdc-rchart__line"/></g>`)
        .join('');
      svg.setAttribute('width', s.width);
      svg.setAttribute('height', HEIGHT);
      svg.setAttribute('viewBox', `0 0 ${s.width} ${HEIGHT}`);
      svg.innerHTML =
        // One wipe reveals every line and fill together, left to right.
        `<defs>${defs}<clipPath id="cdc-rclip"><rect class="cdc-rchart__wipe" x="${PAD.l - 4}" y="0" ` +
        `width="${s.width - PAD.l - PAD.r + 8}" height="${HEIGHT}"/></clipPath></defs>` +
        `<g class="cdc-rchart__axis">${xlabels}</g>` +
        `<g class="cdc-rchart__all" clip-path="url(#cdc-rclip)">${groups}</g>` +
        `<g class="cdc-rchart__hover"><line class="cdc-rchart__guide" y1="${PAD.t}" y2="${s.bottom}"/>` +
        s.rows.map(r => `<circle class="cdc-rchart__dot" data-i="${r.i}" r="4.5" style="--c:${r.color}"/>`).join('') +
        '</g>' +
        `<rect class="cdc-rchart__hit" x="${PAD.l}" y="${PAD.t}" width="${s.width - PAD.l - PAD.r}" height="${s.bottom - PAD.t}"/>`;
      svg.classList.toggle('cdc-rchart__svg--intro', !!animate);
      update();
      renderLegend();
      for (const b of root.querySelectorAll('[data-range]')) b.classList.toggle('active', b.dataset.range === state.range);
      placeThumb();
    };

    // Same range, other ratings shown: new scale, same samples, so the curves
    // move to their new place instead of being redrawn. Draws the grid too.
    const update = () => {
      const s = (view = scales(view));
      for (const g of svg.querySelectorAll('.cdc-rchart__series')) {
        const r = s.rows.find(row => row.i === +g.dataset.i);
        g.classList.toggle('cdc-rchart__series--hidden', state.hidden.has(r.i));
        const { line, area, top, low } = paths(s, r);
        setD(g.querySelector('.cdc-rchart__line'), line);
        setD(g.querySelector('.cdc-rchart__area'), area);
        // Each fill fades out just under its own curve, not at the bottom of
        // the plot: stacked to the bottom, the higher ratings' fills would
        // cover the lower ones.
        const grad = svg.getElementById(`cdc-rg-${r.i}`);
        grad.setAttribute('y1', top);
        grad.setAttribute('y2', Math.min(s.bottom, low + 70));
      }
      const axis = svg.querySelector('.cdc-rchart__axis');
      axis.querySelectorAll('.cdc-rchart__grid, .cdc-rchart__ylabel').forEach(n => n.remove());
      axis.insertAdjacentHTML(
        'afterbegin',
        s.y.ticks
          .map(v => `<line class="cdc-rchart__grid" x1="${PAD.l}" x2="${s.width - PAD.r}" y1="${s.yy(v)}" y2="${s.yy(v)}"/>` +
            `<text class="cdc-rchart__ylabel" x="${PAD.l - 10}" y="${s.yy(v)}">${v}</text>`)
          .join(''),
      );
    };

    const renderLegend = () => {
      const single = series.length === 1;
      legend.innerHTML = view.rows
        .map(r => {
          const vals = r.values.filter(v => v !== null);
          const now = vals[vals.length - 1];
          const diff = now - vals[0];
          const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
          return `<button type="button" class="cdc-rchart__chip${state.hidden.has(r.i) ? ' cdc-rchart__chip--off' : ''}" data-i="${r.i}" style="--c:${r.color}"${single ? ' disabled' : ''}>` +
            `<span class="cdc-rchart__swatch"></span><span class="cdc-rchart__name">${esc(r.name)}</span>` +
            `<strong>${now}</strong><span class="cdc-rchart__diff cdc-rchart__diff--${cls}">${signed(diff)}</span></button>`;
        })
        .join('');
    };

    // Hover: snap to the nearest sample, a dot on every curve shown there.
    const hover = e => {
      const s = view;
      const box = svg.getBoundingClientRect();
      const px = e.clientX - box.left;
      let j = 0;
      for (let k = 1; k < s.times.length; k++) if (Math.abs(s.x(s.times[k]) - px) < Math.abs(s.x(s.times[j]) - px)) j = k;
      const x = s.x(s.times[j]);
      const rows = s.shown.filter(r => r.values[j] !== null);
      if (!rows.length) return leave();
      svg.classList.add('cdc-rchart__svg--hover');
      const guide = svg.querySelector('.cdc-rchart__guide');
      guide.setAttribute('x1', x);
      guide.setAttribute('x2', x);
      for (const dot of svg.querySelectorAll('.cdc-rchart__dot')) {
        const r = rows.find(row => row.i === +dot.dataset.i);
        dot.classList.toggle('cdc-rchart__dot--on', !!r);
        if (r) {
          dot.setAttribute('cx', x);
          dot.setAttribute('cy', s.yy(r.values[j]));
        }
      }
      tip.innerHTML =
        `<div class="cdc-rchart__tipdate">${esc(FMT_FULL.format(s.times[j]))}</div>` +
        rows
          .slice()
          .sort((a, b) => b.values[j] - a.values[j])
          .map(r => `<div class="cdc-rchart__tiprow" style="--c:${r.color}"><span class="cdc-rchart__swatch"></span>` +
            `<span>${esc(r.name)}</span><strong>${r.values[j]}</strong></div>`)
          .join('');
      tip.classList.add('cdc-rchart__tip--on');
      const tw = tip.offsetWidth;
      const left = x + 14 + tw > s.width - PAD.r ? x - 14 - tw : x + 14;
      tip.style.transform = `translate(${Math.round(left)}px, ${PAD.t}px)`;
    };
    const leave = () => {
      svg.classList.remove('cdc-rchart__svg--hover');
      tip.classList.remove('cdc-rchart__tip--on');
    };

    root.addEventListener('click', e => {
      const range = e.target.closest('[data-range]');
      if (range && range.dataset.range !== state.range) {
        state.range = range.dataset.range;
        localStorage.setItem(RANGE_KEY, state.range);
        root.dataset.cdcSlide = '1';
        leave();
        draw(true);
      }
      const chip = e.target.closest('.cdc-rchart__chip');
      if (chip) {
        const i = +chip.dataset.i;
        if (state.hidden.has(i)) state.hidden.delete(i);
        // Never hide the last one shown: an empty chart has no scale.
        else if (view.rows.filter(r => !state.hidden.has(r.i)).length > 1) state.hidden.add(i);
        else return;
        leave();
        update();
        renderLegend();
      }
    });
    svg.addEventListener('pointermove', hover);
    svg.addEventListener('pointerleave', leave);

    let lastWidth = 0;
    new ResizeObserver(() => {
      const width = Math.round(plot.clientWidth);
      if (Math.abs(width - lastWidth) < 2) return;
      const firstDraw = !lastWidth;
      lastWidth = width;
      draw(firstDraw);
    }).observe(plot);
  };

  // ------------------------------------------------------------ boot ---

  // Lichess's page modules read their JSON out of #page-init-data and then
  // remove it, so hold on to the node while the page is still parsing (see
  // dashboard.js). Its text is only complete at DOMContentLoaded.
  const loading = document.readyState === 'loading';
  let initData = loading ? null : document.getElementById('page-init-data');
  const initObserver = new MutationObserver(() => {
    initData = document.getElementById('page-init-data');
    if (initData) initObserver.disconnect();
  });

  const boot = () => {
    initObserver.disconnect();
    // The outer container is the card; Lichess's own chart is the inner one.
    const host = document.querySelector('.rating-history-container:has(> .rating-history-container)');
    let json = null;
    try {
      json = host && initData ? JSON.parse(initData.textContent) : null;
    } catch {}
    initData = null;
    const series = json && parseSeries(json);
    if (!series?.length || host.querySelector('.cdc-rchart')) return;
    mount(host, series);
  };

  if (loading) {
    initObserver.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', boot);
  } else boot();
})();
