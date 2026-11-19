"""Works out a pattern's shape (one way, out and back, branching by direction, loops) and renders its sidebar SVG diagram, alone or with the line's other patterns"""
from __future__ import annotations
from typing import Any
from core.station_resolver import base_of
from core.types import StationKey, RouteStructure, StationDict, Color

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

def _spine(structure: RouteStructure) -> list[StationKey]:
    """The stops on a pattern's main rail, top to bottom"""
    if structure["Type"] != "Branched": return list(structure["Stations"])
    return [k for s in structure["Sections"] for k in s[1]]

# Label / style helpers

def _station_label(key: StationKey, station_data: StationDict) -> str:
    if key in station_data:
        s:     dict[str, Any] = station_data[key]
        label: str            = s.get("Label", key)
        if str(s.get("Airport", "")).strip().lower() == "true" or s.get("Type") == "Airport":
            label += '<tspan dx="9" dy="2" rotate="-45">✈&#xFE0E;</tspan>'          # SVG turns the glyph itself (CSS transforms do nothing on a tspan); FE0E keeps it a text glyph, not an emoji

        return label

    return key

def _station_style(key: StationKey, station_data: StationDict) -> dict[str, int]:
    s = station_data.get(key) or {}
    major = bool(s.get("Major", False))
    return {"FontSize": 13 if major else 12, "FontWeight": 900 if major else 600, "DotRadius": 7 if major else 5}

# Layout: one row per stop, each on a rail; rail 0 is the main rail (x = 30), the others take the first free column to its right

ROW, TOP, MAIN, COL = 35, 20, 30, 16

class _Layout:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.rails: list[dict[str, Any]] = [{"col": 0}]

    def rail(self, top: dict | None, bottom: dict | None, dashed: bool = False, col: int | None = None, turn: str | None = None) -> dict[str, Any]:
        """A rail beside the main one, from the main rail at row `top` (None: from its own first stop) to the main rail at `bottom`"""
        r = {"top": top, "bottom": bottom, "dashed": dashed, "col": col, "turn": turn, "rows": []}
        self.rails.append(r)
        return r

    def row(self, key: StationKey, rail: dict | None = None, at: int | None = None, **kw: Any) -> dict[str, Any]:
        r = {"key": key, "rail": rail or self.rails[0], **kw}
        self.rows.insert(len(self.rows) if at is None else at, r)
        if rail: rail["rows"].append(r)
        return r

def _layout(structure: RouteStructure) -> tuple[_Layout, list[dict[str, Any]]]:
    """A pattern's rows and rails, and its main-rail rows"""
    lay = _Layout()
    if structure["Type"] != "Branched":
        for k in structure["Stations"]: lay.row(k)
        if structure["Type"] == "Loop" and len(lay.rows) > 2: lay.rail(lay.rows[0], lay.rows[-1], turn="bottom")
        return lay, list(lay.rows)

    secs = structure["Sections"]
    pending: list[dict] = []                                        # forks waiting for the shared stop that closes them
    for si, sec in enumerate(secs):
        if sec[0] == "Shared":
            for k in sec[1]:
                r = lay.row(k)
                for f in pending: f["bottom"] = r
                pending = []

        elif sec[0] == "Split":
            fork = lay.rail(lay.rows[-1] if lay.rows else None, None, dashed=True)
            for k in sec[1]: lay.row(k, note="↓")
            for k in sec[2]: lay.row(k, fork, note="↑", muted=True, hollow=True)
            pending.append(fork)
        else:
            first = len(lay.rows)
            for k in sec[1]: lay.row(k)
            if si == 0: pending.append(lay.rail(lay.rows[first], None, turn="top"))           # a loop at the start comes back into the stop after it
            elif lay.rows: lay.rail(lay.rows[first - 1], lay.rows[-1], turn="bottom")                # a loop at the end comes back into the stop before it

    return lay, [r for r in lay.rows if r["rail"] is lay.rails[0]]

def _merge(lay: _Layout, paths: list[list[dict[str, Any]]], structure: RouteStructure) -> None:
    """Another pattern of the line, off the drawn path it shares most with: its other stops branch (out of a stop, into a stop, or around a stretch)"""
    keys, best = _spine(structure), None
    if not keys: return
    for path in paths:
        names = [base_of(r["key"]) for r in path]
        for ks in (keys, keys[::-1]):
            pairs = _align(names, [base_of(k) for k in ks])
            if best is None or len(pairs) > len(best[2]): best = (path, ks, pairs)

    path, keys, pairs = best
    if not pairs:                                                   # nothing in common: drawn on its own below
        r = lay.rail(None, None, col=0)
        paths.append([lay.row(k, r) for k in keys])
        return

    def branch(run: list[StationKey], top: dict | None, bottom: dict | None, at: int) -> list[dict[str, Any]]:
        if not run: return []
        r = lay.rail(top, bottom)
        return [lay.row(k, r, at=at + i) for i, k in enumerate(run)]

    (i0, j0), (il, jl) = pairs[0], pairs[-1]
    mine = branch(keys[:j0], None, path[i0], lay.rows.index(path[i0]))
    for (i, j), (i2, j2) in zip(pairs, pairs[1:]): mine += [path[i]] + branch(keys[j + 1:j2], path[i], path[i2], lay.rows.index(path[i2]))
    paths.append(mine + [path[il]] + branch(keys[jl + 1:], path[il], None, lay.rows.index(path[il]) + 1))

