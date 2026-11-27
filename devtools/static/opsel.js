'use strict';
// ── The Operator box of the "+ Route" form becomes a real dropdown of the operators already in the detailed map (most lines first), with
// "Use “X” as a new operator" for one that is not there yet. It attaches itself whenever the form is drawn, so routes.js needs no change. ──
(function () {
  const form = document.getElementById('newform'); if (!form || !window.Combo) return;
  const ops = async () => {
    const cat = await api('/api/catalog'), m = new Map();
    for (const r of cat) { const o = m.get(r.operator) || {operator: r.operator, lines: new Set(), n: 0}; o.lines.add(r.line); o.n++; m.set(r.operator, o); }
    return [...m.values()].map(o => ({operator: o.operator, lines: o.lines.size, n: o.n})).sort((a, b) => b.lines - a.lines || a.operator.localeCompare(b.operator));
  };
  const fieldInput = name => {                                    // the input that sits next to the label that says `name`
    for (const e of form.querySelectorAll('label, span, div, b')) {
      if (e.children.length || e.textContent.trim().toLowerCase() !== name) continue;
      const row = e.closest('div, label') || e.parentElement, inp = (e.nextElementSibling && e.nextElementSibling.matches('input') && e.nextElementSibling) || (row && row.querySelector('input'));
      if (inp) return inp;
    }
    const byHint = form.querySelector(`input[placeholder="${name[0].toUpperCase() + name.slice(1)}" i], input[id*="${name}" i], input[name*="${name}" i]`);
    return byHint || null;
  };
  const rows = async () => await api('/api/catalog');
  const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
  const val = name => { const i = fieldInput(name); return i ? i.value : ''; };
  const lines = async () => {
    const m = new Map();
    for (const r of await rows()) if (same(r.operator, val('operator'))) { const o = m.get(r.line) || {name: r.line, n: 0}; o.n++; m.set(r.line, o); }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const patterns = async () => {
    const m = new Map();
    for (const r of await rows()) if (same(r.operator, val('operator')) && same(r.line, val('line'))) m.set(r.pattern, {name: r.pattern});
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  let busy = false;
  const field = (name, inp, cfg) => {
    inp.dataset.combo = '1'; inp.removeAttribute('list');
    const fire = () => { inp.dispatchEvent(new Event('input', {bubbles: true})); inp.dispatchEvent(new Event('change', {bubbles: true})); };
    Combo(inp, {...cfg, create: t => ({__create: true, text: t}), text: x => x.__create ? x.text : x[cfg.key], badge: () => '', onCommit: () => fire()});
  };
  const attach = () => {
    if (busy) return; busy = true;
    try {
      let inp = fieldInput('operator');
      if (inp && !inp.dataset.combo) field('operator', inp, {key: 'operator', load: ops, sub: x => `${x.lines} line${x.lines === 1 ? '' : 's'}`, createLabel: x => `Use “${x.text}” as a new operator`, empty: 'No operators yet: type a name'});
      inp = fieldInput('line');
      if (inp && !inp.dataset.combo) field('line', inp, {key: 'name', load: lines, sub: x => `${x.n} pattern${x.n === 1 ? '' : 's'}`, createLabel: x => `Use “${x.text}” as a new line`, empty: 'A new line: type its name'});
      inp = fieldInput('pattern');
      if (inp && !inp.dataset.combo) field('pattern', inp, {key: 'name', load: patterns, sub: () => '', createLabel: x => `Use “${x.text}” as a new pattern`, empty: 'A new pattern: type its name'});
    } finally { busy = false; }
  };
  new MutationObserver(attach).observe(form, {childList: true, subtree: true});
  attach();
})();