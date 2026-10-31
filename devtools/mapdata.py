"""Read map_data.py and write station moves back into it.

The file is machine-formatted (data/formatter.py), one station per line:
    "Union Station": {'Location': (39.75300, -104.99900), 'Label': ...},
or, with extra platforms, 'Platforms': {'2': (lat, lon), ...} on the same line. A move rewrites only the one
coordinate tuple (the Location, or that platform's). Before anything is written the edited text is re-loaded and compared with
the original: if anything other than the requested Locations differs, nothing is written.
"""
from __future__ import annotations
import copy, json, os, re, shutil, time

from . import config

NAMES = ('Modes', 'Nodes', 'Stations', 'Segments', 'Lines', 'Destinations', 'Projects')
_LOC = re.compile(r"""(["']Location["']\s*:\s*)[\(\[]\s*-?[\d.]+\s*,\s*-?[\d.]+\s*[\)\]]""")


def load_namespace(path: str) -> dict:
    with open(path, encoding='utf-8') as f:
        src = f.read()
    ns: dict = {'__name__': 'map_data', '__file__': path}
    exec(compile(src, path, 'exec'), ns)
    return ns


def _norm(o) -> str:
    return json.dumps(o, sort_keys=True, default=lambda x: sorted(x) if isinstance(x, (set, frozenset)) else str(x))


def locate(raw_stations: dict, flat_key: str):
    """Normalised station key -> (raw key, platform name | None)."""
    if flat_key in raw_stations and isinstance(raw_stations[flat_key], dict) and 'Location' in raw_stations[flat_key]:
        return flat_key, None
    for name, data in raw_stations.items():
        if isinstance(data, dict):
            for plat in data.get('Platforms') or {}:
                if f"{name} {{{plat}}}" == flat_key:
                    return name, plat
    return None


def _key_re(k: str):
    return re.compile(r"""^(\s*)(["'])""" + re.escape(k) + r"""\2\s*:\s*\{""")


def _replace(lines: list[str], raw_key: str, plat: str | None, lat: float, lon: float) -> None:
    """Rewrite one coordinate tuple. A station is one line, or (with platforms) a block: the station's own
    Location on the first line inside it, then one line per platform."""
    s0 = next(i for i, l in enumerate(lines) if re.match(r'^\s*Stations\s*=\s*\{', l))
    e0 = next((i for i in range(s0 + 1, len(lines)) if lines[i].startswith('}')), len(lines))
    i = next((i for i in range(s0 + 1, e0) if _key_re(raw_key).match(lines[i])), None)
    if i is None:
        raise ValueError(f"station '{raw_key}' not found in the Stations block")
    indent = len(lines[i]) - len(lines[i].lstrip())
    end = i + 1
    if lines[i].rstrip().endswith('{'):               # block form: runs to the closing brace at the station's own indent
        end = next((j for j in range(i + 1, e0) if lines[j].strip().startswith('}') and len(lines[j]) - len(lines[j].lstrip()) <= indent), e0)
    new = "(%.5f, %.5f)" % (lat, lon)
    if plat is None:
        rng = [i] if end == i + 1 else [i + 1]
        m, j = next(((_LOC.search(lines[j]), j) for j in rng if _LOC.search(lines[j])), (None, None))
    else:
        pat = re.compile(r"""^\s*(["'])%s\1\s*:\s*\{""" % re.escape(plat))
        j = next((j for j in range(i, end) if pat.match(lines[j]) or (end == i + 1 and False)), None)
        if j is None and end == i + 1:               # (older single-line layout)
            j = i
            m = re.compile(r"""(["']%s["']\s*:\s*(?:\{\s*["']Location["']\s*:\s*)?)\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)""" % re.escape(plat)).search(lines[i])
        else:
            m = _LOC.search(lines[j]) if j is not None else None
    if not m:
        raise ValueError(f"no coordinates found for '{raw_key}'" + (f" / platform '{plat}'" if plat else ''))
    lines[j] = lines[j][:m.start()] + m.group(1) + new + lines[j][m.end():]


def move_stations(path: str, moves: dict[str, list[float]], backup_dir: str = config.CACHE_DIR) -> dict:
    """moves: {normalised station key: [lat, lon]}. -> {'moved': n, 'backup': path}"""
    with open(path, encoding='utf-8') as f:
        src = f.read()
    ns = load_namespace(path)
    raw = ns['Stations']
    expected = copy.deepcopy(raw)
    lines = src.split('\n')
    for key, (lat, lon) in moves.items():
        loc = locate(raw, key)
        if not loc:
            raise ValueError(f"unknown station '{key}'")
        rk, plat = loc
        _replace(lines, rk, plat, float(lat), float(lon))
        if plat is None:
            expected[rk]['Location'] = (round(float(lat), 5), round(float(lon), 5))
        else:
            spec, pt = expected[rk]['Platforms'], (round(float(lat), 5), round(float(lon), 5))
            if isinstance(spec[plat], dict): spec[plat]['Location'] = pt
            else: spec[plat] = pt
    new_src = '\n'.join(lines)

    ns2: dict = {'__name__': 'map_data'}
    exec(compile(new_src, path, 'exec'), ns2)

    def rounded(stations):      # compare Locations at the 5 decimals we write
        out = copy.deepcopy(stations)
        for v in out.values():
            if isinstance(v, dict) and 'Location' in v:
                v['Location'] = [round(float(v['Location'][0]), 5), round(float(v['Location'][1]), 5)]
                ps = {}
                for k, c in (v.get('Platforms') or {}).items():
                    loc = c['Location'] if isinstance(c, dict) else c
                    ps[k] = {**(c if isinstance(c, dict) else {}), 'Location': [round(float(loc[0]), 5), round(float(loc[1]), 5)]}
                if ps: v['Platforms'] = ps
                else: v.pop('Platforms', None)
        return out
    if _norm(rounded(ns2['Stations'])) != _norm(rounded(expected)):
        raise ValueError("edited file would differ from the original in more than the moved stations; nothing written")
    for n in NAMES:
        if n != 'Stations' and _norm(ns.get(n)) != _norm(ns2.get(n)):
            raise ValueError(f"'{n}' would change; nothing written")

    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(backup_dir, 'map_data.backup.py')
    shutil.copyfile(path, backup)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(new_src)
    os.replace(tmp, path)
    return {'moved': len(moves), 'backup': backup, 'when': time.strftime('%Y-%m-%dT%H:%M:%S')}


_STATIONS: dict = {}


def station_locations(path: str | None = None) -> dict[str, tuple[float, float]]:
    """Every stopping place in map_data.py ("Station" and "Station {platform}") -> (lat, lon). Re-read when the file changes."""
    path = path or config.MAP_DATA_FILE
    if not os.path.exists(path):
        return {}
    st = os.stat(path); sig = (st.st_mtime_ns, st.st_size)
    hit = _STATIONS.get(path)
    if not hit or hit[0] != sig:
        import sys
        if config.ROOT not in sys.path:
            sys.path.insert(0, config.ROOT)
        from core.station_resolver import normalize_stations
        flat = normalize_stations(load_namespace(path)['Stations'])
        hit = _STATIONS[path] = (sig, {k: (float(v['Location'][0]), float(v['Location'][1])) for k, v in flat.items()})
    return hit[1]


def forget_stations(path: str | None = None) -> None:
    _STATIONS.pop(path or config.MAP_DATA_FILE, None)