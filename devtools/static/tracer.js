'use strict';
const $ = s => document.querySelector(s);
const apiOnce = async (url, opt) => {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), (opt && opt.timeout) || 300000);      // never wait forever on the server
  try {
    const r = await fetch(url, {...(opt ? {method: opt.method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(opt.body)} : {}), signal: ctl.signal});
    if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch (e) {} const er = new Error(m || url + ' -> ' + r.status); er.retry = r.status === 503; throw er; }
    const out = await r.json(); if (opt && opt.method && opt.method !== 'GET') { S_TRACE.clear(); if (url.startsWith('/api/edits')) document.dispatchEvent(new CustomEvent('trackedit', {detail: out && out.platforms})); }
    return out;
  } catch (e) { if (e instanceof TypeError) e.retry = true; throw e.name === 'AbortError' ? new Error(url + ' timed out') : e; }       // TypeError: the connection was dropped
  finally { clearTimeout(timer); }
};

// A read that is already on its way is shared rather than asked again; one the server dropped or called busy is tried once more.
const inflight = new Map();
const api = (url, opt) => {
  if (opt && opt.method && opt.method !== 'GET') return apiOnce(url, opt);
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => { try { return await apiOnce(url, opt); } catch (e) { if (!e.retry) throw e; await new Promise(r => setTimeout(r, 600)); return await apiOnce(url, opt); } finally { inflight.delete(url); } })();
  inflight.set(url, p); return p;
};

const q = o => new URLSearchParams(o).toString();
const S_TRACE = new Map();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const FUT = c => c === 'Fantasy';
const key = p => [p.operator, p.line, p.pattern, p.category].join('|');
const ids = p => ({operator: p.operator, line: p.line, pattern: p.pattern, category: p.category});

const ROUTE = '#ff1f8f';        // route colour: magenta, contrasts with the blue/purple track and green edits
const GRAPH_MIN_ZOOM = 9;

let S_SAT = false;      // satellite basemap: track is drawn brighter so it stays visible on imagery
const map = L.map('map', {preferCanvas: true, doubleClickZoom: false}).setView([39.5, -98.5], 5);
map.createPane('graphPane').style.zIndex = 350;
map.createPane('routePane').style.zIndex = 450;
map.createPane('stationPane').style.zIndex = 470;      // above the route so a station can always be grabbed
// Tiles come from this server under its other host name, so they never use up the six connections the API calls need
const TILE_HOST = location.protocol + '//' + (location.hostname === 'localhost' ? '127.0.0.1' : 'localhost') + (location.port ? ':' + location.port : '');
const TILES = {updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 3, updateInterval: 250};       // fewer, calmer tile requests while panning and zooming
// Tiles the server reports as failed (X-Tile-Failed) are asked for again with growing pauses while still on screen
class RetryTiles extends L.TileLayer {
  createTile(coords, done) {
    const img = document.createElement('img'); img.alt = ''; img.setAttribute('role', 'presentation'); const url = this.getTileUrl(coords);
    const go = n => fetch(url).then(async r => {
      const failed = r.headers.get('X-Tile-Failed') || !r.ok, blob = await r.blob();
      if (failed && n < 5) return setTimeout(() => { if (img.isConnected || n < 1) go(n + 1); }, 600 * (n + 1) + Math.random() * 400);
      img.onload = () => { URL.revokeObjectURL(img.src); done(null, img); }; img.src = URL.createObjectURL(blob);
    }).catch(() => { if (n < 5) setTimeout(() => { if (img.isConnected || n < 1) go(n + 1); }, 800 * (n + 1)); else done(null, img); });

    go(0); return img;
  }
}

const tileLayer = (u, o) => new RetryTiles(u, o);
const base = tileLayer(TILE_HOST + '/tiles/osm/{z}/{x}/{y}', {...TILES, maxZoom: 21, maxNativeZoom: 19, attribution: '© OSM'});
const sat = tileLayer(TILE_HOST + '/tiles/sat/{z}/{x}/{y}', {...TILES, maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'});
const satLabels = tileLayer(TILE_HOST + '/tiles/labels/{z}/{x}/{y}', {...TILES, maxZoom: 21, maxNativeZoom: 19, opacity: .9});
const orm = tileLayer(TILE_HOST + '/tiles/orm/{z}/{x}/{y}', {...TILES, maxZoom: 21, maxNativeZoom: 19, opacity: .8, attribution: 'OpenRailwayMap'});
let savedBase = 'map';
try { savedBase = localStorage.getItem('tracerBase') || 'map'; } catch (e) {}
(savedBase === 'sat' ? sat : base).addTo(map);
S_SAT = savedBase === 'sat';
// OSM platform outlines from the local copy (python -m devtools.platform_ingest), a picture only, redrawn as the view moves
const osmPlat = L.layerGroup(); let platReq = 0;
const platStatus = L.control({position: 'bottomleft'});
platStatus.onAdd = () => { const d = L.DomUtil.create('div', 'osmstatus'); d.hidden = true; return d; };
platStatus.addTo(map);
const setPlatStatus = (txt, bad) => { const d = platStatus.getContainer(); d.hidden = !txt; d.textContent = txt || ''; d.classList.toggle('bad', !!bad); };
async function loadOsmPlatforms() {
  if (!map.hasLayer(osmPlat)) { setPlatStatus(''); return; }
  const my = ++platReq; osmPlat.clearLayers();
  if (map.getZoom() < 14) { setPlatStatus('OSM platforms: zoom in to 14 or more'); return; }
  const b = map.getBounds(); let r;
  try { r = await (await fetch(`/api/osm_platforms?bbox=${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`)).json(); }
  catch (e) { setPlatStatus('OSM platforms: the tracer server did not answer', true); return; }
  if (my !== platReq || !map.hasLayer(osmPlat)) return;
  if (!r.ready) { setPlatStatus('OSM platforms are not on this computer yet: run  python -m devtools.platform_ingest', true); return; }
  setPlatStatus(r.items.length ? '' : 'No OSM platforms in view');
  for (const it of r.items) {
    const st = {color: '#c026d3', weight: it.e ? 2 : 1.5, opacity: .9, dashArray: it.e ? '4 3' : null, fillColor: '#e879f9', fillOpacity: .3, interactive: false};
    const l = it.a ? L.polygon(it.p, st) : L.polyline(it.p, st); if (it.n) l.bindTooltip(it.n); osmPlat.addLayer(l);
  }
}

osmPlat.on('add', loadOsmPlatforms); osmPlat.on('remove', () => { setPlatStatus(''); osmPlat.clearLayers(); }); map.on('moveend', loadOsmPlatforms);
L.control.layers({'Map': base, 'Satellite': sat}, {'Place names (satellite)': satLabels, 'OpenRailwayMap': orm, 'OSM platforms (picture only)': osmPlat}, {collapsed: true}).addTo(map);
map.on('baselayerchange', e => {
  S_SAT = e.layer === sat;
  try { localStorage.setItem('tracerBase', S_SAT ? 'sat' : 'map'); } catch (err) {}
  if (S_SAT && !map.hasLayer(satLabels)) satLabels.addTo(map);
  if (!S_SAT && map.hasLayer(satLabels)) map.removeLayer(satLabels);
  refreshGraph(true);
});

if (S_SAT) satLabels.addTo(map);
const graphRenderer = L.canvas({pane: 'graphPane', padding: 0.5});
const routeRenderer = L.svg({pane: 'routePane'});

// loop: every route returns to its start
const S = {
  catalog: [], sel: null, wps: [], stops: [], hist: [], mapName: 'present', tool: 'trace', loop: true, readonly: false, reuse: null, stationMoves: {},
  graph: L.layerGroup().addTo(map), routeLayer: L.layerGroup().addTo(map), wpLayer: L.layerGroup().addTo(map),
  ghostLayer: L.layerGroup().addTo(map), stationLayer: L.layerGroup().addTo(map), draft: [], draftLayer: L.layerGroup().addTo(map), dirty: false, markers: [],
};

// Catalog tree
async function loadCatalog() { S.catalog = await api('/api/catalog'); renderTree(); }
function dotClass(p) { return p.compiled ? 'ok' : p.waypoints ? 'has' : ''; }
const CAT = {present: 'Present', future: 'Fantasy'};                       // what a map is called in the route data
// The same operator and line on the other map, linked as one line even where the patterns differ
const lineTwins = p => S.catalog.filter(c => c.operator === p.operator && c.line === p.line && c.category !== p.category);
const twinOf = p => S.catalog.find(c => c.operator === p.operator && c.line === p.line && c.pattern === p.pattern && c.category !== p.category);
// Re-routes one route from its stops on its own map and saves it; a route that cannot be traced keeps what it had
async function refreshRoute(p, btn) {
  const open = S.sel && key(S.sel) === key(p);
  if (open && S.dirty && !confirm('Unsaved changes to this route are replaced by its refreshed version. Continue?')) return;
  const was = btn && btn.textContent; if (btn) { btn.disabled = true; btn.textContent = '…'; }
  let ok = true, msg = '';
  try {
    const r = (await api('/api/refresh_route', {method: 'POST', body: ids(p), timeout: 600000})).report;
    ok = r.ok; msg = (r.warnings || []).join('; ');
    if (open) $('#routeinfo').innerHTML = ok ? `<div class="good">Refreshed: ${r.length_km} km</div>` + (msg ? `<div class="warn">${msg}</div>` : '') : `<div class="bad">${msg || 'Could not be traced'}</div>`;
  } catch (e) { ok = false; msg = e.message; }

  clearLegCache(); S_TRACE.delete(key(p)); await loadCatalog();
  if (open && S.sel) { S.dirty = false; reloadSelection(); }
  const b2 = [...document.querySelectorAll('#tree .pat')].find(r => r._p && key(r._p) === key(p));
  const nb = b2 && b2.querySelector('.rfr'); if (nb) { nb.textContent = ok ? '✓' : '!'; nb.title = msg || 'Refreshed'; setTimeout(() => { nb.textContent = '↻'; nb.title = 'Refresh this route: re-route it from its stops and save it'; }, 2500); }
}

// Route list: collapsible operators (remembered), hover prefetch, keyboard (arrows, Enter, / to search)
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
S.openOps = new Set(lsGet('tracerOpenOps', []));
function patRow(p) {
  const d = el('div', 'pat' + (S.sel && key(S.sel) === key(p) ? ' sel' : ''));
  const tw = twinOf(p), other = FUT(p.category) ? 'Present' : 'Future', here = FUT(p.category) ? 'Future' : 'Present';
  const nm = el('span', 'pn', p.pattern); nm.title = p.pattern;
  d.append(el('span', 'dot ' + dotClass(p)), nm);
  if (tw) { const b = el('span', 'mapb both', 'P·F'); b.title = `This route is on both maps (${here} and ${other}), each with its own stops and path`; d.append(b); }
  else if (lineTwins(p).length) { const b = el('span', 'mapb line', FUT(p.category) ? '+P' : '+F'); b.title = `The line also runs on the ${other} map, as a different pattern`; d.append(b); }
  const rb = el('button', 'rfr', '↻'); rb.title = 'Refresh this route: re-route it from its stops and save it'; rb.onclick = e => { e.stopPropagation(); refreshRoute(p, rb); }; rb.onmousedown = e => e.stopPropagation();
  d.append(rb);
  let hv = null;
  d.onmouseenter = () => { hv = setTimeout(() => getTrace(p).catch(() => {}), 40); }; d.onmouseleave = () => clearTimeout(hv); d.onmousedown = () => getTrace(p).catch(() => {});
  d.onclick = () => S.sel && key(S.sel) === key(p) ? deselect() : selectPattern(p);
  d._p = p; return d;
}

function renderTree() {
  const f = $('#filter').value.trim().toLowerCase(), t = $('#tree'), frag = document.createDocumentFragment();
  const by = {}; let total = 0;
  for (const p of S.catalog) {
    if (p.category !== CAT[S.mapName]) continue;                       // each map lists its own routes: a Future-only route is not in the Present list
    if (f && !(p.operator + ' ' + p.line + ' ' + p.pattern).toLowerCase().includes(f)) continue;
    ((by[p.operator] ??= {})[p.line] ??= []).push(p); total++;
  }

  const ops = Object.keys(by), allOpen = ops.length && ops.every(o => S.openOps.has(o));
  const bar = el('div', 'ttools'), cnt = el('span', 'tcount', `${total} route${total === 1 ? '' : 's'} · ${ops.length} operator${ops.length === 1 ? '' : 's'}`);
  const tg = el('button', 'link', allOpen ? 'Collapse all' : 'Expand all'); tg.title = 'Open or close every operator';
  tg.onclick = () => { allOpen ? S.openOps.clear() : ops.forEach(o => S.openOps.add(o)); lsSet('tracerOpenOps', [...S.openOps]); renderTree(); };
  bar.append(cnt, tg); frag.append(bar);
  if (!total) frag.append(el('div', 'tempty', f ? 'No route matches the filter.' : 'No routes on this map yet. Use “+ Route” to start one.'));
  for (const [op, lines] of Object.entries(by)) {
    const n = Object.values(lines).reduce((a, l) => a + l.length, 0), open = !!f || S.openOps.has(op) || (S.sel && S.sel.operator === op);
    const h = el('div', 'op opx' + (open ? ' open' : '')); h.tabIndex = 0;
    h.append(el('span', 'chev', open ? '▾' : '▸'), el('span', 'opn', op), el('span', 'opc', String(n)));
    h.onclick = () => { S.openOps.has(op) ? S.openOps.delete(op) : S.openOps.add(op); lsSet('tracerOpenOps', [...S.openOps]); renderTree(); };
    frag.append(h);
    if (!open) continue;
    for (const [ln, pats] of Object.entries(lines)) {
      const h = el('div', 'ln'), add = el('button', 'lnadd', '+');
      add.title = `Add a service pattern to ${ln}`; add.onclick = e => { e.stopPropagation(); newPattern(op, ln); };
      h.append(el('span', '', ln), add); frag.append(h); pats.forEach(p => frag.append(patRow(p)));
    }
  }

  t.textContent = ''; t.append(frag); S.treeCursor = -1;
}

let filterT = null;
$('#filter').oninput = () => { clearTimeout(filterT); filterT = setTimeout(renderTree, 120); };
$('#filter').addEventListener('keydown', e => {
  const rows = [...document.querySelectorAll('#tree .pat')]; if (!rows.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); S.treeCursor = Math.max(0, Math.min(rows.length - 1, (S.treeCursor ?? -1) + (e.key === 'ArrowDown' ? 1 : -1)));
    rows.forEach((r, i) => r.classList.toggle('cur', i === S.treeCursor)); rows[S.treeCursor].scrollIntoView({block: 'nearest'});
  } else if (e.key === 'Enter') { const r = rows[Math.max(0, S.treeCursor ?? 0)]; if (r && r._p) selectPattern(r._p); }
  else if (e.key === 'Escape') { e.target.blur(); }
});

document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('#filter').focus(); $('#filter').select(); } });

// Deselect: map clicks no longer touch any route's waypoints
function deselect() {
  if (!S.sel) return true;
  if (S.dirty && !confirm('Discard unsaved changes?')) return false;
  S.sel = null; S.dirty = false; S.hist = []; S.stationMoves = {}; S.wps = []; S.stops = []; S.readonly = false;
  S.preview = null; S.stationLayer.clearLayers(); clearLegCache();
  $('#routetitle').textContent = 'No route selected'; $('#routemeta').textContent = ''; $('#routeinfo').textContent = '';
  $('#deselect').hidden = true; $('#undo').hidden = $('#clear').hidden = false;
  renderRouteMaps(); markSel(); drawWps(); scheduleRoute(0);
  document.dispatchEvent(new CustomEvent('routechange'));
  return true;
}

$('#deselect').onclick = deselect;
function getTrace(p) {                              // traces are fetched ahead of the click (on hover) and kept briefly, so opening a route is instant
  const k = key(p);
  if (!S_TRACE.has(k)) {
    const pr = api('/api/trace?' + q(ids(p))); S_TRACE.set(k, pr);
    pr.catch(() => S_TRACE.delete(k)); setTimeout(() => S_TRACE.delete(k), 20000);
  }

  return S_TRACE.get(k);
}

function markSel() {            // highlight the open route in the list without rebuilding the whole tree
  const rows = document.querySelectorAll('#tree .pat'); let found = false;
  rows.forEach(r => { const on = !!(S.sel && r._p && key(r._p) === key(S.sel)); r.classList.toggle('sel', on); found = found || on; });
  return found;
}

async function selectPattern(p, opt) {
  if (S.dirty && !confirm('Discard unsaved changes?')) return;
  if (S.tool !== 'trace') setTool('trace');            // picking a route always means tracing it
  S.sel = p; S.dirty = false; S.hist = []; S.stationMoves = {};
  S.preview = null; markSel();
  const t = await getTrace(p);
  if (S.sel !== p) return;                              // another route was picked while this one loaded
  S.preview = t.geometry && t.geometry.length ? t.geometry : null;          // the compiled line is on screen at once, while the legs are re-routed
  S.ownWps = t.waypoints.map(x => x.slice());
  S.readonly = false;
  S.wps = t.waypoints.map(x => x.slice());
  S.stops = S.wps.map((_, i) => t.stops?.[i] || null);        // a stop is pinned to a station / platform of the detailed map
  setMap(FUT(p.category) ? 'future' : 'present', true);     // a route is always shown and routed on its own map
  document.dispatchEvent(new CustomEvent('routechange'));
  $('#routetitle').textContent = `${p.operator} — ${p.line}`;
  $('#routemeta').textContent = `${p.pattern} · ${p.mode ?? ''} · ${FUT(p.category) ? 'Future' : 'Present'}`;
  renderRouteMaps(); $('#deselect').hidden = false;
  $('#undo').hidden = $('#clear').hidden = S.readonly;
  if (!markSel()) renderTree();                         // the row is not in the list (collapsed operator, opened from a list of changes): rebuild it
  const fit = !(opt && opt.fit === false);
  if (fit) {
    if (S.wps.length) map.fitBounds(L.latLngBounds(S.wps), {padding: [40, 40], animate: false});
    else if (t.geometry && t.geometry.length) map.fitBounds(L.latLngBounds(t.geometry.flat()), {padding: [40, 40], animate: false});
  }

  drawWps(); scheduleRoute(0); loadStations(p);
}

// Stations of the selected line: draggable, saved back into the detailed map
async function loadStations(p) {
  S.stationLayer.clearLayers();
  let list = [];
  try { list = await api('/api/stations?' + q({operator: p.operator, line: p.line, category: p.category})); } catch (e) { return; }
  if (S.sel !== p) return;
  for (const st of list) {
    const m = L.marker([st.lat, st.lon], {pane: 'stationPane', draggable: true, icon: L.divIcon({className: 'stn', iconSize: [14, 14]}), title: ''});
    m.bindTooltip(st.label, {direction: 'top', offset: [0, -8]});
    m.on('dragend', e => {
      const ll = e.target.getLatLng();
      S.stationMoves[st.key] = [ll.lat, ll.lng]; S.dirty = true;
      S.stops.forEach((k, i) => { if (k === st.key) S.wps[i] = [ll.lat, ll.lng]; });          // the route's stop follows the station it is pinned to
      m.getElement()?.classList.add('moved'); changed(0);
    });

    m.on('click', () => stationPopup(m, st));
    S.stationLayer.addLayer(m);
  }
}

// click a station of the open route: pin the route to it ("stop"), or snap the station onto the track
function stationPopup(m, st) {
  const box = el('div', 'wppop'), at = S.stops.indexOf(st.key);
  box.append(el('div', '', st.label + (st.key.includes('{') ? ' — platform ' + st.key.replace(/^.*\{|\}$/g, '') : '')));
  const ll = m.getLatLng(), sn = snapInfo(ll);
  if (sn) { const b = el('button', '', 'Snap station onto track'); b.title = 'Move this station to the nearest point on the track (saved with the route)'; b.onclick = () => { m.setLatLng(sn.ll); m.fire('dragend', {target: m}); map.closePopup(); }; box.append(b); }
  if (editable()) {
    if (at >= 0) { const b = el('button', '', 'Unpin from this route'); b.onclick = () => { push(); S.stops[at] = null; map.closePopup(); changed(); }; box.append(b); }
    else {
      const b = el('button', '', 'Use as a stop on this route'); b.title = 'The route passes exactly through this station / platform, and follows it when it moves';
      b.onclick = () => pinStop(st, m.getLatLng()); box.append(b);
    }
  }

  m.bindPopup(box).openPopup();
}

