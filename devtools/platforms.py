"""Platforms are spans of rail found by walking along the track between their two end points; OSM platform outlines (osm_*) are a local picture to build them against"""
from __future__ import annotations
import math, os, sqlite3, threading
from array import array
from . import config
from core.geo import haversine
from .network import _cum, _point_at, _s_of, _sub
from .store import Pt

STEP_M = 3.0             # how far each step of the walk goes
GAP_M = 8.0              # a rail this close to the next step counts as the same track
BRIDGE_STEPS = 4         # a break in the rail up to this many steps (12 m) is stepped across
ON_RAIL_M = 2.5          # an end this close to the rail counts as still on it
FOLLOW_M = 20.0          # a platform end whose rail moved away follows it if the rail is within this distance
MAX_SPAN_M = 900.0
R6 = lambda p: [round(p[0], 6), round(p[1], 6)]

def _mid(line) -> list[float]:
    cum = _cum(line); m = _point_at(line, cum, cum[-1] / 2)
    return R6(m)

def _cands(net, p, r, n=8):
    return sorted(net.nearest(p, r, n), key=lambda c: c[0])

def _on(c) -> tuple:
    _d, e, i, t, _q = c
    return _point_at(e.geom, (cum := _cum(e.geom)), _s_of(e.geom, cum, i, t))

def snap_point(net, p: Pt, max_m: float = 30.0) -> dict | None:
    """The nearest point on any rail: {point, dist_m, edge}."""
    cs = _cands(net, p, max_m, 1)
    return {'point': R6(_on(cs[0])), 'dist_m': round(cs[0][0], 1), 'edge': cs[0][1].id} if cs else None

def _walk_steps(net, a: Pt, b: Pt, max_m: float = MAX_SPAN_M) -> list | None:
    """The rail from a to b (both on rails): points about STEP_M apart, or None when they are not on one continuous track."""
    total = haversine(a, b)
    if total < 2.0 or total > max_m: return None
    q = tuple(a); out = [q]; prev = None
    first = _cands(net, a, GAP_M, 1)
    if first: prev = first[0][1].id
    stuck, last_d = 0, haversine(q, b)
    for _ in range(int(total / STEP_M * 2) + 20):
        if haversine(q, b) <= STEP_M * 1.2: break
        d = haversine(q, b); ux, uy = (b[0] - q[0]) / (d / 111320.0), (b[1] - q[1]) / (d / (111320.0 * math.cos(math.radians(q[0]))))
        here = next((c for c in _cands(net, q, GAP_M) if c[1].id == prev), None)
        if here is not None:                          # walk the way the rail runs (toward b), not along the straight chord: no drifting onto a neighbour
            ux, uy = _tangent(here, (ux, uy))

        step = lambda m: (q[0] + ux * m / 111320.0, q[1] + uy * m / (111320.0 * math.cos(math.radians(q[0]))))
        nxt = None
        for k in range(1, BRIDGE_STEPS + 1):              # k > 1: stepping over a break in the rail
            p = step(STEP_M * k)
            cs = _cands(net, p, GAP_M)
            if not cs: continue
            hold = next((c for c in cs if c[1].id == prev and c[0] <= ON_RAIL_M), None)
            c = hold or cs[0]
            nq = _on(c)
            if haversine(q, nq) > STEP_M * (k + 0.8) + 1.0: continue
            nxt = (nq, c[1].id); break

        if not nxt: return None
        q, prev = nxt
        out.append(q)
        nd = haversine(q, b)
        stuck = stuck + 1 if nd > last_d - 0.3 else 0
        last_d = min(last_d, nd)
        if stuck > 3: return None

    if haversine(q, b) > STEP_M * 1.2 or not any(c[1].id == prev and c[0] <= ON_RAIL_M for c in _cands(net, b, GAP_M)):
        return None                                           # ended on a different track than b: a parallel one

    out.append(tuple(b))
    return out

MAX_TURN_COS = 0.5       # through a junction a platform may bend at most 60 degrees: it never doubles back through a turnout

