"""Waypoints in, geometry out.

  data/tracks/waypoints.json  what the developer traced (source of truth, in git)
  data/tracks/edits.json      Future-map track edits           (source of truth, in git)
  data/tracks/geometry.json   compiled polylines the map build consumes (generated, in git)

The map build only ever calls `load_geometry()` / `traced_coords()`, which read
plain JSON -- no osmium, Flask, or SQLite needed to build the site.
"""
from __future__ import annotations
import copy, json, os, time
from typing import Any

from . import config

CATS = ('Present', 'Fantasy')


# ── JSON that diffs well: point lists stay on one line ───────────────────────

def _is_points(v) -> bool:
    return (isinstance(v, list) and v and all(
        isinstance(p, list) and len(p) in (2, 3) and all(isinstance(x, (int, float)) for x in p) for p in v))


def dumps(obj, level: int = 0) -> str:
    pad = ' ' * (level + 1)
    if isinstance(obj, dict):
        if not obj: return '{}'
        items = [f'{pad}{json.dumps(k, ensure_ascii=False)}: {dumps(v, level + 1)}' for k, v in obj.items()]
        return '{\n' + ',\n'.join(items) + '\n' + ' ' * level + '}'
    if _is_points(obj):
        return '[' + ', '.join(json.dumps(p) for p in obj) + ']' if len(obj) < 4 else \
            '[\n' + ',\n'.join(pad + json.dumps(p) for p in obj) + '\n' + ' ' * level + ']'
    if isinstance(obj, list):
        if not obj: return '[]'
        return '[\n' + ',\n'.join(pad + dumps(v, level + 1) for v in obj) + '\n' + ' ' * level + ']'
    return json.dumps(obj, ensure_ascii=False)


_FILES: dict = {}      # path -> ((mtime_ns, size), parsed): the big JSON files are parsed once per change on disk, not once per request


def _read(path: str, default, shared: bool = False):
    """Parsed JSON file. Callers get their own copy unless `shared` (read-only use of a big document)."""
    if not os.path.exists(path):
        return default
    st = os.stat(path); sig = (st.st_mtime_ns, st.st_size)
    hit = _FILES.get(path)
    if not hit or hit[0] != sig:
        with open(path, encoding='utf-8') as f:
            hit = _FILES[path] = (sig, json.load(f))
    return hit[1] if shared else copy.deepcopy(hit[1])


def _write(path: str, obj) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(dumps(obj) + '\n')
    os.replace(tmp, path); _FILES.pop(path, None)


# ── read side (used by the map build) ────────────────────────────────────────

def load_geometry(path: str = config.GEOMETRY_FILE) -> dict:
    return _read(path, {}).get('routes', {})


def as_polylines(v) -> list:
    """A stored geometry is one polyline [[lat,lon],...] or a list of polylines."""
    if not v:
        return []
    return [v] if isinstance(v[0][0], (int, float)) else v


def pack_polylines(polys: list):
    return polys[0] if len(polys) == 1 else polys


def traced_coords(geometry: dict, operator: str, line: str, category: str, pattern: str):
    """-> [[[lat, lon], ...], ...] (one or more polylines) or None if this pattern has no traced geometry."""
    try:
        v = geometry[operator][line][pattern][category]
    except (KeyError, TypeError):
        return None
    polys = [p for p in as_polylines(v) if len(p) >= 2]
    return polys or None


# ── tree helpers ─────────────────────────────────────────────────────────────

def _get(doc: dict, op, line, pat, cat, create=False):
    node = doc
    for k in (op, line, pat):
        if k not in node:
            if not create: return None
            node[k] = {}
        node = node[k]
    if cat not in node and create:
        node[cat] = {}
    return node.get(cat)


def iter_routes(doc: dict):
    for op, lines in doc.items():
        for line, pats in lines.items():
            for pat, cats in pats.items():
                for cat, entry in cats.items():
                    yield op, line, pat, cat, entry


def _drop(doc: dict, op, line, pat, cat):
    try:
        del doc[op][line][pat][cat]
    except KeyError:
        return
    if not doc[op][line][pat]: del doc[op][line][pat]
    if not doc[op][line]: del doc[op][line]
    if not doc[op]: del doc[op]


# ── project (dev tool side) ──────────────────────────────────────────────────

def resolve_ref(op: str, line: str, ref) -> tuple[str, str, str]:
    """A Future pattern's `same_as_present` is either a pattern name on the same line (older files)
    or {"operator","line","pattern"} pointing at any Present pattern."""
    if isinstance(ref, dict):
        return ref.get('operator', op), ref.get('line', line), ref['pattern']
    return op, line, ref


