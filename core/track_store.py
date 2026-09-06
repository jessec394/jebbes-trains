from __future__ import annotations
import json, os, uuid

MODES = ('present', 'fantasy')


class TrackStore:
    """Merges base ORM tracks (data/orm_cache/tracks.jsonl) with a per-mode
    edit layer (data/{mode}_edits.json) into one effective way list.

    The base file is shared, read-only from here, and only ever rewritten by
    a region-scoped ORM import/refresh. Each mode's edit layer is a separate
    file that the OTHER mode's code never opens -- so a present-day fix and
    a fictional fantasy line can never collide or overwrite one another, and
    neither can ever be touched by an ORM refresh of an unrelated region.

    Edit layer entry shape, keyed by way_id:
        {"op": "add",    "coords": [[lon,lat], ...], "tags": {...}}
        {"op": "edit",   "coords": [[lon,lat], ...], "tags": {...}}
        {"op": "delete"}
    """

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.base_path = os.path.join(data_dir, 'orm_cache', 'tracks.jsonl')

    def _edits_path(self, mode: str) -> str:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
        return os.path.join(self.data_dir, f'{mode}_edits.json')

    def _load_base(self) -> dict[str, dict]:
        ways: dict[str, dict] = {}
        if os.path.exists(self.base_path):
            with open(self.base_path, encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    w = json.loads(line)
                    ways[str(w['way_id'])] = w
        return ways

    def _load_edits(self, mode: str) -> dict[str, dict]:
        path = self._edits_path(mode)
        if not os.path.exists(path):
            return {}
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    def _save_edits(self, mode: str, edits: dict[str, dict]) -> None:
        path = self._edits_path(mode)
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(edits, f, indent=2)
        os.replace(tmp, path)

    # ── read ─────────────────────────────────────────────────────────────

    def effective_ways(self, mode: str) -> list[dict]:
        """Base ways with this mode's edit layer applied: deletions removed,
        edited ways replaced in place, added ways appended. Both modes start
        from the exact same base, then diverge independently."""
        out: dict[str, dict] = {wid: dict(w) for wid, w in self._load_base().items()}
        for way_id, e in self._load_edits(mode).items():
            op = e.get('op')
            if op == 'delete':
                out.pop(way_id, None)
            elif op in ('edit', 'add'):
                out[way_id] = {'way_id': way_id, 'coords': e['coords'], 'tags': e.get('tags', {})}
        return list(out.values())

    def as_geojson(self, mode: str) -> dict:
        features = []
        for w in self.effective_ways(mode):
            features.append({
                'type': 'Feature',
                'properties': {'preview_type': 'tracks', 'way_id': w['way_id'], **w.get('tags', {})},
                'geometry': {'type': 'LineString', 'coordinates': w['coords']},
            })
        return {'type': 'FeatureCollection', 'features': features}

    # ── write ────────────────────────────────────────────────────────────

    def add_track(self, mode: str, coords: list[list[float]], tags: dict | None = None) -> str:
        if len(coords) < 2:
            raise ValueError('A track needs at least 2 points')
        edits = self._load_edits(mode)
        way_id = f'new-{uuid.uuid4().hex[:10]}'
        edits[way_id] = {'op': 'add', 'coords': coords, 'tags': tags or {}}
        self._save_edits(mode, edits)
        return way_id

    def edit_track(self, mode: str, way_id: str,
                    coords: list[list[float]] | None = None, tags: dict | None = None) -> None:
        edits = self._load_edits(mode)
        base = self._load_base()

        existing = edits.get(way_id)
        if existing and existing.get('op') in ('add', 'edit'):
            new_coords = coords if coords is not None else existing['coords']
            new_tags = tags if tags is not None else existing.get('tags', {})
            op = existing['op']  # a fresh ('add') way stays fully edit-layer-owned
        elif way_id in base:
            new_coords = coords if coords is not None else base[way_id]['coords']
            new_tags = tags if tags is not None else base[way_id].get('tags', {})
            op = 'edit'
        else:
            raise ValueError(f'Unknown way_id {way_id!r} for mode {mode!r}')

        if len(new_coords) < 2:
            raise ValueError('A track needs at least 2 points')

        edits[way_id] = {'op': op, 'coords': new_coords, 'tags': new_tags}
        self._save_edits(mode, edits)

    def delete_track(self, mode: str, way_id: str) -> None:
        edits = self._load_edits(mode)
        base = self._load_base()

        if way_id in edits and edits[way_id].get('op') == 'add':
            # Never existed in the base layer -- forget it outright instead
            # of leaving a tombstone for something that was never there.
            del edits[way_id]
        elif way_id in base or way_id in edits:
            edits[way_id] = {'op': 'delete'}
        else:
            raise ValueError(f'Unknown way_id {way_id!r} for mode {mode!r}')

        self._save_edits(mode, edits)

    def revert_track(self, mode: str, way_id: str) -> None:
        """Drop this way's edit-layer entry entirely, reverting to base (or,
        if it was an 'add' with no base counterpart, removing it)."""
        edits = self._load_edits(mode)
        if way_id in edits:
            del edits[way_id]
            self._save_edits(mode, edits)
