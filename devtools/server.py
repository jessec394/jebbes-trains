"""Local tracing UI. Binds to 127.0.0.1 only; never part of the published site."""
from __future__ import annotations
import importlib, os, sys, threading, uuid

from flask import Flask, jsonify, request, send_from_directory, abort

from . import config
from .tracks import TrackProject, _get, _drop, CATS, as_polylines
from .network import load_edits, save_edits
from .geo import bbox_of
from .network import _cum, _sub


def map_data_file(module: str, path: str | None = None) -> str | None:
    """The map_data.py on disk (None when `module` is an in-memory stand-in, as in the tests)."""
    if path:
        return path
    import importlib.util
    try:
        spec = importlib.util.find_spec(module)
    except (ImportError, ValueError):
        return None
    return spec.origin if spec and spec.origin and os.path.isfile(spec.origin) else None


def _load_project_data(module: str, path: str | None = None):
    if config.ROOT not in sys.path:
        sys.path.insert(0, config.ROOT)
    from core.station_resolver import normalize_stations
    f = map_data_file(module, path)
    if f:       # exec the file fresh each time: always current, and immune to stale .pyc after a write-back
        from .mapdata import load_namespace
        ns = load_namespace(f)
    else:
        ns = vars(importlib.import_module(module))
    return (ns['Lines'], ns['Segments'], normalize_stations(ns['Nodes']),
            normalize_stations(ns['Stations']), ns.get('Modes', {}))


