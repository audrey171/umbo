// Idle animation turns the cube in model space. The same camera basis that
// projects the ink projects this model, even midway through an idle turn.
const cubeMonitor = (() => {
  const edges = [];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const group = document.getElementById('cube-edges');
  const panel = document.getElementById('space-panel');
  let angle = .58,
    previousTime = null,
    frame = 0;
  const corners = Array.from({
    length: 8
  }, (_, index) => [1, 2, 4].map(bit => index & bit ? 1 : -1));
  for (let i = 0; i < corners.length; i++) {
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      group.appendChild(line);
      edges.push({
        a: i,
        b: i | bit,
        line
      });
    }
  }
  function paint(time) {
    frame = 0;
    const idle = !space.orbit && !reducedMotion.matches;
    if (idle && previousTime !== null) angle += Math.min(time - previousTime, 64) * .00029;
    previousTime = idle ? time : null;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const tilt = -.32,
      ct = Math.cos(tilt),
      st = Math.sin(tilt);
    const camera = viewAxes();
    const points = corners.map(([x, y, z]) => {
      const depth = s * x + c * z;
      const world = [c * x - s * z, ct * y + st * depth, -st * y + ct * depth];
      return [dot3(camera.right, world) * 20, dot3(camera.down, world) * 20, dot3(camera.front, world)];
    });
    for (const {
      a,
      b,
      line
    } of edges) {
      const [x1, y1, z1] = points[a],
        [x2, y2, z2] = points[b];
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('opacity', .70 + .18 * (z1 + z2) / 2);
    }
    if (idle) frame = requestAnimationFrame(paint);
  }
  function refresh() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = null;
    panel.classList.toggle('powered', space.enabled);
    if (!space.enabled) angle = .58;
    if (space.enabled && !document.hidden && !document.getElementById('panel').inert) frame = requestAnimationFrame(paint);
  }
  document.addEventListener('visibilitychange', refresh);
  reducedMotion.addEventListener('change', refresh);
  return {
    refresh
  };
})();
