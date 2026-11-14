import * as THREE from 'three';
import { Brush, Evaluator, ADDITION } from 'three-bvh-csg';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { weldWithColors } from './DecoImport.js';

/**
 * Fuse — merge a placed decoration into the chain link as ONE coloured solid.
 *
 * Primary path is a CSG union (three-bvh-csg ADDITION) carrying position,
 * normal AND colour, so the result is a single closed shell whose triangles
 * keep the object's colours on the object and the link's colour on the link —
 * exactly what a multi-colour slicer needs.
 *
 * CSG needs reasonably closed input. If the union throws, comes back empty, or
 * visibly lost a piece (its bounding box no longer spans both inputs), we fall
 * back to a plain merge: both shells in one mesh, overlapping. Slicers union
 * overlapping shells of one object when slicing, so that still prints as one
 * fused part — it's just not a clean single shell in the file.
 */

/** Clone keeping only position / normal / colour (Float32, rgb); fills colour if missing. */
export function solidWithColor(geo, rgb) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geo.getAttribute('position').clone());
  if (geo.index) g.setIndex(geo.index.clone());
  const n = g.getAttribute('position').count;
  const src = geo.getAttribute('color');
  const col = new Float32Array(n * 3);
  if (src) for (let i = 0; i < n; i++) { col[i * 3] = src.getX(i); col[i * 3 + 1] = src.getY(i); col[i * 3 + 2] = src.getZ(i); }
  else for (let i = 0; i < n; i++) { col[i * 3] = rgb.r; col[i * 3 + 1] = rgb.g; col[i * 3 + 2] = rgb.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function triCount(g) { return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3; }

/**
 * Close the T-junctions a CSG cut leaves behind. three-bvh-csg splits triangles
 * on each side of the intersection independently, so a vertex created on one
 * side often sits in the MIDDLE of an edge on the other side — geometrically
 * closed, topologically open (slicers report "open / non-manifold edges").
 * For every boundary edge that has such a vertex on it, split the owning
 * triangle at that vertex; repeat until nothing changes. Works on an indexed,
 * position-welded geometry in place of its index.
 */
export function fixTJunctions(geo, maxPasses = 30) {
  const P = geo.getAttribute('position').array;
  let idx = Array.from(geo.index.array);
  geo.computeBoundingBox();
  const diag = geo.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const eps = diag * 2e-5;
  for (let pass = 0; pass < maxPasses; pass++) {
    // directed edges; a boundary edge is one whose reverse is missing
    const dir = new Set();
    for (let t = 0; t < idx.length; t += 3)
      for (let e = 0; e < 3; e++) dir.add(idx[t + e] * 4294967296 + idx[t + (e + 1) % 3]);
    const bverts = new Set(), bedges = [];
    for (let t = 0; t < idx.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = idx[t + e], b = idx[t + (e + 1) % 3];
        if (!dir.has(b * 4294967296 + a)) { bverts.add(a); bverts.add(b); bedges.push(t, e); }
      }
    if (!bedges.length) break;
    // spatial hash of boundary verts
    let cell = 0;
    for (let k = 0; k < bedges.length; k += 2) {
      const t = bedges[k], e = bedges[k + 1], a = idx[t + e], b = idx[t + (e + 1) % 3];
      cell += Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    }
    cell = Math.max(cell / (bedges.length / 2), eps * 10);
    const hash = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    for (const v of bverts) {
      const k = key(Math.floor(P[v * 3] / cell), Math.floor(P[v * 3 + 1] / cell), Math.floor(P[v * 3 + 2] / cell));
      let arr = hash.get(k); if (!arr) hash.set(k, arr = []); arr.push(v);
    }
    const splitAt = new Map();      // tri start → {e, v}  (one split per triangle per pass)
    for (let k = 0; k < bedges.length; k += 2) {
      const t = bedges[k], e = bedges[k + 1];
      if (splitAt.has(t)) continue;
      const a = idx[t + e], b = idx[t + (e + 1) % 3];
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const dx = P[b * 3] - ax, dy = P[b * 3 + 1] - ay, dz = P[b * 3 + 2] - az;
      const L2 = dx * dx + dy * dy + dz * dz; if (L2 < eps * eps) continue;
      const x0 = Math.floor(Math.min(ax, ax + dx) / cell) - 1, x1 = Math.floor(Math.max(ax, ax + dx) / cell) + 1;
      const y0 = Math.floor(Math.min(ay, ay + dy) / cell) - 1, y1 = Math.floor(Math.max(ay, ay + dy) / cell) + 1;
      const z0 = Math.floor(Math.min(az, az + dz) / cell) - 1, z1 = Math.floor(Math.max(az, az + dz) / cell) + 1;
      let best = -1, bestT = 2;
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const arr = hash.get(key(x, y, z)); if (!arr) continue;
        for (const v of arr) {
          if (v === a || v === b) continue;
          const px = P[v * 3] - ax, py = P[v * 3 + 1] - ay, pz = P[v * 3 + 2] - az;
          const s = (px * dx + py * dy + pz * dz) / L2;
          if (s <= 1e-4 || s >= 1 - 1e-4) continue;
          const qx = px - s * dx, qy = py - s * dy, qz = pz - s * dz;
          if (qx * qx + qy * qy + qz * qz > eps * eps) continue;
          if (Math.abs(s - 0.5) < Math.abs(bestT - 0.5)) { best = v; bestT = s; }   // split nearest the middle first
        }
      }
      if (best >= 0) splitAt.set(t, { e, v: best });
    }
    if (!splitAt.size) break;
    const out = [];
    for (let t = 0; t < idx.length; t += 3) {
      const s = splitAt.get(t);
      if (!s) { out.push(idx[t], idx[t + 1], idx[t + 2]); continue; }
      const a = idx[t + s.e], b = idx[t + (s.e + 1) % 3], c = idx[t + (s.e + 2) % 3];
      out.push(a, s.v, c, s.v, b, c);
    }
    idx = out;
  }
  const n = geo.getAttribute('position').count;
  geo.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  return geo;
}

