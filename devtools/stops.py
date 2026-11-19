"""Edits one pattern's stops through a private wrapper segment, never the shared one"""
from __future__ import annotations
from . import mapdata as M
from core import station_resolver as R
from core.station_resolver import base_of

def natkey(k: str):
    """Natural order of platform names (Track 2 before Track 10): the one order every platform set is kept in, so no platform of a stop is 'the' main one."""
    import re
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', k.rstrip('}'))]

def wrapper_name(op, line, pat, cat): return f"~ {op} / {line} / {pat} / {cat}"

def stops_of(pd: dict, segs: dict, flat: dict) -> list[str]:
    """The stations / platforms a pattern stops at, in order (pass-through points and nodes excluded)."""
    return [k for k in R.build_station_sequence(pd, segs) if k in flat]

def pattern_stops(path: str, op: str, line: str, cat: str, pat: str) -> dict:
    ns = M.load_namespace(path); flat = R.normalize_stations(ns['Stations'])
    pd = ns['Lines'][op][line][cat][pat]
    out = []; alts = {g[0]: list(g[1:]) for g in pd.get('Alt') or [] if len(g) > 1}      # a stop's other usable platforms
    for k in stops_of(pd, ns['Segments'], flat):
        base = base_of(k); raw = ns['Stations'].get(base, {})
        out.append({'key': k, 'alt': alts.get(k, []), 'set': sorted([k] + alts.get(k, []), key=natkey), 'name': base, 'platform': k[len(base) + 2:-1] if '{' in k else None, 'label': flat[k].get('Label', k), 'location': list(flat[k]['Location']),
                    'platforms': sorted(raw.get('Platforms') or {}, key=natkey)})

    me = (op, line, cat, pat); base = lambda p, k: ((ns['Segments'].get(p['Stations'], {}).get('F') or [p['Stations']])[0] if p['Stations'] == wrapper_name(*k[:2], k[3], k[2]) else p['Stations'])
    mine = base(pd, me)
    shared = [{'operator': o, 'line': l, 'pattern': pn, 'category': c} for o, ls in ns['Lines'].items() for l, cs in ls.items() for c, ps in cs.items() for pn, p in ps.items()
              if (o, l, c, pn) != me and base(p, (o, l, c, pn)) == mine]
    return {'stops': out, 'edited': str(pd.get('Stations', '')).startswith('~ '), 'segment': pd.get('Stations'), 'shared': shared}

