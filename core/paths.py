"""Every file and folder the website build and the tracer share"""
from __future__ import annotations
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

DATA_DIR    = os.path.join(ROOT, 'data')
IMAGES_DIR  = os.path.join(DATA_DIR, 'images')
SPORTS_DIR  = os.path.join(IMAGES_DIR, 'sports')
REGIONS_DIR = os.path.join(DATA_DIR, 'regions')
TRACK_DIR   = os.path.join(DATA_DIR, 'tracks')
WEB_DIR     = os.path.join(ROOT, 'web')
OUTPUT_HTML = os.path.join(ROOT, 'index.html')

SIMPLE_FILE   = os.path.join(DATA_DIR, 'map_data.py')        # the simplified map (the blueprint)
DETAILED_FILE = os.path.join(DATA_DIR, 'detailed_map.py')    # the detailed map: its own stations, segments and lines

WAYPOINTS_FILE   = os.path.join(TRACK_DIR, 'waypoints.json')
EDITS_FILE       = os.path.join(TRACK_DIR, 'edits.json')
GEOMETRY_FILE    = os.path.join(TRACK_DIR, 'geometry.json')
DIRECTIONS_FILE  = os.path.join(TRACK_DIR, 'directions.json')
AVAILABILITY_FILE     = os.path.join(TRACK_DIR, 'availability.json')
FUTURE_PLATFORMS_FILE = os.path.join(TRACK_DIR, 'future_platforms.json')
FUTURE_NAMES_FILE     = os.path.join(TRACK_DIR, 'future_names.json')

DEVTOOLS_DIR = os.path.join(ROOT, 'devtools')
CACHE_DIR    = os.path.join(DEVTOOLS_DIR, 'cache')
STATIC_DIR   = os.path.join(DEVTOOLS_DIR, 'static')