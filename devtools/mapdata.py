"""Reads the detailed map and writes station and route edits back into it, checking nothing else changed"""
from __future__ import annotations
import copy, os, re, time

from . import config
from core.datafile import (NAMES, exec_source, load_namespace, load_namespace_cached, forget_namespace, norm as _norm,
                           fmt_stations, fmt_segment as _seg_text, fmt_lines, fmt_modes)
from core.fileio import FileCache, write_with_backup
from core.station_resolver import normalize_stations, plain_name
from core.station_usage import compute_station_usage

_LOC = re.compile(r"""(["']Location["']\s*:\s*)[\(\[]\s*-?[\d.]+\s*,\s*-?[\d.]+\s*[\)\]]""")

def locate(raw_stations: dict, flat_key: str):
    """Normalised station key -> (raw key, platform name | None)."""
    if flat_key in raw_stations and isinstance(raw_stations[flat_key], dict) and 'Location' in raw_stations[flat_key]: return flat_key, None
    for name, data in raw_stations.items():
        if isinstance(data, dict):
            for plat in data.get('Platforms') or {}:
                if f"{name} {{{plat}}}" == flat_key: return name, plat

    return None

def _key_re(k: str):
    return re.compile(r"""^(\s*)(["'])""" + re.escape(k) + r"""\2\s*:\s*\{""")

def _replace(lines: list[str], raw_key: str, plat: str | None, lat: float, lon: float) -> None:
    """Rewrites one coordinate tuple (a station's Location or one platform's)"""
    s0 = next(i for i, l in enumerate(lines) if re.match(r'^\s*Stations\s*=\s*\{', l))
    e0 = next((i for i in range(s0 + 1, len(lines)) if lines[i].startswith('}')), len(lines))
    i = next((i for i in range(s0 + 1, e0) if _key_re(raw_key).match(lines[i])), None)
    if i is None: raise ValueError(f"station '{raw_key}' not found in the Stations block")
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

    if not m: raise ValueError(f"no coordinates found for '{raw_key}'" + (f" / platform '{plat}'" if plat else ''))
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
        if not loc: raise ValueError(f"unknown station '{key}'")
        rk, plat = loc
        _replace(lines, rk, plat, float(lat), float(lon))
        if plat is None:
            expected[rk]['Location'] = (round(float(lat), 5), round(float(lon), 5))
        else:
            spec, pt = expected[rk]['Platforms'], (round(float(lat), 5), round(float(lon), 5))
            if isinstance(spec[plat], dict): spec[plat]['Location'] = pt
            else: spec[plat] = pt

    new_src = '\n'.join(lines)

    ns2 = exec_source(new_src, path)

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
        if n != 'Stations' and _norm(ns.get(n)) != _norm(ns2.get(n)): raise ValueError(f"'{n}' would change; nothing written")

    backup = write_with_backup(path, new_src, backup_dir, 'detailed_map.backup.py')
    forget_stations(path)
    return {'moved': len(moves), 'backup': backup, 'when': time.strftime('%Y-%m-%dT%H:%M:%S')}

def _read_stations(path: str):
    raw = load_namespace(path)['Stations']
    flat = normalize_stations(raw)
    spans = {}
    for name, d in raw.items():
        if d.get('Span'): spans[name] = tuple(tuple(c) for c in d['Span'])
        for p, spec in (d.get('Platforms') or {}).items():
            if isinstance(spec, dict) and spec.get('Span'): spans[f"{name} {{{p}}}"] = tuple(tuple(c) for c in spec['Span'])

    return {k: (float(v['Location'][0]), float(v['Location'][1])) for k, v in flat.items()}, spans

def _read_usage(path: str) -> dict:
    ns = load_namespace(path)
    return {k: sorted(v) for k, v in compute_station_usage(ns['Lines'], ns['Segments']).items()}

_STATIONS, _USAGE = FileCache(_read_stations), FileCache(_read_usage)       # re-read when the file changes

def _stations_cached(path: str | None):
    path = path or config.DETAILED_FILE
    return _STATIONS.get(path) if os.path.exists(path) else ({}, {})

