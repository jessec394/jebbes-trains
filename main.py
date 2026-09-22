import os, sys, importlib.util

ROOT = os.path.abspath(os.path.dirname(__file__))
sys.path.insert(0, ROOT)

def _load(relative_path):
    path = os.path.join(ROOT, relative_path)
    spec = importlib.util.spec_from_file_location(relative_path, path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

map_data = _load('data/map_data.py')

from builder.map_builder import MapBuilder

DATA           = os.path.join(ROOT, 'data')
ROUTES_FANTASY = os.path.join(DATA, 'routes_fantasy')
ROUTES_PRESENT = os.path.join(DATA, 'routes_present')
OUTPUT_HTML    = os.path.join(ROOT, 'index.html')

builder = MapBuilder(
    routes_path_fantasy = ROUTES_FANTASY,
    routes_path_present = ROUTES_PRESENT,
    lines        = map_data.Lines,
    stations     = map_data.Stations,
    nodes        = map_data.Nodes,
    segments     = map_data.Segments,
    modes        = map_data.Modes,
    projects     = map_data.Projects,
    destinations = map_data.Destinations,
)

builder.build()
builder.save(OUTPUT_HTML)