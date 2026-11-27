'use strict';
// ── Destinations tool: the airports, venues and campuses of the simplified map, and which stations of the detailed map serve each ──
// The venues come from the simplified map (data/map_data.py, never changed here). What this tool writes into the detailed map is, per venue,
// whether it is on the Present map, the Future map or both (the same Exists setting the simplified map uses), and the stations that serve it on
// each map it is on.
(function () {
  const box = $('#dstpanel');
  const D = {items: [], found: true, stations: [], sel: null, q: '', onlyOpen: false, pick: null, msg: '', make: null, mode: 'dests'};
  const P = {items: [], sel: null, q: '', make: null, loaded: false};          // the simplified map's projects
  const RADIUS = {S: 'Small', M: 'Medium', L: 'Large', X: 'Extra large'};
  const gDest = L.layerGroup(), gSel = L.layerGroup(), R = L.svg({pane: 'draftPane'});
  const MAPS = {present: {field: 'stations', label: 'Present', color: '#ffd23f'}, future: {field: 'futureStations', label: 'Future', color: '#22d3ee'}};
  let active = false;
  const key = d => d.cat + '\u0001' + d.name;
  const cur = () => D.items.find(d => key(d) === D.sel);
  const km = (a, b) => map.distance(a, b);
  const SET = {present: 'Present', both: 'Both', future: 'Future'};
  const on = (d, m) => d.setting === 'both' || d.setting === m;                           // is the venue on that map?
  const maps = d => Object.keys(MAPS).filter(m => on(d, m));
  const missing = d => maps(d).some(m => !d[MAPS[m].field].length);
  const stTitle = n => { const s = D.stations.find(x => x.name === n); return (s && (s.title || s.name)) || n; };
  // a station can serve a venue on a map only if it is on that map (its own setting, or that of one of its platforms)
  const stationOn = (s, m) => {
    const mp = s.maps || {}, own = mp[''] || 'both', pl = Object.keys(s.platforms || {});
    const vals = pl.length ? pl.map(p => mp[p] || own) : [own];
    return vals.some(v => v === 'both' || v === m);
  };
  // a station is worth suggesting for a map when it is on that map AND some route of that map stops there (otherwise the website could not show it serving anything)
  const servedOn = (s, m) => { const k = m === 'present' ? 'Present' : 'Fantasy', u = s.used || {}; return Object.values(u).some(l => (l || []).includes(k)); };
  const suggest = (s, m) => stationOn(s, m) && servedOn(s, m);
  const say = t => { D.msg = t || ''; const m = box.querySelector('.dmsg'); if (m) m.textContent = D.msg; };

  document.addEventListener('toolchange', ev => {
    active = ev.detail === 'dests'; box.hidden = !active; $('#modebar').hidden = $('#modebar').hidden || active;
    if (active) { gDest.addTo(map); gSel.addTo(map); load(); }
    else { map.removeLayer(gDest); map.removeLayer(gSel); stopPick(); }
  });
  document.addEventListener('keydown', e => { if (active && e.key === 'Escape' && !e.target.closest('input, select, textarea')) { if (D.mode === 'projects' && P.make) { P.make = null; map.getContainer().style.cursor = ''; render(); } else if (D.mode === 'projects' && P.sel) { P.sel = null; draw(); render(); } else if (D.make) { D.make = null; map.getContainer().style.cursor = ''; render(); } else if (D.pick) { stopPick(); render(); } else if (D.sel) { D.sel = null; draw(); render(); } } });

  async function load() {
    try {
      const [r, st] = await Promise.all([api('/api/destinations'), api('/api/station_list')]);
      D.items = r.items; D.found = r.found; D.stations = st;
    } catch (e) { say('Could not load: ' + e.message); }
    draw(); render();
  }
  async function save(d, body, ok) {
    try {
      const r = await api('/api/destination', {method: 'POST', body: {cat: d.cat, name: d.name, ...body}});      // the server answers with the venue as saved: nothing else needs loading
      const i = D.items.findIndex(x => key(x) === key(d)); if (i >= 0) D.items[i] = r.item;
      draw(); render(); say(ok || 'Saved');
    }
    catch (e) { say(e.message); }
  }

  // adding, renaming, moving and deleting the venues themselves (they live in the simplified map's data/map_data.py)
  async function define(body, ok) {
    try {
      const r = await api('/api/destination_def', {method: 'POST', body});
      await load(); if (r.name) { const d = D.items.find(x => x.name === r.name && x.cat === r.cat); D.sel = d ? key(d) : null; } else D.sel = null;
      draw(); render(); say(ok || 'Saved');
    } catch (e) { say(e.message); }
  }
  const cats = () => [...new Set(D.items.map(d => d.cat))].sort();
  // Coordinates as people paste them: 36.10281, -115.17819 · (36.10281 -115.17819) · 35°27'49.5"N 97°30'58.5"W
  function parseCoords(s) {
    s = String(s || '').trim(); if (!s) return null;
    const dms = [...s.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|″|''))?\s*([NSEW])/gi)];
    let lat, lng;
    if (dms.length === 2) {
      const val = m => (+m[1] + (+m[2] || 0) / 60 + (+m[3] || 0) / 3600) * (/[SW]/i.test(m[4]) ? -1 : 1);
      if (/[NS]/i.test(dms[0][4])) { lat = val(dms[0]); lng = val(dms[1]); } else { lat = val(dms[1]); lng = val(dms[0]); }
    } else {
      const n = s.match(/-?\d+(?:\.\d+)?/g); if (!n || n.length !== 2) return null;
      lat = +n[0]; lng = +n[1];
    }

    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
  }

  const fmtCoords = p => p ? `${(+p[0]).toFixed(5)}, ${(+p[1]).toFixed(5)}` : '';
  function coordRow(value, label, onGo) {
    const r = el('div', 'dadd dcoord'), inp = el('input'), b = el('button', '', label);
    inp.placeholder = 'Coordinates, e.g. 36.10281, -115.17819'; inp.value = value || ''; inp.setAttribute('aria-label', 'Coordinates');
    inp.title = 'Decimal degrees (latitude, longitude) or degrees, minutes and seconds as Google Maps shows them';
    const go = () => { const p = parseCoords(inp.value); if (!p) return say('Those are not coordinates: try 36.10281, -115.17819'); onGo(p); };
    b.onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    r.append(inp, b); return r;
  }

  const flyTo = (p, z) => map.flyTo(p, Math.max(map.getZoom(), z), {duration: .6});

  function pin(d, sel) {
    const ok = !missing(d);
    return L.circleMarker(d.location, {renderer: R, radius: sel ? 9 : 6, color: sel ? '#ffd23f' : ok ? '#22c55e' : '#ef4444', weight: sel ? 3 : 2, fillColor: ok ? '#16a34a' : '#b91c1c', fillOpacity: .85, interactive: true});
  }
  function draw() {
    gDest.clearLayers(); gSel.clearLayers();
    if (D.mode === 'projects') return drawProjects();
    for (const d of D.items) {
      if (!d.location) continue;
      const m = pin(d, key(d) === D.sel).bindTooltip(`${d.name} · ${d.cat}`).addTo(gDest);
      m.on('click', ev => { L.DomEvent.stopPropagation(ev); choose(d, false); });
    }
    const d = cur(); if (!d || !d.location) return;
    const mk = L.marker(d.location, {draggable: true, zIndexOffset: 1000, icon: L.divIcon({className: 'dpin', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11]})}).bindTooltip('Drag to move this destination').addTo(gSel);
    mk.on('dragend', () => { const p = mk.getLatLng(); define({action: 'update', cat: d.cat, name: d.name, location: [p.lat, p.lng]}, `Moved ${d.name}`); });
    for (const m of maps(d)) for (const n of d[MAPS[m].field]) {                  // a line from the venue to each station that serves it: yellow Present, cyan Future
      const s = D.stations.find(x => x.name === n); if (!s) continue;
      L.polyline([d.location, s.location], {renderer: R, color: MAPS[m].color, weight: 2, dashArray: m === 'future' ? '2 6' : '5 5', interactive: false}).addTo(gSel);
      L.circleMarker(s.location, {renderer: R, radius: m === 'future' ? 10 : 8, color: MAPS[m].color, weight: 3, fillOpacity: 0, interactive: false}).bindTooltip(`${stTitle(n)} (${MAPS[m].label})`, {permanent: map.getZoom() >= 13, direction: m === 'future' ? 'bottom' : 'top'}).addTo(gSel);
    }
  }
  function choose(d, fly) {
    D.sel = key(d); stopPick(); draw(); render();
    if (fly && d.location) map.flyTo(d.location, Math.max(map.getZoom(), 14), {duration: .6});
    const row = box.querySelector('.drow.on'); if (row) row.scrollIntoView({block: 'nearest'});
  }

  // ── picking serving stations on the map: the click goes to the nearest station within a few pixels ──
  function startPick(m) { D.pick = m; map.getContainer().style.cursor = 'crosshair'; say(`Click stations on the map for the ${MAPS[m].label} map (Esc to finish)`); render(); }
  function stopPick() { D.pick = null; map.getContainer().style.cursor = ''; }
  map.on('click', ev => {
    if (active && D.mode === 'projects' && P.make && P.make.placing) {                     // a new project goes where the map was clicked
      const m = P.make, loc = [ev.latlng.lat, ev.latlng.lng]; P.make = null; map.getContainer().style.cursor = '';
      return defineProject(projectBody(m, loc), `Added ${m.name}`);
    }

    if (active && D.make && D.make.placing) {                                                // a new destination goes where the map was clicked
      const m = D.make; D.make = null; map.getContainer().style.cursor = '';
      return define({action: 'create', cat: m.cat, name: m.name, location: [ev.latlng.lat, ev.latlng.lng], setting: m.setting}, `Added ${m.name}`);
    }
    if (!active || !D.pick) return; const d = cur(); if (!d) return;
    const p = map.latLngToContainerPoint(ev.latlng); let best = null, bd = 1e9;
    for (const s of D.stations) { if (!stationOn(s, D.pick)) continue; const q = map.latLngToContainerPoint(s.location), dd = Math.hypot(p.x - q.x, p.y - q.y); if (dd < bd) { bd = dd; best = s; } }
    if (!best || bd > 28) return say('No station there');
    toggle(d, D.pick, best.name);
  });
  const toggle = (d, m, n) => {
    const f = MAPS[m].field, has = d[f].includes(n);
    return save(d, {[f]: has ? d[f].filter(x => x !== n) : [...d[f], n]}, `${has ? 'Removed' : 'Added'} ${stTitle(n)} (${MAPS[m].label})`);
  };

  function render() {
    box.innerHTML = '';
    const tabs = el('div', 'hg dmode'), sg = el('span', 'seg');
    for (const [k, label] of [['dests', 'Destinations'], ['projects', 'Projects']]) {
      const b = el('button', D.mode === k ? 'on' : '', label);
      b.onclick = () => { if (D.mode === k) return; D.mode = k; stopPick(); if (k === 'projects' && !P.loaded) loadProjects(); draw(); render(); };
      sg.append(b);
    }

    tabs.append(sg); box.append(tabs);
    if (D.mode === 'projects') { renderProjects(); box.append(el('div', 'dmsg stmsg', D.msg)); return; }
    if (!D.found) { box.append(el('div', 'muted', 'No destinations found: data/map_data.py has none (or is not there).')); return; }
    const top = el('div', 'drow2'), f = el('input'); f.placeholder = 'Search destinations…'; f.value = D.q; f.setAttribute('aria-label', 'Search destinations');
    f.oninput = () => { D.q = f.value; list(); };
    const lb = el('label', 'chk'), cb = el('input'); cb.type = 'checkbox'; cb.checked = D.onlyOpen; cb.onchange = () => { D.onlyOpen = cb.checked; list(); };
    const nb = el('button', D.make ? 'primary' : '', D.make ? 'Cancel' : '＋ New'); nb.title = 'Add a destination';
    nb.onclick = () => { if (D.make) { D.make = null; map.getContainer().style.cursor = ''; } else D.make = {name: '', cat: cats()[0] || '', setting: 'both', placing: false}; render(); };
    top.append(f, nb); lb.append(cb, ' Only without stations'); box.append(top);
    if (D.make) box.append(makeForm());
    box.append(lb);
    const lst = el('div', 'dlist'); box.append(lst);
    const list = () => {
      lst.innerHTML = '';
      const q = D.q.trim().toLowerCase();
      const rows = D.items.filter(d => (!q || (d.name + ' ' + d.cat).toLowerCase().includes(q)) && (!D.onlyOpen || missing(d))).sort((a, b) => a.cat.localeCompare(b.cat) || a.name.localeCompare(b.name));
      let lastCat = null;
      for (const d of rows.slice(0, 300)) {
        if (d.cat !== lastCat) { lst.append(el('div', 'dcat', d.cat)); lastCat = d.cat; }
        const r = el('div', 'drow' + (key(d) === D.sel ? ' on' : '')); r.tabIndex = 0;
        r.append(el('span', 'dn', d.name), el('span', 'dset ' + d.setting, SET[d.setting] || '—'));
        for (const m of maps(d)) { const n = d[MAPS[m].field].length; r.append(el('span', 'dcount ' + m + (n ? '' : ' none'), `${MAPS[m].label[0]} ${n}`)); }
        r.title = maps(d).map(m => `${MAPS[m].label}: ${d[MAPS[m].field].map(stTitle).join(', ') || 'no station yet'}`).join('\n');
        r.onclick = () => choose(d, true); r.onkeydown = e => { if (e.key === 'Enter') choose(d, true); };
        lst.append(r);
      }
      if (!rows.length) lst.append(el('div', 'muted', 'Nothing matches'));
      else if (rows.length > 300) lst.append(el('div', 'muted', `${rows.length - 300} more: search to narrow`));
    };
    list();
    const d = cur(); if (d) box.append(detail(d));
    box.append(el('div', 'dmsg stmsg', D.msg));
  }

  function makeForm() {
    const m = D.make, c = el('div', 'dcard dnew'), nm = el('input'); nm.placeholder = 'Name of the destination'; nm.value = m.name; nm.oninput = () => { m.name = nm.value; go.disabled = !nm.value.trim(); };
    const sel = el('select'); for (const k of cats()) { const o = el('option', '', k); o.value = k; sel.append(o); } sel.value = m.cat; sel.onchange = () => m.cat = sel.value;
    const seg = el('div', 'hg'); seg.append(el('span', '', 'Exists on')); const sg = el('span', 'seg');
    for (const k of ['present', 'both', 'future']) { const b = el('button', m.setting === k ? 'on' : '', SET[k]); b.onclick = () => { m.setting = k; render(); }; sg.append(b); }
    seg.append(sg);
    const go = el('button', 'primary', m.placing ? 'Click the map…' : 'Place on map'); go.disabled = !m.name.trim();
    go.onclick = () => { m.placing = true; map.getContainer().style.cursor = 'crosshair'; say('Click the map where it is (Esc to cancel)'); render(); };
    const cr = coordRow('', 'Add here', p => {
      if (!m.name.trim()) return say('Give it a name first');
      D.make = null; map.getContainer().style.cursor = '';
      define({action: 'create', cat: m.cat, name: m.name, location: p, setting: m.setting}, `Added ${m.name}`).then(() => flyTo(p, 14));
    });
    c.append(el('h4', '', 'New destination'), nm, sel, seg, go, el('div', 'muted', 'or enter its coordinates'), cr); setTimeout(() => !m.placing && nm.focus(), 0);
    return c;
  }

  // ── Projects (the simplified map's Projects): find one, see it on the map, move it by dragging or by coordinates, add new ones ──
  const pcur = () => P.items.find(p => p.name === P.sel);
  async function loadProjects() {
    try { P.items = (await api('/api/projects')).items; P.loaded = true; } catch (e) { say('Could not load the projects: ' + e.message); }
    draw(); render();
  }

  async function defineProject(body, ok) {
    try { const r = await api('/api/project_def', {method: 'POST', body}); P.sel = r.name || P.sel; await loadProjects(); say(ok || 'Saved'); return true; }
    catch (e) { say(e.message); return false; }
  }

  const projectBody = (m, loc) => ({action: 'create', name: m.name, location: loc, source: m.source, radius: m.radius, description: m.description, link: m.link, image: m.image});
  function drawProjects() {
    for (const p of P.items) {
      if (!p.location) continue;
      const sel = p.name === P.sel, m = L.circleMarker(p.location, {renderer: R, radius: sel ? 9 : 6, color: sel ? '#ffd23f' : '#60a5fa', weight: sel ? 3 : 2, fillColor: '#2563eb', fillOpacity: .85}).bindTooltip(p.name).addTo(gDest);
      m.on('click', ev => { L.DomEvent.stopPropagation(ev); chooseProject(p, false); });
    }

    const p = pcur(); if (!p || !p.location) return;
    const mk = L.marker(p.location, {draggable: true, zIndexOffset: 1000, icon: L.divIcon({className: 'dpin', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11]})}).bindTooltip('Drag to move this project').addTo(gSel);
    mk.on('dragend', () => { const q = mk.getLatLng(); defineProject({action: 'update', name: p.name, location: [q.lat, q.lng]}, `Moved ${p.name}`); });
  }

  function chooseProject(p, fly) { P.sel = p.name; draw(); render(); if (fly && p.location) flyTo(p.location, 12); }
  function renderProjects() {
    const top = el('div', 'drow2'), f = el('input'); f.placeholder = 'Search projects…'; f.value = P.q; f.setAttribute('aria-label', 'Search projects');
    const nb = el('button', P.make ? 'primary' : '', P.make ? 'Cancel' : '＋ New'); nb.title = 'Add a project';
    nb.onclick = () => { if (P.make) { P.make = null; map.getContainer().style.cursor = ''; } else P.make = {name: '', source: 'Proposal', radius: 'S', description: '', link: '', image: '', placing: false}; render(); };
    top.append(f, nb); box.append(top);
    if (P.make) box.append(projectForm());
    const lst = el('div', 'dlist'); box.append(lst);
    const list = () => {
      lst.innerHTML = '';
      const q = P.q.trim().toLowerCase(), rows = P.items.filter(p => !q || (p.name + ' ' + p.source).toLowerCase().includes(q));
      for (const p of rows) {
        const r = el('div', 'drow' + (p.name === P.sel ? ' on' : '')); r.tabIndex = 0; r.title = p.source;
        r.append(el('span', 'dn', p.name), el('span', 'dset both', p.radius || '—'));
        r.onclick = () => chooseProject(p, true); r.onkeydown = e => { if (e.key === 'Enter') chooseProject(p, true); };
        lst.append(r);
      }

      if (!rows.length) lst.append(el('div', 'muted', P.loaded ? 'Nothing matches' : 'Loading…'));
    };

    f.oninput = () => { P.q = f.value; list(); };
    list();
    const p = pcur(); if (!p) return;
    const c = el('div', 'dcard');
    c.append(el('h4', '', p.name), el('div', 'muted', `${p.source} · ${RADIUS[p.radius] || p.radius}`));
    if (p.description) c.append(el('div', 'muted', p.description));
    c.append(el('h5', '', 'Where it is'), coordRow(fmtCoords(p.location), 'Move', q => defineProject({action: 'update', name: p.name, location: q}, `Moved ${p.name}`).then(ok => ok && flyTo(q, 12))));
    c.append(el('div', 'muted', 'Or drag its pin on the map. Its text, picture and link are kept in data/map_data.py.'));
    box.append(c);
  }

  function projectForm() {
    const m = P.make, c = el('div', 'dcard dnew');
    const field = (k, ph) => { const i = el('input'); i.placeholder = ph; i.value = m[k]; i.oninput = () => { m[k] = i.value; if (k === 'name') go.disabled = !i.value.trim(); }; return i; };
    const nm = field('name', 'Name of the project'), src = field('source', 'Source: the agency behind it, or Proposal'), ln = field('link', 'Link (optional)'), im = field('image', 'Image URL (optional)');
    const ds = el('textarea'); ds.placeholder = 'Description'; ds.rows = 3; ds.value = m.description; ds.oninput = () => { m.description = ds.value; };
    const seg = el('div', 'hg'), sg = el('span', 'seg'); seg.append(el('span', '', 'Size'));
    for (const k of Object.keys(RADIUS)) { const b = el('button', m.radius === k ? 'on' : '', k); b.title = RADIUS[k]; b.onclick = () => { m.radius = k; render(); }; sg.append(b); }
    seg.append(sg);
    const go = el('button', 'primary', m.placing ? 'Click the map…' : 'Place on map'); go.disabled = !m.name.trim();
    go.onclick = () => { m.placing = true; map.getContainer().style.cursor = 'crosshair'; say('Click the map where it is (Esc to cancel)'); render(); };
    const cr = coordRow('', 'Add here', q => {
      if (!m.name.trim()) return say('Give it a name first');
      P.make = null; map.getContainer().style.cursor = '';
      defineProject(projectBody(m, q), `Added ${m.name}`).then(ok => ok && flyTo(q, 12));
    });

    c.append(el('h4', '', 'New project'), nm, src, ds, ln, im, seg, go, el('div', 'muted', 'or enter its coordinates'), cr);
    setTimeout(() => !m.placing && !m.name && nm.focus(), 0);
    return c;
  }

  function editBlock(d) {
    const c = el('div', 'dedit'), row = el('div', 'dactions');
    const rn = el('button', '', 'Rename'); rn.onclick = () => { const n = (prompt('New name', d.name) || '').trim(); if (n && n !== d.name) define({action: 'update', cat: d.cat, name: d.name, new_name: n}, `Renamed to ${n}`); };
    const cs = el('select'); cs.title = 'Category'; for (const k of cats()) { const o = el('option', '', k); o.value = k; cs.append(o); } cs.value = d.cat;
    cs.onchange = () => define({action: 'update', cat: d.cat, name: d.name, new_cat: cs.value}, `${d.name} is now in ${cs.value}`);
    const del = el('button', 'danger', 'Delete'); del.onclick = () => { if (confirm(`Delete “${d.name}” from the simplified map and the detailed map?`)) define({action: 'delete', cat: d.cat, name: d.name}, `Deleted ${d.name}`); };
    row.append(rn, cs, del); c.append(row);
    const im = el('div', 'dadd'), inp = el('input'); inp.placeholder = 'Image URL (the picture itself, not its page)'; inp.value = d.image || '';
    const sv = el('button', '', 'Set image'); sv.title = 'The picture shown in its popup: the address of the image itself. Building the map (main.py) downloads it and looks up its credit'; sv.onclick = () => inp.value.trim() && define({action: 'update', cat: d.cat, name: d.name, image: inp.value.trim()}, 'Image set');
    im.append(inp, sv); c.append(im);
    c.append(coordRow(fmtCoords(d.location), 'Move', p => define({action: 'update', cat: d.cat, name: d.name, location: p}, `Moved ${d.name}`).then(() => flyTo(p, 14))));
    return c;
  }

  function section(d, m) {
    const c = el('div', 'dsec ' + m), f = MAPS[m].field, mine = d[f];
    c.append(el('h5', '', `Serves it on the ${MAPS[m].label} map`));
    const chips = el('div', 'dchips');
    for (const n of mine) {
      const ch = el('span', 'dchip ' + m), x = el('button', '', '✕'); x.title = 'This station no longer serves it'; x.onclick = () => toggle(d, m, n);
      const nm = el('span', '', stTitle(n)); nm.onclick = () => { const s = D.stations.find(z => z.name === n); if (s) map.flyTo(s.location, Math.max(map.getZoom(), 15), {duration: .5}); };
      ch.append(nm, x); chips.append(ch);
    }
    if (!mine.length) chips.append(el('span', 'muted', 'No station yet'));
    c.append(chips);
    const avail = D.stations.filter(s => suggest(s, m) && !mine.includes(s.name));
    const add = el('div', 'dadd'), inp = el('input'); inp.placeholder = 'Add a station…'; add.append(inp);
    if (window.Combo) Combo(inp, {load: async () => avail.slice().sort((a, b) => km(d.location, a.location) - km(d.location, b.location)),
      text: s => s.title || s.name, sub: s => d.location ? (km(d.location, s.location) / 1000).toFixed(1) + ' km' : '', onCommit: s => { if (s) { inp.value = ''; toggle(d, m, s.name); } }, empty: `No ${MAPS[m].label} map station by that name that a route stops at`});
    const on_ = D.pick === m, pb = el('button', on_ ? 'primary' : '', on_ ? 'Done' : '＋ Pick on map'); pb.title = 'Click stations on the map to add or remove them'; pb.onclick = () => { on_ ? stopPick() : startPick(m); render(); };
    add.append(pb); c.append(add);
    const near = d.location ? avail.map(s => ({s, m: km(d.location, s.location)})).filter(x => x.m < 3000).sort((a, b) => a.m - b.m).slice(0, 5) : [];
    if (near.length) {
      const nb = el('div', 'dchips');
      for (const {s, m: dist} of near) { const b = el('button', 'dchip add', `＋ ${s.title || s.name} · ${dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km'}`); b.onclick = () => toggle(d, m, s.name); nb.append(b); }
      c.append(nb);
    }
    return c;
  }

  function detail(d) {
    const c = el('div', 'dcard');
    c.append(el('h4', '', d.name), el('div', 'muted', d.cat));
    const seg = el('div', 'hg'); seg.append(el('span', '', 'Exists on'));
    const sg = el('span', 'seg'); sg.title = 'Which map this destination is on: the same Present / Future setting as on the simplified map';
    for (const k of ['present', 'both', 'future']) { const b = el('button', d.setting === k ? 'on' : '', SET[k]); b.onclick = () => d.setting !== k && save(d, {setting: k}, `${d.name}: ${SET[k]}`); sg.append(b); }
    seg.append(sg); c.append(seg);
    if (!d.own) c.append(el('div', 'muted', 'Set as on the simplified map until you change it here.'));
    if (d.setting === 'none') c.append(el('div', 'muted', 'It is on neither map: choose Present, Both or Future.'));
    for (const m of maps(d)) c.append(section(d, m));
    c.append(editBlock(d));
    return c;
  }
})();