function pinStop(st, ll) {              // replace a plain waypoint standing at the station, or add the stop on the nearest leg
  const p = [ll.lat, ll.lng]; push(); map.closePopup();
  let near = -1, nd = 150; S.wps.forEach((w, i) => { if (!S.stops[i] && dist(w, p) < nd) { nd = dist(w, p); near = i; } });
  if (near >= 0) { S.wps[near] = p; S.stops[near] = st.key; return changed(0); }
  let at = S.wps.length, bd = Infinity;
  pairs().forEach(pr => { const leg = legCache.get(legKey(pr.a, pr.b)), pts = leg && leg.ok ? leg.pts : [pr.a, pr.b];
    const d = dist(nearestOn(pts, ll), p); if (d < bd) { bd = d; at = pr.closing ? S.wps.length : pr.k + 1; } });
  S.wps.splice(at, 0, p); S.stops.splice(at, 0, st.key); changed(0);
}

// Waypoints
function push() { S.hist.push(JSON.stringify({w: S.wps, s: S.stops})); if (S.hist.length > 100) S.hist.shift(); S.dirty = true; }
const editable = () => S.tool === 'trace' && S.sel && !S.readonly;
function changed(delay) { drawWps(); scheduleRoute(delay ?? 0); }
function removeWp(i) { if (S.stops[i]) return; push(); S.wps.splice(i, 1); S.stops.splice(i, 1); map.closePopup(); changed(); }
function insertWp(i, ll) { push(); S.wps.splice(i, 0, [ll[0], ll[1]]); S.stops.splice(i, 0, null); map.closePopup(); changed(); }

function drawWps() {
  S.wpLayer.clearLayers(); S.markers = [];
  S.wps.forEach((w, i) => {
    const stop = S.stops[i];
    const m = L.marker(w, {draggable: editable() && !stop, icon: L.divIcon({className: 'wp' + (i === 0 ? ' start' : '') + (stop ? ' stop' : ''), html: i + 1, iconSize: [20, 20]})});
    if (stop) m.bindTooltip(stop.replace(/\s*\{([^}]*)\}/, ' — platform $1'), {direction: 'top', offset: [0, -10]});
    m.on('dragstart', () => push());
    m.on('drag', e => { S.wps[i] = [e.latlng.lat, e.latlng.lng]; scheduleRoute(60); });
    m.on('dragend', () => { renderWpList(); scheduleRoute(0); });
    m.on('contextmenu', () => { if (editable() && !stop) removeWp(i); });
    m.on('dblclick', e => { L.DomEvent.stop(e); if (editable() && !stop) removeWp(i); });
    m.on('click', e => {
      if (S.readonly) return;
      if (e.originalEvent.altKey) return removeWp(i);
      const box = el('div', 'wppop'); box.append(el('div', '', stop ? 'Stop: ' + stop.replace(/\s*\{([^}]*)\}/, ' — platform $1') : `Waypoint ${i + 1}`));
      if (!stop) { const del = el('button', '', 'Delete'); del.onclick = () => removeWp(i); box.append(del); }
      else box.append(el('div', 'muted', 'Change stops in the Stops list'));
      if (i < S.wps.length - 1 || (S.loop && S.wps.length > 1)) {
        const ins = el('button', '', 'Add one after'); ins.onclick = () => insertWp(i + 1, midpointAfter(i)); box.append(ins);
      }

      m.bindPopup(box).openPopup();
    });

    S.wpLayer.addLayer(m); S.markers.push(m);
  });

  renderWpList();
}

function moveWp(from, to) {
  if (from === to || to < 0 || to >= S.wps.length || S.stops[from]) return;          // stops come from the pattern's stop list, only waypoints move
  push(); S.wps.splice(to, 0, S.wps.splice(from, 1)[0]); S.stops.splice(to, 0, S.stops.splice(from, 1)[0]); changed();
}

function renderWpList() {
  const box = $('#wplist'); box.textContent = '';
  $('#wpcount').textContent = S.wps.length;
  if (!S.wps.length) { box.textContent = S.sel ? 'Add stops below: the route follows them. Click the map for extra waypoints.' : 'Select a route.'; return; }
  const can = editable();
  S.wps.forEach((w, i) => {
    const r = el('div', 'wprow');
    r.append(el('span', 'n', String(i + 1)), el('span', 'c', S.stops[i] ? '⚑ ' + S.stops[i] : `${w[0].toFixed(4)}, ${w[1].toFixed(4)}`));
    if (can) {
      // reorder: drag the ⠿ grip onto another row, or use ▲ ▼
      const isStop = !!S.stops[i];
      const grip = el('span', 'grip', isStop ? '' : '⠿'); grip.title = 'Drag to reorder'; r.prepend(grip);
      r.draggable = !isStop;
      r.ondragstart = e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); };
      r.ondragend = () => box.querySelectorAll('.wprow').forEach(x => x.classList.remove('dragging', 'over'));
      r.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; r.classList.add('over'); };
      r.ondragleave = () => r.classList.remove('over');
      r.ondrop = e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain'), 10); if (!isNaN(from)) moveWp(from, i); };
      const up = el('button', 'mv', '▲'); up.title = 'Move earlier'; up.disabled = i === 0; up.hidden = isStop;
      up.onclick = e => { e.stopPropagation(); moveWp(i, i - 1); };
      const dn = el('button', 'mv', '▼'); dn.title = 'Move later'; dn.disabled = i === S.wps.length - 1; dn.hidden = isStop;
      dn.onclick = e => { e.stopPropagation(); moveWp(i, i + 1); };
      const add = el('button', '', '＋'); add.title = 'Insert a waypoint after this one (midway along the route)';
      add.onclick = e => { e.stopPropagation(); insertWp(i + 1, midpointAfter(i)); };
      const del = el('button', '', '✕'); del.title = 'Delete this waypoint';
      del.onclick = e => { e.stopPropagation(); removeWp(i); };
      del.hidden = isStop; del.title = isStop ? '' : 'Delete this waypoint';
      r.append(up, dn, add, del);
    }

    r.onmouseenter = () => S.markers[i]?._icon?.classList.add('hot');
    r.onmouseleave = () => S.markers[i]?._icon?.classList.remove('hot');
    r.onclick = () => map.panTo(w);
    box.append(r);
  });
}

// midpoint (along the traced leg if known) between waypoint i and the next one (or back to the start)
function midpointAfter(i) {
  const a = S.wps[i], b = S.wps[(i + 1) % S.wps.length];
  const leg = legCache.get(legKey(a, b));
  if (leg && leg.ok && leg.pts.length > 2) return leg.pts[Math.floor(leg.pts.length / 2)];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// Routing: per-leg cache, only changed legs are re-routed
const legCache = new Map();
const f6 = v => v.toFixed(6);
const legKey = (a, b) => `${S.mapName}|${f6(a[0])},${f6(a[1])}|${f6(b[0])},${f6(b[1])}`;
const dist = (a, b) => { const dy = (a[0] - b[0]) * 111320, dx = (a[1] - b[1]) * 111320 * Math.cos(a[0] * Math.PI / 180); return Math.hypot(dx, dy); };
function pairs() {
  const out = [];
  for (let k = 0; k < S.wps.length - 1; k++) out.push({a: S.wps[k], b: S.wps[k + 1], k, closing: false});
  if (S.loop && S.wps.length > 1 && dist(S.wps[0], S.wps[S.wps.length - 1]) > 30)
    out.push({a: S.wps[S.wps.length - 1], b: S.wps[0], k: S.wps.length - 1, closing: true});
  return out;
}

let routeTimer = null, routeBusy = false, routePending = false, routeVer = 0;
function scheduleRoute(delay) { clearTimeout(routeTimer); routeTimer = setTimeout(runRoute, delay); renderRoute(); }
async function runRoute() {
  if (routeBusy) { routePending = true; return; }
  routeBusy = true;
  try {
    do {
      routePending = false;
      const miss = pairs().filter(p => !legCache.has(legKey(p.a, p.b)));
      if (miss.length) {
        const ver = routeVer, mapName = S.mapName;
        const chunks = []; for (let i = 0; i < miss.length; i += 2) chunks.push(miss.slice(i, i + 2));      // a couple of legs per request, several requests at once
        const one = async chunk => {
          let legs;
          try { legs = (await api('/api/legs', {method: 'POST', timeout: 40000, body: {map: mapName, pairs: chunk.map(p => [p.a, p.b])}})).legs; }
          catch (e) { legs = chunk.map(p => ({ok: false, error: 'routing failed: ' + e.message, note: '', km: 0, pts: [p.a, p.b], retry: true})); }
          if (ver === routeVer) { chunk.forEach((p, k) => legCache.set(`${mapName}|${f6(p.a[0])},${f6(p.a[1])}|${f6(p.b[0])},${f6(p.b[1])}`, legs[k])); renderRoute(); }
        };

        let next = 0;
        await Promise.all(Array.from({length: Math.min(4, chunks.length)}, async () => { while (next < chunks.length && ver === routeVer) await one(chunks[next++]); }));
      }
    } while (routePending);
  } finally { routeBusy = false; }

  renderRoute();
}

function clearLegCache() { legCache.clear(); routeVer++; }
document.addEventListener('click', e => { if (e.target && e.target.id === 'retryroute') { clearLegCache(); scheduleRoute(0); } });

function renderRoute() {
  S.routeLayer.clearLayers();
  const ps = pairs(); let out = 0, back = 0, wait = 0;
  if (S.preview && ps.some(p => !legCache.has(legKey(p.a, p.b)))) S.preview.forEach(pl => L.polyline(pl, {color: ROUTE, weight: 4, opacity: .45, interactive: false, renderer: routeRenderer}).addTo(S.routeLayer)); const bad = [], notes = [], hits = [];
  ps.forEach(p => {
    const leg = legCache.get(legKey(p.a, p.b));
    if (!leg) {      // provisional straight line while the real leg is being routed
      wait++; L.polyline([p.a, p.b], {color: '#9aa4b2', weight: 3, dashArray: '3 7', interactive: false, renderer: routeRenderer}).addTo(S.routeLayer); return;
    }

    if (!leg.ok) bad.push(`${p.closing ? 'return' : `leg ${p.k + 1}→${p.k + 2}`}: ${leg.error}`);
    else if (leg.note) notes.push(`${p.closing ? 'return' : `leg ${p.k + 1}→${p.k + 2}`}: ${leg.note}`);
    if (p.closing) back += leg.km; else out += leg.km;
    const style = leg.ok ? {color: ROUTE, weight: 5, opacity: 1} : {color: '#ff5d5d', weight: 4, dashArray: '6 6'};
    if (leg.ok) L.polyline(leg.pts, {color: '#fff', weight: 9, opacity: .95, interactive: false, renderer: routeRenderer, dashArray: p.closing ? '12 9' : null}).addTo(S.routeLayer);
    const line = L.polyline(leg.pts, {...style, dashArray: p.closing && leg.ok ? '12 9' : style.dashArray, renderer: routeRenderer, bubblingMouseEvents: false}).addTo(S.routeLayer);
    if (leg.ok && editable()) {         // every leg, including the way back to 1, can be grabbed to add a waypoint
      const hit = L.polyline(leg.pts, {weight: 22, opacity: 0, renderer: routeRenderer, className: 'route-hit', bubblingMouseEvents: false});
      hit.on('add', () => L.DomEvent.on(hit.getElement(), 'mousedown', ev => beginInsert(ev, p)));
      hit.on('mousemove', e => showRing(e.latlng, leg.pts));
      hit.on('mouseout', hideRing);
      hits.push([p.closing, hit]);
    }
  });

  // grab zones go on top of the drawn route; the way back goes first so that where it retraces the way out, the outbound leg wins
  hits.sort((a, b) => b[0] - a[0]).forEach(([, h]) => h.addTo(S.routeLayer));
  const info = $('#routeinfo');
  if (!S.sel) { info.textContent = ''; return; }
  if (S.wps.length < 2) { info.textContent = S.wps.length ? 'Click the map to add more waypoints.' : 'Click the map to add waypoints.'; return; }
  info.innerHTML = `<div>${out.toFixed(1)} km out${S.loop ? ` · ${back.toFixed(1)} km back to 1` : ''} · ${S.wps.length} waypoints · ${S.mapName} map${wait ? ' · routing…' : ''}</div>` +
    bad.map(b => `<div class="bad">${b}</div>`).join('') + notes.map(b => `<div class="warn">${b}</div>`).join('') + (bad.some(b => b.includes('routing failed')) ? '<div><button id="retryroute">Retry routing</button></div>' : '') + (S.dirty ? '<div class="warn">unsaved changes</div>' : '');
}

// Grabbing a leg inserts a waypoint that follows the mouse; the click after the drag is swallowed
function nearestOn(pts, ll) {
  const p = map.latLngToLayerPoint(ll); let best = null, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const c = L.LineUtil.closestPointOnSegment(p, map.latLngToLayerPoint(pts[i]), map.latLngToLayerPoint(pts[i + 1]));
    const d = c.distanceTo(p); if (d < bd) { bd = d; best = c; }
  }

  const r = map.layerPointToLatLng(best); return [r.lat, r.lng];
}

const ringRenderer = L.svg({pane: 'stationPane'});
let ring = null;
function showRing(ll, pts) {
  const pos = nearestOn(pts, ll);
  if (!ring) ring = L.circleMarker(pos, {radius: 8, color: ROUTE, weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false, renderer: ringRenderer}).addTo(S.ghostLayer);
  else ring.setLatLng(pos);
}

function hideRing() { S.ghostLayer.clearLayers(); ring = null; }
const swallowClicks = (ms = 450) => { S.noClickUntil = Date.now() + ms; };

function beginInsert(ev, leg) {
  if (ev.button !== 0 || !editable()) return;
  L.DomEvent.stop(ev);                                   // the map must not start panning
  const idx = leg.closing ? S.wps.length : leg.k + 1;    // between its two waypoints; the way back to 1 appends
  const start = map.mouseEventToLatLng(ev);
  hideRing(); push(); S.wps.splice(idx, 0, [start.lat, start.lng]); S.stops.splice(idx, 0, null);
  const tmp = L.marker(start, {icon: L.divIcon({className: 'wp', html: idx + 1, iconSize: [20, 20]}), interactive: false, zIndexOffset: 900}).addTo(S.ghostLayer);
  const move = e => { const q = map.mouseEventToLatLng(e); S.wps[idx] = [q.lat, q.lng]; tmp.setLatLng(q); scheduleRoute(40); };
  const up = () => {
    document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true);
    S.ghostLayer.clearLayers(); ring = null; swallowClicks(); drawWps(); scheduleRoute(0);
  };

  document.addEventListener('mousemove', move, true); document.addEventListener('mouseup', up, true);
}

map.on('click', e => {
  if (Date.now() < (S.noClickUntil || 0)) return;        // the click that ends a drag
  if (S.tool === 'trace') {
    if (!editable()) return;
    if (S.picking) return;                              // choosing stops on the map: a click on empty map does nothing
    const p = [e.latlng.lat, e.latlng.lng]; push();
    let at = S.wps.length, bd = Infinity;               // a new waypoint goes into the leg nearest the click, between its two stops
    pairs().forEach(pr => { const leg = legCache.get(legKey(pr.a, pr.b)), pts = leg && leg.ok ? leg.pts : [pr.a, pr.b];
      const d = dist(nearestOn(pts, e.latlng), p); if (d < bd) { bd = d; at = pr.closing ? S.wps.length : pr.k + 1; } });
    S.wps.splice(at, 0, p); S.stops.splice(at, 0, null); changed(0);
  } else if (S.tool === 'edit') {
    if (S.ed) { S.ed = null; renderEditor(); drawEditHits(); }
  }
  else if (S.tool === 'erase' || S.tool === 'restore' || S.tool === 'adopt' || S.tool === 'stations' || S.tool === 'dests' || S.tool === 'direction' || S.tool === 'nogo') return;
  else if (S.tool === 'parallel') {
    if (e.originalEvent.shiftKey && removeParallelAt(e.latlng)) return;       // Shift+click on a parallel segment you are building removes it
    const h = hitTrack(e.latlng); if (h) parSelect(h, e.originalEvent.shiftKey);
  }
  else addDraft(e.latlng, e.originalEvent.shiftKey);
});

$('#undo').onclick = () => { const h = S.hist.pop(); if (h) { const o = JSON.parse(h); S.wps = o.w; S.stops = o.s; changed(); } };
$('#clear').onclick = () => { push(); S.wps = []; S.stops = []; changed(); };
$('#save').onclick = async () => {
  if (!S.sel) return;
  const out = [];
  try {
    const moves = S.stationMoves;
    if (Object.keys(moves).length) {
      const r = await api('/api/stations', {method: 'PUT', body: {moves}});
      out.push(`<div class="good">Moved ${r.moved} station${r.moved === 1 ? '' : 's'} in the detailed map (backup: devtools/cache/detailed_map.backup.py).</div>`);
      S.stationMoves = {}; loadStations(S.sel);
    }

    {
      const body = {...ids(S.sel)};
      body.waypoints = S.wps; body.stops = S.stops;
      const r = await api('/api/trace', {method: 'PUT', body});
      const warns = r.reports.flatMap(x => x.warnings.map(w => `${x.pattern} [${x.category}]: ${w}`));
      out.push(`<div class="good">Saved &amp; compiled ${r.reports.length} route(s).</div>` + warns.map(w => `<div class="warn">${w}</div>`).join(''));
    }

    S.dirty = false;
  } catch (e) { out.push(`<div class="bad">Save failed: ${e.message}</div>`); }

  $('#routeinfo').innerHTML = out.join('');
  await loadCatalog();
};

// Which map(s) a route is on; adding the other map copies its stops, then nothing stays linked
const refName = (r, p) => r.operator === p.operator && r.line === p.line ? r.pattern : `${r.operator} — ${r.line} — ${r.pattern}`;
function renderRouteMaps() {
  const p = S.sel, row = $('#mapsRow'); row.hidden = !p; if (!p) return;
  const tw = twinOf(p), has = {[p.category]: true, ...(tw ? {[tw.category]: true} : {})};
  const cur = has.Present && has.Fantasy ? 'both' : has.Present ? 'present' : 'future';
  document.querySelectorAll('#rtmaps button').forEach(b => { b.className = 'av-' + b.dataset.v + (b.dataset.v === cur ? ' on' : ''); b.onclick = () => b.dataset.v !== cur && setRouteMaps(b.dataset.v); });
  const note = $('#mapsNote'); note.textContent = '';
  if (tw) { const b = el('button', 'link', `Open the ${FUT(tw.category) ? 'Future' : 'Present'} version`); b.onclick = () => selectPattern(tw); note.append(b, el('span', 'muted', tw.waypoints ? '' : ' (no stops drawn yet)')); }
  if (tw) {                                                                       // the version on the other map can hand its stops, platforms and path over
    const other = FUT(tw.category) ? 'Future' : 'Present', ib = el('button', 'link', `⇩ Copy stops from the ${other} version`);
    ib.title = `Give this version the ${other} one's stops and the platforms each uses. Its path is traced again over this map's own track.`;
    ib.onclick = async () => {
      if (S.dirty && !confirm('Discard unsaved changes to this route?')) return;
      if (!confirm(`Replace this version's stops with the ${other} version's? Its path is traced again on this map.`)) return;
      try { await api('/api/route_inherit', {method: 'POST', body: {...ids(p)}}); } catch (e) { $('#routeinfo').innerHTML = `<div class="bad">${e.message}</div>`; return; }
      await reloadSelection(`Now the same stops as the ${other} version, traced on this map`);
    };

    note.append(el('div', '')); note.lastChild.append(ib);
  }

  const rf = el('button', 'link', '↻ Refresh this route'); rf.title = 'Re-route it from its stops and save + compile it'; rf.onclick = () => refreshRoute(p, rf);
  note.append(el('div', '', '')); note.lastChild.append(rf);
  const np = el('button', 'link', '＋ New pattern on this line'); np.title = `Another service pattern of ${p.line} (an express, a short turn, a branch), starting from this one's stops`;
  np.onclick = () => newPattern(p.operator, p.line, p); note.append(el('div', '', '')); note.lastChild.append(np);
  const others = lineTwins(p).filter(c => c !== tw);
  if (others.length) {
    note.append(el('div', 'muted', `This line also runs on the ${FUT(others[0].category) ? 'Future' : 'Present'} map as:`));
    for (const c of others) { const b = el('button', 'link', c.pattern); b.onclick = () => selectPattern(c); note.append(b, ' '); }
  }
}

