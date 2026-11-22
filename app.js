import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader }       from 'three/addons/loaders/STLLoader.js';
import { PLYLoader }       from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader }       from 'three/addons/loaders/OBJLoader.js';
import { STLExporter }     from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter }    from 'three/addons/exporters/GLTFExporter.js';
import { PLYExporter }     from 'three/addons/exporters/PLYExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { LineSegments2 }        from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial }         from 'three/addons/lines/LineMaterial.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, MeshBVH }
  from 'three-mesh-bvh';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { SculptController } from './sculpt/SculptController.js';
import { BRUSH } from './sculpt/Brush.js';
import { repairGeometry } from './sculpt/MeshRepair.js';
import { DisplacementController } from './heightmap/DisplacementController.js';
import { HeightmapEditor }        from './heightmap/HeightmapEditor.js';
import { EditHistory }            from './EditHistory.js';
import { ViewCube }               from './ViewCube.js';
import { importDecoration, simplifyColored, weldWithColors } from './deco/DecoImport.js';
import { fuseGeometries, solidWithColor } from './deco/Fuse.js';
import { TransformGizmo }         from './deco/TransformGizmo.js';
import { planMixes, snapmakerProject } from './slicer/OrcaProject.js';

// three-mesh-bvh wiring (BVH-accelerated raycast + bounds tree on BufferGeometry)
THREE.BufferGeometry.prototype.computeBoundsTree   = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree   = disposeBoundsTree;
THREE.Mesh.prototype.raycast                       = acceleratedRaycast;

/* Register the Alpine component up-front (chainApp is a hoisted function decl), so the
   UI mounts even if the engine setup below throws for some reason. */
document.addEventListener('alpine:init', ()=>{ window.Alpine.data('chainApp', chainApp); });

/* ============================ TUNABLE CONSTANTS ============================
   Everything a maker is likely to tweak lives here.                          */
const CONST = {
  DEFAULT_GAP_MM      : 0.4,    // print clearance along the mating direction
  DEFAULT_PLATE_MM    : 256,    // square print bed edge
  PART_COLOR          : 0x9aa7b4,
  PIN_COLOR           : 0xff5d5d,
  LINK_OK_COLOR       : new THREE.Color(0x6fcf97),
  LINK_BAD_COLOR      : new THREE.Color(0xff6b6b),
  LINK_SEED_COLOR     : new THREE.Color(0x4cc2ff),
  BBOX_PAD_MM         : 0.05,   // broadphase padding so "just touching" counts as a hit
  COLLISION_AUTO_MAX  : 400,    // above this link count, only check collisions on demand
  XRAY_OPACITY        : 0.32,   // mesh opacity in x-ray mode
  EDGE_ANGLE          : 30,     // crease angle (deg) for x-ray outline edges
  MATE_COLOR          : 0xffb454,// the previewed neighbouring link in step 2
  MATE_OPACITY        : 0.5,
  OVERRIDE_COLOR      : new THREE.Color(0xc792ea),// links swapped for a custom model
  SELECT_COLOR        : 0xffffff,// selection box around the picked link
  STL_BYTES_PER_TRI   : 50,     // binary STL: 50 bytes/triangle + 84-byte header
  MAX_VERTS_PER_LINK  : 2000,   // default vertex cap per link for the optional "smaller file" reduction at export
  BIG_FILE_MB         : 100,    // a full-detail file estimated above this → the Export page points at "Smaller file"
                                // (≈4k tris/link → 400 links ≈ 1.6M tris ≈ 76 MB STL)
};

/* The Alpine component instance — set in init(). All reactive UI state lives on it;
   the engine reads/writes UI.* the way the old code read/wrote DOM elements. */
let UI = null;
let viewCube = null;        // corner orientation cube (set up after camera/controls exist)
/* getElementById is still used for the few raw DOM nodes Alpine doesn't drive:
   the Monaco editor containers and the hidden <input type=file> elements. */
const $ = id => document.getElementById(id);
const status = (msg,kind='') => { if(UI){ UI.statusMsg=msg; UI.statusKind=kind; } };

/* ================================ SCENE ================================== */
const wrap = document.getElementById('canvasWrap');
/* No WebGL to be had (switched off, or the browser gave up on its graphics process — then only restarting the
   browser brings it back): nothing here can work, so put up the explanation from index.html instead of a dead page. */
const renderer = (()=>{
  try{ return new THREE.WebGLRenderer({antialias:true}); }
  catch(e){ $('app').remove(); $('noWebgl').hidden=false; throw e; }
})();
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.localClippingEnabled = true;          // for the section / layer view
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.position.set(140, -180, 160);
camera.up.set(0,0,1);                       // Z up — we work on the XY plate

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1;
controls.maxDistance = 50000;

/* OrbitControls in three r160 has a buggy wheel-zoom: getZoomScale() divides by
   (window.devicePixelRatio | 0), which is 0 whenever devicePixelRatio < 1 (e.g.
   fractional display scaling / browser zoomed out). That divide-by-zero makes a
   single notch slam the camera to min- or maxDistance — the "jumps from very
   zoomed in to very zoomed out" symptom. Fixed in r161+. We sidestep it by doing
   our own dpr-independent dolly. */
controls.enableZoom = false;
const ZOOM_SENSITIVITY = 0.5;          // lower = gentler zoom per wheel notch
renderer.domElement.addEventListener('wheel', e=>{
  if(!controls.enabled) return;
  e.preventDefault();
  const norm = Math.min(Math.abs(e.deltaY), 120) / 100;   // tame oversized wheel deltas
  const f = Math.pow(0.95, ZOOM_SENSITIVITY * norm);      // per-event dolly factor
  const offset = camera.position.clone().sub(controls.target);
  let d = offset.length() * (e.deltaY < 0 ? f : 1/f);     // wheel up = zoom in
  d = Math.max(controls.minDistance, Math.min(controls.maxDistance, d));
  camera.position.copy(controls.target).add(offset.setLength(d));
  controls.update();
}, {passive:false});

/* true while a button is held down in the view (orbiting, painting, dragging a handle) — see followContent() */
let viewPointerDown=false;
renderer.domElement.addEventListener('pointerdown', ()=>{ viewPointerDown=true; }, true);
for(const t of ['pointerup','pointercancel','blur']) window.addEventListener(t, ()=>{ viewPointerDown=false; }, true);

/* ---- swapped-link gizmo: move/rotate a custom override within its own slot ---- */
const xform = new TransformControls(camera, renderer.domElement);
xform.visible=false; xform.enabled=false;
scene.add(xform);
xform.addEventListener('dragging-changed', e=>{
  controls.enabled = !e.value;
  if(!e.value) commitGizmoAdjust();           // drag finished → persist + full recheck
});
xform.addEventListener('objectChange', liveGizmoAdjust);
window.__debug={xform,controls};   // TEMP: removed before commit

/* ---- loop-sculpt direction gizmo + visibility group ---- */
const lsXform = new TransformControls(camera, renderer.domElement);
lsXform.visible = false; lsXform.enabled = false;
lsXform.setMode('rotate');
scene.add(lsXform);
lsXform.addEventListener('dragging-changed', e => { controls.enabled = !e.value; });
lsXform.addEventListener('objectChange', lsOnGizmoChange);
const lsGroup = new THREE.Group(); lsGroup.visible = false; scene.add(lsGroup);
const lsTwinGroup = new THREE.Group(); lsGroup.add(lsTwinGroup);   // the mirrored twins of morph points (see lsSyncTwins)

/* ---- joints step: X / Y arrows on the previewed next link — dragging them sets the link offset ---- */
const mateXform = new TransformControls(camera, renderer.domElement);
mateXform.visible=false; mateXform.enabled=false;
mateXform.showZ=false;                        // the arrows only slide the link over the plate; height is a number field
scene.add(mateXform);
const mateHandle = new THREE.Object3D();      // what the arrows hold: the middle of the next link
scene.add(mateHandle);
mateXform.addEventListener('dragging-changed', e=>{
  controls.enabled = !e.value;
  if(!e.value) syncMateGizmo();               // drag finished → the arrows settle on the (0.1 mm-stepped) link
});
mateXform.addEventListener('objectChange', mateGizmoMoved);

/* ---- flatten the bottom: an arrow on the cut plane — dragging it up or down sets the cut height ---- */
const cutXform = new TransformControls(camera, renderer.domElement);
cutXform.visible=false; cutXform.enabled=false;
cutXform.showX=false; cutXform.showY=false;   // the plane only moves up and down
scene.add(cutXform);
const cutHandle = new THREE.Object3D();       // what the arrow holds: the middle of the cut plane
scene.add(cutHandle);
cutXform.addEventListener('dragging-changed', e=>{
  controls.enabled = !e.value;
  if(!e.value) updateCutPreview();            // drag finished → the arrow settles on the (0.1 mm-stepped) plane
});
cutXform.addEventListener('objectChange', ()=>{
  UI.cutHeight = +Math.min(UI.cutMax, Math.max(UI.cutMin, cutHandle.position.z)).toFixed(1);
});

/* ---- decorate step: combined move/rotate/scale gizmo for the placed object ---- */
const decoGizmo = new TransformGizmo({ scene, camera, renderer, controls });

scene.add(new THREE.HemisphereLight(0xffffff, 0x202830, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4); dir.position.set(80,-120,200); scene.add(dir);

/* ---- print bed (XY plane, Z up): the plate itself, a line every 10 mm, its edge — and the world axes ----
   It is drawn centred under what the page shows (syncBed), so whatever sticks out over the edge does not fit. */
const BED = { fill:0x1d2936, line:0x2b3846, major:0x3d5064, edge:0x7088a0, edgeOver:0xffcc66 };
function makeBed(size){
  const h=size/2, bed=new THREE.Group();
  const plate=new THREE.Mesh(new THREE.PlaneGeometry(size,size),      // seen from above only: from below the underside of a part stays in clear view
    new THREE.MeshBasicMaterial({color:BED.fill, transparent:true, opacity:.72, depthWrite:false}));
  plate.position.z=-0.05; plate.renderOrder=-1;                       // a hair under the lines and under whatever lies on the plate
  const pts=[], cols=[], c=new THREE.Color();
  for(let k=1; k*10<size-1e-6; k++){                                  // counted from the front left corner; every 50 mm a stronger line
    const v=-h+k*10; c.set(k%5 ? BED.line : BED.major);
    pts.push(v,-h,0, v,h,0, -h,v,0, h,v,0);
    for(let i=0;i<4;i++) cols.push(c.r,c.g,c.b);
  }
  const lg=new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pts,3));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(cols,3));
  const lines=new THREE.LineSegments(lg, new THREE.LineBasicMaterial({vertexColors:true}));
  const edge=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-h,-h,0),new THREE.Vector3(h,-h,0),new THREE.Vector3(h,h,0),new THREE.Vector3(-h,h,0)]),
    new THREE.LineBasicMaterial({color:BED.edge}));
  bed.add(plate, lines, edge);
  bed.userData={size, edge};
  return bed;
}
let bed = makeBed(CONST.DEFAULT_PLATE_MM); scene.add(bed);
const axes = new THREE.AxesHelper(40); scene.add(axes);

/* ---- where links overlap: the line along which their surfaces cross, drawn on top of everything in a width that
   does not shrink with distance, and a ring around every such spot so it is found when the whole chain is in view ---- */
const overlapViz = new THREE.Group(); overlapViz.visible=false; scene.add(overlapViz);
const OVERLAP_COL = { line:0xfff35c, edge:0x1a1206 };
const overlapMats = [ new LineMaterial({color:OVERLAP_COL.edge, linewidth:6, transparent:true, opacity:.75, depthTest:false, depthWrite:false}),
                      new LineMaterial({color:OVERLAP_COL.line, linewidth:3, transparent:true, depthTest:false, depthWrite:false}) ];
const overlapRing = (()=>{                     // a ring that keeps its size on screen
  const c=document.createElement('canvas'); c.width=c.height=96;
  const x=c.getContext('2d');
  for(const [w,col] of [[11,'rgba(26,18,6,.8)'],[6,'#fff35c']]){ x.beginPath(); x.arc(48,48,36,0,Math.PI*2); x.lineWidth=w; x.strokeStyle=col; x.stroke(); }
  return new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c), depthTest:false, depthWrite:false, sizeAttenuation:false, transparent:true});
})();

function resize(){
  const r=wrap.getBoundingClientRect();
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));   // browser zoom changes it; the canvas itself is stretched to the view by CSS
  renderer.setSize(r.width,r.height,false);
  for(const m of overlapMats) m.resolution.set(r.width||1, r.height||1);   // their line width is in screen pixels
  camera.aspect=(r.width/r.height)||1; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap); resize();

/* ---- WebGL context loss ----
   The browser can take the context away at any moment: a graphics driver reset, its GPU process crashing (on some
   Linux + NVIDIA machines whenever the screen is locked). three.js then just stops drawing, and draws again by itself
   once the browser hands the context back — but without a word the view sits there blank. So say what happened, and
   if the context doesn't come back, what to do about it (the notice is #glLost in index.html). */
let glStuckTimer=0;
renderer.domElement.addEventListener('webglcontextlost', ()=>{
  if(!UI) return;
  UI.glLost='wait';
  clearTimeout(glStuckTimer);
  glStuckTimer=setTimeout(()=>{ if(UI.glLost) UI.glLost='stuck'; }, 4000);   // a restarted GPU process is back within a second or two
});
renderer.domElement.addEventListener('webglcontextrestored', ()=>{
  clearTimeout(glStuckTimer);
  resize();
  if(UI){ UI.glLost=''; status('The 3D view is back.','ok'); }
});

(function loop(){requestAnimationFrame(loop);controls.update();decoGizmo.update();renderer.render(scene,camera);viewCube&&viewCube.update();})();

/* ================================ STATE ================================== */
/* Engine state — Three.js object refs + non-reactive bookkeeping. UI-bound
   primitives (pin, hole, partZ, render toggles, projectId) live on UI instead. */
const S = {
  baseGeo:null,          // the aligned + laid-flat geometry (local coords == plate coords for one part)
  baseColorsRaw:null,    // untouched per-vertex colors of the import, so the color-shades slider can re-quantize live
  loadFormat:'stl',      // extension the part was loaded from — the chain is exported back in this same format
  partMesh:null,         // single part shown in steps 1-2
  pickedNormal:null,     // world normal of picked face
  highlight:null,        // face highlight mesh
  partX:0, partY:0,      // baked-in part rotation about X/Y (deg) — trackers for delta rotations
  partZ:0,               // baked-in part rotation about Z (deg) — tracker for delta rotations
  alignMatrix:new THREE.Matrix4(),   // cumulative rotation baked into baseGeo (auto-align/lay-flat/Z-nudge) —
                                      // reapplied (rotation only) to any link-swap upload, so it shares the same orientation
  meshId:null,           // server filename of the uploaded (aligned) mesh, if saved
  meshName:'part',       // original file name (sans extension), used when uploading
  meshDirty:true,        // geometry changed since last upload → re-upload on save
  poses:[],              // Matrix4 per link (world)
  chain:null,            // InstancedMesh preview
  collideSet:new Set(),  // indices currently colliding
  chainOverlap:null, mateOverlap:null, overlapShown:null, overlapSpots:[],   // where links overlap ({lines, spots}): in the chain / on the Joints page / on show now
  symPlanes:[],          // detected mirror planes {p:Vector3, n:Vector3, score}
  symGroup:null,         // THREE.Group holding the mirror-line visuals
  symVisible:true,
  scaleCode:'',          // user JS for per-part size variation
  scaleFn:(n,t)=>1,      // compiled scale function f(n_it, n_it_nor) → scale
  colorCode:'',          // user JS for per-part colour
  colorFn:null,          // compiled colour function f(n_it, n_it_nor, base) → colour
  pathCode:'',           // user JS for the chain centre-line  f(t) → {x,y}
  pathFn:null,           // compiled path function
  scales:[],             // per-link scale actually used (for status/debug)
  partEdges:null,        // LineSegments outline of the single part (x-ray)
  matePreview:null,      // ghost of the neighbouring link shown in step 2
  cutGeo:null, cutKey:'',// the part with its bottom cut off, as the links of the chain use it (see chainPartGeo) — and what it was made from
  cutViz:null,           // the flatten-bottom preview: sheet at the cut height, what is cut off in red, the cut line
  overrides:new Map(),   // link index → {geo,name}: that slot uses a custom model
  overrideGroup:null,    // THREE.Group of the custom-link meshes
  selectedLink:null,     // index of the link picked in the viewport (for swapping)
  selBox:null,           // Box3Helper around the selected link
  uiStep:'s1',           // which wizard step's view is showing (drives part-vs-chain visibility)
  dbgPoints:null, dbgWire:null,
  chainLength:0, linkSpan:0,
  lsNodes:[],           // loop sculpt nodes [{pos,dir,intensity,radius,mode,falloff,code,fn,arrowHelper,sphereViz,pivot}]
  lsPreviewGeo:null,    // cloned geo currently shown as deformed preview in the lsculpt step
  lsActiveNodeIdx:-1,   // which node is selected for editing
  lsChainGroup:null,    // THREE.Group with one deformed Mesh per link (replaces S.chain visually)
  mirroredBaseGeo:null, // cached full-part geometry built from the half-part when mirror is enabled
  footCenter:null,       // middle of the chain's footprint (set by regen) — the print bed is drawn centred under it
  deco:null,            // object fused onto the link: {name,colorSource,missing,work,geo,mesh,fused,linkPreFuse,preFuseColor,meshId,linkMeshId}
  decoGhost:null,       // translucent neighbouring link (+ its object) shown while placing the object
};

/* ======================================================================== *
 *  STEP 1 — LOADING, AUTO-ALIGN (PCA), PICK-FACE-TO-LAY-FLAT
 * ======================================================================== */
function hasVColor(geo){ return !!(geo && geo.getAttribute('color')); }
// Per-channel (min + max) of the model's palette. For a 2-colour model this equals
// A+B, so `palette_sum - colour` swaps the two colours exactly (white↔green); the
// chain shader and the exporter both use it to "invert" a part.
const SWAP_SUM = new THREE.Vector3(2,2,2);
const SWAP_UNIFORM = { value: SWAP_SUM };
function computeSwapSum(){
  const attr = S.baseGeo && S.baseGeo.getAttribute('color');
  if(!attr){ SWAP_SUM.set(2,2,2); return; }
  let mnr=1,mng=1,mnb=1, mxr=0,mxg=0,mxb=0;
  for(let i=0;i<attr.count;i++){
    const r=attr.getX(i), g=attr.getY(i), b=attr.getZ(i);
    if(r<mnr)mnr=r; if(g<mng)mng=g; if(b<mnb)mnb=b;
    if(r>mxr)mxr=r; if(g>mxg)mxg=g; if(b>mxb)mxb=b;
  }
  SWAP_SUM.set(mnr+mxr, mng+mxg, mnb+mxb);
}
function asRGB(geo){
  const c=geo.getAttribute('color'); if(!c) return null;
  if(c.itemSize===3 && c.array instanceof Float32Array) return c;
  const n=c.count, out=new Float32Array(n*3);
  for(let i=0;i<n;i++){ out[i*3]=c.getX(i); out[i*3+1]=c.getY(i); out[i*3+2]=c.getZ(i); }
  return new THREE.Float32BufferAttribute(out,3);
}
function quantizeColors(arr, k, purify){
  const n=arr.length/3;
  if(k>=n || k<1) return;
  const cen=new Float32Array(k*3); cen.set(arr.slice(0,3),0);
  const d2=new Float32Array(n).fill(Infinity);
  for(let c=1;c<k;c++){
    let best=0,bd=-1;
    for(let i=0;i<n;i++){
      const dr=arr[i*3]-cen[(c-1)*3], dg=arr[i*3+1]-cen[(c-1)*3+1], db=arr[i*3+2]-cen[(c-1)*3+2];
      const d=dr*dr+dg*dg+db*db; if(d<d2[i]) d2[i]=d;
      if(d2[i]>bd){ bd=d2[i]; best=i; }
    }
    cen.set(arr.slice(best*3,best*3+3), c*3);
  }
  const assign=new Int32Array(n);
  for(let it=0; it<12; it++){
    let moved=false;
    for(let i=0;i<n;i++){
      let bc=0,bd=Infinity;
      for(let c=0;c<k;c++){
        const dr=arr[i*3]-cen[c*3], dg=arr[i*3+1]-cen[c*3+1], db=arr[i*3+2]-cen[c*3+2];
        const d=dr*dr+dg*dg+db*db; if(d<bd){ bd=d; bc=c; }
      }
      if(assign[i]!==bc){ assign[i]=bc; moved=true; }
    }
    const sum=new Float64Array(k*3), cnt=new Uint32Array(k);
    for(let i=0;i<n;i++){ const c=assign[i]; sum[c*3]+=arr[i*3]; sum[c*3+1]+=arr[i*3+1]; sum[c*3+2]+=arr[i*3+2]; cnt[c]++; }
    for(let c=0;c<k;c++){ if(cnt[c]){ cen[c*3]=sum[c*3]/cnt[c]; cen[c*3+1]=sum[c*3+1]/cnt[c]; cen[c*3+2]=sum[c*3+2]/cnt[c]; } }
    if(!moved && it>0) break;
  }
  if(purify) for(let c=0;c<k*3;c++) cen[c]=Math.round(cen[c]);   // snap each shade to pure 0/1 channels
  for(let i=0;i<n;i++){ const c=assign[i]; arr[i*3]=cen[c*3]; arr[i*3+1]=cen[c*3+1]; arr[i*3+2]=cen[c*3+2]; }
}
function applyColorShades(){
  if(!S.baseGeo || !S.baseColorsRaw) return;
  const k=Math.max(1, Math.round((UI?UI.colorShades:2)||2));
  const attr=S.baseGeo.getAttribute('color'); if(!attr) return;
  attr.array.set(S.baseColorsRaw);     // restore originals, then collapse to k shades
  quantizeColors(attr.array, k, UI?UI.purify:false);
  attr.needsUpdate=true;
  computeSwapSum();                    // palette changed → refresh the colour-swap reflection
}
function partMaterial(geo, extra={}){
  const vc=hasVColor(geo);
  return new THREE.MeshStandardMaterial(Object.assign(
    {color: vc?0xffffff:CONST.PART_COLOR, vertexColors:vc, metalness:.1, roughness:.75, flatShading:false},
    extra));
}
function weldByPosition(geo){
  geo = geo.index ? geo.toNonIndexed() : geo;
  const bare = new THREE.BufferGeometry();
  bare.setAttribute('position', geo.getAttribute('position').clone());
  const col = asRGB(geo);
  if(col) bare.setAttribute('color', col===geo.getAttribute('color') ? col.clone() : col);
  const merged = BufferGeometryUtils.mergeVertices(bare);
  merged.computeVertexNormals();
  return merged;
}

function setBaseGeometry(geo, opts={}){
  if(opts.faithful){
    if(!geo.getAttribute('normal')) geo.computeVertexNormals();
  }else{
    geo = weldByPosition(geo);                      // weld to true topological vert count
  }
  geo.computeBoundingBox(); geo.computeBoundingSphere();

  if (S.partMesh){ scene.remove(S.partMesh); S.partMesh.geometry.dispose(); }
  if (S.matePreview){ scene.remove(S.matePreview); S.matePreview.material.dispose(); S.matePreview=null; }
  if (UI){ UI.cutOn=false; UI.cutHeight=0; }                           // a cut belonged to the old part
  clearCutPreview(); dropCutGeo();
  for (const i of [...S.overrides.keys()]) clearOverride(i);           // and any per-link swaps (slots no longer valid)
  if (S.overrideGroup){ scene.remove(S.overrideGroup); S.overrideGroup.traverse(o=>o.material&&o.material.dispose()); S.overrideGroup=null; }
  S.alignMatrix.identity();                         // fresh part → its own alignment starts from scratch
  S.selectedLink=null; if(S.selBox){ scene.remove(S.selBox); S.selBox=null; }
  if (S.baseGeo){ S.baseGeo.disposeBoundsTree?.(); S.baseGeo.dispose(); }
  if (S.mirroredBaseGeo){ S.mirroredBaseGeo.dispose(); S.mirroredBaseGeo=null; }

  S.baseGeo = geo;
  decoDetachFromLink();                      // a fused object belonged to the old link → back to "placed, not fused"
  history?.clear();                          // new part → drop any prior undo history
  S.baseColorsRaw = hasVColor(geo) ? geo.getAttribute('color').array.slice() : null;
  applyColorShades();                       // collapse colored imports to the slider's shade count
  const mat = partMaterial(geo, {side:THREE.DoubleSide});
  S.partMesh = new THREE.Mesh(geo, mat);
  scene.add(S.partMesh);
  S.pickedNormal=null; clearHighlight(); clearSymmetry();
  S.meshDirty=true;                         // geometry changed → upload again on next save
  frameCamera();
  updatePartEdges(); applyXray(); applySection();   // keep render modes consistent across loads
  updateDebugViz();
  updateMeshChips();
  updateExportLabel();                      // reflect the loaded file's format on the download button
  updateExportEstimate();
  UI.s1nextDisabled=false;
  UI.hasPart=true; UI.partName=S.meshName; UI.partHasColor=hasVColor(geo);
  fitToolSizes();
  UI.dropHide=true;                         // load done → drop the overlay
  // run half-part detection and seed the mirror controls
  const _det=detectHalfPart();
  UI.halfDetected=!!_det;
  if(_det){
    UI.mirrorDetectOut=`<b style="color:var(--ok)">Flat cut face detected</b> on <b>${_det.axis.toUpperCase()}</b> axis (${(_det.pct*100).toFixed(0)}% of vertices coplanar) — this looks like a half-part.`;
    UI.mirrorAxis=_det.axis; UI.mirrorOffset=+_det.offset.toFixed(3);
  } else {
    UI.mirrorDetectOut='';
  }
  status('Part loaded. Lay it flat the way it will print, then continue to Joints.','ok');
}

/* A new part → brush / morph sizes that suit ITS size (a fixed 8 mm brush swallows a 15 mm link whole). */
function fitToolSizes(){
  const s=S.baseGeo.boundingBox.getSize(new THREE.Vector3()), big=Math.max(s.x,s.y,s.z)||10;
  const half=v=>Math.max(0.5,Math.round(v*2)/2);          // 0.5 mm steps, like the sliders
  UI.partSize=big;
  UI.sculptRadius=half(big*0.12); UI.hmRadius=half(big*0.12);
  UI.hmStrength=Math.min(4,half(big*0.05));
  if(S.lsActiveNodeIdx<0){                                // (these two fields edit the selected morph point, if any)
    UI.lsRadius=Math.max(1,Math.round(big*0.3)); UI.lsIntensity=half(big*0.1);
  }
}

function updateMeshChips(){
  if(!S.baseGeo) return;
  const b=new THREE.Box3().setFromBufferAttribute(S.baseGeo.attributes.position);
  const s=b.getSize(new THREE.Vector3());
  UI.chipMesh=`<b>${S.baseGeo.attributes.position.count.toLocaleString()}</b> verts · ${Math.round(triCount(S.baseGeo)).toLocaleString()} tris`;
  UI.chipSize=`bbox <b>${s.x.toFixed(1)}×${s.y.toFixed(1)}×${s.z.toFixed(1)}</b> mm`;
  UI.cutMin=+b.min.z.toFixed(1); UI.cutMax=Math.max(UI.cutMin+0.1,+b.max.z.toFixed(1));     // the flatten-bottom slider spans the part's height
}

/* ------------------------------- CAMERA --------------------------------- *
 * One rule for every page: the view looks at — and so orbits around — the middle of what
 * is shown. That is not the origin: a file keeps its own coordinates, turning the part
 * moves it, and a straight chain grows away from its first link.
 * ------------------------------------------------------------------------ */
/* the box around whatever the current page shows */
function contentBox(){
  const box=new THREE.Box3();
  if(S.lsChainGroup&&S.lsChainGroup.visible) box.setFromObject(S.lsChainGroup);
  else if(S.chain&&S.chain.visible)          // link by link: the drawn geometry (both halves of a mirrored part), swapped links and their nudges
    S.poses.forEach((p,i)=>box.union(worldAABB(linkWorldMatrix(i), S.overrides.get(i)?.geo || S.chain.geometry)));
  else if(S.baseGeo){
    S.baseGeo.computeBoundingBox(); box.copy(S.baseGeo.boundingBox); const d=decoWorldBox(); if(d) box.union(d);
    if(S.matePreview&&S.matePreview.visible) box.union(S.baseGeo.boundingBox.clone().applyMatrix4(relMate()));   // Joints page: the next link stays in frame
  }
  if(box.isEmpty()) box.set(new THREE.Vector3(-60,-60,0),new THREE.Vector3(60,60,60));   // nothing loaded yet → the middle of the plate
  return box;
}
function contentBounds(){
  const box=contentBox();
  return { center:box.getCenter(new THREE.Vector3()),
           radius:(box.getSize(new THREE.Vector3()).length()/2)||60 };
}
const VIEW_DIRS={                          // where the camera stands, seen from the content
  iso   :[0.62,-0.78,0.66],                // front right, from above
  joints:[0.9,-1.7,2.3],                   // higher up — sliding the next link is an XY job
  top   :[0,-0.001, 1],                    // look down +Z (the tiny Y keeps Z-up from going degenerate)
  bottom:[0, 0.001,-1],                    // look up   -Z
  front :[0,-1, 0],                        // look along -Y
  back  :[0, 1, 0],                        // look along +Y
  right :[ 1, 0, 0],                       // look along +X
  left  :[-1, 0, 0],                       // look along -X
  side  :[ 1, 0, 0],                       // legacy alias for right
};
let viewFit=null;                          // middle + radius of what the view was last fitted to (see followContent)
/* Look at the middle of the content from a named direction, far enough away that all of it is in view.
   pad > 1 leaves air around it. */
function frameContent(dirName='iso', pad=1.15){
  syncBed();
  const {center,radius}=contentBounds();
  const half=THREE.MathUtils.degToRad(camera.fov)/2;                       // the narrower side of the view decides the distance
  const fit=radius/Math.sin(Math.min(half, Math.atan(Math.tan(half)*camera.aspect)));
  const dir=new THREE.Vector3(...(VIEW_DIRS[dirName]||VIEW_DIRS.iso)).normalize();
  controls.enableDamping=false; controls.update(); controls.enableDamping=true;   // drop what is left of the last drag's glide — a preset is exact
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, fit*pad);
  controls.update();
  viewFit={center,radius};
}
function frameCamera(){ frameContent('iso', 1.4); }                        // the single part, with room for its handles
/* Joints step: the part AND its neighbour; still stacked → leave room to slide the next link out */
function frameJoints(){ frameContent('joints', anchorsValid() ? 1.15 : 1.6); }
function setView(name){ frameContent(name); }

/* The content changed (longer chain, other shape, turned part …): keep looking at its middle, from the
   same angle and at the same relative zoom. Skipped
   · on the Joints and Add-an-object pages and during any drag in the view — there the content moves
     because the user is dragging it, and a camera that moves along would fight the drag;
   · once the user has moved the view sideways (right-drag): their framing stands until the next preset. */
function followContent(){
  if(viewPointerDown) return;
  syncBed();                                  // the bed goes along in any case, also where the view itself is left alone
  if(!viewFit) return;
  const kind=viewKind(S.uiStep);
  if(kind!=='part' && kind!=='chain') return;
  if(controls.target.distanceTo(viewFit.center) > viewFit.radius*0.02) return;
  const {center,radius}=contentBounds();
  const off=camera.position.clone().sub(controls.target).multiplyScalar(radius/viewFit.radius);
  controls.target.copy(center);
  camera.position.copy(center).add(off);
  controls.update();
  viewFit={center,radius};
}