def station_locations(path: str | None = None) -> dict[str, tuple[float, float]]:
    """Every stopping place in map_data.py ("Station" and "Station {platform}") -> (lat, lon). Re-read when the file changes."""
    return _stations_cached(path)[0]

def station_spans(path: str | None = None) -> dict[str, tuple]:
    """Stopping place -> its platform span ((lat, lon), (lat, lon)): the stretch of rail it covers. Only those that have one."""
    return _stations_cached(path)[1]

def station_usage(path: str | None = None) -> dict[str, list[str]]:
    """Stopping place -> ['Present', 'Fantasy'] subset from the patterns using it, cached until the file changes"""
    path = path or config.DETAILED_FILE
    return _USAGE.get(path) if os.path.exists(path) else {}

def forget_stations(path: str | None = None) -> None:
    path = path or config.DETAILED_FILE
    _STATIONS.forget(path); _USAGE.forget(path); forget_namespace(path)

# Editing stations and platforms: the Stations block is regenerated, every other block checked unchanged

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
    """Applies mutate(raw Stations, namespace) and writes the result; returned renames are applied to stops and destinations"""
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
        lst = re.compile(r'"(?:Future)?Stations": \[[^\]]*\]')                 # only a destination's list of stations, not its other text
        body = lst.sub(lambda m: pat.sub(lambda q: q.group(1) + q.group(2) + groups[q.group(3)] + q.group(1), m.group(0)), new_src[x:y])
        new_src = new_src[:x] + body + new_src[y:]
        expect['Destinations'] = {c: {k: ({**v, **{lk: _rewrite(v[lk], groups) for lk in DEST_LISTS if lk in v}} if isinstance(v, dict) else v) for k, v in d.items()}
                                  for c, d in expect['Destinations'].items()}

    ns2 = exec_source(new_src, path)
    def same(n):
        a, b = expect.get(n), ns2.get(n)
        if n == 'Destinations':                       # the list of a destination's stations is kept sorted
            fix = lambda d: {k: ({**v, **{lk: sorted(v[lk]) for lk in DEST_LISTS if lk in v}} if isinstance(v, dict) else v) for k, v in d.items()}
            a, b = {c: fix(d) for c, d in a.items()}, {c: fix(d) for c, d in b.items()}

        return _norm(a) == _norm(b)

    for n in NAMES:
        if n != 'Stations' and not same(n): raise ValueError(f"'{n}' would change; nothing written")

    normalize_stations(ns2['Stations'])
    changed = sorted(k for k in set(raw) | set(ns['Stations']) if _norm(raw.get(k)) != _norm(ns['Stations'].get(k)))
    backup = write_with_backup(path, new_src, backup_dir, 'detailed_map.backup.py')
    forget_stations(path)
    return {'backup': backup, 'changed': changed, 'when': time.strftime('%Y-%m-%dT%H:%M:%S')}

def _line_paths(lines: dict) -> set:
    return {(op, ln, cat, pn) for op, ls in lines.items() for ln, cs in ls.items() for cat, ps in cs.items() for pn in ps} | \
           {(op, ln, cat) for op, ls in lines.items() for ln, cs in ls.items() for cat in cs} | {(op, ln) for op, ls in lines.items() for ln in ls} | {(op,) for op in lines}

def ensure_detailed_map(path: str | None = None, modes: dict | None = None) -> str:
    """data/detailed_map.py, created empty (Modes copied from modes) when it does not exist"""
    path = path or config.DETAILED_FILE
    if not os.path.exists(path):
        modes = modes or {'Heavy Rail': {'Color': '#475569', 'Priority': 1}}
        out = fmt_modes(modes) + "\n"
        out += "Nodes = {\n}\n\nStations = {\n}\n\nSegments = {\n}\n\nLines = {\n}\n\nDestinations = {\n}\n\nProjects = {\n}"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='') as f: f.write(out)

    return path

