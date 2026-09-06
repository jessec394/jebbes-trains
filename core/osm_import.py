from __future__ import annotations
import json, os, hashlib, datetime

# pip install osmium --break-system-packages
import osmium

RAIL_VALUES = {'rail', 'light_rail', 'subway', 'tram', 'monorail', 'funicular'}
SKIP_SERVICE = {'yard', 'spur', 'siding'}


class _RailwayHandler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways: list[dict] = []

    def way(self, w):
        tags = w.tags
        rw = tags.get('railway')
        if rw not in RAIL_VALUES:
            return
        if tags.get('service') in SKIP_SERVICE:
            return
        if tags.get('disused') == 'yes' or tags.get('abandoned') == 'yes':
            return
        try:
            coords = [[n.lon, n.lat] for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(coords) < 2:
            return
        self.ways.append({
            'way_id': str(w.id),
            'coords': coords,
            'tags': {
                'railway': rw,
                'name': tags.get('name', ''),
                'operator': tags.get('operator', ''),
                'electrified': tags.get('electrified', ''),
                'gauge': tags.get('gauge', ''),
            },
        })


def region_id_for(name: str) -> str:
    """Stable id from the region NAME (not bbox) so re-importing the same
    named region -- even with a slightly adjusted bbox -- overwrites its
    old rows instead of creating a duplicate region."""
    return hashlib.sha1(name.strip().lower().encode()).hexdigest()[:12]


def load_regions(data_dir: str) -> dict:
    path = os.path.join(data_dir, 'orm_cache', 'regions.json')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def import_region(pbf_path: str, name: str, bbox: tuple[float, float, float, float],
                   cache_dir: str) -> dict:
    """One-time or refresh import of a named, bounded region from a local
    .osm.pbf extract (e.g. a Geofabrik regional extract).

    bbox = (min_lon, min_lat, max_lon, max_lat). Re-running this with the
    same `name` replaces exactly this region's rows in the shared base
    cache and nothing else -- it never touches present_edits.json or
    fantasy_edits.json, so neither edit layer can be clobbered by a refresh.
    """
    if not os.path.exists(pbf_path):
        raise FileNotFoundError(f'PBF file not found: {pbf_path}')

    handler = _RailwayHandler()
    handler.apply_file(pbf_path, locations=True)

    min_lon, min_lat, max_lon, max_lat = bbox
    rid = region_id_for(name)
    kept = []
    for w in handler.ways:
        if any(min_lon <= c[0] <= max_lon and min_lat <= c[1] <= max_lat for c in w['coords']):
            w['region_id'] = rid
            kept.append(w)

    os.makedirs(cache_dir, exist_ok=True)
    regions_path = os.path.join(cache_dir, 'regions.json')
    tracks_path = os.path.join(cache_dir, 'tracks.jsonl')

    regions = {}
    if os.path.exists(regions_path):
        with open(regions_path, encoding='utf-8') as f:
            regions = json.load(f)

    existing = []
    if os.path.exists(tracks_path):
        with open(tracks_path, encoding='utf-8') as f:
            existing = [json.loads(line) for line in f if line.strip()]
    existing = [w for w in existing if w.get('region_id') != rid]
    existing.extend(kept)

    tmp = tracks_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for w in existing:
            f.write(json.dumps(w) + '\n')
    os.replace(tmp, tracks_path)

    regions[rid] = {
        'name': name, 'bbox': list(bbox),
        'imported_at': datetime.datetime.utcnow().isoformat() + 'Z',
        'source_file': os.path.basename(pbf_path),
        'way_count': len(kept),
    }
    tmp2 = regions_path + '.tmp'
    with open(tmp2, 'w', encoding='utf-8') as f:
        json.dump(regions, f, indent=2)
    os.replace(tmp2, regions_path)

    return {'region_id': rid, 'way_count': len(kept)}
