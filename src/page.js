// Page-world script: swaps Lichess's sounds for Chess.com's.
//
// Lichess exposes its sound player as `site.sound`. We register the Chess.com
// files (as blob: URLs, which Lichess's CSP allows) under our own names and wrap
// `move()` / `play()` so each event picks the matching Chess.com sound:
// move-self / move-opponent / capture / castle / promote / move-check, etc.
// Chess.com sounds Lichess has no event for (premove, illegal, game-start) are
// played from our own detection below.

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
  // Pieces as last seen before a move, to know what a promoted piece was.
  let lastPieces = null;
  // The server move Lichess last passed on with its SAN (see sound.move).
  let recentMove = null;
  // Plays one of our sounds once installed.
  let playCdcSound = null;

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
    const fallback = lichessName === 'capture' ? 'capture' : 'move-self';
    const state = readBoard(mainBoard());
    if (!state) return fallback;
    const { pieces, lastMove } = state;
    const before = lastPieces;
    lastPieces = pieces;
    // After a legal move only the side to move can be in check, so a king under
    // attack is enough: no need for the last move, which Lichess doesn't
    // highlight when "Highlight last move" is off.
    const inCheck = [...pieces].some(
      ([key, p]) => p.role === 'king' && isAttacked(pieces, key, p.color === 'white' ? 'black' : 'white'),
    );
    if (inCheck) return 'move-check';
    if (!lastMove.length) return fallback;

    // Drops only highlight one square.
    const [a, b = a] = lastMove;
    const dest = pieces.has(b) ? b : pieces.has(a) ? a : null;
    const orig = dest === a ? b : a;
    const mover = dest ? pieces.get(dest) : null;

    const [ax, ay] = toXY(a);
    const [bx, by] = toXY(b);
    // Castling is highlighted as king->g/c file or king->rook square.
    const castle =
      ay === by && Math.abs(ax - bx) >= 2 && (!mover || mover.role === 'king');

    if (castle) return 'castle';
    // Auto-queen swaps the pawn before we get to look, so also check what stood
    // on the origin square before the move.
    const was = before?.get(orig);
    const wasPawn =
      mover?.role === 'pawn' || (was?.role === 'pawn' && was.color === mover?.color);
    if (wasPawn && orig !== dest && /[18]$/.test(dest)) return 'promote';
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
        // handles. Lichess plays its own check / mate sound either just before
        // the move callback (opponent moves) or on the server echo of our own
        // move, so drop it.
        if (name === 'check' || name === 'checkmate') return Promise.resolve();
        const mapped = PLAY_MAP[name];
        if (mapped && available.has(mapped)) return playCdc(mapped, volume);
      }
      return origPlay(name, volume);
    };

    sound.move = o => {
      // The round page gets each server move with its SAN and passes it here
      // (filter 'music') just before chessground's deferred move callback plays
      // the board sound. Keep it: SAN says exactly what the move was.
      if (o?.filter === 'music' && o.san) {
        recentMove = { san: o.san, ply: o.ply, at: Date.now() };
      }
      if (o?.filter === 'music' || sound.theme === 'music') return origMove(o);
      const volume = o?.volume ?? 1;
      if (o?.san) return playMove(soundFromSan(o.san, o.ply), volume);
      // Board moves on the round page, and drops (no argument).
      if (!o?.name || o.name === 'move' || o.name === 'capture') {
        const recent = recentMove;
        recentMove = null;
        // Our own moves only reach the server (and come back) after this, so a
        // fresh SAN is the move being played now.
        if (recent && Date.now() - recent.at < 300) {
          return playMove(soundFromSan(recent.san, recent.ply), volume);
        }
        // The board redraws on the next frame; inspect it after that.
        lastMoveSoundAt = Date.now();
        requestAnimationFrame(() => playMove(soundFromBoard(o?.name), volume));
        return Promise.resolve();
      }
      return origMove(o);
    };

    playCdcSound = playCdc;
    playGameStart();
  }

  // ------------------------------------------------------------- attempts ---
  // Chess.com plays "premove" when a premove is queued and "illegal" when a
  // dropped piece is refused; chessground does neither. So watch the pointer:
  // after a click or drop that tries to move a piece elsewhere, either a move
  // sound played, a premove appeared, or the move was refused. A refused click
  // stays silent: it is how you deselect a piece.

  function squareAt(board, x, y) {
    const r = board.getBoundingClientRect();
    const fx = Math.floor(((x - r.left) / r.width) * 8);
    const fy = Math.floor(((y - r.top) / r.height) * 8);
    if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return null;
    return orientation() === 'white' ? toKey(fx, 7 - fy) : toKey(7 - fx, fy);
  }

  const premoveKeys = board =>
    [...board.querySelectorAll('square.current-premove')].map(sq => sq.cgKey).join();

  function watchAttempt(board, premovesBefore, isDrop) {
    const at = Date.now();
    // Chessground defers its move callback and redraws on the next frame.
    setTimeout(() => {
      if (!playCdcSound || lastMoveSoundAt >= at) return;
      const premoves = premoveKeys(board);
      if (premoves && premoves !== premovesBefore) playCdcSound('premove');
      else if (isDrop) playCdcSound('illegal');
    }, 80);
  }

  let down = null;

  window.addEventListener(
    'pointerdown',
    e => {
      down = null;
      const board = mainBoard()?.querySelector('cg-board');
      if (e.button !== 0 || !board?.contains(e.target)) return;
      const state = readBoard(mainBoard());
      const key = squareAt(board, e.clientX, e.clientY);
      if (!state || !key) return;
      lastPieces = state.pieces;
      const premoves = premoveKeys(board);
      down = { board, key, premoves };

      // Click-to-move: a piece is selected and this click isn't just selecting
      // another piece of the same side.
      const selected = board.querySelector('square.selected')?.cgKey;
      const piece = selected && state.pieces.get(selected);
      if (piece && key !== selected && state.pieces.get(key)?.color !== piece.color) {
        watchAttempt(board, premoves, false);
      }
    },
    true,
  );

  // Runs before chessground's own handler, so the drag is still in progress.
  window.addEventListener(
    'pointerup',
    e => {
      const d = down;
      down = null;
      if (!d || e.button !== 0 || !d.board.querySelector('piece.dragging')) return;
      const key = squareAt(d.board, e.clientX, e.clientY);
      // Dropped back on its square or off the board: just a cancelled drag.
      if (key && key !== d.key) watchAttempt(d.board, d.premoves, true);
    },
    true,
  );

  // ----------------------------------------------------------- game start ---
  // Lichess has no game start sound. Its round data is inlined in the page as
  // JSON and removed once read, so hold on to the node while the page parses
  // (see dashboard.js). Its text is only complete at DOMContentLoaded: it ends
  // the page, so it can arrive cut at a network chunk, and nothing after it
  // would have us look again. Play "game-start" once per game when a player
  // opens a game that just began.

  let freshGameId = null;
  let initData = null;

  const initObserver = new MutationObserver(() => {
    initData = document.getElementById('page-init-data');
    if (initData) initObserver.disconnect();
  });

  function readFreshGame() {
    initObserver.disconnect();
    let data = null;
    try {
      data = initData ? JSON.parse(initData.textContent)?.data : null;
    } catch {}
    initData = null;
    const game = data?.game;
    const status = game?.status?.name;
    if (
      game?.id &&
      data.player &&
      !data.player.spectator &&
      (status === 'created' || status === 'started') &&
      (game.turns ?? 0) <= 1
    ) {
      freshGameId = game.id;
      playGameStart();
    }
  }

  // Runs once both the game is read and our sounds are in, whichever is last.
  function playGameStart() {
    if (!freshGameId || !playCdcSound) return;
    const key = 'cdc-started:' + freshGameId;
    freshGameId = null;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    playCdcSound('game-start');
  }

  if (document.readyState === 'loading') {
    initObserver.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', readFreshGame);
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
