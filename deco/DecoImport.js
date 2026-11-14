import * as THREE from 'three';
import { OBJLoader }  from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader }  from 'three/addons/loaders/STLLoader.js';
import { PLYLoader }  from 'three/addons/loaders/PLYLoader.js';

/**
 * DecoImport — turns a dropped / picked set of files (e.g. `chilli.obj` +
 * `material.mtl` + `texture.png`) into ONE welded, indexed geometry that
 * carries a per-vertex `color` attribute, ready to be placed on a link and
 * fused into it.
 *
 * Why vertex colours: the chain pipeline (instancing, simplify, CSG, export)
 * only ever moves `position` / `normal` / `color` around — UV-mapped textures
 * would not survive any of it. So the texture is sampled once per corner here,
 * and from then on the object is just a coloured mesh like any other part.
 *
 * Colour priority per corner: texture (map_Kd / baseColor map) → the mesh's own
 * vertex colours → the material's flat colour (Kd / baseColorFactor) → none.
 * Every colour that ends up in the attribute is LINEAR (three's working space),
 * the same as OBJLoader / PLYLoader / GLTFLoader produce for vertex colours.
 */

export const MODEL_EXT = ['obj', 'glb', 'gltf', 'ply', 'stl'];
const Y_UP_EXT = new Set(['obj', 'glb', 'gltf']);   // conventionally Y-up → rotated to the app's Z-up

const extOf  = n => (n.toLowerCase().split('.').pop() || '');
const baseOf = n => n.replace(/\\/g, '/').split('/').pop().toLowerCase();

// sRGB byte → linear float lookup (texture pixels are sRGB-encoded)
const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Browser pixel reader: Blob / ImageBitmap / <img> → {data,width,height}, downscaled to ≤ maxSize. */
export async function readImagePixels(src, maxSize = 2048) {
  const bmp = (typeof Blob !== 'undefined' && src instanceof Blob) ? await createImageBitmap(src) : src;
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, maxSize / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
  const cv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

/** Nearest-texel sampler with repeat wrapping. Writes LINEAR rgb into out[o..o+2]. */
function makeSampler(img, flipY) {
  const { data, width: W, height: H } = img;
  return (u, v, out, o) => {
    u -= Math.floor(u); v -= Math.floor(v);                      // repeat wrap
    const x = Math.min(W - 1, (u * W) | 0);
    const y = Math.min(H - 1, ((flipY ? 1 - v : v) * H) | 0);
    const p = (y * W + x) * 4;
    out[o] = SRGB_LUT[data[p]]; out[o + 1] = SRGB_LUT[data[p + 1]]; out[o + 2] = SRGB_LUT[data[p + 2]];
  };
}

/** Minimal MTL reader — only what matters for colour: Kd and map_Kd per material. */
export function parseMTL(text) {
  const mats = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/), key = sp[0].toLowerCase();
    if (key === 'newmtl') { cur = mats[line.slice(7).trim()] = { kd: null, map: null }; continue; }
    if (!cur) continue;
    if (key === 'kd' && sp.length >= 4) cur.kd = [+sp[1], +sp[2], +sp[3]];
    else if (key === 'map_kd' && sp.length >= 2) cur.map = sp[sp.length - 1];   // last token = file (options come first)
  }
  return mats;
}

/**
 * @param files       array of File-like {name, arrayBuffer(), text()}
 * @param opts.readPixels  async (Blob|image) → {data,width,height}; defaults to the browser canvas reader
 * @param opts.unitScale   model units → mm (applied before anything else)
 * @returns {geo, name, colorSource, missingTextures, yUpConverted}
 */
