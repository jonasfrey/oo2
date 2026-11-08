import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Repair common sculpt artefacts. Returns a NEW geometry (vertex count/order change),
 * so the caller must rebuild the BVH and re-derive the mirror seam afterwards.
 *
 * Steps (each optional):
 *  - removeDegenerate: drop zero-area triangles (collapsed verts from heavy smoothing).
 *      LIMIT: only removes exactly-degenerate tris by an area threshold; doesn't fix
 *      self-intersections or non-manifold edges.
 *  - weld: merge coincident vertices (BufferGeometryUtils.mergeVertices) so shading
 *      and topology are clean. LIMIT: positional weld only; intentional seams within
 *      tolerance get merged too.
 *  - recomputeNormals: refresh vertex normals.
 *  - closeHoles: NOT implemented — robust hole filling needs boundary-loop extraction
 *      + triangulation; for this pipeline the cheaper guarantee is "never open holes"
 *      (in-place sculpting can't) or a voxel remesh. See Voxelizer.js.
 */
export function repairGeometry(src, {
  removeDegenerate = true, weld = true, recomputeNormals = true, tolerance = 1e-4, areaEps = 1e-10,
} = {}) {
  let g = src.toNonIndexed();              // work on a flat triangle soup, then re-weld

  if (removeDegenerate) g = dropDegenerate(g, areaEps);

  // keep position + color; uvs/normals are regenerated/irrelevant for this pipeline
  const bare = new THREE.BufferGeometry();
  bare.setAttribute('position', g.getAttribute('position').clone());
  if (g.getAttribute('color')) bare.setAttribute('color', g.getAttribute('color').clone());

  const out = weld ? BufferGeometryUtils.mergeVertices(bare, tolerance) : bare;
  if (recomputeNormals) out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function dropDegenerate(g, areaEps) {
  const pos = g.getAttribute('position');
  const col = g.getAttribute('color');
  const keepPos = [], keepCol = col ? [] : null;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    ab.subVectors(b, a); ac.subVectors(c, a);
    const area2 = ab.cross(ac).lengthSq();         // (2*area)^2
    if (area2 <= areaEps) continue;                // zero-area → skip whole triangle
    for (let k = 0; k < 3; k++) {
      keepPos.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      if (keepCol) keepCol.push(col.getX(i + k), col.getY(i + k), col.getZ(i + k));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keepPos, 3));
  if (keepCol) out.setAttribute('color', new THREE.Float32BufferAttribute(keepCol, 3));
  return out;
}