def _leave_dir(g) -> tuple[float, float]:
    """Unit direction (metres north, east) a polyline leaves its first point in, measured a few metres along it"""
    a = g[0]; b = next((p for p in g[1:] if haversine(a, p) >= 4.0), g[-1])
    dy, dx = (b[0] - a[0]) * 111320.0, (b[1] - a[1]) * 111320.0 * math.cos(math.radians(a[0]))
    n = math.hypot(dx, dy) or 1.0
    return dy / n, dx / n

def _graph_between(net, x, y, max_m: float):
    """Shortest rail from candidate x (on its edge) to candidate y through the network's junctions, never turning sharply -> (length, points) or None"""
    import heapq, itertools
    ex, ey = x[1], y[1]
    if ex.id == ey.id: return None
    gx, gy = ex.geom, ey.geom; cx, cy = _cum(gx), _cum(gy)
    sx, sy = _s_of(gx, cx, x[2], x[3]), _s_of(gy, cy, y[2], y[3])
    tick, heap, seen = itertools.count(), [], set()
    for node, s_end in ((ex.a, 0.0), (ex.b, cx[-1])):           # from a along its own edge to either end node
        piece = _sub(gx, cx, min(sx, s_end), max(sx, s_end))
        if s_end < sx: piece = piece[::-1]
        if len(piece) < 2: continue
        back = _leave_dir(piece[::-1]); heapq.heappush(heap, (abs(sx - s_end), next(tick), node, ex.id, (-back[0], -back[1]), [piece]))

    while heap:
        cost, _t, n, via, din, parts = heapq.heappop(heap)
        if cost > max_m or (n, via) in seen: continue
        seen.add((n, via))
        for eid, other, _c in net.adjacent(n, raw=True):
            if eid == via: continue
            e = net.edge(eid); g = e.geom if e.a == n else e.geom[::-1]
            if len(g) < 2: continue
            dout = _leave_dir(g)
            if din[0] * dout[0] + din[1] * dout[1] < MAX_TURN_COS: continue
            if eid == ey.id:                                    # the far end's edge: up to b
                s_here = 0.0 if e.a == n else cy[-1]
                piece = _sub(gy, cy, min(s_here, sy), max(s_here, sy))
                if s_here > sy: piece = piece[::-1]
                total = cost + abs(sy - s_here)
                if total <= max_m: return total, [p for k, part in enumerate(parts + [piece]) for p in (part if k == 0 else part[1:])]
                continue

            ln = _cum(g)[-1]
            heapq.heappush(heap, (cost + ln, next(tick), other, eid, tuple(-v for v in _leave_dir(g[::-1])), parts + [g]))

    return None

def _graph_path(net, a: Pt, b: Pt, max_m: float = MAX_SPAN_M) -> list | None:
    """The rail from a to b across junctions (a platform past a switch, on either track): points, or None"""
    ca, cb = _cands(net, a, ON_RAIL_M * 2, 3), _cands(net, b, ON_RAIL_M * 2, 3)
    ca, cb = [c for c in ca if c[0] <= ca[0][0] + 1.0], [c for c in cb if c[0] <= cb[0][0] + 1.0]          # the rail each end is on (or the pieces meeting there), not the track beside it
    best, limit = None, min(max_m, haversine(a, b) * 1.3 + 15.0)          # a platform runs nearly straight: no detours round loops or crossovers
    for x in ca[:2]:
        for y in cb[:2]:
            r = _graph_between(net, x, y, limit)
            if r and (best is None or r[0] < best[0]): best = r

    return [tuple(a)] + [tuple(p) for p in best[1][1:-1]] + [tuple(b)] if best else None

