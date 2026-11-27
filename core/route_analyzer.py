"""Works out a pattern's shape (one way, out and back, branching by direction, loops); the page draws it as the sidebar's strip of stops (web/map.js)"""
from __future__ import annotations
from typing import Any
from core.station_resolver import base_of
from core.types import StationKey, RouteStructure

# Shape detection: a closed pattern is split at the turnaround where its two directions line up best; shared stops are drawn once, differing ones fork

def _collapse(keys: list[StationKey]) -> list[StationKey]:
    """Drops a stop that repeats the station just before it (two platforms of one station in a row)"""
    out: list[StationKey] = []
    for k in keys:
        if not out or base_of(out[-1]) != base_of(k): out.append(k)

    return out

def _align(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """Index pairs of the longest common subsequence of two station lists"""
    n, m = len(a), len(b)
    L = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1): L[i][j] = L[i + 1][j + 1] + 1 if a[i] == b[j] else max(L[i + 1][j], L[i][j + 1])

    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j]: pairs.append((i, j)); i += 1; j += 1
        elif L[i + 1][j] >= L[i][j + 1]: i += 1
        else: j += 1

    return pairs

def _rings(sections: list[tuple[Any, ...]]) -> list[tuple[Any, ...]]:
    """A fork that closes at the turnaround (or opens at the start) is a loop at that end: ('Loop', its stops in the order they are run)"""
    ring = lambda sp: sp[0] == "Split" and sp[1] and sp[2]
    if len(sections) >= 3 and sections[-1][0] == "Shared" and len(sections[-1][1]) == 1 and ring(sections[-2]):
        _, o, b = sections[-2]; sections[-2:] = [("Loop", o + sections[-1][1] + b[::-1])]

    if len(sections) >= 3 and sections[0][0] == "Shared" and len(sections[0][1]) == 1 and ring(sections[1]):
        _, o, b = sections[1]; sections[:2] = [("Loop", b[::-1] + sections[0][1] + o)]

    return sections

def analyze_route_structure(stations: list[StationKey], cyclic: bool = False) -> RouteStructure:
    """{'Type': 'Linear' | 'Loop', 'Stations': [...]} or {'Type': 'Branched', 'Sections': [('Shared', keys) | ('Split', out_keys, back_keys) | ('Loop', keys)]}"""
    keys = _collapse(stations)
    closed = cyclic or (len(keys) > 2 and base_of(keys[0]) == base_of(keys[-1]))
    if not closed or len(keys) < 3: return {"Type": "Linear", "Stations": keys}
    if base_of(keys[0]) == base_of(keys[-1]): keys = keys[:-1]
    names = [base_of(k) for k in keys]
    if len(set(names)) == len(names): return {"Type": "Loop", "Stations": keys}
    tour, n, best = keys + [keys[0]], len(keys), None
    for t in range(1, n):                                       # the turnaround that lines the two directions up best
        out, back = tour[:t + 1], tour[t:][::-1]
        pairs = _align([base_of(k) for k in out], [base_of(k) for k in back])
        score = (len(pairs), -abs(t - n / 2))
        if best is None or score > best[0]: best = (score, out, back, pairs)

    _s, out, back, pairs = best
    sections: list[tuple[Any, ...]] = []
    pi = pj = 0
    for i, j in pairs:
        if i > pi or j > pj: sections.append(("Split", out[pi:i], back[pj:j]))
        if sections and sections[-1][0] == "Shared": sections[-1][1].append(out[i])
        else: sections.append(("Shared", [out[i]]))

        pi, pj = i + 1, j + 1

    if pi < len(out) or pj < len(back): sections.append(("Split", out[pi:], back[pj:]))
    if all(s[0] == "Shared" for s in sections): return {"Type": "Linear", "Stations": sections[0][1], "Returns": True}
    return {"Type": "Branched", "Sections": _rings(sections)}