export async function importDecoration(files, { readPixels = readImagePixels, unitScale = 1 } = {}) {
  files = [...files];
  const model = files.find(f => MODEL_EXT.includes(extOf(f.name)));
  if (!model) throw new Error('no .obj / .glb / .gltf / .ply / .stl among the selected files');
  const byName = new Map(files.map(f => [baseOf(f.name), f]));
  const ext = extOf(model.name);
  const missingTextures = [];
  let parts = [];             // [{geo (non-indexed, world-baked), colorOf(geo) → Float32Array|null, source}]

  if (ext === 'obj') {
    const text = await model.text();
    const root = new OBJLoader().parse(text);
    // material colours from the .mtl (named by `mtllib`, else any .mtl that came along)
    const lib = /^\s*mtllib\s+(.+)$/m.exec(text);
    const mtlFile = (lib && byName.get(baseOf(lib[1].trim()))) || files.find(f => extOf(f.name) === 'mtl');
    const mtl = mtlFile ? parseMTL(await mtlFile.text()) : {};
    const resolved = new Map();               // material name → {sampler|null, kd|null}
    const resolve = async name => {
      if (resolved.has(name)) return resolved.get(name);
      const m = mtl[name] || {};
      let sampler = null;
      if (m.map) {
        const img = byName.get(baseOf(m.map));
        if (img) sampler = makeSampler(await readPixels(img), true);   // OBJ uv origin is bottom-left
        else missingTextures.push(m.map);
      }
      const kd = m.kd ? new THREE.Color().setRGB(m.kd[0], m.kd[1], m.kd[2], THREE.SRGBColorSpace) : null;
      const r = { sampler, kd };
      resolved.set(name, r);
      return r;
    };
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse(o => { if (o.isMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const info = [];
      for (const mat of mats) info.push(await resolve(mat.name));
      parts.push(bakeMesh(mesh, info));
    }
  } else if (ext === 'glb' || ext === 'gltf') {
    const buf = await model.arrayBuffer();
    // external buffers / images of a .gltf come from the other picked files
    const urls = [];
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      const f = byName.get(baseOf(decodeURIComponent(url)));
      if (!f || typeof URL === 'undefined' || !URL.createObjectURL) return url;
      const u = URL.createObjectURL(f); urls.push(u); return u;
    });
    const gltf = await new Promise((res, rej) =>
      new GLTFLoader(manager).parse(buf, '', res, e => rej(new Error('glTF parse error: ' + (e?.message || e)))));
    urls.forEach(u => URL.revokeObjectURL(u));
    gltf.scene.updateMatrixWorld(true);
    const meshes = [];
    gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const info = [];
      for (const mat of mats) {
        let sampler = null;
        if (mat.map && mat.map.image) sampler = makeSampler(await readPixels(mat.map.image), mat.map.flipY);
        info.push({ sampler, kd: mat.color ? mat.color.clone() : null, factor: true });
      }
      parts.push(bakeMesh(mesh, info));
    }
  } else {
    const buf = await model.arrayBuffer();
    const g = ext === 'stl' ? new STLLoader().parse(buf) : new PLYLoader().parse(buf);
    parts.push(bakeMesh(new THREE.Mesh(g), [{ sampler: null, kd: null }]));
  }

  parts = parts.filter(p => p.pos.length);
  if (!parts.length) throw new Error('the model contains no triangles');

  // merge every part into one non-indexed soup
  const total = parts.reduce((s, p) => s + p.pos.length, 0);
  const pos = new Float32Array(total), col = new Float32Array(total);
  let off = 0, source = 'none';
  const rank = { none: 0, material: 1, vertex: 2, texture: 3 };
  for (const p of parts) {
    pos.set(p.pos, off);
    if (p.col) col.set(p.col, off); else col.fill(1, off, off + p.pos.length);
    off += p.pos.length;
    if (rank[p.source] > rank[source]) source = p.source;
  }

  if (unitScale !== 1) for (let i = 0; i < pos.length; i++) pos[i] *= unitScale;
  const yUp = Y_UP_EXT.has(ext);
  if (yUp) for (let i = 0; i < pos.length; i += 3) { const y = pos[i + 1], z = pos[i + 2]; pos[i + 1] = -z; pos[i + 2] = y; }

  const geo = weldWithColors(pos, col);
  // centre on the bbox so the gizmo pivots around the middle of the object
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z);
  geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  return { geo, name: model.name.replace(/\.[^.]+$/, ''), colorSource: source,
           missingTextures: [...new Set(missingTextures)], yUpConverted: yUp };
}

