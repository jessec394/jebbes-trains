"""A routable network = base graph (+ optional edit overlay for the Future map).

Present map:  Network(store)                     -> the OSM graph as-is.
Future map:   Network(store, edits=load_edits())  -> same graph, edits applied.

Because edits are stored *geometrically* (a drawn line, not database ids), they
survive a re-ingest of fresh OSM data: the overlay is simply rebuilt on top of
the new base, and anything that no longer lines up lands in `report`.
"""
from __future__ import annotations
import hashlib
import math, itertools, json, os
from functools import lru_cache

from . import config
from .geo import Pt, haversine, project_on_path, pad_bbox, bbox_of, path_length, project_on_segment, offset_polyline, densify
from .store import GraphStore, Edge

ATTACH_ADDED_M = 3.0   # an edit end this close to another added track connects to it
END_SNAP_M = 8.0     # an attach this close to an edge end uses the end node
SAMPLE_M   = 10.0    # sampling step when matching a remove-line to base track


# ── path helpers ─────────────────────────────────────────────────────────────

def _cum(pts: list[Pt]) -> list[float]:
    c = [0.0]
    for i in range(len(pts) - 1):
        c.append(c[-1] + haversine(pts[i], pts[i + 1]))
    return c


def _point_at(pts, cum, s) -> Pt:
    if s <= 0: return pts[0]
    if s >= cum[-1]: return pts[-1]
    for i in range(len(cum) - 1):
        if cum[i + 1] >= s:
            seg = cum[i + 1] - cum[i]
            t = 0 if seg == 0 else (s - cum[i]) / seg
            a, b = pts[i], pts[i + 1]
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    return pts[-1]


def _sub(pts, cum, s0, s1) -> list[Pt]:
    out = [_point_at(pts, cum, s0)]
    for i, c in enumerate(cum):
        if s0 < c < s1:
            out.append(pts[i])
    out.append(_point_at(pts, cum, s1))
    d = [out[0]]
    for p in out[1:]:
        if p != d[-1]: d.append(p)
    return d if len(d) > 1 else [d[0], d[0]]


def clip_path_box(pts, cum, box) -> list[tuple[float, float]]:
    """Stretches [s0, s1] (metres along the path) of a polyline that lie inside box = (south, west, north, east)."""
    S_, W_, N_, E_ = box
    out: list[list[float]] = []
    for i in range(len(pts) - 1):
        (la0, lo0), (la1, lo1) = pts[i], pts[i + 1]
        t0, t1 = 0.0, 1.0
        for p, q, lo, hi in ((-(la1 - la0), la0 - S_, 0, 0), ((la1 - la0), N_ - la0, 0, 0), (-(lo1 - lo0), lo0 - W_, 0, 0), ((lo1 - lo0), E_ - lo0, 0, 0)):
            if abs(p) < 1e-15:
                if q < 0: t0, t1 = 1.0, 0.0
                continue
            r = q / p
            if p < 0: t0 = max(t0, r)
            else: t1 = min(t1, r)
        if t0 >= t1:
            continue
        seg = cum[i + 1] - cum[i]
        a, b = cum[i] + seg * t0, cum[i] + seg * t1
        if out and a - out[-1][1] < 0.05: out[-1][1] = b
        else: out.append([a, b])
    return [(a, b) for a, b in out if b - a > 0.3]


def subtract_spans(spans, cuts):
    """spans minus cuts, both lists of (a, b)."""
    res = []
    for a, b in spans:
        parts = [(a, b)]
        for c0, c1 in cuts:
            nxt = []
            for x, y in parts:
                if c1 <= x or c0 >= y: nxt.append((x, y)); continue
                if c0 > x: nxt.append((x, c0))
                if c1 < y: nxt.append((c1, y))
            parts = nxt
        res += [(x, y) for x, y in parts if y - x > 0.5]
    return res


