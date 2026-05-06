"""
Converts raw Lines/Stations/Nodes/Segments data into registry entries and JS
wiring strings the frontend needs.  Geometry is NO LONGER embedded into the
HTML — instead, file paths (for GeoJSON) and coordinate arrays (for Full
polylines) are stored in the registry and the browser fetches/renders them.
"""

from __future__ import annotations

import os
import json
from typing import Any

from core.station_resolver import build_station_sequence, build_coordinate_sequence
from core.route_analyzer   import analyze_route_structure, generate_route_diagram
from builder.types import (
    LinesDict, StationDict, SegmentDict, ModeDict, ModeSettings,
    Registry, RegistryEntry, LineMappingJs, PatternPayload,
    LineId, ModeId, Operator, LineName, StationKey, FilePath,
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
    geometry:          dict[str, Any],       # {"Type": "geojson", "Files": [...]} or {"Type": "polyline", "Coords": [...]}
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


# ── Fantasy — Detailed (GeoJSON file references) ──────────────────────────────

def process_detailed(
    lines:       LinesDict,
    stations:    StationDict,
    nodes:       StationDict,
    segments:    SegmentDict,
    modes:       ModeDict,
    routes_path: FilePath,
) -> tuple[Registry, LineMappingJs]:
    """Fantasy patterns with a File entry → registry with GeoJSON file paths."""
    z_order:  dict[ModeId, int] = _mode_z_order(modes)
    registry: Registry          = []

    entries: list[dict[str, Any]] = []
    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = {k: v for k, v in categories.get("Fantasy", {}).items() if v.get("File")}
            if not patterns:
                continue

            first:         Any          = next(iter(patterns.values()))
            mode_id:       ModeId       = first["Mode"]
            mode_settings: ModeSettings = modes.get(mode_id)

            all_line_stations, patterns_payload = _build_patterns_payload(
                patterns.items(), segments, stations, nodes, mode_settings
            )

            # Collect relative file paths (served as static assets alongside index.html)
            files: list[str] = []
            for pattern_data in patterns.values():
                fname = pattern_data.get('File', '')
                if fname:
                    files.append(f"data/routes_fantasy/{fname}.geojson")

            if files:
                entries.append(dict(
                    operator=operator, line_name=line_name,
                    mode_id=mode_id, mode_settings=mode_settings,
                    files=files, patterns_payload=patterns_payload,
                    all_line_stations=all_line_stations,
                    z_order=z_order.get(mode_id, 0),
                ))

    for ld in sorted(entries, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id("LineDetailed", ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
            {"Type": "geojson", "Files": ld['files']},
        ))

    return registry, ""


# ── Fantasy — Full (coordinate arrays) ───────────────────────────────────────

def process_full(
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
    modes:    ModeDict,
) -> tuple[Registry, LineMappingJs]:
    """Fantasy patterns → registry with inline coordinate arrays."""
    z_order:  dict[ModeId, int] = _mode_z_order(modes)
    registry: Registry          = []

    entries: list[dict[str, Any]] = []
    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = categories.get("Fantasy", {})
            if not patterns:
                continue

            first:         Any          = next(iter(patterns.values()))
            mode_id:       ModeId       = first["Mode"]
            mode_settings: ModeSettings = modes.get(mode_id)

            all_line_stations, patterns_payload = _build_patterns_payload(
                patterns.items(), segments, stations, nodes, mode_settings
            )

            multi_coords: list[list[list[float]]] = []
            for pattern_data in patterns.values():
                coords = build_coordinate_sequence(pattern_data, segments, nodes, stations)
                if len(coords) >= 2:
                    multi_coords.append([[lat, lon] for lat, lon in coords])

            if multi_coords:
                entries.append(dict(
                    operator=operator, line_name=line_name,
                    mode_id=mode_id, mode_settings=mode_settings,
                    multi_coords=multi_coords, patterns_payload=patterns_payload,
                    all_line_stations=all_line_stations,
                    z_order=z_order.get(mode_id, 0),
                ))

    for ld in sorted(entries, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id("LineFull", ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
            {"Type": "polyline", "Coords": ld['multi_coords']},
        ))

    return registry, ""


# ── Present (GeoJSON file references) ────────────────────────────────────────

def process_present(
    lines:       LinesDict,
    stations:    StationDict,
    nodes:       StationDict,
    segments:    SegmentDict,
    modes:       ModeDict,
    routes_path: FilePath,
) -> tuple[Registry, LineMappingJs]:
    """Present-day patterns → registry with GeoJSON file paths."""
    z_order:  dict[ModeId, int] = _mode_z_order(modes)
    registry: Registry          = []

    entries: list[dict[str, Any]] = []
    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = categories.get("Present", {})
            if not patterns:
                continue

            first:         Any          = next(iter(patterns.values()))
            mode_id:       ModeId       = first["Mode"]
            mode_settings: ModeSettings = modes.get(mode_id)

            all_line_stations, patterns_payload = _build_patterns_payload(
                patterns.items(), segments, stations, nodes, mode_settings
            )

            files: list[str] = []
            for pattern_data in patterns.values():
                fname = pattern_data.get('File', '')
                if fname:
                    files.append(f"data/routes_present/{fname}.geojson")

            if files:
                entries.append(dict(
                    operator=operator, line_name=line_name,
                    mode_id=mode_id, mode_settings=mode_settings,
                    files=files, patterns_payload=patterns_payload,
                    all_line_stations=all_line_stations,
                    z_order=z_order.get(mode_id, 0),
                ))

    for ld in sorted(entries, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id("LinePresent", ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
            {"Type": "geojson", "Files": ld['files']},
        ))

    return registry, ""