async function setRouteMaps(value) {
  const p = S.sel; if (!p) return;
  if (S.dirty && !confirm('Discard unsaved changes to this route?')) return;
  const tw = twinOf(p), gone = (value === 'present' ? ['Fantasy'] : value === 'future' ? ['Present'] : []).map(c => [p, tw].find(x => x && x.category === c)).filter(Boolean);
  if (gone.some(x => x.waypoints) && !confirm(`Remove the ${gone.map(x => FUT(x.category) ? 'Future' : 'Present').join(' and ')} version of “${p.pattern}”? Its stops and path are deleted.`)) return;
  try { await api('/api/route_maps', {method: 'POST', body: {...ids(p), value}}); } catch (e) { $('#routeinfo').innerHTML = `<div class="bad">${e.message}</div>`; return; }
  S.dirty = false; await loadCatalog();
  const mine = S.catalog.find(c => key(c) === key(p));
  if (mine) { await selectPattern(mine, {fit: false}); const t2 = twinOf(mine); if (t2 && !t2.waypoints) $('#routeinfo').innerHTML = `<div class="good">The ${FUT(t2.category) ? 'Future' : 'Present'} version starts with no stops: open it and add its stops there.</div>`; }
  else { const other = S.catalog.find(c => c.operator === p.operator && c.line === p.line && c.pattern === p.pattern); if (other) await selectPattern(other); else deselect(); }
}

async function reloadSelection(msg) {
  const p = S.sel; S.dirty = false;
  await loadCatalog();
  await selectPattern(S.catalog.find(c => key(c) === key(p)) || p);
  if (msg) $('#routeinfo').innerHTML = `<div class="good">${msg}</div>`;
}

document.addEventListener('stopschanged', async () => {         // the stop list is the route: when it changes the route is re-traced, keeping waypoints placed between stops
  const p = S.sel; if (!p) return;
  if (S.dirty) await $('#save').onclick();
  S.dirty = false; await loadCatalog(); await selectPattern(S.catalog.find(c => key(c) === key(p)) || p, {fit: false});
});

// Map / tool switching
function switchMap(m) {                              // the Present / Future switch: the open route follows to its other-map version, or is closed if it has none
  const cat = CAT[m];
  if (S.sel && S.sel.category !== cat) {
    const tw = twinOf(S.sel);
    if (tw) { selectPattern(tw); return; }
    if (!deselect()) return;
  }

  setMap(m);
}

function setMap(m, quiet) {
  const was = S.mapName;
  if (m !== S.mapName) clearLegCache();
  S.mapName = m;
  document.querySelectorAll('#mapsw button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  if (S.tool !== 'trace') { S.editsView = []; S.ed = null; renderEditor(); refreshEdits(); }
  refreshGraph(m !== was); if (!quiet) scheduleRoute(0);
  if (m !== was) { document.dispatchEvent(new CustomEvent('mapchange', {detail: m})); renderTree(); }
}

function setTool(t) {
  setTimeout(() => drawBpHandles(), 0);
  if (t !== 'trace' && S.sel && !deselect()) return;  // drawing never edits a route's waypoints: leave the route first
  if (t !== 'trace' && t !== 'stations' && t !== 'dests') S.lastDraw = t;
  if (S.par && t !== 'parallel') parAdd();          // a pending parallel selection becomes blueprints rather than vanishing
  stopDraft();
  S.tool = t; if (t !== 'parallel') S.par = null; S.parHover = null; S.parLayer.clearLayers(); $('#parhud').hidden = t !== 'parallel'; if (t === 'parallel') renderPar(); S.draft = []; S.draftSegs = []; S.draftTans = []; S.draftSn = []; S.draftStr = []; S.tan = {start: null, end: null}; S.draftLayer.clearLayers(); hideRing();
  if (t !== 'edit') { S.ed = null; nselClear(); }
  const boxy = t === 'erase' || t === 'restore' || t === 'adopt';
  if (t === 'edit') { map.dragging.disable(); map.boxZoom.disable(); } else { map.dragging.enable(); map.boxZoom.enable(); }
  map.getContainer().classList.toggle('boxtool', boxy); eraseReset(); syncErased();
  document.querySelectorAll('#toolsw button').forEach(b => b.classList.toggle('on', b.dataset.t === (t === 'trace' ? 'trace' : t === 'stations' ? 'stations' : t === 'dests' ? 'dests' : 'draw')));
  document.querySelectorAll('#modebar button[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); $('#modebar').hidden = t === 'trace';
  $('#hud').hidden = t !== 'draw'; syncHud();
  renderEditor(); drawWps(); drawEditHits(); if (t !== 'trace' && t !== 'stations' && t !== 'dests') refreshEdits(); else { S.editsView = []; }
  document.dispatchEvent(new CustomEvent('toolchange', {detail: t}));
}

document.querySelectorAll('#mapsw button').forEach(b => b.onclick = () => switchMap(b.dataset.m));
document.querySelectorAll('#toolsw button').forEach(b => b.onclick = () => setTool(b.dataset.t === 'draw' ? (S.tool !== 'trace' && S.tool !== 'stations' && S.tool !== 'dests' ? S.tool : S.lastDraw || 'draw') : b.dataset.t));
document.querySelectorAll('#modebar button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
L.DomEvent.disableClickPropagation($('#modebar')); L.DomEvent.disableClickPropagation($('#mapbar'));
const DRAWMODE = {straight: 0, curve: 1};
document.querySelectorAll('#drawmode button').forEach(b => b.onclick = () => setDrawMode(DRAWMODE[b.dataset.d]));
function setDrawMode(v) { S.drawMode = v; syncDrawMode(); renderDraft(); }
function syncDrawMode() { document.querySelectorAll('#drawmode button').forEach(b => b.classList.toggle('on', DRAWMODE[b.dataset.d] === S.drawMode)); }
S.drawMode = 1; syncDrawMode();                // drawing is always Curve; hold Left Ctrl for a straight run
// On-map build bar (draw tool): segment type, parallel tracks, which one you draw, spacing
S.tracks = 1; S.spacing = 4.5; S.anchor = 'left';
const setTracks = n => { S.tracks = n; syncHud(); renderDraft(); };
function syncHud() {
  document.querySelectorAll('#hudtracks button').forEach(b => b.classList.toggle('on', +b.dataset.n === S.tracks));
  document.querySelectorAll('#hudanchor button').forEach(b => { b.classList.toggle('on', b.dataset.a === S.anchor); b.disabled = S.tracks < 2; });
  $('#hudspace').value = S.spacing; $('#hudspace').disabled = S.tracks < 2; syncDrawMode();
}

document.querySelectorAll('#hudtracks button').forEach(b => b.onclick = () => setTracks(+b.dataset.n));
document.querySelectorAll('#hudanchor button').forEach(b => b.onclick = () => { S.anchor = b.dataset.a; syncHud(); renderDraft(); });
$('#hudspace').onchange = e => { S.spacing = Math.max(2, Math.min(60, +e.target.value || 4.5)); syncHud(); renderDraft(); };
L.DomEvent.disableClickPropagation($('#hud')); L.DomEvent.disableScrollPropagation($('#hud'));
map.on('contextmenu', e => { if (S.tool === 'draw' || S.tool === 'erase') { stopDraft(); } });

// Geometry for custom tracks: straight and curved segments, parallel tracks, snapping
const M_LAT = 111320, SNAP_PX = 14;
const toXY = (p, lat0) => [p[1] * M_LAT * Math.cos(lat0 * Math.PI / 180), p[0] * M_LAT];          // [east, north] metres
const fromXY = (x, y, lat0) => [y / M_LAT, x / (M_LAT * Math.cos(lat0 * Math.PI / 180))];
const unit = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const orient = (d, ref) => dot2(d, ref) >= 0 ? d : [-d[0], -d[1]];
const r6 = p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
// Segment types: 0 straight, 1 curve, 2 curve that runs out straight
const segFlags = (segs, n) => Array.from({length: Math.max(0, n - 1)}, (_, i) => segs && segs[i] ? (segs[i] === 2 ? 2 : 1) : 0);     // 0 straight · 1 curve · 2 curve that runs out straight

// Lays out a chain of straight and curved (circular arc / biarc) segments -> {coords, idx of each node, rad of each segment}
function arcFrom(A, T, B, stepM) {          // circular arc from A (leaving along unit T) to B -> {pts (after A, up to B), tEnd, R}; null if the turn is >290°
  const v = [B[0] - A[0], B[1] - A[1]], nrm = [-T[1], T[0]], vv = dot2(v, v), den = 2 * dot2(v, nrm);
  if (Math.abs(den) < 1e-7 * (Math.sqrt(vv) + 1)) return {pts: [B], tEnd: unit(v), R: Infinity};
  const R = vv / den, C = [A[0] + nrm[0] * R, A[1] + nrm[1] * R], a0 = [A[0] - C[0], A[1] - C[1]], b0 = [B[0] - C[0], B[1] - C[1]];
  let th = Math.atan2(a0[0] * b0[1] - a0[1] * b0[0], dot2(a0, b0));
  if (R > 0 && th < 0) th += 2 * Math.PI; if (R < 0 && th > 0) th -= 2 * Math.PI;
  if (Math.abs(th) > 1.6 * Math.PI) return null;
  if (Math.abs(R * th) < 2.0) return {pts: [B], tEnd: unit(v), R: Math.abs(R)};          // a bend this short is just a point: sampling it would only add jitter
  const steps = Math.max(2, Math.ceil(Math.abs(R * th) / stepM)), pts = [];
  for (let k = 1; k < steps; k++) { const f = th * k / steps, c = Math.cos(f), s = Math.sin(f); pts.push([C[0] + a0[0] * c - a0[1] * s, C[1] + a0[0] * s + a0[1] * c]); }
  pts.push(B);
  const rl = Math.hypot(b0[0], b0[1]) || 1, tEnd = R > 0 ? [-b0[1] / rl, b0[0] / rl] : [b0[1] / rl, -b0[0] / rl];
  return {pts, tEnd, R: Math.abs(R)};
}

function biarc(P0, T0, P1, T1, stepM) {    // two arcs from P0 (leaving along T0) to P1 (arriving along T1) -> {pts, R} or null
  const v = [P1[0] - P0[0], P1[1] - P0[1]], vv = dot2(v, v), c = 1 - dot2(T0, T1);
  let d;
  if (c < 1e-9) { const vt = dot2(v, T1); if (Math.abs(vt) < 1e-9) return null; d = vv / (4 * vt); }
  else { const t = [T0[0] + T1[0], T0[1] + T1[1]], vtt = dot2(v, t); d = (-vtt + Math.sqrt(vtt * vtt + 2 * c * vv)) / (2 * c); }
  if (!(d > 0) || !isFinite(d)) return null;
  const J = [(P0[0] + P1[0] + d * (T0[0] - T1[0])) / 2, (P0[1] + P1[1] + d * (T0[1] - T1[1])) / 2];
  const a1 = arcFrom(P0, T0, J, stepM), a2 = arcFrom(P1, [-T1[0], -T1[1]], J, stepM);      // the second arc is traced backwards from P1
  if (!a1 || !a2) return null;
  return {pts: [...a1.pts, ...a2.pts.slice(0, -1).reverse(), P1], R: Math.min(a1.R, a2.R)};
}

// A curve that finishes straight: an arc off the previous direction, then a straight run to the node
function filletFrom(A, t0, P, t1, stepM) {
  const cr = t0[0] * t1[1] - t0[1] * t1[0], cphi = dot2(t0, t1);
  if (Math.abs(cr) < 1e-4 && cphi > 0) return {pts: [P], R: Infinity};
  const sgn = cr > 0 ? 1 : -1, om = 1 - cphi;
  if (om < 1e-9) return null;
  const R = -sgn * ((A[0] - P[0]) * t1[1] - (A[1] - P[1]) * t1[0]) / om;
  if (!(R > 0) || !isFinite(R)) return null;
  const phi = Math.atan2(Math.abs(cr), cphi), n0 = [-t0[1], t0[0]], sp = Math.sin(phi), cp = 1 - Math.cos(phi);
  const Q = [A[0] + R * (sp * t0[0] + sgn * cp * n0[0]), A[1] + R * (sp * t0[1] + sgn * cp * n0[1])];
  if ((P[0] - Q[0]) * t1[0] + (P[1] - Q[1]) * t1[1] < -0.5) return null;
  const a = arcFrom(A, t0, Q, stepM);
  return a ? {pts: [...a.pts, P], R: a.R} : null;
}

const FILLET_R = 200;          // metres: the tightest arc used before running straight, when the node is only a gentle turn away
// How a segment from a (leaving along t0) to b is laid -> {mode: 0 straight, 1 arc, 2 arc then straight, t0, t1}
function segRule(a, b, t0, curve, snapDir) {
  const v = [b[0] - a[0], b[1] - a[1]], d = Math.hypot(v[0], v[1]) || 1, c = [v[0] / d, v[1] / d];
  if (!curve) return {mode: 0, t0, t1: c};
  if (snapDir) return {mode: 1, t0, t1: orient(unit(snapDir), c)};
  const dd = dot2(t0, c);
  if (dd < 0.5) return {mode: 0, t0: c, t1: c};                                   // a turn of more than 60° in one segment: run straight instead
  const cr = t0[0] * c[1] - t0[1] * c[0], sg = cr < 0 ? -1 : 1, al = Math.atan2(Math.abs(cr), dd);
  if (al < 1e-3) return {mode: 0, t0, t1: c};
  const arc = {mode: 1, t0, t1: [2 * dd * c[0] - t0[0], 2 * dd * c[1] - t0[1]]};
  if (d / (2 * Math.sin(al)) <= FILLET_R) return arc;                             // a tight enough turn is one arc
  const g = ph => d * Math.sin(ph - al) - FILLET_R * (1 - Math.cos(ph));
  let lo = al, hi = null;
  for (let ph = al + 0.01; ph < Math.PI / 2; ph += 0.01) { if (g(ph) >= 0) { hi = ph; break; } lo = ph; }
  if (hi == null) return arc;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (g(mid) >= 0) hi = mid; else lo = mid; }
  const ph = hi, n0 = [-t0[1], t0[0]];
  return {mode: 2, t0, t1: [t0[0] * Math.cos(ph) + sg * n0[0] * Math.sin(ph), t0[1] * Math.cos(ph) + sg * n0[1] * Math.sin(ph)]};
}

// Lays a whole model out again from its nodes, each segment starting where the last one ended
function replayModel(m) {
  const n = m.ctrl.length; if (n < 2) return;
  const lat0 = m.ctrl[0][0], P = m.ctrl.map(p => toXY(p, lat0)), tans = [null], segs = [];
  for (let k = 1; k < n; k++) {
    const c = unit([P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]]);
    const t0 = tans[k - 1] || (k === 1 && m.tan && m.tan.start ? orient(unit(m.tan.start), c) : c);
    const r = segRule(P[k - 1], P[k], t0, !!m.segs[k - 1], k === n - 1 && m.tan && m.tan.end ? m.tan.end : null);
    if (k === 1 || !tans[k - 1]) tans[k - 1] = r.t0;
    segs.push(r.mode); tans[k] = r.t1;
  }

  m.tans = tans; m.segs = segs;
}

const reTans = m => { if (m && m.tans) replayModel(m); };
function buildCoords(ctrl, segs, tan, stepM = 5, tans = null) {
  const n = ctrl.length, cv = segFlags(segs, n).map(x => x === 2 ? 3 : x ? 2 : 0);
  const lat0 = ctrl[0][0], P = ctrl.map(p => toXY(p, lat0)), dirOf = (a, b) => unit([P[b][0] - P[a][0], P[b][1] - P[a][1]]);
  if (!cv.some(Boolean)) return {coords: ctrl.map(r6), idx: ctrl.map((_, i) => i), rad: cv.map(() => Infinity), tEnd: tans && tans[n - 1] ? unit(tans[n - 1]) : n > 1 ? dirOf(n - 2, n - 1) : null};
  // "follow" segments pass through every node: the tangent at a node bisects the two directions around it (ends extrapolate the bend)
  const bis = j => {
    if (j === 0) { if (tan && tan.start) return unit(tan.start); if (n < 3) return dirOf(0, 1); const a = dirOf(0, 1), b = dirOf(1, 2); return unit([1.5 * a[0] - 0.5 * b[0], 1.5 * a[1] - 0.5 * b[1]]); }
    if (j === n - 1) { if (tan && tan.end) return unit(tan.end); if (n < 3) return dirOf(n - 2, n - 1); const a = dirOf(n - 2, n - 1), b = dirOf(n - 3, n - 2); return unit([1.5 * a[0] - 0.5 * b[0], 1.5 * a[1] - 0.5 * b[1]]); }
    const a = dirOf(j - 1, j), b = dirOf(j, j + 1), m = [a[0] + b[0], a[1] + b[1]];
    return Math.hypot(...m) < 1e-6 ? b : unit(m);
  };

  const out = [ctrl[0]], idx = [0], rad = [];
  let carry = tan && tan.start ? unit(tan.start) : null;               // direction of travel leaving the current node
  for (let i = 0; i < n - 1; i++) {
    let R = Infinity;
    const mode = cv[i];
    if (mode) {
      let pts = null, tEnd = null;
      {
        // a node placed while drawing carries the direction it was left with (`tans`), so what comes after it never re-bends what is before
        const T = j => tans && tans[j] ? unit(tans[j]) : null;
        const t0 = T(i) || (i === 0 ? bis(0) : cv[i - 1] === 1 ? carry : cv[i - 1] === 0 ? dirOf(i - 1, i) : bis(i));
        const t1 = T(i + 1) || (i < n - 2 && cv[i + 1] === 0 ? dirOf(i + 1, i + 2) : bis(i + 1));
        let r = null;
        if (mode === 3 && T(i) && T(i + 1)) r = filletFrom(P[i], t0, P[i + 1], t1, stepM);
        if (!r && T(i) && T(i + 1)) { const a = arcFrom(P[i], t0, P[i + 1], stepM); if (a && dot2(a.tEnd, t1) > 0.9995) r = {pts: a.pts, R: a.R}; }      // a single circular arc
        if (!r) r = biarc(P[i], t0, P[i + 1], t1, stepM);
        if (r) { pts = r.pts; tEnd = t1; R = r.R; }
      }

      if (!pts) { pts = [P[i + 1]]; tEnd = dirOf(i, i + 1); R = Infinity; }                 // turn too tight to draw: straight
      { let last = P[i], end = P[i + 1];          // no sample within 2 m of the previous point or of the node: points that close only add jitter (and zigzag the parallel lanes)
        pts.slice(0, -1).forEach(q => { if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 2 && Math.hypot(q[0] - end[0], q[1] - end[1]) >= 2) { out.push(fromXY(q[0], q[1], lat0)); last = q; } }); }
      carry = tEnd;
    } else carry = dirOf(i, i + 1);

    rad.push(R);
    out.push(ctrl[i + 1]); idx.push(out.length - 1);
  }

  return {coords: out.map(r6), idx, rad, tEnd: tans && tans[n - 1] ? unit(tans[n - 1]) : carry};
}

