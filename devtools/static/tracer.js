'use strict';
const $ = s => document.querySelector(s);
const api = async (url, opt) => {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), (opt && opt.timeout) || 300000);      // never wait forever on the server
  try {
    const r = await fetch(url, {...(opt ? {method: opt.method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(opt.body)} : {}), signal: ctl.signal});
    if (!r.ok) throw new Error(url + ' -> ' + r.status);
    const out = await r.json(); if (opt && opt.method && opt.method !== 'GET') S_TRACE.clear();
    return out;
  } catch (e) { throw e.name === 'AbortError' ? new Error(url + ' timed out') : e; }
  finally { clearTimeout(timer); }
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
const base = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 21, maxNativeZoom: 19, attribution: '© OSM'});
const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'});
const satLabels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {maxZoom: 21, maxNativeZoom: 19, opacity: .9});
const orm = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {maxZoom: 21, maxNativeZoom: 19, opacity: .8, attribution: 'OpenRailwayMap'});
let savedBase = 'map';
try { savedBase = localStorage.getItem('tracerBase') || 'map'; } catch (e) {}
(savedBase === 'sat' ? sat : base).addTo(map);
S_SAT = savedBase === 'sat';
L.control.layers({'Map': base, 'Satellite': sat}, {'Place names (satellite)': satLabels, 'OpenRailwayMap': orm}, {collapsed: true}).addTo(map);
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

const S = {
  catalog: [], sel: null, wps: [], stops: [], hist: [], mapName: 'present', tool: 'trace', loop: true /* every route returns to its start */, readonly: false, reuse: null, stationMoves: {},
  graph: L.layerGroup().addTo(map), routeLayer: L.layerGroup().addTo(map), wpLayer: L.layerGroup().addTo(map),
  ghostLayer: L.layerGroup().addTo(map), stationLayer: L.layerGroup().addTo(map), draft: [], draftLayer: L.layerGroup().addTo(map), dirty: false, markers: [],
};