def create_app(map_data_module: str = 'data.map_data', project: TrackProject | None = None,
               map_data_path: str | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    lock = threading.RLock()
    P = project or TrackProject()

    P.station_path = map_data_file(map_data_module, map_data_path)

    def data():
        return _load_project_data(map_data_module, map_data_path)

    def pat_args(src):
        return src['operator'], src['line'], src['pattern'], src['category']

    # ── static ────────────────────────────────────────────────────────────
    @app.get('/')
    def index():
        return send_from_directory(config.STATIC_DIR, 'index.html')

    @app.get('/favicon.ico')
    def favicon():
        return ('', 204)

    @app.get('/static/<path:name>')
    def static_files(name):
        return send_from_directory(config.STATIC_DIR, name)

    # ── status / catalog ─────────────────────────────────────────────────
    @app.get('/api/status')
    def status():
        from .updater import load_report
        return jsonify(graph=P.store.meta('source'), edges=P.store.meta('edges'),
                       build=P.store.build_id, edits=len(P.future.edits), report=load_report(),
                       future_track=len(P.store.future_ids()), has_kinds=P.store.meta('kinds') is not None)

    @app.get('/api/catalog')
    def catalog():
        Lines, *_ = data()
        wdoc, gdoc = P.waypoints_doc(), P.geometry_doc(True)
        out = []
        for op, lines in Lines.items():
            for line, cats in lines.items():
                for cat in CATS:
                    for pat, pd in (cats.get(cat) or {}).items():
                        w = _get(wdoc, op, line, pat, cat) or {}
                        out.append(dict(
                            operator=op, line=line, pattern=pat, category=cat, mode=pd.get('Mode'),
                            waypoints=len(w.get('waypoints') or []),
                            same_as_present=w.get('same_as_present'),
                            compiled=bool(_get(gdoc, op, line, pat, cat))))
        return jsonify(out)

    @app.get('/api/seed')
    def seed():
        """Stations/nodes along the pattern, in order: a starting set of waypoints."""
        from core.station_resolver import build_coordinate_sequence
        Lines, Segments, Nodes, Stations, _ = data()
        op, line, pat, cat = pat_args(request.args)
        pd = Lines[op][line][cat][pat]
        return jsonify([[round(a, 6), round(b, 6)] for a, b in
                        build_coordinate_sequence(pd, Segments, Nodes, Stations)])

    @app.get('/api/stations')
    def line_stations():
        """Stations served by any pattern of this line (same category), with their coordinates."""
        from core.station_resolver import build_station_sequence
        Lines, Segments, Nodes, Stations, _ = data()
        op, line, cat = request.args['operator'], request.args['line'], request.args['category']
        out = {}
        for pd in (Lines.get(op, {}).get(line, {}).get(cat) or {}).values():
            for sk in build_station_sequence(pd, Segments, filter_non_stops=True):
                st = Stations.get(sk)
                if st and st.get('Location') and sk not in out:
                    out[sk] = {'key': sk, 'label': st.get('Label') or sk, 'lat': st['Location'][0], 'lon': st['Location'][1]}
        return jsonify(list(out.values()))

    @app.put('/api/stations')
    def move_stations_api():
        from .mapdata import move_stations
        f = map_data_file(map_data_module, map_data_path)
        if not f:
            abort(400)
        moves = request.get_json().get('moves') or {}
        try:
            with lock:
                from .mapdata import forget_stations
                out = move_stations(f, moves); forget_stations(f)
                reps = P.recompile_stop_users(moves.keys())        # routes that stop at a moved station / platform follow it
                return jsonify({**out, 'reports': reps})
        except (ValueError, StopIteration) as e:
            return jsonify(error=str(e)), 409

    # ── map layers ───────────────────────────────────────────────────────
    @app.get('/api/edges')
    def edges():
        s, w, n, e = map(float, request.args['bbox'].split(','))
        net = P.net(request.args.get('map', 'present'))
        with lock:
            items = net.view((s, w, n, e), limit=int(request.args.get('limit', 12000)), include_removed=request.args.get('erased') == '1')
        return jsonify([{'id': i['id'], 'k': i['kind'], 'c': i['cls'],
                         'p': [[round(a, 6), round(b, 6)] for a, b in i['pts']]} for i in items])

    @app.post('/api/legs')
    def legs():
        """Route each [from, to] pair independently (the UI caches legs and asks only for new ones)."""
        from .router import route
        j = request.get_json()
        net = P.net(j.get('map', 'present'))
        out = []
        with lock:
            for a, b in j['pairs']:
                l = route(net, [tuple(a[:2]), tuple(b[:2])]).legs[0]
                out.append({'ok': l.ok, 'error': l.error, 'note': l.note, 'km': round(l.length_m / 1000, 2),
                            'pts': [[round(x, 6), round(y, 6)] for x, y in l.geom]})
        return jsonify(legs=out)

    @app.post('/api/route')
    def route_preview():
        from .router import route
        j = request.get_json()
        wps = [tuple(p[:2]) for p in j['waypoints']]
        if len(wps) < 2:
            return jsonify(legs=[], length_km=0)
        with lock:
            r = route(P.net(j.get('map', 'present')), wps)
        return jsonify(length_km=round(r.length_m / 1000, 2), ok=r.ok,
                       legs=[{'ok': l.ok, 'error': l.error, 'note': l.note, 'km': round(l.length_m / 1000, 2),
                              'pts': [[round(a, 6), round(b, 6)] for a, b in l.geom]} for l in r.legs])

    # ── traces ───────────────────────────────────────────────────────────
    def route_signature(pd, Segments):
        """The stations a pattern runs through, ignoring Keep/Skip/Drop (which only change which of them it stops at)."""
        from core.station_resolver import build_station_sequence
        def bare(seg):
            return {k: v for k, v in seg.items() if k not in ('Keep', 'Skip', 'Drop')} if isinstance(seg, dict) else seg
        plain = {k: bare(seg) for k, seg in Segments.items()}
        return tuple(s[4:] if s.startswith('[X] ') else s for s in build_station_sequence(pd, plain))

    def inherit_candidates(op, line, pat):
        """Present routes (any operator/line) with the same station sequence as this Future pattern, that have waypoints."""
        Lines, Segments, *_ = data()
        mine = route_signature(Lines[op][line]['Fantasy'][pat], Segments)
        if len(mine) < 2:
            return []
        wdoc, out = P.waypoints_doc(), []
        for o2, lines in Lines.items():
            for l2, cats in lines.items():
                for p2, pd in (cats.get('Present') or {}).items():
                    sig = route_signature(pd, Segments)
                    if sig != mine and sig[::-1] != mine:
                        continue
                    w = (_get(wdoc, o2, l2, p2, 'Present') or {}).get('waypoints') or []
                    if len(w) >= 2:
                        out.append({'operator': o2, 'line': l2, 'pattern': p2, 'waypoints': len(w),
                                    'same_line': (o2, l2) == (op, line)})
        out.sort(key=lambda c: (not c['same_line'], c['operator'], c['line'], c['pattern']))
        return out

    def future_dependents(op, line, pat):
        """Future patterns with the same station sequence as this Present route: they may inherit its waypoints."""
        from .tracks import resolve_ref
        Lines, Segments, *_ = data()
        mine = route_signature(Lines[op][line]['Present'][pat], Segments)
        if len(mine) < 2:
            return []
        wdoc, out = P.waypoints_doc(), []
        for o2, lines in Lines.items():
            for l2, cats in lines.items():
                for p2, pd in (cats.get('Fantasy') or {}).items():
                    sig = route_signature(pd, Segments)
                    if sig != mine and sig[::-1] != mine:
                        continue
                    ref = (_get(wdoc, o2, l2, p2, 'Fantasy') or {}).get('same_as_present')
                    cur = None
                    if ref:
                        so, sl, sp = resolve_ref(o2, l2, ref); cur = {'operator': so, 'line': sl, 'pattern': sp}
                    out.append({'operator': o2, 'line': l2, 'pattern': p2,
                                'following': bool(cur and (cur['operator'], cur['line'], cur['pattern']) == (op, line, pat)),
                                'other': cur if cur and (cur['operator'], cur['line'], cur['pattern']) != (op, line, pat) else None,
                                'same_line': (o2, l2) == (op, line)})
        out.sort(key=lambda c: (not c['same_line'], c['operator'], c['line'], c['pattern']))
        return out

    @app.get('/api/trace')
    def get_trace():
        from .tracks import resolve_ref
        op, line, pat, cat = pat_args(request.args)
        w = _get(P.waypoints_doc(), op, line, pat, cat) or {}
        g = as_polylines(_get(P.geometry_doc(True), op, line, pat, cat))
        ref = w.get('same_as_present') if cat == 'Fantasy' else None
        src = None; reused, rstops = [], []
        if ref:
            sop, sline, spat = resolve_ref(op, line, ref)
            src = {'operator': sop, 'line': sline, 'pattern': spat}
            reused, rstops, _ = P.resolve_wps((_get(P.waypoints_doc(), sop, sline, spat, 'Present') or {}).get('waypoints') or [])
        own, ostops, missing = P.resolve_wps(w.get('waypoints') or [])
        cands = []
        if cat == 'Fantasy':
            try:
                cands = inherit_candidates(op, line, pat)
            except (KeyError, StopIteration):
                cands = []
        deps, ready = [], False
        if cat == 'Present':
            ready = len(w.get('waypoints') or []) >= 2
            try:
                deps = future_dependents(op, line, pat)
            except (KeyError, StopIteration):
                deps = []
        return jsonify(waypoints=own, stops=ostops, missing_stops=missing, same_as_present=src,
                       reused_waypoints=reused, reused_stops=rstops, candidates=cands, geometry=g, dependents=deps, dependents_ready=ready)

    @app.put('/api/trace')
    def put_trace():
        from .tracks import make_ref
        j = request.get_json()
        op, line, pat, cat = pat_args(j)
        reports = []
        with lock:
            wdoc = P.waypoints_doc()
            entry = _get(wdoc, op, line, pat, cat, create=True)
            if cat == 'Fantasy' and 'same_as_present' in j:
                r = j['same_as_present']
                if r:
                    if not any(c['operator'] == r['operator'] and c['line'] == r['line'] and c['pattern'] == r['pattern']
                               for c in inherit_candidates(op, line, pat)):
                        return jsonify(error='that Present route does not have the same station sequence'), 409
                    entry['same_as_present'] = make_ref(op, line, r['operator'], r['line'], r['pattern'])
                else:
                    entry.pop('same_as_present', None)
            src = None
            if 'waypoints' in j:
                stops = j.get('stops') or []
                pts = [{'stop': stops[i]} if i < len(stops) and stops[i] else [round(p[0], 6), round(p[1], 6)] for i, p in enumerate(j['waypoints'])]
                ref = entry.get('same_as_present') if cat == 'Fantasy' else None
                if ref:      # this Future route shares a Present route's waypoints: the edit goes to the Present route, and every route sharing it follows
                    from .tracks import resolve_ref
                    src = resolve_ref(op, line, ref)
                    _get(wdoc, *src, 'Present', create=True)['waypoints'] = pts
                else:
                    entry['waypoints'] = pts
            # drop empty entries
            for o2, ls in list(wdoc.items()):
                for l2, ps in list(ls.items()):
                    for p, cats in list(ps.items()):
                        for c, ent in list(cats.items()):
                            if not ent.get('waypoints') and not ent.get('same_as_present'):
                                _drop(wdoc, o2, l2, p, c)
            P.save_waypoints_doc(wdoc)
            if src:
                reports.append(P.compile_one(*src, 'Present'))
                reports += P.compile_dependents(*src)
            else:
                reports.append(P.compile_one(op, line, pat, cat))
                if cat == 'Present':
                    reports += P.compile_dependents(op, line, pat)
        return jsonify(reports=reports)

    @app.delete('/api/trace')
    def delete_trace():
        op, line, pat, cat = pat_args(request.args)
        with lock:
            wdoc = P.waypoints_doc(); _drop(wdoc, op, line, pat, cat); P.save_waypoints_doc(wdoc)
            g = P.geometry_doc(); _drop(g, op, line, pat, cat); P.save_geometry_doc(g)
            if cat == 'Present':
                P.compile_dependents(op, line, pat)
        return jsonify(ok=True)

    # ── Future-map edits ─────────────────────────────────────────────────
    @app.get('/api/edits')
    def list_edits():
        # just a count: with thousands of edits a per-edit health check here would be slow (it runs in `update`/`check`)
        return jsonify(count=len(P.future.edits))

    def _clean_edit(j: dict) -> dict:
        """Whitelist + round the editable fields of a Future-map edit. `ctrl` are the control points the
        developer placed, `curve` says they are joined by a smooth spline, `coords` is the resulting polyline
        the router uses, `joins` are indices into coords where the track connects to other track."""
        out: dict = {}
        if j.get('scope') in ('present', 'future'): out['scope'] = j['scope']
        if 'name' in j: out['name'] = str(j['name'])[:120]
        for k in ('coords', 'ctrl'):
            if k in j: out[k] = [[round(float(a), 6), round(float(b), 6)] for a, b in j[k]]
        if 'curve' in j: out['curve'] = bool(j['curve'])
        if isinstance(j.get('tan'), dict):
            out['tan'] = {k: [round(float(x), 5) for x in j['tan'][k]] if j['tan'].get(k) else None for k in ('start', 'end')}
        if isinstance(j.get('tans'), list):              # the direction the track leaves each node, fixed when the node was placed
            out['tans'] = [[round(float(t[0]), 5), round(float(t[1]), 5)] if t else None for t in j['tans']]
        for k in ('snap_s', 'snap_e'):
            if k in j and j[k] is not None: out[k] = bool(j[k])         # did the cursor snap onto track at this end
        if isinstance(j.get('edges'), list):               # segment erase: [base edge id, from m, to m]
            out['edges'] = [[int(a), round(float(b), 1), round(float(c), 1)] for a, b, c in j['edges']]
        if isinstance(j.get('pieces'), list):
            out['pieces'] = [[[round(float(a), 6), round(float(b), 6)] for a, b in pc] for pc in j['pieces']]
        if 'build' in j: out['build'] = str(j['build'])
        if 'segs' in j: out['segs'] = [2 if x == 2 else 1 if x else 0 for x in j['segs']]             # per segment: 0 straight · 1 curved
        if j.get('anchor') in ('left', 'center', 'right'): out['anchor'] = j['anchor']
        if 'tracks' in j: out['tracks'] = max(1, min(8, int(j['tracks'])))      # parallel tracks
        if 'lane_offsets' in j:
            lo = j['lane_offsets']
            if lo and isinstance(lo.get('start'), list) and isinstance(lo.get('end'), list):
                out['lane_offsets'] = {k2: [round(max(-400.0, min(400.0, float(x))), 2) for x in lo[k2]][:8] for k2 in ('start', 'end')}
                for k2 in ('start_pts', 'end_pts'):             # exact positions for lane ends that must land on existing track ends
                    if isinstance(lo.get(k2), list):
                        out['lane_offsets'][k2] = [[round(float(p[0]), 6), round(float(p[1]), 6)] if p else None for p in lo[k2]][:8]
            else:
                out['lane_offsets'] = None
        if 'spacing' in j: out['spacing'] = max(2.0, min(60.0, round(float(j['spacing']), 2)))
        for k in ('joins', 'junctions'):
            if k in j: out[k] = sorted({int(i) for i in j[k]})
        return out

    @app.post('/api/edits')
    def add_edit():
        j = request.get_json()
        if j.get('op') not in ('add_track', 'remove_track') or len(j.get('coords') or []) < 2:
            abort(400)
        op = {'id': 'e' + uuid.uuid4().hex[:8], 'op': j['op'], **_clean_edit({'name': '', **j})}
        with lock:
            save_edits(load_edits() + [op])
            P.reload_future()
            P.mark_dirty(op['coords'], op.get('scope', 'future'))
            health = [r for r in P.future.report if r.get('id') == op['id']]
        return jsonify(edit=op, health=health, recompiled=0)

    @app.post('/api/edits/batch')
    def add_edits_batch():
        """Build several blueprints at once: one reload and one recompile instead of one per edit."""
        items = (request.get_json() or {}).get('edits') or []
        ops = []
        for j in items:
            if j.get('op') not in ('add_track', 'remove_track') or len(j.get('coords') or []) < 2:
                abort(400)
            ops.append({'id': 'e' + uuid.uuid4().hex[:8], 'op': j['op'], **_clean_edit({'name': '', **j})})
        if not ops:
            return jsonify(edits=[], health=[], recompiled=0)
        with lock:
            save_edits(load_edits() + ops)
            P.reload_future()
            n = 0
            for o in ops:
                P.mark_dirty(o['coords'], o.get('scope', 'future'))
            ids = {o['id'] for o in ops}
            health = [r for r in P.future.report if r.get('id') in ids]
        return jsonify(edits=ops, health=health, recompiled=n)

    @app.put('/api/edits/<eid>')
    def update_edit(eid):
        j = request.get_json()
        with lock:
            edits = load_edits()
            cur = next((e for e in edits if e['id'] == eid), None)
            if cur is None:
                abort(404)
            fields = _clean_edit(j); fields.pop('scope', None)       # which map an edit belongs to is fixed
            if 'coords' in fields and len(fields['coords']) < 2:
                abort(400)
            old_pts = [tuple(c) for c in cur['coords']]
            if 'coords' in fields:                       # a new shape replaces the old shape's metadata too
                for k in ('ctrl', 'curve', 'segs', 'tan', 'tans', 'junctions', 'joins', 'lane_offsets'):
                    cur.pop(k, None)
            cur.update(fields)
            save_edits(edits)
            P.reload_future()
            if not request.args.get('quiet'): P.mark_dirty(old_pts + [tuple(c) for c in cur['coords']], cur.get('scope', 'future'))
            recompiled = []
            health = [r for r in P.future.report if r.get('id') == eid]
        return jsonify(edit=cur, health=health, recompiled=len(recompiled))

    def _thin(g, step=30.0):
        """Keep a point about every `step` metres (and both ends): enough to find the same track again, small enough to keep in git."""
        from .geo import haversine
        out, acc = [g[0]], 0.0
        for a, b in zip(g, g[1:]):
            acc += haversine(a, b)
            if acc >= step: out.append(b); acc = 0.0
        if out[-1] != g[-1]: out.append(g[-1])
        return out if len(out) > 1 else [g[0], g[-1]]

    def _erase_body(scope, sel):
        pieces = [_thin(list(g)) for _, _, _, g in sel]
        main = max(pieces, key=len)
        return {'op': 'remove_track', 'scope': scope, 'name': '', 'coords': [list(p) for p in main],
                'pieces': [[list(p) for p in pc] for pc in pieces],
                'edges': [[eid, a, b] for eid, a, b, _ in sel], 'build': P.store.build_id}

    @app.get('/api/edits/pick')
    def pick_segment():
        """The little segment under the cursor (to highlight before a click): kind = erase | restore."""
        scope = 'present' if request.args.get('scope') == 'present' else 'future'
        at = (float(request.args['lat']), float(request.args['lng'])); rad = float(request.args.get('radius_m', 15))
        with lock:
            net = P.present if scope == 'present' else P.future
            if request.args.get('kind') == 'restore':
                p = net.erased_little(at, rad); g = p[4] if p else None
            else:
                p = net.little(at, rad); g = p[3] if p else None
        return jsonify(pts=[[round(a, 6), round(b, 6)] for a, b in g] if g else None)

    @app.post('/api/edits/erase')
    def erase_segments():
        """Erase track by segment: everything inside a drag box (`box` = south,west,north,east), or the one track under `at` (+ radius_m)."""
        j = request.get_json() or {}
        scope = 'present' if j.get('scope') == 'present' else 'future'
        with lock:
            net = P.present if scope == 'present' else P.future
            rad = float(j.get('radius_m') or 15)
            if j.get('path'):                                            # a sweep: every little segment the dragged line passes over
                sel, got = [], []
                for pt in j['path']:
                    p = net.little((float(pt[0]), float(pt[1])), rad)
                    if p and not any(p[0] == g[0] and abs(p[1] - g[1]) < 1 and abs(p[2] - g[2]) < 1 for g in got):
                        got.append(p); sel.append(p)
            else:
                sel = net.select(box=tuple(map(float, j['box'])) if j.get('box') else None,
                                 at=tuple(map(float, j['at'])) if j.get('at') else None, radius_m=rad)
            if not sel:
                return jsonify(edit=None, removed_m=0)
            op = {'id': 'e' + uuid.uuid4().hex[:8], 'op': 'remove_track', **_clean_edit(_erase_body(scope, sel))}
            save_edits(load_edits() + [op])
            P.reload_future()
            P.mark_dirty([tuple(p) for pc in op['pieces'] for p in pc], scope)
        return jsonify(edit=op, removed_m=round(sum(b - a for _, a, b, _ in sel)))

    @app.post('/api/edits/restore')
    def restore_segments():
        """Bring erased track back: whatever erased track lies inside the drag box (`box`) returns, on the given map's own erases."""
        from .network import clip_path_box, subtract_spans, _cum, _sub
        j = request.get_json() or {}
        scope = 'present' if j.get('scope') == 'present' else 'future'
        box = tuple(map(float, j['box'])) if j.get('box') else None
        undo, restored = [], 0.0
        with lock:
            net = P.present if scope == 'present' else P.future
            picks: dict[tuple, list] = {}                                  # (erase id, base edge) -> little segments to bring back
            for pt in ([j['at']] if j.get('at') else j.get('path') or []):
                p = net.erased_little((float(pt[0]), float(pt[1])), float(j.get('radius_m') or 15))
                if p: picks.setdefault((p[0], p[1]), []).append((p[2], p[3]))
            edits = load_edits(); out = []; touched = []
            for op in edits:
                if op.get('op') != 'remove_track' or op.get('scope', 'future') != scope:
                    out.append(op); continue
                spans = net.op_spans.get(op['id']) or {}
                new, hit = [], False
                for eid, sp in spans.items():
                    e = P.store.edge(eid); cum = _cum(e.geom)
                    cuts = clip_path_box(e.geom, cum, box) if box else picks.get((op['id'], eid), [])
                    left = subtract_spans(sp, cuts) if cuts else list(sp)
                    if cuts and sum(b - a for a, b in left) < sum(b - a for a, b in sp) - 0.5:
                        hit = True; restored += sum(b - a for a, b in sp) - sum(b - a for a, b in left)
                    new += [(eid, a, b, _sub(e.geom, cum, a, b)) for a, b in left]
                if not hit:
                    out.append(op); continue
                undo.append({'id': op['id'], 'body': {k: v for k, v in op.items() if k != 'id'}})
                touched += [tuple(p) for pc in (op.get('pieces') or [op['coords']]) for p in pc]
                if new:
                    out.append({'id': op['id'], 'op': 'remove_track', **_clean_edit(_erase_body(scope, new))})
            if undo:
                save_edits(out); P.reload_future(); P.mark_dirty(touched, scope)
        return jsonify(restored_m=round(restored), undo=undo)

    @app.get('/api/edits/view')
    def edits_in_view():
        """Edits (with their control points) that touch the viewport: for selecting and editing them on the map."""
        s_, w_, n_, e_ = map(float, request.args['bbox'].split(','))
        out = []
        with lock:
            for e in (P.present.edits if request.args.get('map') == 'present' else P.future.edits):
                cs = e['coords']
                la = [c[0] for c in cs]; lo = [c[1] for c in cs]
                if max(la) < s_ or min(la) > n_ or max(lo) < w_ or min(lo) > e_:
                    continue
                if e.get('op') == 'remove_track':
                    continue                                 # erased segments are managed with Erase / Restore, never edited as lines
                out.append({k: v for k, v in e.items() if k != 'pieces'})
                if len(out) >= int(request.args.get('limit', 3000)):
                    break
        return jsonify(out)

    @app.delete('/api/edits/<eid>')
    def del_edit(eid):
        with lock:
            edits = load_edits()
            if eid == 'last' and edits:
                eid = edits[-1]['id']
            gone = [e for e in edits if e['id'] == eid]
            save_edits([e for e in edits if e['id'] != eid])
            P.reload_future()
            n = 0
            if gone:
                P.mark_dirty([tuple(c) for c in gone[0]['coords']], gone[0].get('scope', 'future'))
        return jsonify(ok=True, recompiled=n)

    @app.get('/api/dirty')
    def dirty_status():
        """How many lines the track changed since the last refresh may have affected."""
        with lock:
            d = P.dirty_cells()
            lines = P.affected_routes() if d['present'] or d['future'] else []
        return jsonify(changed=len(d['present']) + len(d['future']), lines=len(lines),
                       names=[f'{o} — {l} — {p}' + (' [Future]' if c == 'Fantasy' else '') for o, l, p, c in lines[:60]])

    @app.post('/api/refresh_affected')
    def refresh_affected():
        with lock:
            reports = P.refresh_affected()
        return jsonify(reports=reports, count=len(reports), changed=sum(1 for r in reports if r.get('changed')),
                       changed_lines=[{k: r.get(k) for k in ('operator', 'line', 'pattern', 'category')} for r in reports if r.get('changed')],
                       bad=[{'pattern': r.get('pattern'), 'category': r.get('category'), 'warnings': r['warnings']} for r in reports if not r['ok']],
                       notes=[{'pattern': r.get('pattern'), 'category': r.get('category'), 'warnings': r['warnings']} for r in reports if r['ok'] and r['warnings']])

    @app.post('/api/compile')
    def compile_all():
        with lock:
            reps = P.compile_all(log=lambda *_: None)
        return jsonify(total=len(reps), failed=[r for r in reps if not r['ok']])

    def migrate_erases():
        """Erase lines drawn with the old tool become plain erased segments: the line itself is forgotten, only the track it hid is kept."""
        with lock:
            edits = load_edits()
            old = [e for e in edits if e.get('op') == 'remove_track' and not e.get('edges')]
            if not old:
                return 0
            net = P.future
            out = []
            for e in edits:
                if e not in old:
                    out.append(e); continue
                sel = []
                for eid, sp in (net.op_spans.get(e['id']) or {}).items():
                    ed = P.store.edge(eid); cum = _cum(ed.geom)
                    sel += [(eid, a, b, _sub(ed.geom, cum, a, b)) for a, b in sp]
                if sel:
                    out.append({'id': e['id'], 'op': 'remove_track', **_clean_edit(_erase_body(e.get('scope', 'future'), sel))})
            save_edits(out); P.reload_future()
            return len(old)
    migrate_erases()
    return app