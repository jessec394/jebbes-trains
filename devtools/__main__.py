"""The tracer's command line: python -m devtools <command> (see -h)"""
from __future__ import annotations
import argparse, sys

REQUIRED = (('osmium', 'osmium'), ('flask', 'flask'))      # (module, pip package)
HELP = {
    'setup': 'first time: download the OSM extract, filter it to rail and build the graph',
    'ingest': 'build the graph from an extract you already have',
    'update': 'fresh OSM data: rebuild the graph, re-apply Future edits, re-route traces, write a report',
    'serve': 'run the tracing UI at http://127.0.0.1:5057',
    'compile': 're-route every saved trace and rewrite data/tracks/geometry.json',
    'check': 'show which Future edits need attention',
    'status': "what's built",
}

def missing_packages() -> list[str]:
    missing = []
    for mod, pkg in REQUIRED:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)

    return missing

def _check_deps():
    missing = missing_packages()
    if missing:
        raise SystemExit(f"Missing packages: {', '.join(missing)}. Run: pip install {' '.join(missing)}  (or start the tracer with tracer.py, which installs them)")

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='devtools', description="The tracer's command line")
    sub = ap.add_subparsers(dest='cmd', required=True)
    st = sub.add_parser('setup', help=HELP['setup']); st.add_argument('--region', default='north-america',
        help="Geofabrik region, e.g. north-america (default) or north-america/us/new-york for a quick trial")
    for name in ('ingest', 'update'):
        p = sub.add_parser(name, help=HELP[name]); p.add_argument('pbf', nargs='?' if name == 'update' else None)
        p.add_argument('--region', default='north-america')
        p.add_argument('--location-index', default='flex_mem')

    s = sub.add_parser('serve', help=HELP['serve']); s.add_argument('--port', type=int, default=5057)
    s.add_argument('--host', default='127.0.0.1'); s.add_argument('--open', action='store_true', help='open the browser')
    for name in ('compile', 'check', 'status'): sub.add_parser(name, help=HELP[name])
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

        import threading
        from werkzeug.serving import make_server, WSGIRequestHandler
        class KeepAlive(WSGIRequestHandler):
            protocol_version = 'HTTP/1.1'                # the browser reuses its connections instead of opening one per request

        app = create_app()
        servers = [make_server(a.host, a.port, app, threaded=True, request_handler=KeepAlive)]
        if a.host in ('127.0.0.1', 'localhost'):           # localhost (the map tiles' host name) resolves to ::1 first: answer there too, or every connection waits for the fallback
            try: servers.append(make_server('::1', a.port, app, threaded=True, request_handler=KeepAlive))
            except OSError: pass

        for s in servers[1:]: threading.Thread(target=s.serve_forever, daemon=True).start()
        print(f" * Tracer running at http://{a.host}:{a.port}", flush=True)
        servers[0].serve_forever()
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
        for e in edits: print(f"{e['status']:9} {e.get('id')} {e.get('name', '')}  {e.get('hint', '')}")
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

if __name__ == '__main__': sys.exit(main())