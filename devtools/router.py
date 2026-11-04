"""A* routing between waypoints that are snapped onto a Network."""
from __future__ import annotations
import heapq, math, time
from dataclasses import dataclass, field

from . import config
from .geo import Pt, haversine, pad_bbox, bbox_of, project_on_path
from .network import Network, _cum, _s_of


@dataclass
class Snap:
    edge: object
    i: int
    t: float
    q: Pt
    dist: float


@dataclass
class Leg:
    ok: bool
    geom: list[Pt]
    length_m: float
    error: str = ''
    note: str = ''            # e.g. a small gap in the track that the route bridged


@dataclass
class Route:
    legs: list[Leg] = field(default_factory=list)

    @property
    def ok(self): return bool(self.legs) and all(l.ok for l in self.legs)

    @property
    def length_m(self): return sum(l.length_m for l in self.legs)

    def geometry(self) -> list[Pt]:
        out: list[Pt] = []
        for l in self.legs:
            for p in l.geom:
                if not out or out[-1] != p:
                    out.append(p)
        return out


def snap(net: Network, p: Pt) -> Snap | None:
    r = net.nearest(p, config.MAX_SNAP_M, 1)
    if not r:
        return None
    d, e, i, t, q = r[0]
    return Snap(e, i, t, q, d)


