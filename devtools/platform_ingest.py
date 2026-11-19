"""OSM platform outlines (railway=platform, platform_edge, public_transport=platform) kept locally, to be drawn on the tracer map as a picture to build
platforms against. Nothing in the map data uses them.

Build once from the same OSM extract the rail graph came from (about a minute), then it is read from devtools/cache/osm_platforms.sqlite.
Run this file with VS Code's Run button, or:

    python -m devtools.platform_ingest                    (finds the extract the graph was built from)
    python -m devtools.platform_ingest path/to/file.osm.pbf

Needs pyosmium:  pip install osmium
"""
from __future__ import annotations
import os, sqlite3, sys, threading
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))     # so it also runs as a plain file (VS Code's Run button), not only as -m
from devtools import config
from array import array

DB = os.path.join(config.CACHE_DIR, 'osm_platforms.sqlite')
_local = threading.local()


def pack(pts) -> bytes:                         # lat, lon as 1e-7 degree integers (the same packing the rail graph uses)
    a = array('i')
    for la, lo in pts: a.append(round(la * 1e7)); a.append(round(lo * 1e7))
    return a.tobytes()


def unpack(b: bytes) -> list:
    a = array('i'); a.frombytes(b)
    return [(a[i] / 1e7, a[i + 1] / 1e7) for i in range(0, len(a), 2)]


def _connect():
    c = getattr(_local, 'c', None)
    if c is None or getattr(_local, 'path', None) != DB:
        c = _local.c = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, check_same_thread=False); _local.path = DB
    return c


def ready() -> bool:
    return os.path.exists(DB)


def query(s: float, w: float, n: float, e: float, limit: int = 6000) -> list:
    """Outlines touching the box: [{'p': [[lat, lon], ...], 'a': closed, 'e': is a platform edge, 'n': name}]."""
    if not ready(): return []
    try:
        rows = _connect().execute("SELECT p.closed, p.edge, p.name, p.geom FROM plat_idx i JOIN plat p ON p.id = i.id "
                                  "WHERE i.maxlat >= ? AND i.minlat <= ? AND i.maxlon >= ? AND i.minlon <= ? LIMIT ?", (s, n, w, e, limit)).fetchall()
    except sqlite3.Error:
        return []
    return [{'p': [[round(a, 7), round(b, 7)] for a, b in unpack(g)], 'a': bool(c), 'e': bool(ed), 'n': nm or ''} for c, ed, nm, g in rows]


def write(features, path: str = DB) -> int:
    """features: iterable of (osm id, closed, edge, name, [(lat, lon), ...]). Replaces the database."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    if os.path.exists(tmp): os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("CREATE TABLE plat (id INTEGER PRIMARY KEY, closed INTEGER, edge INTEGER, name TEXT, geom BLOB NOT NULL);"
                     "CREATE VIRTUAL TABLE plat_idx USING rtree(id, minlat, maxlat, minlon, maxlon);")
    n = 0
    for i, (oid, closed, edge, name, pts) in enumerate(features, 1):
        db.execute("INSERT INTO plat VALUES (?,?,?,?,?)", (i, int(closed), int(edge), name or '', pack(pts)))
        db.execute("INSERT INTO plat_idx VALUES (?,?,?,?,?)", (i, min(p[0] for p in pts), max(p[0] for p in pts), min(p[1] for p in pts), max(p[1] for p in pts)))
        n += 1
    db.commit(); db.close(); os.replace(tmp, path)
    return n


def _find_extract(arg: str | None) -> str:
    if arg: return arg
    name = None
    try:
        from devtools.store import GraphStore
        name = GraphStore().meta('source')
    except Exception: pass
    if name:
        for base in (config.ROOT, config.CACHE_DIR, os.path.expanduser('~')):
            for dp, dn, fn in os.walk(base):
                if dp.count(os.sep) - base.count(os.sep) > 4: dn[:] = []; continue
                dn[:] = [d for d in dn if d not in ('node_modules', '.git', '__pycache__', '.venv', 'venv')]
                if name in fn: return os.path.join(dp, name)
    raise SystemExit("Could not find the OSM extract the graph was built from.\n  Run:  python -m devtools.platform_ingest path/to/your-file.osm.pbf")


def ingest(path: str) -> int:
    try: import osmium
    except ImportError: raise SystemExit("This needs pyosmium:  pip install osmium")

    def is_plat(t): return t.get('railway') in ('platform', 'platform_edge') or t.get('public_transport') == 'platform'

    class Members(osmium.SimpleHandler):                            # pass 1: ways that are the outline of a platform relation (a multipolygon)
        def __init__(self): super().__init__(); self.ways = {}
        def relation(self, r):
            t = r.tags
            if is_plat(t):
                for m in r.members:
                    if m.type == 'w' and m.role in ('outer', 'platform', ''): self.ways[m.ref] = t.get('name') or t.get('ref') or ''
    pre = Members(); pre.apply_file(path)

    out = []
    class Ways(osmium.SimpleHandler):                               # pass 2: the outlines themselves
        def way(self, w):
            t = w.tags; rel = pre.ways.get(w.id)
            if not (is_plat(t) or rel is not None): return
            try: pts = [(n.lat, n.lon) for n in w.nodes if n.location.valid()]
            except Exception: return
            if len(pts) < 2: return
            out.append((w.id, len(pts) > 3 and pts[0] == pts[-1], t.get('railway') == 'platform_edge', t.get('name') or t.get('ref') or t.get('local_ref') or rel or '', pts))
    Ways().apply_file(path, locations=True, idx='flex_mem')
    return write(out)


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    path = _find_extract(argv[0] if argv else None)
    print(f"Reading platforms from {path} ...", flush=True)
    n = ingest(path)
    print(f"{n:,} platform outlines saved to {DB}")


if __name__ == '__main__':
    main()