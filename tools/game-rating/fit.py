"""Step 2 of the Game Review's game rating calibration: fits, on extract.py's
output, how often a player of each rating loses how much win% on a move,
and writes it into src/review.js (its RATING_MODEL line).

Needs numpy and scipy:
    python3 tools/game-rating/fit.py moves.jsonl

The model, per speed: a move falls in one of review.js's loss bands (best,
excellent, good, inaccuracy, mistake, blunder), with odds that depend on the
player's rating, the phase the move was played in (opening, tactics,
strategy, endgame) and whether the mover was lost, level or winning (in a
won position even a big blunder costs little win%). A game's moves make a
likelihood over the level a game was played at, and the level is drawn
around the player's rating, with a width (tau) fitted on held-out games:
the posterior's mean is the game rating. Without a rating (an anonymous
player), the population is the prior.
"""
import json, math, os, re, sys
from collections import defaultdict
import numpy as np
from scipy.optimize import minimize

SPEEDS = ['bullet', 'blitz', 'rapid', 'classical']
SPEED_OF = {'ultraBullet': 'bullet', 'bullet': 'bullet', 'blitz': 'blitz', 'rapid': 'rapid',
            'classical': 'classical', 'correspondence': 'classical'}
PHASES = 'otse'  # opening, tactics, strategy, endgame
BANDS = [0.5, 2, 5, 10, 20]  # review.js's loss thresholds
LO, HI = -1.6, 2.2  # the quadratic's range in x = (R - 1500) / 500, linear beyond
GRID = np.arange(100, 3201, 10)


def band(loss):
    return next((i for i, t in enumerate(BANDS) if loss < t), len(BANDS))


def bucket(before):
    return 0 if before < 20 else 2 if before > 80 else 1


def ctx(phase, before):
    return PHASES.index(phase) * 3 + bucket(before)


def feats(x):
    x = np.asarray(x, dtype=float)
    q = np.where(x < LO, LO * LO + 2 * LO * (x - LO), np.where(x > HI, HI * HI + 2 * HI * (x - HI), x * x))
    return np.stack([np.ones_like(x), x, q], axis=-1)


def fit_context(counts):
    """counts: {rating: [n per band]} -> theta (5 x 3), band 0 the reference."""
    rs = np.array(sorted(counts))
    n = np.array([counts[r] for r in rs], dtype=float)
    f = feats((rs - 1500) / 500)

    def nll(t):
        t = t.reshape(5, 3)
        logits = np.concatenate([np.zeros((len(rs), 1)), f @ t.T], axis=1)
        m = logits.max(axis=1, keepdims=True)
        logp = logits - m - np.log(np.exp(logits - m).sum(axis=1, keepdims=True))
        p = np.exp(logp)
        g = ((p[:, 1:] * n.sum(axis=1, keepdims=True) - n[:, 1:]).T @ f)
        return -(n * logp).sum() + 0.5 * (t ** 2).sum(), (g + t).ravel()

    return minimize(nll, np.zeros(15), jac=True, method='L-BFGS-B').x.reshape(5, 3)


def log_probs(theta):
    """theta: (12, 5, 3) -> log p over GRID: (12, len(GRID), 6)."""
    f = feats((GRID - 1500) / 500)
    logits = np.concatenate([np.zeros((12, len(GRID), 1)), np.einsum('gf,ckf->cgk', f, theta)], axis=2)
    m = logits.max(axis=2, keepdims=True)
    return logits - m - np.log(np.exp(logits - m).sum(axis=2, keepdims=True))


def game_ll(lp, moves, phases=PHASES):
    ll = np.zeros(len(GRID))
    for loss, before, phase in moves:
        if phase in phases:
            ll += lp[ctx(phase, before), :, band(loss)]
    return ll


def estimate(ll, mu, sd):
    post = ll - 0.5 * ((GRID - mu) / sd) ** 2
    w = np.exp(post - post.max())
    return (w * GRID).sum() / w.sum()


