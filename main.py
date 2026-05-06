"""
---context:global
assign   straight_line_costfactor  = 10000
assign   allow_steps               = true
assign   allow_ferries             = false

---context:way

assign is_monorail    = railway=monorail
assign is_metro       = railway=subway
assign is_heavy_rail  = railway=rail
assign is_tram        = railway=tram
assign is_lrt         = railway=light_rail
assign is_funicular   = railway=funicular
assign is_narrow      = railway=narrow_gauge

assign is_any_rail = if is_monorail then true
                     else if is_metro then true
                     else if is_lrt then true
                     else if is_tram then true
                     else if is_heavy_rail then true
                     else if is_funicular then true
                     else if is_narrow then true
                     else false

assign costfactor     = if is_any_rail then 1.0 else 9999.0
assign access_allowed = if is_any_rail then true else false

---context:node
assign defaultnodecost = 0
"""

import os, sys, importlib.util

ROOT = os.path.abspath(os.path.dirname(__file__))
sys.path.insert(0, ROOT)

def _load(relative_path):
    path = os.path.join(ROOT, relative_path)
    spec = importlib.util.spec_from_file_location(relative_path, path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

map_data   = _load('data/map_data.py')
props      = _load('data/properties.py')
waypoints  = _load('data/waypoints.py')

from builder.map_builder import MapBuilder

DATA           = os.path.join(ROOT, 'data')
ROUTES_FANTASY = os.path.join(DATA, 'routes_fantasy')
ROUTES_PRESENT = os.path.join(DATA, 'routes_present')
OUTPUT_HTML    = os.path.join(ROOT, 'index.html')

builder = MapBuilder(
    routes_path_fantasy = ROUTES_FANTASY,
    routes_path_present = ROUTES_PRESENT,
    lines     = map_data.Lines,
    stations  = map_data.Stations,
    nodes     = map_data.Nodes,
    segments  = map_data.Segments,
    modes     = props.Modes,
    waypoints = waypoints.Waypoints,
)
builder.build()
builder.save(OUTPUT_HTML)