/**
 * Colour-aware decimation to ≤ `target` vertices with meshoptimizer (`M` = a
 * ready MeshoptSimplifier with experimental features on). A closed mesh has
 * ~2 triangles per vertex, so start there and correct by the measured ratio —
 * 2–4 simplify calls instead of a blind binary search (big for a 500k-tri scan).
 */
export function simplifyColored(M, geo, target) {
  const P = geo.getAttribute('position').array, C = geo.getAttribute('color').array;
  const nV = P.length / 3;
  if (nV <= target) return geo.clone();
  const src = geo.index.array instanceof Uint32Array ? geo.index.array : new Uint32Array(geo.index.array);
  const run = tris => M.simplifyWithAttributes(src, P, 3, C, 3, [0.5, 0.5, 0.5], null, Math.max(3, Math.floor(tris) * 3), 1, ['LockBorder'])[0];
  const used = ix => { const s = new Uint8Array(nV); let k = 0; for (let i = 0; i < ix.length; i++) if (!s[ix[i]]) { s[ix[i]] = 1; k++; } return k; };
  let tris = target * 2, best = null, bestV = 0;
  for (let it = 0; it < 4; it++) {
    const ix = run(tris), v = used(ix);
    if (v <= target && v > bestV) { best = ix; bestV = v; }
    if (v <= target && v >= target * 0.95) break;
    tris *= (target / Math.max(1, v)) * (v > target ? 0.98 : 1);
  }
  if (!best) best = run(tris * 0.5);
  // compact to the used vertices
  const remap = new Int32Array(nV).fill(-1), oi = new Uint32Array(best.length);
  let nx = 0;
  for (let i = 0; i < best.length; i++) { const v = best[i]; if (remap[v] < 0) remap[v] = nx++; oi[i] = remap[v]; }
  const op = new Float32Array(nx * 3), oc = new Float32Array(nx * 3);
  for (let v = 0; v < nV; v++) {
    const q = remap[v]; if (q < 0) continue;
    op[q * 3] = P[v * 3]; op[q * 3 + 1] = P[v * 3 + 1]; op[q * 3 + 2] = P[v * 3 + 2];
    oc[q * 3] = C[v * 3]; oc[q * 3 + 1] = C[v * 3 + 1]; oc[q * 3 + 2] = C[v * 3 + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(op, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(oc, 3));
  g.setIndex(new THREE.Uint32BufferAttribute(oi, 1));
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** One mesh → world-baked non-indexed positions + per-corner linear colours. */
function bakeMesh(mesh, matInfo) {
  let g = mesh.geometry;
  if (g.index) g = g.toNonIndexed();
  const P = g.getAttribute('position');
  const n = P.count;
  const pos = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
  }
  const uv = g.getAttribute('uv'), vc = g.getAttribute('color');
  // material index per corner (multi-material OBJ / glTF primitives use groups)
  const matOf = new Uint16Array(n);
  if (g.groups && g.groups.length && matInfo.length > 1)
    for (const gr of g.groups) matOf.fill(gr.materialIndex || 0, gr.start, Math.min(n, gr.start + gr.count));

  const anyTex = !!uv && matInfo.some(m => m.sampler);
  const anyKd = matInfo.some(m => m.kd && !(m.factor && m.kd.r === 1 && m.kd.g === 1 && m.kd.b === 1));
  const source = anyTex ? 'texture' : vc ? 'vertex' : anyKd ? 'material' : 'none';
  if (source === 'none') return { pos, col: null, source };

  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const m = matInfo[matOf[i]] || matInfo[0], o = i * 3;
    if (uv && m.sampler) { m.sampler(uv.getX(i), uv.getY(i), col, o); continue; }   // the texture already holds the albedo
    let r = 1, gg = 1, b = 1;
    if (vc) { r = vc.getX(i); gg = vc.getY(i); b = vc.getZ(i); }
    if (m.kd && (!vc || m.factor)) { r *= m.kd.r; gg *= m.kd.g; b *= m.kd.b; }      // glTF factor multiplies, OBJ Kd only fills in
    col[o] = r; col[o + 1] = gg; col[o + 2] = b;
  }
  return { pos, col, source };
}

/**
 * Weld a non-indexed triangle soup by POSITION only, averaging the colours of
 * every corner that lands on the same vertex. Texture seams split vertices in
 * the source; welding them back gives a closed mesh that simplifies and CSGs
 * cleanly. Degenerate (collapsed) triangles are dropped.
 * `tol` > 0 also merges vertices up to that distance apart (searching the
 * neighbouring grid cells) — for CSG output, where the two sides of a cut
 * compute "the same" point with slightly different rounding.
 */
export function weldWithColors(pos, col, tol = 0) {
  const n = pos.length / 3;
  if (tol > 0) return finishWeld(n, pos, col, tolerantRemap(pos, n, tol));
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
    if (y < mny) mny = y; if (y > mxy) mxy = y;
    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
  }
  // 17 bits per axis → a 51-bit integer key, exact in a JS number
  const R = 131071, sx = R / ((mxx - mnx) || 1), sy = R / ((mxy - mny) || 1), sz = R / ((mxz - mnz) || 1);
  const B = 131072;
  const map = new Map();
  const remap = new Uint32Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const key = (Math.round((pos[o] - mnx) * sx) * B + Math.round((pos[o + 1] - mny) * sy)) * B + Math.round((pos[o + 2] - mnz) * sz);
    let id = map.get(key);
    if (id === undefined) { id = next++; map.set(key, id); }
    remap[i] = id;
  }
  return finishWeld(n, pos, col, { remap, count: next });
}

