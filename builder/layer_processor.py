"""
Converts raw Lines/Stations/Nodes/Segments data into Leaflet layers added to a
folium Map, plus the registry entries and JS wiring strings the frontend needs.

Each public function follows the same contract:
    process_*(map_, lines, stations, nodes, segments, modes, routes_path?)
        -> tuple[Registry, LineMappingJs]

Layers are added to `map_` as a side-effect; the return values are pure data.
"""

from __future__ import annotations

import os
import json
from typing import Any
import folium

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


def _geojson_style(mode_settings: ModeSettings):  # type: ignore[return]
    ms = mode_settings
    return lambda x: {
        'color': ms['Color'], 'weight': ms['Weight'], 'opacity': 0.8,
        'lineJoin': 'round', 'lineCap': 'round', 'smoothFactor': 1.5,
    }


def _load_geojson_features(path: FilePath) -> list[dict[str, Any]]:
    if not path or not os.path.exists(path):
        return []
    with open(path, 'r') as f:
        data: dict[str, Any] = json.load(f)
    return data.get("features", [data]) if isinstance(data, dict) else [data]


def _build_patterns_payload(
    pattern_items: Any,
    segments:      SegmentDict,
    stations:      StationDict,
    nodes:         StationDict,
    mode_settings: ModeSettings,
) -> tuple[list[StationKey], list[PatternPayload]]:
    """
    Given an iterable of (pattern_name, pattern_data) pairs, returns
    (all_line_stations, patterns_payload).
    """
    all_stations: StationDict          = {**stations, **nodes}
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
    }


def _safe_line_id(prefix: str, operator: Operator, line_name: LineName) -> LineId:
    return f"{prefix}_{operator}_{line_name}".replace(" ", "_").replace("'", "")


# ── Fantasy — Detailed (GeoJSON geometry) ─────────────────────────────────────

def process_detailed(
    map_:       folium.Map,
    lines:      LinesDict,
    stations:   StationDict,
    nodes:      StationDict,
    segments:   SegmentDict,
    modes:      ModeDict,
    routes_path: FilePath,
) -> tuple[Registry, LineMappingJs]:
    """Fantasy patterns that have a File entry → GeoJSON layers."""
    z_order:  dict[ModeId, int] = _mode_z_order(modes)
    registry: Registry          = []
    js:       LineMappingJs     = ""

    layers_to_add: list[dict[str, Any]] = []
    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = {k: v for k, v in categories.get("Fantasy", {}).items() if v.get("File")}
            if not patterns:
                continue

            first:         Any          = next(iter(patterns.values()))
            mode_id:       ModeId       = first["Mode"]
            mode_settings: ModeSettings = modes.get(mode_id)
            features:      list[dict[str, Any]] = []

            all_line_stations, patterns_payload = _build_patterns_payload(
                patterns.items(), segments, stations, nodes, mode_settings
            )
            for pattern_data in patterns.values():
                features.extend(_load_geojson_features(
                    os.path.join(routes_path, f"{pattern_data.get('File', '')}.geojson")
                ))

            if features:
                layers_to_add.append(dict(
                    operator=operator, line_name=line_name,
                    mode_id=mode_id, mode_settings=mode_settings,
                    features=features, patterns_payload=patterns_payload,
                    all_line_stations=all_line_stations,
                    z_order=z_order.get(mode_id, 0),
                ))

    for ld in sorted(layers_to_add, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id("LineDetailed", ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        layer           = folium.GeoJson(
            {"type": "FeatureCollection", "features": ld['features']},
            style_function=_geojson_style(ld['mode_settings']),
            smooth_factor=1.5, interactive=True,
        ).add_to(map_)
        n: str = layer.get_name()
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
        ))
        js += (
            f"window['{line_id}']={n};{n}.setZIndex({z_index});"
            f"{n}.on('mouseover',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;"
            f"if(HR.find(X=>X.Id==='{line_id}'))return;HoverLine('{line_id}');}})."
            f"on('mouseout',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;"
            f"if(HR.find(X=>X.Id==='{line_id}'))return;UnhoverLine();}})."
            f"on('click',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;"
            f"if(HR.find(X=>X.Id==='{line_id}'))return;SelectLineFromMap('{line_id}');"
            f"L.DomEvent.stopPropagation(e)}});"
        )

    return registry, js


# ── Fantasy — Full (coordinate-based polylines) ───────────────────────────────

