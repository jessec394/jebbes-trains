from __future__ import annotations

import os
import folium

from builder.layer_processor import process_fantasy, process_present
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

def _jinja_safe_css(css: str) -> str:
    """Minified CSS can accidentally produce Jinja2's opening delimiters --
    most commonly `@media (...) {` immediately followed by an id selector,
    which collapses to `{#`, Jinja's comment-open token. folium renders this
    payload through Jinja, so it would swallow the rest of the stylesheet
    looking for a matching `#}`. Re-inserting one space breaks the token
    without changing what the CSS means."""
    for token in ('{#', '{%', '{{'):
        css = css.replace(token, token[0] + ' ' + token[1])
    return css

def _read_web(filename: str) -> str:
    with open(os.path.join(_WEB_DIR, filename), 'r', encoding='utf-8') as f:
        content = f.read()

    # Strip comments (and collapse incidental whitespace) before this ever
    # reaches a shipped page -- comments explaining "why" are for us, not for
    # anyone opening dev tools on the live site. rjsmin/rcssmin are safe here:
    # they only remove comments/whitespace, never rename identifiers, so every
    # onclick="FunctionName()" reference in the HTML keeps resolving correctly.
    if filename.endswith('.js'):
        try:
            import rjsmin
            return rjsmin.jsmin(content)
        except ImportError:
            print("Note: `pip install rjsmin` to strip JS comments from the shipped page.")
    elif filename.endswith('.css'):
        try:
            import rcssmin
            return _jinja_safe_css(rcssmin.cssmin(content))
        except ImportError:
            print("Note: `pip install rcssmin` to strip CSS comments from the shipped page.")
    return content

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

        self._map:                folium.Map | None = None
        self._registry_fantasy:   Registry          = []
        self._registry_present:   Registry          = []
        self._basemap_names:      BasemapNames       = {}

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
        self._registry_fantasy = process_fantasy(*shared)
        self._registry_present = process_present(*shared)

    def _inject_frontend(self) -> None:
        all_nodes: StationDict = {**self.stations, **self.nodes}
        sidebar_html: str = (
            f"<style>\n{_read_web('styles.css')}\n</style>"
            + _read_web('template.html')
            + f"<script>\n{_read_web('map.js')}\n</script>"
        )

        init_script: str = JsBridge(
            registry_fantasy    = self._registry_fantasy,
            registry_present    = self._registry_present,
            named_stations      = self.stations,
            all_nodes           = all_nodes,
            modes               = self.modes,
            map_name            = self._map.get_name(),  # type: ignore[union-attr]
            basemap_layer_names = self._basemap_names,
            info_points         = self.projects,
            destinations        = self.destinations,
            leagues             = self.leagues,
        ).generate()
        self._map.get_root().html.add_child(folium.Element(sidebar_html + init_script))  # type: ignore[union-attr]