"""End-to-end test on a tiny synthetic OSM extract:  python -m pytest devtools/tests  (or run directly)

        Y=0.02 ───1──────2──────3───  (main line, lat 40.02)
                          |
        Y=0.00 ───4──────5──────6───  (second line, lat 40.00)   gap between 2 and 5 (no link)
Future edit adds a connector 2->5, and removes nothing; a second edit erases a piece of 4-5.
"""
import json, os, sys, tempfile, importlib, types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
import osmium
from devtools import config


def make_pbf(path, extra_ways=()):
    w = osmium.SimpleWriter(path)
    nid = {}
    def node(i, lat, lon):
        nid[i] = i; w.add_node(osmium.osm.mutable.Node(id=i, location=(lon, lat)))
    for k in range(7):                       # row A lat 40.02, nodes 1..7 every 0.01° lon
        node(1 + k, 40.02, -100.0 + 0.01 * k)
    for k in range(7):                       # row B lat 40.00, nodes 11..17
        node(11 + k, 40.00, -100.0 + 0.01 * k)
    node(30, 40.01, -99.97); node(31, 40.01, -99.94)
    w.add_way(osmium.osm.mutable.Way(id=100, nodes=list(range(1, 8)), tags={'railway': 'rail'}))
    w.add_way(osmium.osm.mutable.Way(id=101, nodes=list(range(11, 18)), tags={'railway': 'rail'}))
    for wid, nodes in extra_ways:
        w.add_way(osmium.osm.mutable.Way(id=wid, nodes=nodes, tags={'railway': 'rail'}))
    w.close()


def setup(tmp):
    for name in ('CACHE_DIR', 'TRACK_DIR'):
        setattr(config, name, os.path.join(tmp, name.lower()))
    config.GRAPH_DB = os.path.join(config.CACHE_DIR, 'rail.sqlite')
    config.EDIT_REPORT = os.path.join(config.CACHE_DIR, 'edit_report.json')
    config.WAYPOINTS_FILE = os.path.join(config.TRACK_DIR, 'waypoints.json')
    config.EDITS_FILE = os.path.join(config.TRACK_DIR, 'edits.json')
    config.GEOMETRY_FILE = os.path.join(config.TRACK_DIR, 'geometry.json')
    # modules copied the defaults at import time (function defaults) -> patch those too
    import devtools.store as st, devtools.network as nw, devtools.tracks as tr
    st.GraphStore.__init__.__defaults__ = (config.GRAPH_DB,)
    nw.load_edits.__defaults__ = (config.EDITS_FILE,); nw.save_edits.__defaults__ = (config.EDITS_FILE,)
    tr.load_geometry.__defaults__ = (config.GEOMETRY_FILE,)


