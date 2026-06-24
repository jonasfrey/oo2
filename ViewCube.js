import * as THREE from 'three';

/**
 * ViewCube — a small interactive orientation cube for the corner of the screen.
 *
 * It runs its own tiny renderer/scene (so it never fights OrbitControls or the
 * brush handlers on the main canvas). Every frame the mini-camera is pointed
 * from the SAME direction the main camera looks, so the cube always shows the
 * face you're currently viewing. Clicking a face calls `onSelect(name)` — the
 * app maps that to a snap view via setView().
 *
 * World is Z-up, so the faces are labelled:
 *   +Z TOP   -Z BOT   -Y FRONT   +Y BACK   +X RIGHT   -X LEFT
 * (BoxGeometry material order is +X,-X,+Y,-Y,+Z,-Z.)
 */

// face material index -> { label, setView name }
const FACES = [
  { label: 'RIGHT', name: 'right'  }, // 0: +X
  { label: 'LEFT',  name: 'left'   }, // 1: -X
  { label: 'BACK',  name: 'back'   }, // 2: +Y
  { label: 'FRONT', name: 'front'  }, // 3: -Y
  { label: 'TOP',   name: 'top'    }, // 4: +Z
  { label: 'BOT',   name: 'bottom' }, // 5: -Z
];

const _dir = new THREE.Vector3();
const _ndc = new THREE.Vector2();

export class ViewCube {
  constructor({ camera, controls, onSelect, size = 96 }) {
    this.camera = camera;       // main camera — read its orientation
    this.controls = controls;   // main controls — read its target
    this.onSelect = onSelect;   // (name) => void

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(size, size);
    this.domElement = this.renderer.domElement;
    this.domElement.style.cursor = 'pointer';
    this.domElement.style.display = 'block';

    this.scene = new THREE.Scene();
    // small ortho frustum just big enough to frame a unit cube with margin
    this.cam = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 100);

    this._baseColor = new THREE.Color(0x2b3340);
    this._hotColor = new THREE.Color(0x4cc2ff);
    this.mats = FACES.map((f) => new THREE.MeshBasicMaterial({ map: makeLabel(f.label), color: this._baseColor.clone() }));

    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.mats);
    this.scene.add(this.cube);
    // crisp edges so the cube reads as a cube against any background
    this.scene.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x6e7681 })));

    this.ray = new THREE.Raycaster();
    this._hover = -1;
    this._downXY = null;

    this._onMove = this._onMove.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onLeave = this._onLeave.bind(this);
    this.domElement.addEventListener('pointermove', this._onMove);
    this.domElement.addEventListener('pointerdown', this._onDown);
    this.domElement.addEventListener('pointerup', this._onUp);
    this.domElement.addEventListener('pointerleave', this._onLeave);
  }

  /** Call once per frame from the main render loop. */
  update() {
    _dir.copy(this.camera.position).sub(this.controls.target);
    if (_dir.lengthSq() < 1e-9) _dir.set(0, 0, 1);
    _dir.normalize();
    this.cam.position.copy(_dir).multiplyScalar(4);   // same direction as the main view
    this.cam.up.copy(this.camera.up);
    // looking (almost) straight along `up` makes lookAt degenerate — nudge the up axis
    if (Math.abs(_dir.dot(this.cam.up)) > 0.999) this.cam.up.set(0, 1, 0);
    this.cam.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.cam);
  }

  // ---- interaction ----------------------------------------------------------
  _pick(ev) {
    const r = this.domElement.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(_ndc, this.cam);
    const hit = this.ray.intersectObject(this.cube, false)[0];
    return hit ? hit.face.materialIndex : -1;
  }

  _setHover(i) {
    if (i === this._hover) return;
    if (this._hover >= 0) this.mats[this._hover].color.copy(this._baseColor);
    if (i >= 0) this.mats[i].color.copy(this._hotColor);
    this._hover = i;
  }

  _onMove(ev) { this._setHover(this._pick(ev)); }
  _onLeave() { this._setHover(-1); }
  _onDown(ev) { this._downXY = [ev.clientX, ev.clientY]; ev.stopPropagation(); }

  _onUp(ev) {
    if (!this._downXY) return;
    const moved = Math.hypot(ev.clientX - this._downXY[0], ev.clientY - this._downXY[1]);
    this._downXY = null;
    if (moved > 4) return;                 // ignore drags
    const i = this._pick(ev);
    if (i >= 0) this.onSelect?.(FACES[i].name);
  }

  dispose() {
    this.domElement.removeEventListener('pointermove', this._onMove);
    this.domElement.removeEventListener('pointerdown', this._onDown);
    this.domElement.removeEventListener('pointerup', this._onUp);
    this.domElement.removeEventListener('pointerleave', this._onLeave);
    this.cube.geometry.dispose();
    this.mats.forEach((m) => { m.map.dispose(); m.dispose(); });
    this.renderer.dispose();
  }
}

/** Render a face label onto a small canvas texture. */
function makeLabel(text) {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, s / 2, s / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}
