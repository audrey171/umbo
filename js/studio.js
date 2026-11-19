const $ = id => document.getElementById(id);
const canvas = $('drawing');
const screen = canvas.getContext('2d');
const settings = {
  mode: 'spiral',
  material: 'cartoon',
  color: $('primary').value,
  secondary: null,
  thickness: .5,
  taper: .5,
  irregularity: 0,
  density: 0,
  assist: .35,
  curl: 0
};
const step = 2;
let scenePhoto = null;
let strokes = [],
  sculpts = [],
  undoStack = [],
  redoStack = [],
  active = null;
let width = 1,
  height = 1,
  ratio = 1,
  base,
  group,
  frame = 0;
function playEffect(name, volume = .5, offset = 0) {
  const clip = $(name);
  clip.volume = volume;
  clip.currentTime = offset;
  clip.play().catch(() => {});
}
const penSound = (() => {
  const clip = $('pen-loop');
  let idle = 0,
    fade = 0,
    moving = false;
  function stop() {
    clearTimeout(idle);
    if (!moving) return;
    moving = false;
    const start = performance.now(),
      volume = clip.volume;
    function release() {
      const t = Math.min(1, (performance.now() - start) / 80);
      clip.volume = volume * (1 - t);
      if (t < 1) fade = requestAnimationFrame(release);else clip.pause();
    }
    release();
  }
  function move() {
    if (!moving) {
      moving = true;
      cancelAnimationFrame(fade);
      clip.volume = .22;
      clip.play().catch(() => {
        moving = false;
      });
    }
    clearTimeout(idle);
    idle = setTimeout(stop, 110);
  }
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
      cancelAnimationFrame(fade);
      clip.pause();
    }
  });
  return {
    move,
    stop
  };
})();
let nextNotch = 0,
  lastTick = -Infinity;
