import * as THREE from 'three';

const _v = new THREE.Vector3();

/**
 * A reflection plane in the GEOMETRY'S LOCAL space (which, for S.partMesh, equals
 * world space because the part's matrix is baked to identity).
 * Plane = { point, unit normal }. Provides the reflect/side/project primitives the
 * brush-mirroring strategy needs. The correspondence map (strategy "a") is optional.
 */
export class MirrorHelper {
  constructor(point = new THREE.Vector3(), normal = new THREE.Vector3(1, 0, 0)) {
    this.point = point.clone();
    this.normal = normal.clone().normalize();
  }

  set(point, normal) {
    this.point.copy(point);
    this.normal.copy(normal).normalize();
    return this;
  }

  /** signed distance of a point to the plane (>0 = on +normal side). */
  signedDistance(p) { return _v.copy(p).sub(this.point).dot(this.normal); }

  /** reflect a position across the plane. */
  reflectPoint(p, out = new THREE.Vector3()) {
    const d = out.copy(p).sub(this.point).dot(this.normal);
    return out.copy(p).addScaledVector(this.normal, -2 * d);
  }

  /** reflect a direction/normal across the plane (no translation). */
  reflectDir(dir, out = new THREE.Vector3()) {
    const d = dir.dot(this.normal);
    return out.copy(dir).addScaledVector(this.normal, -2 * d);
  }

  /** indices of vertices that lie on the plane (the symmetry seam). */
  collectSeam(geometry, eps) {
    const pos = geometry.attributes.position, out = [];
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      if (Math.abs(this.signedDistance(_v)) <= eps) out.push(i);
    }
    return out;
  }

  /**
   * OPTIONAL — strategy (a): build a vertex<->mirror-vertex map by hashing reflected
   * positions. Returns Int32Array (index -> mirror index, or -1 if no partner).
   * Not used by the default brush-mirroring path; here if you want exact mode.
   */
  buildCorrespondence(geometry, eps = 1e-3) {
    const pos = geometry.attributes.position, n = pos.count, inv = 1 / eps;
    const key = (x, y, z) => `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, i);
      const k = key(_v.x, _v.y, _v.z);
      let a = buckets.get(k); if (!a) { a = []; buckets.set(k, a); } a.push(i);
    }
    const map = new Int32Array(n).fill(-1), r = new THREE.Vector3(), w = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      _v.fromBufferAttribute(pos, i);
      if (Math.abs(this.signedDistance(_v)) <= eps) { map[i] = i; continue; }
      this.reflectPoint(_v, r);
      const cx = Math.round(r.x * inv), cy = Math.round(r.y * inv), cz = Math.round(r.z * inv);
      let best = -1, bestD = (eps * 3) ** 2;
      for (let dx = -1; dx <= 1 && best < 0; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const a = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`); if (!a) continue;
        for (const j of a) {
          if (j === i) continue;
          w.fromBufferAttribute(pos, j);
          const d = w.distanceToSquared(r);
          if (d < bestD) { bestD = d; best = j; }
        }
      }
      map[i] = best;
    }
    return map;
  }
}
