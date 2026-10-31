"""Refresh the OSM base and re-apply everything built on top of it.

    python -m devtools update new-extract.osm.pbf

1. rebuilds the rail graph (the Present map)            -> swapped in atomically
2. rebuilds the Future map = new graph + data/tracks/edits.json
3. checks each edit against the new data:
     * add_track that real OSM track now covers   -> "now in OSM, delete this edit"
     * add_track whose ends no longer attach       -> "needs review"
     * remove_track that matches nothing anymore   -> "obsolete"
4. re-routes every saved trace on both maps and reports which geometries changed
Report -> devtools/cache/edit_report.json (also shown in the UI).
"""
from __future__ import annotations
import json, os, time

from . import config
from .geo import Pt, haversine, simplify


def edit_health(store, op: dict, tol_m: float = 10.0) -> dict:
    """Is an add_track edit now redundant because OSM mapped that track?"""
    if op.get('op') != 'add_track':
        return {}
    pts = [tuple(c) for c in op['coords']]
    samples: list[Pt] = []
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(haversine(a, b) / 40))
        samples += [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n)]
    samples.append(pts[-1])
    covered = sum(1 for p in samples if store.nearest(p, tol_m, 1))
    frac = covered / len(samples)
    return {'osm_coverage': round(frac, 2), 'now_in_osm': frac >= 0.9}


def check_edits(project) -> list[dict]:
    from .network import load_edits
    edits = load_edits()
    by_id = {e.get('id'): e for e in edits}
    out = []
    for r in project.future.report:
        r = dict(r)
        op = by_id.get(r.get('id'))
        r.update(edit_health(project.store, op) if op else {})
        if r.get('now_in_osm'):
            r['status'] = 'redundant'
            r['hint'] = 'OSM now maps this track; delete the edit so the real track is used.'
        elif not r.get('ok'):
            r['status'] = 'review'
            r['hint'] = ('Ends no longer attach to track; move the edit.' if r['op'] == 'add_track'
                         else 'Nothing left to remove here (OSM changed); delete the edit.')
        else:
            r['status'] = 'ok'
        out.append(r)
    return out


def update(pbf: str, location_index: str = 'flex_mem', log=print) -> dict:
    from .ingest import ingest
    from .store import GraphStore
    from .tracks import TrackProject
    before = None
    if os.path.exists(config.GRAPH_DB):
        before = GraphStore().meta('edges')
    ingest(pbf, config.GRAPH_DB, location_index=location_index, log=log)
    project = TrackProject(GraphStore())
    edits = check_edits(project)
    log("re-routing saved traces on both maps")
    routes = project.compile_all(log=log)
    report = {
        'when': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': os.path.basename(pbf),
        'edges_before': before, 'edges_after': project.store.meta('edges'),
        'edits': edits,
        'routes_changed': [r for r in routes if r.get('changed')],
        'routes_failed': [r for r in routes if not r['ok']],
        'routes_total': len(routes),
    }
    save_report(report)
    log(summary(report))
    return report


def save_report(report: dict) -> None:
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    with open(config.EDIT_REPORT, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=1)


def load_report() -> dict:
    try:
        with open(config.EDIT_REPORT, encoding='utf-8') as f:
            return json.load(f)
    except OSError:
        return {}


def summary(rep: dict) -> str:
    bad = [e for e in rep['edits'] if e['status'] != 'ok']
    lines = [f"update from {rep['source']}: {rep['routes_total']} routes re-routed, "
             f"{len(rep['routes_changed'])} changed, {len(rep['routes_failed'])} failed, "
             f"{len(bad)} of {len(rep['edits'])} edits need attention"]
    lines += [f"  edit {e.get('id')} ({e.get('name') or e['op']}): {e['hint']}" for e in bad]
    lines += [f"  changed: {r['operator']} / {r['line']} / {r['pattern']} [{r['category']}]"
              for r in rep['routes_changed']]
    return '\n'.join(lines)
