// Isolated world: brings the Game Review coach to life. review.js (the page
// world) draws the coach's avatar and says, by postMessage, which coach it
// is, how it feels about the move (its mood) and whether it's talking (the
// comment typing out). This plays it: the coach's rig, built by
// coach-lottie.js from the features traced out of the portrait, as three
// Lottie animations over the portrait's plate. A new mood eases in from the
// last one, talking loops until the comment is typed, and the blinks run on
// their own. Isolated, because the rig's files are the extension's, which
// the page's CSP keeps out of the page world's reach.
(() => {
  const RIG = chrome.runtime.getURL('img/coaches/rig.json');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  let rigs = null; // the traced features, fetched once
  let rig = null; // the mounted rig: { el, coach, face, lids, blink, meta, ... }
  const want = { coach: 0, mood: 'neutral', talking: false };

  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.cdc !== 'coach') return;
    want.coach = e.data.coach;
    want.mood = cdcCoachMoods.includes(e.data.mood) ? e.data.mood : 'neutral';
    want.talking = !!e.data.talking;
    sync();
  });

  function sync() {
    const el = document.querySelector('.cdc-coach__avatar');
    if (!el || typeof lottie === 'undefined') return;
    if (!rig || rig.el !== el || rig.coach !== want.coach) mount(el, want.coach);
    else {
      if (rig.ready && rig.blink.isPaused && !calm.matches) rig.blink.play();
      step();
    }
  }

  async function mount(el, coach) {
    unmount();
    const r = (rig = { el, coach, ready: false, mood: want.mood, busy: false, talking: false });
    try {
      rigs ||= fetch(RIG).then(res => res.json());
      const data = cdcCoachLottie((await rigs)[coach], coach);
      if (rig !== r) return;
      const face = el.querySelector('.cdc-coach__face');
      const box = document.createElement('span');
      box.className = 'cdc-coach__rig';
      face.append(box);
      const play = key => {
        const layer = document.createElement('span');
        box.append(layer);
        return lottie.loadAnimation({
          container: layer, renderer: 'svg', loop: false, autoplay: false,
          animationData: data[key], rendererSettings: { preserveAspectRatio: 'xMidYMax meet' },
        });
      };
      Object.assign(r, { box, meta: data.meta, lids: play('lids'), blink: play('blink'), face: play('face') });
      // (lottie can be loaded before it's even returned)
      await Promise.all(['lids', 'blink', 'face'].map(k => new Promise(ok => (r[k].isLoaded ? ok() : r[k].addEventListener('DOMLoaded', ok)))));
      if (rig !== r) return;
      // The face's transitions are the longest: the lids' are over by then.
      r.face.addEventListener('complete', () => r.done?.());
      // Straight to the current mood: the plate comes in with the features
      // already on it, so the face never shows without them.
      r.face.goToAndStop(r.meta.face.pose[r.mood], true);
      r.lids.goToAndStop(r.meta.lids.pose[r.mood], true);
      r.blink.loop = true;
      if (calm.matches) r.blink.goToAndStop(0, true);
      else r.blink.goToAndPlay(Math.random() * r.meta.blink[1], true);
      // No one to blink for once the review panel is gone.
      r.blink.addEventListener('loopComplete', () => el.isConnected || r.blink.pause());
      el.classList.add('cdc-coach__avatar--rig');
      r.ready = true;
      step();
    } catch (err) {
      // Without its rig, the coach is just its portrait.
      console.warn('[cdc] coach rig', err);
      if (rig === r) unmount();
    }
  }

  function unmount() {
    if (!rig) return;
    for (const k of ['face', 'lids', 'blink']) rig[k]?.destroy();
    rig.box?.remove();
    rig.el.classList.remove('cdc-coach__avatar--rig');
    rig = null;
  }

  // To a pose. goToAndStop counts from the last segment played, so reset
  // to the whole animation first.
  const hold = (anim, frame) => {
    anim.resetSegments(true);
    anim.goToAndStop(frame, true);
  };

  // One move at a time: a transition, or a syllable, finishes before the
  // next thing starts, so the face never jumps.
  function step() {
    const r = rig;
    if (!r?.ready || r.busy) return;
    const { face, lids, meta } = r;
    if (calm.matches) {
      r.mood = want.mood;
      hold(face, meta.face.pose[r.mood]);
      hold(lids, meta.lids.pose[r.mood]);
      return;
    }
    if (r.talking && (want.mood !== r.mood || !want.talking)) return stopTalking(r);
    if (want.mood !== r.mood) {
      const to = want.mood;
      const edge = `${r.mood}>${to}`;
      r.busy = true;
      // lottie stops a frame short of a segment's end: land on the pose
      r.done = () => {
        r.done = null;
        r.busy = false;
        r.mood = to;
        hold(face, meta.face.pose[to]);
        hold(lids, meta.lids.pose[to]);
        step();
      };
      lids.playSegments(meta.lids.trans[edge], true);
      face.playSegments(meta.face.trans[edge], true);
      return;
    }
    if (want.talking && !r.talking) {
      const [a, b] = meta.face.talk[r.mood];
      r.talking = true;
      face.loop = true;
      face.playSegments([a, b], true);
    }
  }

  // Talking stops at the end of a syllable, where the mouth is back at rest.
  function stopTalking(r) {
    const { face, meta } = r;
    const [a, , stops] = meta.face.talk[r.mood];
    const now = a + face.currentFrame;
    const end = stops.find(s => s > now + 0.5) ?? stops[stops.length - 1];
    face.loop = false;
    r.busy = true;
    r.done = () => {
      r.done = null;
      r.busy = false;
      r.talking = false;
      hold(face, meta.face.pose[r.mood]);
      step();
    };
    face.playSegments([now, end], true);
  }

  calm.addEventListener('change', sync);
})();
