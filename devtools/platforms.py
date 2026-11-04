"""Platforms: the stretch of rail a platform serves, found from real-world platform geometry (OSM railway=platform).

A platform's span is two points on the rail ('Span': [(lat, lon), (lat, lon)] in map_data.py); the track between them follows
the rail, so curves are respected and the length is derived."""
from __future__ import annotations
import math

from .geo import haversine
from .network import _cum, _point_at, _s_of, _sub
from .store import Pt


def densify(pts: list[Pt], step_m: float = 3.0, cap: int = 600) -> list[Pt]:
    out: list[Pt] = []
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(haversine(a, b) / step_m))
        out.extend((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n))
    out.append(pts[-1])
    if len(out) > cap:
        out = out[::math.ceil(len(out) / cap)]
    return out


def _mid(line: list[Pt]) -> list[float]:
    cum = _cum(line); m = _point_at(line, cum, cum[-1] / 2)
    return [round(m[0], 5), round(m[1], 5)]


def platform_spans(net, pts: list[Pt], max_m: float = 25.0, near_m: float = 6.0) -> list[dict]:
    """Rails beside a platform (a line or the outline of a platform area) -> [{a, b, length_m, dist_m, edge, pts}], longest
    cover first. A platform between two rails (an island) gives one span for each rail it faces."""
    per: dict[int, dict] = {}
    for p in densify(pts):
        cand = net.nearest(p, max_m, 6)
        if not cand:
            continue
        best = cand[0][0]
        for d, e, i, t, q in cand:
            if d > best + near_m:
                continue
            ent = per.setdefault(e.id, {'e': e, 'cum': _cum(e.geom), 'n': 0, 'd': 0.0, 's0': 1e18, 's1': -1.0})
            s = _s_of(e.geom, ent['cum'], i, t)
            ent['n'] += 1; ent['d'] += d; ent['s0'] = min(ent['s0'], s); ent['s1'] = max(ent['s1'], s)
    out = []
    for ent in per.values():
        if ent['s1'] - ent['s0'] < 3.0:
            continue
        line = _sub(ent['e'].geom, ent['cum'], ent['s0'], ent['s1'])
        out.append({'a': [round(line[0][0], 5), round(line[0][1], 5)], 'b': [round(line[-1][0], 5), round(line[-1][1], 5)],
                    'mid': _mid(line), 'length_m': round(ent['s1'] - ent['s0'], 1), 'dist_m': round(ent['d'] / ent['n'], 1), 'edge': ent['e'].id,
                    'pts': [[round(a, 6), round(b, 6)] for a, b in line]})
    out.sort(key=lambda x: -x['length_m'])
    return out


def span_between(net, a: Pt, b: Pt, max_m: float = 30.0) -> dict | None:
    """Two points clicked near a rail -> the span between them on that rail (both must land on the same track)."""
    ca, cb = net.nearest(a, max_m, 4), net.nearest(b, max_m, 4)
    for d1, e1, i1, t1, q1 in ca:
        for d2, e2, i2, t2, q2 in cb:
            if e1.id != e2.id:
                continue
            cum = _cum(e1.geom); s1, s2 = _s_of(e1.geom, cum, i1, t1), _s_of(e1.geom, cum, i2, t2)
            if abs(s1 - s2) < 3.0:
                continue
            lo, hi = min(s1, s2), max(s1, s2)
            line = _sub(e1.geom, cum, lo, hi)
            return {'a': [round(line[0][0], 5), round(line[0][1], 5)], 'b': [round(line[-1][0], 5), round(line[-1][1], 5)],
                    'mid': _mid(line), 'length_m': round(hi - lo, 1), 'dist_m': round((d1 + d2) / 2, 1), 'edge': e1.id,
                    'pts': [[round(x, 6), round(y, 6)] for x, y in line]}
    return None