# Editing Segments / Lines: only changed entries are rewritten, then the whole file is checked

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

    same_routes = _line_paths(lns) == _line_paths(ns['Lines'])
    for op, ls in (ns['Lines'].items() if same_routes else []):
        for ln, cats in ls.items():
            for cat, pats in cats.items():
                for pn, pd in pats.items():
                    if _norm(pd) == _norm(lns[op][ln][cat][pn]): continue
                    r = _entry_range(out, *block('Lines'), f'"{op}": {{', 4); r = _entry_range(out, r[0] + 1, r[1], f'"{ln}": {{', 8)
                    r = _entry_range(out, r[0] + 1, r[1], f'"{cat}": {{', 12); r = _entry_range(out, r[0] + 1, r[1], f'"{pn}": ', 16)
                    out[r[0]] = f'                "{pn}": {lns[op][ln][cat][pn]!r},'

    if _line_paths(lns) != _line_paths(ns['Lines']):        # routes were added or removed: the Lines block is written afresh
        x, y = block('Lines'); out[x - 1:y + 1] = fmt_lines(lns).rstrip('\n').split('\n')

    new_src = '\n'.join(out)
    ns2 = exec_source(new_src, path)
    expect = {n: ns.get(n) for n in NAMES}; expect['Segments'], expect['Lines'] = segs, lns
    for n in NAMES:
        if _norm(expect.get(n)) != _norm(ns2.get(n)): raise ValueError(f"'{n}' would not come out as intended; nothing written")

    backup = write_with_backup(path, new_src, backup_dir, 'detailed_map.backup.py')
    forget_stations(path)
    return {'backup': backup, 'when': time.strftime('%Y-%m-%dT%H:%M:%S')}

def _pt(c): return (round(float(c[0]), 5), round(float(c[1]), 5))

def _free_name(raw: dict, ns: dict, name: str) -> str:
    """A free station key: a repeated name gets a hidden ' [2]', ' [3]' ... tag"""
    taken = lambda n: n in raw or n in ns.get('Nodes', {})
    if not taken(name): return name
    base, n = plain_name(name) or name, 2
    while taken(f"{base} [{n}]"): n += 1
    return f"{base} [{n}]"

def _ap(v):
    """The tracer's airport value ('Airport' / True) -> what is written in the map data: 'True'; anything else -> None."""
    return 'True' if v is True or str(v).strip().lower() in ('airport', 'true') else None

def create_station(path: str, name: str, location, region=None, span=None, **attrs) -> dict:
    name = (name or '').strip(); final = {}
    def go(raw, ns):
        if not name or '{' in name or '}' in name: raise ValueError("a station needs a name without braces")
        final['name'] = key = _free_name(raw, ns, name)
        st = {'Location': _pt(location)}
        if span: st['Span'] = [_pt(span[0]), _pt(span[1])]
        if region: st['Region'] = list(region)
        for k in ('Label', 'Major'):
            if attrs.get(k) not in (None, '', False): st[k] = attrs[k]

        if _ap(attrs.get('Type')) or _ap(attrs.get('Airport')): st['Airport'] = 'True'
        raw[key] = st

    out = edit_stations(path, go); out['name'] = final['name']
    return out

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
            elif k in ('Type', 'Airport'):                       # a checkbox: 'Airport': 'True', or nothing
                st.pop('Type', None)
                if _ap(v): st['Airport'] = 'True'
                else: st.pop('Airport', None)
            elif k in ('Label', 'Major', 'Region'):
                if v in (None, '', False): st.pop(k, None)
                else: st[k] = list(v) if k == 'Region' else v
            else: raise ValueError(f"cannot set '{k}'")

    return edit_stations(path, go)

def _free_platform(pl: dict, name: str) -> str:
    """A free platform name: a repeated one gets a hidden ' [2]' tag"""
    base, n = plain_name(name) or name, 2
    while f"{base} [{n}]" in pl: n += 1
    return f"{base} [{n}]"

