function showDrawingControls() {
  const card = $('quick-card');
  if (card.classList.contains('flipped')) return;
  $('card-front').inert = true;
  $('card-back').inert = false;
  card.classList.add('flipped');
}

(() => {
  const card = $('quick-card'), back = $('card-back');
  const actions = [...back.querySelectorAll('[data-action]')];
  function sync() {
    for (const button of actions) {
      const id = button.dataset.action;
      button.disabled = $(id).disabled;
      if (id.startsWith('space-')) {
        button.setAttribute('aria-pressed', String((document.body.dataset.tool || 'draw') === id.slice(6)));
      }
    }
  }
  for (const button of actions) button.onclick = () => $(button.dataset.action).click();
  const observer = new MutationObserver(sync);
  observer.observe(document.body, {attributes: true, attributeFilter: ['data-tool']});
  for (const id of ['undo','redo']) observer.observe($(id), {attributes: true, attributeFilter: ['disabled']});
  sync();

  function place(x, y) {
    const clamp = (v, max) => Math.max(0, Math.min(v, max));
    card.style.left = clamp(x, innerWidth - card.offsetWidth) + 'px';
    card.style.top = clamp(y, innerHeight - card.offsetHeight) + 'px';
    card.style.bottom = 'auto';
  }
  let drag = null;
  card.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.button !== 0) return;
    if (e.target.closest('#card-back button')) return;
    const rect = card.getBoundingClientRect();
    drag = {id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false};
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener('pointermove', e => {
    if (drag?.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx,dy) < 5) return;
    drag.moved = true;
    place(drag.left + dx, drag.top + dy);
  });
  card.addEventListener('lostpointercapture', e => {
    if (drag?.id === e.pointerId) drag = null;
  });
  card.addEventListener('dragstart', e => e.preventDefault());
  window.addEventListener('resize', () => {
    if (card.style.top) place(card.offsetLeft, card.offsetTop);
  });
})();
