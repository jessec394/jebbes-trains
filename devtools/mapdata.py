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


def _stations_cached(path: str | None):
    path = path or config.MAP_DATA_FILE
    if not os.path.exists(path):
        return {}, {}
    st = os.stat(path); sig = (st.st_mtime_ns, st.st_size)
    hit = _STATIONS.get(path)
    if not hit or hit[0] != sig:
        import sys
        if config.ROOT not in sys.path:
            sys.path.insert(0, config.ROOT)
        from core.station_resolver import normalize_stations
        raw = load_namespace(path)['Stations']
        flat = normalize_stations(raw)
        spans = {}
        for name, d in raw.items():
            if d.get('Span'): spans[name] = tuple(tuple(c) for c in d['Span'])
            for p, spec in (d.get('Platforms') or {}).items():
                if isinstance(spec, dict) and spec.get('Span'): spans[f"{name} {{{p}}}"] = tuple(tuple(c) for c in spec['Span'])
        hit = _STATIONS[path] = (sig, {k: (float(v['Location'][0]), float(v['Location'][1])) for k, v in flat.items()}, spans)
    return hit[1], hit[2]


def station_locations(path: str | None = None) -> dict[str, tuple[float, float]]:
    """Every stopping place in map_data.py ("Station" and "Station {platform}") -> (lat, lon). Re-read when the file changes."""
    return _stations_cached(path)[0]


def station_spans(path: str | None = None) -> dict[str, tuple]:
    """Stopping place -> its platform span ((lat, lon), (lat, lon)): the stretch of rail it covers. Only those that have one."""
    return _stations_cached(path)[1]


_USAGE: dict = {}


def station_usage(path: str | None = None) -> dict[str, list[str]]:
    """Stopping place -> ['Present', 'Fantasy'] subset, derived from which patterns stop there (never stored; recomputed when the file changes).
    A platform in no list is not used by any pattern yet. Bare names of stations with platforms (group references) count for every platform."""
    path = path or config.MAP_DATA_FILE
    if not os.path.exists(path): return {}
    st = os.stat(path); sig = (st.st_mtime_ns, st.st_size)
    hit = _USAGE.get(path)
    if not hit or hit[0] != sig:
        import sys
        if config.ROOT not in sys.path: sys.path.insert(0, config.ROOT)
        from core.station_usage import compute_station_usage
        ns = load_namespace(path)
        hit = _USAGE[path] = (sig, {k: sorted(v) for k, v in compute_station_usage(ns['Lines'], ns['Segments']).items()})
    return hit[1]


def forget_stations(path: str | None = None) -> None:
    _STATIONS.pop(path or config.MAP_DATA_FILE, None); _USAGE.pop(path or config.MAP_DATA_FILE, None)


# ── editing stations and platforms in map_data.py ────────────────────────────────────────────────
# The Stations block is regenerated in the layout of data/formatter.py (one line per station; a block with one line per
# platform when it has platforms). Every other block is checked to be unchanged, and a backup is kept.

def _c(c): return f"({float(c[0]):.5f}, {float(c[1]):.5f})"


def _items(d: dict) -> str:
    parts = []
    if 'Location' in d: parts.append(f"'Location': {_c(d['Location'])}")
    for k in sorted(v for v in d if v not in ('Location', 'Platforms')):
        parts.append(f"'Span': [{', '.join(_c(x) for x in d[k])}]" if k == 'Span' else f"{k!r}: {d[k]!r}")
    return ", ".join(parts)


def fmt_station(key: str, d: dict) -> str:
    if not d.get('Platforms'):
        return f'    "{key}": {{{_items(d)}}},\n'
    head = _items(d)
    out = f'    "{key}": {{\n' + (f'        {head},\n' if head else '') + "        'Platforms': {\n"
    for name in sorted(d['Platforms']):
        p = d['Platforms'][name]
        p = p if isinstance(p, dict) else {'Location': p}
        out += f"            {name!r}: {{{_items(p)}}},\n"
    return out + "        },\n    },\n"


def fmt_stations(stations: dict) -> str:
    return "Stations = {\n" + "".join(fmt_station(k, stations[k]) for k in sorted(stations)) + "}\n"


def _refs(ns: dict, key: str) -> list[str]:
    """Where a stopping place is named: Segments (stop lists, Keep / Skip / Swap) and Lines, as 'Segment: ...' texts."""
    import re
    hits = []
    def walk(o, path):
        if isinstance(o, str):
            m = re.match(r'^(\[[RX]\] )?(.*)$', o, re.S)
            if m.group(2) == key: hits.append(' / '.join(path))
        elif isinstance(o, dict):
            for k, v in o.items(): walk(v, path + [str(k)])
        elif isinstance(o, (list, tuple)):
            for x in o: walk(x, path)
    for blk in ('Segments', 'Lines'): walk(ns.get(blk), [blk])
    return hits


