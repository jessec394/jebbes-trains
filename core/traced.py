"""Reading the detailed map's traced routes (data/tracks/geometry.json): operator -> line -> pattern -> category -> entry"""
from __future__ import annotations

from core import paths
from core.fileio import read_json

CATS = ('Present', 'Fantasy')

def load_geometry(path: str = paths.GEOMETRY_FILE) -> dict:
    return read_json(path, {}).get('routes', {})

def as_polylines(v) -> list:
    """A stored geometry is one polyline [[lat,lon],...] or a list of polylines."""
    if not v: return []
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

# Tree helpers

def get_entry(doc: dict, op, line, pat, cat, create=False):
    node = doc
    for k in (op, line, pat):
        if k not in node:
            if not create: return None
            node[k] = {}

        node = node[k]

    if cat not in node and create: node[cat] = {}
    return node.get(cat)

def iter_routes(doc: dict):
    for op, lines in doc.items():
        for line, pats in lines.items():
            for pat, cats in pats.items():
                for cat, entry in cats.items(): yield op, line, pat, cat, entry

def drop_entry(doc: dict, op, line, pat, cat):
    try:
        del doc[op][line][pat][cat]
    except KeyError:
        return

    if not doc[op][line][pat]: del doc[op][line][pat]
    if not doc[op][line]: del doc[op][line]
    if not doc[op]: del doc[op]