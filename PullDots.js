import * as THREE from 'three';

/**
 * PullDots — round handles in the view for lengths that have something to hold on to: how far a morph point pushes
 * and how far it reaches, the radius a spiral starts at, the distance between its loops.
 *
 * A dot sits at  origin + dir · t  and is pulled along that line; it keeps its size on screen and is drawn on top of
 * everything. Where it is comes from the dot's own line() every frame, so a dot follows whatever it measures — and
 * what a pull does is up to its pull(): the dot itself only reports how far along the line the pointer has taken it.
 *
 * Like the gizmo's handles: Shift snaps (the pull is told, and rounds to whole millimetres), Ctrl is for fine
 * adjustment — the pointer then counts a tenth. Alt leaves the click to the camera.
 * Call update() once per frame.
 */

const _w = new THREE.Vector3(), _hit = new THREE.Vector3(), _ndc = new THREE.Vector2();

function dotTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  x.beginPath(); x.arc(32, 32, 27, 0, Math.PI * 2); x.fillStyle = 'rgba(8,11,16,.85)'; x.fill();   // dark rim: readable on any part
  x.beginPath(); x.arc(32, 32, 21, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill();                 // tinted by the material
  return new THREE.CanvasTexture(c);
}

export class PullDots {
  constructor({ scene, camera, renderer, controls }) {
    this.scene = scene; this.camera = camera; this.renderer = renderer; this.controls = controls;
    this.sizePx = 17;               // diameter on screen
    this.fineFactor = 0.1;
    this.dots = [];
    this.drag = null;
    this.hovered = null;
    this._map = dotTexture();
    this._ray = new THREE.Raycaster();
    // before the gizmos' own (they are added when a page turns them on): a dot is the smaller target
    renderer.domElement.addEventListener('pointerdown', ev => this._onDown(ev), true);
    window.addEventListener('pointermove', ev => this._onMove(ev));
    window.addEventListener('pointerup', () => this._onUp());
  }

  get dragging() { return !!this.drag; }

  /**
   * line(): {origin, dir, t} — where the dot is — or null while there is nothing for it to show
   * pull(t, {fine, snap}): the dot was pulled to t along its line
   * end(): the pull is over
   */
  add({ color = 0xffffff, title = '', line, pull, end = null }) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._map, color, depthTest: false, depthWrite: false,
      sizeAttenuation: false, transparent: true, toneMapped: false }));
    sprite.renderOrder = 1001; sprite.visible = false;
    this.scene.add(sprite);
    const dot = { sprite, title, line, pull, end, origin: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), t: 0, shown: false };
    this.dots.push(dot);
    return dot;
  }

  update() {
    const k = this.sizePx / (this.renderer.domElement.clientHeight || 800) * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    for (const dot of this.dots) {
      const l = dot.line();
      dot.shown = dot.sprite.visible = !!l;
      if (!l) { if (this.hovered === dot) this._setHover(null); continue; }
      if (!(this.drag && this.drag.dot === dot)) { dot.origin.copy(l.origin); dot.dir.copy(l.dir).normalize(); }   // a pull keeps the line it began on
      dot.t = l.t;
      dot.sprite.position.copy(dot.origin).addScaledVector(dot.dir, dot.t);
      dot.sprite.scale.setScalar(k * (this.hovered === dot ? 1.35 : 1));
    }
  }

  // ---- picking: the dot nearest to the pointer, on screen ----
  _px(p, rect) { _w.copy(p).project(this.camera); return [(_w.x + 1) / 2 * rect.width, (1 - _w.y) / 2 * rect.height, _w.z]; }
  _pick(ev) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let best = null, bd = this.sizePx / 2 + 5;
    for (const dot of this.dots) {
      if (!dot.shown) continue;
      const [x, y, z] = this._px(dot.sprite.position, rect);
      if (z > 1) continue;                                   // behind the camera
      const d = Math.hypot(x - mx, y - my);
      if (d < bd) { bd = d; best = dot; }
    }
    return best;
  }
  _setHover(dot) {
    if (this.hovered === dot) return;
    this.hovered = dot;
    const el = this.renderer.domElement;
    el.style.cursor = dot ? 'grab' : '';
    if (dot && dot.title) el.title = dot.title; else el.removeAttribute('title');
  }

  /* how far along the dot's line the pointer is: where its ray meets the plane through the line that faces the camera */
  _along(ev, d) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    _ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    this._ray.setFromCamera(_ndc, this.camera);
    if (!this._ray.ray.intersectPlane(d.plane, _hit)) return null;
    return _hit.sub(d.origin).dot(d.dir);
  }

  _onDown(ev) {
    if (ev.button !== 0 || ev.altKey || ev.viewGrabbed) return;
    const dot = this._pick(ev);
    if (!dot) return;
    const origin = dot.origin.clone(), dir = dot.dir.clone();
    const view = dot.sprite.position.clone().sub(this.camera.position).normalize();
    const n = dir.clone().cross(view.clone().cross(dir));
    if (n.lengthSq() < 1e-10) n.copy(view);
    const d = { dot, origin, dir, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), origin), raw: 0, t: dot.t };
    const raw = this._along(ev, d);
    if (raw == null) return;
    d.raw = raw;
    ev.viewGrabbed = true;                                   // one handle per click (the gizmos look at this too)
    this.controls.enabled = false;                           // beat OrbitControls' own pointerdown
    this.renderer.domElement.setPointerCapture?.(ev.pointerId);
    ev.stopPropagation(); ev.preventDefault();
    this.drag = d;
    this._setHover(dot);
    this.renderer.domElement.style.cursor = 'grabbing';
  }

  _onMove(ev) {
    const d = this.drag;
    if (!d) { this._setHover(this.dots.some(x => x.shown) ? this._pick(ev) : null); return; }
    const raw = this._along(ev, d);
    if (raw == null) return;
    const fine = ev.ctrlKey || ev.metaKey;
    d.t += (raw - d.raw) * (fine ? this.fineFactor : 1);     // step by step, so a fine stretch counts for less without a jump
    d.raw = raw;
    d.dot.pull(d.t, { fine, snap: ev.shiftKey });
  }

  _onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = this.hovered ? 'grab' : '';
    d.dot.end?.();
  }
}
