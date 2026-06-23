import * as THREE from 'three';
import { CONTAINED, INTERSECTED, NOT_INTERSECTED } from 'three-mesh-bvh';
import { Brush } from '../sculpt/Brush.js';
import { HeightmapProjector } from './HeightmapProjector.js';
import { PaintMask } from './PaintMask.js';

const _ndc = new THREE.Vector2();
const _sphere = new THREE.Sphere();
const _v0 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion(), _zUp = new THREE.Vector3(0, 0, 1);

const LIVE_NORMAL_LIMIT = 40000; // above this vert count, recompute normals on pointerup only

/**
 * DisplacementController — Part 3 glue. Same interaction contract as
 * SculptController (capture-phase pointerdown beats OrbitControls, Alt = orbit,
 * BVH gather, torus cursor), but instead of moving verts directly it paints a
 * PaintMask and re-derives every affected vertex as:
 *
 *     position = base + direction * heightSample * strength * mask
 *
 * Re-displacing from the stored REST positions (never from the current ones) is
 * what keeps it stable: changing the image, strength, direction, or mask just
 * recomputes from base, so nothing compounds and the edges always feather to 0
 * wherever the mask is 0.
 */
export class DisplacementController {
  constructor({ scene, camera, renderer, controls, raycaster }) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;
    this.raycaster = raycaster;           // reuse the app's accelerated, firstHitOnly raycaster

    this.mesh = null;
    this.geometry = null;
    this.base = null;                     // Float32Array, rest positions (snapshot on attach)
    this.baseNormal = null;               // Float32Array, rest normals (stable 'normal' direction)
    this.adjacency = null;                // [vert] -> Int32Array neighbours (for mask blur)
    this.heights = null;                  // Float32Array, sampled height 0..1 per vertex

    this.projector = new HeightmapProjector();
    this.mask = new PaintMask();
    this.brush = new Brush({ radius: 8, strength: 0.6, falloff: 'smooth' }); // radius + falloff curve
    this.strength = 4;                    // global displacement amount in model units (mm)
    this.direction = 'normal';            // 'normal' | 'axis'
    this.erase = false;

    this.active = false;
    this.painting = false;
    this._found = new Set();
    this._dirtyNormals = false;

    this._cursor = this._makeCursor();
    this.scene.add(this._cursor);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  // ---- lifecycle -----------------------------------------------------------
  attach(mesh, { camera } = {}) {
    this.mesh = mesh;
    this.geometry = mesh.geometry;
    const g = this.geometry;
    if (!g.boundsTree) g.computeBoundsTree();
    if (!g.attributes.normal) g.computeVertexNormals();

    // snapshot rest state — every redisplace reads from these, never from live verts
    this.base = g.attributes.position.array.slice();
    this.baseNormal = g.attributes.normal.array.slice();

    this._buildAdjacency();
    this.mask.resize(g.attributes.position.count);

    // default mapping: use UVs if the mesh actually has them, else planar
    this.projector.mode = g.attributes.uv ? 'uv' : 'planar';
    this.projector.buildCoords(g, this.base, { camera: camera || this.camera });
    this.heights = this.projector.sampleAll(this.heights);
    this.redisplaceAll();
  }

