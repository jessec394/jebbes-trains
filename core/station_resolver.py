"""
Resolves segment/station definitions into flat ordered lists of station keys
or coordinate pairs.  Pure logic — no I/O, no Leaflet, no data imports.
"""

from __future__ import annotations
from typing import Any
from builder.types import (
    StationKey, SegmentKey, SegmentDict, StationDict,
    LatLon, CoordSequence, PatternData,
)


def resolve_path(
    item:             str,
    segments:         SegmentDict,
    filter_non_stops: bool = False,
) -> list[StationKey]:
    is_reverse: bool = item.startswith("[R] ")
    lookup_key: str  = item[4:] if is_reverse else item

    if lookup_key in segments:
        segment_data = segments[lookup_key]
        path: list[StationKey] = []
        combined: list[str] = (
            segment_data.get("F", []) +
            segment_data.get("L", []) +
            segment_data.get("R", [])
        )
        for sub_item in combined:
            for station in resolve_path(sub_item, segments, filter_non_stops):
                if not path or path[-1] != station:
                    path.append(station)
        if is_reverse:
            path.reverse()
        if filter_non_stops:
            path = [s[4:] if s.startswith("[X] ") else s for s in path]
            path = [s for s in path if not s.startswith("[X] ")]
        return path

    if filter_non_stops and lookup_key.startswith("[X] "):
        return []
    return [lookup_key[4:] if filter_non_stops and lookup_key.startswith("[X] ") else lookup_key]


def _get_segment_final_sequence(
    segment_key:       SegmentKey,
    segments:          SegmentDict,
    _visited:          set[SegmentKey] | None = None,
    _segment_swap_map: dict[str, str]  | None = None,
) -> list[StationKey]:
    if _visited is None:          _visited          = set()
    if _segment_swap_map is None: _segment_swap_map = {}

    if segment_key in _visited or segment_key not in segments:
        return []

    _visited.add(segment_key)
    segment_data: dict[str, Any]   = segments[segment_key]
    global_skips: set[StationKey]  = set()
    seg_swap_map:    dict[str, str] = dict(_segment_swap_map)
    station_swap_map: dict[str, str] = {}

    for old, new in segment_data.get("Swap", []):
        if new in segments: seg_swap_map[old]     = new
        else:               station_swap_map[old] = new

    def expand(item: str) -> list[StationKey]:
        is_rev:   bool = item.startswith("[R] ")
        base:     str  = item[4:] if is_rev else item
        if base.startswith("[X] "):
            global_skips.add(base[4:])
        clean:    str  = base[4:] if base.startswith("[X] ") else base
        resolved: str  = seg_swap_map.get(clean, clean)
        if resolved in segments:
            inner_swap = {k: v for k, v in seg_swap_map.items() if k != clean}
            sub = _get_segment_final_sequence(resolved, segments, _visited.copy(), inner_swap)
            return list(reversed(sub)) if is_rev else sub
        return [resolved]

    def raw_path(key: str) -> list[StationKey]:
        path: list[StationKey] = []
        for item in segment_data.get(key, []):
            for station in expand(item):
                if not path or path[-1] != station:
                    path.append(station)
        return path

    f_path = raw_path("F")
    l_path = raw_path("L")
    r_path = raw_path("R")

    if   f_path and l_path and r_path: base = f_path + l_path + r_path
    elif f_path and r_path:            base = f_path + r_path
    elif f_path and l_path:            base = f_path + l_path + list(reversed(f_path))
    elif f_path:                       base = f_path
    elif l_path:
        base = l_path
        if base and base[0] != base[-1]:
            base.append(base[0])
    else:
        base = []

    sequence: list[StationKey]
    if "Keep" in segment_data:
        sequence = _apply_stops_filter(segment_data["Keep"], segments, base)
    else:
        sequence = []
        for s in base:
            if not sequence or sequence[-1] != s:
                sequence.append(s)

    for skip in segment_data.get("Skip", []) + segment_data.get("Drop", []):
        global_skips.add(skip[4:] if skip.startswith(("[X] ", "[R] ")) else skip)

    sequence = [s for s in sequence if s not in global_skips]
    if station_swap_map:
        sequence = [station_swap_map.get(s, s) for s in sequence]
    return sequence


