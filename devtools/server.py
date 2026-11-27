"""Local tracing UI. Binds to 127.0.0.1 only; never part of the published site."""
from __future__ import annotations
import base64, collections, contextlib, gzip, importlib, json, logging, math, os, sys, threading, time, uuid

from flask import Flask, Response, jsonify, request, send_from_directory, abort

from . import config
from .tracks import TrackProject, compress_wps
from core.traced import CATS, as_polylines, get_entry as _get, drop_entry as _drop
from core.datafile import load_namespace
from core.fileio import read_json
from core.station_resolver import normalize_stations, is_airport, plain_name
from .network import load_edits, save_edits
from core.geo import bbox_of, pad_bbox
from .network import _cum, _sub

DEFAULT_MODULE = 'data.detailed_map'

def _pl_type(spec):
    """A platform's own airport setting, in the form the panel reads: Type 'Airport' / None (explicitly not) / absent (follows its station)."""
    if 'Airport' in spec:
        v = spec.pop('Airport'); spec['Type'] = 'Airport' if str(v).lower() == 'true' else None

    return spec

def map_data_file(module: str, path: str | None = None) -> str | None:
    """The detailed map file on disk (None when `module` is an in-memory stand-in, as in the tests)."""
    if path: return path
    if module == DEFAULT_MODULE:
        from .mapdata import ensure_detailed_map
        return ensure_detailed_map()

    import importlib.util
    try:
        spec = importlib.util.find_spec(module)
    except (ImportError, ValueError):
        return None

    return spec.origin if spec and spec.origin and os.path.isfile(spec.origin) else None

def _load_project_data(module: str, path: str | None = None):
    f = map_data_file(module, path)
    ns = load_namespace(f) if f else vars(importlib.import_module(module))      # a file is run fresh each time: always current after a write-back
    return (ns['Lines'], ns['Segments'], normalize_stations(ns['Nodes']),
            normalize_stations(ns['Stations']), ns.get('Modes', {}))

