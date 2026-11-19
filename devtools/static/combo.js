// ── Inputs and accessibility for the whole page: (1) a real dropdown for a text box, (2) quiet text boxes (no browser suggestions), (3) labels, keyboard use and live text ──
// ── (1) A real dropdown for a text box: suggestions in a panel of our own (not the browser's datalist), filtered locally so typing never waits
// on the server or flickers. Up / Down / Enter / Esc work; the panel follows the box and flips above it when there is no room below.
//   Combo(input, {load: () => Promise<items>, text: item => string, sub: item => string, badge: item => string, create: q => item | null,
//                 onCommit: (item | null, typedText) => void, empty: 'text shown when nothing matches'})
// A platform name without its hidden " [2]" tag (two platforms of one station may share a name when they are on different maps): what people see.
window.plainPl = window.plainPl || (n => String(n == null ? '' : n).replace(/\s*\[[^\]]*\]\s*$/, ''));
(() => {
  const panels = new Set();
  // A box can disappear (the form is closed or drawn again) or lose focus without any event reaching the box: sweep up its panel so it never stays open.
  const sweep = () => { for (const p of [...panels]) { if (!p.input.isConnected) { p.panel.remove(); panels.delete(p); } else if (!p.panel.hidden && document.activeElement !== p.input) p.close(); } };
  document.addEventListener('mousedown', e => { for (const p of panels) if (!p.panel.hidden && e.target !== p.input && !p.panel.contains(e.target)) p.close(); }, true);
  setInterval(sweep, 400);
  const norm = s => (s || '').toLowerCase();
  window.Combo = function (input, o) {
    for (const p of [...panels]) if (!p.input.isConnected) { p.panel.remove(); panels.delete(p); }          // a card that was drawn again leaves its panel behind
    const panel = document.createElement('div'); panel.className = 'combo-panel'; panel.setAttribute('role', 'listbox'); panel.hidden = true;
    panel.id = 'combo' + Math.random().toString(36).slice(2, 8); document.body.append(panel);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', panel.id); input.autocomplete = 'off';
    let items = [], shown = [], active = -1, drawnKey = '', committed = input.value, loading = null, openNow = false, dirty = false;          // dirty: the user has typed since the list opened (until then it shows everything, not just what the box already says)

    const place = () => {
      const r = input.getBoundingClientRect(), below = innerHeight - r.bottom, h = Math.min(panel.scrollHeight, 280), up = below < h + 12 && r.top > below;
      panel.style.left = Math.max(4, Math.min(r.left, innerWidth - 4 - Math.max(r.width, 260))) + 'px'; panel.style.minWidth = Math.max(r.width, 260) + 'px';
      panel.style.maxHeight = Math.max(120, Math.min(280, (up ? r.top : below) - 12)) + 'px';
      if (up) { panel.style.top = ''; panel.style.bottom = (innerHeight - r.top + 4) + 'px'; } else { panel.style.bottom = ''; panel.style.top = (r.bottom + 4) + 'px'; }
    };
    const filter = () => {
      const q = dirty ? norm(input.value.trim()) : '', hit = !q ? items.slice() : items.filter(x => norm(o.text(x)).includes(q) || norm(o.sub ? o.sub(x) : '').includes(q));
      if (q) hit.sort((a, b) => (norm(o.text(b)).startsWith(q) - norm(o.text(a)).startsWith(q)));            // stable: the rest keep their most-used-first order
      shown = hit.slice(0, 40);
      const typed = norm(input.value.trim()), c = dirty && typed && o.create && !items.some(x => norm(o.text(x)) === typed) ? o.create(input.value.trim()) : null;
      if (c) shown.push(c);
      active = shown.length && (q || active >= 0) ? Math.min(Math.max(active, 0), shown.length - 1) : -1;
      if (q && shown.length && !shown[0].__create) active = 0;
    };
    const mark = (el, text, q) => { const i = q ? norm(text).indexOf(q) : -1; if (i < 0) { el.textContent = text; return; } el.append(text.slice(0, i), Object.assign(document.createElement('mark'), {textContent: text.slice(i, i + q.length)}), text.slice(i + q.length)); };
    const draw = () => {
      const q = dirty ? norm(input.value.trim()) : '', key = q + '|' + shown.map(x => o.text(x) + (x.__create ? '+' : '')).join('\n');
      if (key !== drawnKey) {                                                                                // nothing changed: leave the DOM alone (no flicker)
        drawnKey = key; panel.innerHTML = '';
        if (!shown.length) { const e = document.createElement('div'); e.className = 'combo-empty'; e.textContent = loading ? 'Loading…' : (o.empty || 'Nothing matches'); panel.append(e); }
        shown.forEach((x, i) => {
          const row = document.createElement('div'); row.className = 'combo-row' + (x.__create ? ' create' : ''); row.setAttribute('role', 'option'); row.id = panel.id + '-' + i; row.dataset.i = i;
          const main = document.createElement('span'); main.className = 'combo-main';
          if (x.__create) main.textContent = o.createLabel ? o.createLabel(x) : `Use “${o.text(x)}”`; else mark(main, o.text(x), q);
          row.append(main);
          const sub = !x.__create && o.sub ? o.sub(x) : ''; if (sub) row.append(Object.assign(document.createElement('span'), {className: 'combo-sub', textContent: sub}));
          const bd = !x.__create && o.badge ? o.badge(x) : ''; if (bd) row.append(Object.assign(document.createElement('span'), {className: 'combo-badge', textContent: bd}));
          panel.append(row);
        });
      }
      [...panel.querySelectorAll('.combo-row')].forEach((r, i) => { const on = i === active; r.classList.toggle('on', on); r.setAttribute('aria-selected', on ? 'true' : 'false'); });
      if (active >= 0) { input.setAttribute('aria-activedescendant', panel.id + '-' + active); const r = panel.children[active]; if (r && r.scrollIntoView) r.scrollIntoView({block: 'nearest'}); } else input.removeAttribute('aria-activedescendant');
      place();
    };
    const open = async () => {
      openNow = true; dirty = false; panel.hidden = false; input.setAttribute('aria-expanded', 'true'); filter(); draw();
      if (!loading) { loading = Promise.resolve(o.load()).then(l => { items = l || []; }).catch(() => {}).finally(() => { loading = null; if (openNow) { filter(); draw(); } }); }
    };
    const close = () => { openNow = false; panel.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
    const commit = (item) => {
      const text = item ? (item.__create ? item.text : o.text(item)) : input.value.trim();
      if (item) input.value = item.__create ? item.text : o.text(item);
      close();
      if (item || text !== committed) { committed = item ? input.value : text; o.onCommit(item && !item.__create ? item : null, item && item.__create ? item.text : text); }
    };
    input.addEventListener('focus', open);
    input.addEventListener('click', () => { if (!openNow) open(); });
    input.addEventListener('input', () => { if (!openNow) open(); dirty = true; filter(); draw(); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input && openNow) { close(); if (input.value.trim() !== committed) commit(null); } }, 120));
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!openNow) { open(); return; } if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; draw(); } }
      else if (e.key === 'Enter') { e.preventDefault(); commit(openNow && active >= 0 ? shown[active] : null); }
      else if (e.key === 'Escape' && openNow) { e.preventDefault(); e.stopPropagation(); input.value = committed; close(); }
    });
    panel.addEventListener('mousedown', e => e.preventDefault());                                               // keep the focus in the box
    panel.addEventListener('mousemove', e => { const r = e.target.closest('.combo-row'); if (r && +r.dataset.i !== active) { active = +r.dataset.i; draw(); } });
    panel.addEventListener('click', e => { const r = e.target.closest('.combo-row'); if (r) commit(shown[+r.dataset.i]); });
    const follow = () => { if (openNow) place(); };
    addEventListener('resize', follow); document.addEventListener('scroll', follow, true);
    panels.add({input, panel, close});
    return {close, refresh() { items = []; loading = null; }, set(v) { input.value = v; committed = v; }};
  };
})();