# Rendering

def _dot(key: StationKey, x: float, y: float, color: Color, station_data: StationDict, hollow: bool = False) -> str:
    r = _station_style(key, station_data)["DotRadius"] - (1 if hollow else 0)
    fill = f'fill="#fff" stroke="{color}" stroke-width="2.5"' if hollow else f'fill="{color}"'
    return f'<circle class="station-dot" data-station="{key}" cx="{x}" cy="{y}" r="{r}" {fill}/>'

def _label(key: StationKey, x: float, y: float, station_data: StationDict, note: str = "", muted: bool = False) -> str:
    st = _station_style(key, station_data)
    tail = f'<tspan dx="6" font-size="13" font-weight="700" fill="#64748b">{note}</tspan>' if note else ''
    return (f'<text class="station-label" data-station="{key}" x="{x}" y="{y + 5}" font-size="{st["FontSize"]}" fill="{"#475569" if muted else "#1e293b"}" '
            f'font-weight="{st["FontWeight"]}">{_station_label(key, station_data)}{tail}</text>')

def _rail(d: str, color: Color, dashed: bool = False) -> str:
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="3" stroke-linecap="round"{" stroke-dasharray=\"5,4\"" if dashed else ""}/>'

def _side_path(x: float, y0: float, y1: float, x_top: float | None, x_bottom: float | None, turn: str | None = None) -> str:
    """Down column x from y0 to y1, bending out of / into the rail at x_top / x_bottom; the `turn` end of a loop swings round past its last stop"""
    bend, e = ROW * (0.8 if turn else 0.45), 5                     # a loop leaves its junction in a long, smooth curve
    arc = lambda xa, xb, y: f"A{abs(xb - xa) / 2},{abs(xb - xa) / 2} 0 0 1 {xb},{y}"
    if turn == "top": d = f"M{x_top},{y0} V{y0 - e} {arc(x_top, x, y0 - e)}"
    elif x_top is not None: d = f"M{x_top},{y0} C{x_top},{y0 + bend} {x},{y0 + bend * 0.4} {x},{y0 + bend}"
    else: d = f"M{x},{y0}"

    if turn == "bottom": return d + f" V{y1 + e} {arc(x, x_bottom, y1 + e)} V{y1}"
    return d + (f" V{y1 - bend} C{x},{y1 - bend * 0.4} {x_bottom},{y1 - bend} {x_bottom},{y1}" if x_bottom is not None else f" V{y1}")

def _render(lay: _Layout, color: Color, station_data: StationDict) -> str:
    if not lay.rows: return ""
    idx, ys = {id(r): i for i, r in enumerate(lay.rows)}, [TOP + i * ROW for i in range(len(lay.rows))]
    y = lambda r: ys[idx[id(r)]]
    spans = []
    for rl in lay.rails[1:]:                                        # the rows each side rail covers, then the first column free there
        ends = [idx[id(r)] for r in (rl["top"], rl["bottom"], *rl["rows"]) if r is not None]
        if ends: spans.append((rl, min(ends), max(ends)))

    taken: list[tuple[int, int, int]] = []
    for rl, a, b in spans:
        if rl["col"] is None: rl["col"] = next(c for c in range(1, 99) if not any(c == tc and a < tb and ta < b for tc, ta, tb in taken))
        taken.append((rl["col"], a, b))

    text_x = max(MAIN + COL * rl["col"] + (10 if rl.get("turn") else 0) for rl in lay.rails) + 16
    body: list[str] = []
    main = [r for r in lay.rows if r["rail"] is lay.rails[0]]
    if len(main) > 1: body.append(_rail(f"M{MAIN},{y(main[0])} V{y(main[-1])}", color))
    for rl, a, b in spans:
        x = MAIN + COL * rl["col"] + (10 if rl["turn"] else 0)             # a loop is a little wider, so its turn reads as one
        if rl["col"] == 0: body.append(_rail(f"M{x},{ys[a]} V{ys[b]}", color)); continue
        at_x = lambda r: None if r is None else MAIN + COL * r["rail"]["col"]
        body.append(_rail(_side_path(x, ys[a], ys[b], at_x(rl["top"]), at_x(rl["bottom"]), rl["turn"]), color, rl["dashed"]))

    for r in lay.rows:
        ry, x = y(r), MAIN + COL * r["rail"]["col"]
        body.append(_dot(r["key"], x, ry, color, station_data, r.get("hollow", False)))
        body.append(_label(r["key"], text_x, ry, station_data, r.get("note", ""), r.get("muted", False)))

    return f'<svg width="100%" height="{max(60, ys[-1] + ROW)}" style="margin:8px 0">' + ''.join(body) + '</svg>'

def generate_route_diagram(structure: RouteStructure, line_color: Color, station_keys: list[StationKey], station_data: StationDict) -> str:
    return _render(_layout(structure)[0], line_color, station_data)

def generate_line_diagram(patterns: list[tuple[str, RouteStructure]], line_color: Color, station_data: StationDict) -> str:
    """Every pattern of a line on one diagram: the one with the most stops is the main rail, the others branch off it"""
    if len(patterns) < 2: return ""
    order = sorted(range(len(patterns)), key=lambda i: -len(_spine(patterns[i][1])))
    lay, spine = _layout(patterns[order[0]][1])
    paths = [spine]
    for i in order[1:]: _merge(lay, paths, patterns[i][1])
    return _render(lay, line_color, station_data)