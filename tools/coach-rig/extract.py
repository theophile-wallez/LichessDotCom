"""Traces the Game Review coaches' features out of their portraits.

Run once per portrait change (needs numpy and opencv-python-headless):
    python3 tools/coach-rig/extract.py
It writes img/coaches/rig.json (the features: the brows as sprites, the
lips and lids as curves, in the portrait's pixels, and their colours) and
img/coaches/coach-<n>-plate.webp (the portrait with its brows and mouth
painted out, for the animated features to move over). src/coach-lottie.js
builds the Lottie animations from rig.json in the page.
"""
import base64, json, os
import cv2
import numpy as np

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
IMG = os.path.join(ROOT, 'img', 'coaches')
N = 17  # samples per mouth curve, corner to corner
E = 11  # samples per eye curve

# Measured by hand on each portrait (300×275). The mouth: its corners' x,
# the rows it spans, and reference colours for each part, from which every
# sub-pixel is classified: S skin, U upper lip (both lips on coaches 1 and 2,
# told apart by the teeth between them), D lower lip, T teeth, N the dark
# mouth line.
MOUTH = {
    1: dict(x=(124, 176), band=(149.5, 167), S=['#f7bc93', '#e5ae89', '#eeb48e'], U=['#e09274', '#e8957a'],
            T=['#fdf4f0', '#f4e2dc'], N=['#974f36', '#b86a52']),
    2: dict(x=(126, 173), band=(150, 172), S=['#fbcaa7'], U=['#cf7167', '#ec8b80', '#e8988c'],
            T=['#fdf7f6', '#f3e6e4']),
    3: dict(x=(125, 176), band=(157, 176), S=['#cd8159', '#bf704c', '#c7784f'], U=['#a04b3b', '#aa5242'],
            D=['#bb604e', '#d57763', '#c86b58']),
    4: dict(x=(131, 172), band=(157.5, 167.6), S=['#fdcba8', '#f5bc98'], U=['#eea887', '#f2b996'],
            N=['#bc7557', '#c9805f'], D=['#f1a788', '#f4ac8c'], lo_sides=(141, 162)),
}
BROWS = {  # x range, y range of each brow
    1: [((104, 142), (80, 97)), ((159, 199), (80, 97))],
    2: [((106, 139), (84, 96)), ((161, 190), (84, 96))],
    3: [((102, 141), (89, 105)), ((161, 200), (88, 105))],
    4: [((102, 142), (87, 102)), ((159, 199), (87, 102))],
}
EYES = {  # the box around each eye, lashes included
    1: [(110, 95, 138, 109), (163, 95, 192, 108)],
    2: [(110, 101, 134, 113), (164, 101, 189, 113)],  # her left one stops short of the glasses' frame
    3: [(107, 106, 138, 119), (165, 105, 197, 119)],
    4: [(110, 101, 138, 114), (163, 101, 191, 114)],
}
SUB = 8  # sub-pixels per pixel when tracing


def lerp(a, b, t):
    return a + (b - a) * t


def hexc(bgr):
    b, g, r = (int(round(v)) for v in bgr)
    return '#%02x%02x%02x' % (r, g, b)


def lab_of(h):
    c = np.uint8([[[int(h[5:7], 16), int(h[3:5], 16), int(h[1:3], 16)]]])
    return cv2.cvtColor(c, cv2.COLOR_BGR2LAB)[0, 0].astype(float)


def smooth(xs, ys, deg=6):
    """A smooth fit through noisy per-column samples."""
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    ok = ~np.isnan(ys)
    p = np.polyfit(xs[ok], ys[ok], min(deg, ok.sum() - 1))
    return np.poly1d(p)


def soften(xs, ys, width=9):
    """A running median then mean: follows the lip, not the pixel steps."""
    ys = np.asarray(ys, float)
    if np.all(np.isnan(ys)):
        return ys
    h = width // 2
    med = np.array([np.nanmedian(ys[max(0, k - h):k + h + 1]) for k in range(len(ys))])
    return np.array([np.nanmean(med[max(0, k - h):k + h + 1]) for k in range(len(med))])


