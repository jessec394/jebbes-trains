from __future__ import annotations

import os
import folium

from builder.layer_processor import process_detailed, process_full, process_present, process_present_full
from builder.js_bridge       import JsBridge
from builder.audit           import report_unused
from core.station_resolver   import normalize_stations
from builder.types import (
    LinesDict, StationDict, SegmentDict, ModeDict,
    ProjectsDict, Registry, BasemapNames, FilePath,
)

_WEB_DIR: FilePath = os.path.join(os.path.dirname(__file__), '..', 'web')
_SPORTS_IMAGES_DIR: FilePath = os.path.join(os.path.dirname(__file__), '..', 'data', 'images', 'sports')

CARTO_API_KEY: str = os.environ.get("CARTO_API_KEY", "")

if not CARTO_API_KEY:
    try:
        from builder.carto_key import CARTO_API_KEY
    except ImportError:
        pass

def _carto_url(style: str) -> str:
    base = f"https://{{s}}.basemaps.cartocdn.com/{style}/{{z}}/{{x}}/{{y}}{{r}}.png"
    return f"{base}?key={CARTO_API_KEY}" if CARTO_API_KEY else base

BASEMAPS: list[tuple[str, str, str]] = [
    (_carto_url("light_all"), "Light",     "&copy; CartoDB"),
    (_carto_url("dark_all"),  "Dark",      "&copy; CartoDB"),
    ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                                                                        "Satellite", "&copy; Esri"),
]

def _read_web(filename: str) -> str:
    with open(os.path.join(_WEB_DIR, filename), 'r', encoding='utf-8') as f:
        return f.read()

def _scan_leagues(sports_images_path: FilePath) -> dict[str, list[str]]:
    """Reads league -> team names straight off the data/images/sports/<League>/
    folder structure, so nothing needs hand-maintaining in map_data.py: drop a
    league folder in with its logos and it's immediately pickable. Each
    league's own logo (any leading-underscore file, e.g. '_Logo.webp') is
    skipped; every other image file's stem is treated as a team name."""
    leagues: dict[str, list[str]] = {}
    if not sports_images_path or not os.path.isdir(sports_images_path):
        return leagues
    for league in sorted(os.listdir(sports_images_path)):
        league_dir = os.path.join(sports_images_path, league)
        if not os.path.isdir(league_dir):
            continue
        teams = sorted(
            os.path.splitext(f)[0] for f in os.listdir(league_dir)
            if not f.startswith('_') and os.path.splitext(f)[1].lower() in ('.webp', '.png', '.jpg', '.jpeg')
        )
        if teams:
            leagues[league] = teams
    return leagues

class MapBuilder:
    def __init__(
        self,
        routes_path_fantasy: FilePath,
        routes_path_present: FilePath,
        lines:        LinesDict,
        stations:     StationDict,
        nodes:        StationDict,
        segments:     SegmentDict,
        modes:        ModeDict,
        projects:    ProjectsDict,
        destinations: dict,
        sports_images_path: FilePath = _SPORTS_IMAGES_DIR,
    ) -> None:
        self.lines:        LinesDict      = lines
        self.stations:     StationDict    = normalize_stations(stations)
        self.nodes:        StationDict    = normalize_stations(nodes)
        self.segments:     SegmentDict    = segments
        self.modes:        ModeDict       = modes
        self.projects:    ProjectsDict  = projects
        self.destinations: dict           = destinations
        self.sports_images_path: FilePath = sports_images_path
        self.leagues:      dict           = {}
        self.routes_fantasy: FilePath     = routes_path_fantasy
        self.routes_present: FilePath     = routes_path_present

        self._map:                   folium.Map | None = None
        self._registry_detailed:     Registry          = []
        self._registry_full:         Registry          = []
        self._registry_present:      Registry          = []
        self._registry_present_full: Registry          = []
        self._basemap_names:         BasemapNames       = {}

    def build(self) -> None:
        self._map = folium.Map(
            location=[39, -101], zoom_start=5,
            tiles=None, zoom_control=False, prefer_canvas=True,
        )

        self._add_tile_layers()
        self._process_layers()
        self.leagues = _scan_leagues(self.sports_images_path)
        self._inject_frontend()

        report_unused(self.lines, self.stations, self.nodes, self.segments)

    def save(self, path: FilePath) -> None:
        self._map.save(path)

    def _add_tile_layers(self) -> None:
        layers: dict[str, folium.TileLayer] = {}
        for url, name, attr in BASEMAPS:
            layers[name] = folium.TileLayer(tiles=url, name=name, attr=attr, overlay=False, control=False)

        layers["Light"].add_to(self._map)
        layers["Dark"].add_to(self._map)
        layers["Satellite"].add_to(self._map)
        self._basemap_names = {name: layer.get_name() for name, layer in layers.items()}

    def _process_layers(self) -> None:
        shared = (self.lines, self.stations, self.nodes, self.segments, self.modes)
        self._registry_detailed,     _ = process_detailed(*shared, self.routes_fantasy)
        self._registry_full,         _ = process_full(*shared)
        self._registry_present,      _ = process_present(*shared, self.routes_present)
        self._registry_present_full, _ = process_present_full(*shared)

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
            registry_present_full = self._registry_present_full,
            stations_detailed     = self.stations,
            all_nodes             = all_nodes,
            modes                 = self.modes,
            map_name              = self._map.get_name(),  # type: ignore[union-attr]
            basemap_layer_names   = self._basemap_names,
            info_points           = self.projects,
            destinations          = self.destinations,
            leagues               = self.leagues,
        ).generate()
        self._map.get_root().html.add_child(folium.Element(sidebar_html + init_script))  # type: ignore[union-attr]