def make_ref(op: str, line: str, sop: str, sline: str, spat: str):
    return spat if (sop, sline) == (op, line) else {'operator': sop, 'line': sline, 'pattern': spat}


# ── "which lines may be affected by the track I changed" ────────────────────
# Changed track is remembered as grid cells (~200 m); a line is affected when its compiled path passes within about a cell of
# them, or when the straight corridor between two consecutive waypoints passes within about 1 km (a new track there could be
# a shortcut that changes how the line routes).
CELL_DEG = 0.002
NEAR_CELLS, CORRIDOR_CELLS = 1, 5


def _cell(p) -> tuple[int, int]:
    return (int(p[0] // CELL_DEG), int(p[1] // CELL_DEG))


def _dense(pts, step_deg: float = 0.001):
    pts = [tuple(p[:2]) for p in pts]
    if len(pts) == 1:
        yield pts[0]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / step_deg) + 1)
        for k in range(n):
            yield (a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)
    if pts:
        yield pts[-1]


def _dilate(cells: set, r: int) -> set:
    out = set()
    for i, j in cells:
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1):
                out.add((i + di, j + dj))
    return out


def is_stop(w) -> bool:
    """A waypoint is [lat, lon], or {"stop": "Station {platform}"}: pinned to that stopping place of map_data.py."""
    return isinstance(w, dict) and bool(w.get('stop'))