  enable() {
    if (this.active) return;
    this.active = true;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._onDown, true); // capture: pre-empt OrbitControls
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
    this._finishNormals();
  }

  dispose() {
    this.disable();
    this.scene.remove(this._cursor);
    this._cursor.geometry.dispose();
    this._cursor.material.dispose();
  }

  // ---- public setters (each just re-derives from base; nothing compounds) ----

  /** New processed height buffer from HeightmapEditor. */
  setHeightBuffer(buffer, width, height) {
    this.projector.setBuffer(buffer, width, height);
    this.heights = this.projector.sampleAll(this.heights);
    this.redisplaceAll();
  }

  /** Change mapping mode/axis -> rebuild coords, resample, redisplace. */
  setMapping({ mode, axis } = {}) {
    if (mode) this.projector.mode = mode;
    if (axis) this.projector.axis = axis;
    this.projector.buildCoords(this.geometry, this.base, { camera: this.camera });
    this.heights = this.projector.sampleAll(this.heights);
    this.redisplaceAll();
  }

  setStrength(v) { this.strength = v; this.redisplaceAll(); }
  setDirection(mode) { this.direction = mode; this.redisplaceAll(); }

  clearMask() { this.mask.clear(); this.redisplaceAll(); }

  /** Blur the whole mask for extra-soft falloff, then rebuild. */
  smoothMask(amount = 0.5, iterations = 1) {
    this.mask.blur(this.adjacency, amount, iterations);
    this.redisplaceAll();
  }

  // ---- pointer handlers (mirrors SculptController) -------------------------
  _onDown(ev) {
    if (!this.active || ev.button !== 0 || ev.altKey) return; // left-only; Alt = orbit override
    const hit = this._ray(ev);
    if (!hit) return;
    this.painting = true;
    this.controls.enabled = false;                            // beat OrbitControls' pointerdown
    this.renderer.domElement.setPointerCapture?.(ev.pointerId);
    ev.stopPropagation(); ev.preventDefault();
    this._stamp(hit.point);
  }

  _onMove(ev) {
    if (!this.active) return;
    const hit = this._ray(ev);
    this._updateCursor(hit);
    if (this.painting && hit) this._stamp(hit.point);
  }

  _onUp() {
    if (!this.painting) return;
    this.painting = false;
    this.controls.enabled = true;
    this._finishNormals();
  }

  // ---- the stroke ----------------------------------------------------------
  _stamp(center) {
    const set = this._found;
    set.clear();
    this._collect(center, this.brush.radius, set);
    if (set.size === 0) return;

    // radial falloff weight by distance from the cursor (reuses Brush.weight curve);
    // measure against the LIVE position so the brush feels attached to the surface
    const px = this.geometry.attributes.position;
    const weightFn = (i) => {
      _v0.set(px.getX(i), px.getY(i), px.getZ(i));
      return this.brush.weight(center.distanceTo(_v0));
    };
    this.mask.stamp(set, weightFn, this.brush.strength, this.erase);

    // only the touched verts changed -> redisplace just those
    this.redisplaceVerts(set);

    const pos = this.geometry.attributes.position;
    pos.needsUpdate = true;
    this.geometry.boundsTree.refit();                          // keep mid-stroke raycast accurate
    if (pos.count <= LIVE_NORMAL_LIMIT) this.geometry.computeVertexNormals();
    else this._dirtyNormals = true;                            // big mesh: defer to pointerup
  }

  // ---- displacement core ---------------------------------------------------

  /** position[i] = base[i] + dir[i] * height[i] * strength * mask[i]. */
  _displaceOne(i, pos) {
    const m = this.mask.values[i];
    const amt = this.heights[i] * this.strength * m;
    if (this.direction === 'axis') this.projector.axisVector(_dir);
    else _dir.set(this.baseNormal[i * 3], this.baseNormal[i * 3 + 1], this.baseNormal[i * 3 + 2]);
    pos.setXYZ(i,
      this.base[i * 3]     + _dir.x * amt,
      this.base[i * 3 + 1] + _dir.y * amt,
      this.base[i * 3 + 2] + _dir.z * amt);
  }

  redisplaceVerts(indices) {
    const pos = this.geometry.attributes.position;
    for (const i of indices) this._displaceOne(i, pos);
  }

  /** Full rebuild — used on any param/image/mask change. */
  redisplaceAll() {
    if (!this.geometry) return;
    const pos = this.geometry.attributes.position;
    const n = pos.count;
    for (let i = 0; i < n; i++) this._displaceOne(i, pos);
    pos.needsUpdate = true;
    this.geometry.boundsTree?.refit();
    if (n <= LIVE_NORMAL_LIMIT) this.geometry.computeVertexNormals();
    else this._dirtyNormals = true;
  }

  _finishNormals() {
    if (this._dirtyNormals) { this.geometry.computeVertexNormals(); this._dirtyNormals = false; }
    if (this.geometry) { this.geometry.computeBoundingBox(); this.geometry.computeBoundingSphere(); }
  }

  // ---- raycast + cursor (copied contract from SculptController) -------------
  _ray(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(_ndc, this.camera);
    return this.raycaster.intersectObject(this.mesh, false)[0] || null;
  }

  _makeCursor() {
    const g = new THREE.TorusGeometry(1, 0.025, 8, 48);
    const m = new THREE.MeshBasicMaterial({ color: 0xffc24c, transparent: true, opacity: 0.9, depthTest: false });
    const ring = new THREE.Mesh(g, m);
    ring.renderOrder = 999;
    ring.visible = false;
    return ring;
  }

  _updateCursor(hit) {
    if (!hit) { this._cursor.visible = false; return; }
    this._cursor.visible = true;
    this._cursor.position.copy(hit.point);
    _q.setFromUnitVectors(_zUp, hit.face.normal.clone().normalize());
    this._cursor.quaternion.copy(_q);
    this._cursor.scale.setScalar(this.brush.radius);
    this._cursor.material.color.set(this.erase ? 0xff5a5a : 0xffc24c); // red = erase
  }

  // ---- BVH vertex gather (same approach as SculptController._collect) -------
  _collect(center, radius, out) {
    const geom = this.geometry, bvh = geom.boundsTree, index = geom.index, pos = geom.attributes.position;
    _sphere.set(center, radius);
    const r2 = radius * radius;
    bvh.shapecast({
      intersectsBounds: (box) => {
        if (!_sphere.intersectsBox(box)) return NOT_INTERSECTED;
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
        return false;
      },
    });
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
