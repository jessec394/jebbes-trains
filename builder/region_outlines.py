"""
Builds the splash-screen map of North America from the country outlines in
data/regions/.

Everything heavy happens here, once, at build time: the raw geoBoundaries
files are several MB each, but the splash only needs pre-projected,
simplified SVG path strings. The browser drops them straight into <path>
elements -- no GeoJSON parsing, projection or simplification on page load.

Two views come out of this, both in the same (conformal) projection so the
browser can animate smoothly from one to the other with a plain scale +
translate:

  Continent view -- every country (ADM0), zoomed so the south of the
      continent fills the disc (see FIT_NORTH_LAT / FIT_ANCHORS). The far
      north -- northern Alaska, the Arctic coast, Canada's Arctic islands --
      is still drawn but spills past the disc edge and disappears under the
      flag ring. Nothing is cut off with a hard line.

  Country view -- one per country: its first-level subdivisions (ADM1),
      zoomed so the whole country fills the disc (minus anything in
      COUNTRY_VIEW_EXCLUDED -- Alaska, for the United States).

Hawaii, Guam and the other subdivisions in EXCLUDED_SUBDIVISIONS are dropped
from both views.
"""

from __future__ import annotations

import glob
import json
import math
import os
import re
import unicodedata
from typing import Any

import numpy as np   # already installed: folium depends on it

from builder.types import FilePath


# ── Tunables ──────────────────────────────────────────────────────────────────

# Continent view framing. The disc is a circle, and North America's far
# corners (northwest Alaska and Trinidad) sit almost diametrically opposite
# each other -- so any circle holding both is centred near Hudson Bay, and
# the Arctic coast lands well inside the frame. To zoom in and let the north
# spill out under the flags instead, the map is sized to fit only:
#   * land south of FIT_NORTH_LAT, plus
#   * FIT_ANCHORS: extra (lon, lat) points that must stay inside the frame.
# Everything else is still drawn; it just may fall outside the disc.
# With the defaults, Alaska falls out of frame along with the Arctic: it sits
# even farther from the Caribbean than the Arctic coast does. Lower
# FIT_NORTH_LAT / drop anchors to zoom in; raise / add anchors to zoom out.
FIT_NORTH_LAT: float = 50.0
FIT_ANCHORS: list[tuple[float, float]] = [
    # (-134.4, 58.3),   # e.g. Juneau: brings the Alaska Panhandle back into frame,
    #                   # at the cost of ~10% zoom and the Arctic islands peeking in
]

# Country views close up big empty gaps: landmasses separated from the rest
# of their country by more than COMPACT_GAP_THRESHOLD (a fraction of the
# country's overall span) are slid straight toward the main landmass until
# only COMPACT_TARGET_GAP (a fraction of the main landmass's span) is left --
# like the insets on a printed map. Puerto Rico ends up off Florida, Mexico's
# Revillagigedo Islands off Baja, Costa Rica's Cocos Island off the Pacific
# coast. Island chains (the Bahamas, the Grenadines) have gaps well under the
# threshold and stay as they are. Set the threshold to 1.0 to disable.
COMPACT_GAP_THRESHOLD: float = 0.10
COMPACT_TARGET_GAP:    float = 0.06

# First-level subdivisions (ADM1 'shapeISO' codes) that aren't part of the
# continent or the Caribbean, keyed by country file code. They're left out of
# the country's subdivision view, and any ADM0 polygon inside one is dropped
# from the continent view.
EXCLUDED_SUBDIVISIONS: dict[str, frozenset[str]] = {
    'USA': frozenset({
        'US-HI',   # Hawaii
        'US-GU',   # Guam
        'US-MP',   # Northern Mariana Islands
        'US-AS',   # American Samoa
        'US-UM',   # U.S. Minor Outlying Islands (if present in the data)
    }),
}

# Subdivisions left out of a country's own close-up view only (they still
# appear on the continent). Alaska would otherwise shrink the contiguous
# states to a third of the disc.
COUNTRY_VIEW_EXCLUDED: dict[str, frozenset[str]] = {
    'USA': frozenset({'US-AK'}),
}

# Lambert conformal conic, standard parallels 20°N/60°N, central meridian
# 100°W -- the familiar "atlas" framing of North America, with true shapes.
_STD_PARALLEL_1: float = 20.0
_STD_PARALLEL_2: float = 60.0
_CENTRAL_MERIDIAN: float = -100.0

# Output coordinate space: a SIZE x SIZE square whose inscribed circle is the
# visible disc. Margins are breathing room inside that circle.
SIZE:           int   = 1000
MARGIN:         float = 6.0      # continent view
COUNTRY_MARGIN: float = 60.0     # country view (keeps clear of the back button)

SIMPLIFY_TOLERANCE: float = 0.6    # output units (≈ one screen pixel at most patch sizes)
MIN_RING_AREA:      float = 1.2    # output units²; smaller islands are dropped, except
                                   # each country's / subdivision's largest polygon
SMALL_COUNTRY_SIZE: float = 16.0   # countries smaller than this (bbox, output units) get a hover target
HIT_RADIUS:         float = 11.0
SMALL_SUB_SIZE:     float = 7.0    # same idea for subdivisions in the country view
SUB_HIT_RADIUS:     float = 6.0

# Clicking a subdivision zooms it to fill the disc on its own (map.js:
# SPLASH_ISOLATE_RADIUS, capped at 80x). Small ones (DC, Rhode Island, island
# parishes) are magnified so far that the country-scale outline looks crude,
# so any subdivision magnified more than FINE_OUTLINE_MIN_ZOOM also gets a
# finer outline ('DFine'), simplified for its isolated scale.
ISOLATE_RADIUS:        float = 410.0
ISOLATE_MAX_ZOOM:      float = 80.0
FINE_OUTLINE_MIN_ZOOM: float = 6.0

