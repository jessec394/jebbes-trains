// ── Stops of the selected route: the stations / platforms its pattern stops at, written into the detailed map ──
// The stops ARE the route: it is traced from stop to stop (and back to the first). Waypoints only bend the way between two stops.
// Edits never change what other patterns share: the pattern gets its own wrapper segment (see devtools/stops.py).
(() => {
  const plainPl = window.plainPl || (n => String(n == null ? '' : n).replace(/\s*\[[^\]]*\]\s*$/, ''));
  const box = $('#stopbox');
  let reloadWait = null, cur = null, data = null, msg = '', both = false, ins = null, pick = null, stations = [];
  const gPick = L.layerGroup(), R = L.svg({pane: 'draftPane'});
  const pat = () => S.sel && {operator: S.sel.operator, line: S.sel.line, pattern: S.sel.pattern, category: S.sel.category};
  const okHere = (s, p) => { const v = (s.maps || {})[p || ''] || 'both'; return v === 'both' || v === (S.sel && S.sel.category === 'Fantasy' ? 'future' : 'present'); };       // a route only stops where its map has the platform
  const keyOf = (s, p) => p ? `${s.name} {${p}}` : s.name;

  let loadSeq = 0, reloadDone = null, lastAdded = null;                // lastAdded: where the next picked stop goes (right after the one just added, always)
  async function load() {
    const my = ++loadSeq, finish = () => { if (my === loadSeq && reloadDone) { const r = reloadDone; reloadDone = null; r(); } };
    const keep = pick && cur && S.sel && key(S.sel) === key(cur);        // the same route re-selected after a stop was added: stay in "pick platforms" mode
    cur = pat(); data = null; msg = ''; both = false; if (!keep) { ins = null; stopPick(); }
    if (!cur) { box.hidden = true; finish(); return; }
    let got = null, err = '';
    try { got = await api('/api/pattern_stops?' + new URLSearchParams(cur)); } catch (e) { err = e.message; }
    if (my !== loadSeq) return;                                         // a newer load is under way: this answer is out of date and must not overwrite it
    data = got; if (err) msg = err;
    if (!S.sel || key(S.sel) !== key(cur)) { if (pick) stopPick(); finish(); return; }
    if (pick && lastAdded && data && (data.stops.filter(x => x.key === lastAdded.near).length > (lastAdded.nth || 0))) { ins = pick.at = lastAdded; }
    render(); finish(); if (pick) { const l = data && data.stops.length ? data.stops.length - 1 : -1; if (!(ins && ins.near != null && data && data.stops.some(x => x.key === ins.near))) ins = pick.at = l >= 0 ? {near: data.stops[l].key, side: 'after', nth: nthAt(l)} : {near: null, side: 'after'}; drawPick(); }
  }
  async function edit(change) {
    try {
      data = await api('/api/pattern_stops', {method: 'POST', body: {...cur, change: both && data.shared.length ? {...change, shared: true} : change}});
      const bad = (data.reports || []).flatMap(r => r.ok ? [] : [r.warnings[0]]);
      msg = bad.length ? 'Saved; ' + bad[0] : 'Saved'; render();
      reloadWait = new Promise(res => { reloadDone = res; setTimeout(res, 4000); });
      document.dispatchEvent(new CustomEvent('stopschanged'));           // the route is re-traced from the new stops
      return true;
    } catch (e) { msg = e.message; render(); return false; }
  }
  const stopKeys = () => (data ? data.stops.map(s => s.key) : []);
  const idxOf = (list, k, n) => { const h = list.map((x, i) => x === k ? i : -1).filter(i => i >= 0); return h.length ? h[Math.min(n || 0, h.length - 1)] : -1; };
  const tidy = l => l.filter((x, i) => !i || l[i - 1] !== x);                       // two in a row are one stop
  // nth: which visit of `near` (a route may stop at one platform several times). The result is checked against what was meant: if the stop landed
  // anywhere else the exact order is written, so a stop can never end up in the wrong place.
  const add = async (k, at) => {
    const before = stopKeys(), j = at.near == null ? -1 : idxOf(before, at.near, at.nth), want = before.slice();
    want.splice(j < 0 ? before.length : at.side === 'before' ? j : j + 1, 0, k);
    if (!await edit({add: {key: k, near: at.near, side: at.side, nth: at.nth || 0}})) return false;
    if (JSON.stringify(stopKeys()) !== JSON.stringify(tidy(want))) return edit({order: tidy(want)});
    return true;
  };
  const nthAt = i => data && data.stops[i] ? data.stops.slice(0, i).filter(x => x.key === data.stops[i].key).length : 0;
  const where = () => ins || (data && data.stops.length ? {near: data.stops[data.stops.length - 1].key, side: 'after', nth: nthAt(data.stops.length - 1)} : {near: null, side: 'after'});

  // ── picking platforms on the map: click a platform and it becomes the next stop ──
  let pickTimer = null, adding = false;
  const settled = async () => { const w = reloadWait; reloadWait = null; if (w) await w; };           // the route has been re-read: only then is the next click taken
  async function drawPick() {
    if (!pick) return;
    if (map.getZoom() < 10) { gPick.clearLayers(); return say('Zoom in to see stations'); }
    const b = map.getBounds().pad(0.2);
    try { stations = await api('/api/station_list?' + q({bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(',')})); } catch (e) { return say(e.message); }
    gPick.clearLayers(); const have = new Set(stopKeys());
    for (const s of stations) for (const p of (s.single ? [''] : Object.keys(s.platforms))) {
      if (!okHere(s, p)) continue;
      const k = keyOf(s, p), ll = s.single ? s.location : s.platforms[p].Location, on = have.has(k);
      const m = L.circleMarker(ll, {renderer: R, radius: 8, color: on ? '#3fb950' : '#ffd23f', weight: 3, fillColor: on ? '#3fb950' : '#fff', fillOpacity: on ? .9 : .85}).bindTooltip(k.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\{([^}]*)\}/, ' — platform $1') + (on ? ' (already a stop: click to stop here again)' : ''), {direction: 'top'}).addTo(gPick);
      m.on('click', async ev => {
        L.DomEvent.stopPropagation(ev);
        if (adding) return;                                        // one at a time: the next click waits until this stop is in, so they can never get jumbled
        adding = true; map.getContainer().classList.add('pick-busy'); say('Adding…');
        try {
          const at = where();
          if (await add(k, at)) {
            const nth = (await settled(), data && data.stops ? data.stops.filter(x => x.key === k).length - 1 : 0);
            lastAdded = {near: k, side: 'after', nth: Math.max(nth, 0)}; pick = {...pick, at: lastAdded}; ins = lastAdded; render(); say(`Added ${plainPl(k).replace(/\s*\{[^}]*\}/, '')}. Click the next stop (Esc to finish)`); drawPick(); }
        } finally { adding = false; map.getContainer().classList.remove('pick-busy'); }
      });
    }
    say('Click platforms on the map to add them as stops (Esc to finish)');
  }
  const say = t => { msg = t; const m = box.querySelector('.stmsg'); if (m) m.textContent = t; };
  function startPick(at) { stopPick(); lastAdded = null; ins = at; pick = {at}; S.picking = true; document.body.classList.add('picking'); gPick.addTo(map); map.getContainer().style.cursor = 'crosshair'; drawPick(); render(); }
  function stopPick() { lastAdded = null; S.picking = false; document.body.classList.remove('picking'); if (!pick) return; pick = null; ins = null; gPick.clearLayers(); map.removeLayer(gPick); map.getContainer().style.cursor = ''; render(); }
  map.on('moveend', () => { if (!pick) return; clearTimeout(pickTimer); pickTimer = setTimeout(drawPick, 200); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pick) { e.stopPropagation(); stopPick(); } }, true);

  // ── reordering: drag a row by its handle; a bar shows where it will land; the panel scrolls when you reach its edge; Esc cancels ──
  function startDrag(e, from, row, rows) {
    if (e.button !== 0) return; e.preventDefault();
    const list = [...rows.querySelectorAll('.stopr')], scroller = box.closest('aside') || document.scrollingElement;
    const snap = data.stops.map((x, i) => ({key: x.key, nth: nthAt(i)}));
    let target = null, side = 'after', raf = 0, y = e.clientY;
    row.classList.add('dragging'); document.body.classList.add('dragging-stop');
    const clear = () => list.forEach(x => x.classList.remove('over', 'overb'));
    const update = () => {
      raf = 0; clear(); target = null;
      const sr = scroller.getBoundingClientRect();
      if (y < sr.top + 36) scroller.scrollTop -= 14; else if (y > sr.bottom - 36) scroller.scrollTop += 14;
      for (const x of list) { const r = x.getBoundingClientRect(); if (y >= r.top && y <= r.bottom) { target = +x.dataset.i; side = y > (r.top + r.bottom) / 2 ? 'after' : 'before'; break; } }
      if (target === null) { const f = list[0].getBoundingClientRect(), l = list[list.length - 1].getBoundingClientRect(); if (y < f.top) { target = 0; side = 'before'; } else if (y > l.bottom) { target = list.length - 1; side = 'after'; } }
      if (target !== null && !(target === from || (side === 'after' && target === from - 1) || (side === 'before' && target === from + 1))) list[target].classList.add(side === 'after' ? 'overb' : 'over');
      else target = null;
      if (y < sr.top + 36 || y > sr.bottom - 36) raf = requestAnimationFrame(update);
    };
    const move = ev => { y = ev.clientY; if (!raf) raf = requestAnimationFrame(update); };
    const end = async (ev, cancel) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('keydown', key, true); cancelAnimationFrame(raf);
      row.classList.remove('dragging'); document.body.classList.remove('dragging-stop'); clear();
      if (!cancel && target !== null) edit({move: {key: snap[from].key, nth: snap[from].nth, near: snap[target].key, near_nth: snap[target].nth, side}});
    };
    const up = ev => end(ev, false), key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); end(ev, true); } };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('keydown', key, true);
  }

  function render() {
    box.innerHTML = '';
    if (!cur || !data) { box.hidden = !msg; if (msg) { box.append(el('h3', '', 'Stops'), el('div', 'stmsg', msg)); } return; }
    box.hidden = false;
    const h = el('h3', '', 'Stops'); h.append(el('span', 'tag', `${data.stops.length}`));
    if (data.edited) { const r = el('button', '', 'Use shared'); r.title = 'Drop this route\'s own changes and use the stops it shares with other routes again'; r.style.float = 'right'; r.onclick = () => edit({reset: true}); h.append(r); }
    box.append(h);
    if (data.shared.length && !data.edited) {              // the stop list is shared with another route (usually the same route on the other map)
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = both; cb.onchange = () => { both = cb.checked; };
      const lb = el('label', 'chk'); lb.append(cb, ' Also change ' + data.shared.map(x => `${x.category === 'Fantasy' ? 'Future' : 'Present'} ${x.pattern}`).join(', '));
      lb.title = 'Unchecked: only this route changes and gets its own stops'; box.append(lb);
    }
    const bar = el('div', 'strow');
    const pb = el('button', pick ? 'primary' : '', pick ? 'Done' : '＋ Add stops on the map'); pb.title = 'Click platforms on the map to add them as stops, one after another (a platform may be a stop more than once)';
    pb.onclick = () => pick ? stopPick() : startPick(where());
    bar.append(pb);
    if (data.stops.length > 1) {
      const rv = el('button', '', '⇅ Reverse'); rv.title = 'Reverse the whole sequence (the last stop becomes the first)'; rv.onclick = () => { ins = null; edit({order: stopKeys().reverse()}); }; bar.append(rv);
    }
    if (data.stops.length) {
      const cl = el('button', 'del', 'Clear all'); cl.title = 'Remove every stop of this route';
      cl.onclick = () => { if (confirm(`Remove all ${data.stops.length} stops of this route?`)) { ins = null; edit({order: []}); } }; bar.append(cl);
    }
    box.append(bar);

    const rows = el('div', 'stops');
    if (data.stops.length) rows.append(el('div', 'seqcap start', '▶ START — the route begins here'));
    data.stops.forEach((st, i) => {
      const nth = nthAt(i);                                                 // taken now: the list may be reloading by the time a button is pressed
      const r = el('div', 'strow stopr' + (i === 0 ? ' first' : '') + (i === data.stops.length - 1 ? ' last' : '')); r.dataset.i = i;
      const grip = el('span', 'grip', '⠿'); grip.title = 'Drag this handle to reorder'; grip.setAttribute('aria-label', 'Drag to reorder');
      const lab = el('span', 'lab', st.label); lab.title = st.key; r.append(grip, el('span', 'n', String(i + 1)), lab);
      if (st.platforms.length) {                                            // every platform this stop may use is shown the same: tick the ones the route uses (at least one)
        const sx = stations.find(x => x.name === st.name), on = new Set(st.set || [st.key]), chips = el('span', 'pchips');
        chips.title = 'Platforms this stop uses: one service, all of them are shown when the line is hovered';
        const shown = st.platforms.filter(p => on.has(`${st.name} {${p}}`) || !sx || okHere(sx, p));
        for (const p of shown) {
          const k = `${st.name} {${p}}`, cb = el('input'); cb.type = 'checkbox'; cb.checked = on.has(k);
          cb.onchange = () => {
            const next = shown.map(q => `${st.name} {${q}}`).filter(q => q === k ? cb.checked : on.has(q));
            if (!next.length) { cb.checked = true; return; }
            edit({set: {key: st.key, platforms: next}, nth});
          };
          const lb = el('label', 'chk pchip' + (cb.checked ? ' on' : '')); lb.append(cb, ' ' + plainPl(p)); chips.append(lb);
        }
        r.append(chips);
      }
      const plus = el('button', '', '+'); plus.title = 'Add stops after this one: click their platforms on the map'; plus.onclick = () => startPick({near: st.key, side: 'after', nth});
      const x = el('button', '', '✕'); x.title = nth || data.stops.some((y, j) => j > i && y.key === st.key) ? 'Remove this visit (the route stops here again at another point)' : 'This route no longer stops here'; x.onclick = () => edit({skip: st.key, nth});
      r.append(plus, x);
      grip.onpointerdown = e => startDrag(e, i, r, rows);              // only the handle drags: the platform list and buttons on the row keep working
      if (pick && ins && ins.near === st.key && (ins.nth || 0) === nth) r.classList.add('here');
      rows.append(r);
    });
    if (data.stops.length > 1) rows.append(el('div', 'seqcap end', `■ LAST STOP — then it runs back to ${data.stops[0].label}`));
    box.append(rows);
    box.append(el('div', 'stmsg', msg));
  }
  document.addEventListener('routechange', load);
})();