def test_all():
    from devtools.ingest import ingest
    from devtools.store import GraphStore
    from devtools.tracks import TrackProject, load_geometry, traced_coords
    from devtools.network import save_edits
    from devtools.router import route
    from devtools.geo import haversine
    tmp = tempfile.mkdtemp(); setup(tmp)
    pbf = os.path.join(tmp, 'a.osm.pbf'); make_pbf(pbf)
    ingest(pbf, config.GRAPH_DB, log=lambda *_: None)
    P = TrackProject(GraphStore())
    assert int(P.store.meta('edges')) == 2

    A, B = (40.02, -100.0), (40.02, -99.96)     # same row: simple route
    r = route(P.present, [A, B]); assert r.ok and abs(r.length_m - haversine(A, B)) < 30
    # row A -> row B has no connection on the Present map
    r = route(P.present, [A, (40.0, -99.96)]); assert not r.ok

    # Future edit: connector 2->5 (lon -99.97 .. -99.97 uses node at k=3) joining the rows
    save_edits([{'id': 'c1', 'op': 'add_track', 'name': 'connector',
                 'coords': [[40.02, -99.97], [40.0, -99.97]]},
                {'id': 'c2', 'op': 'add_track', 'name': 'cheap connector', 'cost_factor': 0.5,
                 'coords': [[40.02, -99.99], [40.0, -99.99]]}])
    P.reload_future()
    assert all(x['ok'] for x in P.future.report)
    r = route(P.future, [A, (40.0, -99.94)]); assert r.ok, r.legs[0].error
    assert r.length_m > haversine(A, (40.0, -99.94))

    # trace + compile: Present pattern on row A; Fantasy pattern reusing it; Fantasy pattern with own waypoints
    w = {'Op': {'Line': {
        'Local':  {'Present': {'waypoints': [list(A), list(B)]}},
        'Local2': {'Fantasy': {'same_as_present': 'Local'}},
        'Cross':  {'Fantasy': {'waypoints': [list(A), [40.0, -99.94]]}},
        'Ring':   {'Fantasy': {'waypoints': [[40.02, -99.99], [40.02, -99.97], [40.0, -99.97]]}}}}}
    P.save_waypoints_doc(w)
    reps = P.compile_all(log=lambda *_: None)
    assert all(x['ok'] for x in reps), reps
    g = load_geometry()
    assert traced_coords(g, 'Op', 'Line', 'Present', 'Local')
    assert traced_coords(g, 'Op', 'Line', 'Fantasy', 'Local2') == traced_coords(g, 'Op', 'Line', 'Present', 'Local')
    cross = [p for pl in traced_coords(g, 'Op', 'Line', 'Fantasy', 'Cross') for p in pl]
    assert any(abs(a[1] - b[1]) < 1e-4 and abs(a[0] - b[0]) > 0.015 for a, b in zip(cross, cross[1:]))   # it used a connector
    # out-and-back (default loop): the return retraces the way out, so it is NOT stored a second time
    assert len(traced_coords(g, 'Op', 'Line', 'Present', 'Local')) == 1
    assert abs(g['Op']['Line']['Local']['Present'][-1][1] - B[1]) < 1e-4         # ends at the far waypoint, not back at start
    # true loop: out via row A + connector c1, back via the cheaper connector c2 -> one closed polyline
    ring = traced_coords(g, 'Op', 'Line', 'Fantasy', 'Ring')
    assert len(ring) == 1, [len(x) for x in ring]
    ring = ring[0]
    assert abs(ring[0][0] - 40.02) < 1e-4 and abs(ring[-1][0] - 40.02) < 1e-3 and abs(ring[-1][1] + 99.99) < 1e-3, (ring[0], ring[-1])
    assert any(abs(a[1] + 99.99) < 1e-4 and abs(b[1] + 99.99) < 1e-4 and abs(a[0] - b[0]) > 0.015 for a, b in zip(ring, ring[1:]))   # used c2 on the way back
    # loop switched off: only the way out
    w['Op']['Line']['Ring']['Fantasy']['loop'] = False; P.save_waypoints_doc(w)
    c, rep = P.compile_entry(P.waypoints_doc(), 'Op', 'Line', 'Ring', 'Fantasy')
    assert abs(c[-1][1] + 99.97) < 1e-3 and rep['loop'] is False
    del w['Op']['Line']['Ring']['Fantasy']['loop']; P.save_waypoints_doc(w)
    assert traced_coords(g, 'Op', 'Line', 'Present', 'Nope') is None

    # remove_track: erase part of row B, route along it fails on Future
    save_edits([{'id': 'r1', 'op': 'remove_track', 'coords': [[40.0, -99.995], [40.0, -99.985]]}])
    P.reload_future()
    assert P.future.report[0]['ok'] and P.future.report[0]['removed_m'] > 500
    assert not route(P.future, [(40.0, -100.0), (40.0, -99.96)]).ok
    assert route(P.present, [(40.0, -100.0), (40.0, -99.96)]).ok

    # OSM update: real connector now exists in OSM -> edit flagged redundant, geometry re-routed
    save_edits([{'id': 'c1', 'op': 'add_track', 'name': 'connector',
                 'coords': [[40.02, -99.97], [40.0, -99.97]]},
                {'id': 'bad', 'op': 'add_track', 'coords': [[41.0, -90.0], [41.0, -89.9]]}])
    pbf2 = os.path.join(tmp, 'b.osm.pbf')
    make_pbf(pbf2, [(102, [4, 30, 14])])        # node 4 -> 30 -> 14 : real connector at lon -99.97
    from devtools.updater import update
    rep = update(pbf2, log=lambda *_: None)
    st = {e['id']: e['status'] for e in rep['edits']}
    assert st['c1'] == 'redundant' and st['bad'] == 'review', st
    assert rep['routes_total'] == 4

    # Flask API
    from devtools.server import create_app
    stub = types.ModuleType('stubmap')
    stub.Lines = {'Op': {'Line': {'Present': {'Local': {'Mode': 'Rail'}},
                                   'Fantasy': {'Local': {'Mode': 'Rail'}, 'Cross': {'Mode': 'Rail'}}}}}
    stub.Segments = {}; stub.Nodes = {}; stub.Stations = {}; stub.Modes = {}
    sys.modules['stubmap'] = stub
    import core.station_resolver as sr; sr.normalize_stations = lambda x: x
    app = create_app('stubmap', TrackProject(GraphStore())); c = app.test_client()
    assert c.get('/').status_code == 200 and c.get('/static/tracer.js').status_code == 200
    cat = c.get('/api/catalog').get_json(); assert len(cat) == 3
    lg = c.post('/api/legs', json={'map': 'present', 'pairs': [[list(A), list(B)], [list(B), list(A)]]}).get_json()['legs']
    assert len(lg) == 2 and all(x['ok'] for x in lg)
    ids = dict(operator='Op', line='Line', pattern='Local', category='Present')
    r = c.put('/api/trace', json={**ids, 'waypoints': [list(A), list(B)], 'also_future': True})
    assert r.status_code == 200 and len(r.get_json()['reports']) == 3          # Present + Fantasy 'Local' + 'Local2' (reuses it)
    t = c.get('/api/trace', query_string=dict(ids, category='Fantasy')).get_json()
    assert t['same_as_present'] == 'Local' and t['geometry']
    assert c.get('/api/trace', query_string=ids).get_json()['future_users'] == ['Local', 'Local2']
    r = c.put('/api/trace', json={**ids, 'also_future': False}); assert len(r.get_json()['reports']) == 3
    assert not c.get('/api/trace', query_string=dict(ids, category='Fantasy')).get_json()['geometry']
    r = c.post('/api/route', json={'map': 'present', 'waypoints': [list(A), list(B)]}).get_json(); assert r['ok']
    e = c.post('/api/edits', json={'op': 'add_track', 'coords': [[40.02, -99.99], [40.0, -99.99]]}).get_json()
    assert e['health'][0]['ok']
    assert c.delete('/api/edits/' + e['edit']['id']).get_json()['ok']
    assert c.get('/api/edges', query_string={'bbox': '39.9,-100.1,40.1,-99.8', 'map': 'future'}).get_json()
    assert c.get('/api/status').get_json()['edges']
    # build hook
    from builder.layer_processor import _inline_coords
    print('all good')


if __name__ == '__main__':
    test_all()
