"""OSM extract -> routable rail graph.

Memory-safe for a whole-continent .pbf: way geometry streams into a staging
table in SQLite, junctions are found with a SQL GROUP BY, and edges stream out.

Tip: pre-filter a huge extract once, it makes re-ingests much faster:
    osmium tags-filter north-america-latest.osm.pbf w/railway=rail,light_rail,subway,tram,narrow_gauge,monorail,funicular,preserved,construction,proposed -o rail.osm.pbf
"""
from __future__ import annotations
import hashlib, os, time

from . import config, store
from .geo import haversine


LIFECYCLE = (('construction:railway', 'construction'), ('proposed:railway', 'proposed'))


def kind_of(tags, kinds) -> str | None:
    """railway=* kind of a way; ways using the OSM lifecycle prefix (construction:railway=rail, proposed:railway=rail, no plain railway tag) count as construction / proposed."""
    k = tags.get('railway')
    if k in kinds:
        return k
    if k is None:
        for key, kind in LIFECYCLE:
            if tags.get(key) and kind in kinds:
                return kind
    return None


def prefilter(pbf: str, out: str, kinds: set[str] | None = None, log=print) -> str:
    """Pure-python replacement for `osmium tags-filter`: keep only rail ways and
    the nodes they use. Two streaming reads of the big file; the output is small."""
    import osmium
    kinds = kinds or config.RAIL_KINDS
    t0 = time.time()
    ways, node_ids = [], set()
    log("filter pass 1/2: finding rail ways")
    for w in osmium.FileProcessor(pbf, osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('railway', 'construction:railway', 'proposed:railway')):
        kd = kind_of(w.tags, kinds)
        if kd:
            keep = {'railway': kd, **{k: w.tags[k] for k in ('service',) if k in w.tags}}
            refs = [n.ref for n in w.nodes]            # copy out: pyosmium objects die after the loop step
            ways.append(osmium.osm.mutable.Way(id=w.id, nodes=refs, tags=keep))
            node_ids.update(refs)
    log(f"  {len(ways):,} rail ways, {len(node_ids):,} nodes ({time.time()-t0:.0f}s)")
    log("filter pass 2/2: collecting their nodes")
    tmp = out + '.tmp.osm.pbf'      # osmium picks the format from the extension
    if os.path.exists(tmp):
        os.remove(tmp)
    wr = osmium.SimpleWriter(tmp)
    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(node_ids)):
        wr.add_node(osmium.osm.mutable.Node(id=n.id, location=n.location))
    for w in ways:
        wr.add_way(w)
    wr.close()
    os.replace(tmp, out)
    log(f"filtered extract: {out} ({os.path.getsize(out)/1e6:.0f} MB, {time.time()-t0:.0f}s)")
    return out


BIG_PBF_BYTES = 1_000_000_000


def prepare(pbf: str, log=print) -> str:
    """Large extracts are filtered down to rail first; small ones are used directly."""
    if os.path.getsize(pbf) < BIG_PBF_BYTES:
        return pbf
    tag = hashlib.sha1(('v2,' + ','.join(sorted(config.RAIL_KINDS))).encode()).hexdigest()[:6]      # a changed kind list invalidates an old filtered extract
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
    for w in fp:
        if not w.is_way():
            continue
        kind = kind_of(w.tags, kinds)
        if not kind:
            continue
        pts = []
        for nd in w.nodes:
            try:
                if nd.location.valid():
                    pts.append((nd.ref, nd.lat, nd.lon))
            except osmium.InvalidLocationError:
                pass
        if len(pts) < 2:
            continue
        wbatch.append((w.id, kind, 1.0))
        batch.extend((w.id, i, r, la, lo) for i, (r, la, lo) in enumerate(pts))
        n_ways += 1
        if len(batch) > 200_000:
            db.executemany("INSERT INTO wp VALUES (?,?,?,?,?)", batch); batch.clear()
            db.executemany("INSERT OR REPLACE INTO ways VALUES (?,?,?)", wbatch); wbatch.clear()
            if n_ways % 50_000 < 100:
                log(f"  ... {n_ways:,} ways")
    db.executemany("INSERT INTO wp VALUES (?,?,?,?,?)", batch)
    db.executemany("INSERT OR REPLACE INTO ways VALUES (?,?,?)", wbatch)
    log(f"read {n_ways:,} rail ways in {time.time()-t0:.0f}s; finding junctions")

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
        if len(pts) < 2:
            return
        start = 0
        for i in range(1, len(pts)):
            if i == len(pts) - 1 or pts[i][0] in junctions:
                seg = pts[start:i + 1]
                start = i
                ll = [(s[1], s[2]) for s in seg]
                length = sum(haversine(ll[j], ll[j + 1]) for j in range(len(ll) - 1))
                if len(ll) < 2 or seg[0][0] == seg[-1][0] and length < 1:
                    continue
                eid += 1
                a, b = seg[0][0], seg[-1][0]
                out_nodes[a] = ll[0]; out_nodes[b] = ll[-1]
                out_edges.append((eid, a, b, length, length * pen, kind, way, store.pack(ll),
                                  min(p[0] for p in ll), max(p[0] for p in ll),
                                  min(p[1] for p in ll), max(p[1] for p in ll)))
        if len(out_edges) >= 50_000:
            drain()

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
            if cur_way is not None:
                flush_way(cur_way, *cur_meta, cur_pts)
            cur_way, cur_meta, cur_pts = way, (kind, pen), []
        cur_pts.append((node, lat, lon))
    if cur_way is not None:
        flush_way(cur_way, *cur_meta, cur_pts)
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
    return out