def _edit_pattern_stops(path: str, op: str, line: str, cat: str, pat: str, change: dict) -> dict:
    """change: {'swap': {'from', 'to'}} | {'alt': {'key', 'platforms': [other platforms the stop may use]}} | {'skip': key} | {'add': {'key', 'near', 'side': 'before'|'after'}} | {'reset': True}"""
    def go(segs, lns, ns):
        flat = R.normalize_stations(ns['Stations']); coords = {**{k: v['Location'] for k, v in ns['Nodes'].items() if isinstance(v, dict) and 'Location' in v},
                                                           **{k: v['Location'] for k, v in flat.items()}}
        pd = lns[op][line][cat][pat]; W = wrapper_name(op, line, pat, cat)
        was = stops_of(pd, segs, flat); want = list(was)
        A = [list(g) for g in pd.get('Alt') or []]                  # groups of platforms one stop may use: [the stop's own key, the others...]
        if 'alt' in change:
            k = change['alt']['key']; more = [x for x in change['alt'].get('platforms') or [] if x != k]
            if k not in was: raise ValueError(f"this route does not stop at '{k}'")
            base = base_of(k)
            for x in more:
                if x not in flat or x.split(' {')[0] != base: raise ValueError(f"'{x}' is not a platform of {base}")

            A = [g for g in A if g[0] != k]
            if more: A.append([k] + list(dict.fromkeys(more)))
            _set_alt(pd, A); return

        if 'swap' in change:                                        # the stop is now another platform: its group follows
            a, b = change['swap']['from'], change['swap']['to']
            A = [[b] + [x for x in g[1:] if x != b] if g[0] == a else g for g in A]; _set_alt(pd, A)
        elif 'skip' in change:
            A = [g for g in A if g[0] != change['skip']]; _set_alt(pd, A)

        if 'reset' in change:
            base = (segs.get(W, {}).get('F') or [pd['Stations']])[0]
            if base not in segs: raise ValueError("this route's stops were written out as its own list (a stop repeats); it cannot go back to a shared one")
            pd['Stations'] = base; _drop(segs, W); return

        if 'order' in change:                                        # the exact list of stops (a route that stops at one platform more than once)
            new = list(change['order'])
            if any(k not in flat for k in new): raise ValueError("unknown stop in that order")
            _drop(segs, W); segs[W] = {'F': new}; pd['Stations'] = W
            _verify(R, pd, segs, flat, ns, coords, change, new); return

        if change.get('shared') or (pd['Stations'] != W and (not was or _owned(segs, lns, pd['Stations'], (op, line, cat, pat)))):
            seg = pd['Stations']; seg = segs[seg]['F'][0] if seg == W and W in segs else seg
            want = _direct(segs, seg, change, flat, want)        # the stop list is this route's own (or shared on purpose): edit it itself
            _verify(R, pd, segs, flat, ns, coords, change, want); return

        def own_list(new):                                          # a stop that repeats cannot be told apart by name: the route gets the exact list
            _drop(segs, W); segs[W] = {'F': list(new)}; pd['Stations'] = W
            _verify(R, pd, segs, flat, ns, coords, change, new)

        n = int(change.get('nth') or (change.get('add') or {}).get('nth') or 0)
        if 'swap' in change and was.count(change['swap']['from']) > 1:
            a, b = change['swap']['from'], change['swap']['to']
            if b not in flat: raise ValueError(f"unknown stop '{b}'")
            new = list(was); new[_nth(new, a, n)] = b; return own_list(new)

        if 'skip' in change and was.count(change['skip']) > 1:
            new = list(was); del new[_nth(new, change['skip'], n)]; return own_list(new)

        if 'add' in change and change['add'].get('near') and was.count(change['add']['near']) > 1 and change['add']['key'] in flat:
            k, near, side = change['add']['key'], change['add']['near'], change['add'].get('side', 'after')
            new = list(was); i = _nth(new, near, n); at = i + 1 if side == 'after' else i; _no_repeat(new, at, k); new.insert(at, k); return own_list(new)

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
                F = segs[mini]['F']; anchor = next(a for a, m in swaps if m == mini); anchor_k = next((n for oo, n in swaps if oo == anchor and n not in segs), anchor)
                swaps = [x for x in swaps if x[1] != mini and not (x[0] == o and x[1] not in segs)]; _drop_one(segs, mini)
                after = F[0] == anchor
                hit = [i for i, x in enumerate(want) if x == k and ((after and i > 0 and want[i - 1] == anchor_k) or (not after and i + 1 < len(want) and want[i + 1] == anchor_k))]
                del want[hit[0] if hit else want.index(k)]; k = None             # the added visit goes; any other visit of the same stop stays
            else:
                swaps = [x for x in swaps if not (x[1] == k and x[1] not in segs)]
                w['Skip'] = sorted(set(w.get('Skip', [])) | {o}); want[:] = [x for x in want if x != k]
        elif 'add' in change:
            k, near, side = change['add']['key'], change['add'].get('near'), change['add'].get('side', 'after')
            if k not in flat: raise ValueError(f"unknown stop '{k}'")
            if k in w.get('Skip', []):                              # taking a skipped stop back: it returns where it was
                w['Skip'] = [x for x in w['Skip'] if x != k]; want = None
            elif near is None: raise ValueError("choose the stop to add it next to")
            else:
                o = origin(near); n = 1
                while f'{W} +{n}' in segs: n += 1
                m = f'{W} +{n}'; segs[m] = {'F': [o, k] if side == 'after' else [k, o]}; swaps.append((o, m))
                i = _nth(want, near, change['add'].get('nth')); at = i + 1 if side == 'after' else i
                _no_repeat(want, at, k); want.insert(at, k)

        w['Swap'] = swaps
        if not w['Swap']: del w['Swap']
        if not w.get('Skip'): w.pop('Skip', None)
        if set(w) == {'F'}: pd['Stations'] = w['F'][0]; _drop(segs, W)
        _verify(R, pd, segs, flat, ns, coords, change, want)

    return M.edit_wiring(path, go)