def add_platform(path: str, station: str, platform: str | None, location, span=None, first: str = 'Main', twin: bool = False, **attrs) -> dict:
    """Adds a named platform; platform None moves a single-platform station's own Location / Span"""
    final: dict = {}
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
        if twin and platform_ in (st.get('Platforms') or {}): platform_ = _free_platform(st['Platforms'], platform_)
        final['platform'] = platform_
        renames = {}
        if 'Location' in st:                          # single-platform station -> station with platforms
            first_ = (first or 'Main').strip()
            if first_ == platform_: raise ValueError(f"'{station}' already has a platform '{platform_}'")
            old = {k: st.pop(k) for k in ('Location', 'Span', 'Type', 'Airport', 'Major') if k in st}
            st['Platforms'] = {first_: {k: v for k, v in old.items()}}
            for k in ('Type', 'Airport', 'Major'):
                if k in old: st[k] = old[k]           # the station keeps its attributes; the platform needs no copy
                st['Platforms'][first_].pop(k, None)

            renames = {station: f"{station} {{{first_}}}"}

        if platform_ in st['Platforms']: raise ValueError(f"'{station}' already has a platform '{platform_}'")
        spec = {'Location': _pt(location)}
        if span: spec['Span'] = [_pt(span[0]), _pt(span[1])]
        if attrs.get('Major') not in (None, False): spec['Major'] = attrs['Major']
        if _ap(attrs.get('Type')) or _ap(attrs.get('Airport')): spec['Airport'] = 'True'
        st['Platforms'][platform_] = spec
        return renames

    out = edit_stations(path, go); out['platform'] = final.get('platform', platform)
    return out

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
            elif k in ('Type', 'Airport') and platform is not None:
                spec.pop('Type', None)
                if v is False: spec.pop('Airport', None)       # same as the station
                elif _ap(v): spec['Airport'] = 'True'
                else: spec['Airport'] = None                    # None = the station is an airport but this platform is not
            elif k == 'Major' and platform is not None:
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

# Renaming and merging

def _check_name(raw: dict, ns: dict, name: str, what: str = 'station'):
    if not name or '{' in name or '}' in name: raise ValueError(f"a {what} needs a name without braces")
    if name in raw or name in ns.get('Nodes', {}): raise ValueError(f"'{name}' already exists")

def _platform_keys(st: dict, name: str) -> dict:
    return {f"{name} {{{p}}}": p for p in (st.get('Platforms') or {})}

def rename_station(path: str, old: str, new: str) -> dict:
    """Station -> new name; every stop (and the Destinations that list it) follows. A platform's key is "Station {platform}"."""
    new = (new or '').strip(); final = {}
    def go(raw, ns):
        nonlocal new
        if old not in raw: raise ValueError(f"unknown station '{old}'")
        if not new or '{' in new or '}' in new: raise ValueError("a station needs a name without braces")
        if new == old: raise ValueError("that is already its name")
        new = _free_name({k: v for k, v in raw.items() if k != old}, ns, new); final['name'] = new
        st = raw.pop(old); raw[new] = st
        stops = {old: new} if 'Location' in st else {k: f"{new} {{{p}}}" for k, p in _platform_keys(st, old).items()}
        if 'Label' not in st and re.search(r'\s*\[[^\]]*\]', old) and not re.search(r'\s*\[[^\]]*\]', new): st['Label'] = re.sub(r'\s*\[[^\]]*\]', '', old)
        return stops, {old: new}                          # a "[Disambiguator]" in the name was the label: keep showing it

    out = edit_stations(path, go); out['name'] = final['name']
    return out

def rename_platform(path: str, station: str, old: str, new: str, twin: bool = False) -> dict:
    new = (new or '').strip(); final: dict = {}
    def go(raw, ns):
        nonlocal new
        st = raw.get(station)
        if not st or old not in (st.get('Platforms') or {}): raise ValueError(f"'{station}' has no platform '{old}'")
        if not new or '{' in new or '}' in new: raise ValueError("a platform needs a name without braces")
        if new == old: raise ValueError("that is already its name")
        if new in st['Platforms']:
            if not twin: raise ValueError(f"'{station}' already has a platform '{new}'")
            new = _free_platform(st['Platforms'], new)

        final['platform'] = new
        st['Platforms'] = {(new if k == old else k): v for k, v in st['Platforms'].items()}
        return {f"{station} {{{old}}}": f"{station} {{{new}}}"}

    out = edit_stations(path, go); out['platform'] = final['platform']
    return out

