// Orthographic ink view. Each stroke keeps the drawing plane it was made on.
const space = {
  enabled: false,
  tool: 'draw',
  yaw: 0,
  pitch: 0,
  pivot: null,
  orbit: null,
  grab: null,
  surface: document.getElementById('spatial'),
  gl: null,
  meshes: new Map()
};
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function viewAxes() {
  const c = Math.cos(space.yaw),
    s = Math.sin(space.yaw),
    v = Math.cos(space.pitch),
    w = Math.sin(space.pitch);
  return {
    right: [c, 0, -s],
    down: [s * w, v, c * w],
    front: [s * v, -w, c * v]
  };
}
function frontView() {
  return Math.cos(space.yaw) * Math.cos(space.pitch) > 1 - 1e-10;
}
function worldPoint(plane, x, y, z = 0) {
  if (!plane) return [x, y, z];
  return plane.origin.map((o, i) => o + x * plane.right[i] + y * plane.down[i] + z * plane.front[i]);
}
function projectPoint(p) {
  const a = viewAxes(),
    v = p.map((x, i) => x - space.pivot[i]);
  return [space.pivot[0] + dot3(a.right, v), space.pivot[1] + dot3(a.down, v), dot3(a.front, v)];
}
const paperPlane = {
  origin: [0, 0, 0],
  right: [1, 0, 0],
  down: [0, 1, 0],
  front: [0, 0, 1]
};
function strokePlanes(stroke) {
  return [stroke.plane || paperPlane, ...(stroke.mirrors || [])];
}
function scenePivot(items, w, h) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  if (scenePhoto) {
    lo.splice(0, 3, scenePhoto.x, scenePhoto.y, -1);
    hi.splice(0, 3, scenePhoto.x + scenePhoto.w, scenePhoto.y + scenePhoto.h, -1);
  }
  for (const stroke of items) for (const plane of strokePlanes(stroke)) for (const p of stroke.points) {
    const v = worldPoint(plane, p.x, p.y, p.z || 0);
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], v[i]);
      hi[i] = Math.max(hi[i], v[i]);
    }
  }
  return Number.isFinite(lo[0]) ? lo.map((x, i) => (x + hi[i]) / 2) : [w / 2, h / 2, 0];
}
function initSpatial(target = space) {
  if (target.gl) return true;
  const gl = target.surface.getContext('webgl', {
    alpha: false,
    antialias: true,
    stencil: true,
    preserveDrawingBuffer: true
  });
  if (!gl) return false;
  const vertex = `attribute vec3 pos,normal;varying vec3 viewNormal;attribute vec2 paper;attribute float ringId,joinBlend;varying float joinWeight;varying highp vec3 inkPosition;
    uniform float firstRing,outlineWidth;varying highp float hitRing;
    uniform vec3 pivot,axisX,axisY,axisZ;uniform vec2 viewport,viewOrigin;
    uniform mat4 model;uniform vec4 inkRect;varying vec2 uv;
    void main(){
      vec3 world=(model*vec4(pos,1.)).xyz;
      joinWeight=joinBlend;inkPosition=world;
      vec3 n=mat3(model)*normal;viewNormal=vec3(dot(n,axisX),dot(n,axisY),dot(n,axisZ));
      vec3 p=world-pivot;
      vec2 screen=pivot.xy+vec2(dot(p,axisX),dot(p,axisY))-viewOrigin;
      screen+=outlineWidth*viewNormal.xy;
      hitRing=firstRing+ringId;
      gl_Position=vec4(screen.x/viewport.x*2.-1.,1.-screen.y/viewport.y*2.,-dot(p,axisZ)/24000.,1.);
      uv=(paper-inkRect.xy)/inkRect.zw;
    }`;
  const fragment = `precision highp float;
    varying float joinWeight;varying highp vec3 inkPosition;uniform vec3 lineInk;uniform float inkDensity;
    varying highp float hitRing;varying vec2 uv;uniform sampler2D strokeInk,finishMap;uniform float pick,finished,metalSurface;uniform vec4 basicInk,cartoonPaper;varying vec3 viewNormal;
    void main(){
      vec4 mark=basicInk.a>.5?basicInk:(finished>.5?vec4(1.):texture2D(strokeInk,uv));
      if(cartoonPaper.a>.5)mark=vec4(mix(cartoonPaper.rgb,mark.rgb,mark.a),1.);
      if(mark.a<.01)discard;
      if(pick>1.5){
        float id=floor(hitRing+.5);
        gl_FragColor=vec4(mod(id,256.),mod(floor(id/256.),256.),floor(id/65536.),255.)/255.;
      }else if(pick>.5){
        float v=floor(gl_FragCoord.z*65535.+.5);
        gl_FragColor=vec4(floor(v/256.)/255.,mod(v,256.)/255.,metalSurface/255.,1.);
      }else{
        if(finished>.5){
          vec3 n=normalize(viewNormal);
          gl_FragColor=vec4(texture2D(finishMap,.5+.488*n.xy).rgb,mark.a);
        }else if(joinWeight>0. && cartoonPaper.a>.5){
          vec3 n=normalize(viewNormal);
          float tone=max(0.,.48+.22*inkDensity-.68*max(0.,n.z)+.54*dot(n.xy,vec2(.6,.8)));
          float edge=pow(clamp(1.-n.z*n.z,0.,1.),3.);
          float chance=clamp((.004+.2*edge+.56*tone)*inkDensity*(.85+4.15*inkDensity),0.,.96);
          vec3 h=fract(floor(inkPosition/(.85+.35*inkDensity))*vec3(.1031,.1030,.0973));h+=dot(h,h.yxz+33.33);
          float grain=chance>0. ? step(fract((h.x+h.y)*h.z),chance) : 0.;
          gl_FragColor=vec4(mix(mark.rgb,mix(cartoonPaper.rgb,lineInk,grain),joinWeight),1.);
        }else gl_FragColor=mark;
      }
    }`;
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return false;
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
  gl.useProgram(program);
  target.gl = gl;
  target.pickTarget = null;
  target.depthTarget = null;
  target.uniform = {};
  target.attribute = {};
  for (const key of ['pivot', 'axisX', 'axisY', 'axisZ', 'viewport', 'viewOrigin', 'firstRing', 'pick', 'strokeInk', 'finishMap', 'finished', 'metalSurface', 'basicInk', 'inkRect', 'model', 'cartoonPaper', 'outlineWidth','lineInk','inkDensity']) target.uniform[key] = gl.getUniformLocation(program, key);
  for (const key of ['pos', 'normal', 'paper', 'ringId','joinBlend']) target.attribute[key] = gl.getAttribLocation(program, key);
  target.textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  gl.uniform1i(target.uniform.strokeInk, 0);
  gl.uniform1i(target.uniform.finishMap, 1);
  // WebGL requires complete textures for both samplers, including unlit ink draws.
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.activeTexture(gl.TEXTURE0);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  return true;
}
function difference(a, b) {
  return a.map((v, i) => v - b[i]);
}
function unit3(v, fallback) {
  const length = Math.hypot(...v);
  return length > 1e-8 ? v.map(n => n / length) : fallback;
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function meshData(s, centers = null) {
  const points = s.points;
  const fan = s.mode === 'fan' && s.previous && points.length > 1;
  const sides = isPolished(s) ? 32 : ringSides;
  const caps = isPolished(s) || s.material === 'cartoon' ? capBands : 1;
  const rows = fan ? Math.min(140, Math.max(8, Math.ceil(points.at(-1).d / 3))) : points.length - 1 + 2 * caps;
  const verts = new Float32Array(rows * (fan ? 14 : sides) * 6 * 8);
  let offset = 0;
  function write(vertex) {
    verts.set(vertex, offset);
    offset += 8;
  }
  function vertex(p) {
    return [...p, p[0], p[1], 0, 0, 1];
  }
  function strip(a, b) {
    for (let k = 1; k < a.length; k++) {
      write(a[k - 1]); write(b[k - 1]); write(b[k]);
      write(a[k - 1]); write(b[k]); write(a[k]);
    }
  }
  if (fan) {
    const end = points.at(-1),
      previous = s.previous.at(-1),
      mid = [(end.x + previous.x) / 2 - s.hinge.x, (end.y + previous.y) / 2 - s.hinge.y];
    const span = distanceBetween(previous, end),
      axis = Math.hypot(...mid) || 1;
    const crown = Math.min(span * .29, Math.min(s.reach, distanceBetween(previous, s.hinge)) * .27) * (1 + .45 * s.curl);
    let last;
    for (let i = 0; i <= rows; i++) {
      const t = i / rows,
        a = ribPoint(s.previous, t),
        b = ribPoint(points, t),
        row = [];
      const dx = b.x - a.x,
        dy = b.y - a.y,
        w = Math.hypot(dx, dy) || 1;
      for (let j = 0; j <= 14; j++) {
        const u = j / 14,
          bow = 4 * u * (1 - u) * t ** 3 * crown;
        const arch = (.10 + .18 * s.assist) * widthScale(s);
        const z = Math.sin(u * Math.PI) * w * arch;
        row.push(vertex([a.x + u * dx + bow * mid[0] / axis, a.y + u * dy + bow * mid[1] / axis, z]));
      }
      if (last) strip(last, row);
      last = row;
    }
  } else {
    // A rounded cross section gives even a flat gesture a visible edge in profile.
    let last = null;
    const polished = isPolished(s),
      rings = polished ? 32 : ringSides,
      tip = points.at(-1);
    let center,
      tangent,
      side,
      depth = [0, 0, 1];
    function ring(p, nx, ny, radius, shift = 0, radial = 1, axial = 0) {
      const row = [];
      for (let k = 0; k <= rings; k++) {
        const a = Math.PI * 2 * k / rings,
          c = Math.cos(a),
          v = Math.sin(a);
        const u = p.x + nx * c * radius + ny * shift,
          w = p.y + ny * c * radius - nx * shift;
        const sideNormal = radial * c,
          depthNormal = radial * v * (polished ? 1.25 : 1);
        const n = centers ? side.map((q, i) => q * sideNormal + depth[i] * depthNormal + tangent[i] * axial) : [nx * sideNormal + ny * axial, ny * sideNormal - nx * axial, depthNormal];
        if (centers) {
          const pos = center.map((n, i) => n + side[i] * c * radius + depth[i] * v * radius * .8 + tangent[i] * shift);
          row.push([...pos, u, w, ...n]);
        } else row.push([u, w, (p.z || 0) + v * radius * .8, u, w, ...n]);
      }
      return row;
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i],
        a = points[Math.max(0, i - 1)],
        b = points[Math.min(i + 1, points.length - 1)];
      const dx = b.x - a.x,
        dy = b.y - a.y,
        len = Math.hypot(dx, dy);
      const nx = len ? -dy / len : 0,
        ny = len ? dx / len : 1;
      if (centers) {
        center = centers[i];
        tangent = unit3(difference(centers[Math.min(i + 1, points.length - 1)], centers[Math.max(0, i - 1)]), [ny, -nx, 0]);
        // Orient each ring independently so a local bend cannot twist the ink farther down the stroke.
        side = unit3(cross3([0, 0, 1], tangent), [nx, ny, 0]);
        depth = cross3(tangent, side);
      }
      const r = s.mode === 'fan' ? widthScale(s) * .5 : p.r,
        row = ring(p, nx, ny, r);
      function dome(sign) {
        let previous = row;
        for (let band = 1; band <= capBands; band++) {
          const angle = band * Math.PI / (2 * capBands),
            radial = Math.cos(angle),
            axial = sign * Math.sin(angle);
          const next = ring(p, nx, ny, r * radial, r * axial, radial, axial);
          if (sign > 0) strip(previous, next);else strip(next, previous);
          previous = next;
        }
      }
      if (last) strip(last, row);else if (polished || s.material === 'cartoon') dome(-1);else strip(ring(p, nx, ny, .02, -r * .75), row);
      if (p === tip) {
        if (polished || s.material === 'cartoon') dome(1);else strip(row, ring(p, nx, ny, .02, r * .75));
      }
      last = row;
    }
  }
  return verts;
}
// Bake the same seeded pen marks used on paper in the stroke's own drawing plane.
function bakeStrokeInk(stroke, data, gl, target) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (let i = 3; i < data.length; i += 8) {
    left = Math.min(left, data[i]);
    right = Math.max(right, data[i]);
    top = Math.min(top, data[i + 1]);
    bottom = Math.max(bottom, data[i + 1]);
  }
  left = Math.floor(left) - 2;
  top = Math.floor(top) - 2;
  const w = Math.ceil(right) + 2 - left,
    h = Math.ceil(bottom) + 2 - top;
  const scale = Math.min(target === space ? ratio : 1, target.textureLimit / w, target.textureLimit / h, Math.sqrt(4194304 / (w * h)));
  function localLayer() {
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.ceil(w * scale));
    surface.height = Math.max(1, Math.ceil(h * scale));
    const g = surface.getContext('2d');
    g.scale(surface.width / w, surface.height / h);
    g.translate(-left, -top);
    return g;
  }
  const output = localLayer();
  if (stroke.mode === 'fan') {
    drawFanRib(output, stroke);
  } else {
    // A rotating-view gesture already has a local grain layer. Copy its new
    // texture without replaying the whole stroke on every pointer move.
    const live = active?.stroke === stroke && !active.end && !frontView() &&
      left >= 0 && top >= 0 && left + w <= width && top + h <= height;
    const ink = live ? group : groupFor(stroke.color, stroke.secondary, localLayer);
    if (!live) replay(ink, stroke);
    output.save();
    output.setTransform(1, 0, 0, 1, 0, 0);
    const layers = stroke.material === 'cartoon' ? [ink.stipple] : [ink.outline, ink.paper, ink.stipple];
    for (const layer of layers) {
      if (live) output.drawImage(layer.canvas, left * ratio, top * ratio, w * ratio, h * ratio, 0, 0, output.canvas.width, output.canvas.height);
      else output.drawImage(layer.canvas, 0, 0);
    }
    output.restore();
    if (live) finishCartoon({stipple: output}, stroke);
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, output.canvas);
  return [left, top, w, h];
}
// Move a compact patch along the selected stroke. Limit strain on the ink at the shoulders.
function pushSpine(stroke, centers, plane, edit) {
  const ring = edit.ring;
  const influence = edit.influence ?? .35;
  if (influence <= 0) return centers;
  const reach = Math.max(20, Math.min(38, 18 + stroke.points[ring].r * .45)) * (.65 + influence);
  const limit = reach * .28,
    amount = Math.hypot(...edit.delta);
  if (!amount) return centers;
  const gain = limit * Math.tanh((.20 + influence) * amount / limit) / amount;
  const delta = [plane.right, plane.down, plane.front].map(axis => dot3(axis, edit.delta) * gain);
  const out = centers.slice();
  const shifted = (i, w) => centers[i].map((v, k) => v + delta[k] * w);
  out[ring] = shifted(ring, 1);
  for (const step of [-1, 1]) {
    let distance = 0;
    for (let i = ring + step; i >= 0 && i < centers.length; i += step) {
      distance += Math.hypot(...difference(centers[i], centers[i - step]));
      if (distance >= reach) break;
      const t = distance / reach;
      out[i] = shifted(i, 1 - t * t * (3 - 2 * t));
    }
  }
  return out;
}
function sculptBuffer(entry, stroke, plane, index, gl) {
  const hand = space.grab;
  const grab = hand?.moved && hand.stroke === stroke && hand.index === index ? hand : null;
  if (!sculpts.length && !grab || stroke.mode === 'fan') return entry.buffer;
  const cache = entry.shapes[index] ||= {};
  if (!cache.rest || cache.rest.length !== stroke.points.length) {
    cache.rest = stroke.points.map(p => [p.x, p.y, p.z || 0]);
    cache.version = null;
  }
  if (cache.version !== sculpts) {
    cache.committed = cache.rest;
    for (const edit of sculpts) if (edit.stroke === stroke && edit.index === index) cache.committed = pushSpine(stroke, cache.committed, plane, edit);
    cache.version = sculpts;
    cache.preview = undefined;
  }
  if (cache.preview !== (grab?.delta || null)) {
    const centers = grab ? pushSpine(stroke, cache.committed, plane, grab) : cache.committed;
    if (centers !== cache.uploaded && centers !== cache.rest) {
      cache.buffer ||= gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, cache.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, meshData(stroke, centers), gl.DYNAMIC_DRAW);
    }
    cache.uploaded = centers;
    cache.preview = grab?.delta || null;
  }
  return cache.uploaded === cache.rest ? entry.buffer : cache.buffer;
}
// The pick pass interpolates ring numbers over the same triangles as the visible ink.
const ringSides = 16,
  capBands = 8;