/* corner orientation cube — clicking a face snaps to that named view */
viewCube = new ViewCube({ camera, controls, onSelect: name => setView(name) });
document.getElementById('viewcube')?.appendChild(viewCube.domElement);

/* ----- Bake an arbitrary Matrix4 into the base geometry (keeps mesh xform = I) ----- */
function bakeMatrix(m){
  S.baseGeo.applyMatrix4(m);
  S.alignMatrix.premultiply(m);                 // track the total alignment, for link-swap uploads to inherit
  S.baseGeo.computeVertexNormals();
  S.baseGeo.computeBoundingBox(); S.baseGeo.computeBoundingSphere();
  S.baseGeo.disposeBoundsTree?.();              // invalidate BVH; rebuilt lazily
  S.baseGeo.boundsTree=null;
  S.meshDirty=true;                             // alignment baked in → re-upload on save
  updatePartEdges();                            // x-ray outline follows the alignment
  updateDebugViz();
  updateMeshChips();
  if(S.symPlanes.length){
    for(const pl of S.symPlanes){ pl.p.applyMatrix4(m); pl.n.transformDirection(m); }
    buildSymLines();
  }
  if(S.deco){                                   // the placed object (and the pre-fuse link) ride along
    if(S.deco.mesh){ S.deco.mesh.applyMatrix4(m); S.deco.mesh.updateMatrix(); }
    if(S.deco.linkPreFuse){ S.deco.linkPreFuse.applyMatrix4(m); S.deco.linkPreFuse.computeBoundingBox(); S.deco.linkMeshId=null; }
  }
  followContent();                              // the part moved → the view keeps looking at its middle
}

/* ----- AUTO-ALIGN via PCA ----- */
function autoAlign(){
  if(!S.baseGeo) return;
  const pos=S.baseGeo.attributes.position, n=pos.count;
  let cx=0,cy=0,cz=0;
  for(let i=0;i<n;i++){cx+=pos.getX(i);cy+=pos.getY(i);cz+=pos.getZ(i);}
  cx/=n;cy/=n;cz/=n;
  let xx=0,xy=0,xz=0,yy=0,yz=0,zz=0;
  for(let i=0;i<n;i++){
    const dx=pos.getX(i)-cx,dy=pos.getY(i)-cy,dz=pos.getZ(i)-cz;
    xx+=dx*dx;xy+=dx*dy;xz+=dx*dz;yy+=dy*dy;yz+=dy*dz;zz+=dz*dz;
  }
  const C=[[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]].map(r=>r.map(v=>v/n));
  const {vectors,values}=jacobiEigen(C);
  const order=[0,1,2].sort((a,b)=>values[b]-values[a]);
  let e0=col(vectors,order[0]), e1=col(vectors,order[1]), e2=col(vectors,order[2]);
  e0.normalize(); e1.normalize();
  e2.copy(new THREE.Vector3().crossVectors(e0,e1)).normalize(); // enforce right-handed
  e1.copy(new THREE.Vector3().crossVectors(e2,e0)).normalize();
  const basis=new THREE.Matrix4().makeBasis(e0,e1,e2);           // axes→world
  const align=basis.clone().transpose();                        // world→axes (inverse)
  const T=new THREE.Matrix4().makeTranslation(-cx,-cy,-cz);
  bakeMatrix(new THREE.Matrix4().multiplyMatrices(align,T));
  status('Auto-oriented along the part’s main axes. If it isn’t lying flat yet, pick the bottom face.','ok');
}
const col=(m,c)=>new THREE.Vector3(m[0][c],m[1][c],m[2][c]);

function jacobiEigen(A){
  const a=A.map(r=>r.slice());
  const V=[[1,0,0],[0,1,0],[0,0,1]];
  for(let sweep=0;sweep<50;sweep++){
    let p=0,q=1,max=Math.abs(a[0][1]);
    const cand=[[0,1],[0,2],[1,2]];
    for(const[i,j]of cand){if(Math.abs(a[i][j])>max){max=Math.abs(a[i][j]);p=i;q=j;}}
    if(max<1e-12) break;
    const app=a[p][p],aqq=a[q][q],apq=a[p][q];
    const phi=0.5*Math.atan2(2*apq,aqq-app);
    const c=Math.cos(phi),s=Math.sin(phi);
    for(let k=0;k<3;k++){
      const akp=a[k][p],akq=a[k][q];
      a[k][p]=c*akp-s*akq; a[k][q]=s*akp+c*akq;
    }
    for(let k=0;k<3;k++){
      const apk=a[p][k],aqk=a[q][k];
      a[p][k]=c*apk-s*aqk; a[q][k]=s*apk+c*aqk;
    }
    for(let k=0;k<3;k++){
      const vkp=V[k][p],vkq=V[k][q];
      V[k][p]=c*vkp-s*vkq; V[k][q]=s*vkp+c*vkq;
    }
  }
  return {vectors:V, values:[a[0][0],a[1][1],a[2][2]]};
}

/* ----- 90° nudges: on the spot — about the part's own middle, and back down onto the height it was resting at
         (a plain rotation about a world axis swings a part on the plate sideways and half-way under it) ----- */
function nudge(axis){
  if(!S.baseGeo) return;
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox, c=b.getCenter(new THREE.Vector3()), s=b.getSize(new THREE.Vector3());
  const m=new THREE.Matrix4();
  if(axis==='x')m.makeRotationX(Math.PI/2);
  if(axis==='y')m.makeRotationY(Math.PI/2);
  if(axis==='z')m.makeRotationZ(Math.PI/2);
  const h = axis==='x' ? s.y : axis==='y' ? s.x : s.z;      // how tall the part is once turned
  m.premultiply(new THREE.Matrix4().makeTranslation(c.x,c.y,b.min.z+h/2))
   .multiply(new THREE.Matrix4().makeTranslation(-c.x,-c.y,-c.z));
  bakeMatrix(m); status('Rotated 90°.');
}

/* ----- pick face → highlight + remember world normal ----- */
const raycaster=new THREE.Raycaster();
raycaster.firstHitOnly=true;
const ndc=new THREE.Vector2();
function pointerNDC(ev){
  const r=renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX-r.left)/r.width)*2-1, -((ev.clientY-r.top)/r.height)*2+1);
  raycaster.setFromCamera(ndc,camera);
}
function rayPart(ev){ pointerNDC(ev); return S.partMesh? raycaster.intersectObject(S.partMesh,false)[0] : null; }

/* ======================================================================== *
 *  SCULPT (optional step) — symmetric brush over S.partMesh / S.baseGeo.
 *  Edits the welded/indexed base geometry in place, so the chain/CSG/export
 *  pipeline keeps working on a single mesh. See sculpt/*.js for the modules.
 * ======================================================================== */
const sculpt = new SculptController({ scene, camera, renderer, controls, raycaster });

// the part's mirror plane {p, n}: detected symmetry by default, manual X/Y/Z + offset override
const axisPlane=(ax,off)=>{ const n=new THREE.Vector3(ax==='x'?1:0, ax==='y'?1:0, ax==='z'?1:0); return {p:n.clone().multiplyScalar(off||0), n}; };
function partMirrorPlane(){
  return (!UI.sculptManual && S.symPlanes[0]) ? {p:S.symPlanes[0].p.clone(), n:S.symPlanes[0].n.clone()}
                                               : axisPlane(UI.sculptAxis||'x', UI.sculptOffset);
}
function applySculptMirror(){
  const {p,n}=partMirrorPlane();
  sculpt.setMirror(p, n, UI.sculptMirror);
}
function enterSculpt(){
  if(!S.baseGeo) return;
  ensureBVH();
  sculpt.attach(S.partMesh);
  sculpt.brush.type     = UI.sculptTool || BRUSH.DRAW;
  sculpt.brush.radius   = UI.sculptRadius;
  sculpt.brush.strength = UI.sculptStrength;
  applySculptMirror();
  history.clear();                 // fresh undo timeline for this sculpt session
  sculpt.enable();
  status('Sculpt: drag on the part. Alt+drag rotates the view, right-drag moves it.');
}
function exitSculpt(){
  sculpt.disable(); status('');
  // refresh everything downstream that reads S.baseGeo
  S.baseGeo.disposeBoundsTree?.(); S.baseGeo.boundsTree=null;   // chain build rebuilds via ensureBVH()
  S.meshDirty=true;
  updatePartEdges(); updateDebugViz(); updateMeshChips(); setAnchorRanges();
}
function sculptRepair(){
  if(!S.baseGeo) return;
  const fixed = repairGeometry(S.baseGeo);
  swapBaseGeometry(fixed);                 // welds, reassigns partMesh.geometry, disposes old BVH
  if(sculpt.active){ sculpt.attach(S.partMesh); applySculptMirror(); }  // rebuild adjacency/seam/BVH
  updateMeshChips();
  status('Repaired: welded, dropped degenerate triangles, recomputed normals.','ok');
}

/* ======================================================================== *
 *  HEIGHTMAP DISPLACEMENT (optional step) — paint an image as relief onto
 *  S.partMesh / S.baseGeo. Mirrors the sculpt enter/exit contract: edits the
 *  welded base geometry in place so the downstream pipeline keeps working on a
 *  single mesh. See heightmap/*.js for the modules.
 * ======================================================================== */
const heightEditor = new HeightmapEditor({ maxSize: 1024 });
const disp = new DisplacementController({ scene, camera, renderer, controls, raycaster });
heightEditor.onChange = (buf, w, h) => { if(disp.active) disp.setHeightBuffer(buf, w, h); };

/* ======================================================================== *
 *  EDIT HISTORY (undo / redo) — one step per brush stroke. Scoped per editing
 *  session: cleared whenever the baseline changes (mode enter / geometry swap /
 *  load), so a snapshot is never restored into a mesh of a different topology.
 * ======================================================================== */
const history = new EditHistory({ onChange: h => { if(UI){ UI.canUndo=h.canUndo; UI.canRedo=h.canRedo; } } });

// write a position snapshot back into the live base geometry (sculpt undo/redo)
function restorePositions(arr){
  const pos=S.baseGeo.attributes.position;
  pos.array.set(arr); pos.needsUpdate=true;
  S.baseGeo.boundsTree?.refit?.();
  S.baseGeo.computeVertexNormals();
  S.baseGeo.computeBoundingBox(); S.baseGeo.computeBoundingSphere();
}
const arraysEqual=(a,b)=>{ if(a.length!==b.length) return false; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; };

// --- sculpt: a step = the position delta of one stroke ---
let _sculptBefore=null;
sculpt.onStrokeStart=()=>{ _sculptBefore=S.baseGeo.attributes.position.array.slice(); };
sculpt.onStrokeEnd=()=>{
  if(!_sculptBefore) return;
  const before=_sculptBefore, after=S.baseGeo.attributes.position.array.slice();
  _sculptBefore=null;
  if(arraysEqual(before,after)) return;                 // brush missed the mesh — no step
  history.push('Sculpt stroke', ()=>restorePositions(before), ()=>restorePositions(after));
};

// --- heightmap: a step = the paint-mask delta; positions are re-derived ---
let _hmBeforeMask=null;
disp.onStrokeStart=()=>{ _hmBeforeMask=disp.mask.values.slice(); };
disp.onStrokeEnd=()=>{
  if(!_hmBeforeMask) return;
  const before=_hmBeforeMask, after=disp.mask.values.slice();
  _hmBeforeMask=null;
  if(arraysEqual(before,after)) return;
  const applyMask=(m)=>{ disp.mask.values.set(m); disp.redisplaceAll(); disp._finishNormals(); };
  history.push('Heightmap stroke', ()=>applyMask(before), ()=>applyMask(after));
};

// Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl+Y = redo — only while a brush mode
// is active, and never while typing in a field or one of the Monaco editors.
window.addEventListener('keydown', ev=>{
  if(!(sculpt.active || disp.active || decoEditable())) return;
  const t=ev.target;
  if(t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable||t.closest?.('.monaco-editor'))) return;
  if(!(ev.ctrlKey||ev.metaKey)) return;
  const k=ev.key.toLowerCase();
  if(k==='z'){ ev.preventDefault(); ev.shiftKey ? history.redo() : history.undo(); }
  else if(k==='y'){ ev.preventDefault(); history.redo(); }
});

function enterHeight(){
  if(!S.baseGeo) return;
  ensureBVH();
  disp.attach(S.partMesh, { camera });
  disp.brush.radius   = UI.hmRadius;
  disp.brush.strength = UI.hmFlow;
  disp.erase          = UI.hmErase;
  disp.strength       = UI.hmStrength;
  disp.direction      = UI.hmDir;
  disp.setMapping({ mode: UI.hmMode, axis: UI.hmAxis });
  if(heightEditor.out) disp.setHeightBuffer(heightEditor.out, heightEditor.width, heightEditor.height);
  history.clear();                 // fresh undo timeline for this heightmap session
  disp.enable();
  status(heightEditor.out ? 'Relief: drag on the part to paint it on. Alt+drag rotates the view.'
                          : 'Relief: load a greyscale image first, then drag on the part to paint it on.');
}
function exitHeight(){
  disp.disable(); status('');
  // same downstream invalidation as exitSculpt — geometry changed in place
  S.baseGeo.disposeBoundsTree?.(); S.baseGeo.boundsTree=null;
  S.meshDirty=true;
  updatePartEdges(); updateDebugViz(); updateMeshChips(); setAnchorRanges();
}

function clearHighlight(){ if(S.highlight){scene.remove(S.highlight);S.highlight.geometry.dispose();S.highlight=null;} }

function pickFace(hit){
  clearHighlight();
  const a=hit.face, posAttr=S.baseGeo.attributes.position;
  S.pickedNormal=hit.face.normal.clone().normalize();
  const g=new THREE.BufferGeometry();
  const vA=new THREE.Vector3().fromBufferAttribute(posAttr,a.a);
  const vB=new THREE.Vector3().fromBufferAttribute(posAttr,a.b);
  const vC=new THREE.Vector3().fromBufferAttribute(posAttr,a.c);
  g.setFromPoints([vA,vB,vC]); g.computeVertexNormals();
  S.highlight=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xffcc66,side:THREE.DoubleSide,
    transparent:true,opacity:.85,depthTest:false}));
  S.highlight.renderOrder=999; scene.add(S.highlight);
}

function layFlat(){
  if(!S.pickedNormal){status('Pick a face first.','err');return;}
  const q=new THREE.Quaternion().setFromUnitVectors(S.pickedNormal.clone(), new THREE.Vector3(0,0,-1));
  bakeMatrix(new THREE.Matrix4().makeRotationFromQuaternion(q));
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox, c=b.getCenter(new THREE.Vector3());
  bakeMatrix(new THREE.Matrix4().makeTranslation(-c.x,-c.y,-b.min.z));
  clearHighlight(); S.pickedNormal=null;
  alignInPlane();
  frameCamera();
  status('Laid flat on the picked face. Turn it 90° around Z if it points the wrong way.','ok');
}

/* ----- FLATTEN BOTTOM: slice off everything below a Z height, cap the new floor ----- */
const CUT_COL = { off:0xff4d4d, line:0xfff2a8 };
/* stop moving the plane; a cut that is in use stays on show on the Part page */
function clearCutPreview(){
  if(!UI) return;
  UI.cutPreview=false; updateCutPreview();
}
function hideCutViz(){
  if(S.cutViz){ scene.remove(S.cutViz); S.cutViz.traverse(o=>{ if(o!==S.cutViz.userData.off) o.geometry?.dispose(); o.material?.dispose(); }); S.cutViz=null; }
  cutXform.detach(); cutXform.visible=false; cutXform.enabled=false;
}
/* where the plane z = h cuts the part: one line segment per crossed triangle, as [x,y, x,y, …] */
function cutSegments(h){
  ensureBVH();
  const out=[], P=[null,null,null];
  S.baseGeo.boundsTree.shapecast({
    intersectsBounds: box=>box.min.z<=h && box.max.z>=h,
    intersectsTriangle: tri=>{
      P[0]=tri.a; P[1]=tri.b; P[2]=tri.c;
      for(let i=0;i<3;i++){
        const a=P[i], b=P[(i+1)%3];
        if((a.z<h)===(b.z<h)) continue;                 // this edge does not cross the plane
        const t=(h-a.z)/(b.z-a.z);
        out.push(a.x+(b.x-a.x)*t, a.y+(b.y-a.y)*t);
      }
    }
  });
  return out;
}
/* The cut on the Part page: a sheet at the cut height, everything below it — what the links lose — in red, and the
   line where the sheet goes through the part (the edge of the new bottom) as a bright band. Shown while the plane is
   being moved (with its arrow), and for as long as a cut is in use. The part itself is never cut. */
function updateCutPreview(){
  const edit=UI.cutPreview;
  if(!S.baseGeo || S.uiStep!=='s1' || !(edit || UI.cutOn)){ hideCutViz(); return; }
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox, s=b.getSize(new THREE.Vector3()), h=edit?UI.cutHeight:UI.cutAt;
  if(!S.cutViz){
    const g=S.cutViz=new THREE.Group();
    const sheet=new THREE.Mesh(new THREE.PlaneGeometry(1,1),
      new THREE.MeshBasicMaterial({color:CUT_COL.off,transparent:true,opacity:.16,side:THREE.DoubleSide,depthWrite:false}));
    sheet.renderOrder=996;
    const off=new THREE.Mesh(S.baseGeo, new THREE.MeshBasicMaterial({color:CUT_COL.off,transparent:true,opacity:.62,side:THREE.DoubleSide,
      depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1,     // lies on the part's own surface
      clippingPlanes:[new THREE.Plane(new THREE.Vector3(0,0,-1),0)]}));                     // only what is below the sheet
    off.renderOrder=997;
    const band=new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({color:CUT_COL.line,side:THREE.DoubleSide,depthTest:false,transparent:true}));
    band.renderOrder=999;
    const line=new THREE.LineSegments(new THREE.BufferGeometry(),          // the same line once more: still there when the sheet is seen edge-on
      new THREE.LineBasicMaterial({color:CUT_COL.line,depthTest:false,transparent:true}));
    line.renderOrder=999;
    g.add(sheet,off,band,line); g.userData={sheet,off,band,line};
    scene.add(g);
  }
  if(edit && !cutXform.object){ cutXform.attach(cutHandle); cutXform.visible=true; cutXform.enabled=true; }
  if(!edit && cutXform.object){ cutXform.detach(); cutXform.visible=false; cutXform.enabled=false; }
  const {sheet,off,band,line}=S.cutViz.userData;
  if(off.geometry!==S.baseGeo) off.geometry=S.baseGeo;
  const cx=(b.min.x+b.max.x)/2, cy=(b.min.y+b.max.y)/2;
  sheet.scale.set(s.x*1.4+10, s.y*1.4+10, 1);
  sheet.position.set(cx,cy,h);
  off.material.clippingPlanes[0].constant=h;
  if(!cutXform.dragging) cutHandle.position.set(cx,cy,h);
  const seg=cutSegments(h), w=Math.max(0.12, s.length()*0.006)/2;     // half the band's width, in mm
  const lp=[], bp=[];
  for(let i=0;i+3<seg.length;i+=4){
    const x1=seg[i], y1=seg[i+1], x2=seg[i+2], y2=seg[i+3];
    let nx=y2-y1, ny=x1-x2; const l=Math.hypot(nx,ny); if(l<1e-9) continue;
    nx*=w/l; ny*=w/l;
    lp.push(x1,y1,h, x2,y2,h);
    bp.push(x1+nx,y1+ny,h, x2+nx,y2+ny,h, x2-nx,y2-ny,h,  x1+nx,y1+ny,h, x2-nx,y2-ny,h, x1-nx,y1-ny,h);
  }
  band.geometry.setAttribute('position', new THREE.Float32BufferAttribute(bp,3));
  line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lp,3));
}
/* "Flatten the bottom" was opened (or the Part page reopened with it open): the plane starts through the middle of the part */
function startCutPreview(center){
  if(!S.baseGeo || S.uiStep!=='s1') return;
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox;
  if(UI.cutOn) UI.cutHeight=UI.cutAt;                                  // a cut in use: that is where the plane is
  else if(center || !(UI.cutHeight>b.min.z && UI.cutHeight<b.max.z)) UI.cutHeight=+((b.min.z+b.max.z)/2).toFixed(1);
  UI.cutPreview=true; updateCutPreview();
  status('Drag the blue arrow up or down: everything shown in red is cut off.');
}
/* "Use this cut" / "Remove the cut": the height is a setting of the project — the links of the chain are cut there,
   the part keeps its shape (and so does the mesh saved with the project). */
async function applyCut(){
  if(!S.baseGeo) return;
  const z=UI.cutHeight;
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox;
  if(!(z>b.min.z)){ status('The cut height is at the very bottom — nothing would be cut off.','warn'); return; }
  if(z>=b.max.z){ status('Cut height is at or above the part — nothing would be left.','err'); return; }
  UI.cutAt=z; UI.cutOn=true;
  status('Cutting…'); await new Promise(r=>setTimeout(r,10));     // let the status line repaint
  if(!cutChanged()){ UI.cutOn=false; cutChanged(); status('This part could not be cut at that height.','err'); return; }
  status(`The links are cut ${(z-b.min.z).toFixed(1)} mm above the bottom. The part itself stays as it is.`,'ok');
}
function removeCut(){
  if(!UI.cutOn) return;
  UI.cutOn=false; cutChanged();
  status('Cut removed — the links are whole again.','ok');
}
/* the cut was set, moved or removed → everything made from the part for the chain is made again; false: the cut failed */
function cutChanged(){
  dropCutGeo();
  const ok = !UI.cutOn || chainPartGeo()!==S.baseGeo;
  updateMirroredBase();
  if(S.poses.length) regen();
  updateCutPreview();
  return ok;
}
function dropCutGeo(){
  if(S.cutGeo){ S.cutGeo.disposeBoundsTree?.(); S.cutGeo.dispose(); }
  S.cutGeo=null; S.cutKey='';
}
/* What the links of the chain are made of: the part — with its bottom cut off where "Flatten the bottom" says so.
   Made when first needed and again when the part or the height has changed. */
function chainPartGeo(){
  if(!UI || !UI.cutOn || !S.baseGeo) return S.baseGeo;
  const pos=S.baseGeo.attributes.position, col=S.baseGeo.attributes.color;
  const key=[S.baseGeo.uuid, pos.version, col?col.version:'', UI.cutAt].join('|');
  if(S.cutKey!==key){ dropCutGeo(); S.cutKey=key; S.cutGeo=cutPart(S.baseGeo, UI.cutAt); }
  return S.cutGeo || S.baseGeo;                       // null: nothing to cut at that height, or the cut failed
}
/* how far the cut part was moved down to sit on the plate again (things placed on the part — morph points — go along) */
function cutShift(){ return (UI && UI.cutOn && chainPartGeo()===S.cutGeo && S.cutGeo) ? S.cutGeo.userData.shift : 0; }
/* slice everything below z off (boolean with a box), close the new bottom, and set it down on z = 0 */
function cutPart(src, cutZ){
  src.computeBoundingBox();
  const b=src.boundingBox;
  if(!(cutZ>b.min.z && cutZ<b.max.z)) return null;
  const size=b.getSize(new THREE.Vector3()), c=b.getCenter(new THREE.Vector3()), vc=hasVColor(src);
  const boxH=(cutZ-b.min.z)+10;                      // reaches well below the part, top face = cutZ
  let boxGeo=new THREE.BoxGeometry(size.x*3+20,size.y*3+20,boxH), part=src;
  if(vc){                                            // a coloured part: the new bottom takes the colour most common just above the cut
    const ca=src.getAttribute('color'), pa=src.getAttribute('position'), band=Math.max(0.5,size.z*0.08), hist=new Map();
    for(const lim of [cutZ+band, Infinity]){
      for(let i=0;i<pa.count;i++){ const z=pa.getZ(i); if(z<cutZ||z>lim) continue;
        const k=colourKey(ca.getX(i),ca.getY(i),ca.getZ(i)), e=hist.get(k); if(e) e[3]++; else hist.set(k,[ca.getX(i),ca.getY(i),ca.getZ(i),1]); }
      if(hist.size) break;
    }
    const top=[...hist.values()].sort((x,y)=>y[3]-x[3])[0]||[1,1,1];
    part=solidWithColor(src, WHITE);
    const plain=boxGeo; boxGeo=solidWithColor(plain, new THREE.Color(top[0],top[1],top[2])); plain.dispose();
  }
  try{
    const brushA=new Brush(part); brushA.updateMatrixWorld();
    const brushB=new Brush(boxGeo);
    brushB.position.set(c.x,c.y,cutZ-boxH/2); brushB.updateMatrixWorld();
    const evaluator=new Evaluator(); evaluator.attributes=vc?['position','normal','color']:['position','normal'];   // our geometries carry no uvs
    const raw=evaluator.evaluate(brushA,brushB,SUBTRACTION).geometry;
    raw.computeBoundingBox();
    if(!raw.attributes.position.count || !isFinite(raw.boundingBox.min.z)){ raw.dispose(); return null; }
    const shift=raw.boundingBox.min.z;
    raw.translate(0,0,-shift);                         // the new floor sits on z = 0
    const g=weldByPosition(raw); raw.dispose();
    g.computeBoundingBox(); g.computeBoundingSphere();
    g.userData.shift=shift;
    return g;
  }catch(e){ console.warn('cutting the part failed:',e); return null; }
  finally{ boxGeo.dispose(); if(part!==src) part.dispose(); }
}

function centerPart(){
  if(!S.baseGeo) return;
  S.baseGeo.computeBoundingBox();
  const c=S.baseGeo.boundingBox.getCenter(new THREE.Vector3());
  bakeMatrix(new THREE.Matrix4().makeTranslation(-c.x,-c.y,-c.z));
  frameCamera();
  status('Part centered at (0, 0, 0).','ok');
}

function alignInPlane(){
  if(!S.baseGeo) return;
  const pos=S.baseGeo.attributes.position, n=pos.count;
  let cx=0,cy=0;
  for(let i=0;i<n;i++){cx+=pos.getX(i);cy+=pos.getY(i);}
  cx/=n; cy/=n;
  let sxx=0,sxy=0,syy=0;
  for(let i=0;i<n;i++){const dx=pos.getX(i)-cx,dy=pos.getY(i)-cy;sxx+=dx*dx;sxy+=dx*dy;syy+=dy*dy;}
  const angle=0.5*Math.atan2(2*sxy,sxx-syy);      // major-axis angle of the 2D footprint
  const T=new THREE.Matrix4().makeTranslation(-cx,-cy,0);
  const R=new THREE.Matrix4().makeRotationZ(-angle);
  bakeMatrix(new THREE.Matrix4().multiplyMatrices(R,T));
}

/* ----- MIRROR-SYMMETRY DETECTION ----- */
function geoCentroid(){
  const pos=S.baseGeo.attributes.position,n=pos.count;let x=0,y=0,z=0;
  for(let i=0;i<n;i++){x+=pos.getX(i);y+=pos.getY(i);z+=pos.getZ(i);}
  return new THREE.Vector3(x/n,y/n,z/n);
}
const _symTarget={};
function symScore(pts,c,n){
  n=n.clone().normalize(); let sum=0,cnt=0;
  const r=new THREE.Vector3();
  for(const p of pts){
    const d=r.copy(p).sub(c).dot(n);
    r.copy(p).addScaledVector(n,-2*d);                  // reflect p across plane
    const hit=S.baseGeo.boundsTree.closestPointToPoint(r,_symTarget);
    if(hit){sum+=hit.distance*hit.distance;cnt++;}
  }
  return cnt? Math.sqrt(sum/cnt):Infinity;               // RMS distance (mm)
}
const angleModPi=a=>{a=((a%Math.PI)+Math.PI)%Math.PI; return a>Math.PI/2? a-Math.PI : a;};

/* the vertical mirror planes of the part, best first (none found: empty) — and how far off each one is */
function findSymPlanes(){
  ensureBVH();
  const pos=S.baseGeo.attributes.position, n=pos.count;
  const stride=Math.max(1,Math.floor(n/1400));         // subsample for speed
  const pts=[];
  for(let i=0;i<n;i+=stride) pts.push(new THREE.Vector3().fromBufferAttribute(pos,i));
  const c=geoCentroid();
  S.baseGeo.computeBoundingBox();
  const diag=S.baseGeo.boundingBox.getSize(new THREE.Vector3()).length()||1;
  const tol=0.02*diag;                                 // "symmetric" if RMS < 2% of bbox diag
  const STEPS=72;
  const score=θ=>symScore(pts,c,new THREE.Vector3(Math.cos(θ),Math.sin(θ),0));
  const arr=[];
  for(let i=0;i<STEPS;i++){const θ=Math.PI*i/STEPS; arr.push({θ,s:score(θ)});}
  const found=[];
  for(let i=0;i<STEPS;i++){
    const a=arr[(i-1+STEPS)%STEPS].s, b=arr[i].s, d=arr[(i+1)%STEPS].s;
    if(b<tol && b<=a && b<=d){
      let best=arr[i];
      for(let r=-1;r<=1.0001;r+=0.1){
        const θ=arr[i].θ+r*(Math.PI/STEPS), s=score(θ);
        if(s<best.s)best={θ,s};
      }
      found.push(best);
    }
  }
  found.sort((x,y)=>x.s-y.s);
  const planes=[];
  for(const f of found){
    if(planes.some(p=>Math.abs(angleModPi(p._θ-f.θ))<THREE.MathUtils.degToRad(4))) continue;
    planes.push({p:c.clone(),n:new THREE.Vector3(Math.cos(f.θ),Math.sin(f.θ),0),_θ:f.θ,score:f.s});
  }
  S.symPlanes=planes; S.symVisible=true;
  buildSymLines();
  const errs=planes.map(p=>(p.score/diag*100).toFixed(1)+'%').join(', ');
  UI.symOut = planes.length ? `<b>${planes.length}</b> mirror line(s) — error ${errs}.` : 'No vertical mirror symmetry detected.';
  return {planes, errs};
}
function detectSymmetry(){
  if(!S.baseGeo){status('Load a part first.','err');return;}
  status('Searching for mirror symmetry…');
  UI.symOut='Searching…';
  setTimeout(()=>{                                        // defer so the UI paints
    const {planes,errs}=findSymPlanes();
    if(planes.length) status(`Found ${planes.length} mirror line${planes.length>1?'s':''} (RMS error: ${errs}).`,'ok');
    else status('No vertical mirror symmetry found. Lay the part flat first, or it may be asymmetric.');
  },20);
}

function clearSymmetry(){
  if(S.symGroup){scene.remove(S.symGroup);S.symGroup.traverse(o=>o.geometry&&o.geometry.dispose());S.symGroup=null;}
  S.symPlanes=[]; if(UI)UI.symOut='';
}

function buildSymLines(){
  if(S.symGroup){scene.remove(S.symGroup);S.symGroup.traverse(o=>o.geometry&&o.geometry.dispose());}
  S.symGroup=new THREE.Group();
  S.baseGeo.computeBoundingBox();
  const L=(S.baseGeo.boundingBox.getSize(new THREE.Vector3()).length()||50)*0.6;
  const zAxis=new THREE.Vector3(0,0,1);
  const mat=new THREE.LineBasicMaterial({color:0xff3df0,transparent:true,opacity:.95,depthTest:false});
  for(const pl of S.symPlanes){
    const dir=new THREE.Vector3().crossVectors(pl.n,zAxis);
    if(dir.lengthSq()<1e-9) continue;                    // plane parallel to plate → no line
    dir.normalize();
    const a=pl.p.clone().addScaledVector(dir,-L), b=pl.p.clone().addScaledVector(dir,L);
    const g=new THREE.BufferGeometry().setFromPoints([a,b]);
    const line=new THREE.Line(g,mat); line.renderOrder=998;
    S.symGroup.add(line);
    const dot=new THREE.Mesh(new THREE.SphereGeometry(L*0.012,10,8),
      new THREE.MeshBasicMaterial({color:0xff3df0,depthTest:false}));
    dot.position.copy(pl.p); dot.renderOrder=998; S.symGroup.add(dot);
  }
  S.symGroup.visible=S.symVisible;
  scene.add(S.symGroup);
}

