(() => {
  const popup = $('ink-picker'),
    hex = $('ink-hex');
  const field = $('ink-field'),
    hue = $('ink-hue'),
    sat = $('ink-saturation'),
    val = $('ink-value');
  const positions = {
    primary: {
      h: 0,
      s: 0,
      v: 1
    },
    secondary: {
      h: 0,
      s: 0,
      v: 1
    }
  };
  let target = null,
    pointer = null;
  function readColor(color) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
    const pos = positions[target.id];
    const max = Math.max(r, g, b),
      delta = max - Math.min(r, g, b);
    pos.v = max;
    if (max) pos.s = delta / max;
    if (delta) {
      const sector = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
      pos.h = (sector * 60 + 360) % 360;
    }
  }
  function selectedHex() {
    const {
      h,
      s,
      v
    } = positions[target.id];
    return '#' + [5, 3, 1].map(offset => {
      const k = (offset + h / 60) % 6;
      const channel = v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1)));
      return Math.round(channel * 255).toString(16).padStart(2, '0');
    }).join('');
  }
  function sync() {
    const color = target.id === 'primary' ? settings.color : settings.secondary;
    const displayed = color || '#ffffff';
    const {
      h,
      s,
      v
    } = positions[target.id];
    const preview = $('ink-preview');
    preview.style.setProperty('--ink', displayed);
    preview.classList.toggle('unset', !color);
    hex.value = displayed.toUpperCase();
    hue.value = Math.round(h);
    sat.value = Math.round(s * 100);
    val.value = Math.round(v * 100);
    field.style.setProperty('--hue', String(h));
    field.style.setProperty('--x', s * 100 + '%');
    field.style.setProperty('--y', (1 - v) * 100 + '%');
    field.style.setProperty('--selected', displayed);
    $('ink-none').hidden = target.id === 'primary';
  }
  function apply(color) {
    const secondary = target.id === 'secondary';
    settings[secondary ? 'secondary' : 'color'] = color;
    schedulePreview();
    target.value = color || '';
    target.style.setProperty('--ink', color || '#ffffff');
    target.classList.toggle('unset', !color);
    if (secondary) $('clear-secondary').hidden = !color;
    if (!color) readColor('#ffffff');
    sync();
  }
  function place() {
    if (!target || !popup.matches(':popover-open')) return;
    const rect = target.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8));
    const below = rect.bottom + 7,
      above = rect.top - popup.offsetHeight - 7;
    const y = below + popup.offsetHeight <= innerHeight - 8 ? below : Math.max(8, above);
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
  }
  function close() {
    popup.hidePopover();
    target.focus({
      preventScroll: true
    });
  }
  for (const id of ['primary', 'secondary']) {
    const trigger = $(id);
    trigger.onclick = e => {
      e.preventDefault();
      if (popup.matches(':popover-open') && trigger === target) {
        close();
        return;
      }
      target?.setAttribute('aria-expanded', 'false');
      target = trigger;
      $('ink-title').textContent = trigger.getAttribute('aria-label');
      if (!trigger.dataset.pickerReady) {
        readColor(trigger.value || '#ffffff');
        trigger.dataset.pickerReady = 'true';
      }
      sync();
      if (!popup.matches(':popover-open')) popup.showPopover();
      trigger.setAttribute('aria-expanded', 'true');
      place();
      sat.focus({
        preventScroll: true
      });
    };
  }
  popup.addEventListener('toggle', () => {
    const open = popup.matches(':popover-open');
    for (const id of ['primary', 'secondary']) $(id).setAttribute('aria-expanded', String(open && $(id) === target));
  });
  window.addEventListener('resize', place);
  $('panel').addEventListener('scroll', place);
  function pickPoint(e) {
    const rect = field.getBoundingClientRect(),
      pos = positions[target.id];
    const clamp = n => Math.max(0, Math.min(1, n));
    pos.s = clamp((e.clientX - rect.left - field.clientLeft) / field.clientWidth);
    pos.v = 1 - clamp((e.clientY - rect.top - field.clientTop) / field.clientHeight);
    apply(selectedHex());
  }
  field.onpointerdown = e => {
    if (e.button !== 0 || pointer !== null) return;
    e.preventDefault();
    pointer = e.pointerId;
    field.setPointerCapture(pointer);
    sat.focus({
      preventScroll: true
    });
    pickPoint(e);
  };
  field.onpointermove = e => {
    if (pointer === e.pointerId) pickPoint(e);
  };
  field.onpointerup = e => {
    if (pointer === e.pointerId) {
      pickPoint(e);
      pointer = null;
    }
  };
  field.onlostpointercapture = () => {
    pointer = null;
  };
  hue.oninput = () => {
    positions[target.id].h = Number(hue.value);
    apply(selectedHex());
  };
  sat.oninput = () => {
    positions[target.id].s = Number(sat.value) / 100;
    apply(selectedHex());
  };
  val.oninput = () => {
    positions[target.id].v = Number(val.value) / 100;
    apply(selectedHex());
  };
  function commitHex() {
    let digits = hex.value.trim().replace(/^#/, '').toLowerCase();
    if (/^[\da-f]{3}$/.test(digits)) digits = [...digits].map(c => c + c).join('');
    if (/^[\da-f]{6}$/.test(digits)) {
      readColor('#' + digits);
      apply('#' + digits);
    } else sync();
  }
  hex.onchange = commitHex;
  hex.onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitHex();
      hex.select();
    }
  };
  popup.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  $('ink-close').onclick = close;
  $('ink-none').onclick = () => {
    apply(null);
    close();
  };
  $('clear-secondary').onclick = () => {
    target = $('secondary');
    apply(null);
    target.focus({
      preventScroll: true
    });
  };
})();
