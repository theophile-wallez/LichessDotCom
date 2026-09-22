// Page-world script: swaps Lichess's sounds for Chess.com's.
//
// Lichess exposes its sound player as `site.sound`. We register the Chess.com
// files (as blob: URLs, which Lichess's CSP allows) under our own names and wrap
// `move()` / `play()` so each event picks the matching Chess.com sound:
// move-self / move-opponent / capture / castle / promote / move-check, etc.

(() => {
  const MSG_SOUNDS = 'cdc:sounds';
  const MSG_PAGE_READY = 'cdc:page-ready';
  const PREFIX = 'cdc-';

  // Lichess sound name -> Chess.com sound name.
  const PLAY_MAP = {
    move: 'move-self',
    capture: 'capture',
    genericNotify: 'game-start',
    victory: 'game-end',
    defeat: 'game-end',
    draw: 'game-end',
    lowTime: 'tenseconds',
    error: 'illegal',
    confirmation: 'notify',
    newChallenge: 'notify',
    newPM: 'notify',
    socialNotify: 'notify',
  };

  const available = new Set();
  let lastMoveSoundAt = 0;

  // ---------------------------------------------------------------- board ---

  const FILES = 'abcdefgh';

  const mainBoard = () =>
    document.querySelector('.main-board .cg-wrap') || document.querySelector('.cg-wrap');

  const orientation = () =>
    mainBoard()?.classList.contains('orientation-black') ? 'black' : 'white';

  function readBoard(wrap) {
    const board = wrap?.querySelector('cg-board');
    if (!board) return null;
    const pieces = new Map();
    for (const el of board.children) {
      if (el.tagName !== 'PIECE' || !el.cgKey) continue;
      if (el.classList.contains('ghost') || el.classList.contains('fading')) continue;
      const cls = el.classList;
      const color = cls.contains('white') ? 'white' : cls.contains('black') ? 'black' : null;
      const role = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'].find(r => cls.contains(r));
      if (color && role) pieces.set(el.cgKey, { color, role });
    }
    const lastMove = [...board.querySelectorAll('square.last-move')]
      .map(sq => sq.cgKey)
      .filter(Boolean);
    return { pieces, lastMove };
  }

  const toXY = key => [FILES.indexOf(key[0]), parseInt(key.slice(1), 10) - 1];
  const toKey = (x, y) => (x >= 0 && x < 8 && y >= 0 && y < 8 ? FILES[x] + (y + 1) : null);

  function isAttacked(pieces, target, by) {
    const [tx, ty] = toXY(target);
    const at = (x, y) => {
      const k = toKey(x, y);
      return k ? pieces.get(k) : undefined;
    };
    const isBy = (p, ...roles) => p && p.color === by && roles.includes(p.role);

    const dir = by === 'white' ? -1 : 1;
    if (isBy(at(tx - 1, ty + dir), 'pawn') || isBy(at(tx + 1, ty + dir), 'pawn')) return true;

    const knight = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    if (knight.some(([dx, dy]) => isBy(at(tx + dx, ty + dy), 'knight'))) return true;

    const around = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    if (around.some(([dx, dy]) => isBy(at(tx + dx, ty + dy), 'king'))) return true;

    const slide = (dirs, roles) =>
      dirs.some(([dx, dy]) => {
        for (let x = tx + dx, y = ty + dy; toKey(x, y); x += dx, y += dy) {
          const p = at(x, y);
          if (p) return isBy(p, ...roles);
        }
        return false;
      });
    return (
      slide(around.slice(0, 4), ['rook', 'queen']) || slide(around.slice(4), ['bishop', 'queen'])
    );
  }

  // Works out the Chess.com sound for the move that was just played on the board.
  function soundFromBoard(lichessName) {
    const state = readBoard(mainBoard());
    if (!state || state.lastMove.length < 2) {
      return lichessName === 'capture' ? 'capture' : 'move-self';
    }
    const { pieces, lastMove } = state;
    const [a, b] = lastMove;
    const dest = pieces.has(b) ? b : pieces.has(a) ? a : null;
    const mover = dest ? pieces.get(dest) : null;

    const [ax, ay] = toXY(a);
    const [bx, by] = toXY(b);
    // Castling is highlighted as king->g/c file or king->rook square.
    const castle =
      ay === by && Math.abs(ax - bx) >= 2 && (!mover || mover.role === 'king');

    if (mover) {
      const enemy = mover.color === 'white' ? 'black' : 'white';
      const enemyKing = [...pieces].find(([, p]) => p.color === enemy && p.role === 'king');
      if (enemyKing && isAttacked(pieces, enemyKing[0], mover.color)) return 'move-check';
    }
    if (castle) return 'castle';
    if (mover?.role === 'pawn' && (dest.endsWith('8') || dest.endsWith('1'))) return 'promote';
    if (lichessName === 'capture') return 'capture';
    return !mover || mover.color === orientation() ? 'move-self' : 'move-opponent';
  }

  function soundFromSan(san, ply) {
    if (/[+#]/.test(san)) return 'move-check';
    if (san.startsWith('O-O')) return 'castle';
    if (san.includes('=')) return 'promote';
    if (san.includes('x')) return 'capture';
    if (typeof ply === 'number') {
      const mover = ply % 2 === 1 ? 'white' : 'black';
      return mover === orientation() ? 'move-self' : 'move-opponent';
    }
    return 'move-self';
  }

  // ---------------------------------------------------------------- hooks ---

  function install(sound, blobs) {
    for (const [name, url] of Object.entries(blobs)) {
      sound.paths.set(PREFIX + name, url);
      available.add(name);
    }
    if (sound.__cdcHooked) return;
    sound.__cdcHooked = true;

    const origPlay = sound.play.bind(sound);
    const origMove = sound.move.bind(sound);

    const playCdc = (name, volume) => {
      if (!available.has(name)) return undefined;
      return origPlay(PREFIX + name, volume);
    };
    const playMove = (name, volume) => {
      lastMoveSoundAt = Date.now();
      return playCdc(name, volume) ?? origPlay('move', volume);
    };

    sound.play = (name, volume = 1) => {
      if (typeof name === 'string' && !name.startsWith(PREFIX)) {
        // Chess.com plays a single "move-check" for checking moves, which move()
        // already handled. Drop Lichess's separate check / mate sound.
        if (name === 'check' || name === 'checkmate') {
          if (Date.now() - lastMoveSoundAt < 1500) return Promise.resolve();
          return playMove('move-check', volume);
        }
        const mapped = PLAY_MAP[name];
        if (mapped && available.has(mapped)) return playCdc(mapped, volume);
      }
      return origPlay(name, volume);
    };

    sound.move = o => {
      if (o?.filter === 'music' || sound.theme === 'music') return origMove(o);
      const volume = o?.volume ?? 1;
      if (o?.san) return playMove(soundFromSan(o.san, o.ply), volume);
      if (o?.name === 'move' || o?.name === 'capture') {
        // The board redraws on the next frame; inspect it after that.
        lastMoveSoundAt = Date.now();
        requestAnimationFrame(() => playMove(soundFromBoard(o.name), volume));
        return Promise.resolve();
      }
      if (o?.name) return origMove(o);
      return playMove('move-self', volume);
    };
  }

  function toBlobUrls(sounds) {
    const blobs = {};
    for (const [name, b64] of Object.entries(sounds)) {
      if (typeof b64 !== 'string') continue;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blobs[name] = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    }
    return blobs;
  }

  function whenSoundReady(cb) {
    const started = Date.now();
    const check = () => {
      const sound = window.site?.sound;
      if (sound?.paths instanceof Map && typeof sound.play === 'function') cb(sound);
      else if (Date.now() - started < 30000) setTimeout(check, 50);
    };
    check();
  }

  let installed = false;
  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.type !== MSG_SOUNDS || installed) return;
    installed = true;
    const blobs = toBlobUrls(e.data.sounds || {});
    whenSoundReady(sound => install(sound, blobs));
  });
  window.postMessage({ type: MSG_PAGE_READY }, location.origin);
})();