function tickNotch() {
  const now = performance.now();
  if (now - lastTick < 65) return;
  lastTick = now;
  const first = nextNotch++ % 2 === 0;
  playEffect(first ? 'slider-notch-01' : 'slider-notch-02', .33, first ? .083 : 0);
}
const sceneScale = 1;
const mirrorAxes = {
  lr: false,
  tb: false
};
for (const axis of ['lr', 'tb']) {
  const button = $('mirror-' + axis);
  button.onclick = () => {
    mirrorAxes[axis] = !mirrorAxes[axis];
    button.setAttribute('aria-pressed', String(mirrorAxes[axis]));
    $('paper').classList.toggle('mirror-' + axis, mirrorAxes[axis]);
  };
}
// Reflect the drawing plane at pointer-down. The copies then rotate with the shell.
function mirrorPlanes(plane) {
  const basis = plane || paperPlane,
    result = [];
  function reflected(x, y) {
    return {
      origin: worldPoint(basis, x < 0 ? width : 0, y < 0 ? height : 0),
      right: basis.right.map(n => n * x),
      down: basis.down.map(n => n * y),
      front: basis.front
    };
  }
  if (mirrorAxes.lr) result.push(reflected(-1, 1));
  if (mirrorAxes.tb) result.push(reflected(1, -1));
  if (mirrorAxes.lr && mirrorAxes.tb) result.push(reflected(-1, -1));
  return result;
}
function drawPlanes(g, stroke, draw) {
  for (const p of strokePlanes(stroke)) {
    g.save();
    g.transform(p.right[0], p.right[1], p.down[0], p.down[1], p.origin[0], p.origin[1]);
    draw();
    g.restore();
  }
}
function layer() {
  const surface = document.createElement('canvas');
  surface.width = canvas.width;
  surface.height = canvas.height;
  const g = surface.getContext('2d');
  g.scale(ratio, ratio);
  return g;
}
function blit(target, source) {
  target.drawImage(source.canvas, 0, 0, width, height);
}
function groupFor(color, secondary, makeLayer = layer) {
  return {
    color,
    secondary,
    outline: makeLayer(),
    paper: makeLayer(),
    stipple: makeLayer()
  };
}
// Composite the silhouette underneath the combined fill and grain.
function composite(g, ink, cap) {
  if (!ink) return;
  blit(g, ink.outline);
  blit(g, ink.paper);
  blit(g, ink.stipple);
  if (cap) cap();
  ink.junctions?.draw(g,width,height);
}
function disk(g, point, radius, color) {
  g.fillStyle = color;
  g.beginPath();
  g.arc(point.x, point.y, radius, 0, 2 * Math.PI);
  g.fill();
}
function ribbon(g, a, b, edge, color) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.hypot(dx, dy);
  if (length < .001) return;
  const nx = -dy / length,
    ny = dx / length,
    ra = a.r + edge,
    rb = b.r + edge;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(a.x + nx * ra, a.y + ny * ra);
  g.lineTo(b.x + nx * rb, b.y + ny * rb);
  g.lineTo(b.x - nx * rb, b.y - ny * rb);
  g.lineTo(a.x - nx * ra, a.y - ny * ra);
  g.closePath();
  g.fill();
  disk(g, b, rb, color);
}
function random(seed) {
  let n = seed | 0;
  return () => {
    n = Math.imul(1664525, n) + 1013904223 | 0;
    return (n >>> 0) / 4294967296;
  };
}
// Reserve the upper part of the dial for dots that run together into ink.
function inkLoad(density) {
  return density * (.85 + 4.15 * density);
}
// Shade the exposed dome with the same ink distribution as the ribbon at its seam.
function cartoonCap(g, stroke, tip, start = false) {
  if (start && stroke.joinedCartoon) return;
  if (!stroke.density || stroke.material !== 'cartoon') return;
  const r = tip.r,
    load = inkLoad(stroke.density),
    grain = .68 + .88 * stroke.density;
  const dx = Math.cos(tip.angle),
    dy = Math.sin(tip.angle),
    rng = random(stroke.seed + 73013);
  g.save();
  g.beginPath();
  if (start) g.arc(tip.x, tip.y, r, 0, 2 * Math.PI);else g.arc(tip.x, tip.y, r, tip.angle - Math.PI / 2, tip.angle + Math.PI / 2);
  g.closePath();
  g.clip();
  g.fillStyle = stroke.color;
  for (let i = 0; i < Math.ceil(r * r * (start ? 4 : 2) * 1.65); i++) {
    const u = 2 * rng() - 1,
      v = start ? 2 * rng() - 1 : rng(),
      rr = u * u + v * v;
    if (rr > 1) continue;
    const nx = -dy * u + dx * v,
      ny = dx * u + dy * v;
    const tone = Math.max(0, .48 + .22 * stroke.density - .68 * Math.sqrt(1 - rr) + .54 * (.60 * nx + .8 * ny));
    const seam = stroke.mode === 'spire' ? Math.exp(-Math.pow(Math.sin((tip.phase + u * .13) * Math.PI) * 5, 2)) * .48 * stroke.assist : 0;
    const chance = (.009 + .20 * rr ** 3 + tone * .56 + seam) * load;
    if (rng() >= chance) continue;
    const size = (.34 + rng() * .71) * grain;
    g.fillRect(tip.x + nx * r - size / 2, tip.y + ny * r - size / 2, size, size);
  }
  g.restore();
}
function finishCartoon(ink, stroke) {
  if (stroke.points.length > 1) cartoonCap(ink.stipple, stroke, stroke.points.at(-1));
}
function layInk(ink, stroke, a, b, seed) {
  if (stroke.material === 'basic') {
    ribbon(ink.paper, a, b, 0, stroke.color);
    return;
  }
  if (stroke.material === 'metal' || stroke.material === 'plastic') {
    paintFinish(ink.paper, stroke, a, b, seed);
    return;
  }
  if (ink.trackJunctions) (ink.junctions ||= new InkJunctions(ink)).add(stroke, a, b);
  ribbon(ink.outline, a, b, .78, stroke.color);
  ribbon(ink.paper, a, b, 0, stroke.secondary || '#fff');
  const dx = b.x - a.x,
    dy = b.y - a.y,
    distance = Math.hypot(dx, dy);
  if (distance < .001) return;
  const nx = -dy / distance,
    ny = dx / distance;
  if (!stroke.density) return;
  const load = inkLoad(stroke.density),
    grain = .68 + .88 * stroke.density;
  const rng = random(seed),
    count = Math.ceil(distance * (a.r + b.r) * 1.65);
  const g = ink.stipple;
  g.fillStyle = stroke.color;
  for (let i = 0; i < count; i++) {
    const t = rng(),
      across = 2 * rng() - 1,
      radius = a.r + (b.r - a.r) * t;
    const relief = Math.sqrt(1 - across * across);
    const darkSide = across * (-.60 * nx - .8 * ny);
    const tone = Math.max(0, .48 + .22 * stroke.density - .68 * relief - .54 * darkSide);
    const phase = a.phase + (b.phase - a.phase) * t + across * .13;
    const seam = stroke.mode === 'spire' ? Math.exp(-Math.pow(Math.sin(phase * Math.PI) * 5, 2)) * .48 * stroke.assist : 0;
    const probability = (.009 + .20 * across ** 6 + tone * .56 + seam) * load;
    const threshold = rng(),
      size = (.34 + rng() * .71) * grain;
    const grainBlend = stroke.joinedCartoon && a.d < stroke.joinRadius ? smoothBand(a.d + t * (b.d - a.d), 0, stroke.joinRadius) : 1;
    if (threshold >= probability * grainBlend) continue;
    const dotSize = Math.min(size, 2 * radius * (1 - Math.abs(across)));
    g.fillRect(a.x + t * dx + nx * across * radius - dotSize / 2, a.y + t * dy + ny * across * radius - dotSize / 2, dotSize, dotSize);
  }
}
function widthScale(stroke) {
  return 4 ** (2 * (stroke.thickness ?? .5) - 1);
}
// Distance-based variation stays attached to the mark during replay and rotation.
function edgeVariation(stroke, distance) {
  if (!stroke.irregularity) return 0;
  const phase = stroke.seed % 997 / 997 * Math.PI * 2;
  return stroke.irregularity * (.65 * Math.sin(distance * .19 + phase) + .35 * Math.sin(distance * .53 - phase)) * Math.min(distance / 12, 1);
}
// Vary the entrance of a free stroke. Attached strokes inherit the contact width.
function taperedRadius(stroke, distance) {
  const taper = stroke.taper ?? .5;
  const body = 6.3 + 12 * stroke.assist;
  const run = distance / (1 + 3 * Math.max(0, taper - .5));
  const growth = 1 - Math.exp(-Math.max(0, run - 5) / 85);
  const tip = distance === 0 ? .58 : 1;
  const profile = tip * (1 - Math.max(0, taper - .5) * (1 - growth)) +
    (2.3 + growth * (3 + 12 * stroke.assist)) * Math.min(1, run / 22);
  const amount = Math.min(1, taper * 2);
  return (1 - amount) * body + amount * profile;
}
function makeStroke(options, p) {
  let startRadius = options.material === 'basic' ? 2.25 : .58;
  if (options.material === 'cartoon' && options.mode === 'spiral') {
    startRadius = taperedRadius(options, 0);
  }
  const point = {
    ...p,
    d: 0,
    r: startRadius * widthScale(options),
    phase: 0,
    turn: 0,
    angle: 0
  };
  return {
    ...options,
    seed: Math.random() * 2147483647 | 0,
    points: [point]
  };
}
function inheritWidth(stroke, radius) {
  stroke.inheritedWidth = true;
  stroke.joinRadius = radius;
  stroke.points[0].r = radius;
}
function attachBrush(stroke, parent, ring) {
  inheritWidth(stroke, parent.points[ring].r);
  stroke.joinedCartoon = stroke.material === 'cartoon' && stroke.color === parent.color && stroke.secondary === parent.secondary;
}
function flatContact(stroke, marks) {
  const p = stroke.points[0];
  for (let i = marks.length - 1; i >= 0; i--) {
    const s = marks[i];
    for (const plane of strokePlanes(s)) {
      const d = [p.x - plane.origin[0], p.y - plane.origin[1], 0];
      const x = dot3(d, plane.right),
        y = dot3(d, plane.down);
      let nearest = null,
        best = Infinity;
      for (const q of s.points) {
        const distance = (x - q.x) ** 2 + (y - q.y) ** 2;
        if (distance < best && distance <= q.r * q.r) {
          best = distance;
          nearest = q;
        }
      }
      if (nearest) {
        if (s.material === stroke.material) attachBrush(stroke, s, s.points.indexOf(nearest));
        return;
      }
    }
  }
}
function nextPoint(stroke, p) {
  const points = stroke.points,
    last = points[points.length - 1];
  const dx = p.x - last.x,
    dy = p.y - last.y,
    delta = Math.hypot(dx, dy);
  const d = last.d + delta,
    angle = Math.atan2(dy, dx);
  const turn = points.length < 2 ? 0 : Math.atan2(Math.sin(angle - last.angle), Math.cos(angle - last.angle));
  const bend = last.turn * .85 + turn * .15;
  const growth = 1 - Math.exp(-Math.max(0, d - 5) / 85);
  const a = stroke.assist,
    phase = last.phase + delta / (10 + growth * 22);
  const pressure = p.pressure ?? .5;
  let r = 1 + (2.3 + growth * (3 + 12 * a)) * Math.min(1, d / 22);
  // The lip thickens on the inside of a bend.
  if (stroke.material === 'cartoon' && stroke.mode === 'spiral') r = taperedRadius(stroke, d);
  if (stroke.material === 'basic') r = 2.25;else if (stroke.mode === 'spiral') r *= 1 + Math.min(.5, Math.abs(bend) * 4) * a;else if (stroke.mode === 'spire') r *= 1 + growth * a * .32 * Math.sin(phase * 2 * Math.PI);else if (stroke.mode === 'cone') r = (1 + Math.min(26, d * .092)) * (1 + .1 * a * Math.sin(phase * 2 * Math.PI));else r = 1 + Math.min(1, d / 12) * 3.5;
  if (stroke.inheritedWidth) {
    const startPressure = points[0].pressure ?? .5;
    const radius = stroke.joinRadius * (.65 + .7 * pressure) / (.65 + .7 * startPressure);
    return {
      ...p,
      d,
      phase,
      angle,
      turn: bend,
      r: radius * (1 + .55 * edgeVariation(stroke, d))
    };
  }
  if (stroke.joinRadius) r = Math.max(r, stroke.joinRadius / widthScale(stroke) * Math.exp(-d / 24));
  return {
    ...p,
    d,
    phase,
    angle,
    turn: bend,
    r: r * (.65 + .7 * pressure) * widthScale(stroke) * (1 + .55 * edgeVariation(stroke, d))
  };
}
function startMark(ink, stroke) {
  const first = stroke.points[0];
  if (stroke.material === 'basic') disk(ink.paper, first, first.r, stroke.color);else if (stroke.material === 'metal' || stroke.material === 'plastic') {
    ink.paper.drawImage(materialCap(finishFor(stroke), stroke.density), first.x - first.r, first.y - first.r, 2 * first.r, 2 * first.r);
  } else {
    disk(ink.outline, first, first.r + .78, stroke.color);
    disk(ink.paper, first, first.r, stroke.secondary || '#fff');
    cartoonCap(ink.stipple, stroke, first, true);
  }
}
// Use the same transform and draw order for incremental marks and history replay.
function replaySceneStroke(ink, stroke, complete = true, local = false) {
  const draw = action => inDrawingPlanes(ink,stroke,action,local);
  draw(() => startMark(ink,stroke));
  for (let i=1;i<stroke.points.length;i++) {
    draw(() => layInk(ink,stroke,stroke.points[i-1],stroke.points[i],stroke.seed+i*92821));
  }
  if (complete) draw(() => finishCartoon(ink,stroke));
}
function replay(ink, stroke, complete = true) {
  startMark(ink,stroke);
  const points = stroke.points;
  for (let i = 1; i < points.length; i++) layInk(ink, stroke, points[i - 1], points[i], stroke.seed + i * 92821);
  if (complete) finishCartoon(ink, stroke);
}
function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function ribPoint(points, t) {
  const d = t * points.at(-1).d;
  let low = 0,
    high = points.length - 1;
  while (low < high) {
    const mid = low + high >> 1;
    if (points[mid].d < d) low = mid + 1;else high = mid;
  }
  const b = points[low],
    a = points[Math.max(0, low - 1)];
  const w = (d - a.d) / (b.d - a.d || 1);
  return {
    x: a.x + (b.x - a.x) * w,
    y: a.y + (b.y - a.y) * w
  };
}
function drawFanRib(g, rib) {
  const {
    points,
    previous,
    assist,
    density,
    hinge
  } = rib;
  const tip = points.at(-1);
  g.save();
  g.strokeStyle = rib.color;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (!previous || points.length < 2) {
    g.beginPath();
    g.moveTo(hinge.x, hinge.y);
    for (const p of points) g.lineTo(p.x, p.y);
    g.lineWidth = widthScale(rib);
    g.stroke();
    disk(g, hinge, widthScale(rib), rib.color);
    g.restore();
    return;
  }
  const other = previous.at(-1),
    span = distanceBetween(other, tip);
  const midX = (other.x + tip.x) / 2 - hinge.x,
    midY = (other.y + tip.y) / 2 - hinge.y;
  const axis = Math.hypot(midX, midY) || 1;
  const crown = Math.min(span * .29, Math.min(rib.reach, distanceBetween(hinge, other)) * .27) * (1 + .45 * rib.curl);
  function surface(a, b, t, u) {
    const lift = crown * 4 * u * (1 - u) * t ** 3;
    return {
      x: a.x + u * (b.x - a.x) + midX / axis * lift,
      y: a.y + u * (b.y - a.y) + midY / axis * lift
    };
  }
  g.beginPath();
  g.moveTo(hinge.x, hinge.y);
  for (const p of previous) g.lineTo(p.x, p.y);
  g.quadraticCurveTo(hinge.x + midX + 2 * crown * midX / axis, hinge.y + midY + 2 * crown * midY / axis, tip.x, tip.y);
  for (let i = points.length - 2; i >= 0; i--) g.lineTo(points[i].x, points[i].y);
  g.closePath();
  g.fillStyle = rib.secondary || '#fff';
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = rib.color;
  const rows = Math.min(260, Math.max(2, Math.ceil(Math.max(other.d, tip.d) / 2)));
  const load = inkLoad(density),
    grain = .68 + .88 * density;
  let a0 = hinge,
    b0 = hinge;
  for (let row = 1; row <= rows; row++) {
    const t = row / rows,
      a = ribPoint(previous, t),
      b = ribPoint(points, t);
    const acrossX = b.x - a.x,
      acrossY = b.y - a.y;
    const dx = (a.x + b.x - a0.x - b0.x) / 2,
      dy = (a.y + b.y - a0.y - b0.y) / 2;
    const area = Math.abs(dx * acrossY - dy * acrossX);
    const count = Math.min(1800, Math.ceil(area * .85));
    const rng = random(rib.seed + row * 6389);
    for (let i = 0; i < count; i++) {
      const along = rng(),
        u = rng(),
        v = (row - 1 + along) / rows;
      const seam = Math.exp(-u * (8 + assist * 8) / (1 + .8 * density)) * (.09 + .77 * assist);
      const rim = Math.exp((v - 1) * 45) * .32;
      const threshold = rng(),
        size = (.4 + rng() * .8) * grain;
      if (threshold >= (.008 + seam + rim + .09 * u ** 6) * load) continue;
      const p = surface({
        x: a0.x + (a.x - a0.x) * along,
        y: a0.y + (a.y - a0.y) * along
      }, {
        x: b0.x + (b.x - b0.x) * along,
        y: b0.y + (b.y - b0.y) * along
      }, v, u);
      g.fillRect(p.x, p.y, size, size);
    }
    a0 = a;
    b0 = b;
  }
  g.restore();
  g.beginPath();
  g.moveTo(other.x, other.y);
  g.quadraticCurveTo(hinge.x + midX + 2 * crown * midX / axis, hinge.y + midY + 2 * crown * midY / axis, tip.x, tip.y);
  for (let i = points.length - 2; i >= 0; i--) g.lineTo(points[i].x, points[i].y);
  g.lineWidth = .85 * widthScale(rib);
  g.stroke();
  // A pale crease at low Ridge gradually becomes an inked valley.
  g.beginPath();
  g.moveTo(hinge.x, hinge.y);
  for (const p of previous) g.lineTo(p.x, p.y);
  g.strokeStyle = rib.secondary || '#fff';
  g.lineWidth = 1.8 * widthScale(rib);
  g.stroke();
  g.globalAlpha = .09 + .87 * assist;
  g.strokeStyle = rib.color;
  g.lineWidth = (.6 + assist) * widthScale(rib);
  g.stroke();
  g.restore();
}
function sameInk(a, b) {
  return a.material === b.material && a.color === b.color && (a.secondary || '#ffffff') === (b.secondary || '#ffffff');
}
function selectInk(color, secondary, material) {
  if (group && sameInk(group, {color, secondary, material})) return;
  composite(base, group);
  group = groupFor(color, secondary);
  group.material = material;
  group.trackJunctions = true;
}
let frontNeedsReplay = false;
function inDrawingPlanes(ink, stroke, draw, local = false) {
  if (local || (!stroke.mirrors?.length && !stroke.plane)) {
    draw();
    return;
  }
  for (const p of strokePlanes(stroke)) withInkTransform(ink, p, draw);
}
function withInkTransform(ink, p, draw) {
  const layers = [ink.outline, ink.paper, ink.stipple];
  for (const g of layers) {
    g.save();
    g.transform(p.right[0], p.right[1], p.down[0], p.down[1], p.origin[0], p.origin[1]);
  }
  ink.plane = p;
  draw();
  ink.plane = null;
  for (const g of layers) g.restore();
}
function rebuild(items = strokes, transparent = false) {
  frontNeedsReplay = false;
  base = layer();
  group = null;
  if (!transparent) {
    base.fillStyle = '#fff';
    base.fillRect(0, 0, width, height);
    if (scenePhoto) base.drawImage(scenePhoto.image, scenePhoto.x, scenePhoto.y, scenePhoto.w, scenePhoto.h);
  }
  for (const stroke of items) {
    if (stroke.mode === 'fan') {
      composite(base, group);
      group = null;
      drawPlanes(base, stroke, () => drawFanRib(base, stroke));
    } else {
      selectInk(stroke.color, stroke.secondary, stroke.material);
      replaySceneStroke(group, stroke);
    }
  }
  requestPaint();
}
function paint(immediate = false) {
  frame = 0;
  const rotated = space.enabled && !frontView() || strokes.some(s => s.plane && Math.abs(s.plane.front[2] - 1) > 1e-8);
  prepareWelds(strokes);
  const joinView = welds.joined;
  if (joinView && initSpatial()) space.pivot ||= scenePivot(strokes, width, height);
  if (space.gl && (joinView || rotated || sculpts.length || space.grab?.moved)) {
    renderSpace(strokes, false, null, null, space, immediate === true);
    space.surface.hidden = false;
    return;
  }
  if (frontNeedsReplay) rebuild();
  space.surface.hidden = true;
  screen.setTransform(ratio, 0, 0, ratio, 0, 0);
  blit(screen, base);
  composite(screen, group, () => {
    if (active?.stroke.points.length > 1) drawPlanes(screen, active.stroke, () => cartoonCap(screen, active.stroke, active.stroke.points.at(-1)));
  });
  if (active?.over) blit(screen, active.over);
}
function requestPaint() {
  if (!frame) frame = requestAnimationFrame(paint);
}
function remember() {
  redoStack = [];
  undoStack.push({
    strokes: strokes.slice(),
    scenePhoto,
    sculpts
  });
  if (undoStack.length > 35) undoStack.shift();
}
function refresh() {
  $('add-photo').textContent = scenePhoto ? 'Replace photo' : 'Add photo to scene';
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}
function pointer(e, rect) {
  return {
    x: (e.clientX - rect.left) / sceneScale,
    y: (e.clientY - rect.top) / sceneScale,
    pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : .5
  };
}
// Close tiny gaps at the mirror seam only at the beginning or end of a metal stroke.
function snapMirrorTip(stroke, p) {
  if (!isPolished(stroke)) return;
  for (const [axis, enabled, center] of [['x', mirrorAxes.lr, width / 2], ['y', mirrorAxes.tb, height / 2]]) {
    if (enabled && Math.abs(p[axis] - center) <= 7) p[axis] = center;
  }
}
// Assisted ink can curl far from the physical pointer. Remember both places.
const lastLift = {
  scene: null,
  preview: null
};
function endpointAt(marks, p, scene = false) {
  let best = null,
    score = Infinity;
  const axes = scene ? viewAxes() : paperPlane;
  const lift = lastLift[scene ? 'scene' : 'preview'];
  if (lift && marks[lift.index] === lift.source && lift.source.material === settings.material && lift.source.density === settings.density && lift.source.color === settings.color && lift.source.secondary === settings.secondary && (!scene || lift.yaw === space.yaw && lift.pitch === space.pitch && lift.edits === sculpts) && Math.hypot(p.x - lift.x, p.y - lift.y) <= 7) {
    return {
      source: lift.source,
      index: lift.index,
      plane: lift.plane,
      axes
    };
  }
  let hit;
  for (let i = marks.length - 1; i >= 0; i--) {
    const s = marks[i],
      tip = s.points.at(-1);
    if (s.material !== settings.material || s.density !== settings.density || s.color !== settings.color || s.secondary !== settings.secondary || s.mode === 'fan') continue;
    for (const [index, plane] of strokePlanes(s).entries()) {
      let center = [tip.x, tip.y, tip.z || 0];
      if (scene && sculpts.some(edit => edit.stroke === s && edit.index === index)) {
        let centers = s.points.map(q => [q.x, q.y, q.z || 0]);
        for (const edit of sculpts) if (edit.stroke === s && edit.index === index) centers = pushSpine(s, centers, plane, edit);
        center = centers.at(-1);
      }
      const world = worldPoint(plane, ...center);
      const screenPoint = scene && space.pivot ? projectPoint(world) : world;
      const dx = p.x - screenPoint[0],
        dy = p.y - screenPoint[1];
      // Include the shoulder just behind the round cap as well as its visible rim.
      const back = s.points.findLast(q => tip.d - q.d >= tip.r * .8) || s.points[0];
      const localBack = [center[0] + back.x - tip.x, center[1] + back.y - tip.y, center[2] + (back.z || 0) - (tip.z || 0)];
      const backWorld = worldPoint(plane, ...localBack),
        backView = scene && space.pivot ? projectPoint(backWorld) : backWorld;
      const bx = backView[0] - screenPoint[0],
        by = backView[1] - screenPoint[1];
      const u = Math.max(0, Math.min(1, (dx * bx + dy * by) / (bx * bx + by * by || 1)));
      const near = Math.hypot(dx - u * bx, dy - u * by) / (tip.r + 6);
      if (near > 1 || near >= score) continue;
      if (scene && space.gl) {
        if (hit === undefined) hit = pickRing(p) || null;
        if (hit && (hit.stroke !== s || hit.index !== index || tip.d - s.points[hit.ring].d > tip.r * 2 + 8)) continue;
      }
      best = {
        source: s,
        index: i,
        plane,
        axes
      };
      score = near;
    }
  }
  return best;
}
function resumeGesture(end, p, id) {
  const stroke = {
    ...end.source,
    points: end.source.points.slice()
  };
  return {
    id,
    stroke,
    raw: p,
    target: p,
    tail: null,
    heading: 0,
    side: 0,
    startAngle: null,
    ...stroke.curlState,
    end
  };
}
function saveHeading(gesture) {
  const {
    heading,
    side,
    startAngle
  } = gesture;
  gesture.stroke.curlState = {
    heading,
    side,
    startAngle
  };
  const scene = gesture === active,
    marks = scene ? strokes : previewMarks;
  lastLift[scene ? 'scene' : 'preview'] = {
    source: gesture.stroke,
    index: marks.indexOf(gesture.stroke),
    plane: gesture.end?.plane || strokePlanes(gesture.stroke)[0],
    x: gesture.raw.x,
    y: gesture.raw.y,
    yaw: space.yaw,
    pitch: space.pitch,
    edits: sculpts
  };
}
function startContinuation(end, p, id) {
  const prefix = strokes.slice(0, end.index),
    suffix = strokes.slice(end.index + 1);
  const gesture = resumeGesture(end, p, id);
  gesture.support = captureSurface([...prefix, ...suffix]);
  strokes = [...prefix, gesture.stroke, ...suffix];
  sculpts = sculpts.map(edit => edit.stroke === end.source ? {
    ...edit,
    stroke: gesture.stroke
  } : edit);
  active = gesture;
  // Same-ink strokes beside the resumed one share its fill, including later branches.
  while (suffix.length && sameInk(suffix[0], gesture.stroke)) prefix.push(suffix.shift());
  if (suffix.length) {
    rebuild(suffix, true);
    composite(base, group);
    gesture.over = base;
  }
  // Replay the old spine without its terminal dome. Keep earlier folds and grain.
  rebuild(prefix);
  selectInk(gesture.stroke.color, gesture.stroke.secondary, gesture.stroke.material);
  replaySceneStroke(group, gesture.stroke, false, !frontView());
}
function append(stroke, p) {
  const previous = stroke.points.at(-1),
    next = nextPoint(stroke, p);
  if (active.end) {
    next.z = p.z ?? previous.z ?? 0;
    if (active.support) {
      const {
        plane,
        axes
      } = active.end;
      const [x, y, z] = projectPoint(worldPoint(plane, next.x, next.y, next.z));
      const depth = surfaceAt(active.support, {
        x,
        y,
        r: next.r
      });
      if (depth !== null) {
        const dz = depth - .24 * next.r - z;
        next.x += dz * dot3(plane.right, axes.front);
        next.y += dz * dot3(plane.down, axes.front);
        next.z += dz * dot3(plane.front, axes.front);
      }
    }
  } else placeOnSurface(stroke, next, stroke.points.length);
  stroke.points.push(next);
  inDrawingPlanes(group, stroke, () => layInk(group, stroke, previous, next, stroke.seed + (stroke.points.length - 1) * 92821), !frontView());
}
// Rotate each new hand movement by a distance-based heading. Raw pointer
// positions and ink positions stay separate once the stroke starts to curl.
function curledPoint(target, commit, gesture) {
  const {
    stroke,
    raw,
    heading
  } = gesture;
  const tip = stroke.points.at(-1);
  let dx = target.x - raw.x,
    dy = target.y - raw.y,
    z = tip.z;
  if (gesture.end) {
    const {
      axes,
      plane
    } = gesture.end;
    const v = axes.right.map((n, i) => n * dx + axes.down[i] * dy);
    dx = dot3(v, plane.right);
    dy = dot3(v, plane.down);
    z = (tip.z || 0) + dot3(v, plane.front);
    if (!stroke.curl || stroke.mode === 'free') return {
      x: tip.x + dx,
      y: tip.y + dy,
      z,
      pressure: target.pressure
    };
  } else if (!stroke.curl || stroke.mode === 'free') return target;
  const distance = Math.hypot(dx, dy);
  if (!distance) return {
    ...tip,
    pressure: target.pressure
  };
  const angle = Math.atan2(dy, dx);
  let side = gesture.side;
  if (!side && gesture.startAngle !== null) {
    const turn = Math.sin(angle - gesture.startAngle);
    if (Math.abs(turn) > .19) side = Math.sign(turn);
  }
  if (!side && tip.d >= 16) side = 1;
  const along = tip.d + distance / 2;
  const leadIn = Math.min(1, Math.max(0, (along - 8) / 24));
  const turn = side * leadIn * Math.pow(stroke.curl, 1.35) * distance / (16 + along * .058);
  const mid = heading + turn / 2;
  if (commit) {
    gesture.startAngle ??= angle;
    gesture.side = side;
    gesture.heading += turn;
  }
  return {
    x: tip.x + dx * Math.cos(mid) - dy * Math.sin(mid),
    y: tip.y + dx * Math.sin(mid) + dy * Math.cos(mid),
    z,
    pressure: target.pressure
  };
}
function moveTo(target, force, gesture = active, addPoint = append) {
  const last = gesture.raw;
  const dx = target.x - last.x,
    dy = target.y - last.y,
    distance = Math.hypot(dx, dy);
  if (!force && distance >= step) penSound.move();
  function add(sample) {
    addPoint(gesture.stroke, curledPoint(sample, true, gesture));
    gesture.raw = sample;
  }
  for (let d = step; d <= distance; d += step) {
    const t = d / distance;
    add({
      x: last.x + dx * t,
      y: last.y + dy * t,
      pressure: last.pressure + (target.pressure - last.pressure) * t
    });
  }
  if (force && Math.hypot(target.x - gesture.raw.x, target.y - gesture.raw.y) > .05) add(target);
  gesture.target = target;
  gesture.tail = curledPoint(target, false, gesture);
}
canvas.onpointerdown = e => {
  if ($('ink-picker').matches(':popover-open')) {
    $('ink-picker').hidePopover();
    return;
  }
  if (active || space.orbit || space.grab || e.button !== 0) return;
  if (space.enabled && space.tool === 'hand' && !e.altKey) {
    const hit = pickRing(pointer(e, canvas.getBoundingClientRect()));
    if (!hit) return;
    space.grab = {
      ...hit,
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      axes: viewAxes(),
      influence: settings.influence,
      delta: [0, 0, 0],
      moved: false
    };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (space.enabled && (space.tool === 'rotate' || e.altKey)) {
    space.pivot = orbitPivot();
    space.orbit = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY
    };
    cubeMonitor.refresh();
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  showDrawingControls();
  remember();
  const p = pointer(e, canvas.getBoundingClientRect());
  const end = endpointAt(strokes, p, true);
  if (end) {
    startContinuation(end, p, e.pointerId);
    canvas.setPointerCapture(e.pointerId);
    refresh();
    requestPaint();
    return;
  }
  const support = captureSurface();
  const plane = space.enabled ? drawingPlane() : null;
  if (space.enabled && !frontView()) frontNeedsReplay = true;
  const mirrors = mirrorPlanes(plane);
  if (space.enabled && !frontView()) {
    composite(base, group);
    group = null;
  }
  snapMirrorTip(settings, p);
  const stroke = makeStroke({
    ...settings,
    plane,
    mirrors
  }, p);
  let joinDepth = null;
  if (support) {
    const contact = {};
    const z = surfaceAt(support, stroke.points[0], contact);
    if (z !== null) {
      const hit = pickRing(contact);
      if (hit?.stroke.material === stroke.material) {
        attachBrush(stroke, hit.stroke, hit.ring);
        if (isPolished(stroke)) {
          const part = welds.parts.get(hit.stroke)[hit.index];
          const center = worldPoint(part.plane, ...part.centers[hit.ring]);
          const q = projectPoint(center);
          joinDepth = q[2] + (plane ? 0 : space.pivot[2]);
          if (hit.ring === hit.stroke.points.length - 1 && Math.hypot(q[0] - p.x, q[1] - p.y) <= Math.max(2, stroke.joinRadius * .85)) {
            stroke.continues = hit.stroke;
            stroke.points[0].x = q[0];
            stroke.points[0].y = q[1];
          }
        }
      }
    }
  } else flatContact(stroke, strokes);
  strokes.push(stroke);
  selectInk(stroke.color, stroke.secondary, stroke.material);
  active = {
    stroke,
    support,
    joinDepth,
    lastContact: null,
    id: e.pointerId,
    raw: p,
    target: p,
    tail: null,
    heading: 0,
    side: 0,
    startAngle: null
  };
  placeOnSurface(stroke, stroke.points[0], 0);
  inDrawingPlanes(group, stroke, () => replay(group, stroke, false), !frontView());
  canvas.setPointerCapture(e.pointerId);
  refresh();
  requestPaint();
};
function moveHand(e) {
  const grab = space.grab,
    dx = e.clientX - grab.x,
    dy = e.clientY - grab.y;
  grab.moved = Math.hypot(dx, dy) >= 1;
  grab.delta = grab.axes.right.map((v, i) => (v * dx + grab.axes.down[i] * dy) / sceneScale);
  requestPaint();
}
canvas.onpointermove = e => {
  if (space.grab?.id === e.pointerId) {
    moveHand(e);
    return;
  }
  if (space.orbit?.id === e.pointerId) {
    space.yaw -= (e.clientX - space.orbit.x) * .009;
    space.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, space.pitch + (e.clientY - space.orbit.y) * .009));
    space.orbit.x = e.clientX;
    space.orbit.y = e.clientY;
    cubeMonitor.refresh();
    requestPaint();
    return;
  }
  if (!active || e.pointerId !== active.id) return;
  const rect = canvas.getBoundingClientRect(),
    samples = e.getCoalescedEvents?.() || [];
  for (const sample of samples) moveTo(pointer(sample, rect), false);
  moveTo(pointer(e, rect), false);
  requestPaint();
};
function finish(e) {
  if (space.grab?.id === e.pointerId) {
    if (e.type === 'pointerup') {
      moveHand(e);
      const {
        moved,
        stroke,
        index,
        ring,
        delta,
        influence
      } = space.grab;
      if (moved && influence > 0) {
        remember();
        sculpts = [...sculpts, {
          stroke,
          index,
          ring,
          delta,
          influence
        }];
        refresh();
      }
    }
    space.grab = null;
    requestPaint();
    return;
  }
  if (space.orbit?.id === e.pointerId) {
    space.orbit = null;
    cubeMonitor.refresh();
    return;
  }
  if (!active || e.pointerId !== active.id) return;
  if (e.type === 'pointerup') {
    moveTo(pointer(e, canvas.getBoundingClientRect()), true);
    const stroke = active.stroke,
      last = stroke.points.at(-1),
      end = {
        ...last
      };
    snapMirrorTip(stroke, end);
    if (distanceBetween(last, end) > .05) append(stroke, end);
  } else if (active.tail) moveTo(active.target, true);
  penSound.stop();
  saveHeading(active);
  if (active.end) {
    active = null;
    rebuild();
    return;
  }
  inDrawingPlanes(group, active.stroke, () => finishCartoon(group, active.stroke), !frontView());
  active = null;
  requestPaint();
}
canvas.onpointerup = finish;
canvas.onpointercancel = finish;
canvas.onlostpointercapture = finish;
let previewFrame = 0,
  previewGesture = null;