def cut_positions(geom, cum, others, touch_m: float = 1.5) -> list[float]:
    """Where other track crosses `geom` or ends on it (metres along it): the points that split a track into its little segments."""
    kx = 111320.0 * math.cos(math.radians(geom[0][0])); ky = 111320.0
    XY = lambda p: (p[1] * kx, p[0] * ky)
    G = [XY(p) for p in geom]
    CELL = 25.0
    grid: dict[tuple[int, int], list[int]] = {}
    for i in range(len(G) - 1):
        x0, x1 = sorted((G[i][0], G[i + 1][0])); y0, y1 = sorted((G[i][1], G[i + 1][1]))
        for cx in range(int((x0 - 2) // CELL), int((x1 + 2) // CELL) + 1):
            for cy in range(int((y0 - 2) // CELL), int((y1 + 2) // CELL) + 1):
                grid.setdefault((cx, cy), []).append(i)
    out: list[float] = []
    for og in others:
        O = [XY(p) for p in og]
        seen = set()
        for j in range(len(O) - 1):
            (rx, ry), (tx, ty) = O[j], O[j + 1]
            cand = set()
            for cx in range(int((min(rx, tx) - 1) // CELL), int((max(rx, tx) + 1) // CELL) + 1):
                for cy in range(int((min(ry, ty) - 1) // CELL), int((max(ry, ty) + 1) // CELL) + 1):
                    cand.update(grid.get((cx, cy), ()))
            for i in cand:
                (px, py), (qx, qy) = G[i], G[i + 1]
                dx, dy, ex, ey = qx - px, qy - py, tx - rx, ty - ry
                den = dx * ey - dy * ex
                if abs(den) < 1e-9: continue
                u = ((rx - px) * ey - (ry - py) * ex) / den
                v = ((rx - px) * dy - (ry - py) * dx) / den
                if 0 <= u <= 1 and 0 <= v <= 1:
                    out.append(cum[i] + (cum[i + 1] - cum[i]) * u)
        for end in (og[0], og[-1]):                                  # another track that ends on this one (a switch, a junction)
            d, i, t, q = project_on_path(end, geom)
            if d <= touch_m:
                out.append(cum[i] + (cum[i + 1] - cum[i]) * t)
    return sorted(out)


def _s_of(pts, cum, i, t) -> float:
    return cum[i] + (cum[i + 1] - cum[i]) * t


def expand_lanes(edits: list[dict]) -> list[dict]:
    """An add_track with `tracks` > 1 is stored once (as its centre line) and becomes that many parallel tracks, `spacing` m apart."""
    out = []
    for op in edits:
        k = int(op.get('tracks') or 1) if op.get('op') == 'add_track' else 1
        if k <= 1:
            out.append(op); continue
        sp = float(op.get('spacing') or 4.5)
        a = {'left': 0, 'right': k - 1}.get(op.get('anchor'), (k - 1) / 2)       # which lane is the line that was drawn (0 = left-most)
        lo = op.get('lane_offsets') or {}
        ls, le = lo.get('start'), lo.get('end')
        pts = [tuple(c) for c in op['coords']]
        fr = None
        if ls and le and len(ls) == k and len(le) == k:        # a lane that eases from one spacing to another (so it links up with parallel track of a slightly different width)
            cum, kx = [0.0], 111320.0 * math.cos(math.radians(pts[0][0]))
            for p0, p1 in zip(pts, pts[1:]):
                cum.append(cum[-1] + math.hypot((p1[1] - p0[1]) * kx, (p1[0] - p0[0]) * 111320.0))
            fr = [c / (cum[-1] or 1.0) for c in cum]
        for i in range(k):
            d = [ls[i] + (le[i] - ls[i]) * f for f in fr] if fr else (a - i) * sp
            lane = dict(op); lane['coords'] = [list(p) for p in offset_polyline(pts, d)]
            for key, at in (('start_pts', 0), ('end_pts', -1)):                 # lane ends pinned onto existing track ends
                sp_ = lo.get(key)
                if sp_ and len(sp_) == k and sp_[i]:
                    lane['coords'][at] = list(sp_[i])
            lane['lane'] = i
            out.append(lane)
    return out


def edits_hash(edits: list[dict]) -> str:
    return hashlib.sha1(json.dumps(edits, sort_keys=True).encode()).hexdigest()[:12]


def load_edits(path: str = config.EDITS_FILE) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as f:
        return json.load(f).get('edits', [])


def save_edits(edits: list[dict], path: str = config.EDITS_FILE) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'edits': edits}, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


# ── network ──────────────────────────────────────────────────────────────────

class Network:
    def __init__(self, store: GraphStore, edits: list[dict] | None = None, name: str = 'present'):
        self.store = store
        self.name = name
        self.edits = edits or []
        self.lanes = expand_lanes(self.edits)       # what is actually routed (parallel tracks expanded)
        self.version = f"{store.build_id}:{edits_hash(self.edits)}"
        self.op_spans: dict[str, dict[int, list[tuple[float, float]]]] = {}     # erase edit id -> {base edge id: stretches it hides}
        self.vorigin: dict[int, tuple[int, float, float]] = {}                 # kept piece id -> (base edge id, from s, to s)
        self.replaced: set[int] = set()          # base edge ids superseded by pieces
        self.vedges: dict[int, Edge] = {}        # virtual edges (kept pieces + added tracks)
        self.vadded: set[int] = set()            # subset of vedges that are user-added
        self.vremoved: list[tuple[list[Pt], int]] = []   # removed pieces (display only)
        self.vadj: dict[int, list[tuple[int, int, float]]] = {}
        self.vpos: dict[int, Pt] = {}
        self.report: list[dict] = []
        self._eid = itertools.count(-1, -1)
        self._nid = itertools.count(-1, -1)
        self._node_cache = store.node_pos
        if name == 'present':                    # planned / under-construction track exists on the Future map only
            self.replaced |= set(store.future_ids())
        if self.edits:
            self._apply_edits()

    # -- graph interface -----------------------------------------------------
    def _node_uncached(self, n: int) -> Pt:
        return self.store.node(n)

    def pos(self, n: int) -> Pt:
        return self.vpos[n] if n < 0 else self._node_cache(n)

    def adjacent(self, n: int):
        base = self.store.adjacent(n) if n > 0 else ()
        if self.replaced and base:
            base = tuple(x for x in base if x[0] not in self.replaced)
        extra = self.vadj.get(n)
        return base + tuple(extra) if extra else base

    def edge(self, eid: int) -> Edge:
        return self.vedges[eid] if eid < 0 else self.store.edge(eid)

    # -- snapping ------------------------------------------------------------
    def nearest(self, p: Pt, max_m: float = config.MAX_SNAP_M, k: int = 5):
        """-> [(dist, Edge, seg_idx, t, point)] over base (minus replaced) + virtual edges."""
        out = []
        for d, e, i, t, q in self.store.nearest(p, max_m, k, self.replaced or None):
            if e.id not in self.replaced:
                out.append((d, e, i, t, q))
        if self.vedges:
            box = pad_bbox((p[0], p[1], p[0], p[1]), max_m)
            for e in self.vedges.values():
                g = e.geom
                lo = min(x[0] for x in g), min(x[1] for x in g), max(x[0] for x in g), max(x[1] for x in g)
                if lo[2] < box[0] or lo[0] > box[2] or lo[3] < box[1] or lo[1] > box[3]:
                    continue
                d, i, t, q = project_on_path(p, g)
                if d <= max_m:
                    out.append((d, e, i, t, q))
        out.sort(key=lambda x: x[0])
        return out[:k]

    # -- picking track to erase ---------------------------------------------
    def select(self, box=None, at=None, radius_m: float = 15.0):
        """Base track under a drag box (the stretches inside it) or nearest to a point (that whole segment, junction to junction).
        -> [(base edge id, from s, to s, geometry)]. Added tracks are not offered: they are edited, not erased."""
        out = []

        def take(eid, off, g, cum, spans):
            for a, b in spans:
                out.append((eid, off + a, off + b, _sub(g, cum, a, b)))
        if box is not None:
            for e in self.store.edges_in_bbox(box, 30000):
                if e.id in self.replaced:
                    continue
                cum = _cum(e.geom); take(e.id, 0.0, e.geom, cum, clip_path_box(e.geom, cum, box))
            for e in self.vedges.values():
                o = self.vorigin.get(e.id)
                if o is None or e.id in self.vadded:
                    continue
                cum = _cum(e.geom); take(o[0], o[1], e.geom, cum, clip_path_box(e.geom, cum, box))
        elif at is not None:
            p = self.little(at, radius_m)
            if p: out.append(p)
        return out

    def _others(self, geom, skip_eid):
        box = pad_bbox(bbox_of(geom), 3.0)
        res = [e.geom for e in self.store.edges_in_bbox(box, 3000) if e.id != skip_eid]
        res += [e.geom for e in self.vedges.values() if e.id in self.vadded]
        return res

    @staticmethod
    def _around(cuts, s, total):
        a = max([c for c in cuts if c <= s - 0.3], default=0.0)
        b = min([c for c in cuts if c >= s + 0.3], default=total)
        return a, b

    def little(self, at, radius_m: float = 15.0):
        """The little segment of track under a point: the stretch between the nearest crossings / junctions on either side.
        -> (base edge id, from s, to s, geometry) or None."""
        for d, e, i, t, q in self.nearest(at, radius_m, 8):
            if e.id in self.vadded:
                continue
            o = self.vorigin.get(e.id) if e.id < 0 else (e.id, 0.0, e.len)
            if o is None:
                continue
            cum = _cum(e.geom)
            s = _s_of(e.geom, cum, i, t)
            a, b = self._around(cut_positions(e.geom, cum, self._others(e.geom, o[0])), s, cum[-1])
            return (o[0], o[1] + a, o[1] + b, _sub(e.geom, cum, a, b))
        return None

    def erased_little(self, at, radius_m: float = 15.0):
        """Same for erased track: -> (erase edit id, base edge id, from s, to s, geometry) of the little erased segment nearest to the point."""
        best = None
        for op in self.lanes:
            if op.get('op') != 'remove_track':
                continue
            for eid, sp in (self.op_spans.get(op.get('id')) or {}).items():
                e = self.store.edge(eid); cum = _cum(e.geom)
                for a, b in sp:
                    sub = _sub(e.geom, cum, a, b)
                    d, i, t, q = project_on_path(at, sub)
                    if d <= radius_m and (best is None or d < best[0]):
                        best = (d, op.get('id'), e, cum, a, b, a + _s_of(sub, _cum(sub), i, t))
        if best is None:
            return None
        d, oid, e, cum, a, b, s = best
        lo, hi = self._around(cut_positions(e.geom, cum, self._others(e.geom, e.id)), s, cum[-1])
        lo, hi = max(lo, a), min(hi, b)
        return (oid, e.id, lo, hi, _sub(e.geom, cum, lo, hi))

    # -- viewport listing for the UI ----------------------------------------
    def view(self, bbox, limit=15000, include_removed=True):
        """-> list of {id, kind, pts} where kind in base|added|removed."""
        res = []
        for e in self.store.edges_in_bbox(bbox, limit):
            if e.id not in self.replaced:
                res.append({'id': e.id, 'kind': 'base', 'cls': e.kind, 'pts': e.geom})
        s, w, n, ee = bbox
        for e in self.vedges.values():
            g = e.geom
            if max(x[0] for x in g) < s or min(x[0] for x in g) > n or max(x[1] for x in g) < w or min(x[1] for x in g) > ee:
                continue
            res.append({'id': e.id, 'kind': 'added' if e.id in self.vadded else 'base', 'cls': e.kind, 'pts': g})
        if include_removed:
            for g, _ in self.vremoved:
                if max(x[0] for x in g) < s or min(x[0] for x in g) > n or max(x[1] for x in g) < w or min(x[1] for x in g) > ee:
                    continue
                res.append({'id': 0, 'kind': 'removed', 'cls': '', 'pts': g})
        return res

    # -- overlay construction -----------------------------------------------
    def _new_vnode(self, p: Pt) -> int:
        n = next(self._nid)
        self.vpos[n] = p
        return n

    def _link(self, e: Edge) -> None:
        self.vedges[e.id] = e
        self.vadj.setdefault(e.a, []).append((e.id, e.b, e.cost))
        if e.b != e.a:
            self.vadj.setdefault(e.b, []).append((e.id, e.a, e.cost))

    def _apply_edits(self) -> None:
        tol_rm = config.REMOVE_TOLERANCE_M
        spans: dict[int, list[tuple[float, float]]] = {}       # base edge id -> removed [s0,s1]
        edge_cache: dict[int, tuple[Edge, list[float]]] = {}

        def get(eid_or_edge):
            e = eid_or_edge if isinstance(eid_or_edge, Edge) else self.store.edge(eid_or_edge)
            if e.id not in edge_cache:
                edge_cache[e.id] = (e, _cum(e.geom))
            return edge_cache[e.id]

        rep: dict[int, dict] = {}
        # 1) removals -> spans per base edge. A segment erase names the base edges and stretches it hides; an older erase *line* hides
        #    whatever track lies along it.
        def cover(line, tol):
            found: dict[int, list[tuple[float, float]]] = {}
            box = pad_bbox(bbox_of(line), tol + 5)
            for e in self.store.edges_in_bbox(box, 5000):
                _, cum = get(e)
                cov: list[tuple[float, float]] = []
                run0 = None
                for si in range(len(e.geom) - 1):
                    a, b = e.geom[si], e.geom[si + 1]
                    sb = bbox_of([a, b])
                    if sb[2] < box[0] or sb[0] > box[2] or sb[3] < box[1] or sb[1] > box[3]:
                        if run0 is not None:
                            cov.append((run0, cum[si])); run0 = None
                        continue
                    seglen = cum[si + 1] - cum[si]
                    n = max(1, int(seglen / SAMPLE_M))
                    for k in range(n + 1):
                        tt = k / n
                        q = (a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt)
                        s = cum[si] + seglen * tt
                        near = project_on_path(q, line)[0] <= tol
                        if near and run0 is None:
                            run0 = max(0.0, s - SAMPLE_M / 2)
                        elif not near and run0 is not None:
                            cov.append((run0, min(cum[-1], s))); run0 = None
                if run0 is not None:
                    cov.append((run0, cum[-1]))
                cov = [c for c in cov if c[1] - c[0] > 1.0]
                if cov:
                    found.setdefault(e.id, []).extend(cov)
            return found

        for op in self.lanes:
            if op.get('op') != 'remove_track':
                continue
            mine: dict[int, list[tuple[float, float]]] = {}
            if op.get('edges') and op.get('build') in (None, self.store.build_id):
                for eid, a, b in op['edges']:
                    try:
                        e, cum = get(int(eid))
                    except Exception:
                        continue
                    a, b = max(0.0, float(a)), min(cum[-1], float(b))
                    if b - a > 0.3:
                        mine.setdefault(e.id, []).append((a, b))
            if not mine:                                    # an erase line, or a segment erase whose edge ids went stale after a re-ingest
                lines = [[tuple(c) for c in pc] for pc in (op.get('pieces') or [])] or [[tuple(c) for c in op['coords']]]
                tol = tol_rm if not op.get('edges') else 3.0
                for line in lines:
                    if len(line) >= 2:
                        for eid, cov in cover(line, tol).items():
                            mine.setdefault(eid, []).extend(cov)
            total = sum(b - a for v in mine.values() for a, b in v)
            for eid, v in mine.items():
                spans.setdefault(eid, []).extend(v)
            self.op_spans[op.get('id')] = mine
            rep[id(op)] = {'id': op.get('id'), 'op': 'remove_track', 'name': op.get('name', ''),
                           'removed_m': round(total), 'ok': total > 0}
            self.report.append(rep[id(op)])

        for eid, sp in spans.items():            # merge overlapping spans
            sp.sort(); merged = [list(sp[0])]
            for a, b in sp[1:]:
                if a <= merged[-1][1] + 1.0: merged[-1][1] = max(merged[-1][1], b)
                else: merged.append([a, b])
            spans[eid] = [tuple(m) for m in merged]

        def in_removed(eid, s):
            return any(a - 0.5 <= s <= b + 0.5 for a, b in spans.get(eid, ()))

        # 2) additions: decide attach nodes, collecting cuts on base edges
        cuts: dict[int, list[tuple[float, int]]] = {}
        added_nodes: dict[tuple[float, float], int] = {}
        plans = []

        adds = [(op, [tuple(c) for c in op['coords']]) for op in self.lanes if op.get('op') == 'add_track' and len(op['coords']) >= 2]
        CELL = 0.0005
        grid: dict[tuple[int, int], set[int]] = {}
        for ai, (_, cs) in enumerate(adds):
            for p in densify(cs, 25.0):
                grid.setdefault((int(p[0] / CELL), int(p[1] / CELL)), set()).add(ai)
        extra: dict[int, list[tuple[Pt, int]]] = {}        # other added tracks passing through a node -> they get split there

        def on_added(p: Pt, me: int, tol: float = ATTACH_ADDED_M):
            ci, cj = int(p[0] / CELL), int(p[1] / CELL)
            cand = set()
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    cand |= grid.get((ci + di, cj + dj), set())
            best = None
            for ai in cand:
                if ai == me: continue
                d, i, t, q = project_on_path(p, adds[ai][1])
                if d <= tol and (best is None or d < best[0]):
                    best = (d, ai, q)
            return best

        def find(p: Pt, me: int, tb: float, ta: float, out):
            """An existing track to connect p to, or None. `out` (unit [east, north] pointing away from the end of the track being
            attached) limits long-range bridging to track roughly in line with the end, so lanes alongside are never joined."""
            kx, ky = 111320.0 * math.cos(math.radians(p[0])), 111320.0

            def ok(q) -> bool:
                if out is None:
                    return True
                vx, vy = (q[1] - p[1]) * kx, (q[0] - p[0]) * ky
                d = math.hypot(vx, vy)
                return d < config.EDIT_ATTACH_M or abs(vx * out[0] + vy * out[1]) / d >= 0.5
            hit = on_added(p, me, ta)
            if hit and not ok(hit[2]):
                hit = None
            for d, e, i, t, q in self.store.nearest(p, tb, 6, self.replaced or None):
                _, cum = get(e)
                s = _s_of(e.geom, cum, i, t)
                if in_removed(e.id, s) or not ok(q):
                    continue
                if hit and hit[0] + 0.3 < d:          # an added track is the closer thing to attach to
                    break
                if min(s, cum[-1] - s) <= END_SNAP_M:           # near an end of the edge: use that end's node (the nearer one, for a short edge)
                    n = e.a if s <= cum[-1] - s else e.b; q = self.pos(n)
                else:
                    lst = cuts.setdefault(e.id, [])
                    n = next((nn for ss, nn in lst if abs(ss - s) < 1.0), None)
                    if n is None:
                        n = self._new_vnode(q); lst.append((s, n))
                    else:
                        q = self.vpos[n]
                return n, q, 'base', d
            if hit:
                pq = p if hit[0] <= config.EDIT_ATTACH_M else hit[2]       # a bridged end is moved onto the other track
                n = self._new_vnode(pq)
                extra.setdefault(hit[1], []).append((pq, n))
                return n, pq, 'track', hit[0]
            return None

        def attach(p: Pt, me: int, out=None):
            key = (round(p[0], 6), round(p[1], 6))
            if key in added_nodes:
                return added_nodes[key], p, 'added', 0.0
            r = find(p, me, config.EDIT_ATTACH_M, ATTACH_ADDED_M, None)
            if r is None and out is not None:
                r = find(p, me, config.BRIDGE_M, config.BRIDGE_M, out)         # bridge a small gap or overshoot
            if r is None:
                n = self._new_vnode(p); added_nodes[key] = n
                return n, p, 'none', 0.0
            added_nodes[key] = r[0]
            return r

        def outward(coords, j):
            """Unit direction pointing away from the track at its first / last point."""
            if j not in (0, len(coords) - 1):
                return None
            kx, ky = 111320.0 * math.cos(math.radians(coords[j][0])), 111320.0
            rng = range(1, len(coords)) if j == 0 else range(len(coords) - 2, -1, -1)
            for k in rng:
                vx, vy = (coords[j][1] - coords[k][1]) * kx, (coords[j][0] - coords[k][0]) * ky
                d = math.hypot(vx, vy)
                if d >= 4.0:
                    return (vx / d, vy / d)
            return None

        for ai, (op, coords) in enumerate(adds):
            joins = sorted(set(op.get('joins') or [0, len(coords) - 1]) | {0, len(coords) - 1})
            explicit = 'snap_s' in op or 'snap_e' in op         # newer edits only connect where the cursor snapped onto track (or at a junction node)
            last = len(coords) - 1
            nodes = []
            info = []
            for j in joins:
                if explicit and ((j == 0 and not op.get('snap_s')) or (j == last and not op.get('snap_e'))):
                    # not snapped: still joined when it lies exactly on track (within 0.5 m), as a snapped end would; otherwise left free
                    key = (round(coords[j][0], 6), round(coords[j][1], 6))
                    r0 = (added_nodes[key], coords[j], 'added', 0.0) if key in added_nodes else find(coords[j], ai, 0.5, 0.5, None)
                    if r0:
                        added_nodes[key] = r0[0]; nodes.append((j, r0[0], r0[1])); info.append({'index': j, 'to': r0[2], 'dist_m': round(r0[3], 1)}); continue
                    nodes.append((j, self._new_vnode(coords[j]), coords[j])); info.append({'index': j, 'to': 'free', 'dist_m': 0.0}); continue
                n, q, how, d = attach(coords[j], ai, outward(coords, j))
                nodes.append((j, n, q)); info.append({'index': j, 'to': how, 'dist_m': round(d, 1)})
            r = {'id': op.get('id'), 'op': 'add_track', 'name': op.get('name', ''), 'joins': info,
                 'ok': (not (op.get('snap_s') and info[0]['to'] == 'none') and not (op.get('snap_e') and info[-1]['to'] == 'none')) if explicit
                       else (info[0]['to'] != 'none' and info[-1]['to'] != 'none')}
            self.report.append(r)
            plans.append((ai, op, coords, nodes))

        # 3) rebuild affected base edges as pieces
        for eid in set(spans) | set(cuts):
            e, cum = get(eid)
            L = cum[-1]
            marks: dict[float, int] = {}
            for s, n in cuts.get(eid, []):
                marks[round(s, 3)] = n
            for a, b in spans.get(eid, []):
                for s in (a, b):
                    if 0.5 < s < L - 0.5 and not any(abs(s - m) < 0.5 for m in marks):
                        marks[round(s, 3)] = self._new_vnode(_point_at(e.geom, cum, s))
            pts_s = [0.0] + sorted(marks) + [L]
            node_at = {0.0: e.a, L: e.b, **marks}
            self.replaced.add(eid)
            ratio = e.cost / e.len if e.len else 1.0
            for s0, s1 in zip(pts_s, pts_s[1:]):
                if s1 - s0 < 0.5:
                    continue
                geom = _sub(e.geom, cum, s0, s1)
                mid = (s0 + s1) / 2
                if any(a - 0.5 <= mid <= b + 0.5 for a, b in spans.get(eid, ())):
                    self.vremoved.append((geom, eid)); continue
                ln = path_length(geom)
                ed = Edge(next(self._eid), node_at[s0], node_at[s1], ln, ln * ratio, e.kind, e.way, geom)
                self.vorigin[ed.id] = (eid, s0, s1)
                self._link(ed)

        # 4) materialise added tracks, split wherever another added track connects to them.
        #    Two nodes that turn out to be the same place (two track ends that nearly touch) are merged.
        parent: dict[int, int] = {}

        def root(x: int) -> int:
            while x in parent:
                x = parent[x]
            return x

        def union(a: int, b: int) -> None:
            ra, rb = root(a), root(b)
            if ra == rb:
                return
            if ra < 0 < rb: parent[ra] = rb          # keep base nodes as the representative
            else: parent[rb] = ra
        for ai, op, coords, nodes in plans:
            cum = _cum(coords)
            pts = [(cum[j], nn, q) for j, nn, q in nodes]
            for p, nn in extra.get(ai, []):
                if any(nn == x[1] for x in pts):
                    continue
                d, i, t, q = project_on_path(p, coords)
                s = _s_of(coords, cum, i, t)
                close = next((x for x in pts if abs(s - x[0]) < 0.5), None)
                if close is not None:
                    union(nn, close[1])               # lands on one of this track's own nodes: they are the same junction
                    continue
                pts.append((s, nn, p))
            pts.sort(key=lambda x: x[0])
            for (s0, n0, q0), (s1, n1, q1) in zip(pts, pts[1:]):
                geom = _sub(coords, cum, s0, s1)
                geom[0] = q0; geom[-1] = q1
                ln = path_length(geom)
                ed = Edge(next(self._eid), n0, n1, ln, ln, 'added', 0, geom)
                self._link(ed); self.vadded.add(ed.id)
        if parent:                                       # apply the merges to every edge
            self.vadj = {}
            for e in self.vedges.values():
                e.a, e.b = root(e.a), root(e.b)
                self.vadj.setdefault(e.a, []).append((e.id, e.b, e.cost))
                if e.b != e.a:
                    self.vadj.setdefault(e.b, []).append((e.id, e.a, e.cost))