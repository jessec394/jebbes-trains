"""Create and delete the detailed map's routes (a route is a pattern: operator / line / pattern / category 'Present' | 'Fantasy').

A new route has an empty stop list of its own ("Segments": {"operator / line / pattern": {"F": []}}). A Future route made beside a
Present route of the same name shares that stop list, so the stops are written once; editing them for one map only (the Stops
panel) gives that route a private copy of the changes (see stops.py).
"""
from __future__ import annotations
from . import mapdata as M


def segment_name(op: str, line: str, pat: str) -> str:
    return f"{op} / {line} / {pat}"


def create_route(path: str, op: str, line: str, pat: str, cat: str, mode: str) -> dict:
    op, line, pat = (x.strip() for x in (op, line, pat))
    def go(segs, lns, ns):
        if cat not in ('Present', 'Fantasy'): raise ValueError("a route is Present or Future")
        if not (op and line and pat): raise ValueError("a route needs an operator, a line and a pattern name")
        if any('"' in x for x in (op, line, pat)): raise ValueError("names cannot contain double quotes")
        if mode not in ns.get('Modes', {}): raise ValueError(f"unknown mode '{mode}'")
        if pat in lns.get(op, {}).get(line, {}).get(cat, {}): raise ValueError(f"'{op} — {line} — {pat}' already exists")
        seg = segment_name(op, line, pat)
        segs.setdefault(seg, {'F': []})                     # a Future route beside the Present one shares its stops
        lns.setdefault(op, {}).setdefault(line, {}).setdefault(cat, {})[pat] = {'Mode': mode, 'Stations': seg}
    return M.edit_wiring(path, go)


def delete_route(path: str, op: str, line: str, pat: str, cat: str) -> dict:
    """The route goes; so do its private stop changes and, when nothing else uses it, its stop list."""
    def go(segs, lns, ns):
        try: pd = lns[op][line][cat].pop(pat)
        except KeyError: raise ValueError("no such route")
        for c in [c for c in lns[op][line] if not lns[op][line][c]]: del lns[op][line][c]
        if not lns[op][line]: del lns[op][line]
        if not lns[op]: del lns[op]
        W = f"~ {op} / {line} / {pat} / {cat}"
        base = pd['Stations']
        if base == W and W in segs: base = segs[W]['F'][0]
        for k in [k for k in segs if k == W or k.startswith(W + ' +')]: del segs[k]
        used = {p['Stations'] for ls in lns.values() for cs in ls.values() for ps in cs.values() for p in ps.values()}
        if base == segment_name(op, line, pat) and base not in used: segs.pop(base, None)
    return M.edit_wiring(path, go)