# Rail lines drawn on the globe. Tolerances are in output units (the disc is
# 1000 across); country views are finer because they're zoomed further still
# when a station's subdivision is shown.
LINE_TOLERANCE_CONTINENT: float = 0.5
LINE_TOLERANCE_COUNTRY:   float = 0.2
LINE_WIDTH_PER_WEIGHT:    float = 0.26   # on-screen px per unit of a mode's map Weight...
LINE_WIDTH_RANGE: tuple[float, float] = (0.8, 2.2)   # ...clamped to this

_FILE_RE = re.compile(r'(?:^|[-_])([A-Z]{3})-ADM([01])', re.IGNORECASE)


# ── Projection ────────────────────────────────────────────────────────────────

class _LambertConformal:
    """Lambert conformal conic. Conformal means shapes are locally true: a
    state or province looks the right proportions at any zoom (an equal-area
    projection, used previously, stretched mid-latitude states ~13%
    north-south). The price is area exaggeration far from the standard
    parallels, which in this framing is mostly the Arctic, out of frame."""

    def __init__(self, phi1: float, phi2: float, lon0: float) -> None:
        p1, p2 = math.radians(phi1), math.radians(phi2)
        t = lambda p: math.tan(math.pi / 4 + p / 2)
        self.n = math.log(math.cos(p1) / math.cos(p2)) / math.log(t(p2) / t(p1))
        self.F = math.cos(p1) * t(p1) ** self.n / self.n
        self.lon0 = lon0

    def rho(self, lat: float) -> float:
        lat = max(min(lat, 89.9), -89.9)
        return self.F / math.tan(math.pi / 4 + math.radians(lat) / 2) ** self.n

    def convergence(self, lon: float) -> float:
        """How far (degrees, clockwise) north is rotated at this longitude."""
        return math.degrees(self.n * math.radians((lon - self.lon0 + 180.0) % 360.0 - 180.0))

    def __call__(self, lon: float, lat: float) -> tuple[float, float]:
        # Wrapping the longitude difference keeps the Aleutians that cross the
        # antimeridian (stored as +173°..+180°) attached to the rest of Alaska.
        d = (lon - self.lon0 + 180.0) % 360.0 - 180.0
        theta = self.n * math.radians(d)
        r = self.rho(lat)
        # Apex of the cone at the origin; y grows downward (SVG convention).
        return r * math.sin(theta), r * math.cos(theta)


# ── Geometry helpers ──────────────────────────────────────────────────────────

def _wrap_lon(lon: float) -> float:
    """Longitude in the western-hemisphere-friendly range [-270, 90): the
    Aleutians past the antimeridian (+172°..+180°) come out as -188°..-180°."""
    return lon - 360.0 if lon >= 90.0 else lon


def _polygons(geometry: dict[str, Any] | None) -> list[list[list[list[float]]]]:
    if not geometry:
        return []
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return list(geometry['coordinates'])
    if geometry['type'] == 'GeometryCollection':
        return [p for g in geometry.get('geometries', []) for p in _polygons(g)]
    return []


def _bbox(ring: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return min(xs), min(ys), max(xs), max(ys)


def _point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _ring_area(pts: list[tuple[float, float]]) -> float:
    a = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i - 1]
        x2, y2 = pts[i]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def _simplify(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Iterative Ramer–Douglas–Peucker on an open polyline."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        best, best_i = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if seg2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg2
                t = max(0.0, min(1.0, t))
                d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d2 > best:
                best, best_i = d2, i
        if best > tol2:
            keep[best_i] = True
            stack.append((a, best_i))
            stack.append((best_i, b))
    return [p for p, k in zip(pts, keep) if k]


def _thin(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Cheap first pass: drop vertices within `tol` of the last kept one.
    Full-resolution source files can carry hundreds of thousands of points
    per country; this shrinks them before the costlier RDP pass."""
    if len(pts) < 3:
        return pts
    tol2 = tol * tol
    out = [pts[0]]
    for p in pts[1:-1]:
        q = out[-1]
        if (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 >= tol2:
            out.append(p)
    out.append(pts[-1])
    return out


def _simplify_ring(pts: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """RDP for a closed ring: split at the vertex farthest from the first one
    so both halves are anchored at points guaranteed to stay."""
    pts = _thin(pts, tol / 2)
    if pts and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 4:
        return pts
    x0, y0 = pts[0]
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - x0) ** 2 + (pts[i][1] - y0) ** 2)
    first = _simplify(pts[:far + 1], tol)
    second = _simplify(pts[far:] + [pts[0]], tol)
    return first[:-1] + second[:-1]


def _path(rings: list[list[tuple[float, float]]], decimals: int = 1) -> str:
    """Compact SVG path: absolute move per ring, then relative line deltas,
    at `decimals` decimal places."""
    parts: list[str] = []
    f = 10 ** decimals
    for ring in rings:
        q = [(round(x * f), round(y * f)) for x, y in ring]
        deduped = [q[0]]
        for p in q[1:]:
            if p != deduped[-1]:
                deduped.append(p)
        if len(deduped) < 3:
            continue
        x, y = deduped[0]
        seg = [f'M{x / f:g} {y / f:g}l']
        deltas = []
        for nx, ny in deduped[1:]:
            deltas.append(f'{(nx - x) / f:g} {(ny - y) / f:g}')
            x, y = nx, ny
        seg.append(' '.join(deltas))
        seg.append('z')
        parts.append(''.join(seg))
    # Negative numbers separate themselves; drop the redundant spaces before them.
    return ''.join(parts).replace(' -', '-')


def _enclosing_circle(points: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Smallest circle containing every point (Welzl's algorithm on the convex
    hull, which keeps the input small)."""
    pts = sorted(set(points))
    if len(pts) == 1:
        return pts[0][0], pts[0][1], 0.0
    if len(pts) <= 2:
        (x1, y1), (x2, y2) = pts[0], pts[-1]
        return (x1 + x2) / 2, (y1 + y2) / 2, math.dist(pts[0], pts[-1]) / 2

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[tuple[float, float]] = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]

    def circle2(a, b):
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, math.dist(a, b) / 2)

    def circle3(a, b, c):
        d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
        if abs(d) < 1e-12:
            return max((circle2(a, b), circle2(a, c), circle2(b, c)), key=lambda k: k[2])
        ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d
        uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d
        return ux, uy, math.dist((ux, uy), a)

    def inside(c, p):
        return math.dist((c[0], c[1]), p) <= c[2] * (1 + 1e-9) + 1e-9

    c = (hull[0][0], hull[0][1], 0.0)
    for i, p in enumerate(hull):
        if inside(c, p):
            continue
        c = (p[0], p[1], 0.0)
        for j in range(i):
            q = hull[j]
            if inside(c, q):
                continue
            c = circle2(p, q)
            for k in range(j):
                if not inside(c, hull[k]):
                    c = circle3(p, q, hull[k])
    return c