/* ======================================================================== *
 *  STEP 2 — LINK OFFSET + PIVOT (stored as the PIN / HOLE anchor points)
 * ======================================================================== */
/* A joint is stored as two points on the part: `hole` — where the link before holds this one — and
   `pin` — where this one holds the next. The Joints page edits them as what they mean for the chain:
     offset = pin − hole   how far the next link is shifted against this one (0 = exactly on top of it)
     pivot  = pin          the point the two turn around in a curved chain                              */
const linkOffset = ()=>new THREE.Vector3(UI.pin.x-UI.hole.x, UI.pin.y-UI.hole.y, (UI.pin.z||0)-(UI.hole.z||0));
function setLinkOffset(axis,v){
  if(!Number.isFinite(v)) return;
  if(axis==='z'){ UI.pin.z=(UI.hole.z||0)+v; return; }      // height: the first link stays on the plate
  const m=(UI.pin[axis]+UI.hole[axis])/2;                   // x / y: both ends share the move, so the pivot keeps its place between the links
  UI.pin[axis]=m+v/2; UI.hole[axis]=m-v/2;
}
function setPivot(axis,v){                                  // moves pin and hole together — the offset is untouched
  if(!Number.isFinite(v)) return;
  const d=v-UI.pin[axis];
  UI.pin[axis]+=d; UI.hole[axis]+=d;
}
/* Build the chain the other way round: the same path, every link turned by half a turn. The link's two joint
   points trade places — the same as sliding the next link to the exact opposite side on the Joints page.
   Only in X / Y: a height step keeps climbing. (The pin / hole watchers rebuild the chain.) */
function reverseChain(){
  if(!S.baseGeo || !anchorsValid()) return;
  const {x:px,y:py}=UI.pin, {x:hx,y:hy}=UI.hole;
  UI.pin.x=hx; UI.pin.y=hy; UI.hole.x=px; UI.hole.y=py;
}
function partCenter(){
  if(!S.baseGeo.boundingBox) S.baseGeo.computeBoundingBox();
  return S.baseGeo.boundingBox.getCenter(new THREE.Vector3());
}
/* the starting point: the next link exactly on top of this one, pivoting about the middle of the part */
function stackLinks(){
  const c=partCenter(), p={x:+c.x.toFixed(2), y:+c.y.toFixed(2), z:0};
  UI.pin={...p}; UI.hole={...p};
}

let pivotGizmo;
function makeCylinderGizmo(color){
  S.baseGeo.computeBoundingBox();
  const zsize=S.baseGeo.boundingBox.getSize(new THREE.Vector3()).z||10;
  const diag=S.baseGeo.boundingBox.getSize(new THREE.Vector3()).length()||40;
  const h=zsize*1.6+6, r=Math.max(0.6,diag*0.012);
  const g=new THREE.CylinderGeometry(r,r,h,20);
  g.rotateX(Math.PI/2);                 // axis Y → Z
  g.translate(0,0,h/2-2);               // base just under the plate, rising up
  return new THREE.Mesh(g,new THREE.MeshBasicMaterial({color,depthTest:false,transparent:true,opacity:.95}));
}
const pivotShown = ()=>S.uiStep==='s2' && UI.pivotOpen;      // the marker only shows while its controls are open
function buildGizmos(){
  if(pivotGizmo){scene.remove(pivotGizmo);pivotGizmo.geometry.dispose();}
  pivotGizmo=makeCylinderGizmo(CONST.PIN_COLOR); pivotGizmo.renderOrder=997;
  scene.add(pivotGizmo);
  buildMatePreview();
  syncGizmos();
}
function syncGizmos(){
  if(pivotGizmo){ pivotGizmo.position.set(UI.pin.x,UI.pin.y,UI.pin.z||0); pivotGizmo.visible=pivotShown(); }
  syncMatePreview();
}
/* Bound the sliders: the offset to a bit more than one part length either way, the pivot to the part's footprint (+30%). */
function setAnchorRanges(){
  if(!S.baseGeo) return;
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox, s=b.getSize(new THREE.Vector3()), d=linkOffset();
  const padX=Math.max(2,s.x*0.3), padY=Math.max(2,s.y*0.3);
  UI.anchorXmin=+(b.min.x-padX).toFixed(1); UI.anchorXmax=+(b.max.x+padX).toFixed(1);
  UI.anchorYmin=+(b.min.y-padY).toFixed(1); UI.anchorYmax=+(b.max.y+padY).toFixed(1);
  const span=(size,cur)=>Math.ceil(Math.max(2, size*1.3, Math.abs(cur)*1.2));   // a saved offset always fits its slider
  UI.offXmax=span(s.x,d.x); UI.offYmax=span(s.y,d.y); UI.offZmax=span(s.z,d.z);
}
function anchorsValid(){
  if(linkOffset().length()<1e-3){
    UI.anchorWarn='The next link sits exactly on top of this one — move it along X or Y first.';
    return false;
  }
  UI.anchorWarn='';
  return true;
}

/* ======================================================================== *
 *  STEP 3 — CHAIN GENERATION + SPIRAL CONTROLS + BVH COLLISION
 * ======================================================================== */
const P = ()=>({shape:UI.shape, count:UI.count, startR:UI.startR, spacing:UI.spacing, plate:UI.plate});

function pathPoint(t,n_it,n_it_nor,z_stack){
  let q; try{ q=S.pathFn ? S.pathFn(t,n_it,n_it_nor,z_stack) : null; }catch(e){ q=null; }
  if(!(q && Number.isFinite(q.x) && Number.isFinite(q.y))) return new THREE.Vector3(0,0,0);
  return new THREE.Vector3(q.x, q.y, Number.isFinite(q.z) ? q.z : 0);
}
/* per-axis link scale: the user's fn may return a plain number (uniform) or {x,y,z}. */
function linkScaleVec(i,count){
  const nor = count>1 ? i/(count-1) : 0;
  let s; try{ s=S.scaleFn(i,nor); }catch(e){ s=1; }
  if(typeof s==='number') s = (Number.isFinite(s)&&s>0) ? {x:s,y:s,z:s} : {x:1,y:1,z:1};
  const f=v=>(typeof v==='number'&&Number.isFinite(v)&&v>0) ? v : 1;
  return {x:f(s&&s.x), y:f(s&&s.y), z:f(s&&s.z)};
}
function buildPoses(){
  const p=P();
  const H=new THREE.Vector3(UI.hole.x,UI.hole.y,UI.hole.z||0), Pp=new THREE.Vector3(UI.pin.x,UI.pin.y,UI.pin.z||0);
  const Vloc=new THREE.Vector3().subVectors(Pp,H);   // local hole→pin (3D)
  const d=Vloc.length()||1;                          // physical pin↔hole distance, for reporting
  const scaleVecs=[];
  for(let i=0;i<p.count;i++) scaleVecs.push(linkScaleVec(i,p.count));

  // Per-link heading + chord target. An anisotropic scale skews the local pin→hole direction,
  // so (unlike a uniform scale) both depend on this link's own x/y scale, not a single global dir.
  const baseDirs=[], needXYs=[];
  for(let i=0;i<p.count;i++){
    const sv=scaleVecs[i];
    const lx=sv.x*Vloc.x, ly=sv.y*Vloc.y, len=Math.hypot(lx,ly);
    needXYs.push(len||1e-6);
    baseDirs.push(len>1e-9 ? new THREE.Vector3(lx/len,ly/len,0) : new THREE.Vector3(1,0,0));
  }

  const norOf=k=>p.count>1 ? k/(p.count-1) : 0;
  // cumulative lift from the pin/hole z offset (scaled per-link by THIS link's own z-scale), before
  // each link — stacks per link like stair risers. Computed up front so the path fn can see it as z_stack.
  const zStack=[0];
  for(let i=0;i<p.count;i++) zStack.push(zStack[i]+scaleVecs[i].z*Vloc.z);

  // XY-only chord distance — z (from the path's own formula, or zStack below) never feeds the
  // spacing search, so an arbitrary/discontinuous z can never perturb the in-plane layout.
  const distXY=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const Q=[pathPoint(0,0,norOf(0),zStack[0])];
  let t=0;
  for(let k=0;k<p.count;k++){
    const nor=norOf(k), zs=zStack[k], need=needXYs[k], prev=Q[k];
    const dist=u=>distXY(pathPoint(u,k,nor,zs),prev);
    const eps=Math.max(1e-3, Math.abs(t)*1e-3);
    let speed=dist(t+eps)/eps; if(!(speed>1e-9)) speed=1;
    let lo=t, hi=t + need/speed + eps;
    let guard=0; while(dist(hi)<need && guard++<500) hi += need/speed*0.5 + eps;   // expand until chord ≥ need
    for(let i=0;i<50;i++){ const mid=(lo+hi)/2; if(dist(mid)<need) lo=mid; else hi=mid; }
    t=(lo+hi)/2; Q.push(pathPoint(t,k,nor,zs));
  }
  const poses=[];                  // baseDir/dir are XY-only below — z (any source) only ever lifts, never tilts
  const seg=new THREE.Vector3(), dir=new THREE.Vector3(), hole3=new THREE.Vector3(), q=new THREE.Quaternion();
  let chainLen3D=0;
  for(let i=0;i<p.count;i++){
    const sv=scaleVecs[i], baseDir=baseDirs[i];
    seg.subVectors(Q[i+1],Q[i]);
    const lenXY=Math.hypot(seg.x,seg.y);
    if(lenXY>1e-9) dir.set(seg.x/lenXY,seg.y/lenXY,0); else dir.copy(baseDir);
    q.setFromUnitVectors(baseDir,dir);               // rotation is always about Z — z never tilts the link
    const m=new THREE.Matrix4().makeRotationFromQuaternion(q);
    m.scale(new THREE.Vector3(sv.x,sv.y,sv.z));      // m = R · S (per-axis)
    hole3.copy(H).applyMatrix4(m);                   // (R·S)·hole (m has no translation yet)
    m.setPosition(Q[i].x-hole3.x, Q[i].y-hole3.y, Q[i].z+zStack[i]-hole3.z);
    poses.push(m);
    chainLen3D += Math.hypot(sv.x*Vloc.x, sv.y*Vloc.y, sv.z*Vloc.z);
  }
  S.scales=scaleVecs;
  S.chainLength = chainLen3D;
  S.linkSpan = d;   // single-link hole→pin distance (mm), unscaled — for reporting
  return poses;
}

// /* ---- per-part size variation ---- */
// const DEFAULT_SCALE_CODE =
//   `// n_it     – index of this part (0 … count-1)
//   // n_it_nor – that index normalized to 0 … 1
//   // Return either a single number (uniform scale) or {x, y, z} to scale each axis
//   // independently (1 = original size on that axis; any axis you omit defaults to 1).
//   //
//   // Most patterns below share two knobs:
//   //   freq – how many cycles run across the whole chain (1 = one cycle)
//   //   amp  – peak deviation from 1 (the original size)
//   const TAU = Math.PI * 2;

//   // ── sine wave: smooth swell, dips below 1 as well as above ──
//   let freq = 1, amp = 0.05;
//   const n = 1 + Math.sin(n_it_nor * TAU * freq) * amp;
//   return { x: n, y: n, z: n };

//   // ── linear triangle (in/out ease): up then down, sharp peak ──
//   // let freq = 1, amp = 1;
//   // const tri = (-Math.abs(((n_it_nor * freq) % 1) - 0.5) + 0.5) * 2; // 0→1→0
//   // const n = 1 + tri * amp;
//   // return { x: n, y: n, z: n };

//   // ── cosine ease (smoothstep): 1 → 1+amp → 1, no kinks ──
//   // let freq = 1, amp = 0.5;
//   // const ease = (1 - Math.cos(((n_it_nor * freq) % 1) * TAU)) / 2;   // 0→1→0
//   // const n = 1 + ease * amp;
//   // return { x: n, y: n, z: n };

//   // ── pulse / square: alternate big & small in blocks ──
//   // let freq = 4, amp = 0.3;
//   // const n = 1 + (((n_it_nor * freq) % 1) < 0.5 ? amp : -amp);
//   // return { x: n, y: n, z: n };`;
const SCALE_DOC = `// n_it = link number (0 … count-1), n_it_nor = the same from 0 … 1.
// Return a number, or {x, y, z} to scale each axis (1 = original size).
`;
/* one-click starting points for the size editor (the "Size along the chain" preset buttons) */
const SCALE_PRESETS = {
  same  : SCALE_DOC + `
// Every link the same size.
return 1;`,
  taper : SCALE_DOC + `
// Taper: full size at the start, shrinking to "end" at the last link.
const end = 0.5;
return 1 + (end - 1) * n_it_nor;`,
  grow  : SCALE_DOC + `
// Grow: starts at "start", reaching full size at the last link.
const start = 0.5;
return start + (1 - start) * n_it_nor;`,
  belly : SCALE_DOC + `
// Belly: thickest in the middle, slimmer towards both ends.
const amp = 0.4;
return 1 - amp + amp * Math.sin(n_it_nor * Math.PI);`,
  wave  : SCALE_DOC + `
// Wave: swells and shrinks several times along the chain.
const waves = 4, amp = 0.15;
return 1 + amp * Math.sin(n_it_nor * Math.PI * 2 * waves);`,
  scales: SCALE_DOC + `const TAU = Math.PI * 2;

// Zig-zag: repeated ramps that also taper off towards the end.
let n_freq = 6;
let nitn = (n_it_nor*n_freq)%1;
let namp = .3;
let noff = 1;
let ny_linear = (-Math.abs(nitn-0.5)+0.5)*namp + noff;


let ny_sine = (Math.sin(nitn*TAU)*.5+0.5)*namp;
let n = ny_linear;
n-= n_it_nor*.2;
return { x: n, y: n, z: n };`,
};
const DEFAULT_SCALE_CODE = SCALE_PRESETS.same;

function compileScaleFn(code){
  let fn;
  try{
    fn = new Function('n_it','n_it_nor', code);   // user's own machine → eval is the feature
    const ok=v=> (typeof v==='number' && Number.isFinite(v))
      || (v && typeof v==='object' && ['x','y','z'].every(k=> !(k in v) || (typeof v[k]==='number' && Number.isFinite(v[k]))));
    const t = fn(0, 0);
    if(!ok(t)) throw new Error('function must return a finite number, or {x, y, z} finite numbers');
  }catch(e){ return {err:e.message}; }
  return {fn};
}
function applyScaleCode(code){
  S.scaleCode=code;
  const {fn,err}=compileScaleFn(code);
  if(err){ UI.scaleErr='⚠ '+err; UI.scaleErrColor='var(--bad)'; return; }
  UI.scaleErr='✓ applied'; UI.scaleErrColor='var(--accent2)';
  S.scaleFn=fn; debounceRegen();
}
let scaleEditor=null;
async function ensureScaleEditor(){
  if(scaleEditor) return;
  let monaco;
  try{ monaco=await window.monacoReady; }
  catch(err){ UI.scaleErr='Monaco failed to load — using the default size function.'; UI.scaleErrColor='var(--warn)'; return; }
  scaleEditor=monaco.editor.create($('scaleEditor'),{
    value:S.scaleCode||DEFAULT_SCALE_CODE,
    language:'javascript', theme:'vs-dark',
    minimap:{enabled:false}, fontSize:12, lineNumbers:'off', folding:false, glyphMargin:false,
    lineDecorationsWidth:10, wordWrap:'on', tabSize:2,
    scrollBeyondLastLine:false, automaticLayout:true, padding:{top:8,bottom:8},
  });
  scaleEditor.onDidChangeModelContent(()=>applyScaleCode(scaleEditor.getValue()));
}

/* ---- per-part colour ---- */
const COLOR_DOC =
`// n_it     – index of this part (0 … count-1)
// n_it_nor – that index normalized to 0 … 1
// base     – this part's natural colour as {r, g, b}, each 0 … 1
// Return one of:
//   'invert'  – swap this part's colours (e.g. white<->green on a 2-colour model)
//   a colour  – tint this part: hex (0xff0000), CSS ('#ff0000' / 'tomato'),
//               or {r, g, b} 0…1. The tint MULTIPLIES a coloured model's own
//               colours; on a plain, un-coloured part it sets the colour outright.
//   base      – leave this part untouched
`;
const DEFAULT_COLOR_CODE = COLOR_DOC + `
// Swap the colours on every 2nd part:
if (n_it % 2 === 1) return 'invert';
return base;`;
/* one-click starting points for the colour editor (the "Colour along the chain" preset buttons) */
const COLOR_PRESETS = {
  alternate: DEFAULT_COLOR_CODE,
  plain    : COLOR_DOC + `
// Every link keeps its own colour.
return base;`,
  stripes  : COLOR_DOC + `
// Two colours in turn — on a plain part too (each colour becomes a filament).
return n_it % 2 ? '#ff7a1a' : '#f2f2f2';`,
  gradient : COLOR_DOC + `
// Blend from one colour to another along the chain (r, g, b each 0 … 1).
const from = [0.20, 0.60, 1.00], to = [1.00, 0.30, 0.50];
const mix = i => from[i] + (to[i] - from[i]) * n_it_nor;
return { r: mix(0), g: mix(1), b: mix(2) };`,
  rainbow  : COLOR_DOC + `
// Rainbow along the chain.
return 'hsl(' + Math.round(n_it_nor * 300) + ', 80%, 55%)';`,
};

function isInvert(v){ return v==='invert' || (v && typeof v==='object' && v.invert===true); }
// Mutate `out` (a THREE.Color) from a user-returned colour value; leave it
// unchanged if the value isn't a colour we recognise.
function applyColorValue(out, v){
  if(typeof v==='number' && Number.isFinite(v)){ out.setHex(v & 0xffffff); return; }
  if(typeof v==='string'){ try{ out.set(v); }catch(e){} return; }
  if(Array.isArray(v) && v.length>=3 && [v[0],v[1],v[2]].every(n=>Number.isFinite(+n))){ out.setRGB(+v[0],+v[1],+v[2]); return; }
  if(v && typeof v==='object'){
    const r=+v.r, g=+v.g, b=+v.b;
    if([r,g,b].every(Number.isFinite)) out.setRGB(r,g,b);
  }
}
// Evaluate the user's colour fn for part i. Writes the instance tint into `_tmpCol`
// and returns 1 if the part should be colour-swapped (vc models) else 0.
function linkPaint(i, count, base, vc){
  _tmpCol.copy(base);
  if(!S.colorFn) return 0;
  const nor = count>1 ? i/(count-1) : 0;
  let v; try{ v=S.colorFn(i, nor, {r:base.r, g:base.g, b:base.b}); }catch(e){ return 0; }
  if(isInvert(v)){
    if(vc) return 1;                                   // real palette swap via the chain shader
    _tmpCol.setRGB(1-base.r, 1-base.g, 1-base.b);      // plain part → just invert its flat colour
    return 0;
  }
  applyColorValue(_tmpCol, v);                         // a colour → tint
  return 0;
}
function compileColorFn(code){
  let fn;
  try{
    fn = new Function('n_it','n_it_nor','base', code);   // user's own machine → eval is the feature
    fn(0, 0, {r:1,g:1,b:1});                              // smoke-test: must run without throwing
  }catch(e){ return {err:e.message}; }
  return {fn};
}
function applyColorCode(code){
  S.colorCode=code;
  const {fn,err}=compileColorFn(code);
  if(err){ UI.colorErr='⚠ '+err; UI.colorErrColor='var(--bad)'; return; }
  UI.colorErr='✓ applied'; UI.colorErrColor='var(--accent2)';
  S.colorFn=fn; debounceRegen();
}
let colorEditor=null;
async function ensureColorEditor(){
  if(colorEditor) return;
  let monaco;
  try{ monaco=await window.monacoReady; }
  catch(err){ UI.colorErr='Monaco failed to load — using the default colour function.'; UI.colorErrColor='var(--warn)'; return; }
  colorEditor=monaco.editor.create($('colorEditor'),{
    value:S.colorCode||DEFAULT_COLOR_CODE,
    language:'javascript', theme:'vs-dark',
    minimap:{enabled:false}, fontSize:12, lineNumbers:'off', folding:false, glyphMargin:false,
    lineDecorationsWidth:10, wordWrap:'on', tabSize:2,
    scrollBeyondLastLine:false, automaticLayout:true, padding:{top:8,bottom:8},
  });
  colorEditor.onDidChangeModelContent(()=>applyColorCode(colorEditor.getValue()));
}

/* ---- chain centre-line ---- */
/* (the full explanation of t / n_it / z_stack lives in the panel, under "How the code works") */
const PATH_DOC =
`// Chain centre-line: return the point {x, y, z} in mm for a position t along the curve.
// t grows continuously (NOT one per link) — count links with n_it (0 … count-1) or n_it_nor (0 … 1).
// z only lifts a link, never tilts it. z_stack = height already added by the link offset's Z.`;
// shape: 'straight' (default) or 'spiral'. The Shape selector + sliders rewrite this function.
function pathCodeFor(shape, a, b){
  const f=n=>Number.isFinite(n)?String(Math.round(n*1000)/1000):'0';
  if(shape==='spiral')
    return PATH_DOC + `
// Archimedean spiral r = a + bθ. The Start-radius / Loop-spacing sliders rewrite a, b below.
const a = ${f(a)};          // start radius (mm)
const b = ${f(b)};          // loop spacing / 2π
const r = a + b * t;
return { x: r * Math.cos(t), y: r * Math.sin(t), z: 0 };`;
  return PATH_DOC + `
// Straight chain along +X. The link pitch comes from the link offset (Joints page), not from t.
return { x: t, y: 0, z: 0 };`;
}
function compilePathFn(code){
  let fn;
  try{
    fn = new Function('t','n_it','n_it_nor','z_stack', code);  // user's own machine → eval is the feature
    const ok=p=>p && Number.isFinite(p.x) && Number.isFinite(p.y);
    if(!ok(fn(0,0,0,0)) || !ok(fn(1,0,0,0))) throw new Error('function must return {x, y} finite numbers');
  }catch(e){ return {err:e.message}; }
  return {fn};
}
function applyPathCode(code){
  S.pathCode=code;
  const {fn,err}=compilePathFn(code);
  if(err){ UI.pathErr='⚠ '+err; UI.pathErrColor='var(--bad)'; return; }   // keep last good fn
  UI.pathErr='✓ applied'; UI.pathErrColor='var(--accent2)';
  S.pathFn=fn; debounceRegen();
}
function regeneratePathFromSliders(){
  const a=Math.max(0,UI.startR), b=UI.spacing/(2*Math.PI);
  const code=pathCodeFor(UI.shape, a, b);
  if(pathEditor){ pathEditor.setValue(code); }   // change listener recompiles + regens
  else applyPathCode(code);
}
let pathEditor=null;
async function ensurePathEditor(){
  if(pathEditor) return;
  let monaco;
  try{ monaco=await window.monacoReady; }
  catch(err){ UI.pathErr='Monaco failed to load — using the default spiral path.'; UI.pathErrColor='var(--warn)'; return; }
  pathEditor=monaco.editor.create($('pathEditor'),{
    value:S.pathCode||pathCodeFor('straight',25,16/(2*Math.PI)),
    language:'javascript', theme:'vs-dark',
    minimap:{enabled:false}, fontSize:12, lineNumbers:'off', folding:false, glyphMargin:false,
    lineDecorationsWidth:10, wordWrap:'on', tabSize:2,
    scrollBeyondLastLine:false, automaticLayout:true, padding:{top:8,bottom:8},
  });
  pathEditor.onDidChangeModelContent(()=>applyPathCode(pathEditor.getValue()));
}

const _HIDDEN=new THREE.Matrix4().makeScale(0,0,0);
const WHITE=new THREE.Color(0xffffff);   // neutral instance tint → lets a model's own vertex colors show
const _tmpCol=new THREE.Color();         // scratch colour reused per setColorAt call
// Inject a per-instance colour swap into the chain material: when aSwap=1, reflect
// the vertex colour through the palette mid-point (SWAP_SUM - colour) — a true
// white↔green swap that a multiply tint (instanceColor) physically can't do.
function installSwapShader(mat){
  mat.onBeforeCompile=(shader)=>{
    shader.uniforms.uSwapSum = SWAP_UNIFORM;
    shader.vertexShader = 'attribute float aSwap;\nuniform vec3 uSwapSum;\n' +
      shader.vertexShader.replace('#include <color_vertex>',
        '#include <color_vertex>\n#ifdef USE_COLOR\n\tif(aSwap > 0.5) vColor.rgb = uSwapSum - vColor.rgb;\n#endif');
  };
  mat.customProgramCacheKey=()=>'chain-swap';
}
// Set every instance's tint (and the swap attribute on coloured models). `bad` is the
// collision set (null on the first paint); colliding links are forced red, no swap.
function paintChain(poses, bad){
  const vc=hasVColor(S.baseGeo);
  const swapArr = vc ? new Float32Array(poses.length) : null;
  for(let i=0;i<poses.length;i++){
    const base = vc?WHITE:(i===0?CONST.LINK_SEED_COLOR:CONST.LINK_OK_COLOR);
    let sw=0;
    if(bad && bad.has(i)) _tmpCol.copy(CONST.LINK_BAD_COLOR);
    else sw=linkPaint(i, poses.length, base, vc);
    if(swapArr) swapArr[i]=sw;
    S.chain.setColorAt(i, _tmpCol);
  }
  if(S.chain.instanceColor) S.chain.instanceColor.needsUpdate=true;
  if(vc) S.baseGeo.setAttribute('aSwap', new THREE.InstancedBufferAttribute(swapArr,1));
}
/* ======================================================================== *
 *  MIRROR HALF — build a full symmetric part from a half-mesh at chain time
 * ======================================================================== */
function detectHalfPart(){
  if(!S.baseGeo) return null;
  S.baseGeo.computeBoundingBox();
  const bb=S.baseGeo.boundingBox;
  const pos=S.baseGeo.getAttribute('position');
  const n=pos.count;
  let best=null;
  for(let axIdx=0;axIdx<3;axIdx++){
    const axName=['x','y','z'][axIdx];
    const min=bb.min[axName], max=bb.max[axName];
    const span=max-min; if(span<0.001) continue;
    const eps=span*0.015;
    let atMin=0, atMax=0;
    for(let i=0;i<n;i++){
      const v=pos.getComponent(i,axIdx);
      if(Math.abs(v-min)<eps) atMin++;
      if(Math.abs(v-max)<eps) atMax++;
    }
    for(const [cnt,offset] of [[atMin,min],[atMax,max]]){
      const pct=cnt/n;
      if(!best||pct>best.pct) best={axis:axName,axIdx,offset,pct};
    }
  }
  return (best&&best.pct>=0.08)?best:null;
}

function buildMirroredGeo(srcGeo){
  const axIdx=UI.mirrorAxis==='x'?0:UI.mirrorAxis==='y'?1:2;
  const off=UI.mirrorOffset;
  // always non-indexed so winding flip is straightforward
  const orig=srcGeo.index?srcGeo.toNonIndexed():srcGeo.clone();
  const half2=orig.clone();
  // reflect positions
  const pos=half2.getAttribute('position');
  for(let i=0;i<pos.count;i++) pos.setComponent(i,axIdx,2*off-pos.getComponent(i,axIdx));
  pos.needsUpdate=true;
  // reverse winding (swap vertex 0 ↔ vertex 2 in every tri) for all attributes except normals
  for(const [name,attr] of Object.entries(half2.attributes)){
    if(name==='normal') continue;
    const arr=attr.array, sz=attr.itemSize;
    for(let t=0;t<pos.count;t+=3){
      for(let c=0;c<sz;c++){
        const tmp=arr[t*sz+c]; arr[t*sz+c]=arr[(t+2)*sz+c]; arr[(t+2)*sz+c]=tmp;
      }
    }
    attr.needsUpdate=true;
  }
  half2.computeVertexNormals();
  let merged;
  try{ merged=BufferGeometryUtils.mergeGeometries([orig,half2],false); }
  catch(e){ orig.dispose(); half2.dispose(); return srcGeo.clone(); }
  orig.dispose(); half2.dispose();
  const welded=BufferGeometryUtils.mergeVertices(merged,0.01);
  merged.dispose();
  welded.computeVertexNormals(); welded.computeBoundingBox(); welded.computeBoundingSphere();
  welded.disposeBoundsTree?.(); welded.boundsTree=null;
  return welded;
}

function updateMirroredBase(){
  if(S.mirroredBaseGeo){ S.mirroredBaseGeo.dispose(); S.mirroredBaseGeo=null; }
  if(UI&&UI.mirrorEnabled&&S.baseGeo) S.mirroredBaseGeo=buildMirroredGeo(chainPartGeo());
}
let mirrorRegenTimer=null;
function debounceMirrorRegen(){
  clearTimeout(mirrorRegenTimer);
  mirrorRegenTimer=setTimeout(()=>{ updateMirroredBase(); if(S.poses.length) regen(); },250);
}

function disposeLSChainGroup(){
  if(!S.lsChainGroup) return;
  scene.remove(S.lsChainGroup);
  S.lsChainGroup.traverse(o=>{ if(o.isMesh){ o.geometry.dispose(); o.material.dispose(); } });
  S.lsChainGroup=null;
}

function buildLSChainGroup(poses){
  disposeLSChainGroup();
  if(!S.lsNodes.length || !poses.length) return;
  const N=poses.length, vc=hasVColor(S.baseGeo);
  const group=new THREE.Group();
  for(let i=0;i<N;i++){
    if(S.overrides.has(i)) continue;   // overrideGroup handles custom slots
    const nor=N>1?i/(N-1):0;
    // use cached mirrored base if mirror is enabled (much faster than rebuilding per link)
    const geo=(UI&&UI.mirrorEnabled&&S.mirroredBaseGeo)?S.mirroredBaseGeo.clone():linkGeom(i).clone();
    applyLSDeform(geo,i,nor,cutShift());
    const base=vc?WHITE:(i===0?CONST.LINK_SEED_COLOR:CONST.LINK_OK_COLOR);
    linkPaint(i,N,base,vc);            // writes result into _tmpCol
    const mat=new THREE.MeshStandardMaterial({color:_tmpCol.clone(),metalness:0.05,roughness:0.7});
    const mesh=new THREE.Mesh(geo,mat);
    linkWorldMatrix(i).decompose(mesh.position,mesh.quaternion,mesh.scale);
    mesh.userData.linkIndex=i;
    group.add(mesh);
  }
  S.lsChainGroup=group;
  scene.add(group);
}

function recolorLSChain(bad){
  if(!S.lsChainGroup) return;
  const N=S.poses.length, vc=hasVColor(S.baseGeo);
  for(const mesh of S.lsChainGroup.children){
    const i=mesh.userData.linkIndex;
    if(bad&&bad.has(i)){ mesh.material.color.copy(CONST.LINK_BAD_COLOR); continue; }
    const base=vc?WHITE:(i===0?CONST.LINK_SEED_COLOR:CONST.LINK_OK_COLOR);
    linkPaint(i,N,base,vc);
    mesh.material.color.copy(_tmpCol);
  }
}

