"""Turns map data into the registry entries the frontend draws, for the simplified map or (with traced geometry) the detailed one"""

from __future__ import annotations

from typing import Any, Callable

from core.geo import simplify, near_polyline
from core.route_analyzer import analyze_route_structure
from core.station_resolver import build_station_sequence, build_coordinate_sequence, base_of
from core.traced import traced_coords
from core.types import (
    LinesDict, StationDict, SegmentDict, ModeDict, ModeSettings,
    Registry, RegistryEntry, PatternPayload, StationKey,
)

WEB_SIMPLIFY_M = 0.5      # detailed lines shipped to the browser: Douglas-Peucker tolerance in metres
PLATFORM_TOL_M = 2.5      # a platform whose position is this close to a route's traced path is one the route stops at

PathsOf = Callable[[str], Any]      # detailed map: pattern name -> its traced polylines
OnMap   = Callable[[str], bool]     # detailed map: platform key -> is it on the map being built (Present / Future)?

def _add_unique(out: list, items) -> None:
    for s in items:
        if s not in out: out.append(s)

def _platform_groups(seq: list[StationKey], explicit: list[list[StationKey]], all_stations: StationDict,
                     paths: list[Any] | None, on_map: OnMap | None) -> list[list[StationKey]]:
    """The platforms the line really stops at per station: its stops, their alternatives and (detailed map) platforms the traced path runs through"""
    by_base: dict[str, list[StationKey]] = {}
    for k in all_stations:
        if ' {' in k: by_base.setdefault(base_of(k), []).append(k)

    groups: dict[str, list[StationKey]] = {}
    for k in seq:
        if k in all_stations: groups.setdefault(base_of(k), []).append(k)

    for g in explicit:
        for k in g:
            if k in all_stations and k not in groups.setdefault(base_of(k), []): groups[base_of(k)].append(k)

    if paths:
        for b, members in list(groups.items()):
            for k in by_base.get(b, []):
                if k not in members and (on_map is None or on_map(k)) and near_polyline(tuple(all_stations[k]['Location']), paths, PLATFORM_TOL_M):
                    members.append(k)

    return [g for g in groups.values() if len(g) > 1]

def _shape_json(structure: dict, seq: list[StationKey]) -> dict:
    """A pattern's shape for the page, each stop given as its place in the pattern's list of stops (much smaller than the names)"""
    at: dict[StationKey, int] = {}
    for i, k in enumerate(seq): at.setdefault(k, i)
    ix = lambda ks: [at[k] for k in ks]
    if structure['Type'] != 'Branched': return {'Type': structure['Type'], 'Stations': ix(structure['Stations'])}
    return {'Type': 'Branched', 'Sections': [[s[0], *[ix(x) for x in s[1:]]] for s in structure['Sections']]}

def _patterns_payload(patterns: dict[str, Any], segments: SegmentDict, all_stations: StationDict, mode_settings: ModeSettings,
                      paths_of: PathsOf | None, on_map: OnMap | None) -> tuple[list[StationKey], list[PatternPayload]]:
    all_line_stations: list[StationKey] = []
    payload: list[PatternPayload] = []
    for name, data in patterns.items():
        seq = build_station_sequence(data, segments)
        _add_unique(all_line_stations, seq)
        # Alt: other platforms a stop may use; they belong to the line too (hover, search, pop-ups)
        alt = _platform_groups(seq, [[k for k in g if k in all_stations] for g in (data.get('Alt') or [])], all_stations,
                               paths_of(name) if paths_of else None, on_map)
        for g in alt: _add_unique(all_line_stations, g[1:])
        cyclic = paths_of is not None and not data.get('Shuttle')          # detailed routes return to their start, except a shuttle, which runs back over the same stops
        shape = _shape_json(analyze_route_structure(seq, cyclic=cyclic), seq)          # the page draws it (web/map.js)
        payload.append({"Name": name, "Stations": seq, "Shape": shape, **({"Alt": alt} if alt else {})})

    return all_line_stations, payload

def _line_coords(patterns: dict[str, Any], segments: SegmentDict, nodes: StationDict, stations: StationDict,
                 paths_of: PathsOf | None) -> list[list[list[float]]]:
    """One polyline per pattern. Simplified map: stations / nodes joined end to end. Detailed map: the traced path along the real track."""
    out: list[list[list[float]]] = []
    for name, data in patterns.items():
        if paths_of is None:
            coords = build_coordinate_sequence(data, segments, nodes, stations)
            if len(coords) >= 2: out.append([[lat, lon] for lat, lon in coords])
            continue

        for pl in paths_of(name):
            pts = simplify([(a, b) for a, b in pl], WEB_SIMPLIFY_M)
            out.append([[round(a, 6), round(b, 6)] for a, b in pts])

    return out

def build_registry(
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
    modes:    ModeDict,
    category: str,                            # 'Fantasy' | 'Present'
    traced:   dict[str, Any] | None = None,   # None: the simplified map; the geometry document: the detailed map (traced patterns only)
    on_map:   OnMap | None = None,
) -> Registry:
    """Every line with patterns in `category` -> one registry entry, lowest mode zOrder first."""
    prefix = ('Line' if traced is None else 'Detailed') + category
    all_stations: StationDict = {**stations, **nodes}
    entries: list[tuple[int, RegistryEntry]] = []

    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = categories.get(category, {})
            paths_of: PathsOf | None = None
            if traced is not None:          # the detailed map draws only what has been traced
                paths_of = lambda n, o=operator, l=line_name: traced_coords(traced, o, l, category, n)
                patterns = {n: p for n, p in patterns.items() if paths_of(n)}

            if not patterns: continue

            mode_id = next(iter(patterns.values()))["Mode"]
            mode_settings = modes.get(mode_id)
            coords = _line_coords(patterns, segments, nodes, stations, paths_of)
            if not coords: continue
            all_line_stations, payload = _patterns_payload(patterns, segments, all_stations, mode_settings, paths_of, on_map)
            z = modes[mode_id].get('zOrder', 0) if mode_id in modes else 0
            entries.append((z, {
                'Id':              f"{prefix}_{operator}_{line_name}".replace(" ", "_").replace("'", ""),
                'Color':           mode_settings['Color'],
                'Weight':          mode_settings['Weight'],
                'Name':            line_name,
                'Operator':        operator,
                'ModeId':          mode_id,
                'ModeName':        mode_settings['Name'],
                'ZIndex':          z * 100,
                'Patterns':        payload,
                'AllLineStations': all_line_stations,
                'Geometry':        {"Type": "polyline", "Coords": coords},
            }))

    return [entry for _, entry in sorted(entries, key=lambda e: e[0])]