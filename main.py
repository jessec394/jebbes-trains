import os, sys

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from core import paths
from core.datafile import load_namespace
from builder.map_builder import MapBuilder

map_data = load_namespace(paths.SIMPLE_FILE)

builder = MapBuilder(
    lines        = map_data['Lines'],
    stations     = map_data['Stations'],
    nodes        = map_data['Nodes'],
    segments     = map_data['Segments'],
    modes        = map_data['Modes'],
    projects     = map_data['Projects'],
    destinations = map_data['Destinations'],
)

builder.build()
builder.save(paths.OUTPUT_HTML)