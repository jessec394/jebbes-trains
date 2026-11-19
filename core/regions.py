"""The country / subdivision outlines in data/regions, used by the splash map and to fill in station Regions"""
from __future__ import annotations
import glob, json, os, re, threading
from typing import Any

from core import paths

FILE_RE = re.compile(r'(?:^|[-_])([A-Z]{3})-ADM([01])', re.IGNORECASE)

def find_files(regions_dir: str = paths.REGIONS_DIR) -> dict[str, dict[int, str]]:
    """{country code: {0: ADM0 file, 1: ADM1 file}}, preferring a '_simplified' variant when both exist."""
    found: dict[str, dict[int, str]] = {}
    for path in sorted(glob.glob(os.path.join(regions_dir, '*.geojson')) + glob.glob(os.path.join(regions_dir, '*.json'))):
        m = FILE_RE.search(os.path.basename(path))
        if not m: continue
        code, level = m.group(1).upper(), int(m.group(2))
        current = found.setdefault(code, {}).get(level)
        if current is None or ('simplified' in os.path.basename(path).lower() and 'simplified' not in os.path.basename(current).lower()):
            found[code][level] = path

    return found

def polygons(geometry: dict[str, Any] | None) -> list:
    """A GeoJSON geometry -> its polygons (each a list of rings)."""
    if not geometry: return []
    t = geometry.get('type')
    if t == 'Polygon': return [geometry['coordinates']]
    if t == 'MultiPolygon': return list(geometry['coordinates'])
    if t == 'GeometryCollection': return [p for g in geometry.get('geometries', []) for p in polygons(g)]
    return []

def point_in_ring(x: float, y: float, ring) -> bool:
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, yi, xj, yj = ring[i][0], ring[i][1], ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi: inside = not inside
        j = i

    return inside

def point_in_polygon(x: float, y: float, poly) -> bool:
    """Inside the outer ring and in none of the holes."""
    return point_in_ring(x, y, poly[0]) and not any(point_in_ring(x, y, h) for h in poly[1:])

# Locating a place (the tracer)

_LOCK = threading.Lock()
_CACHE: dict = {}

def _indexed(path: str) -> list:
    """[(name, [(bbox, polygon), ...])] of one GeoJSON file, parsed once."""
    with _LOCK:
        hit = _CACHE.get(path)
        if hit is not None: return hit

    with open(path, encoding='utf-8') as f: doc = json.load(f)
    out = []
    for ft in doc.get('features', []):
        name = (ft.get('properties') or {}).get('shapeName') or ''
        ps = []
        for poly in polygons(ft.get('geometry')):
            if not poly or len(poly[0]) < 4: continue
            xs, ys = [p[0] for p in poly[0]], [p[1] for p in poly[0]]
            ps.append(((min(xs), min(ys), max(xs), max(ys)), poly))

        if ps: out.append((name, ps))

    with _LOCK: _CACHE[path] = out
    return out

def _find(path: str, lat: float, lon: float):
    for name, ps in _indexed(path):
        for (x0, y0, x1, y1), poly in ps:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_polygon(lon, lat, poly): return name

    return None

def available() -> bool:
    return bool(find_files())

def locate(lat: float, lon: float):
    """(subdivision, country code) of a place, or None; a country without subdivisions names itself"""
    files = find_files()
    for code, lv in files.items():                             # the country first (cheap, few big polygons), then its subdivisions
        if 0 in lv and _find(lv[0], lat, lon) is not None:
            if 1 in lv:
                sub = _find(lv[1], lat, lon)
                if sub: return sub, code

            return (_find(lv[0], lat, lon) or code), code

    for code, lv in files.items():                             # a coast the country outline just misses: the subdivisions may still contain it
        if 1 in lv:
            sub = _find(lv[1], lat, lon)
            if sub: return sub, code

    return None