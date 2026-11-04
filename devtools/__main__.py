"""python -m devtools <command>

  setup [--region R]      FIRST TIME: download the OSM extract, filter to rail, build the graph
  ingest <file.osm.pbf>   build the graph from an extract you already have
  update [file.osm.pbf]   fresh OSM data (downloads again unless a file is given): rebuild graph,
                          re-apply Future edits, re-route traces, write a report
  serve                   run the tracing UI at http://127.0.0.1:5057
  compile                 re-route every saved trace and rewrite data/tracks/geometry.json
  check                   show which Future edits need attention (uses the current graph)
  status                  what's built
"""
from __future__ import annotations
import argparse, sys


def _check_deps():
    missing = []
    for mod, pkg in (('osmium', 'osmium'), ('flask', 'flask')):
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        raise SystemExit(f"Missing packages: {', '.join(missing)}. Run the 'Tracer: Install dependencies' task "
                         f"(or: pip install -r devtools/requirements.txt)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='devtools', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    st = sub.add_parser('setup'); st.add_argument('--region', default='north-america',
        help="Geofabrik region, e.g. north-america (default) or north-america/us/new-york for a quick trial")
    for name in ('ingest', 'update'):
        p = sub.add_parser(name); p.add_argument('pbf', nargs='?' if name == 'update' else None)
        p.add_argument('--region', default='north-america')
        p.add_argument('--location-index', default='flex_mem')
    s = sub.add_parser('serve'); s.add_argument('--port', type=int, default=5057)
    s.add_argument('--host', default='127.0.0.1'); s.add_argument('--open', action='store_true', help='open the browser')
    for name in ('compile', 'check', 'status'):
        sub.add_parser(name)
    a = ap.parse_args(argv)

    if a.cmd == 'setup':
        _check_deps()
        from . import config
        from .fetch import download
        from .ingest import ingest
        import os
        if os.path.exists(config.GRAPH_DB):
            print("A graph already exists. To refresh it with new OSM data run the 'update' task instead.")
            return 0
        ingest(download(a.region))
        print("\nSetup done. Run the 'Tracer: Serve' task (or F5) to start tracing.")
    elif a.cmd == 'ingest':
        from .ingest import ingest
        ingest(a.pbf, location_index=a.location_index)
    elif a.cmd == 'update':
        from .updater import update
        from .fetch import download
        update(a.pbf or download(a.region, force=True), a.location_index)
    elif a.cmd == 'serve':
        from .server import create_app
        from .store import GraphStore
        try:
            GraphStore()
        except FileNotFoundError:
            print("No rail graph yet. Run the 'Tracer: First-time setup' task first.")
            return 1
        if a.open:
            import threading, webbrowser
            threading.Timer(1.0, lambda: webbrowser.open(f'http://{a.host}:{a.port}')).start()
        create_app().run(host=a.host, port=a.port, threaded=True)
    elif a.cmd == 'compile':
        from .tracks import TrackProject
        reps = TrackProject().compile_all()
        bad = [r for r in reps if not r['ok']]
        print(f"{len(reps)} routes compiled, {len(bad)} with problems")
    elif a.cmd == 'check':
        from .tracks import TrackProject
        from .updater import check_edits, save_report, load_report
        edits = check_edits(TrackProject())
        rep = load_report(); rep['edits'] = edits; save_report(rep)
        for e in edits:
            print(f"{e['status']:9} {e.get('id')} {e.get('name', '')}  {e.get('hint', '')}")
        print(f"{len(edits)} edits")
    elif a.cmd == 'status':
        from .store import GraphStore
        from . import config
        try:
            g = GraphStore()
            print(f"graph: {g.meta('source')}  {g.meta('edges')} edges  build {g.meta('build_id')}")
        except FileNotFoundError as e:
            print(e)
    return 0


if __name__ == '__main__':
    sys.exit(main())