def _wanted(keys: list, change: dict):
    """The exact list of stops a change should give (None: not a change of the list)."""
    new = list(keys)
    if 'add' in change:
        k, near, side, n = change['add']['key'], change['add'].get('near'), change['add'].get('side', 'after'), change['add'].get('nth')
        if near is None or near not in new: at = len(new)
        else: i = _nth(new, near, n); at = i + 1 if side == 'after' else i

        _no_repeat(new, at, k); new.insert(at, k)
    elif 'skip' in change:
        del new[_nth(new, change['skip'], change.get('nth'))]
    elif 'swap' in change:
        a, b = change['swap']['from'], change['swap']['to']; new[_nth(new, a, change.get('nth'))] = b
    else: return None

    return [x for i, x in enumerate(new) if not i or new[i - 1] != x]

def edit_pattern_stops(path: str, op: str, line: str, cat: str, pat: str, change: dict) -> dict:
    """Applies one stop-list change, keeping shared lists shared where possible"""
    if 'set' in change:                                      # {'set': {'key', 'platforms': [every platform this stop uses]}}: all equal; kept in natural order
        k = change['set']['key']; S = sorted(dict.fromkeys(change['set'].get('platforms') or []), key=natkey)
        if not S: raise ValueError("a stop needs at least one platform")
        if S[0] != k:
            edit_pattern_stops(path, op, line, cat, pat, {'swap': {'from': k, 'to': S[0]}, 'nth': change.get('nth'), 'shared': change.get('shared')})

        return edit_pattern_stops(path, op, line, cat, pat, {'alt': {'key': S[0], 'platforms': S[1:]}})

    try:
        return _edit_pattern_stops(path, op, line, cat, pat, change)
    except ValueError as first:
        keys = [s['key'] for s in pattern_stops(path, op, line, cat, pat)['stops']]
        want = _wanted(keys, change)                         # a real mistake (a stop straight after itself ...) raises here, with its own message
        if want is None: raise
        try:
            return _edit_pattern_stops(path, op, line, cat, pat, {'order': want})
        except ValueError:
            raise first

def _nth(lst: list, k, n: int = 0) -> int:
    """Index of the n-th occurrence of k in lst (a route may stop at one platform several times)."""
    hits = [i for i, x in enumerate(lst) if x == k]
    if not hits: raise ValueError(f"no stop '{k}' here")
    return hits[min(max(int(n or 0), 0), len(hits) - 1)]

def _no_repeat(want: list, i: int, k: str):
    """A stop cannot directly follow itself: two in a row are one stop."""
    if (i > 0 and want[i - 1] == k) or (i < len(want) and want[i] == k):
        raise ValueError("a stop cannot come straight after itself: put another stop between them")

def _set_alt(pd: dict, groups: list):
    groups = [g for g in groups if len(g) > 1]
    if groups: pd['Alt'] = groups
    else: pd.pop('Alt', None)

def _drop(segs: dict, W: str):
    for k in [k for k in segs if k == W or k.startswith(W + ' +')]: del segs[k]

def _drop_one(segs: dict, k: str): segs.pop(k, None)

def _owned(segs: dict, lns: dict, seg: str, me: tuple) -> bool:
    """True when no other route and no other segment uses this stop list."""
    for op, ls in lns.items():
        for ln, cs in ls.items():
            for c, ps in cs.items():
                for pn, p in ps.items():
                    if (op, ln, c, pn) != me and p.get('Stations') in (seg, wrapper_name(op, ln, pn, c)) and (p['Stations'] == seg or segs.get(p['Stations'], {}).get('F', [None])[0] == seg): return False

    return not any(seg in (x[4:] if x[:4] in ('[R] ', '[X] ') else x) for k, d in segs.items() if k != seg for key in ('F', 'L', 'R') for x in d.get(key, []))