const previewMarks = [],
  swatch = $('preview'),
  resetSwatch = $('reset-preview');
function previewPoint(e) {
  const r = swatch.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * swatch.width / r.width,
    y: (e.clientY - r.top) * swatch.height / r.height,
    pressure: e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : .5
  };
}
let previewSheet = null,
  previewInk = null,
  previewLight = -1;
const previewSpace = {
  surface: document.createElement('canvas'),
  pivot: [0, 0, 0],
  meshes: new Map(),
  welds: weldState()
};
function flattenPreview(g, layers, live) {
  for (const layer of [layers.outline, layers.paper, layers.stipple]) g.drawImage(layer.canvas, 0, 0);
  if (live) finishCartoon({stipple:g},live);
  layers.junctions?.draw(g,g.canvas.width,g.canvas.height);
}
function refreshPreviewPaper() {
  if (previewLight === studioLight.version && previewSheet) return;
  previewLight = studioLight.version;
  previewSheet = previewLayer();
  previewInk = null;
  const live = previewGesture?.stroke;
  const marks = live ? [...previewMarks.filter(s => s !== live), live] : previewMarks;
  for (const stroke of marks) {
    if (!previewInk || !sameInk(previewInk, stroke)) {
      if (previewInk) flattenPreview(previewSheet, previewInk);
      previewInk = groupFor(stroke.color, stroke.secondary, previewLayer);
      previewInk.material = stroke.material;
      previewInk.trackJunctions = true;
    }
    replay(previewInk, stroke, stroke !== previewGesture?.stroke);
  }
}
function extendPreview(stroke, p) {
  const a = stroke.points.at(-1),
    b = nextPoint(stroke, p);
  stroke.points.push(b);
  layInk(previewInk, stroke, a, b, stroke.seed + (stroke.points.length - 1) * 92821);
}
swatch.onpointerdown = e => {
  if (e.button !== 0 || previewGesture) return;
  const p = previewPoint(e),
    end = endpointAt(previewMarks, p);
  if (end) {
    previewGesture = resumeGesture(end, p, e.pointerId);
    previewMarks[end.index] = previewGesture.stroke;
    previewSheet = null;
    refreshPreviewPaper();
    swatch.setPointerCapture(e.pointerId);
    schedulePreview();
    return;
  }
  const stroke = makeStroke(settings, p);
  flatContact(stroke, previewMarks);
  refreshPreviewPaper();
  previewMarks.push(stroke);
  if (!previewInk || !sameInk(previewInk, stroke)) {
    if (previewInk) flattenPreview(previewSheet, previewInk);
    previewInk = groupFor(stroke.color, stroke.secondary, previewLayer);
    previewInk.material = stroke.material;
    previewInk.trackJunctions = true;
  }
  replay(previewInk, stroke, false);
  previewGesture = {
    id: e.pointerId,
    stroke,
    raw: p,
    heading: 0,
    side: 0,
    startAngle: null
  };
  swatch.setPointerCapture(e.pointerId);
  resetSwatch.hidden = false;
  schedulePreview();
};
swatch.onpointermove = e => {
  if (e.pointerId !== previewGesture?.id) return;
  for (const sample of e.getCoalescedEvents?.() || []) moveTo(previewPoint(sample), false, previewGesture, extendPreview);
  moveTo(previewPoint(e), false, previewGesture, extendPreview);
  schedulePreview();
};
swatch.onpointerup = swatch.onpointercancel = swatch.onlostpointercapture = e => {
  if (e.pointerId !== previewGesture?.id) return;
  if (e.type === 'pointerup') moveTo(previewPoint(e), true, previewGesture, extendPreview);
  penSound.stop();
  saveHeading(previewGesture);
  finishCartoon(previewInk, previewGesture.stroke);
  if (previewGesture.end) previewSheet = null;
  previewGesture = null;
  schedulePreview();
};
resetSwatch.onclick = () => {
  previewMarks.length = 0;
  previewGesture = null;
  previewSheet = null;
  previewInk = null;
  resetSwatch.hidden = true;
  schedulePreview();
};
function previewLayer() {
  const c = document.createElement('canvas');
  c.width = swatch.width;
  c.height = swatch.height;
  return c.getContext('2d');
}
function schedulePreview() {
  if (previewFrame) return;
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0;
    const preview = $('preview'),
      g = preview.getContext('2d');
    prepareWelds(previewMarks, previewSpace.welds);
    if (previewSpace.welds.joined && initSpatial(previewSpace)) {
      renderSpace(previewMarks, false, null, null, previewSpace);
      g.drawImage(previewSpace.surface, 0, 0);
      return;
    }
    if (!previewMarks.length && previewSpace.meshes.size) renderSpace([], false, null, null, previewSpace);
    if (previewMarks.length) {
      g.clearRect(0, 0, preview.width, preview.height);
      refreshPreviewPaper();
      g.drawImage(previewSheet.canvas, 0, 0);
      if (previewInk) {
        flattenPreview(g, previewInk, previewGesture?.stroke);
      }
      return;
    }
    const point = t => {
      const angle = t * (1.1 + settings.curl * 2.1),
        r = 105 + 55 * t;
      return {
        x: 20 + r * Math.sin(angle),
        y: 40 + (1 - Math.cos(angle)) * 28 - 14 * Math.sin(t * Math.PI),
        pressure: .5
      };
    };
    const stroke = makeStroke(settings, point(0));
    stroke.seed = 64801;
    for (let i = 1; i <= 90; i++) stroke.points.push(nextPoint(stroke, point(i / 90)));
    const bounds = stroke.points.reduce((b, p) => [Math.min(b[0], p.x - p.r - 2), Math.min(b[1], p.y - p.r - 2), Math.max(b[2], p.x + p.r + 2), Math.max(b[3], p.y + p.r + 2)], [Infinity, Infinity, -Infinity, -Infinity]);
    const w = bounds[2] - bounds[0],
      h = bounds[3] - bounds[1],
      scale = Math.min(268 / w, 120 / h);
    const ink = groupFor(stroke.color, stroke.secondary, () => {
      const layer = document.createElement('canvas');
      layer.width = preview.width;
      layer.height = preview.height;
      const ctx = layer.getContext('2d');
      ctx.translate((layer.width - w * scale) / 2, (layer.height - h * scale) / 2);
      ctx.scale(scale, scale);
      ctx.translate(-bounds[0], -bounds[1]);
      return ctx;
    });
    replay(ink, stroke);
    g.clearRect(0, 0, preview.width, preview.height);
    for (const ctx of [ink.outline, ink.paper, ink.stipple]) g.drawImage(ctx.canvas, 0, 0);
  });
}
$('preview').parentElement.addEventListener('pointerenter', schedulePreview);
function resize() {
  width = $('paper').clientWidth;
  height = $('paper').clientHeight;
  ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  rebuild();
}
function undo() {
  if (active || space.grab || !undoStack.length) return;
  playEffect('plastic-key');
  redoStack.push({
    strokes: strokes.slice(),
    scenePhoto,
    sculpts
  });
  ({
    strokes,
    scenePhoto,
    sculpts
  } = undoStack.pop());
  refresh();
  rebuild();
}
function redo() {
  if (active || space.grab || !redoStack.length) return;
  playEffect('plastic-key');
  undoStack.push({
    strokes: strokes.slice(),
    scenePhoto,
    sculpts
  });
  ({
    strokes,
    scenePhoto,
    sculpts
  } = redoStack.pop());
  refresh();
  rebuild();
}
$('undo').onclick = undo;
$('redo').onclick = redo;
document.addEventListener('keydown', e => {
  if (!e.target.closest?.('#ink-picker') && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  }
});
$('new').onclick = () => {
  if (active || space.grab || (!strokes.length && !scenePhoto)) return;
  remember();
  strokes = [];
  scenePhoto = null;
  sculpts = [];
  refresh();
  rebuild();
};
const photoInput = $('photo-file');
let photoRequest = 0;
$('add-photo').onclick = () => photoInput.click();
photoInput.onchange = async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
  if (!file) return;
  const request = ++photoRequest;
  const url = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = url;
    await source.decode();
    if (request !== photoRequest || active || space.grab) return;
    const image = document.createElement('canvas');
    const scale = Math.min(1, 2048 / Math.max(source.naturalWidth, source.naturalHeight));
    image.width = Math.max(1, Math.round(source.naturalWidth * scale));
    image.height = Math.max(1, Math.round(source.naturalHeight * scale));
    image.getContext('2d').drawImage(source, 0, 0, image.width, image.height);
    const fit = Math.min(width * .68 / source.naturalWidth, height * .68 / source.naturalHeight);
    const w = source.naturalWidth * fit, h = source.naturalHeight * fit;
    remember();
    scenePhoto = {image, w, h, x: (width - w) / 2, y: (height - h) / 2};
    space.yaw = space.pitch = 0;
    space.pivot = scenePivot(strokes, width, height);
    updateSpaceUI();
    refresh();
    rebuild();
  } catch {
    if (request === photoRequest) {
      $('info-title').textContent = 'Photo import';
      $('info-text').textContent = 'This image could not be opened. Try a JPEG, PNG, or WebP copy.';
      $('info').showModal();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};
$('export').onclick = () => {
  paint(true);
  const a = document.createElement('a');
  a.download = 'umbo.ink-shell-sheet.png';
  a.href = (space.surface.hidden ? canvas : space.surface).toDataURL('image/png');
  a.click();
  playEffect('export-chime', .6);
};
const toggle = $('toggle'),
  panel = $('panel');
toggle.onclick = () => {
  const closed = $('drawer').classList.toggle('closed');
  if (closed && $('ink-picker').matches(':popover-open')) $('ink-picker').hidePopover();
  panel.inert = closed;
  cubeMonitor.refresh();
  toggle.setAttribute('aria-expanded', String(!closed));
  toggle.setAttribute('aria-label', closed ? 'Open drawer' : 'Collapse drawer');
};
for (const [id, key] of [['curl', 'curl'], ['assist', 'assist'], ['shade', 'density'], ['thickness', 'thickness'], ['irregularity', 'irregularity'], ['taper', 'taper'], ['influence', 'influence']]) {
  const input = $(id),
    knob = input.parentElement,
    initial = Number(input.value);
  const min = Number(input.min),
    max = Number(input.max);
  let notch = Math.round(initial / 5);
  function setDial(preview = true) {
    const value = Number(input.value);
    const next = Math.round(value / 5);
    if (preview && next !== notch) tickNotch();
    notch = next;
    settings[key] = value / 100;
    if (preview && key !== 'influence') schedulePreview();
    knob.style.setProperty('--angle', (value - initial) / (max - min) * 270 + 'deg');
    knob.dataset.value = value + '%';
    input.setAttribute('aria-valuetext', value + ' percent');
  }
  let drag = null;
  input.onpointerdown = e => {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    input.focus({
      preventScroll: true
    });
    input.setPointerCapture(e.pointerId);
    drag = {
      x: e.clientX,
      y: e.clientY,
      value: Number(input.value),
      id: e.pointerId
    };
  };
  input.onpointermove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x,
      dy = drag.y - e.clientY;
    input.value = Math.round(drag.value + (Math.abs(dx) > Math.abs(dy) ? dx : dy) * (max - min) / 120);
    setDial();
  };
  input.onlostpointercapture = () => {
    drag = null;
  };
  input.oninput = () => setDial();
  setDial(false);
}
function orbitPivot() {
  // At the original front angle a new pivot does not change the composition.
  if (space.yaw === 0 && space.pitch === 0) return scenePivot(strokes, width, height);
  return space.pivot;
}
function updateSpaceUI() {
  $('space-toggle').setAttribute('aria-pressed', String(space.enabled));
  cubeMonitor.refresh();
  if (!sculpts.length && (!space.enabled || frontView())) space.surface.hidden = true;
  for (const tool of ['draw', 'rotate', 'hand']) $('space-' + tool).setAttribute('aria-pressed', String(tool === (space.enabled ? space.tool : 'draw')));
  document.body.dataset.tool = space.enabled ? space.tool : 'draw';
}
function setSpaceMode(tool) {
  if (active || space.orbit || space.grab) return;
  const wasOn = space.enabled;
  if (tool && !space.enabled) {
    if (!initSpatial()) {
      $('info-title').textContent = '3D view';
      $('info-text').textContent = '3D drawing needs WebGL. Open the demo in a browser with hardware acceleration enabled.';
      $('info').showModal();
      return;
    }
    space.pivot = scenePivot(strokes, width, height);
    space.yaw = 0;
    space.pitch = 0;
  }
  if (!tool) {
    space.yaw = 0;
    space.pitch = 0;
  }
  space.enabled = tool !== null;
  if (tool) space.tool = tool;
  if (!wasOn && space.enabled) playEffect('terminal-power-on', .58);else if (wasOn && !space.enabled) {
    $('terminal-power-on').pause();
    playEffect('latching-switch');
  } else if (space.enabled) playEffect('plastic-key');
  updateSpaceUI();
  requestPaint();
}
$('space-toggle').onclick = () => setSpaceMode(space.enabled ? null : 'draw');
for (const tool of ['draw', 'rotate', 'hand']) $('space-' + tool).onclick = () => setSpaceMode(tool);
space.surface.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  space.enabled = false;
  space.orbit = null;
  space.grab = null;
  space.gl = null;
  space.photoLayer = null;
  space.meshes.clear();
  updateSpaceUI();
  rebuild();
});
new ResizeObserver(resize).observe($('paper'));
schedulePreview();
refresh();
document.addEventListener('click', e => {
  const button = e.target.closest('button');
  if (!button || button.disabled || button.hasAttribute('data-action')) return;
  if (button.matches('#toggle,#mirror-lr,#mirror-tb')) playEffect('latching-switch');else if (!button.matches('#export,#space-toggle,#space-draw,#space-rotate,#space-hand,#light-sphere,#undo,#redo')) playEffect('plastic-key');
});
