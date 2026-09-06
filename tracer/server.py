from __future__ import annotations
import importlib.util, json, os, re, sys, threading, webbrowser
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# ── Config ────────────────────────────────────────────────────────────────────

TRACK_JSON = r"C:\Users\jrcoo\Saved Games\Weird and Wry\NIMBY Rails\jebbe's trains.json"
PORT       = 5000

_HERE        = os.path.dirname(os.path.abspath(__file__))
_ROOT        = os.path.dirname(_HERE)
_FANTASY_DIR = os.path.join(_ROOT, 'data', 'routes_fantasy')
_DATA_DIR    = os.path.join(_ROOT, 'data')
_MAP_DATA_PY = os.path.join(_DATA_DIR, 'map_data.py')

sys.path.insert(0, _ROOT)
try:
    from core.station_resolver import normalize_stations
except Exception as e:
    print(f'[tracer] Warning: could not import normalize_stations ({e}); multi-location stations will be skipped.')
    def normalize_stations(raw):  # type: ignore[misc]
        return {k: v for k, v in raw.items() if 'Location' in v}

MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json'}

# ── Helpers ───────────────────────────────────────────────────────────────────

def _load_map_data():
    path = os.path.join(_DATA_DIR, 'map_data.py')
    spec = importlib.util.spec_from_file_location('map_data', path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def _fantasy_routes() -> list[dict]:
    try:
        md = _load_map_data()
        routes = [
            {'Operator': op, 'Line': line, 'Pattern': pat,
             'File': pd['File'], 'Mode': str(pd.get('Mode', ''))}
            for op, op_lines in md.Lines.items()
            for line, cats in op_lines.items()
            for pat, pd in cats.get('Fantasy', {}).items()
            if pd.get('File')
        ]
        return sorted(routes, key=lambda r: (r['Operator'], r['Line'], r['Pattern']))
    except Exception as e:
        print(f'[tracer] Error reading map_data: {e}')
        return []

def _station_list() -> list[dict]:
    try:
        md          = _load_map_data()
        raw_stations = getattr(md, 'Stations', {}) or {}
        out: list[dict] = []
        flat = normalize_stations(raw_stations)
        for key, data in flat.items():
            loc = data.get('Location')
            if not loc:
                continue
            out.append({
                'Key':      key,
                'Label':    data.get('Label', key),
                'Location': [loc[0], loc[1]],
                'Major':    bool(data.get('Major', False)),
                'Section':  'Stations',
            })
        return sorted(out, key=lambda s: s['Label'].lower())
    except Exception as e:
        print(f'[tracer] Error reading stations: {e}')
        return []

def _find_dict_span(text: str, brace_start: int) -> int:
    """Given the index of an opening '{', return the index just past its
    matching closing '}'."""
    depth = 0
    i = brace_start
    while i < len(text):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError('Unbalanced braces in map_data.py')

def _update_station_location(content: str, section: str, station_key: str, lat: float, lon: float) -> str:
    m = re.match(r'^(.*) \{([^}]+)\}$', station_key)
    name, sub = (m.group(1), m.group(2)) if m else (station_key, None)

    section_match = re.search(r'\b' + re.escape(section) + r'\s*=\s*\{', content)
    if not section_match:
        raise ValueError(f"'{section}' dict not found in map_data.py")
    sect_start = section_match.end() - 1
    sect_end   = _find_dict_span(content, sect_start)
    section_text = content[sect_start:sect_end]

    key_match = re.search(r'"' + re.escape(name) + r'"\s*:\s*\{', section_text)
    if not key_match:
        raise ValueError(f"Station '{name}' not found in {section}")
    key_start = key_match.end() - 1
    key_end   = _find_dict_span(section_text, key_start)
    block     = section_text[key_start:key_end]

    loc_pattern = re.compile(r"('Location'\s*:\s*\(\s*)[^()]*?(\s*\))")

    if sub is None:
        new_block, n = loc_pattern.subn(lambda mm: f"{mm.group(1)}{lat!r}, {lon!r}{mm.group(2)}", block, count=1)
        if n == 0:
            raise ValueError(f"No 'Location' field found for station '{name}'")
    else:
        sub_match = re.search(r'[\'"]' + re.escape(sub) + r'[\'"]\s*:\s*\{', block)
        if not sub_match:
            raise ValueError(f"Sub-station '{sub}' not found under '{name}'")
        sub_start = sub_match.end() - 1
        sub_end   = _find_dict_span(block, sub_start)
        sub_block = block[sub_start:sub_end]
        new_sub_block, n = loc_pattern.subn(
            lambda mm: f"{mm.group(1)}{lat!r}, {lon!r}{mm.group(2)}", sub_block, count=1
        )
        if n == 0:
            raise ValueError(f"No 'Location' field found for '{name} {{{sub}}}'")
        new_block = block[:sub_start] + new_sub_block + block[sub_end:]

    new_section_text = section_text[:key_start] + new_block + section_text[key_end:]
    return content[:sect_start] + new_section_text + content[sect_end:]

def _region_filter(data: dict, bounds: tuple) -> dict:
    min_lon, max_lon, min_lat, max_lat = bounds
    out = []
    for f in data.get('features', []):
        pt   = (f.get('properties') or {}).get('preview_type')
        geom = f.get('geometry') or {}
        if pt == 'tracks' and geom:
            raw  = geom.get('coordinates', [])
            lines = raw if geom['type'] == 'MultiLineString' else [raw]
            kept  = [[c for c in ln if min_lon <= c[0] <= max_lon and min_lat <= c[1] <= max_lat]
                     for ln in lines]
            kept  = [ln for ln in kept if len(ln) >= 2]
            if kept:
                out.append({**f, 'geometry': {
                    'type': 'MultiLineString' if len(kept) > 1 else 'LineString',
                    'coordinates': kept if len(kept) > 1 else kept[0]
                }})
        elif pt == 'station' and geom.get('type') == 'Point':
            lon, lat = geom['coordinates']
            if min_lon <= lon <= max_lon and min_lat <= lat <= max_lat:
                out.append(f)
    return {'type': 'FeatureCollection', 'features': out}

def _read(path: str) -> bytes:
    with open(path, 'rb') as f:
        return f.read()

def _build_page() -> bytes:
    html = _read(os.path.join(_HERE, 'tracer.html')).decode('utf-8')
    try:
        borders = _read(os.path.join(_HERE, 'Borders.json')).decode('utf-8')
    except Exception:
        borders = '{"type":"FeatureCollection","features":[]}'
    return html.replace('__BORDERS_DATA__', borders).encode('utf-8')

# ── Handler ───────────────────────────────────────────────────────────────────

class _H(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def _ok(self, body: bytes, mime: str) -> None:
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status=200) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _404(self) -> None:
        self.send_response(404)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path   = parsed.path
        params = parse_qs(parsed.query)

        if path in ('/', '/index.html'):
            return self._ok(_build_page(), 'text/html; charset=utf-8')

        rel       = path.lstrip('/').replace('/', os.sep)
        candidate = os.path.normpath(os.path.join(_HERE, rel))
        if (os.path.commonpath([candidate, _HERE]) == _HERE
                and os.path.isfile(candidate)
                and not candidate.endswith('tracer.html')):
            ext = os.path.splitext(candidate)[1]
            return self._ok(_read(candidate), MIME.get(ext, 'application/octet-stream'))

        if path == '/api/routes':
            return self._json(_fantasy_routes())

        if path == '/api/stations':
            return self._json(_station_list())

        if path == '/api/waypoints':
            fname = params.get('file', [''])[0]
            wp    = os.path.join(_FANTASY_DIR, fname + '.waypoints.json')
            if fname and os.path.exists(wp):
                with open(wp, encoding='utf-8') as f:
                    saved = json.load(f)
                wps = saved.get('waypoints', [])
                return self._json({'exists': True, 'waypoints': wps, 'count': len(wps)})
            return self._json({'exists': False, 'waypoints': [], 'count': 0})

        if path == '/api/trackdata':
            if not os.path.exists(TRACK_JSON):
                return self._json({'error': f'Not found: {TRACK_JSON}'}, 500)
            try:
                bounds = tuple(float(params[k][0]) for k in ('minlon', 'maxlon', 'minlat', 'maxlat'))
                label  = f'region {bounds[0]:.2f},{bounds[2]:.2f}→{bounds[1]:.2f},{bounds[3]:.2f}'
            except (KeyError, ValueError):
                bounds, label = None, 'full network'
            print(f'[tracer] Serving track data ({label})')
            with open(TRACK_JSON, encoding='utf-8') as f:
                data = json.load(f)
            if bounds:
                data = _region_filter(data, bounds)
            return self._json(data)

        self._404()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == '/api/save':
            return self._post_save()
        if path == '/api/update_station':
            return self._post_update_station()
        return self._404()

    def _post_save(self) -> None:
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        try:
            p  = json.loads(body)
            fn = p['file']
            if any(c in fn for c in ('/', '\\', '..')):
                return self._json({'ok': False, 'error': 'Invalid filename'})
            os.makedirs(_FANTASY_DIR, exist_ok=True)
            with open(os.path.join(_FANTASY_DIR, fn + '.geojson'), 'w', encoding='utf-8') as f:
                json.dump(p['geojson'], f, indent=2)
            with open(os.path.join(_FANTASY_DIR, fn + '.waypoints.json'), 'w', encoding='utf-8') as f:
                json.dump({'waypoints': p['waypoints']}, f, indent=2)
            n = len((p['geojson'].get('features') or [{}])[0]
                    .get('geometry', {}).get('coordinates', []))
            print(f'[tracer] Saved {fn}.geojson ({n} pts) + .waypoints.json ({len(p["waypoints"])} wpts)')
            self._json({'ok': True})
        except Exception as e:
            print(f'[tracer] Save error: {e}')
            self._json({'ok': False, 'error': str(e)})

    def _post_update_station(self) -> None:
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        try:
            p       = json.loads(body)
            section = p['section']
            key     = p['key']
            lat     = float(p['lat'])
            lon     = float(p['lon'])
            if section not in ('Stations', 'Nodes'):
                return self._json({'ok': False, 'error': "section must be 'Stations' or 'Nodes'"})
            with open(_MAP_DATA_PY, encoding='utf-8') as f:
                content = f.read()
            new_content = _update_station_location(content, section, key, lat, lon)
            with open(_MAP_DATA_PY, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f'[tracer] Updated {section} "{key}" -> ({lat}, {lon})')
            self._json({'ok': True})
        except Exception as e:
            print(f'[tracer] Update station error: {e}')
            self._json({'ok': False, 'error': str(e)})

# ── Entry point ───────────────────────────────────────────────────────────────

def run() -> None:
    if not os.path.exists(TRACK_JSON):
        print(f'[tracer] Warning: track file not found:\n  {TRACK_JSON}\n')
    server = HTTPServer(('localhost', PORT), _H)
    url    = f'http://localhost:{PORT}'
    print(f'[tracer] Running at {url}  (Ctrl+C to stop)')
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[tracer] Stopped.')

if __name__ == '__main__':
    run()