def walk(net, a: Pt, b: Pt, max_m: float = MAX_SPAN_M) -> list | None:
    """The rail from a to b (both on rails): points about STEP_M apart, or None when they are not on one continuous track."""
    pts = _walk_steps(net, a, b, max_m) or _graph_path(net, tuple(a), tuple(b), max_m)
    if pts: return pts
    total = haversine(a, b)
    if total < 2.0 or total > max_m: return None
    c = _cands(net, a, GAP_M, 1)
    if not c: return None
    ref = ((b[0] - a[0]) * 111320.0, (b[1] - a[1]) * 111320.0 * math.cos(math.radians(a[0])))
    out = [tuple(a)] + _ride(net, tuple(a), c[0][1].id, _tangent(c[0], ref), total * 1.25 + 10.0)
    i = min(range(len(out)), key=lambda j: haversine(out[j], b))
    if haversine(out[i], b) > STEP_M * 1.2: return None
    if not any(cb[0] <= ON_RAIL_M for cb in _cands(net, b, ON_RAIL_M, 1)): return None
    return out[:i + 1] + [tuple(b)]

def _span(pts: list, **extra) -> dict:
    ln = sum(haversine(x, y) for x, y in zip(pts, pts[1:]))
    return {'a': R6(pts[0]), 'b': R6(pts[-1]), 'mid': _mid(pts), 'length_m': round(ln, 1), 'pts': [R6(p) for p in pts], **extra}

def span_through(net, a: Pt, b: Pt) -> dict | None:
    """The platform between two points that are on rails (an end was dragged)."""
    pts = walk(net, tuple(a), tuple(b))
    return _span(pts) if pts else None

def span_between(net, a: Pt, b: Pt, max_m: float = 30.0) -> dict | None:
    """Two points clicked near a rail -> the platform between them (None when they are not on one continuous track)."""
    sa, sb = snap_point(net, a, max_m), snap_point(net, b, max_m)
    if not sa or not sb: return None
    sp = span_through(net, tuple(sa['point']), tuple(sb['point']))
    if sp: sp['dist_m'] = round((sa['dist_m'] + sb['dist_m']) / 2, 1)
    return sp

def _on_one_edge(net, a: Pt, b: Pt) -> list | None:
    """Both ends on the same piece of rail: that piece's geometry between them (no walking, no search)."""
    total = haversine(a, b)
    if total < 2.0 or total > MAX_SPAN_M: return None
    ca, cb = _cands(net, a, ON_RAIL_M, 3), _cands(net, b, ON_RAIL_M, 3)
    ca, cb = [c for c in ca if c[0] <= ca[0][0] + 1.0], [c for c in cb if c[0] <= cb[0][0] + 1.0]
    for _tot, x, y in sorted(((x[0] + y[0], x, y) for x in ca for y in cb if x[1].id == y[1].id), key=lambda t: t[0]):          # the rail the ends are on, never the track beside it
        g = x[1].geom; cum = _cum(g)
        s0, s1 = _s_of(g, cum, x[2], x[3]), _s_of(g, cum, y[2], y[3])
        if abs(s1 - s0) < 1.0 or abs(s1 - s0) > total * 1.5 + 3.0: continue
        pts = _sub(g, cum, min(s0, s1), max(s0, s1))
        return pts if s0 <= s1 else pts[::-1]

    return None

def shape(net, span) -> list | None:
    """The rail a stored span covers, for drawing: [[lat, lon], ...] (None when the rail is not there any more)."""
    a, b = tuple(span[0]), tuple(span[1])
    pts = _on_one_edge(net, a, b) or walk(net, a, b)
    return [R6(p) for p in pts] if pts else None

def _tangent(c, ref) -> tuple[float, float]:
    """Unit direction (lat, lon scaled to metres) of the rail at a candidate, turned to point the way `ref` points."""
    _d, e, i, _t, _q = c; a, b = e.geom[i], e.geom[i + 1]
    dy, dx = (b[0] - a[0]) * 111320.0, (b[1] - a[1]) * 111320.0 * math.cos(math.radians(a[0]))
    n = math.hypot(dx, dy) or 1.0; dy, dx = dy / n, dx / n
    return (dy, dx) if dy * ref[0] + dx * ref[1] >= 0 else (-dy, -dx)

