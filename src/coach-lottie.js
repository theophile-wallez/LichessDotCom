// The Game Review coach's faces as Lottie animations, built from the
// features tools/coach-rig/extract.py traced out of each portrait
// (img/coaches/rig.json) and played over its plate (the portrait with its
// brows and mouth painted out). At rest every feature is the portrait's own,
// so the neutral face is the portrait itself. Three animations per coach:
//
// - face: the brows and the mouth. Every mood's pose, and a transition from
//   each mood to each other one, laid out as one Eulerian circuit so that
//   each transition is the segment between two poses; then a talking loop
//   per mood.
// - lids: where the upper lids rest in each mood, in the same circuit.
// - blink: a shut lid dropping over each eye now and then, on its own loop,
//   so the coach blinks whatever it's doing.
//
// Pure: `cdcCoachLottie(rig, n)` returns the animations and the frames
// coach.js needs to drive them.
(() => {
  const FPS = 60;
  const W = 300;
  const H = 275;
  const MOODS = ['neutral', 'happy', 'delight', 'doubt', 'worry', 'shock'];

  // ------------------------------------------------------------ poses ---

  // The mouth, in the portrait's pixels: w its width, lift both corners
  // (negative is up), liftL / liftR one of them, sx a shift sideways, bend
  // the whole mouth (positive dips the middle, as in a smile), close how
  // much of the painted opening shuts (0..1), open the jaw dropping, raise
  // the upper lip going up, round how round the opening gets (0 flat, 1 an
  // ellipse), teeth how far they show under the upper lip, tongue its
  // height, upT / lipT the lips' thickness.
  const REST_MOUTH = {
    w: 1, lift: 0, liftL: 0, liftR: 0, sx: 0, bend: 0, close: 0, open: 0, raise: 0,
    round: 0, teeth: null, tongue: 0, upT: 1, lipT: 1,
  };
  const MOUTH = {
    neutral: {},
    happy: { w: 1.05, lift: -1.3, bend: 0.4, open: 0.8 },
    delight: { w: 1.1, lift: -2.2, bend: 0.6, open: 5, raise: 0.8, round: 0.25, tongue: 2, lipT: 0.85 },
    doubt: { w: 0.84, close: 1, liftL: -2, liftR: 1, sx: 1.6, lipT: 1.05 },
    worry: { w: 0.86, close: 0.8, lift: 3.4, bend: -2.2, lipT: 1.1 },
    shock: { w: 0.5, lift: 0.6, open: 9, raise: 1.6, round: 1, teeth: 1.3, tongue: 2, upT: 0.8, lipT: 0.8 },
  };
  // The brows, the portrait's own (sprites): dy up / down, tilt the inner
  // end up (degrees). Per side: the portrait's left, then its right.
  const BROW = {
    neutral: [{}, {}],
    happy: [{ dy: -1.3 }, { dy: -1.3 }],
    delight: [{ dy: -3.2, tilt: 2 }, { dy: -3.2, tilt: 2 }],
    doubt: [{ dy: -3.8, tilt: -5 }, { dy: 1.3, tilt: -8 }],
    worry: [{ dy: -1.2, tilt: 12 }, { dy: -1.2, tilt: 12 }],
    shock: [{ dy: -4.4, tilt: 4 }, { dy: -4.4, tilt: 4 }],
  };
  // The upper lids: how closed each one rests (0 open, 1 shut).
  const LIDS = {
    neutral: [0, 0], happy: [0.1, 0.1], delight: [0.38, 0.38], doubt: [0, 0.42],
    worry: [0.24, 0.24], shock: [0, 0],
  };
  // Colours no portrait shows: the inside of a mouth, the tongue, teeth for
  // the coaches who don't show theirs, a shut eye's lash line. Coach 2's
  // lids are set by hand: her glasses sit where they'd be sampled.
  const INSIDE = '#5b1f22';
  const TONGUE = '#d9716f';
  const TEETH = '#fdf6f1';
  const LASH = '#3a2019';
  const LASH_W = 1.1;
  const LID_SKIN = { 2: ['#f9b393', '#fcbb95'] };
  // How far a talking mouth opens, per mood: a grin or an "O" is open already.
  const TALK = { delight: 0.6, shock: 0.45 };
  // The little dark hooks at the corners of a smile (coaches 1 and 3): how
  // far they reach in along the lips and out past the corner, how far they
  // curl up, their width and colour.
  const CURLS = {
    1: { inner: 2.2, outer: 0.8, rise: 0.6, w: 0.8, color: '#8b492b' },
    3: { inner: 3, outer: 1.5, rise: 1.2, w: 0.9, color: '#8d3c23' },
  };
  const SMILES = new Set(['neutral', 'happy', 'delight']);

  const STEP_FACE = 24; // frames for a face transition
  const STEP_LIDS = 18; // ... for the lids
  // A talking loop: syllables as [frames, how wide the mouth opens], each
  // one back to the pose at its end, so talking can stop after any of them.
  const SYLLABLES = [[10, 0.7], [12, 1], [9, 0.4], [14, 1.2], [11, 0.6], [15, 0.9]];
  const MOUTH_POINTS = 11; // per lip curve, corner to corner
  // The blinks: an 11 s loop, at uneven times, one of them double.
  const BLINK_LOOP = 660;
  const BLINKS = [[84, 1], [310, 2], [520, 1]];

  // --------------------------------------------------------- geometry ---

  const lerp = (a, b, t) => a + (b - a) * t;
  const rgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16) / 255);
  const r1 = v => Math.round(v * 10) / 10;

  // Catmull-Rom tangents through `pts`: smooth all round when closed; an
  // open curve keeps sharp ends.
  function spline(pts, closed) {
    const n = pts.length;
    const ins = [];
    const outs = [];
    for (let k = 0; k < n; k++) {
      const a = closed ? pts[(k - 1 + n) % n] : pts[Math.max(k - 1, 0)];
      const b = closed ? pts[(k + 1) % n] : pts[Math.min(k + 1, n - 1)];
      let tx = (b[0] - a[0]) / 6;
      let ty = (b[1] - a[1]) / 6;
      if (!closed && (k === 0 || k === n - 1)) tx = ty = 0;
      ins.push([-tx, -ty]);
      outs.push([tx, ty]);
    }
    return [ins, outs];
  }

  const shape = (v, i, o, c) => {
    const r = ps => ps.map(([x, y]) => [r1(x), r1(y)]);
    return { i: r(i), o: r(o), v: r(v), c };
  };

  // A closed shape from a top curve (left to right) and a bottom one sharing
  // its ends (the corners): each curve smooth, the corners sharp.
  function outline(top, bottom) {
    const [ti, to] = spline(top, false);
    const bot = bottom.slice().reverse();
    const [bi, bo] = spline(bot, false);
    return shape(top.concat(bot.slice(1, -1)), ti.concat(bi.slice(1, -1)), to.concat(bo.slice(1, -1)), true);
  }

  const openPath = pts => {
    const [i, o] = spline(pts, false);
    return shape(pts, i, o, false);
  };

  // ---------------------------------------------- features in a pose ---

  function mouthShapes(m, n, pose) {
    const p = { ...REST_MOUTH, ...pose };
    const span = m.curves.up.length - 1;
    const at = (v, f) => {
      const j = Math.min(Math.floor(f), v.length - 2);
      return lerp(v[j], v[j + 1], f - j);
    };
    const c = {};
    for (const [k, v] of Object.entries(m.curves))
      c[k] = Array.from({ length: MOUTH_POINTS }, (_, q) => at(v, (span * q) / (MOUTH_POINTS - 1)));
    const [xl, xr] = m.x;
    const [yl, yr] = m.y;
    const N = MOUTH_POINTS;
    const cx = (xl + xr) / 2;
    // Teeth: as painted on a coach who shows them, else only once the mouth
    // opens.
    const teeth =
      p.teeth ?? (m.colors.teeth ? Math.max(...c.ob.map((b, k) => b - c.ot[k])) + 2 : 2.4 * Math.min(1, (p.open + p.raise) / 3));
    const cur = { up: [], ot: [], ob: [], lo: [], tb: [], tt: [] };
    const xs = [];
    for (let k = 0; k < N; k++) {
      const f = k / (N - 1);
      const u = -1 + 2 * f;
      const chord = lerp(yl, yr, f);
      const mid = 1 - u * u;
      const base = chord + (p.lift + (u < 0 ? p.liftL : p.liftR)) * u * u + p.bend * mid;
      // the jaw: flat-ish for a talking mouth, an ellipse for an "O"
      const jaw = mid ** lerp(0.9, 0.5, p.round);
      const dUp = c.up[k] - chord;
      const dOt = c.ot[k] - chord;
      const dOb = c.ob[k] - chord;
      const dLo = c.lo[k] - chord;
      const ot = base + dOt - p.raise * jaw;
      const ob = ot + (dOb - dOt) * (1 - p.close) + p.open * jaw;
      xs.push(cx + (lerp(xl, xr, f) - cx) * p.w + p.sx * mid);
      cur.up.push(ot - (dOt - dUp) * p.upT);
      cur.ot.push(ot);
      cur.ob.push(ob);
      cur.lo.push(ob + (dLo - dOb) * p.lipT);
      // teeth hang from the upper lip and stop short of the corners, where
      // the portraits show the dark mouth line instead
      cur.tb.push(Math.min(ot + teeth * Math.max(0, 1 - (Math.abs(u) / 0.82) ** 4), ob));
      cur.tt.push(Math.max(ob - p.tongue * mid ** 0.7, ot));
    }
    const P = key => xs.map((x, k) => [x, cur[key][k]]);
    const out = {
      upper: outline(P('up'), P('ot')),
      lower: outline(P('ob'), P('lo')),
      inside: outline(P('ot'), P('ob')),
      teeth: outline(P('ot'), P('tb')),
      tongue: outline(P('tt'), P('ob')),
    };
    const curl = CURLS[n];
    if (curl)
      for (const [key, k, d] of [['curlL', 0, -1], ['curlR', N - 1, 1]]) {
        const x = xs[k];
        const y = cur.ot[k];
        // a corner pulled down flattens its hook
        const turn = p.lift + (d < 0 ? p.liftL : p.liftR);
        const rise = curl.rise * Math.max(0, Math.min(1.2, 1 - turn / 2));
        out[key] = openPath([[x - d * curl.inner * p.w, y + 0.5 + 0.2 * turn], [x, y], [x + d * curl.outer, y - rise]]);
      }
    return out;
  }

  // An upper lid `t` closed: from the top of the eye down to its edge. Shut,
  // the edge is one smooth arc from corner to corner, as deep as the eye and
  // a hair past its lower lash, so no white shows.
  function lidShapes(e, t) {
    const n = e.x.length;
    const k = Math.floor(n / 2);
    const sag = e.bottom[k] + 0.6 - lerp(e.top[0], e.top[n - 1], 0.5);
    const shut = e.x.map((x, q) => {
      const f = q / (n - 1);
      const u = 2 * f - 1;
      return Math.max(lerp(e.top[0], e.top[n - 1], f) + sag * (1 - u * u) ** 0.75, e.bottom[q] + 0.3);
    });
    const edge = e.x.map((x, q) => [x, lerp(e.top[q], shut[q], t)]);
    return [outline(e.x.map((x, q) => [x, e.top[q] - 0.3]), edge), openPath(edge)];
  }

  // ----------------------------------------------------------- Lottie ---

  const EASE = { o: { x: [0.42], y: [0] }, i: { x: [0.58], y: [1] } };
  const EASE_OUT = { o: { x: [0.2], y: [0.6] }, i: { x: [0.4], y: [1] } };

  // A property from [frame, value] keys, eased in and out; one key per frame.
  function track(keys, ease = EASE) {
    const byT = new Map();
    for (const [t, v] of keys) byT.set(Math.round(t * 100) / 100, v);
    const ks = [...byT].sort((a, b) => a[0] - b[0]);
    if (new Set(ks.map(([, v]) => JSON.stringify(v))).size === 1) return { a: 0, k: ks[0][1] };
    return {
      a: 1,
      k: ks.map(([t, v], n) => ({ t, s: Array.isArray(v) ? v : [v], ...(n < ks.length - 1 ? ease : {}) })),
    };
  }

  const still = k => ({ a: 0, k });
  const fill = color => ({ ty: 'fl', c: still([...rgb(color), 1]), o: still(100), r: 1 });
  const stroke = (color, w, o) => ({ ty: 'st', c: still([...rgb(color), 1]), o, w: still(w), lc: 2, lj: 2 });
  const gradient = (cols, stops, y0, y1) => ({
    ty: 'gf', o: still(100), r: 1, t: 1, s: still([150, y0]), e: still([150, y1]),
    g: { p: cols.length, k: still(cols.flatMap((h, q) => [stops[q], ...rgb(h)])) },
  });
  const TRANSFORM = { ty: 'tr', p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) };
  const STILL = { o: still(100), r: still(0), p: still([0, 0, 0]), a: still([0, 0, 0]), s: still([100, 100, 100]) };
  const group = items => ({ ty: 'gr', it: [...items, TRANSFORM] });

  const layer = (nm, ind, shapes, op, ks = STILL) => ({
    ddd: 0, ind, ty: 4, nm, sr: 1, ip: 0, op, st: 0, ks, shapes, ao: 0, bm: 0,
  });

  // A brow sprite (drawn at 2x), turning about its middle.
  function browLayer(nm, ind, b, refId, p, r, op) {
    const [cx, cy] = b.center;
    return {
      ddd: 0, ind, ty: 2, nm, refId, sr: 1, ip: 0, op, st: 0, ao: 0, bm: 0,
      ks: { o: still(100), r, p, a: still([(cx - b.x) * 2, (cy - b.y) * 2, 0]), s: still([50, 50, 100]) },
    };
  }

  // lottie-web rewrites the data it's given, so nothing may be shared
  // between (or within) animations: each gets its own copy.
  const animation = (nm, layers, op, assets = []) =>
    JSON.parse(JSON.stringify({ v: '5.12.0', fr: FPS, ip: 0, op, w: W, h: H, nm, ddd: 0, assets, layers }));

  // An Eulerian circuit of the complete directed graph on `nodes`: every
  // ordered pair once, starting and ending at the first node.
  function circuit(nodes) {
    const left = Object.fromEntries(nodes.map(a => [a, nodes.filter(b => b !== a)]));
    const stack = [nodes[0]];
    const path = [];
    while (stack.length) {
      const a = stack[stack.length - 1];
      if (left[a].length) stack.push(left[a].shift());
      else path.push(stack.pop());
    }
    return path.reverse();
  }

  // --------------------------------------------------- the animations ---

  function build(rig, n) {
    const { mouth: m, brows, eyes } = rig;
    const seq = circuit(MOODS);

    // -- face: brows and mouth
    const keys = {};
    const key = (k, t, v) => (keys[k] ||= []).push([t, v]);
    const line = rgb(m.colors.line || INSIDE);
    const deep = rgb(INSIDE);
    const face = (t, mood, extra = null, lift = 0, brows_ = true) => {
      const mp = { ...MOUTH[mood], ...extra };
      for (const [k, v] of Object.entries(mouthShapes(m, n, mp))) key(k, t, v);
      // a thin mouth line has the portrait's colour, an open mouth is dark
      const o = Math.min(1, ((mp.open || 0) + (mp.raise || 0)) / 3.5);
      key('insideC', t, [...line.map((a, q) => lerp(a, deep[q], o)), 1]);
      // the corners' hooks belong to a smile
      key('curlO', t, SMILES.has(mood) ? 100 : 0);
      if (!brows_) return;
      brows.forEach((b, side) => {
        const bp = BROW[mood][side];
        key(`brow${side}p`, t, [b.center[0], b.center[1] + (bp.dy || 0) + lift, 0]);
        // the inner end is towards the nose: up is anticlockwise on the left
        key(`brow${side}r`, t, side ? bp.tilt || 0 : -(bp.tilt || 0));
      });
    };
    const trans = {};
    const pose = {};
    seq.forEach((mood, k) => {
      const t = k * STEP_FACE;
      face(t, mood);
      pose[mood] ??= t;
      if (k) trans[`${seq[k - 1]}>${mood}`] = [t - STEP_FACE, t];
    });
    let t = seq.length * STEP_FACE;
    const talk = {};
    for (const mood of MOODS) {
      const start = t;
      const stops = [];
      const base = { ...REST_MOUTH, ...MOUTH[mood] };
      face(t, mood);
      for (const [frames, a] of SYLLABLES) {
        // a syllable: the jaw drops and the lips part (a shut mouth, doubt
        // or worry, parts less), then back to the pose. The brows lift on
        // the stressed ones only.
        const amp = a * (TALK[mood] ?? 1);
        const extra = {
          open: base.open + amp * 2.4, w: base.w * (1 - 0.04 * amp),
          close: base.close * (1 - 0.35 * amp), round: Math.min(1, base.round + 0.15),
        };
        const stress = amp >= 1;
        if (stress) face(t, mood);
        face(t + frames * 0.45, mood, extra, -0.7, stress);
        t += frames;
        face(t, mood, null, 0, stress);
        stops.push(t);
      }
      talk[mood] = [start, t, stops];
      t += 1;
    }
    const faceEnd = t + 1;
    const sh = k => ({ ty: 'sh', ks: track(keys[k]) });
    const lipShade = lip => {
      const k = Math.floor(m.curves.up.length / 2);
      const [y0, y1] = lip === 'upper' ? [m.curves.up[k], m.curves.ot[k]] : [m.curves.ob[k], m.curves.lo[k]];
      return gradient(m.shade[lip], lip === 'upper' ? [0.15, 0.5, 0.85] : [0.2, 0.4, 0.6, 0.8, 0.92], y0, y1);
    };
    const faceLayers = [
      browLayer('brow L', 1, brows[0], 'brow0', track(keys.brow0p), track(keys.brow0r), faceEnd),
      browLayer('brow R', 2, brows[1], 'brow1', track(keys.brow1p), track(keys.brow1r), faceEnd),
      layer('upper lip', 3, [group([sh('upper'), lipShade('upper')])], faceEnd),
      layer('lower lip', 4, [group([sh('lower'), lipShade('lower')])], faceEnd),
      layer('teeth', 5, [group([sh('teeth'), fill(m.colors.teeth || TEETH)])], faceEnd),
      layer('tongue', 6, [group([sh('tongue'), fill(TONGUE)])], faceEnd),
      layer('inside', 7, [group([sh('inside'), { ...fill(INSIDE), c: track(keys.insideC) }])], faceEnd),
    ];
    const curl = CURLS[n];
    if (curl)
      ['curlL', 'curlR'].forEach((k, q) =>
        faceLayers.splice(2, 0, layer(k, 8 + q, [group([sh(k), stroke(curl.color, curl.w, track(keys.curlO))])], faceEnd)),
      );

    // -- lids: where they rest in each mood, their outline morphed between
    // moods. A blunder is a double take, a mistake a slow blink.
    const lk = {};
    const lkey = (k, t, v) => (lk[k] ||= []).push([t, v]);
    const lids = (t, closed) =>
      eyes.forEach((e, side) => {
        const [lid, edge] = lidShapes(e, closed[side]);
        lkey(`lid${side}`, t, lid);
        lkey(`edge${side}`, t, edge);
        lkey(`lash${side}`, t, Math.min(1, closed[side] / 0.22) * 100);
      });
    const lidTrans = {};
    const lidPose = {};
    seq.forEach((mood, k) => {
      const t = k * STEP_LIDS;
      if (k) {
        lidTrans[`${seq[k - 1]}>${mood}`] = [t - STEP_LIDS, t];
        if (mood === 'shock') {
          lids(t - STEP_LIDS * 0.6, [1, 1]);
          lids(t - STEP_LIDS * 0.3, LIDS[mood]);
        } else if (mood === 'worry') lids(t - STEP_LIDS * 0.5, [0.9, 0.9]);
      }
      lids(t, LIDS[mood]);
      lidPose[mood] ??= t;
    });
    const lidsEnd = seq.length * STEP_LIDS + 1;

    // -- blink: a shut lid over each eye, dropping from the top of the eye
    // and back, fast enough that its squashed in-betweens don't show.
    const bk = [[0, [100, 0, 100]]];
    const bo = [[0, 0]];
    for (const [at, count] of BLINKS)
      for (let q = 0; q < count; q++) {
        const b = at + q * 20;
        bk.push([b, [100, 0, 100]], [b + 4, [100, 100, 100]], [b + 6, [100, 100, 100]], [b + 14, [100, 0, 100]]);
        // open, the lid is a line along the top of the eye: hide its lash
        bo.push([b, 0], [b + 2, 100], [b + 10, 100], [b + 14, 0]);
      }
    bk.push([BLINK_LOOP, [100, 0, 100]]);
    bo.push([BLINK_LOOP, 0]);

    const lidLayers = [];
    const blinkLayers = [];
    eyes.forEach((e, side) => {
      const top = Math.min(...e.top);
      const skin = LID_SKIN[n] || e.skin;
      const grad = gradient(skin, [0, 1], top, Math.max(...e.bottom));
      lidLayers.push(
        layer(`lid ${side}`, side + 1, [
          group([{ ty: 'sh', ks: track(lk[`edge${side}`], EASE_OUT) }, stroke(LASH, LASH_W, track(lk[`lash${side}`], EASE_OUT))]),
          group([{ ty: 'sh', ks: track(lk[`lid${side}`], EASE_OUT) }, grad]),
        ], lidsEnd),
      );
      const [lid, edge] = lidShapes(e, 1);
      const cx = e.x.reduce((a, b) => a + b) / e.x.length;
      blinkLayers.push(
        layer(`blink ${side}`, side + 1, [
          group([{ ty: 'sh', ks: still(edge) }, stroke(LASH, LASH_W, track(bo, EASE_OUT))]),
          group([{ ty: 'sh', ks: still(lid) }, grad]),
        ], BLINK_LOOP + 1, { ...STILL, p: still([cx, top, 0]), a: still([cx, top, 0]), s: track(bk, EASE_OUT) }),
      );
    });

    return {
      face: animation(`coach ${n} face`, faceLayers, faceEnd,
        brows.map((b, k) => ({ id: `brow${k}`, w: b.w * 2, h: b.h * 2, u: '', p: `data:image/png;base64,${b.png}`, e: 1 }))),
      lids: animation(`coach ${n} lids`, lidLayers, lidsEnd),
      blink: animation(`coach ${n} blink`, blinkLayers, BLINK_LOOP + 1),
      meta: { face: { pose, trans, talk }, lids: { pose: lidPose, trans: lidTrans }, blink: [0, BLINK_LOOP] },
    };
  }

  globalThis.cdcCoachLottie = build;
  globalThis.cdcCoachMoods = MOODS;
})();