# ── Data loading ──────────────────────────────────────────────────────────────

def _load(path: FilePath) -> dict[str, Any]:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def _excluded_bounds(adm1: dict[str, Any] | None, codes: frozenset[str]) -> list[tuple[list[list[float]], tuple[float, float, float, float]]]:
    """Outer rings (with their bboxes) of every excluded subdivision."""
    if not adm1 or not codes:
        return []
    rings = []
    for feature in adm1.get('features', []):
        props = feature.get('properties') or {}
        if (props.get('shapeISO') or '').upper() not in codes:
            continue
        for poly in _polygons(feature.get('geometry')):
            if poly and poly[0]:
                rings.append((poly[0], _bbox(poly[0])))
    return rings


def _in_excluded(poly: list[list[list[float]]], excluded) -> bool:
    if not excluded:
        return False
    x0, y0, x1, y1 = _bbox(poly[0])
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for ring, (ex0, ey0, ex1, ey1) in excluded:
        # Whole-bbox containment catches islands drawn slightly differently
        # in the ADM0 and ADM1 files; point-in-ring catches the rest.
        if ex0 - 0.05 <= x0 and x1 <= ex1 + 0.05 and ey0 - 0.05 <= y0 and y1 <= ey1 + 0.05:
            return True
        if ex0 <= cx <= ex1 and ey0 <= cy <= ey1 and _point_in_ring(cx, cy, ring):
            return True
    return False


def _find_files(regions_dir: FilePath) -> dict[str, dict[int, FilePath]]:
    found: dict[str, dict[int, FilePath]] = {}
    for path in sorted(glob.glob(os.path.join(regions_dir, '*.geojson')) + glob.glob(os.path.join(regions_dir, '*.json'))):
        m = _FILE_RE.search(os.path.basename(path))
        if not m:
            continue
        code, level = m.group(1).upper(), int(m.group(2))
        # Prefer the '_simplified' variant when both exist.
        current = found.setdefault(code, {}).get(level)
        if current is None or ('simplified' in os.path.basename(path).lower() and 'simplified' not in os.path.basename(current).lower()):
            found[code][level] = path
    return found


# ── Pipeline helpers ──────────────────────────────────────────────────────────

Ring  = list[tuple[float, float]]
Poly  = list[Ring]


def _outline(polys: list[Poly], transform, tol: float = SIMPLIFY_TOLERANCE,
             keep=None, min_area: float = MIN_RING_AREA, decimals: int = 1) -> tuple[str, tuple[float, float, float, float]] | None:
    """Transform, simplify and speck-filter a set of projected polygons into
    one path string. Returns (path, bbox) or None if nothing survives.
    `keep(bbox)` can veto polygons (e.g. ones wholly outside the disc)."""
    out: list[tuple[float, list[Ring]]] = []
    for rings in polys:
        out_rings: list[Ring] = []
        for i, ring in enumerate(rings):
            simplified = _simplify_ring([transform(p) for p in ring], tol)
            if len(simplified) >= 3:
                out_rings.append(simplified)
            elif i == 0:
                break   # exterior collapsed; skip the polygon (and its holes)
        if not out_rings:
            continue
        if keep is not None:
            ext = out_rings[0]
            bb = (min(p[0] for p in ext), min(p[1] for p in ext), max(p[0] for p in ext), max(p[1] for p in ext))
            if not keep(bb):
                continue
        out.append((_ring_area(out_rings[0]), out_rings))
    if not out:
        return None

    largest = max(a for a, _ in out)
    kept = [r for a, rs in out if a >= min_area or a == largest for r in rs]
    pts = [p for r in kept for p in r]
    bbox = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
    return _path(kept, decimals), bbox, kept


def _hit(bbox: tuple[float, float, float, float], small: float, radius: float) -> list[float] | None:
    """A round hover target for shapes too small to point at."""
    x0, y0, x1, y1 = bbox
    if max(x1 - x0, y1 - y0) >= small:
        return None
    return [round((x0 + x1) / 2, 1), round((y0 + y1) / 2, 1), radius]


def _fit(points: list[tuple[float, float]], margin: float):
    """Fit points' enclosing circle into the output disc. Returns
    (transform, (cx, cy, scale))."""
    cx, cy, r = _enclosing_circle(points)
    half = SIZE / 2
    scale = (half - margin) / max(r, 1e-9)

    def transform(p: tuple[float, float]) -> tuple[float, float]:
        return half + (p[0] - cx) * scale, half + (p[1] - cy) * scale

    return transform, (cx, cy, scale)