def _rewrite(o, renames: dict):
    """o with every stop string in `renames` (optionally behind [R] / [X]) replaced; containers keep their type."""
    if isinstance(o, str):
        m = re.match(r'^((?:\[[RX]\] )?)(.*)$', o, re.S)
        return m.group(1) + renames[m.group(2)] if m.group(2) in renames else o
    if isinstance(o, dict): return {k: _rewrite(v, renames) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return type(o)(_rewrite(x, renames) for x in o)
    return o


def _block_span(src: str, name: str):
    m = re.search(r'^%s = \{\n' % name, src, re.M)
    e = re.compile(r'^\}', re.M).search(src, m.end())
    return m.end(), e.start()


def edit_stations(path: str, mutate, backup_dir: str = config.CACHE_DIR) -> dict:
    """Apply `mutate(raw Stations dict, namespace)` to map_data.py -> {'backup', 'changed': [station names]}. Raises ValueError (nothing written).
    mutate may return {old stop name: new stop name}, or (that, {old station: new station}): the stop names are rewritten in Segments and
    Lines (a station that gains its first named platform is no longer addressed by its bare name); the station names, which Destinations
    use for the whole station, in Destinations."""
    with open(path, encoding='utf-8') as f:
        src = f.read()
    ns = load_namespace(path)
    raw = copy.deepcopy(ns['Stations'])
    ret = mutate(raw, ns) or {}
    renames, groups = ret if isinstance(ret, tuple) else (ret, {})
    s0, s1 = src.index('\nStations = {\n') + 1, src.index('\nSegments = {\n')
    new_src = src[:s0] + fmt_stations(raw) + src[s1:]
    expect = {n: ns.get(n) for n in NAMES}
    if renames:
        pat = re.compile(r'(["\'])((?:\[[RX]\] )?)(%s)\1' % '|'.join(re.escape(k) for k in sorted(renames, key=len, reverse=True)))
        for blk in ('Segments', 'Lines'):
            x, y = _block_span(new_src, blk)
            new_src = new_src[:x] + pat.sub(lambda m: m.group(1) + m.group(2) + renames[m.group(3)] + m.group(1), new_src[x:y]) + new_src[y:]
            expect[blk] = _rewrite(expect[blk], renames)
    if groups:
        pat = re.compile(r'(["\'])((?:\[[RX]\] )?)(%s)\1' % '|'.join(re.escape(k) for k in sorted(groups, key=len, reverse=True)))
        x, y = _block_span(new_src, 'Destinations')
        lst = re.compile(r'"Stations": \[[^\]]*\]')                 # only a destination's list of stations, not its other text
        body = lst.sub(lambda m: pat.sub(lambda q: q.group(1) + q.group(2) + groups[q.group(3)] + q.group(1), m.group(0)), new_src[x:y])
        new_src = new_src[:x] + body + new_src[y:]
        expect['Destinations'] = {c: {k: ({**v, 'Stations': _rewrite(v['Stations'], groups)} if isinstance(v, dict) and 'Stations' in v else v) for k, v in d.items()}
                                  for c, d in expect['Destinations'].items()}
    ns2: dict = {'__name__': 'map_data'}
    exec(compile(new_src, path, 'exec'), ns2)
    def same(n):
        a, b = expect.get(n), ns2.get(n)
        if n == 'Destinations':                       # the list of a destination's stations is kept sorted
            fix = lambda d: {k: ({**v, 'Stations': sorted(v['Stations'])} if isinstance(v, dict) and 'Stations' in v else v) for k, v in d.items()}
            a, b = {c: fix(d) for c, d in a.items()}, {c: fix(d) for c, d in b.items()}
        return _norm(a) == _norm(b)
    for n in NAMES:
        if n != 'Stations' and not same(n):
            raise ValueError(f"'{n}' would change; nothing written")
    import sys
    if config.ROOT not in sys.path:
        sys.path.insert(0, config.ROOT)
    from core.station_resolver import normalize_stations
    normalize_stations(ns2['Stations'])
    changed = sorted(k for k in set(raw) | set(ns['Stations']) if _norm(raw.get(k)) != _norm(ns['Stations'].get(k)))
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(backup_dir, 'map_data.backup.py')
    shutil.copyfile(path, backup)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        f.write(new_src)
    os.replace(tmp, path)
    forget_stations(path)
    return {'backup': backup, 'changed': changed, 'when': time.strftime('%Y-%m-%dT%H:%M:%S')}


# ── editing Segments / Lines (stop lists) ────────────────────────────────────────────────────────
# Only the entries that changed are rewritten, in place, in the formatter's layout; afterwards the whole file is re-loaded and every
# block is compared with what was intended.

def _seg_text(key: str, content: dict) -> str:
    return f'    "{key}": {{\n' + ''.join(f'        "{k}": {content[k]!r},\n' for k in sorted(content)) + '    },\n'


def _entry_range(lines: list[str], start: int, stop: int, header: str, indent: int):
    """[first, end) of the entry `header` (text after the indent) between lines start..stop, or None."""
    pre = ' ' * indent + header
    i = next((i for i in range(start, stop) if lines[i].startswith(pre)), None)
    if i is None: return None
    if lines[i].rstrip().endswith('},') and not lines[i].rstrip().endswith('{'): return i, i + 1
    close = ' ' * indent + '}'
    return i, next(j for j in range(i + 1, stop) if lines[j].startswith(close) and not lines[j].startswith(close + ' ')) + 1


def edit_wiring(path: str, mutate, backup_dir: str = config.CACHE_DIR) -> dict:
    """mutate(segments, lines, namespace) edits copies of Segments / Lines -> written to map_data.py. Raises ValueError (nothing written)."""
    with open(path, encoding='utf-8') as f: src = f.read()
    ns = load_namespace(path)
    segs, lns = copy.deepcopy(ns['Segments']), copy.deepcopy(ns['Lines'])
    mutate(segs, lns, ns)
    out = src.split('\n')
    def block(name):            # [first entry line, closing line) of a top-level block, in the current text
        i = next(i for i, l in enumerate(out) if l == f'{name} = {{') + 1
        return i, next(j for j in range(i, len(out)) if out[j].startswith('}'))
    old = ns['Segments']
    for k in [k for k in old if k not in segs] + [k for k in old if k in segs and _norm(old[k]) != _norm(segs[k])]:
        r = _entry_range(out, *block('Segments'), f'"{k}": {{', 4)
        out[r[0]:r[1]] = _seg_text(k, segs[k]).rstrip('\n').split('\n') if k in segs else []
    for k in sorted(k for k in segs if k not in old):
        x, y = block('Segments')
        at = next((i for i in range(x, y) if out[i].startswith('    "') and '": {' in out[i] and out[i][5:out[i].index('": {')] > k), y)
        out[at:at] = _seg_text(k, segs[k]).rstrip('\n').split('\n')
    for op, ls in ns['Lines'].items():
        for ln, cats in ls.items():
            for cat, pats in cats.items():
                for pn, pd in pats.items():
                    if _norm(pd) == _norm(lns[op][ln][cat][pn]): continue
                    r = _entry_range(out, *block('Lines'), f'"{op}": {{', 4); r = _entry_range(out, r[0] + 1, r[1], f'"{ln}": {{', 8)
                    r = _entry_range(out, r[0] + 1, r[1], f'"{cat}": {{', 12); r = _entry_range(out, r[0] + 1, r[1], f'"{pn}": ', 16)
                    out[r[0]] = f'                "{pn}": {lns[op][ln][cat][pn]!r},'
    new_src = '\n'.join(out)
    ns2: dict = {'__name__': 'map_data'}
    exec(compile(new_src, path, 'exec'), ns2)
    expect = {n: ns.get(n) for n in NAMES}; expect['Segments'], expect['Lines'] = segs, lns
    for n in NAMES:
        if _norm(expect.get(n)) != _norm(ns2.get(n)): raise ValueError(f"'{n}' would not come out as intended; nothing written")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(backup_dir, 'map_data.backup.py'); shutil.copyfile(path, backup)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f: f.write(new_src)
    os.replace(tmp, path); forget_stations(path)
    return {'backup': backup, 'when': time.strftime('%Y-%m-%dT%H:%M:%S')}


def _pt(c): return (round(float(c[0]), 5), round(float(c[1]), 5))


def create_station(path: str, name: str, location, region=None, span=None, **attrs) -> dict:
    name = (name or '').strip()
    def go(raw, ns):
        if not name or '{' in name or '}' in name: raise ValueError("a station needs a name without braces")
        if name in raw or name in ns.get('Nodes', {}): raise ValueError(f"'{name}' already exists")
        st = {'Location': _pt(location)}
        if span: st['Span'] = [_pt(span[0]), _pt(span[1])]
        if region: st['Region'] = list(region)
        for k in ('Label', 'Major', 'Type'):
            if attrs.get(k) not in (None, '', False): st[k] = attrs[k]
        raw[name] = st
    return edit_stations(path, go)


def set_station(path: str, name: str, fields: dict) -> dict:
    """Station-level fields: Label / Major / Type / Region (None or '' removes one) and Location / Span (the default platform)."""
    def go(raw, ns):
        if name not in raw: raise ValueError(f"unknown station '{name}'")
        st = raw[name]
        for k, v in fields.items():
            if k in ('Location', 'Span') and st.get('Platforms'): raise ValueError("a station with platforms has no location of its own")
            if k == 'Location': st['Location'] = _pt(v)
            elif k == 'Span':
                if v: st['Span'] = [_pt(v[0]), _pt(v[1])]
                else: st.pop('Span', None)
            elif k in ('Label', 'Major', 'Type', 'Region'):
                if v in (None, '', False): st.pop(k, None)
                else: st[k] = list(v) if k == 'Region' else v
            else: raise ValueError(f"cannot set '{k}'")
    return edit_stations(path, go)


def add_platform(path: str, station: str, platform: str | None, location, span=None, first: str = 'Main', **attrs) -> dict:
    """A named platform ('Station {name}'). platform None moves a single-platform station's own Location / Span. Adding a platform to a
    single-platform station turns that station into one with platforms: its old stopping place becomes the platform `first`
    (Station -> Station {first}, rewritten in Segments / Lines) and it keeps no location of its own."""
    def go(raw, ns):
        if station not in raw: raise ValueError(f"unknown station '{station}'")
        st = raw[station]
        if platform is None:
            if st.get('Platforms'): raise ValueError(f"'{station}' has platforms; name the platform")
            st['Location'] = _pt(location)
            if span: st['Span'] = [_pt(span[0]), _pt(span[1])]
            else: st.pop('Span', None)
            return
        if '{' in platform or '}' in platform or not platform.strip(): raise ValueError("a platform needs a name without braces")
        platform_ = platform.strip()
        renames = {}
        if 'Location' in st:                          # single-platform station -> station with platforms
            first_ = (first or 'Main').strip()
            if first_ == platform_: raise ValueError(f"'{station}' already has a platform '{platform_}'")
            old = {k: st.pop(k) for k in ('Location', 'Span', 'Type', 'Major') if k in st}
            st['Platforms'] = {first_: {k: v for k, v in old.items()}}
            for k in ('Type', 'Major'):
                if k in old: st[k] = old[k]           # the station keeps its attributes; the platform needs no copy
                st['Platforms'][first_].pop(k, None)
            renames = {station: f"{station} {{{first_}}}"}
        if platform_ in st['Platforms']: raise ValueError(f"'{station}' already has a platform '{platform_}'")
        spec = {'Location': _pt(location)}
        if span: spec['Span'] = [_pt(span[0]), _pt(span[1])]
        for k in ('Major', 'Type'):
            if k in attrs and attrs[k] is not False: spec[k] = attrs[k]
        st['Platforms'][platform_] = spec
        return renames
    return edit_stations(path, go)


def set_platform(path: str, station: str, platform: str | None, fields: dict) -> dict:
    def go(raw, ns):
        if station not in raw: raise ValueError(f"unknown station '{station}'")
        st = raw[station]
        spec = st if platform is None else (st.get('Platforms') or {}).get(platform)
        if spec is None: raise ValueError(f"'{station}' has no platform '{platform}'")
        if not isinstance(spec, dict): spec = {'Location': spec}; st['Platforms'][platform] = spec
        for k, v in fields.items():
            if k == 'Location': spec['Location'] = _pt(v)
            elif k == 'Span':
                if v: spec['Span'] = [_pt(v[0]), _pt(v[1])]
                else: spec.pop('Span', None)
            elif k == 'Label' and platform is not None:
                if v in (None, ''): spec.pop(k, None)           # the station's label
                else: spec[k] = v
            elif k in ('Major', 'Type') and platform is not None:
                if v is False: spec.pop(k, None)           # same as the station
                else: spec[k] = v                           # None = the station's value does not apply here
            else: raise ValueError(f"cannot set '{k}'")
    return edit_stations(path, go)


def delete_platform(path: str, station: str, platform: str | None) -> dict:
    """Remove a named platform, or the whole station (platform None). Refused while a line still stops there."""
    def go(raw, ns):
        if station not in raw: raise ValueError(f"unknown station '{station}'")
        st = raw[station]
        if platform is None:
            keys = ([station] if 'Location' in st else []) + [f"{station} {{{p}}}" for p in (st.get('Platforms') or {})]
        else:
            if platform not in (st.get('Platforms') or {}): raise ValueError(f"'{station}' has no platform '{platform}'")
            keys = [f"{station} {{{platform}}}"]
        used = [(k, r) for k in keys for r in _refs(ns, k)]
        if used: raise ValueError(f"still used by: " + '; '.join(f"{k} in {r}" for k, r in used[:5]) + (' …' if len(used) > 5 else ''))
        if platform is None: del raw[station]
        else:
            del st['Platforms'][platform]
            if not st['Platforms']: del raw[station]          # a station is its platforms
    return edit_stations(path, go)


# ── renaming and merging ─────────────────────────────────────────────────────────────────────────

def _check_name(raw: dict, ns: dict, name: str, what: str = 'station'):
    if not name or '{' in name or '}' in name: raise ValueError(f"a {what} needs a name without braces")
    if name in raw or name in ns.get('Nodes', {}): raise ValueError(f"'{name}' already exists")


def _platform_keys(st: dict, name: str) -> dict:
    return {f"{name} {{{p}}}": p for p in (st.get('Platforms') or {})}


def rename_station(path: str, old: str, new: str) -> dict:
    """Station -> new name; every stop (and the Destinations that list it) follows. A platform's key is "Station {platform}"."""
    new = (new or '').strip()
    def go(raw, ns):
        if old not in raw: raise ValueError(f"unknown station '{old}'")
        _check_name(raw, ns, new)
        st = raw.pop(old); raw[new] = st
        stops = {old: new} if 'Location' in st else {k: f"{new} {{{p}}}" for k, p in _platform_keys(st, old).items()}
        if 'Label' not in st and re.search(r'\s*\[[^\]]*\]', old) and not re.search(r'\s*\[[^\]]*\]', new): st['Label'] = re.sub(r'\s*\[[^\]]*\]', '', old)
        return stops, {old: new}                          # a "[Disambiguator]" in the name was the label: keep showing it
    return edit_stations(path, go)


def rename_platform(path: str, station: str, old: str, new: str) -> dict:
    new = (new or '').strip()
    def go(raw, ns):
        st = raw.get(station)
        if not st or old not in (st.get('Platforms') or {}): raise ValueError(f"'{station}' has no platform '{old}'")
        if not new or '{' in new or '}' in new: raise ValueError("a platform needs a name without braces")
        if new in st['Platforms']: raise ValueError(f"'{station}' already has a platform '{new}'")
        st['Platforms'] = {(new if k == old else k): v for k, v in st['Platforms'].items()}
        return {f"{station} {{{old}}}": f"{station} {{{new}}}"}
    return edit_stations(path, go)


def merge_platform(path: str, station: str, src: str, dst: str) -> dict:
    """Two platforms of one station that are really one: src goes, every stop at it becomes a stop at dst."""
    def go(raw, ns):
        st = raw.get(station); pl = (st or {}).get('Platforms') or {}
        if src not in pl or dst not in pl or src == dst: raise ValueError(f"'{station}' needs two different platforms")
        del pl[src]
        return {f"{station} {{{src}}}": f"{station} {{{dst}}}"}
    return edit_stations(path, go)


def merge_station(path: str, src: str, dst: str, platform: str | None = None, first: str = 'Main') -> dict:
    """Station src is really part of station dst: its platforms move over (a single-platform src becomes the platform `platform`),
    every stop and destination follows, and src is gone."""
    def go(raw, ns):
        if src not in raw or dst not in raw or src == dst: raise ValueError("choose two different stations")
        a, b = raw[src], raw[dst]
        stops, moved = {}, {}
        if 'Location' in b:                              # dst gains its first named platform
            first_ = (first or 'Main').strip(); old = {k: b.pop(k) for k in ('Location', 'Span') if k in b}
            b['Platforms'] = {first_: old}; stops[dst] = f"{dst} {{{first_}}}"
        if 'Location' in a:
            name = (platform or '').strip()
            if not name or '{' in name or '}' in name: raise ValueError("name the platform src becomes")
            spec = {k: a[k] for k in ('Location', 'Span', 'Label', 'Major', 'Type') if k in a}
            moved[name] = spec; stops[src] = f"{dst} {{{name}}}"
        else:
            for k, p in _platform_keys(a, src).items():
                moved[p] = a['Platforms'][p]; stops[k] = f"{dst} {{{p}}}"
        for n, spec in moved.items():
            if n in b['Platforms']: raise ValueError(f"'{dst}' already has a platform '{n}'")
            b['Platforms'][n] = spec
        del raw[src]
        return stops, {src: dst}
    return edit_stations(path, go)