"""What differs between the Present and Future map for a station or platform: data/tracks/availability.json, future_platforms.json, future_names.json"""
from __future__ import annotations
from core.fileio import read_json, write_json
from core.paths import AVAILABILITY_FILE as FILE, FUTURE_PLATFORMS_FILE as VERSIONS_FILE, FUTURE_NAMES_FILE as NAMES_FILE
from core.station_resolver import platform_key as key_of

FILES = (FILE, VERSIONS_FILE, NAMES_FILE)

def _read_map(path: str, field: str) -> dict:
    return read_json(path, {}).get(field, {})

def _write_map(path: str, field: str, d: dict) -> None:
    write_json(path, {field: dict(sorted(d.items()))})

# Which map a station / platform is on
def load() -> dict:
    return _read_map(FILE, 'only')

def effective(d: dict, station: str, platform: str | None) -> str:
    """'present' | 'future' | 'both' for a platform (platform=None: the station itself)."""
    return d.get(key_of(station, platform)) or d.get(station) or 'both'

def choose(station: str, platform: str | None, value: str) -> None:
    """Set the station's setting (platform=None: it applies to every platform, so their own settings are cleared), or one platform's own."""
    d = load(); value = value if value in ('present', 'future', 'both') else 'both'
    if platform is None:
        for k in [k for k in d if k.startswith(station + ' {')]: del d[k]
        if value == 'both': d.pop(station, None)
        else: d[station] = value
    else:
        k = key_of(station, platform)
        if value == d.get(station, 'both'): d.pop(k, None)               # the same as its station: nothing to override
        else: d[k] = value

    _write_map(FILE, 'only', d)

# Future versions of platforms
def platform_versions() -> dict:
    return _read_map(VERSIONS_FILE, 'overrides')

def _clean(fields: dict) -> dict:
    out = {}
    if fields.get('Location'): out['Location'] = [round(float(fields['Location'][0]), 6), round(float(fields['Location'][1]), 6)]
    if 'Span' in fields:
        sp = fields['Span']
        out['Span'] = [[round(float(p[0]), 6), round(float(p[1]), 6)] for p in sp[:2]] if sp else None

    return out

def set_platform_version(key: str, fields: dict) -> dict:
    d = platform_versions(); d[key] = {**d.get(key, {}), **_clean(fields)}
    _write_map(VERSIONS_FILE, 'overrides', d); return d[key]

def drop_platform_version(key: str) -> bool:
    d = platform_versions()
    if key not in d: return False
    del d[key]; _write_map(VERSIONS_FILE, 'overrides', d); return True

# Future names of stations
def future_names() -> dict:
    return _read_map(NAMES_FILE, 'names')

def set_future_name(station: str, name: str | None) -> None:
    """name blank / None: the Future map uses the station's usual name again."""
    d = future_names(); name = (name or '').strip()
    if name: d[station] = name
    else: d.pop(station, None)

    _write_map(NAMES_FILE, 'names', d)

# A deleted or renamed station takes everything written about it along
def drop_station(station: str, platform: str | None = None) -> None:
    """A deleted platform (platform=None: the whole station) takes its settings, Future versions and (whole station) Future name with it."""
    key = key_of(station, platform) if platform else None
    for path, field in ((FILE, 'only'), (VERSIONS_FILE, 'overrides')):
        d = _read_map(path, field)
        gone = [k for k in d if (k == station or k.startswith(station + ' {')) and (platform is None or k == key)]
        for k in gone: del d[k]
        if gone: _write_map(path, field, d)

    if platform is None:
        d = future_names()
        if d.pop(station, None) is not None: _write_map(NAMES_FILE, 'names', d)

def rename(mapping: dict, only: tuple = ('only', 'overrides', 'names')) -> None:
    """Renamed / merged stations carry their settings, Future versions and Future names; only picks which of the three"""
    for path, field in ((FILE, 'only'), (VERSIONS_FILE, 'overrides'), (NAMES_FILE, 'names')):
        if field not in only: continue
        d = _read_map(path, field); ch = False
        for old, new in mapping.items():
            if old in d and old != new:
                if new not in d: d[new] = d[old]
                del d[old]; ch = True

        if ch: _write_map(path, field, d)