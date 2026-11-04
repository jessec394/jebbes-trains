"""Edit the stops of one pattern without touching what other patterns share.

A pattern runs through a segment ("Stations": segment). Several patterns, often a Present and a Future one, share segments, so an
edit never changes the shared segment: the pattern gets a private wrapper segment "~ operator / line / pattern / category" that
contains the shared one plus the edits (Swap = another platform, Skip = no stop there, Swap to a tiny segment = an added stop). A
wrapper that ends up with no edits is removed again, so a pattern that matches the shared one simply uses it.
Every edit is checked: the pattern's stops and its coordinates must come out exactly as intended, or nothing is written.
"""
from __future__ import annotations
import sys
from . import config, mapdata as M


def _core():
    if config.ROOT not in sys.path: sys.path.insert(0, config.ROOT)
    from core import station_resolver as R
    return R


def wrapper_name(op, line, pat, cat): return f"~ {op} / {line} / {pat} / {cat}"


def stops_of(pd: dict, segs: dict, flat: dict) -> list[str]:
    """The stations / platforms a pattern stops at, in order (pass-through points and nodes excluded)."""
    return [k for k in _core().build_station_sequence(pd, segs) if k in flat]


def pattern_stops(path: str, op: str, line: str, cat: str, pat: str) -> dict:
    R = _core(); ns = M.load_namespace(path); flat = R.normalize_stations(ns['Stations'])
    pd = ns['Lines'][op][line][cat][pat]
    out = []
    for k in stops_of(pd, ns['Segments'], flat):
        base = k.split(' {')[0]; raw = ns['Stations'].get(base, {})
        out.append({'key': k, 'name': base, 'platform': k[len(base) + 2:-1] if '{' in k else None, 'label': flat[k].get('Label', k), 'location': list(flat[k]['Location']),
                    'platforms': sorted(raw.get('Platforms') or {})})
    return {'stops': out, 'edited': str(pd.get('Stations', '')).startswith('~ '), 'segment': pd.get('Stations')}


def edit_pattern_stops(path: str, op: str, line: str, cat: str, pat: str, change: dict) -> dict:
    """change: {'swap': {'from', 'to'}} | {'skip': key} | {'add': {'key', 'near', 'side': 'before'|'after'}} | {'reset': True}"""
    R = _core()
    def go(segs, lns, ns):
        flat = R.normalize_stations(ns['Stations']); coords = {**{k: v['Location'] for k, v in ns['Nodes'].items() if isinstance(v, dict) and 'Location' in v},
                                                           **{k: v['Location'] for k, v in flat.items()}}
        pd = lns[op][line][cat][pat]; W = wrapper_name(op, line, pat, cat)
        was = stops_of(pd, segs, flat); want = list(was)
        if 'reset' in change:
            base = segs.get(W, {}).get('F', [pd['Stations']])[0]; pd['Stations'] = base; _drop(segs, W); return
        if pd['Stations'] != W:
            segs[W] = {'F': [pd['Stations']]}; pd['Stations'] = W
        w = segs[W]; swaps = [tuple(x) for x in w.get('Swap', [])]
        def origin(k): return next((o for o, n in swaps if n == k and n not in segs), k)
        if 'swap' in change:
            a, b = change['swap']['from'], change['swap']['to']
            if b not in flat: raise ValueError(f"unknown stop '{b}'")
            o = origin(a); swaps = [x for x in swaps if x[0] != o or x[1] in segs]
            if b != o: swaps.append((o, b))
            want[want.index(a)] = b
        elif 'skip' in change:
            k = change['skip']; o = origin(k)
            mini = next((m for anchor, m in swaps if m in segs and m.startswith(W + ' +') and o in segs[m]['F'] and o != anchor), None)
            if mini:                                                # a stop added here: take the addition away
                if any(x[0] == o for x in swaps if x[1] != mini and x[1] in segs): raise ValueError("remove the stops added after this one first")
                swaps = [x for x in swaps if x[1] != mini and not (x[0] == o and x[1] not in segs)]; _drop_one(segs, mini)
            else:
                swaps = [x for x in swaps if not (x[1] == k and x[1] not in segs)]
                w['Skip'] = sorted(set(w.get('Skip', [])) | {o})
            want.remove(k)
        elif 'add' in change:
            k, near, side = change['add']['key'], change['add'].get('near'), change['add'].get('side', 'after')
            if k not in flat: raise ValueError(f"unknown stop '{k}'")
            if k in want: raise ValueError(f"already stops at '{k}'")
            if k in w.get('Skip', []):                              # taking a skipped stop back: it returns where it was
                w['Skip'] = [x for x in w['Skip'] if x != k]; want = None
            elif near is None: raise ValueError("choose the stop to add it next to")
            else:
                o = origin(near); n = 1
                while f'{W} +{n}' in segs: n += 1
                m = f'{W} +{n}'; segs[m] = {'F': [o, k] if side == 'after' else [k, o]}; swaps.append((o, m))
                i = want.index(near); want.insert(i + 1 if side == 'after' else i, k)
        w['Swap'] = swaps
        if not w['Swap']: del w['Swap']
        if not w.get('Skip'): w.pop('Skip', None)
        if set(w) == {'F'}: pd['Stations'] = w['F'][0]; _drop(segs, W)
        got = stops_of(pd, segs, flat)
        if (k_add := change.get('add', {}).get('key')) and want is None:
            if k_add not in got: raise ValueError('that stop is not on this pattern\'s path; nothing written')
        elif got != want: raise ValueError("that would not give the intended stops here (a Keep list in a shared segment filters it); nothing written")
        if 'add' in change or 'swap' in change:
            seq = R.build_coordinate_sequence(pd, segs, ns['Nodes'], flat)
            need = coords[change['add']['key'] if 'add' in change else change['swap']['to']]
            if tuple(need) not in [tuple(c) for c in seq]: raise ValueError("that stop is not on this pattern's path; nothing written")
    return M.edit_wiring(path, go)


def _drop(segs: dict, W: str):
    for k in [k for k in segs if k == W or k.startswith(W + ' +')]: del segs[k]


def _drop_one(segs: dict, k: str): segs.pop(k, None)