// parallel copy, d metres to the left of travel (same maths as the server, so previews match what gets routed)
function offsetLine(pts, d) {          // d: metres (number) or one per vertex (array)
  if (!Array.isArray(d) && !d || pts.length < 2) return pts;
  const lat0 = pts[0][0], xy = pts.map(p => toXY(p, lat0)), nm = [];
  for (let i = 0; i < xy.length - 1; i++) { const u = unit([xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]]); nm.push([-u[1], u[0]]); }
  return xy.map((p, i) => {
    let n = nm[Math.min(i, nm.length - 1)], m = 1;
    if (i > 0 && i < xy.length - 1) { const a = nm[i - 1], b = nm[i], s = [a[0] + b[0], a[1] + b[1]], l = Math.hypot(...s); if (l > 1e-6) { n = [s[0] / l, s[1] / l]; m = Math.min(2, 1 / Math.max(.5, dot2(n, a))); } else n = a; }
    const dd = Array.isArray(d) ? d[i] : d;
    return fromXY(p[0] + n[0] * dd * m, p[1] + n[1] * dd * m, lat0);
  });
}

// parallel tracks: lane 0 is the left-most; `anchor` says which lane is the line that was actually drawn
const anchorIdx = (k, anchor) => anchor === 'left' ? 0 : anchor === 'right' ? k - 1 : (k - 1) / 2;
const lanesOf = (coords, tracks, spacing, anchor, lo) => {
  if ((tracks || 1) <= 1) return [coords];
  let fr = null;                                    // lane_offsets {start, end}: lane distances that ease from one end's spacing to the other's
  if (lo && lo.start && lo.end && lo.start.length === tracks && lo.end.length === tracks) {
    const lat0 = coords[0][0], cum = [0]; for (let i = 1; i < coords.length; i++) { const a = toXY(coords[i - 1], lat0), b = toXY(coords[i], lat0); cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); }
    fr = cum.map(c => c / (cum[cum.length - 1] || 1));
  }

  return Array.from({length: tracks}, (_, j) => {
    const ln = offsetLine(coords, fr ? fr.map(f => lo.start[j] + (lo.end[j] - lo.start[j]) * f) : (anchorIdx(tracks, anchor) - j) * (spacing || 4.5)).map(p => p.slice());
    if (lo && lo.start_pts && lo.start_pts[j]) ln[0] = lo.start_pts[j].slice();
    if (lo && lo.end_pts && lo.end_pts[j]) ln[ln.length - 1] = lo.end_pts[j].slice();
    return ln;
  });
};

// Lanes ending on existing parallel track take their distance from that track so they link up exactly
function nearestParallel(q, lat0, dir, tol, excl) {
  let best = null, bd = tol;
  const scan = pts => {
    for (let i = 0; i < pts.length - 1; i++) {
      const A = toXY(pts[i], lat0), B = toXY(pts[i + 1], lat0), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      if (!L2 || Math.abs(dot2(unit([dx, dy]), dir)) < 0.9) continue;
      const t = Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)), px = A[0] + dx * t, py = A[1] + dy * t, d = Math.hypot(q[0] - px, q[1] - py);
      if (d < bd) { bd = d; best = [px, py]; }
    }
  };

  for (const it of S.graphItems || []) scan(it.p);
  for (const e of S.editsView || []) if (e.op === 'add_track' && !(excl && excl.id && e.id === excl.id)) for (const ln of e._lanes) scan(ln);
  for (const b of S.blueprints || []) if (b !== excl && b.op === 'add_track') for (const ln of b._lanes) scan(ln);
  return best;
}

function nearestEndNode(q, lat0, dir, radius, excl) {       // an existing track END within radius of q that runs the same way
  let best = null, bd = radius;
  const scan = pts => {
    if (pts.length < 2) return;
    [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]].forEach(([e, nb]) => {
      const A = toXY(e, lat0), B = toXY(nb, lat0), d = Math.hypot(A[0] - q[0], A[1] - q[1]);
      if (d < bd && Math.abs(dot2(unit([B[0] - A[0], B[1] - A[1]]), dir)) > 0.9) { bd = d; best = A; }
    });
  };

  for (const it of S.graphItems || []) scan(it.p);
  for (const e of S.editsView || []) if (e.op === 'add_track' && !(excl && excl.id && e.id === excl.id)) for (const ln of e._lanes) scan(ln);
  for (const b of S.blueprints || []) if (b !== excl && b.op === 'add_track') for (const ln of b._lanes) scan(ln);
  return best;
}

function fitEnd(P, dir, k, sp, anchor, excl) {
  const lat0 = P[0], p = toXY(P, lat0), n = [-dir[1], dir[0]], a = anchorIdx(k, anchor), tol = Math.max(1.2, 0.5 * sp);
  const off = [], pts = [];
  for (let j = 0; j < k; j++) {
    const t = (a - j) * sp;
    if (!t) { off.push(0); pts.push(null); continue; }
    const q = [p[0] + n[0] * t, p[1] + n[1] * t];
    const nd = nearestEndNode(q, lat0, dir, Math.max(3, 0.7 * sp), excl);          // the lane lands exactly on the existing track's end
    if (nd) { off.push(Math.round(dot2([nd[0] - p[0], nd[1] - p[1]], n) * 100) / 100); pts.push(r6(fromXY(nd[0], nd[1], lat0))); continue; }
    const f = nearestParallel(q, lat0, dir, tol, excl);
    off.push(f ? Math.round(dot2([f[0] - p[0], f[1] - p[1]], n) * 100) / 100 : t); pts.push(null);
  }

  return {off, pts};
}

function fitLo(coords, k, sp, anchor, fitS, fitE, excl) {
  if (k <= 1 || coords.length < 2 || (!fitS && !fitE)) return null;
  const n = coords.length, lat0 = coords[0][0];
  const dirAt = (i, j) => { const a = toXY(coords[i], lat0), b = toXY(coords[j], lat0); return unit([b[0] - a[0], b[1] - a[1]]); };
  const ideal = Array.from({length: k}, (_, j) => (anchorIdx(k, anchor) - j) * sp);
  const start = fitS ? fitEnd(coords[0], dirAt(0, Math.min(n - 1, 2)), k, sp, anchor, excl) : null;
  const end = fitE ? fitEnd(coords[n - 1], dirAt(Math.max(0, n - 3), n - 1), k, sp, anchor, excl) : null;
  const lo = {start: (start || end).off, end: (end || start).off};
  if (start && start.pts.some(Boolean)) lo.start_pts = start.pts;
  if (end && end.pts.some(Boolean)) lo.end_pts = end.pts;
  const flat = lo.start.every((x, j) => Math.abs(x - ideal[j]) < 0.01) && lo.end.every((x, j) => Math.abs(x - ideal[j]) < 0.01);
  return flat && !lo.start_pts && !lo.end_pts ? null : lo;
}

// Nearest existing track within SNAP_PX (track ends win) -> {ll, dir, node} or null; Shift disables snapping
function snapInfo(ll, excludeId) {
  if (S.shift) return null;
  const lat0 = ll.lat, mpp = 156543.03392 * Math.cos(lat0 * Math.PI / 180) / Math.pow(2, map.getZoom());
  const rad = SNAP_PX * mpp, dLat = rad / M_LAT, dLon = dLat / Math.cos(lat0 * Math.PI / 180);
  const q = toXY([ll.lat, ll.lng], lat0);
  let best = null, bd = rad, nodeBest = null, nd = rad;
  const scan = pts => {
    const far = fromStart => { const a = fromStart ? pts[0] : pts[pts.length - 1]; let i = fromStart ? 1 : pts.length - 2;       // a vertex >= 12 m along, so one kinked end segment does not decide the direction
      while (i > 0 && i < pts.length - 1 && map.distance(a, pts[i]) < 12) i += fromStart ? 1 : -1; return pts[i]; };
    const ends = [[pts[0], far(true)], [pts[pts.length - 1], far(false)]];
    ends.forEach(([e, nb], k) => {
      const d = Math.hypot(...[toXY(e, lat0)[0] - q[0], toXY(e, lat0)[1] - q[1]]);
      if (d < nd) { nd = d; const A = toXY(e, lat0), B = toXY(nb, lat0); nodeBest = {ll: L.latLng(e[0], e[1]), dir: unit(k === 0 ? [B[0] - A[0], B[1] - A[1]] : [A[0] - B[0], A[1] - B[1]]), node: true}; }
    });

    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.max(a[0], b[0]) < ll.lat - dLat || Math.min(a[0], b[0]) > ll.lat + dLat || Math.max(a[1], b[1]) < ll.lng - dLon || Math.min(a[1], b[1]) > ll.lng + dLon) continue;
      const A = toXY(a, lat0), B = toXY(b, lat0), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
      const d = Math.hypot(q[0] - (A[0] + dx * t), q[1] - (A[1] + dy * t));
      if (d < bd) { bd = d; const c = fromXY(A[0] + dx * t, A[1] + dy * t, lat0); best = {ll: L.latLng(c[0], c[1]), dir: unit([dx, dy]), node: false}; }
    }
  };

  for (const it of S.graphItems || []) scan(it.p);
  for (const e of S.editsView || []) if (e.id !== excludeId && e.op === 'add_track') for (const ln of e._lanes) scan(ln);
  for (const bp of S.blueprints || []) if (bp.op === 'add_track') for (const ln of bp._lanes) scan(ln);
  return nodeBest || best;
}

const snapLL = (ll, excludeId) => (snapInfo(ll, excludeId) || {ll}).ll;
const modKeys = e => { S.lock = e.ctrlKey; S.shift = e.shiftKey; if (S.draft.length && draftCursor) renderDraft(); };
document.addEventListener('keydown', modKeys); document.addEventListener('keyup', modKeys);
window.addEventListener('blur', () => { S.lock = S.shift = false; });
map.on('mousemove', e => {
  S.lock = !!e.originalEvent?.ctrlKey; S.shift = !!e.originalEvent?.shiftKey;
  if (S.draft.length && S.tool === 'draw') previewDraft(e.latlng);
  if (S.tool === 'draw') { if (S.shift || (S.lock && S.draft.length)) { if (snapRing) { snapRing.remove(); snapRing = null; } } else showSnap(e.latlng); }
});

let snapRing = null;
function showSnap(ll) {          // a ring where the next click would attach
  const s = S.tool === 'erase' ? null : snapInfo(ll);
  if (!s) { if (snapRing) { snapRing.remove(); snapRing = null; } return; }
  if (!snapRing) snapRing = L.circleMarker(s.ll, {radius: s.node ? 9 : 6, color: '#7c3aed', weight: 3, fillOpacity: 0, interactive: false, renderer: ringRenderer}).addTo(map);
  else snapRing.setLatLng(s.ll).setRadius(s.node ? 9 : 6);
}

// Drawing new tracks: a chain of nodes, each segment straight or curved
S.draftSegs = []; S.draftTans = []; S.draftSn = []; S.draftStr = []; S.tan = {start: null, end: null};
// Left Ctrl: the next segment runs straight on along the track's heading; the cursor only sets the length
function straightOut(ll) {
  if (!S.draft.length || S.tool !== 'draw') return null;
  const pts = S.draft, lat0 = pts[0][0];
  let t = pts.length === 1 ? (S.tan.start ? unit(S.tan.start) : null) : buildCoords(pts, S.draftSegs, draftTan(pts), 5, S.draftTans).tEnd;
  if (!t) return null;
  const a = toXY(pts[pts.length - 1], lat0), q = toXY([ll.lat, ll.lng], lat0);
  let d = dot2([q[0] - a[0], q[1] - a[1]], t);
  if (pts.length === 1 && d < 0) { t = [-t[0], -t[1]]; d = -d; }          // a start snapped onto a track can leave either way along it
  d = Math.max(d, 0);
  return {pt: fromXY(a[0] + t[0] * d, a[1] + t[1] * d, lat0), t, from: a, d, lat0};
}

function popDraft() {
  S.draft.pop(); S.draftSegs.pop(); S.draftTans.pop(); S.draftSn.pop(); S.draftStr.pop();
  if (S.draft.length === 1) S.draftTans[0] = null;
}

// The segment from the last node to P: one arc off the previous direction, or two arcs onto a snapped track
function nextSeg(prev, P, sn, straight) {
  const lat0 = S.draft[0][0], a = toXY(S.draft[prev], lat0), b = toXY(P, lat0), c = unit([b[0] - a[0], b[1] - a[1]]);
  let t0 = S.draftTans[prev];
  if (!t0) t0 = prev === 0 && S.tan.start ? orient(unit(S.tan.start), c) : c;
  return segRule(a, b, t0, !(straight || S.drawMode === 0), sn && sn.dir);
}

function replayDraft() {
  S.draftTans = [null]; S.draftSegs = [];
  for (let k = 1; k < S.draft.length; k++) {
    const sg = nextSeg(k - 1, S.draft[k], S.draftSn[k], S.draftStr[k]);
    if (k === 1 || !S.draftTans[k - 1]) S.draftTans[k - 1] = sg.t0;
    S.draftSegs.push(sg.mode); S.draftTans[k] = sg.t1;
  }
}

function addDraft(ll, noSnap) {
  let straight = false;
  if (S.lock && S.draft.length) { const so = straightOut(ll); if (so) { ll = L.latLng(so.pt[0], so.pt[1]); straight = true; } }
  if (!S.draft.length) {
    const s = !noSnap && S.tool === 'draw' ? snapInfo(ll) : null;
    S.tan.start = s ? s.dir : null; S.snapStart = !!s; S.draftSn = [s || null]; S.draftTans = [null]; S.draftStr = [false];
    S.draft.push(s ? [s.ll.lat, s.ll.lng] : [ll.lat, ll.lng]); renderDraft(); return;
  }

  let sn = null;
  if (!straight && !noSnap && S.tool === 'draw') { sn = snapInfo(ll); if (sn) ll = sn.ll; }      // a node near track snaps onto it (the ring shows where); only a snapped end connects
  const last = S.draft[S.draft.length - 1];
  if (map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) < 4) return;     // double-click's second click
  const k = S.draft.length, sg = nextSeg(k - 1, [ll.lat, ll.lng], sn, straight);
  if (k === 1 || !S.draftTans[k - 1]) S.draftTans[k - 1] = sg.t0;
  S.draftSegs.push(sg.mode); S.draftTans[k] = sg.t1; S.draftSn[k] = sn; S.draftStr[k] = straight;
  S.draft.push([ll.lat, ll.lng]); renderDraft();
}

let draftCursor = null;
function previewDraft(ll) {
  S.curSnap = false; S.curSnapInfo = null;
  if (S.tool === 'draw' && !S.shift && !S.lock) { const sn = snapInfo(ll); if (sn) { ll = sn.ll; S.curSnap = true; S.curSnapInfo = sn; } }
  draftCursor = [ll.lat, ll.lng]; renderDraft();
}

// tangents oriented along the direction of travel of the new track
function draftTan(pts) {
  const t = {start: null, end: null};
  if (S.tan.start && pts.length > 1) { const a = toXY(pts[0], pts[0][0]), b = toXY(pts[1], pts[0][0]); t.start = orient(S.tan.start, [b[0] - a[0], b[1] - a[1]]); }
  if (S.tan.end && pts.length > 1) { const n = pts.length, a = toXY(pts[n - 2], pts[0][0]), b = toXY(pts[n - 1], pts[0][0]); t.end = orient(S.tan.end, [b[0] - a[0], b[1] - a[1]]); }
  return t;
}

const fmtLen = m => m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
let _hd = false;
function renderDraft() {
  S.draftLayer.clearLayers(); $('#hudread').textContent = '';
  if (_hd !== !!S.draft.length) { _hd = !!S.draft.length; drawBpHandles(); }
  if (S._dnCount !== S.draft.length) { S._dnCount = S.draft.length; drawDraftNodes(); }
  if (!S.draft.length) return;
  const erase = S.tool === 'erase', c = erase ? '#ff5d5d' : '#43c37a';
  let cur = draftCursor, straight = false;
  let ray = null, noDir = false;
  if (cur && S.lock && S.tool === 'draw') { const so = straightOut(L.latLng(cur[0], cur[1])); if (so) { cur = so.pt; straight = true; ray = so; } else noDir = true; }
  const pts = cur ? [...S.draft, cur] : S.draft;
  const tansP = S.draftTans.slice(), segs = S.draftSegs.slice();
  if (cur && S.draft.length) {
    const sg = nextSeg(S.draft.length - 1, cur, !straight && S.curSnap ? S.curSnapInfo : null, straight);
    if (S.draft.length === 1 || !tansP[S.draft.length - 1]) tansP[S.draft.length - 1] = sg.t0;
    segs.push(sg.mode); tansP[S.draft.length] = sg.t1;
  }

  if (pts.length > 1) {
    const {coords, idx, rad} = buildCoords(pts, segs, draftTan(pts), 5, tansP), k = erase ? 1 : S.tracks, lastStart = cur ? idx[pts.length - 2] : coords.length - 1;
    lanesOf(coords, k, S.spacing, S.anchor, erase ? null : fitLo(coords, k, S.spacing, S.anchor, S.snapStart, !!cur && S.curSnap && !straight)).forEach(ln => {
      L.polyline(ln.slice(0, lastStart + 1), {renderer: draftRenderer, color: c, weight: k > 1 ? 3 : 4, interactive: false}).addTo(S.draftLayer);
      if (cur) L.polyline(ln.slice(lastStart), {renderer: draftRenderer, color: c, weight: k > 1 ? 3 : 4, opacity: .65, dashArray: '2 7', interactive: false}).addTo(S.draftLayer);
    });

    const lenOf = (a, b) => { let m = 0; for (let i = a; i < b; i++) m += map.distance(coords[i], coords[i + 1]); return m; };
    const seg = cur ? lenOf(lastStart, coords.length - 1) : 0, r = rad[rad.length - 1];
    $('#hudread').textContent = `${cur ? 'segment ' + fmtLen(seg) + (isFinite(r) ? ' · radius ' + fmtLen(r) : '') + (straight ? ' · straight out' : '') + ' · ' : ''}total ${fmtLen(lenOf(0, coords.length - 1))}`;
  }

  if (ray) { const e = fromXY(ray.from[0] + ray.t[0] * (ray.d + 400), ray.from[1] + ray.t[1] * (ray.d + 400), ray.lat0); L.polyline([ray.pt, e], {renderer: draftRenderer, color: '#7c3aed', weight: 2, opacity: .7, dashArray: '2 6', interactive: false}).addTo(S.draftLayer); }
  if (noDir) $('#hudread').textContent = 'Ctrl: nothing to run straight out from yet (start on a track, or place a first segment)';
}

// every node you click while drawing stays a handle: drag it and the track reshapes at once (the later nodes keep their place)
S.draftNodes = L.layerGroup().addTo(map);
function drawDraftNodes() {
  S.draftNodes.clearLayers();
  if (S.tool !== 'draw') return;
  S.draft.forEach((p, k) => {
    const m = L.marker(p, {icon: bpHandleIcon('node add'), draggable: true, keyboard: false, zIndexOffset: 950}).addTo(S.draftNodes);
    m.on('drag', ev => {
      let ll = ev.target.getLatLng();
      const sn = S.shift ? null : snapInfo(ll); if (sn) ll = sn.ll;
      S.draft[k] = [ll.lat, ll.lng]; S.draftSn[k] = sn || null;
      if (k === 0) { S.tan.start = sn ? sn.dir : null; S.snapStart = !!sn; }
      replayDraft(); renderDraft();
    });

    m.on('dragend', () => m.setLatLng(S.draft[k]));
  });
}