/** Does `box` span (almost) all of `ref` on every axis? Catches a union that silently dropped a shell. */
function spans(box, ref, tol) {
  return box.min.x <= ref.min.x + tol && box.min.y <= ref.min.y + tol && box.min.z <= ref.min.z + tol
      && box.max.x >= ref.max.x - tol && box.max.y >= ref.max.y - tol && box.max.z >= ref.max.z - tol;
}

/**
 * @param linkGeo    the link (local part frame); kept untouched
 * @param decoGeo    the decoration in its own local frame; kept untouched
 * @param decoMatrix decoration local → part frame (the gizmo's TRS)
 * @param linkColor  THREE.Color used when the link has no vertex colours
 * @param mode       'csg' (default, falls back to merge) | 'merge'
 * @returns {geo, mode:'csg'|'merge', note}
 */
export function fuseGeometries(linkGeo, decoGeo, decoMatrix, { linkColor = new THREE.Color(1, 1, 1), mode = 'csg' } = {}) {
  const A = solidWithColor(linkGeo, linkColor);
  const B = solidWithColor(decoGeo, linkColor);
  B.applyMatrix4(decoMatrix);
  if (decoMatrix.determinant() < 0) {               // mirrored placement → keep outward winding
    const idx = B.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; }
    B.computeVertexNormals();
  }
  A.computeBoundingBox(); B.computeBoundingBox();
  const ref = A.boundingBox.clone().union(B.boundingBox);
  const tol = ref.getSize(new THREE.Vector3()).length() * 0.01;

  let note = '';
  if (mode === 'csg') {
    try {
      const ev = new Evaluator();
      ev.attributes = ['position', 'normal', 'color'];
      ev.useGroups = false;
      const a = new Brush(A), b = new Brush(B);
      a.updateMatrixWorld(); b.updateMatrixWorld();
      const out = ev.evaluate(a, b, ADDITION).geometry;
      out.computeBoundingBox();
      if (triCount(out) > 0 && spans(out.boundingBox, ref, tol)) {
        // one vertex per position (colours averaged — the caller re-quantizes to its palette),
        // then stitch the seam so the union is a single closed shell
        const welded = weldWithColors(out.getAttribute('position').array, out.getAttribute('color').array, tol * 1e-3);
        out.dispose(); A.dispose(); B.dispose();
        fixTJunctions(welded);
        welded.computeVertexNormals();
        return { geo: welded, mode: 'csg', note };
      }
      note = 'boolean union lost part of the shape (open / non-manifold input?) — merged the shells instead';
    } catch (e) {
      note = 'boolean union failed (' + (e.message || e) + ') — merged the shells instead';
    }
  }
  const merged = BufferGeometryUtils.mergeGeometries([A.index ? A.toNonIndexed() : A, B.index ? B.toNonIndexed() : B], false);
  A.dispose(); B.dispose();
  merged.computeVertexNormals();
  return { geo: merged, mode: 'merge', note };
}
