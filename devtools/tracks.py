"""Waypoints in, geometry out: traces data/tracks/waypoints.json into geometry.json"""
from __future__ import annotations
import copy, hashlib, json, os, time
from typing import Any

from . import config
from core.geo import haversine
from core.fileio import read_json, write_json
from core.station_resolver import base_of
from core.traced import CATS, as_polylines, pack_polylines, get_entry, iter_routes, drop_entry

# Project (dev tool side)

def resolve_ref(op: str, line: str, ref) -> tuple[str, str, str]:
    """A Future pattern's same_as_present: a pattern name on the same line or an {operator, line, pattern} ref"""
    if isinstance(ref, dict): return ref.get('operator', op), ref.get('line', line), ref['pattern']
    return op, line, ref

def make_ref(op: str, line: str, sop: str, sline: str, spat: str):
    return spat if (sop, sline) == (op, line) else {'operator': sop, 'line': sline, 'pattern': spat}

# Lines affected by changed track: changed cells (~200 m) near a line's path or its waypoint corridors
CELL_DEG = 0.002
NEAR_CELLS, CORRIDOR_CELLS = 1, 5

def _cell(p) -> tuple[int, int]:
    return (int(p[0] // CELL_DEG), int(p[1] // CELL_DEG))

def _dense(pts, step_deg: float = 0.001):
    pts = [tuple(p[:2]) for p in pts]
    if len(pts) == 1: yield pts[0]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / step_deg) + 1)
        for k in range(n): yield (a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)

    if pts: yield pts[-1]

def _dilate(cells: set, r: int) -> set:
    out = set()
    for i, j in cells:
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1): out.add((i + di, j + dj))

    return out

def _join_to(run, out, tol_m: float = 40.0) -> list:
    """Joins a diverging stretch of the way back onto the way out at both ends"""
    import math
    def snap(p):
        kx, ky = 111320.0 * math.cos(math.radians(p[0])), 110540.0
        best = None
        for a, b in zip(out, out[1:]):
            ax, ay, bx, by = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky, (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
            dx, dy = bx - ax, by - ay; L2 = dx * dx + dy * dy
            t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L2))
            d = math.hypot(ax + t * dx, ay + t * dy)
            if best is None or d < best[0]: best = (d, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))

        return best[1] if best and best[0] <= tol_m else None

    s, e = snap(run[0]), snap(run[-1])
    return ([s] if s else []) + list(run) + ([e] if e else [])

def is_stop(w) -> bool:
    """A waypoint is [lat, lon], or {"stop": "Station {platform}"}: pinned to that stopping place of the detailed map."""
    return isinstance(w, dict) and bool(w.get('stop'))

def merge_stops(stored, keys) -> list:
    """The route's points: every stop in order, with stored waypoints after the stop they followed"""
    keys = list(keys or [])
    if len(keys) > 1 and keys[0] == keys[-1]: keys.pop()
    head, buckets, cur, pos = [], [[] for _ in keys], None, 0
    for w in stored or []:
        if is_stop(w):
            k = w['stop']
            idx = next((i for i in range(pos, len(keys)) if keys[i] == k), None)
            if idx is None: idx = next((i for i in range(pos, len(keys)) if base_of(keys[i]) == base_of(k)), None)
            if idx is not None: cur, pos = idx, idx + 1
        else:
            (head if cur is None else buckets[cur]).append(w)

    out = list(head)
    for k, b in zip(keys, buckets):
        out.append({'stop': k}); out += b

    return out

def compress_wps(wps) -> list:
    """What is worth storing of a route: its plain waypoints anchored to the stops they follow"""
    wps = list(wps or [])
    if not any(not is_stop(w) for w in wps): return []
    first = next((i for i, w in enumerate(wps) if is_stop(w)), None)
    return [w for i, w in enumerate(wps) if not is_stop(w) or i == first or (i + 1 < len(wps) and not is_stop(wps[i + 1]))]

