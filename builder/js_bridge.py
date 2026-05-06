"""
Serialises all Python-side map data into the <script> block that bootstraps
the Leaflet frontend.  This is the only place where Python objects become JS.
"""

from __future__ import annotations

import json
from builder.types import (
    Registry, StationDict, ModeDict, WaypointsDict,
    LineMappingJs, BasemapNames,
)


class JsBridge:
    def __init__(
        self,
        registry_detailed:     Registry,
        registry_full:         Registry,
        registry_present:      Registry,
        stations_detailed:     StationDict,
        all_nodes:             StationDict,
        modes:                 ModeDict,
        map_name:              str,
        line_mapping_detailed: LineMappingJs,
        line_mapping_full:     LineMappingJs,
        line_mapping_present:  LineMappingJs,
        basemap_layer_names:   BasemapNames,
        info_points:           WaypointsDict,
    ) -> None:
        self.registry_detailed:     Registry      = registry_detailed
        self.registry_full:         Registry      = registry_full
        self.registry_present:      Registry      = registry_present
        self.stations_detailed:     StationDict   = stations_detailed
        self.all_nodes:             StationDict   = all_nodes
        self.modes:                 ModeDict      = modes
        self.map_name:              str           = map_name
        self.line_mapping_detailed: LineMappingJs = line_mapping_detailed
        self.line_mapping_full:     LineMappingJs = line_mapping_full
        self.line_mapping_present:  LineMappingJs = line_mapping_present
        self.basemap_layer_names:   BasemapNames  = basemap_layer_names
        self.info_points:           WaypointsDict = info_points

    def _build_search_index(self) -> dict[str, dict]:
        """
        Returns {stationKey: {Label, Location, Lines[]}} for every real station.
        Nodes (geometry waypoints) are excluded.
        Lines are de-duplicated across the three registries.
        """
        index: dict[str, dict] = {
            key: {'Label': data.get('Label', key), 'Location': data.get('Location', [0, 0]), 'Lines': []}
            for key, data in self.stations_detailed.items()
        }
        for registry in (self.registry_detailed, self.registry_full, self.registry_present):
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
        {json.dumps(self.stations_detailed)},
        {json.dumps(self.all_nodes)},
        {json.dumps(self.modes)},
        {{
            Light:     {bl.get('Light',     'null')},
            Dark:      {bl.get('Dark',      'null')},
            Satellite: {bl.get('Satellite', 'null')}
        }},
        `{self.line_mapping_detailed}`,
        `{self.line_mapping_full}`,
        `{self.line_mapping_present}`,
        {json.dumps(self.info_points)},
        {json.dumps(search_index)}
    );
}});
</script>"""