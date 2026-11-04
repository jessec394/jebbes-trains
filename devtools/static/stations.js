'use strict';
// ── Stations tool: stations and their platforms, written into map_data.py ──
// A platform is a stretch of one rail ("span": two points on it). Real platforms from OpenStreetMap (what OpenRailwayMap shows) are
// drawn in orange: click one to turn it into a platform of a new or an existing station. Everything is saved straight to map_data.py.
(function () {
  const ST = {sel: null, pick: null, cands: [], ci: 0, list: [], osm: {platforms: [], stops: [], ready: true}, draw: null, seq: 0, msg: ''};
  const gSt = L.layerGroup(), gOsm = L.layerGroup(), gCand = L.layerGroup(), MIN_Z = 12, R = L.svg({pane: 'draftPane'});
  const box = $('#stpanel'); let active = false, timer = null;
  const mid = pts => pts[pts.length >> 1];
  const km = (a, b) => map.distance(a, b);
  const len = sp => Math.round(sp.length_m != null ? sp.length_m : km(sp.a || sp[0], sp.b || sp[1]));
  const say = t => { ST.msg = t || ''; const m = box.querySelector('.stmsg'); if (m) m.textContent = ST.msg; };

  document.addEventListener('toolchange', ev => {
    active = ev.detail === 'stations';
    box.hidden = !active;
    if (active) { [gOsm, gSt, gCand].forEach(g => g.addTo(map)); refresh(); render(); }
    else { [gOsm, gSt, gCand].forEach(g => map.removeLayer(g)); endDraw(); ST.pick = null; ST.sel = null; }
  });
  document.addEventListener('mapchange', () => { if (active) { draw(); render(); } });
  map.on('moveend', () => { if (!active) return; clearTimeout(timer); timer = setTimeout(refresh, 200); });
  document.addEventListener('keydown', e => { if (active && e.key === 'Escape') { endDraw(); ST.pick = null; gCand.clearLayers(); render(); } });

  async function refresh() {
    if (!active) return;
    if (map.getZoom() < MIN_Z) { gSt.clearLayers(); gOsm.clearLayers(); say(`Zoom in to see stations and platforms (zoom ${MIN_Z}+)`); return; }
    const b = map.getBounds().pad(0.2), bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(','), seq = ++ST.seq;
    let list, osm;
    try { [list, osm] = await Promise.all([api('/api/station_list?' + q({bbox: bb})), api('/api/osm_stops?' + q({bbox: bb}))]); } catch (e) { say('Could not load: ' + e.message); return; }
    if (seq !== ST.seq || !active) return;
    ST.list = list; ST.osm = osm; say(osm.ready ? '' : 'The graph has no real-world platforms yet: re-run ingest_osm.py (FRESH = False is fine)');
    draw(); render(false);
  }

  function draw() {
    gOsm.clearLayers(); gSt.clearLayers();
    for (const p of ST.osm.platforms) {
      const edge = p.kind === 'platform_edge', on = ST.pick && ST.pick.id === p.id;
      const l = L.polyline(p.pts, {renderer: R, color: on ? '#ffd23f' : '#f59e0b', weight: edge ? 3 : 7, opacity: edge ? .9 : .6, lineCap: 'butt'}).addTo(gOsm);
      l.bindTooltip(`Platform ${p.ref || ''} ${p.name || ''}`.trim(), {sticky: true});
      l.on('click', ev => { if (ST.draw) return; L.DomEvent.stopPropagation(ev); pickOsm(p); });
    }
    for (const s of ST.osm.stops) L.circleMarker([s.lat, s.lon], {renderer: R, radius: 4, color: '#b45309', weight: 2, fillColor: '#fde68a', fillOpacity: 1}).bindTooltip(s.name || s.kind).addTo(gOsm);
    for (const st of ST.list) {
      const on = ST.sel === st.name;
      for (const [n, p] of platList(st)) {
        const sp = p.span, loc = p.location, u = useOf(st, n), fade = u === 'other' ? .35 : .9;
        if (sp) L.polyline(sp, {renderer: R, color: on ? '#ffd23f' : '#ff1f8f', weight: 7, opacity: fade, lineCap: 'butt', interactive: false, dashArray: u === 'none' ? '4 6' : null}).addTo(gSt);
        const m = L.circleMarker(loc, {renderer: R, radius: n ? 5 : 7, color: '#ff1f8f', weight: 3, opacity: fade, fillColor: on ? '#ffd23f' : '#fff', fillOpacity: u === 'other' ? .4 : 1, dashArray: u === 'none' ? '3 3' : null}).addTo(gSt);
        m.bindTooltip(st.name + (n ? ` {${n}}` : '') + ` · ${useText(st, n)}`, {direction: 'top', offset: [0, -6]});
        m.on('click', ev => { if (ST.draw) return; L.DomEvent.stopPropagation(ev); selectStation(st.name); });
      }
    }
  }

  // ── a real-world platform -> a platform of a station ──
  async function pickOsm(p) {
    ST.pick = p; ST.sel = null; ST.cands = []; ST.ci = 0; draw(); render(); say('Finding the rail…');
    try { ST.cands = (await api('/api/platform_spans', {method: 'POST', body: {map: S.mapName, pts: p.pts}})).spans; } catch (e) { say(e.message); return; }
    say(ST.cands.length ? '' : `No rail within 25 m on the ${S.mapName} map`); showCand(); render();
  }
  function showCand() {
    gCand.clearLayers();
    ST.cands.forEach((c, i) => L.polyline(c.pts, {renderer: R, color: '#ffd23f', weight: i === ST.ci ? 9 : 5, opacity: i === ST.ci ? 1 : .5, interactive: false}).addTo(gCand));
  }
  // which map(s) a platform serves is derived from the patterns that stop there: 'here' = this map, 'other' = only the other one, 'none' = nothing yet
  const mapKey = () => S.mapName === 'present' ? 'Present' : 'Fantasy';
  const useOf = (st, n) => { const u = (st.used || {})[n || ''] || [], k = mapKey(); return u.includes(k) ? 'here' : u.length ? 'other' : 'none'; };
  const useText = (st, n) => { const u = (st.used || {})[n || ''] || []; return u.length === 2 ? 'both maps' : u.length ? u[0] + ' only' : 'unused'; };
  const platList = st => st.single ? [['', {location: st.location, span: st.span, Type: undefined}]] : Object.entries(st.platforms).map(([n, p]) => [n, {location: p.Location, span: p.Span, Type: p.Type, Label: p.Label}]);
  const firstName = st => st.single ? ((prompt(`${st.name} gets its first named platform: what is its existing stop called?`, 'Main') || '').trim() || 'Main') : null;
  const nearStations = ll => ST.list.map(s => ({s, d: km(ll, s.location)})).sort((a, b) => a.d - b.d);
  async function addFromPick() {
    const c = ST.cands[ST.ci]; if (!c) return;
    const name = box.querySelector('#stname').value.trim(), plat = box.querySelector('#stplat').value.trim(), loc = c.mid, span = [c.a, c.b];
    if (!name) return say('Give the station a name');
    const exists = ST.list.find(s => s.name === name);
    try {
      if (exists) {
        if (!plat && !exists.single) return say('Name the platform');
        await api('/api/platform', {method: 'POST', body: {station: name, platform: plat || null, location: loc, span, first: exists.single ? firstName(exists) : null}});
      }
      else {
        const near = nearStations(loc).find(x => x.s.region && x.d < 8000);
        await api('/api/station', {method: 'POST', body: {name, location: loc, span, region: near ? near.s.region : null}});
      }
    } catch (e) { return say(e.message); }
    ST.pick = null; gCand.clearLayers(); await refresh(); selectStation(name); say(`Saved to map_data.py: ${name}${plat ? ' {' + plat + '}' : ''}`);
  }

  // ── a station of map_data.py ──
  function selectStation(name) { ST.sel = name; ST.pick = null; gCand.clearLayers(); draw(); render(); }
  const put = async (url, method, body, ok) => { try { const r = await api(url, {method, body}); await refresh(); say(ok || (r.reports && r.reports.length ? `Saved; ${r.reports.length} route(s) recompiled` : 'Saved')); return r; } catch (e) { say(e.message); } };
  const setSt = (name, fields) => put('/api/station', 'PUT', {name, fields});
  const setPl = (station, platform, fields) => put('/api/platform', 'PUT', {station, platform, fields});

  // ── hand-drawn span: click two points on the rail ──
  function startDraw(kind, station, platform) {
    ST.draw = {kind, station, platform, pts: []}; map.getContainer().style.cursor = 'crosshair'; gCand.clearLayers(); say('Click the start of the platform on the rail, then its end (Esc cancels)');
  }
  function endDraw() { ST.draw = null; map.getContainer().style.cursor = ''; }
  map.on('click', async ev => {
    const d = ST.draw; if (!active || !d) return;
    if (d.kind === 'move') { endDraw(); await setPl(d.station, d.platform, {Location: [ev.latlng.lat, ev.latlng.lng], Span: null}); return render(); }
    d.pts.push([ev.latlng.lat, ev.latlng.lng]);
    L.circleMarker(ev.latlng, {renderer: R, radius: 5, color: '#ffd23f', fillColor: '#fff', fillOpacity: 1}).addTo(gCand);
    if (d.pts.length < 2) return say('Now click the end of the platform on the same rail');
    let sp; try { sp = (await api('/api/platform_spans', {method: 'POST', body: {map: S.mapName, between: d.pts}})).spans[0]; } catch (e) { return say(e.message); }
    if (!sp) { gCand.clearLayers(); d.pts = []; return say('Those two points are not on the same rail: try again'); }
    const loc = sp.mid, span = [sp.a, sp.b]; endDraw(); gCand.clearLayers();
    if (d.kind === 'newstation') {
      const name = (prompt('Station name') || '').trim(); if (!name) return say('');
      const near = nearStations(loc).find(x => x.s.region && x.d < 8000);
      try { await api('/api/station', {method: 'POST', body: {name, location: loc, span, region: near ? near.s.region : null}}); } catch (e) { return say(e.message); }
      await refresh(); return selectStation(name);
    }
    if (d.kind === 'newplatform') {
      const pn = (prompt('Platform name') || '').trim(); if (!pn) return say('');
      const stn = ST.list.find(x => x.name === d.station);
      await put('/api/platform', 'POST', {station: d.station, platform: pn, location: loc, span, first: firstName(stn)}, `Added platform ${pn}`);
    } else await setPl(d.station, d.platform, {Location: loc, Span: span});
    render();
  });

  // ── panel ──
  function row(...kids) { const r = el('div', 'strow'); r.append(...kids); return r; }
  function render(full = true) {
    if (!active) return;
    const keep = box.querySelector('#stname')?.value, keepP = box.querySelector('#stplat')?.value;
    box.textContent = '';
    box.append(el('h3', '', 'Stations'));
    const bar = row(); const ns = el('button', '', 'New station'); ns.title = 'Click two points on a rail to place its first platform'; ns.onclick = () => startDraw('newstation');
    bar.append(ns); box.append(bar);
    if (ST.pick) renderPick(keep, keepP, full);
    else if (ST.sel) renderStation();
    box.append(el('div', 'stmsg', ST.msg));
  }
  function renderPick(keep, keepP, full) {
    const p = ST.pick, loc = ST.cands[ST.ci] ? mid(ST.cands[ST.ci].pts) : mid(p.pts), near = nearStations(loc);
    box.append(el('h4', '', `Real platform ${p.ref || ''} ${p.name || ''}`.trim()));
    if (ST.cands.length > 1) {
      const sel = el('select'); ST.cands.forEach((c, i) => { const o = el('option', '', `rail ${i + 1}: ${len(c)} m, ${c.dist_m} m away`); o.value = i; sel.append(o); });
      sel.value = ST.ci; sel.onchange = () => { ST.ci = +sel.value; showCand(); render(false); }; box.append(row(el('span', '', 'Rail'), sel));
    } else if (ST.cands[0]) box.append(row(el('span', '', `${len(ST.cands[0])} m of rail`)));
    const dl = el('datalist'); dl.id = 'stnames'; near.slice(0, 20).forEach(x => { const o = el('option'); o.value = x.s.name; dl.append(o); });
    const stop = ST.osm.stops.map(s => ({s, d: km(loc, [s.lat, s.lon])})).filter(x => x.s.name).sort((a, b) => a.d - b.d)[0];
    const def = keep ?? (near[0] && near[0].d < 300 ? near[0].s.name : stop && stop.d < 250 ? stop.s.name : '');
    const nm = el('input'); nm.id = 'stname'; nm.setAttribute('list', 'stnames'); nm.placeholder = 'Station'; nm.value = def; nm.title = 'An existing station of map_data.py adds a platform to it; a new name creates the station';
    const pl = el('input'); pl.id = 'stplat'; pl.placeholder = 'Platform'; pl.style.width = '70px'; pl.value = keepP ?? ''; pl.title = 'Platform name (needed once a station has several platforms)';
    const ex = () => ST.list.some(s => s.name === nm.value.trim()), go = el('button', 'primary', ex() ? 'Add platform' : 'Create station');
    nm.oninput = () => { go.textContent = ex() ? 'Add platform' : 'Create station'; };
    go.onclick = addFromPick; go.disabled = !ST.cands.length;
    box.append(dl, row(nm, pl), row(go));
  }
  function renderStation() {
    const st = ST.list.find(s => s.name === ST.sel); if (!st) return;
    const btn = (text, title, fn, cls) => { const b = el('button', cls || '', text); b.title = title; b.onclick = fn; return b; };
    const field = (name, ...kids) => { const r = el('div', 'stfield'); r.append(el('span', 'fl', name), ...kids); return r; };
    // ── the station: what is shared by all of its platforms ──
    const card = el('div', 'stcard'), head = el('div', 'sthead');
    head.append(el('h4', '', st.name), btn('Rename', 'Rename the station; every route, line and destination that uses it follows', async () => {
      const n = (prompt('New name', st.name) || '').trim(); if (n && n !== st.name && await put('/api/rename', 'POST', {station: st.name, name: n}, `Renamed to ${n}`)) { ST.sel = n; draw(); render(); }
    }), btn('Merge into…', 'This station is really part of another one: its platforms move there and everything that used it follows', async () => {
      const into = (prompt('Merge into which station?') || '').trim(); if (!into) return;
      const dst = ST.list.find(x => x.name === into); if (!dst) return say(`No station '${into}' here: zoom to it first`);
      const body = {station: st.name, into};
      if (st.single) { body.platform_name = (prompt(`What is ${st.name} called as a platform of ${into}?`, 'Main') || '').trim(); if (!body.platform_name) return; }
      if (dst.single) body.first = firstName(dst);
      if (await put('/api/rename', 'POST', body, `Merged into ${into}`)) { ST.sel = into; draw(); render(); }
    }));
    const lab = el('input'); lab.value = st.label || ''; lab.placeholder = st.name; lab.title = 'Shown instead of the name'; lab.onchange = () => setSt(st.name, {Label: lab.value.trim()});
    const major = el('input'); major.type = 'checkbox'; major.checked = !!st.major; major.onchange = () => setSt(st.name, {Major: major.checked});
    const ml = el('label', 'chk'); ml.append(major, ' Major');
    card.append(head, field('Label', lab), field('Type', typeSel(st.type, v => setSt(st.name, {Type: v})), ml));
    box.append(el('div', 'stcap', 'Station'), card);
    // ── its platforms: each one a card of its own ──
    const pls = platList(st);
    box.append(el('div', 'stcap', st.single ? 'Platform' : `Platforms · ${pls.length}`));
    for (const [n, q] of pls) {
      const pc = el('div', 'stplat'), ph = el('div', 'sthead');
      const u = useOf(st, n), badge = el('span', 'badge ' + u, useText(st, n));
      ph.append(el('b', '', n || st.name), badge, el('span', 'c', q.span ? `${len(q.span)} m` : 'no span'));
      if (n) {
        const x = btn('✕', 'Delete this platform', async () => { if (confirm(`Delete platform ${n} of ${st.name}?`)) { await put('/api/platform', 'DELETE', {station: st.name, platform: n}, 'Deleted'); ST.sel = st.name; render(); } }, 'del');
        ph.append(x);
        const pl = el('input'); pl.value = q.Label || ''; pl.placeholder = 'same as station'; pl.title = 'Label at this platform (blank: the station\'s)'; pl.onchange = () => setPl(st.name, n, {Label: pl.value.trim()});
        const t = typeSel(q.Type, v => setPl(st.name, n, {Type: v}), true); t.title = 'Type at this platform';
        pc.append(ph, field('Label', pl), field('Type', t));
      } else pc.append(ph);
      const acts = el('div', 'stacts');
      acts.append(btn('Span', 'Click two points on a rail to set the platform', () => startDraw('span', st.name, n || null)));
      if (!q.span) acts.append(btn('Move', 'Click the map to place this platform', () => { ST.draw = {kind: 'move', station: st.name, platform: n || null, pts: []}; map.getContainer().style.cursor = 'crosshair'; say('Click where the platform is (Esc cancels)'); }));
      if (n) {
        acts.append(btn('Rename', 'Rename this platform everywhere it is used', async () => { const nn = (prompt('New platform name', n) || '').trim(); if (nn && nn !== n) { await put('/api/rename', 'POST', {station: st.name, platform: n, name: nn}, `Renamed to ${nn}`); render(); } }),
          btn('Merge', 'This is the same platform as another one of this station', async () => { const into = (prompt('Merge into which platform?', Object.keys(st.platforms).find(x => x !== n) || '') || '').trim(); if (into) { await put('/api/rename', 'POST', {station: st.name, platform: n, into}, `Merged into ${into}`); render(); } }));
      }
      pc.append(acts); box.append(pc);
    }
    box.append(row(btn('Add platform', 'Click two points on a rail', () => startDraw('newplatform', st.name)),
      btn('Delete station', 'Delete this station and all its platforms', async () => { if (confirm(`Delete ${st.name}?`)) { const r = await put('/api/platform', 'DELETE', {station: st.name, platform: null}, 'Deleted'); if (r) { ST.sel = null; draw(); render(); } } }, 'del')));
  }
  function typeSel(cur, on, platform) {            // a platform may keep its station's Type, have none, or have its own
    const s = el('select'), opts = platform ? [['', 'same as station'], ['__none', 'no type'], ['Airport', 'Airport']] : [['', 'no type'], ['Airport', 'Airport']];
    opts.forEach(([v, t]) => { const o = el('option', '', t); o.value = v; s.append(o); });
    s.value = platform ? (cur === undefined ? '' : cur === null ? '__none' : cur) : (cur || '');
    s.onchange = () => on(platform ? (s.value === '' ? false : s.value === '__none' ? null : s.value) : (s.value || null)); return s;
  }
})();