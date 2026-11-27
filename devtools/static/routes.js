// Routes of the detailed map: create one (a new line, or another service pattern of a line), delete one
(() => {
  const form = $('#newform'), btn = $('#newroute'), del = $('#delroute'), ren = $('#renroute');
  let modes = [];
  const field = (name, input) => { const r = el('div', 'nf'); r.append(el('span', '', name), input); return r; };
  const list = (id, items) => { const d = el('datalist'); d.id = id; [...new Set(items)].sort().forEach(v => { const o = el('option'); o.value = v; d.append(o); }); return d; };
  const mapName = c => FUT(c) ? 'Future' : 'Present';
  // pre: {operator, line, mode, category, copyFrom: catalog entry} for another pattern of a line; none: the open route's twin on the other map
  async function open(pre) {
    if (!form.hidden && !pre) { form.hidden = true; return; }
    if (!modes.length) try { modes = await api('/api/modes'); } catch (e) {}
    form.innerHTML = '';
    const op = el('input'), line = el('input'), pat = el('input'), cat = el('select'), mode = el('select'), from = el('select'), msg = el('div', 'msg');
    op.setAttribute('list', 'nfops'); line.setAttribute('list', 'nflines'); op.placeholder = 'Operator'; line.placeholder = 'Line'; pat.placeholder = 'Pattern';
    [['Present', 'Present'], ['Fantasy', 'Future'], ['Both', 'Both']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; cat.append(o); });
    modes.forEach(m => { const o = el('option', '', m); o.value = m; mode.append(o); });
    if (pre) { op.value = pre.operator; line.value = pre.line; mode.value = pre.mode || mode.value; }
    else if (S.sel) { op.value = S.sel.operator; line.value = S.sel.line; pat.value = S.sel.pattern; mode.value = S.sel.mode || mode.value; }
    cat.value = S.mapName === 'future' ? 'Fantasy' : 'Both';          // from the Future view a new route is Future only; from the Present view it runs on both maps
    // Start with: no stops, or the stops of any pattern of this line (either map)
    const fill = () => {
      const keep = from.value; from.innerHTML = '';
      const none = el('option', '', 'No stops'); none.value = ''; from.append(none);
      S.catalog.filter(c => c.operator === op.value.trim() && c.line === line.value.trim()).forEach(c => {
        const o = el('option', '', `Stops of ${c.pattern}` + (c.category !== cat.value ? ` (${mapName(c.category)})` : '')); o.value = key(c); from.append(o);
      });

      from.value = [...from.options].some(o => o.value === keep) ? keep : '';
      from.closest('.nf').hidden = from.options.length < 2;
    };

    const go = el('button', 'primary', 'Create'), no = el('button', '', 'Cancel');
    no.onclick = () => { form.hidden = true; };
    go.onclick = async () => {
      const body = {operator: op.value.trim(), line: line.value.trim(), pattern: pat.value.trim(), mode: mode.value};
      const src = S.catalog.find(c => key(c) === from.value), cats = cat.value === 'Both' ? ['Present', 'Fantasy'] : [cat.value];
      if (src) body.copy_from = {pattern: src.pattern, category: src.category};
      go.disabled = true; msg.textContent = src ? 'Creating and tracing…' : '';
      for (const [i, c] of cats.entries()) {                                     // Both: the Future version is made beside the Present one and shares its stops
        try { await api('/api/route_def', {method: 'POST', body: {...body, category: c}, timeout: 600000}); }
        catch (e) { msg.textContent = (i ? 'The Present version was made, but not the Future one: ' : '') + e.message; go.disabled = false; if (i) await loadCatalog(); return; }
      }

      form.hidden = true; await loadCatalog();
      const mine = S.catalog.filter(c => c.operator === body.operator && c.line === body.line && c.pattern === body.pattern && cats.includes(c.category));
      const p = mine.find(c => c.category === CAT[S.mapName]) || mine[0];
      if (p) { S.openOps.add(S.groupBy === 'mode' ? p.mode || 'Other' : p.operator); renderTree(); selectPattern(p); }
    };

    pat.onkeydown = e => { if (e.key === 'Enter') go.click(); else if (e.key === 'Escape') no.click(); };
    const br = el('div', 'nf'); br.append(go, no);
    form.append(list('nfops', S.catalog.map(c => c.operator)), list('nflines', S.catalog.filter(c => !op.value || c.operator === op.value).map(c => c.line)),
      field('Operator', op), field('Line', line), field('Pattern', pat), field('Map', cat), field('Mode', mode), field('Start with', from), br, msg);
    [op, line, cat].forEach(x => x.addEventListener('change', fill)); fill();
    if (pre && pre.copyFrom) from.value = key(pre.copyFrom);
    form.hidden = false; (pre ? pat : op).focus(); form.scrollIntoView({block: 'nearest'});
  }

  btn.onclick = () => open();
  // Another service pattern of a line: from the line's + in the route list, or the open route's panel
  window.newPattern = (operator, line, from) => {
    const pats = S.catalog.filter(c => c.operator === operator && c.line === line), here = CAT[S.mapName];
    const src = from || pats.find(c => c.category === here) || pats[0];
    open({operator, line, mode: src && src.mode, category: here, copyFrom: src});
  };

  del.onclick = async () => {
    const p = S.sel; if (!p || !confirm(`Delete ${p.operator} — ${p.line} — ${p.pattern} (${FUT(p.category) ? 'Future' : 'Present'}) and its waypoints?`)) return;
    S.dirty = false;
    try { await api('/api/route_def?' + new URLSearchParams({operator: p.operator, line: p.line, pattern: p.pattern, category: p.category}), {method: 'DELETE'}); } catch (e) { alert(e.message); return; }
    deselect(); await loadCatalog();
  };

  // Rename the open pattern; its twin on the other map keeps the same name
  ren.onclick = async () => {
    const p = S.sel; if (!p) return;
    const name = (prompt(`New name for ${p.operator} — ${p.line} — ${p.pattern} (on both maps)`, p.pattern) || '').trim();
    if (!name || name === p.pattern || (S.dirty && !confirm('Discard unsaved changes?'))) return;
    try { await api('/api/route_def', {method: 'PATCH', body: {operator: p.operator, line: p.line, pattern: p.pattern, new_name: name}}); } catch (e) { alert(e.message); return; }
    S.dirty = false; deselect(); await loadCatalog();
    const n = S.catalog.find(c => c.operator === p.operator && c.line === p.line && c.pattern === name && c.category === p.category);
    if (n) selectPattern(n);
  };

  document.addEventListener('routechange', () => { del.hidden = ren.hidden = !S.sel; });
})();