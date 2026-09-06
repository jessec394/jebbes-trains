"""
Serialises all Python-side map data into the <script> block that bootstraps
the Leaflet frontend.  Geometry is now in the registry (Geometry field) and
the browser creates Leaflet layers itself — no folium layer wiring needed.
"""

from __future__ import annotations

import json
from builder.types import (
    Registry, StationDict, ModeDict, ProjectsDict, BasemapNames,
)


class JsBridge:
    def __init__(
        self,
        registry_detailed:     Registry,
        registry_full:         Registry,
        registry_present:      Registry,
        registry_present_full: Registry,
        stations_detailed:     StationDict,
        all_nodes:             StationDict,
        modes:                 ModeDict,
        map_name:              str,
        basemap_layer_names:   BasemapNames,
        info_points:           ProjectsDict,
        destinations:          dict,
        leagues:               dict,
    ) -> None:
        self.registry_detailed:     Registry      = registry_detailed
        self.registry_full:         Registry      = registry_full
        self.registry_present:      Registry      = registry_present
        self.registry_present_full: Registry      = registry_present_full
        self.stations_detailed:     StationDict   = stations_detailed
        self.all_nodes:             StationDict   = all_nodes
        self.modes:                 ModeDict      = modes
        self.map_name:              str           = map_name
        self.basemap_layer_names:   BasemapNames  = basemap_layer_names
        self.info_points:           ProjectsDict = info_points
        self.destinations:          dict          = destinations
        self.leagues:               dict          = leagues

    @staticmethod
    def _clean_station_name(key: str) -> str:
        """
        Fallback display name for a station with no explicit 'Label'. Strips
        any trailing '[Sub]' (multi-platform grouping), '(Disambiguator)', or
        '{Disambiguator}' (same-named station at a different location) suffix
        from the raw key — that suffix is bookkeeping for the data, never
        meant to reach the user. Users tell stations apart by map position
        and serving lines, not by a suffix baked into an internal key.
        """
        for sep in (' [', ' (', ' {'):
            idx = key.find(sep)
            if idx != -1:
                return key[:idx]
        return key

    def _build_search_index(self) -> dict[str, dict]:
        index: dict[str, dict] = {
            key: {
                'Label': data.get('Label') or self._clean_station_name(key),
                'Location': data.get('Location', [0, 0]),
                'Lines': [],
            }
            for key, data in self.stations_detailed.items()
        }
        all_registries = (
            self.registry_detailed, self.registry_full,
            self.registry_present, self.registry_present_full,
        )
        for registry in all_registries:
            for entry in registry:
                name:     str = entry.get('Name', '')
                operator: str = entry.get('Operator', '')
                color:    str = entry.get('Color', '#888')
                line_id:  str = entry.get('Id', '')
                for station_key in entry.get('AllLineStations', []):
                    if station_key not in index:
                        continue
                    lines = index[station_key]['Lines']
                    if not any(l['Operator'] == operator and l['Name'] == name for l in lines):
                        lines.append({'Name': name, 'Operator': operator, 'Color': color, 'Id': line_id})
        return index

    def generate(self) -> str:
        search_index: dict[str, dict] = self._build_search_index()
        bl: BasemapNames = self.basemap_layer_names
        return f"""<script>
window.addEventListener('load', function() {{
    initializeMap(
        {json.dumps(self.map_name)},
        {json.dumps(self.registry_detailed)},
        {json.dumps(self.registry_full)},
        {json.dumps(self.registry_present)},
        {json.dumps(self.registry_present_full)},
        {json.dumps(self.stations_detailed)},
        {json.dumps(self.all_nodes)},
        {json.dumps(self.modes)},
        {{
            Light:     {bl.get('Light',     'null')},
            Dark:      {bl.get('Dark',      'null')},
            Satellite: {bl.get('Satellite', 'null')}
        }},
        {json.dumps(self.info_points)},
        {json.dumps(search_index)},
        {json.dumps(self.destinations)},
        {json.dumps(self.leagues)}
    );
}});
</script>"""