def merge_platform(path: str, station: str, src: str, dst: str) -> dict:
    """Two platforms of one station that are really one: src goes, every stop at it becomes a stop at dst."""
    def go(raw, ns):
        st = raw.get(station); pl = (st or {}).get('Platforms') or {}
        if src not in pl or dst not in pl or src == dst: raise ValueError(f"'{station}' needs two different platforms")
        del pl[src]
        return {f"{station} {{{src}}}": f"{station} {{{dst}}}"}

    return edit_stations(path, go)

def merge_station(path: str, src: str, dst: str, platform: str | None = None, first: str = 'Main') -> dict:
    """Merges station src into dst: its platforms, stops and destinations move over"""
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
            spec = {k: a[k] for k in ('Location', 'Span', 'Label', 'Major', 'Type', 'Airport') if k in a}
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

# Destinations of the detailed map: only its own serving stations and Exists setting per venue
DEST_LISTS = ('Stations', 'FutureStations')      # the stations serving a destination on the Present map / on the Future map

def _fmt_destinations(d: dict) -> str:
    out = ["Destinations = {\n"]
    for cat in sorted(d):
        if not d[cat]: continue
        out.append(f"    {cat!r}: {{\n")
        for name in sorted(d[cat]):
            v = d[cat][name]; parts = []
            for lk in DEST_LISTS:
                if lk in v: parts.append(f'"{lk}": {sorted(v[lk])!r}')

            if 'Exists' in v: parts.append(f'"Exists": {list(v["Exists"])!r}')
            out.append(f"        {name!r}: {{{', '.join(parts)}}},\n")

        out.append("    },\n")

    out.append("}\n")
    return ''.join(out)

def edit_destinations(path: str, mutate, backup_dir: str = config.CACHE_DIR) -> dict:
    """Apply mutate(destinations dict, namespace) to the Destinations block of the detailed map. Everything else in the file is checked to be unchanged."""
    with open(path, encoding='utf-8') as f: src = f.read()
    ns = load_namespace_cached(path); dest = copy.deepcopy(ns.get('Destinations') or {})
    mutate(dest, ns)
    dest = {c: {n: {k: (sorted(x) if k in DEST_LISTS else x) for k, x in v.items()} for n, v in d.items() if v} for c, d in dest.items()}
    dest = {c: d for c, d in dest.items() if d}
    m = re.search(r'^Destinations = \{\n', src, re.M)
    if not m: raise ValueError("the detailed map has no Destinations block")
    x, y = _block_span(src, 'Destinations')
    new_src = src[:m.start()] + _fmt_destinations(dest) + src[y + 1:].removeprefix('\n')
    block = _fmt_destinations(dest)                       # only the Destinations block is new text: run just that and check it; the rest of the file is untouched
    got = exec_source(block, path)
    if _norm(got.get('Destinations')) != _norm(dest): raise ValueError("the destinations did not come out as intended; nothing written")
    write_with_backup(path, new_src, backup_dir, 'detailed_map.backup.py')
    forget_stations(path)
    return {'when': time.strftime('%Y-%m-%dT%H:%M:%S')}

def exists_setting(d: dict) -> str:
    """'present' | 'future' | 'both' | 'none': what a destination's Exists says (a list of 'Present' / 'Fantasy', or the older Present / Fantasy flags)."""
    ex = d.get('Exists')
    p, f = (('Present' in ex, 'Fantasy' in ex) if isinstance(ex, (list, tuple, set)) else (bool(d.get('Present')), bool(d.get('Fantasy'))))
    return 'both' if p and f else 'present' if p else 'future' if f else 'none'

EXISTS_OF = {'present': ['Present'], 'future': ['Fantasy'], 'both': ['Present', 'Fantasy']}