// Blueprints (like NIMBY Rails): what you draw stays a ghost until you press Build. Esc / right-click / double-click just stop drawing.
S.blueprints = [];
function stopDraft() {
  draftCursor = null;
  if (S.draft.length >= 2 && (S.tool === 'draw' || S.tool === 'erase')) {
    const erase = S.tool === 'erase', n = S.draft.length;
    if (!erase) { const s = S.draftSn[n - 1]; S.tan.end = s ? s.dir : null; S.endSnap = !!s; }
    const segs = erase ? S.draft.slice(1).map(() => 0) : S.draftSegs.slice(0, n - 1), curved = segs.some(Boolean);
    addBlueprint({op: erase ? 'remove_track' : 'add_track', scope: S.mapName, ctrl: S.draft.slice(), segs, tan: curved ? draftTan(S.draft) : null,
                  tracks: erase ? 1 : S.tracks, spacing: S.spacing, anchor: S.anchor, name: '', fitS: !erase && !!S.snapStart, fitE: !erase && !!S.endSnap,
                  tans: curved ? S.draftTans.slice(0, n).map(t => t ? [t[0], t[1]] : null) : null});
    S.freshBp = S.blueprints[S.blueprints.length - 1];
  }

  S.draft = []; S.draftSegs = []; S.draftTans = []; S.draftSn = []; S.draftStr = []; S.tan = {start: null, end: null}; renderDraft();
}

S.bpHist = [];
const bpSnap = () => JSON.stringify(S.blueprints.map(b => ({op: b.op, scope: b.scope, ctrl: b.ctrl, segs: b.segs, tan: b.tan, tracks: b.tracks, spacing: b.spacing, anchor: b.anchor, name: b.name, fitS: b.fitS, fitE: b.fitE, tans: b.tans})));
function bpPush(keepFresh) { if (keepFresh !== true) S.freshBp = null; S.bpHist.push(bpSnap()); if (S.bpHist.length > 200) S.bpHist.shift(); }
function bpUndo() {                                 // Ctrl+Z on blueprints: undoes adding, moving, inserting, deleting nodes and segment-type changes
  const f = S.freshBp;                              // a line you just finished drawing comes apart one segment at a time
  if (f && S.blueprints.includes(f) && f.ctrl.length > 2) {
    f.ctrl.pop(); f.segs.pop(); if (f.tans) f.tans.pop(); if (f.tan) f.tan.end = null; f.fitE = false; bpRebuild(f); renderBlueprints(); return true;
  }

  const h = S.bpHist.pop(); if (!h) return false;
  S.blueprints = JSON.parse(h); S.blueprints.forEach(bpRebuild); renderBlueprints(); return true;
}

function addBlueprint(bp) {
  bpPush(true); S.freshBp = null;
  const {coords} = buildCoords(bp.ctrl, bp.segs, bp.tan, 5, bp.tans);
  bp.coords = coords; bp.lo = bp.op === 'add_track' ? fitLo(coords, bp.tracks, bp.spacing, bp.anchor, bp.fitS, bp.fitE, bp) : null;
  bp._lanes = bp.op === 'add_track' ? lanesOf(coords, bp.tracks, bp.spacing, bp.anchor, bp.lo) : [coords];
  S.blueprints.push(bp); renderBlueprints();
}

S.bpLayer = L.layerGroup().addTo(map);
function renderBlueprints() {
  S.bpLayer.clearLayers();
  for (const bp of S.blueprints) {
    const c = bp.op === 'remove_track' ? '#ff5d5d' : '#43c37a';
    bp._line = bp._lanes.map(ln => L.polyline(ln, {renderer: draftRenderer, color: c, weight: bp._lanes.length > 1 ? 3 : 4, opacity: .75, dashArray: '8 6', interactive: false}).addTo(S.bpLayer));
    [bp.ctrl[0], bp.ctrl[bp.ctrl.length - 1]].forEach(p => L.circleMarker(p, {renderer: draftRenderer, radius: 3.5, color: c, fillColor: '#fff', fillOpacity: 1, weight: 2, interactive: false}).addTo(S.bpLayer));
  }

  drawBpHandles();
  const n = S.blueprints.length;
  $('#bpbar').hidden = !n;
  $('#bpcount').textContent = `${n} blueprint${n === 1 ? '' : 's'}`;
}

// Editing blueprints: drag nodes, drag segment midpoints to insert, Shift+click a midpoint to change its type, right-click deletes
S.bpHandles = L.layerGroup().addTo(map);
function bpRebuild(bp) {
  reTans(bp);
  const {coords} = buildCoords(bp.ctrl, bp.segs, bp.tan, 5, bp.tans);
  bp.coords = coords; bp.lo = bp.op === 'add_track' ? fitLo(coords, bp.tracks, bp.spacing, bp.anchor, bp.fitS, bp.fitE, bp) : null;
  bp._lanes = bp.op === 'add_track' ? lanesOf(coords, bp.tracks, bp.spacing, bp.anchor, bp.lo) : [coords];
}

function bpTan(bp, i, snap) {                       // end tangents follow the track an end snaps onto
  const n = bp.ctrl.length, key = i === 0 ? 'start' : 'end';
  bp.tan = bp.tan || {start: null, end: null};
  if (snap && snap.dir) { const a = i === 0 ? 0 : n - 2, b = i === 0 ? 1 : n - 1, A = toXY(bp.ctrl[a], bp.ctrl[0][0]), B = toXY(bp.ctrl[b], bp.ctrl[0][0]); bp.tan[key] = orient(snap.dir, [B[0] - A[0], B[1] - A[1]]); }
  else bp.tan[key] = null;
}

function bpHandleIcon(cls) { return L.divIcon({className: 'bph ' + cls, iconSize: [14, 14], iconAnchor: [7, 7]}); }
function drawBpHandles() {
  S.bpHandles.clearLayers();
  if (S.tool === 'trace' || S.tool === 'parallel' || S.draft.length || S.par) return;
  for (const bp of S.blueprints) {
    const col = bp.op === 'remove_track' ? 'rm' : 'add';
    bp.ctrl.forEach((p, i) => {
      const m = L.marker(p, {icon: bpHandleIcon('node ' + col), draggable: true, keyboard: false, zIndexOffset: 900, title: 'Drag to move · right-click to delete'}).addTo(S.bpHandles);
      m.on('dragstart', bpPush);
      m.on('drag', e => {
        const ll = e.target.getLatLng(), sn = !S.shift && bp.op === 'add_track' && (i === 0 || i === bp.ctrl.length - 1) ? snapInfo(ll) : null;
        bp.ctrl[i] = sn ? [sn.ll.lat, sn.ll.lng] : [ll.lat, ll.lng]; if (bp.tans) bp.tans[i] = null;
        bpRebuild(bp); renderBlueprintLines(bp);
      });

      m.on('dragend', e => {
        const ll = e.target.getLatLng(), end = i === 0 || i === bp.ctrl.length - 1, sn = !S.shift && end && bp.op === 'add_track' ? snapInfo(ll) : null;
        if (sn) bp.ctrl[i] = [sn.ll.lat, sn.ll.lng];
        if (end) { bpTan(bp, i, sn); if (bp.op === 'add_track') { if (i === 0) bp.fitS = !!sn; else bp.fitE = !!sn; } }
        bpRebuild(bp); renderBlueprints();
      });

      m.on('contextmenu', e => {
        L.DomEvent.stop(e); bpPush();
        if (bp.ctrl.length <= 2) { S.blueprints.splice(S.blueprints.indexOf(bp), 1); renderBlueprints(); return; }
        bp.ctrl.splice(i, 1); bp.segs.splice(Math.min(i, bp.segs.length - 1), 1); if (bp.tans) bp.tans.splice(i, 1);
        if (i === 0 && bp.tan) bp.tan.start = null; if (i === bp.ctrl.length && bp.tan) bp.tan.end = null;
        bpRebuild(bp); renderBlueprints();
      });
    });

    bp.ctrl.slice(1).forEach((p, k) => {
      const a = bp.ctrl[k], mid = [(a[0] + p[0]) / 2, (a[1] + p[1]) / 2], type = bp.segs[k] || 0;
      if (bp.op !== 'add_track' && false) return;
      const m = L.marker(mid, {icon: bpHandleIcon('mid t' + type), draggable: true, keyboard: false, zIndexOffset: 800, title: 'Drag to add a node here · Shift+click: segment type (' + ['straight', 'curve', 'follow'][type] + ')'}).addTo(S.bpHandles);
      m.on('click', e => {
        if (!(e.originalEvent && e.originalEvent.shiftKey)) return;
        bpPush(); bp.segs[k] = type ? 0 : 1; if (bp.op !== 'add_track') bp.segs[k] = 0; bpRebuild(bp); renderBlueprints();
      });

      m.on('dragstart', () => { bpPush(); bp.ctrl.splice(k + 1, 0, mid); bp.segs.splice(k, 0, bp.segs[k] || 0); if (bp.tans) bp.tans.splice(k + 1, 0, null); });
      m.on('drag', e => { const ll = e.target.getLatLng(); bp.ctrl[k + 1] = [ll.lat, ll.lng]; bpRebuild(bp); renderBlueprintLines(bp); });
      m.on('dragend', () => { bpRebuild(bp); renderBlueprints(); });
    });
  }
}

function renderBlueprintLines(bp) {                 // cheap redraw while dragging: just this blueprint's ghost line
  if (bp._line) bp._line.forEach(l => S.bpLayer.removeLayer(l));
  const c = bp.op === 'remove_track' ? '#ff5d5d' : '#43c37a';
  bp._line = bp._lanes.map(ln => L.polyline(ln, {renderer: draftRenderer, color: c, weight: 4, opacity: .75, dashArray: '8 6', interactive: false}).addTo(S.bpLayer));
}

async function buildBlueprints() {
  if (S.par) parAdd();
  if (S.draft.length) stopDraft();
  if (!S.blueprints.length) return;
  const edits = S.blueprints.map(bp => {
    const curved = bp.segs.some(Boolean), b = {op: bp.op, scope: bp.scope, name: bp.name, coords: bp.coords};
    if (curved) { b.ctrl = bp.ctrl; b.segs = bp.segs; b.curve = true; if (bp.tan && (bp.tan.start || bp.tan.end)) b.tan = bp.tan; if (bp.tans) b.tans = bp.tans; }
    if (bp.op === 'add_track') { b.snap_s = !!bp.fitS; b.snap_e = !!bp.fitE; }              // only an end the cursor snapped onto track connects
    if (bp.op === 'add_track' && bp.tracks > 1) { b.tracks = bp.tracks; b.spacing = bp.spacing; b.anchor = bp.anchor; if (bp.lo) b.lane_offsets = bp.lo; }
    return b;
  });

  $('#bpbuild').disabled = true;
  try {
    const r = await api('/api/edits/batch', {method: 'POST', body: {edits}});
    S.blueprints = []; S.bpHist = []; renderBlueprints();
    const bad = r.health.filter(h => !h.ok);
    $('#routeinfo').innerHTML = `<div class="good">Built ${edits.length} segment${edits.length === 1 ? '' : 's'}.</div>` +
      (bad.length ? `<div class="warn">${bad.length} ${bad.length === 1 ? 'has' : 'have'} a free end (not connected to any track yet, or nothing to remove there).</div>` : '');
  } catch (e) { $('#routeinfo').innerHTML = `<div class="bad">Build failed: ${e.message}</div>`; }

  $('#bpbuild').disabled = false;
  afterEditChange();
}

function clearBlueprints() { S.par = null; if (S.tool === 'parallel') renderPar(); S.draft = []; S.draftSegs = []; S.draftTans = []; S.draftSn = []; S.draftStr = []; S.tan = {start: null, end: null}; draftCursor = null; S.draftLayer.clearLayers(); S.blueprints = []; S.bpHist = []; renderDraft(); renderBlueprints(); }
$('#bpbuild').onclick = buildBlueprints; $('#bpclear').onclick = clearBlueprints;
L.DomEvent.disableClickPropagation($('#bpbar'));
window.addEventListener('beforeunload', e => { if (S.blueprints.length) { e.preventDefault(); e.returnValue = ''; } });

// Parallel track beside an existing track: pick it, set distance / side / count, add as a blueprint
S.par = null; S.parOpt = {d: 4.5, n: 1, side: 1};
S.parLayer = L.layerGroup().addTo(map);
const pathCum = pts => { const c = [0]; for (let i = 0; i < pts.length - 1; i++) c.push(c[i] + map.distance(pts[i], pts[i + 1])); return c; };
function pointAtS(pts, cum, s) {
  if (s <= 0) return pts[0]; if (s >= cum[cum.length - 1]) return pts[pts.length - 1];
  let i = 0; while (cum[i + 1] < s) i++;
  const t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
}

function subPath(pts, cum, s0, s1) { const out = [pointAtS(pts, cum, s0)]; pts.forEach((p, i) => { if (cum[i] > s0 && cum[i] < s1) out.push(p); }); out.push(pointAtS(pts, cum, s1)); return out; }
function projectS(pts, cum, ll) {              // arc-length position of the point on the path nearest to ll
  const lat0 = ll.lat, q = toXY([ll.lat, ll.lng], lat0); let best = [Infinity, 0];
  for (let i = 0; i < pts.length - 1; i++) {
    const A = toXY(pts[i], lat0), B = toXY(pts[i + 1], lat0), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
    const d = Math.hypot(q[0] - A[0] - dx * t, q[1] - A[1] - dy * t);
    if (d < best[0]) best = [d, cum[i] + (cum[i + 1] - cum[i]) * t];
  }

  return best[1];
}

function densifyPath(pts, step) {
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) { const n = Math.max(1, Math.ceil(map.distance(pts[i], pts[i + 1]) / step)); for (let k = 1; k <= n; k++) out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k / n, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k / n]); }
  return out;
}

function simplifyXY(pts, tol) {                // Douglas-Peucker in metres
  if (pts.length < 3) return pts;
  const lat0 = pts[0][0], xy = pts.map(p => toXY(p, lat0)), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let dm = 0, im = -1;
    const dx = xy[b][0] - xy[a][0], dy = xy[b][1] - xy[a][1], L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((xy[i][0] - xy[a][0]) * dy - (xy[i][1] - xy[a][1]) * dx) / L; if (d > dm) { dm = d; im = i; } }
    if (dm > tol && im > 0) { keep[im] = 1; stack.push([a, im], [im, b]); }
  }

  return pts.filter((_, i) => keep[i]);
}

// the new track(s): floating parallel lines at distance k·d (k = 1..n) on the chosen side; they are not connected to anything
function parallelLines(par, o) {
  const cum = par.cum, sub = subPath(par.pts, cum, par.s0, par.s1), dense = densifyPath(sub, 5);
  const lines = [];
  for (let k = 1; k <= o.n; k++) lines.push(simplifyXY(offsetLine(dense, o.side * k * o.d), 0.08));
  return lines;
}

function removeParallelAt(ll) {                  // the pending parallel preview or a parallel blueprint under the click
  const lat0 = ll.lat, mpp = 156543.03392 * Math.cos(lat0 * Math.PI / 180) / Math.pow(2, map.getZoom()), rad = SNAP_PX * mpp, q = toXY([ll.lat, ll.lng], lat0);
  const near = pts => { for (let i = 0; i < pts.length - 1; i++) {
    const A = toXY(pts[i], lat0), B = toXY(pts[i + 1], lat0), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
    if (Math.hypot(q[0] - A[0] - dx * t, q[1] - A[1] - dy * t) < rad) return true; } return false; };
  if (S.par && parallelLines(S.par, S.parOpt).some(near)) { S.par = null; renderPar(); return true; }
  const bp = S.blueprints.find(b => b.op === 'add_track' && b._lanes.some(near));
  if (bp) { bpPush(); S.blueprints.splice(S.blueprints.indexOf(bp), 1); renderBlueprints(); return true; }
  return false;
}

function hitTrack(ll) {                         // the whole track (edge / custom track / blueprint) under the cursor, or null
  const lat0 = ll.lat, mpp = 156543.03392 * Math.cos(lat0 * Math.PI / 180) / Math.pow(2, map.getZoom()), rad = SNAP_PX * 1.3 * mpp, q = toXY([ll.lat, ll.lng], lat0);
  let best = null, bd = rad;
  const scan = pts => {
    for (let i = 0; i < pts.length - 1; i++) {
      const A = toXY(pts[i], lat0), B = toXY(pts[i + 1], lat0), dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
      const d = Math.hypot(q[0] - A[0] - dx * t, q[1] - A[1] - dy * t);
      if (d < bd) { bd = d; best = pts; }
    }
  };

  for (const it of S.graphItems || []) scan(it.p);
  for (const e of S.editsView || []) if (e.op === 'add_track') e._lanes.forEach(scan);
  for (const bp of S.blueprints) if (bp.op === 'add_track') bp._lanes.forEach(scan);
  return best;
}

function parSelect(pts, extend) {
  if (S.par && !extend) parAdd();                   // selecting another track keeps the previous parallel(s) as blueprints
  pts = pts.map(p => p.slice());
  if (extend && S.par) {                         // join an adjoining track onto the selection
    const cur = S.par.pts, near = (a, b) => map.distance(a, b) < 3, e0 = cur[0], e1 = cur[cur.length - 1], f0 = pts[0], f1 = pts[pts.length - 1];
    let joined = null;
    if (near(e1, f0)) joined = [...cur, ...pts.slice(1)];
    else if (near(e1, f1)) joined = [...cur, ...pts.slice(0, -1).reverse()];
    else if (near(e0, f1)) joined = [...pts, ...cur.slice(1)];
    else if (near(e0, f0)) joined = [...pts.slice().reverse(), ...cur.slice(1)];
    if (!joined) { $('#parhint').textContent = 'That track is not connected to the selection end.'; return; }
    pts = joined;
  }

  const cum = pathCum(pts); S.par = {pts, cum, s0: 0, s1: cum[cum.length - 1]}; renderPar();
}

function renderPar() {
  S.parLayer.clearLayers();
  const hasSel = !!S.par; $('#paradd').disabled = !hasSel;
  $('#parhint').textContent = hasSel ? `${fmtLen(S.par.s1 - S.par.s0)} selected · drag the end handles to trim · Shift+click an adjoining track to extend, or a parallel line to remove it · F flips side · it is kept as a blueprint when you press Enter/Esc, pick another track or switch tool` : 'Click a track to select it';
  if (!hasSel) return;
  const p = S.par, o = S.parOpt, sel = subPath(p.pts, p.cum, p.s0, p.s1);
  L.polyline(sel, {renderer: draftRenderer, color: '#ffd23f', weight: 9, opacity: .8, interactive: false}).addTo(S.parLayer);
  parallelLines(p, o).forEach(ln => L.polyline(ln, {renderer: draftRenderer, color: '#43c37a', weight: 4, opacity: .85, dashArray: '8 6', interactive: false}).addTo(S.parLayer));
  [['s0', 0], ['s1', 1]].forEach(([k]) => {
    const m = L.marker(pointAtS(p.pts, p.cum, p[k]), {draggable: true, zIndexOffset: 900, icon: L.divIcon({className: 'vx end', iconSize: [16, 16]})}).addTo(S.parLayer);
    m.on('drag', ev => {
      const s = projectS(p.pts, p.cum, ev.latlng);
      p[k] = k === 's0' ? Math.min(s, p.s1 - 10) : Math.max(s, p.s0 + 10);
      const at = pointAtS(p.pts, p.cum, p[k]); m.setLatLng(at);
      S.parLayer.eachLayer(l => { if (!(l instanceof L.Marker)) S.parLayer.removeLayer(l); });
      const sel2 = subPath(p.pts, p.cum, p.s0, p.s1);
      L.polyline(sel2, {renderer: draftRenderer, color: '#ffd23f', weight: 9, opacity: .8, interactive: false}).addTo(S.parLayer);
      parallelLines(p, o).forEach(ln => L.polyline(ln, {renderer: draftRenderer, color: '#43c37a', weight: 4, opacity: .85, dashArray: '8 6', interactive: false}).addTo(S.parLayer));
    });

    m.on('dragend', renderPar);
  });
}

