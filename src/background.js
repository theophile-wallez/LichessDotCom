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
