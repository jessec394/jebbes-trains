"""OSM extract -> routable rail graph, streamed through SQLite so a whole continent fits in memory"""
from __future__ import annotations
import hashlib, os, time

from . import config, store
from core.geo import haversine

STOP_KINDS = {'station', 'halt', 'tram_stop', 'stop'}                 # nodes: named stops, to suggest a station name

LIFECYCLE = (('construction:railway', 'construction'), ('proposed:railway', 'proposed'))

def kind_of(tags, kinds) -> str | None:
    """railway=* kind of a way; ways using the OSM lifecycle prefix (construction:railway=rail, proposed:railway=rail, no plain railway tag) count as construction / proposed."""
    k = tags.get('railway')
    if k in kinds: return k
    if k is None:
        for key, kind in LIFECYCLE:
            if tags.get(key) and kind in kinds: return kind

    return None

def prefilter(pbf: str, out: str, kinds: set[str] | None = None, log=print) -> str:
    """Pure-python osmium tags-filter: keeps only rail ways, platform outlines (platforms.osm_build) and their nodes"""
    import osmium
    from . import platforms as PL
    kinds = kinds or config.RAIL_KINDS
    t0 = time.time()
    ways, node_ids, seen = [], set(), set()
    log("filter pass 1/2: finding rail ways and platforms")
    rel = PL.osm_relation_ways(pbf)
    def take(w):
        kd = kind_of(w.tags, kinds)
        if kd: keep = {'railway': kd, **{k: w.tags[k] for k in ('service', 'name', 'ref') if k in w.tags}}
        elif PL.osm_is_platform(w.tags) or w.id in rel:
            keep = {'public_transport': 'platform', **({'railway': 'platform_edge'} if w.tags.get('railway') == 'platform_edge' else {})}
            name = PL.osm_outline_name(w.tags) or rel.get(w.id, '')
            if name: keep['name'] = name
        else: return

        refs = [n.ref for n in w.nodes]            # copy out: pyosmium objects die after the loop step
        ways.append(osmium.osm.mutable.Way(id=w.id, nodes=refs, tags=keep)); node_ids.update(refs); seen.add(w.id)

    for w in osmium.FileProcessor(pbf, osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('railway', 'construction:railway', 'proposed:railway', 'public_transport')): take(w)
    left = [i for i in rel if i not in seen]
    if left:                                       # untagged outline ways of platform relations
        for w in osmium.FileProcessor(pbf, osmium.osm.WAY).with_filter(osmium.filter.IdFilter(left)): take(w)

    log(f"  {len(ways):,} rail and platform ways, {len(node_ids):,} nodes ({time.time()-t0:.0f}s)")
    log("filter pass 2/2: collecting their nodes")
    tmp = out + '.tmp.osm.pbf'      # osmium picks the format from the extension
    if os.path.exists(tmp): os.remove(tmp)
    wr = osmium.SimpleWriter(tmp)
    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(node_ids)):
        wr.add_node(osmium.osm.mutable.Node(id=n.id, location=n.location))

    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.KeyFilter('railway')):        # named stops (they are not part of any way)
        if n.tags.get('railway') in STOP_KINDS and n.id not in node_ids and n.location.valid():
            wr.add_node(osmium.osm.mutable.Node(id=n.id, location=n.location, tags={'railway': n.tags['railway'], **({'name': n.tags['name']} if 'name' in n.tags else {})}))

    for w in ways: wr.add_way(w)
    wr.close()
    os.replace(tmp, out)
    log(f"filtered extract: {out} ({os.path.getsize(out)/1e6:.0f} MB, {time.time()-t0:.0f}s)")
    return out

BIG_PBF_BYTES = 1_000_000_000

def prepare(pbf: str, log=print) -> str:
    """Large extracts are filtered down to rail first; small ones are used directly."""
    if os.path.getsize(pbf) < BIG_PBF_BYTES: return pbf
    tag = hashlib.sha1(('v4,' + ','.join(sorted(config.RAIL_KINDS))).encode()).hexdigest()[:6]      # a changed kind list (or what is kept, v4: platforms) invalidates an old filtered extract
    out = os.path.join(config.CACHE_DIR, os.path.basename(pbf).replace('.osm.pbf', '') + f'.rail-{tag}.osm.pbf')
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(pbf):
        log(f"using existing filtered extract {out}")
        return out

    return prefilter(pbf, out, log=log)

