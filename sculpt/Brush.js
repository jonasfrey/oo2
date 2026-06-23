import * as THREE from 'three';

export const BRUSH = { DRAW: 'draw', CARVE: 'carve', SMOOTH: 'smooth' };

/**
 * Holds brush parameters and the radial falloff. The per-vertex deformation math
 * lives in SculptController (it needs the gathered verts + adjacency); this keeps
 * the tunables and the falloff curve in one obvious place.
 */
export class Brush {
  constructor({ type = BRUSH.DRAW, radius = 8, strength = 0.5, falloff = 'smooth' } = {}) {
    this.type = type;
    this.radius = radius;     // model units (mm here)
    this.strength = strength; // 0..1
    this.falloff = falloff;   // 'smooth' | 'linear' | 'constant'
  }

  /** weight at distance `d` from the brush center: 1 at center, 0 at the rim. */
  weight(d) {
    const t = THREE.MathUtils.clamp(d / this.radius, 0, 1);
    if (this.falloff === 'constant') return 1;
    if (this.falloff === 'linear') return 1 - t;
    const u = 1 - t * t;            // smooth bump, C1 at the rim
    return u * u;
  }
}