def _dist_poly(p, pts) -> float:
    """Metres from a point to a polyline [[lat, lon], ...]."""
    kx, ky = 111320.0 * math.cos(math.radians(p[0])), 110540.0; best = float('inf')
    for a, b in zip(pts, pts[1:]):
        ax, ay, bx, by = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky, (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
        dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))

    return best

def _taken(m, avoid) -> bool:
    """Is this rail point on a platform already placed (avoid: their polylines)? Two platforms of a set never share a track."""
    return bool(avoid) and any(_dist_poly(m, a) < 1.8 for a in avoid)

def _ride(net, m: Pt, eid, d: tuple, dist: float) -> list:
    """Points dist metres along the rail from m in direction d, staying on that rail"""
    q, prev, out, done = tuple(m), eid, [], 0.0
    while done < dist - 0.2:
        step = min(STEP_M, dist - done); nxt = None
        for k in range(1, BRIDGE_STEPS + 1):
            p = (q[0] + d[0] * step * k / 111320.0, q[1] + d[1] * step * k / (111320.0 * math.cos(math.radians(q[0]))))
            cs = _cands(net, p, GAP_M)
            best = None
            for c in cs:
                if c[0] > ON_RAIL_M: continue
                nq = _on(c); prog = ((nq[0] - q[0]) * 111320.0 * d[0] + (nq[1] - q[1]) * 111320.0 * math.cos(math.radians(q[0])) * d[1])
                if prog < 0.3 * step: continue                      # the end of the piece we are on, or something behind: no way forward
                tg = _tangent(c, d); score = tg[0] * d[0] + tg[1] * d[1] - c[0] * 0.15 + (0.3 if c[1].id == prev else 0.0)
                if best is None or score > best[0]: best = (score, c, nq)

            if not best: continue
            pick, nq = best[1], best[2]
            if haversine(q, nq) > step * (k + 0.8) + 1.0: continue
            nxt = (pick, nq); break

        if not nxt: break
        pick, nq = nxt; d = _tangent(pick, d); moved = haversine(q, nq)
        if moved < 0.05: break
        q, prev = nq, pick[1].id; out.append(q); done += moved

    return out

def _centered(net, c, ref: tuple, length_m: float) -> dict | None:
    """A platform of about length_m centred on the rail point of candidate c, laid along the rail (None when under 8 m of rail)."""
    m = _on(c); d = _tangent(c, ref)
    fwd, back = _ride(net, m, c[1].id, d, length_m / 2), _ride(net, m, c[1].id, (-d[0], -d[1]), length_m / 2)
    pts = back[::-1] + [m] + fwd
    return _span(pts) if sum(haversine(x, y) for x, y in zip(pts, pts[1:])) >= 8.0 else None

def slide(net, to: Pt, a: Pt, b: Pt, avoid=None) -> dict | None:
    """The same platform (same length, same direction) centred on the rail nearest `to`: drag a platform onto another track."""
    L = haversine(a, b)
    ref = ((b[0] - a[0]) * 111320.0, (b[1] - a[1]) * 111320.0 * math.cos(math.radians(a[0])))
    for c in _cands(net, to, 30.0, 4):
        if _taken(_on(c), avoid): continue
        sp = _centered(net, c, ref, L)
        if sp: return sp

    return None

def default_span(net, p: Pt, length_m: float = 80.0, max_m: float = 40.0, avoid=None) -> dict | None:
    """A platform of about `length_m` centred on the rail nearest `p` (shorter if the rail ends sooner)."""
    for c in _cands(net, p, max_m, 6 if avoid else 3):
        if _taken(_on(c), avoid): continue
        sp = _centered(net, c, (1.0, 0.0), length_m)
        if sp: return sp

    return None