COMPILE_VERSION = 3          # raise it when the way paths are compiled changes: every route is then re-traced on the next map build

class TrackProject:
    station_path = None          # the detailed map file to read stopping places from (None = data/detailed_map.py)

    def resolve_wps(self, wps, expand: bool = False, future: bool = False) -> tuple[list, list, list]:
        """Waypoint items -> (points, stop keys, unknown stops); with expand a platform span becomes both its ends"""
        from .mapdata import station_locations, station_spans
        has = any(is_stop(w) for w in wps)
        locs = station_locations(self.station_path) if has else {}
        spans = station_spans(self.station_path) if has and expand else {}
        ov = {}
        if has and future:                                   # on the Future map a platform may have its own Future version (see availability.py)
            from . import availability as AV
            ov = AV.platform_versions()

        pts, stops, missing = [], [], []
        for i, w in enumerate(wps):
            if not is_stop(w):
                pts.append([w[0], w[1]]); stops.append(None); continue

            o = ov.get(w['stop']) or {}
            loc = o.get('Location') or locs.get(w['stop'])
            if loc is None:
                missing.append(w['stop']); continue

            sp = o['Span'] if 'Span' in o else spans.get(w['stop'])
            if sp:
                a, b = [list(sp[0][:2]), list(sp[1][:2])]
                ref = pts[-1] if pts else next((list(locs[x['stop']]) if is_stop(x) and x['stop'] in locs else list(x[:2]) for x in wps[i + 1:] if is_stop(x) or isinstance(x, (list, tuple))), None)
                if ref is not None and haversine(tuple(ref), tuple(a)) > haversine(tuple(ref), tuple(b)): a, b = b, a
                pts += [a, b]; stops += [w['stop'], w['stop']]
            else:
                pts.append([loc[0], loc[1]]); stops.append(w['stop'])

        return pts, stops, missing

    # -- the stops of a pattern are its route: waypoints are only the extra points between them --
    def stop_keys(self, op, line, pat, cat):
        """The stopping places of a pattern of the detailed map, in order (None when there is no detailed map to ask)."""
        f = self.station_path
        if not f: return None
        try: sig = os.stat(f).st_mtime_ns
        except OSError: return None

        c = self.__dict__.setdefault('_sk', {})
        if c.get('sig') != sig: c.clear(); c['sig'] = sig
        k = (op, line, pat, cat)
        if k not in c:
            try:
                from .stops import pattern_stops
                c[k] = [s['key'] for s in pattern_stops(f, op, line, cat, pat)['stops']]
            except Exception:
                c[k] = None

        return c[k]

    def effective_wps(self, op, line, pat, cat, stored) -> list:
        """Stored waypoints + the pattern's stops = the points the route is traced through. An old list of only plain points is left as it was."""
        stored = stored or []
        keys = self.stop_keys(op, line, pat, cat)
        if keys is None or (stored and not any(is_stop(w) for w in stored)): return stored
        return merge_stops(stored, keys)

    def pattern_seqs(self) -> dict:
        """(operator, line, pattern, category) -> station names its pattern stops at (one read of the detailed map, cached until it changes)."""
        f = self.station_path
        if not f: return {}
        try: sig = os.stat(f).st_mtime_ns
        except OSError: return {}

        hit = self.__dict__.get('_ps')
        if hit and hit[0] == sig: return hit[1]
        from .mapdata import load_namespace
        from core.station_resolver import build_station_sequence
        ns = load_namespace(f); out = {}
        for op, lines in (ns.get('Lines') or {}).items():
            for line, cats in lines.items():
                for cat in CATS:
                    for pat, pd in (cats.get(cat) or {}).items():
                        try: seq = build_station_sequence(pd, ns['Segments'])
                        except Exception: seq = []

                        out[(op, line, pat, cat)] = [base_of(x[4:] if x.startswith(('[R] ', '[X] ')) else x) for x in seq if not x.startswith('[X] ')]

        self._ps = (sig, out)
        return out

    def routes_all(self, wdoc=None):
        """Every route there is to trace: those with stored waypoints, and every pattern of the detailed map with at least two stops."""
        wdoc = self.waypoints_doc() if wdoc is None else wdoc
        seen = set()
        for t in iter_routes(wdoc):
            seen.add(t[:4]); yield t

        for k, seq in self.pattern_seqs().items():
            if k not in seen and len(seq) >= 2: yield (*k, {})

    def routes_with_stops(self, keys) -> list[tuple]:
        keys = set(keys); bases = {base_of(k) for k in keys}
        out = [(o, l, p, c) for o, l, p, c, e in iter_routes(self.waypoints_doc())
               if any(is_stop(w) and w['stop'] in keys for w in (e.get('waypoints') or []))]
        out += [k for k, seq in self.pattern_seqs().items() if k not in out and bases & set(seq)]
        return out

    def rename_stops(self, mapping: dict) -> list[tuple]:
        """Stops pinned in waypoints.json follow a renamed / merged station or platform; returns the routes that changed."""
        doc, hit = self.waypoints_doc(), []
        for o, l, p, c, e in iter_routes(doc):
            ch = False
            for w in e.get('waypoints') or []:
                if is_stop(w) and w['stop'] in mapping: w['stop'] = mapping[w['stop']]; ch = True

            if ch: hit.append((o, l, p, c))

        if hit: self.save_waypoints_doc(doc)
        return hit

    def recompile_stop_users(self, keys) -> list[dict]:
        """After a station / platform moved: recompile the routes that stop there."""
        return [self.compile_one(o, l, p, c) for o, l, p, c in self.routes_with_stops(keys)]

    def __init__(self, store=None):
        from .store import GraphStore
        from .network import Network, load_edits
        self.store = store or GraphStore()
        self._Network, self._load_edits = Network, load_edits
        self.reload_future()
        self.drop_inheritance()

    def drop_inheritance(self) -> int:
        """Routes no longer inherit anything: a Future route that used to follow a Present route keeps a copy of those waypoints as its own."""
        wdoc, n = self.waypoints_doc(), 0
        for o, lines in wdoc.items():
            for l, pats in lines.items():
                for p, cats in pats.items():
                    ent = cats.get('Fantasy') or {}
                    ref = ent.pop('same_as_present', None)
                    if ref:
                        src = get_entry(wdoc, *resolve_ref(o, l, ref), 'Present') or {}
                        ent['waypoints'] = copy.deepcopy(src.get('waypoints') or [])
                        n += 1

        if n:
            for o in list(wdoc):                                          # an entry with nothing in it is not kept
                for l in list(wdoc[o]):
                    for p in list(wdoc[o][l]):
                        for c in list(wdoc[o][l][p]):
                            if not wdoc[o][l][p][c].get('waypoints'): drop_entry(wdoc, o, l, p, c)

            self.save_waypoints_doc(wdoc)

        return n

    # edits / networks ------------------------------------------------------
    def reload_future(self):
        # edits drawn on the Present map (scope 'present') apply to both maps; the rest only to the Future map
        edits = self._load_edits()
        pres = [e for e in edits if e.get('scope') == 'present']
        sig = json.dumps(pres, sort_keys=True)
        if getattr(self, '_present_sig', None) != sig or getattr(self, 'present', None) is None:       # Future-only edits leave the Present network as it was
            self.present = self._Network(self.store, pres, 'present'); self._present_sig = sig

        fresh_present = getattr(self, '_locked_present', None) is not self.present
        self.future = self._Network(self.store, edits, 'future')
        self.apply_locks(present=fresh_present)
        return self.future

    def locks_doc(self) -> list:
        return read_json(config.DIRECTIONS_FILE, {}, shared=True).get('locks', [])      # read only: the networks never change it

    def apply_locks(self, present: bool = True) -> None:
        """(Re)read the locked track directions into both networks (see directions.py)."""
        L = self.locks_doc()
        for n in ((self.present, self.future) if present else (self.future,)):          # an unchanged Present network keeps its locks
            if hasattr(n, 'set_locks'): n.set_locks(L)

        self._locked_present = self.present

        if not getattr(self, '_said', False): self._said = True; print(f"[directions] {len(L)} locked stretches loaded: {len(getattr(self.present, '_dir', ()))} edges on the Present map, {len(getattr(self.future, '_dir', ()))} on the Future map", flush=True)

    def net(self, which: str):
        return self.future if which in ('future', 'Fantasy') else self.present

    # documents -------------------------------------------------------------
    def waypoints_doc(self) -> dict:
        return read_json(config.WAYPOINTS_FILE, {}).get('routes', {})

    def save_waypoints_doc(self, routes: dict) -> None:
        write_json(config.WAYPOINTS_FILE, {'routes': routes})

    def geometry_doc(self, shared: bool = False) -> dict:
        return read_json(config.GEOMETRY_FILE, {}, shared).get('routes', {})

    def save_geometry_doc(self, routes: dict) -> None:
        write_json(config.GEOMETRY_FILE, {'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                                      'graph': self.store.meta('source'), 'routes': routes})

    # compile ---------------------------------------------------------------
    def stop_alts(self, op, line, pat, cat) -> dict:
        """{stop key: [the other platforms that stop may use]} of a pattern ('Alt' in the detailed map); {} when there are none."""
        f = self.station_path
        if not f: return {}
        try: sig = os.stat(f).st_mtime_ns
        except OSError: return {}

        c = self.__dict__.setdefault('_sa', {})
        if c.get('sig') != sig: c.clear(); c['sig'] = sig
        k = (op, line, pat, cat)
        if k not in c:
            try:
                from .stops import pattern_stops
                c[k] = {s['key']: s['alt'] for s in pattern_stops(f, op, line, cat, pat)['stops'] if s.get('alt')}
            except Exception:
                c[k] = {}

        return c[k]

    def _variants(self, op, line, pat, cat, entry) -> list:
        """The waypoint lists a route is traced through: one, or one per platform choice ('Alt')."""
        base_wps = self.effective_wps(op, line, pat, cat, entry.get('waypoints'))
        groups = {k: [k] + list(v) for k, v in self.stop_alts(op, line, pat, cat).items()}
        variants, seen = [], set()
        for v in range(max([1] + [len(g) for g in groups.values()])):
            pick = lambda k: groups[k][v % len(groups[k])] if k in groups else k
            w = [({**x, 'stop': pick(x['stop'])} if is_stop(x) else x) for x in base_wps]
            sig = tuple(x['stop'] for x in w if is_stop(x))
            if sig not in seen: seen.add(sig); variants.append(w)

        return variants

    # A route's stored path is current while the fingerprint of everything it depends on matches
    SIG_FILE = os.path.join(config.TRACK_DIR, 'geometry_sig.json')

    def _net_sig(self, cat) -> str:
        edits = self._load_edits()
        if cat != 'Fantasy': edits = [e for e in edits if e.get('scope') == 'present']
        return hashlib.sha1(json.dumps([COMPILE_VERSION, edits, self.locks_doc(), self.store.meta('source'), config.OUTPUT_SIMPLIFY_M, config.OUTPUT_DECIMALS], sort_keys=True, default=str).encode()).hexdigest()

    def route_sig(self, op, line, pat, cat, entry) -> str:
        pts = [self.resolve_wps(w, expand=True, future=cat == 'Fantasy')[:2] for w in self._variants(op, line, pat, cat, entry)]
        return hashlib.sha1(json.dumps([pts, self._net_sig(cat)], sort_keys=True, default=str).encode()).hexdigest()

    def _record_sigs(self, new: dict, drop=()) -> None:
        d = read_json(self.SIG_FILE, {}).get('sigs', {})
        d.update({'|'.join(k): v for k, v in new.items()})
        for k in drop: d.pop('|'.join(k), None)
        write_json(self.SIG_FILE, {'sigs': dict(sorted(d.items()))})

    def sync_geometry(self, log=print) -> list[dict]:
        """Recompile every route whose stored path is out of date, so the website shows exactly what the tracer shows. Quick when nothing changed."""
        if not self.station_path or not os.path.exists(self.station_path):
            log("[detailed] the detailed map file is not set: not checking the traced routes"); return []

        wdoc, sigs, gdoc = self.waypoints_doc(), read_json(self.SIG_FILE, {}).get('sigs', {}), self.geometry_doc()
        stale = set()
        for op, line, pat, cat, entry in self.routes_all(wdoc):
            if self.route_sig(op, line, pat, cat, entry) != sigs.get('|'.join((op, line, pat, cat))) or not get_entry(gdoc, op, line, pat, cat):
                stale.add((op, line, pat, cat))

        log(f"[detailed] traced routes: {len(stale)} out of date, {sum(1 for r in self.routes_all(wdoc)) - len(stale)} up to date")
        if not stale: return []
        log(f"[detailed] {len(stale)} traced route(s) were out of date with the tracer: re-tracing them")
        reps, done = [], {}
        for i, (op, line, pat, cat) in enumerate(sorted(stale), 1):             # a path is only ever replaced by a better one: a route that cannot be traced keeps what it had
            entry = get_entry(wdoc, op, line, pat, cat) or {}
            if i % 10 == 1: log(f"  re-tracing {i}/{len(stale)}: {op} / {line} / {pat} [{cat}]")
            coords, rep = self.compile_entry(wdoc, op, line, pat, cat); reps.append(rep)
            if coords and not rep['ok']:
                log(f"  ! {op} / {line} / {pat} [{cat}]: traced, but with problems (the path may jump): {'; '.join(rep['warnings'])}")

            if not coords:
                log(f"  ! {op} / {line} / {pat} [{cat}]: not re-traced ({'; '.join(rep['warnings']) or 'no path'}); the stored path is kept"); continue

            get_entry(gdoc, op, line, pat, cat, create=True); gdoc[op][line][pat][cat] = coords
            done[(op, line, pat, cat)] = self.route_sig(op, line, pat, cat, entry)

        if done:
            self.save_geometry_doc(gdoc); self._record_sigs(done)

        return reps

    def compile_entry(self, wdoc: dict, op: str, line: str, pat: str, cat: str):
        """-> (packed geometry | None, report); stops with Alt platforms are traced once per platform choice"""
        from .router import route
        from core.geo import simplify, haversine, novel_runs
        entry = get_entry(wdoc, op, line, pat, cat) or {}
        rep: dict[str, Any] = {'operator': op, 'line': line, 'pattern': pat, 'category': cat,
                               'ok': True, 'warnings': []}
        net, loop = self.net(cat), True                                  # every route returns to its start
        variants = self._variants(op, line, pat, cat, entry)

        polys, total_m = [], 0.0
        for vi, vw in enumerate(variants):
            wps, _stops, missing = self.resolve_wps(vw, expand=True, future=cat == 'Fantasy')
            if vi == 0:
                for k in missing: rep['warnings'].append(f"stop '{k}' is not a station of the detailed map; skipped")

            tag = '' if len(variants) == 1 else f" (platform choice {vi + 1})"
            if len(wps) < 2:
                if vi == 0: return None, {**rep, 'ok': False, 'warnings': rep['warnings'] + ['fewer than 2 waypoints']}
                continue

            pts = [tuple(w[:2]) for w in wps]
            r = route(net, pts)
            if not all(l.ok for l in r.legs):            # the tracer draws a route between the stops themselves: if running the whole length of the platforms cannot be routed
                wps2 = self.resolve_wps(vw, expand=False, future=cat == 'Fantasy')[0]       # (one-way / no-go track in the way), route to the stops instead of jumping across
                if 2 <= len(wps2) != len(wps):
                    pts2 = [tuple(w[:2]) for w in wps2]; r2 = route(net, pts2)
                    if all(l.ok for l in r2.legs):
                        r, pts = r2, pts2                # (quietly: the route is fine, it just does not run the platforms' full length there)

            for k, leg in enumerate(r.legs):
                if not leg.ok:
                    rep['ok'] = False
                    rep['warnings'].append(f'leg {k + 1}->{k + 2}: {leg.error}{tag}')
                elif getattr(leg, 'note', ''):
                    rep['warnings'].append(f'leg {k + 1}->{k + 2}: {leg.note}{tag}')

            out = r.geometry()
            mine = [out]
            total_m += r.length_m
            # every route returns to its origin; the part of the way back that just retraces the way out is not stored twice
            if loop and haversine(pts[0], pts[-1]) > 30:
                back = route(net, [pts[-1], pts[0]])
                if back.ok:
                    total_m += back.length_m
                    runs = novel_runs(back.geometry(), out)
                    if len(runs) == 1 and haversine(runs[0][0], out[-1]) < 20:
                        mine = [out + runs[0][1:]]
                    else:
                        mine = [out] + [_join_to(r, out) for r in runs]
                else:
                    rep['ok'] = False
                    rep['warnings'].append(f'return to start: {back.legs[0].error}{tag}')

            polys.extend(mine)                                   # each platform choice is a whole route of its own; they overlap and are shown as one

        d = config.OUTPUT_DECIMALS
        packed = [[[round(p[0], d), round(p[1], d)] for p in simplify(pl, config.OUTPUT_SIMPLIFY_M)] for pl in polys]
        rep['length_km'] = round(total_m / 1000, 2)
        rep['loop'] = bool(loop)
        rep['variants'] = len(variants)
        return pack_polylines(packed), rep

    def compile_one(self, op, line, pat, cat, keep: bool = False) -> dict:
        """keep: a route that cannot be traced keeps its stored path (a refresh must never lose a line)."""
        wdoc = self.waypoints_doc()
        coords, rep = self.compile_entry(wdoc, op, line, pat, cat)
        if keep and not coords: return rep
        gdoc = self.geometry_doc(True)          # edited in place and saved straight away (the cached copy is dropped on save)
        if coords:
            get_entry(gdoc, op, line, pat, cat, create=True)
            gdoc[op][line][pat][cat] = coords
        else:
            drop_entry(gdoc, op, line, pat, cat)

        self.save_geometry_doc(gdoc)
        self._record_sigs({(op, line, pat, cat): self.route_sig(op, line, pat, cat, get_entry(self.waypoints_doc(), op, line, pat, cat) or {})} if coords else {}, [] if coords else [(op, line, pat, cat)])
        return rep

    def compile_all(self, only=None, log=print) -> list[dict]:
        wdoc, reports, new = self.waypoints_doc(), [], {}
        old = self.geometry_doc()
        picked = None
        if only: picked = {(o, l, p, c) for o, l, p, c, _ in self.routes_all(wdoc) if only(o, l, p, c)}
        for op, line, pat, cat, _ in self.routes_all(wdoc):
            if only and (op, line, pat, cat) not in picked:
                c = get_entry(old, op, line, pat, cat)
                if c:
                    get_entry(new, op, line, pat, cat, True); new[op][line][pat][cat] = c

                continue

            coords, rep = self.compile_entry(wdoc, op, line, pat, cat)
            if coords:
                get_entry(new, op, line, pat, cat, True); new[op][line][pat][cat] = coords

            oc = get_entry(old, op, line, pat, cat)
            rep['changed'] = bool(oc) and oc != coords
            reports.append(rep)
            if not rep['ok']: log(f"  ! {op} / {line} / {pat} [{cat}]: {'; '.join(rep['warnings'])}")

        self.save_geometry_doc(new)
        self._record_sigs({(op, line, pat, cat): self.route_sig(op, line, pat, cat, ent) for op, line, pat, cat, ent in self.routes_all(wdoc)
                           if (not only or (op, line, pat, cat) in picked) and get_entry(new, op, line, pat, cat)})
        return reports

    # -- changed-track memory (a Present-map edit affects Present and Future routes, a Future-map edit only Future routes) --
    def _dirty_file(self) -> str:
        return os.path.join(config.CACHE_DIR, 'dirty_regions.json')

    def dirty_cells(self) -> dict[str, set]:
        if not hasattr(self, '_dirty'):
            d = read_json(self._dirty_file(), {})
            self._dirty = {s: {tuple(c) for c in d.get(s, [])} for s in ('present', 'future')}

        return self._dirty

    def mark_dirty(self, coords, scope: str = 'future') -> None:
        cells = {_cell(p) for p in _dense(coords)}
        self.dirty_cells()[scope if scope in ('present', 'future') else 'future'].update(cells)
        os.makedirs(config.CACHE_DIR, exist_ok=True)
        write_json(self._dirty_file(), {s: sorted(c) for s, c in self.dirty_cells().items()})

    def clear_dirty(self) -> None:
        self._dirty = {'present': set(), 'future': set()}
        write_json(self._dirty_file(), {'present': [], 'future': []})

    def _affected_fn(self):
        d = self.dirty_cells()
        gdoc, wdoc = self.geometry_doc(), self.waypoints_doc()
        sets = {}
        for cat, cells in (('Present', d['present']), ('Fantasy', d['present'] | d['future'])):
            sets[cat] = (_dilate(cells, NEAR_CELLS), _dilate(cells, CORRIDOR_CELLS)) if cells else None

        def waypoints(op, line, pat, cat):
            e = get_entry(wdoc, op, line, pat, cat) or {}
            stored = e.get('waypoints')
            if get_entry(gdoc, op, line, pat, cat): return self.resolve_wps(stored or [], future=cat == 'Fantasy')[0]      # already compiled: its stored waypoints are enough to see which way it runs
            return self.resolve_wps(self.effective_wps(op, line, pat, cat, stored), future=cat == 'Fantasy')[0]       # not compiled yet: the stops are its route

        def hit(op, line, pat, cat) -> bool:
            s = sets.get(cat)
            if not s: return False
            near, corridor = s
            g = get_entry(gdoc, op, line, pat, cat)
            for pl in (as_polylines(g) if g else []):
                if any(_cell(p) in near for p in _dense(pl, 0.0015)): return True

            w = waypoints(op, line, pat, cat)
            return any(_cell(p) in corridor for p in _dense(w, 0.0015)) if len(w) >= 2 else False

        return hit

    def affected_routes(self) -> list[tuple]:
        hit = self._affected_fn()
        return [(o, l, p, c) for o, l, p, c, _ in self.routes_all() if hit(o, l, p, c)]

    def refresh_affected(self, log=lambda *_: None) -> list[dict]:
        """Recompiles every line affected by track changed since the last refresh, then forgets the changes"""
        hit = self._affected_fn()
        reports = self.compile_all(only=hit, log=log)
        self.clear_dirty()
        return reports

    def compile_affected(self, bbox, scope='future') -> list[dict]:
        """Recompiles routes near an edit: Present edits affect every route, Future edits only Future routes"""
        from core.geo import bbox_of
        gdoc, wdoc = self.geometry_doc(), self.waypoints_doc()

        def hit(op, line, pat, cat):
            if scope != 'present' and cat != 'Fantasy': return False
            g = get_entry(gdoc, op, line, pat, cat)
            pts = [p for pl in as_polylines(g) for p in pl] if g else self.resolve_wps(self.effective_wps(op, line, pat, cat, (get_entry(wdoc, op, line, pat, cat) or {}).get('waypoints')), future=cat == 'Fantasy')[0]
            if not pts: return False
            b = bbox_of([tuple(p[:2]) for p in pts])
            return not (b[2] < bbox[0] or b[0] > bbox[2] or b[3] < bbox[1] or b[1] > bbox[3])

        return self.compile_all(only=hit, log=lambda *_: None)