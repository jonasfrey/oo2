import * as THREE from 'three';
import { CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';
import { Brush, BRUSH } from './Brush.js';
import { MirrorHelper } from './MirrorHelper.js';

const _ndc = new THREE.Vector2();
const _sphere = new THREE.Sphere();
const _v0 = new THREE.Vector3(), _v1 = new THREE.Vector3(), _avg = new THREE.Vector3();
const _center2 = new THREE.Vector3(), _bn2 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _zUp = new THREE.Vector3(0, 0, 1);

const LIVE_NORMAL_LIMIT = 40000; // above this vert count, recompute normals on pointerup only

/**
 * Minimal symmetric sculpt brush over an existing welded/indexed mesh + shared
 * BVH-accelerated raycaster. Mode: left-drag sculpts, right/middle-drag orbits,
 * Alt+left-drag orbits. Mirroring = "stamp the brush at the cursor AND its
 * plane-reflection" (no correspondence map, single mesh preserved).
 */
export class SculptController {
  constructor({ scene, camera, renderer, controls, raycaster }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.raycaster = raycaster;          // reuse the app's accelerated, firstHitOnly raycaster

    this.mesh = null;
    this.geometry = null;
    this.adjacency = null;               // [vertIndex] -> Int32Array of neighbour vertex indices
    this.brush = new Brush();
    this.mirror = { enabled: true, helper: new MirrorHelper(), seam: [], keepSeamOnPlane: true, eps: 1e-3 };

    this.active = false;
    this.painting = false;
    this._found = new Set();
    this._dirtyNormals = false;

    this.onStrokeStart = null;            // () => void, fired once when a left-drag stroke begins
    this.onStrokeEnd = null;              // () => void, fired on pointerup (used for undo snapshots)

    this._cursor = this._makeCursor();
    this.scene.add(this._cursor);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  // ---- lifecycle -----------------------------------------------------------
  attach(mesh) {
    this.mesh = mesh;
    this.geometry = mesh.geometry;
    if (!this.geometry.boundsTree) this.geometry.computeBoundsTree();
    if (!this.geometry.attributes.normal) this.geometry.computeVertexNormals();
    this._buildAdjacency();
    if (this.mirror.enabled) this._refreshSeam();
  }

  enable() {
    if (this.active) return;
    this.active = true;
    const el = this.renderer.domElement;
    // capture phase so we can pre-empt OrbitControls when a left-drag is a sculpt stroke
    el.addEventListener('pointerdown', this._onDown, true);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.painting = false;
    this.controls.enabled = true;
    this._cursor.visible = false;
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onDown, true);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    if (this._dirtyNormals) { this.geometry.computeVertexNormals(); this._dirtyNormals = false; }
    if (this.geometry) { this.geometry.computeBoundingBox(); this.geometry.computeBoundingSphere(); }
  }

  setMirror(point, normal, enabled = true) {
    this.mirror.enabled = enabled;
    this.mirror.helper.set(point, normal);
    if (enabled && this.geometry) this._refreshSeam();
  }

  dispose() {
    this.disable();
    this.scene.remove(this._cursor);
    this._cursor.geometry.dispose();
    this._cursor.material.dispose();
  }

  // ---- pointer handlers ----------------------------------------------------
  _onDown(ev) {
    if (!this.active || ev.button !== 0 || ev.altKey) return; // left-only, Alt = orbit override
    const hit = this._ray(ev);
    if (!hit) return;
    this.painting = true;
    this.controls.enabled = false;                 // beat OrbitControls' own pointerdown
    this.renderer.domElement.setPointerCapture?.(ev.pointerId);
    ev.stopPropagation();
    ev.preventDefault();
    this.onStrokeStart?.();                         // snapshot the pre-stroke state for undo
    this._apply(hit);
  }

  _onMove(ev) {
    if (!this.active) return;
    const hit = this._ray(ev);
    this._updateCursor(hit);
    if (this.painting && hit) this._apply(hit);
  }

  _onUp() {
    if (!this.painting) return;
    this.painting = false;
    this.controls.enabled = true;
    if (this._dirtyNormals) { this.geometry.computeVertexNormals(); this._dirtyNormals = false; }
    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
    this.onStrokeEnd?.();                           // commit the stroke to the undo history
  }

  // ---- raycast + cursor ----------------------------------------------------
  _ray(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(_ndc, this.camera);
    return this.raycaster.intersectObject(this.mesh, false)[0] || null;
  }

  _makeCursor() {
    const g = new THREE.TorusGeometry(1, 0.025, 8, 48); // unit ring, scaled to radius at runtime
    const m = new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.9, depthTest: false });
    const ring = new THREE.Mesh(g, m);
    ring.renderOrder = 999;
    ring.visible = false;
    return ring;
  }

  _updateCursor(hit) {
    if (!hit) { this._cursor.visible = false; return; }
    this._cursor.visible = true;
    this._cursor.position.copy(hit.point);
    _q.setFromUnitVectors(_zUp, hit.face.normal.clone().normalize()); // ring lies flat on the surface
    this._cursor.quaternion.copy(_q);
    this._cursor.scale.setScalar(this.brush.radius);
  }

  // ---- the stroke ----------------------------------------------------------
  _apply(hit) {
    const center = hit.point;
    const faceN = hit.face.normal; // local space == world (part matrix is identity)
    let changed = this._stamp(center, faceN);

    if (this.mirror.enabled) {
      const mc = this.mirror.helper.reflectPoint(center, _center2);
      const mn = this.mirror.helper.reflectDir(faceN, _bn2);
      // skip the mirror stamp when the cursor sits on the plane (avoids double-hitting the seam)
      if (mc.distanceToSquared(center) > (this.brush.radius * 0.04) ** 2)
        changed = this._stamp(mc, mn) || changed;
    }

    if (!changed) return;
    if (this.mirror.enabled && this.mirror.keepSeamOnPlane) this._snapSeam();
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.boundsTree.refit();                      // keep the cursor raycast accurate mid-stroke
    if (this.geometry.attributes.position.count <= LIVE_NORMAL_LIMIT) this.geometry.computeVertexNormals();
    else this._dirtyNormals = true;                        // big mesh: defer to pointerup
  }

  /** apply one brush stamp at `center`; returns true if anything moved. */
  _stamp(center, faceN) {
    const set = this._found;
    set.clear();
    this._collect(center, this.brush.radius, set);
    if (set.size === 0) return false;

    const pos = this.geometry.attributes.position;
    const nor = this.geometry.attributes.normal;
    const str = this.brush.strength;

    if (this.brush.type === BRUSH.SMOOTH) {
      // compute targets against the pre-move state, then write (so neighbours don't cascade)
      const writes = [];
      for (const i of set) {
        _v0.fromBufferAttribute(pos, i);
        const w = this.brush.weight(center.distanceTo(_v0));
        if (w <= 0) continue;
        const nb = this.adjacency[i];
        if (!nb || nb.length === 0) continue;
        _avg.set(0, 0, 0);
        for (let k = 0; k < nb.length; k++) { const j = nb[k]; _avg.x += pos.getX(j); _avg.y += pos.getY(j); _avg.z += pos.getZ(j); }
        _avg.multiplyScalar(1 / nb.length);
        const t = w * str;
        writes.push(i, _v0.x + (_avg.x - _v0.x) * t, _v0.y + (_avg.y - _v0.y) * t, _v0.z + (_avg.z - _v0.z) * t);
      }
      for (let k = 0; k < writes.length; k += 4) pos.setXYZ(writes[k], writes[k + 1], writes[k + 2], writes[k + 3]);
      return writes.length > 0;
    }

    // draw / carve: push along each vertex's own normal
    const sign = this.brush.type === BRUSH.CARVE ? -1 : 1;
    const unit = this.brush.radius * 0.12;     // displacement scale per stamp, radius-relative
    let moved = false;
    for (const i of set) {
      _v0.fromBufferAttribute(pos, i);
      _v1.fromBufferAttribute(nor, i);
      if (faceN && _v1.dot(faceN) <= 0) continue;        // front-facing filter (skip the far wall)
      const w = this.brush.weight(center.distanceTo(_v0));
      if (w <= 0) continue;
      const amt = sign * str * w * unit;
      pos.setXYZ(i, _v0.x + _v1.x * amt, _v0.y + _v1.y * amt, _v0.z + _v1.z * amt);
      moved = true;
    }
    return moved;
  }

  /** gather vertex indices within `radius` of `center` via the BVH. */
  _collect(center, radius, out) {
    const geom = this.geometry, bvh = geom.boundsTree, index = geom.index, pos = geom.attributes.position;
    _sphere.set(center, radius);
    const r2 = radius * radius;
    bvh.shapecast({
      intersectsBounds: (box) => {
        if (!_sphere.intersectsBox(box)) return NOT_INTERSECTED;
        // is the box fully inside the sphere? (farthest corner within radius) -> accept all tris
        const { min, max } = box;
        let d = 0;
        d += Math.max((center.x - min.x) ** 2, (center.x - max.x) ** 2);
        d += Math.max((center.y - min.y) ** 2, (center.y - max.y) ** 2);
        d += Math.max((center.z - min.z) ** 2, (center.z - max.z) ** 2);
        return d <= r2 ? CONTAINED : INTERSECTED;
      },
      intersectsTriangle: (tri, triIndex, contained) => {
        const i3 = triIndex * 3;
        for (let c = 0; c < 3; c++) {
          const vi = index ? index.getX(i3 + c) : i3 + c;
          if (contained) { out.add(vi); continue; }
          _v0.fromBufferAttribute(pos, vi);
          if (center.distanceToSquared(_v0) <= r2) out.add(vi);
        }
        return false; // keep traversing
      },
    });
  }

  _snapSeam() {
    const pos = this.geometry.attributes.position, h = this.mirror.helper;
    for (const i of this.mirror.seam) {
      _v0.fromBufferAttribute(pos, i);
      const d = h.signedDistance(_v0);
      pos.setXYZ(i, _v0.x - h.normal.x * d, _v0.y - h.normal.y * d, _v0.z - h.normal.z * d);
    }
  }

  _refreshSeam() {
    this.mirror.seam = this.mirror.helper.collectSeam(this.geometry, this.mirror.eps);
  }

  _buildAdjacency() {
    const geom = this.geometry, index = geom.index, pos = geom.attributes.position;
    const n = pos.count;
    const sets = Array.from({ length: n }, () => new Set());
    const get = index ? (k) => index.getX(k) : (k) => k;
    const triCount = index ? index.count : pos.count;
    for (let i = 0; i < triCount; i += 3) {
      const a = get(i), b = get(i + 1), c = get(i + 2);
      sets[a].add(b); sets[a].add(c);
      sets[b].add(a); sets[b].add(c);
      sets[c].add(a); sets[c].add(b);
    }
    this.adjacency = sets.map((s) => Int32Array.from(s));
  }
}
