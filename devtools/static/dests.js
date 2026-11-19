'use strict';
// ── Destinations tool: the airports, venues and campuses of the simplified map, and which stations of the detailed map serve each ──
// The venues come from the simplified map (data/map_data.py, never changed here). What this tool writes into the detailed map is, per venue,
// whether it is on the Present map, the Future map or both (the same Exists setting the simplified map uses), and the stations that serve it on
// each map it is on.
(function () {
  const box = $('#dstpanel');
  const D = {items: [], found: true, stations: [], sel: null, q: '', onlyOpen: false, pick: null, msg: '', make: null};
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
  document.addEventListener('keydown', e => { if (active && e.key === 'Escape' && !e.target.closest('input, select, textarea')) { if (D.make) { D.make = null; map.getContainer().style.cursor = ''; render(); } else if (D.pick) { stopPick(); render(); } else if (D.sel) { D.sel = null; draw(); render(); } } });

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

  function pin(d, sel) {
    const ok = !missing(d);
    return L.circleMarker(d.location, {renderer: R, radius: sel ? 9 : 6, color: sel ? '#ffd23f' : ok ? '#22c55e' : '#ef4444', weight: sel ? 3 : 2, fillColor: ok ? '#16a34a' : '#b91c1c', fillOpacity: .85, interactive: true});
  }
  function draw() {
    gDest.clearLayers(); gSel.clearLayers();
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
    box.append(el('h3', '', 'Destinations'));
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
    c.append(el('h4', '', 'New destination'), nm, sel, seg, go); setTimeout(() => !m.placing && nm.focus(), 0);
    return c;
  }

  function editBlock(d) {
    const c = el('div', 'dedit'), row = el('div', 'dactions');
    const rn = el('button', '', 'Rename'); rn.onclick = () => { const n = (prompt('New name', d.name) || '').trim(); if (n && n !== d.name) define({action: 'update', cat: d.cat, name: d.name, new_name: n}, `Renamed to ${n}`); };
    const cs = el('select'); cs.title = 'Category'; for (const k of cats()) { const o = el('option', '', k); o.value = k; cs.append(o); } cs.value = d.cat;
    cs.onchange = () => define({action: 'update', cat: d.cat, name: d.name, new_cat: cs.value}, `${d.name} is now in ${cs.value}`);
    const del = el('button', 'danger', 'Delete'); del.onclick = () => { if (confirm(`Delete “${d.name}” from the simplified map and the detailed map?`)) define({action: 'delete', cat: d.cat, name: d.name}, `Deleted ${d.name}`); };
    row.append(rn, cs, del); c.append(row);
    const im = el('div', 'dadd'), inp = el('input'); inp.placeholder = 'Image file name (no extension)'; inp.value = d.image || '';
    const sv = el('button', '', 'Set image'); sv.title = 'The picture shown in its popup: a file in data/images/destinations'; sv.onclick = () => inp.value.trim() && define({action: 'update', cat: d.cat, name: d.name, image: inp.value.trim()}, 'Image set');
    const op = el('button', '', '📂 Open images folder'); op.title = 'Open data/images/destinations in your file browser: put the picture there, then type its file name (without the extension) above';
    op.onclick = async () => { try { const r = await api('/api/open_images', {method: 'POST', body: {}}); say(`Opened ${r.path}`); } catch (e) { say(e.message); } };
    im.append(inp, sv); c.append(im, op);
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