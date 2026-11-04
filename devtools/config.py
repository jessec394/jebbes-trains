"""Paths and tunables for the track tool.

Tracked in git (the real work):   data/tracks/{waypoints,edits,geometry}.json
Untracked (rebuildable, big):     devtools/cache/*   (graph DB, edit report)
"""
from __future__ import annotations
import os

ROOT       = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CACHE_DIR  = os.path.join(ROOT, 'devtools', 'cache')
STATIC_DIR = os.path.join(ROOT, 'devtools', 'static')
TRACK_DIR  = os.path.join(ROOT, 'data', 'tracks')

MAP_DATA_FILE = os.path.join(ROOT, 'data', 'map_data.py')
GRAPH_DB       = os.path.join(CACHE_DIR, 'rail.sqlite')
EDIT_REPORT    = os.path.join(CACHE_DIR, 'edit_report.json')
WAYPOINTS_FILE = os.path.join(TRACK_DIR, 'waypoints.json')
EDITS_FILE     = os.path.join(TRACK_DIR, 'edits.json')
GEOMETRY_FILE  = os.path.join(TRACK_DIR, 'geometry.json')

# railway=* values that become routable track.
RAIL_KINDS = {'rail', 'light_rail', 'subway', 'tram', 'narrow_gauge',
              'monorail', 'funicular', 'preserved', 'construction', 'proposed'}
# Track mapped in OSM / OpenRailwayMap as not yet built: part of the Future map's graph only (traceable, editable, parallel-able there).
FUTURE_KINDS = {'construction', 'proposed'}

# Routing is purely geometric: the shortest path between waypoints. No weights, penalties or prices of any kind.

SNAP_TOLERANCE_M   = 20.0    # (legacy) loose snapping distance
EDIT_ATTACH_M      = 3.0     # a drawn end connects to existing track only if it actually touches it (the editor snaps ends exactly); no invented stubs
BRIDGE_M           = 10.0    # a track END that does not quite touch other track still connects if the track lies within this distance roughly in line with it (a gap, or an overshoot);
                             # track alongside (parallel lanes) is never bridged to
REMOVE_TOLERANCE_M = 12.0    # a remove-line captures base edges lying within this
MAX_SNAP_M         = 2000.0  # waypoint further than this from any track = unroutable
OUTPUT_SIMPLIFY_M  = 0.4     # Douglas-Peucker tolerance for exported geometry
OUTPUT_DECIMALS    = 6