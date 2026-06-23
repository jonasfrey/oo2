import * as THREE from 'three';

/**
 * HeightmapProjector — Part 2: decide where each vertex reads the heightmap, and
 * which way it gets pushed.
 *
 * It precomputes a per-vertex (u,v) in [0,1] ONCE (from the rest positions or the
 * mesh UVs), so re-sampling after an image tweak is just a bilinear lookup per
 * vertex — no re-projection. `sampleAll()` returns a Float32Array of heights 0..1.
 *
 * Mapping modes:
 *   'uv'     — use geometry.attributes.uv (only if present & meaningful).
 *   'planar' — orthographic projection from an axis (+x/+y/+z). Simple and robust
 *              for arbitrary meshes; the two axes perpendicular to `axis` become
 *              (u,v), normalized by the mesh bounding box. RECOMMENDED default.
 *   'camera' — project rest positions through a frozen camera matrix ("decal from
 *              this view"). Good for stamping relief from where you're looking.
 *
 * Displacement direction is chosen separately (see DisplacementController):
 *   'normal' pushes along each vertex normal; 'axis' pushes along the projection
 *   axis (cleaner, self-non-intersecting relief, like a stamped emboss).
 */
export class HeightmapProjector {
  constructor() {
    this.mode = 'planar';
    this.axis = 'z';                 // for 'planar' / default 'axis' direction
    this.wrap = false;               // clamp (false) vs repeat (true) at buffer edges
    this.uv = null;                  // Float32Array(vertCount*2), the baked sample coords
    this.buffer = null;              // Float32Array height 0..1
    this.bw = 0; this.bh = 0;        // buffer dimensions
  }

  setBuffer(buffer, width, height) {
    this.buffer = buffer; this.bw = width; this.bh = height;
  }

  /**
   * Bake per-vertex (u,v) from rest positions. Call on attach and whenever the
   * mode/axis changes. `basePositions` is a Float32Array of the rest geometry.
   */
  buildCoords(geometry, basePositions, { camera } = {}) {
    const n = geometry.attributes.position.count;
    const uv = new Float32Array(n * 2);

    if (this.mode === 'uv' && geometry.attributes.uv) {
      const a = geometry.attributes.uv.array;
      uv.set(a.subarray(0, n * 2));
    } else if (this.mode === 'camera' && camera) {
      const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.set(basePositions[i * 3], basePositions[i * 3 + 1], basePositions[i * 3 + 2]).applyMatrix4(m);
        uv[i * 2] = v.x * 0.5 + 0.5;        // NDC -> [0,1]
        uv[i * 2 + 1] = v.y * 0.5 + 0.5;
      }
    } else {
      // planar: pick the two axes perpendicular to `axis`, normalize by bbox
      const [ui, vi] = PLANAR_AXES[this.axis];
      const box = bboxOf(basePositions, n);
      const min = box.min, size = box.max.clone().sub(box.min);
      const su = size.getComponent(ui) || 1, sv = size.getComponent(vi) || 1;
      for (let i = 0; i < n; i++) {
        uv[i * 2] = (basePositions[i * 3 + ui] - min.getComponent(ui)) / su;
        uv[i * 2 + 1] = (basePositions[i * 3 + vi] - min.getComponent(vi)) / sv;
      }
    }
    this.uv = uv;
    return uv;
  }

  /** Heights for every vertex: bilinear sample of the buffer at the baked (u,v). */
  sampleAll(out) {
    const n = this.uv.length / 2;
    const res = out && out.length === n ? out : new Float32Array(n);
    if (!this.buffer) { res.fill(0); return res; }
    for (let i = 0; i < n; i++) res[i] = this.sample(this.uv[i * 2], this.uv[i * 2 + 1]);
    return res;
  }

  /** Bilinear buffer lookup at (u,v) in [0,1], with clamp or repeat. */
  sample(u, v) {
    const W = this.bw, H = this.bh, b = this.buffer;
    u = this.wrap ? u - Math.floor(u) : (u < 0 ? 0 : u > 1 ? 1 : u);
    v = this.wrap ? v - Math.floor(v) : (v < 0 ? 0 : v > 1 ? 1 : v);
    const x = u * (W - 1), y = v * (H - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = b[y0 * W + x0], c = b[y0 * W + x1], d = b[y1 * W + x0], e = b[y1 * W + x1];
    return a * (1 - fx) * (1 - fy) + c * fx * (1 - fy) + d * (1 - fx) * fy + e * fx * fy;
  }

  /** Unit displacement axis for direction='axis'. */
  axisVector(out = new THREE.Vector3()) {
    return out.set(this.axis === 'x' ? 1 : 0, this.axis === 'y' ? 1 : 0, this.axis === 'z' ? 1 : 0);
  }
}

// for a given projection axis, which position components become (u, v)
const PLANAR_AXES = { x: [1, 2], y: [0, 2], z: [0, 1] }; // 0=x 1=y 2=z

function bboxOf(arr, n) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < n; i++) {
    const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
    if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
    if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
  }
  return { min, max };
}