function parAdd() {
  if (!S.par) return;
  const lines = parallelLines(S.par, S.parOpt);
  lines.forEach(ln => addBlueprint({op: 'add_track', scope: S.mapName, ctrl: ln, segs: ln.slice(1).map(() => 0), tan: null, tracks: 1, spacing: 4.5, anchor: 'center', name: 'parallel'}));
  S.par = null; renderPar();
  $('#routeinfo').innerHTML = `<div class="good">Added ${lines.length} floating parallel blueprint${lines.length === 1 ? '' : 's'} (not connected to the original). Press Build, then connect the ends with Draw or Connect.</div>`;
}

function syncPar() {
  const o = S.parOpt; $('#pardist').value = o.d;
  document.querySelectorAll('#partracks button').forEach(b => b.classList.toggle('on', +b.dataset.n === o.n));
  $('#parflip').textContent = o.side > 0 ? '⇄ Left' : '⇄ Right';
}

$('#pardist').onchange = e => { S.parOpt.d = Math.max(2, Math.min(60, +e.target.value || 4.5)); syncPar(); renderPar(); };
document.querySelectorAll('#partracks button').forEach(b => b.onclick = () => { S.parOpt.n = +b.dataset.n; syncPar(); renderPar(); });
const parFlip = () => { S.parOpt.side *= -1; syncPar(); renderPar(); };
$('#parflip').onclick = parFlip; $('#paradd').onclick = parAdd;
L.DomEvent.disableClickPropagation($('#parhud')); L.DomEvent.disableScrollPropagation($('#parhud'));
syncPar();
map.on('mousemove', e => {
  if (S.tool !== 'parallel') return;
  const h = hitTrack(e.latlng);
  S.parHover && S.parLayer.removeLayer(S.parHover); S.parHover = null;
  if (h) S.parHover = L.polyline(h, {renderer: draftRenderer, color: '#ffd23f', weight: 7, opacity: .45, interactive: false}).addTo(S.parLayer);
});

map.on('dblclick', () => { if (S.tool === 'draw' || S.tool === 'erase') { popDraft(); stopDraft(); } });
async function afterEditChange() {
  S.editVer = (S.editVer ?? 0) + 1; clearLegCache(); refreshGraph(true); refreshEdits(); scheduleRoute(0);       // the map updates first; the bookkeeping follows in the background
  updateDirty(); loadEdits();
}

// Editing custom tracks
S.editsView = []; S.ed = null; S.graphItems = [];
map.createPane('editPane').style.zIndex = 440;
map.createPane('draftPane').style.zIndex = 480;
const draftRenderer = L.svg({pane: 'draftPane'});
const editRenderer = L.svg({pane: 'editPane'});
S.edLayer = L.layerGroup().addTo(map); S.edLines = L.layerGroup().addTo(map); S.edHandles = L.layerGroup().addTo(map);
const EDCOL = {add_track: '#12a150', remove_track: '#e5484d'};
let edViewSeq = 0;
async function refreshEdits() {
  if (S.tool === 'trace') { S.editsView = []; drawEditHits(); return; }
  if (map.getZoom() < GRAPH_MIN_ZOOM) { S.editsView = []; drawEditHits(); return; }
  const b = map.getBounds().pad(0.3), seq = ++edViewSeq;
  const list = await api('/api/edits/view?' + q({map: S.mapName, bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(',')}));
  if (seq !== edViewSeq) return;
  for (const e of list) e._lanes = lanesOf(e.coords, e.tracks, e.spacing, e.anchor, e.lane_offsets);
  S.editsView = list; drawEditHits();
}

function drawEditHits() {
  S.edLayer.clearLayers();
  if (S.tool !== 'edit') { drawSelLayer.clearLayers(); return; }
  for (const e of S.editsView) {
    if (e.op === 'remove_track' || (S.ed && S.ed.id === e.id)) continue;          // erased segments are restored with the Restore tool, not edited
    const hover = L.polyline(e.coords, {color: '#ffd23f', weight: 7 + 4 * ((e.tracks || 1) > 1), opacity: 0, renderer: editRenderer, interactive: false}).addTo(S.edLayer);
    const multi = (e.tracks || 1) > 1 && e.op === 'add_track';
    (multi ? e._lanes : [e.coords]).forEach((ln, j) => {
      const hit = L.polyline(ln, {weight: multi ? 10 : 18, opacity: 0, renderer: editRenderer, bubblingMouseEvents: true, className: 'edit-hit'}).addTo(S.edLayer);
      hit.on('mouseover', () => hover.setStyle({opacity: .85})); hit.on('mouseout', () => hover.setStyle({opacity: 0}));
      hit.on('click', ev => { L.DomEvent.stopPropagation(ev); S.edHitAt = Date.now(); if (!ev.originalEvent.shiftKey) nselClear(); if (multi) S.laneSel = {id: e.id, j}; selectEdit(e); });
    });

    if (map.getZoom() >= 13) (e.ctrl || e.coords).forEach((p, i) => {          // every placed node is visible and selectable
      const m = L.marker(p, {icon: L.divIcon({className: 'vx simple' + (nselHas(e.id, i) ? ' selx' : ''), iconSize: [12, 12]}), zIndexOffset: 500, keyboard: false, draggable: true});
      m.on('click', ev => { L.DomEvent.stopPropagation(ev); nodeClick(e.id, i, ev.originalEvent.shiftKey); });
      bindGroupDrag(m, e.id, i);                               // drag any node: the selection (or this node) moves, joined tracks follow
      S.edLayer.addLayer(m);
    });
  }

  drawSelHighlight();
}

// Moving nodes as a group: the selected nodes (or the one dragged) plus the nodes of other tracks lying on them, so joins hold
const JOIN_M = 0.6;
S.pendLayer = L.layerGroup().addTo(map);
const ctrlOf = r => r.ctrl || r.coords;
function joinedNodes(pts, set) {                       // nodes of other custom tracks lying on any of pts -> added to set (id -> Set)
  for (const r of S.editsView) {
    if (r.op !== 'add_track') continue;
    ctrlOf(r).forEach((p, j) => {
      if (set.get(r.id)?.has(j) || !pts.some(q => dist(p, q) < JOIN_M)) return;
      if (!set.has(r.id)) set.set(r.id, new Set()); set.get(r.id).add(j);
    });
  }

  return set;
}

function hasJoined(id, i) { const m = modelFor(id); return !!m && [...joinedNodes([m.ctrl[i]], new Map()).keys()].some(k => k !== id); }
function moveSetFor(id, i) {
  const set = new Map();
  if (nselHas(id, i) && nselCount() > 1) S.nsel.forEach((v, k) => set.set(k, new Set(v)));
  else set.set(id, new Set([i]));
  const pts = []; set.forEach((v, k) => { const m = modelFor(k); if (m) v.forEach(j => m.ctrl[j] && pts.push(m.ctrl[j])); });
  return joinedNodes(pts, set);
}

// The models a move works on: the open track is edited in place, the others as copies of what the server has
function groupModels(set) {
  const out = [];
  set.forEach((v, id) => {
    const rec = S.editsView.find(x => x.id === id), m = S.ed && S.ed.id === id ? S.ed : rec ? modelOf(rec) : null;
    if (m && rec) out.push({id, idx: [...v], m, rec, base: m.ctrl.map(p => p.slice()), tan: m.tan ? {start: m.tan.start && m.tan.start.slice(), end: m.tan.end && m.tan.end.slice()} : null});
  });

  return out;
}

function drawGhosts(models) {
  S.pendLayer.clearLayers();
  for (const g of models) {
    const {coords} = buildCoords(g.m.ctrl, g.m.segs, g.m.tan, 5, g.m.tans);
    lanesOf(coords, g.m.tracks, g.m.spacing, g.m.anchor, null).forEach(ln => L.polyline(ln, {color: '#ffd23f', weight: 4, opacity: .95, interactive: false, renderer: editRenderer}).addTo(S.pendLayer));
  }
}

// Moves every model's chosen nodes by f([lat, lng]) -> [lat, lng]; rot rotates the end directions of whole-track moves too
function applyMove(models, f, rot) {
  for (const g of models) {
    g.idx.forEach(j => { g.m.ctrl[j] = f(g.base[j]); });
    if (rot && g.tan) g.m.tan = {start: g.tan.start && g.idx.includes(0) ? rot(g.tan.start) : g.tan.start, end: g.tan.end && g.idx.includes(g.base.length - 1) ? rot(g.tan.end) : g.tan.end};
    if (rot && g.m.tans) g.m.tans = g.m.tans.map((t, j) => t && g.idx.includes(j) ? rot(t) : t);
    reTans(g.m);
  }
}

// Saves a finished move in one request; the map shows the new shapes at once and the server's version follows
async function commitGroup(models) {
  const update = [], restore = [];
  for (const g of models) {
    const body = editBody(g.m); body.op = g.m.op; body.scope = g.m.scope;
    update.push({id: g.id, ...body}); restore.push({id: g.id, body: JSON.parse(JSON.stringify(recBody(g.rec)))});
    Object.assign(g.rec, {ctrl: g.m.ctrl.map(p => p.slice()), coords: body.coords, tan: body.tan || null, tans: body.tans, segs: body.segs});
    g.rec._lanes = lanesOf(body.coords, g.rec.tracks, g.rec.spacing, g.rec.anchor, body.lane_offsets);
  }

  S.pendClear = true; drawEditHits(); if (S.ed) renderEditor();
  const op = {restore, created: []}; S.edOps.push(op); S.lastEditAct = 'ops';          // undoable at once: an undo waits for this save to land
  const req = api('/api/edits/batch', {method: 'PUT', body: {update}}); S.pendingSave = req.catch(() => {});
  try {
    const r = await req;
    const bad = (r.health || []).some(h => !h.ok); $('#edstatus').innerHTML = bad ? '<span class="warn">moved — an end is not attached to track</span>' : '<span class="good">moved</span>';
    const mine = S.ed && r.edits.find(x => x.id === S.ed.id); if (mine) { mine._lanes = lanesOf(mine.coords, mine.tracks, mine.spacing, mine.anchor, mine.lane_offsets); selectEdit(mine); }
  } catch (err) { S.edOps = S.edOps.filter(x => x !== op); $('#routeinfo').innerHTML = `<div class="bad">move failed: ${err.message}</div>`; }

  afterEditChange();
}

function bindGroupDrag(mk, id, i) {
  let models = null, from = null, single = false;
  mk.on('dragstart', async () => {
    S.edHitAt = Date.now(); if (S.ed && edTimer) { clearTimeout(edTimer); edTimer = null; await saveEditor(); }
    const set = moveSetFor(id, i); single = !(nselHas(id, i) && nselCount() > 1);
    models = groupModels(set); from = mk.getLatLng();
  });

  mk.on('drag', ev => {
    if (!models) return;
    const d = [ev.latlng.lat - from.lat, ev.latlng.lng - from.lng];
    applyMove(models, p => [p[0] + d[0], p[1] + d[1]]); drawGhosts(models);
  });

  mk.on('dragend', ev => {
    if (!models) return;
    const own = models.find(g => g.id === id);
    if (single && own) {                                 // one node (and the tracks joined to it): it snaps like any end or junction
      const ll = ev.target.getLatLng(), end = i === 0 || i === own.base.length - 1, ex = models.map(g => g.id), s = end || own.m.junctions.has(i) ? snapInfoExcl(ll, ex) : null;
      if (s) { const d = [s.ll.lat - from.lat, s.ll.lng - from.lng]; applyMove(models, p => [p[0] + d[0], p[1] + d[1]]); }
      if (end && own.m.op === 'add_track') { own.m[i === 0 ? 'snap_s' : 'snap_e'] = !!s || models.length > 1; own.m.tan = own.m.tan || {start: null, end: null}; own.m.tan[i === 0 ? 'start' : 'end'] = s ? orientEnd(own.m, i, s.dir) : null; reTans(own.m); }
    }

    drawGhosts(models); commitGroup(models); models = null;
  });
}

// Snapping that ignores every track taking part in the move
function snapInfoExcl(ll, ids) {
  const keep = S.editsView; S.editsView = keep.filter(e => !ids.includes(e.id));
  try { return snapInfo(ll); } finally { S.editsView = keep; }
}

// Keyboard: arrows nudge the selection (Shift = 10 m), [ and ] turn it about its middle (Shift = 15°); saved when the keys stop
let keyMove = null;
function selectionForKeys() {
  const set = new Map();
  if (nselCount()) S.nsel.forEach((v, k) => set.set(k, new Set(v)));
  else if (S.ed) set.set(S.ed.id, new Set(S.ed.ctrl.map((_, j) => j)));
  if (!set.size) return null;
  const pts = []; set.forEach((v, k) => { const m = modelFor(k); if (m) v.forEach(j => m.ctrl[j] && pts.push(m.ctrl[j])); });
  return joinedNodes(pts, set);
}

function keyTransform(kind, amount) {
  if (!keyMove) {
    const set = selectionForKeys(); if (!set) return false;
    const models = groupModels(set); if (!models.length) return false;
    const pts = models.flatMap(g => g.idx.map(j => g.base[j])), c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    keyMove = {models, c, dx: 0, dy: 0, ang: 0, timer: null};
  }

  const k = keyMove, lat0 = k.c[0];
  if (kind === 'move') { k.dx += amount[0]; k.dy += amount[1]; } else k.ang += amount;
  const cs = Math.cos(k.ang * Math.PI / 180), sn = Math.sin(k.ang * Math.PI / 180), C = toXY(k.c, lat0);
  const f = p => { const P = toXY(p, lat0), x = P[0] - C[0], y = P[1] - C[1]; return r6(fromXY(C[0] + x * cs - y * sn + k.dx, C[1] + x * sn + y * cs + k.dy, lat0)); };
  applyMove(k.models, f, k.ang ? t => [t[0] * cs - t[1] * sn, t[0] * sn + t[1] * cs] : null); drawGhosts(k.models);
  clearTimeout(k.timer); k.timer = setTimeout(() => { const m = keyMove.models; keyMove = null; commitGroup(m); }, 450);
  $('#edstatus').textContent = `moving ${Math.hypot(k.dx, k.dy).toFixed(1)} m` + (k.ang ? `, turned ${k.ang}°` : '');
  return true;
}