def main(path):
    recs = defaultdict(list)
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            s = SPEED_OF.get(r['s'])
            if s and sum(1 for m in r['m'] if m[2] != 'k') >= 5:
                recs[s].append(r)
    rng = np.random.default_rng(1)
    model, report = {}, []
    for s in SPEEDS:
        rows = recs[s]
        rng.shuffle(rows)
        test, train = rows[: len(rows) // 5], rows[len(rows) // 5:]
        counts = [defaultdict(lambda: [0] * 6) for _ in range(12)]
        for r in train:
            rb = int(round(r['r'] / 50) * 50)
            for loss, before, phase in r['m']:
                if phase != 'k':
                    counts[ctx(phase, before)][rb][band(loss)] += 1
        theta = np.array([fit_context(c) for c in counts])
        lp = log_probs(theta)
        ratings = np.array([r['r'] for r in train])
        mu, sd = ratings.mean(), ratings.std()
        # TAU: how far one game's level strays from the player's rating,
        # the width that best explains the held-out games' moves: the level
        # is drawn around the rating, then the moves around the level.
        lls = [game_ll(lp, r['m']) for r in test]
        rt = np.array([r['r'] for r in test])
        best = None
        for tau in range(50, 1001, 25):
            prior = -0.5 * ((GRID[None, :] - rt[:, None]) / tau) ** 2
            prior -= np.log(np.exp(prior).sum(axis=1, keepdims=True))
            total = sum(np.logaddexp.reduce(ll + pr) for ll, pr in zip(lls, prior))
            if best is None or total > best[1]:
                best = (tau, total)
        tau = best[0]
        # With the player's own rating as the prior: the spread of estimates,
        # and each phase's pull on it, whose quantiles set the phase verdicts.
        diffs = np.array([estimate(ll, r['r'], tau) - r['r'] for ll, r in zip(lls, test)])
        pd = {p: [] for p in PHASES}
        for r in test:
            for p in PHASES:
                if any(m[2] == p for m in r['m']):
                    pd[p].append(estimate(game_ll(lp, r['m'], p), r['r'], tau) - r['r'])
        # Without a rating, the population is the prior: how well the
        # estimate then tells the players' ratings.
        e0 = np.array([estimate(ll, mu, math.hypot(sd, tau)) for ll in lls])
        model[s] = dict(theta=theta, tau=tau, mu=mu, sd=sd, pd=pd)
        report.append(f'{s}: {len(rows)} player-games, tau {tau}, unrated r {np.corrcoef(e0, rt)[0, 1]:.2f}, '
                      f'estimate - rating: sd {diffs.std():.0f}, 5-95% {np.percentile(diffs, 5):.0f} .. {np.percentile(diffs, 95):.0f}')
    # The phase verdicts, from best to blunder: shares of all phases played.
    shares = np.cumsum([0.10, 0.20, 0.35, 0.20, 0.10])
    cuts = {}
    for p in PHASES:
        allp = np.concatenate([model[s]['pd'][p] for s in SPEEDS])
        cuts[p] = [round(float(np.percentile(allp, 100 * (1 - q)))) for q in shares]
    print('\n'.join('// ' + line for line in report), file=sys.stderr)
    r3 = lambda a: [round(float(v), 3) for v in a]
    out = {
        'pop': {s: [round(model[s]['mu']), round(model[s]['sd'])] for s in SPEEDS},
        'tau': {s: model[s]['tau'] for s in SPEEDS},
        'cuts': cuts,
        'theta': {s: [[r3(k) for k in c] for c in model[s]['theta']] for s in SPEEDS},
    }
    path = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'review.js')
    with open(path) as f:
        src = f.read()
    line = '  const RATING_MODEL = ' + json.dumps(out, separators=(',', ':')) + ';'
    src, n = re.subn(r'^  const RATING_MODEL = .*;$', lambda _: line, src, count=1, flags=re.M)
    assert n == 1, 'no RATING_MODEL line in review.js'
    with open(path, 'w') as f:
        f.write(src)


if __name__ == '__main__':
    main(sys.argv[1])