function renderChain(poses){
  if(S.chain){scene.remove(S.chain);S.chain.dispose();}
  disposeLSChainGroup();
  const chainGeo=(UI&&UI.mirrorEnabled&&S.mirroredBaseGeo)?S.mirroredBaseGeo:chainPartGeo();
  const mat=partMaterial(chainGeo,{roughness:.7});
  if(hasVColor(chainGeo)) installSwapShader(mat);
  S.chain=new THREE.InstancedMesh(chainGeo, mat, poses.length);
  S.chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let i=0;i<poses.length;i++)
    S.chain.setMatrixAt(i, S.overrides.has(i)?_HIDDEN:poses[i]);   // custom slots drawn separately
  S.chain.instanceMatrix.needsUpdate=true;
  paintChain(poses, null);
  scene.add(S.chain);
  buildLSChainGroup(poses);   // per-link deformed meshes (empty if no nodes)
  rebuildOverrideMeshes(poses);
  syncViewVisibility();                       // chain in steps 3/4 (loop-sculpt group instead of the instanced mesh); part elsewhere
  syncMatePreview();
  applyXray(); applySection();                // the new instanced material adopts the active modes
}

/* ---- BVH collision ---- */
function ensureBVH(){
  if(!S.baseGeo.boundsTree) S.baseGeo.boundsTree=new MeshBVH(S.baseGeo);
}
function worldAABB(pose,geo){
  geo=geo||S.baseGeo; if(!geo.boundingBox) geo.computeBoundingBox();
  const b=geo.boundingBox.clone().applyMatrix4(pose);
  b.expandByScalar(CONST.BBOX_PAD_MM);
  return b;
}
function checkCollisions(poses){
  const n=poses.length;
  const boxes=poses.map((p,i)=>worldAABB(linkWorldMatrix(i),linkGeom(i)));   // honors any gizmo nudge on a swapped link
  let cell=0; const sz=new THREE.Vector3();
  for(const b of boxes){b.getSize(sz);cell=Math.max(cell,sz.x,sz.y);}
  cell=Math.max(cell,1e-3);
  const grid=new Map();
  for(let i=0;i<n;i++){
    const b=boxes[i];
    const x0=Math.floor(b.min.x/cell),x1=Math.floor(b.max.x/cell);
    const y0=Math.floor(b.min.y/cell),y1=Math.floor(b.max.y/cell);
    for(let cx=x0;cx<=x1;cx++)for(let cy=y0;cy<=y1;cy++){
      const k=cx*73856093^cy*19349663; let arr=grid.get(k); if(!arr){arr=[];grid.set(k,arr);} arr.push(i);
    }
  }
  const bad=new Set(), tested=new Set(), where={lines:[],spots:[]}; let pairs=0;
  const inv=new THREE.Matrix4();
  for(const arr of grid.values()){
    for(let a=0;a<arr.length;a++)for(let bI=a+1;bI<arr.length;bI++){
      let i=arr[a],j=arr[bI]; if(i>j){const t=i;i=j;j=t;}
      const pk=i*n+j; if(tested.has(pk))continue; tested.add(pk);   // dedupe multi-cell pairs
      if(!boxes[i].intersectsBox(boxes[j]))continue;
      pairs++;
      inv.copy(linkWorldMatrix(i)).invert().multiply(linkWorldMatrix(j));   // bring link j into link i's frame
      if(linkGeom(i).boundsTree.intersectsGeometry(linkGeom(j),inv)){
        bad.add(i); bad.add(j);
        overlapSpots(linkGeom(i), linkGeom(j), inv, linkWorldMatrix(i), `link ${i+1} and link ${j+1}`, where);
      }
    }
  }
  return {bad,pairs,where};
}
/* Where two meshes run into each other. `toA` brings mesh B into A's frame, `world` takes A's frame to the scene.
   Adds to `where`: lines — the crossing line as x,y,z pairs of segment ends — and spots — one {center, radius, label}
   per place they meet (two links can touch in several places). */
const OVERLAP_MAX_SEGMENTS=20000, OVERLAP_MAX_TOTAL=200000;   // line pieces per pair / in all: plenty for the picture, and a bound when many detailed links sit inside each other
function overlapSpots(geoA, geoB, toA, world, label, where){
  if(!geoA.boundsTree) geoA.boundsTree=new MeshBVH(geoA);
  if(!geoB.boundsTree) geoB.boundsTree=new MeshBVH(geoB);
  if(!geoA.boundingBox) geoA.computeBoundingBox();
  const seg=new THREE.Line3(), a=new THREE.Vector3(), b=new THREE.Vector3(), mid=new THREE.Vector3();
  const reach=Math.max(1, geoA.boundingBox.getSize(new THREE.Vector3()).length()*0.08);   // pieces of line closer than this belong to the same place
  const spots=[], first=where.lines.length;
  geoA.boundsTree.bvhcast(geoB.boundsTree, toA, { intersectsTriangles:(t1,t2)=>{
    if(!t1.intersectsTriangle(t2, seg, true)) return false;
    a.copy(seg.start).applyMatrix4(world); b.copy(seg.end).applyMatrix4(world);
    if(a.distanceToSquared(b)<1e-12) return false;                  // touching in a point (or lying flat on each other): nothing to draw
    where.lines.push(a.x,a.y,a.z, b.x,b.y,b.z);
    mid.addVectors(a,b).multiplyScalar(.5);
    let s=null;
    for(let k=spots.length-1;k>=0;k--){                             // the place this piece belongs to; it may join two that were apart so far
      if(spots[k].box.distanceToPoint(mid)>=reach) continue;
      if(!s) s=spots[k]; else { s.box.union(spots[k].box); spots.splice(k,1); }
    }
    if(!s){ s={box:new THREE.Box3(), label}; spots.push(s); }
    s.box.expandByPoint(a); s.box.expandByPoint(b);
    return where.lines.length-first >= OVERLAP_MAX_SEGMENTS*6 || where.lines.length >= OVERLAP_MAX_TOTAL*6;   // true ends the search (the place is still marked)
  }});
  for(let again=true; again;){                                      // places that grew into each other are one place
    again=false;
    for(let x=0; x<spots.length && !again; x++) for(let y=x+1; y<spots.length; y++){
      if(!spots[x].box.clone().expandByScalar(reach).intersectsBox(spots[y].box)) continue;
      spots[x].box.union(spots[y].box); spots.splice(y,1); again=true; break;
    }
  }
  for(const s of spots){ s.center=s.box.getCenter(new THREE.Vector3()); s.radius=s.box.getSize(new THREE.Vector3()).length()/2; where.spots.push(s); }
}
/* show them (or, with nothing to show, clear the picture) */
function setOverlapViz(where){
  for(const o of [...overlapViz.children]){ overlapViz.remove(o); if(o.isLineSegments2) o.geometry.dispose(); }
  S.overlapSpots = where ? where.spots : [];
  if(UI){ UI.overlapCount=S.overlapSpots.length; UI.overlapAt=0; UI.overlapLabel=''; }
  if(!where || !where.lines.length){ overlapViz.visible=false; return; }
  const g=new LineSegmentsGeometry().setPositions(where.lines);
  overlapMats.forEach((m,k)=>{ const l=new LineSegments2(g,m); l.renderOrder=1000+k; l.frustumCulled=false; overlapViz.add(l); });
  for(const s of where.spots){ const r=new THREE.Sprite(overlapRing); r.position.copy(s.center); r.scale.setScalar(0.055); r.renderOrder=1002; overlapViz.add(r); }
  overlapViz.visible=true;
}
/* "Show where": look at the next overlap from close up, from the side the view is on now */
function showOverlap(step=1){
  const n=S.overlapSpots.length; if(!n) return;
  UI.overlapAt = ((UI.overlapLabel ? UI.overlapAt+step : 0)%n+n)%n;
  const s=S.overlapSpots[UI.overlapAt];
  const dir=camera.position.clone().sub(controls.target).normalize();
  const half=THREE.MathUtils.degToRad(camera.fov)/2, r=Math.max(s.radius*3, 6);          // the spot and some of the links around it
  controls.enableDamping=false; controls.update(); controls.enableDamping=true;
  controls.target.copy(s.center);
  camera.position.copy(s.center).addScaledVector(dir, r/Math.sin(Math.min(half, Math.atan(Math.tan(half)*camera.aspect))));
  controls.update();
  UI.overlapLabel=`${UI.overlapAt+1} of ${n}: ${s.label}`;
}

let regenTimer=null;
function regen(force){
  if(!S.baseGeo||!anchorsValid()) return;
  const poses=buildPoses();
  S.poses=poses;
  const mm=S.chainLength;
  UI.chainLenVal = mm>=1000 ? `${(mm/1000).toFixed(2)} m` : `${mm.toFixed(1)} mm`;
  UI.chainLenSub = `${poses.length} links · ${(mm/poses.length).toFixed(1)} mm from joint to joint`;
  if(S.selectedLink!=null && S.selectedLink>=poses.length){ S.selectedLink=null; updateSwapUI(); }
  renderChain(poses);
  const doCheck = force || poses.length<=CONST.COLLISION_AUTO_MAX;
  let bad=new Set(), pairs=0, where=null;
  if(doCheck) ({bad,pairs,where}=checkCollisions(poses));
  S.collideSet=bad;
  S.chainOverlap=where; syncOverlapViz();
  paintChain(poses, bad);            // re-tint, flagging collisions red
  recolorLSChain(bad);
  recolorOverrides(bad); showSelection();
  const fp=new THREE.Box3(); poses.forEach((p,i)=>fp.union(worldAABB(linkWorldMatrix(i),linkGeom(i))));
  const fs=fp.getSize(new THREE.Vector3());
  S.footCenter=fp.getCenter(new THREE.Vector3());
  const plate=P().plate;
  const off = fs.x>plate||fs.y>plate;
  updatePlate(plate, off);
  if(!doCheck){UI.chipCollide=`<span class="warn">${poses.length} links — press “Re-check”</span>`;}
  else if(bad.size===0){UI.chipCollide=`<span class="ok">✓ no overlaps</span> · ${pairs} pairs tested`;}
  else{UI.chipCollide=`<span class="err">✗ ${bad.size} links overlap</span>`;}
  UI.chipSize=`footprint <b>${fs.x.toFixed(0)}×${fs.y.toFixed(0)}</b> mm`;
  // the same facts, structured, for the status card on the Chain / Export pages
  UI.chainState = !doCheck ? 'unchecked' : bad.size ? 'bad' : 'ok';
  UI.chainBad=bad.size; UI.chainFoot=`${fs.x.toFixed(0)} × ${fs.y.toFixed(0)} mm`; UI.chainOff=off;
  let msg=`${poses.length} links · footprint ${fs.x.toFixed(0)}×${fs.y.toFixed(0)} mm.`;
  let kind = bad.size? 'err':'ok';
  if(!doCheck){ msg+=' Collision check skipped (large count) — press “Re-check”.'; kind=''; }
  else if(bad.size) msg+=` ${bad.size} links overlap — the yellow lines show where.`;
  else msg+=' No mesh overlaps.';
  if(off){msg+=` ⚠ Larger than the ${plate} mm print bed.`; if(!bad.size)kind='';}
  status(msg,kind);
  UI.s3nextDisabled=false;
  followContent();                          // more links / another shape → the view stays on the middle of the chain
  updateExportEstimate();                   // file size follows the link count
  return {bad,off};
}
function updatePlate(size, over=false){
  size=Math.max(10, +size||CONST.DEFAULT_PLATE_MM);
  if(size!==bed.userData.size){            // only rebuild when it actually changes
    const old=bed;
    bed=makeBed(size); bed.position.copy(old.position); scene.add(bed);
    scene.remove(old); old.traverse(o=>{ o.geometry?.dispose(); o.material?.dispose(); });
  }
  bed.userData.edge.material.color.set(over ? BED.edgeOver : BED.edge);   // the chain is larger than the bed → its edge lights up
}
/* The bed is drawn centred under the chain (Chain / Export pages) or under the part (everywhere else), the way a
   slicer centres a model on the plate. */
function syncBed(){
  let c=null;
  if(viewKind(S.uiStep)==='chain' && S.poses.length) c=S.footCenter;
  else if(S.baseGeo){ S.baseGeo.computeBoundingBox(); c=S.baseGeo.boundingBox.getCenter(new THREE.Vector3()); }
  bed.position.set(c?c.x:0, c?c.y:0, 0);
}

/* ======================================================================== *
 *  STEP 4 — MERGE + EXPORT  /  SAVE-LOAD CONFIG
 * ======================================================================== */
const EXPORT_FORMATS=['stl','3mf','obj','ply','glb','gltf'];
function exportFormat(){
  if(UI && EXPORT_FORMATS.includes(UI.exportFmt)) return UI.exportFmt;     // picked explicitly
  const f=(S.loadFormat||'stl').toLowerCase();
  if(!EXPORT_FORMATS.includes(f)) return 'stl';
  return (f==='stl' && chainHasColours()) ? 'obj' : f;                  // auto: source format, but never drop colours
}
function updateExportLabel(){ UI.exportFmtNow=exportFormat(); UI.exportLabel='⬇ Download '+UI.exportFmtNow.toUpperCase(); }
// OBJ vertex colours are sRGB by convention (OBJLoader converts them to linear on import),
// while our colour attributes are linear — convert back so slicers see the real colours.
const linToSRGB=c=>{ c=Math.min(1,Math.max(0,c)); return c<=0.0031308 ? c*12.92 : 1.055*Math.pow(c,1/2.4)-0.055; };
function writeOBJ(geo){
  const pos=geo.getAttribute('position'), col=geo.getAttribute('color'), nrm=geo.getAttribute('normal'), idx=geo.index;
  const n=pos.count, out=['# articulated chain export'];
  for(let i=0;i<n;i++){
    let l='v '+pos.getX(i).toFixed(5)+' '+pos.getY(i).toFixed(5)+' '+pos.getZ(i).toFixed(5);
    if(col) l+=' '+linToSRGB(col.getX(i)).toFixed(5)+' '+linToSRGB(col.getY(i)).toFixed(5)+' '+linToSRGB(col.getZ(i)).toFixed(5);
    out.push(l);
  }
  if(nrm) for(let i=0;i<n;i++) out.push('vn '+nrm.getX(i).toFixed(5)+' '+nrm.getY(i).toFixed(5)+' '+nrm.getZ(i).toFixed(5));
  const v=a=>nrm?`${a+1}//${a+1}`:`${a+1}`;   // OBJ indices are 1-based
  if(idx) for(let i=0;i<idx.count;i+=3) out.push('f '+v(idx.getX(i))+' '+v(idx.getX(i+1))+' '+v(idx.getX(i+2)));
  else    for(let i=0;i<n;i+=3)         out.push('f '+v(i)+' '+v(i+1)+' '+v(i+2));
  return out.join('\n')+'\n';
}
async function encodeChain(mesh, geo, fmt, ranges, pal, mix){
  const title=(UI.projectTitle||S.meshName||'').trim().replace(/[^\w.-]+/g,'_');
  const base=(title && title!=='part' ? title : 'articulated')+'-chain';
  if(fmt==='3mf'){
    return {blob:new Blob([await write3MF(geo, ranges, pal, base, mix)],{type:'model/3mf'}), name:base+'.3mf'};
  }
  if(fmt==='stl'){
    const dv=new STLExporter().parse(mesh,{binary:true});
    return {blob:new Blob([dv],{type:'application/octet-stream'}), name:base+'.stl'};
  }
  if(fmt==='obj'){
    return {blob:new Blob([writeOBJ(geo)],{type:'text/plain'}), name:base+'.obj'};
  }
  if(fmt==='ply'){
    const buf=await new Promise((res,rej)=>{ try{ new PLYExporter().parse(mesh,r=>res(r),{binary:true}); }catch(e){rej(e);} });
    return {blob:new Blob([buf],{type:'application/octet-stream'}), name:base+'.ply'};
  }
  const binary=fmt!=='gltf';   // glb = binary, gltf = JSON
  const result=await new Promise((res,rej)=>new GLTFExporter().parse(mesh,r=>res(r),e=>rej(e),{binary}));
  return binary
    ? {blob:new Blob([result],{type:'model/gltf-binary'}), name:base+'.glb'}
    : {blob:new Blob([JSON.stringify(result)],{type:'model/gltf+json'}), name:base+'.gltf'};
}
async function exportChain(){
  if(!S.poses.length){status('Build the chain first.','err');return;}
  const fmt=exportFormat();
  const keepColor = fmt!=='stl' && chainHasColours();      // STL has no color; every other format keeps it
  const cap=exportVertCap(), lite=new Map();               // "Smaller file": source geometry → its lighter copy (made once, used for every link)
  const pal = keepColor ? chainPalette(exportColourCap(fmt)) : null;   // the colours of the file (null: a plain part)
  let mix = null;                                          // "Mix the colours": a slicer project with mixed filaments
  if(pal && exportMixing(fmt)){
    mix=mixPlan(pal);
    try{ const r=await fetch(MIX_TEMPLATE); if(!r.ok) throw new Error(r.status); mix.settings=await r.json(); }
    catch(e){ status('The slicer settings for the project ('+MIX_TEMPLATE+') could not be loaded: '+e.message,'err'); return; }
  }
  if(cap){ status('Reducing the links for the file…'); await new Promise(r=>setTimeout(r,10)); }   // let the status line repaint
  const geos=[], ranges=[], rgb=[0,0,0];
  for(let i=0;i<S.poses.length;i++){
    let src=exportSource(i);                 // the part (mirrored to the full link for a half part), or a swapped-in model
    if(cap && src.attributes.position.count>cap){
      if(!lite.has(src)) lite.set(src, await reducedCopy(src,cap));
      src=lite.get(src);
    }
    let g=src.clone();
    if(S.lsNodes.length){ const nor=S.poses.length>1?i/(S.poses.length-1):0; applyLSDeform(g,i,nor,S.overrides.has(i)?0:cutShift()); }
    g.applyMatrix4(linkWorldMatrix(i));      // bake world matrix (incl. any gizmo nudge) → separate solid
    for(const a of Object.keys(g.attributes)) if(a!=='position'&&a!=='normal'&&!(keepColor&&a==='color')) g.deleteAttribute(a);
    if(keepColor && !g.getAttribute('color'))   // an uncolored override → white-fill so the merge's attrs match
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(1),3));
    if(keepColor){                               // bake the per-part colour callback into the exported colours, then keep to the file's colours
      const ca=g.getAttribute('color'), paint=linkColourer(i);
      for(let v=0;v<ca.count;v++){
        paint(ca.getX(v),ca.getY(v),ca.getZ(v),rgb);
        if(pal.limited){ const c=pal.colours[pal.index(rgb[0],rgb[1],rgb[2])]; ca.setXYZ(v,c.r,c.g,c.b); }
        else ca.setXYZ(v,rgb[0],rgb[1],rgb[2]);
      }
    }
    if(!g.attributes.normal) g.computeVertexNormals();   // keep every solid's attribute set identical for the merge
    ranges.push(g.attributes.position.count);
    geos.push(g);
  }
  const merged=BufferGeometryUtils.mergeGeometries(geos,false);
  geos.forEach(g=>g.dispose()); lite.forEach(g=>g.dispose());
  const mesh=new THREE.Mesh(merged, keepColor?partMaterial(merged):undefined);
  const tris=merged.index?merged.index.count/3:merged.attributes.position.count/3;
  const {blob,name}=await encodeChain(mesh, merged, fmt, ranges, pal, mix);
  merged.dispose();
  download(blob,name);
  const cols = !pal ? '' : mix ? ` · ${new Set(mix.filamentOf).size} colours from ${mix.filaments.length} filaments (${mix.mixes.length} mixed)` : ` · ${pal.colours.length} colour${pal.colours.length>1?'s':''}`;
  UI.exportOut=`✓ Exported <b>${S.poses.length}</b> links · ${tris.toLocaleString()} triangles${cols} · ${fmtBytes(blob.size)}${lite.size?' (reduced)':''}.`;
  status(name.toUpperCase().split('.').pop()+' downloaded: '+name,'ok');
}

/* ---- THE COLOURS OF THE FILE ----
   A slicer wants a handful of flat colours, one per filament. The chain can carry more: every link's own colours,
   swapped or tinted link by link ("Colour along the chain"). For the file, similar colours are merged until at most
   N are left ("At most N colours" on the Export page; 3MF always has a limit, it stores filament numbers). */
const MAX_FILAMENTS=16;
function exportColourCap(fmt){     // 0 = every colour as it is
  const most = exportMixing(fmt) ? MAX_FILAMENTS-UI.exportFilaments.length : MAX_FILAMENTS;   // mixed filaments are numbered on from the real ones
  const n=Math.min(most, Math.max(1, Math.round(+UI.exportMaxColours)||4));
  return UI.exportLimitColours ? n : fmt==='3mf' ? most : 0;
}
/* Does the chain carry colours? A coloured part always does. A plain part does once "Colour along the chain" gives
   some link a colour of its own — the alternating look of the default code only tells the links apart in the view. */
function chainHasColours(){
  if(!S.baseGeo) return false;
  if(hasVColor(S.baseGeo)) return true;
  if(!S.colorFn) return false;
  const n=S.poses.length||Math.max(1,(UI&&UI.count)||1), base=CONST.LINK_OK_COLOR, c=new THREE.Color();
  for(let i=0;i<n;i++){
    let v; try{ v=S.colorFn(i, n>1?i/(n-1):0, {r:base.r,g:base.g,b:base.b}); }catch(e){ continue; }
    if(isInvert(v)) continue;
    applyColorValue(c.copy(base), v);
    if(Math.abs(c.r-base.r)+Math.abs(c.g-base.g)+Math.abs(c.b-base.b)>1e-4) return true;
  }
  return false;
}
/* what link i does to a colour of the part — the same rule as the chain shader: swap the palette, or tint.
   A plain part has no colours to change: the link is the one colour it has in the view (without the marker of link 1). */
function linkColourer(i){
  if(!hasVColor(S.baseGeo)){
    linkPaint(i, S.poses.length, CONST.LINK_OK_COLOR, false);
    const c=_tmpCol.clone();
    return (r,g,b,out)=>{ out[0]=c.r; out[1]=c.g; out[2]=c.b; };
  }
  let rv;
  if(S.colorFn){ try{ rv=S.colorFn(i, S.poses.length>1?i/(S.poses.length-1):0, {r:1,g:1,b:1}); }catch(e){} }
  if(isInvert(rv)) return (r,g,b,out)=>{ out[0]=SWAP_SUM.x-r; out[1]=SWAP_SUM.y-g; out[2]=SWAP_SUM.z-b; };
  const t=new THREE.Color(); applyColorValue(t.copy(WHITE), rv);
  return (r,g,b,out)=>{ out[0]=r*t.r; out[1]=g*t.g; out[2]=b*t.b; };
}
const srgb8=c=>Math.round(linToSRGB(c)*255);
const colourKey=(r,g,b)=>(srgb8(r)<<16)|(srgb8(g)<<8)|srgb8(b);
/* The chain's colours, most used first: {colours:[{r,g,b (linear), hex, share}], limited, index(r,g,b) → which of them}.
   With a limit n, similar colours are merged (weighted k-means on the sRGB values) until n are left. */
function chainPalette(n){
  const hist=new Map(), own=new Map(), rgb=[0,0,0];      // final colour → [r,g,b,weight] · source geometry → its own colours
  for(let i=0;i<S.poses.length;i++){
    const g=exportSource(i);
    if(!own.has(g)){
      const ca=g.getAttribute('color'), m=new Map();
      if(!ca) m.set(0,[1,1,1,g.attributes.position.count]);          // an uncoloured swapped-in link counts as white
      else for(let v=0;v<ca.count;v++){
        const r=ca.getX(v), gg=ca.getY(v), b=ca.getZ(v), k=colourKey(r,gg,b), e=m.get(k);
        if(e) e[3]++; else m.set(k,[r,gg,b,1]);
      }
      own.set(g,[...m.values()]);
    }
    const paint=linkColourer(i);
    for(const [r,gg,b,w] of own.get(g)){
      paint(r,gg,b,rgb);
      const k=colourKey(rgb[0],rgb[1],rgb[2]), e=hist.get(k);
      if(e) e[3]+=w; else hist.set(k,[rgb[0],rgb[1],rgb[2],w]);
    }
  }
  let cols=[...hist.values()];
  const limited = n>0 && cols.length>n;
  if(limited) cols=mergeColours(cols,n);
  cols.sort((a,b)=>b[3]-a[3]);
  const total=cols.reduce((t,c)=>t+c[3],0)||1;
  const colours=cols.map(c=>({r:c[0],g:c[1],b:c[2], share:c[3]/total,
    hex:'#'+[c[0],c[1],c[2]].map(v=>srgb8(v).toString(16).padStart(2,'0')).join('').toUpperCase()}));
  const sr=colours.map(c=>[linToSRGB(c.r),linToSRGB(c.g),linToSRGB(c.b)]), near=new Map();
  const index=(r,g,b)=>{
    const k=colourKey(r,g,b); let i=near.get(k);
    if(i===undefined){
      const x=linToSRGB(r), y=linToSRGB(g), z=linToSRGB(b); let bd=Infinity; i=0;
      for(let c=0;c<sr.length;c++){ const d=(x-sr[c][0])**2+(y-sr[c][1])**2+(z-sr[c][2])**2; if(d<bd){ bd=d; i=c; } }
      near.set(k,i);
    }
    return i;
  };
  return {colours, limited, found:hist.size, index};
}
function mergeColours(cols, k){
  const P=cols.map(c=>[linToSRGB(c[0]),linToSRGB(c[1]),linToSRGB(c[2])]), W=cols.map(c=>c[3]), n=P.length;
  const d2=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2;
  /* start from the most used colour, then keep adding the colour that is both far from the chosen ones and much used */
  const cen=[P[W.indexOf(Math.max(...W))].slice()], near=new Float64Array(n).fill(Infinity);
  while(cen.length<k){
    let best=0, bs=-1;
    for(let i=0;i<n;i++){ near[i]=Math.min(near[i], d2(P[i],cen[cen.length-1])); const sc=near[i]*W[i]; if(sc>bs){ bs=sc; best=i; } }
    cen.push(P[best].slice());
  }
  const assign=new Int32Array(n);
  for(let it=0;it<24;it++){
    let moved=false;
    for(let i=0;i<n;i++){ let bc=0, bd=Infinity; for(let c=0;c<k;c++){ const d=d2(P[i],cen[c]); if(d<bd){ bd=d; bc=c; } } if(assign[i]!==bc){ assign[i]=bc; moved=true; } }
    const sum=cen.map(()=>[0,0,0,0]);
    for(let i=0;i<n;i++){ const s=sum[assign[i]]; s[0]+=P[i][0]*W[i]; s[1]+=P[i][1]*W[i]; s[2]+=P[i][2]*W[i]; s[3]+=W[i]; }
    for(let c=0;c<k;c++) if(sum[c][3]) cen[c]=[sum[c][0]/sum[c][3], sum[c][1]/sum[c][3], sum[c][2]/sum[c][3]];
    if(!moved && it>0) break;
  }
  const w=new Float64Array(k); for(let i=0;i<n;i++) w[assign[i]]+=W[i];
  const toLin=c=>c<=0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055,2.4);
  return cen.map((c,i)=>[toLin(c[0]),toLin(c[1]),toLin(c[2]),w[i]]).filter(c=>c[3]>0);
}

/* 3MF: the mesh and — for a coloured chain — the filament every triangle is printed with. Slicers of the Bambu Studio /
   OrcaSlicer family (Snapmaker Orca among them) keep that as colour painting: paint_color on a triangle, "4" = filament 1,
   "8" = 2, "0C" = 3, "1C" = 4 … The most used colour is filament 1 and stays unpainted: it is the object's own filament.
   The colours also go in as a standard 3MF colour group, for programs that read those. */
function paintCode(f){                       // the slicer's own notation of "this whole triangle: filament f"
  if(f<3) return f===1 ? '4' : '8';
  let n=f-3, s='C';
  while(n>=15){ s='F'+s; n-=15; }
  return n.toString(16).toUpperCase()+s;
}
/* "Mix the colours" (3MF only): the colours are not filaments of their own but made from the loaded ones — each
   colour is printed with one of them, or with two in alternating layers (Snapmaker Orca's mixed filaments, numbered
   on from the last real one). That needs the slicer's project format: see slicer/OrcaProject.js. */
const MIX_TEMPLATE='slicer/snapmaker_u1_project_settings.json';   // print settings the project is given: from a project saved by the slicer
const exportMixing=fmt=>fmt==='3mf' && !!UI.exportMix;
function mixPlan(pal){
  const filaments=UI.exportFilaments.map(c=>String(c).toUpperCase());
  const plan=planMixes(pal.colours.map(c=>c.hex), filaments);
  const share=filaments.map(()=>0);                                  // how much of the chain each real filament prints on its own
  plan.colours.forEach((c,i)=>{ if(c.filament<=filaments.length) share[c.filament-1]+=pal.colours[i].share; });
  const base=share.indexOf(Math.max(...share))+1;                     // … the busiest one is the object's own filament
  return {filaments, base, filamentOf:plan.colours.map(c=>c.filament), colours:plan.colours, mixes:plan.mixes};
}
/* the chain as the <mesh> of a 3MF. filamentOf: which filament each colour of pal is painted with (base: left unpainted);
   group: also refer to the standard colour group; centre: write the coordinates relative to the middle of the chain */
function meshXml(geo, ranges, pal, {filamentOf=null, base=1, group=false, centre=false}={}){
  const pos=geo.getAttribute('position'), col=pal&&geo.getAttribute('color'), idx=geo.index;
  geo.computeBoundingBox();
  const bb=geo.boundingBox, mid=centre ? bb.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const enc=new TextEncoder(), parts=[]; let lines=[], bytes=0;
  const flush=()=>{ if(lines.length){ const u=enc.encode(lines.join('\n')+'\n'); parts.push(u); bytes+=u.length; lines=[]; } };
  const put=l=>{ lines.push(l); if(lines.length>=20000) flush(); };
  const num=v=>String(+v.toFixed(4));
  put('<mesh>'); put('<vertices>');
  /* vertices: one per position within a link (a colour seam has two on the same spot — the slicer wants a closed surface) */
  const remap=new Uint32Array(pos.count); let nv=0, v=0;
  for(const count of ranges){
    const seen=new Map();
    for(const end=v+count; v<end; v++){
      const x=num(pos.getX(v)-mid.x), y=num(pos.getY(v)-mid.y), z=num(pos.getZ(v)-mid.z), k=x+' '+y+' '+z;
      let i=seen.get(k);
      if(i===undefined){ i=nv++; seen.set(k,i); put(`<vertex x="${x}" y="${y}" z="${z}"/>`); }
      remap[v]=i;
    }
  }
  put('</vertices>'); put('<triangles>');
  const nt=idx?idx.count:pos.count, at=i=>idx?idx.getX(i):i;
  const ci=v=>pal.index(col.getX(v),col.getY(v),col.getZ(v));
  for(let t=0;t<nt;t+=3){
    const a=at(t), b=at(t+1), c=at(t+2), ra=remap[a], rb=remap[b], rc=remap[c];
    if(ra===rb||rb===rc||ra===rc) continue;                     // collapsed by the weld
    let l=`<triangle v1="${ra}" v2="${rb}" v3="${rc}"`;
    if(col){
      const pa=ci(a), pb=ci(b), pc=ci(c), k = pb===pc ? pb : pa, f=filamentOf[k];   // the colour two of its corners agree on
      if(group && k>0) l+=` pid="2" p1="${k}"`;
      if(f!==base) l+=` paint_color="${paintCode(f)}"`;
    }
    put(l+'/>');
  }
  put('</triangles>'); put('</mesh>');
  flush();
  const out=new Uint8Array(bytes); let o=0; for(const u of parts){ out.set(u,o); o+=u.length; }
  return {bytes:out, halfHeight:(bb.max.z-bb.min.z)/2};
}
async function write3MF(geo, ranges, pal, title, mix){
  const {zipSync, strToU8}=await import('three/addons/libs/fflate.module.js');
  const u8=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k, typeof v==='string' ? strToU8(v) : v]));
  if(mix){                                             // a Snapmaker Orca project: settings, filament colours, mixes
    const {bytes,halfHeight}=meshXml(geo, ranges, pal, {filamentOf:mix.filamentOf, base:mix.base, centre:true});
    return zipSync(u8(snapmakerProject({mesh:bytes, halfHeight, title, settings:mix.settings, filaments:mix.filaments, mixes:mix.mixes, base:mix.base})), {level:6});
  }
  const col=!!pal;
  const {bytes}=meshXml(geo, ranges, pal, {filamentOf:col?pal.colours.map((c,i)=>i+1):null, group:col});
  const esc=t=>String(t).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'})[c]);
  const head=strToU8('<?xml version="1.0" encoding="UTF-8"?>\n'
    +'<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'
    +(col?' xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"':'')+'>\n'
    +`<metadata name="Title">${esc(title)}</metadata>\n`
    +'<metadata name="Application">Articulated Spiral Builder</metadata>\n'
    +(col?`<metadata name="Description">${esc(pal.colours.map((c,i)=>`filament ${i+1}: ${c.hex}`).join(', '))}</metadata>\n`:'')
    +'<resources>\n'
    +(col?'<m:colorgroup id="2">'+pal.colours.map(c=>`<m:color color="${c.hex}"/>`).join('')+'</m:colorgroup>\n':'')
    +`<object id="1" type="model" name="${esc(title)}"${col?' pid="2" pindex="0"':''}>\n`);
  const tail=strToU8('</object>\n</resources>\n<build><item objectid="1"/></build>\n</model>\n');
  const model=new Uint8Array(head.length+bytes.length+tail.length);
  model.set(head,0); model.set(bytes,head.length); model.set(tail,head.length+bytes.length);
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': model,
  }, {level:6});
}

