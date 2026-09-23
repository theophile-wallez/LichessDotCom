// Isolated-world content script for the puzzle dashboard (/training/dashboard).
//
// The page's centrepiece is a radar of performance per puzzle theme, which
// Lichess draws with Chart.js into a <canvas>: a bitmap, so CSS can't touch its
// colors, fonts or proportions. The numbers it charts are inlined in the page as
// its page module's JSON, so read those and draw our own radar in SVG instead,
// Chess.com-style. Lichess's canvas is only hidden once ours is in place (see
// styles/dashboard.css), so if the data ever moves we fall back to their chart
// rather than to an empty panel.

(() => {
  const RINGS = 4;
  // Radius in viewBox units; the SVG scales, so this is just the grid's shape.
  const R = 100;

  const esc = s =>
    String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // Vertex i of a regular n-gon of radius r, starting at the top like Chart.js.
  const vertex = (i, n, r) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const polygon = (n, r) =>
    Array.from({ length: n }, (_, i) => vertex(i, n, r).map(v => v.toFixed(2)).join(',')).join(' ');

  // No tick labels are drawn (each theme shows its own number), so the scale
  // only has to place the points well inside the rim, whatever the spread.
  const bounds = data => {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min;
    return span ? [min - span * 0.6, max + span * 0.25] : [min - 10, min + 10];
  };

  const render = (host, radar) => {
    const names = radar.labels;
    const data = radar.datasets[0].data.map(Number);
    const n = names.length;
    const [lo, hi] = bounds(data);

    const rings = Array.from(
      { length: RINGS },
      (_, k) => `<polygon points="${polygon(n, (R * (k + 1)) / RINGS)}"/>`,
    ).join('');
    const spokes = Array.from({ length: n }, (_, i) => {
      const [x, y] = vertex(i, n, R);
      return `<line x1="0" y1="0" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}"/>`;
    }).join('');
    const points = data.map((v, i) =>
      vertex(i, n, R * Math.min(Math.max((v - lo) / (hi - lo), 0.06), 1)),
    );
    const dots = points
      .map(([x, y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.6"/>`)
      .join('');
    const area = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

    // Labels are HTML, not SVG text: real fonts, real wrapping. Each sits on its
    // spoke (--cdc-x / --cdc-y) and is nudged outwards along it (--cdc-ox/oy).
    const labels = names
      .map((name, i) => {
        const [ux, uy] = vertex(i, n, 1);
        return (
          `<div class="cdc-radar__label" style="--cdc-x:${(50 + 50 * ux).toFixed(2)}%;` +
          `--cdc-y:${(50 + 50 * uy).toFixed(2)}%;--cdc-ox:${ux.toFixed(3)};--cdc-oy:${uy.toFixed(3)}">` +
          `<span class="cdc-radar__name">${esc(name)}</span>` +
          `<span class="cdc-radar__value">${Math.round(data[i])}</span></div>`
        );
      })
      .join('');

    const figure = document.createElement('div');
    figure.className = 'cdc-radar';
    figure.innerHTML =
      '<div class="cdc-radar__plot">' +
      `<svg class="cdc-radar__chart" viewBox="${-R} ${-R} ${R * 2} ${R * 2}" aria-hidden="true">` +
      `<g class="cdc-radar__rings">${rings}</g>` +
      `<g class="cdc-radar__spokes">${spokes}</g>` +
      `<polygon class="cdc-radar__area" points="${area}"/>` +
      `<g class="cdc-radar__dots">${dots}</g>` +
      `</svg>${labels}</div>`;
    host.appendChild(figure);
  };

  // Lichess's page modules read their JSON out of #page-init-data and then
  // remove it, so hold on to the node while the page is still parsing. Its text
  // is only complete at DOMContentLoaded, and a node kept this way still carries
  // its text after Lichess has taken it out of the document.
  const loading = document.readyState === 'loading';
  let initData = loading ? null : document.getElementById('page-init-data');

  const initObserver = new MutationObserver(() => {
    initData = document.getElementById('page-init-data');
    if (initData) initObserver.disconnect();
  });

  const readRadar = () => {
    try {
      return JSON.parse(initData.textContent).radar;
    } catch {
      return null; // Not the shape we expect: leave Lichess's chart alone.
    }
  };

  const draw = () => {
    initObserver.disconnect();
    const host = document.querySelector('.puzzle-dashboard__global');
    const radar = host && initData && !host.querySelector('.cdc-radar') ? readRadar() : null;
    // Every other page has its own (sometimes big) init data; stop holding it.
    initData = null;
    const data = radar?.datasets?.[0]?.data;
    // A radar needs at least a triangle, and every point must be a number.
    if (!Array.isArray(data) || data.length < 3 || data.length !== radar.labels?.length) return;
    if (!data.every(v => Number.isFinite(Number(v)))) return;
    render(host, radar);
  };

  if (loading) {
    initObserver.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', draw);
  } else draw();
})();