// ── catalog tree ────────────────────────────────────────────────────────────
async function loadCatalog() { S.catalog = await api('/api/catalog'); renderTree(); }
function dotClass(p) { return p.same_as_present ? 'linked' : p.compiled ? 'ok' : p.waypoints ? 'has' : ''; }
// ── route list: collapsible operators (state remembered), recent routes, hover prefetch, keyboard (↑ ↓ Enter, "/" to search) ──
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
S.openOps = new Set(lsGet('tracerOpenOps', []));
function pushRecent(p) {
  const r = lsGet('tracerRecent', []).filter(x => key(x) !== key(p)); r.unshift(ids(p)); lsSet('tracerRecent', r.slice(0, 8));
}
function patRow(p) {
  const d = el('div', 'pat' + (S.sel && key(S.sel) === key(p) ? ' sel' : ''));
  d.append(el('span', 'dot ' + dotClass(p)), el('span', '', p.pattern), el('span', 'cat', FUT(p.category) ? 'Future' : 'Present'));
  let hv = null;
  d.onmouseenter = () => { hv = setTimeout(() => getTrace(p).catch(() => {}), 40); }; d.onmouseleave = () => clearTimeout(hv); d.onmousedown = () => getTrace(p).catch(() => {});
  d.onclick = () => S.sel && key(S.sel) === key(p) ? deselect() : selectPattern(p);
  d._p = p; return d;
}
function renderTree() {
  const f = $('#filter').value.trim().toLowerCase(), t = $('#tree'), frag = document.createDocumentFragment();
  const by = {};
  for (const p of S.catalog) {
    if (f && !(p.operator + ' ' + p.line + ' ' + p.pattern).toLowerCase().includes(f)) continue;
    ((by[p.operator] ??= {})[p.line] ??= []).push(p);
  }
  if (!f) {
    const recent = lsGet('tracerRecent', []).map(r => S.catalog.find(c => key(c) === key(r))).filter(Boolean);
    if (recent.length) { frag.append(el('div', 'op', 'Recent')); recent.forEach(p => { const d = patRow(p); d.firstChild.after(el('span', 'rl', p.operator + ' — ' + p.line + ' · ')); frag.append(d); }); }
  }
  for (const [op, lines] of Object.entries(by)) {
    const n = Object.values(lines).reduce((a, l) => a + l.length, 0), open = !!f || S.openOps.has(op) || (S.sel && S.sel.operator === op);
    const h = el('div', 'op opx' + (open ? ' open' : ''), `${open ? '▾' : '▸'} ${op}  (${n})`);
    h.onclick = () => { S.openOps.has(op) ? S.openOps.delete(op) : S.openOps.add(op); lsSet('tracerOpenOps', [...S.openOps]); renderTree(); };
    frag.append(h);
    if (!open) continue;
    for (const [ln, pats] of Object.entries(lines)) { frag.append(el('div', 'ln', ln)); pats.forEach(p => frag.append(patRow(p))); }
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

// ── selection ───────────────────────────────────────────────────────────────
// Deselect: nothing is being edited, so clicking the map no longer touches any route's waypoints.
function deselect() {
  if (!S.sel) return true;
  if (S.dirty && !confirm('Discard unsaved changes?')) return false;
  S.sel = null; S.dirty = false; S.hist = []; S.stationMoves = {}; S.wps = []; S.stops = []; S.readonly = false; S.inherit = S.reuse = null; S.cands = []; S.deps = [];
  S.preview = null; S.stationLayer.clearLayers(); clearLegCache();
  $('#routetitle').textContent = 'No route selected'; $('#routemeta').textContent = ''; $('#routeinfo').textContent = '';
  $('#deselect').hidden = true; $('#undo').hidden = $('#clear').hidden = false;
  renderInherit(); markSel(); drawWps(); scheduleRoute(0);
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
  pushRecent(p);
  S.ownWps = t.waypoints.map(x => x.slice());
  S.cands = FUT(p.category) ? t.candidates || [] : [];
  S.deps = FUT(p.category) ? [] : t.dependents || []; S.depsReady = !!t.dependents_ready;
  S.inherit = FUT(p.category) && t.same_as_present ? t.same_as_present : null;   // Present route whose waypoints this Future route uses
  S.reuse = S.inherit; S.readonly = false;                                       // ...its waypoints are edited from either route: the change is saved to the Present route and both are recompiled
  S.wps = (S.inherit ? t.reused_waypoints : t.waypoints).map(x => x.slice());
  S.stops = S.wps.map((_, i) => (S.inherit ? t.reused_stops : t.stops)?.[i] || null);        // a stop is pinned to a station / platform of map_data.py
  setMap(FUT(p.category) ? 'future' : 'present', true);     // a Future route is always routed on the Future map, even when its waypoints are inherited
  $('#routetitle').textContent = `${p.operator} — ${p.line}`;
  $('#routemeta').textContent = `${p.pattern} · ${p.mode ?? ''} · ${FUT(p.category) ? 'Future' : 'Present'}`;
  renderInherit(); $('#deselect').hidden = false;
  $('#undo').hidden = $('#clear').hidden = S.readonly;
  if (!markSel()) renderTree();                         // the row is not in the list (collapsed operator, opened from a list of changes): rebuild it
  const fit = !(opt && opt.fit === false);
  if (fit) {
    if (S.wps.length) map.fitBounds(L.latLngBounds(S.wps), {padding: [40, 40], animate: false});
    else if (t.geometry && t.geometry.length) map.fitBounds(L.latLngBounds(t.geometry.flat()), {padding: [40, 40], animate: false});
  }
  drawWps(); scheduleRoute(0); loadStations(p);
}

// ── stations of the selected line: shown on the map, draggable, saved back into map_data.py ──
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

// ── waypoints ───────────────────────────────────────────────────────────────
function push() { S.hist.push(JSON.stringify({w: S.wps, s: S.stops})); if (S.hist.length > 100) S.hist.shift(); S.dirty = true; }
const editable = () => S.tool === 'trace' && S.sel && !S.readonly;
function changed(delay) { drawWps(); scheduleRoute(delay ?? 0); }
function removeWp(i) { push(); S.wps.splice(i, 1); S.stops.splice(i, 1); map.closePopup(); changed(); }
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
    m.on('contextmenu', () => { if (editable()) removeWp(i); });
    m.on('dblclick', e => { L.DomEvent.stop(e); if (editable()) removeWp(i); });
    m.on('click', e => {
      if (S.readonly) return;
      if (e.originalEvent.altKey) return removeWp(i);
      const box = el('div', 'wppop'); box.append(el('div', '', `Waypoint ${i + 1}`));
      const del = el('button', '', 'Delete'); del.onclick = () => removeWp(i);
      box.append(del);
      if (S.stops[i]) { const un = el('button', '', 'Unpin from station'); un.title = 'Keep this waypoint here, but stop following the station'; un.onclick = () => { push(); S.stops[i] = null; map.closePopup(); changed(); }; box.append(un); }
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
  if (from === to || to < 0 || to >= S.wps.length) return;
  push(); S.wps.splice(to, 0, S.wps.splice(from, 1)[0]); S.stops.splice(to, 0, S.stops.splice(from, 1)[0]); changed();
}
function renderWpList() {
  const box = $('#wplist'); box.textContent = '';
  $('#wpcount').textContent = S.wps.length;
  if (!S.wps.length) { box.textContent = S.sel ? ('Click the map to add waypoints.') : 'Select a route, then click the map.'; return; }
  const can = editable();
  S.wps.forEach((w, i) => {
    const r = el('div', 'wprow');
    r.append(el('span', 'n', String(i + 1)), el('span', 'c', S.stops[i] ? '⚑ ' + S.stops[i] : `${w[0].toFixed(4)}, ${w[1].toFixed(4)}`));
    if (can) {
      // reorder: drag the ⠿ grip onto another row, or use ▲ ▼
      const grip = el('span', 'grip', '⠿'); grip.title = 'Drag to reorder'; r.prepend(grip);
      r.draggable = true;
      r.ondragstart = e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); };
      r.ondragend = () => box.querySelectorAll('.wprow').forEach(x => x.classList.remove('dragging', 'over'));
      r.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; r.classList.add('over'); };
      r.ondragleave = () => r.classList.remove('over');
      r.ondrop = e => { e.preventDefault(); const from = parseInt(e.dataTransfer.getData('text/plain'), 10); if (!isNaN(from)) moveWp(from, i); };
      const up = el('button', 'mv', '▲'); up.title = 'Move earlier'; up.disabled = i === 0;
      up.onclick = e => { e.stopPropagation(); moveWp(i, i - 1); };
      const dn = el('button', 'mv', '▼'); dn.title = 'Move later'; dn.disabled = i === S.wps.length - 1;
      dn.onclick = e => { e.stopPropagation(); moveWp(i, i + 1); };
      const add = el('button', '', '＋'); add.title = 'Insert a waypoint after this one (midway along the route)';
      add.onclick = e => { e.stopPropagation(); insertWp(i + 1, midpointAfter(i)); };
      const del = el('button', '', '✕'); del.title = 'Delete this waypoint';
      del.onclick = e => { e.stopPropagation(); removeWp(i); };
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

// ── routing (per-leg cache: only changed legs are re-routed) ────────────────
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

// ── inserting a waypoint by grabbing the route ──────────────────────────────
// Every leg gets a wide invisible grab zone. Pressing on it starts the gesture: a new waypoint is created
// right there and follows the mouse until release. The gesture is handled here (not by Leaflet's click
// logic) and the click the browser sends afterwards is swallowed, so it can never append a stray waypoint.
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
    push(); S.wps.push([e.latlng.lat, e.latlng.lng]); S.stops.push(null); changed(0);
  } else if (S.tool === 'edit') {
    if (S.ed) { S.ed = null; renderEditor(); drawEditHits(); }
  }
  else if (S.tool === 'erase' || S.tool === 'restore') return;
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
      out.push(`<div class="good">Moved ${r.moved} station${r.moved === 1 ? '' : 's'} in map_data.py (backup: devtools/cache/map_data.backup.py).</div>`);
      S.stationMoves = {}; loadStations(S.sel);
    }
    {
      const body = {...ids(S.sel)};
      body.waypoints = S.wps; body.stops = S.stops;                           // a Future route that inherits saves them to the Present route, and both are recompiled
      if (FUT(S.sel.category)) body.same_as_present = S.inherit;
      const r = await api('/api/trace', {method: 'PUT', body});
      const warns = r.reports.flatMap(x => x.warnings.map(w => `${x.pattern} [${x.category}]: ${w}`));
      out.push(`<div class="good">Saved &amp; compiled ${r.reports.length} route(s).</div>` + warns.map(w => `<div class="warn">${w}</div>`).join(''));
    }
    S.dirty = false;
  } catch (e) { out.push(`<div class="bad">Save failed: ${e.message}</div>`); }
  $('#routeinfo').innerHTML = out.join('');
  await loadCatalog();
};

