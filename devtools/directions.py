"""Locked track directions (data/tracks/directions.json): one-way or no-go stretches, stored by where they are"""
from __future__ import annotations
import time, uuid
from . import config
from .network import _oriented_geom, _along, _PathIndex
from core.fileio import read_json, write_json

FILE = config.DIRECTIONS_FILE
MAX_CHAIN = 600
BUDGET_S = 2.5                                          # a stretch walk gives up (and the stretch ends there) rather than hold the server

def load() -> list[dict]:
    return read_json(FILE, {}).get('locks', [])

def save(locks: list[dict]) -> None:
    write_json(FILE, {'locks': locks})

def stretch(net, eid: int) -> tuple[list, list[int]]:
    """The junction-to-junction stretch an edge belongs to -> (path, edge ids), running in the clicked edge's direction"""
    e0 = net.edge(eid)
    seen = {e0.id}
    t_end = time.time() + BUDGET_S

    def go(edge, node):                                 # follow through nodes where exactly one other track continues
        out = []
        while len(seen) < MAX_CHAIN and time.time() < t_end:
            around = net.adjacent(node, raw=True)
            nxt = [x for x in around if x[0] != edge.id]
            if len(around) != 2 or len(nxt) != 1 or nxt[0][0] in seen: break
            e2 = net.edge(nxt[0][0]); seen.add(e2.id)
            out.append((e2, node)); edge = e2; node = e2.b if e2.a == node else e2.a

        return out

    fwd, back = go(e0, e0.b), go(e0, e0.a)
    pts: list = []
    for e2, node in reversed(back):                     # behind the clicked edge: each piece turned to end where the next begins
        pts += _oriented_geom(e2, e2.b if e2.a == node else e2.a)

    pts += list(e0.geom)
    for e2, node in fwd: pts += _oriented_geom(e2, node)
    out = [pts[0]]
    for p in pts[1:]:
        if tuple(p) != tuple(out[-1]): out.append(p)

    return [[round(p[0], 6), round(p[1], 6)] for p in out], [e0.id] + [x[0].id for x in fwd] + [x[0].id for x in back]

def _hit(net, at):
    hit = next(((d, e) for d, e, *_ in net.nearest(tuple(at), 25.0, 6) if e.a != e.b), None)
    if hit is None: raise ValueError('no track here')
    return hit[1]

def probe(net, at) -> dict:
    """What a click here would act on, without changing anything: {pts (the stretch, junction to junction), dir (+1 along pts, -1 against, 0 free)}."""
    e = _hit(net, at)
    pts, ids = stretch(net, e.id)
    v = net._dir.get(e.id)
    return {'pts': pts, 'dir': v[0] if v else 0, 'edges': len(ids)}

def cycle(net, scope: str, at, locks: list[dict], kind: str = 'dir') -> dict:
    """Click on track: 'dir' cycles none -> one way -> other way, 'nogo' toggles closed -> {locks, dir, pts}"""
    e = _hit(net, at)
    pts, ids = stretch(net, e.id)
    v = net._dir.get(e.id)
    cur = v[0] if v else 0                              # in the direction of the stretch's path at this edge (a -> b = +1)
    if kind == 'nogo':
        nxt = 0 if cur == 2 else 2
    elif cur == 2:
        raise ValueError('this track is closed to all routes: open it with the No-go tool first')
    else:
        nxt = {0: 1, 1: -1, -1: 0}[cur]

    mine = (net._src.get(e.id) or {}).get(scope)
    keep = [k for k in locks if not (mine and k.get('id') == mine[0])]
    base = 0
    if scope == 'future':                               # what the Present map already says here (the lock a Future override sits on top of)
        pr = (net._src.get(e.id) or {}).get('present')
        lk = next((k for k in locks if pr and k.get('id') == pr[0]), None)
        if lk:
            al = _along(e.geom, _PathIndex([tuple(p) for p in lk['pts']]))
            base = 2 if pr[1] == 2 else ((pr[1] * al) if al else 0)

    if nxt != base or scope == 'present' and nxt:
        keep.append({'id': 'd' + uuid.uuid4().hex[:8], 'scope': scope, 'dir': _in_path_order(e, pts, nxt), 'pts': pts})

    return {'locks': keep, 'dir': nxt, 'pts': pts, 'edges': ids}

def _in_path_order(e, pts, d: int) -> int:
    """`d` is +1 for a -> b of edge e; a lock's dir is relative to its own pts order. The path was built running a -> b through e, so they agree."""
    return d

def arrows(net, bbox) -> list[dict]:
    """The locked stretches in view as [{p: [[lat, lon], ...] oriented the way trains may run}]."""
    s, w, n, ee = bbox
    out = []
    for eid, (d, a, b, _src) in list(net._dir.items()):
        g = net._dg.get(eid) or net.edge(eid).geom
        if max(x[0] for x in g) < s or min(x[0] for x in g) > n or max(x[1] for x in g) < w or min(x[1] for x in g) > ee: continue
        pts = list(g) if d != -1 else list(g)[::-1]
        out.append({'id': eid, 'closed': d == 2, 'p': [[round(p[0], 6), round(p[1], 6)] for p in pts]})

    return out