document.addEventListener('keydown', e => {
  if (S.tool !== 'edit' || typing(e) || e.altKey) return;
  const step = e.shiftKey ? 10 : 1, ARROWS = {ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0]};
  if (ARROWS[e.key] && !e.ctrlKey && !e.metaKey) { if (keyTransform('move', ARROWS[e.key])) e.preventDefault(); return; }
  if ((e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') && !e.ctrlKey && !e.metaKey) { if (keyTransform('turn', (e.key === '[' || e.key === '{' ? 1 : -1) * (e.shiftKey ? 15 : 1))) e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectWholeTracks(); }
});

// Ctrl+A: every node of the open track (and of any track with a node selected); with nothing open, every custom track in view
function selectWholeTracks() {
  const ids = new Set([...S.nsel.keys(), ...(S.ed ? [S.ed.id] : [])]);
  if (!ids.size) S.editsView.forEach(r => { if (r.op === 'add_track') ids.add(r.id); });
  ids.forEach(id => { const r = S.editsView.find(x => x.id === id); if (r) ctrlOf(r).forEach((_, j) => nselAdd(id, j)); });
  if (S.ed) renderEditor(); drawEditHits();
  $('#edstatus').textContent = `${nselCount()} nodes selected: drag one, or use the arrow keys and [ ]`;
}

function selectEdit(e) {
  const ctrl = (e.ctrl || e.coords).map(p => p.slice());
  S.ed = {id: e.id, op: e.op, scope: e.scope || 'future', name: e.name || '', ctrl, segs: segFlags(e.segs || (e.curve ? ctrl.slice(1).map(() => 1) : null), ctrl.length),
          tan: e.tan || null, tans: e.tans ? e.tans.map(t => t && t.slice()) : null, snap_s: e.snap_s, snap_e: e.snap_e, tracks: e.tracks || 1, spacing: e.spacing || 4.5, anchor: e.anchor || 'center', junctions: new Set(e.junctions || []), hist: [], seg: null};
  renderEditor(); drawEditHits();
}

const edSnapshot = () => JSON.stringify({ctrl: S.ed.ctrl, segs: S.ed.segs, tan: S.ed.tan, tans: S.ed.tans, snap_s: S.ed.snap_s, snap_e: S.ed.snap_e, tracks: S.ed.tracks, spacing: S.ed.spacing, anchor: S.ed.anchor, junctions: [...S.ed.junctions]});
function edPush() { S.lastEditAct = 'ed'; S.ed.hist.push(edSnapshot()); if (S.ed.hist.length > 100) S.ed.hist.shift(); }
function edUndo() {
  if (!S.ed || !S.ed.hist.length) return;
  const h = JSON.parse(S.ed.hist.pop()); Object.assign(S.ed, h, {junctions: new Set(h.junctions), seg: null});
  renderEditor(); edSave();
}

let edTimer = null;
function edSave(delay = 250) { clearTimeout(edTimer); edTimer = setTimeout(saveEditor, delay); $('#edstatus').textContent = 'saving…'; }
function editBody(e) {
  const {coords, idx} = buildCoords(e.ctrl, e.segs, e.tan, 5, e.tans), curved = e.segs.some(Boolean);
  const body = {name: e.name, coords, ctrl: e.ctrl, segs: e.segs, curve: curved, tracks: e.op === 'add_track' ? e.tracks : 1, spacing: e.spacing, anchor: e.anchor};
  if (curved && e.tan) body.tan = e.tan;
  body.tans = curved && e.tans ? e.tans : null;
  if (e.op === 'add_track') { if (e.snap_s != null) body.snap_s = !!e.snap_s; if (e.snap_e != null) body.snap_e = !!e.snap_e; }
  body.lane_offsets = e.op === 'add_track' && e.tracks > 1 ? fitLo(coords, e.tracks, e.spacing, e.anchor, e.snap_s !== false, e.snap_e !== false, e) : null;
  if (e.junctions.size) { body.junctions = [...e.junctions].sort((a, b) => a - b); body.joins = [...new Set([0, coords.length - 1, ...body.junctions.map(i => idx[i])])].sort((a, b) => a - b); }
  return body;
}

// Edit mode selection: click / Shift+click / box-drag nodes; Delete removes them, cutting stretches out of their track
S.nsel = new Map();                                  // edit id -> Set of selected node indices
S.edOps = []; S.lastEditAct = 'ed';
const nselCount = () => { let n = 0; S.nsel.forEach(v => n += v.size); return n; };
const nselHas = (id, i) => !!(S.nsel.get(id) && S.nsel.get(id).has(i));
function nselClear() { S.nsel.clear(); S.laneSel = null; }
function nselAdd(id, i) { if (!S.nsel.has(id)) S.nsel.set(id, new Set()); S.nsel.get(id).add(i); }
function nselToggle(id, i) { if (nselHas(id, i)) { S.nsel.get(id).delete(i); if (!S.nsel.get(id).size) S.nsel.delete(id); } else nselAdd(id, i); }
function nodeClick(id, i, shift) {
  S.edHitAt = Date.now();
  if (shift) nselToggle(id, i); else { nselClear(); nselAdd(id, i); }
  if (!shift && !(S.ed && S.ed.id === id)) { const rec = S.editsView.find(x => x.id === id); if (rec) { selectEdit(rec); return; } }
  if (S.ed) renderEditor(); drawEditHits();
}

const modelOf = e => {
  const ctrl = (e.ctrl || e.coords).map(p => p.slice());
  return {id: e.id, op: e.op, scope: e.scope || 'future', name: e.name || '', ctrl, segs: segFlags(e.segs || (e.curve ? ctrl.slice(1).map(() => 1) : null), ctrl.length),
          tan: e.tan ? {start: e.tan.start || null, end: e.tan.end || null} : null, tans: e.tans ? e.tans.map(t => t && t.slice()) : null, snap_s: e.snap_s, snap_e: e.snap_e, tracks: e.tracks || 1, spacing: e.spacing || 4.5, anchor: e.anchor || 'center', junctions: new Set(e.junctions || [])};
};

const modelFor = id => S.ed && S.ed.id === id ? S.ed : (S.editsView.find(x => x.id === id) ? modelOf(S.editsView.find(x => x.id === id)) : null);
const runsOf = set => { const a = [...set].sort((x, y) => x - y), runs = []; a.forEach(i => { const r = runs[runs.length - 1]; if (r && r[1] === i - 1) r[1] = i; else runs.push([i, i]); }); return runs; };
const drawSelLayer = L.layerGroup().addTo(map);
function drawSelHighlight() {                         // yellow along each stretch of two or more consecutive selected nodes
  drawSelLayer.clearLayers();
  S.nsel.forEach((set, id) => {
    const m = modelFor(id); if (!m) return;
    const {coords, idx} = buildCoords(m.ctrl, m.segs, m.tan, 5, m.tans);
    runsOf(set).forEach(([a, b]) => { if (b > a && idx[b] != null) L.polyline(coords.slice(idx[a], idx[b] + 1), {color: '#ffd23f', weight: 11, opacity: .8, renderer: editRenderer, interactive: false}).addTo(drawSelLayer); });
  });

  if (S.laneSel) {                                    // the single track (lane) chosen within a multi-track edit
    const rec = S.editsView.find(x => x.id === S.laneSel.id);
    if (rec && rec.tracks > 1) {
      const m = modelFor(rec.id), g = buildCoords(m.ctrl, m.segs, m.tan, 5, m.tans), ln = lanesOf(g.coords, rec.tracks, rec.spacing, rec.anchor, rec.lane_offsets)[S.laneSel.j];
      const set = S.nsel.get(rec.id);
      const runs = set && set.size ? runsOf(set).filter(r => r[1] > r[0]) : [[0, g.idx.length - 1]];
      runs.forEach(([a, b]) => ln && L.polyline(ln.slice(g.idx[a], g.idx[b] + 1), {color: '#ff9f1c', weight: 8, opacity: .85, renderer: editRenderer, interactive: false}).addTo(drawSelLayer));
    }
  }

  $('#edsegdel').disabled = !nselCount() && !S.laneSel;
}

// cut a model into the pieces that remain after deleting the selected nodes -> [{ctrl, segs, tan, junctions}]
function piecesAfterDelete(m, set) {
  let ctrl = m.ctrl.map(p => p.slice()), segs = m.segs.slice(), tans = m.tans ? m.tans.slice() : null, junc = new Set(m.junctions), tan = m.tan ? {...m.tan} : {start: null, end: null};
  let runs = runsOf(set);
  const lone = runs.filter(r => r[0] === r[1]).map(r => r[0]).sort((x, y) => y - x);
  for (const i of lone) {                              // lone nodes: neighbours join up
    if (ctrl.length <= 2) return [];
    ctrl.splice(i, 1); segs.splice(i === 0 ? 0 : i === ctrl.length ? ctrl.length - 1 : i, 1); segs = segFlags(segs, ctrl.length); if (tans) tans.splice(i, 1);
    if (i === 0) tan.start = null; if (i === ctrl.length) tan.end = null;
    junc = new Set([...junc].filter(j => j !== i).map(j => j > i ? j - 1 : j));
    runs = runs.map(r => r[0] === r[1] ? r : [r[0] > i ? r[0] - 1 : r[0], r[1] > i ? r[1] - 1 : r[1]]);
  }

  const n = ctrl.length, dead = new Set();
  runs.filter(r => r[1] > r[0]).forEach(([a, b]) => { for (let k = a; k < b; k++) dead.add(k); });
  const pieces = []; let start = null;
  for (let k = 0; k <= n - 1; k++) {
    const live = k < n - 1 && !dead.has(k);
    if (live && start == null) start = k;
    if (!live && start != null) { pieces.push([start, k]); start = null; }
  }

  return pieces.map(([a, b]) => ({ctrl: ctrl.slice(a, b + 1), segs: segs.slice(a, b), tans: tans ? tans.slice(a, b + 1) : null,
    snap_s: a === 0 ? m.snap_s : false, snap_e: b === n - 1 ? m.snap_e : false, junctions: new Set([...junc].filter(j => j >= a && j <= b).map(j => j - a)),
    tan: (a === 0 && tan.start) || (b === n - 1 && tan.end) ? {start: a === 0 ? tan.start : null, end: b === n - 1 ? tan.end : null} : null}));
}

const recBody = r => ({scope: r.scope, name: r.name, coords: r.coords, ctrl: r.ctrl, segs: r.segs, curve: r.curve, tan: r.tan, tans: r.tans || null, snap_s: r.snap_s, snap_e: r.snap_e, edges: r.edges, pieces: r.pieces, build: r.build, tracks: r.tracks, spacing: r.spacing, anchor: r.anchor,
                       junctions: r.junctions, joins: r.joins, lane_offsets: r.lane_offsets || null, op: r.op, reshape: r.reshape || undefined});
// a multi-track edit stored as one line + spacing becomes one single-track model per lane, so that single tracks can be cut or removed
function laneModels(rec) {
  const m = modelOf(rec), g = buildCoords(m.ctrl, m.segs, m.tan, 5, m.tans), lanes = lanesOf(g.coords, m.tracks, m.spacing, m.anchor, rec.lane_offsets);
  return lanes.map(ln => ({...m, tracks: 1, spacing: 4.5, anchor: 'center', ctrl: g.idx.map(k => ln[k].slice()), segs: m.segs.slice(), tans: m.tans ? m.tans.slice() : null, tan: m.tan ? {...m.tan} : null, junctions: new Set(m.junctions)}));
}

async function deleteSelectedNodes() {
  const ls = S.laneSel;
  if (!nselCount() && !ls) return;
  if (S.ed) { clearTimeout(edTimer); await saveEditor(); }            // make sure the open track is saved first
  const op = {restore: [], created: []};
  const ids = new Set([...S.nsel.keys()]); if (ls) ids.add(ls.id);
  const jobs = [...ids].map(id => ({id, set: S.nsel.get(id) || new Set(), rec: S.editsView.find(x => x.id === id)})).filter(j => j.rec);
  nselClear();
  S.ed = null; renderEditor();
  try {
    const batch = {update: [], create: [], delete: []};
    for (const j of jobs) {
      const rec = j.rec, m = modelOf(rec);
      let results;                                                     // the models that replace this edit
      if (ls && ls.id === j.id && rec.tracks > 1) {                    // only the chosen single track (lane) is cut / removed
        const lm = laneModels(rec);
        results = [];
        lm.forEach((x, i) => { if (i !== ls.j) results.push(x); else if (j.set.size) piecesAfterDelete(x, j.set).forEach(p => results.push({...x, ...p})); });
      } else if (!j.set.size) continue;
      else results = piecesAfterDelete(m, j.set).map(p => ({...m, ...p}));
      op.restore.push({id: rec.id, body: JSON.parse(JSON.stringify(recBody(rec)))});
      if (!results.length) { batch.delete.push(j.id); continue; }
      results.forEach((x, k) => { const body = editBody(x); body.op = m.op; body.scope = m.scope; if (k === 0) batch.update.push({id: j.id, ...body}); else batch.create.push(body); });
    }

    const req = api('/api/edits/batch', {method: 'PUT', body: batch}); S.pendingSave = req.catch(() => {});
    const r = await req;
    op.created = r.created.map(x => x.id);
    S.edOps.push(op); S.lastEditAct = 'ops';
  } catch (err) { $('#edstatus').innerHTML = `<span class="bad">delete failed: ${err.message}</span>`; }

  afterEditChange();
}

async function undoEditOp() {
  if (S.pendingSave) await S.pendingSave;
  const op = S.edOps.pop(); if (!op) return false;
  try {
    await api('/api/edits/batch', {method: 'PUT', body: {delete: op.created, update: op.restore.map(r => ({...r.body, id: r.id}))}});
  } catch (err) { $('#routeinfo').innerHTML = `<div class="bad">undo failed: ${err.message}</div>`; }

  nselClear(); S.ed = null; renderEditor(); afterEditChange(); return true;
}

// drag a box on the map in Edit mode to select the nodes inside (the map pans with WASD / the wheel here)
map.on('mousedown', e => {
  if (S.tool !== 'edit' || e.originalEvent.button !== 0) return;
  if (e.originalEvent.target.closest && e.originalEvent.target.closest('.leaflet-marker-icon')) return;          // dragging a node, not a box
  const start = e.latlng, x0 = e.originalEvent.clientX, y0 = e.originalEvent.clientY; let moved = false, rect = null;
  const mv = m => {
    if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
    moved = true; const b = L.latLngBounds(start, map.mouseEventToLatLng(m));
    if (!rect) rect = L.rectangle(b, {color: '#ffd23f', weight: 1.5, fillOpacity: .12, interactive: false, renderer: editRenderer}).addTo(map); else rect.setBounds(b);
  };

  const up = m => {
    document.removeEventListener('mousemove', mv, true); document.removeEventListener('mouseup', up, true);
    if (rect) { rect.remove(); rect = null; }
    if (moved) {
      S.edBoxAt = Date.now();
      const b = L.latLngBounds(start, map.mouseEventToLatLng(m));
      if (!m.shiftKey) nselClear();
      for (const r of S.editsView) (r.ctrl || r.coords).forEach((p, i) => { if (b.contains(p)) nselAdd(r.id, i); });
      if (S.ed) renderEditor(); drawEditHits();
    } else if (!m.shiftKey) setTimeout(() => {         // after the click event, so a click on a node / track is not swallowed by the redraw
      if (Date.now() - (S.edHitAt || 0) < 150) return;
      nselClear(); if (S.ed) { S.ed = null; renderEditor(); } drawEditHits();
    }, 40);
  };

  document.addEventListener('mousemove', mv, true); document.addEventListener('mouseup', up, true);
});

async function saveEditor() {
  const e = S.ed; if (!e) return;
  const body = editBody(e);
  e.lane_offsets = body.lane_offsets;
  try {
    const r = await api('/api/edits/' + e.id, {method: 'PUT', body});
    const bad = r.health.some(h => !h.ok);
    $('#edstatus').innerHTML = bad ? '<span class="warn">saved — an end is not attached to track</span>' : '<span class="good">saved</span>';
  } catch (err) { $('#edstatus').innerHTML = `<span class="bad">save failed: ${err.message}</span>`; }

  S.editVer = (S.editVer ?? 0) + 1; clearLegCache(); updateDirty(); refreshGraph(true); refreshEdits(); scheduleRoute(0);
}

function setEdSegs(v) { edPush(); S.ed.segs = S.ed.segs.map(() => v); reTans(S.ed); renderEditor(); edSave(); }
function renderEditor() {
  S.edHandles.clearLayers(); S.edLines.clearLayers();
  const box = $('#edpanel'); box.hidden = !S.ed;
  if (!S.ed) return;
  const e = S.ed, col = EDCOL[e.op], n = e.ctrl.length, add = e.op === 'add_track';
  $('#edtitle').textContent = add ? 'Editing custom track' : 'Editing erase line';
  $('#edscope').textContent = e.scope === 'present' ? 'On the Present map (and so also the Future map)' : 'On the Future map only';
  $('#edname').value = e.name; $('#edtracksrow').hidden = !add; $('#edspace').value = e.spacing; $('#edspace').disabled = e.tracks < 2;
  document.querySelectorAll('#edtracks button').forEach(b => b.classList.toggle('on', +b.dataset.n === e.tracks));
  document.querySelectorAll('#edanchor button').forEach(b => { b.classList.toggle('on', b.dataset.a === e.anchor); b.disabled = e.tracks < 2; });
  $('#edsegrow').hidden = !add;
  if (e.seg != null && e.seg >= n - 1) e.seg = null;
  $('#edsegn').textContent = e.seg == null ? 'none selected — click a segment' : `${e.seg + 1} of ${n - 1}`;
  document.querySelectorAll('#edsegmode button').forEach(b => { b.disabled = e.seg == null; b.classList.toggle('on', e.seg != null && +b.dataset.s === Math.min(1, e.segs[e.seg])); });
  const drawLines = () => {
    S.edLines.clearLayers();
    const {coords, idx} = buildCoords(e.ctrl, e.segs, e.tan, 5, e.tans);
    const multi = add && e.tracks > 1;
    if (multi) lanesOf(coords, e.tracks, e.spacing, e.anchor, e.lane_offsets).forEach((ln, j) => {
      L.polyline(ln, {color: col, weight: 2, opacity: .7, renderer: editRenderer, interactive: false}).addTo(S.edLines);
      for (let i = 0; i < n - 1; i++) {                 // each lane is its own clickable track
        const h = L.polyline(ln.slice(idx[i], idx[i + 1] + 1), {weight: 10, opacity: 0, renderer: editRenderer, bubblingMouseEvents: true, className: 'edit-seg'}).addTo(S.edLines);
        h.on('click', ev => { L.DomEvent.stopPropagation(ev); S.edHitAt = Date.now(); e.seg = i; if (!ev.originalEvent.shiftKey) nselClear(); S.laneSel = {id: e.id, j}; nselAdd(e.id, i); nselAdd(e.id, i + 1); renderEditor(); drawEditHits(); });
        h.on('contextmenu', ev => { L.DomEvent.stop(ev); nselClear(); S.laneSel = {id: e.id, j}; nselAdd(e.id, i); nselAdd(e.id, i + 1); deleteSelectedNodes(); });
      }
    });

    for (let i = 0; i < n - 1; i++) {
      const pts = coords.slice(idx[i], idx[i + 1] + 1);
      const ln = L.polyline(pts, {color: col, weight: 5, opacity: .95, dashArray: e.segs[i] ? null : '10 5', renderer: editRenderer, bubblingMouseEvents: true, className: 'edit-seg', interactive: !multi}).addTo(S.edLines);
      ln.on('click', ev => {
        L.DomEvent.stopPropagation(ev); S.edHitAt = Date.now(); e.seg = i;
        if (!ev.originalEvent.shiftKey) nselClear(); nselAdd(e.id, i); nselAdd(e.id, i + 1); renderEditor(); drawEditHits();
      });

      if (add) {
        ln.on('contextmenu', ev => { L.DomEvent.stop(ev); nselClear(); nselAdd(e.id, i); nselAdd(e.id, i + 1); deleteSelectedNodes(); });
        ln.bindTooltip('click: select this segment (Shift+click adds) · Delete removes it', {sticky: true, direction: 'top', offset: [0, -6]});
      }
    }

    return {coords, idx};
  };

  const {coords, idx} = drawLines();
  e.ctrl.forEach((p, i) => {
    const end = i === 0 || i === n - 1, jn = e.junctions.has(i);
    const m = L.marker(p, {draggable: true, zIndexOffset: 800, icon: L.divIcon({className: 'vx' + (end ? ' end' : '') + (jn ? ' jn' : '') + (nselHas(e.id, i) ? ' selx' : ''), iconSize: [16, 16]})});
    const grouped = (nselHas(e.id, i) && nselCount() > 1) || hasJoined(e.id, i);          // a selection, or tracks joined here: they all move together
    if (grouped) bindGroupDrag(m, e.id, i);
    m.on('dragstart', () => { if (!grouped) edPush(); });
    m.on('drag', ev => { if (grouped) return; e.ctrl[i] = [ev.latlng.lat, ev.latlng.lng]; reTans(e); drawLines(); });
    m.on('dragend', ev => {
      if (grouped) return;
      if (end && e.op === 'add_track') e[i === 0 ? 'snap_s' : 'snap_e'] = !!snapInfo(ev.target.getLatLng(), e.id);
      if (end || e.junctions.has(i)) {                     // ends + junctions snap to track and leave it tangentially
        const s = snapInfo(ev.target.getLatLng(), e.id);
        if (s) { e.ctrl[i] = [s.ll.lat, s.ll.lng]; if (end) { e.tan = e.tan || {start: null, end: null}; e.tan[i === 0 ? 'start' : 'end'] = n > 1 ? orientEnd(e, i, s.dir) : null; } }
        else if (end && e.tan) e.tan[i === 0 ? 'start' : 'end'] = null;
      }

      reTans(e); renderEditor(); edSave(0);
    });

    const del = () => {
      if (n <= 2) return; edPush(); e.ctrl.splice(i, 1); if (e.tans) e.tans.splice(i, 1);
      e.segs.splice(i === 0 ? 0 : i === n - 1 ? n - 2 : i, 1);                      // the neighbouring segments merge, keeping the earlier one's type
      if (e.tan && (i === 0 || i === n - 1)) e.tan[i === 0 ? 'start' : 'end'] = null;
      e.segs = segFlags(e.segs, e.ctrl.length);
      e.junctions = new Set([...e.junctions].filter(j => j !== i).map(j => j > i ? j - 1 : j)); e.seg = null; reTans(e); renderEditor(); edSave();
    };

    m.on('contextmenu', del); m.on('dblclick', ev => { L.DomEvent.stop(ev); del(); });
    m.on('click', ev => {
      if (ev.originalEvent.altKey) return del();
      if (ev.originalEvent.ctrlKey || ev.originalEvent.metaKey) { edPush(); e.junctions.has(i) ? e.junctions.delete(i) : e.junctions.add(i); renderEditor(); edSave(); return; }   // Ctrl+click: junction
      nodeClick(e.id, i, ev.originalEvent.shiftKey); return;
    });

    m.bindTooltip(jn ? 'junction' : end ? 'end' : '', {direction: 'top', offset: [0, -8], permanent: false});
    S.edHandles.addLayer(m);
  });

  const insertAt = (i, at) => {      // new node in segment i (same type as the segment it splits)
    e.ctrl.splice(i + 1, 0, at); e.segs.splice(i, 0, e.segs[i]); if (e.tans) e.tans.splice(i + 1, 0, null); e.seg = null;
    e.junctions = new Set([...e.junctions].map(j => j > i ? j + 1 : j)); reTans(e);
  };

  for (let i = 0; i < n - 1; i++) {      // midpoint dots: drag (or click) to add a node there
    const mid = coords[(idx[i] + idx[i + 1]) >> 1];
    const m = L.marker(mid, {draggable: true, zIndexOffset: 700, icon: L.divIcon({className: 'mx', iconSize: [12, 12]})});
    let added = false;
    m.on('dragstart', () => { edPush(); insertAt(i, [...mid]); added = true; });
    m.on('drag', ev => { e.ctrl[i + 1] = [ev.latlng.lat, ev.latlng.lng]; reTans(e); drawLines(); });
    m.on('dragend', () => { renderEditor(); edSave(0); });
    m.on('click', () => { if (added) { added = false; return; } edPush(); insertAt(i, [...mid]); renderEditor(); edSave(0); });
    S.edHandles.addLayer(m);
  }

  $('#edstatus').textContent = '';
  drawSelHighlight();
}

function orientEnd(e, i, dir) {      // direction of travel at an end of the edit, given the direction of the track it snapped to
  const lat0 = e.ctrl[0][0], n = e.ctrl.length;
  const a = toXY(e.ctrl[i === 0 ? 0 : n - 2], lat0), b = toXY(e.ctrl[i === 0 ? 1 : n - 1], lat0);
  return orient(dir, [b[0] - a[0], b[1] - a[1]]);
}

$('#edname').oninput = e => { if (S.ed) { S.ed.name = e.target.value; edSave(500); } };
document.querySelectorAll('#edtracks button').forEach(b => b.onclick = () => { if (S.ed) { edPush(); S.ed.tracks = +b.dataset.n; renderEditor(); edSave(); } });
document.querySelectorAll('#edanchor button').forEach(b => b.onclick = () => { if (S.ed) { edPush(); S.ed.anchor = b.dataset.a; renderEditor(); edSave(); } });
$('#edspace').onchange = e => { if (S.ed) { edPush(); S.ed.spacing = Math.max(2, Math.min(60, +e.target.value || 4.5)); renderEditor(); edSave(); } };
document.querySelectorAll('#edsegmode button').forEach(b => b.onclick = () => { const e = S.ed; if (e && e.seg != null) { edPush(); e.segs[e.seg] = +b.dataset.s; reTans(e); renderEditor(); edSave(); } });
$('#edsegdel').onclick = deleteSelectedNodes;
$('#edselall').onclick = selectWholeTracks;
$('#edallstr').onclick = () => S.ed && setEdSegs(0);
$('#edallcur').onclick = () => S.ed && setEdSegs(1);
$('#eddone').onclick = () => { S.ed = null; renderEditor(); drawEditHits(); };
$('#eddelete').onclick = async () => {
  if (!S.ed || !confirm('Delete this track edit?')) return;
  await api('/api/edits/' + S.ed.id, {method: 'DELETE'}); S.ed = null; renderEditor(); afterEditChange();
};

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if ((e.key === 'p' || e.key === 'P') && (S.tool === 'draw' || S.tool === 'parallel') && !e.ctrlKey && !e.metaKey) setTool(S.tool === 'draw' ? 'parallel' : 'draw');
  if (S.tool === 'parallel' && !e.ctrlKey && !e.metaKey) { if (e.key === 'f' || e.key === 'F') parFlip(); if (e.key === 'Enter' || e.key === 'Escape') parAdd(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.tool === 'edit' && (nselCount() || S.laneSel)) { e.preventDefault(); deleteSelectedNodes(); }
  if (e.key === 'Escape' && S.tool === 'trace' && S.sel && !S.draft.length) deselect();
  if (e.key === 'Escape') {
    const pending = S.draft.length || S.ed || nselCount() || S.par || (S.sel && S.tool === 'trace');
    stopDraft(); S.draftLayer.clearLayers(); map.closePopup(); if (S.ed || nselCount()) { S.ed = null; nselClear(); renderEditor(); drawEditHits(); }
    if (!pending && S.tool !== 'trace' && !document.querySelector('.modal:not([hidden])')) setTool('trace');     // nothing left to cancel: leave the editor
  }

  if (e.key === 'Enter' && (S.tool === 'draw' || S.tool === 'erase')) stopDraft();
  if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && S.blueprints.length) buildBlueprints();
  if (S.tool === 'draw' && /^[1-6]$/.test(e.key) && !e.ctrlKey && !e.metaKey) setTracks(+e.key);
  if (S.tool === 'draw' && (e.key === '[' || e.key === ']')) { S.spacing = Math.max(2, Math.min(60, S.spacing + (e.key === ']' ? 0.5 : -0.5))); syncHud(); renderDraft(); }
  if (e.key === 'Backspace' && S.draft.length) { e.preventDefault(); popDraft(); if (!S.draft.length) S.tan.start = null; renderDraft(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (S.tool === 'erase' || S.tool === 'restore' || S.tool === 'adopt') { undoEditOp(); } else if ((S.tool === 'draw' || S.tool === 'erase') && S.draft.length) { popDraft(); if (!S.draft.length) S.tan.start = null; renderDraft(); } else if (S.tool !== 'trace' && S.tool !== 'edit' && bpUndo()) { } else if (S.tool === 'edit') { if (S.edOps.length && (S.lastEditAct === 'ops' || !(S.ed && S.ed.hist.length))) undoEditOp(); else if (S.ed) edUndo(); } else $('#undo').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && S.tool === 'trace') { e.preventDefault(); $('#save').click(); }
});

// Erase / Restore: hides or brings back OSM track; Show erased draws erased track dashed red
S.showErased = false;
function syncErased() { const b = $('#showErased'); if (b) b.classList.toggle('on', S.showErased || S.tool === 'restore'); refreshGraph(false); }
$('#showErased').onclick = () => { S.showErased = !S.showErased; syncErased(); refreshGraph(true); };
function say(html) { $('#routeinfo').innerHTML = html; }
async function segmentOp(kind, body) {
  try {
    const r = await api('/api/edits/' + kind, {method: 'POST', body: {scope: S.mapName, ...body}});
    if (kind === 'adopt') {
      if (!r.created.length) { say(`<div class="warn">${r.error || 'No track there.'}</div>`); return; }
      S.edOps.push({restore: [], created: r.created.map(x => x.id)}); S.lastEditAct = 'ops';
      say('<div class="good">That track is now editable: drag its nodes, or Ctrl+A then the arrow keys and [ ]. Ctrl+Z undoes it.</div>');
      afterEditChange(); setTool('edit'); selectEdit(r.edit); return;
    }

    if (kind === 'erase') {
      if (!r.edit) { say(`<div class="warn">${r.error || 'No track there to erase.'}</div>`); return; }
      S.edOps.push({restore: [], created: [r.edit.id]}); say(`<div class="good">Erased ${fmtLen(r.removed_m)} of track. Ctrl+Z undoes it.</div>`);
    } else {
      if (!r.undo.length) { say(`<div class="warn">${r.error || 'No erased track on this map between those points.'}</div>`); return; }
      S.edOps.push({restore: r.undo, created: []}); say(`<div class="good">Restored ${fmtLen(r.restored_m)} of track.</div>`);
    }

    S.lastEditAct = 'ops'; afterEditChange();
  } catch (err) { say(`<div class="bad">${kind} failed: ${err.message}</div>`); }
}

// Erase / Restore / Reshape: click where the stretch starts, then where it ends; Esc or right-click starts over
S.pickLayer = L.layerGroup().addTo(map); let pickT = null, pickSeq = 0;
const pickRadius = ll => 12 * 156543.03392 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
function clearPick() { clearTimeout(pickT); pickSeq++; S.pickLayer.clearLayers(); }
function eraseReset() { S.eraseFrom = null; S.eraseKind = null; clearPick(); if (S.eraseMark) { S.eraseMark.remove(); S.eraseMark = null; } }
const segTool = () => S.tool === 'erase' || S.tool === 'restore' || S.tool === 'adopt';
const SEGCOL = {erase: '#ff5d5d', restore: '#38bdf8', adopt: '#f59e0b'}, SEGVERB = {erase: 'erase', restore: 'restore', adopt: 'make editable'};
map.on('mousemove', e => {
  if (!segTool()) return;
  if (S.eraseKind && S.eraseKind !== S.tool) eraseReset();
  clearTimeout(pickT); const seq = ++pickSeq, kind = S.tool, a = S.eraseFrom, col = SEGCOL[kind];
  pickT = setTimeout(async () => {
    try {
      const r = await api('/api/edits/pick_path?' + q({scope: S.mapName, lat: e.latlng.lat, lng: e.latlng.lng, radius_m: pickRadius(e.latlng), ...(a ? {alat: a[0], alng: a[1]} : {})}));
      if (seq !== pickSeq) return;
      S.pickLayer.clearLayers();
      if (r.pts) L.polyline(r.pts, {color: col, weight: 7, opacity: .8, interactive: false, renderer: editRenderer}).addTo(S.pickLayer);
      if (r.snap) L.circleMarker(r.snap, {radius: 5, color: col, weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false, renderer: editRenderer}).addTo(S.pickLayer);
    } catch (_) {}
  }, 60);
});

map.on('mouseout', () => { if (!S.eraseFrom) clearPick(); });
map.on('click', e => {
  if (!segTool()) return;
  const kind = S.tool, col = SEGCOL[kind];
  if (!S.eraseFrom) {
    S.eraseFrom = [e.latlng.lat, e.latlng.lng]; S.eraseKind = kind;
    S.eraseMark = L.circleMarker(e.latlng, {radius: 6, color: col, weight: 3, fillColor: '#fff', fillOpacity: 1, interactive: false, renderer: editRenderer}).addTo(map);
    say(`<div class="muted">Now click where the stretch to ${SEGVERB[kind]} ends (Esc to cancel).</div>`); return;
  }

  const a = S.eraseFrom; eraseReset();
  segmentOp(kind, {a, b: [e.latlng.lat, e.latlng.lng], radius_m: pickRadius(e.latlng)});
});

map.on('contextmenu', () => { if (segTool() && S.eraseFrom) { eraseReset(); say(''); } });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && segTool() && S.eraseFrom) { eraseReset(); say(''); } });
// "Undo last edit" (the most recent draw / erase, on either map)
async function loadEdits() {
  const r = await api('/api/edits');
  $('#undoEdit').disabled = !r.count;
}