# Editing the simplified map's destinations in place, entry by entry, keeping its hand-kept layout
def _offsets(src: str):
    lines = src.split('\n'); starts, n = [], 0
    for l in lines: starts.append(n); n += len(l) + 1
    def pos(lineno: int, col: int) -> int:                       # the parser counts columns in bytes
        return starts[lineno - 1] + len(lines[lineno - 1].encode('utf-8')[:col].decode('utf-8', 'ignore'))

    return pos

def _dest_dict(src: str):
    import ast
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'Destinations' for t in node.targets) and isinstance(node.value, ast.Dict):
            return node.value

    raise ValueError("the simplified map has no Destinations block")

def _pair(d, name: str):
    """(key node, value node) of a literal string key in a dict node, or None."""
    for k, v in zip(d.keys, d.values):
        if k is not None and getattr(k, 'value', None) == name and isinstance(getattr(k, 'value', None), str): return k, v

    return None

def _after_comma(src: str, i: int) -> int:
    j = i
    while j < len(src) and src[j] in ' \t': j += 1
    return j + 1 if j < len(src) and src[j] == ',' else i

def _indent_of(src: str, i: int) -> str:
    s = src.rfind('\n', 0, i) + 1; k = s
    while k < len(src) and src[k] in ' \t': k += 1
    return src[s:k]

def _insert_pair(src: str, d, pair_text: str) -> str:
    """Add `pair_text` (a 'key: value' entry, no comma) as the last entry of the dict node d, laid out like its neighbours."""
    pos = _offsets(src)
    if d.keys:
        lv = d.values[-1]; end = pos(lv.end_lineno, lv.end_col_offset); ind = _indent_of(src, pos(d.keys[0].lineno, d.keys[0].col_offset))
        multi = d.keys[0].lineno != lv.end_lineno or d.lineno != d.end_lineno
        if multi:
            e2 = _after_comma(src, end)
            return src[:end] + ('' if e2 != end else ',') + src[end:e2] + '\n' + ind + pair_text + ',' + src[e2:]

        return src[:end] + ', ' + pair_text + src[end:]

    a, b = pos(d.lineno, d.col_offset), pos(d.end_lineno, d.end_col_offset)
    base = _indent_of(src, a)
    return src[:a] + '{\n' + base + '    ' + pair_text + ',\n' + base + '}' + src[b:]

def _cut_pair(src: str, k, v) -> str:
    pos = _offsets(src); a, b = pos(k.lineno, k.col_offset), pos(v.end_lineno, v.end_col_offset); b = _after_comma(src, b)
    ls = src.rfind('\n', 0, a) + 1; le = src.find('\n', b); le = len(src) if le < 0 else le
    if not src[ls:a].strip() and not src[b:le].strip(): return src[:ls] + src[le + 1:]          # the entry had its own line(s): the lines go
    return src[:a] + src[b:].lstrip(' \t')

def _set_field(src: str, v, field: str, text: str) -> str:
    """Set one field of an entry's dict node to the source text `text` (replacing its value, or adding the field)."""
    pos = _offsets(src); p = _pair(v, field)
    if p: return src[:pos(p[1].lineno, p[1].col_offset)] + text + src[pos(p[1].end_lineno, p[1].end_col_offset):]
    return _insert_pair(src, v, f'{field!r}: {text}')

def edit_simple_destinations(path: str, op, expect, backup_dir: str = config.CACHE_DIR) -> dict:
    """op(src) -> new source text; expect(destinations dict) changes a copy into what the file must then say. Raises ValueError (nothing written)."""
    with open(path, encoding='utf-8', newline='') as f: src = f.read()
    ns = load_namespace(path); want = copy.deepcopy(ns.get('Destinations') or {}); expect(want)
    new_src = op(src)
    ns2 = exec_source(new_src, path)
    if _norm(ns2.get('Destinations')) != _norm(want): raise ValueError("the destinations would not come out as intended; nothing written")
    for n in NAMES:
        if n != 'Destinations' and _norm(ns.get(n)) != _norm(ns2.get(n)): raise ValueError(f"'{n}' would change; nothing written")

    write_with_backup(path, new_src, backup_dir, 'map_data.backup.py')
    forget_namespace(path)
    return {'when': time.strftime('%Y-%m-%dT%H:%M:%S')}