function download(blob,name){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name;
  a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

function exportGLB(mesh){
  return new Promise((resolve,reject)=>
    new GLTFExporter().parse(mesh, glb=>resolve(glb),
      err=>reject(err instanceof Error?err:new Error('glTF export failed')), {binary:true}));
}
function parseGLB(buf){
  return new Promise((resolve,reject)=>
    new GLTFLoader().parse(buf,'', gltf=>{
      let g=null; gltf.scene.traverse(o=>{ if(!g&&o.isMesh) g=o.geometry; });
      g?resolve(g):reject(new Error('no mesh found in glTF'));
    }, err=>reject(err instanceof Error?err:new Error('glTF parse failed'))));
}
/* Upload one geometry as GLB to data/meshes/ (vertexColors material → COLOR_0 is written); returns its id. */
async function uploadGeo(geo, filename){
  const glb=await exportGLB(new THREE.Mesh(geo, partMaterial(geo)));
  const res=await fetch('/api/meshes',{method:'POST',
    headers:{'content-type':'model/gltf-binary','x-filename':filename.replace(/[^\w.-]+/g,'_')},
    body:glb});
  if(!res.ok) throw new Error(await res.text());
  return (await res.json()).id;
}
async function ensureMeshUploaded(){
  if(!S.baseGeo) return null;
  if(S.meshId && !S.meshDirty) return S.meshId;
  S.meshId=await uploadGeo(S.baseGeo, (S.meshName||'part')+'.glb'); S.meshDirty=false;
  return S.meshId;
}
/* the decoration's working mesh + the pre-fuse link, so "Edit placement" still works after a reload */
async function ensureDecoUploaded(){
  const d=S.deco; if(!d||!d.work) return;
  if(!d.meshId) d.meshId=await uploadGeo(d.work, (d.name||'object')+'.glb');
  if(d.fused && d.linkPreFuse && !d.linkMeshId) d.linkMeshId=await uploadGeo(d.linkPreFuse, (S.meshName||'part')+'-link.glb');
}
async function loadMeshFromServer(id){
  S.loadFormat=(id.split('.').pop()||'stl').toLowerCase();   // export back in the stored format
  setBaseGeometry(await fetchMeshGeom(id), {faithful:S.loadFormat!=='stl'});
}
async function fetchMeshGeom(id){
  const res=await fetch('/api/meshes/'+encodeURIComponent(id));
  if(!res.ok) throw new Error('mesh fetch failed ('+res.status+')');
  const buf=await res.arrayBuffer();
  const g=(id.split('.').pop()||'').toLowerCase()==='stl' ? new STLLoader().parse(buf) : await parseGLB(buf);
  if(!g.getAttribute('normal')) g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
async function ensureOverridesUploaded(){
  for(const [i,o] of S.overrides){
    if(o.meshId) continue;
    o.meshId=await uploadGeo(o.geo, 'link-'+i+'.glb');
  }
}
function geoFromArrays(pos,nrm,idx,col){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  if(Array.isArray(col)) g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  if(Array.isArray(idx)) g.setIndex(idx);
  if(Array.isArray(nrm)) g.setAttribute('normal',new THREE.Float32BufferAttribute(nrm,3)); else g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function gatherConfig(opts={}){
  const cfg={
    version:4, pin:{x:UI.pin.x,y:UI.pin.y,z:UI.pin.z||0}, hole:{x:UI.hole.x,y:UI.hole.y,z:UI.hole.z||0}, partX:UI.partX, partY:UI.partY, partZ:UI.partZ,
    params:P(),
    scaleCode:S.scaleCode,
    colorCode:S.colorCode,
    pathCode:S.pathCode,
    symPlanes:S.symPlanes.map(pl=>({p:[pl.p.x,pl.p.y,pl.p.z],n:[pl.n.x,pl.n.y,pl.n.z]})),
    mirror:{enabled:UI.mirrorEnabled,axis:UI.mirrorAxis,offset:UI.mirrorOffset},
    lsNodes:S.lsNodes.map(n=>({pos:[n.pos.x,n.pos.y,n.pos.z],dir:[n.dir.x,n.dir.y,n.dir.z],
      intensity:n.intensity,radius:n.radius,mode:n.mode,falloff:n.falloff,code:n.code,mirror:!!n.mirror})),
    mirrorPlane:{manual:UI.sculptManual,axis:UI.sculptAxis,offset:UI.sculptOffset},   // set by hand (Sculpt / Morph); the detected lines are symPlanes
    meshId:S.meshId,                          // aligned mesh stored in data/meshes/ on the server
    colorShades:UI.colorShades, purify:UI.purify,   // a coloured part is re-quantized with these on load
    cut: UI.cutOn ? UI.cutAt : null,                // "Flatten the bottom": the links are cut at this height (the mesh is the whole part)
  };
  if(opts.inlineGeometry && S.baseGeo){
    cfg.geometry=Array.from(S.baseGeo.attributes.position.array);
    const nrm=S.baseGeo.getAttribute('normal'); if(nrm) cfg.normals=Array.from(nrm.array);
    if(S.baseGeo.index) cfg.indices=Array.from(S.baseGeo.index.array);
    if(hasVColor(S.baseGeo)) cfg.colors=Array.from(S.baseGeo.getAttribute('color').array);
  }
  if(S.deco && S.deco.mesh){
    const d=S.deco; d.mesh.updateMatrix();
    const e={ name:d.name, colorSource:d.colorSource, matrix:d.mesh.matrix.toArray(), fused:d.fused,
      shades:UI.decoShades, maxVerts:UI.decoMaxVerts, flatColor:UI.decoFlatColor, linkColor:UI.decoLinkColor,
      sink:UI.decoSink, fuseMode:UI.decoFuseMode, preFuseShades:d.preFuseColor?.shades ?? null };
    if(d.meshId) e.meshId=d.meshId;
    if(d.linkMeshId) e.linkMeshId=d.linkMeshId;
    if(opts.inlineGeometry){
      e.geometry=Array.from(d.work.attributes.position.array);
      e.colors=Array.from(d.work.attributes.color.array);
      e.indices=Array.from(d.work.index.array);
      if(d.linkPreFuse){
        const L=d.linkPreFuse;
        e.linkGeometry=Array.from(L.attributes.position.array);
        if(L.index) e.linkIndices=Array.from(L.index.array);
        if(hasVColor(L)) e.linkColors=Array.from(L.getAttribute('color').array);
      }
    }
    cfg.deco=e;
  }
  if(S.overrides.size){
    cfg.overrides=[...S.overrides].map(([i,o])=>{
      const e={index:i, name:o.name||('link '+i)};
      if(o.meshId) e.meshId=o.meshId;
      if(o.adjust && !o.adjust.equals(new THREE.Matrix4())) e.adjust=o.adjust.toArray();
      if(opts.inlineGeometry){
        e.geometry=Array.from(o.geo.attributes.position.array);
        const n=o.geo.getAttribute('normal'); if(n) e.normals=Array.from(n.array);
        if(o.geo.index) e.indices=Array.from(o.geo.index.array);
      }
      return e;
    });
  }
  return cfg;
}
async function applyConfig(cfg){
  UI._loading=true;
  try{
    decoDispose();                              // the previous project's object doesn't belong to this one
    if(Number.isFinite(cfg.colorShades)) UI.colorShades=cfg.colorShades;   // before the mesh loads → it quantizes with these
    if(typeof cfg.purify==='boolean') UI.purify=cfg.purify;
    if(cfg.meshId){
      await loadMeshFromServer(cfg.meshId);     // also clears symmetry
      S.meshId=cfg.meshId;
    }else if(cfg.geometry){                     // geometry embedded in the JSON
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(cfg.geometry,3));
      if(Array.isArray(cfg.indices)) g.setIndex(cfg.indices);
      if(Array.isArray(cfg.colors)) g.setAttribute('color',new THREE.Float32BufferAttribute(cfg.colors,3));
      const faithful=Array.isArray(cfg.normals);
      if(faithful) g.setAttribute('normal',new THREE.Float32BufferAttribute(cfg.normals,3));
      else g.computeVertexNormals();
      setBaseGeometry(g,{faithful});
      S.meshId=null;
    }
    S.meshDirty=false;                          // whatever we just loaded is the current saved mesh
    if(Number.isFinite(cfg.cut)){ UI.cutAt=cfg.cut; UI.cutOn=true; } else UI.cutOn=false;
    dropCutGeo();
    if(cfg.pin) Object.assign(UI.pin,cfg.pin);
    if(cfg.hole) Object.assign(UI.hole,cfg.hole);
    S.partX=cfg.partX||0; UI.partX=S.partX;
    S.partY=cfg.partY||0; UI.partY=S.partY;
    S.partZ=cfg.partZ||0; UI.partZ=S.partZ;
    const p=cfg.params||{};
    if(p.shape!=null)UI.shape=p.shape;
    if(p.count!=null)UI.count=p.count; if(p.startR!=null)UI.startR=p.startR;
    if(p.spacing!=null)UI.spacing=p.spacing; if(p.plate!=null)UI.plate=p.plate;
    if(Array.isArray(cfg.symPlanes)){
      S.symPlanes=cfg.symPlanes.map(pl=>({p:new THREE.Vector3(...pl.p),n:new THREE.Vector3(...pl.n),score:0}));
      buildSymLines();
    }
    if(cfg.mirror){
      UI.mirrorEnabled=!!cfg.mirror.enabled;
      UI.mirrorAxis=cfg.mirror.axis||'x';
      UI.mirrorOffset=cfg.mirror.offset||0;
      if(UI.mirrorEnabled) updateMirroredBase();
    }
    lsClearAll();                               // the previous project's morph points don't belong to this one
    if(cfg.mirrorPlane){
      UI.sculptManual=!!cfg.mirrorPlane.manual; UI.sculptAxis=cfg.mirrorPlane.axis||'x'; UI.sculptOffset=+cfg.mirrorPlane.offset||0;
    }
    if(Array.isArray(cfg.lsNodes) && cfg.lsNodes.length){
      for(const n of cfg.lsNodes){
        // set UI values so lsAddNode picks them up for the arrow/sphere sizing
        if(UI){ UI.lsRadius=n.radius; UI.lsIntensity=n.intensity;
                UI.lsMode=n.mode; UI.lsFalloff=n.falloff; UI.lsCode=n.code; }
        const node=lsAddNode(new THREE.Vector3(...n.pos), new THREE.Vector3(...n.dir),
                             n.mirror ?? !!UI.mirrorEnabled);   // older projects: every point of a half part was mirrored
        if(node){ node.fn=compileLSFn(n.code); }
      }
      lsSelectNode(-1); lsSyncNodeList(); // deselect after loading; user picks up from the list
    }
    if(typeof cfg.scaleCode==='string'){
      S.scaleCode=cfg.scaleCode;
      const r=compileScaleFn(cfg.scaleCode); if(r.fn)S.scaleFn=r.fn;
      if(scaleEditor)scaleEditor.setValue(cfg.scaleCode);
    }
    if(typeof cfg.colorCode==='string'){
      S.colorCode=cfg.colorCode;
      const r=compileColorFn(cfg.colorCode); if(r.fn)S.colorFn=r.fn;
      if(colorEditor)colorEditor.setValue(cfg.colorCode);
    }
    if(typeof cfg.pathCode==='string'){
      S.pathCode=cfg.pathCode;
      const r=compilePathFn(cfg.pathCode); if(r.fn)S.pathFn=r.fn;
      if(pathEditor)pathEditor.setValue(cfg.pathCode);
    }
    if(Array.isArray(cfg.overrides)){
      for(const e of cfg.overrides){
        try{
          let g=null;
          if(e.meshId) g=await fetchMeshGeom(e.meshId);
          else if(Array.isArray(e.geometry)) g=geoFromArrays(e.geometry,e.normals,e.indices);
          const adjust=Array.isArray(e.adjust)?new THREE.Matrix4().fromArray(e.adjust):new THREE.Matrix4();
          if(g) S.overrides.set(e.index,{geo:g,name:e.name||('link '+e.index),meshId:e.meshId||null,adjust});
        }catch(err){ status('A swapped link failed to load: '+err.message,'err'); }
      }
      updateSwapUI();
    }
    if(cfg.deco){
      try{ await decoRestore(cfg.deco); if(S.deco&&S.deco.fused) markDone('deco'); }
      catch(err){ status('The decoration failed to load: '+err.message,'err'); }
    }
    markDone('s1'); markDone('s2'); unlock('s2'); unlock('s3'); unlock('s4'); buildGizmos();
    setAnchorRanges();
    ensureScaleEditor(); ensureColorEditor(); ensurePathEditor(); openStep('s3',true);   // rebuilds + frames the chain
    UI.dropHide=true;
  } finally { UI._loading=false; }
}
async function saveCfg(){
  let cfg;
  if(hasServer){
    try{ await ensureMeshUploaded(); await ensureOverridesUploaded(); await ensureDecoUploaded(); }
    catch(e){ status('Mesh upload failed: '+e.message,'err'); return; }
    cfg=gatherConfig();                       // references the server meshes
  }else{
    cfg=gatherConfig({inlineGeometry:true});  // no server → keep the file self-contained
  }
  download(new Blob([JSON.stringify(cfg)],{type:'application/json'}),'spiral_config.json');
  status(hasServer?'Config saved (references the uploaded mesh).':'Config saved (geometry inline).','ok');
}
function loadCfg(file){
  const r=new FileReader();
  r.onload=async()=>{
    try{ await applyConfig(JSON.parse(r.result)); status('Config loaded.','ok'); }
    catch(e){status('Bad config file: '+e.message,'err');}
  };
  r.readAsText(file);
}

/* ======================================================================== *
 *  PROJECTS — CRUD against the Deno server (data/projects.json)
 * ======================================================================== */
const API='/api/projects';
const hasServer = location.protocol==='http:' || location.protocol==='https:';
async function apiList(){ const r=await fetch(API); if(!r.ok)throw new Error(await r.text()); return r.json(); }
async function apiGet(id){ const r=await fetch(`${API}/${id}`); if(!r.ok)throw new Error(await r.text()); return r.json(); }
async function apiCreate(name,config){
  const r=await fetch(API,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,config})});
  if(!r.ok)throw new Error(await r.text()); return r.json();
}
async function apiUpdate(id,patch){
  const r=await fetch(`${API}/${id}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
  if(!r.ok)throw new Error(await r.text()); return r.json();
}
async function apiDelete(id){ const r=await fetch(`${API}/${id}`,{method:'DELETE'}); if(!r.ok)throw new Error(await r.text()); return r.json(); }

/* shown in the Projects dialog and echoed to the viewport status line (the header's Save button has no dialog open) */
function projStatus(msg,kind=''){ if(UI){ UI.projMsg=msg; UI.projMsgErr=(kind==='err'); } status(msg, kind==='err'?'err':'ok'); }

async function refreshProjects(){
  if(!hasServer){ UI.hasServer=false; UI.projects=[]; return; }
  UI.hasServer=true;
  try{ UI.projects=await apiList(); }
  catch(e){ projStatus('List failed: '+e.message,'err'); }
}

async function saveNewProject(){
  if(!hasServer)return projStatus('Server not running.','err');
  if(!S.baseGeo)return projStatus('Load a part first.','err');
  const name=(UI.projectName||'').trim()||`spiral ${new Date().toLocaleString()}`;
  try{
    await ensureMeshUploaded(); await ensureOverridesUploaded(); await ensureDecoUploaded();
    const p=await apiCreate(name,gatherConfig());
    UI.projectId=p.id; UI.projectName=p.name; UI.projectTitle=p.name;
    projStatus(`Saved “${p.name}”.`); refreshProjects();
  }catch(e){ projStatus('Save failed: '+e.message,'err'); }
}
async function updateCurrentProject(){
  if(!hasServer)return projStatus('Server not running.','err');
  if(!UI.projectId)return projStatus('No project loaded — use “Save as new”.','err');
  try{
    await ensureMeshUploaded(); await ensureOverridesUploaded(); await ensureDecoUploaded();
    const name=(UI.projectName||'').trim();
    const p=await apiUpdate(UI.projectId,{name:name||undefined,config:gatherConfig()});
    UI.projectName=p.name; UI.projectTitle=p.name;
    projStatus(`Saved “${p.name}”.`); refreshProjects();
  }catch(e){ projStatus('Save failed: '+e.message,'err'); }
}
async function loadProject(id){
  try{
    const p=await apiGet(id);
    await applyConfig(p.config||{});
    UI.projectId=p.id; UI.projectName=p.name; UI.projectTitle=p.name;
    projStatus(`Opened “${p.name}”.`); refreshProjects();
  }catch(e){ projStatus('Load failed: '+e.message,'err'); }
}
async function deleteProject(id){
  const p=UI.projects.find(q=>q.id===id);
  if(!confirm(`Delete the project “${p?p.name:id}”? This can't be undone.`))return;
  try{
    await apiDelete(id);
    if(UI.projectId===id){ UI.projectId=null; UI.projectTitle=''; }
    projStatus('Project deleted.'); refreshProjects();
  }catch(e){ projStatus('Delete failed: '+e.message,'err'); }
}

/* ======================================================================== *
 *  FILE LOADING (STL / glTF) + DRAG-DROP
 * ======================================================================== */
function applyUnitScale(g){ const s=UI.unitScale||1; if(s!==1) g.scale(s,s,s); }
function mergeObject3D(root){
  const geos=[]; root.updateMatrixWorld(true);
  root.traverse(o=>{
    if(o.isMesh){const g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);
      ['uv','uv2'].forEach(a=>g.deleteAttribute(a)); geos.push(g);}   // keep COLOR_0 / OBJ vertex colors
  });
  if(!geos.length) return null;
  const anyColor=geos.some(hasVColor);
  for(const g of geos){
    if(anyColor){ const rgb=asRGB(g);
      g.setAttribute('color', rgb || new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count*3).fill(1),3)); }
    else g.deleteAttribute('color');
  }
  return geos.length>1?BufferGeometryUtils.mergeGeometries(geos,false):geos[0];
}
function parseMeshFile(buf,name){
  const ext=name.toLowerCase().split('.').pop();
  return new Promise((resolve,reject)=>{
    try{
      if(ext==='stl'){ resolve(new STLLoader().parse(buf)); }
      else if(ext==='ply'){ const g=new PLYLoader().parse(buf); applyUnitScale(g); resolve(g); }   // PLY scans carry per-vertex RGB
      else if(ext==='obj'){
        const text=(typeof buf==='string')?buf:new TextDecoder().decode(buf);
        const g=mergeObject3D(new OBJLoader().parse(text));
        if(!g){reject(new Error('OBJ has no meshes'));return;}
        applyUnitScale(g); resolve(g);
      }
      else if(ext==='glb'||ext==='gltf'){
        new GLTFLoader().parse(buf,'',(gltf)=>{
          const g=mergeObject3D(gltf.scene);
          if(!g){reject(new Error('glTF has no meshes'));return;}
          applyUnitScale(g); resolve(g);
        },(err)=>reject(new Error('glTF parse error: '+err)));
      }else reject(new Error('unsupported file type .'+ext));
    }catch(e){reject(e);}
  });
}
function loadArrayBuffer(buf,name){
  S.meshName=name.replace(/\.[^.]+$/,'')||'part';   // remember for the upload filename
  S.loadFormat=(name.toLowerCase().split('.').pop())||'stl';   // export the chain back in this format
  S.meshId=null;                                     // a fresh file supersedes any saved mesh
  parseMeshFile(buf,name).then(g=>{
    setBaseGeometry(g);
    if(S.uiStep!=='s1') openStep('s1');              // a new part always starts on the Part page (never on top of the old chain)
  }).catch(e=>status('Load error: '+e.message,'err'));
}
function loadFile(file){
  status('Loading '+file.name+'…');
  const r=new FileReader();
  r.onload=()=>loadArrayBuffer(r.result,file.name);
  r.readAsArrayBuffer(file);
}

const drop=$('drop');
['dragenter','dragover'].forEach(t=>view().addEventListener(t,e=>{e.preventDefault();if(UI){UI.dropHide=false;UI.dropHot=true;}}));
['dragleave','drop'].forEach(t=>view().addEventListener(t,e=>{e.preventDefault();if(UI)UI.dropHot=false;if(t==='drop'||e.target===drop)maybeHide();}));
view().addEventListener('drop',e=>{
  const fs=e.dataTransfer.files; if(!fs.length) return;
  if(S.uiStep==='deco' && S.baseGeo) decoLoadFiles(fs);   // decorate step: the drop is the object (+ its .mtl / textures)
  else loadFile(fs[0]);
});
function view(){return document.getElementById('view');}
function maybeHide(){ if(UI&&S.baseGeo) UI.dropHide=true; }

/* ======================================================================== *
 *  RENDER MODES — X-RAY · SECTION/LAYER VIEW · MATING PREVIEW · SIMPLIFY
 * ======================================================================== */
function overrideMaterials(){ return S.overrideGroup ? S.overrideGroup.children.map(c=>c.material) : []; }
function lsChainMaterials(){ return S.lsChainGroup ? S.lsChainGroup.children.map(c=>c.material) : []; }
function clipMaterials(){
  const o=[];
  if(S.partMesh)    o.push(S.partMesh.material);
  if(S.chain)       o.push(S.chain.material);
  if(S.matePreview) o.push(S.matePreview.material);
  return o.concat(overrideMaterials(), lsChainMaterials(), decoMaterials());
}
function xrayMaterials(){
  const o=[];
  if(S.partMesh) o.push(S.partMesh.material);
  if(S.chain)    o.push(S.chain.material);
  return o.concat(overrideMaterials(), lsChainMaterials(), S.deco&&S.deco.mesh ? [S.deco.mesh.material] : []);
}

function updatePartEdges(){
  if(S.partEdges){ scene.remove(S.partEdges); S.partEdges.geometry.dispose(); S.partEdges.material.dispose(); S.partEdges=null; }
  if(!S.baseGeo) return;
  const eg=new THREE.EdgesGeometry(S.baseGeo, CONST.EDGE_ANGLE);
  S.partEdges=new THREE.LineSegments(eg,new THREE.LineBasicMaterial({color:0x05080c,transparent:true,opacity:.55}));
  scene.add(S.partEdges);
  syncPartEdges();
}
function syncPartEdges(){
  if(S.partEdges) S.partEdges.visible = UI.xray && !!S.partMesh && S.partMesh.visible;
}
function updateDebugViz(){
  if(S.dbgPoints){ scene.remove(S.dbgPoints); S.dbgPoints.material.dispose(); S.dbgPoints=null; }   // geometry is the shared baseGeo — don't dispose
  if(S.dbgWire){ scene.remove(S.dbgWire); S.dbgWire.geometry.dispose(); S.dbgWire.material.dispose(); S.dbgWire=null; }
  if(S.baseGeo){
    const partMode = PART_STEPS.has(S.uiStep);
    const r=(S.baseGeo.boundingSphere&&S.baseGeo.boundingSphere.radius)||40;
    if(UI.showVerts){
      S.dbgPoints=new THREE.Points(S.baseGeo,new THREE.PointsMaterial({color:0x7ee787,size:Math.max(0.3,r*0.012),sizeAttenuation:true,depthTest:false}));
      S.dbgPoints.renderOrder=998; S.dbgPoints.visible=partMode; scene.add(S.dbgPoints);
    }
    if(UI.showWire){
      S.dbgWire=new THREE.LineSegments(new THREE.WireframeGeometry(S.baseGeo),new THREE.LineBasicMaterial({color:0x4cc2ff,transparent:true,opacity:.45}));
      S.dbgWire.visible=partMode; scene.add(S.dbgWire);
    }
  }
  updateDbgOut();
}
function updateDbgOut(){
  if(!S.baseGeo){ UI.dbgOut='Load a part to see its vertex / triangle count.'; return; }
  const v=S.baseGeo.attributes.position.count, t=Math.round(triCount(S.baseGeo));
  UI.dbgOut = `<b>${v.toLocaleString()}</b> verts · ${t.toLocaleString()} tris`;
}
function applyXray(){
  const on=UI.xray;
  for(const m of xrayMaterials()){ m.transparent=on; m.opacity=on?CONST.XRAY_OPACITY:1; m.depthWrite=!on; m.needsUpdate=true; }
  syncPartEdges();
}

const _clipPlanes=[ new THREE.Plane(new THREE.Vector3(0,0,-1),0) ];   // keeps z ≤ constant
function contentZRange(){
  if(S.baseGeo){ S.baseGeo.computeBoundingBox(); const b=S.baseGeo.boundingBox.clone(), d=decoWorldBox(); if(d) b.union(d); return {min:b.min.z,max:b.max.z}; }
  return {min:0,max:10};
}
function updateSectionPlane(){
  const {min,max}=contentZRange();
  const z=min+(max-min)*(UI.sectionZ/100)+1e-3;   // ε so the very top isn't culled
  _clipPlanes[0].constant=z;
  UI.sectionZval=z.toFixed(1)+' mm';
}
function applySection(){
  const on=UI.section;
  if(on) updateSectionPlane();
  for(const m of clipMaterials()){ m.clippingPlanes=on?_clipPlanes:null; m.clipShadows=false; m.needsUpdate=true; }
}

function relMate(){
  // straight (no hinge) neighbour: translate so the neighbour's HOLE lands on our PIN.
  const d=linkOffset();
  return new THREE.Matrix4().makeTranslation(d.x,d.y,d.z);
}
function buildMatePreview(){
  if(!S.baseGeo) return;
  if(S.matePreview){ scene.remove(S.matePreview); S.matePreview.material.dispose(); S.matePreview=null; }
  const mat=new THREE.MeshStandardMaterial({color:CONST.MATE_COLOR,metalness:.1,roughness:.75,
    transparent:true,opacity:CONST.MATE_OPACITY,side:THREE.DoubleSide,depthWrite:false,
    polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});   // stays visible while it lies exactly on the part
  S.matePreview=new THREE.Mesh(S.baseGeo,mat);
  S.matePreview.matrixAutoUpdate=false; S.matePreview.renderOrder=1;
  scene.add(S.matePreview);
  applySection();                         // adopt the clip plane if section view is on
  syncMatePreview();
}
function syncMatePreview(){
  if(!S.matePreview){ syncMateGizmo(); return; }   // a new part was just loaded → its arrows go with the old preview
  const show=UI.matePreviewOn && S.uiStep==='s2' && !!S.partMesh && S.partMesh.visible;
  S.matePreview.visible=show;
  syncMateGizmo();
  if(!show){ UI.mateOut=''; UI.mateState=''; S.mateOverlap=null; syncOverlapViz(); return; }
  const M=relMate(), stacked=!anchorsValid();
  S.matePreview.matrix.copy(M); S.matePreview.updateMatrixWorld(true);
  let hit=stacked;
  if(!hit){ ensureBVH(); hit=S.baseGeo.boundsTree.intersectsGeometry(S.baseGeo,M); }
  S.mateOverlap=null;
  if(hit && !stacked){ S.mateOverlap={lines:[],spots:[]}; overlapSpots(S.baseGeo, S.baseGeo, M, new THREE.Matrix4(), 'this link and the next', S.mateOverlap); }
  syncOverlapViz();
  S.matePreview.material.color.set(hit?0xff6b6b:CONST.MATE_COLOR);
  UI.mateState = hit ? 'bad' : 'ok';
  UI.mateOut = stacked ? 'The next link sits exactly on top of this one. Move it along X or Y until the two no longer touch.'
    : hit ? 'The two links still touch — they would fuse when printed. The yellow line shows where; move the next link a little further.'
    : 'The two links don’t touch — they print as separate, moving pieces.';
}
/* the X / Y arrows sit on the middle of the next link, wherever it is shown */
function syncMateGizmo(){
  const show=!!(S.matePreview && S.matePreview.visible);
  if(show && !mateXform.dragging) mateHandle.position.copy(partCenter()).add(linkOffset());
  if(show && mateXform.object!==mateHandle) mateXform.attach(mateHandle);
  if(!show && mateXform.object) mateXform.detach();
  mateXform.enabled=mateXform.visible=show;
}
function mateGizmoMoved(){
  const c=partCenter(), ax=mateXform.axis||'', mm=v=>Math.round(v*10)/10;   // 0.1 mm steps, like the sliders
  if(ax.includes('X')) setLinkOffset('x', mm(mateHandle.position.x-c.x));   // only the dragged axis — the other keeps its exact value
  if(ax.includes('Y')) setLinkOffset('y', mm(mateHandle.position.y-c.y));
}

/* ---- FILE SIZE / OPTIONAL REDUCTION AT EXPORT ----
   The part is never reduced while you work on it. Export can write a lighter copy of every link instead
   ("Smaller file" on the Export page) — that only changes the downloaded file. */