class TrackProject:
    station_path = None          # map_data.py to read stopping places from (None = data/map_data.py)

    def resolve_wps(self, wps) -> tuple[list, list, list]:
        """Waypoint items -> ([lat, lon] list, parallel list of stop keys (None for plain waypoints), unknown stop keys).
        A stop takes the current Location of its station / platform, so moving that one place moves every route that stops there."""
        from .mapdata import station_locations
        locs = station_locations(self.station_path) if any(is_stop(w) for w in wps) else {}
        pts, stops, missing = [], [], []
        for w in wps:
            if is_stop(w):
                loc = locs.get(w['stop'])
                if loc is None:
                    missing.append(w['stop']); continue
                pts.append([loc[0], loc[1]]); stops.append(w['stop'])
            else:
                pts.append([w[0], w[1]]); stops.append(None)
        return pts, stops, missing

    def routes_with_stops(self, keys) -> list[tuple]:
        keys = set(keys)
        return [(o, l, p, c) for o, l, p, c, e in iter_routes(self.waypoints_doc())
                if any(is_stop(w) and w['stop'] in keys for w in (e.get('waypoints') or []))]

    def recompile_stop_users(self, keys) -> list[dict]:
        """After a station / platform moved: recompile the routes that stop there (and the Future routes inheriting them)."""
        reports = []
        for o, l, p, c in self.routes_with_stops(keys):
            reports.append(self.compile_one(o, l, p, c))
            if c == 'Present':
                reports += self.compile_dependents(o, l, p)
        return reports

    def __init__(self, store=None):
        from .store import GraphStore
        from .network import Network, load_edits
        self.store = store or GraphStore()
        self._Network, self._load_edits = Network, load_edits
        self.reload_future()

    # edits / networks ------------------------------------------------------
    def reload_future(self):
        # edits drawn on the Present map (scope 'present') apply to both maps; the rest only to the Future map
        edits = self._load_edits()
        pres = [e for e in edits if e.get('scope') == 'present']
        sig = json.dumps(pres, sort_keys=True)
        if getattr(self, '_present_sig', None) != sig or getattr(self, 'present', None) is None:       # Future-only edits leave the Present network as it was
            self.present = self._Network(self.store, pres, 'present'); self._present_sig = sig
        self.future = self._Network(self.store, edits, 'future')
        return self.future

    def net(self, which: str):
        return self.future if which in ('future', 'Fantasy') else self.present

    # documents -------------------------------------------------------------
    def waypoints_doc(self) -> dict:
        return _read(config.WAYPOINTS_FILE, {}).get('routes', {})

    def save_waypoints_doc(self, routes: dict) -> None:
        _write(config.WAYPOINTS_FILE, {'routes': routes})

    def geometry_doc(self, shared: bool = False) -> dict:
        return _read(config.GEOMETRY_FILE, {}, shared).get('routes', {})

    def save_geometry_doc(self, routes: dict) -> None:
        _write(config.GEOMETRY_FILE, {'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                      'graph': self.store.meta('source'), 'routes': routes})

    # compile ---------------------------------------------------------------
    def compile_entry(self, wdoc: dict, op: str, line: str, pat: str, cat: str):
        """-> (packed geometry | None, report dict)"""
        from .router import route
        from .geo import simplify, haversine, novel_runs
        entry = _get(wdoc, op, line, pat, cat) or {}
        rep: dict[str, Any] = {'operator': op, 'line': line, 'pattern': pat, 'category': cat,
                               'ok': True, 'warnings': []}
        same = entry.get('same_as_present') if cat == 'Fantasy' else None
        if same:
            sop, sline, spat = resolve_ref(op, line, same)
            src = _get(wdoc, sop, sline, spat, 'Present') or {}
            wps, net, loop = src.get('waypoints') or [], self.net(cat), True      # only the waypoints are shared: the route is found on this route's own map
            rep['same_as'] = spat if (sop, sline) == (op, line) else f'{sop} / {sline} / {spat}'
        else:
            wps, net, loop = entry.get('waypoints') or [], self.net(cat), True      # every route returns to its start
        wps, _stops, missing = self.resolve_wps(wps)
        for k in missing:
            rep['warnings'].append(f"stop '{k}' is not a station in map_data.py; skipped")
        if len(wps) < 2:
            return None, {**rep, 'ok': False, 'warnings': rep['warnings'] + ['fewer than 2 waypoints']}
        pts = [tuple(w[:2]) for w in wps]
        r = route(net, pts)
        for k, leg in enumerate(r.legs):
            if not leg.ok:
                rep['ok'] = False
                rep['warnings'].append(f'leg {k + 1}->{k + 2}: {leg.error}')
            elif getattr(leg, 'note', ''):
                rep['warnings'].append(f'leg {k + 1}->{k + 2}: {leg.note}')
        out = r.geometry()
        polys = [out]
        total_m = r.length_m
        # every route returns to its origin; the part of the way back that just retraces the way out is not stored twice
        if loop and haversine(pts[0], pts[-1]) > 30:
            back = route(net, [pts[-1], pts[0]])
            if back.ok:
                total_m += back.length_m
                runs = novel_runs(back.geometry(), out)
                if len(runs) == 1 and haversine(runs[0][0], out[-1]) < 20:
                    polys = [out + runs[0][1:]]
                else:
                    polys = [out] + runs
            else:
                rep['ok'] = False
                rep['warnings'].append(f'return to start: {back.legs[0].error}')
        d = config.OUTPUT_DECIMALS
        packed = [[[round(p[0], d), round(p[1], d)] for p in simplify(pl, config.OUTPUT_SIMPLIFY_M)] for pl in polys]
        rep['length_km'] = round(total_m / 1000, 2)
        rep['loop'] = bool(loop)
        return pack_polylines(packed), rep

    def compile_one(self, op, line, pat, cat) -> dict:
        wdoc = self.waypoints_doc()
        coords, rep = self.compile_entry(wdoc, op, line, pat, cat)
        gdoc = self.geometry_doc(True)          # edited in place and saved straight away (the cached copy is dropped on save)
        if coords:
            _get(gdoc, op, line, pat, cat, create=True)
            gdoc[op][line][pat][cat] = coords
        else:
            _drop(gdoc, op, line, pat, cat)
        self.save_geometry_doc(gdoc)
        return rep

    def compile_dependents(self, op, line, pat) -> list[dict]:
        """Recompile Future patterns (on any line) that inherit this Present pattern's waypoints."""
        wdoc, out = self.waypoints_doc(), []
        for o2, lines in wdoc.items():
            for l2, pats in lines.items():
                for p2, cats in pats.items():
                    ref = (cats.get('Fantasy') or {}).get('same_as_present')
                    if ref and resolve_ref(o2, l2, ref) == (op, line, pat):
                        out.append(self.compile_one(o2, l2, p2, 'Fantasy'))
        return out

    def compile_all(self, only=None, log=print) -> list[dict]:
        wdoc, reports, new = self.waypoints_doc(), [], {}
        old = self.geometry_doc()
        picked = None
        if only:        # a Future route that inherits the waypoints of a Present route is always recompiled along with it
            routes = list(iter_routes(wdoc))
            picked = {(o, l, p, c) for o, l, p, c, _ in routes if only(o, l, p, c)}
            for o, l, p, c, _ in routes:
                ref = (_get(wdoc, o, l, p, c) or {}).get('same_as_present') if c == 'Fantasy' else None
                if ref and (*resolve_ref(o, l, ref), 'Present') in picked:
                    picked.add((o, l, p, c))
        for op, line, pat, cat, _ in iter_routes(wdoc):
            if only and (op, line, pat, cat) not in picked:
                c = _get(old, op, line, pat, cat)
                if c:
                    _get(new, op, line, pat, cat, True); new[op][line][pat][cat] = c
                continue
            coords, rep = self.compile_entry(wdoc, op, line, pat, cat)
            if coords:
                _get(new, op, line, pat, cat, True); new[op][line][pat][cat] = coords
            oc = _get(old, op, line, pat, cat)
            rep['changed'] = bool(oc) and oc != coords
            reports.append(rep)
            if not rep['ok']:
                log(f"  ! {op} / {line} / {pat} [{cat}]: {'; '.join(rep['warnings'])}")
        self.save_geometry_doc(new)
        return reports

    # -- changed-track memory (a Present-map edit affects Present and Future routes, a Future-map edit only Future routes) --
    def _dirty_file(self) -> str:
        return os.path.join(config.CACHE_DIR, 'dirty_regions.json')

    def dirty_cells(self) -> dict[str, set]:
        if not hasattr(self, '_dirty'):
            d = _read(self._dirty_file(), {})
            self._dirty = {s: {tuple(c) for c in d.get(s, [])} for s in ('present', 'future')}
        return self._dirty

    def mark_dirty(self, coords, scope: str = 'future') -> None:
        cells = {_cell(p) for p in _dense(coords)}
        self.dirty_cells()[scope if scope in ('present', 'future') else 'future'].update(cells)
        os.makedirs(config.CACHE_DIR, exist_ok=True)
        _write(self._dirty_file(), {s: sorted(c) for s, c in self.dirty_cells().items()})

    def clear_dirty(self) -> None:
        self._dirty = {'present': set(), 'future': set()}
        _write(self._dirty_file(), {'present': [], 'future': []})

    def _affected_fn(self):
        d = self.dirty_cells()
        gdoc, wdoc = self.geometry_doc(), self.waypoints_doc()
        sets = {}
        for cat, cells in (('Present', d['present']), ('Fantasy', d['present'] | d['future'])):
            sets[cat] = (_dilate(cells, NEAR_CELLS), _dilate(cells, CORRIDOR_CELLS)) if cells else None

        def waypoints(op, line, pat, cat):
            e = _get(wdoc, op, line, pat, cat) or {}
            ref = e.get('same_as_present') if cat == 'Fantasy' else None
            if ref:
                so, sl, sp = resolve_ref(op, line, ref)
                return self.resolve_wps((_get(wdoc, so, sl, sp, 'Present') or {}).get('waypoints') or [])[0]
            return self.resolve_wps(e.get('waypoints') or [])[0]

        def hit(op, line, pat, cat) -> bool:
            s = sets.get(cat)
            if not s:
                return False
            near, corridor = s
            g = _get(gdoc, op, line, pat, cat)
            for pl in (as_polylines(g) if g else []):
                if any(_cell(p) in near for p in _dense(pl, 0.0015)):
                    return True
            w = waypoints(op, line, pat, cat)
            return any(_cell(p) in corridor for p in _dense(w, 0.0015)) if len(w) >= 2 else False
        return hit

    def affected_routes(self) -> list[tuple]:
        hit = self._affected_fn()
        return [(o, l, p, c) for o, l, p, c, _ in iter_routes(self.waypoints_doc()) if hit(o, l, p, c)]

    def refresh_affected(self, log=lambda *_: None) -> list[dict]:
        """Recompile every line that may be affected by the track changed since the last refresh (and the Future lines that
        inherit the waypoints of a recompiled Present line), then forget the changes."""
        hit = self._affected_fn()
        reports = self.compile_all(only=hit, log=log)
        self.clear_dirty()
        return reports

    def compile_affected(self, bbox, scope='future') -> list[dict]:
        """After an edit: recompile the routes passing near it. A Present-map edit changes Present routes and every
        Future route (including those inheriting Present waypoints); a Future-map edit only Future routes."""
        from .geo import bbox_of
        gdoc, wdoc = self.geometry_doc(), self.waypoints_doc()

        def hit(op, line, pat, cat):
            if scope != 'present' and cat != 'Fantasy': return False
            g = _get(gdoc, op, line, pat, cat)
            pts = [p for pl in as_polylines(g) for p in pl] if g else self.resolve_wps((_get(wdoc, op, line, pat, cat) or {}).get('waypoints') or [])[0]
            if not pts: return False
            b = bbox_of([tuple(p[:2]) for p in pts])
            return not (b[2] < bbox[0] or b[0] > bbox[2] or b[3] < bbox[1] or b[1] > bbox[3])
        return self.compile_all(only=hit, log=lambda *_: None)