// The canvas and rotated mesh sample the same studio environment.
const studioLight = {
  x: -.39,
  y: -.59,
  z: .71,
  version: 0
};
const finishCache = new Map();
function finishFor(stroke) {
  const key = [stroke.material, stroke.color, stroke.secondary, stroke.density].join('/');
  if (finishCache.has(key)) return finishCache.get(key);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const surface = {
    pigment: rgb(stroke.color),
    accent: stroke.secondary ? rgb(stroke.secondary) : null,
    metal: stroke.material === 'metal',
    cap: null
  };
  if (finishCache.size >= 24) finishCache.delete(finishCache.keys().next().value);
  finishCache.set(key, surface);
  return surface;
}
function smoothBand(x, lo, hi) {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
function surfaceRGB(surface, x, y, z, density) {
  const {
      pigment,
      accent,
      metal
    } = surface,
    L = studioLight;
  const rx = 2 * z * x,
    ry = 2 * z * y,
    rz = 2 * z * z - 1;
  // Project the reflected ray onto a rectangular softbox oriented toward the shell.
  const facing = rx * L.x + ry * L.y + rz * L.z;
  const horizontal = Math.hypot(L.x, L.z) || 1;
  const u = (rx * L.z - rz * L.x) / horizontal;
  const v = ry * horizontal - L.y * (rx * L.x + rz * L.z) / horizontal;
  const span = Math.max(.01, facing);
  const panelX = Math.abs((.91 * u + .414 * v) / span);
  const panelY = Math.abs((.91 * v - .414 * u) / span);
  const blur = metal ? .035 + .030 * density : .105;
  const key = facing > 0 ? (1 - smoothBand(panelX, .50 - blur, .50 + blur)) * (1 - smoothBand(panelY, .16 - blur, .16 + blur)) : 0;
  const soft = facing > 0 ? Math.exp(-panelX * panelX * 1.8 - panelY * panelY * 8) : 0;
  // The floor, ceiling, black flag and side strip reflect at different angles.
  const horizon = ry + .13 * rx - .10 * rz;
  const floor = smoothBand(horizon, -.06, .08);
  const flag = (1 - smoothBand(Math.abs(rx + .52 * rz), .10, .22)) * smoothBand(-rz, -.5, .60);
  const side = (1 - smoothBand(Math.abs(rx - .78 * rz + .14), .045, .13)) * smoothBand(-ry, -.6, .10);
  const fresnel = (1 - z) ** 5;
  const diffuse = .21 + .60 * Math.max(0, x * L.x + y * L.y + z * L.z) + .22 * (.5 - .5 * y);
  const patina = metal ? density * (.5 + .5 * Math.sin(x * 8 + y * 3 + Math.sin(y * 9))) ** 3 : 0;
  const result = [];
  for (let i = 0; i < 3; i++) {
    // Work in linear light before converting the reflected radiance for the display.
    const sky = (.32 + .40 * Math.max(0, -horizon)) * [.91, .98, 1.08][i];
    const ground = (.019 + .27 * smoothBand(horizon, .05, .96)) * [1.10, 1.01, .90][i];
    const room = (sky * (1 - floor) + ground * floor) * (1 - .91 * flag);
    const reflection = room + (metal ? .90 : 3.2) * side + 1.6 * soft + (metal ? 3.8 : 19) * key;
    const tint = pigment[i] + (accent ? (accent[i] - pigment[i]) * (metal ? .12 : .20) * (1 - z) : 0);
    const reflectance = metal ? .78 + .18 * tint : .047 + .93 * fresnel;
    const linear = metal ? reflection * reflectance * (1 - patina * [.04, .08, .16][i]) : tint ** 2.2 * diffuse * (1 - reflectance) + reflectance * reflection;
    // Gently roll off only the top of the highlight; keep deep chrome reflections.
    const tone = linear < .72 ? linear : .72 + .28 * (1 - Math.exp(-Math.max(0, linear - .72) / .28));
    result.push(Math.round(255 * Math.max(0, tone) ** (1 / 2.2)));
  }
  return result;
}
function materialCap(surface, density) {
  if (surface.cap && surface.capVersion === studioLight.version) return surface.cap;
  const cap = document.createElement('canvas'),
    size = 192;
  cap.width = cap.height = size;
  const ctx = cap.getContext('2d'),
    pixels = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x + .5) * 2 / size - 1,
      ny = (y + .5) * 2 / size - 1,
      r = Math.hypot(nx, ny);
    if (r > 1) continue;
    const i = (y * size + x) * 4,
      color = surfaceRGB(surface, nx, ny, Math.sqrt(1 - r * r), density);
    for (let k = 0; k < 3; k++) pixels.data[i + k] = color[k];
    pixels.data[i + 3] = Math.min(255, (1 - r) * size * 255);
  }
  ctx.putImageData(pixels, 0, 0);
  surface.pixels = pixels.data;
  surface.cap = cap;
  surface.capVersion = studioLight.version;
  return cap;
}
function paintFinish(g, stroke, a, b, seed) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    length = Math.hypot(dx, dy);
  if (!length) return;
  const nx = -dy / length,
    ny = dx / length,
    surface = finishFor(stroke);
  const gradient = g.createLinearGradient(b.x - nx * b.r, b.y - ny * b.r, b.x + nx * b.r, b.y + ny * b.r);
  const cap = materialCap(surface, stroke.density),
    size = cap.width;
  const steps = Math.min(144, Math.max(32, Math.ceil(3 * b.r)));
  for (let i = 0; i <= steps; i++) {
    const u = (2 * i / steps - 1) * .985;
    const px = Math.round((.5 + nx * u * .5) * (size - 1)),
      py = Math.round((.5 + ny * u * .5) * (size - 1));
    const at = (py * size + px) * 4,
      p = surface.pixels;
    gradient.addColorStop(i / steps, 'rgb(' + p[at] + ',' + p[at + 1] + ',' + p[at + 2] + ')');
  }
  // Paint only the swept band. A full disk here overwrites the previous bend
  // with the newest tangent and leaves a hard seam across the highlight.
  g.fillStyle = gradient;
  g.beginPath();
  g.moveTo(a.x + nx * a.r, a.y + ny * a.r);
  g.lineTo(b.x + nx * b.r, b.y + ny * b.r);
  g.lineTo(b.x - nx * b.r, b.y - ny * b.r);
  g.lineTo(a.x - nx * a.r, a.y - ny * a.r);
  g.closePath();
  g.fill();
  // Only the forward half is domed. The continuous body keeps a longitudinal highlight.
  g.save();
  g.beginPath();
  g.arc(b.x, b.y, b.r, b.angle - Math.PI / 2, b.angle + Math.PI / 2);
  g.closePath();
  g.clip();
  g.drawImage(materialCap(surface, stroke.density), b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  g.restore();
  if (surface.metal) {
    const rng = random(seed);
    if (rng() < .12 * stroke.density) {
      const u = (rng() - .5) * 1.6,
        x = b.x + nx * u * b.r,
        y = b.y + ny * u * b.r;
      g.strokeStyle = 'rgba(87,72,49,.28)';
      g.lineWidth = .36;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - dx * .85 + nx * .35, y - dy * .85 + ny * .35);
      g.stroke();
    }
  }
}