function triCount(g){ return g ? (g.index ? g.index.count/3 : g.attributes.position.count/3) : 0; }
function estStlBytes(tris){ return 84 + tris*CONST.STL_BYTES_PER_TRI; }
function fmtBytes(b){ return b>=1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB'; }
/* the geometry link i is exported from: a swapped-in model, or the part (the full, mirrored one for a half part) */
function exportSource(i){
  const o=S.overrides.get(i);
  return o ? o.geo : (UI.mirrorEnabled&&S.mirroredBaseGeo) ? S.mirroredBaseGeo : chainPartGeo();
}
function exportVertCap(){ return UI.exportReduce ? Math.max(50, Math.round(+UI.exportMaxVerts)||CONST.MAX_VERTS_PER_LINK) : 0; }   // 0 = full detail
/* the colours the file will have (Export page): the legend under "At most N colours" */
function updateExportPalette(){
  const fmt=exportFormat();
  UI.chainColoured=chainHasColours();
  if(S.uiStep!=='s4' || !S.poses.length || fmt==='stl' || !UI.chainColoured){ UI.exportPalette=[]; return; }
  const pal=chainPalette(exportColourCap(fmt)), mix=exportMixing(fmt) ? mixPlan(pal) : null;
  UI.exportPalette=pal.colours.map((c,i)=>({hex:c.hex, share:Math.max(1,Math.round(c.share*100)),
    ...(mix ? {fil:mix.filamentOf[i], made:mix.colours[i].hex, recipe:mix.colours[i].recipe} : {fil:i+1})}));
  UI.exportFound=pal.found;
}
function updateExportEstimate(){
  if(!S.baseGeo){ UI.exportEst=''; return; }
  updateExportLabel();        // "automatic" follows the chain's colours
  updateExportPalette();
  const links=S.poses.length||Math.max(1,UI.count||1), cap=exportVertCap();
  let full=0, lite=0;
  for(let i=0;i<links;i++){
    const t=triCount(exportSource(i));
    full+=t; lite+= cap ? Math.min(t,2*cap) : t;         // a closed mesh has about two triangles per vertex
  }
  const partV=S.baseGeo.attributes.position.count*((UI.mirrorEnabled&&S.mirroredBaseGeo)?2:1);
  const size=t=>fmtBytes(estStlBytes(Math.round(t))), n=x=>x.toLocaleString();
  UI.exportEst = !cap
    ? `Full detail: <b>${n(partV)}</b> vertices per link · the file will be about <b>${size(full)}</b> as STL (${links} links).`
      + (estStlBytes(full)>CONST.BIG_FILE_MB*1048576 ? ` <span style="color:var(--warn)">That is a large file — tick “Smaller file” for a lighter one.</span>` : '')
    : lite<full
      ? `${partV>cap ? `At most <b>${n(cap)}</b> of ${n(partV)} vertices per link` : `Swapped links reduced to at most <b>${n(cap)}</b> vertices`} · the file will be about <b>${size(lite)}</b> as STL instead of ${size(full)} (${links} links). Only the file is reduced — the part here keeps its detail.`
      : `Nothing to reduce — the link has only ${n(partV)} vertices. The file will be about <b>${size(full)}</b> as STL (${links} links).`;
}
/* a lighter copy of a link, for the file. Welded first: the simplifier only removes vertices that triangles share,
   and a mirrored half or a swapped-in model can come with every triangle on its own. */
async function reducedCopy(src, cap){
  const welded=weldByPosition(src);
  const g=await decimateToVertexTarget(welded,cap);
  welded.dispose();
  return g;
}
function swapBaseGeometry(geo, {weld=true}={}){
  if(weld) geo = weldByPosition(geo);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  const old=S.baseGeo;
  S.baseGeo=geo;
  // the colour-shades slider re-quantizes from baseColorsRaw — it has to match the NEW vertex set
  S.baseColorsRaw = hasVColor(geo) ? geo.getAttribute('color').array.slice() : null;
  if(S.partMesh){
    S.partMesh.geometry=geo;
    const m=S.partMesh.material, vc=hasVColor(geo);
    if(m.vertexColors!==vc){                                // colours appeared (fuse) or went away (unfuse)
      m.vertexColors=vc; m.color.set(vc?0xffffff:CONST.PART_COLOR); m.needsUpdate=true;
    }
  }
  if(S.matePreview) S.matePreview.geometry=geo;
  if(old){ old.disposeBoundsTree?.(); old.dispose(); }     // chain is rebuilt by regen() right after
  history?.clear();                                        // topology changed → old snapshots are invalid
  if(UI) UI.partHasColor=hasVColor(geo);
  updatePartEdges(); updateDebugViz(); updateMeshChips();
  followContent();                                         // e.g. a cut or a fused object changed the part's extent
}
let _simplifierP=null;
function getSimplifier(){
  if(!_simplifierP) _simplifierP = import('meshoptimizer')
    .then(m=>m.MeshoptSimplifier.ready.then(()=>{ m.MeshoptSimplifier.useExperimentalFeatures=true;   // enables attribute-aware simplify (keeps vertex colors)
                                                  return m.MeshoptSimplifier; }));
  return _simplifierP;
}
const COLOR_WEIGHTS=[0.5,0.5,0.5];   // how hard meshopt fights to preserve per-vertex RGB during collapse
function compactIndexed(srcPos, index, srcCol){
  const remap=new Int32Array(srcPos.length/3).fill(-1);
  const outIdx=new Uint32Array(index.length);
  let next=0;
  for(let i=0;i<index.length;i++){ const v=index[i]; if(remap[v]<0) remap[v]=next++; outIdx[i]=remap[v]; }
  const outPos=new Float32Array(next*3), outCol=srcCol?new Float32Array(next*3):null;
  for(let v=0;v<remap.length;v++){ const r=remap[v]; if(r<0) continue;
    outPos[r*3]=srcPos[v*3]; outPos[r*3+1]=srcPos[v*3+1]; outPos[r*3+2]=srcPos[v*3+2];
    if(outCol){ outCol[r*3]=srcCol[v*3]; outCol[r*3+1]=srcCol[v*3+1]; outCol[r*3+2]=srcCol[v*3+2]; } }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(outPos,3));
  if(outCol) g.setAttribute('color', new THREE.Float32BufferAttribute(outCol,3));
  g.setIndex(new THREE.Uint32BufferAttribute(outIdx,1));
  return g;
}
async function meshoptDecimate(src,target){
  const M=await getSimplifier();
  let g=src;
  if(!g.index){ const b=new THREE.BufferGeometry(); b.setAttribute('position',g.getAttribute('position').clone());
                const c=asRGB(g); if(c) b.setAttribute('color', c===g.getAttribute('color')?c.clone():c);
                g=BufferGeometryUtils.mergeVertices(b); }
  const positions=g.getAttribute('position').array;             // Float32Array, stride 3
  const colAttr=g.getAttribute('color');
  const colArr=colAttr ? (colAttr.array instanceof Float32Array ? colAttr.array : Float32Array.from(colAttr.array)) : null;
  const srcIdx=g.index.array instanceof Uint32Array ? g.index.array : new Uint32Array(g.index.array);
  const srcTris=srcIdx.length/3;
  const simp=ic=> colArr
    ? M.simplifyWithAttributes(srcIdx, positions, 3, colArr, 3, COLOR_WEIGHTS, null, ic, 1, ['LockBorder'])
    : M.simplify(srcIdx, positions, 3, ic, 1, ['LockBorder']);
  const count=i=>{ const s=new Set(); for(let k=0;k<i.length;k++) s.add(i[k]); return s.size; };
  let lo=2, hi=srcTris, best=null;
  for(let it=0; it<12 && lo<=hi; it++){
    const tTris=Math.max(1,Math.floor((lo+hi)/2));
    const [idx]=simp(tTris*3);
    if(count(idx)>target) hi=tTris-1;
    else { best=idx; lo=tTris+1; }                              // keep the densest result still ≤ target
  }
  if(!best){ const [idx]=simp(3); best=idx; }
  const out=compactIndexed(positions, best, colArr);
  out.computeVertexNormals(); out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}
function clusterDecimate(src,grid){
  src.computeBoundingBox();
  const min=src.boundingBox.min, size=new THREE.Vector3().subVectors(src.boundingBox.max,min);
  const sx=size.x||1, sy=size.y||1, sz=size.z||1;
  const pos=src.attributes.position, n=pos.count, idx=src.index;
  const key=i=>{
    const cx=Math.min(grid-1,Math.max(0,Math.floor((pos.getX(i)-min.x)/sx*grid)));
    const cy=Math.min(grid-1,Math.max(0,Math.floor((pos.getY(i)-min.y)/sy*grid)));
    const cz=Math.min(grid-1,Math.max(0,Math.floor((pos.getZ(i)-min.z)/sz*grid)));
    return (cx*grid+cy)*grid+cz;
  };
  const cell=new Map();                       // key → [sumX,sumY,sumZ,count,outIndex]
  const vk=new Int32Array(n);
  for(let i=0;i<n;i++){ const k=key(i); vk[i]=k; let c=cell.get(k); if(!c){c=[0,0,0,0,-1];cell.set(k,c);}
    c[0]+=pos.getX(i); c[1]+=pos.getY(i); c[2]+=pos.getZ(i); c[3]++; }
  const outPos=new Float32Array(cell.size*3); let oi=0;
  for(const c of cell.values()){ c[4]=oi; outPos[oi*3]=c[0]/c[3]; outPos[oi*3+1]=c[1]/c[3]; outPos[oi*3+2]=c[2]/c[3]; oi++; }
  const outIdx=[];
  const tri=(a,b,d)=>{ const ia=cell.get(vk[a])[4],ib=cell.get(vk[b])[4],id=cell.get(vk[d])[4];
    if(ia!==ib&&ib!==id&&ia!==id) outIdx.push(ia,ib,id); };
  if(idx){ const A=idx.array; for(let t=0;t<A.length;t+=3) tri(A[t],A[t+1],A[t+2]); }
  else { for(let t=0;t<n;t+=3) tri(t,t+1,t+2); }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(outPos,3));
  g.setIndex(outIdx);
  return g;
}
function clusterDecimateToTarget(src,target){          // offline fallback (grid clustering)
  let lo=2, hi=220, best=null;
  for(let it=0; it<9 && lo<=hi; it++){
    const grid=Math.max(2,Math.round((lo+hi)/2));
    const g=clusterDecimate(src,grid), v=g.attributes.position.count;
    if(v>target){ hi=grid-1; g.dispose(); }
    else { if(best)best.dispose(); best=g; lo=grid+1; }   // keep finest result still ≤ target
  }
  const out=best||clusterDecimate(src,2);
  out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}
async function decimateToVertexTarget(src,target){
  if(src.attributes.position.count<=target) return src.clone();
  try{ return await meshoptDecimate(src,target); }
  catch(e){ console.warn('meshopt simplify unavailable, falling back to clustering:',e);
            return clusterDecimateToTarget(src,target); }
}

/* ======================================================================== *
 *  PER-LINK MODEL OVERRIDES
 * ======================================================================== */
function linkGeom(i){
  const o=S.overrides.get(i);
  const g=o?o.geo:chainPartGeo();
  if(!g.boundsTree) g.boundsTree=new MeshBVH(g);
  if(!g.boundingBox) g.computeBoundingBox();
  return g;
}
function fitReplacement(geo){
  geo=geo.index?geo.toNonIndexed():geo;
  geo=BufferGeometryUtils.mergeVertices(geo);
  geo.applyMatrix4(new THREE.Matrix4().extractRotation(S.alignMatrix));   // match the base part's auto-align/lay-flat/Z-nudge
  geo.computeBoundingBox();
  S.baseGeo.computeBoundingBox();
  const bb=S.baseGeo.boundingBox, bsz=bb.getSize(new THREE.Vector3()), bc=bb.getCenter(new THREE.Vector3());
  const rb=geo.boundingBox, rsz=rb.getSize(new THREE.Vector3()), rc=rb.getCenter(new THREE.Vector3());
  const s=(bsz.length()||1)/(rsz.length()||1);
  geo.applyMatrix4(new THREE.Matrix4().makeTranslation(bc.x,bc.y,bc.z)
    .multiply(new THREE.Matrix4().makeScale(s,s,s))
    .multiply(new THREE.Matrix4().makeTranslation(-rc.x,-rc.y,-rc.z)));
  geo.computeBoundingBox(); geo.translate(0,0,-geo.boundingBox.min.z);    // sit on the plate
  geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
}
/* Effective world matrix for a link's slot, including any manual gizmo nudge on a swapped-in part. */
function linkWorldMatrix(i){
  const o=S.overrides.get(i);
  if(o && o.adjust) return new THREE.Matrix4().multiplyMatrices(S.poses[i],o.adjust);
  return S.poses[i];
}
function rebuildOverrideMeshes(poses){
  if(S.overrideGroup){ scene.remove(S.overrideGroup); S.overrideGroup.traverse(o=>o.material&&o.material.dispose()); }
  S.overrideGroup=new THREE.Group(); scene.add(S.overrideGroup);
  for(const [i,o] of S.overrides){
    if(i>=poses.length) continue;
    if(!o.adjust) o.adjust=new THREE.Matrix4();
    const m=new THREE.Mesh(o.geo,new THREE.MeshStandardMaterial({color:CONST.OVERRIDE_COLOR,metalness:.1,roughness:.7}));
    new THREE.Matrix4().multiplyMatrices(poses[i],o.adjust).decompose(m.position,m.quaternion,m.scale);
    m.updateMatrixWorld(true);
    m.userData.linkIndex=i; S.overrideGroup.add(m);
  }
  syncGizmoAttachment();
}
function recolorOverrides(bad){
  if(!S.overrideGroup) return;
  for(const m of S.overrideGroup.children)
    m.material.color.copy(bad&&bad.has(m.userData.linkIndex)?CONST.LINK_BAD_COLOR:CONST.OVERRIDE_COLOR);
}
function clearOverride(i){
  const o=S.overrides.get(i); if(o){ o.geo.disposeBoundsTree?.(); o.geo.dispose(); } S.overrides.delete(i);
  if(xform.object && xform.object.userData.linkIndex===i) xform.detach();
}

function showSelection(){
  if(S.selBox){ scene.remove(S.selBox); S.selBox=null; }
  if(S.selectedLink==null || !S.poses[S.selectedLink]) return;
  S.selBox=new THREE.Box3Helper(worldAABB(linkWorldMatrix(S.selectedLink),linkGeom(S.selectedLink)),CONST.SELECT_COLOR);
  scene.add(S.selBox);
}
function selectLinkAt(ev){
  if(!S.chain&&!S.lsChainGroup){ status('Build the chain first.','warn'); return; }
  pointerNDC(ev);
  const hits=[];
  if(S.chain&&S.chain.visible){
    const ch=raycaster.intersectObject(S.chain,false)[0];
    if(ch&&ch.instanceId!=null) hits.push({d:ch.distance,i:ch.instanceId});
  }
  if(S.lsChainGroup&&S.lsChainGroup.visible){
    for(const h of raycaster.intersectObjects(S.lsChainGroup.children,false)) hits.push({d:h.distance,i:h.object.userData.linkIndex});
  }
  if(S.overrideGroup) for(const h of raycaster.intersectObjects(S.overrideGroup.children,false)) hits.push({d:h.distance,i:h.object.userData.linkIndex});
  if(!hits.length){ status('No link under the cursor — click directly on a link.','warn'); return; }
  hits.sort((a,b)=>a.d-b.d);
  S.selectedLink=hits[0].i; showSelection(); updateSwapUI(); syncGizmoAttachment();
  status('Selected link #'+S.selectedLink+'.');
}
/* ---- gizmo: attach to the selected link's override mesh, only while step 4 is open ---- */
function syncGizmoAttachment(){
  const i=S.selectedLink;
  const mesh = (i!=null && S.overrideGroup) ? S.overrideGroup.children.find(c=>c.userData.linkIndex===i) : null;
  const want = mesh && S.uiStep==='s4';
  if(want){ xform.attach(mesh); xform.enabled=true; xform.visible=true; }
  else { xform.detach(); xform.enabled=false; xform.visible=false; }
  if(UI) UI.gizmoActive=!!want;
}
function liveGizmoAdjust(){
  const mesh=xform.object; if(!mesh) return;
  mesh.updateMatrix();                              // bake the drag's position/quaternion into .matrix now
  const o=S.overrides.get(mesh.userData.linkIndex); if(!o) return;
  o.adjust.multiplyMatrices(new THREE.Matrix4().copy(S.poses[mesh.userData.linkIndex]).invert(), mesh.matrix);
  showSelection();                                   // cheap visual feedback while dragging
}
function commitGizmoAdjust(){
  if(!xform.object) return;
  liveGizmoAdjust();
  regen();                                           // full collision recheck + stats, now that the drag is done
  syncGizmoAttachment();                             // regen() rebuilt the mesh — reattach to the fresh one
}
function gizmoSetMode(mode){ xform.setMode(mode); if(UI) UI.gizmoMode=mode; }
function gizmoResetAdjust(){
  if(S.selectedLink==null) return;
  const o=S.overrides.get(S.selectedLink); if(!o) return;
  o.adjust.identity();
  regen(); syncGizmoAttachment();
  status('Adjustment reset.','ok');
}
function updateSwapUI(){
  const has=S.selectedLink!=null;
  UI.swapSel = has
    ? `Link #${S.selectedLink} selected — ${S.overrides.has(S.selectedLink)?'custom: '+S.overrides.get(S.selectedLink).name:'base part'}`
    : 'No link selected yet.';
  UI.swapFileBtnDisabled=!has;
  UI.swapClearDisabled=!(has&&S.overrides.has(S.selectedLink));
  UI.swapClearAllDisabled=S.overrides.size===0;
}
function replaceSelectedLink(file){
  if(S.selectedLink==null){ status('Select a link first.','warn'); return; }
  const idx=S.selectedLink;
  status('Loading '+file.name+'…');
  const r=new FileReader();
  r.onload=()=>parseMeshFile(r.result,file.name).then(g=>{
    clearOverride(idx);
    S.overrides.set(idx,{geo:fitReplacement(g),name:file.name,meshId:null,adjust:new THREE.Matrix4()});   // meshId filled in on save
    regen(); showSelection(); updateSwapUI(); updateExportEstimate();
    status(`Link #${idx} → “${file.name}”.`,'ok');
  }).catch(e=>status('Replace failed: '+e.message,'err'));
  r.readAsArrayBuffer(file);
}

/* ======================================================================== *
 *  WIZARD GATING + low-level helpers used by the Alpine component
 * ======================================================================== */
/* The four main steps are s1 Part → s2 Joints → s3 Chain → s4 Export; the optional
   part tools (sculpt / height / lsculpt / deco) are sub-pages opened from the Part page. */
const TOOL_IDS=new Set(['sculpt','height','lsculpt','deco']);
/* what a page shows in the viewport — the camera is only re-framed when this changes */
const viewKind = id => (id==='s3'||id==='s4') ? 'chain' : id==='s2' ? 'joints' : id==='deco' ? 'deco' : 'part';
function openStep(id, force){
  const prev=S.uiStep;
  if(UI){ UI.openId=id; UI.activeId=id; UI.arm=null; }
  showStepView(id);
  if(UI) UI.$nextTick(()=>{ const p=$('pages'); if(p) p.scrollTop=0; });
  if(!S.baseGeo) return;
  if(id==='s2') UI.s2nextDisabled=!anchorsValid();   // an opened project sets the joint with the watchers muted
  const kind=viewKind(id), changed = force || kind!==viewKind(prev);
  if(kind==='chain'){
    if(anchorsValid() && (changed || !S.poses.length)) regen();
    if(changed) setView('iso');
    if(id==='s4') updateExportEstimate();          // file size and colours, as things stand now
    return;
  }
  updateMeshChips(); UI.chipCollide='';              // the HUD describes the single part again
  if(viewKind(prev)==='chain') status('');
  if(changed){ kind==='deco' ? decoFrame() : kind==='joints' ? frameJoints() : frameCamera(); }
}
function unlock(id){ if(UI)UI.steps[id].locked=false; }
function markDone(id){ if(UI)UI.steps[id].done=true; }

/* ======================================================================== *
 *  LOOP SCULPTING (optional step) — per-link progressive deformation
 *  Nodes are stored as metadata; deformation is applied during export.
 *  The preview slider lets users audition any single link's shape.
 * ======================================================================== */
const LS_COL_IDLE   = 0x00e5a0;
const LS_COL_ACTIVE = 0xffcc00;

function compileLSFn(code){
  try{ const fn=new Function('n_it','n_it_nor',code); fn(0,0); return fn; }
  catch(e){ return null; }
}

/* dz: how far this geometry sits below the part the points were placed on (a link with its bottom cut off, see cutShift) */
function applyLSDeform(geo, n_it, n_it_nor, dz=0){
  if(!S.lsNodes.length) return;
  const nodes=lsActingNodes();
  const pos=geo.getAttribute('position');
  const nrm=geo.getAttribute('normal');
  const n=pos.count;
  const v=new THREE.Vector3(), d=new THREE.Vector3();
  for(let vi=0;vi<n;vi++){
    v.fromBufferAttribute(pos,vi); v.z+=dz;
    for(const node of nodes){
      const dist=v.distanceTo(node.pos);
      if(dist>node.radius) continue;
      const r=dist/node.radius;
      let fall;
      switch(node.falloff){
        case 'linear':   fall=1-r; break;
        case 'gaussian': fall=Math.exp(-r*r*4); break;
        case 'cosine':   fall=(1+Math.cos(r*Math.PI))*0.5; break;
        default:         fall=(1-r)*(1-r); break; // smooth quadratic
      }
      let t=n_it_nor;
      try{ const rv=node.fn?+node.fn(n_it,n_it_nor):n_it_nor; t=isFinite(rv)?rv:n_it_nor; }catch(e){}
      switch(node.mode){
        case 'inflate':
          d.set(nrm?nrm.getX(vi):node.dir.x, nrm?nrm.getY(vi):node.dir.y, nrm?nrm.getZ(vi):node.dir.z)
           .multiplyScalar(node.intensity*t*fall);
          break;
        case 'pinch':
          d.copy(node.pos).sub(v);
          if(d.lengthSq()>1e-8) d.normalize();
          d.multiplyScalar(node.intensity*t*fall);
          break;
        default: // push
          d.copy(node.dir).multiplyScalar(node.intensity*t*fall);
      }
      pos.setXYZ(vi, pos.getX(vi)+d.x, pos.getY(vi)+d.y, pos.getZ(vi)+d.z);
    }
  }
  pos.needsUpdate=true;
  geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  geo.disposeBoundsTree?.(); geo.boundsTree=null;
}

/* A point with "Mirror" on acts a second time, reflected across the mirror plane: a half part's own plane,
   else the part's mirror plane (the one Sculpt uses — the detected symmetry line, or the one set by hand). */
function lsMirrorPlane(){ return UI.mirrorEnabled ? axisPlane(UI.mirrorAxis, UI.mirrorOffset) : partMirrorPlane(); }
function lsTwin(node, pl){
  const pos=node.pos.clone().addScaledVector(pl.n, -2*node.pos.clone().sub(pl.p).dot(pl.n));
  const dir=node.dir.clone().addScaledVector(pl.n, -2*node.dir.dot(pl.n));
  return {...node, pos, dir};
}
function lsActingNodes(){
  if(!S.lsNodes.some(n=>n.mirror)) return S.lsNodes;
  const pl=lsMirrorPlane();
  return S.lsNodes.flatMap(n=>n.mirror ? [n, lsTwin(n,pl)] : [n]);
}
/* "Mirror" was ticked and the part has no mirror plane yet: look for its symmetry line, as "Find mirror lines"
   does; a part without one is mirrored lengthways through its middle until the plane is set by hand. */
function lsEnsureMirrorPlane(){
  if(UI.mirrorEnabled || UI.sculptManual || S.symPlanes[0] || !S.baseGeo) return;
  if(findSymPlanes().planes.length){ status('Mirrored across the part\'s mirror line (magenta).','ok'); return; }
  S.baseGeo.computeBoundingBox();
  const bb=S.baseGeo.boundingBox, sz=bb.getSize(new THREE.Vector3()), c=bb.getCenter(new THREE.Vector3());
  UI.sculptAxis = sz.x>=sz.y ? 'y' : 'x';
  UI.sculptOffset = +c[UI.sculptAxis].toFixed(2);
  UI.sculptManual = true;
  status('No mirror line found on this part — mirrored through its middle. Change it under “Mirror plane”.','warn');
}
/* the twins in the view: a fainter arrow and reach for every mirrored point (rebuilt whenever a point or the plane changes) */
function lsSyncTwins(){
  for(const o of [...lsTwinGroup.children]){ lsTwinGroup.remove(o); lsDropViz(o); }
  const pl=lsMirrorPlane();
  S.lsNodes.forEach((n,i)=>{
    if(!n.mirror) return;
    const t=lsTwin(n,pl), col=i===S.lsActiveNodeIdx?LS_COL_ACTIVE:LS_COL_IDLE;
    const arrow=lsMakeArrow(t.pos,t.dir,t.radius,col), sphere=lsMakeSphere(t.pos,t.radius,col);
    for(const m of [arrow.line.material, arrow.cone.material]){ m.transparent=true; m.opacity=0.45; }
    sphere.material.opacity=0.09;
    lsTwinGroup.add(arrow,sphere);
  });
  if(UI) UI.lsMirrorInfo = UI.mirrorEnabled ? 'Across the half part\'s mirror plane.'
    : (!UI.sculptManual && S.symPlanes[0]) ? 'Across the part\'s mirror line (magenta in the view).'
    : `Across ${(UI.sculptAxis||'x').toUpperCase()} = ${+(UI.sculptOffset||0)} mm.`;
}
function lsDropViz(o){
  if(o.line){ o.line.geometry.dispose(); o.line.material.dispose(); o.cone.geometry.dispose(); o.cone.material.dispose(); }
  else { o.geometry.dispose(); o.material.dispose(); }
}
/* the mirror plane moved (other symmetry line, set by hand, half part on / off) */
function lsPlaneChanged(){ if(S.lsNodes.some(n=>n.mirror)){ lsSyncTwins(); lsPreviewUpdate(); } }

function lsMakeArrow(pos, dir, radius, color){
  const len=radius*1.4;
  const ah=new THREE.ArrowHelper(dir.clone().normalize(), pos.clone(), len, color, len*0.28, len*0.14);
  ah.renderOrder=998;
  return ah;
}

function lsMakeSphere(pos, radius, color){
  const g=new THREE.SphereGeometry(radius,16,8);
  const m=new THREE.MeshBasicMaterial({color,wireframe:true,transparent:true,opacity:0.18,depthTest:false});
  const mesh=new THREE.Mesh(g,m); mesh.position.copy(pos); mesh.renderOrder=997;
  return mesh;
}

function lsAddNode(pos, initialDir, mirror){
  if(!UI||!S.baseGeo) return null;
  S.baseGeo.computeBoundingBox();
  const bb=S.baseGeo.boundingBox, sz=bb.getSize(new THREE.Vector3());
  const defaultRadius=Math.max(sz.x,sz.y,sz.z)*0.25;
  const radius=UI.lsRadius||defaultRadius;
  const intensity=UI.lsIntensity||5;
  const mode=UI.lsMode||'push';
  const falloff=UI.lsFalloff||'smooth';
  const code=UI.lsCode||'return n_it_nor;';

  const dir=(initialDir&&initialDir.lengthSq()>0)?initialDir.clone().normalize():new THREE.Vector3(0,0,1);

  const pivot=new THREE.Object3D();
  pivot.position.copy(pos);
  const base=new THREE.Vector3(0,0,1);
  if(Math.abs(dir.dot(base))<0.999) pivot.quaternion.setFromUnitVectors(base,dir);
  lsGroup.add(pivot);

  const arrowHelper=lsMakeArrow(pos,dir,radius,LS_COL_IDLE);
  const sphereViz=lsMakeSphere(pos,radius,LS_COL_IDLE);
  lsGroup.add(arrowHelper,sphereViz);

  const node={pos:pos.clone(),dir,intensity,radius,mode,falloff,code,fn:compileLSFn(code),
              mirror: mirror ?? !!(UI.mirrorEnabled || UI.lsMirror),   // a half part starts mirrored, otherwise like the last point
              arrowHelper,sphereViz,pivot};
  S.lsNodes.push(node);
  lsSelectNode(S.lsNodes.length-1);
  lsSyncNodeList();
  lsPreviewUpdate();
  return node;
}

function lsSelectNode(idx){
  S.lsActiveNodeIdx=idx;
  if(UI) UI.lsActiveNode=idx;
  for(let i=0;i<S.lsNodes.length;i++){
    const active=i===idx, col=active?LS_COL_ACTIVE:LS_COL_IDLE;
    const nd=S.lsNodes[i];
    nd.arrowHelper.setColor(col);
    nd.sphereViz.material.color.setHex(col);
  }
  lsSyncTwins();
  if(idx<0||idx>=S.lsNodes.length){
    lsXform.detach(); lsXform.visible=false; lsXform.enabled=false; return;
  }
  const node=S.lsNodes[idx];
  lsXform.setMode(UI ? UI.lsGizmoMode : 'rotate');
  lsXform.attach(node.pivot); lsXform.visible=true; lsXform.enabled=true;
  if(UI){
    UI.lsIntensity=node.intensity; UI.lsRadius=node.radius;
    UI.lsMode=node.mode; UI.lsFalloff=node.falloff; UI.lsCode=node.code; UI.lsMirror=node.mirror;
  }
}

function lsDeleteNode(idx){
  if(idx<0||idx>=S.lsNodes.length) return;
  const nd=S.lsNodes[idx];
  lsGroup.remove(nd.arrowHelper,nd.sphereViz,nd.pivot);
  nd.arrowHelper.line.geometry.dispose(); nd.arrowHelper.cone.geometry.dispose();
  nd.sphereViz.geometry.dispose(); nd.sphereViz.material.dispose();
  S.lsNodes.splice(idx,1);
  const next=S.lsNodes.length>0?Math.min(idx,S.lsNodes.length-1):-1;
  lsSelectNode(next);
  lsSyncNodeList(); lsPreviewUpdate();
}

function lsSyncNodeList(){
  if(!UI) return;
  UI.lsNodes=S.lsNodes.map((n,i)=>({
    idx:i,
    label:`Point ${i+1} · ${n.mode} ${n.intensity} mm · reach ${n.radius} mm${n.mirror?' · mirrored':''}`,
  }));
}

function lsUpdateActiveNode(){
  const idx=S.lsActiveNodeIdx;
  if(idx<0||idx>=S.lsNodes.length||!UI) return;
  const node=S.lsNodes[idx];
  node.intensity=UI.lsIntensity;
  node.radius=UI.lsRadius;
  node.mode=UI.lsMode;
  node.falloff=UI.lsFalloff;
  node.mirror=!!UI.lsMirror;

  // rebuild arrow + sphere with new radius/color
  const col=LS_COL_ACTIVE;
  lsGroup.remove(node.arrowHelper,node.sphereViz);
  node.arrowHelper.line.geometry.dispose(); node.arrowHelper.cone.geometry.dispose();
  node.sphereViz.geometry.dispose(); node.sphereViz.material.dispose();
  node.arrowHelper=lsMakeArrow(node.pos,node.dir,node.radius,col); lsGroup.add(node.arrowHelper);
  node.sphereViz=lsMakeSphere(node.pos,node.radius,col);           lsGroup.add(node.sphereViz);

  lsSyncTwins(); lsSyncNodeList(); lsPreviewUpdate();
}

function lsApplyCode(){
  const idx=S.lsActiveNodeIdx;
  if(idx<0||idx>=S.lsNodes.length||!UI) return;
  const node=S.lsNodes[idx];
  node.code=UI.lsCode;
  node.fn=compileLSFn(UI.lsCode);
  if(!node.fn && UI) status('Formula error — check the JS syntax.','err');
  lsPreviewUpdate();
}

function lsSetPreset(code){
  if(UI) UI.lsCode=code;
  lsApplyCode();
}

function lsOnGizmoChange(){
  const idx=S.lsActiveNodeIdx;
  if(idx<0||idx>=S.lsNodes.length) return;
  const node=S.lsNodes[idx];
  // sync position (translate mode moves the pivot)
  node.pos.copy(node.pivot.position);
  node.arrowHelper.position.copy(node.pos);
  node.sphereViz.position.copy(node.pos);
  // sync direction (rotate mode changes the pivot quaternion)
  const dir=new THREE.Vector3(0,0,1).applyQuaternion(node.pivot.quaternion).normalize();
  node.dir=dir;
  node.arrowHelper.setDirection(dir);
  lsSyncTwins(); lsPreviewUpdate();
}

