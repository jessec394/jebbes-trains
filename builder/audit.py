"""Post-build audit: lists segments, stations and nodes no line pattern uses"""

from __future__ import annotations
from core.station_resolver import iter_patterns
from core.types import LinesDict, StationDict, SegmentDict, SegmentKey, StationKey

def report_unused(
    lines:    LinesDict,
    stations: StationDict,
    nodes:    StationDict,
    segments: SegmentDict,
) -> None:
    patterns = [p for *_, p in iter_patterns(lines)]
    line_roots: set[SegmentKey] = {p["Stations"] for p in patterns if p.get("Stations")}

    def collect_segments(seg_key: SegmentKey, visited: set[SegmentKey]) -> None:
        if seg_key in visited or seg_key not in segments: return
        visited.add(seg_key)
        seg_data = segments[seg_key]
        for component in ("F", "L", "R", "Keep"):
            for item in seg_data.get(component, []):
                clean: str = item[4:] if item.startswith(("[R] ", "[X] ")) else item
                for _, new in seg_data.get("Swap", []):
                    if new in segments: collect_segments(new, visited)

                collect_segments(clean, visited)

    reachable: set[SegmentKey] = set()
    for root in line_roots: collect_segments(root, reachable)

    def collect_stations(seg_key: SegmentKey, visited: set[SegmentKey], referenced: set[StationKey]) -> None:
        if seg_key in visited or seg_key not in segments: return
        visited.add(seg_key)
        seg_data = segments[seg_key]
        swap_map: dict[str, str] = {old: new for old, new in seg_data.get("Swap", []) if new not in segments}
        for component in ("F", "L", "R", "Keep", "Skip", "Drop"):
            for item in seg_data.get(component, []):
                base:  str = item[4:] if item.startswith(("[R] ", "[X] ")) else item
                clean: str = base[4:] if base.startswith("[X] ") else base
                if clean in segments:
                    collect_stations(clean, visited, referenced)
                else:
                    referenced.add(swap_map.get(clean, clean))

        for _, new in seg_data.get("Swap", []):
            if new not in segments: referenced.add(new)

    referenced_stations: set[StationKey] = set()
    for seg_key in reachable: collect_stations(seg_key, set(), referenced_stations)

    for pattern_data in patterns:                           # platforms a stop may alternatively use (a pattern's 'Alt')
        for group in pattern_data.get('Alt') or []: referenced_stations.update(group)

    sep: str = "-" * 52

    def _section(title: str, items: set[str]) -> None:
        if items:
            print(f"\n{sep}\n  {title} ({len(items)})\n{sep}")
            for item in sorted(items): print(f"  * {item}")
        else:
            print(f"\n  No {title.lower()}.")

    _section("UNUSED SEGMENTS", set(segments) - reachable)
    _section("UNUSED STATIONS", set(stations)  - referenced_stations)
    _section("UNUSED NODES",    set(nodes)      - referenced_stations)
    print()