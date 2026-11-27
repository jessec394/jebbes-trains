"""Tunables for the track tool. File locations are shared with the website build: see core/paths.py."""
from __future__ import annotations
import os

from core.paths import (ROOT, CACHE_DIR, STATIC_DIR, TRACK_DIR, SIMPLE_FILE, DETAILED_FILE,
                        WAYPOINTS_FILE, EDITS_FILE, GEOMETRY_FILE, DIRECTIONS_FILE)

GRAPH_DB    = os.path.join(CACHE_DIR, 'rail.sqlite')
EDIT_REPORT = os.path.join(CACHE_DIR, 'edit_report.json')

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