def _parallel_tracks(net, at: Pt, ty: float, tx: float, reach: float = 24.0, step: float = 0.75) -> list:
    """Offsets (metres, across the track from `at`) of the tracks running alongside the one at `at`, found by probing a line across them."""
    py, px = -tx, ty; kx = 111320.0 * math.cos(math.radians(at[0])); hits = []
    for i in range(-int(reach / step), int(reach / step) + 1):
        off = i * step; t = (at[0] + py * off / 111320.0, at[1] + px * off / kx)
        for c in _cands(net, t, 1.0, 3):
            cy, cx = _tangent(c, (ty, tx))
            if abs(cy * ty + cx * tx) >= 0.9: hits.append((off, c[0])); break          # a rail running the same way (not one crossing)

    tracks: list = []
    for h in hits:
        if tracks and h[0] - tracks[-1][-1][0] <= step * 1.6: tracks[-1].append(h)
        else: tracks.append([h])

    return [min(tr, key=lambda x: x[1])[0] for tr in tracks]

def platform_set(net, at: Pt, count: int = 2, length_m: float = 80.0, max_m: float = 40.0) -> list | None:
    """count platforms of length_m on adjacent parallel tracks around at -> one span each, or None"""
    cs = _cands(net, at, max_m, 3)
    if not cs: return None
    ty, tx = _tangent(cs[0], (1.0, 0.0)); py, px = -tx, ty                 # along the track, and across it
    offs = _parallel_tracks(net, at, ty, tx)
    if not offs: offs = [0.0]
    count = max(1, int(count)); k = min(count, len(offs))
    best = min(range(len(offs) - k + 1), key=lambda i: abs(sum(offs[i:i + k]) / k))      # the run of adjacent tracks centred nearest the click
    chosen = offs[best:best + k]
    out, used = [], []
    for off in chosen:
        t = (at[0] + py * off / 111320.0, at[1] + px * off / (111320.0 * math.cos(math.radians(at[0]))))
        sp = default_span(net, t, length_m, 2.5, avoid=used)
        out.append(sp)
        if sp: used.append(sp['pts'])

    return out + [None] * (count - len(out))

def move_set(net, spans, dlat: float, dlng: float) -> list | None:
    """Moves several platforms by the same offset onto their nearest rails -> new spans, or None if one does not fit"""
    out, used = [], []
    for a, b in spans:
        sp = slide(net, ((a[0] + b[0]) / 2 + dlat, (a[1] + b[1]) / 2 + dlng), tuple(a), tuple(b), avoid=used)
        if not sp: return None
        used.append(sp['pts']); out.append(sp)

    return out

def follow(net, span) -> dict | None:
    """A platform's span after its rail moved. None = nothing to do (still on the rail, or no rail close enough to follow)."""
    a, b = tuple(span[0]), tuple(span[1])
    near = lambda p, m: bool(_cands(net, p, m, 1))
    if near(a, ON_RAIL_M) and near(b, ON_RAIL_M) and walk(net, a, b): return None
    ca, cb = _cands(net, a, FOLLOW_M, 3), _cands(net, b, FOLLOW_M, 3)
    pairs = sorted(((x[0] + y[0], x, y) for x in ca for y in cb), key=lambda t: t[0])       # the pair that moves least first
    for _tot, x, y in pairs:
        pa, pb = _on(x), _on(y)
        if haversine(pa, pb) < 3.0: continue
        sp = span_through(net, pa, pb)
        if sp: return sp if (sp['a'], sp['b']) != (R6(a), R6(b)) else None

    return None

# OSM platform outlines (railway=platform, platform_edge, public_transport=platform), rebuilt with the rail graph (refresh_osm.py) into devtools/cache/osm_platforms.sqlite; nothing in the map data uses them
OSM_DB = os.path.join(config.CACHE_DIR, 'osm_platforms.sqlite')
_osm_local = threading.local()

def osm_is_platform(tags) -> bool:
    return tags.get('railway') in ('platform', 'platform_edge') or tags.get('public_transport') == 'platform'

def osm_outline_name(tags) -> str:
    return tags.get('name') or tags.get('ref') or tags.get('local_ref') or ''

# lat, lon as 1e-7 degree integers (the same packing the rail graph uses)
def osm_pack(pts) -> bytes:
    a = array('i')
    for la, lo in pts: a.append(round(la * 1e7)); a.append(round(lo * 1e7))
    return a.tobytes()