// ── Future routes may inherit waypoints from a Present route with the same station sequence ──
// Every action here saves immediately (no separate Save): pick a Present route to follow, switch to another, or take a copy to edit.
const refKey = r => r && `${r.operator}|${r.line}|${r.pattern}`;
const refName = (r, p) => r.operator === p.operator && r.line === p.line ? r.pattern : `${r.operator} — ${r.line} — ${r.pattern}`;
function renderDeps() {                             // Present route selected: Future routes with the same stations may follow its waypoints
  const p = S.sel, row = $('#depRow'), deps = S.deps || [];
  row.hidden = !(p && !FUT(p.category) && deps.length);
  if (row.hidden) return;
  $('#depText').textContent = S.depsReady ? `${deps.length} Future route${deps.length === 1 ? ' has' : 's have'} the same stations. Tick the ones that should use these waypoints (still routed on the Future map):` : `${deps.length} Future route${deps.length === 1 ? ' has' : 's have'} the same stations. Save waypoints for this route first, then they can follow it.`;
  const box = $('#depList'); box.textContent = '';
  deps.forEach(d => {
    const lab = el('label'), cb = el('input'); cb.type = 'checkbox'; cb.checked = d.following; cb.disabled = !S.depsReady;
    const sp = el('span', '', refName(d, p)); if (d.other) sp.append(el('span', 'muted', ` — now follows “${refName(d.other, p)}”`));
    cb.onchange = async () => {
      cb.disabled = true;
      try {
        const r = await api('/api/trace', {method: 'PUT', body: {...ids(d), category: 'Fantasy', same_as_present: cb.checked ? {operator: p.operator, line: p.line, pattern: p.pattern} : null}});
        const t = await api('/api/trace?' + q(ids(p))); S.deps = t.dependents || [];
        $('#routeinfo').innerHTML = `<div class="good">${d.pattern} ${cb.checked ? 'now follows this route' : 'stopped following it'} (recompiled).</div>`;
        await loadCatalog();
      } catch (e) { cb.checked = !cb.checked; $('#routeinfo').innerHTML = `<div class="bad">${e.message}</div>`; }
      renderDeps();
    };
    lab.append(cb, sp); box.append(lab);
  });
}
function renderInherit() {
  renderDeps();
  const p = S.sel, row = $('#inheritRow');
  row.hidden = !(p && FUT(p.category) && (S.cands.length || S.inherit));
  if (row.hidden) { $('#inheritUse').hidden = $('#inheritGo').hidden = $('#inheritCopy').hidden = true; return; }
  const list = [...S.cands];
  if (S.inherit && !list.some(c => refKey(c) === refKey(S.inherit))) list.push({...S.inherit, waypoints: '?'});
  const sel = $('#inheritSel'); sel.textContent = '';
  list.forEach(c => { const o = el('option', '', refName(c, p) + (c.waypoints === '?' ? '' : ` · ${c.waypoints} waypoints`)); o.value = refKey(c); sel.append(o); });
  sel.value = refKey(S.inherit || list[0]);
  sel.hidden = list.length < 2;
  const one = list.length === 1 ? `“${refName(list[0], p)}”` : '';
  $('#inheritText').textContent = S.inherit
    ? (list.length > 1 ? 'Sharing the waypoints of a Present route (routed on the Future map):' : `Sharing the waypoints of Present route “${refName(S.inherit, p)}”: edit them here or there, both change. Still routed on the Future map.`)
    : (list.length > 1 ? `Same stations as ${list.length} Present routes. Pick one to follow:` : `Same stations as Present route ${one}.`);
  $('#inheritUse').hidden = !!S.inherit;
  $('#inheritGo').hidden = $('#inheritCopy').hidden = !S.inherit;
}
async function reloadSelection(msg) {
  const p = S.sel; S.dirty = false;
  await loadCatalog();
  await selectPattern(S.catalog.find(c => key(c) === key(p)) || p);
  if (msg) $('#routeinfo').innerHTML = `<div class="good">${msg}</div>`;
}
async function applyInherit(ref) {
  if (S.dirty && !confirm('Discard unsaved changes to this route?')) return renderInherit();
  const r = await api('/api/trace', {method: 'PUT', body: {...ids(S.sel), same_as_present: ref}});
  const warns = r.reports.flatMap(x => x.warnings);
  await reloadSelection(ref ? 'Now following that Present route.' : 'Stopped following.');
  if (warns.length) $('#routeinfo').innerHTML += warns.map(w => `<div class="warn">${w}</div>`).join('');
}
const pickedRef = () => { const c = S.cands.find(c => c.operator + '|' + c.line + '|' + c.pattern === $('#inheritSel').value) || S.cands[0]; return c && {operator: c.operator, line: c.line, pattern: c.pattern}; };
$('#inheritUse').onclick = () => { const r = pickedRef(); if (r) applyInherit(r); };
$('#inheritSel').onchange = () => { if (S.inherit) { const r = pickedRef(); if (r) applyInherit(r); } };
$('#inheritCopy').onclick = async () => {          // stop following, but keep the waypoints as this route's own so they can be edited
  const r = await api('/api/trace', {method: 'PUT', body: {...ids(S.sel), same_as_present: null, waypoints: S.wps, stops: S.stops}});
  await reloadSelection('This route now has its own copy of the waypoints.');
};
$('#inheritGo').onclick = () => {
  const c = S.inherit && S.catalog.find(c => c.operator === S.inherit.operator && c.line === S.inherit.line && c.category === 'Present' && c.pattern === S.inherit.pattern);
  if (c) selectPattern(c);
};