def _direct(segs: dict, seg: str, change: dict, flat: dict, want: list):          # -> the stops to expect (None: just check the added one is there)
    """Edit the segment's own F list: the stop is found as an item there (a stop that comes from a nested segment is edited in that segment)."""
    F = segs[seg].setdefault('F', [])
    def at(k, n=0):
        hits = [i for i, x in enumerate(F) if x == k or x == '[X] ' + k]
        if not hits: raise ValueError(f"'{k}' comes from a segment inside this one; nothing written")
        return hits[min(max(int(n or 0), 0), len(hits) - 1)]

    if 'swap' in change:
        a, b = change['swap']['from'], change['swap']['to']
        if b not in flat: raise ValueError(f"unknown stop '{b}'")
        n = int(change.get('nth') or 0); F[at(a, n)] = b; want[_nth(want, a, n)] = b
    elif 'skip' in change:
        k = change['skip']; n = int(change.get('nth') or 0); i = at(k, n); del F[i]; del want[_nth(want, k, n)]
        if 0 < i < len(F) and F[i - 1] == F[i]: del F[i]                       # the two neighbours were the same stop: now they are one
    elif 'add' in change:
        k, near, side = change['add']['key'], change['add'].get('near'), change['add'].get('side', 'after')
        if k not in flat: raise ValueError(f"unknown stop '{k}'")
        n = int(change['add'].get('nth') or 0)
        if '[X] ' + k in F and k not in want: F[F.index('[X] ' + k)] = k; return None            # a point the route passes becomes a stop
        elif near is None: _no_repeat(want, len(want), k); F.append(k); want.append(k)
        else:
            j = _nth(want, near, n); jj = j + 1 if side == 'after' else j; _no_repeat(want, jj, k)
            i = at(near, n); F.insert(i + 1 if side == 'after' else i, k)
            want.insert(jj, k)

    return want

def _verify(R, pd, segs, flat, ns, coords, change, want):
    got = stops_of(pd, segs, flat)
    if want is None:
        if change['add']['key'] not in got: raise ValueError("that stop is not on this pattern's path; nothing written")
    elif got != [x for i, x in enumerate(want) if not i or want[i - 1] != x]: raise ValueError("that would not give the intended stops here (a Keep list in a shared segment filters it); nothing written")

    if 'add' in change or 'swap' in change:
        seq = R.build_coordinate_sequence(pd, segs, ns['Nodes'], flat)
        need = coords[change['add']['key'] if 'add' in change else change['swap']['to']]
        if tuple(need) not in [tuple(c) for c in seq]: raise ValueError("that stop is not on this pattern's path; nothing written")

def copy_route(path: str, op: str, line: str, pat: str, src: str, dst: str) -> dict:
    """The pattern of category `dst` becomes the same service as the one of category `src` (its stops and platform choices): a route put on both maps starts identical."""
    import copy
    def go(segs, lns, ns):
        cats = lns[op][line]
        if pat not in (cats.get(src) or {}) or pat not in (cats.get(dst) or {}): raise ValueError("both versions of the route must exist")
        s_pd, d_pd = cats[src][pat], cats[dst][pat]
        Ws, Wd = wrapper_name(op, line, pat, src), wrapper_name(op, line, pat, dst)
        for k in [k for k in segs if k == Wd or k.startswith(Wd + ' +')]: del segs[k]
        ren = {k: Wd + k[len(Ws):] for k in segs if k == Ws or k.startswith(Ws + ' +')}
        for k, nk in ren.items(): segs[nk] = M._rewrite(copy.deepcopy(segs[k]), ren)
        for k, v in s_pd.items():
            if k != 'Mode': d_pd[k] = M._rewrite(copy.deepcopy(v), ren)

        for k in [k for k in d_pd if k not in s_pd and k != 'Mode']: del d_pd[k]

    return M.edit_wiring(path, go)

