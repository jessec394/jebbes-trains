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
    def _extra_nodes(named: StationDict, all_nodes: StationDict) -> StationDict:
        """What all_nodes has beyond the named stations (the page puts the two back together, so the stations are not sent twice)"""
        return {k: v for k, v in all_nodes.items() if k not in named or named[k] != v}

    def generate(self) -> str:
        d = self.detailed
        detailed_js = 'null' if not d else json.dumps({
            'Fantasy': d['registry_fantasy'], 'Present': d['registry_present'], 'Stations': d['named_stations'], 'Nodes': self._extra_nodes(d['named_stations'], d['all_nodes']), 'Modes': d['modes'],
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
        {json.dumps(self._extra_nodes(self.named_stations, self.all_nodes))},
        {json.dumps(self.modes)},
        {{
            Light:     {bl.get('Light',     'null')},
            Dark:      {bl.get('Dark',      'null')},
            Satellite: {bl.get('Satellite', 'null')}
        }},
        {json.dumps(self.info_points)},
        {json.dumps(self.destinations)},
        {json.dumps(self.leagues)},
        {detailed_js}
    );
}});
</script>"""