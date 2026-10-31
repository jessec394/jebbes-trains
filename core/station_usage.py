from __future__ import annotations
from core.station_resolver import build_station_sequence

CATEGORIES = ('Present', 'Fantasy')


def compute_station_usage(lines: dict, segments: dict) -> dict[str, set[str]]:
    """station_key -> subset of {'Present', 'Fantasy'}, derived purely from
    which patterns currently route through it. Nothing to keep in sync by
    hand: add a station to a Fantasy pattern's segment and it shows up
    Fantasy-scoped on the next load; remove it and it drops out. A station
    referenced by both a Present and a Fantasy pattern is automatically
    treated as the same shared record -- there is nothing to fork or
    duplicate unless the two lines are later pointed at different station
    keys entirely.
    """
    usage: dict[str, set[str]] = {}
    for op_lines in lines.values():
        for categories in op_lines.values():
            for category in CATEGORIES:
                for pattern_data in categories.get(category, {}).values():
                    for station_key in build_station_sequence(pattern_data, segments):
                        usage.setdefault(station_key, set()).add(category)
    return usage


def annotate_stations(flat_stations: dict, lines: dict, segments: dict) -> list[dict]:
    """Combine normalize_stations() output with computed usage into the
    list the frontend renders. 'Scope' is informational only -- it is
    recomputed on every load, never stored."""
    usage = compute_station_usage(lines, segments)
    out = []
    for key, data in flat_stations.items():
        loc = data.get('Location')
        if not loc:
            continue
        scope = usage.get(key, set())
        if scope == {'Present', 'Fantasy'}:
            scope_label = 'Both'
        elif scope == {'Present'}:
            scope_label = 'Present'
        elif scope == {'Fantasy'}:
            scope_label = 'Fantasy'
        else:
            scope_label = 'Unassigned'  # not (yet) referenced by any pattern
        out.append({
            'Key': key,
            'Label': data.get('Label', key),
            'Location': [loc[0], loc[1]],
            'Major': bool(data.get('Major', False)),
            'Scope': scope_label,
        })
    return sorted(out, key=lambda s: s['Label'].lower())
