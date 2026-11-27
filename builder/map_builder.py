from __future__ import annotations

import json
import os
import folium

from builder.layer_processor import build_registry
from builder.js_bridge       import JsBridge
from builder.audit           import report_unused
from builder.region_outlines import build_splash_regions
from core                    import paths
from core.datafile           import load_namespace
from core.station_resolver   import normalize_stations
from core.traced             import load_geometry
from core.types import (
    LinesDict, StationDict, SegmentDict, ModeDict,
    ProjectsDict, Registry, BasemapNames, FilePath,
)

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
    """Breaks Jinja delimiters ({#, {%, {{) that minified CSS can produce"""
    for token in ('{#', '{%', '{{'): css = css.replace(token, token[0] + ' ' + token[1])
    return css

def _read_web(filename: str) -> str:
    with open(os.path.join(paths.WEB_DIR, filename), 'r', encoding='utf-8') as f:
        content = f.read()

    # Strip comments from shipped JS / CSS; the minifiers never rename identifiers
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

_IMAGE_EXT_ORDER = ('jpg', 'jpeg', 'png', 'webp', 'gif')     # same order map.js probes in

def _scan_images(images_path: FilePath) -> dict:
    """Every image under data/images with its real extension, so the page requests the right file"""
    dirs: list[str] = []
    files: dict[str, str] = {}
    if not os.path.isdir(images_path): return {'dirs': dirs, 'files': files}
    for root, _subdirs, names in os.walk(images_path):
        rel = os.path.relpath(root, images_path).replace(os.sep, '/')
        if rel == '.': continue
        dirs.append(rel)
        for f in names:
            stem, ext = os.path.splitext(f)
            ext = ext.lstrip('.')                      # keep the on-disk case: GitHub Pages is case-sensitive
            if ext.lower() not in _IMAGE_EXT_ORDER: continue
            key = f"{rel}/{stem}"
            if key not in files or _IMAGE_EXT_ORDER.index(ext.lower()) < _IMAGE_EXT_ORDER.index(files[key].lower()): files[key] = ext

    return {'dirs': sorted(dirs), 'files': files}

def _scan_leagues(sports_images_path: FilePath) -> dict[str, list[str]]:
    """League -> team names, read from the data/images/sports/<League>/ folders (files starting with _ are skipped)"""
    leagues: dict[str, list[str]] = {}
    if not sports_images_path or not os.path.isdir(sports_images_path): return leagues
    for league in sorted(os.listdir(sports_images_path)):
        league_dir = os.path.join(sports_images_path, league)
        if not os.path.isdir(league_dir): continue
        teams = sorted(
            os.path.splitext(f)[0] for f in os.listdir(league_dir)
            if not f.startswith('_') and os.path.splitext(f)[1].lower() in ('.webp', '.png', '.jpg', '.jpeg')
        )

        if teams: leagues[league] = teams

    return leagues

def _load_detailed() -> dict | None:
    """The detailed map's own stations / segments / lines / modes and its traced geometry, or None when it has nothing traced yet."""
    path = paths.DETAILED_FILE
    if not os.path.exists(path):
        print(f"[detailed] no detailed view: {path} does not exist"); return None

    try:        # the website must show exactly what the tracer shows: re-trace any route whose stored path is out of date (stops moved, track edited, ...)
        from devtools.tracks import TrackProject      # needs the tracer's rail graph; without it the stored paths are used as they are
        project = TrackProject(); project.station_path = path       # the stops of every pattern come from the detailed map
        project.sync_geometry(log=print)
    except Exception as e:
        print(f"[detailed] could not check that the traced routes are up to date ({type(e).__name__}: {e}); using the stored paths")

    traced = load_geometry()
    if not traced:
        print(f"[detailed] no detailed view: nothing is traced yet in {paths.GEOMETRY_FILE} (in the tracer: build the routes, then 'Refresh affected lines')"); return None

    ns = load_namespace(path)
    return {'lines': ns['Lines'], 'stations': ns['Stations'], 'nodes': ns['Nodes'], 'segments': ns['Segments'], 'modes': ns['Modes'], 'traced': traced,
            'destinations': ns.get('Destinations') or {}}

