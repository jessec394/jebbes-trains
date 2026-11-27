"""Refresh everything the tracer reads from OpenStreetMap: open this file in VS Code and press Run (F5 / the play button)
It downloads the extract (FRESH), rebuilds the rail graph and its named stops, re-applies your Future edits, re-routes every trace and rebuilds the OSM platform outlines
Options: PBF = an .osm.pbf you already have (None: the one downloaded before, or a new download); FRESH = True downloads a new copy from Geofabrik first (new OSM mapping)
"""
PBF = None
REGION = 'north-america'
FRESH = False
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from devtools import config
from devtools.fetch import download

def main():
    pbf = PBF or download(REGION, force=FRESH)
    if os.path.exists(config.GRAPH_DB):             # a graph exists: rebuild it, re-apply the Future edits and re-route the traces
        from devtools.updater import update
        update(pbf)
    else:
        from devtools.ingest import ingest
        ingest(pbf)

    print('\nDone. Start the tracer (python tracer.py).')

if __name__ == '__main__':
    main()