'use strict';
// ── Stations tool: stations and their platforms, written into the detailed map ──
// A platform is a stretch of one rail ("span": two points on it): pick the two ends on the rail. Every station of the detailed map is
// drawn on the map in every tool and can be searched for; the tool itself edits them. Saved straight to the detailed map.
(function () {
  const plainPl = window.plainPl || (n => String(n == null ? '' : n).replace(/\s*\[[^\]]*\]\s*$/, ''));
  const ST = {sel: null, list: [], osm: {stops: [], ready: true}, draw: null, seq: 0, msg: '', pick: new Map(), ends: new Set(), regs: [], set: {count: 2, length: 80}};      // pick: platforms selected to move together; set: the platform-set builder
  const gSt = L.layerGroup(), gOsm = L.layerGroup(), gCand = L.layerGroup(), MIN_Z = 12, R = L.svg({pane: 'draftPane'});
  const box = $('#stpanel'); let active = false, timer = null;
  const km = (a, b) => map.distance(a, b);
  const gmaps = ll => window.open(`https://www.google.com/maps/search/?api=1&query=${(+ll[0]).toFixed(6)},${(+ll[1]).toFixed(6)}`, '_blank', 'noopener');
  const title = st => st.title || st.name;                       // the name people see: a hidden " [2]" tag tells same-named stations apart
  const len = sp => Math.round(sp.length_m != null ? sp.length_m : km(sp.a || sp[0], sp.b || sp[1]));
  const say = t => { ST.msg = t || ''; const m = box.querySelector('.stmsg'); if (m) m.textContent = ST.msg; };

  gSt.addTo(map);
  document.addEventListener('toolchange', ev => {
    active = ev.detail === 'stations';
    box.hidden = !active;
    if (active) { [gOsm, gCand].forEach(g => g.addTo(map)); refresh(); render(); }
    else { [gOsm, gCand].forEach(g => map.removeLayer(g)); endDraw(); ST.sel = null; ST.pick.clear(); ST.ends.clear(); draw(); }
  });
  document.addEventListener('mapchange', () => { ST.pick.clear(); ST.ends.clear(); draw(); if (active) render(); });
  document.addEventListener('trackedit', ev => {                   // track was drawn / moved / erased: platforms on it may have followed the rail
    const moved = ev.detail || []; if (!moved.length) return;
    clearTimeout(timer); timer = setTimeout(async () => { await refresh(); say(`${moved.length} platform${moved.length > 1 ? 's' : ''} followed the rail`); }, 150);
  });
  map.on('moveend', () => { if (!active) return; clearTimeout(timer); timer = setTimeout(refresh, 200); });
  document.addEventListener('keydown', e => {
    if (!active || e.key !== 'Escape' || e.target.closest('input, select, textarea')) return;
    const had = !!ST.draw; endDraw(); gCand.clearLayers();
    if (!had && ST.sel) { ST.sel = null; draw(); }                 // Esc again: leave the station
    render();
  });

  // ── the rail each platform covers, to draw it along the track (curves and all) ──
  const shapes = new Map(); let shapeTimer = null;
  const skey = sp => `${S.mapName}|${sp[0]}|${sp[1]}`;
  const shapeOf = sp => { const v = sp && shapes.get(skey(sp)); return v && v.length > 1 ? v : null; };
  let shapeBusy = false, shapeAgain = false;
  async function ensureShapes() {
    if (map.getZoom() < 13 || !ST.list.length) return;
    if (shapeBusy) { shapeAgain = true; return; }                          // one request at a time: the next one starts when this one is done
    const b = map.getBounds().pad(0.3), c = map.getCenter(), want = [];
    for (const st of ST.list) for (const [, p] of platList(st)) {
      const sp = p.span; if (!sp || shapes.has(skey(sp))) continue;
      if (b.contains(sp[0]) || b.contains(sp[1])) want.push(sp);
    }
    if (!want.length) return;
    want.sort((x, y) => km(c, x[0]) - km(c, y[0]));                          // nearest the middle of the view first
    const mapName = S.mapName, batch = want.slice(0, 60);
    shapeBusy = true; let more = want.length > batch.length;
    try {
      const r = await api('/api/platform_shapes', {method: 'POST', timeout: 60000, body: {map: mapName, spans: batch}});
      if (mapName === S.mapName) batch.forEach((sp, i) => { if (r.shapes[i] === false) more = true; else shapes.set(skey(sp), r.shapes[i] || []); });
    } catch (e) { more = false; }
    finally { shapeBusy = false; }
    draw();
    if (more || shapeAgain) { shapeAgain = false; setTimeout(ensureShapes, more ? 200 : 0); }
  }
  const reshape = () => { shapes.clear(); clearTimeout(shapeTimer); shapeTimer = setTimeout(ensureShapes, 150); };
  document.addEventListener('trackedit', reshape);
  document.addEventListener('mapchange', () => { clearTimeout(shapeTimer); shapeTimer = setTimeout(ensureShapes, 150); });
  map.on('moveend', () => { clearTimeout(shapeTimer); shapeTimer = setTimeout(ensureShapes, 250); });

  async function refresh() {
    const seq = ++ST.seq;
    let list;
    try { list = await api('/api/station_list'); } catch (e) { if (active) say('Could not load: ' + e.message); return; }
    if (seq !== ST.seq) return;
    ST.list = list; draw(); renderResults(); ensureShapes(); if (active) render(false);         // the stations are usable now ...
    if (active && map.getZoom() >= MIN_Z) {                                                       // ... the OSM stop dots come in when they are ready
      const b = map.getBounds().pad(0.2);
      try { const osm = await api('/api/osm_stops?' + q({bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(',')})); if (seq === ST.seq) { ST.osm = osm; draw(); } } catch (e) {}
    }
  }

  function draw() {
    gOsm.clearLayers(); gSt.clearLayers(); ST.regs = []; if (!ST.sel) ST.ends.clear();
    for (const s of ST.osm.stops) L.circleMarker([s.lat, s.lon], {renderer: R, radius: 4, color: '#b45309', weight: 2, fillColor: '#fde68a', fillOpacity: 1}).bindTooltip(s.name || s.kind).addTo(gOsm);
    for (const st of ST.list) {
      const on = ST.sel === st.name;
      for (const [n, p] of platList(st)) {
        const sp = p.span, loc = p.location, u = useOf(st, n), off = offHere(st, n), fade = off ? .22 : u === 'other' ? .35 : .9;
        const picked = ST.pick.has(pk(st, n));
        if (off && !on) continue;                                          // a platform that is not on this map is not drawn (the selected station still shows it, faint, so it can be fixed)
        let line = null;
        if (p.fut) {                                                       // the other map's version, faint, for reference
          const o = onFuture() ? p.base : {span: p.fut.Span !== undefined ? p.fut.Span : p.base.span};
          if (o.span && JSON.stringify(o.span) !== JSON.stringify(sp)) L.polyline(shapeOf(o.span) || o.span, {renderer: R, color: '#8b95a5', weight: 4, opacity: .8, dashArray: '2 6', interactive: false}).addTo(gSt);
        }
        if (sp) line = L.polyline(shapeOf(sp) || sp, {renderer: R, color: picked ? '#22d3ee' : on ? '#ffd23f' : '#ff1f8f', weight: picked ? 9 : 7, opacity: fade, lineCap: 'butt', interactive: false, dashArray: off || u === 'none' ? '4 6' : null}).addTo(gSt);
        const m = L.circleMarker(loc, {renderer: R, interactive: active, radius: active ? (n ? 5 : 7) : 4, color: '#ff1f8f', weight: 3, opacity: fade, fillColor: picked ? '#22d3ee' : on ? '#ffd23f' : '#fff', fillOpacity: u === 'other' ? .4 : 1, dashArray: u === 'none' ? '3 3' : null}).addTo(gSt);
        if (!active) continue;
        m.bindTooltip(title(st) + (n ? ` {${plainPl(n)}}` : '') + ` · ${AVTXT[availOf(st, n)]}${off ? ' (not on this map)' : ''} · ${useText(st, n)}`, {direction: 'top', offset: [0, -6]});
        m.on('click', ev => { if (ST.draw) return; L.DomEvent.stopPropagation(ev); if (ev.originalEvent && (ev.originalEvent.shiftKey || ev.originalEvent.ctrlKey)) return togglePick(st, n); selectStation(st.name); });
        if (on) handles(st, n, sp, loc, line);
      }
    }
    const items = active && !ST.draw ? pickedItems() : [];                     // several platforms selected: one handle in the middle moves them all
    if (items.length) {
      const c = [items.reduce((a, x) => a + x.p.location[0], 0) / items.length, items.reduce((a, x) => a + x.p.location[1], 0) / items.length];
      dot(c, ll => moveGroup(items, [ll.lat - c[0], ll.lng - c[1]]), `Drag to move the ${items.length} selected platform${items.length > 1 ? 's' : ''} together`, 'mid grp');
    }
  }

  // ── several platform ends at once: Shift+click ends of the selected station's platforms, then drag any selected one ──
  function toggleEnd(k) { ST.ends.has(k) ? ST.ends.delete(k) : ST.ends.add(k); draw(); render(); }
  async function moveEnds(delta) {
    const jobs = [];
    for (const r of ST.regs) {
      const sel = [0, 1].filter(j => ST.ends.has(r.key + '|' + (j ? 'b' : 'a'))); if (!sel.length) continue;
      const pts = [r.sp[0], r.sp[1]].map((p, j) => sel.includes(j) ? [p[0] + delta[0], p[1] + delta[1]] : p);
      try {
        for (const j of sel) { const pt = await snapTo({lat: pts[j][0], lng: pts[j][1]}); if (!pt) { say('No rail within 30 m of where one of the ends would land: nothing moved'); return draw(); } pts[j] = pt; }
        const res = await api('/api/platform_spans_through', {method: 'POST', body: {map: S.mapName, a: pts[0], b: pts[1]}});
        if (!res.span) { say('One of the platforms would end up on two different tracks: nothing moved'); return draw(); }
        jobs.push([r, res.span]);
      } catch (e) { say(e.message); return draw(); }
    }
    for (const [r, sp] of jobs) await setPl(r.st.name, r.n || null, {Location: sp.mid, Span: [sp.a, sp.b]});
    say(`Moved ${jobs.length} platform${jobs.length > 1 ? 's' : ''} together`); draw(); render();
  }
  function endsCard() {
    const card = el('div', 'stcard stpick'), n = ST.ends.size;
    card.append(el('div', 'stcap', `${n} platform end${n > 1 ? 's' : ''} selected`), el('div', 'c stnote', 'Drag any selected end: they all move the same distance and snap onto the rail. Shift+click an end to add or remove it.'));
    const acts = el('div', 'stacts'), clr = el('button', '', 'Clear'); clr.onclick = () => { ST.ends.clear(); draw(); render(); }; acts.append(clr); card.append(acts);
    return card;
  }

  // ── several platforms at once: Shift+click them on the map (or tick them in the station card); the blue handle moves them all together ──
  const pk = (st, n) => st.name + '\u0001' + (n || '');
  function togglePick(st, n, on) {
    const k = pk(st, n), has = ST.pick.has(k); if (on === undefined) on = !has;
    if (on) ST.pick.set(k, {station: st.name, platform: n || ''}); else ST.pick.delete(k);
    draw(); render();
  }
  function pickedItems() {
    const out = [];
    for (const v of ST.pick.values()) { const st = ST.list.find(s => s.name === v.station); const e = st && platList(st).find(([n]) => (n || '') === v.platform); if (e && e[1].location) out.push({st, n: v.platform, p: e[1]}); }
    return out;
  }
  async function moveGroup(items, d) {
    const withSpan = items.filter(x => x.p.span), moved = [];
    if (withSpan.length) {
      let r; try { r = await api('/api/platform_move_set', {method: 'POST', body: {map: S.mapName, spans: withSpan.map(x => x.p.span), dlat: d[0], dlng: d[1]}}); } catch (e) { say(e.message); return draw(); }
      if (!r.spans) { say('They do not all fit onto separate tracks there: nothing moved'); return draw(); }
      withSpan.forEach((x, i) => moved.push([x, {Location: r.spans[i].mid, Span: [r.spans[i].a, r.spans[i].b]}]));
    }
    items.filter(x => !x.p.span).forEach(x => moved.push([x, {Location: [x.p.location[0] + d[0], x.p.location[1] + d[1]]}]));
    for (const [x, f] of moved) await setPl(x.st.name, x.n || null, f);
    say(`Moved ${moved.length} platform${moved.length > 1 ? 's' : ''} together`); draw(); render();
  }

  // ── the selected station's dots can be dragged: a platform's two ends (they snap onto the rail), or a platform that has no span yet ──
  const dot = (ll, fn, tip, cls) => {
    const mk = L.marker(ll, {draggable: true, icon: L.divIcon({className: 'sthandle' + (cls ? ' ' + cls : ''), iconSize: /mid/.test(cls || '') ? [10, 10] : [14, 14]}), zIndexOffset: 1000, keyboard: false}).addTo(gSt);
    if (tip) mk.bindTooltip(tip, {direction: 'top', offset: [0, -8]});
    mk.on('dragstart', () => map.dragging.disable()); mk.on('dragend', async () => { map.dragging.enable(); await fn(mk.getLatLng()); });
    return mk;
  };
  const snapTo = async ll => (await api('/api/snap?' + q({map: S.mapName, lat: ll.lat, lng: ll.lng, max_m: 30}))).point;
  function handles(st, n, sp, loc, line) {
    if (!active || ST.draw) return;
    const label = title(st) + (n ? ` {${plainPl(n)}}` : '');
    if (!sp) { dot(loc, ll => setPl(st.name, n || null, {Location: [ll.lat, ll.lng]}), `Drag ${label}`); return; }
    const rec = {st, n, sp, line, key: pk(st, n), mk: []}; ST.regs.push(rec);
    ['a', 'b'].forEach(end => {                                                  // an end slides along the rail it is on (it will not hop to a parallel track)
      const i = end === 'a' ? 0 : 1, ek = rec.key + '|' + end, mk = dot(sp[i], async ll => {
        if (ST.ends.has(ek) && ST.ends.size > 1) return moveEnds([ll.lat - sp[i][0], ll.lng - sp[i][1]]);          // one of several selected ends: they all move
        try {
          const pt = await snapTo(ll); if (!pt) { say('No rail within 30 m of there: the platform end stays where it was'); return draw(); }
          const other = sp[1 - i], r = await api('/api/platform_spans_through', {method: 'POST', body: {map: S.mapName, a: end === 'a' ? pt : other, b: end === 'a' ? other : pt}});
          if (!r.span) { say('That is not the same continuous track as the other end: drag the middle dot to move the whole platform to another track'); return draw(); }
          await setPl(st.name, n || null, {Location: r.span.mid, Span: [r.span.a, r.span.b]});
        } catch (e) { say(e.message); draw(); }
      }, `Drag the end of ${label} along the rail · Shift+click to select several ends, then drag any selected one`, ST.ends.has(ek) ? 'sel' : '');
      rec.mk[i] = mk;
      mk.on('click', ev => { if (ev.originalEvent && ev.originalEvent.shiftKey) { L.DomEvent.stopPropagation(ev); toggleEnd(ek); } });
      mk.on('drag', ev => {
        const cur = ev.target.getLatLng(), dl = [cur.lat - sp[i][0], cur.lng - sp[i][1]];
        if (!(ST.ends.has(ek) && ST.ends.size > 1)) { const pts = [sp[0], sp[1]]; pts[i] = cur; line.setLatLngs(pts); return; }
        for (const r of ST.regs) {                                              // the other selected ends follow the one being dragged
          const p = [0, 1].map(j => ST.ends.has(r.key + '|' + (j ? 'b' : 'a')) ? [r.sp[j][0] + dl[0], r.sp[j][1] + dl[1]] : r.sp[j]);
          r.line.setLatLngs(p); [0, 1].forEach(j => { if (r.mk[j] && r.mk[j] !== ev.target && ST.ends.has(r.key + '|' + (j ? 'b' : 'a'))) r.mk[j].setLatLng(p[j]); });
        }
      });
    });
    dot(loc, async ll => {                                                       // the middle moves the whole platform, onto whichever track it is dropped on
      try {
        const r = await api('/api/platform_slide', {method: 'POST', body: {map: S.mapName, to: [ll.lat, ll.lng], a: sp[0], b: sp[1]}});
        if (!r.span) { say('The platform does not fit on a rail there'); return draw(); }
        await setPl(st.name, n || null, {Location: r.span.mid, Span: [r.span.a, r.span.b]});
      } catch (e) { say(e.message); draw(); }
    }, `Drag ${label} onto another track`, 'mid');
  }

  // which map(s) a platform serves is derived from the patterns that stop there: 'here' = this map, 'other' = only the other one, 'none' = nothing yet
  const mapKey = () => S.mapName === 'present' ? 'Present' : 'Fantasy';
  const useOf = (st, n) => { const u = (st.used || {})[n || ''] || [], k = mapKey(); return u.includes(k) ? 'here' : u.length ? 'other' : 'none'; };
  const useText = (st, n) => { const u = (st.used || {})[n || ''] || []; return u.length === 2 ? 'Present + Future routes' : u.length ? (u[0] === 'Present' ? 'Present routes only' : 'Future routes only') : 'no routes stop here'; };
  // which map(s) a platform is on: the setting chosen for it ('present' / 'future'; none: both). A new platform is on the map it was made on.
  const availOf = (st, n) => (st.maps || {})[n || ''] || 'both';                  // what the platform is (n '' : the station's own setting)
  // A new station or platform made on the Present map is on both maps; one made on the Future map is Future only (on a Future-only station a Present-made platform stays Present)
  const newOn = st => S.mapName === 'future' ? 'future' : st && availOf(st, '') === 'future' ? 'present' : 'both';
  const offHere = (st, n) => { const v = availOf(st, n); return v !== 'both' && v !== S.mapName; };
  const AVTXT = {present: 'Present only', both: 'Both maps', future: 'Future only'};
  const setMaps = (st, n, value) => put('/api/platform_maps', 'PUT', {station: st.name, platform: n || null, value}, `${n || st.name}: ${AVTXT[value].toLowerCase()}`);
  function avSeg(st, n, own) {                                                  // Present | Both | Future, for one platform (n) or the whole station (n null)
    const seg = el('div', 'seg avseg'), cur = availOf(st, n);
    for (const v of ['present', 'both', 'future']) {
      const b = el('button', 'av-' + v + (cur === v ? ' on' : ''), v === 'present' ? 'Present' : v === 'future' ? 'Future' : 'Both');
      b.title = v === 'both' ? 'On the Present map and the Future map' : `Only on the ${v === 'present' ? 'Present' : 'Future'} map`;
      b.onclick = () => { if (n === null || cur !== v || own === false) setMaps(st, n, v); };       // the station's own buttons always apply: every platform takes the setting
      seg.append(b);
    }
    return seg;
  }
  const fold = new Map();                                                      // per station: are its platform cards open
  const useTip = 'Which maps\' routes stop at this platform now. Where the platform exists is set by the Present / Both / Future switch above.';
  // a platform may have a Future version (a different span / position on the Future map): the same platform, shown as it is on the map being edited
  const futOf = (st, n) => (st.future || {})[n || ''] || null;
  const onFuture = () => S.mapName === 'future';
  const shown = (b, f) => (f && onFuture()) ? {location: f.Location || b.location, span: f.Span !== undefined ? f.Span : b.span} : b;
  const platList = st => (st.single ? [['', {location: st.location, span: st.span, Type: undefined}]] : Object.entries(st.platforms).map(([n, p]) => [n, {location: p.Location, span: p.Span, Type: p.Type, Label: p.Label}]))
    .map(([n, b]) => { const f = futOf(st, n), v = shown(b, f); return [n, {...b, base: b, fut: f, location: v.location, span: v.span}]; });
  let munCache = null;                                                          // the municipalities already used: fetched once, filtered in the browser as you type
  const loadMuns = () => munCache || (munCache = api('/api/municipalities').catch(e => { munCache = null; return []; }));
  const firstName = st => st.single ? ((prompt(`${st.name} gets its first named platform: what is its existing stop called?`, 'Main') || '').trim() || 'Main') : null;
  const nearStations = ll => ST.list.map(s => ({s, d: km(ll, s.location)})).sort((a, b) => a.d - b.d);
  // ── a station of the detailed map ──
  function selectStation(name) { if (name !== ST.sel) ST.ends.clear(); ST.sel = name; gCand.clearLayers(); draw(); render(); }
  const put = async (url, method, body, ok) => { try { const r = await api(url, {method, body}); await refresh(); say(ok || (r.reports && r.reports.length ? `Saved; ${r.reports.length} route(s) recompiled` : 'Saved')); return r; } catch (e) { say(e.message); } };
  const setSt = (name, fields) => put('/api/station', 'PUT', {name, fields});
  const setPl = async (station, platform, fields) => {
    const st = ST.list.find(x => x.name === station), geo = ['Location', 'Span'].filter(k => k in fields);
    if (onFuture() && st && futOf(st, platform) && geo.length) {                 // editing the Future version of this platform: only Future routes are affected
      const f = {}; geo.forEach(k => f[k] = fields[k]);
      const r = await put('/api/platform_future', 'PUT', {station, platform: platform || null, fields: f}, 'Saved (Future version)');
      const rest = Object.fromEntries(Object.entries(fields).filter(([k]) => !geo.includes(k)));
      if (Object.keys(rest).length) await put('/api/platform', 'PUT', {station, platform, fields: rest});
      return r;
    }
    return put('/api/platform', 'PUT', {station, platform, fields});
  };
  const makeFuture = (st, n, q) => put('/api/platform_future', 'PUT', {station: st.name, platform: n || null, fields: {Location: q.base.location, Span: q.base.span || null}}, `${n || st.name}: now has its own Future version`);
  const rebind = (st, n) => put('/api/platform_future', 'DELETE', {station: st.name, platform: n || null}, `${n || st.name}: shared with Present again`);

  // ── hand-drawn span: click two points on the rail ──
  function startDraw(kind, station, platform) {
    if (kind === 'newstation') ST.sel = null;                       // a new station is started from anywhere: leave the one being edited
    ST.draw = {kind, station, platform, pts: []}; map.getContainer().style.cursor = 'crosshair'; gCand.clearLayers(); draw(); render(); say('Click the start of the platform on the rail, then its end (Esc cancels)');
  }
  function endDraw() { ST.draw = null; map.getContainer().style.cursor = ''; }
  map.on('click', async ev => {
    const d = ST.draw; if (!active || !d) return;
    if (d.kind === 'set') { endDraw(); gCand.clearLayers(); await placeSet([ev.latlng.lat, ev.latlng.lng]); return; }
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
      let made; try { made = await api('/api/station', {method: 'POST', body: {name, location: loc, span, region: near ? near.s.region : null, maps: newOn(null)}}); } catch (e) { return say(e.message); }
      await refresh(); return selectStation(made.name);                  // the backend may have given it a hidden tag (same name as another station)
    }
    if (d.kind === 'newplatform') {
      const pn = (prompt('Platform name') || '').trim(); if (!pn) return say('');
      const stn = ST.list.find(x => x.name === d.station);
      await put('/api/platform', 'POST', {station: d.station, platform: pn, location: loc, span, first: firstName(stn), maps: newOn(stn)}, `Added platform ${pn}`);
    } else await setPl(d.station, d.platform, {Location: loc, Span: span});
    render();
  });

  // ── a set of parallel platforms: "2 platforms, 80 m": click the world and they snap onto the tracks there, each on its own ──
  async function placeSet(at) {
    const {count, length} = ST.set;
    let r; try { r = await api('/api/platform_set', {method: 'POST', body: {map: S.mapName, at, count, length_m: length}}); } catch (e) { return say(e.message); }
    const spans = r.spans; if (!spans) return say('No rail near there');
    const got = spans.filter(Boolean); if (got.length < spans.length) return say(`Only ${got.length} of ${spans.length} platforms found a track of their own there: try fewer platforms`);
    const sp = s => [s.a, s.b], sel = ST.sel && ST.list.find(s => s.name === ST.sel);
    try {
      if (sel) {                                                                 // adds to the selected station
        const have = new Set(Object.keys(sel.platforms || {}).map(plainPl)), names = []; let k = 1;
        for (let i = 0; i < spans.length; i++) { while (have.has('Track ' + k)) k++; names.push('Track ' + k); have.add('Track ' + k); }
        const first = sel.single ? firstName(sel) : 'Main';
        for (let i = 0; i < spans.length; i++) await api('/api/platform', {method: 'POST', body: {station: sel.name, platform: names[i], location: spans[i].mid, span: sp(spans[i]), first, maps: newOn(sel)}});
        await refresh(); say(`Added ${names.join(', ')} to ${title(sel)}`); selectStation(sel.name); return;
      }
      const name = (prompt(`Station name for ${spans.length === 1 ? 'this platform' : 'these ' + spans.length + ' platforms'}`) || '').trim(); if (!name) return say('');
      const near = nearStations(spans[0].mid).find(x => x.s.region && x.d < 8000);
      const made = await api('/api/station', {method: 'POST', body: {name, location: spans[0].mid, span: sp(spans[0]), region: near ? near.s.region : null, maps: newOn(null)}});
      for (let i = 1; i < spans.length; i++) await api('/api/platform', {method: 'POST', body: {station: made.name, platform: 'Track ' + (i + 1), location: spans[i].mid, span: sp(spans[i]), first: 'Track 1', maps: newOn(null)}});
      await refresh(); say(`Made ${made.name} with ${spans.length} platform${spans.length > 1 ? 's' : ''}`); selectStation(made.name);
    } catch (e) { say(e.message); await refresh(); }
  }
  let prevT = null, prevSeq = 0;
  map.on('mousemove', ev => {                                                    // the platforms follow the cursor, snapped onto the tracks they would land on
    const d = ST.draw; if (!active || !d || d.kind !== 'set') return;
    clearTimeout(prevT); const seq = ++prevSeq, {count, length} = ST.set;
    prevT = setTimeout(async () => {
      try {
        const r = await api('/api/platform_set', {method: 'POST', body: {map: S.mapName, at: [ev.latlng.lat, ev.latlng.lng], count, length_m: length}});
        if (seq !== prevSeq || !ST.draw || ST.draw.kind !== 'set') return;
        gCand.clearLayers(); (r.spans || []).forEach(s => s && L.polyline(s.pts, {renderer: R, color: '#22d3ee', weight: 7, opacity: .85, lineCap: 'butt', interactive: false}).addTo(gCand));
      } catch (_) {}
    }, 70);
  });
  function setBuilder() {
    const card = el('div', 'stcard stset'), num = (k, min, max, w) => { const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.value = ST.set[k]; i.oninput = () => { const v = parseFloat(i.value); if (v >= min && v <= max) ST.set[k] = v; }; return i; };
    const r1 = el('div', 'setgrid'), cell = (label, inp) => { const l = el('label', 'setcell'); l.append(el('span', '', label), inp); return l; };
    r1.append(cell('Platforms', num('count', 1, 12)), cell('Length (m)', num('length', 10, 600)));
    const go = el('button', 'primary', ST.draw && ST.draw.kind === 'set' ? 'Click the map…' : 'Place on map'); go.title = 'Click the world: the platforms snap onto the tracks there, side by side, each on its own track';
    go.onclick = () => { ST.draw = {kind: 'set', pts: []}; map.getContainer().style.cursor = 'crosshair'; gCand.clearLayers(); draw(); render(); say('Click where the platforms go: they snap onto the tracks (Esc cancels)'); };
    const sel = ST.sel && ST.list.find(s => s.name === ST.sel);
    card.append(el('div', 'stcap', 'Platform set'), r1, el('div', 'c stnote', sel ? `Added to ${title(sel)}` : 'Makes a new station (asks for its name)'), go);
    return card;
  }
  function pickCard() {
    const card = el('div', 'stcard stpick'), n = ST.pick.size, sel = ST.sel && ST.list.find(s => s.name === ST.sel);
    card.append(el('div', 'stcap', `${n} platform${n > 1 ? 's' : ''} selected`), el('div', 'c stnote', 'Drag the blue handle on the map to move them together. Shift+click a platform to add or remove it.'));
    const acts = el('div', 'stacts');
    if (sel && !sel.single) { const all = el('button', '', 'Select all of this station'); all.onclick = () => { for (const [pn] of platList(sel)) ST.pick.set(pk(sel, pn), {station: sel.name, platform: pn || ''}); draw(); render(); }; acts.append(all); }
    const clr = el('button', '', 'Clear'); clr.onclick = () => { ST.pick.clear(); draw(); render(); }; acts.append(clr); card.append(acts);
    return card;
  }

  // ── panel ──
  function row(...kids) { const r = el('div', 'strow'); r.append(...kids); return r; }
  function render(full = true) {
    if (!active) return;
    box.textContent = '';
    box.append(el('h3', '', 'Stations'));
    const bar = row(); bar.classList.add('stbar'); const ns = el('button', '', 'New station'); ns.title = 'Click the two ends of its first platform on a rail'; ns.onclick = () => startDraw('newstation');
    bar.append(ns); box.append(bar); box.append(setBuilder()); if (ST.pick.size) box.append(pickCard()); if (ST.ends.size) box.append(endsCard());
    if (ST.sel) renderStation();
    box.append(el('div', 'stmsg', ST.msg));
  }
  function renderStation() {
    const st = ST.list.find(s => s.name === ST.sel); if (!st) return;
    const btn = (text, title, fn, cls) => { const b = el('button', cls || '', text); b.title = title; b.onclick = fn; return b; };
    const field = (name, ...kids) => { const r = el('div', 'stfield'); r.append(el('span', 'fl', name), ...kids); return r; };
    // ── the station: what is shared by all of its platforms ──
    const card = el('div', 'stcard'), head = el('div', 'sthead');
    head.append(el('h4', '', title(st)), btn('Google Maps', 'Open this station\'s coordinates in Google Maps (a new tab)', () => gmaps(st.location), 'gm'), btn('Rename', 'Rename the station; every route, line and destination that uses it follows', async () => {
      const n = (prompt('New name', title(st)) || '').trim(); if (n && n !== title(st)) { const r = await put('/api/rename', 'POST', {station: st.name, name: n}, `Renamed to ${n}`); if (r) { ST.sel = r.name; draw(); render(); } }
    }), btn('Merge into…', 'This station is really part of another one: its platforms move there and everything that used it follows', async () => {
      const into0 = (prompt('Merge into which station?') || '').trim(); if (!into0) return;
      const cands = ST.list.filter(x => x.name !== st.name && (x.name === into0 || title(x).toLowerCase() === into0.toLowerCase()));
      const dst = cands.find(x => x.name === into0) || (cands.length === 1 ? cands[0] : cands.sort((a, b) => km(st.location, a.location) - km(st.location, b.location))[0]);   // same name twice: the nearer one
      if (!dst) return say(`No station '${into0}' here`); const into = dst.name, intoT = title(dst);
      const body = {station: st.name, into};
      if (st.single) { body.platform_name = (prompt(`What is ${title(st)} called as a platform of ${intoT}?`, 'Main') || '').trim(); if (!body.platform_name) return; }
      if (dst.single) body.first = firstName(dst);
      if (await put('/api/rename', 'POST', body, `Merged into ${intoT}`)) { ST.sel = into; draw(); render(); }
    }));
    const lab = el('input'); lab.value = st.label || ''; lab.placeholder = title(st); lab.title = 'Shown instead of the name'; lab.onchange = () => setSt(st.name, {Label: lab.value.trim()});
    const major = el('input'); major.type = 'checkbox'; major.checked = !!st.major; major.onchange = () => setSt(st.name, {Major: major.checked});
    const ml = el('label', 'chk'); ml.append(major, ' Major');
    // the municipality: typed (with suggestions from those already used); the country and state are found from where the station is
    const mun = el('input'); mun.value = (st.region && st.region[0]) || ''; mun.placeholder = 'City or town'; mun.title = 'The country and state are found automatically';
    const saveMun = (hit, typed) => { const v = (hit ? hit.municipality : typed || '').trim();
      return put('/api/station_region', 'PUT', hit ? {station: st.name, municipality: hit.municipality, subdivision: hit.subdivision, country: hit.country} : {station: st.name, municipality: v}, v ? 'Municipality saved' : 'Municipality removed').then(r => { munCache = null; return r; }); };
    Combo(mun, {load: loadMuns, text: x => x.__create ? x.text : x.municipality, sub: x => `${x.subdivision}, ${x.country}`, badge: x => x.n > 1 ? `${x.n} stations` : '',
      create: t => ({__create: true, text: t}), createLabel: x => `Use “${x.text}” — country and state found from the station's location`, empty: 'Type a city or town', onCommit: saveMun});
    const again = el('button', '', '↻'); again.title = 'Find the country and state again from where the station is'; again.onclick = () => saveMun(null, mun.value);
    const reg = st.region && st.region.length >= 3 ? `${st.region[1]}, ${st.region[2]}` : '';
    const fnm = el('input'); fnm.value = st.futureName || ''; fnm.placeholder = 'same as ' + (st.label || title(st)); fnm.title = 'What the Future map calls this station (blank: the usual name). The Present map keeps the usual name.';
    fnm.onchange = () => put('/api/future_name', 'PUT', {station: st.name, name: fnm.value.trim()}, fnm.value.trim() ? `Future name: ${fnm.value.trim()}` : 'Future name cleared');
    card.append(head, field('Label', lab), ...(availOf(st, null) === 'both' ? [field('Future name', fnm)] : []), field('Type', typeSel(st.type, v => setSt(st.name, {Type: v})), ml), field('Municipality', mun, again));
    if (reg) card.append(el('div', 'c stnote', reg));
    if (!st.single) card.append(field('Maps', avSeg(st, null)), el('div', 'c stnote', 'Applies to every platform. A platform can have its own setting below.'));
    box.append(el('div', 'stcap', 'Station'), card);
    // ── its platforms: each one a card of its own ──
    const pls = platList(st);
    let fd = fold.get(st.name); if (!fd) fold.set(st.name, fd = {all: pls.length <= 3, open: new Set()});
    if (st.single) box.append(el('div', 'stcap', 'Platform'));
    else {                                                                       // many platforms: fold them away, open one from its chip or all from the heading
      const cap = el('div', 'stcap stfold', `${fd.all ? '▾' : '▸'} Platforms · ${pls.length}`); cap.title = fd.all ? 'Fold the platforms away' : 'Show every platform';
      cap.onclick = () => { fd.all = !fd.all; fd.open.clear(); render(); }; box.append(cap);
      if (!fd.all) {
        const chips = el('div', 'stchips');
        for (const [n] of pls) { const c = el('button', 'chip ' + useOf(st, n) + ' av-' + availOf(st, n) + (fd.open.has(n) ? ' on' : ''), n); c.title = AVTXT[availOf(st, n)] + ' · ' + useText(st, n); c.onclick = () => { fd.open.has(n) ? fd.open.delete(n) : fd.open.add(n); render(); }; chips.append(c); }
        box.append(chips);
      }
    }
    for (const [n, q] of pls) {
      if (!st.single && !fd.all && !fd.open.has(n)) continue;
      const pc = el('div', 'stplat'), ph = el('div', 'sthead');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = ST.pick.has(pk(st, n)); cb.title = 'Select, to move several platforms together (Shift+click works on the map)'; cb.onchange = () => togglePick(st, n, cb.checked);
      ph.append(cb, el('b', '', n ? plainPl(n) : title(st)), el('span', 'c', q.span ? `${len(q.span)} m` : 'no span'), btn('Maps', 'Open this platform\'s coordinates in Google Maps', () => gmaps(q.location), 'gm'));
      const av = el('div', 'stav'), uses = (st.used || {})[n || ''] || [], want = availOf(st, n);
      av.append(avSeg(st, n || null, !st.single && !(st.own || []).includes(n)));
      const clash = (want === 'present' && uses.includes('Fantasy')) || (want === 'future' && uses.includes('Present'));      // a route of a map the platform is not on stops here
      av.append(el('span', 'c' + (clash ? ' warn' : ''), clash ? `${want === 'present' ? 'Future' : 'Present'} routes still stop here` : st.single || (st.own || []).includes(n) ? useText(st, n) : `follows the station · ${useText(st, n)}`)); av.lastChild.title = useTip;
      if (n) {
        const x = btn('✕', 'Delete this platform', async () => { if (confirm(`Delete platform ${plainPl(n)} of ${title(st)}?`)) { await put('/api/platform', 'DELETE', {station: st.name, platform: n}, 'Deleted'); ST.sel = st.name; render(); } }, 'del');
        ph.append(x);
        const pl = el('input'); pl.value = q.Label || ''; pl.placeholder = 'same as station'; pl.title = 'Label at this platform (blank: the station\'s)'; pl.onchange = () => setPl(st.name, n, {Label: pl.value.trim()});
        const t = typeSel(q.Type, v => setPl(st.name, n, {Type: v}), true, st.type); t.title = 'An airport platform (it follows the station until ticked or unticked here)';
        pc.append(ph, av, field('Label', pl), field('Type', t));
      } else pc.append(ph, av);
      const acts = el('div', 'stacts');
      acts.append(btn('Span', 'Click two points on a rail to set the platform', () => startDraw('span', st.name, n || null)));
      if (!q.span) acts.append(btn('Snap to rail', 'Give this platform a span on the nearest rail (about 80 m: drag its ends to fit)', async () => {
        try { const r = await api('/api/platform_default', {method: 'POST', body: {map: S.mapName, at: q.location}}); if (!r.span) return say('No rail within 40 m of this platform'); await setPl(st.name, n || null, {Location: r.span.mid, Span: [r.span.a, r.span.b]}); render(); } catch (e) { say(e.message); }
      }));
      if (!q.span) acts.append(btn('Move', 'Click the map to place this platform', () => { ST.draw = {kind: 'move', station: st.name, platform: n || null, pts: []}; map.getContainer().style.cursor = 'crosshair'; say('Click where the platform is (Esc cancels)'); }));
      if (n) {
        acts.append(btn('Rename', 'Rename this platform everywhere it is used', async () => {
          const nn = (prompt('New platform name (it may match another platform of this station when they are on different maps)', plainPl(n)) || '').trim();
          if (!nn || nn === plainPl(n)) return;
          const keys = Object.keys(st.platforms), plan = [];                           // renames in the order they were worked out
          const twinOk = (p, k) => ['present', 'future'].includes(availOf(st, p)) && ['present', 'future'].includes(availOf(st, k)) && availOf(st, p) !== availOf(st, k);
          const gone = new Set(), chain = [];                                           // renamed away already / being renamed further up the chain
          const clash = (name, me) => keys.find(k => k !== me && !gone.has(k) && !chain.includes(k) && plainPl(k) === name && !twinOk(me, k));
          const ask = (me, name) => {                                                   // can `me` take `name`? if another platform is in the way, that one is renamed first
            const o = clash(name, me);
            if (o) {
              chain.push(me);                                                           // `me` is leaving its name, so the other may take it (a swap)
              for (;;) {
                const o2 = (prompt(`'${name}' is already a platform of ${st.name}. What should that existing platform be called?`, plainPl(me)) || '').trim();
                if (!o2) return false;
                if (o2 === name) { alert(`That is the name you are giving ${plainPl(me)}: choose another.`); continue; }
                if (!ask(o, o2)) return false;
                break;
              }
              chain.pop();
            }
            plan.push([me, name]); gone.add(me); return true;
          };
          if (!ask(n, nn)) { say('Rename cancelled'); return; }
          const live = new Set(keys), queue = plan.slice();
          for (let i = 0; i < queue.length; i++) {
            let [p, name] = queue[i];
            const occ = [...live].find(k => k !== p && plainPl(k) === name && !twinOk(p, k));
            if (occ) {                                                                  // the name is still taken by a platform that has not moved yet (a swap): park this one under a temporary name
              const tmp = `${name} (swap ${i})`; await put('/api/rename', 'POST', {station: st.name, platform: p, name: tmp}, `Renaming…`);
              live.delete(p); live.add(tmp); queue.push([tmp, name]); continue;
            }
            await put('/api/rename', 'POST', {station: st.name, platform: p, name}, `Renamed to ${name}`);
            live.delete(p); live.add(name);
          }
          render();
        }),
          btn('Merge', 'This is the same platform as another one of this station', async () => { const into0 = (prompt('Merge into which platform?', plainPl(Object.keys(st.platforms).find(x => x !== n) || '')) || '').trim(), same = Object.keys(st.platforms).filter(x => x !== n && (x === into0 || plainPl(x) === into0)), into = same.length === 1 ? same[0] : into0; if (into) { await put('/api/rename', 'POST', {station: st.name, platform: n, into}, `Merged into ${plainPl(into)}`); render(); } }));
      }
      if (q.fut) {                                                                   // a separate Future shape made before platforms had their own Present / Future setting
        const fr = el('div', 'stfut'); fr.append(el('span', 'c warn', 'Has an old separate Future shape'), btn('Remove it', 'Use this platform as drawn on the Present map again', () => confirm(`Drop the old Future shape of ${n || st.name}?`) && rebind(st, n)));
        pc.append(fr);
      }
      pc.append(acts); box.append(pc);
    }
    box.append(row(btn('Add platform', 'Click two points on a rail', () => startDraw('newplatform', st.name)),
      btn('Delete station', 'Delete this station and all its platforms', async () => { if (confirm(`Delete ${title(st)}?`)) { const r = await put('/api/platform', 'DELETE', {station: st.name, platform: null}, 'Deleted'); if (r) { ST.sel = null; draw(); render(); } } }, 'del')));
  }
  function typeSel(cur, on, platform, stType) {     // an Airport checkbox. A platform follows its station until it is ticked / unticked itself
    const cb = el('input'), lab = el('label', 'chk'); cb.type = 'checkbox';
    cb.checked = platform ? (cur === undefined ? stType === 'Airport' : cur === 'Airport') : cur === 'Airport';
    cb.onchange = () => on(platform ? (cb.checked ? 'Airport' : stType === 'Airport' ? null : false) : (cb.checked ? 'Airport' : null));
    lab.append(cb, ' Airport'); return lab;
  }
  // ── search: every station of the detailed map ──
  const sIn = $('#stsearch'), sOut = $('#stresults');
  function hits() {
    const t = sIn.value.trim().toLowerCase();
    return !t ? [] : ST.list.filter(s => [title(s), s.label || '', ...(s.region ? [s.region[0]] : []), ...Object.keys(s.platforms || {})].join(' ').toLowerCase().includes(t)).slice(0, 15);
  }
  function renderResults() {
    sOut.textContent = ''; sOut.hidden = !sIn.value.trim();
    if (sOut.hidden) return;
    const hs = hits();
    if (!hs.length) { sOut.append(el('div', 'sres', 'No station found')); return; }
    for (const s of hs) {
      const r = el('div', 'sres'); r.append(el('b', '', title(s)), el('span', 'c', [s.region && s.region[0], s.single ? '1 platform' : `${Object.keys(s.platforms).length} platforms`].filter(Boolean).join(' · ')));
      r.onclick = () => goStation(s); sOut.append(r);
    }
  }
  function goStation(s) {
    const pts = platList(s).map(([, p]) => p.location);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.5), {maxZoom: 17}); else map.setView(pts[0], Math.max(map.getZoom(), 15));
    setTool('stations'); selectStation(s.name); sIn.value = ''; renderResults();
  }
  sIn.oninput = renderResults;
  sIn.onkeydown = e => { if (e.key === 'Enter' && hits()[0]) goStation(hits()[0]); if (e.key === 'Escape') { sIn.value = ''; renderResults(); } };
  refresh();
})();