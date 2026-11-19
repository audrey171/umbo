// Re-ink only the tiles where two footprints meet. A shared distance field
// rounds the crotch and gives the stipple one surface normal across the join.
const joinTileSize = 32;
function inkRGB(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}
class InkJunctions {
  constructor(ink) {
    this.ink = ink;
    this.width = ink.paper.canvas.width;
    this.height = ink.paper.canvas.height;
    this.tiles = new Map();
    this.dirty = new Set();
    this.pen = inkRGB(ink.color);
    this.fill = inkRGB(ink.secondary || '#ffffff');
    this.surface = null;
  }
  add(stroke, a, b) {
    const m = this.ink.paper.getTransform();
    const scale = Math.hypot(m.a, m.b);
    const x = m.a * a.x + m.c * a.y + m.e, y = m.b * a.x + m.d * a.y + m.f;
    const dx = m.a * (b.x - a.x) + m.c * (b.y - a.y), dy = m.b * (b.x - a.x) + m.d * (b.y - a.y);
    const ra = a.r * scale, rb = b.r * scale;
    const pad = 2.6 * Math.max(ra, rb) + scale;
    const size = joinTileSize;
    const left = Math.max(0, Math.floor((Math.min(x, x + dx) - pad) / size));
    const top = Math.max(0, Math.floor((Math.min(y, y + dy) - pad) / size));
    const right = Math.floor(Math.min(this.width - 1, Math.max(x, x + dx) + pad) / size);
    const bottom = Math.floor(Math.min(this.height - 1, Math.max(y, y + dy) + pad) / size);
    const seg = { x, y, dx, dy, ra, rb, inv: 1 / (dx * dx + dy * dy || 1) };
    // Reflections are separate limbs even when they share a stroke object.
    const plane = this.ink.plane || paperPlane;
    for (let j = top; j <= bottom; j++) for (let i = left; i <= right; i++) {
      const key = j * Math.ceil(this.width / size) + i;
      let tile = this.tiles.get(key);
      if (!tile) this.tiles.set(key, tile = { x: i * size, y: j * size, branches: [] });
      let limb = tile.branches.find(l => l.stroke === stroke && l.plane === plane && a.d - l.end < 4 * Math.max(a.r, b.r) + size / scale);
      if (!limb) {
        limb = { stroke, plane, segments: [] };
        tile.branches.push(limb);
      }
      limb.end = b.d;
      limb.segments.push(seg);
      if (tile.branches.length > 1) this.dirty.add(tile);
    }
    this.scale = scale;
  }
  draw(g, width, height) {
    if (!this.surface) {
      if (!this.dirty.size) return;
      this.surface = document.createElement('canvas');
      this.surface.width = this.width;
      this.surface.height = this.height;
      this.ctx = this.surface.getContext('2d');
    }
    for (const tile of this.dirty) this.paintTile(tile);
    this.dirty.clear();
    g.drawImage(this.surface, 0, 0, width, height);
  }
  paintTile(tile) {
    const size = joinTileSize, n = size * size, scale = this.scale;
    const field = new Float32Array(n).fill(Infinity), second = new Float32Array(n).fill(Infinity);
    const radius = new Float32Array(n), density = new Float32Array(n);
    const closest = new Float32Array(n), localRadius = new Float32Array(n);
    for (const limb of tile.branches) {
      closest.fill(Infinity);
      for (const s of limb.segments) {
        const x0 = s.x - tile.x, y0 = s.y - tile.y;
        const pad = 2.6 * Math.max(s.ra, s.rb) + scale;
        const left = Math.max(0, Math.floor(Math.min(x0, x0 + s.dx) - pad)), right = Math.min(size - 1, Math.ceil(Math.max(x0, x0 + s.dx) + pad));
        const top = Math.max(0, Math.floor(Math.min(y0, y0 + s.dy) - pad)), bottom = Math.min(size - 1, Math.ceil(Math.max(y0, y0 + s.dy) + pad));
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
          const vx = x + .5 - x0, vy = y + .5 - y0;
          const t = Math.max(0, Math.min(1, (vx * s.dx + vy * s.dy) * s.inv));
          const r = s.ra + t * (s.rb - s.ra);
          const d = Math.sqrt((vx - t * s.dx) ** 2 + (vy - t * s.dy) ** 2) - r, i = y * size + x;
          if (d < closest[i]) { closest[i] = d; localRadius[i] = r; }
        }
      }
      for (let i = 0; i < n; i++) {
        const d = closest[i];
        if (!Number.isFinite(d)) continue;
        const old = field[i], r = localRadius[i];
        second[i] = Math.min(second[i], Math.max(old, d));
        if (!Number.isFinite(old)) { field[i] = d; radius[i] = r; density[i] = limb.stroke.density; continue; }
        const k = Math.max(1, .95 * Math.min(radius[i], r));
        const t = Math.max(0, Math.min(1, .5 + (old - d) / (2 * k)));
        field[i] = (1 - t) * old + t * d - k * t * (1 - t);
        radius[i] += t * (r - radius[i]);
        density[i] += t * (limb.stroke.density - density[i]);
      }
    }
    const out = this.ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, r = radius[i], d = field[i], edge = .78 * scale;
      if (d > edge + .5 || !Number.isFinite(second[i]) || !r) continue;
      // A moving contour must fully cover the original rim. Only the grain
      // crossfades, otherwise both the old corner and its fillet stay visible.
      const proximity = second[i] / r;
      const grainMask = 1 - smoothBand(proximity, 0, .62);
      const rimMask = smoothBand(d / r, -.55, -.32) * (1 - smoothBand(proximity, 1.1, 1.55));
      const weight = Math.max(grainMask, rimMask);
      if (weight <= 0) continue;
      // Look up the normal inside this tile. Use one-sided differences at its edges.
      const gx = x === 0 ? field[i + 1] - d : x === size - 1 ? d - field[i - 1] : (field[i + 1] - field[i - 1]) * .5;
      const gy = y === 0 ? field[i + size] - d : y === size - 1 ? d - field[i - size] : (field[i + size] - field[i - size]) * .5;
      const q = Math.max(0, Math.min(1, 1 + d / r)), nz = Math.sqrt(1 - q * q);
      const lit = Math.max(0, .48 + .22 * density[i] - .68 * nz + .54 * q * (.6 * gx + .8 * gy));
      const probability = Math.min(.96, (.004 + .2 * q ** 6 + lit * .56) * inkLoad(density[i]));
      const grain = junctionDot((tile.x + x + .5) / scale, (tile.y + y + .5) / scale, probability, density[i]);
      const line = Math.max(grain, Math.max(0, Math.min(1, d + .5)));
      const idx = 4 * i;
      for (let k = 0; k < 3; k++) out.data[idx + k] = this.fill[k] + line * (this.pen[k] - this.fill[k]);
      out.data[idx + 3] = 255 * weight * Math.min(1, Math.max(0, edge + .5 - d));
    }
    this.ctx.putImageData(out, tile.x, tile.y);
  }
}
// A fixed, jittered dot screen is shared by every limb. Adding branches cannot
// stack samples or shift dots on a frame redraw or an undo/redo.
function junctionDot(x, y, p, density) {
  const spacing = .85 + .35 * density;
  x /= spacing; y /= spacing;
  const ix = Math.floor(x), iy = Math.floor(y);
  let hash = Math.imul(ix + 37, 374761393) + Math.imul(iy + 13, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177) >>> 0;
  if (!p || (hash & 1023) / 1024 >= p) return 0;
  const dx = x - ix - .25 - ((hash >>> 10) & 255) / 512, dy = y - iy - .25 - ((hash >>> 18) & 255) / 512;
  return Math.max(0, Math.min(1, (.49 - Math.sqrt(dx * dx + dy * dy)) * 4));
}
