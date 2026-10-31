"""SQLite-backed rail graph: junction-compressed edges with R-tree spatial index.

Whole-continent data never sits in memory; the router pulls adjacency on demand
and the UI pulls only the edges inside the viewport.
"""
from __future__ import annotations
import math, os, sqlite3, threading
from array import array
from functools import lru_cache

from . import config
from .geo import Pt, project_on_path, pad_bbox

SCHEMA = """
CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE nodes (id INTEGER PRIMARY KEY, lat REAL NOT NULL, lon REAL NOT NULL);
CREATE TABLE edges (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL,
                    len REAL NOT NULL, cost REAL NOT NULL, kind TEXT, way INTEGER, geom BLOB NOT NULL);
CREATE VIRTUAL TABLE edge_idx USING rtree(id, minlat, maxlat, minlon, maxlon);
"""
INDEXES = "CREATE INDEX edges_a ON edges(a); CREATE INDEX edges_b ON edges(b);"


def pack(pts: list[Pt]) -> bytes:
    arr = array('i')
    for la, lo in pts:
        arr.append(round(la * 1e7)); arr.append(round(lo * 1e7))
    return arr.tobytes()


def unpack(blob: bytes) -> list[Pt]:
    arr = array('i'); arr.frombytes(blob)
    return [(arr[i] / 1e7, arr[i + 1] / 1e7) for i in range(0, len(arr), 2)]


class Edge:
    __slots__ = ('id', 'a', 'b', 'len', 'cost', 'kind', 'way', 'geom')

    def __init__(self, id, a, b, len, cost, kind, way, geom):
        self.id, self.a, self.b, self.len, self.cost = id, a, b, len, len        # cost is simply length
        self.kind, self.way, self.geom = kind, way, geom


def _edge(row) -> Edge:
    return Edge(row[0], row[1], row[2], row[3], row[4], row[5], row[6], unpack(row[7]))


class GraphStore:
    COLS = "e.id, e.a, e.b, e.len, e.cost, e.kind, e.way, e.geom"

    def __init__(self, path: str = config.GRAPH_DB):
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"No rail graph at {path}. Run the 'Tracer: First-time setup' task (python -m devtools setup)")
        self.path = path
        self._local = threading.local()
        self.build_id = self.meta('build_id') or '0'
        self._adjd: dict = {}                 # node -> adjacency, filled lazily or in bulk by preload()
        self._posd: dict = {}

    # connection per thread
    @property
    def db(self) -> sqlite3.Connection:
        c = getattr(self._local, 'c', None)
        if c is None:
            c = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
            self._local.c = c
        return c

    def meta(self, key: str) -> str | None:
        r = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return r[0] if r else None

    def node(self, nid: int) -> Pt:
        r = self.db.execute("SELECT lat, lon FROM nodes WHERE id=?", (nid,)).fetchone()
        return (r[0], r[1])

    def edge(self, eid: int) -> Edge:
        r = self.db.execute(f"SELECT {self.COLS} FROM edges e WHERE e.id=?", (eid,)).fetchone()
        return _edge(r)

    def edges_in_bbox(self, bbox, limit: int = 20000) -> list[Edge]:
        s, w, n, e = bbox
        rows = self.db.execute(
            f"SELECT {self.COLS} FROM edge_idx i JOIN edges e ON e.id=i.id "
            "WHERE i.maxlat>=? AND i.minlat<=? AND i.maxlon>=? AND i.minlon<=? LIMIT ?",
            (s, n, w, e, limit)).fetchall()
        return [_edge(r) for r in rows]

    def _adj_uncached(self, node: int) -> tuple:
        rows = self.db.execute(
            "SELECT id, a, b, len FROM edges WHERE a=? OR b=?", (node, node)).fetchall()
        return tuple((r[0], r[2] if r[1] == node else r[1], r[3]) for r in rows)

    def adjacent(self, node: int):
        """-> ((edge_id, other_node, cost), ...)"""
        v = self._adjd.get(node)
        if v is None:
            if len(self._adjd) > 2_000_000:
                self._adjd.clear(); self._posd.clear()
            v = self._adjd[node] = self._adj_uncached(node)
        return v

    def node_pos(self, nid: int) -> Pt:
        v = self._posd.get(nid)
        if v is None:
            v = self._posd[nid] = self.node(nid)
        return v

    def preload(self, bbox, limit: int = 300_000) -> int:
        """Load every edge in a box with one query, so a search there runs from memory. A node inside the box has all its edges
        in the box too (they all touch it), so its adjacency is complete. -> edges loaded (0 if the box is too big)."""
        s, w, n, e = bbox
        rows = self.db.execute(
            "SELECT e.id, e.a, e.b, e.len, e.geom FROM edge_idx i JOIN edges e ON e.id=i.id "
            "WHERE i.maxlat>=? AND i.minlat<=? AND i.maxlon>=? AND i.minlon<=? LIMIT ?", (s, n, w, e, limit)).fetchall()
        if len(rows) >= limit:
            return 0
        adj: dict = {}; pos: dict = {}
        for eid, a, b, ln, blob in rows:
            h = array('i'); h.frombytes(blob[:8]); t = array('i'); t.frombytes(blob[-8:])
            pos[a] = (h[0] / 1e7, h[1] / 1e7); pos[b] = (t[0] / 1e7, t[1] / 1e7)
            adj.setdefault(a, []).append((eid, b, ln))
            if b != a:
                adj.setdefault(b, []).append((eid, a, ln))
        for nid, lst in adj.items():
            p = pos[nid]
            if s < p[0] < n and w < p[1] < e:
                self._adjd[nid] = tuple(lst); self._posd[nid] = p
        return len(rows)

    def future_ids(self) -> frozenset:
        """Ids of edges that are only planned/under construction (OSM railway=construction / proposed)."""
        if not hasattr(self, '_future_ids'):
            q = ','.join('?' * len(config.FUTURE_KINDS))
            self._future_ids = frozenset(r[0] for r in self.db.execute(f"SELECT id FROM edges WHERE kind IN ({q})", tuple(config.FUTURE_KINDS)))
        return self._future_ids

    def nearest(self, p: Pt, max_m: float = config.MAX_SNAP_M, k: int = 5, skip=None):
        """Closest edges to p: [(dist_m, edge, seg_idx, t, point)] ascending."""
        r = 60.0
        while True:
            r = min(r, max_m)
            found = []
            for e in self.edges_in_bbox(pad_bbox((p[0], p[1], p[0], p[1]), r), 2000):
                if skip and e.id in skip:
                    continue
                d, i, t, q = project_on_path(p, e.geom)
                if d <= r:
                    found.append((d, e, i, t, q))
            if found or r >= max_m:
                found.sort(key=lambda x: x[0])
                return found[:k]
            r *= 3


# ── writing (ingest only) ────────────────────────────────────────────────────

def create(path: str) -> sqlite3.Connection:
    if os.path.exists(path):
        os.remove(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=OFF"); db.execute("PRAGMA synchronous=OFF")
    db.executescript(SCHEMA)
    return db