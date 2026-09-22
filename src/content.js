// Isolated-world content script.
// 1. Gets the Chess.com sounds from the background worker and forwards them to
//    the page-world script (page.js), which hooks Lichess's sound player.
// 2. Keeps a CSS variable in sync with the height of the game controls, which
//    the game layout grid needs (see styles/game.css).

(() => {
  const MSG_SOUNDS = 'cdc:sounds';
  const MSG_PAGE_READY = 'cdc:page-ready';

  let sounds = null;

  const postSounds = () => {
    if (sounds) window.postMessage({ type: MSG_SOUNDS, sounds }, location.origin);
  };

  window.addEventListener('message', e => {
    if (e.source === window && e.data?.type === MSG_PAGE_READY) postSounds();
  });

  chrome.runtime.sendMessage({ type: 'cdc:get-sounds' }, res => {
    if (chrome.runtime.lastError || !res?.sounds || !Object.keys(res.sounds).length) return;
    sounds = res.sounds;
    postSounds();
  });

  // The right-hand panel stacks moves / controls / chat in fixed grid rows, so
  // the controls row height has to be definite. Measure it and expose it.
  let lastHeight = -1;
  const syncControlsHeight = () => {
    const main = document.querySelector('main.round, main.analyse');
    if (!main) return;
    const controls = main.querySelector('.rcontrols, .analyse__controls');
    const height = controls ? Math.ceil(controls.getBoundingClientRect().height) : 0;
    if (height !== lastHeight) {
      lastHeight = height;
      main.style.setProperty('--cdc-controls-h', height + 'px');
    }
  };
  setInterval(syncControlsHeight, 250);
})();