def process_full(
    map_:     folium.Map,
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
    modes:    ModeDict,
) -> tuple[Registry, LineMappingJs]:
    """Fantasy patterns → simplified PolyLine layers from coordinate sequences."""
    z_order:  dict[ModeId, int] = _mode_z_order(modes)
    registry: Registry          = []
    js:       LineMappingJs     = ""

    layers_to_add: list[dict[str, Any]] = []
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
                layers_to_add.append(dict(
                    operator=operator, line_name=line_name,
                    mode_id=mode_id, mode_settings=mode_settings,
                    multi_coords=multi_coords, patterns_payload=patterns_payload,
                    all_line_stations=all_line_stations,
                    z_order=z_order.get(mode_id, 0),
                ))

    for ld in sorted(layers_to_add, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id("LineFull", ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        layer           = folium.PolyLine(
            ld['multi_coords'],
            color=ld['mode_settings']['Color'],
            weight=ld['mode_settings']['Weight'],
            opacity=0.8, smooth_factor=1.5,
        ).add_to(map_)
        n: str = layer.get_name()
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
        ))
        js += (
            f"window['{line_id}']={n};"
            f"if({n}.setZIndex){{{n}.setZIndex({z_index});}}else{{{n}.options.pane='overlayPane';}}"
            f"{n}.on('mouseover',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;"
            f"if(HR.find(X=>X.Id==='{line_id}'))return;HoverLine('{line_id}');}})."
            f"on('mouseout',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;"
            f"if(HR.find(X=>X.Id==='{line_id}'))return;UnhoverLine();}})."
            f"on('click',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;"
            f"if(HR.find(X=>X.Id==='{line_id}'))return;SelectLineFromMap('{line_id}');"
            f"L.DomEvent.stopPropagation(e)}});"
        )

    return registry, js


# ── Present (GeoJSON geometry) ────────────────────────────────────────────────

def process_present(
    map_:        folium.Map,
    lines:       LinesDict,
    stations:    StationDict,
    nodes:       StationDict,
    segments:    SegmentDict,
    modes:       ModeDict,
    routes_path: FilePath,
) -> tuple[Registry, LineMappingJs]:
    """Present-day patterns → GeoJSON layers."""
    z_order:  dict[ModeId, int] = _mode_z_order(modes)
    registry: Registry          = []
    js:       LineMappingJs     = ""

    layers_to_add: list[dict[str, Any]] = []
    for operator, op_lines in lines.items():
        for line_name, categories in op_lines.items():
            patterns = categories.get("Present", {})
            if not patterns:
                continue

            first:         Any          = next(iter(patterns.values()))
            mode_id:       ModeId       = first["Mode"]
            mode_settings: ModeSettings = modes.get(mode_id)
            features:      list[dict[str, Any]] = []

            all_line_stations, patterns_payload = _build_patterns_payload(
                patterns.items(), segments, stations, nodes, mode_settings
            )
            for pattern_data in patterns.values():
                features.extend(_load_geojson_features(
                    os.path.join(routes_path, f"{pattern_data.get('File', '')}.geojson")
                    if pattern_data.get('File') else ''
                ))

            if features:
                layers_to_add.append(dict(
                    operator=operator, line_name=line_name,
                    mode_id=mode_id, mode_settings=mode_settings,
                    features=features, patterns_payload=patterns_payload,
                    all_line_stations=all_line_stations,
                    z_order=z_order.get(mode_id, 0),
                ))

    for ld in sorted(layers_to_add, key=lambda x: x['z_order']):
        line_id: LineId = _safe_line_id("LinePresent", ld['operator'], ld['line_name'])
        z_index: int    = ld['z_order'] * 100
        layer           = folium.GeoJson(
            {"type": "FeatureCollection", "features": ld['features']},
            style_function=_geojson_style(ld['mode_settings']),
            smooth_factor=1.5, interactive=True,
        ).add_to(map_)
        n: str = layer.get_name()
        registry.append(_registry_entry(
            line_id, ld['operator'], ld['line_name'],
            ld['mode_id'], ld['mode_settings'], z_index,
            ld['patterns_payload'], ld['all_line_stations'],
        ))
        js += (
            f"window['{line_id}']={n};{n}.setZIndex({z_index});"
            f"{n}.on('mouseover',e=>{{if(CurrentMapMode!=='Present')return;HoverLine('{line_id}');}})."
            f"on('mouseout',e=>{{if(CurrentMapMode!=='Present')return;UnhoverLine();}})."
            f"on('click',e=>{{if(CurrentMapMode!=='Present')return;SelectLineFromMap('{line_id}');"
            f"L.DomEvent.stopPropagation(e)}});"
        )

    return registry, js