/** remap[i] → merged vertex id, merging anything within `tol` (27-cell neighbour search). */
function tolerantRemap(pos, n, tol) {
  const cells = new Map(), reps = [];        // reps[id] = source corner that founded vertex id
  const remap = new Uint32Array(n);
  const inv = 1 / tol, t2 = tol * tol;
  for (let i = 0; i < n; i++) {
    const o = i * 3, x = pos[o], y = pos[o + 1], z = pos[o + 2];
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let id = -1;
    for (let dx = -1; dx <= 1 && id < 0; dx++) for (let dy = -1; dy <= 1 && id < 0; dy++) for (let dz = -1; dz <= 1 && id < 0; dz++) {
      const arr = cells.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!arr) continue;
      for (const c of arr) {
        const r = reps[c] * 3, ex = pos[r] - x, ey = pos[r + 1] - y, ez = pos[r + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= t2) { id = c; break; }
      }
    }
    if (id < 0) {
      id = reps.length; reps.push(i);
      const k = `${cx},${cy},${cz}`; let arr = cells.get(k); if (!arr) cells.set(k, arr = []); arr.push(id);
    }
    remap[i] = id;
  }
  return { remap, count: reps.length };
}

function finishWeld(n, pos, col, { remap, count: next }) {
  const outPos = new Float32Array(next * 3), acc = new Float64Array(next * 3), cnt = new Uint32Array(next);
  for (let i = 0; i < n; i++) {
    const o = i * 3, id = remap[i];
    if (!cnt[id]) { outPos[id * 3] = pos[o]; outPos[id * 3 + 1] = pos[o + 1]; outPos[id * 3 + 2] = pos[o + 2]; }
    acc[id * 3] += col[o]; acc[id * 3 + 1] += col[o + 1]; acc[id * 3 + 2] += col[o + 2]; cnt[id]++;
  }
  const idx = [];
  for (let t = 0; t < n; t += 3) {
    const a = remap[t], b = remap[t + 1], c = remap[t + 2];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  const outCol = new Float32Array(next * 3);
  for (let v = 0; v < next; v++) {
    const k = cnt[v] || 1;
    outCol[v * 3] = acc[v * 3] / k; outCol[v * 3 + 1] = acc[v * 3 + 1] / k; outCol[v * 3 + 2] = acc[v * 3 + 2] / k;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(outCol, 3));
  g.setIndex(next > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return g;
}