def osm_unpack(b: bytes) -> list:
    a = array('i'); a.frombytes(b)
    return [(a[i] / 1e7, a[i + 1] / 1e7) for i in range(0, len(a), 2)]

def _osm_connect():
    c = getattr(_osm_local, 'c', None)
    if c is None or getattr(_osm_local, 'path', None) != OSM_DB:
        c = _osm_local.c = sqlite3.connect(f'file:{OSM_DB}?mode=ro', uri=True, check_same_thread=False); _osm_local.path = OSM_DB

    return c

def osm_ready() -> bool:
    return os.path.exists(OSM_DB)

def osm_query(s: float, w: float, n: float, e: float, limit: int = 6000) -> list:
    """Outlines touching the box: [{'p': [[lat, lon], ...], 'a': closed, 'e': is a platform edge, 'n': name}]"""
    if not osm_ready(): return []
    try:
        rows = _osm_connect().execute("SELECT p.closed, p.edge, p.name, p.geom FROM plat_idx i JOIN plat p ON p.id = i.id "
                                  "WHERE i.maxlat >= ? AND i.minlat <= ? AND i.maxlon >= ? AND i.minlon <= ? LIMIT ?", (s, n, w, e, limit)).fetchall()
    except sqlite3.Error:
        return []

    return [{'p': [[round(a, 7), round(b, 7)] for a, b in osm_unpack(g)], 'a': bool(c), 'e': bool(ed), 'n': nm or ''} for c, ed, nm, g in rows]

def osm_write(features, path: str = OSM_DB) -> int:
    """features: iterable of (osm id, closed, edge, name, [(lat, lon), ...]); replaces the database"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    if os.path.exists(tmp): os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("CREATE TABLE plat (id INTEGER PRIMARY KEY, closed INTEGER, edge INTEGER, name TEXT, geom BLOB NOT NULL);"
                     "CREATE VIRTUAL TABLE plat_idx USING rtree(id, minlat, maxlat, minlon, maxlon);")
    n = 0
    for i, (oid, closed, edge, name, pts) in enumerate(features, 1):
        db.execute("INSERT INTO plat VALUES (?,?,?,?,?)", (i, int(closed), int(edge), name or '', osm_pack(pts)))
        db.execute("INSERT INTO plat_idx VALUES (?,?,?,?,?)", (i, min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts)))
        n += 1

    db.commit(); db.close(); os.replace(tmp, path)
    return n

def osm_relation_ways(pbf: str) -> dict:
    """{way id: name} of the ways outlining platform relations (multipolygons): they are often untagged themselves"""
    import osmium
    out = {}
    for r in osmium.FileProcessor(pbf, osmium.osm.RELATION).with_filter(osmium.filter.KeyFilter('railway', 'public_transport')):
        if not osm_is_platform(r.tags): continue
        for m in r.members:
            if m.type == 'w' and m.role in ('outer', 'platform', ''): out[m.ref] = osm_outline_name(r.tags)

    return out

def osm_build(pbf: str, path: str = OSM_DB, log=print) -> int:
    """Platform outlines of an extract (the rail-filtered one keeps them, see ingest.prefilter) -> the local database"""
    import osmium
    rel = osm_relation_ways(pbf); out, seen = [], set()
    def read(flt):
        for w in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations('flex_mem').with_filter(flt):
            if not w.is_way() or w.id in seen or not (osm_is_platform(w.tags) or w.id in rel): continue
            try: pts = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
            except osmium.InvalidLocationError: continue
            seen.add(w.id)
            if len(pts) >= 2: out.append((w.id, len(pts) > 3 and pts[0] == pts[-1], w.tags.get('railway') == 'platform_edge', osm_outline_name(w.tags) or rel.get(w.id, ''), pts))

    read(osmium.filter.KeyFilter('railway', 'public_transport'))
    left = [i for i in rel if i not in seen]
    if left: read(osmium.filter.IdFilter(left))                    # untagged outline ways of platform relations
    n = osm_write(out, path)
    log(f"{n:,} OSM platform outlines -> {path}")
    return n