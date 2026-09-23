"""
Converts raw Lines/Stations/Nodes/Segments data into registry entries the
frontend needs. Geometry is always an inline coordinate array built straight
from segment/station/node coordinates -- there's no separate GeoJSON-traced
("Detailed") layer anymore, so every line gets exactly one polyline.
"""

from __future__ import annotations

from typing import Any

from core.station_resolver import build_station_sequence, build_coordinate_sequence
from core.route_analyzer   import analyze_route_structure, generate_route_diagram
from builder.types import (
    LinesDict, StationDict, SegmentDict, ModeDict, ModeSettings,
    Registry, RegistryEntry, PatternPayload,
    LineId, ModeId, Operator, LineName, StationKey,
)


# ── Shared helpers ────────────────────────────────────────────────────────────

def _mode_z_order(modes: ModeDict) -> dict[ModeId, int]:
    return {mode_id: modes[mode_id].get('zOrder', 0) for mode_id in modes}


def _build_patterns_payload(
    pattern_items: Any,
    segments:      SegmentDict,
    stations:      StationDict,
    nodes:         StationDict,
    mode_settings: ModeSettings,
) -> tuple[list[StationKey], list[PatternPayload]]:
    all_stations: StationDict           = {**stations, **nodes}
    all_line_stations: list[StationKey] = []
    patterns_payload: list[PatternPayload] = []

    for pattern_name, pattern_data in pattern_items:
        station_seq: list[StationKey] = build_station_sequence(pattern_data, segments, filter_non_stops=True)
        for s in station_seq:
            if s not in all_line_stations:
                all_line_stations.append(s)
        structure = analyze_route_structure(station_seq)
        diagram: str = generate_route_diagram(structure, mode_settings['Color'], station_seq, all_stations)
        patterns_payload.append({"Name": pattern_name, "Stations": station_seq, "Diagram": diagram})

    return all_line_stations, patterns_payload


def _registry_entry(
    line_id:           LineId,
    operator:          Operator,
    line_name:         LineName,
    mode_id:           ModeId,
    mode_settings:     ModeSettings,
    z_index:           int,
    patterns:          list[PatternPayload],
    all_line_stations: list[StationKey],
    geometry:          dict[str, Any],       # {"Type": "polyline", "Coords": [...]}
) -> RegistryEntry:
    return {
        'Id':              line_id,
        'Color':           mode_settings['Color'],
        'Weight':          mode_settings['Weight'],
        'Name':            line_name,
        'Operator':        operator,
        'ModeId':          mode_id,
        'ModeName':        mode_settings['Name'],
        'ZIndex':          z_index,
        'Patterns':        patterns,
        'AllLineStations': all_line_stations,
        'Geometry':        geometry,
    }


def _safe_line_id(prefix: str, operator: Operator, line_name: LineName) -> LineId:
    return f"{prefix}_{operator}_{line_name}".replace(" ", "_").replace("'", "")


# ── Shared pipeline ───────────────────────────────────────────────────────────
#
# process_fantasy and process_present are the same operator→line→pattern walk,
# differing only in which category dict they read from and the line-id prefix.
# _collect_line_entries does that walk once; each public function only
# supplies the category.

def _collect_line_entries(
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
    modes:    ModeDict,
    category: str,   # "Fantasy" | "Present"
) -> list[dict[str, Any]]:
    z_order: dict[ModeId, int] = _mode_z_order(modes)
    entries: list[dict[str, Any]] = []

    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = categories.get(category, {})
            if not patterns:
                continue

            first:         Any          = next(iter(patterns.values()))
            mode_id:       ModeId       = first["Mode"]
            mode_settings: ModeSettings = modes.get(mode_id)

            geometry = _inline_coords(patterns, segments, nodes, stations)
            if not geometry:
                continue

            all_line_stations, patterns_payload = _build_patterns_payload(
                patterns.items(), segments, stations, nodes, mode_settings
            )

            entries.append(dict(
                operator=operator, line_name=line_name,
                mode_id=mode_id, mode_settings=mode_settings,
                geometry=geometry, patterns_payload=patterns_payload,
                all_line_stations=all_line_stations,
                z_order=z_order.get(mode_id, 0),
            ))

    return entries


def _build_registry(entries: list[dict[str, Any]], id_prefix: str) -> Registry:
    registry: Registry = []
    for ld in sorted(entries, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id(id_prefix, ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
            ld['geometry'],
        ))
    return registry


def _inline_coords(
    patterns: dict[str, Any], segments: SegmentDict, nodes: StationDict, stations: StationDict
) -> dict[str, Any] | None:
    multi_coords: list[list[list[float]]] = []
    for pattern_data in patterns.values():
        coords = build_coordinate_sequence(pattern_data, segments, nodes, stations)
        if len(coords) >= 2:
            multi_coords.append([[lat, lon] for lat, lon in coords])
    return {"Type": "polyline", "Coords": multi_coords} if multi_coords else None


# ── Fantasy ───────────────────────────────────────────────────────────────────

def process_fantasy(
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
    modes:    ModeDict,
) -> Registry:
    """Fantasy patterns → registry with inline coordinate arrays."""
    entries = _collect_line_entries(lines, stations, nodes, segments, modes, "Fantasy")
    return _build_registry(entries, "LineFantasy")


# ── Present ───────────────────────────────────────────────────────────────────

def process_present(
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
    modes:    ModeDict,
) -> Registry:
    """Present-day patterns → registry with inline coordinate arrays."""
    entries = _collect_line_entries(lines, stations, nodes, segments, modes, "Present")
    return _build_registry(entries, "LinePresent")