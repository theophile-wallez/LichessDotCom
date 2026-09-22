// Fetches the Chess.com sound files once, caches them as base64 in
// chrome.storage.local, and hands them to content scripts on request.
// Lichess's CSP only allows audio from its own domains, blob: and data:, so
// the page can't load these URLs directly. The extension worker can.

const SOUND_BASE = 'https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default/';
const SOUND_NAMES = [
  'move-self',
  'move-opponent',
  'move-check',
  'capture',
  'castle',
  'promote',
  'premove',
  'illegal',
  'notify',
  'tenseconds',
  'game-start',
  'game-end',
];
const CACHE_KEY = 'sounds:v1';

let pending = null;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function fetchSound(name) {
  const res = await fetch(SOUND_BASE + name + '.mp3', { credentials: 'omit' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return toBase64(await res.arrayBuffer());
}

async function loadSounds() {
  const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY];
  if (cached && Object.keys(cached).length) return cached;

  const sounds = {};
  await Promise.all(
    SOUND_NAMES.map(async name => {
      try {
        sounds[name] = await fetchSound(name);
      } catch (err) {
        console.warn('[LichessDotCom] could not fetch sound', err);
      }
    }),
  );
  // Only cache a complete set, so a transient failure is retried next time.
  if (Object.keys(sounds).length === SOUND_NAMES.length) {
    await chrome.storage.local.set({ [CACHE_KEY]: sounds });
  }
  return sounds;
}

function getSounds() {
  pending ??= loadSounds().finally(() => (pending = null));
  return pending;
}

chrome.runtime.onInstalled.addListener(() => {
  getSounds();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'cdc:get-sounds') return false;
  getSounds().then(
    sounds => sendResponse({ sounds }),
    () => sendResponse({ sounds: {} }),
  );
  return true;
});

/* ---- dev auto-reload --- */
// Unpacked only (store installs have an update_url). Shipping pulls main into
// the folder Chrome loads, so when a Lichess tab asks, compare the files on
// disk with the ones loaded and reload the extension if they changed.
const DEV = !('update_url' in chrome.runtime.getManifest());
const LOADED_KEY = 'dev:loaded';
let reloading = false;

async function fingerprint() {
  const { background, content_scripts } = chrome.runtime.getManifest();
  const files = [
    'manifest.json',
    background.service_worker,
    ...content_scripts.flatMap(s => [...(s.css || []), ...(s.js || [])]),
  ];
  const texts = await Promise.all(
    files.map(f =>
      fetch(chrome.runtime.getURL(f), { cache: 'no-store' }).then(
        r => r.text(),
        () => '',
      ),
    ),
  );
  const hash = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(texts.join('\0')));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

// Session storage is cleared on every extension reload, so it holds the
// fingerprint of the code that is actually running, across worker restarts.
async function loadedFingerprint() {
  const stored = (await chrome.storage.session.get(LOADED_KEY))[LOADED_KEY];
  if (stored) return stored;
  const current = await fingerprint();
  await chrome.storage.session.set({ [LOADED_KEY]: current });
  return current;
}

if (DEV) {
  chrome.runtime.onInstalled.addListener(loadedFingerprint);
  chrome.runtime.onStartup.addListener(loadedFingerprint);
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'cdc:dev-check') return false;
    Promise.all([loadedFingerprint(), fingerprint()]).then(([loaded, current]) => {
      const stale = reloading || loaded !== current;
      sendResponse({ reload: stale });
      if (stale && !reloading) {
        reloading = true;
        setTimeout(() => chrome.runtime.reload(), 50);
      }
    });
    return true;
  });
}