$('#undoEdit').onclick = async () => {
  await api('/api/edits/last', {method: 'DELETE'}); S.editVer = (S.editVer ?? 0) + 1;
  clearLegCache(); await loadEdits(); refreshGraph(true); refreshEdits(); loadCatalog(); scheduleRoute(0);
};

// Track overlay: canvas-drawn fixed tiles, swapped in without clearing
const gTiles = new Map();
// Zoomed out outside the drawing tools nothing snaps to the track, so tiles drop points under a third of a pixel apart
const DRAW_TOOLS = ['draw', 'parallel', 'edit', 'erase', 'restore', 'adopt', 'direction', 'nogo'];
const tileLod = z => z <= 12 && !DRAW_TOOLS.includes(S.tool) ? 1 : 0;
async function loadTiles(pb, z, er, ver, seq) {
  z = Math.min(z, 13);
  const lod = tileLod(z), sz = 0.02 * 2 ** Math.max(0, 13 - z), i0 = Math.floor(pb.getSouth() / sz), i1 = Math.floor(pb.getNorth() / sz), j0 = Math.floor(pb.getWest() / sz), j1 = Math.floor(pb.getEast() / sz);
  const jobs = [], todo = [], cy = (pb.getSouth() + pb.getNorth()) / 2, cx = (pb.getWest() + pb.getEast()) / 2;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const k = `${S.mapName}:${ver}:${er}:${z}:${lod}:${i}:${j}`;
    if (!gTiles.has(k)) todo.push({k, i, j, d: Math.hypot((i + .5) * sz - cy, (j + .5) * sz - cx)});
    jobs.push(k);
  }

  todo.sort((a, b) => a.d - b.d);
  let next = 0;                                                            // a few at a time, nearest the middle first, so the rest of the page is not starved
  const fetchTile = t => { const pr = api('/api/edge_tile?' + q({map: S.mapName, erased: er, z, lod, i: t.i, j: t.j})).catch(e => { gTiles.delete(t.k); throw e; }); gTiles.set(t.k, pr); return pr; };
  const worker = async () => { while (next < todo.length && seq === gSeq) await fetchTile(todo[next++]); };          // a newer view stops the rest
  const pending = Promise.all([worker(), worker(), worker()]);
  if (gTiles.size > 400) for (const k of [...gTiles.keys()].slice(0, 150)) gTiles.delete(k);
  const seen = new Set(), out = [], s = pb.getSouth(), n = pb.getNorth(), w = pb.getWest(), e = pb.getEast();
  await pending;
  if (seq !== gSeq) return null;
  for (const part of await Promise.all(jobs.map(k => gTiles.get(k)))) for (const it of part) {           // an edge crossing a tile edge comes with both tiles: keep it once, and only what is near the view
    const id = it.k + ':' + (it.id || it.p[0]);
    if (seen.has(id)) continue; seen.add(id);
    let a = 90, b = -90, c = 180, d = -180; for (const p of it.p) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
    if (b >= s && a <= n && d >= w && c <= e) out.push(it);
  }

  return out;
}

let gTimer, gSeq = 0, gBox = null, gKey = '';
function refreshGraph(force) {
  clearTimeout(gTimer);
  gTimer = setTimeout(async () => {
    const low = map.getZoom() < GRAPH_MIN_ZOOM;
    $('#zoomhint').style.display = low ? 'block' : 'none';
    if (low) { if (S.graph.getLayers().length) S.graph.clearLayers(); gBox = null; return; }
    const b = map.getBounds(), er = S.showErased || S.tool === 'restore' ? 1 : 0, zt = Math.min(map.getZoom(), 13), k = [S.mapName, S.editVer ?? 0, er, zt, tileLod(zt)].join(':');
    if (!force && gBox && k === gKey && gBox.contains(b)) return;       // current data still covers the view
    const pb = b.pad(map.getZoom() <= 11 ? 0.2 : 0.5), seq = ++gSeq;          // zoomed out, a smaller margin: those tiles are big
    let items; try { items = await loadTiles(pb, map.getZoom(), er, S.editVer ?? 0, seq); } catch (e) { return; }
    if (seq !== gSeq || !items) return;
    S.graphItems = items.filter(i => i.k === 'base');
    const next = L.layerGroup();
    for (const i of items) {
      const lr = ['subway', 'light_rail', 'tram'].includes(i.c);
      const st = S_SAT
        ? (i.k === 'added' ? {color: '#4ade80', weight: 4.5} : i.k === 'removed' ? {color: '#f87171', weight: 4, dashArray: '4 5'} : {color: lr ? '#e879f9' : '#38bdf8', weight: 3})
        : (i.k === 'added' ? {color: '#12a150', weight: 3.5} : i.k === 'removed' ? {color: '#e5484d', weight: 3.5, dashArray: '4 5'} : {color: lr ? '#9333ea' : '#2563eb', weight: 2.2});
      if (i.k === 'base' && (i.c === 'construction' || i.c === 'proposed')) { st.color = S_SAT ? '#fbbf24' : '#d97706'; st.dashArray = i.c === 'proposed' ? '3 6' : '8 5'; st.weight = S_SAT ? 3.2 : 2.6; }     // OSM / OpenRailwayMap track not built yet (Future map only)
      L.polyline(i.p, {...st, opacity: 1, interactive: false, smoothFactor: 1, renderer: graphRenderer}).addTo(next);
    }

    next.addTo(map);                       // new layer is on screen before the old one goes
    const old = S.graph; S.graph = next; map.removeLayer(old);
    if (S.pendClear && !keyMove) { S.pendClear = false; S.pendLayer.clearLayers(); }
    gBox = pb; gKey = k;
  }, 120);
}

let moveT = null;
map.on('moveend', () => { refreshGraph(false); clearTimeout(moveT); moveT = setTimeout(() => { if (S.tool !== 'trace' && S.tool !== 'stations' && S.tool !== 'dests') refreshEdits(); }, S.keys && S.keys.size ? 250 : 0); });

// WASD pans the camera (Shift = faster)
S.keys = new Set();
const PANKEYS = {w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0]};
let panRaf = null, panLast = 0;
function panLoop(t) {
  const dt = Math.min(50, t - panLast) / 1000; panLast = t;
  let dx = 0, dy = 0; S.keys.forEach(k => { dx += PANKEYS[k][0]; dy += PANKEYS[k][1]; });
  if (dx || dy) {
    const sp = (S.shift ? 2800 : 1100) * dt, len = Math.hypot(dx, dy);
    map.panBy([dx / len * sp, dy / len * sp], {animate: false});
    if (draftCursor && S.lastMouse) previewDraft(map.mouseEventToLatLng(S.lastMouse));          // keep the preview under the unmoved mouse
    panRaf = requestAnimationFrame(panLoop);
  } else panRaf = null;
}

const typing = e => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || !PANKEYS[k]) return;
  if (S.tool === 'trace' && k === 's' && false) return;
  S.keys.add(k); if (!panRaf) { panLast = performance.now(); panRaf = requestAnimationFrame(panLoop); }
  e.preventDefault();
});

document.addEventListener('keydown', e => {                    // Q zoom out · E zoom in
  if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'q') map.zoomOut(1); else if (k === 'e') map.zoomIn(1);
});

document.addEventListener('keyup', e => { S.keys.delete(e.key.toLowerCase()); });
window.addEventListener('blur', () => S.keys.clear());
map.getContainer().addEventListener('mousemove', e => { S.lastMouse = e; });

// Report / status
async function loadStatus() {
  const s = await api('/api/status');
  $('#graphinfo').textContent = `graph: ${s.graph} · ${Number(s.edges).toLocaleString()} edges` + (s.has_kinds ? ` · ${Number(s.future_track).toLocaleString()} planned/under-construction` : ' · re-run setup/update to include planned and under-construction track');
  const r = s.report;
  $('#report').innerHTML = !r || !r.when ? 'No OSM update recorded yet.' :
    `Last update ${r.when.slice(0, 10)} from ${r.source}<br>` +
    `${(r.edits || []).filter(e => e.status !== 'ok').length} edit(s) need attention · ${(r.routes_changed || []).length} route(s) changed · ${(r.routes_failed || []).length} failed`;
}

$('#recompile').onclick = async () => {
  if (!confirm('Re-route every saved trace on both maps?')) return;
  const r = await api('/api/compile', {method: 'POST', body: {}});
  alert(`${r.total} routes compiled, ${r.failed.length} with problems.`); loadCatalog();
};

window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// Refresh every line the track changed this session may affect
async function updateDirty() {
  try {
    const d = await api('/api/dirty'), b = $('#refreshAffected');
    b.disabled = !d.changed; b.textContent = d.changed ? `Refresh affected lines (${d.lines})` : 'Refresh affected lines';
    b.title = d.changed ? `Track changed since the last refresh. Lines that pass near it, or could now route through it, will be re-routed from their waypoints:\n` + d.names.join('\n') + (d.lines > d.names.length ? '\n…' : '') : 'No track changed since the last refresh.';
  } catch (e) {}
}

function showChanged(list) {              // the lines whose route changed, to open one by one and check (opened ones dim)
  const box = $('#changedlist'); box.textContent = ''; box.hidden = !list.length; if (!list.length) return;
  box.append(el('div', 'op', `Changed lines (${list.length})`));
  for (const x of list) {
    const p = S.catalog.find(c => key(c) === key(x)); if (!p) continue;
    const d = el('div', 'pat'); d.append(el('span', 'dot ' + dotClass(p)), el('span', '', `${x.operator} — ${x.line} — ${x.pattern}`), el('span', 'cat', FUT(p.category) ? 'Future' : 'Present'));
    d.onclick = () => { d.classList.add('seen'); selectPattern(p, {fit: false}); };       // opening a changed line leaves the camera where it is
    box.append(d);
  }
}

$('#refreshAffected').onclick = async () => {
  const b = $('#refreshAffected'); if (S.dirty && !confirm('Unsaved changes to the open route will be kept, but its saved version is refreshed. Continue?')) return;
  b.disabled = true; b.textContent = 'Refreshing…';
  try {
    const r = await api('/api/refresh_affected', {method: 'POST', body: {}, timeout: 1800000});
    $('#routeinfo').innerHTML = `<div class="good">Refreshed ${r.count} line${r.count === 1 ? '' : 's'}: ${r.changed} changed.</div>` +
      r.bad.map(x => `<div class="bad">${x.pattern} [${x.category}]: ${x.warnings.join('; ')}</div>`).join('') + r.notes.map(x => `<div class="warn">${x.pattern} [${x.category}]: ${x.warnings.join('; ')}</div>`).join('');
    S.lastChanged = r.changed_lines;
  } catch (e) { $('#routeinfo').innerHTML = `<div class="bad">Refresh failed: ${e.message}</div>`; }

  clearLegCache(); await loadCatalog(); updateDirty(); if (S.lastChanged) showChanged(S.lastChanged);
  if (S.sel && !S.dirty) reloadSelection();
};

// Rebuilds the points of curves saved by older versions (jittery sample points), same nodes and shape
async function smoothBuilt() {
  try {
    const list = await api('/api/edits/view?' + q({map: 'future', bbox: '-90,-180,90,180', limit: 100000})); let n = 0;
    for (const e of list) {
      if (e.op !== 'add_track' || !e.ctrl || !e.segs || !e.segs.some(Boolean)) continue;
      const m = modelOf(e), {coords, idx} = buildCoords(m.ctrl, m.segs, m.tan, 5, m.tans);
      const same = coords.length === e.coords.length && coords.every((p, i) => Math.abs(p[0] - e.coords[i][0]) < 5e-6 && Math.abs(p[1] - e.coords[i][1]) < 5e-6);
      if (same) continue;
      const body = recBody(e); body.coords = coords; body.op = e.op; body.scope = e.scope;
      if (e.junctions && e.junctions.length) body.joins = [...new Set([0, coords.length - 1, ...e.junctions.map(i => idx[i])])].sort((a, b) => a - b);
      await api('/api/edits/' + e.id + '?quiet=1', {method: 'PUT', body}); n++;
    }

    if (n) { refreshGraph(true); refreshEdits(); }
  } catch (_) {}
}

setMap('present', true); setTool('trace'); updateDirty(); smoothBuilt();
Promise.all([loadCatalog(), loadStatus(), loadEdits()]);