def _apply_stops_filter(
    stops_array:   list[str],
    segments:      SegmentDict,
    base_sequence: list[StationKey],
) -> list[StationKey]:
    allowed: list[StationKey] = []
    for item in stops_array:
        is_rev: bool = item.startswith("[R] ")
        base:   str  = item[4:] if is_rev else item
        clean:  str  = base[4:] if base.startswith("[X] ") else base
        if clean in segments:
            sub = _get_segment_final_sequence(clean, segments)
            allowed.extend(reversed(sub) if is_rev else sub)
        else:
            allowed.append(clean)

    allowed_set: set[StationKey] = set(allowed)
    filtered:    list[StationKey] = [s for s in base_sequence if s in allowed_set]
    final: list[StationKey] = []
    for s in filtered:
        if not final or final[-1] != s:
            final.append(s)
    return final


def build_station_sequence(
    pattern_data:     PatternData,
    segments:         SegmentDict,
    filter_non_stops: bool = False,
) -> list[StationKey]:
    seg_key: str | None = pattern_data.get("Stations")
    if not seg_key or seg_key not in segments:
        return []
    return _get_segment_final_sequence(seg_key, segments)


def build_coordinate_sequence(
    pattern_data: PatternData,
    segments:     SegmentDict,
    nodes:        StationDict,
    stations:     StationDict | None = None,
) -> CoordSequence:
    if stations is None:
        stations = {}

    seg_key: str | None = pattern_data.get("Stations")
    if not seg_key or seg_key not in segments:
        return []

    seg_data:     dict[str, Any]  = segments[seg_key]
    root_swaps:   list[Any]       = seg_data.get("Swap", [])
    swap_map:     dict[str, str]  = {old: new for old, new in root_swaps if new not in segments}
    seg_swap_map: dict[str, str]  = {old: new for old, new in root_swaps if new in segments}
    drop_set:     set[str]        = {
        d[4:] if d.startswith(("[X] ", "[R] ")) else d
        for d in seg_data.get("Drop", [])
    }

    def resolve_coords(
        item:            str,
        depth:           int = 0,
        active_swap:     dict[str, str] | None = None,
        active_drop:     set[str]       | None = None,
        active_seg_swap: dict[str, str] | None = None,
    ) -> CoordSequence:
        if active_swap     is None: active_swap     = swap_map
        if active_drop     is None: active_drop     = drop_set
        if active_seg_swap is None: active_seg_swap = seg_swap_map

        is_rev: bool = item.startswith("[R] ")
        key:    str  = item[4:] if is_rev else item
        if key.startswith("[X] "):
            key = key[4:]
        key = active_seg_swap.get(key, key)

        if key in segments:
            sub_data = segments[key]
            merged_swap:     dict[str, str] = dict(active_swap)
            merged_seg_swap: dict[str, str] = dict(active_seg_swap)
            for old, new in sub_data.get("Swap", []):
                if new in segments: merged_seg_swap[old] = new
                else:               merged_swap[old]     = new
            merged_drop: set[str] = set(active_drop)
            for d in sub_data.get("Drop", []):
                merged_drop.add(d[4:] if d.startswith(("[X] ", "[R] ")) else d)
            coords: CoordSequence = []
            for sub in sub_data.get("F", []) + sub_data.get("L", []) + sub_data.get("R", []):
                for coord in resolve_coords(sub, depth + 1, merged_swap, merged_drop, merged_seg_swap):
                    if not coords or coords[-1] != coord:
                        coords.append(coord)
            return list(reversed(coords)) if is_rev else coords

        if key in active_drop:
            return []
        name: str = active_swap.get(key, key)
        if name in stations: loc: LatLon = stations[name]['Location']
        elif name in nodes:  loc          = nodes[name]['Location']
        else:                return []
        return [loc]

    def coords_from(component_key: str) -> CoordSequence:
        coords: CoordSequence = []
        for item in seg_data.get(component_key, []):
            for coord in resolve_coords(item):
                if not coords or coords[-1] != coord:
                    coords.append(coord)
        return coords

    f = coords_from("F") if "F" in seg_data else []
    l = coords_from("L") if "L" in seg_data else []
    r = coords_from("R") if "R" in seg_data else []

    if   f and l and r: final: CoordSequence = f + l + r
    elif f and r:        final               = f + r
    elif f and l:        final               = f + l + list(reversed(f))
    elif f:              final               = f + list(reversed(f))
    elif l:
        final = l
        if final and final[0] != final[-1]:
            final.append(final[0])
    else:
        final = []

    cleaned: CoordSequence = []
    for c in final:
        if not cleaned or cleaned[-1] != c:
            cleaned.append(c)
    return cleaned