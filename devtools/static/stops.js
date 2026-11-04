// ── Stops of the selected route: which stations / platforms the pattern stops at, written into map_data.py ──
// Edits never change what other patterns share: the pattern gets its own wrapper segment (see devtools/stops.py).
(() => {
  const box = $('#stopbox');
  let cur = null, data = null, adding = null, msg = '';
  const pat = () => S.sel && {operator: S.sel.operator, line: S.sel.line, pattern: S.sel.pattern, category: S.sel.category};
  async function load() {
    cur = pat(); data = null; adding = null; msg = '';
    if (!cur) { box.hidden = true; return; }
    try { data = await api('/api/pattern_stops?' + new URLSearchParams(cur)); } catch (e) { data = null; msg = e.message; }
    if (!S.sel || key(S.sel) !== key(cur)) return;
    render();
  }
  async function edit(change, where) {
    try { data = await api('/api/pattern_stops', {method: 'POST', body: {...cur, change}}); msg = 'Saved to map_data.py'; adding = null; }
    catch (e) { msg = e.message; }
    render();
  }
  async function begin(near, side, ll) {           // the stations around the stop are the choices
    const d = .15; let list = [];
    try { list = await api('/api/station_list?' + new URLSearchParams({bbox: [ll[0] - d, ll[1] - d, ll[0] + d, ll[1] + d].join(',')})); } catch (e) {}
    const dl = el('datalist'); dl.id = 'stopnames';
    for (const s of list) for (const k of s.single ? [s.name] : Object.keys(s.platforms).map(p => `${s.name} {${p}}`)) { const o = el('option'); o.value = k; dl.append(o); }
    adding = {near, side, dl}; render();
  }
  function render() {
    box.innerHTML = '';
    if (!cur || !data) { box.hidden = !msg; if (msg) { box.append(el('h3', '', 'Stops'), el('div', 'stmsg', msg)); } return; }
    box.hidden = false;
    const h = el('h3', '', 'Stops'); h.append(el('span', 'tag', `${data.stops.length}`));
    if (data.edited) { const r = el('button', '', 'Use shared'); r.title = 'Drop this route\'s own changes and use the stops it shares with other routes again'; r.style.float = 'right'; r.onclick = () => edit({reset: true}); h.append(r); }
    box.append(h);
    const addBtn = (st, side, title) => { const b = el('button', '', '+'); b.title = title; b.onclick = () => begin(st.key, side, st.location); return b; };
    const addRow = (near, side) => {
      const r = el('div', 'strow'), i = el('input'); i.setAttribute('list', 'stopnames'); i.placeholder = 'Station or platform'; i.style.flex = '1';
      const ok = el('button', 'primary', 'Add'); ok.onclick = () => edit({add: {key: i.value.trim(), near, side}});
      const no = el('button', '', '✕'); no.onclick = () => { adding = null; render(); };
      i.onkeydown = e => { if (e.key === 'Enter') ok.onclick(); if (e.key === 'Escape') no.onclick(); };
      r.append(adding.dl, i, ok, no); setTimeout(() => i.focus(), 0); return r;
    };
    if (adding && adding.near === data.stops[0]?.key && adding.side === 'before') box.append(addRow(adding.near, 'before'));
    else if (data.stops.length) box.append(addBtn(data.stops[0], 'before', 'Add a stop before the first'));
    for (const st of data.stops) {
      const r = el('div', 'strow'), lab = el('span', 'lab', st.label); lab.title = st.key; r.append(lab);
      if (st.platforms.length) {
        const sel = el('select'); sel.title = 'Platform this route uses';
        for (const p of st.platforms) { const o = el('option', '', p); o.value = `${st.name} {${p}}`; sel.append(o); }
        sel.value = st.key; sel.onchange = () => edit({swap: {from: st.key, to: sel.value}}); r.append(sel);
      }
      const x = el('button', '', '✕'); x.title = 'This route no longer stops here'; x.onclick = () => edit({skip: st.key});
      r.append(addBtn(st, 'after', 'Add a stop after this one'), x); box.append(r);
      if (adding && adding.near === st.key && adding.side === 'after') box.append(addRow(st.key, 'after'));
    }
    box.append(el('div', 'stmsg', msg));
  }
  document.addEventListener('routechange', load);
})();