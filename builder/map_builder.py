"""
Orchestrates the full map build pipeline:
  1. Create folium Map + tile layers
  2. Process each data layer (detailed, full, present) via layer_processor
  3. Inject the frontend HTML/CSS/JS via js_bridge
  4. Run the unused-data audit
"""

from __future__ import annotations

import os
import folium

from builder.layer_processor import process_detailed, process_full, process_present
from builder.js_bridge       import JsBridge
from builder.audit           import report_unused
from builder.types import (
    LinesDict, StationDict, SegmentDict, ModeDict,
    WaypointsDict, Registry, LineMappingJs, BasemapNames, FilePath,
)

_WEB_DIR: FilePath = os.path.join(os.path.dirname(__file__), '..', 'web')

BASEMAPS: list[tuple[str, str, str]] = [
    ("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", "Light",     "&copy; CartoDB"),
    ("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",  "Dark",      "&copy; CartoDB"),
    ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                                                                        "Satellite", "&copy; Esri"),
]


def _read_web(filename: str) -> str:
    with open(os.path.join(_WEB_DIR, filename), 'r', encoding='utf-8') as f:
        return f.read()


class MapBuilder:
    def __init__(
        self,
        routes_path_fantasy: FilePath,
        routes_path_present: FilePath,
        lines:     LinesDict,
        stations:  StationDict,
        nodes:     StationDict,
        segments:  SegmentDict,
        modes:     ModeDict,
        waypoints: WaypointsDict,
    ) -> None:
        self.lines:    LinesDict      = lines
        self.stations: StationDict    = stations
        self.nodes:    StationDict    = nodes
        self.segments: SegmentDict    = segments
        self.modes:    ModeDict       = modes
        self.waypoints: WaypointsDict = waypoints
        self.routes_fantasy: FilePath = routes_path_fantasy
        self.routes_present: FilePath = routes_path_present

        self._map:               folium.Map | None = None
        self._registry_detailed: Registry          = []
        self._registry_full:     Registry          = []
        self._registry_present:  Registry          = []
        self._js_detailed:       LineMappingJs      = ""
        self._js_full:           LineMappingJs      = ""
        self._js_present:        LineMappingJs      = ""
        self._basemap_names:     BasemapNames       = {}

    def build(self) -> None:
        self._map = folium.Map(
            location=[39, -101], zoom_start=5,
            tiles=None, zoom_control=False, prefer_canvas=True,
        )
        self._add_tile_layers()
        self._process_layers()
        self._inject_frontend()
        report_unused(self.lines, self.stations, self.nodes, self.segments)

    def save(self, path: FilePath) -> None:
        self._map.save(path)  # type: ignore[union-attr]

    def _add_tile_layers(self) -> None:
        layers: dict[str, folium.TileLayer] = {}
        for url, name, attr in BASEMAPS:
            layers[name] = folium.TileLayer(tiles=url, name=name, attr=attr, overlay=False, control=False)
        layers["Light"].add_to(self._map)
        layers["Dark"].add_to(self._map)
        layers["Satellite"].add_to(self._map)
        self._basemap_names = {name: layer.get_name() for name, layer in layers.items()}

    def _process_layers(self) -> None:
        shared = (self._map, self.lines, self.stations, self.nodes, self.segments, self.modes)
        self._registry_detailed, self._js_detailed = process_detailed(*shared, self.routes_fantasy)
        self._registry_full,     self._js_full     = process_full(*shared)
        self._registry_present,  self._js_present  = process_present(*shared, self.routes_present)

    def _inject_frontend(self) -> None:
        all_nodes: StationDict = {**self.stations, **self.nodes}
        sidebar_html: str = (
            f"<style>\n{_read_web('styles.css')}\n</style>"
            + _read_web('template.html')
            + f"<script>\n{_read_web('map.js')}\n</script>"
        )
        init_script: str = JsBridge(
            registry_detailed     = self._registry_detailed,
            registry_full         = self._registry_full,
            registry_present      = self._registry_present,
            stations_detailed     = self.stations,
            all_nodes             = all_nodes,
            modes                 = self.modes,
            map_name              = self._map.get_name(),  # type: ignore[union-attr]
            line_mapping_detailed = self._js_detailed,
            line_mapping_full     = self._js_full,
            line_mapping_present  = self._js_present,
            basemap_layer_names   = self._basemap_names,
            info_points           = self.waypoints,
        ).generate()
        self._map.get_root().html.add_child(folium.Element(sidebar_html + init_script))  # type: ignore[union-attr]