# ── Compacting far-flung landmasses ──────────────────────────────────────────

Cluster = tuple[tuple[float, float, float, float], float, float]   # (bbox, dx, dy)


def _box_gap(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    dx = max(a[0] - b[2], b[0] - a[2], 0.0)
    dy = max(a[1] - b[3], b[1] - a[3], 0.0)
    return math.hypot(dx, dy)


def _union_box(boxes) -> tuple[float, float, float, float]:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def _sample(polys: list[Poly], step: float) -> np.ndarray:
    """Exterior-ring vertices, thinned to roughly `step` apart -- plenty for
    measuring gaps between landmasses."""
    pts = [p for poly in polys for p in _thin(poly[0], step)]
    return np.array(pts, dtype=float)


def _min_dist(a: np.ndarray, obstacles: list[np.ndarray]) -> float:
    best = math.inf
    for b in obstacles:
        d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2).min()
        best = min(best, float(d2))
    return math.sqrt(best)


def _compact(polys: list[Poly]) -> list[Cluster]:
    """Groups a country's polygons into landmass clusters and works out how
    far to slide each outlying cluster toward the main one. Returns one
    (bbox, dx, dy) per cluster, in projected units; the main cluster's offset
    is always (0, 0)."""
    if not polys:
        return []
    boxes = [_bbox(poly[0]) for poly in polys]
    whole = _union_box(boxes)
    span = math.hypot(whole[2] - whole[0], whole[3] - whole[1])
    link = COMPACT_GAP_THRESHOLD * span

    # Single-linkage clustering on bbox gaps (union-find).
    parent = list(range(len(polys)))
    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    order = sorted(range(len(polys)), key=lambda i: boxes[i][0])
    for n, i in enumerate(order):
        for j in order[n + 1:]:
            if boxes[j][0] - boxes[i][2] > link:
                break   # sorted by left edge: nothing further right can be close
            if _box_gap(boxes[i], boxes[j]) <= link:
                parent[find(i)] = find(j)
    groups: dict[int, list[int]] = {}
    for i in range(len(polys)):
        groups.setdefault(find(i), []).append(i)
    members = list(groups.values())
    cluster_boxes = [_union_box([boxes[i] for i in m]) for m in members]
    if len(members) == 1:
        return [(cluster_boxes[0], 0.0, 0.0)]

    areas = [sum(_ring_area(polys[i][0]) for i in m) for m in members]
    main = max(range(len(members)), key=lambda c: areas[c])
    mb = cluster_boxes[main]
    main_span = math.hypot(mb[2] - mb[0], mb[3] - mb[1])
    gap = COMPACT_TARGET_GAP * main_span
    step = span / 600
    main_center = np.array([(mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2])

    offsets: dict[int, tuple[float, float]] = {main: (0.0, 0.0)}
    obstacles = [_sample([polys[i] for i in members[main]], step)]

    # Nearest outliers first, so later ones settle around earlier ones.
    others = sorted((c for c in range(len(members)) if c != main), key=lambda c: _box_gap(cluster_boxes[c], mb))
    for c in others:
        pts = _sample([polys[i] for i in members[c]], step)
        cb = cluster_boxes[c]
        v = main_center - np.array([(cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2])
        dist = lambda t: _min_dist(pts + t * v, obstacles)

        if dist(0.0) <= gap:
            t = 0.0
        else:
            # March toward the main landmass until the gap closes, then refine.
            lo, hi, steps = 0.0, None, 64
            for k in range(1, steps + 1):
                if dist(k / steps) < gap:
                    hi = k / steps
                    break
                lo = k / steps
            if hi is None:
                t = lo
            else:
                for _ in range(14):
                    mid = (lo + hi) / 2
                    if dist(mid) < gap: hi = mid
                    else:               lo = mid
                t = lo
        offsets[c] = (float(t * v[0]), float(t * v[1]))
        obstacles.append(pts + t * v)

    return [(cluster_boxes[c], offsets[c][0], offsets[c][1]) for c in range(len(members))]


def _shift(poly: Poly, clusters: list[Cluster]) -> Poly:
    """Moves a polygon (from either the ADM0 or the ADM1 file) along with the
    landmass cluster it belongs to."""
    if not clusters or all(dx == 0 and dy == 0 for _, dx, dy in clusters):
        return poly
    bb = _bbox(poly[0])
    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
    _, dx, dy = min(clusters, key=lambda c: _box_gap(c[0], (cx, cy, cx, cy)))
    if dx == 0 and dy == 0:
        return poly
    return [[(x + dx, y + dy) for x, y in ring] for ring in poly]


# ── Rail lines ────────────────────────────────────────────────────────────────

Node = tuple[float, float]   # (lat, lon), rounded


def _line_network(registry: list[dict[str, Any]]) -> dict[str, list[list[Node]]]:
    """All of a registry's line geometry, per mode, as a minimal set of
    polylines: shared track (many patterns and lines ride the same segments)
    is drawn once, and runs of segments are chained end to end."""
    edges: dict[str, set[tuple[Node, Node]]] = {}
    for entry in registry:
        mode = entry.get('ModeId')
        for coords in (entry.get('Geometry') or {}).get('Coords', []):
            nodes = [(round(c[0], 5), round(c[1], 5)) for c in coords]
            bucket = edges.setdefault(mode, set())
            for a, b in zip(nodes, nodes[1:]):
                if a != b:
                    bucket.add((a, b) if a < b else (b, a))
    return {mode: _chain(e) for mode, e in edges.items()}


def _chain(edges: set[tuple[Node, Node]]) -> list[list[Node]]:
    adj: dict[Node, list[Node]] = {}
    for a, b in edges:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    used: set[tuple[Node, Node]] = set()
    key = lambda a, b: (a, b) if a < b else (b, a)

    def walk(start: Node, nxt: Node) -> list[Node]:
        path, prev, cur = [start, nxt], start, nxt
        used.add(key(start, nxt))
        while len(adj[cur]) == 2:
            step = adj[cur][0] if adj[cur][1] == prev else adj[cur][1]
            if key(cur, step) in used:
                break
            used.add(key(cur, step))
            path.append(step)
            prev, cur = cur, step
        return path

    paths: list[list[Node]] = []
    for node, nbrs in adj.items():          # ends and junctions first...
        if len(nbrs) != 2:
            for nb in nbrs:
                if key(node, nb) not in used:
                    paths.append(walk(node, nb))
    for a, b in edges:                       # ...then whatever is left is loops
        if (a, b) not in used:
            paths.append(walk(a, b))
    return paths


def _polyline_path(lines: list[Ring], tol: float) -> str:
    """Open polylines (already in output units) -> compact SVG path. Lines
    that simplify down to a single point at this scale are dropped."""
    parts: list[str] = []
    for pts in lines:
        pts = _simplify(_thin(pts, tol / 2), tol)
        q = [(round(x * 10), round(y * 10)) for x, y in pts]
        dedup = [q[0]]
        for p in q[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        if len(dedup) < 2:
            continue
        x, y = dedup[0]
        deltas = []
        for nx, ny in dedup[1:]:
            deltas.append(f'{(nx - x) / 10:g} {(ny - y) / 10:g}')
            x, y = nx, ny
        parts.append(f'M{dedup[0][0] / 10:g} {dedup[0][1] / 10:g}l' + ' '.join(deltas))
    return ''.join(parts).replace(' -', '-')


def _touches_disc(pts: Ring, pad: float = 20.0) -> bool:
    half = SIZE / 2
    x0 = min(p[0] for p in pts); x1 = max(p[0] for p in pts)
    y0 = min(p[1] for p in pts); y1 = max(p[1] for p in pts)
    nx = min(max(half, x0), x1)
    ny = min(max(half, y0), y1)
    return (nx - half) ** 2 + (ny - half) ** 2 <= (half + pad) ** 2


def _locate(points: np.ndarray, regions: list[tuple[str, list[Ring]]]) -> np.ndarray:
    """Index into `regions` of the region containing each point (even-odd
    over all its rings), or -1. Vectorised; points are tested in chunks."""
    found = np.full(len(points), -1, dtype=np.int32)
    if not len(points):
        return found
    for r, (_, rings) in enumerate(regions):
        if not rings:
            continue
        xs = np.concatenate([np.asarray(ring, dtype=float) for ring in rings])
        x0, y0 = xs.min(axis=0)
        x1, y1 = xs.max(axis=0)
        cand = np.nonzero((found < 0) & (points[:, 0] >= x0) & (points[:, 0] <= x1) &
                          (points[:, 1] >= y0) & (points[:, 1] <= y1))[0]
        if not len(cand):
            continue
        a = np.concatenate([np.asarray(ring, dtype=float) for ring in rings])
        b = np.concatenate([np.roll(np.asarray(ring, dtype=float), -1, axis=0) for ring in rings])
        ax, ay, bx, by = a[:, 0][None, :], a[:, 1][None, :], b[:, 0][None, :], b[:, 1][None, :]
        dy = np.where(by == ay, 1e-12, by - ay)
        for start in range(0, len(cand), 1024):
            idx = cand[start:start + 1024]
            px = points[idx, 0][:, None]
            py = points[idx, 1][:, None]
            crosses = ((ay > py) != (by > py)) & (px < (bx - ax) * (py - ay) / dy + ax)
            inside = (crosses.sum(axis=1) % 2) == 1
            found[idx[inside]] = r
    return found


# Where along each segment to look for the region(s) it's in: midpoint first
# (it decides which region "owns" the segment), then the ends, then quarters.
_SEGMENT_SAMPLES = (0.5, 0.0, 1.0, 0.25, 0.75)


def _region_lines(networks: dict[str, dict[str, list[list[tuple[float, float]]]]], transform, tol: float,
                  regions: list[tuple[str, list[Ring]]], select=None,
                  keep_unassigned: bool = False) -> dict[str, dict[str, dict[str, str]]]:
    """{category: {region key: {mode: path}}} for one view.

    Each segment (station to station) is owned by one region: the one its
    midpoint is in, or failing that its ends / quarter points (a coastal
    stretch whose midpoint is just offshore). Unowned segments are dropped,
    or grouped under '_' if keep_unassigned.

    A segment that crosses a border also touches the regions on the other
    side. For each of those it's recorded again under '+' + key ("border
    extras"): the browser draws a region's extras only when that region is
    shown on its own, masked to its outline -- so a line runs right up to
    the border instead of stopping at the last station before it, and is
    never drawn twice when everything is visible."""
    out: dict[str, dict[str, dict[str, str]]] = {}
    for category, by_mode in networks.items():
        groups: dict[str, dict[str, str]] = {}
        for mode, polylines in by_mode.items():
            lines = []
            for pl in polylines:
                if select is not None:
                    pl = select(pl)
                    if pl is None:
                        continue
                pts = [transform(p) for p in pl]
                if len(pts) >= 2 and _touches_disc(pts):
                    lines.append(pts)
            if not lines:
                continue
            starts = np.array([p for pts in lines for p in pts[:-1]], dtype=float)
            ends = np.array([p for pts in lines for p in pts[1:]], dtype=float)
            hits = np.stack([_locate(starts + (ends - starts) * t, regions) for t in _SEGMENT_SAMPLES], axis=1)
            # Owner: first sample (in _SEGMENT_SAMPLES order) that's in a region.
            owner = np.full(len(starts), -1, dtype=np.int32)
            for col in range(hits.shape[1]):
                owner = np.where(owner < 0, hits[:, col], owner)

            pieces: dict[str, list[Ring]] = {}

            def add_runs(pts: Ring, keys: list[str | None]) -> None:
                run_key, run = None, None
                for j, key in enumerate(keys):
                    if key != run_key:
                        if run is not None:
                            pieces.setdefault(run_key, []).append(run)
                        run_key, run = key, ([pts[j]] if key is not None else None)
                    if run is not None:
                        run.append(pts[j + 1])
                if run is not None:
                    pieces.setdefault(run_key, []).append(run)

            i = 0
            for pts in lines:
                n = len(pts) - 1
                seg_owner = owner[i:i + n]
                seg_hits = hits[i:i + n]
                i += n
                add_runs(pts, [regions[r][0] if r >= 0 else ('_' if keep_unassigned else None) for r in seg_owner])
                # Border extras, one pass per region this polyline touches but doesn't own.
                for r in sorted({int(r) for r in np.unique(seg_hits) if r >= 0}):
                    extra = (seg_hits == r).any(axis=1) & (seg_owner != r)
                    if extra.any():
                        add_runs(pts, ['+' + regions[r][0] if e else None for e in extra])

            for key, runs in pieces.items():
                d = _polyline_path(runs, tol)
                if d:
                    groups.setdefault(key, {})[mode] = d
        if groups:
            out[category] = groups
    return out


def _country_line_selector(clusters: list[Cluster], view_polys: list[Poly]):
    """Keeps polylines that come near this country (in projected space) and
    moves the parts on relocated islands along with their island. The
    browser clips what's left to the country's outline."""
    boxes = [bb for bb, _, _ in clusters] or [_union_box([_bbox(p[0]) for p in view_polys])]
    whole = _union_box(boxes)
    pad = 0.03 * math.hypot(whole[2] - whole[0], whole[3] - whole[1])
    padded = [(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad) for b in boxes]
    moved = [c for c in clusters if c[1] or c[2]]

    def inside(p):
        return any(b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3] for b in padded)

    def select(pl):
        if not any(inside(p) for p in pl):
            return None
        if not moved:
            return pl
        out = []
        for x, y in pl:
            _, dx, dy = min(clusters, key=lambda c: _box_gap(c[0], (x, y, x, y)))
            out.append((x + dx, y + dy))
        return out

    return select


# ── Station Region -> subdivision ─────────────────────────────────────────────

def _norm_name(name: str) -> str:
    """'Québec' -> 'quebec', 'Nuevo León' -> 'nuevoleon'. map.js has an
    identical NormalizeRegionName; keep the two in step."""
    decomposed = unicodedata.normalize('NFKD', name)
    stripped = ''.join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]', '', stripped.lower())


def _in_geo(lon: float, lat: float, geo: list | None) -> bool:
    for poly in geo or []:
        x0, y0, x1, y1 = _bbox(poly[0])
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            continue
        if _point_in_ring(lon, lat, poly[0]) and not any(_point_in_ring(lon, lat, hole) for hole in poly[1:]):
            return True
    return False


def _match_by_name(name: str, subs: list[tuple[str, list | None]]) -> int | None:
    target = _norm_name(name)
    if not target:
        return None
    exact = [i for i, (n, _) in enumerate(subs) if _norm_name(n) == target]
    if len(exact) == 1:
        return exact[0]
    # 'Distrito Federal' vs 'Ciudad de México' won't get here, but
    # 'Veracruz' vs 'Veracruz de Ignacio de la Llave' will.
    if len(target) >= 4:
        partial = [i for i, (n, _) in enumerate(subs)
                   if target in _norm_name(n) or (len(_norm_name(n)) >= 4 and _norm_name(n) in target)]
        if len(partial) == 1:
            return partial[0]
    return None


def _match_by_location(locations: list[tuple[float, float]], subs: list[tuple[str, list | None]]) -> int | None:
    votes: dict[int, int] = {}
    for lat, lon in locations:
        for i, (_, geo) in enumerate(subs):
            if _in_geo(lon, lat, geo):
                votes[i] = votes.get(i, 0) + 1
                break
    return max(votes, key=votes.get) if votes else None


def _region_index(stations: dict[str, Any], sub_geo: dict[str, list[tuple[str, list | None]]]) -> dict[str, dict[str, list]]:
    """Maps every (country code, subdivision name) used in a station's
    'Region' to the subdivision it refers to. Tries, in order: the name in
    the stated country; where the stations actually are, in the stated
    country; where they actually are, anywhere (catches a wrong country code)."""
    groups: dict[tuple[str, str], tuple[str, list[tuple[float, float]]]] = {}
    for data in stations.values():
        region, loc = data.get('Region'), data.get('Location')
        if not region or len(region) < 3 or not region[1] or not region[2]:
            continue
        key = (str(region[2]).upper(), _norm_name(str(region[1])))
        name, locs = groups.setdefault(key, (str(region[1]), []))
        if loc and len(locs) < 25:
            locs.append((loc[0], loc[1]))

    index: dict[str, dict[str, list]] = {}
    unresolved: list[str] = []
    relocated: list[str] = []
    for (code, norm), (name, locs) in sorted(groups.items()):
        found: tuple[str, int] | None = None
        subs = sub_geo.get(code)
        if subs is not None:
            if len(subs) == 1 and subs[0][1] is None:      # country without an ADM1 file
                found = (code, 0)
            else:
                i = _match_by_name(name, subs)
                if i is None:
                    i = _match_by_location(locs, subs)
                if i is not None:
                    found = (code, i)
        if found is None:
            for other, other_subs in sub_geo.items():
                if other == code:
                    continue
                i = _match_by_location(locs, other_subs)
                if i is not None:
                    found = (other, i)
                    relocated.append(f"{name} [{code}] -> {other_subs[i][0]} [{other}]")
                    break
        if found is None:
            unresolved.append(f"{name} [{code}]")
            continue
        index.setdefault(code, {})[norm] = [found[0], found[1]]

    if relocated:
        print(f"Note: station Regions resolved to a different country than stated ({len(relocated)}):")
        for line in relocated:
            print(f"  * {line}")
    if unresolved:
        print(f"Note: station Regions with no matching subdivision ({len(unresolved)}): {', '.join(unresolved)}")
    return index


# ── Public entry point ────────────────────────────────────────────────────────

def build_splash_regions(
    regions_dir: FilePath,
    stations:    dict[str, Any] | None = None,
    registries:  dict[str, list[dict[str, Any]]] | None = None,   # {'Fantasy': registry, 'Present': registry}
    modes:       dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Returns the payload the splash screen renders:
        {
          "Size": 1000,                         # square viewBox side, both views
          "Projection": [n, F, lon0],           # Lambert conformal constants (see _LambertConformal)
          "ContinentFit": [cx, cy, scale],      # projected -> continent view: p' = 500 + (p - c)*scale
          "Countries": {
            "USA": {
              "Name": "United States",
              "D":    "M...z",                  # continent-view outline
              "Hit":  [x, y, r],                # hover target, tiny countries only
              "View": [k, tx, ty],              # continent -> country view: p' = k*p + t
              "Fit":  [cx, cy, scale],          # projected -> country view: p' = 500 + (p - c)*scale
              "Clusters": [[x0, y0, x1, y1, dx, dy], ...],   # only if landmasses were moved
              "Subs": [                         # country-view subdivisions
                {"Name": "Ohio", "D": "M...z", "Hit": [x, y, r],   # Hit only if tiny
                 "DFine": "M...z"},             # only if it's zoomed far when isolated
                ...
              ]
            }, ...
          },
          "LineModes": {"Heavy Rail": [color, px, z], ...},  # only if `registries` is given
          "Lines": {"Fantasy": {"Heavy Rail": "M...", ...}, "Present": {...}},   # continent view
          (and per country, "Lines" in that country's view, same shape)
          "RegionIndex": {                      # only if `stations` is given
            "CAN": {"quebec": ["CAN", 4], ...}  # station Region -> [country, index into Subs]
          }
        }
    RegionIndex is keyed by each station's own Region country code and its
    subdivision name, normalised by _norm_name (accents, case, punctuation
    ignored), so the browser can look a station up with the same rule.
    Returns {} if the folder is missing or empty, in which case the splash
    simply shows no map."""
    if not regions_dir or not os.path.isdir(regions_dir):
        return {}

    project = _LambertConformal(_STD_PARALLEL_1, _STD_PARALLEL_2, _CENTRAL_MERIDIAN)
    files = _find_files(regions_dir)

    # Pass 1: load, filter in lon/lat space, project.
    raw: dict[str, dict[str, Any]] = {}
    continent_fit: list[tuple[float, float]] = []

    for code, levels in sorted(files.items()):
        if 0 not in levels:
            continue
        excluded_codes = EXCLUDED_SUBDIVISIONS.get(code, frozenset())
        adm1 = _load(levels[1]) if 1 in levels else None
        if excluded_codes and adm1 is None:
            print(f"Note: no ADM1 file for {code} in {regions_dir}; can't exclude {', '.join(sorted(excluded_codes))}.")
        excluded = _excluded_bounds(adm1, excluded_codes)
        view_excluded_codes = COUNTRY_VIEW_EXCLUDED.get(code, frozenset())
        view_excluded = _excluded_bounds(adm1, view_excluded_codes)

        name = code
        polys: list[Poly] = []
        view_polys: list[Poly] = []
        for feature in _load(levels[0]).get('features', []):
            name = (feature.get('properties') or {}).get('shapeName') or name
            for poly in _polygons(feature.get('geometry')):
                if not poly or len(poly[0]) < 4 or _in_excluded(poly, excluded):
                    continue
                projected = [[project(p[0], p[1]) for p in ring] for ring in poly]
                polys.append(projected)
                if not _in_excluded(poly, view_excluded):
                    view_polys.append(projected)
                continent_fit.extend(xy for xy, p in zip(projected[0], poly[0]) if p[1] <= FIT_NORTH_LAT)
        if not polys:
            continue

        subs: list[tuple[str, list[Poly]]] = []
        for feature in (adm1 or {}).get('features', []):
            props = feature.get('properties') or {}
            if (props.get('shapeISO') or '').upper() in excluded_codes | view_excluded_codes:
                continue
            geo = [poly for poly in _polygons(feature.get('geometry')) if poly and len(poly[0]) >= 4]
            sub_polys = [[[project(p[0], p[1]) for p in ring] for ring in poly] for poly in geo]
            if sub_polys:
                subs.append((props.get('shapeName') or '', sub_polys, geo))

        raw[code] = {'Name': name, 'Polys': polys, 'ViewPolys': view_polys or polys, 'Subs': subs}

    if not raw:
        return {}
    continent_fit.extend(project(lon, lat) for lon, lat in FIT_ANCHORS)
    if not continent_fit:   # nothing south of FIT_NORTH_LAT -- fall back to everything
        continent_fit = [p for v in raw.values() for poly in v['Polys'] for p in poly[0]]

    # Pass 2: continent view.
    to_continent, (c0x, c0y, s0) = _fit(continent_fit, MARGIN)

    networks: dict[str, dict[str, list[list[tuple[float, float]]]]] = {}
    for category, registry in (registries or {}).items():
        networks[category] = {
            mode: [[project(lon, lat) for lat, lon in pl] for pl in polylines]
            for mode, polylines in _line_network(registry).items()
        }
    half = SIZE / 2
    countries: dict[str, dict[str, Any]] = {}
    sub_geo: dict[str, list[tuple[str, list | None]]] = {}   # code -> [(name, lon/lat polygons)] in Subs order
    continent_regions: list[tuple[str, list[Ring]]] = []      # (code, outline rings) in continent coords

    for code, entry in raw.items():
        # Out-of-frame land (the Arctic, Alaska) is kept: it scrolls into view
        # during the zoom into Canada or the United States.
        outline = _outline(entry['Polys'], to_continent)
        if outline is None:
            continue
        d, bbox, rings = outline
        continent_regions.append((code, rings))
        country: dict[str, Any] = {'Name': entry['Name'], 'D': d}
        hit = _hit(bbox, SMALL_COUNTRY_SIZE, HIT_RADIUS)
        if hit:
            country['Hit'] = hit

        # Pass 3: this country's own view, in the same projection, so the
        # continent -> country step is one uniform scale + translate. Far-flung
        # landmasses are pulled in first; the main landmass never moves, so
        # the zoom still lands on it exactly.
        clusters = _compact(entry['ViewPolys'])
        view_polys = [_shift(poly, clusters) for poly in entry['ViewPolys']]
        to_country, (cix, ciy, si) = _fit([p for poly in view_polys for p in poly[0]], COUNTRY_MARGIN)
        k = si / s0
        country['View'] = [round(k, 5),
                           round(half * (1 - k) + (c0x - cix) * si, 3),
                           round(half * (1 - k) + (c0y - ciy) * si, 3)]
        # Enough for the browser to place any lon/lat in this view (the
        # selected station's dot): projected point -> cluster shift -> fit.
        country['Fit'] = [round(cix, 7), round(ciy, 7), round(si, 4)]
        if any(dx or dy for _, dx, dy in clusters):
            country['Clusters'] = [[round(v, 7) for v in (*bb, dx, dy)] for bb, dx, dy in clusters]

        subs_out: list[dict[str, Any]] = []
        sub_sources = entry['Subs'] or [(entry['Name'], entry['ViewPolys'], None)]   # no ADM1 file: one region
        for sub_name, sub_polys, geo in sub_sources:
            shifted = [_shift(poly, clusters) for poly in sub_polys]
            sub = _outline(shifted, to_country)
            if sub is None:
                continue
            sd, sbbox, srings = sub
            item: dict[str, Any] = {'Name': sub_name, 'D': sd, '_geo': geo, '_rings': srings}
            # Shown on its own, a subdivision is turned north-up: on a conic
            # map, ones far east or west of 100°W sit tilted (Maine ~20°).
            if geo:
                lons = [p[0] for poly in geo for p in poly[0]]
                rot = project.convergence((min(lons) + max(lons)) / 2)
                if abs(rot) >= 0.5:
                    item['Rot'] = round(rot, 2)
            zoom = min(max(ISOLATE_RADIUS / max(math.hypot(sbbox[2] - sbbox[0], sbbox[3] - sbbox[1]) / 2, 0.5), 1.0), ISOLATE_MAX_ZOOM)
            if zoom > FINE_OUTLINE_MIN_ZOOM:
                fine = _outline(shifted, to_country, tol=2 * SIMPLIFY_TOLERANCE / zoom,
                                min_area=MIN_RING_AREA / zoom ** 2, decimals=1 + math.ceil(math.log10(zoom)))
                if fine is not None and fine[0] != sd:
                    item['DFine'] = fine[0]
            sub_hit = _hit(sbbox, SMALL_SUB_SIZE, SUB_HIT_RADIUS)
            if sub_hit:
                item['Hit'] = sub_hit
            subs_out.append(item)
        subs_out.sort(key=lambda s: s['Name'])
        sub_geo[code] = [(item['Name'], item.pop('_geo')) for item in subs_out]
        sub_rings = [item.pop('_rings') for item in subs_out]
        country['Subs'] = subs_out
        if networks:
            # Grouped by subdivision index: the browser draws one group alone
            # for an isolated subdivision, no clipping needed.
            lines = _region_lines(networks, to_country, LINE_TOLERANCE_COUNTRY,
                                  [(str(i), r) for i, r in enumerate(sub_rings)],
                                  select=_country_line_selector(clusters, entry['ViewPolys']))
            if lines:
                country['Lines'] = lines

        countries[code] = country

    result: dict[str, Any] = {
        'Size': SIZE,
        'Projection': [round(project.n, 10), round(project.F, 10), project.lon0],
        'ContinentFit': [round(c0x, 7), round(c0y, 7), round(s0, 4)],   # projected -> continent view
        'Countries': countries,
    }
    if networks:
        # Grouped by country ('_' = at sea / unassigned), so zooming into a
        # country draws only its own lines -- no clipping needed.
        result['Lines'] = _region_lines(networks, to_continent, LINE_TOLERANCE_CONTINENT,
                                        continent_regions, keep_unassigned=True)
        lo, hi = LINE_WIDTH_RANGE
        used_modes = {m for by_mode in networks.values() for m in by_mode}
        result['LineModes'] = {
            m: [
                (modes or {}).get(m, {}).get('Color', '#888888'),
                round(min(hi, max(lo, float((modes or {}).get(m, {}).get('Weight', 3)) * LINE_WIDTH_PER_WEIGHT)), 2),
                (modes or {}).get(m, {}).get('zOrder', 0),
            ]
            for m in sorted(used_modes, key=lambda m: (modes or {}).get(m, {}).get('zOrder', 0))
        }
    if stations:
        result['RegionIndex'] = _region_index(stations, sub_geo)
    return result