def create_app(map_data_module: str = DEFAULT_MODULE, project: TrackProject | None = None,
               map_data_path: str | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)       # no line per request: the terminal shows only slow requests, warnings and errors
    lock = threading.RLock()                    # one writer at a time: edits, saves, recompiles
    nolock = contextlib.nullcontext()           # read-only requests do not wait for a writer (or for each other)
    P = project or TrackProject()

    @app.before_request
    def _t0():
        request._t0 = time.time()

    @app.after_request
    def _after(r):
        dt = time.time() - getattr(request, '_t0', time.time())
        if dt > 1.0 and request.path.startswith('/api/'):
            print(f"[slow] {request.method} {request.path} took {dt:.1f}s", flush=True)      # shows which request is holding things up

        try:                                        # big JSON answers (the track overlay) travel compressed
            if r.status_code == 200 and r.mimetype == 'application/json' and not r.direct_passthrough and 'Content-Encoding' not in r.headers and 'gzip' in request.headers.get('Accept-Encoding', ''):
                body = r.get_data()
                if len(body) > 20000:
                    r.set_data(gzip.compress(body, 3)); r.headers['Content-Encoding'] = 'gzip'; r.headers['Vary'] = 'Accept-Encoding'
        except Exception:
            pass

        return r

    P.station_path = map_data_file(map_data_module, map_data_path)

    def data():
        return _load_project_data(map_data_module, map_data_path)

    def pat_args(src):
        return src['operator'], src['line'], src['pattern'], src['category']

    # Static
    @app.get('/')
    def index():
        return send_from_directory(config.STATIC_DIR, 'index.html')

    @app.get('/favicon.ico')
    def favicon():
        return ('', 204)

    @app.get('/static/<path:name>')
    def static_files(name):
        return send_from_directory(config.STATIC_DIR, name)

    # Status / catalog
    @app.get('/api/status')
    def status():
        from .updater import load_report
        return jsonify(graph=P.store.meta('source'), edges=P.store.meta('edges'),
                       build=P.store.build_id, edits=len(P.future.edits), report=load_report(),
                       future_track=len(P.store.future_ids()), has_kinds=P.store.meta('kinds') is not None)

    @app.get('/api/catalog')
    def catalog():
        Lines, *_ = data()
        wdoc, gdoc, seqs = P.waypoints_doc(), P.geometry_doc(True), P.pattern_seqs()
        out = []
        for op, lines in Lines.items():
            for line, cats in lines.items():
                for cat in CATS:
                    for pat, pd in (cats.get(cat) or {}).items():
                        w = _get(wdoc, op, line, pat, cat) or {}
                        out.append(dict(
                            operator=op, line=line, pattern=pat, category=cat, mode=pd.get('Mode'),
                            waypoints=max(len(w.get('waypoints') or []), len(seqs.get((op, line, pat, cat)) or [])),      # a pattern's stops are its route
                            compiled=bool(_get(gdoc, op, line, pat, cat))))

        return jsonify(out)

    @app.get('/api/modes')
    def modes_list():
        return jsonify(list(data()[4]))

    @app.post('/api/route_def')
    def route_create():
        from . import routes as RT
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); src = j.get('copy_from')                 # {pattern, category}: start as a copy of another pattern of the line
        try:
            with lock:
                RT.create_route(f, j['operator'], j['line'], j['pattern'], j['category'], j['mode'])
                if src:
                    from . import stops as ST
                    op, line, pat, cat = j['operator'].strip(), j['line'].strip(), j['pattern'].strip(), j['category']
                    ST.copy_pattern(f, op, line, src['pattern'], src['category'], pat, cat)
                    wdoc = P.waypoints_doc(); old = _get(wdoc, op, line, src['pattern'], src['category'])
                    if old and old.get('waypoints'):                       # the path's extra waypoints come along, so it is traced the same way
                        _get(wdoc, op, line, pat, cat, create=True).update({'waypoints': json.loads(json.dumps(old['waypoints']))}); P.save_waypoints_doc(wdoc)

                    if src['category'] != cat: fit_copy(f, op, line, pat, cat)
                    try: P.compile_one(op, line, pat, cat, keep=True)
                    except Exception: pass                                 # it can be refreshed from the route's own button

        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True)

    def remove_route(f, op, line, pat, cat):
        from . import routes as RT
        RT.delete_route(f, op, line, pat, cat)
        wdoc = P.waypoints_doc(); _drop(wdoc, op, line, pat, cat); P.save_waypoints_doc(wdoc)
        g = P.geometry_doc(); _drop(g, op, line, pat, cat); P.save_geometry_doc(g)
        P._record_sigs({}, drop=[(op, line, pat, cat)])                    # its path fingerprint goes too

    @app.put('/api/route_mode')
    def route_mode():
        """{operator, line, pattern | null, mode, category | null}: the mode of that pattern, or (pattern null) of every pattern of the line, on both maps or (category) only that one"""
        from . import routes as RT
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock: done = RT.set_mode(f, j['operator'], j['line'], j.get('pattern') or None, j['mode'], j.get('category') or None)
        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True, patterns=done)

    @app.patch('/api/route_def')
    def route_rename():
        from . import stops as ST
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); op, line, old, new = j['operator'], j['line'], j['pattern'], j['new_name'].strip()
        try:
            with lock:
                cats = ST.rename_pattern(f, op, line, old, new)
                docs = [(P.waypoints_doc(), P.save_waypoints_doc), (P.geometry_doc(), P.save_geometry_doc)]
                for doc, save in docs:                                          # its waypoints and traced path keep with it
                    moved = [(c, _get(doc, op, line, old, c)) for c in cats]
                    for c, e in moved:
                        if e is not None: _drop(doc, op, line, old, c); _get(doc, op, line, new, c, create=True); doc[op][line][new][c] = e

                    if any(e is not None for _c, e in moved): save(doc)

                sigs = read_json(P.SIG_FILE, {}).get('sigs', {})                  # so is its path fingerprint: the path itself has not changed
                P._record_sigs({(op, line, new, c): sigs['|'.join((op, line, old, c))] for c in cats if '|'.join((op, line, old, c)) in sigs}, drop=[(op, line, old, c) for c in cats])

        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True, categories=cats)

    @app.patch('/api/operator')
    def operator_rename():
        """{operator, new_name}: the operator's new name on both maps, for every line it runs; their waypoints, paths and path fingerprints keep with them"""
        from . import stops as ST
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); old, new = j['operator'], (j.get('new_name') or '').strip()
        try:
            with lock:
                routes = ST.rename_operator(f, old, new)
                if new == old: return jsonify(ok=True, routes=0)
                for doc, save in ((P.waypoints_doc(), P.save_waypoints_doc), (P.geometry_doc(), P.save_geometry_doc)):
                    if old in doc: doc[new] = doc.pop(old); save(doc)

                sigs = read_json(P.SIG_FILE, {}).get('sigs', {})                  # the paths themselves have not changed
                keys = [(l, p, c) for l, p, c in routes if '|'.join((old, l, p, c)) in sigs]
                P._record_sigs({(new, l, p, c): sigs['|'.join((old, l, p, c))] for l, p, c in keys}, drop=[(old, l, p, c) for l, p, c in keys])
        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True, operator=new, routes=len(routes))

    @app.delete('/api/route_def')
    def route_delete():
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        op, line, pat, cat = pat_args(request.args)
        try:
            with lock: remove_route(f, op, line, pat, cat)
        except ValueError as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True)

    def fit_copy(f, op, line, pat, cat):
        """A route copied from the other map drops the platforms its own map does not have; waypoints pinned to them follow"""
        from . import stops as ST
        done = ST.fit_to_map(f, op, line, pat, cat)
        if not done: return
        wdoc = P.waypoints_doc(); e = _get(wdoc, op, line, pat, cat)
        if not e or not e.get('waypoints'): return
        out = []
        for w in e['waypoints']:
            k = w.get('stop') if isinstance(w, dict) else None
            if k in done and done[k] is None: continue
            out.append(dict(w, stop=done[k]) if k in done else w)

        e['waypoints'] = out; P.save_waypoints_doc(wdoc)

    def inherit(f, op, line, pat, src, dst):
        """The dst version of a pattern takes the stops and waypoints of its src version and is traced again on its own map"""
        from . import stops as ST
        ST.copy_route(f, op, line, pat, src, dst)
        wdoc = P.waypoints_doc(); have = (_get(wdoc, op, line, pat, src) or {}).get('waypoints')
        if have: _get(wdoc, op, line, pat, dst, create=True)['waypoints'] = json.loads(json.dumps(have))          # the path between the stops bends the same way
        else: _drop(wdoc, op, line, pat, dst)

        P.save_waypoints_doc(wdoc); fit_copy(f, op, line, pat, dst)
        try: P.compile_one(op, line, pat, dst, keep=True)
        except Exception: pass                                                           # it can be refreshed from the route's own button

    @app.post('/api/route_inherit')
    def route_inherit():
        """{operator, line, pattern, category}: that version takes the stops and platforms of the same pattern on the other map (its path is traced again on its own map)."""
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); op, line, pat, dst = j['operator'], j['line'], j['pattern'], j['category']
        src = 'Present' if dst == 'Fantasy' else 'Fantasy'
        try:
            with lock:
                cats = data()[0][op][line]
                if pat not in (cats.get(src) or {}) or pat not in (cats.get(dst) or {}): return jsonify(error=f"this route has no {'Present' if src == 'Present' else 'Future'} version to copy from"), 409
                inherit(f, op, line, pat, src, dst)
        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True)

    @app.post('/api/route_maps')
    def route_maps():
        """Which map(s) a pattern is on; one added starts with the other's stops and is traced on its own map"""
        from . import routes as RT, stops as ST
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); op, line, pat = j['operator'], j['line'], j['pattern']
        want = {'present': {'Present'}, 'future': {'Fantasy'}, 'both': {'Present', 'Fantasy'}}.get(j['value'])
        if want is None: abort(400)
        try:
            with lock:
                cats = data()[0][op][line]
                have = {c for c in ('Present', 'Fantasy') if pat in (cats.get(c) or {})}
                if not have: return jsonify(error='no such route'), 404
                mode = next((cats[c][pat].get('Mode') for c in ('Present', 'Fantasy') if c in have), None)
                for c in sorted(want - have):                                                    # add first: if that fails nothing has been removed
                    RT.create_route(f, op, line, pat, c, mode)
                    if len(have) == 1: inherit(f, op, line, pat, next(iter(have)), c)          # the new version starts identical to the one it joins

                for c in sorted(have - want): remove_route(f, op, line, pat, c)
        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

        return jsonify(ok=True)

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
            for sk in build_station_sequence(pd, Segments):
                st = Stations.get(sk)
                if st and st.get('Location') and sk not in out:
                    out[sk] = {'key': sk, 'label': st.get('Label') or plain_name(sk), 'lat': st['Location'][0], 'lon': st['Location'][1]}

        return jsonify(list(out.values()))

    @app.put('/api/stations')
    def move_stations_api():
        from .mapdata import move_stations
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        moves = request.get_json().get('moves') or {}
        try:
            with lock:
                from .mapdata import forget_stations
                out = move_stations(f, moves); forget_stations(f)
                reps = P.recompile_stop_users(moves.keys())        # routes that stop at a moved station / platform follow it
                return jsonify({**out, 'reports': reps})
        except (ValueError, StopIteration) as e:
            return jsonify(error=str(e)), 409

    # Stations and platforms (the detailed map)
    def _bbox_arg():
        s, w, n, e = map(float, request.args['bbox'].split(','))
        return s, w, n, e

    @app.get('/api/osm_stops')
    def osm_stops():
        """Named stops of OpenStreetMap (points) in a box: a hint for naming a station."""
        return jsonify(ready=P.store.has_stops(), stops=P.store.osm_stops(_bbox_arg(), 3000))

    @app.get('/api/pattern_stops')
    def pattern_stops_get():
        from . import stops as ST
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        a = request.args
        try: return jsonify(ST.pattern_stops(f, a['operator'], a['line'], a['category'], a['pattern']))
        except KeyError: abort(404)

    @app.post('/api/pattern_stops')
    def pattern_stops_edit():
        from . import stops as ST
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock:
                ch = j['change'] or {}
                before = (ST.pattern_stops(f, j['operator'], j['line'], j['category'], j['pattern']).get('shared') or []) if ch.get('shared') else []       # only a shared edit needs the routes sharing it
                if 'move' in ch:
                    from .stopmove import move_stop
                    mv = ch['move']; move_stop(f, j['operator'], j['line'], j['category'], j['pattern'], mv['key'], mv['near'], mv.get('side', 'after'), bool(ch.get('shared')), int(mv.get('nth') or 0), int(mv.get('near_nth') or 0))
                else:
                    if ch.get('shuttle'): j['change'] = {**ch, 'platforms': P.shuttle_platforms(j['operator'], j['line'], j['pattern'], j['category'])}          # only the platforms on its own tracks, not those of other lines at its stations
                    ST.edit_pattern_stops(f, j['operator'], j['line'], j['category'], j['pattern'], j['change'])

                out = ST.pattern_stops(f, j['operator'], j['line'], j['category'], j['pattern'])
                todo = [(j['operator'], j['line'], j['pattern'], j['category'])]
                if (j['change'] or {}).get('shared'):                        # the shared list itself changed: everything sharing it follows
                    todo += [(x['operator'], x['line'], x['pattern'], x['category']) for x in before]

                reports = []
                for o, l, p, c in todo:                                     # the stops are the route: a new stop list is a new path
                    reports.append(P.compile_one(o, l, p, c))

                return jsonify({**out, 'reports': reports})
        except (ValueError, KeyError) as e:
            return jsonify(error=str(e)), 409

    stl = {'sig': None, 'list': None, 'body': None}

    def stations_all(f):
        """Every station of the detailed map, as the tracer shows it. Built once and kept until a map file changes (it scans every route for usage)."""
        import glob
        from .mapdata import station_usage, plain_name
        from . import availability as AV
        sig = tuple(os.path.getmtime(x) for x in sorted(glob.glob(os.path.join(os.path.dirname(f), '*.py'))) + list(AV.FILES) if os.path.exists(x))
        if stl['sig'] == sig and stl['list'] is not None: return stl['list']
        use = station_usage(f); fut = AV.platform_versions(); only = AV.load(); fnames = AV.future_names(); out = []
        for name, d in load_namespace(f)['Stations'].items():
            plats = d.get('Platforms') or {}
            pts = [d['Location']] if d.get('Location') else [(v['Location'] if isinstance(v, dict) else v) for v in plats.values()]
            lo = d.get('Location') or (sum(q[0] for q in pts) / len(pts), sum(q[1] for q in pts) / len(pts))
            eff = {p: AV.effective(only, name, p or None) for p in [''] + list(plats)}
            out.append({'name': name, 'title': plain_name(name), 'location': list(lo), 'single': 'Location' in d,
                        'used': {'': use.get(name, [])} | {p: use.get(f"{name} {{{p}}}", []) for p in plats}, 'span': d.get('Span'), 'label': d.get('Label'), 'major': d.get('Major'), 'type': 'Airport' if is_airport(d) else None,
                        'region': d.get('Region'), 'futureName': fnames.get(name),
                        'maps': {p: v for p, v in eff.items() if v != 'both'},                     # what each platform is: 'present' / 'future' (absent: both). '' is the station's own setting
                        'own': [p for p in plats if AV.key_of(name, p) in only],                  # platforms with a setting of their own (the rest follow the station)
                        'future': {p: fut[AV.key_of(name, p)] for p in [''] + list(plats) if AV.key_of(name, p) in fut},      # a Future shape made earlier (no longer created)
                        'pts': pts,
                        'platforms': {p: _pl_type(dict(v) if isinstance(v, dict) else {'Location': v}) for p, v in plats.items()}})

        stl.update(sig=sig, list=out, body=None)
        return out

    @app.get('/api/station_list')
    def station_list():
        """Stations of the detailed map (in a box, or all of them), as written there (platforms, spans)."""
        f = map_data_file(map_data_module, map_data_path)
        if not f: return jsonify([])
        out = stations_all(f)
        if 'bbox' in request.args:
            box = _bbox_arg()
            out = [x for x in out if any(box[0] <= q[0] <= box[2] and box[1] <= q[1] <= box[3] for q in x['pts'])]

        return jsonify([{k: v for k, v in x.items() if k != 'pts'} for x in out[:5000]])

    @app.post('/api/platform_spans')
    def platform_spans_api():
        """The platform between two points clicked on one rail: {spans: [{a, b, mid, length_m, pts, ...}]} (empty when they are not on the same rail)."""
        from .platforms import span_between
        j = request.get_json(); net = P.net(j.get('map', 'present'))
        sp = span_between(net, tuple(j['between'][0]), tuple(j['between'][1]))
        return jsonify(spans=[sp] if sp else [])

    @app.get('/api/snap')
    def snap_api():
        """The nearest rail point to (lat, lng) on the given map: {point, dist_m, edge} or {point: null}."""
        from .platforms import snap_point
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            r = snap_point(P.net(request.args.get('map', 'present')), (float(request.args['lat']), float(request.args['lng'])), float(request.args.get('max_m', 30)))

        return jsonify(r or {'point': None})

    @app.post('/api/platform_default')
    def platform_default_api():
        """A platform of ~80 m centred on the rail nearest a point (for a station dot that has no span yet)."""
        from .platforms import default_span
        j = request.get_json()
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            sp = default_span(P.net(j.get('map', 'present')), tuple(j['at']), float(j.get('length_m', 80)))

        return jsonify(span=sp)

    # Locked track directions
    @app.get('/api/directions')
    def directions_view():
        """The locked stretches in a box, as the map `map` sees them: [{p: path oriented the way trains may run}]."""
        from . import directions as D
        return jsonify(D.arrows(P.net(request.args.get('map', 'present')), _bbox_arg()))          # no lock: the locks are swapped in whole, so this never waits for a click

    @app.get('/api/directions/probe')
    def directions_probe():
        """Hover: the stretch of track under a point and which way it is locked, so the tool can light it up before a click."""
        from . import directions as D
        import time; t0 = time.time()
        if not lock.acquire(timeout=1.5):                                   # another request is busy: say so quickly rather than queue behind it
            return jsonify(error='busy'), 503

        try:
            try: out = D.probe(P.net(request.args.get('map', 'present')), (float(request.args['lat']), float(request.args['lon'])))
            except ValueError as e: return jsonify(error=str(e)), 404
        finally: lock.release()

        if time.time() - t0 > 0.5: print(f"[directions] hover took {time.time() - t0:.2f}s ({out['edges']} edges)", flush=True)
        return jsonify(out)

    @app.post('/api/directions/cycle')
    def directions_cycle():
        """Click on track: free -> one way -> the other way -> free, for the whole stretch up to the next junctions."""
        from . import directions as D
        j = request.get_json(); which = j.get('map', 'present'); scope = 'present' if which == 'present' else 'future'
        import time; t0 = time.time()
        with lock:
            try: out = D.cycle(P.net(which), scope, j['at'], D.load(), j.get('kind') or 'dir')
            except ValueError as e: return jsonify(error=str(e)), 400

            t1 = time.time()
            D.save(out['locks']); P.apply_locks()
            P.mark_dirty([tuple(p) for p in out['pts']], scope)               # routes along it need re-tracing: shown by Refresh affected lines

        if time.time() - t0 > 1.0: print(f"[directions] slow click: stretch of {len(out['edges'])} edges, found in {t1 - t0:.2f}s, applied in {time.time() - t1:.2f}s", flush=True)
        return jsonify(dir=out['dir'], pts=out['pts'], stretch_edges=len(out['edges']))

    @app.put('/api/platform_maps')
    def platform_maps():
        """{station, platform: name | null, value: 'present' | 'future' | 'both'}. platform null: the whole station (every platform, their own settings cleared)."""
        from . import availability as AV
        j = request.get_json()
        with lock:
            AV.choose(j['station'], j.get('platform') or None, j['value'])

        return jsonify({'reports': []})

    @app.put('/api/future_name')
    def future_name_set():
        """{station, name}: what the Future map calls this station (blank: its usual name)."""
        from . import availability as AV
        j = request.get_json()
        with lock:
            AV.set_future_name(j['station'], j.get('name'))
            return jsonify({'name': (j.get('name') or '').strip()})

    @app.put('/api/platform_future')
    def platform_future_set():
        """{station, platform|null, fields: {Location, Span}}: give a platform its own Future version (or change it). A new Future version starts as a copy of the platform."""
        from . import availability as AV
        j = request.get_json(); key = AV.key_of(j['station'], j.get('platform'))
        with lock:
            out = AV.set_platform_version(key, j['fields'])
            return jsonify({'future': out, 'reports': P.recompile_stop_users([key])})

    @app.delete('/api/platform_future')
    def platform_future_drop():
        """{station, platform|null}: the Future map uses the shared platform again."""
        from . import availability as AV
        j = request.get_json(); key = AV.key_of(j['station'], j.get('platform'))
        with lock:
            AV.drop_platform_version(key)
            return jsonify({'reports': P.recompile_stop_users([key])})

    @app.post('/api/platform_spans_through')
    def platform_through_api():
        """The platform between two points that are already on rails (an end was dragged): {span} (null when they are not one continuous track)."""
        from .platforms import span_through
        j = request.get_json()
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            return jsonify(span=span_through(P.net(j.get('map', 'present')), tuple(j['a']), tuple(j['b'])))

    @app.post('/api/platform_slide')
    def platform_slide_api():
        """The same platform moved onto the rail nearest `to` (dragged by its middle): {span} or null."""
        from .platforms import slide
        j = request.get_json()
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            return jsonify(span=slide(P.net(j.get('map', 'present')), tuple(j['to']), tuple(j['a']), tuple(j['b'])))

    @app.post('/api/platform_set')
    def platform_set_api():
        """{map, at, count, length_m}: that many platforms on the neighbouring parallel tracks around a point, one on each: {spans: [span | null, ...]}."""
        from .platforms import platform_set
        j = request.get_json()
        with nolock:
            sp = platform_set(P.net(j.get('map', 'present')), tuple(j['at']), max(1, min(12, int(j.get('count', 2)))), max(10.0, min(600.0, float(j.get('length_m', 80)))))

        return jsonify(spans=sp)

    @app.post('/api/platform_move_set')
    def platform_move_set_api():
        """{map, spans: [[a, b], ...], dlat, dlng}: those platforms moved together: {spans: [...]} or {spans: null} when one does not fit on a rail there."""
        from .platforms import move_set
        j = request.get_json()
        with nolock:
            return jsonify(spans=move_set(P.net(j.get('map', 'present')), j['spans'], float(j['dlat']), float(j['dlng'])))

    @app.post('/api/platform_shapes')
    def platform_shapes_api():
        """The rail each given span [a, b] covers, to draw it along the track: {shapes: [[[lat, lon], ...] | null, ...]}."""
        from .platforms import shape
        j = request.get_json(); net = P.net(j.get('map', 'present'))
        cache = net.__dict__.setdefault('_shapes', collections.OrderedDict())       # per network: an edit makes a new network, so stale shapes go with the old one
        t_end = time.time() + 2.5; out = []
        for sp in j['spans'][:400]:
            k = (round(sp[0][0], 6), round(sp[0][1], 6), round(sp[1][0], 6), round(sp[1][1], 6))
            if k in cache: out.append(cache[k])
            elif time.time() > t_end: out.append(False)                           # out of time: false = "not worked out yet, ask again"
            else: out.append(cache.setdefault(k, shape(net, sp)))

        while len(cache) > 20000: cache.popitem(last=False)
        return jsonify(shapes=out)

    @app.post('/api/station')
    def station_create():
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock:
                out = M.create_station(f, j['name'], j['location'], j.get('region'), j.get('span'), Label=j.get('label'), Major=j.get('major'), Type=j.get('type'))
                if j.get('maps') in ('present', 'future'):          # a new station is on the map it was made on
                    from . import availability as AV; AV.choose(out['name'], None, j['maps'])

                return jsonify(out)
        except ValueError as e:
            return jsonify(error=str(e)), 409

    @app.get('/api/municipalities')
    def municipalities():
        """Municipalities already used by stations (with their subdivision and country), most used first: suggestions while typing."""
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        q = (request.args.get('q') or '').strip().lower()           # optional: the tracer asks for all of them once and filters as you type
        seen: dict = {}
        for st in stations_all(f):
            r = st.get('region')
            if r and len(r) >= 3 and r[0]:
                k = (r[0], r[1], r[2]); seen[k] = seen.get(k, 0) + 1

        out = [{'municipality': m, 'subdivision': sub, 'country': c, 'text': f"{m}, {sub}, {c}", 'n': n} for (m, sub, c), n in seen.items()
               if not q or q in m.lower() or q in f"{m}, {sub}, {c}".lower()]
        out.sort(key=lambda x: (not x['municipality'].lower().startswith(q), -x['n'], x['municipality'].lower()))
        return jsonify(out[:500])

    @app.put('/api/station_region')
    def station_region():
        """Sets a station's municipality; subdivision and country come from its position unless picked"""
        from . import mapdata as M
        from core import regions as RG
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); name = j['station']; mun = (j.get('municipality') or '').strip()
        try:
            with lock:
                if not mun:
                    out = M.set_station(f, name, {'Region': None}); return jsonify({**out, 'region': None})

                # where the station is decides the state and country: a picked suggestion only names the town (Pontiac, Illinois is not Pontiac, Michigan)
                sub, code = (j.get('subdivision') or '').strip(), (j.get('country') or '').strip()
                d = M.load_namespace(f)['Stations'].get(name)
                if d is None: raise ValueError(f"unknown station '{name}'")
                pts = [d['Location']] if d.get('Location') else [(v['Location'] if isinstance(v, dict) else v) for v in (d.get('Platforms') or {}).values()]
                hit = RG.locate(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) if pts and RG.available() else None
                if hit: sub, code = hit
                elif not (sub and code):
                    if not pts: raise ValueError(f"'{name}' has no location")
                    if not RG.available(): raise ValueError("no outlines in data/regions to find the country and state from")
                    raise ValueError(f"'{name}' is not inside any country outline in data/regions")

                out = M.set_station(f, name, {'Region': [mun, sub, code]})
                return jsonify({**out, 'region': [mun, sub, code]})
        except ValueError as e:
            return jsonify(error=str(e)), 409

    @app.put('/api/station')
    def station_set():
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock:
                out = M.set_station(f, j['name'], j['fields'])
                return jsonify({**out, 'reports': P.recompile_stop_users([j['name']])})
        except ValueError as e:
            return jsonify(error=str(e)), 409

    def _twin_ok(station_raw, station, name, maps, me=None):
        """May this platform share its name with one the station already has? Only when they are on different maps (Present only / Future only)."""
        pl = (station_raw or {}).get('Platforms') or {}
        if not name or name not in pl or name == me: return False
        from . import availability as AV
        d = AV.load(); mine = maps if me is None else AV.effective(d, station, me)
        theirs = AV.effective(d, station, name)
        if mine in ('present', 'future') and theirs in ('present', 'future') and mine != theirs: return True
        raise ValueError(f"'{station}' already has a platform '{name}' on {'both maps' if theirs == 'both' else theirs + ' only'}. Two platforms can share a name only "
                         "when one is Present only and the other Future only: change that setting first.")

    @app.post('/api/platform')
    def platform_add():
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock:
                from . import availability as AV
                was = load_namespace(f)['Stations'].get(j['station']) or {}
                twin = _twin_ok(was, j['station'], (j.get('platform') or '').strip(), j.get('maps'))
                out = M.add_platform(f, j['station'], j.get('platform'), j['location'], j.get('span'), first=j.get('first') or 'Main', twin=twin, Major=j.get('major', False), Type=j.get('type', False))
                if 'Location' in was:                               # a one-platform station gained a second: a Future shape made earlier moves to the platform that was its own
                    AV.rename({j['station']: f"{j['station']} {{{j.get('first') or 'Main'}}}"}, only=('overrides',))

                if j.get('maps') in ('present', 'future') and j.get('platform'):
                    AV.choose(j['station'], out.get('platform') or j['platform'], j['maps'])             # the map it was made on (kept only where that differs from its station)

                return jsonify(out)
        except ValueError as e:
            return jsonify(error=str(e)), 409

    @app.put('/api/platform')
    def platform_set():
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock:
                out = M.set_platform(f, j['station'], j.get('platform'), j['fields'])
                key = j['station'] if j.get('platform') is None else f"{j['station']} {{{j['platform']}}}"
                return jsonify({**out, 'reports': P.recompile_stop_users([key])})     # routes that stop here follow it
        except ValueError as e:
            return jsonify(error=str(e)), 409

    def _renamed(out, mapping):
        """After renaming / merging in the detailed map: pinned stops follow, and the routes that stop there are recompiled."""
        P.rename_stops(mapping)
        from . import availability as AV; AV.rename(mapping)
        return {**out, 'reports': P.recompile_stop_users(set(mapping.values()))}

    # Destinations: venues from the simplified map, serving stations from the detailed one
    def _simple_destinations():
        """{category: {name: venue}} from data/map_data.py (read only, re-read when that file changes); {} when it is not there."""
        from core.datafile import load_namespace_cached
        f = getattr(config, 'SIMPLE_FILE', None)
        if not f or not os.path.exists(f): return {}
        try: return load_namespace_cached(f).get('Destinations') or {}
        except Exception: return {}

    def _dest_item(M, cat, name, v, mine):
        o = (mine.get(cat) or {}).get(name) or {}; loc = v.get('Location')
        return {'cat': cat, 'name': name, 'location': list(loc) if loc else None,
                'setting': M.exists_setting(o if 'Exists' in o else v), 'own': 'Exists' in o,
                'image': (v.get('Image')[0] if isinstance(v.get('Image'), (list, tuple)) and v.get('Image') else v.get('Image')) or '',
                'stations': list(o.get('Stations') or []), 'futureStations': list(o.get('FutureStations') or [])}

    @app.get('/api/destinations')
    def destinations_api():
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: return jsonify({'items': [], 'found': False})
        simple = _simple_destinations(); mine = M.load_namespace_cached(f).get('Destinations') or {}
        return jsonify({'items': [_dest_item(M, cat, name, v, mine) for cat, d in simple.items() for name, v in d.items() if isinstance(v, dict)], 'found': bool(simple)})

    @app.post('/api/destination_def')
    def destination_def():
        """Creates, updates or deletes a simplified-map venue; the detailed map's data follows"""
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path); sf = getattr(config, 'SIMPLE_FILE', None)
        if not f or not sf or not os.path.exists(sf): return jsonify(error='data/map_data.py was not found'), 400
        j = request.get_json(); act, cat, name = j.get('action'), j.get('cat'), j.get('name')
        try:
            with lock:
                if act == 'create':
                    out = M.create_simple_destination(sf, cat, name, j['location'], M.EXISTS_OF.get(j.get('setting') or 'both', M.EXISTS_OF['both'])); new_name, new_cat = (name or '').strip(), cat
                elif act == 'update':
                    new_name, new_cat = (j.get('new_name') or name).strip(), j.get('new_cat') or cat
                    out = M.update_simple_destination(sf, cat, name, j.get('new_name'), j.get('new_cat'), j.get('location'), (j.get('image') or '').strip() or None)
                    if (new_name, new_cat) != (name, cat):
                        def mv(dest, ns):
                            e = (dest.get(cat) or {}).pop(name, None)
                            if e: dest.setdefault(new_cat, {})[new_name] = e

                        M.edit_destinations(f, mv)
                elif act == 'delete':
                    out = M.delete_simple_destination(sf, cat, name); new_name = new_cat = None
                    M.edit_destinations(f, lambda dest, ns: (dest.get(cat) or {}).pop(name, None))
                else: return jsonify(error='unknown action'), 400
        except (ValueError, KeyError) as ex:
            return jsonify(error=str(ex)), 400

        return jsonify({**out, 'cat': new_cat, 'name': new_name})

    @app.get('/api/projects')
    def projects_list():
        """The simplified map's projects, with where each is"""
        from . import mapdata as M
        sf = getattr(config, 'SIMPLE_FILE', None)
        if not sf or not os.path.exists(sf): return jsonify(error='data/map_data.py was not found'), 400
        return jsonify(items=M.list_simple_projects(sf))

    @app.post('/api/project_def')
    def project_def():
        """{action: 'create', name, location, source, radius, description, link?, image?} | {action: 'update', name, location}"""
        from . import mapdata as M
        sf = getattr(config, 'SIMPLE_FILE', None)
        if not sf or not os.path.exists(sf): return jsonify(error='data/map_data.py was not found'), 400
        j = request.get_json(); act = j.get('action')
        try:
            with lock:
                if act == 'create': out = M.create_simple_project(sf, j.get('name'), j['location'], j.get('source'), j.get('radius'), j.get('description'), j.get('link') or '', j.get('image') or '')
                elif act == 'update': out = M.update_simple_project(sf, j.get('name'), j['location'])
                else: return jsonify(error='unknown action'), 400
        except (ValueError, KeyError, TypeError) as ex:
            return jsonify(error=str(ex)), 400

        return jsonify({**out, 'name': (j.get('name') or '').strip()})

    @app.post('/api/open_images')
    def open_images():
        """Open data/images/destinations in the computer's file browser (this tool only runs on your own computer), so pictures are easy to add."""
        import subprocess
        if request.remote_addr not in ('127.0.0.1', '::1'): abort(403)
        d = os.path.join(config.ROOT, 'data', 'images', 'destinations'); os.makedirs(d, exist_ok=True)
        try:
            if sys.platform.startswith('win'): os.startfile(d)                          # noqa: just for Windows
            elif sys.platform == 'darwin': subprocess.Popen(['open', d])
            else: subprocess.Popen(['xdg-open', d])
        except Exception as ex:
            return jsonify(error=f"could not open the folder ({ex}): it is {d}"), 500

        return jsonify(path=d)

    @app.post('/api/destination')
    def destination_api():
        """{cat, name, stations?: [Present map stations], futureStations?: [Future map stations], setting?: 'present'|'future'|'both'}: what the detailed map says about one venue of the simplified map."""
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); cat, name = j['cat'], j['name']
        if name not in (_simple_destinations().get(cat) or {}): return jsonify(error=f"'{name}' is not a destination of the simplified map"), 400
        try:
            with lock:
                def go(dest, ns):
                    have = set(ns['Stations'])
                    e = dest.setdefault(cat, {}).setdefault(name, {})
                    for jk, lk in (('stations', 'Stations'), ('futureStations', 'FutureStations')):        # the stations serving it on the Present map / on the Future map
                        if jk not in j: continue
                        bad = [x for x in j[jk] if x not in have]
                        if bad: raise ValueError(f"no such station: {bad[0]}")
                        if j[jk]: e[lk] = list(dict.fromkeys(j[jk]))
                        else: e.pop(lk, None)

                    if j.get('setting'):
                        if j['setting'] not in M.EXISTS_OF: raise ValueError("setting must be present, future or both")
                        e['Exists'] = list(M.EXISTS_OF[j['setting']])

                out = M.edit_destinations(f, go)
                item = _dest_item(M, cat, name, _simple_destinations()[cat][name], M.load_namespace_cached(f).get('Destinations') or {})
        except ValueError as ex:
            return jsonify(error=str(ex)), 400

        return jsonify({**out, 'item': item})

    @app.post('/api/rename')
    def rename_api():
        """{station, name} or {station, platform, name}; {station, platform, into} merges platforms; {station, into, platform_name} merges stations."""
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json(); st = j['station']
        try:
            with lock:
                raw = M.load_namespace(f)['Stations'].get(st) or {}
                keys = ([st] if 'Location' in raw else []) + [f"{st} {{{p}}}" for p in (raw.get('Platforms') or {})]
                if 'into' in j and 'platform' in j:
                    out = M.merge_platform(f, st, j['platform'], j['into']); m = {f"{st} {{{j['platform']}}}": f"{st} {{{j['into']}}}"}
                elif 'into' in j:
                    dst = M.load_namespace(f)['Stations'].get(j['into']) or {}
                    out = M.merge_station(f, st, j['into'], j.get('platform_name'), j.get('first') or 'Main')
                    m = {}
                    if 'Location' in raw: m[st] = f"{j['into']} {{{j['platform_name'].strip()}}}"
                    else: m.update({f"{st} {{{p}}}": f"{j['into']} {{{p}}}" for p in (raw.get('Platforms') or {})})

                    if 'Location' in dst: m[j['into']] = f"{j['into']} {{{(j.get('first') or 'Main').strip()}}}"
                elif j.get('platform'):
                    twin = _twin_ok(raw, st, j['name'].strip(), None, me=j['platform'])
                    out = M.rename_platform(f, st, j['platform'], j['name'], twin=twin); m = {f"{st} {{{j['platform']}}}": f"{st} {{{out['platform']}}}"}
                else:
                    out = M.rename_station(f, st, j['name']); n = out['name']            # the same name as another station gets a hidden tag
                    m = {st: n, **{k: (n if k == st else f"{n} {{{k[len(st) + 2:-1]}}}") for k in keys}}            # the station itself too: its own map setting follows

                return jsonify(_renamed(out, m))
        except ValueError as e:
            return jsonify(error=str(e)), 409

    @app.delete('/api/platform')
    def platform_delete():
        from . import mapdata as M
        f = map_data_file(map_data_module, map_data_path)
        if not f: abort(400)
        j = request.get_json()
        try:
            with lock:
                out = M.delete_platform(f, j['station'], j.get('platform'))
                from . import availability as AV; AV.drop_station(j['station'], j.get('platform'))
                return jsonify(out)
        except ValueError as e:
            return jsonify(error=str(e)), 409

    # Map layers
    @app.get('/api/edges')
    def edges():
        s, w, n, e = map(float, request.args['bbox'].split(','))
        net = P.net(request.args.get('map', 'present'))
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            items = net.view((s, w, n, e), limit=int(request.args.get('limit', 12000)), include_removed=request.args.get('erased') == '1')

        return jsonify([{'id': i['id'], 'k': i['kind'], 'c': i['cls'],
                         'p': [[round(a, 6), round(b, 6)] for a, b in i['pts']]} for i in items])

    # Background map tiles, cached on disk; a failure returns an empty tile
    TILE_SRC = {'osm': (['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], 'image/png'),
                'sat': (['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                         'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], 'image/jpeg'),
                'labels': (['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
                            'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'], 'image/png'),
                'orm': (['https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', 'https://b.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png'], 'image/png')}
    BLANK = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==')       # 1 px, fully transparent
    tile_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'tiles')
    tile_gate, tile_failed, tile_rr = threading.Semaphore(12), {}, [0]
    conn_pool, conn_lock = {}, threading.Lock()

    def http_get(url, timeout=8.0, headers=None):
        """GET through connections kept open and shared by every request thread: a tile costs one request, not a new TLS handshake each"""
        import http.client, urllib.parse
        u = urllib.parse.urlsplit(url)
        for fresh in (False, True):
            c = None
            if not fresh:
                with conn_lock:
                    idle = conn_pool.get(u.netloc)
                    c = idle.pop() if idle else None

            if c is None: c = http.client.HTTPSConnection(u.netloc, timeout=timeout)
            try:
                c.request('GET', u.path + (f'?{u.query}' if u.query else ''), headers={'User-Agent': 'rail-map-tracer/1.0 (local dev tool)', 'Accept': '*/*', **(headers or {})})
                r = c.getresponse(); body = r.read()
                if r.status in (200, 403, 404):
                    if not r.will_close:
                        with conn_lock: conn_pool.setdefault(u.netloc, []).append(c)

                    return body if r.status == 200 else None

                if r.status in (429, 502, 503, 504): time.sleep(0.4)
                raise OSError(f'HTTP {r.status}')
            except Exception:
                try: c.close()
                except Exception: pass

        return None

    @app.get('/tiles/<layer>/<int:z>/<int:x>/<int:y>')
    def tile(layer, z, x, y):
        if layer not in TILE_SRC: abort(404)
        urls, mime = TILE_SRC[layer]; path = os.path.join(tile_dir, layer, str(z), str(x), f'{y}.bin')
        def out(body, ok=True):
            r = Response(body, mimetype=mime if ok else 'image/png')
            r.headers['Cache-Control'] = 'public, max-age=86400' if ok else 'no-store'
            r.headers['Access-Control-Allow-Origin'] = '*'; r.headers['Access-Control-Expose-Headers'] = 'X-Tile-Failed'      # tiles are asked for from the other name of this server (127.0.0.1 / localhost)
            if not ok: r.headers['X-Tile-Failed'] = '1'                          # the page asks again (with a pause) instead of leaving a hole
            return r

        if os.path.exists(path):
            with open(path, 'rb') as fh: return out(fh.read())

        if time.time() - tile_failed.get((layer, z, x, y), 0) < 2: return out(BLANK, False)        # just failed: a moment's rest before the page asks again
        body = None
        with tile_gate:
            tile_rr[0] += 1
            for attempt in range(len(urls) * 2):
                body = http_get(urls[(tile_rr[0] + attempt) % len(urls)].format(z=z, x=x, y=y))
                if body: break

        if not body:
            tile_failed[(layer, z, x, y)] = time.time()
            if len(tile_failed) > 5000: tile_failed.clear()
            return out(BLANK, False)

        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + '.tmp', 'wb') as fh: fh.write(body)
            os.replace(path + '.tmp', path)
        except OSError:
            pass

        return out(body)

    # OSM platform outlines from the local copy (rebuilt by refresh_osm.py)
    @app.get('/api/osm_platforms')
    def osm_platforms():
        from . import platforms as PL
        s, w, n, e = map(float, request.args['bbox'].split(','))
        if not PL.osm_ready(): return jsonify(ready=False, items=[])
        return jsonify(ready=True, items=PL.osm_query(s, w, n, e))

    def reload(touched):
        """Rebuilds the networks after an edit; cached tiles and platform shapes away from the touched points carry over"""
        old = (P.present, P.future)
        P.reload_future()
        if not touched: return
        box = pad_bbox(bbox_of(touched), 300.0)
        areas = {'_tiles': lambda k: (k[2] * tile_size(k[1]), k[3] * tile_size(k[1]), (k[2] + 1) * tile_size(k[1]), (k[3] + 1) * tile_size(k[1])),
                 '_shapes': lambda k: pad_bbox(bbox_of([(k[0], k[1]), (k[2], k[3])]), 500.0)}
        for o, n in zip(old, (P.present, P.future)):
            if n is o: continue
            for name, area in areas.items():
                src = o.__dict__.get(name)
                if not src: continue
                dst = n.__dict__.setdefault(name, collections.OrderedDict())
                for k, v in list(src.items()):
                    if name == '_tiles' and v[1]: continue            # custom track's edges are numbered afresh with every rebuild: its tiles are never reused
                    b = area(k)
                    if b[2] < box[0] or b[0] > box[2] or b[3] < box[1] or b[1] > box[3]: dst.setdefault(k, v)

    def thin_pts(pts, tol):
        """Drops points closer than tol metres to the last kept one; both ends stay"""
        if len(pts) < 3: return pts
        kx, ky = 111320.0 * math.cos(math.radians(pts[0][0])), 110540.0
        out = [pts[0]]
        for p in pts[1:-1]:
            q = out[-1]
            if math.hypot((p[1] - q[1]) * kx, (p[0] - q[0]) * ky) >= tol: out.append(p)

        out.append(pts[-1])
        return out

    def tile_size(z):                                   # degrees: about 2 km at street zoom, doubling for each zoom level out
        return 0.02 * 2 ** max(0, 13 - min(z, 13))

    @app.get('/api/edge_tile')
    def edge_tile():
        """The track overlay in fixed tiles, built once per network and kept compressed"""
        z, i, j = min(int(request.args['z']), 13), int(request.args['i']), int(request.args['j'])      # tiles are the same from zoom 13 on
        er = request.args.get('erased') == '1'
        lod = request.args.get('lod') == '1' and z <= 12                  # zoomed out, nothing to snap to: points under a third of a pixel apart are dropped
        net = P.net(request.args.get('map', 'present'))
        cache = net.__dict__.setdefault('_tiles', collections.OrderedDict())
        key = (er, z, i, j, lod); hit = cache.get(key); body = hit[0] if hit else None
        if body is None:
            sz = tile_size(z)
            items = net.view((i * sz, j * sz, (i + 1) * sz, (j + 1) * sz), limit=20000, include_removed=er)
            tol = 0.33 * 156543.03 * math.cos(math.radians((i + 0.5) * sz)) / 2 ** z if lod else 0.0
            body = gzip.compress(json.dumps([{'id': t['id'], 'k': t['kind'], 'c': t['cls'], 'p': [[round(a, 6), round(b, 6)] for a, b in (thin_pts(t['pts'], tol) if tol else t['pts'])]} for t in items],
                                            separators=(',', ':')).encode(), 3)
            cache[key] = (body, any(t['id'] < 0 for t in items))          # with custom track in it (whose ids change with every rebuild) or not
            while len(cache) > 800: cache.popitem(last=False)

        resp = Response(body, mimetype='application/json'); resp.headers['Content-Encoding'] = 'gzip'
        return resp

    @app.post('/api/legs')
    def legs():
        """Route each [from, to] pair independently (the UI caches legs and asks only for new ones)."""
        from .router import route
        j = request.get_json()
        net = P.net(j.get('map', 'present'))
        cache = net.__dict__.setdefault('_legs', collections.OrderedDict())       # per network: an edit makes a new network, so its legs are routed afresh
        out = []
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            for a, b in j['pairs']:
                k = (round(a[0], 6), round(a[1], 6), round(b[0], 6), round(b[1], 6))
                v = cache.get(k)
                if v is None:
                    l = route(net, [tuple(a[:2]), tuple(b[:2])]).legs[0]
                    v = {'ok': l.ok, 'error': l.error, 'note': l.note, 'km': round(l.length_m / 1000, 2), 'pts': [[round(x, 6), round(y, 6)] for x, y in l.geom]}
                    if l.ok or 'too long' not in (l.error or ''): cache[k] = v               # a search that ran out of time is tried again next time
                    while len(cache) > 5000: cache.popitem(last=False)

                out.append(v)

        return jsonify(legs=out)

    @app.post('/api/route')
    def route_preview():
        from .router import route
        j = request.get_json()
        wps = [tuple(p[:2]) for p in j['waypoints']]
        if len(wps) < 2: return jsonify(legs=[], length_km=0)
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            r = route(P.net(j.get('map', 'present')), wps)

        return jsonify(length_km=round(r.length_m / 1000, 2), ok=r.ok,
                       legs=[{'ok': l.ok, 'error': l.error, 'note': l.note, 'km': round(l.length_m / 1000, 2),
                              'pts': [[round(a, 6), round(b, 6)] for a, b in l.geom]} for l in r.legs])

    # Traces
    def route_signature(pd, Segments):
        """The stations a pattern runs through, ignoring Keep/Skip/Drop (which only change which of them it stops at)."""
        from core.station_resolver import build_station_sequence
        def bare(seg):
            return {k: v for k, v in seg.items() if k not in ('Keep', 'Skip', 'Drop')} if isinstance(seg, dict) else seg

        plain = {k: bare(seg) for k, seg in Segments.items()}
        return tuple(s[4:] if s.startswith('[X] ') else s for s in build_station_sequence(pd, plain))

    @app.get('/api/trace')
    def get_trace():
        op, line, pat, cat = pat_args(request.args)
        w = _get(P.waypoints_doc(), op, line, pat, cat) or {}
        g = as_polylines(_get(P.geometry_doc(True), op, line, pat, cat))
        own, ostops, missing = P.resolve_wps(P.effective_wps(op, line, pat, cat, w.get('waypoints')), future=cat == 'Fantasy')
        return jsonify(waypoints=own, stops=ostops, missing_stops=missing, geometry=g)

    @app.put('/api/trace')
    def put_trace():
        j = request.get_json()
        op, line, pat, cat = pat_args(j)
        with lock:
            wdoc = P.waypoints_doc()
            entry = _get(wdoc, op, line, pat, cat, create=True)
            if 'waypoints' in j:
                stops = j.get('stops') or []
                pts = [{'stop': stops[i]} if i < len(stops) and stops[i] else [round(p[0], 6), round(p[1], 6)] for i, p in enumerate(j['waypoints'])]
                entry['waypoints'] = compress_wps(pts) if P.stop_keys(op, line, pat, cat) is not None else pts      # the pattern's stops are the route: only the waypoints between them are stored

            for o2, ls in list(wdoc.items()):                                  # drop empty entries
                for l2, ps in list(ls.items()):
                    for p, cats in list(ps.items()):
                        for c, ent in list(cats.items()):
                            if not ent.get('waypoints'): _drop(wdoc, o2, l2, p, c)

            P.save_waypoints_doc(wdoc)
            reports = [P.compile_one(op, line, pat, cat)]

        return jsonify(reports=reports)

    @app.delete('/api/trace')
    def delete_trace():
        op, line, pat, cat = pat_args(request.args)
        with lock:
            wdoc = P.waypoints_doc(); _drop(wdoc, op, line, pat, cat); P.save_waypoints_doc(wdoc)
            g = P.geometry_doc(); _drop(g, op, line, pat, cat); P.save_geometry_doc(g)

        return jsonify(ok=True)

    # Platforms follow their rails
    def follow_platforms(touched, scope=None, recompile=True):
        """Moves platforms left off the rail near touched points back onto it (recompile False: their routes are left to Refresh affected lines, as the touched track is marked changed)"""
        from .mapdata import station_usage, set_platform
        from .platforms import follow
        f = map_data_file(map_data_module, map_data_path)
        if not f or not touched: return []
        cells = {(round(p[0] / 0.003), round(p[1] / 0.003)) for p in touched}
        cells |= {(a + da, b + db) for a, b in list(cells) for da in (-1, 0, 1) for db in (-1, 0, 1)}
        raw = load_namespace(f)['Stations']; use = station_usage(f); moved = []
        for name, d in raw.items():
            items = ([(None, d['Span'])] if d.get('Span') else []) + [(pn, v['Span']) for pn, v in (d.get('Platforms') or {}).items() if isinstance(v, dict) and v.get('Span')]
            for pn, span in items:
                if not any((round(q[0] / 0.003), round(q[1] / 0.003)) in cells for q in span): continue
                key = name if pn is None else f"{name} {{{pn}}}"; u = use.get(key, [])
                which = 'present' if 'Present' in u else 'future' if u else (scope or 'present')
                sp = follow(P.net(which), span)
                if not sp: continue
                try: set_platform(f, name, pn, {'Location': sp['mid'], 'Span': [sp['a'], sp['b']]})
                except ValueError: continue

                moved.append(key)

        from . import availability as AV
        for key, ov in AV.platform_versions().items():                       # a Future version lives on the Future map's rails
            span = ov.get('Span')
            if not span or not any((round(q[0] / 0.003), round(q[1] / 0.003)) in cells for q in span): continue
            sp = follow(P.net('future'), span)
            if sp:
                AV.set_platform_version(key, {'Location': sp['mid'], 'Span': [sp['a'], sp['b']]}); moved.append(key)

        if moved and recompile:
            try: P.recompile_stop_users(moved)
            except Exception: pass

        return moved

    # Future-map edits
    @app.get('/api/edits')
    def list_edits():
        # just a count: with thousands of edits a per-edit health check here would be slow (it runs in `update`/`check`)
        return jsonify(count=len(P.future.edits))

    def _clean_edit(j: dict) -> dict:
        """Whitelists and rounds a Future-map edit's fields (ctrl, curve, coords, joins)"""
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

        if isinstance(j.get('pieces'), list): out['pieces'] = [[[round(float(a), 6), round(float(b), 6)] for a, b in pc] for pc in j['pieces']]
        if 'build' in j: out['build'] = str(j['build'])
        if j.get('reshape'): out['reshape'] = True                 # made by Reshape: joins exactly where its erase ends
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
        if j.get('op') not in ('add_track', 'remove_track') or len(j.get('coords') or []) < 2: abort(400)
        op = {'id': 'e' + uuid.uuid4().hex[:8], 'op': j['op'], **_clean_edit({'name': '', **j})}
        with lock:
            save_edits(load_edits() + [op])
            reload([tuple(c) for c in op['coords']])
            P.mark_dirty(op['coords'], op.get('scope', 'future'))
            health = [r for r in P.future.report if r.get('id') == op['id']]
            moved = follow_platforms(op['coords'], op.get('scope', 'future'))

        return jsonify(edit=op, health=health, recompiled=0, platforms=moved)

    @app.post('/api/edits/batch')
    def add_edits_batch():
        """Build several blueprints at once: one reload and one recompile instead of one per edit."""
        items = (request.get_json() or {}).get('edits') or []
        ops = []
        for j in items:
            if j.get('op') not in ('add_track', 'remove_track') or len(j.get('coords') or []) < 2: abort(400)
            ops.append({'id': 'e' + uuid.uuid4().hex[:8], 'op': j['op'], **_clean_edit({'name': '', **j})})

        if not ops: return jsonify(edits=[], health=[], recompiled=0)
        with lock:
            save_edits(load_edits() + ops)
            reload([tuple(c) for o in ops for c in o['coords']])
            n = 0
            for o in ops: P.mark_dirty(o['coords'], o.get('scope', 'future'))
            ids = {o['id'] for o in ops}
            health = [r for r in P.future.report if r.get('id') in ids]
            moved = follow_platforms([tuple(c) for o in ops for c in o['coords']])

        return jsonify(edits=ops, health=health, recompiled=n, platforms=moved)

    @app.put('/api/edits/<eid>')
    def update_edit(eid):
        j = request.get_json()
        with lock:
            edits = load_edits()
            cur = next((e for e in edits if e['id'] == eid), None)
            if cur is None: abort(404)
            fields = _clean_edit(j); fields.pop('scope', None)       # which map an edit belongs to is fixed
            if 'coords' in fields and len(fields['coords']) < 2: abort(400)
            old_pts = [tuple(c) for c in cur['coords']]
            if 'coords' in fields:                       # a new shape replaces the old shape's metadata too
                for k in ('ctrl', 'curve', 'segs', 'tan', 'tans', 'junctions', 'joins', 'lane_offsets'): cur.pop(k, None)

            cur.update(fields)
            save_edits(edits)
            reload(old_pts + [tuple(c) for c in cur['coords']])
            if not request.args.get('quiet'): P.mark_dirty(old_pts + [tuple(c) for c in cur['coords']], cur.get('scope', 'future'))
            recompiled = []
            health = [r for r in P.future.report if r.get('id') == eid]
            moved = follow_platforms(old_pts + [tuple(c) for c in cur['coords']], cur.get('scope', 'future'))

        return jsonify(edit=cur, health=health, recompiled=len(recompiled), platforms=moved)

    @app.put('/api/edits/batch')
    def update_edits_batch():
        """Changes, adds and deletes several edits at once (a selection moved across tracks): one rebuild for all"""
        j = request.get_json() or {}
        with lock:
            edits = load_edits(); byid = {e['id']: e for e in edits}
            touched, dirty, changed = [], [], []
            for u in j.get('update') or []:
                cur = byid.get(u.get('id'))
                if cur is None and u.get('op') in ('add_track', 'remove_track') and len(u.get('coords') or []) >= 2:          # undo of a delete: back under its own id
                    cur = {'id': str(u['id'])[:20], 'op': u['op'], **_clean_edit({'name': '', **u})}; edits.append(cur); byid[cur['id']] = cur
                    changed.append(cur); pts = [tuple(c) for c in cur['coords']]; touched += pts; dirty.append((pts, cur.get('scope', 'future'))); continue

                if cur is None: abort(404)
                fields = _clean_edit(u); fields.pop('scope', None)
                if 'coords' in fields and len(fields['coords']) < 2: abort(400)
                old_pts = [tuple(c) for c in cur['coords']]
                if 'coords' in fields:
                    for k in ('ctrl', 'curve', 'segs', 'tan', 'tans', 'junctions', 'joins', 'lane_offsets'): cur.pop(k, None)

                cur.update(fields); changed.append(cur)
                pts = old_pts + [tuple(c) for c in cur['coords']]; touched += pts; dirty.append((pts, cur.get('scope', 'future')))

            created = []
            for c in j.get('create') or []:
                if c.get('op') not in ('add_track', 'remove_track') or len(c.get('coords') or []) < 2: abort(400)
                op = {'id': 'e' + uuid.uuid4().hex[:8], 'op': c['op'], **_clean_edit({'name': '', **c})}; created.append(op)
                pts = [tuple(x) for x in op['coords']]; touched += pts; dirty.append((pts, op.get('scope', 'future')))

            gone = set(j.get('delete') or [])
            for e in edits:
                if e['id'] in gone: pts = [tuple(x) for x in e['coords']]; touched += pts; dirty.append((pts, e.get('scope', 'future')))

            save_edits([e for e in edits if e['id'] not in gone] + created)
            reload(touched)
            for pts, scope in dirty: P.mark_dirty(pts, scope)
            ids = {e['id'] for e in changed + created}
            health = [r for r in P.future.report if r.get('id') in ids]
            moved = follow_platforms(touched)

        return jsonify(edits=changed, created=created, health=health, platforms=moved)

    @app.post('/api/edits/adopt')
    def adopt_track():
        """Makes OSM track editable (`runs`: paths along the rail, or two clicked points a, b): it is erased and each stretch redrawn as a custom track with the same shape"""
        from core.geo import simplify
        j = request.get_json() or {}
        scope = 'present' if j.get('scope') == 'present' else 'future'
        rad = float(j.get('radius_m') or 15)
        with lock:
            runs, spans, err = picked(j, rad)
            if err: return jsonify(error=err, created=[])
            sel = sel_of(spans)
            if not sel: return jsonify(error='No track between those points.', created=[])
            erase = {'id': 'e' + uuid.uuid4().hex[:8], 'op': 'remove_track', **_clean_edit(_erase_body(scope, sel))}
            adds = []
            for pts in runs:
                ctrl = [list(p) for p in simplify(list(pts), 1.0)]
                if len(ctrl) < 2: continue
                adds.append({'id': 'e' + uuid.uuid4().hex[:8], 'op': 'add_track', **_clean_edit({'scope': scope, 'name': str(j.get('name') or ''), 'coords': ctrl, 'ctrl': ctrl,
                             'segs': [0] * (len(ctrl) - 1), 'curve': False, 'snap_s': True, 'snap_e': True, 'tracks': 1, 'spacing': 4.5, 'anchor': 'center', 'reshape': True})})

            save_edits(load_edits() + [erase, *adds])
            touched = [tuple(p) for pts in runs for p in pts]
            reload(touched); P.mark_dirty(touched, scope)
            ids = {a['id'] for a in adds}; health = [r for r in P.future.report if r.get('id') in ids]
            moved = follow_platforms(touched, scope, recompile=False)          # routing round erased track can take minutes: Refresh affected lines does it

        return jsonify(created=[erase, *adds], edit=adds[0] if adds else None, edits=adds, health=health, platforms=moved)

    def _thin(g, step=30.0):
        """Keep a point about every `step` metres (and both ends): enough to find the same track again, small enough to keep in git."""
        from core.geo import haversine
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

    # Erase / Restore by two clicked points: the track between them along the rail
    _base = {}

    def base_net():
        if 'n' not in _base:
            _base['n'] = P._Network(P.store, [], 'present')              # the untouched rail graph: erased track is still there to walk along

        return _base['n']

    def _spans_along(B, pts):
        from . import platforms as PL
        from .network import _cum, _s_of
        out, prev = {}, None
        for p in pts:
            cs = PL._cands(B, p, 3.0, 4)
            if not cs: continue
            c = next((c for c in cs if prev is not None and c[1].id == prev), cs[0]); e = c[1]; prev = e.id
            s = _s_of(e.geom, _cum(e.geom), c[2], c[3])
            r = out.setdefault(e.id, [s, s]); r[0] = min(r[0], s); r[1] = max(r[1], s)

        return {eid: (lo, hi) for eid, (lo, hi) in out.items() if hi - lo > 0.3}

    def _path_spans(B, pts):
        """A path drawn along the rail -> {base edge id: [[from m, to m], ...]}: it keeps to the rail it is on and, at a switch, takes the one running its way"""
        from . import platforms as PL
        from .network import _cum, _s_of
        from core.geo import densify
        dense = densify([tuple(p) for p in pts], 1.5)
        out, prev, last = {}, None, None
        def add(c):
            e = c[1]; s = _s_of(e.geom, _cum(e.geom), c[2], c[3]); r = out.setdefault(e.id, [s, s]); r[0] = min(r[0], s); r[1] = max(r[1], s)

        for k, p in enumerate(dense):
            cs = PL._cands(B, p, 3.0, 6)
            if not cs: continue
            q = dense[k + 1] if k + 1 < len(dense) else dense[k - 1] if k else p
            d = (q[0] - p[0], (q[1] - p[1]) * math.cos(math.radians(p[0])))
            near = [c for c in cs if c[0] <= cs[0][0] + 0.15]
            c = next((c for c in near if c[1].id == prev), None) or max(near, key=lambda c: abs(sum(a * b for a, b in zip(PL._tangent(c, d), d))) / (math.hypot(*d) or 1))
            if prev is not None and c[1].id != prev and last is not None:          # onto the next piece of rail: it starts where the last one ended
                back = next((x for x in PL._cands(B, last, 0.6, 6) if x[1].id == c[1].id), None)
                if back: add(back)

            add(c); prev, last = c[1].id, p

        return {eid: [(lo, hi)] for eid, (lo, hi) in out.items() if hi - lo > 0.3}

    def runs_spans(runs):
        """Several paths -> ({base edge id: [(from m, to m), ...] merged}, the walked points of each)"""
        B = base_net(); out = {}
        for pts in runs:
            for eid, sp in _path_spans(B, pts).items(): out.setdefault(eid, []).extend(sp)

        for eid, sp in out.items():
            sp.sort(); m = [list(sp[0])]
            for a, b in sp[1:]:
                if a <= m[-1][1] + 0.3: m[-1][1] = max(m[-1][1], b)
                else: m.append([a, b])

            out[eid] = [tuple(x) for x in m]

        return out

    def picked(j, rad):
        """The track an erase / reshape / restore acts on: `runs` (paths along the rail) or two points a, b -> (paths, {edge: [spans]}, error)"""
        if j.get('runs'):
            runs = [[(float(p[0]), float(p[1])) for p in r] for r in j['runs'] if len(r) > 1]
            sp = runs_spans(runs)
            return runs, sp, None if sp else 'No track there.'

        pts, sp, err = two_points(j['a'], j['b'], rad)
        return ([pts] if pts else []), ({k: [v] for k, v in sp.items()} if sp else sp), err

    def sel_of(spans):
        from .network import _cum, _sub
        out = []
        for eid, sp in spans.items():
            e = P.store.edge(eid); cum = _cum(e.geom)
            out += [(eid, lo, hi, _sub(e.geom, cum, lo, hi)) for lo, hi in sp if hi - lo >= 0.3]

        return out

    @app.get('/api/edits/stretch')
    def stretch_at():
        """The track under a point, junction to junction (on the untouched rail graph, so erased track can be picked too): {pts} or {pts: null}"""
        from . import platforms as PL, directions as D
        rad = max(float(request.args.get('radius_m', 15)), 6.0)
        with nolock:
            B = base_net(); cs = PL._cands(B, (float(request.args['lat']), float(request.args['lng'])), rad, 1)
            if not cs: return jsonify(pts=None)
            pts, _ids = D.stretch(B, cs[0][1].id)

        return jsonify(pts=pts)

    def two_points(a, b, rad):
        """-> (walked points, {base edge id: (from m, to m)}, error text)"""
        from . import platforms as PL
        B = base_net(); rad = max(rad, 10.0)
        sa, sb = PL.snap_point(B, (float(a[0]), float(a[1])), rad), PL.snap_point(B, (float(b[0]), float(b[1])), rad)
        if not sa or not sb: return None, None, 'Click on track.'
        pts = PL.walk(B, tuple(sa['point']), tuple(sb['point']), 6000.0)
        if not pts: return None, None, 'Those two points are not on one continuous track (or are over 6 km apart): pick them closer, on the same track.'
        sp = _spans_along(B, pts)
        return pts, sp, None if sp else 'No track between those points.'

    @app.get('/api/edits/pick_path')
    def pick_path():
        """Preview: the point a click would snap to (lat, lng) and, with a start (alat, alng), the track between the two."""
        from . import platforms as PL
        rad = float(request.args.get('radius_m', 15))
        with nolock:
            B = base_net(); here = (float(request.args['lat']), float(request.args['lng']))
            sn = PL.snap_point(B, here, max(rad, 10.0))
            pts = None
            if request.args.get('alat') and sn: pts, _sp, _err = two_points((float(request.args['alat']), float(request.args['alng'])), here, rad)

        return jsonify(snap=sn['point'] if sn else None, pts=[[round(p[0], 6), round(p[1], 6)] for p in pts] if pts else None)

    @app.get('/api/edits/pick')
    def pick_segment():
        """The little segment under the cursor (to highlight before a click): kind = erase | restore."""
        scope = 'present' if request.args.get('scope') == 'present' else 'future'
        at = (float(request.args['lat']), float(request.args['lng'])); rad = float(request.args.get('radius_m', 15))
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
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
            if j.get('runs') or (j.get('a') and j.get('b')):            # paths along the rail, or two points: the track between them
                _runs, spans, err = picked(j, rad)
                if err: return jsonify(edit=None, removed_m=0, error=err)
                sel = sel_of(spans)
            elif j.get('path'):                                            # a sweep: every little segment the dragged line passes over
                sel, got = [], []
                for pt in j['path']:
                    p = net.little((float(pt[0]), float(pt[1])), rad)
                    if p and not any(p[0] == g[0] and abs(p[1] - g[1]) < 1 and abs(p[2] - g[2]) < 1 for g in got):
                        got.append(p); sel.append(p)
            else:
                sel = net.select(box=tuple(map(float, j['box'])) if j.get('box') else None,
                                 at=tuple(map(float, j['at'])) if j.get('at') else None, radius_m=rad)

            if not sel: return jsonify(edit=None, removed_m=0)
            op = {'id': 'e' + uuid.uuid4().hex[:8], 'op': 'remove_track', **_clean_edit(_erase_body(scope, sel))}
            save_edits(load_edits() + [op])
            reload([tuple(p) for pc in op['pieces'] for p in pc])
            P.mark_dirty([tuple(p) for pc in op['pieces'] for p in pc], scope)
            moved = follow_platforms([tuple(p) for pc in op['pieces'] for p in pc], scope, recompile=False)

        return jsonify(edit=op, removed_m=round(sum(b - a for _, a, b, _ in sel)), platforms=moved)

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
            along = None
            if j.get('runs') or (j.get('a') and j.get('b')):
                _runs, along, err = picked(j, float(j.get('radius_m') or 15))
                if err: return jsonify(restored_m=0, undo=[], error=err)

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
                    cuts = list(along.get(eid, [])) if along is not None else clip_path_box(e.geom, cum, box) if box else picks.get((op['id'], eid), [])
                    left = subtract_spans(sp, cuts) if cuts else list(sp)
                    if cuts and sum(b - a for a, b in left) < sum(b - a for a, b in sp) - 0.5:
                        hit = True; restored += sum(b - a for a, b in sp) - sum(b - a for a, b in left)

                    new += [(eid, a, b, _sub(e.geom, cum, a, b)) for a, b in left]

                if not hit:
                    out.append(op); continue

                undo.append({'id': op['id'], 'body': {k: v for k, v in op.items() if k != 'id'}})
                touched += [tuple(p) for pc in (op.get('pieces') or [op['coords']]) for p in pc]
                if new: out.append({'id': op['id'], 'op': 'remove_track', **_clean_edit(_erase_body(scope, new))})

            if undo:
                save_edits(out); reload(touched); P.mark_dirty(touched, scope)

            moved = follow_platforms(touched, scope) if undo else []

        return jsonify(restored_m=round(restored), undo=undo, platforms=moved)

    @app.get('/api/edits/view')
    def edits_in_view():
        """Edits (with their control points) that touch the viewport: for selecting and editing them on the map."""
        s_, w_, n_, e_ = map(float, request.args['bbox'].split(','))
        out = []
        with nolock:   # read-only: networks are replaced whole when edited, never changed in place
            for e in (P.present.edits if request.args.get('map') == 'present' else P.future.edits):
                cs = e['coords']
                la = [c[0] for c in cs]; lo = [c[1] for c in cs]
                if max(la) < s_ or min(la) > n_ or max(lo) < w_ or min(lo) > e_: continue
                if e.get('op') == 'remove_track':
                    continue                                 # erased segments are managed with Erase / Restore, never edited as lines

                out.append({k: v for k, v in e.items() if k != 'pieces'})
                if len(out) >= int(request.args.get('limit', 3000)): break

        return jsonify(out)

    @app.delete('/api/edits/<eid>')
    def del_edit(eid):
        with lock:
            edits = load_edits()
            if eid == 'last' and edits: eid = edits[-1]['id']
            gone = [e for e in edits if e['id'] == eid]
            save_edits([e for e in edits if e['id'] != eid])
            reload([tuple(c) for g in gone for c in g['coords']])
            n = 0
            if gone:
                P.mark_dirty([tuple(c) for c in gone[0]['coords']], gone[0].get('scope', 'future'))
                moved = follow_platforms([tuple(c) for c in gone[0]['coords']], gone[0].get('scope', 'future'))
            else: moved = []

        return jsonify(ok=True, recompiled=n, platforms=moved)

    @app.get('/api/dirty')
    def dirty_status():
        """How many lines the track changed since the last refresh may have affected."""
        with lock: d = {k: set(v) for k, v in P.dirty_cells().items()}          # a snapshot: working out the lines does not hold up edits
        lines = P.affected_routes(d) if d['present'] or d['future'] else []

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

    @app.post('/api/refresh_route')
    def refresh_route():
        """{operator, line, pattern, category}: re-route one route from its stops / waypoints and save + compile it. A route that cannot be traced keeps its stored path."""
        op, line, pat, cat = pat_args(request.get_json())
        with lock:
            rep = P.compile_one(op, line, pat, cat, keep=True)

        return jsonify(report=rep)

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
            if not old: return 0
            net = P.future
            out = []
            for e in edits:
                if e not in old:
                    out.append(e); continue

                sel = []
                for eid, sp in (net.op_spans.get(e['id']) or {}).items():
                    ed = P.store.edge(eid); cum = _cum(ed.geom)
                    sel += [(eid, a, b, _sub(ed.geom, cum, a, b)) for a, b in sp]

                if sel: out.append({'id': e['id'], 'op': 'remove_track', **_clean_edit(_erase_body(e.get('scope', 'future'), sel))})

            save_edits(out); reload(None)
            return len(old)

    migrate_erases()

    def retag_stations():
        """Every station's key carries a hidden random ID ('Name [k7q2xm]'): stations without one (older ones, ones typed into the file) get one; nothing shown changes"""
        from . import mapdata as M, availability as AV
        f = map_data_file(map_data_module, map_data_path)
        if not f or all(M.tag_of(k) for k in M.load_namespace(f)['Stations']): return          # the usual case: nothing to do
        try:
            with lock:
                sigs = read_json(P.SIG_FILE, {}).get('sigs', {})
                fresh = [(o, l, p, c) for o, l, p, c, e in P.routes_all(P.waypoints_doc()) if P.route_sig(o, l, p, c, e) == sigs.get('|'.join((o, l, p, c)))]
                mapping = M.tag_all(f)
                if not mapping: return
                P.rename_stops(mapping); AV.rename(mapping)
                ent = {(o, l, p, c): e for o, l, p, c, e in P.routes_all(P.waypoints_doc())}
                P._record_sigs({k: P.route_sig(*k, ent[k]) for k in fresh if k in ent})          # only names changed: the paths stay up to date
                print(f"[stations] {sum(1 for k in mapping if '{' not in k)} stations got their ID", flush=True)
        except Exception as e:
            print(f"[stations] giving stations their IDs stopped: {e}", flush=True)

    threading.Thread(target=retag_stations, daemon=True).start()          # at every start: a station added by hand gets its ID too
    return app