// ── map / tool switching ────────────────────────────────────────────────────
function setMap(m, quiet) {
  const was = S.mapName;
  if (m !== S.mapName) clearLegCache();
  S.mapName = m;
  document.querySelectorAll('#mapsw button').forEach(b => b.classList.toggle('on', b.dataset.m === m));
  if (S.tool !== 'trace') { S.editsView = []; S.ed = null; renderEditor(); refreshEdits(); }
  refreshGraph(m !== was); if (!quiet) scheduleRoute(0);
}
function setTool(t) {
  setTimeout(() => drawBpHandles(), 0);
  if (t !== 'trace' && S.sel && !deselect()) return;  // drawing never edits a route's waypoints: leave the route first
  if (t !== 'trace') S.lastDraw = t;
  if (S.par && t !== 'parallel') parAdd();          // a pending parallel selection becomes blueprints rather than vanishing
  stopDraft();
  S.tool = t; if (t !== 'parallel') S.par = null; S.parHover = null; S.parLayer.clearLayers(); $('#parhud').hidden = t !== 'parallel'; if (t === 'parallel') renderPar(); S.draft = []; S.draftSegs = []; S.draftTans = []; S.draftSn = []; S.draftStr = []; S.tan = {start: null, end: null}; S.draftLayer.clearLayers(); hideRing();
  if (t !== 'edit') { S.ed = null; nselClear(); }
  const boxy = t === 'erase' || t === 'restore';
  if (t === 'edit' || boxy) { map.dragging.disable(); map.boxZoom.disable(); } else { map.dragging.enable(); map.boxZoom.enable(); }
  map.getContainer().classList.toggle('boxtool', boxy); clearPick(); syncErased();
  document.querySelectorAll('#toolsw button').forEach(b => b.classList.toggle('on', (b.dataset.t === 'trace') === (t === 'trace')));
  document.querySelectorAll('#modebar button[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); $('#modebar').hidden = t === 'trace';
  $('#hud').hidden = t !== 'draw'; syncHud();
  renderEditor(); drawWps(); drawEditHits(); if (t !== 'trace') refreshEdits(); else { S.editsView = []; }
}
document.querySelectorAll('#mapsw button').forEach(b => b.onclick = () => setMap(b.dataset.m));
document.querySelectorAll('#toolsw button').forEach(b => b.onclick = () => setTool(b.dataset.t === 'draw' ? (S.tool !== 'trace' ? S.tool : S.lastDraw || 'draw') : 'trace'));
document.querySelectorAll('#modebar button').forEach(b => b.onclick = () => setTool(b.dataset.tool));
L.DomEvent.disableClickPropagation($('#modebar'));
const DRAWMODE = {straight: 0, curve: 1};
document.querySelectorAll('#drawmode button').forEach(b => b.onclick = () => setDrawMode(DRAWMODE[b.dataset.d]));
function setDrawMode(v) { S.drawMode = v; syncDrawMode(); renderDraft(); }
function syncDrawMode() { document.querySelectorAll('#drawmode button').forEach(b => b.classList.toggle('on', DRAWMODE[b.dataset.d] === S.drawMode)); }
S.drawMode = 1; syncDrawMode();                // drawing is always Curve; hold Left Ctrl for a straight run
// ── on-map build bar (draw tool), like NIMBY Rails: segment type · number of parallel tracks · which one you are drawing · spacing ──
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

// ── geometry for custom tracks: straight + curved segments, parallel tracks, snapping ──
const M_LAT = 111320, SNAP_PX = 14;
const toXY = (p, lat0) => [p[1] * M_LAT * Math.cos(lat0 * Math.PI / 180), p[0] * M_LAT];          // [east, north] metres
const fromXY = (x, y, lat0) => [y / M_LAT, x / (M_LAT * Math.cos(lat0 * Math.PI / 180))];
const unit = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const orient = (d, ref) => dot2(d, ref) >= 0 ? d : [-d[0], -d[1]];
const r6 = p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
// segment types: 0 straight · 1 curve (passes smoothly through every node you click, so you can trace trails; leaves snapped track tangentially)
const segFlags = (segs, n) => Array.from({length: Math.max(0, n - 1)}, (_, i) => segs && segs[i] ? (segs[i] === 2 ? 2 : 1) : 0);     // 0 straight · 1 curve · 2 curve that runs out straight

// Each segment between two nodes is straight or curved. Like NIMBY Rails, a curved segment leaves the previous one tangentially
// (a circular arc ending at the next node), so track you build runs on smoothly and placing a node never re-bends what is before it.
// A straight segment goes where you click, corner or not. The first segment leaves along the track it was snapped to (`tan.start`),
// and if the last node was snapped to another track the curve is a biarc (two arcs) that arrives along it (`tan.end`).
// Constant-curvature arcs, like real railway geometry and the OSM curves on the basemap.
// -> {coords: sampled polyline (a point every ≈5 m on curves), idx: where each node landed in it, rad: radius of each segment (m, Infinity = straight)}
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
// A curve that finishes straight: an arc leaves the previous direction, then a straight line runs to the node (so the line points where you aimed).
// Rebuilt from the node, the direction it leaves the previous node and the direction of the straight part.
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
// How a segment from a (leaving along unit t0) to b is laid: -> {mode: 0 straight · 1 single arc · 2 arc then straight, t0, t1: direction it ends in}
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
// Lay a whole model out again from its nodes, front to back (after a node moved, was added or deleted): every segment starts in the direction the last one ended in.
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
// Parallel tracks of slightly different widths: where a multi-track line starts or ends on existing parallel track, each lane's distance is
// measured from the neighbouring track actually there (if within tolerance of the ideal spacing) so the lanes link up exactly.
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

// nearest existing track (OSM graph in view + custom tracks incl. every parallel lane) within SNAP_PX: a node (track end) wins over
// a point along a segment. -> {ll, dir: unit [east, north] of the track there, node} or null. Alt disables snapping.
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

// ── drawing new tracks: chain of nodes, each new segment Straight or Curved ──
S.draftSegs = []; S.draftTans = []; S.draftSn = []; S.draftStr = []; S.tan = {start: null, end: null};
// Left Ctrl: the next segment runs straight out from the previous one, along the direction the track is heading (like NIMBY Rails).
// The cursor only decides how far; the node lands on that line.
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
// The segment from the last placed node to P. Each curve is one circular arc that leaves the previous segment along the direction it ended in,
// so it is finished the moment it is placed; only a node snapped onto a track makes it arrive along that track instead (two arcs).
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
// ── editing blueprints: every node is a draggable handle; ghost handles at segment middles insert a node (Shift+click one to cycle that segment Straight/Curve/Follow); right-click a node deletes it ──
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

// ── parallel track next to an existing track: select it, choose distance / side / number, add as floating blueprint ──
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
  updateDirty(); loadEdits(); loadCatalog();
}