def copy_pattern(path: str, op: str, line: str, src_pat: str, src_cat: str, dst_pat: str, dst_cat: str) -> dict:
    """Pattern dst_pat (dst_cat) of a line becomes the same service as src_pat (src_cat): its stops and platform choices; a stop list they share stays shared"""
    import copy
    from .routes import segment_name
    def go(segs, lns, ns):
        cats = lns[op][line]
        if src_pat not in (cats.get(src_cat) or {}) or dst_pat not in (cats.get(dst_cat) or {}): raise ValueError("both patterns must exist")
        s_pd, d_pd = cats[src_cat][src_pat], cats[dst_cat][dst_pat]
        Ws, Wd = wrapper_name(op, line, src_pat, src_cat), wrapper_name(op, line, dst_pat, dst_cat)
        for k in [k for k in segs if k == Wd or k.startswith(Wd + ' +')]: del segs[k]
        ren = {k: Wd + k[len(Ws):] for k in segs if k == Ws or k.startswith(Ws + ' +')}
        for k, nk in ren.items(): segs[nk] = M._rewrite(copy.deepcopy(segs[k]), ren)
        own = d_pd.get('Stations')
        for k, v in s_pd.items():
            if k != 'Mode': d_pd[k] = M._rewrite(copy.deepcopy(v), ren)

        for k in [k for k in d_pd if k not in s_pd and k != 'Mode']: del d_pd[k]
        used = {p['Stations'] for ls in lns.values() for cs in ls.values() for ps in cs.values() for p in ps.values()}
        if own == segment_name(op, line, dst_pat) and own not in used and segs.get(own) == {'F': []}: del segs[own]          # its own empty stop list is not needed

    return M.edit_wiring(path, go)

def rename_pattern(path: str, op: str, line: str, old: str, new: str) -> list[str]:
    """Pattern `old` of a line is called `new` on both maps: its entries, its private stop changes and (when only it uses it) its stop list; -> the maps renamed"""
    from .routes import segment_name
    new, done = new.strip(), []
    def go(segs, lns, ns):
        cats = lns.get(op, {}).get(line, {})
        mine = [c for c in cats if old in cats[c]]
        if not mine: raise ValueError("no such pattern")
        if not new or '"' in new: raise ValueError("a pattern needs a name, without double quotes")
        if new == old: return
        if any(new in ps for ps in cats.values()): raise ValueError(f"'{op} — {line} — {new}' already exists")
        ren = {}
        for c in mine:
            W, Wn = wrapper_name(op, line, old, c), wrapper_name(op, line, new, c)
            ren.update({k: Wn + k[len(W):] for k in segs if k == W or k.startswith(W + ' +')})

        S, Sn = segment_name(op, line, old), segment_name(op, line, new)
        others = [p for o, ls in lns.items() for ln, cs in ls.items() for c, ps in cs.items() for pn, p in ps.items() if (o, ln, pn) != (op, line, old) or c not in mine]
        shared = any(p.get('Stations') == S for p in others) or any((x[4:] if x[:4] in ('[R] ', '[X] ') else x) == S for k, d in segs.items() if k != S and k not in ren for key in ('F', 'L', 'R') for x in d.get(key, []))
        if S in segs and Sn not in segs and not shared: ren[S] = Sn             # its own stop list takes the new name too
        items = list(segs.items()); segs.clear()
        for k, v in items: segs[ren.get(k, k)] = M._rewrite(v, ren)

        for c, ps in cats.items():                                              # same place in the list, new name
            items = list(ps.items()); ps.clear()
            for pn, pd in items: ps[new if pn == old else pn] = pd

        for ls in lns.values():
            for cs in ls.values():
                for ps in cs.values():
                    for pn in ps: ps[pn] = M._rewrite(ps[pn], ren)

        done.extend(mine)

    M.edit_wiring(path, go)
    return done