def _entry(src: str, cat: str, name: str):
    D = _dest_dict(src); c = _pair(D, cat)
    if not c: raise ValueError(f"no destination category '{cat}'")
    e = _pair(c[1], name)
    if not e: raise ValueError(f"no destination '{name}' in {cat}")
    return D, c, e

def _where(simple: dict, name: str):
    return next((c for c, d in simple.items() if name in d), None)

def _new_entry_text(name: str, location, exists: list) -> str:
    return f"{name!r}: {{'Location': ({float(location[0]):.5f}, {float(location[1]):.5f}), 'Exists': {list(exists)!r}}}"

def create_simple_destination(path: str, cat: str, name: str, location, exists: list) -> dict:
    name = (name or '').strip()
    if not name or '\n' in name: raise ValueError("a destination needs a name")
    ns = load_namespace(path); simple = ns.get('Destinations') or {}
    if _where(simple, name): raise ValueError(f"there is already a destination called '{name}'")
    if cat not in simple: raise ValueError(f"no destination category '{cat}'")
    def op(src):
        D = _dest_dict(src); return _insert_pair(src, _pair(D, cat)[1], _new_entry_text(name, location, exists))

    return edit_simple_destinations(path, op, lambda d: d[cat].__setitem__(name, {'Location': (round(float(location[0]), 5), round(float(location[1]), 5)), 'Exists': list(exists)}))

def delete_simple_destination(path: str, cat: str, name: str) -> dict:
    def op(src):
        _, _, (k, v) = _entry(src, cat, name); return _cut_pair(src, k, v)

    return edit_simple_destinations(path, op, lambda d: d[cat].pop(name))

def update_simple_destination(path: str, cat: str, name: str, new_name: str | None = None, new_cat: str | None = None, location=None, image: str | None = None) -> dict:
    """Renames, recategorises, moves and / or sets the image of a simplified-map venue"""
    new_name = (new_name or name).strip(); new_cat = new_cat or cat
    ns = load_namespace(path); simple = ns.get('Destinations') or {}
    if new_name != name and _where(simple, new_name): raise ValueError(f"there is already a destination called '{new_name}'")
    if new_cat not in simple: raise ValueError(f"no destination category '{new_cat}'")
    def op(src):
        if location is not None:
            _, _, (k, v) = _entry(src, cat, name)
            src = _set_field(src, v, 'Location', f"({float(location[0]):.5f}, {float(location[1]):.5f})")

        if image:
            import ast
            _, _, (k, v) = _entry(src, cat, name); p = _pair(v, 'Image'); pos = _offsets(src)
            if p and isinstance(p[1], ast.List) and p[1].elts:                 # [file, source]: only the file changes
                e0 = p[1].elts[0]; src = src[:pos(e0.lineno, e0.col_offset)] + repr(image) + src[pos(e0.end_lineno, e0.end_col_offset):]
            else: src = _set_field(src, v, 'Image', repr(image))

        if new_name != name:
            _, _, (k, v) = _entry(src, cat, name); pos = _offsets(src)
            src = src[:pos(k.lineno, k.col_offset)] + repr(new_name) + src[pos(k.end_lineno, k.end_col_offset):]

        if new_cat != cat:
            _, _, (k, v) = _entry(src, cat, new_name); pos = _offsets(src)
            text = src[pos(k.lineno, k.col_offset):pos(v.end_lineno, v.end_col_offset)]
            src = _cut_pair(src, k, v); D = _dest_dict(src); src = _insert_pair(src, _pair(D, new_cat)[1], text)

        return src

    def expect(d):
        e = d[cat].pop(name)
        if image: e['Image'] = [image] + list(e['Image'][1:]) if isinstance(e.get('Image'), (list, tuple)) and e['Image'] else image
        if location is not None: e['Location'] = (round(float(location[0]), 5), round(float(location[1]), 5))
        d[new_cat][new_name] = e

    return edit_simple_destinations(path, op, expect)