// ── editing custom tracks ───────────────────────────────────────────────────
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
      let before = null, ghost = null, mm = null;                // drag any node of any custom track to reshape it (Ctrl+Z puts it back)
      m.on('dragstart', () => { S.edHitAt = Date.now(); before = JSON.parse(JSON.stringify(recBody(e))); mm = modelOf(e); });
      m.on('drag', ev => {
        mm.ctrl[i] = [ev.target.getLatLng().lat, ev.target.getLatLng().lng]; reTans(mm);
        const {coords} = buildCoords(mm.ctrl, mm.segs, mm.tan, 5, mm.tans);
        if (ghost) ghost.remove(); ghost = L.polyline(coords, {color: '#ffd23f', weight: 4, opacity: .9, interactive: false, renderer: editRenderer}).addTo(map);
      });
      m.on('dragend', async ev => {
        if (ghost) { ghost.remove(); ghost = null; }
        const end = i === 0 || i === mm.ctrl.length - 1, ll = ev.target.getLatLng(), s = end || mm.junctions.has(i) ? snapInfo(ll, e.id) : null;
        if (s) mm.ctrl[i] = [s.ll.lat, s.ll.lng];
        if (end && mm.op === 'add_track') { mm[i === 0 ? 'snap_s' : 'snap_e'] = !!s; mm.tan = mm.tan || {start: null, end: null}; mm.tan[i === 0 ? 'start' : 'end'] = s ? orientEnd(mm, i, s.dir) : null; }
        reTans(mm);
        const body = editBody(mm); body.op = mm.op; body.scope = mm.scope;
        try { await api('/api/edits/' + e.id, {method: 'PUT', body}); S.edOps.push({restore: [{id: e.id, body: before}], created: []}); S.lastEditAct = 'ops'; }
        catch (err) { $('#routeinfo').innerHTML = `<div class="bad">move failed: ${err.message}</div>`; }
        afterEditChange();
      });
      S.edLayer.addLayer(m);
    });
  }
  drawSelHighlight();
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
// ── selecting and deleting nodes of custom tracks (Edit mode) ──
// Every placed node is visible. Click one to select it (and open its track), Shift+click to add or remove, or drag a box over the map to
// select every node inside (Shift+drag adds). Delete / Backspace removes them; Ctrl+Z puts them back.
// Selected nodes that follow each other along a track are a highlighted stretch: Delete cuts that stretch out (splitting the track).
// A lone selected node is removed and its neighbours join up.
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
                       junctions: r.junctions, joins: r.joins, lane_offsets: r.lane_offsets || null, op: r.op});
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
      if (!results.length) { await api('/api/edits/' + j.id, {method: 'DELETE'}); continue; }
      for (let k = 0; k < results.length; k++) {
        const body = editBody(results[k]); body.op = m.op; body.scope = m.scope;
        if (k === 0) await api('/api/edits/' + j.id, {method: 'PUT', body});
        else { const r = await api('/api/edits', {method: 'POST', body}); op.created.push(r.edit.id); }
      }
    }
    S.edOps.push(op); S.lastEditAct = 'ops';
  } catch (err) { $('#edstatus').innerHTML = `<span class="bad">delete failed: ${err.message}</span>`; }
  afterEditChange();
}
async function undoEditOp() {
  const op = S.edOps.pop(); if (!op) return false;
  try {
    for (const id of op.created) await api('/api/edits/' + id, {method: 'DELETE'});
    for (const r of op.restore) {
      try { await api('/api/edits/' + r.id, {method: 'PUT', body: r.body}); } catch (_) { await api('/api/edits', {method: 'POST', body: r.body}); }
    }
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
  S.editVer = (S.editVer ?? 0) + 1; clearLegCache(); updateDirty(); refreshGraph(true); refreshEdits(); loadCatalog(); scheduleRoute(0);
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
    m.on('dragstart', () => edPush());
    m.on('drag', ev => { e.ctrl[i] = [ev.latlng.lat, ev.latlng.lng]; reTans(e); drawLines(); });
    m.on('dragend', ev => {
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
  if (e.key === 'Escape') { stopDraft(); S.draftLayer.clearLayers(); map.closePopup(); if (S.ed || nselCount()) { S.ed = null; nselClear(); renderEditor(); drawEditHits(); } }
  if (e.key === 'Enter' && (S.tool === 'draw' || S.tool === 'erase')) stopDraft();
  if ((e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && S.blueprints.length) buildBlueprints();
  if (S.tool === 'draw' && /^[1-6]$/.test(e.key) && !e.ctrlKey && !e.metaKey) setTracks(+e.key);
  if (S.tool === 'draw' && (e.key === '[' || e.key === ']')) { S.spacing = Math.max(2, Math.min(60, S.spacing + (e.key === ']' ? 0.5 : -0.5))); syncHud(); renderDraft(); }
  if (e.key === 'Backspace' && S.draft.length) { e.preventDefault(); popDraft(); if (!S.draft.length) S.tan.start = null; renderDraft(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (S.tool === 'erase' || S.tool === 'restore') { undoEditOp(); } else if ((S.tool === 'draw' || S.tool === 'erase') && S.draft.length) { popDraft(); if (!S.draft.length) S.tan.start = null; renderDraft(); } else if (S.tool !== 'trace' && S.tool !== 'edit' && bpUndo()) { /* blueprint undone */ } else if (S.tool === 'edit') { if (S.edOps.length && (S.lastEditAct === 'ops' || !(S.ed && S.ed.hist.length))) undoEditOp(); else if (S.ed) edUndo(); } else $('#undo').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && S.tool === 'trace') { e.preventDefault(); $('#save').click(); }
});

// ── Erase / Restore: drag a box over the map (or click one track). Whole segments of the OSM track inside it are hidden / brought back. ──
// Erased track disappears from the map; "Show erased" (or the Restore tool) draws it dashed red again. Ctrl+Z undoes either.
S.showErased = false;
function syncErased() { const b = $('#showErased'); if (b) b.classList.toggle('on', S.showErased || S.tool === 'restore'); refreshGraph(false); }
$('#showErased').onclick = () => { S.showErased = !S.showErased; syncErased(); refreshGraph(true); };
function say(html) { $('#routeinfo').innerHTML = html; }
async function segmentOp(kind, body) {
  try {
    const r = await api('/api/edits/' + kind, {method: 'POST', body: {scope: S.mapName, ...body}});
    if (kind === 'erase') {
      if (!r.edit) { say('<div class="warn">No track there to erase.</div>'); return; }
      S.edOps.push({restore: [], created: [r.edit.id]}); say(`<div class="good">Erased ${fmtLen(r.removed_m)} of track. Ctrl+Z undoes it.</div>`);
    } else {
      if (!r.undo.length) { say('<div class="warn">No erased track on this map inside that box.</div>'); return; }
      S.edOps.push({restore: r.undo, created: []}); say(`<div class="good">Restored ${fmtLen(r.restored_m)} of track.</div>`);
    }
    S.lastEditAct = 'ops'; afterEditChange();
  } catch (err) { say(`<div class="bad">${kind} failed: ${err.message}</div>`); }
}
// Hover shows the little segment (between two crossings / junctions) a click would erase or restore.
S.pickLayer = L.layerGroup().addTo(map); let pickT = null, pickSeq = 0;
const pickRadius = ll => 12 * 156543.03392 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom());
function clearPick() { clearTimeout(pickT); pickSeq++; S.pickLayer.clearLayers(); }
map.on('mousemove', e => {
  if (S.tool !== 'erase' && S.tool !== 'restore') return;
  if (S.sweeping) return;
  clearTimeout(pickT); const seq = ++pickSeq, kind = S.tool;
  pickT = setTimeout(async () => {
    try {
      const r = await api('/api/edits/pick?' + q({scope: S.mapName, kind, lat: e.latlng.lat, lng: e.latlng.lng, radius_m: pickRadius(e.latlng)}));
      if (seq !== pickSeq) return;
      S.pickLayer.clearLayers();
      if (r.pts) L.polyline(r.pts, {color: kind === 'erase' ? '#ff5d5d' : '#38bdf8', weight: 7, opacity: .8, interactive: false, renderer: editRenderer}).addTo(S.pickLayer);
    } catch (_) {}
  }, 50);
});
map.on('mouseout', clearPick);
map.on('mousedown', e => {
  if ((S.tool !== 'erase' && S.tool !== 'restore') || e.originalEvent.button !== 0) return;
  const kind = S.tool, start = e.latlng, x0 = e.originalEvent.clientX, y0 = e.originalEvent.clientY, col = kind === 'erase' ? '#ff5d5d' : '#38bdf8', sweep = e.originalEvent.shiftKey;
  let moved = false, rect = null, trail = null; const path = [[start.lat, start.lng]];
  const mv = m => {
    if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
    if (!moved) { moved = true; clearPick(); S.sweeping = sweep; }
    const ll = map.mouseEventToLatLng(m);
    if (sweep) {                                                   // Shift+drag: sweep over track; every little segment the line touches is picked
      const last = path[path.length - 1];
      if (map.latLngToContainerPoint(last).distanceTo(map.latLngToContainerPoint(ll)) >= 6) path.push([ll.lat, ll.lng]);
      if (!trail) trail = L.polyline(path, {color: col, weight: 5, opacity: .75, interactive: false, renderer: editRenderer}).addTo(map); else trail.setLatLngs(path);
      return;
    }
    const b = L.latLngBounds(start, ll);
    if (!rect) rect = L.rectangle(b, {color: col, weight: 1.5, fillOpacity: .14, interactive: false, renderer: editRenderer}).addTo(map); else rect.setBounds(b);
  };
  const up = m => {
    document.removeEventListener('mousemove', mv, true); document.removeEventListener('mouseup', up, true);
    if (rect) { rect.remove(); rect = null; } if (trail) { trail.remove(); trail = null; }
    S.sweeping = false;
    const end = map.mouseEventToLatLng(m), box = b => [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], rad = pickRadius(end);
    if (moved) {
      S.noClickUntil = Date.now() + 150;
      if (sweep) segmentOp(kind, {path: path.slice(0, 400), radius_m: rad}); else segmentOp(kind, {box: box(L.latLngBounds(start, end))});
      return;
    }
    segmentOp(kind, {at: [end.lat, end.lng], radius_m: rad});          // a plain click: the one little segment under the cursor
  };
  document.addEventListener('mousemove', mv, true); document.addEventListener('mouseup', up, true);
});

// "Undo last edit" (the most recent draw / erase, on either map)
async function loadEdits() {
  const r = await api('/api/edits');
  $('#undoEdit').disabled = !r.count;
}
$('#undoEdit').onclick = async () => {
  await api('/api/edits/last', {method: 'DELETE'}); S.editVer = (S.editVer ?? 0) + 1;
  clearLegCache(); await loadEdits(); refreshGraph(true); refreshEdits(); loadCatalog(); scheduleRoute(0);
};

// ── track graph overlay: opaque, canvas-drawn, swapped in without clearing (no flicker) ──
let gTimer, gSeq = 0, gBox = null, gKey = '';
function refreshGraph(force) {
  clearTimeout(gTimer);
  gTimer = setTimeout(async () => {
    const low = map.getZoom() < GRAPH_MIN_ZOOM;
    $('#zoomhint').style.display = low ? 'block' : 'none';
    if (low) { if (S.graph.getLayers().length) S.graph.clearLayers(); gBox = null; return; }
    const b = map.getBounds(), er = S.showErased || S.tool === 'restore' ? 1 : 0, k = S.mapName + ':' + (S.editVer ?? 0) + ':' + er;
    if (!force && gBox && k === gKey && gBox.contains(b)) return;       // current data still covers the view
    const pb = b.pad(0.5), seq = ++gSeq;
    const items = await api('/api/edges?' + q({map: S.mapName, erased: er, bbox: [pb.getSouth(), pb.getWest(), pb.getNorth(), pb.getEast()].join(','), limit: 40000}));
    if (seq !== gSeq) return;
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
    gBox = pb; gKey = k;
  }, 120);
}
let moveT = null;
map.on('moveend', () => { refreshGraph(false); clearTimeout(moveT); moveT = setTimeout(() => { if (S.tool !== 'trace') refreshEdits(); }, S.keys && S.keys.size ? 250 : 0); });

// ── WASD pans the camera like NIMBY Rails (Shift = faster) ──
S.keys = new Set();
const PANKEYS = {w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0]};
let panRaf = null, panLast = 0;
function panLoop(t) {
  const dt = Math.min(50, t - panLast) / 1000; panLast = t;
  let dx = 0, dy = 0; S.keys.forEach(k => { dx += PANKEYS[k][0]; dy += PANKEYS[k][1]; });
  if (dx || dy) {
    const sp = (S.shift ? 2800 : 1100) * dt, len = Math.hypot(dx, dy);
    map.panBy([dx / len * sp, dy / len * sp], {animate: false});
    if (draftCursor) { /* keep the preview under the (unmoved) mouse */ if (S.lastMouse) { const ll = map.mouseEventToLatLng(S.lastMouse); previewDraft(ll); } }
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

// ── report / status ─────────────────────────────────────────────────────────
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

// ── refresh every line that the track changed this session may affect ──
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
// Curves built by earlier versions carry jittery sample points (sub-metre steps) that zigzag the parallel lanes: rebuild their points once, same nodes and shape.
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