// ── Stops of the selected route: the stations / platforms its pattern stops at, written into the detailed map ──
// The stops ARE the route: it is traced from stop to stop (and back to the first). Waypoints only bend the way between two stops.
// Edits never change what other patterns share: the pattern gets its own wrapper segment (see devtools/stops.py).
(() => {
  const plainPl = window.plainPl || (n => String(n == null ? '' : n).replace(/\s*\[[^\]]*\]\s*$/, ''));
  const box = $('#stopbox');
  let cur = null, data = null, msg = '', both = false, ins = null, pick = null, stations = [];
  const gPick = L.layerGroup(), R = L.svg({pane: 'draftPane'});
  const pat = () => S.sel && {operator: S.sel.operator, line: S.sel.line, pattern: S.sel.pattern, category: S.sel.category};
  const okHere = (s, p) => { const v = (s.maps || {})[p || ''] || 'both'; return v === 'both' || v === (S.sel && S.sel.category === 'Fantasy' ? 'future' : 'present'); };       // a route only stops where its map has the platform
  const keyOf = (s, p) => p ? `${s.name} {${p}}` : s.name;

  let loadSeq = 0, lastAdded = null, editVer = 0;                       // lastAdded: where the next picked stop goes (right after the one just added, always)
  async function load() {
    const my = ++loadSeq, ver = editVer;
    const keep = pick && cur && S.sel && key(S.sel) === key(cur);        // the same route re-selected after a stop was added: stay in "pick platforms" mode
    if (!keep) pendingSet.clear();
    cur = pat(); data = null; msg = ''; both = false; if (!keep) { ins = null; stopPick(); }
    if (!cur) { box.hidden = true; return; }
    let got = null, err = '';
    try { got = await api('/api/pattern_stops?' + new URLSearchParams(cur)); } catch (e) { err = e.message; }
    if (my !== loadSeq) return;                                         // a newer load is under way: this answer is out of date and must not overwrite it
    if (ver !== editVer && known && known._k === key(cur)) got = {...(got || {}), ...known};          // a stop was added while this was read: the edit's answer is newer
    data = got; if (err) msg = err;
    if (!S.sel || key(S.sel) !== key(cur)) { if (pick) stopPick(); return; }
    if (pick && lastAdded && data && (data.stops.filter(x => x.key === lastAdded.near).length > (lastAdded.nth || 0))) { ins = pick.at = lastAdded; }
    render(); if (pick) { const l = data && data.stops.length ? data.stops.length - 1 : -1; if (!(ins && ins.near != null && data && data.stops.some(x => x.key === ins.near))) ins = pick.at = l >= 0 ? {near: data.stops[l].key, side: 'after', nth: nthAt(l)} : {near: null, side: 'after'}; drawPick(); }
  }
  // retrace: false while stops are being picked; the route is traced once the picked stops are all in
  let known = null;                                                     // the stop list as the server last answered an edit: never emptied by a reload
  async function edit(change, retrace = true) {
    try {
      const shared = both && (live() || {shared: []}).shared.length, me = cur;
      const got = await api('/api/pattern_stops', {method: 'POST', body: {...me, change: shared ? {...change, shared: true} : change}});
      if (!cur || key(cur) !== key(me)) return true;                    // another route was opened meanwhile: this answer is not about it
      got._k = key(me); data = known = got; editVer++;
      const bad = (data.reports || []).flatMap(r => r.ok ? [] : [r.warnings[0]]);
      msg = bad.length ? 'Saved; ' + bad[0] : 'Saved'; render();
      if (retrace) document.dispatchEvent(new CustomEvent('stopschanged'));           // the route is re-traced from the new stops
      return true;
    } catch (e) { msg = e.message; render(); return false; }
  }
  const live = () => data || (known && cur && known._k === key(cur) ? known : null);
  const stopKeys = () => (live() ? live().stops.map(s => s.key) : []);
  const idxOf = (list, k, n) => { const h = list.map((x, i) => x === k ? i : -1).filter(i => i >= 0); return h.length ? h[Math.min(n || 0, h.length - 1)] : -1; };
  const tidy = l => l.filter((x, i) => !i || l[i - 1] !== x);                       // two in a row are one stop
  // Adds k at `at` (nth: which visit of a platform) and writes the exact order if it landed elsewhere -> which visit of k it is, or null
  const add = async (k, at) => {
    const before = stopKeys(), j = at.near == null ? -1 : idxOf(before, at.near, at.nth), want = before.slice(), pos = j < 0 ? before.length : at.side === 'before' ? j : j + 1;
    want.splice(pos, 0, k);
    const nth = tidy(want.slice(0, pos)).filter(x => x === k).length;
    if (!await edit({add: {key: k, near: at.near, side: at.side, nth: at.nth || 0}}, false)) return null;
    const got = stopKeys(), sorted = l => JSON.stringify([...l].sort());
    if (JSON.stringify(got) !== JSON.stringify(tidy(want)) && sorted(got) === sorted(tidy(want)) && !await edit({order: tidy(want)}, false)) return null;        // only ever a reorder of the same stops
    return nth;
  };
  const nthAt = i => data && data.stops[i] ? data.stops.slice(0, i).filter(x => x.key === data.stops[i].key).length : 0;
  const where = () => ins || (data && data.stops.length ? {near: data.stops[data.stops.length - 1].key, side: 'after', nth: nthAt(data.stops.length - 1)} : {near: null, side: 'after'});

  // ── picking platforms on the map: clicks never wait; while stops are being picked the list is a plan (reorder and trim it freely), saved stop by stop, then put in its order in one write ──
  let pickTimer = null, queue = [], running = false, plan = null, anchor = null, qRoute = null, retraceT = null, inflight = null;
  const pendingSet = new Map();                                         // stop index -> the platforms it is to use: shown at once, saved through the queue
  const shown = () => plan.filter(e => !e.removed);
  const label = k => plainPl(k).replace(/\s*\{[^}]*\}/, '');
  function startPlan() {
    const keys = stopKeys(), w = where(); plan = keys.map(k => ({k, saved: true})); qRoute = cur && key(cur);
    const j = w.near == null ? -1 : idxOf(keys, w.near, w.nth);
    anchor = j < 0 ? plan[plan.length - 1] || null : w.side === 'before' ? plan[j - 1] || null : plan[j];
  }

  // where the server should put a planned stop: right after the nearest saved stop before it in the plan
  function placeOf(e) {
    let p = plan.indexOf(e) - 1;
    while (p >= 0 && !plan[p].saved) p--;
    if (p < 0) { const f = plan.find(x => x.saved); return f ? {near: f.k, side: 'before', nth: 0} : {near: null, side: 'after'}; }
    return {near: plan[p].k, side: 'after', nth: plan.slice(0, p).filter(x => x.saved && x.k === plan[p].k).length};
  }

  function finishPlan() {
    const vis = shown(), a = anchor && !anchor.removed ? anchor : null, i = a ? vis.indexOf(a) : -1;
    lastAdded = a ? {near: a.k, side: 'after', nth: vis.slice(0, i).filter(x => x.k === a.k).length} : null;
    if (pick && lastAdded) { pick = {...pick, at: lastAdded}; ins = lastAdded; }
    plan = null; anchor = null; render();
  }

  async function runQueue() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        for (let w = 0; !live() && cur && key(cur) === qRoute && w < 200; w++) await new Promise(r => setTimeout(r, 50));        // the stop list is being read: the next stop goes in once it is known
        if (!cur || key(cur) !== qRoute || !live()) { queue = []; plan = null; break; }      // the route was closed, another opened, or its stops could not be read: the rest is dropped
        if (queue[0].op) {                                                    // a stop's platforms: the latest choice for it is written, then the path follows
          const {i} = queue.shift(), st = live().stops[i], want = pendingSet.get(i);
          if (st && want) { say('Saving platforms…'); await edit({set: {key: st.key, platforms: want}, nth: live().stops.slice(0, i).filter(x => x.key === st.key).length}, false); }
          if (!queue.some(x => x.op && x.i === i)) pendingSet.delete(i);
          render(); liveTrace(); continue;
        }

        const e = inflight = queue.shift();
        say(`Adding ${label(e.k)}…` + (queue.length ? ` (${queue.length} more to go)` : ''));
        const ok = await add(e.k, placeOf(e)) !== null; inflight = null;
        if (!ok) { const n = queue.length; queue = []; plan = plan.filter(x => x.saved); say(`${msg}` + (n ? ` · the ${n} stop${n > 1 ? 's' : ''} picked after it were not added` : '')); break; }
        e.saved = true; render(); drawPick(); liveTrace();
      }

      for (let g = 0; plan && !queue.length && g < 5; g++) {                    // all in: the saved order becomes the planned one (checked again if the plan changed during the write)
        const want = tidy(shown().map(x => x.k)), have = stopKeys(), left = have.slice();
        if (JSON.stringify(have) === JSON.stringify(want) || !want.every(k => { const j = left.indexOf(k); if (j >= 0) left.splice(j, 1); return j >= 0; })) { finishPlan(); break; }      // only ever a reorder or removal of saved stops
        say('Putting the stops in order…');
        if (!await edit({order: want}, false)) break;
      }
    } finally { running = false; inflight = null; }
    if (queue.length) return runQueue();                                       // stops picked while the order was written
    if (editVer) { clearTimeout(retraceT); retraceT = setTimeout(() => { if (!running && !queue.length) document.dispatchEvent(new CustomEvent('stopschanged')); }, 350); }
    if (lastAdded && pick) say(`Added ${label(lastAdded.near)}. Click the next stop (Esc to finish)`);
  }

  function pickStop(k) {
    if (!plan) startPlan();
    const e = {k, saved: false};
    plan.splice(anchor ? plan.indexOf(anchor) + 1 : 0, 0, e); anchor = e; queue.push(e);
    clearTimeout(retraceT); render(); runQueue();
  }

  // a stop of the plan removed or dragged: one not saved yet just leaves the queue; the saved order follows the plan once everything is in
  function planRemove(e) {
    const vis = shown(), i = vis.indexOf(e);
    if (anchor === e) anchor = vis[i - 1] || null;
    e.removed = true;
    if (!e.saved && e !== inflight) { queue = queue.filter(x => x !== e); plan = plan.filter(x => x !== e); }
    render(); drawPick();
  }

  function planMove(from, target, side) {
    const vis = shown(), e = vis[from], t = vis[target];
    plan = plan.filter(x => x !== e); plan.splice(plan.indexOf(t) + (side === 'after' ? 1 : 0), 0, e);
    render();
  }

  async function drawPick() {
    if (!pick) return;
    if (map.getZoom() < 10) { gPick.clearLayers(); return say('Zoom in to see stations'); }
    const b = map.getBounds().pad(0.2);
    try { stations = await api('/api/station_list?' + q({bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].join(',')})); } catch (e) { return say(e.message); }
    gPick.clearLayers(); const have = new Set([...stopKeys(), ...(plan ? shown().map(x => x.k) : [])]);
    for (const s of stations) for (const p of (s.single ? [''] : Object.keys(s.platforms))) {
      if (!okHere(s, p)) continue;
      const k = keyOf(s, p), ll = s.single ? s.location : s.platforms[p].Location, on = have.has(k);
      const m = L.circleMarker(ll, {renderer: R, radius: 8, color: on ? '#3fb950' : '#ffd23f', weight: 3, fillColor: on ? '#3fb950' : '#fff', fillOpacity: on ? .9 : .85}).bindTooltip(k.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\{([^}]*)\}/, ' — platform $1') + (on ? ' (already a stop: click to stop here again)' : ''), {direction: 'top'}).addTo(gPick);
      m.on('click', ev => { L.DomEvent.stopPropagation(ev); m.setStyle({color: '#3fb950', fillColor: '#3fb950', fillOpacity: .9}); pickStop(k); });
    }

    if (!running && !queue.length) say('Click platforms on the map to add them as stops (Esc to finish)');
  }

  const say = t => { msg = t; const m = box.querySelector('.stmsg'); if (m) m.textContent = t; };
  function startPick(at) { stopPick(); lastAdded = null; ins = at; pick = {at}; S.picking = true; document.body.classList.add('picking'); gPick.addTo(map); map.getContainer().style.cursor = 'crosshair'; drawPick(); render(); }
  function stopPick() { lastAdded = null; S.picking = false; document.body.classList.remove('picking'); if (!pick) return; pick = null; ins = null; gPick.clearLayers(); map.removeLayer(gPick); map.getContainer().style.cursor = ''; render(); }
  map.on('moveend', () => { if (!pick) return; clearTimeout(pickTimer); pickTimer = setTimeout(drawPick, 200); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pick) { e.stopPropagation(); stopPick(); } }, true);

  // ── reordering: drag a row by its handle; a bar shows where it will land; the panel scrolls when you reach its edge; Esc cancels ──
  function startDrag(e, from, row, rows, onDrop) {
    if (e.button !== 0) return; e.preventDefault();
    const list = [...rows.querySelectorAll('.stopr')], scroller = box.closest('aside') || document.scrollingElement;
    const snap = onDrop ? [] : data.stops.map((x, i) => ({key: x.key, nth: nthAt(i)}));
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
      if (!cancel && target !== null) onDrop ? onDrop(from, target, side) : edit({move: {key: snap[from].key, nth: snap[from].nth, near: snap[target].key, near_nth: snap[target].nth, side}});
    };
    const up = ev => end(ev, false), key = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); end(ev, true); } };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('keydown', key, true);
  }

  function render() {
    box.innerHTML = '';
    if (!cur || !data) { box.hidden = !msg; if (msg) { box.append(el('h3', '', 'Stops'), el('div', 'stmsg', msg)); } return; }
    box.hidden = false;
    const h = el('h3', '', 'Stops'); h.append(el('span', 'tag', `${plan ? shown().length : data.stops.length}`));
    if (data.edited) { const r = el('button', '', 'Use shared'); r.title = 'Drop this route\'s own changes and use the stops it shares with other routes again'; r.style.float = 'right'; r.onclick = () => edit({reset: true}); h.append(r); }
    box.append(h);
    if (data.shared.length && !data.edited) {              // the stop list is shared with another route (usually the same route on the other map)
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = both; cb.onchange = () => { both = cb.checked; };
      const lb = el('label', 'chk'); lb.append(cb, ' Also change ' + data.shared.map(x => `${x.category === 'Fantasy' ? 'Future' : 'Present'} ${x.pattern}`).join(', '));
      lb.title = 'Unchecked: only this route changes and gets its own stops'; box.append(lb);
    }
    const bar = el('div', 'strow stbar');
    const pb = el('button', pick ? 'primary' : '', pick ? 'Done' : '＋ Add stops on the map'); pb.title = 'Click platforms on the map to add them as stops, one after another (a platform may be a stop more than once)';
    pb.onclick = () => pick ? stopPick() : startPick(where());
    bar.append(pb);
    if (data.stops.length > 1 && !plan) {
      const rv = el('button', 'sm', '⇅ Reverse'); rv.title = 'Reverse the whole sequence (the last stop becomes the first)'; rv.onclick = () => { ins = null; edit({order: stopKeys().reverse()}); }; bar.append(rv);
    }
    if (!plan && (data.shuttle || data.stops.some(s => (s.platforms || []).length > 1))) {          // a short line whose trains go back and forth on each of its tracks
      const sh = el('button', 'sm' + (data.shuttle ? ' on' : ''), '⇆ Shuttle'); sh.setAttribute('aria-pressed', data.shuttle ? 'true' : 'false');
      sh.title = data.shuttle ? 'Shuttle: traced once along each track (every platform of each stop is used). Click to trace it as a normal line again' : 'Trains shuttle back and forth on each track instead of switching over at the ends: the line is traced along every track, still as one pattern';
      sh.onclick = () => edit({shuttle: !data.shuttle}); bar.append(sh);
    }
    if (data.stops.length && !plan) {
      const cl = el('button', 'del sm quiet', 'Clear all'); cl.title = 'Remove every stop of this route';
      cl.onclick = () => { if (confirm(`Remove all ${data.stops.length} stops of this route?`)) { ins = null; edit({order: []}); } }; bar.append(cl);
    }
    box.append(bar);

    const vis = plan ? shown() : null, items = vis ? [] : data.stops.map((st, i) => ({st, i})), rows = el('div', 'stops'), total = vis ? vis.length : items.length;
    if (total) rows.append(el('div', 'seqcap start', '▶ START — the route begins here'));
    // while stops are being picked: every stop of the plan, saved or not, can be dragged or removed
    const planRow = (e, n) => {
      const r = el('div', 'strow stopr' + (e.saved ? '' : ' pendr') + (n === 1 ? ' first' : '') + (n === total ? ' last' : '')); r.dataset.i = n - 1;
      const grip = el('span', 'grip', '⠿'); grip.title = 'Drag this handle to reorder'; grip.onpointerdown = ev => startDrag(ev, n - 1, r, rows, planMove);
      const m = /^(.*?)\s*\{([^}]*)\}$/.exec(e.k);
      r.append(grip, el('span', 'n', String(n)), el('span', 'lab', plainPl(m ? m[1] : e.k)));
      if (m) { const chips = el('span', 'pchips'); chips.append(el('span', 'pchip on', plainPl(m[2]))); r.append(chips); }
      if (!e.saved) r.append(el('span', 'c', e === inflight ? 'saving…' : 'queued'));
      const x = el('button', 'ra', '✕'); x.title = e.saved ? 'Remove this stop (written once the stops being added are in)' : 'Do not add this stop'; x.setAttribute('aria-label', x.title); x.onclick = () => planRemove(e);
      r.append(x); return r;
    };

    const realRow = (st, i, num) => {
      const nth = nthAt(i);                                                 // taken now: the list may be reloading by the time a button is pressed
      const r = el('div', 'strow stopr' + (num === 1 ? ' first' : '') + (num === total ? ' last' : '')); r.dataset.i = i;
      const grip = el('span', 'grip', '⠿'); grip.title = 'Drag this handle to reorder'; grip.setAttribute('aria-label', 'Drag to reorder');
      const lab = el('span', 'lab', st.label); lab.title = typeof stopName === 'function' ? stopName(st.key) : st.label; r.append(grip, el('span', 'n', String(num)), lab);
      if (st.platforms.length) {                                            // every platform this stop may use is shown the same: tick the ones the route uses (at least one)
        const sx = stations.find(x => x.name === st.name), on = new Set(pendingSet.get(i) || st.set || [st.key]), chips = el('span', 'pchips');
        chips.title = 'Platforms this stop uses: one service, all of them are shown when the line is hovered';
        const shown = st.platforms.filter(p => on.has(`${st.name} {${p}}`) || !sx || okHere(sx, p));
        for (const p of shown) {
          const k = `${st.name} {${p}}`, cb = el('input'); cb.type = 'checkbox'; cb.checked = on.has(k);
          cb.onchange = () => {
            const next = shown.map(q => `${st.name} {${q}}`).filter(q => q === k ? cb.checked : on.has(q));
            if (!next.length) { cb.checked = true; return; }
            pendingSet.set(i, next); render();                                // the chip shows the choice at once
            if (!queue.some(x => x.op && x.i === i)) queue.push({op: true, i});
            clearTimeout(retraceT); runQueue();
          };
          const lb = el('label', 'chk pchip' + (cb.checked ? ' on' : '')); lb.append(cb, ' ' + plainPl(p)); chips.append(lb);
        }
        r.append(chips);
      }
      const plus = el('button', 'ra', '+'); plus.title = 'Add stops after this one: click their platforms on the map'; plus.setAttribute('aria-label', 'Add stops after ' + st.label); plus.onclick = () => startPick({near: st.key, side: 'after', nth});
      const x = el('button', 'ra', '✕'); x.title = nth || data.stops.some((y, j) => j > i && y.key === st.key) ? 'Remove this visit (the route stops here again at another point)' : 'This route no longer stops here'; x.setAttribute('aria-label', 'Remove ' + st.label); x.onclick = () => edit({skip: st.key, nth});
      r.append(plus, x);
      grip.onpointerdown = e => startDrag(e, i, r, rows);              // only the handle drags: the platform list and buttons on the row keep working
      if (pick && ins && ins.near === st.key && (ins.nth || 0) === nth) r.classList.add('here');
      return r;
    };

    if (vis) vis.forEach((e, n) => rows.append(planRow(e, n + 1))); else items.forEach((x, n) => rows.append(realRow(x.st, x.i, n + 1)));
    if (total > 1) rows.append(el('div', 'seqcap end', `■ LAST STOP — then it runs back to ${vis ? label(vis[0].k) : items[0].st.label}`));
    box.append(rows);
    box.append(el('div', 'stmsg', msg));
  }
  document.addEventListener('routechange', load);
})();