function lsPreviewUpdate(){
  if(!S.baseGeo||!UI||S.uiStep!=='lsculpt') return;
  if(S.lsPreviewGeo){ S.lsPreviewGeo.dispose(); S.lsPreviewGeo=null; }
  if(!S.lsNodes.length){ if(S.partMesh) S.partMesh.geometry=S.baseGeo; return; }
  const t=UI.lsPreviewT;
  const geo=S.baseGeo.clone();
  applyLSDeform(geo, Math.round(t*99), t);
  S.lsPreviewGeo=geo;
  if(S.partMesh) S.partMesh.geometry=geo;
}

function lsRevertPreview(){
  if(S.partMesh&&S.baseGeo) S.partMesh.geometry=S.baseGeo;
  if(S.lsPreviewGeo){ S.lsPreviewGeo.dispose(); S.lsPreviewGeo=null; }
}

function lsEnter(){
  lsGroup.visible=true;
  lsXform.visible=S.lsActiveNodeIdx>=0; lsXform.enabled=S.lsActiveNodeIdx>=0;
  lsSyncTwins(); lsPreviewUpdate();
  status(S.lsNodes.length ? 'Morph: select a point to change it, or add another one.'
                          : 'Morph: press “Add a point”, then click the part where it should change.');
}

function lsExit(){
  lsGroup.visible=false;
  lsXform.detach(); lsXform.visible=false; lsXform.enabled=false;
  lsRevertPreview(); status('');
  if(S.poses.length) regen();   // rebuild the chain with updated loop sculpt params
}

function lsClearAll(){
  for(const nd of S.lsNodes){
    lsGroup.remove(nd.arrowHelper,nd.sphereViz,nd.pivot);
    nd.arrowHelper.line.geometry.dispose(); nd.arrowHelper.cone.geometry.dispose();
    nd.sphereViz.geometry.dispose(); nd.sphereViz.material.dispose();
  }
  S.lsNodes=[]; S.lsActiveNodeIdx=-1;
  lsXform.detach(); lsXform.visible=false; lsXform.enabled=false;
  if(UI){ UI.lsActiveNode=-1; UI.lsNodes=[]; }
  lsSyncTwins(); lsRevertPreview();
}

/* ======================================================================== *
 *  DECORATE (optional step) — load an object (a duck, a chilli, …), place it
 *  on the link with the combined gizmo, and fuse it into the link as ONE
 *  coloured solid. Fusing replaces S.baseGeo, so pin/hole, chain, collision
 *  and export all simply see a (coloured) part. The plain link and the object
 *  + its placement are kept, so "Edit placement" can take the fuse back.
 *  See deco/*.js for import (texture → vertex colours), fuse (CSG) and gizmo.
 * ======================================================================== */
const DECO_WORK_VERTS = 60000;     // working copy every detail level is decimated from (keeps the slider fast)
const DECO_GHOST_COLOR = 0xffb454;
const DECO_COLOR_CODE =
`// n_it     – index of this part (0 … count-1)
// n_it_nor – that index normalized to 0 … 1
// base     – this part's natural colour as {r, g, b}, each 0 … 1
// Return 'invert', a colour (tint) or base — see the hint above.

// Decorated link: keep the object's own colours on every link.
// ('invert' reflects colours through the palette mid-point — right for a
//  2-colour part, but on a multi-colour object it makes colours it doesn't have.)
return base;`;

const decoEditable = ()=> S.uiStep==='deco' && !!(S.deco && S.deco.mesh && !S.deco.fused);
function decoMaterials(){
  const o=[];
  if(S.deco&&S.deco.mesh) o.push(S.deco.mesh.material);
  if(S.decoGhost) o.push(S.decoGhost.userData.mat);
  return o;
}
/* world box of the placed (not yet fused) object, for framing / section range */
function decoWorldBox(){
  const d=S.deco; if(!d||!d.mesh||d.fused||!d.mesh.visible) return null;
  d.geo.computeBoundingBox(); d.mesh.updateMatrix();
  return d.geo.boundingBox.clone().applyMatrix4(d.mesh.matrix);
}

/* ---- gizmo → placement (+ one undo step per drag) ---- */
let _decoBefore=null;
decoGizmo.onDragStart=()=>{ S.deco.mesh.updateMatrix(); _decoBefore=S.deco.mesh.matrix.clone(); };
decoGizmo.onChange=()=>decoChanged();
decoGizmo.onDragEnd=()=>{ if(_decoBefore) decoRecord('Move object', _decoBefore); _decoBefore=null; decoChanged(true); };
function decoRecord(label, before){
  const d=S.deco; d.mesh.updateMatrix();
  const after=d.mesh.matrix.clone();
  if(before.equals(after)) return;
  history.push(label, ()=>decoSetMatrix(before), ()=>decoSetMatrix(after));
}
function decoSetMatrix(m){
  const o=S.deco&&S.deco.mesh; if(!o) return;
  o.matrix.copy(m); o.matrix.decompose(o.position,o.quaternion,o.scale);
  decoChanged(true);
}

/* ---- load ---- */
function decoPrepWork(g){          // a fetched / inline mesh → indexed, Float32 rgb colours, like importDecoration's output
  const col=asRGB(g);
  const pos=g.getAttribute('position');
  if(!g.index){
    const n=pos.count, c=col?col.array:new Float32Array(n*3).fill(1);
    return weldWithColors(pos.array instanceof Float32Array?pos.array:Float32Array.from(pos.array), c);
  }
  const out=new THREE.BufferGeometry();
  out.setAttribute('position', pos.clone());
  out.setAttribute('color', col ? (col===g.getAttribute('color')?col.clone():col) : new THREE.Float32BufferAttribute(new Float32Array(pos.count*3).fill(1),3));
  out.setIndex(new THREE.Uint32BufferAttribute(Uint32Array.from(g.index.array),1));
  return out;
}
async function decoLoadFiles(fileList){
  const files=[...fileList]; if(!files.length) return;
  if(!S.baseGeo){ status('Load the link part first (Part step), then the object.','err'); return; }
  UI.decoBusy=true; status('Loading object…'); UI.decoInfo='Loading…';
  await new Promise(r=>setTimeout(r,30));            // let the panel repaint before the heavy parse
  try{
    const res=await importDecoration(files);
    status('Preparing '+res.name+'…');
    await new Promise(r=>setTimeout(r,10));
    const M=await getSimplifier();
    const work=simplifyColored(M,res.geo,DECO_WORK_VERTS);
    res.geo.dispose();
    if(S.deco&&S.deco.fused) decoUnfuse();           // replacing a fused object → put the plain link back first
    decoDispose();
    S.deco={ name:res.name, colorSource:res.colorSource, missing:res.missingTextures,
             work, geo:null, mesh:null, fused:false, linkPreFuse:null, preFuseColor:null, meshId:null, linkMeshId:null };
    UI.decoLoaded=true; UI.decoFused=false; UI.decoColorSource=res.colorSource;
    UI.linkHasColor=hasVColor(S.baseGeo);
    await decoRebuildGeo();
    decoAutoPlace();
    history.clear();
    decoSyncVisibility(); decoFrame();
    const miss=res.missingTextures.length ? ` ⚠ texture ${res.missingTextures.join(', ')} wasn't among the files — select it together with the .obj.` : '';
    status(`Object “${res.name}” placed on the link. Drag the gizmo to adjust it.`+miss, miss?'warn':'ok');
  }catch(e){ console.error(e); status('Object load failed: '+e.message,'err'); decoUpdateInfo(); }
  finally{ UI.decoBusy=false; }
}

/* decimate the working copy to the detail budget, then collapse it to N colours (or one flat colour) */
async function decoRebuildGeo(){
  const d=S.deco; if(!d||!d.work) return;
  const M=await getSimplifier();
  const g=simplifyColored(M,d.work,Math.max(100,Math.round(UI.decoMaxVerts)||6000));
  const col=g.getAttribute('color').array;
  if(d.colorSource==='none'){ const c=new THREE.Color(UI.decoFlatColor); for(let i=0;i<col.length;i+=3){ col[i]=c.r; col[i+1]=c.g; col[i+2]=c.b; } }
  else quantizeColors(col, Math.max(1,Math.round(UI.decoShades)||1), UI.purify);
  g.boundsTree=new MeshBVH(g);
  if(d.mesh){ const old=d.mesh.geometry; d.mesh.geometry=g; if(old&&old!==g){ old.disposeBoundsTree?.(); old.dispose(); } }
  else{
    d.mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({vertexColors:true,metalness:.1,roughness:.7}));
    d.mesh.visible=false; scene.add(d.mesh);
    applyXray(); applySection();
  }
  d.geo=g;
  decoUpdateInfo(); decoChanged(true);
}
let _decoRebuildTimer=null;
function debounceDecoRebuild(){
  if(!S.deco||S.deco.fused) return;
  clearTimeout(_decoRebuildTimer); _decoRebuildTimer=setTimeout(()=>decoRebuildGeo(),120);
}
function decoUpdateInfo(){
  const d=S.deco;
  if(!d||!d.geo){ UI.decoInfo=''; return; }
  const src={texture:'colours from its texture',vertex:'its vertex colours',material:'its material colours',none:'no colours of its own — pick one below'}[d.colorSource]||'';
  UI.decoInfo=`<b>${d.name}</b> · ${src} · <b>${d.geo.attributes.position.count.toLocaleString()}</b> verts`
    + (d.missing.length?`<br><span style="color:var(--warn)">⚠ missing texture: ${d.missing.join(', ')} — select it together with the model file.</span>`:'');
}

/* ---- placement helpers ---- */
function decoAutoPlace(){
  const d=S.deco, m=d.mesh;
  S.baseGeo.computeBoundingBox(); d.geo.computeBoundingBox();
  const L=S.baseGeo.boundingBox, ls=L.getSize(new THREE.Vector3()), ds=d.geo.boundingBox.getSize(new THREE.Vector3());
  const s=(Math.max(ls.x,ls.y)*0.9)/(Math.max(ds.x,ds.y,ds.z)||1);   // about as big as the link
  m.quaternion.identity(); m.scale.setScalar(s);
  m.position.set((L.min.x+L.max.x)/2,(L.min.y+L.max.y)/2, L.max.z+ds.z*s/2);
  m.updateMatrix();
  decoDrop(false);
}
/* lower the object straight down until it meets the link, then sink it in by UI.decoSink mm */
function decoDrop(record=true){
  const d=S.deco; if(!d||!d.mesh||d.fused) return false;
  const m=d.mesh; m.updateMatrix();
  const before=m.matrix.clone(), z0=m.position.z;
  ensureBVH();
  S.baseGeo.computeBoundingBox(); d.geo.computeBoundingBox();
  const L=S.baseGeo.boundingBox;
  const rs=d.geo.boundingBox.clone().applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(),m.quaternion,m.scale));   // extent around the pivot
  const hits=z=>{ m.position.z=z; m.updateMatrix(); return S.baseGeo.boundsTree.intersectsGeometry(d.geo,m.matrix); };
  const hi=L.max.z-rs.min.z+0.5, lo=L.min.z-rs.max.z, STEPS=80;
  let contact=null;
  for(let k=1;k<=STEPS;k++){ const z=hi-(hi-lo)*k/STEPS; if(hits(z)){ contact=z; break; } }
  if(contact==null){
    m.position.z=z0; m.updateMatrix();
    status('The object never meets the link straight below it — move it over the link first.','warn');
    return false;
  }
  let a=contact, b=contact+(hi-lo)/STEPS;            // a overlaps, b is clear
  for(let i=0;i<30;i++){ const mid=(a+b)/2; if(hits(mid)) a=mid; else b=mid; }
  m.position.z=b-Math.max(0,+UI.decoSink||0);        // first touch, then sink in so the two really overlap
  m.updateMatrix();
  if(record) decoRecord('Drop onto link', before);
  decoChanged(true);
  return true;
}
function decoCenter(){
  const d=S.deco; if(!d||!d.mesh||d.fused) return;
  const m=d.mesh; m.updateMatrix(); const before=m.matrix.clone();
  S.baseGeo.computeBoundingBox();
  const c=S.baseGeo.boundingBox.getCenter(new THREE.Vector3());
  m.position.x=c.x; m.position.y=c.y; m.updateMatrix();
  decoRecord('Centre object', before); decoChanged(true);
}
function decoRot90(axis){
  const d=S.deco; if(!d||!d.mesh||d.fused) return;
  const m=d.mesh; m.updateMatrix(); const before=m.matrix.clone();
  m.rotateOnWorldAxis(new THREE.Vector3(axis==='x'?1:0,axis==='y'?1:0,axis==='z'?1:0), Math.PI/2);
  m.updateMatrix();
  decoRecord('Rotate object 90°', before); decoChanged(true);
}
function decoReset(){
  const d=S.deco; if(!d||!d.mesh||d.fused) return;
  d.mesh.updateMatrix(); const before=d.mesh.matrix.clone();
  decoAutoPlace(); decoRecord('Reset placement', before);
}
/* size = longest side of the object's own (unrotated) box, in mm */
function decoSizeNow(){
  const d=S.deco; d.geo.computeBoundingBox();
  const s=d.geo.boundingBox.getSize(new THREE.Vector3());
  return Math.max(s.x*d.mesh.scale.x, s.y*d.mesh.scale.y, s.z*d.mesh.scale.z);
}
function decoSetSize(v){
  const d=S.deco; if(!d||!d.mesh||d.fused||UI._loading) return;
  v=+v; const cur=decoSizeNow();
  if(!(v>0) || !(cur>0) || Math.abs(v-cur)<0.006) return;
  d.mesh.scale.multiplyScalar(v/cur); decoChanged();
}

/* ---- UI ↔ mesh sync (fields are rounded, so compare with a tolerance to avoid feedback) ---- */
function decoUIFromMesh(){
  const m=S.deco.mesh, r2=v=>Math.round(v*100)/100, r3=v=>Math.round(v*1000)/1000, deg=v=>Math.round(THREE.MathUtils.radToDeg(v)*10)/10;
  for(const k of ['x','y','z']){
    UI.decoPos[k]=r2(m.position[k]); UI.decoRot[k]=deg(m.rotation[k]); UI.decoScale[k]=r3(m.scale[k]);
  }
  UI.decoSize=r2(decoSizeNow());
}
function decoMeshFromUI(){
  const d=S.deco; if(!d||!d.mesh||d.fused||UI._loading) return;
  const m=d.mesh, near=(a,b,t)=>Math.abs(a-b)<=t;
  let changed=false;
  for(const k of ['x','y','z']){
    const p=+UI.decoPos[k], r=+UI.decoRot[k], s=+UI.decoScale[k];
    if(Number.isFinite(p) && !near(p,m.position[k],0.006)){ m.position[k]=p; changed=true; }
    if(Number.isFinite(r) && !near(r,THREE.MathUtils.radToDeg(m.rotation[k]),0.06)){ m.rotation[k]=THREE.MathUtils.degToRad(r); changed=true; }
    if(Number.isFinite(s) && s>0 && !near(s,m.scale[k],0.0006)){ m.scale[k]=s; changed=true; }
  }
  if(changed) decoChanged();
}

/* ---- live checks: does it touch the link? does it hit the neighbouring link? ---- */
let _decoRaf=0;
function decoChanged(now){
  if(!S.deco||!S.deco.mesh) return;
  if(now){ cancelAnimationFrame(_decoRaf); _decoRaf=0; decoRefresh(); return; }
  if(!_decoRaf) _decoRaf=requestAnimationFrame(()=>{ _decoRaf=0; decoRefresh(); });
}
function decoRefresh(){
  const d=S.deco; if(!d||!d.mesh) return;
  d.mesh.updateMatrix(); d.mesh.updateMatrixWorld();
  decoUIFromMesh();
  decoCheck();
}
const anchorsPlaced=()=> !(UI.pin.x===0&&UI.pin.y===0&&UI.hole.x===0&&UI.hole.y===0) && anchorsValid();
function decoCheck(){
  const d=S.deco;
  if(!d||!d.mesh||d.fused||!S.baseGeo){ UI.decoTouch=''; UI.decoMate=''; decoSyncGhost(false); return; }
  ensureBVH();
  const M=d.mesh.matrix;
  const touch=S.baseGeo.boundsTree.intersectsGeometry(d.geo,M);
  UI.decoTouch = touch
    ? '<span style="color:var(--accent2)">✓ overlaps the link — they fuse into one piece.</span>'
    : '<span style="color:var(--bad)">✗ doesn\'t touch the link — it would print as a separate loose piece. Use “Drop onto link”.</span>';
  if(!anchorsPlaced()){
    UI.decoMate='<span style="color:#888">Move the next link into place (Joints step) to check the object against the neighbouring links.</span>';
    decoSyncGhost(false); return;
  }
  // the neighbour sits hole-on-pin (T); 2nd neighbour = T² — a long object can reach past the next link
  const Mi=M.clone().invert(), L=S.baseGeo, bL=L.boundsTree, bD=d.geo.boundsTree;
  const hitsAt=T=>[]
    .concat(bL.intersectsGeometry(d.geo, T.clone().multiply(M))      ? ['link ↔ object'] : [])
    .concat(bD.intersectsGeometry(L, Mi.clone().multiply(T))         ? ['object ↔ link'] : [])
    .concat(bD.intersectsGeometry(d.geo, Mi.clone().multiply(T).multiply(M)) ? ['object ↔ object'] : []);
  const T1=relMate(), T2=T1.clone().multiply(T1);
  const h1=hitsAt(T1), h2=hitsAt(T2);
  const bad=h1.length||h2.length;
  UI.decoMate = !bad
    ? '<span style="color:var(--accent2)">✓ clears the neighbouring links (straight mating).</span>'
    : `<span style="color:var(--bad)">✗ touches the ${h1.length?'next':'2nd-next'} link (${[...new Set(h1.length?h1:h2)].join(', ')}) — links would fuse. Shrink, turn or move the object.</span>`;
  decoSyncGhost(true, !!bad);
}
function decoSyncGhost(show, bad){
  const d=S.deco;
  const want = show && UI.decoMateOn && S.uiStep==='deco' && d && d.mesh && !d.fused;
  if(!want){ if(S.decoGhost) S.decoGhost.visible=false; return; }
  if(!S.decoGhost){
    const mat=new THREE.MeshStandardMaterial({color:DECO_GHOST_COLOR,metalness:.1,roughness:.75,
      transparent:true,opacity:CONST.MATE_OPACITY,side:THREE.DoubleSide,depthWrite:false});
    const g=new THREE.Group(); g.matrixAutoUpdate=false; g.userData.mat=mat;
    const link=new THREE.Mesh(S.baseGeo,mat), obj=new THREE.Mesh(d.geo,mat);
    obj.matrixAutoUpdate=false; link.renderOrder=obj.renderOrder=1;
    g.add(link,obj); g.userData.link=link; g.userData.obj=obj;
    S.decoGhost=g; scene.add(g);
    applySection();
  }
  const g=S.decoGhost;
  g.userData.link.geometry=S.baseGeo; g.userData.obj.geometry=d.geo;
  g.userData.obj.matrix.copy(d.mesh.matrix);
  g.matrix.copy(relMate()); g.updateMatrixWorld(true);
  g.userData.mat.color.set(bad?0xff6b6b:DECO_GHOST_COLOR);
  g.visible=true;
}

/* ---- step enter / leave ---- */
function decoSyncVisibility(){
  const d=S.deco, editable=decoEditable();
  if(d&&d.mesh) d.mesh.visible=editable;
  if(editable){ decoGizmo.enable(); decoGizmo.attach(d.mesh); }
  else{ decoGizmo.detach(); decoGizmo.disable(); }
  if(UI){
    const plainLink = d&&d.fused ? d.linkPreFuse : S.baseGeo;   // the link as it is without the object
    UI.decoLoaded=!!d; UI.decoFused=!!(d&&d.fused); UI.decoCanEdit=!!(d&&d.fused&&d.linkPreFuse);
    UI.linkHasColor=!!(plainLink&&hasVColor(plainLink));
  }
  if(!editable && S.decoGhost) S.decoGhost.visible=false;
}
function decoEnter(){
  history.clear();                         // fresh undo timeline for this placement session
  decoSyncVisibility();
  if(S.deco&&S.deco.mesh) decoChanged(true);
  status(!S.deco ? 'Load the object you want to sit on every link.'
       : S.deco.fused ? 'The object is fused into the link. “Edit placement” makes it movable again.'
       : 'Drag the handles to place the object on the link.');
}
function decoExit(){
  if(S.deco&&S.deco.mesh&&!S.deco.fused) decoFuse();
  decoSyncVisibility();
}
function decoFrame(){ if(S.baseGeo) frameContent('iso', 1.4); }   // the link and the object placed on it

/* ---- fuse / unfuse ---- */
function setColorCode(code){ if(colorEditor) colorEditor.setValue(code); else applyColorCode(code); }
function distinctColors(geo){          // after quantization: how many colours the object really uses
  const c=geo.getAttribute('color').array, seen=new Set();
  for(let i=0;i<c.length && seen.size<9;i+=3) seen.add(c[i].toFixed(4)+','+c[i+1].toFixed(4)+','+c[i+2].toFixed(4));
  return seen.size;
}
function decoFuse(){
  const d=S.deco; if(!d||!d.mesh||d.fused||!S.baseGeo) return false;
  d.mesh.updateMatrix();
  ensureBVH();
  const touching=S.baseGeo.boundsTree.intersectsGeometry(d.geo,d.mesh.matrix);
  const t0=performance.now();
  let res;
  try{ res=fuseGeometries(S.baseGeo, d.geo, d.mesh.matrix, {linkColor:new THREE.Color(UI.decoLinkColor), mode:UI.decoFuseMode}); }
  catch(e){ console.error(e); status('Fuse failed: '+e.message,'err'); return false; }
  const linkColored=hasVColor(S.baseGeo);
  d.linkPreFuse=S.baseGeo.clone(); d.linkMeshId=null;
  d.linkPreFuse.deleteAttribute('aSwap');    // the chain shader's per-instance attribute isn't part of the link
  d.preFuseColor={ raw:S.baseColorsRaw?S.baseColorsRaw.slice():null, shades:UI.colorShades };
  swapBaseGeometry(res.geo);                 // welds, refreshes edges / chips, resets baseColorsRaw
  res.geo.dispose();
  d.fused=true;
  // palette = the object's colours + the link's; re-quantizing snaps the blended seam vertices onto it
  const shades=Math.min(8, (linkColored?(d.preFuseColor.shades||2):1) + distinctColors(d.geo));
  UI.colorShades=shades; applyColorShades();
  S.meshDirty=true;
  if(S.colorCode===DEFAULT_COLOR_CODE) setColorCode(DECO_COLOR_CODE);
  if(pivotGizmo) buildGizmos();
  setAnchorRanges(); updateExportLabel();
  updateExportEstimate();
  history.clear();
  decoSyncVisibility();
  markDone('deco');
  const v=S.baseGeo.attributes.position.count;
  UI.decoFuseOut = `✓ Fused (${res.mode==='csg'?'boolean union':'merged shells'}) in ${Math.round(performance.now()-t0)} ms — the link is now <b>${v.toLocaleString()}</b> verts in ${shades} colours.`
    + (res.note?`<br><span style="color:var(--warn)">${res.note}</span>`:'')
    + (touching?'':'<br><span style="color:var(--bad)">⚠ the object doesn\'t touch the link — it will print as a loose piece.</span>');
  status(`Object fused into the link (${v.toLocaleString()} verts).`, touching?'ok':'warn');
  return true;
}
function decoUnfuse(){
  const d=S.deco; if(!d||!d.fused||!d.linkPreFuse) return;
  const link=d.linkPreFuse; d.linkPreFuse=null; d.linkMeshId=null;
  swapBaseGeometry(link,{weld:false});        // exactly the link we fused into (keeps vertex order for its colours)
  if(d.preFuseColor){
    if(d.preFuseColor.raw && d.preFuseColor.raw.length===S.baseGeo.attributes.position.count*3) S.baseColorsRaw=d.preFuseColor.raw;
    UI.colorShades=d.preFuseColor.shades; applyColorShades();
  }
  d.preFuseColor=null; d.fused=false;
  S.meshDirty=true;
  if(pivotGizmo) buildGizmos();
  setAnchorRanges(); updateExportLabel();
  updateExportEstimate();
  UI.decoFuseOut='';
  history.clear();
  decoSyncVisibility(); decoChanged(true);
  if(S.poses.length && (S.uiStep==='s3'||S.uiStep==='s4')) regen();
  status('Fuse undone — the object is editable again.','ok');
}
/* a NEW link was loaded: the fused result is gone with the old link → the object is just "placed" again */
function decoDetachFromLink(){
  const d=S.deco; if(!d) return;
  if(d.linkPreFuse){ d.linkPreFuse.dispose(); d.linkPreFuse=null; }
  d.fused=false; d.linkMeshId=null; d.preFuseColor=null;
  if(UI){ UI.decoFused=false; UI.decoFuseOut=''; }
  decoSyncVisibility();
}
function decoRemove(){
  if(!S.deco) return;
  if(S.deco.fused){
    if(!S.deco.linkPreFuse){ status('This object is baked into the saved part (no plain link stored) — load the plain link in the Part step instead.','warn'); return; }
    decoUnfuse();
  }
  decoDispose();
  status('Object removed — the link is plain again.');
}
function decoDispose(){
  const d=S.deco;
  decoGizmo.detach(); decoGizmo.disable();
  if(S.decoGhost){ scene.remove(S.decoGhost); S.decoGhost.userData.mat.dispose(); S.decoGhost=null; }
  if(d){
    if(d.mesh){ scene.remove(d.mesh); d.mesh.material.dispose(); }
    for(const g of new Set([d.geo,d.work,d.linkPreFuse])) if(g){ g.disposeBoundsTree?.(); g.dispose(); }
  }
  S.deco=null;
  if(UI){ UI.decoLoaded=false; UI.decoFused=false; UI.decoCanEdit=false; UI.decoInfo=''; UI.decoTouch=''; UI.decoMate=''; UI.decoFuseOut=''; }
}
/* project / config load */
async function decoRestore(c){
  let work=null;
  if(c.meshId) work=await fetchMeshGeom(c.meshId);
  else if(Array.isArray(c.geometry)) work=geoFromArrays(c.geometry,null,c.indices,c.colors);
  if(!work) return;
  work=decoPrepWork(work);
  let link=null;
  if(c.fused){
    if(c.linkMeshId) link=await fetchMeshGeom(c.linkMeshId);
    else if(Array.isArray(c.linkGeometry)) link=geoFromArrays(c.linkGeometry,null,c.linkIndices,c.linkColors);
    if(link){ const col=asRGB(link); if(col) link.setAttribute('color', col); }   // GLB may hand back rgba colours
  }
  if(Number.isFinite(c.shades)) UI.decoShades=c.shades;
  if(Number.isFinite(c.maxVerts)) UI.decoMaxVerts=c.maxVerts;
  if(typeof c.flatColor==='string') UI.decoFlatColor=c.flatColor;
  if(typeof c.linkColor==='string') UI.decoLinkColor=c.linkColor;
  if(Number.isFinite(c.sink)) UI.decoSink=c.sink;
  if(c.fuseMode) UI.decoFuseMode=c.fuseMode;
  S.deco={ name:c.name||'object', colorSource:c.colorSource||'vertex', missing:[], work, geo:null, mesh:null,
           fused:false, linkPreFuse:null, preFuseColor:null, meshId:c.meshId||null, linkMeshId:null };
  UI.decoColorSource=S.deco.colorSource;
  await decoRebuildGeo();
  if(Array.isArray(c.matrix)) decoSetMatrix(new THREE.Matrix4().fromArray(c.matrix));
  if(c.fused){
    S.deco.fused=true;                         // S.baseGeo (the saved part) already IS the fused link
    if(link){
      S.deco.linkPreFuse=link; S.deco.linkMeshId=c.linkMeshId||null;
      S.deco.preFuseColor={ raw:hasVColor(link)?link.getAttribute('color').array.slice():null, shades:c.preFuseShades ?? 2 };
    }
  }
  decoSyncVisibility();
}

function showStepView(id){
  const wasSculpt = S.uiStep==='sculpt';
  const wasHeight = S.uiStep==='height';
  const wasLS     = S.uiStep==='lsculpt';
  const wasDeco   = S.uiStep==='deco';
  S.uiStep=id;
  if(wasSculpt && id!=='sculpt') exitSculpt();
  if(wasHeight && id!=='height') exitHeight();
  if(wasLS     && id!=='lsculpt') lsExit();
  if(wasDeco   && id!=='deco') decoExit();      // leaving with a placed object fuses it into the link
  if(id!=='s1') clearCutPreview();              // the flatten-bottom plane belongs to the Part page only
  else if(UI && UI.cutFold && !UI.cutPreview) startCutPreview(false);   // … and is back when the page is, if its section is open
  else if(UI) updateCutPreview();               // a cut in use shows on the Part page
  if(id==='sculpt'  && !sculpt.active && S.baseGeo) enterSculpt();
  if(id==='height'  && !disp.active  && S.baseGeo) enterHeight();
  if(id==='lsculpt' && S.baseGeo) lsEnter();
  if(id==='deco'    && S.baseGeo) decoEnter();
  syncViewVisibility();
  syncMatePreview();         // restores the ghost neighbour when returning to step 2
  syncGizmoAttachment();     // the swap gizmo only ever shows on step 4
}
const PART_STEPS=new Set(['s1','s2','proj','sculpt','height','lsculpt','deco']);
/* single part (part steps) vs whole chain (steps 3/4) — also re-applied after every chain rebuild,
   so a regen() triggered from a part step (simplify, cut, colour code, …) doesn't cover the part */
/* the overlap picture of the page: the chain's on Chain / Export, the two links' on Joints */
function syncOverlapViz(){
  const id=S.uiStep, want = id==='s2' ? S.mateOverlap : PART_STEPS.has(id) ? null : S.chainOverlap;
  if(want!==S.overlapShown){ S.overlapShown=want; setOverlapViz(want); }
}
function syncViewVisibility(){
  const id=S.uiStep, partMode=PART_STEPS.has(id);
  syncOverlapViz();
  if(S.partMesh) S.partMesh.visible = partMode && !!S.baseGeo;
  if(pivotGizmo) pivotGizmo.visible = pivotShown();
  if(S.symGroup) S.symGroup.visible = partMode && S.symVisible;
  if(S.chain) S.chain.visible = !partMode && !S.lsNodes.length;
  if(S.lsChainGroup) S.lsChainGroup.visible = !partMode && !!S.lsNodes.length;
  if(S.overrideGroup) S.overrideGroup.visible = !partMode;
  if(S.selBox) S.selBox.visible = !partMode;
  if(S.dbgPoints) S.dbgPoints.visible = partMode;
  if(S.dbgWire) S.dbgWire.visible = partMode;
  syncPartEdges();
}

/* ---- arm helper for click-modes: the next click in the viewport does `mode` (UI.arm drives the
        banner + crosshair cursor; Esc or pressing the same button again cancels) ---- */
const ARM_HINTS={
  pickFace :'Click the face of the part that should rest on the plate',
  pickLink :'Click the link you want to swap',
  lsPick   :'Click a point on the part',
};
function setArm(mode){ if(!UI)return; UI.arm = (UI.arm===mode)?null:mode; }

function debounceRegen(){clearTimeout(regenTimer);regenTimer=setTimeout(regen,80);}

/* free part rotation about Z — bake the DELTA so geometry stays the single source
   of truth, and carry the anchor points along so the cylinders track the part. */
