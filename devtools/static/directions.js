// ── Locked track directions (like NIMBY Rails signals) ──
// No-go tool: the same, but click closes the stretch to every route (click again: open).
// Direction tool: hover track to light up its whole stretch (junction to junction); click: one way, again: the other way, again: open both ways.
// "Arrows" (or the Direction tool) shows every locked stretch with arrows along it. Locks are saved by position (data/tracks/directions.json), see devtools/directions.py.
(() => {
  const AMBER = '#f59e0b', FREE = '#38bdf8', RED = '#ef4444', MIN_ZOOM = 11, GAP_PX = 34, SIZE = 6;
  S.showDirs = false;
  const tool = () => S.tool === 'direction' || S.tool === 'nogo';
  const show = () => S.showDirs || tool();

  // ── a visible message, so nothing here can fail silently ──
  let toastEl = null, toastTimer = null;
  function toast(msg, bad) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:absolute;left:50%;bottom:34px;transform:translateX(-50%);z-index:1200;padding:9px 16px;border-radius:8px;font:600 13px system-ui,sans-serif;pointer-events:none;box-shadow:0 6px 24px #0008;transition:opacity .25s;max-width:80%;text-align:center';
      map.getContainer().appendChild(toastEl);
    }
    toastEl.textContent = msg; toastEl.style.opacity = 1;
    toastEl.style.background = bad ? '#b42318' : '#111827'; toastEl.style.color = '#fff'; toastEl.style.border = '2px solid ' + (bad ? '#fecaca' : AMBER);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = 0; }, bad ? 6000 : 2600);
  }
  let lastFail = 0;
  const fail = (what, err) => {                                       // a repeating problem is shown once, not flashed over and over
    const busy = /busy|timed out/.test(err && err.message);
    if (Date.now() - lastFail < 8000) return; lastFail = Date.now();
    if (!busy) console.warn('[directions] ' + what, err && err.message);                  // a busy server is not worth a line in the console
    toast(what + ': ' + (busy ? 'the server is busy, try again in a moment' : (err && err.message || err)), true);
  };

  try {
    map.createPane('dirPane').style.zIndex = 460; map.getPane('dirPane').style.pointerEvents = 'none';
    const R = L.svg({pane: 'dirPane'}), g = L.layerGroup().addTo(map), gh = L.layerGroup().addTo(map);
    let items = [], seq = 0, timer = null, byId = new Map(), G = [];

    // a path in lat/lon, drawn with white arrows along it pointing the way trains may run
    function drawArrows(p, layer) {
      const z = map.getZoom(), px = p.map(c => map.project(c, z)), seg = [];
      let total = 0;
      for (let i = 0; i < px.length - 1; i++) { const d = px[i].distanceTo(px[i + 1]); seg.push(d); total += d; }
      if (!seg.length) return;
      const n = Math.max(1, Math.floor(total / GAP_PX));
      for (let k = 0; k < n; k++) {
        let s = (k + .5) * total / n, i = 0; while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
        const a = px[i], b = px[i + 1], t = seg[i] ? s / seg[i] : 0, c = a.add(b.subtract(a).multiplyBy(t)), v = b.subtract(a), L_ = Math.hypot(v.x, v.y) || 1, ux = v.x / L_, uy = v.y / L_;
        const pt = (fx, fy) => map.unproject(L.point(c.x + ux * fx - uy * fy, c.y + uy * fx + ux * fy), z);
        L.polygon([pt(SIZE, 0), pt(-SIZE * .8, SIZE * .75), pt(-SIZE * .35, 0), pt(-SIZE * .8, -SIZE * .75)], {renderer: R, color: '#1b1b1b', weight: 1, fillColor: '#fff', fillOpacity: 1, interactive: false}).addTo(layer);
      }
    }
    const line = (p, color, w, layer, extra) => L.polyline(p, {renderer: R, color, weight: w, opacity: .95, lineCap: 'round', lineJoin: 'round', interactive: false, ...extra}).addTo(layer);
    // a stretch with a dark casing so it stands out on satellite imagery
    const stretchLine = (p, color, layer, extra) => { line(p, '#000', 8, layer, {opacity: .55}); return line(p, color, 4.5, layer, extra); };

    // a closed (no-go) stretch: red, with a white dashed centre like a no-entry road
    const closedLine = (p, layer, extra) => { line(p, '#000', 8, layer, {opacity: .55}); line(p, RED, 4.5, layer, extra); return line(p, '#fff', 1.6, layer, {dashArray: '3 8', opacity: .95}); };
    function draw() {
      g.clearLayers();
      if (!show() || map.getZoom() < MIN_ZOOM) return;
      for (const it of items) it.closed ? closedLine(it.p, g) : (stretchLine(it.p, AMBER, g), drawArrows(it.p, g));
    }
    async function refresh() {
      syncBtn();
      if (!show() || map.getZoom() < MIN_ZOOM) { items = []; byId = new Map(); draw(); return; }
      const b = map.getBounds().pad(0.4), my = ++seq;
      try { const r = await api('/api/directions?' + q({map: S.mapName, bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(',')}), {timeout: 20000}); if (my === seq) { items = r; byId = new Map(r.map(x => [x.id, x])); draw(); } }
      catch (e) { fail('Could not load locked tracks', e); setTimeout(later, 3000); }
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(refresh, 150); };
    function syncBtn() { document.querySelectorAll('.showDirs').forEach(b => b.classList.toggle('on', show())); const h = $('#dirhint'); h.hidden = !tool(); if (!h.hidden && !h.dataset.busy) h.textContent = S.tool === 'nogo' ? 'Click track: closed to every route · again: open' : 'Click track: one way · again: other way · again: open'; }

    // ── hover: light up the stretch a click would act on. Like the Parallel tool this uses the track the page has already loaded (S.graphItems), so it needs no server ──
    const tip = document.createElement('div');
    tip.style.cssText = 'position:absolute;z-index:1100;display:none;pointer-events:none;padding:4px 9px;border-radius:6px;background:#111827ee;color:#fff;font:600 12px system-ui,sans-serif;white-space:nowrap;border:1px solid #fff4';
    map.getContainer().appendChild(tip);
    const key = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);
    let ends = null, endsOf = null, endsEv = null, endsN = 0;
    function index() {                                                        // which pieces of track meet at each point (custom tracks count as pieces too: a crossover leaving here makes it a junction)
      const ev = S.editsView; if (endsOf === S.graphItems && endsEv === ev && endsN === (ev || []).length) return;
      endsOf = S.graphItems; endsEv = ev; endsN = (ev || []).length; ends = new Map();
      const add = (p, i) => { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); };
      (S.graphItems || []).forEach((it, i) => { add(it.p[0], i); add(it.p[it.p.length - 1], i); });
      for (const e of ev || []) if (e.op === 'add_track') for (const ln of e._lanes || []) { add(ln[0], -1); add(ln[ln.length - 1], -1); }
    }
    function chain(i0) {                                                      // the piece and the pieces joined to it, up to the next junction either way: [{i, p}] each laid out in walking order
      index(); const G = S.graphItems, seen = new Set([i0]), mid = [{i: i0, p: G[i0].p}];
      const walk = fwd => {
        for (let n = 0; n < 400; n++) {
          const cur = fwd ? mid[mid.length - 1] : mid[0], k = key(fwd ? cur.p[cur.p.length - 1] : cur.p[0]), at = ends.get(k);
          if (!at || at.length !== 2) return;
          const nx = at[0] === cur.i ? at[1] : at[0]; if (seen.has(nx)) return; seen.add(nx);
          const p = G[nx].p, startsHere = key(p[0]) === k, q = fwd ? (startsHere ? p : p.slice().reverse()) : (startsHere ? p.slice().reverse() : p);
          if (fwd) mid.push({i: nx, p: q}); else mid.unshift({i: nx, p: q});
        }
      };
      walk(true); walk(false); return mid;
    }
    const isLocked = i => byId.has(S.graphItems[i].id);
    const isClosed = i => !!(byId.get(S.graphItems[i].id) || {}).closed;
    let hv = null, raf = 0, mv = null;
    const hideHover = () => { gh.clearLayers(); tip.style.display = 'none'; hv = null; };
    function paint(pieces, locked, extra) {                                   // a stretch with a casing, and arrows along it where it is one-way
      gh.clearLayers();
      const all = pieces.flatMap(pc => pc.p.slice(pc === pieces[0] ? 0 : 1)), shut = pieces.some(pc => pc.i >= 0 && (byId.get(S.graphItems[pc.i].id) || {}).closed);
      if (S.tool === 'nogo') shut ? stretchLine(all, FREE, gh, extra) : closedLine(all, gh, extra);        // what a click would make it
      else shut ? closedLine(all, gh, extra) : stretchLine(all, locked ? AMBER : FREE, gh, extra);
      for (const pc of pieces) { const it = pc.i >= 0 && byId.get(S.graphItems[pc.i].id); if (it && !it.closed) drawArrows(it.p, gh); }
    }
    function hover() {
      raf = 0; if (!tool() || !mv) return;
      const e = mv; mv = null, G = S.graphItems || [];
      if (map.getZoom() < 9) { hideHover(); return; }
      const hit = hitTrack(e.latlng), i = hit ? G.findIndex(it => it.p === hit) : -1;
      if (!hit) { hideHover(); return; }
      const pieces = i < 0 ? [{i: -1, p: hit}] : chain(i), locked = pieces.some(pc => pc.i >= 0 && isLocked(pc.i)), shut = pieces.some(pc => pc.i >= 0 && isClosed(pc.i));   // i < 0: a custom (green) track
      hv = {i, pieces, locked, shut}; paint(pieces, locked, locked ? {} : {dashArray: null});
      tip.textContent = S.tool === 'nogo' ? (shut ? 'Closed to every route: click to open it again' : 'Click to close it to every route (no-go)')
        : shut ? 'Closed to all routes: open it with the No-go tool' : locked ? 'One way: click to turn it round (then again to open it)' : 'Open both ways: click to lock one way';
      tip.style.display = 'block'; tip.style.left = (e.containerPoint.x + 16) + 'px'; tip.style.top = (e.containerPoint.y + 14) + 'px';
    }
    map.on('mousemove', e => {
      if (!tool()) return;
      if (e.originalEvent && e.originalEvent.buttons) { hideHover(); return; }                       // dragging the map
      mv = e; if (!raf) raf = requestAnimationFrame(hover);
    });
    map.getContainer().addEventListener('mouseleave', () => { mv = null; hideHover(); });

    document.querySelectorAll('.showDirs').forEach(b => b.onclick = () => { S.showDirs = !S.showDirs; refresh(); });
    document.addEventListener('toolchange', () => { hideHover(); map.getContainer().classList.toggle('dirtool', tool()); if (tool()) toast(S.tool === 'nogo' ? 'No-go tool: hover track to see its stretch, click to close it to every route' : 'Direction tool: hover track to see its stretch, click to lock it one way'); refresh(); });
    document.addEventListener('mapchange', later);
    map.on('moveend', later); map.on('zoomend', draw);

    // ── click: cycle free → one way → the other way → free, and make it obvious ──
    let clicking = false;
    map.on('click', async e => {
      if (!tool() || clicking) return;
      clicking = true; $('#dirhint').dataset.busy = 1; $('#dirhint').textContent = 'Working…';
      if (hv) { paint(hv.pieces, true, {weight: 8}); tip.textContent = 'Working…'; }
      try {
        const r = await api('/api/directions/cycle', {method: 'POST', timeout: 60000, body: {map: S.mapName, kind: S.tool === 'nogo' ? 'nogo' : 'dir', at: [e.latlng.lat, e.latlng.lng]}});
        const msg = r.dir === 2 ? 'Closed: no route can use this track' : r.dir === 0 ? (S.tool === 'nogo' ? 'Open again' : 'Open to both directions') : r.dir === 1 ? 'One way: trains run in the direction of the arrows' : 'One way, turned round';
        delete $('#dirhint').dataset.busy; $('#dirhint').textContent = msg + ' · click: next';
        toast((r.dir === 2 ? '⛔ ' : r.dir === 0 ? '↔ ' : '→ ') + msg + (r.stretch_edges > 1 ? ` (${r.stretch_edges} track pieces, up to the next junctions)` : ''));
        // flash the whole stretch that changed
        const p = r.dir === -1 ? r.pts.slice().reverse() : r.pts, fl = L.layerGroup().addTo(map);
        const pl = r.dir === 2 ? closedLine(p, fl, {weight: 8}) : stretchLine(p, r.dir ? AMBER : FREE, fl, {weight: 8}); if (pl.getElement()) pl.getElement().classList.add('dirflash');
        setTimeout(() => map.removeLayer(fl), 1300);
        hideHover();
        clearLegCache(); S.editVer = (S.editVer ?? 0) + 1; await refresh(); updateDirty(); scheduleRoute(0);
      } catch (err) {
        const none = /no track/i.test(err.message);
        delete $('#dirhint').dataset.busy; $('#dirhint').textContent = none ? 'No track there' : err.message;
        toast(none ? 'No track there: click right on a rail' : 'Could not change direction: ' + err.message, true);
        if (!none) console.error('[directions]', err);
      } finally { clicking = false; }
    });
    syncBtn();
    console.log('[directions] ready');
  } catch (err) { fail('directions.js failed to start', err); }
})();