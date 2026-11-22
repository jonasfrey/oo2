import * as THREE from 'three';

/**
 * TransformGizmo — one combined move / rotate / scale handle set, in the spirit
 * of Nomad Sculpt's gizmo: every operation is available at once, no mode
 * switching.
 *
 *   arrows  (x/y/z)      drag → move along that axis
 *   rings   (x/y/z)      drag → rotate about that axis
 *   cubes   on the shafts drag → scale along that (local) axis
 *   centre ball          drag → move freely in the view plane
 *   outer white ring     drag → scale uniformly
 *
 * Hold Shift while dragging to snap (1 mm · 15° · 0.05×). `space` = 'local'
 * aligns the handles with the object's own rotation; 'world' keeps them on the
 * plate axes (per-axis scale cubes are hidden there — a world-axis stretch of a
 * rotated object would be a shear, which a position/rotation/scale can't hold).
 *
 * `handles` picks the kinds to build ('move', 'rotate', 'scale', 'free', 'uniform'; default: all) — a thing that can
 * only be moved and turned gets a gizmo without the scale handles.
 *
 * Interaction contract matches the sculpt/heightmap controllers: a capture-phase
 * pointerdown on the canvas disables OrbitControls before it sees the event, so
 * grabbing a handle never also orbits the camera. Call update() once per frame.
 */

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const COLORS = { x: 0xff4d5e, y: 0x6ee05a, z: 0x4f8dff, free: 0xf2f4f7, uniform: 0xc9d1db, hover: 0xffd84a };
const RING_R = 0.72, UNIFORM_R = 1.22, SCALE_AT = 0.5;
const PRIORITY = { free: 0, scale: 1, move: 2, rotate: 3, uniform: 4 };

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _ndc = new THREE.Vector2(), _plane = new THREE.Plane(), _hit = new THREE.Vector3();

function handleMat(color) {
  return new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95, toneMapped: false });
}
const PICK_MAT = new THREE.MeshBasicMaterial({ visible: false });

// geometry built along +Y, then turned onto the requested axis
function toAxis(geo, axis) {
  if (axis === 'x') geo.rotateZ(-Math.PI / 2);
  else if (axis === 'z') geo.rotateX(Math.PI / 2);
  return geo;
}
// torus lies in XY (normal +Z) — turn its normal onto the axis
function ringToAxis(geo, axis) {
  if (axis === 'x') geo.rotateY(Math.PI / 2);
  else if (axis === 'y') geo.rotateX(Math.PI / 2);
  return geo;
}

