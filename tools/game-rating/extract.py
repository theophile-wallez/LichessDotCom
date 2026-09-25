"""Step 1 of the Game Review's game rating calibration: every player-game of
a Lichess database slice, as its moves' accuracies, phases and ratings.

Needs python-chess. Feed it a slice of a monthly dump of rated games
(https://database.lichess.org); only the games with Stockfish evals (~10%)
are kept. 700 MB of a month is about 230k of them:
    curl -r 0-700000000 https://database.lichess.org/standard/lichess_db_standard_rated_2026-08.pgn.zst \
      | zstdcat | python3 tools/game-rating/extract.py - openings/ > moves.jsonl
(zstdcat complains that the slice ends mid-frame: expected.) openings/
holds lichess-org/chess-openings' a.tsv … e.tsv, for the book moves. Then
fit.py turns moves.jsonl into the tables in review.js.

Each move is judged as src/review.js does (the same win% curve, the win%
it lost, book moves by Lichess's opening names), and put in the same phase: the
phase of the position it was played from, by Lichess's own divider
(scalachess Divider.scala), a middlegame move being "tactics" when the
position had a tactic in it (see `tactical`). The two must stay in step.
"""
import io, json, math, multiprocessing, os, sys
import chess, chess.pgn

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}


def win_pct(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


# ---- Lichess's divider (scalachess Divider.scala) ----

def majors_and_minors(b):
    return chess.popcount(b.occupied & ~(b.kings | b.pawns))


def backrank_sparse(b):
    return chess.popcount(chess.BB_RANK_1 & b.occupied_co[chess.WHITE]) < 4 or \
        chess.popcount(chess.BB_RANK_8 & b.occupied_co[chess.BLACK]) < 4


def score(y, w, k):
    if w == 0:
        return {1: 1 + y, 2: 2 + (6 - y) if y < 6 else 0, 3: 3 + (7 - y) if y < 7 else 0,
                4: 3 + (7 - y) if y < 7 else 0}.get(k, 0)
    if w == 1:
        return {0: 1 + (8 - y), 1: 5 + abs(4 - y), 2: 4 + (7 - y), 3: 5 + (7 - y)}.get(k, 0)
    if w == 2:
        return {0: 2 + (y - 2) if y > 2 else 0, 1: 4 + (y - 1), 2: 7}.get(k, 0)
    if w == 3:
        return {0: 3 + (y - 1) if y > 1 else 0, 1: 5 + (y - 1)}.get(k, 0)
    if w == 4:
        return 3 + (y - 1) if k == 0 and y > 1 else 0
    return 0


REGIONS = [0x0303 << (x + 8 * y) for y in range(7) for x in range(7)]


def mixedness(b):
    white, black = b.occupied_co[chess.WHITE], b.occupied_co[chess.BLACK]
    return sum(score(i // 7 + 1, chess.popcount(white & r), chess.popcount(black & r)) for i, r in enumerate(REGIONS))


def division(boards):
    middle = next((i for i, b in enumerate(boards)
                   if majors_and_minors(b) <= 10 or backrank_sparse(b) or mixedness(b) > 150), None)
    end = next((i for i, b in enumerate(boards) if majors_and_minors(b) <= 6), None) if middle is not None else None
    if middle is not None and end is not None and middle >= end:
        middle = None
    return middle, end


# ---- tactics ----

def hanging(b):
    """A piece (not a pawn or the king) either side could win: attacked, and
    undefended or attacked by something cheaper. Pins are ignored, as in
    review.js's `attackers`."""
    for sq, p in b.piece_map(mask=b.knights | b.bishops | b.rooks | b.queens).items():
        hits = [VALUES[b.piece_type_at(s)] for s in b.attackers(not p.color, sq)]
        if not hits:
            continue
        if min(hits) < VALUES[p.piece_type] or not b.attackers(p.color, sq):
            return True
    return False


def tactical(b, prev_loss):
    """A position with a tactic in it: the side to move is in check, the
    opponent's last move threw away 10% or more (a chance to punish it), or
    a piece hangs."""
    return b.is_check() or prev_loss >= 10 or hanging(b)


# ---- games ----

def load_openings(folder):
    epds = set()
    for name in 'abcde':
        with open(os.path.join(folder, f'{name}.tsv')) as f:
            next(f)
            for line in f:
                pgn = line.rstrip('\n').split('\t')[2]
                b = chess.Board()
                for tok in pgn.split():
                    if not tok[0].isdigit():
                        b.push_san(tok)
                epds.add(b.epd())
    return epds


def speed(tc):
    if tc == '-':
        return 'correspondence'
    base, inc = (int(x) for x in tc.split('+'))
    t = base + 40 * inc
    return 'ultraBullet' if t < 30 else 'bullet' if t < 180 else 'blitz' if t < 480 else 'rapid' if t < 1500 else 'classical'


OPENINGS = None


def init(folder):
    global OPENINGS
    OPENINGS = load_openings(folder)


def game_records(text):
    if '%eval' not in text:
        return []
    g = chess.pgn.read_game(io.StringIO(text))
    if g is None or g.headers.get('Variant', 'Standard') != 'Standard' or 'FEN' in g.headers:
        return []
    h = g.headers
    try:
        elo = {'w': int(h['WhiteElo']), 'b': int(h['BlackElo'])}
    except (KeyError, ValueError):
        return []
    b = g.board()
    boards, wps = [b.copy(stack=False)], [win_pct(18)]
    for node in g.mainline():
        b.push(node.move)
        boards.append(b.copy(stack=False))
        e = node.eval()
        if e is None:
            if b.is_checkmate():
                wps.append(0 if b.turn == chess.WHITE else 100)
            else:
                break
        else:
            w = e.white()
            wps.append((100 if w.mate() > 0 else 0) if w.is_mate() else win_pct(w.score()))
    n = len(wps) - 1
    if n < 10:
        return []
    boards = boards[:n + 1]
    book = 0
    for i in range(1, min(n, 40) + 1):
        if chess.popcount(boards[i - 1].occupied) < 20:
            break
        if boards[i].epd() in OPENINGS:
            book = i
    middle, end = division(boards)
    moves = {'w': [], 'b': []}
    prev_loss = 0
    for ply in range(1, n + 1):
        color = 'w' if ply % 2 == 1 else 'b'
        before, after = wps[ply - 1], wps[ply]
        if color == 'b':
            before, after = 100 - before, 100 - after
        loss = max(0, before - after)
        is_book = ply <= book
        pos = ply - 1
        if end is not None and pos >= end:
            phase = 'e'
        elif middle is None or pos < middle:
            phase = 'o'
        else:
            phase = 't' if tactical(boards[pos], 0 if is_book else prev_loss) else 's'
        # [win% lost, the mover's win% before, phase]; book moves are phase "k".
        moves[color].append([round(loss, 2), round(before, 1), 'k' if is_book else phase])
        prev_loss = 0 if is_book else loss
    res = h.get('Result')
    score_w = {'1-0': 1, '0-1': 0, '1/2-1/2': 0.5}.get(res)
    out = []
    for c, o in (('w', 'b'), ('b', 'w')):
        out.append({'s': speed(h.get('TimeControl', '-')), 'r': elo[c], 'ro': elo[o],
                    'res': None if score_w is None else (score_w if c == 'w' else 1 - score_w),
                    'm': moves[c], 'mo': moves[o], 'id': h.get('Site', '')[-8:], 'c': c})
    return out


def games(path):
    buf = []
    with sys.stdin if path == '-' else open(path) as f:
        for line in f:
            if line.startswith('[Event ') and buf:
                yield ''.join(buf)
                buf = []
            buf.append(line)
    if buf:
        yield ''.join(buf)


if __name__ == '__main__':
    pgn, folder = sys.argv[1], sys.argv[2]
    with multiprocessing.Pool(initializer=init, initargs=(folder,)) as pool:
        for recs in pool.imap_unordered(game_records, games(pgn), chunksize=200):
            for r in recs:
                sys.stdout.write(json.dumps(r, separators=(',', ':')) + '\n')
