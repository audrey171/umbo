// Find contacting sweeps in world space, including reflected and sculpted copies.
function weldState() {
  return {
    items: [],
    edits: null,
    drag: null,
    parts: new Map(),
    version: 0,
    joined: false
  };
}
const welds = weldState();
const weldCell = 32;
function prepareWelds(items, state = welds, spatialInk = false) {
  const polished = items.filter(s => isPolished(s) || (spatialInk && s.material === "cartoon" && s.mode !== "fan"));
  const edits = (state === welds || spatialInk) ? sculpts : null,
    drag = (state === welds || spatialInk) && space.grab?.moved ? space.grab.delta : null;
  if (state.edits === edits && state.drag === drag && polished.length === state.items.length && polished.every((s, i) => s === state.items[i].stroke && s.points.length === state.items[i].length)) return;
  state.items = polished.map(stroke => ({
    stroke,
    length: stroke.points.length
  }));
  state.edits = edits;
  state.drag = drag;
  state.parts.clear();
  state.version++;
  state.joined = false;
  const cells = new Map();
  function buckets(a, b, pad, visit) {
    const lo = a.map((n, i) => Math.floor((Math.min(n, b[i]) - pad) / weldCell));
    const hi = a.map((n, i) => Math.floor((Math.max(n, b[i]) + pad) / weldCell));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) visit(x + ',' + y + ',' + z);
  }
  for (const s of polished) {
    const parts = [];
    state.parts.set(s, parts);
    for (const [i, plane] of strokePlanes(s).entries()) {
      let centers = s.points.map(p => [p.x, p.y, p.z || 0]);
      for (const edit of edits || []) if (edit.stroke === s && edit.index === i) centers = pushSpine(s, centers, plane, edit);
      if (drag && space.grab.stroke === s && space.grab.index === i) centers = pushSpine(s, centers, plane, space.grab);
      const part = {
        s,
        plane,
        centers,
        segments: [],
        near: new Set()
      };
      parts.push(part);
      let a = 0;
      for (let j = 0; j < centers.length; j++) {
        if (j !== centers.length - 1 && s.points[j].d - s.points[a].d < 5) continue;
        const start = worldPoint(plane, ...centers[a]),
          end = worldPoint(plane, ...centers[j]);
        const ra = s.points[a].r,
          rb = s.points[j].r,
          r = Math.max(ra, rb);
        const seg = {
          part,
          start,
          end,
          ra,
          rb,
          r,
          from: a,
          to: j
        };
        part.segments.push(seg);
        buckets(start, end, r + Math.min(10, r), key => {
          let bin = cells.get(key);
          if (!bin) cells.set(key, bin = []);
          for (const other of bin) {
            if (other.part.s.material !== s.material || (spatialInk && !sameInk(other.part.s,s))) continue;
            if (other.part === part && s.points[a].d - s.points[other.to].d < 3 * (other.r + r) + 8) continue;
            const pad = r + other.r + Math.min(10, r, other.r);
            if (start.some((v, k) => Math.min(v, end[k]) > Math.max(other.start[k], other.end[k]) + pad || Math.max(v, end[k]) < Math.min(other.start[k], other.end[k]) - pad)) continue;
            part.near.add(other);
            other.part.near.add(seg);
          }
          bin.push(seg);
        });
        a = j;
      }
    }
  }
  const seen = new Set();
  for (const parts of state.parts.values()) for (const part of parts) {
    if (!part.near.size || seen.has(part)) continue;
    const group = [part];
    seen.add(part);
    for (const next of group) for (const neighbor of next.near) {
      if (!seen.has(neighbor.part)) {
        seen.add(neighbor.part);
        group.push(neighbor.part);
      }
    }
    state.joined = true;
    const cluster = {
      parts: group,
      meshes: null
    };
    for (const member of group) member.cluster = cluster;
  }
}
// Sample the union of the tapered, elliptical sweeps. Extract just its exterior
// with surface nets. The original centerlines still own width, editing and undo.
function fusedMeshes(cluster) {
  if (cluster.meshes) return cluster.meshes;
  const parts = cluster.parts,
    meshes = parts.map(() => []),
    segments = [];
  let maxRadius = 0;
  parts.forEach((part, id) => {
    for (const seg of part.segments) {
      const {
          start: a,
          end: b,
          ra,
          rb
        } = seg,
        v = difference(b, a),
        f = part.plane.front;
      const axial = dot3(v, f),
        r = Math.max(ra, rb);
      segments.push({
        ...seg,
        id,
        a,
        v,
        f,
        axial,
        dr: rb - ra,
        len: dot3(v, v) + .5625 * axial * axial
      });
      maxRadius = Math.max(maxRadius, r);
    }
  });
  const h = Math.max(.6, Math.min(4, maxRadius / 10)),
    block = 12,
    size = block + 2,
    slab = size * size;
  const tiles = new Map();
  for (const seg of segments) {
    const pad = seg.r + Math.min(20, seg.r) + 3 * h;
    const lo = seg.a.map((v, k) => Math.floor((Math.min(v, seg.end[k]) - pad) / (h * block)));
    const hi = seg.a.map((v, k) => Math.floor((Math.max(v, seg.end[k]) + pad) / (h * block)));
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      const key = x + ',' + y + ',' + z;
      let tile = tiles.get(key);
      if (!tile) {
        tile = {
          origin: [x, y, z].map(n => (n * block - 1) * h),
          layers: new Map()
        };
        tiles.set(key, tile);
      }
      let layer = tile.layers.get(seg.id);
      if (!layer) tile.layers.set(seg.id, layer = []);
      layer.push(seg);
    }
  }
  const total = size ** 3;
  const floats = () => new Float32Array(total);
  const field = floats(),
    dist = floats(),
    neighbor = floats(),
    radii = floats(),
    localRadius = floats(),
    rings = floats(),
    localRing = floats();
  const owner = new Int32Array(total),
    vertices = new Array(total);
  const corners = [0, 1, size, size + 1, slab, slab + 1, slab + size, slab + size + 1];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (const {
    origin,
    layers
  } of tiles.values()) {
    field.fill(1e5);
    neighbor.fill(1e5);
    vertices.fill(null);
    for (const [id, layer] of layers) {
      dist.fill(1e5);
      for (const seg of layer) {
        const {
            a,
            v,
            f,
            axial,
            len,
            ra,
            dr,
            from,
            to
          } = seg,
          pad = seg.r + Math.min(20, seg.r) + 2 * h;
        const lo = a.map((n, k) => Math.max(0, Math.ceil((Math.min(n, seg.end[k]) - pad - origin[k]) / h)));
        const hi = a.map((n, k) => Math.min(size - 1, Math.floor((Math.max(n, seg.end[k]) + pad - origin[k]) / h)));
        for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) {
          const dy = origin[1] + h * y - a[1],
            dz = origin[2] + h * z - a[2];
          for (let x = lo[0]; x <= hi[0]; x++) {
            const i = x + y * size + z * slab,
              dx = origin[0] + h * x - a[0];
            const depth = dx * f[0] + dy * f[1] + dz * f[2];
            const t = Math.max(0, Math.min(1, (dx * v[0] + dy * v[1] + dz * v[2] + .5625 * depth * axial) / (len || 1)));
            const qx = dx - t * v[0],
              qy = dy - t * v[1],
              qz = dz - t * v[2],
              qf = depth - t * axial;
            const r = ra + t * dr,
              d = Math.sqrt(qx * qx + qy * qy + qz * qz + .5625 * qf * qf) - r;
            if (d < dist[i]) {
              dist[i] = d;
              localRadius[i] = r;
              localRing[i] = from + t * (to - from);
            }
          }
        }
      }
      for (let i = 0; i < total; i++) {
        const d = dist[i];
        if (d === 1e5) continue;
        const old = field[i],
          k = Math.min(20, localRadius[i], radii[i]) * .95;
        neighbor[i] = Math.min(neighbor[i], Math.max(old, d));
        const overlap = Math.max(0, k - Math.abs(d - old));
        field[i] = Math.min(d, old) - (k > 0 ? overlap * overlap / (4 * k) : 0);
        if (d < old) {
          owner[i] = id;
          rings[i] = localRing[i];
          radii[i] = localRadius[i];
        }
      }
    }
    // Neighbor cells share a vertex, including across tile boundaries.
    for (let z = 0; z < size - 1; z++) for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const i = x + size * y + slab * z,
        inside = field[i] < 0;
      if (corners.every(c => field[i + c] < 0 === inside)) continue;
      let px = 0,
        py = 0,
        pz = 0,
        n = 0;
      for (const [c, b] of edges) {
        const a = field[i + corners[c]],
          d = field[i + corners[b]];
        if (a < 0 === d < 0) continue;
        const t = a / (a - d);
        px += (c & 1) + ((b & 1) - (c & 1)) * t;
        py += (c >> 1 & 1) + ((b >> 1 & 1) - (c >> 1 & 1)) * t;
        pz += (c >> 2) + ((b >> 2) - (c >> 2)) * t;
        n++;
      }
      const f = corners.map(c => field[i + c]);
      const nx = f[1] - f[0] + f[3] - f[2] + f[5] - f[4] + f[7] - f[6];
      const ny = f[2] - f[0] + f[3] - f[1] + f[6] - f[4] + f[7] - f[5];
      const nz = f[4] - f[0] + f[5] - f[1] + f[6] - f[2] + f[7] - f[3];
      const scale = 1 / (Math.hypot(nx, ny, nz) || 1);
      vertices[i] = [origin[0] + (x + px / n) * h, origin[1] + (y + py / n) * h, origin[2] + (z + pz / n) * h, 0, 0, nx * scale, ny * scale, nz * scale];
    }
    const strides = [1, size, slab];
    for (let z = 1; z <= block; z++) for (let y = 1; y <= block; y++) for (let x = 1; x <= block; x++) {
      const i = x + y * size + z * slab;
      for (let axis = 0; axis < 3; axis++) {
        const end = i + strides[axis];
        if (field[i] < 0 === field[end] < 0) continue;
        const source = field[i] < 0 ? i : end,
          dst = meshes[owner[source]],
          ring = rings[source];
        const u = strides[(axis + 1) % 3],
          v = strides[(axis + 2) % 3];
        const a = vertices[i],
          b = vertices[i - u],
          c = vertices[i - u - v],
          d = vertices[i - v];
        const {plane} = parts[owner[source]];
        const blend = 1 - smoothBand(neighbor[source] / Math.max(.01,radii[source]), 0, .7);
        for (const vert of [a,b,c,a,c,d]) {
          const local = difference(vert.slice(0,3),plane.origin);
          dst.push(vert[0],vert[1],vert[2],dot3(local,plane.right),dot3(local,plane.down),vert[5],vert[6],vert[7],ring,blend);
        }
      }
    }
  }
  cluster.meshes = new Map(parts.map((p, i) => [p, new Float32Array(meshes[i])]));
  return cluster.meshes;
}
