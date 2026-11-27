'use strict';
// Page frame: which panels show for the tool in use, the side panels' show / hide buttons, and the OSM report pop-over
(() => {
  const body = document.body, GROUP = {trace: 'trace', stations: 'stations', dests: 'dests'};
  document.addEventListener('toolchange', e => { body.dataset.tool = GROUP[e.detail] || 'draw'; });
  document.addEventListener('routechange', () => body.classList.toggle('has-route', !!S.sel));
  // The side panels: hidden ones stay hidden next time
  const side = (id, btn) => {
    const k = 'tracerHide_' + id, set = hide => {
      body.classList.toggle('hide-' + id, hide); $(btn).classList.toggle('on', !hide); $(btn).setAttribute('aria-pressed', String(!hide));
      lsSet(k, hide);
    };

    set(!!lsGet(k, false)); $(btn).onclick = () => set(!body.classList.contains('hide-' + id));
  };

  side('left', '#tglleft'); side('right', '#tglright');
  new ResizeObserver(() => map.invalidateSize({pan: false})).observe(map.getContainer());          // the map fills whatever room the panels leave
  // The OSM report: opens under its button, closes on a click elsewhere or Esc
  const pop = $('#maint'), pb = $('#maintbtn');
  const show = on => { pop.hidden = !on; pb.classList.toggle('on', on); pb.setAttribute('aria-expanded', String(on)); };
  pb.onclick = e => { e.stopPropagation(); show(pop.hidden); };
  document.addEventListener('click', e => { if (!pop.hidden && !e.target.closest('#maintwrap')) show(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  // Menus: a [data-menu] button opens the menu after it; picking an item or clicking anywhere else closes it
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-menu]'), m = b && b.nextElementSibling;
    document.querySelectorAll('.menu:not([hidden])').forEach(x => { if (x !== m) x.hidden = true; });
    if (m) m.hidden = !m.hidden;
  });

  // Folded sections remember whether they were open
  document.querySelectorAll('#right details[id]').forEach(d => {
    d.open = !!lsGet('tracerOpen_' + d.id, false);
    d.addEventListener('toggle', () => lsSet('tracerOpen_' + d.id, d.open));
  });

  // The station search's results drop down under it; a click elsewhere closes them
  document.addEventListener('click', e => { if (!e.target.closest('#searchwrap')) $('#stresults').hidden = true; });
  $('#stsearch').addEventListener('focus', () => { if ($('#stsearch').value.trim()) $('#stsearch').dispatchEvent(new Event('input')); });
})();