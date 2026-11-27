"""Reading and writing the map data files (data/map_data.py, data/detailed_map.py)"""
from __future__ import annotations
import json
from typing import Any

from core.fileio import FileCache

NAMES = ('Modes', 'Nodes', 'Stations', 'Segments', 'Lines', 'Destinations', 'Projects')
CATEGORIES = ('Fantasy', 'Present')          # the order the Lines block lists them in

# Loading

_CODE: dict = {}

def exec_source(src: str, path: str = '<map data>') -> dict:
    """Run a map data file's text -> its namespace (Modes, Stations, ...). The compiled code is kept per text: each run still builds fresh objects."""
    k = (path, hash(src), len(src))
    code = _CODE.get(k)
    if code is None:
        if len(_CODE) > 8: _CODE.clear()
        code = _CODE[k] = compile(src, path, 'exec')

    ns: dict = {'__name__': 'map_data', '__file__': path}
    exec(code, ns)
    return ns

def load_namespace(path: str) -> dict:
    """Run the file fresh: always current, and immune to a stale .pyc after a write-back."""
    with open(path, encoding='utf-8') as f:
        return exec_source(f.read(), path)

_NS = FileCache(load_namespace)

def load_namespace_cached(path: str) -> dict:
    """load_namespace, kept until the file changes. READ ONLY: callers must not change what it returns."""
    return _NS.get(path)

def forget_namespace(path: str) -> None:
    _NS.forget(path)

def norm(o) -> str:
    """A canonical text of a data structure, to compare two of them."""
    return json.dumps(o, sort_keys=True, default=lambda x: sorted(x) if isinstance(x, (set, frozenset)) else str(x))

# Formatting (the layout every write-back keeps)

def fmt_coord(c) -> str:
    return f"({float(c[0]):.5f}, {float(c[1]):.5f})"

def _items(d: dict) -> str:
    parts = []
    if 'Location' in d: parts.append(f"'Location': {fmt_coord(d['Location'])}")
    for k in sorted(v for v in d if v not in ('Location', 'Platforms')):
        parts.append(f"'Span': [{', '.join(fmt_coord(x) for x in d[k])}]" if k == 'Span' else f"{k!r}: {d[k]!r}")

    return ", ".join(parts)

def fmt_station(key: str, d: dict) -> str:
    """One line, or for a station with platforms a block with one line per platform (a platform is always a dict with its Location)."""
    if not d.get('Platforms'): return f'    "{key}": {{{_items(d)}}},\n'
    head = _items(d)
    out = f'    "{key}": {{\n' + (f'        {head},\n' if head else '') + "        'Platforms': {\n"
    for name in sorted(d['Platforms']):
        p = d['Platforms'][name]
        p = p if isinstance(p, dict) else {'Location': p}
        out += f"            {name!r}: {{{_items(p)}}},\n"

    return out + "        },\n    },\n"

def fmt_stations(stations: dict) -> str:
    return "Stations = {\n" + "".join(fmt_station(k, stations[k]) for k in sorted(stations)) + "}\n"

def fmt_segment(key: str, content: dict) -> str:
    return f'    "{key}": {{\n' + ''.join(f'        "{k}": {content[k]!r},\n' for k in sorted(content)) + '    },\n'

def fmt_lines(lines: dict) -> str:
    out = "Lines = {\n"
    for op in sorted(lines):
        out += f'    "{op}": {{\n'
        for ln in sorted(lines[op]):
            out += f'        "{ln}": {{\n'
            for cat in CATEGORIES:
                if cat not in lines[op][ln]: continue
                out += f'            "{cat}": {{\n'
                for pn in sorted(lines[op][ln][cat]): out += f'                "{pn}": {lines[op][ln][cat][pn]!r},\n'
                out += "            },\n"

            out += "        },\n"

        out += "    },\n"

    return out + "}\n"

def fmt_modes(modes: dict) -> str:
    return "Modes = {\n" + ''.join(f'    "{k}": {{{", ".join(f"{a!r}: {b!r}" for a, b in v.items())}}},\n' for k, v in modes.items()) + "}\n"

def _fmt_nodes(nodes: dict) -> str:
    out = "Nodes = {\n"
    for key in sorted(nodes):
        v = nodes[key]
        out += (f"    \"{key}\": {{'Location': {fmt_coord(v['Location'])}}},\n" if isinstance(v, dict) and 'Location' in v
                else f'    "{key}": {v!r},\n')

    return out + "}\n"

def _fmt_simple_destinations(dests: dict) -> str:
    out = "Destinations = {\n"
    for cat in sorted(dests):
        out += f'    "{cat}": {{\n'
        for name in sorted(dests[cat]):
            v = dests[cat][name]
            if isinstance(v, dict) and 'Location' in v:
                inner = f'"Location": {fmt_coord(v["Location"])}, "Stations": {sorted(v.get("Stations", []))!r}'
                for k in sorted(k for k in v if k not in ('Location', 'Stations')): inner += f', {k!r}: {v[k]!r}'
                out += f'        "{name}": {{{inner}}},\n'
            else:
                out += f'        "{name}": {v!r},\n'

        out += "    },\n"

    return out + "}\n"

def _fmt_projects(projects: dict) -> str:
    out = "Projects = {\n"
    for key in sorted(projects):
        v = projects[key]
        inner = f'"Source": {v["Source"]!r}, "Location": {fmt_coord(v["Location"])}, "Radius": {v["Radius"]!r}'
        for k in sorted(k for k in v if k not in ('Source', 'Location', 'Radius')): inner += f', {k!r}: {v[k]!r}'
        out += f'    "{key}": {{{inner}}},\n'

    return out + "}"

def format_map_data(ns: dict[str, Any]) -> str:
    """The whole simplified map file (data/map_data.py) in its canonical layout."""
    stations = "Stations = {\n" + "".join(
        fmt_station(k, v) if isinstance(v, dict) and ('Location' in v or v.get('Platforms')) else f'    "{k}": {v!r},\n'
        for k, v in sorted(ns['Stations'].items())) + "}\n"
    segments = "Segments = {\n" + "".join(
        fmt_segment(k, v) if isinstance(v, dict) else f'    "{k}": {{\n    }},\n' for k, v in sorted(ns['Segments'].items())) + "}\n"
    return "\n".join((fmt_modes(ns['Modes']), _fmt_nodes(ns['Nodes']), stations, segments, fmt_lines(ns['Lines']),
                      _fmt_simple_destinations(ns['Destinations']), _fmt_projects(ns['Projects'])))