def mouth(i, bgr):
    c = MOUTH[i]
    big = cv2.resize(bgr, None, fx=SUB, fy=SUB, interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(big, cv2.COLOR_BGR2LAB).astype(float)
    refs, roles = [], []
    for role in 'SUDTN':
        for h in c.get(role, []):
            refs.append(lab_of(h))
            roles.append(role)
    refs, roles = np.array(refs), np.array(roles)
    (xl, xr), (b0, b1) = c['x'], c['band']
    y0, y1 = int(b0 * SUB), int(b1 * SUB)
    lip = {'U', 'D', 'T', 'N'}
    xs, up, ot, ob, lo = [], [], [], [], []
    pix = {'upper': [], 'lower': [], 'teeth': [], 'line': []}
    for X in range(xl * SUB + 2, xr * SUB - 1, 2):
        d = np.linalg.norm(lab[y0:y1, X][:, None, :] - refs[None], axis=2)
        r = roles[d.argmin(1)]
        m = np.isin(r, list(lip))
        # a thin line of shading between two parts (teeth and lip) is still
        # the mouth: close gaps up to a pixel
        k = 0
        while k < len(m):
            if not m[k]:
                j = k
                while j < len(m) and not m[j]:
                    j += 1
                if 0 < k and j < len(m) and j - k <= SUB:
                    m[k:j] = True
                k = j
            else:
                k += 1
        # the mouth is the first run of mouth colours at least 3 sub-pixels long
        run = np.convolve(m, np.ones(3), 'same') >= 3
        idx = np.nonzero(run)[0]
        if len(idx) < 3:
            continue
        top = idx[0]
        # ...down to where it's skin again
        rest = np.nonzero(~m[top:])[0]
        bot = top + (rest[0] if len(rest) else len(m) - top)
        r = np.where(m & (r == 'S'), 'U', r)
        seg = r[top:bot]
        if i == 3:
            # the line is where the dark upper lip gives way to the lower
            # one: the first long run of lower-lip colour after the upper lip
            d_ = np.convolve(seg == 'D', np.ones(6), 'same') >= 6
            u_ = np.nonzero(seg == 'U')[0]
            dd = np.nonzero(d_ & (np.arange(len(seg)) > (u_[0] + 4 if len(u_) else 0)))[0]
            o1 = o2 = top + dd[0] - 3 if len(dd) else np.nan
        else:
            tn = np.nonzero(np.isin(seg, ['T', 'N']))[0]
            o1, o2 = (top + tn[0], top + tn[-1] + 1) if len(tn) else (np.nan, np.nan)
        x = X / SUB
        xs.append(x)
        up.append((y0 + top) / SUB)
        ot.append((y0 + o1) / SUB)
        ob.append((y0 + o2) / SUB)
        lo.append((y0 + bot) / SUB)
        for k in range(top, bot):
            if r[k] == 'N':
                pix['line'].append(big[y0 + k, X])
        # colours, from the sub-pixels well inside each part
        for k in range(top + 3, bot - 3):
            px = big[y0 + k, X]
            if r[k] == 'T':
                pix['teeth'].append(px)
            elif r[k] in ('U', 'D'):
                upper = r[k] == 'U' and (np.isnan(o1) or k < o1)
                pix['upper' if upper else 'lower'].append(px)
    xs = np.array(xs)
    # the teeth's edges are smoother than the classification: a wider window
    ot_s, ob_s = soften(xs, soften(xs, ot, 25), 9), soften(xs, soften(xs, ob, 25), 9)
    # where the teeth / line thin out near a corner, the lips just meet:
    # the mouth line runs on between them
    # the corners: on the mouth line, or where the lips meet
    line = np.where(np.isnan(ot_s), (np.array(up) + np.array(lo)) / 2, (ot_s + ob_s) / 2)
    yl, yr = float(np.median(line[:4])), float(np.median(line[-4:]))
    curves = {}
    xs_s = np.linspace(xl, xr, N)
    if 'lo_sides' in c:
        # a pale highlight in the middle of the lower lip reads as skin: fit
        # its bottom edge from the two sides
        a, b = c['lo_sides']
        side = (xs < a) | (xs > b)
        lo = list(np.poly1d(np.polyfit(xs[side], np.array(lo)[side], 4))(xs))
    for key, v in (('up', up), ('ot', ot_s), ('ob', ob_s), ('lo', lo)):
        v = soften(xs, v)
        ok = ~np.isnan(v)
        # pinned to the corners at each end
        y = np.interp(xs_s, np.r_[xl, xs[ok], xr], np.r_[yl, v[ok], yr])
        curves[key] = y
    for j in range(N):
        curves['ob'][j] = max(curves['ob'][j], curves['ot'][j])
        curves['up'][j] = min(curves['up'][j], curves['ot'][j])
        curves['lo'][j] = max(curves['lo'][j], curves['ob'][j])
    curves = {k: list(np.round(v, 2)) for k, v in curves.items()}
    med = lambda px: hexc(np.median(np.array(px), axis=0)) if len(px) else None
    return dict(x=[float(xl), float(xr)], y=[yl, yr], curves=curves,
                colors=dict(upper=med(pix['upper']), lower=med(pix['lower']), teeth=med(pix['teeth']),
                            line=med(pix['line'])))


def brows(i, bgr):
    """Each brow as a sprite: its core colour, with an alpha matte from how
    much darker than the skin each pixel is. Over the plate it composes back
    into the brow as painted, hair texture and soft edge included."""
    out = []
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(float)
    for (x0, x1), (y0, y1) in BROWS[i]:
        sx0, sy0, sx1, sy1 = x0 - 4, y0 - 4, x1 + 5, y1 + 3
        skinL = np.median(lab[y0 - 3, (x0 + x1) // 2 - 6:(x0 + x1) // 2 + 7, 0])
        box = lab[sy0:sy1, sx0:sx1, 0]
        core = box < skinL * 0.5
        coreL = np.median(box[core])
        alpha = np.clip((skinL - box) / (skinL - coreL), 0, 1)
        # keep only the brow: its pixels and a soft margin, not the eyes
        m = (box < skinL * 0.84).astype(np.uint8)
        n_, lbl, stats, _ = cv2.connectedComponentsWithStats(m)
        keep = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
        m = cv2.dilate((lbl == keep).astype(np.uint8), np.ones((3, 3), np.uint8))
        for ex0, ey0, ex1, ey1 in EYES[i]:
            m[max(ey0 - 1 - sy0, 0):max(ey1 + 1 - sy0, 0), max(ex0 - 2 - sx0, 0):max(ex1 + 2 - sx0, 0)] = 0
        alpha = alpha * cv2.GaussianBlur(m.astype(float), (0, 0), 0.6)
        color = np.median(bgr[sy0:sy1, sx0:sx1][core], axis=0)
        sprite = np.dstack([np.full(box.shape + (3,), color), alpha * 255]).astype(np.uint8)
        # 2x, so it stays crisp on a high-density screen
        sprite = cv2.resize(sprite, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
        ok, png = cv2.imencode('.png', sprite, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        ys, xs = np.nonzero(core)
        out.append(dict(x=sx0, y=sy0, w=sx1 - sx0, h=sy1 - sy0, color=hexc(color),
                        center=[float(sx0 + xs.mean()), float(sy0 + ys.mean())],
                        png=base64.b64encode(png.tobytes()).decode(),
                        mask=(sx0, sy0, m)))
    return out


def eyes(i, bgr):
    out = []
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(float)
    for (x0, y0, x1, y1) in EYES[i]:
        skinL = np.median(lab[y0 - 2, x0 + 4:x1 - 4, 0])
        xs, top, bot = [], [], []
        for x in range(x0 + 1, x1):
            col = lab[y0:y1 + 1, x]
            chroma = np.hypot(col[:, 1] - 128, col[:, 2] - 128)
            # the eye itself: its white (light, grey) or its iris and lashes
            # (dark), not the shading around it
            eye = ((col[:, 0] > skinL + 12) & (chroma < 18)) | (col[:, 0] < skinL * 0.6)
            ys = np.nonzero(eye)[0]
            if len(ys) < 2:
                continue
            # one run from the top, so a frame or a crease below doesn't count
            run = ys[:1].tolist()
            for y in ys[1:]:
                if y - run[-1] > 2:
                    break
                run.append(y)
            xs.append(x)
            top.append(y0 + run[0])
            bot.append(y0 + run[-1] + 1)
        ft, fb = smooth(xs, top, 4), smooth(xs, bot, 4)
        xl, xr = xs[0] - 0.5, xs[-1] + 1.5
        xe = np.linspace(xl, xr, E)
        yt, yb = ft(xe), fb(xe)
        mid = (yt + yb) / 2
        # the corners, where lid and lower lash meet
        yt[0] = yb[0] = mid[0]
        yt[-1] = yb[-1] = mid[-1]
        above = [bgr[max(int(round(ft(x))) - 3, 0), int(x)] for x in xe[2:-2]]
        below = [bgr[min(int(round(fb(x))) + 2, 274), int(x)] for x in xe[2:-2]]
        out.append(dict(x=np.round(xe, 2).tolist(), top=np.round(yt, 2).tolist(),
                        bottom=np.round(yb, 2).tolist(),
                        skin=[hexc(np.median(above, axis=0)), hexc(np.median(below, axis=0))]))
    return out


def main():
    rig = {}
    for i in range(1, 5):
        im = cv2.imread(os.path.join(IMG, f'coach-{i}.webp'), cv2.IMREAD_UNCHANGED)
        bgr = np.ascontiguousarray(im[:, :, :3])
        m = mouth(i, bgr)
        b = brows(i, bgr)
        e = eyes(i, bgr)
        # The plate: brows and mouth painted out from the skin around them.
        # The brows are painted out from the forehead above them, column by
        # column (below them are the lids and, on coach 2, the glasses).
        plate0 = bgr.copy().astype(float)
        bmask = np.zeros(bgr.shape[:2], np.uint8)
        for br in b:
            sx0, sy0, bm = br.pop('mask')
            bm = cv2.dilate(bm, np.ones((3, 3), np.uint8), iterations=2)
            bmask[sy0:sy0 + bm.shape[0], sx0:sx0 + bm.shape[1]] |= bm
        for x in range(bgr.shape[1]):
            ys = np.nonzero(bmask[:, x])[0]
            if len(ys):
                a = ys.min()
                src = plate0[max(a - 3, 0):a - 1, x].mean(axis=0)
                plate0[ys, x] = src
        soft = cv2.GaussianBlur(plate0, (0, 0), 1.6)
        al = cv2.GaussianBlur(bmask.astype(float), (0, 0), 1.0)[..., None]
        bgr_b = np.clip(plate0 * (1 - al) + soft * al, 0, 255).astype(np.uint8)
        mask = np.zeros(bgr.shape[:2], np.uint8)
        c = m['curves']
        xs = np.linspace(*m['x'], N)
        poly = np.array([*zip(xs, c['up']), *zip(xs[::-1], c['lo'][::-1])], np.float32)
        cv2.fillPoly(mask, [np.round(poly * 8).astype(np.int32)], 255, shift=3)
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)
        plate = cv2.inpaint(bgr_b, mask, 6, cv2.INPAINT_TELEA)
        # Inpainting leaves streaks: blur what it filled, fading into the rest.
        soft = cv2.GaussianBlur(plate, (0, 0), 2.2)
        a = cv2.GaussianBlur(cv2.dilate(mask, np.ones((3, 3), np.uint8)).astype(float) / 255, (0, 0), 1.2)[..., None]
        plate = np.clip(plate * (1 - a) + soft * a, 0, 255).astype(np.uint8)
        # each lip's shading, top to bottom down the middle, for a gradient
        c = m['curves']
        k = N // 2
        cx = int(round((m['x'][0] + m['x'][1]) / 2))
        def shade(y0, y1, stops):
            return [hexc(bgr[int(round(lerp(y0, y1, f))), cx - 2:cx + 3].mean(axis=0)) for f in stops]
        m['shade'] = dict(upper=shade(c['up'][k] + 0.5, c['ot'][k] - 0.5, (0.15, 0.5, 0.85)),
                          lower=shade(c['ob'][k], c['lo'][k], (0.2, 0.4, 0.6, 0.8, 0.92)))
        out = np.dstack([plate, im[:, :, 3]])
        cv2.imwrite(os.path.join(IMG, f'coach-{i}-plate.webp'), out, [cv2.IMWRITE_WEBP_QUALITY, 92])
        rig[i] = dict(mouth=m, brows=b, eyes=e)
    with open(os.path.join(IMG, 'rig.json'), 'w') as f:
        json.dump(rig, f, separators=(',', ':'))


if __name__ == '__main__':
    main()