function rotatePartX(deg){
  if(!S.baseGeo)return;
  const delta=THREE.MathUtils.degToRad(deg-S.partX); S.partX=deg;
  if(Math.abs(delta)<1e-12) return;
  bakeMatrix(new THREE.Matrix4().makeRotationX(delta));
  const c=Math.cos(delta),s=Math.sin(delta);
  for(const a of [UI.pin,UI.hole]){const y=a.y,z=a.z||0; a.y=c*y-s*z; a.z=s*y+c*z;}
  syncGizmos();
}
function rotatePartY(deg){
  if(!S.baseGeo)return;
  const delta=THREE.MathUtils.degToRad(deg-S.partY); S.partY=deg;
  if(Math.abs(delta)<1e-12) return;
  bakeMatrix(new THREE.Matrix4().makeRotationY(delta));
  const c=Math.cos(delta),s=Math.sin(delta);
  for(const a of [UI.pin,UI.hole]){const x=a.x,z=a.z||0; a.x=c*x+s*z; a.z=-s*x+c*z;}
  syncGizmos();
}
function rotatePartZ(deg){
  if(!S.baseGeo)return;
  const delta=THREE.MathUtils.degToRad(deg-S.partZ); S.partZ=deg;
  if(Math.abs(delta)<1e-12) return;
  bakeMatrix(new THREE.Matrix4().makeRotationZ(delta));
  const c=Math.cos(delta),s=Math.sin(delta);
  for(const a of [UI.pin,UI.hole]){const x=a.x,y=a.y; a.x=c*x-s*y; a.y=s*x+c*y;}
  syncGizmos();
}

/* Called by the pin/hole watchers whenever an anchor value changes. */
function onAnchorChange(){
  if(!UI || UI._loading) return;
  syncGizmos();
  UI.s2nextDisabled = !anchorsValid();
  if((S.uiStep==='s3'||S.uiStep==='s4') && anchorsValid()) debounceRegen();
}

/* ---- viewport click router for armed modes ---- */
renderer.domElement.addEventListener('pointerdown',ev=>{
  if(!UI||!UI.arm||ev.button!==0)return;
  if(UI.arm==='pickLink'){ selectLinkAt(ev); setArm(null); return; }   // raycasts the chain, not the part
  const hit=rayPart(ev);
  if(UI.arm==='pickFace'){                       // one click: pick the face and lay the part flat on it
    if(hit){ pickFace(hit); layFlat(); setArm(null); }
    else status('That click missed the part — click directly on the face that should rest on the plate.','warn');
    return;
  }
  if(UI.arm==='lsPick'){
    if(hit){
      const {face}=hit, posAttr=S.baseGeo.getAttribute('position');
      const vA=new THREE.Vector3().fromBufferAttribute(posAttr,face.a);
      const vB=new THREE.Vector3().fromBufferAttribute(posAttr,face.b);
      const vC=new THREE.Vector3().fromBufferAttribute(posAttr,face.c);
      const hp=hit.point;
      const dA=vA.distanceToSquared(hp),dB=vB.distanceToSquared(hp),dC=vC.distanceToSquared(hp);
      const snapped=dA<=dB&&dA<=dC?vA:dB<=dC?vB:vC;
      lsAddNode(snapped, hit.face.normal.clone());
    }
    setArm(null); return;
  }
});

/* ---- drag the pivot marker directly on the plate (step 2, while its controls are open) ---- */
let dragPivot=false;
const _platePlane=new THREE.Plane(new THREE.Vector3(0,0,1),0), _plateHit=new THREE.Vector3();
function gizmoUnder(ev){
  if(!pivotGizmo||!pivotGizmo.visible) return null;
  pointerNDC(ev);
  return raycaster.intersectObject(pivotGizmo,false)[0]||null;
}
function plateUnder(ev){
  pointerNDC(ev);
  if(!raycaster.ray.intersectPlane(_platePlane,_plateHit)) return null;
  const {center,radius}=contentBounds();   // ignore wild hits when the plate is edge-on
  if(Math.hypot(_plateHit.x-center.x,_plateHit.y-center.y) > radius*8) return null;
  return _plateHit;
}
wrap.addEventListener('pointerdown',ev=>{
  if(!UI||UI.arm||ev.button!==0) return;
  if(!gizmoUnder(ev)) return;
  dragPivot=true;
  controls.enabled=false;
  renderer.domElement.style.cursor='grabbing';
  ev.stopPropagation(); ev.preventDefault();
},true);
window.addEventListener('pointermove',ev=>{
  if(!dragPivot){
    if(UI&&!UI.arm){ const h=gizmoUnder(ev); if(pivotGizmo&&pivotGizmo.visible) renderer.domElement.style.cursor=h?'grab':''; }
    return;
  }
  const pt=plateUnder(ev); if(!pt) return;
  setPivot('x',+pt.x.toFixed(2)); setPivot('y',+pt.y.toFixed(2));
  syncGizmos();
});
window.addEventListener('pointerup',()=>{
  if(!dragPivot) return;
  dragPivot=false; controls.enabled=true; renderer.domElement.style.cursor='';
});

/* ---- side panel resize ---- */
(function(){
  const handle=document.getElementById('panelResize');
  if(!handle) return;
  const root=document.documentElement;
  const saved=+localStorage.getItem('panelW');
  if(saved) root.style.setProperty('--panel-w',saved+'px');
  let dragging=false;
  handle.addEventListener('pointerdown',ev=>{
    dragging=true; handle.classList.add('dragging');
    handle.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  handle.addEventListener('pointermove',ev=>{
    if(!dragging) return;
    const w=Math.min(Math.max(ev.clientX,320),Math.min(window.innerWidth-280,1100));
    root.style.setProperty('--panel-w',w+'px');
    if(scaleEditor) scaleEditor.layout();
    if(colorEditor) colorEditor.layout();
    if(pathEditor) pathEditor.layout();
  });
  handle.addEventListener('pointerup',ev=>{
    if(!dragging) return;
    dragging=false; handle.classList.remove('dragging');
    handle.releasePointerCapture(ev.pointerId);
    localStorage.setItem('panelW',root.style.getPropertyValue('--panel-w').replace('px',''));
    if(scaleEditor) scaleEditor.layout();
    if(colorEditor) colorEditor.layout();
    if(pathEditor) pathEditor.layout();
  });
})();

/* ======================================================================== *
 *  ALPINE COMPONENT — all reactive UI state + the template entry points
 * ======================================================================== */
function chainApp(){
  return {
    /* ----- status / wizard ----- */
    statusMsg:'Choose a 3D file — or drop it onto the view.', statusKind:'',
    openId:'s1', activeId:'s1',        // the page shown in the side panel: a main step (s1…s4) or a part tool
    toolBack:'s1',                     // main step a part tool returns to
    steps:{ s1:{done:false,locked:false}, s2:{done:false,locked:true},
            s3:{done:false,locked:true}, s4:{done:false,locked:true},
            sculpt:{done:false,locked:false}, height:{done:false,locked:false},
            lsculpt:{done:false,locked:false}, deco:{done:false,locked:false} },
    arm:null,
    _loading:false,
    /* ----- drop overlay ----- */
    dropHide:false, dropHot:false,
    /* ----- HUD chips ----- */
    chipMesh:'', chipSize:'', chipCollide:'',
    /* ----- step 1 ----- */
    hasPart:false, partName:'', partHasColor:false, halfDetected:false,
    partSize:40,                       // the part's longest side (mm) — scales the brush / morph sliders
    unitScale:1, colorShades:2, purify:false, partX:0, partY:0, partZ:0,
    symOut:'',
    dbgOut:'Load a part to see its vertex / triangle count.',
    showVerts:false, showWire:false,
    cutHeight:0, cutMin:0, cutMax:20, cutPreview:false, cutFold:false,
    cutOn:false, cutAt:0,              // a cut is in use: the links of the chain lose everything below cutAt (the part does not)
    s1nextDisabled:true,
    /* ----- sculpt (optional step) ----- */
    sculptTool:'draw', sculptRadius:8, sculptStrength:0.5,
    sculptMirror:true, sculptManual:false, sculptAxis:'x', sculptOffset:0,
    /* ----- heightmap (optional step) ----- */
    hmStrength:4, hmDir:'normal', hmMode:'planar', hmAxis:'z',
    hmRadius:8, hmFlow:0.6, hmErase:false,
    hmBlack:0, hmWhite:1, hmBright:0, hmContrast:1, hmShadows:0, hmHi:0, hmInvert:false,
    hmLoaded:false,
    /* ----- loop sculpt (optional step) ----- */
    lsNodes:[], lsActiveNode:-1,
    lsIntensity:5, lsRadius:20,
    lsMode:'push', lsFalloff:'smooth', lsMirror:false, lsMirrorInfo:'',
    lsCode:'return n_it_nor;',
    lsPreviewT:0.5,
    lsGizmoMode:'rotate',
    /* ----- mirror half ----- */
    mirrorEnabled:false, mirrorAxis:'x', mirrorOffset:0,
    mirrorDetectOut:'',
    /* ----- edit history (undo/redo) ----- */
    canUndo:false, canRedo:false,
    /* ----- step 2 ----- */
    pin:{x:0,y:0,z:0}, hole:{x:0,y:0,z:0},             // stored joint — edited through offX… / pivX… below
    anchorXmin:-100, anchorXmax:100, anchorYmin:-100, anchorYmax:100,
    offXmax:50, offYmax:50, offZmax:20, pivotOpen:false,
    mateOut:'', mateState:'', matePreviewOn:true, anchorWarn:'', s2nextDisabled:true,
    /* ----- step 3 ----- */
    chainLenVal:'—', chainLenSub:'',
    chainState:'', chainBad:0, chainFoot:'', chainOff:false,   // filled by regen(): '' | 'ok' | 'bad' | 'unchecked'
    overlapCount:0, overlapAt:0, overlapLabel:'',              // the places where links overlap, and the one "Show where" is looking at
    shape:'straight', count:14, startR:25, spacing:16, plate:CONST.DEFAULT_PLATE_MM,
    scaleErr:'', scaleErrColor:'', colorErr:'', colorErrColor:'', pathErr:'', pathErrColor:'', solveOut:'',
    s3nextDisabled:true,
    /* ----- step 4 ----- */
    swapSel:'No link selected yet.',
    swapFileBtnDisabled:true, swapClearDisabled:true, swapClearAllDisabled:true,
    gizmoActive:false, gizmoMode:'translate',
    exportOut:'', exportLabel:'⬇ Download STL', exportFmt:'auto', exportFmtNow:'stl',   // exportFmtNow: what 'auto' comes to
    exportLimitColours:true, exportMaxColours:4, exportPalette:[], exportFound:0, chainColoured:false,
    exportMix:false, exportFilaments:['#00C3FF','#F54399','#FAE727','#000000'],       // 3MF: make the colours from these loaded filaments (cyan, magenta, yellow, black) and mixes of two     // at most N colours in the file — one per filament
    exportReduce:false, exportMaxVerts:CONST.MAX_VERTS_PER_LINK, exportEst:'',   // optional: fewer vertices per link, in the file only
    /* ----- decorate (optional step) ----- */
    decoLoaded:false, decoFused:false, decoCanEdit:false, decoBusy:false,
    decoInfo:'', decoTouch:'', decoMate:'', decoFuseOut:'', decoColorSource:'',
    decoShades:2, decoMaxVerts:6000, decoFlatColor:'#ffcc33', decoLinkColor:'#e6e6e6', linkHasColor:false,
    decoPos:{x:0,y:0,z:0}, decoRot:{x:0,y:0,z:0}, decoScale:{x:1,y:1,z:1}, decoSize:0,
    decoSpace:'local', decoSnap:false, decoSink:1, decoMateOn:true, decoFuseMode:'csg',
    /* ----- render toggles ----- */
    xray:false, section:false, sectionZ:100, sectionZval:'',
    glLost:'',                         // '' | 'wait' | 'stuck' — the browser took the WebGL context away (see "WebGL context loss")
    /* ----- projects (header buttons + dialog) ----- */
    projectName:'', projMsg:'', projMsgErr:false, projects:[], projectId:null, hasServer:true,
    projectTitle:'',                   // name of the project that is open (projectName is the editable field)
    projOpen:false, projFilter:'',

    /* ---- lifecycle ---- */
    init(){
      UI = this;
      window.__debug.S=S; window.__debug.UI=UI;   // TEMP: removed before commit
      this.hasServer = hasServer;
      // seed the editor default functions from the current slider values
      S.scaleCode=DEFAULT_SCALE_CODE; S.scaleFn=compileScaleFn(DEFAULT_SCALE_CODE).fn;
      S.colorCode=DEFAULT_COLOR_CODE; S.colorFn=compileColorFn(DEFAULT_COLOR_CODE).fn;
      S.pathCode=pathCodeFor(this.shape, this.startR, this.spacing/(2*Math.PI)); S.pathFn=compilePathFn(S.pathCode).fn;

      // reactive → engine bridges
      this.$watch('colorShades', ()=>applyColorShades());
      this.$watch('purify', ()=>{ applyColorShades(); debounceDecoRebuild(); });
      this.$watch('pin.x', ()=>onAnchorChange());
      this.$watch('pin.y', ()=>onAnchorChange());
      this.$watch('pin.z', ()=>onAnchorChange());
      this.$watch('hole.x', ()=>onAnchorChange());
      this.$watch('hole.y', ()=>onAnchorChange());
      this.$watch('hole.z', ()=>onAnchorChange());
      this.$watch('pivotOpen', ()=>syncGizmos());
      this.$watch('partX', v=>{ if(!this._loading) rotatePartX(v); });
      this.$watch('partY', v=>{ if(!this._loading) rotatePartY(v); });
      this.$watch('partZ', v=>{ if(!this._loading) rotatePartZ(v); });
      this.$watch('count', ()=>{ if(!this._loading) debounceRegen(); });
      this.$watch('shape', ()=>{ if(!this._loading) regeneratePathFromSliders(); });
      this.$watch('startR', ()=>{ if(!this._loading) regeneratePathFromSliders(); });
      this.$watch('spacing', ()=>{ if(!this._loading) regeneratePathFromSliders(); });
      this.$watch('plate', ()=>{ if(!this._loading) debounceRegen(); });
      this.$watch('exportReduce', ()=>updateExportEstimate());
      this.$watch('exportMaxVerts', ()=>updateExportEstimate());
      this.$watch('sectionZ', ()=>updateSectionPlane());
      this.$watch('cutHeight', v=>{              // moving the slider shows the cut plane — no separate "preview" toggle
        if(v>this.cutMin && S.baseGeo && S.uiStep==='s1') this.cutPreview=true; else if(!(v>this.cutMin)) clearCutPreview();
        updateCutPreview();
      });
      this.$watch('sculptTool',     v=>sculpt.brush.type=v);
      this.$watch('sculptRadius',   v=>sculpt.brush.radius=v);
      this.$watch('sculptStrength', v=>sculpt.brush.strength=v);
      this.$watch('sculptMirror',   ()=>applySculptMirror());
      this.$watch('sculptManual',   ()=>{ applySculptMirror(); lsPlaneChanged(); });
      this.$watch('sculptAxis',     ()=>{ applySculptMirror(); lsPlaneChanged(); });
      this.$watch('sculptOffset',   ()=>{ applySculptMirror(); lsPlaneChanged(); });

      // heightmap displacement bridges
      this.$watch('hmRadius',   v=>disp.brush.radius=v);
      this.$watch('hmFlow',     v=>disp.brush.strength=v);
      this.$watch('hmErase',    v=>disp.erase=v);
      this.$watch('hmStrength', v=>disp.setStrength(v));
      this.$watch('hmDir',      v=>disp.setDirection(v));
      this.$watch('hmMode',     v=>disp.setMapping({mode:v}));
      this.$watch('hmAxis',     v=>disp.setMapping({axis:v}));
      const hmReproc = ()=>heightEditor.setParams({
        black:this.hmBlack, white:this.hmWhite, brightness:this.hmBright,
        contrast:this.hmContrast, shadows:this.hmShadows, highlights:this.hmHi, invert:this.hmInvert });
      for(const k of ['hmBlack','hmWhite','hmBright','hmContrast','hmShadows','hmHi','hmInvert'])
        this.$watch(k, hmReproc);

      // mirror half
      this.$watch('mirrorEnabled', ()=>{ updateMirroredBase(); lsPlaneChanged(); if(S.poses.length) regen(); });
      this.$watch('mirrorAxis',    ()=>{ if(UI.mirrorEnabled){ updateMirroredBase(); lsPlaneChanged(); if(S.poses.length) regen(); } });
      this.$watch('mirrorOffset',  ()=>{ if(UI.mirrorEnabled){ lsPlaneChanged(); debounceMirrorRegen(); } });

      // loop sculpt bridges
      this.$watch('lsIntensity', ()=>lsUpdateActiveNode());
      this.$watch('lsRadius',    ()=>lsUpdateActiveNode());
      this.$watch('lsMode',      ()=>lsUpdateActiveNode());
      this.$watch('lsFalloff',   ()=>lsUpdateActiveNode());
      this.$watch('lsMirror',    v=>{ if(v && S.lsActiveNodeIdx>=0) lsEnsureMirrorPlane(); lsUpdateActiveNode(); });
      this.$watch('lsPreviewT',  ()=>lsPreviewUpdate());

      // decorate bridges
      this.$watch('decoShades',   ()=>debounceDecoRebuild());
      this.$watch('decoMaxVerts', ()=>debounceDecoRebuild());
      this.$watch('decoFlatColor',()=>debounceDecoRebuild());
      for(const k of ['x','y','z']) for(const f of ['decoPos','decoRot','decoScale'])
        this.$watch(f+'.'+k, ()=>decoMeshFromUI());
      this.$watch('decoSize',  v=>decoSetSize(v));
      this.$watch('decoSpace', v=>decoGizmo.setSpace(v));
      this.$watch('decoSnap',  v=>{ decoGizmo.snap=v; });
      this.$watch('decoMateOn',()=>decoChanged(true));
      { const f=localStorage.getItem('exportFmt'); if(f==='auto' || EXPORT_FORMATS.includes(f)) this.exportFmt=f; }   // the slicer decides the format — remember it
      this.$watch('exportFmt', v=>{ localStorage.setItem('exportFmt',v); updateExportLabel(); updateExportEstimate(); });
      try{ const m=JSON.parse(localStorage.getItem('exportMix')||'null');      // the printer's filaments stay the same from project to project
           if(m && Array.isArray(m.filaments) && m.filaments.length===this.exportFilaments.length && m.filaments.every(c=>/^#[0-9a-f]{6}$/i.test(c))){ this.exportMix=!!m.on; this.exportFilaments=m.filaments; } }catch(e){}
      const mixChanged=()=>{ localStorage.setItem('exportMix', JSON.stringify({on:this.exportMix, filaments:this.exportFilaments})); updateExportEstimate(); };
      this.$watch('exportMix', mixChanged);
      this.$watch('exportFilaments', mixChanged);
      this.$watch('exportLimitColours', ()=>updateExportEstimate());
      this.$watch('exportMaxColours', ()=>updateExportEstimate());

      refreshProjects();
      status('Choose a 3D file — or drop it onto the view.');
    },

    /* ---- wizard navigation ---- */
    get isTool(){ return TOOL_IDS.has(this.openId); },
    get mainStep(){ return this.isTool ? 's1' : this.openId; },      // the part tools belong to the Part step
    stepState(id){
      return { cur:this.mainStep===id, done:this.steps[id].done && this.mainStep!==id,
               locked: id!=='s1' && (!this.hasPart || ((id==='s3'||id==='s4') && this.steps.s3.locked)) };
    },
    stepTitle(id){
      if(id==='s1') return 'Load and orient the link';
      if(!this.hasPart) return 'Load a part first';
      if(id==='s2') return 'Set how the next link sits';
      if(this.steps.s3.locked) return 'Move the next link into place, then build the chain';
      return id==='s3' ? 'Shape and length of the chain' : 'Download the printable file';
    },
    /* a click in the step bar: go there if it's reachable, otherwise advance one step the way the Next buttons would */
    async goStep(id){
      if(this.openId===id) return;
      if(!this.hasPart){ if(id!=='s1') status('Load a part first — choose a file or drop it onto the view.','warn'); return; }
      if(id==='s1'){ if(this.openId==='s2') status(''); openStep('s1'); return; }   // the Joints hint doesn't belong on the Part page
      if(this.isTool) openStep('s1');              // finish the brush / placement session before the part is prepared
      if(id==='s2'){ await this.s1Next(); return; }
      if(this.steps.s3.locked){                    // the chain hasn't been built yet
        if(this.openId==='s2') await this.s2Next();
        else{ await this.s1Next(); status('Move the next link into place first, then press “Build chain”.'); }
        return;
      }
      if(id==='s3') openStep('s3'); else this.s3Next();
    },
    toggleStep(id){ return TOOL_IDS.has(id) ? this.openTool(id) : this.goStep(id); },   // older name, kept for scripts
    get backLabel(){ return this.isTool ? '← Back' : ({s2:'← Part', s3:'← Joints', s4:'← Chain'})[this.openId] || ''; },
    goBack(){ if(this.isTool) this.closeTool(); else this.goStep(({s2:'s1', s3:'s2', s4:'s3'})[this.openId] || 's1'); },
    async openTool(id){
      if(!S.baseGeo || this.openId===id) return;
      if(!this.isTool) this.toolBack=this.openId;
      await this.preparePart();
      openStep(id);
    },
    closeTool(){ const back=this.toolBack||'s1'; this.toolBack='s1'; this.goStep(back); },
    onEscape(){ if(this.projOpen) this.projOpen=false; else if(this.arm) setArm(null); },
    get armHint(){ return ARM_HINTS[this.arm] || ''; },
    get mouseHint(){
      return (this.openId==='sculpt'||this.openId==='height')
        ? 'Drag: paint · Alt+drag: rotate · Right-drag: move · Scroll: zoom'
        : this.openId==='s2'
        ? 'Drag an arrow: move the next link · Drag: rotate · Right-drag: move · Scroll: zoom'
        : 'Drag: rotate · Right-drag: move · Scroll: zoom';
    },
    /* everything that has to be true of the part before any later page works on it (safe to repeat) */
    async preparePart(){
      if(!S.baseGeo) return false;
      if(!anchorsValid()) stackLinks();                // no offset yet → the pivot follows the part as it is now
      markDone('s1'); unlock('s2');
      buildGizmos(); setAnchorRanges();
      return true;
    },
    async s1Next(){
      if(!(await this.preparePart())) return;
      openStep('s2');
      status('Move the next link — with the arrows in the view, or with X and Y — until the two no longer touch.');
    },
    async s2Next(){
      if(!S.baseGeo||!anchorsValid())return;
      markDone('s2'); unlock('s3'); unlock('s4');
      ensureScaleEditor(); ensureColorEditor(); ensurePathEditor();
      openStep('s3');                                  // builds + frames the chain
    },
    s3Next(){
      if(this.steps.s3.locked) return;
      markDone('s3'); openStep('s4');
      updateExportEstimate();
      updateSwapUI();
      if(this.chainState==='bad') status(`${this.chainBad} links overlap — they would fuse when printed. Fix them on the Chain page first.`,'err');
      else status('Ready to export.','ok');
    },

    /* ---- step 1 actions ---- */
    chooseFile(){ $('fileInput').click(); },
    onFileInput(e){ if(e.target.files[0])loadFile(e.target.files[0]); e.target.value=''; },   // reset → the same file can be picked again
    get brushMax(){ return Math.max(5, Math.ceil(this.partSize*0.75)); },
    get reachMax(){ return Math.max(5, Math.ceil(this.partSize*1.5)); },
    get amountMax(){ return Math.max(2, Math.ceil(this.partSize*0.5)); },
    autoAlign, nudge, setArm, layFlat, detectSymmetry, centerPart,
    alignZ(){ alignInPlane(); S.partX=0; this.partX=0; S.partY=0; this.partY=0; S.partZ=0; this.partZ=0; frameCamera(); status('Auto-rotated: longest axis on X.','ok'); },
    resetRotXY(){ rotatePartX(0); this.partX=0; rotatePartY(0); this.partY=0; },
    toggleSym(){ S.symVisible=!S.symVisible; if(S.symGroup)S.symGroup.visible=S.symVisible; },
    toggleVerts(){ this.showVerts=!this.showVerts; updateDebugViz(); },
    toggleWire(){ this.showWire=!this.showWire; updateDebugViz(); },
    applyCut, removeCut, showOverlap,
    get exportKeepsColour(){ return this.chainColoured && this.exportFmtNow!=='stl'; },
    get exportColourNote(){
      const n=this.exportPalette.length, all=this.exportFound;
      return all>n ? `The chain has ${all} colours — similar ones are merged into these ${n}:` : `The chain has ${n} colour${n>1?'s':''}:`;
    },
    get exportMixOn(){ return this.exportMix && this.exportFmtNow==='3mf' && this.chainColoured; },
    onCutFold(open){ this.cutFold=open; if(open) startCutPreview(true); else clearCutPreview(); },
    get cutInfo(){ const off=this.cutHeight-this.cutMin, all=this.cutMax-this.cutMin; return `Cuts off the lowest ${off.toFixed(1)} mm of ${all.toFixed(1)} mm — ${Math.round(100*off/all)} % of the height.`; },
    get cutSummary(){ return this.cutOn ? `links cut ${(this.cutAt-this.cutMin).toFixed(1)} mm up` : ''; },

    /* ---- loop sculpt actions ---- */
    mirrorSnap(){
      if(!S.baseGeo) return;
      S.baseGeo.computeBoundingBox();
      const bb=S.baseGeo.boundingBox, ax=this.mirrorAxis;
      const mn=bb.min[ax], mx=bb.max[ax];
      this.mirrorOffset=+(Math.abs(mn)<=Math.abs(mx)?mn:mx).toFixed(3);
    },
    lsPickMode(){ setArm(this.arm==='lsPick'?null:'lsPick'); },
    lsSetGizmoMode(m){ this.lsGizmoMode=m; lsXform.setMode(m); },
    lsSelectNode(idx){ lsSelectNode(idx); },
    lsDeleteNode(idx){ lsDeleteNode(idx); },
    lsClear(){ lsClearAll(); status('All morph points removed.'); },
    lsApplyCode(){ lsApplyCode(); status('Formula applied.','ok'); },
    lsPreset(code){ lsSetPreset(code); status('Preset applied.','ok'); },

    /* ---- sculpt actions ---- */
    sculptRepair,
    setSculptTool(t){ this.sculptTool=t; },

    /* ---- heightmap actions ---- */
    async hmLoadFile(e){
      const f=e.target.files[0]; if(!f) return;
      await heightEditor.load(f);
      heightEditor.setParams({ black:this.hmBlack, white:this.hmWhite, brightness:this.hmBright,
        contrast:this.hmContrast, shadows:this.hmShadows, highlights:this.hmHi, invert:this.hmInvert });
      heightEditor.setPreviewCanvas(document.getElementById('hmPreview'));
      this.hmLoaded=true;
      if(disp.active) disp.setHeightBuffer(heightEditor.out, heightEditor.width, heightEditor.height);
      status('Image loaded — drag on the part to paint the relief.','ok');
    },
    hmClearMask(){ disp.clearMask(); },
    hmSmooth(){ disp.smoothMask(0.6, 2); },

    /* ---- edit history ---- */
    undo(){ history.undo(); },
    redo(){ history.redo(); },

    /* ---- step 2 actions ---- */
    toggleMate(){ this.matePreviewOn=!this.matePreviewOn; syncMatePreview(); },
    /* the joint as the page shows it: where the next link sits against this one, and the point they turn around */
    get offX(){ return +(this.pin.x-this.hole.x).toFixed(3); },                 set offX(v){ setLinkOffset('x',v); },
    get offY(){ return +(this.pin.y-this.hole.y).toFixed(3); },                 set offY(v){ setLinkOffset('y',v); },
    get offZ(){ return +((this.pin.z||0)-(this.hole.z||0)).toFixed(3); },       set offZ(v){ setLinkOffset('z',v); },
    get pivX(){ return +this.pin.x.toFixed(3); },                               set pivX(v){ setPivot('x',v); },
    get pivY(){ return +this.pin.y.toFixed(3); },                               set pivY(v){ setPivot('y',v); },
    resetOffset(){ if(S.baseGeo){ stackLinks(); status('The next link is back on top of this one.'); } },

    /* ---- step 3 actions ---- */
    recheck(){ regen(true); },
    reverseChain,
    pathReset(){ regeneratePathFromSliders(); },
    scaleReset(){ this.scalePreset('same'); },
    colorReset(){ this.colorPreset('alternate'); },
    /* presets: the numbers worth tweaking sit at the END of the code, below the explanatory comments → scroll there */
    scalePreset(k){
      const c=SCALE_PRESETS[k]; if(!c) return;
      if(scaleEditor){ scaleEditor.setValue(c); scaleEditor.revealLine(scaleEditor.getModel().getLineCount()); } else applyScaleCode(c);
    },
    colorPreset(k){
      const c=COLOR_PRESETS[k]; if(!c) return;
      setColorCode(c);
      if(colorEditor) colorEditor.revealLine(colorEditor.getModel().getLineCount());
    },

    /* ---- render-mode + camera ---- */
    toggleXray(){ this.xray=!this.xray; applyXray(); },
    toggleSection(){ this.section=!this.section; applySection(); },
    setView,

    /* ---- step 4 actions ---- */
    chooseSwapFile(){ $('swapFileInput').click(); },
    onSwapFileInput(e){ if(e.target.files[0]){ replaceSelectedLink(e.target.files[0]); e.target.value=''; } },
    swapClear(){ if(S.selectedLink!=null&&S.overrides.has(S.selectedLink)){ clearOverride(S.selectedLink); regen(); showSelection(); updateSwapUI(); updateExportEstimate(); status('Link reverted to the base part.'); } },
    swapClearAll(){ for(const i of [...S.overrides.keys()]) clearOverride(i); regen(); showSelection(); updateSwapUI(); updateExportEstimate(); status('All links reverted to the base part.'); },
    gizmoSetMode, gizmoResetAdjust,

    /* ---- decorate actions ---- */
    decoChooseFiles(){ $('decoFileInput').click(); },
    decoOnFileInput(e){ if(e.target.files.length){ decoLoadFiles(e.target.files); e.target.value=''; } },
    decoDrop(){ decoDrop(true); },
    decoCenter, decoRot90, decoReset, decoRemove,
    decoFuse(){ decoFuse(); },
    decoUnfuse(){ decoUnfuse(); },
    async decoNext(){
      if(S.deco&&S.deco.mesh&&!S.deco.fused&&!decoFuse()) return;
      markDone('deco');
      if(!this.steps.s3.locked && anchorsValid()) await this.s2Next();   // chain was already built (or project loaded) → straight back to it
      else{ openStep('s2'); status('Now move the next link into place against the decorated one.'); }
    },
    exportChain, saveCfg,
    chooseCfg(){ $('cfgInput').click(); },
    onCfgInput(e){ if(e.target.files[0]){ this.projOpen=false; loadCfg(e.target.files[0]); } e.target.value=''; },

    /* ---- projects ---- */
    refreshProjects, saveNewProject, updateCurrentProject, loadProject, deleteProject,
    get shownProjects(){
      const q=this.projFilter.trim().toLowerCase();
      return q ? this.projects.filter(p=>(p.name||'').toLowerCase().includes(q)) : this.projects;
    },
    projMeta(p){ return (p.links ?? '–')+' links · '+new Date(p.updatedAt).toLocaleDateString(); },
    openProjects(){ this.projOpen=true; this.projMsg=''; this.projFilter=''; refreshProjects(); },
    saveProject(){ return this.projectId ? updateCurrentProject() : saveNewProject(); },
    /* header Save: one click once the project has a name; the first time it asks for one */
    quickSave(){
      if(!S.baseGeo){ status('Nothing to save yet — load a part first.','warn'); return; }
      if(this.projectId && hasServer) return updateCurrentProject();
      this.openProjects();
      setTimeout(()=>{ const el=this.$refs.projName; if(el) el.focus(); }, 60);   // x-show reveals the dialog a tick later
    },
    async openProject(id){ this.projOpen=false; await loadProject(id); },
  };
}
