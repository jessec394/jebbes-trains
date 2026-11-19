"""Writes the map data into the script block that starts the Leaflet frontend"""

from __future__ import annotations

import json
from core.types import (
    Registry, StationDict, ModeDict, ProjectsDict, BasemapNames,
)

class JsBridge:
    def __init__(
        self,
        registry_fantasy:    Registry,
        registry_present:    Registry,
        named_stations:      StationDict,
        all_nodes:           StationDict,
        modes:               ModeDict,
        map_name:            str,
        basemap_layer_names: BasemapNames,
        info_points:         ProjectsDict,
        destinations:        dict,
        leagues:             dict,
        detailed:            dict | None = None,   # the detailed map's own data (see MapBuilder): registry_fantasy / registry_present / named_stations / all_nodes / modes
    ) -> None:
        self.registry_fantasy:    Registry      = registry_fantasy
        self.registry_present:    Registry      = registry_present
        self.named_stations:      StationDict   = named_stations
        self.all_nodes:           StationDict   = all_nodes
        self.modes:               ModeDict      = modes
        self.map_name:            str           = map_name
        self.basemap_layer_names: BasemapNames  = basemap_layer_names
        self.info_points:         ProjectsDict  = info_points
        self.destinations:        dict          = destinations
        self.leagues:             dict          = leagues
        self.detailed:            dict | None   = detailed

    @staticmethod
    def _clean_station_name(key: str) -> str:
        """A station key without its [..], (..) or {..} suffix, for stations with no Label"""
        for sep in (' [', ' (', ' {'):
            idx = key.find(sep)
            if idx != -1: return key[:idx]

        return key

    @classmethod
    def _build_search_index(cls, named_stations: StationDict, registries: tuple) -> dict[str, dict]:
        index: dict[str, dict] = {
            key: {
                'Label': data.get('Label') or cls._clean_station_name(key),
                'Location': data.get('Location', [0, 0]),
                'Lines': [],
                # [city, subdivision, country code], optional; the code is also the flag file name
                **({'Region': list(data['Region'])} if data.get('Region') else {}),
            }
            for key, data in named_stations.items()
        }

        for registry in registries:
            for entry in registry:
                name:     str = entry.get('Name', '')
                operator: str = entry.get('Operator', '')
                color:    str = entry.get('Color', '#888')
                line_id:  str = entry.get('Id', '')
                for station_key in entry.get('AllLineStations', []):
                    if station_key not in index: continue
                    lines = index[station_key]['Lines']
                    if not any(l['Id'] == line_id for l in lines):   # by id: a line on both maps is one entry per map
                        lines.append({'Name': name, 'Operator': operator, 'Color': color, 'Id': line_id})

        return index

    def generate(self) -> str:
        search_index: dict[str, dict] = self._build_search_index(self.named_stations, (self.registry_fantasy, self.registry_present))
        d = self.detailed
        detailed_js = 'null' if not d else json.dumps({
            'Fantasy': d['registry_fantasy'], 'Present': d['registry_present'], 'Stations': d['named_stations'], 'Nodes': d['all_nodes'], 'Modes': d['modes'],
            'Search': self._build_search_index(d['named_stations'], (d['registry_fantasy'], d['registry_present'])),
            'FutureLabels': d.get('future_labels') or {}, 'Destinations': d.get('destinations'),
        })

        bl: BasemapNames = self.basemap_layer_names
        return f"""<script>
window.addEventListener('load', function() {{
    initializeMap(
        {json.dumps(self.map_name)},
        {json.dumps(self.registry_fantasy)},
        {json.dumps(self.registry_present)},
        {json.dumps(self.named_stations)},
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
        {json.dumps(self.leagues)},
        {detailed_js}
    );
}});
</script>"""