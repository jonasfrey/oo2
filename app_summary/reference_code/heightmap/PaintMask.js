/**
 * PaintMask — Part 3: the per-vertex gate (0..1) that says how much displacement
 * each vertex receives. The brush accumulates into it smoothly so repeated
 * strokes blend, and erase subtracts. Because displacement is always rebuilt as
 * base + height*strength*mask (see DisplacementController), the mask is the only
 * thing that needs to be soft for the result to feather to zero with no seams.
 */
export class PaintMask {
  constructor(count = 0) {
    this.values = new Float32Array(count);
  }

  resize(count) {
    if (this.values.length !== count) this.values = new Float32Array(count);
    else this.values.fill(0);
  }

  clear() { this.values.fill(0); }

  /**
   * Accumulate one brush stamp over `indices`. `weightFn(i)` returns the radial
   * falloff 0..1 for vertex i (Brush.weight of its distance to the cursor).
   *   flow   — per-stamp gain (brush strength/flow).
   *   erase  — subtract instead of add.
   * Additive-with-clamp: mask stays in [0,1] no matter how many strokes overlap.
   */
  stamp(indices, weightFn, flow, erase) {
    const m = this.values, sign = erase ? -1 : 1;
    for (const i of indices) {
      const w = weightFn(i);
      if (w <= 0) continue;
      let nv = m[i] + sign * flow * w;
      m[i] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
    }
  }

  /**
   * Optional Laplacian blur of the mask for extra-soft transitions. `adjacency`
   * is the per-vertex neighbour list the controller already builds. Operates only
   * on `indices` (the stroke region) when given, else the whole mask.
   */
  blur(adjacency, amount = 0.5, iterations = 1, indices = null) {
    const m = this.values;
    const list = indices || range(m.length);
    for (let it = 0; it < iterations; it++) {
      const snapshot = m.slice();
      for (const i of list) {
        const nb = adjacency[i];
        if (!nb || nb.length === 0) continue;
        let avg = 0;
        for (let k = 0; k < nb.length; k++) avg += snapshot[nb[k]];
        avg /= nb.length;
        m[i] = snapshot[i] + (avg - snapshot[i]) * amount;
      }
    }
  }
}

function range(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; return a; }