def _registries(lines, stations, nodes, segments, modes, traced=None, on_map=None) -> dict[str, Registry]:
    """{'Fantasy': registry, 'Present': registry}. on_map(category) -> the platform filter of that map (detailed map only)."""
    return {cat: build_registry(lines, stations, nodes, segments, modes, cat, traced, on_map(cat) if on_map else None)
            for cat in ('Fantasy', 'Present')}

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
        sports_images_path: FilePath = paths.SPORTS_DIR,
        regions_path:       FilePath = paths.REGIONS_DIR,
        detailed:           dict | None | str = 'auto',
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
        self.regions_path: FilePath       = regions_path
        self.splash_regions: dict         = {}
        # The detailed map is a separate map (data/detailed_map.py + its traced routes): nothing above is shared with it. 'auto' loads it when it exists.
        self.detailed: dict | None        = _load_detailed() if detailed == 'auto' else detailed

        self._map:                folium.Map | None = None
        self._registry_fantasy:   Registry          = []
        self._registry_present:   Registry          = []
        self._detailed_data:      dict | None       = None
        self._basemap_names:      BasemapNames       = {}

    def build(self) -> None:
        self._map = folium.Map(
            location=[39, -101], zoom_start=5,
            tiles=None, zoom_control=False, prefer_canvas=True,
        )

        self._add_tile_layers()
        self._process_layers()
        self.leagues = _scan_leagues(self.sports_images_path)
        self.splash_regions = build_splash_regions(
            self.regions_path, self.stations,
            registries={'Fantasy': self._registry_fantasy, 'Present': self._registry_present},
            modes=self.modes,
        )

        self._inject_frontend()

        report_unused(self.lines, self.stations, self.nodes, self.segments)

    def save(self, path: FilePath) -> None:
        self._map.save(path)

    def _add_tile_layers(self) -> None:
        layers: dict[str, folium.TileLayer] = {}
        for url, name, attr in BASEMAPS: layers[name] = folium.TileLayer(tiles=url, name=name, attr=attr, overlay=False, control=False)

        layers["Light"].add_to(self._map)
        layers["Dark"].add_to(self._map)
        layers["Satellite"].add_to(self._map)
        self._basemap_names = {name: layer.get_name() for name, layer in layers.items()}

    def _detailed_destinations(self, mine: dict) -> dict:
        """The simplified map's venues served by the detailed map's own stations and Present / Future settings"""
        out: dict = {}
        for cat, d in (self.destinations or {}).items():
            out[cat] = {}
            for name, v in d.items():
                o = (mine.get(cat) or {}).get(name) or {}
                pres, fut = list(o.get('Stations') or []), list(o.get('FutureStations') or [])
                nv = {**v, 'Stations': list(dict.fromkeys(pres + fut)), 'StationsByMode': {'Present': pres, 'Fantasy': fut}}      # each map has its own serving stations
                if 'Exists' in o: nv['Exists'] = list(o['Exists']); nv.pop('Present', None); nv.pop('Fantasy', None)
                out[cat][name] = nv

        return out

    def _process_layers(self) -> None:
        simple = _registries(self.lines, self.stations, self.nodes, self.segments, self.modes)
        self._registry_fantasy, self._registry_present = simple['Fantasy'], simple['Present']
        d = self.detailed
        if not d: return
        from devtools import availability as av
        only = av.load()
        def on_map(cat):        # a platform belongs to a map unless the tracer set it to the other map only (station setting, or its own)
            view = 'future' if cat == 'Fantasy' else 'present'
            def ok(key):
                stn, _, pl = key.partition(' {')
                return av.effective(only, stn, pl.rstrip('}') or None) in ('both', view)

            return ok

        st, nd = normalize_stations(d['stations']), normalize_stations(d['nodes'])
        reg = _registries(d['lines'], st, nd, d['segments'], d['modes'], d['traced'], on_map)
        fant, pres = reg['Fantasy'], reg['Present']
        print(f"[detailed] traced routes found; detailed lines: {len(fant)} Future, {len(pres)} Present")
        if not (fant or pres):
            print("[detailed] no detailed view: none of the traced routes matches a line in data/detailed_map.py (check the operator / line / pattern names)")
            return

        self._detailed_data = {'registry_fantasy': fant, 'registry_present': pres, 'named_stations': st, 'all_nodes': {**st, **nd}, 'modes': d['modes'],
                               'future_labels': av.future_names(), 'destinations': self._detailed_destinations(d.get('destinations') or {})}

    def _inject_frontend(self) -> None:
        all_nodes: StationDict = {**self.stations, **self.nodes}
        # The splash outlines must exist before map.js runs
        manifest: str = json.dumps(_scan_images(paths.IMAGES_DIR), separators=(',', ':')).replace('</', '<\\/')
        splash_regions_script: str = (f"<script>var SplashRegions = {json.dumps(self.splash_regions)};</script>"
                                      f"<script>var ImageManifest = {manifest};</script>")
        sidebar_html: str = (
            f"<style>\n{_read_web('styles.css')}\n</style>"
            + _read_web('template.html')
            + splash_regions_script
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
            detailed            = self._detailed_data,
        ).generate()

        self._map.get_root().html.add_child(folium.Element(sidebar_html + init_script))  # type: ignore[union-attr]