// ── (2) + (3) Page polish: accessibility only (no behaviour changes). Labels for icon buttons, pressed state for the switches, live status text, and
// keyboard activation of the clickable rows. One observer, each change looks only at the nodes that were added or whose class changed. ──
(function () {
  const ROWS = '.pat, .op, .ln, .sres, .sttop, .stfold, .wprow, .stitem .sttop';
  const label = el => {
    if (el.tagName === 'BUTTON') {
      if (!el.getAttribute('aria-label') && el.title && !/[A-Za-z0-9]{3,}/.test(el.textContent)) el.setAttribute('aria-label', el.title);     // icon-only: ✕ ↻ ▾ …
      if (el.parentElement && el.parentElement.classList.contains('seg')) el.setAttribute('aria-pressed', el.classList.contains('on') ? 'true' : 'false');
    }
    if (el.matches && el.matches(ROWS) && !el.hasAttribute('tabindex')) { el.tabIndex = 0; el.setAttribute('role', 'button'); }
    if (el.classList && (el.classList.contains('stmsg') || el.id === 'dirhint' || el.id === 'zoomhint')) el.setAttribute('aria-live', 'polite');
  };
  const scan = root => { if (root.nodeType !== 1) return; label(root); root.querySelectorAll('button, ' + ROWS + ', .stmsg').forEach(label); };
  const roots = ['#left', '#right', '#mapbar', '#modebar', '#bpbar', '#hud', '#parhud'].map(s => document.querySelector(s)).filter(Boolean);
  roots.forEach(scan);
  const mo = new MutationObserver(ms => {
    for (const m of ms) {
      if (m.type === 'attributes') { if (m.target.tagName === 'BUTTON') label(m.target); }
      else m.addedNodes.forEach(scan);
    }
  });
  roots.forEach(r => mo.observe(r, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']}));
  document.addEventListener('keydown', e => {                                    // Enter / Space presses a focused row like a click
    if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.matches || !e.target.matches(ROWS) || e.target.closest('input, select, textarea')) return;
    e.preventDefault(); e.target.click();
  });
  // No browser suggestion boxes (autofill, history, <datalist>): every text box, now and when it is drawn later, answers only to the tracer's own dropdowns.
  const quiet = n => {
    if (n.nodeType !== 1) return;
    const all = n.matches('input, textarea') ? [n, ...n.querySelectorAll('input, textarea')] : [...n.querySelectorAll('input, textarea')];
    all.forEach(i => { i.setAttribute('autocomplete', 'off'); i.removeAttribute('list'); i.spellcheck = false; i.setAttribute('autocorrect', 'off'); i.setAttribute('autocapitalize', 'off'); });
    (n.tagName === 'DATALIST' ? [n] : [...n.querySelectorAll('datalist')]).forEach(d => d.remove());
    if (n.tagName === 'FORM') n.setAttribute('autocomplete', 'off'); n.querySelectorAll && n.querySelectorAll('form').forEach(f => f.setAttribute('autocomplete', 'off'));
  };
  quiet(document.body);
  new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(quiet))).observe(document.body, {childList: true, subtree: true});
  const live = document.getElementById('graphinfo'); if (live) live.setAttribute('role', 'status');
  const nav = document.getElementById('left'); if (nav) nav.setAttribute('aria-label', 'Routes and stations');
  const rt = document.getElementById('right'); if (rt) rt.setAttribute('aria-label', 'Editor');
  const mp = document.getElementById('map'); if (mp) mp.setAttribute('aria-label', 'Map');
})();