def ingest(pbf: str, out: str = config.GRAPH_DB, kinds: set[str] | None = None,
           location_index: str = 'flex_mem', log=print) -> str:
    import osmium
    kinds = kinds or config.RAIL_KINDS
    pbf = prepare(pbf, log)
    tmp = out + '.building'
    db = store.create(tmp)
    db.executescript("""
        CREATE TABLE wp (way INTEGER, seq INTEGER, node INTEGER, lat REAL, lon REAL);
        CREATE TABLE ways (way INTEGER PRIMARY KEY, kind TEXT, pen REAL);""")
    t0 = time.time()
    fp = (osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY)
          .with_locations(location_index)
          .with_filter(osmium.filter.KeyFilter('railway', 'construction:railway', 'proposed:railway')))
    n_ways, batch, wbatch = 0, [], []
    stops = []
    for w in fp:
        if w.is_node():
            if w.tags.get('railway') in STOP_KINDS and w.location.valid():
                stops.append((w.id, w.tags['railway'], w.tags.get('name', ''), w.location.lat, w.location.lon))

            continue

        if not w.is_way(): continue
        kind = kind_of(w.tags, kinds)
        if not kind: continue
        pts = []
        for nd in w.nodes:
            try:
                if nd.location.valid(): pts.append((nd.ref, nd.lat, nd.lon))
            except osmium.InvalidLocationError:
                pass

        if len(pts) < 2: continue
        wbatch.append((w.id, kind, 1.0))
        batch.extend((w.id, i, r, la, lo) for i, (r, la, lo) in enumerate(pts))
        n_ways += 1
        if len(batch) > 200_000:
            db.executemany("INSERT INTO wp VALUES (?,?,?,?,?)", batch); batch.clear()
            db.executemany("INSERT OR REPLACE INTO ways VALUES (?,?,?)", wbatch); wbatch.clear()
            if n_ways % 50_000 < 100: log(f"  ... {n_ways:,} ways")

    db.executemany("INSERT INTO wp VALUES (?,?,?,?,?)", batch)
    db.executemany("INSERT OR REPLACE INTO ways VALUES (?,?,?)", wbatch)
    db.executemany("INSERT OR REPLACE INTO osm_stops VALUES (?,?,?,?,?)", stops)
    log(f"read {n_ways:,} rail ways, {len(stops):,} named stops in {time.time()-t0:.0f}s; finding junctions")

    db.execute("CREATE INDEX wp_node ON wp(node)")
    db.execute("CREATE TABLE junc AS SELECT node FROM wp GROUP BY node HAVING count(*) > 1")
    db.execute("CREATE UNIQUE INDEX junc_node ON junc(node)")
    db.execute("CREATE INDEX wp_way ON wp(way, seq)")
    junctions = {r[0] for r in db.execute("SELECT node FROM junc")}

    log("building edges")
    cur = db.execute("SELECT w.way, w.kind, w.pen, p.node, p.lat, p.lon FROM wp p "
                     "JOIN ways w USING(way) ORDER BY p.way, p.seq")
    out_edges, out_nodes, n_edges = [], {}, 0
    eid = 0

    def flush_way(way, kind, pen, pts):
        nonlocal eid, n_edges
        if len(pts) < 2: return
        start = 0
        for i in range(1, len(pts)):
            if i == len(pts) - 1 or pts[i][0] in junctions:
                seg = pts[start:i + 1]
                start = i
                ll = [(s[1], s[2]) for s in seg]
                length = sum(haversine(ll[j], ll[j + 1]) for j in range(len(ll) - 1))
                if len(ll) < 2 or seg[0][0] == seg[-1][0] and length < 1: continue
                eid += 1
                a, b = seg[0][0], seg[-1][0]
                out_nodes[a] = ll[0]; out_nodes[b] = ll[-1]
                out_edges.append((eid, a, b, length, length * pen, kind, way, store.pack(ll),
                                  min(p[0] for p in ll), max(p[0] for p in ll),
                                  min(p[1] for p in ll), max(p[1] for p in ll)))

        if len(out_edges) >= 50_000: drain()

    def drain():
        db.executemany("INSERT INTO edges VALUES (?,?,?,?,?,?,?,?)", [e[:8] for e in out_edges])
        db.executemany("INSERT INTO edge_idx VALUES (?,?,?,?,?)",
                       [(e[0], e[8], e[9], e[10], e[11]) for e in out_edges])
        db.executemany("INSERT OR IGNORE INTO nodes VALUES (?,?,?)",
                       [(k, v[0], v[1]) for k, v in out_nodes.items()])
        out_edges.clear(); out_nodes.clear()

    cur_way, cur_meta, cur_pts = None, None, []
    for way, kind, pen, node, lat, lon in cur:
        if way != cur_way:
            if cur_way is not None: flush_way(cur_way, *cur_meta, cur_pts)
            cur_way, cur_meta, cur_pts = way, (kind, pen), []

        cur_pts.append((node, lat, lon))

    if cur_way is not None: flush_way(cur_way, *cur_meta, cur_pts)
    drain()

    db.execute("DROP TABLE wp"); db.execute("DROP TABLE ways"); db.execute("DROP TABLE junc")
    db.executescript(store.INDEXES)
    n_edges = db.execute("SELECT count(*) FROM edges").fetchone()[0]
    for k, v in (('build_id', str(int(time.time()))), ('source', os.path.basename(pbf)),
                 ('edges', str(n_edges)), ('kinds', ','.join(sorted(kinds)))):
        db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (k, v))

    db.commit(); db.execute("VACUUM"); db.close()
    os.replace(tmp, out)
    log(f"graph ready: {n_edges:,} edges -> {out} ({time.time()-t0:.0f}s)")
    if out == config.GRAPH_DB:                     # the tracer's platform outlines come from the same extract
        from . import platforms as PL
        PL.osm_build(pbf, log=log)

    return out