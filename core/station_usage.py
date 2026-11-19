from __future__ import annotations
from core.station_resolver import build_station_sequence, iter_patterns

def compute_station_usage(lines: dict, segments: dict) -> dict[str, set[str]]:
    """station key -> subset of {'Present', 'Fantasy'}, from the patterns (and their Alt platforms) using it"""
    usage: dict[str, set[str]] = {}
    for _op, _line, category, _name, pattern_data in iter_patterns(lines):
        for station_key in build_station_sequence(pattern_data, segments): usage.setdefault(station_key, set()).add(category)
        for group in pattern_data.get('Alt') or []:
            for station_key in group: usage.setdefault(station_key, set()).add(category)

    return usage