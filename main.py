import os, sys

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from core import paths
from core.datafile import load_namespace
from builder.map_builder import MapBuilder
from builder import images

map_data = load_namespace(paths.SIMPLE_FILE)
destinations, projects = images.resolve(map_data['Destinations'], map_data['Projects'])

builder = MapBuilder(
    lines        = map_data['Lines'],
    stations     = map_data['Stations'],
    nodes        = map_data['Nodes'],
    segments     = map_data['Segments'],
    modes        = map_data['Modes'],
    projects     = projects,
    destinations = destinations,
)

builder.build()
builder.save(paths.OUTPUT_HTML)