def _partial(sn: Snap, to_a: bool) -> tuple[list[Pt], float]:
    g = sn.edge.geom
    pts = [sn.q] + (g[sn.i::-1] if to_a else g[sn.i + 1:])
    ln = sum(haversine(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
    ratio = sn.edge.cost / sn.edge.len if sn.edge.len else 1.0
    return pts, ln * ratio


def _oriented(e, frm: int) -> list[Pt]:
    return e.geom if e.a == frm else e.geom[::-1]


LEG_SECONDS = 6.0       # everything one leg may spend (searching, then looking for a break to jump); a failure never takes longer


def route_leg(net: Network, A: Snap, B: Snap, max_expand: int = 250_000, seconds: float = LEG_SECONDS, deadline: float | None = None) -> Leg:
    deadline = deadline or time.monotonic() + seconds
    ea, eb = A.edge, B.edge
    # same edge: go straight along it
    if ea.id == eb.id:
        cum = _cum(ea.geom)
        sa, sb = _s_of(ea.geom, cum, A.i, A.t), _s_of(ea.geom, cum, B.i, B.t)
        lo, hi = (A, B) if sa <= sb else (B, A)
        pts = [lo.q] + ea.geom[lo.i + 1:hi.i + 1] + [hi.q]
        if sa > sb: pts.reverse()
        ln = abs(sb - sa)
        return Leg(True, _dedupe(pts), ln)

    starts = {}
    for to_a in (True, False):
        pts, c = _partial(A, to_a)
        n = ea.a if to_a else ea.b
        if n not in starts or c < starts[n][0]:
            starts[n] = (c, pts)
    goals = {}
    for to_a in (True, False):
        pts, c = _partial(B, to_a)
        n = eb.a if to_a else eb.b
        if n not in goals or c < goals[n][0]:
            goals[n] = (c, pts)

    straight = haversine(A.q, B.q)
    for k, margin in enumerate((max(1_500, straight * 0.5), max(8_000, straight * 1.5), max(60_000, straight * 3), None)):
        box = None if margin is None else pad_bbox(bbox_of([A.q, B.q]), margin)
        if k == 0:
            res = _astar(net, starts, goals, B.q, box, 4_000, deadline)         # an easy leg is found almost at once, reading only what it needs
            if res:
                break
            continue
        if time.monotonic() > deadline:
            return Leg(False, [A.q, B.q], straight, 'routing took too long (track may be disconnected)')
        if box is not None:
            net.store.preload(box)                       # a hard leg: read the whole area in one query, then search from memory
        res = _astar(net, starts, goals, B.q, box, max_expand, deadline)
        if not res and time.monotonic() > deadline:
            return Leg(False, [A.q, B.q], straight, 'routing took too long (track may be disconnected)')
        if res:
            break
    if not res:
        return Leg(False, [A.q, B.q], straight, 'no connected track between these waypoints (a break of more than 40 m, or no track there)')
    total, node_path, edge_path, first_n, last_n = res
    geom = starts[first_n][1][:]
    for eid, frm in edge_path:
        geom += _oriented(net.edge(eid), frm)[1:]
    geom += list(reversed(goals[last_n][1]))[1:]
    return Leg(True, _dedupe(geom), total)


GAP_M = 40.0        # the largest break in the track that a route will jump (the jump is reported)


CELL = 0.0006        # grid cell (about 50-65 m) for the closest-approach search; larger than GAP_M so 3x3 cells always cover it


def _explore(net: Network, starts: dict, target: Pt, budget: int, deadline: float):
    """Greedy walk outward from a snap, always continuing from the node closest to `target`: the (nodes, edge ids in the order reached) on this side."""
    heap = [(haversine(net.pos(n), target), n) for n in starts]
    heapq.heapify(heap)
    seen, edges, eseen = set(starts), [], set()
    while heap and len(seen) < budget and time.monotonic() < deadline:
        _, n = heapq.heappop(heap)
        for eid, other, _c in net.adjacent(n):
            if eid not in eseen:
                eseen.add(eid); edges.append(eid)
            if other not in seen:
                seen.add(other)
                heapq.heappush(heap, (haversine(net.pos(other), target), other))
    return seen, edges


def _cloud(net: Network, edges, cap: int = 4_000, step: float = 15.0) -> list:
    """Points along the first `cap` explored edges (every ~15 m): [(point, edge id)]. Those are the edges nearest the other side."""
    pts = []
    for k, eid in enumerate(edges):
        if k >= cap:
            break
        g = net.edge(eid).geom
        pts.append((g[0], eid))
        for a, b in zip(g, g[1:]):
            d = haversine(a, b)
            for s in range(1, int(d // step) + 1):
                t = s * step / d
                pts.append(((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), eid))
            pts.append((b, eid))
    return pts


def find_gap(net: Network, A: Snap, B: Snap, deadline: float):
    """Closest approach between the track reachable from A and the track reachable from B (a break the router could jump).
    -> (gap_m, snap on A's side, snap on B's side) or None. Always finishes by `deadline`."""
    sa, sb = {}, {}
    for to_a in (True, False):
        for sn, d in ((A, sa), (B, sb)):
            n = sn.edge.a if to_a else sn.edge.b
            d[n] = 0.0
    na, ea = _explore(net, sa, B.q, 8_000, deadline)
    nb, eb = _explore(net, sb, A.q, 8_000, deadline)
    if set(ea) & set(eb):
        return None                                  # they touch after all: the failure is not a break
    pa, pb = _cloud(net, [A.edge.id] + ea), _cloud(net, [B.edge.id] + eb)
    small, big, swap = (pa, pb, False) if len(pa) <= len(pb) else (pb, pa, True)
    grid: dict = {}
    for q, qe in big:
        grid.setdefault((int(q[0] / CELL), int(q[1] / CELL)), []).append((q, qe))
    kx = math.cos(math.radians(A.q[0])) * 111320.0
    best = None
    for n, (p, pe) in enumerate(small):
        if n % 2000 == 0 and time.monotonic() > deadline:
            break
        ci, cj = int(p[0] / CELL), int(p[1] / CELL)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for q, qe in grid.get((ci + di, cj + dj), ()):
                    d = math.hypot((p[0] - q[0]) * 111320.0, (p[1] - q[1]) * kx)
                    if d <= GAP_M and (best is None or d < best[0]):
                        best = (d, p, pe, q, qe)
    if best is None:
        return None
    d, p, pe, q, qe = best
    if swap:
        p, pe, q, qe = q, qe, p, pe

    def snap_on(pt, eid):
        e = net.edge(eid); dd, i, t, qq = project_on_path(pt, e.geom)
        return Snap(e, i, t, qq, dd)
    return d, snap_on(p, pe), snap_on(q, qe)


def route_robust(net: Network, A: Snap, B: Snap, depth: int = 2, deadline: float | None = None) -> Leg:
    """route_leg, but a break in the track of up to GAP_M is jumped with a straight link instead of failing."""
    top = deadline is None
    deadline = deadline or time.monotonic() + LEG_SECONDS
    leg = route_leg(net, A, B, deadline=deadline if not top else time.monotonic() + LEG_SECONDS * 0.55)
    if leg.ok or depth <= 0 or time.monotonic() > deadline:
        return leg
    gap = find_gap(net, A, B, deadline)
    if gap is None:
        return leg
    d, sa, sb = gap
    l1 = route_robust(net, A, sa, depth - 1, deadline)
    l2 = route_robust(net, sb, B, depth - 1, deadline) if l1.ok else l1
    if not (l1.ok and l2.ok):
        return leg
    geom = _dedupe(l1.geom + l2.geom)
    note = '; '.join(x for x in (l1.note, f'bridged a {d:.0f} m break in the track', l2.note) if x)
    return Leg(True, geom, l1.length_m + d + l2.length_m, '', note)


def _dedupe(pts):
    out = []
    for p in pts:
        if not out or out[-1] != p: out.append(p)
    return out


def _astar(net, starts, goals, target: Pt, box, max_expand, deadline=None):
    pos_cache = {}

    def h(n):
        v = pos_cache.get(n)
        if v is None:
            v = pos_cache[n] = haversine(net.pos(n), target)
        return v

    def inside(n):
        if box is None: return True
        p = net.pos(n)
        return box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]

    g = {}
    prev = {}
    heap = []
    for n, (c, _) in starts.items():
        g[n] = c; prev[n] = None
        heapq.heappush(heap, (c + h(n), c, n))
    best, best_goal = float('inf'), None
    expanded = 0
    done = set()
    while heap:
        f, gc, n = heapq.heappop(heap)
        if f >= best:
            break
        if n in done or gc > g.get(n, float('inf')):
            continue
        done.add(n)
        if n in goals and gc + goals[n][0] < best:
            best, best_goal = gc + goals[n][0], n
        expanded += 1
        if expanded > max_expand or (deadline and expanded % 1024 == 0 and time.monotonic() > deadline):
            return None
        for eid, other, cost in net.adjacent(n):
            ng = gc + cost
            if ng < g.get(other, float('inf')) and inside(other):
                g[other] = ng
                prev[other] = (n, eid)
                heapq.heappush(heap, (ng + h(other), ng, other))
    if best_goal is None:
        return None
    path = []
    n = best_goal
    while prev[n] is not None:
        p, eid = prev[n]
        path.append((eid, p))
        n = p
    path.reverse()
    return best, None, path, n, best_goal


def route(net: Network, waypoints: list[Pt]) -> Route:
    r = Route()
    snaps = []
    for w in waypoints:
        s = snap(net, tuple(w))
        snaps.append(s)
    for k in range(len(snaps) - 1):
        a, b = snaps[k], snaps[k + 1]
        if a is None or b is None:
            r.legs.append(Leg(False, [tuple(waypoints[k]), tuple(waypoints[k + 1])],
                              haversine(tuple(waypoints[k]), tuple(waypoints[k + 1])),
                              'waypoint is not near any track'))
        else:
            r.legs.append(route_robust(net, a, b))
    return r