export class TransformGizmo {
  constructor({ scene, camera, renderer, controls, handles = null }) {
    this.kinds = handles ? new Set(handles) : null;   // null: every kind
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.controls = controls;

    this.object = null;
    this.space = 'local';           // 'local' | 'world'
    this.size = 0.16;               // gizmo radius as a fraction of the view half-height
    this.snapMove = 1;              // mm
    this.snapAngle = Math.PI / 12;  // 15°
    this.snapScale = 0.05;
    this.snap = false;              // always snap (Shift snaps too)
    this.minScale = 0.01;

    this.onDragStart = null;        // (kind, axis) => void
    this.onChange = null;           // () => void, every pointer move while dragging
    this.onDragEnd = null;          // () => void

    this.active = false;
    this.drag = null;
    this.hovered = null;
    this.handles = [];              // {kind, axis, visuals:[Mesh], picker:Mesh, color}
    this._ray = new THREE.Raycaster();

    this.root = new THREE.Group();
    this.root.visible = false;
    this.root.renderOrder = 1000;
    this._billboard = new THREE.Group();   // holds the uniform-scale ring, turned to face the camera
    this.root.add(this._billboard);
    this._build();
    scene.add(this.root);

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  get dragging() { return !!this.drag; }

  // ---- lifecycle -----------------------------------------------------------
  attach(object) { this.object = object; this.root.visible = !!object && this.active; this.update(); }
  detach() { this.object = null; this.root.visible = false; this._setHover(null); }

  enable() {
    if (this.active) return;
    this.active = true;
    this.root.visible = !!this.object;
    this.renderer.domElement.addEventListener('pointerdown', this._onDown, true);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
  }

  disable() {
    if (!this.active) return;
    if (this.drag) this._end();
    this.active = false;
    this.root.visible = false;
    this._setHover(null);
    this.renderer.domElement.removeEventListener('pointerdown', this._onDown, true);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
  }

  setSpace(space) { this.space = space; this.update(); }

  /** Follow the object and keep a constant on-screen size. */
  update() {
    if (!this.object || !this.root.visible) return;
    this.object.updateMatrixWorld();
    this.object.matrixWorld.decompose(_v, _q, _s);
    this.root.position.copy(_v);
    if (this.space === 'local') this.root.quaternion.copy(_q); else this.root.quaternion.identity();
    const d = this.camera.position.distanceTo(_v);
    const k = d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.size;
    this.root.scale.setScalar(Math.max(k, 1e-6));
    this._billboard.quaternion.copy(this.root.quaternion).invert().multiply(this.camera.quaternion);
    for (const h of this.handles) if (h.kind === 'scale') h.group.visible = this.space === 'local';
    this.root.updateMatrixWorld(true);
  }

  dispose() {
    this.disable();
    this.scene.remove(this.root);
    this.root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material !== PICK_MAT) o.material.dispose(); } });
  }

  // ---- construction --------------------------------------------------------
  _add(kind, axis, color, visuals, pickerGeo, parent = this.root) {
    if (this.kinds && !this.kinds.has(kind)) { for (const m of visuals) { m.geometry.dispose(); m.material.dispose(); } pickerGeo.dispose(); return; }
    const group = new THREE.Group();
    for (const m of visuals) { m.renderOrder = 1000; group.add(m); }
    const picker = new THREE.Mesh(pickerGeo, PICK_MAT);
    group.add(picker);
    parent.add(group);
    const h = { kind, axis, color, visuals, picker, group };
    picker.userData.handle = h;
    this.handles.push(h);
  }

  _build() {
    for (const a of ['x', 'y', 'z']) {
      const c = COLORS[a];
      // move arrow
      const shaft = new THREE.Mesh(toAxis(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 8).translate(0, 0.53, 0), a), handleMat(c));
      const cone = new THREE.Mesh(toAxis(new THREE.ConeGeometry(0.055, 0.17, 16).translate(0, 0.965, 0), a), handleMat(c));
      this._add('move', a, c, [shaft, cone], toAxis(new THREE.CylinderGeometry(0.065, 0.065, 0.92, 8).translate(0, 0.6, 0), a));
      // per-axis scale cube (sits on the shaft)
      const cube = new THREE.Mesh(toAxis(new THREE.BoxGeometry(0.085, 0.085, 0.085).translate(0, SCALE_AT, 0), a), handleMat(c));
      this._add('scale', a, c, [cube], toAxis(new THREE.BoxGeometry(0.15, 0.15, 0.15).translate(0, SCALE_AT, 0), a));
      // rotate ring
      const ring = new THREE.Mesh(ringToAxis(new THREE.TorusGeometry(RING_R, 0.011, 6, 96), a), handleMat(c));
      this._add('rotate', a, c, [ring], ringToAxis(new THREE.TorusGeometry(RING_R, 0.055, 6, 48), a));
    }
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 14), handleMat(COLORS.free));
    this._add('free', null, COLORS.free, [ball], new THREE.SphereGeometry(0.13, 12, 8));
    const outer = new THREE.Mesh(new THREE.TorusGeometry(UNIFORM_R, 0.012, 6, 96), handleMat(COLORS.uniform));
    this._add('uniform', null, COLORS.uniform, [outer], new THREE.TorusGeometry(UNIFORM_R, 0.06, 6, 64), this._billboard);
  }

  // ---- picking -------------------------------------------------------------
  _setRay(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this._ray.setFromCamera(_ndc, this.camera);
    return r;
  }

  _pick(ev) {
    if (!this.object || !this.root.visible) return null;
    this._setRay(ev);
    const pickers = this.handles.filter(h => h.group.visible).map(h => h.picker);
    const hits = this._ray.intersectObjects(pickers, false);
    if (!hits.length) return null;
    // Pickers overlap where handles cross (a cube sits on its arrow, an edge-on ring
    // projects as a line straight through the centre ball) — the more specific handle wins.
    hits.sort((a, b) => PRIORITY[a.object.userData.handle.kind] - PRIORITY[b.object.userData.handle.kind] || a.distance - b.distance);
    const h = hits[0];
    return { handle: h.object.userData.handle, point: h.point.clone() };
  }

  _setHover(h) {
    if (this.hovered === h) return;
    if (this.hovered) for (const m of this.hovered.visuals) m.material.color.setHex(this.hovered.color);
    this.hovered = h;
    if (h) for (const m of h.visuals) m.material.color.setHex(COLORS.hover);
    this.renderer.domElement.style.cursor = h ? 'pointer' : '';
  }

  _screen(p, rect) {   // world point → canvas pixels
    _w.copy(p).project(this.camera);
    return new THREE.Vector2((_w.x + 1) / 2 * rect.width, (1 - _w.y) / 2 * rect.height);
  }

  // ---- pointer handlers ----------------------------------------------------
  _onDown(ev) {
    if (!this.active || ev.button !== 0 || ev.altKey) return;
    const pick = this._pick(ev);
    if (!pick) return;
    this.controls.enabled = false;               // beat OrbitControls' own pointerdown
    this.renderer.domElement.setPointerCapture?.(ev.pointerId);
    ev.stopPropagation(); ev.preventDefault();

    const { handle, point } = pick;
    const o = this.object;
    o.updateMatrixWorld();
    const origin = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const axisW = handle.axis ? AXES[handle.axis].clone().applyQuaternion(this.root.quaternion).normalize() : null;
    const view = origin.clone().sub(this.camera.position).normalize();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const d = {
      handle, origin, axisW, view, point,
      startPos: o.position.clone(), startQuat: o.quaternion.clone(), startScale: o.scale.clone(),
      mouse0: new THREE.Vector2(ev.clientX - rect.left, ev.clientY - rect.top),
      center: this._screen(origin, rect),
      plane: new THREE.Plane(), p0: null, angle: 0, prevVec: null,
    };
    if (handle.kind === 'move' || handle.kind === 'scale') {
      // plane through the axis that faces the camera as much as possible
      const n = axisW.clone().cross(view.clone().cross(axisW));
      if (n.lengthSq() < 1e-10) n.copy(view);
      d.plane.setFromNormalAndCoplanarPoint(n.normalize(), origin);
    } else if (handle.kind === 'free') {
      d.plane.setFromNormalAndCoplanarPoint(view, origin);
    } else if (handle.kind === 'rotate') {
      d.useTangent = Math.abs(axisW.dot(view)) < 0.25;   // ring seen edge-on → drag along its tangent instead
      d.plane.setFromNormalAndCoplanarPoint(axisW, origin);
      const tangent = axisW.clone().cross(point.clone().sub(origin)).normalize();
      const a = this._screen(point, rect), b = this._screen(point.clone().add(tangent.multiplyScalar(this.root.scale.x * 0.2)), rect);
      d.tan2 = b.sub(a).normalize();
      d.radPx = Math.max(20, this._screen(point, rect).distanceTo(d.center));
    }
    if (handle.kind !== 'uniform' && !(handle.kind === 'rotate' && d.useTangent)) {
      if (!this._ray.ray.intersectPlane(d.plane, _hit)) { this._cancel(); return; }
      d.p0 = _hit.clone();
      if (handle.kind === 'rotate') d.prevVec = d.p0.clone().sub(origin);
    }
    this.drag = d;
    this._setHover(handle);
    this.onDragStart?.(handle.kind, handle.axis);
  }

  _cancel() { this.drag = null; this.controls.enabled = true; }

  _onMove(ev) {
    if (!this.active) return;
    if (!this.drag) { if (this.object && this.root.visible) this._setHover(this._pick(ev)?.handle || null); return; }
    const d = this.drag, o = this.object, snap = this.snap || ev.shiftKey;
    const rect = this._setRay(ev);
    const mouse = new THREE.Vector2(ev.clientX - rect.left, ev.clientY - rect.top);
    const kind = d.handle.kind;

    if (kind === 'uniform') {
      const d0 = Math.max(5, d.mouse0.distanceTo(d.center));
      let f = mouse.distanceTo(d.center) / d0;
      if (snap) f = Math.round(f / this.snapScale) * this.snapScale;
      o.scale.copy(d.startScale).multiplyScalar(Math.max(this.minScale / Math.min(d.startScale.x, d.startScale.y, d.startScale.z), f));
    } else if (kind === 'rotate') {
      let angle;
      if (d.useTangent) {
        angle = mouse.clone().sub(d.mouse0).dot(d.tan2) / d.radPx;
      } else {
        if (!this._ray.ray.intersectPlane(d.plane, _hit)) return;
        const v = _hit.clone().sub(d.origin);
        // accumulate the step since the last move so the angle can wind past ±180°
        const cross = d.prevVec.clone().cross(v).dot(d.axisW), dot = d.prevVec.dot(v);
        d.angle += Math.atan2(cross, dot);
        d.prevVec = v;
        angle = d.angle;
      }
      if (snap) angle = Math.round(angle / this.snapAngle) * this.snapAngle;
      o.quaternion.copy(_q.setFromAxisAngle(d.axisW, angle)).multiply(d.startQuat);
    } else {
      if (!this._ray.ray.intersectPlane(d.plane, _hit)) return;
      if (kind === 'free') {
        const delta = _hit.clone().sub(d.p0);
        if (snap) delta.set(Math.round(delta.x / this.snapMove) * this.snapMove, Math.round(delta.y / this.snapMove) * this.snapMove, Math.round(delta.z / this.snapMove) * this.snapMove);
        this._setWorldPos(d.origin.clone().add(delta));
      } else {
        const t0 = d.p0.clone().sub(d.origin).dot(d.axisW), t = _hit.clone().sub(d.origin).dot(d.axisW);
        if (kind === 'move') {
          let delta = t - t0;
          if (snap) delta = Math.round(delta / this.snapMove) * this.snapMove;
          this._setWorldPos(d.origin.clone().addScaledVector(d.axisW, delta));
        } else {   // per-axis scale
          let f = Math.abs(t0) > 1e-9 ? t / t0 : 1;
          if (snap) f = Math.round(f / this.snapScale) * this.snapScale;
          o.scale.copy(d.startScale);
          o.scale[d.handle.axis] = Math.max(this.minScale, d.startScale[d.handle.axis] * f);
        }
      }
    }
    o.updateMatrixWorld();
    this.update();
    this.onChange?.();
  }

  _setWorldPos(p) {
    const o = this.object;
    if (o.parent) o.parent.worldToLocal(p);
    o.position.copy(p);
  }

  _onUp() { if (this.drag) this._end(); }

  _end() {
    this.drag = null;
    this.controls.enabled = true;
    this.onDragEnd?.();
  }
}
