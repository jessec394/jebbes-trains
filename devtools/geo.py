from __future__ import annotations
import math

R = 6371008.8
Pt = tuple[float, float]  # (lat, lon)


def haversine(a: Pt, b: Pt) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def path_length(pts: list[Pt]) -> float:
    return sum(haversine(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def _xy(p: Pt, lat0: float) -> tuple[float, float]:
    return (math.radians(p[1]) * R * math.cos(math.radians(lat0)), math.radians(p[0]) * R)


def project_on_segment(p: Pt, a: Pt, b: Pt) -> tuple[float, float, Pt]:
    """-> (distance_m, t in [0,1], nearest point) using a local flat projection."""
    lat0 = p[0]
    px, py = _xy(p, lat0); ax, ay = _xy(a, lat0); bx, by = _xy(b, lat0)
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    return math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t, q


def project_on_path(p: Pt, pts: list[Pt]) -> tuple[float, int, float, Pt]:
    """-> (distance_m, segment index, t within segment, nearest point)."""
    best = (float('inf'), 0, 0.0, pts[0])
    for i in range(len(pts) - 1):
        d, t, q = project_on_segment(p, pts[i], pts[i + 1])
        if d < best[0]:
            best = (d, i, t, q)
    return best


def cut_path(pts: list[Pt], i: int, t: float, q: Pt) -> tuple[list[Pt], list[Pt]]:
    """Split a path at (segment i, fraction t, point q) into (before, after), both containing q."""
    before = pts[:i + 1] + [q]
    after = [q] + pts[i + 1:]
    return _dedupe(before), _dedupe(after)


def _dedupe(pts: list[Pt]) -> list[Pt]:
    out: list[Pt] = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    if len(out) == 1:
        out.append(out[0])
    return out


def bbox_of(pts: list[Pt]) -> tuple[float, float, float, float]:
    lats = [p[0] for p in pts]; lons = [p[1] for p in pts]
    return min(lats), min(lons), max(lats), max(lons)


def pad_bbox(b, meters: float):
    dlat = meters / 111320.0
    dlon = meters / (111320.0 * max(0.05, math.cos(math.radians((b[0] + b[2]) / 2))))
    return b[0] - dlat, b[1] - dlon, b[2] + dlat, b[3] + dlon


def simplify(pts: list[Pt], tol_m: float) -> list[Pt]:
    """Iterative Douglas-Peucker."""
    n = len(pts)
    if n < 3 or tol_m <= 0:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        if e <= s + 1:
            continue
        dmax, idx = -1.0, -1
        for i in range(s + 1, e):
            d, _, _ = project_on_segment(pts[i], pts[s], pts[e])
            if d > dmax:
                dmax, idx = d, i
        if dmax > tol_m:
            keep[idx] = True
            stack += [(s, idx), (idx, e)]
    return [p for p, k in zip(pts, keep) if k]


def densify(pts: list[Pt], step_m: float) -> list[Pt]:
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, math.ceil(haversine(a, b) / step_m))
        out += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(1, n + 1)]
    return out


def novel_runs(path: list[Pt], reference: list[Pt], tol_m: float = 7.0, min_run_m: float = 25.0) -> list[list[Pt]]:
    """Parts of `path` that do NOT lie on `reference` (i.e. not a retrace).
    Each run includes the neighbouring covered point so it joins up visually."""
    ref = densify(reference, tol_m * 0.7)
    min_cos = max(0.05, math.cos(math.radians(max(abs(p[0]) for p in ref))))
    dlat = tol_m / 111320.0
    dlon = dlat / min_cos
    grid: dict[tuple[int, int], list[Pt]] = {}
    for p in ref:
        grid.setdefault((int(p[0] // dlat), int(p[1] // dlon)), []).append(p)

    def covered(p: Pt) -> bool:
        ci, cj = int(p[0] // dlat), int(p[1] // dlon)
        for i in (ci - 1, ci, ci + 1):
            for j in (cj - 1, cj, cj + 1):
                for q in grid.get((i, j), ()):
                    if haversine(p, q) <= tol_m:
                        return True
        return False

    dense = densify(path, 10.0)
    flags = [covered(p) for p in dense]
    runs, cur = [], None
    for i, (p, c) in enumerate(zip(dense, flags)):
        if not c:
            if cur is None:
                cur = [dense[i - 1]] if i > 0 else []
            cur.append(p)
        elif cur is not None:
            cur.append(p); runs.append(cur); cur = None
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= 2 and path_length(r) >= min_run_m]


def offset_polyline(pts: list[Pt], d_m: float) -> list[Pt]:
    """Parallel copy of a polyline, d_m metres to the left of travel (negative = right). Keeps the vertex count
    (mitred corners, clamped) so indices into the original stay valid."""
    per_vertex = isinstance(d_m, (list, tuple))           # d_m may also be one distance per vertex (a lane that narrows or widens)
    if len(pts) < 2 or (not per_vertex and abs(d_m) < 1e-9):
        return [tuple(p) for p in pts]
    lat0 = pts[0][0]
    kx = 111320.0 * math.cos(math.radians(lat0)); ky = 111320.0
    xy = [(p[1] * kx, p[0] * ky) for p in pts]
    norms = []
    for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
        dx, dy = x1 - x0, y1 - y0; L = math.hypot(dx, dy) or 1.0
        norms.append((-dy / L, dx / L))
    out = []
    for i, (x, y) in enumerate(xy):
        if i == 0: nx, ny = norms[0]; m = 1.0
        elif i == len(xy) - 1: nx, ny = norms[-1]; m = 1.0
        else:
            ax, ay = norms[i - 1]; bx, by = norms[i]
            nx, ny = ax + bx, ay + by; L = math.hypot(nx, ny)
            if L < 1e-6: nx, ny, m = ax, ay, 1.0
            else:
                nx, ny = nx / L, ny / L
                m = min(2.0, 1.0 / max(0.5, nx * ax + ny * ay))
        dd = d_m[i] if per_vertex else d_m
        out.append(((y + ny * dd * m) / ky, (x + nx * dd * m) / kx))
    return out