function isPolished(stroke) {
  return stroke.material === 'metal' || stroke.material === 'plastic';
}
function ringNumbers(stroke) {
  const count = stroke.points.length,
    polished = isPolished(stroke);
  const sides = polished ? 32 : ringSides,
    caps = polished || stroke.material === 'cartoon' ? capBands : 1,
    bands = count - 1 + 2 * caps;
  const ids = new Float32Array(bands * sides * 6);
  let k = 0;
  for (let band = 0; band < bands; band++) {
    const a = Math.max(0, Math.min(count - 1, band - caps)),
      b = Math.max(0, Math.min(count - 1, band - caps + 1));
    for (let side = 0; side < sides; side++) {
      ids.set([a, b, b, a, b, a], k);
      k += 6;
    }
  }
  return ids;
}
// The photograph belongs to the original drawing plane in world coordinates.
function renderPhoto(target, photo) {
  const {gl, uniform: u, attribute: a} = target;
  let layer = target.photoLayer;
  if (layer && layer.photo !== photo) {
    gl.deleteBuffer(layer.buffer);
    gl.deleteTexture(layer.texture);
    target.photoLayer = layer = null;
  }
  if (!photo) return;
  gl.activeTexture(gl.TEXTURE0);
  if (!layer) {
    const {x, y, w, h, image} = photo;
    layer = target.photoLayer = {photo, buffer: gl.createBuffer(), texture: gl.createTexture()};
    gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      x, y, -1, 0, 0, x + w, y, -1, 1, 0,
      x, y + h, -1, 0, 1, x + w, y + h, -1, 1, 1
    ]), gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, layer.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
    for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, key, gl.CLAMP_TO_EDGE);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, layer.buffer);
  gl.bindTexture(gl.TEXTURE_2D, layer.texture);
  gl.enableVertexAttribArray(a.pos);
  gl.enableVertexAttribArray(a.paper);
  gl.disableVertexAttribArray(a.normal);
  gl.disableVertexAttribArray(a.joinBlend);
  gl.disableVertexAttribArray(a.ringId);
  gl.vertexAttribPointer(a.pos, 3, gl.FLOAT, false, 20, 0);
  gl.vertexAttribPointer(a.paper, 2, gl.FLOAT, false, 20, 12);
  gl.uniform4f(u.basicInk, 0, 0, 0, 0);
  gl.uniform4f(u.cartoonPaper, 0, 0, 0, 0);
  gl.uniform1f(u.finished, 0);
  gl.uniform4f(u.inkRect, 0, 0, 1, 1);
  gl.uniformMatrix4fv(u.model, false, [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
function renderSpace(items, picking = false, hit = null, map = null, target = space, immediate = false) {
  const preview = target !== space,
    gl = target.gl,
    u = target.uniform,
    a = preview ? paperPlane : viewAxes();
  const drawing = preview ? swatch : canvas,
    viewW = preview ? drawing.width : width,
    viewH = preview ? drawing.height : height;
  const spatialInk = !preview && (!frontView() || sculpts.length || space.grab?.moved || items.some(s => s.plane && Math.abs(s.plane.front[2]-1)>1e-8));
  const joins = spatialInk ? (target.spatialWelds ||= weldState()) : preview ? target.welds : welds;
  if (target.surface.width !== drawing.width || target.surface.height !== drawing.height) {
    target.surface.width = drawing.width;
    target.surface.height = drawing.height;
  }
  gl.viewport(0, 0, hit ? 1 : map?.w || target.surface.width, hit ? 1 : map?.h || target.surface.height);
  gl.uniform2f(u.viewOrigin, hit ? hit.x - .5 / ratio : 0, hit ? hit.y - .5 / ratio : 0);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniform3fv(u.pivot, target.pivot);
  gl.uniform3fv(u.axisX, a.right);
  gl.uniform3fv(u.axisY, a.down);
  gl.uniform3fv(u.axisZ, a.front);
  gl.uniform2f(u.viewport, hit ? 1 / ratio : viewW, hit ? 1 / ratio : viewH);
  gl.uniform1f(u.pick, hit ? 2 : picking ? 1 : 0);
  if (picking) gl.disable(gl.BLEND);else gl.enable(gl.BLEND);
  if (!preview && !picking) renderPhoto(target, scenePhoto);
  prepareWelds(items, joins, spatialInk);
  const live = new Set(items);
  for (const [s, entry] of target.meshes) if (!live.has(s)) {
    for (const shape of entry.shapes) {
      if (shape?.buffer) gl.deleteBuffer(shape.buffer);
      if (shape?.weldBuffer) gl.deleteBuffer(shape.weldBuffer);
    }
    if (entry.ringBuffer) gl.deleteBuffer(entry.ringBuffer);
    if (entry.finishMap) gl.deleteTexture(entry.finishMap);
    gl.deleteBuffer(entry.buffer);
    gl.deleteTexture(entry.texture);
    target.meshes.delete(s);
  }
  function drawStroke(s, outline = false) {
    let entry = target.meshes.get(s);
    if (!entry) {
      entry = {
        buffer: gl.createBuffer(),
        texture: gl.createTexture(),
        size: -1,
        shapes: []
      };
      target.meshes.set(s, entry);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    } else gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    if (entry.size !== s.points.length || entry.ratio !== ratio) {
      const data = meshData(s);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      if (s.material === 'basic' || isPolished(s) || (s.material === 'cartoon' && s.mode !== 'fan' && !s.density)) {
        if (!entry.rect) {
          if (s.material === 'basic') entry.basicInk = [1, 3, 5].map(i => parseInt(s.color.slice(i, i + 2), 16) / 255).concat(1);
          // Opaque finishes cover the mesh and only textured ink needs a baked mask.
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, s.material === 'cartoon' ? 0 : 255]));
          entry.rect = [0, 0, 1, 1];
        }
      } else entry.rect = bakeStrokeInk(s, data, gl, target);
      entry.count = data.length / 8;
      entry.size = s.points.length;
      entry.ratio = ratio;
    }
    const finished = isPolished(s);
    const cartoon = s.material === 'cartoon' && s.mode !== 'fan';
    if (cartoon && !entry.paperColor) {
      const rgba = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).concat(1);
      entry.paperColor = rgba(s.secondary || '#ffffff');
      entry.lineColor = rgba(s.color);
    }
    if (cartoon && !outline) {
      gl.uniform4fv(u.cartoonPaper, entry.paperColor);
      gl.uniform3f(u.lineInk,...entry.lineColor.slice(0,3));
      gl.uniform1f(u.inkDensity,s.density);
    }
    else gl.uniform4f(u.cartoonPaper, 0, 0, 0, 0);
    if (outline) gl.uniform4fv(u.basicInk, entry.lineColor);
    else if (entry.basicInk) gl.uniform4fv(u.basicInk, entry.basicInk);else gl.uniform4f(u.basicInk, 0, 0, 0, 0);
    gl.uniform1f(u.finished, finished ? 1 : 0);
    gl.uniform1f(u.metalSurface, s.material === 'metal' ? 1 : s.material === 'plastic' ? 2 : cartoon ? 3 : 0);
    if (!picking && finished) {
      gl.activeTexture(gl.TEXTURE1);
      entry.finishMap ||= gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, entry.finishMap);
      if (entry.lightVersion !== studioLight.version) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, materialCap(finishFor(s), s.density));
        for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE);
        for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, param, gl.LINEAR);
        entry.lightVersion = studioLight.version;
      }
      gl.activeTexture(gl.TEXTURE0);
    }
    if (hit) {
      if (s.mode === 'fan') return;
      entry.ringBuffer ||= gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.ringBuffer);
      if (entry.ringCount !== s.points.length) {
        gl.bufferData(gl.ARRAY_BUFFER, ringNumbers(s), gl.STATIC_DRAW);
        entry.ringCount = s.points.length;
      }
      gl.enableVertexAttribArray(target.attribute.ringId);
      gl.vertexAttribPointer(target.attribute.ringId, 1, gl.FLOAT, false, 0, 0);
    } else gl.disableVertexAttribArray(target.attribute.ringId);
    gl.uniform4fv(u.inkRect, entry.rect);
    for (const [index, plane] of strokePlanes(s).entries()) {
      if (hit) {
        hit.ranges.push({
          stroke: s,
          index,
          first: hit.next
        });
        gl.uniform1f(u.firstRing, hit.next);
        hit.next += s.points.length;
      }
      const part = joins.parts.get(s)?.[index],
        merged = part?.cluster;
      let count = entry.count,
        model = plane,
        stride = 32;
      // The stencil outlines the combined silhouette while the exact fillet builds.
      // Pointer samples on a moving limb would immediately invalidate that job.
      const moving = !immediate && merged && (active || space.grab?.moved) &&
        merged.parts.some(part => part.s === active?.stroke || part.s === space.grab?.stroke);
      const geometry = merged && (merged.meshes || (!moving && fusedMeshes(merged, immediate)));
      if (geometry) {
        const shape = entry.shapes[index] ||= {};
        shape.weldBuffer ||= gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, shape.weldBuffer);
        if (shape.cluster !== merged) {
          const data = geometry.get(part);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          shape.count = data.length / 10;
          shape.cluster = merged;
        }
        count = shape.count;
        stride = 40;
        gl.enableVertexAttribArray(target.attribute.joinBlend);
        gl.vertexAttribPointer(target.attribute.joinBlend,1,gl.FLOAT,false,stride,36);
        model = paperPlane;
        if (hit) gl.vertexAttribPointer(target.attribute.ringId, 1, gl.FLOAT, false, stride, 32);
      } else {
        gl.disableVertexAttribArray(target.attribute.joinBlend);
        if (hit) {
          gl.bindBuffer(gl.ARRAY_BUFFER, entry.ringBuffer);
          gl.vertexAttribPointer(target.attribute.ringId, 1, gl.FLOAT, false, 0, 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, preview ? entry.buffer : sculptBuffer(entry, s, plane, index, gl));
      }
      for (const [key, size, offset] of [['pos', 3, 0], ['paper', 2, 12], ['normal', 3, 20]]) {
        const loc = target.attribute[key];
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      }
      gl.uniformMatrix4fv(u.model, false, [...model.right, 0, ...model.down, 0, ...model.front, 0, ...model.origin, 1]);
      gl.drawArrays(gl.TRIANGLES, 0, count);
    }
  }
  for (let i = 0; i < items.length;) {
    const first = items[i];
    if (picking || first.material !== 'cartoon' || first.mode === 'fan') {
      drawStroke(items[i++]);
      continue;
    }
    const start = i++;
    while (i < items.length && items[i].mode !== 'fan' && sameInk(first, items[i])) i++;
    // Mark visible ink in the stencil. The expanded shell can ink only its outside edge.
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.ALWAYS, 1, 255);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    for (let j = start; j < i; j++) drawStroke(items[j]);
    gl.stencilFunc(gl.EQUAL, 0, 255);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.uniform1f(u.outlineWidth, .78);
    for (let j = start; j < i; j++) drawStroke(items[j], true);
    gl.uniform1f(u.outlineWidth, 0);
    gl.disable(gl.STENCIL_TEST);
  }
}
// A single-sample target keeps IDs exact even where two coils overlap at their edges.
function pickTarget(gl, w, h) {
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  const color = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  return {
    framebuffer,
    color,
    depth,
    w,
    h
  };
}
function pickRing(p) {
  const gl = space.gl;
  space.pickTarget ||= pickTarget(gl, 1, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, space.pickTarget.framebuffer);
  const hit = {
      x: p.x,
      y: p.y,
      ranges: [],
      next: 1
    },
    pixel = new Uint8Array(4);
  try {
    gl.disable(gl.DITHER);
    renderSpace(strokes, true, hit);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DITHER);
  }
  const id = pixel[0] + 256 * pixel[1] + 65536 * pixel[2];
  if (id < 1 || id >= hit.next) return null;
  const match = hit.ranges.findLast(range => range.first <= id);
  return {
    stroke: match.stroke,
    index: match.index,
    ring: id - match.first
  };
}
// Freeze the visible shell at pen-down. Newly added rings cannot pick themselves.
function captureSurface(items = strokes) {
  if (!items.length || !initSpatial()) return null;
  space.pivot ||= scenePivot(strokes, width, height);
  const gl = space.gl;
  const scale = Math.min(1, space.textureLimit / width, space.textureLimit / height);
  const w = Math.max(1, Math.round(width * scale)),
    h = Math.max(1, Math.round(height * scale));
  let target = space.depthTarget;
  if (!target || target.w !== w || target.h !== h) {
    if (target) {
      gl.deleteTexture(target.color);
      gl.deleteRenderbuffer(target.depth);
      gl.deleteFramebuffer(target.framebuffer);
    }
    target = space.depthTarget = pickTarget(gl, w, h);
    target.pixels = new Uint8Array(w * h * 4);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  try {
    gl.disable(gl.DITHER);
    renderSpace(items, true, null, target);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, target.pixels);
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.DITHER);
  }
  return target;
}
function surfaceAt(map, p, contact = null) {
  const cx = Math.floor(p.x * map.w / width),
    cy = map.h - 1 - Math.floor(p.y * map.h / height);
  const reach = Math.ceil(Math.min(6, .7 * p.r) * map.w / width);
  let best = Infinity,
    depth = null;
  for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) {
    const d = x * x + y * y;
    if (d >= best || d > reach * reach || cx + x < 0 || cy + y < 0 || cx + x >= map.w || cy + y >= map.h) continue;
    const i = 4 * ((cy + y) * map.w + cx + x);
    if (map.pixels[i + 2] > 3) continue;
    if (contact) {
      contact.finish = ['', 'metal', 'plastic', 'cartoon'][map.pixels[i + 2]];
      contact.x = (cx + x + .5) * width / map.w;
      contact.y = (map.h - cy - y - .5) * height / map.h;
    }
    depth = (1 - 2 * (map.pixels[i] * 256 + map.pixels[i + 1]) / 65535) * 24000;
    best = d;
  }
  return depth;
}
function placeOnSurface(stroke, p, index) {
  const map = active.support;
  if (!map) return;
  const pts = stroke.points,
    prior = pts[Math.max(0, index - 1)];
  const contact = {};
  const depth = surfaceAt(map, p, contact);
  if (depth === null) {
    p.z = prior.z || 0;
    return;
  }
  if (index === 0 && !stroke.inheritedWidth && stroke.material !== 'basic') {
    // A fresh pass on the shell starts with a contact patch instead of a hairline tip.
    stroke.joinRadius = 3.5 * widthScale(stroke);
    p.r = stroke.joinRadius;
  }
  // Embed the center just inside the picked surface so even a grazing pass joins it.
  const embed = stroke.material === contact.finish ? .74 : .24;
  p.z = depth + (stroke.plane ? 0 : space.pivot[2]) - embed * p.r;
  if (active.joinDepth !== null && contact.finish === stroke.material && p.d < stroke.joinRadius * 2) {
    const mix = stroke.continues ? 0 : smoothBand(p.d, 0, stroke.joinRadius * 2);
    p.z = active.joinDepth + (p.z - active.joinDepth) * mix;
  }
  const anchor = active.lastContact;
  if (anchor === null) {
    for (let i = 0; i < index; i++) pts[i].z = p.z;
  } else if (index > anchor + 1) {
    // Bridge open space between the two real contacts, including after a curl.
    const start = pts[anchor],
      span = p.d - start.d;
    for (let i = anchor + 1; i < index; i++) {
      const t = (pts[i].d - start.d) / span;
      pts[i].z = start.z + (p.z - start.z) * t;
    }
  }
  active.lastContact = index;
}
function drawingPlane() {
  const a = viewAxes();
  return {
    ...a,
    origin: space.pivot.map((n, i) => n - a.right[i] * space.pivot[0] - a.down[i] * space.pivot[1])
  };
}
