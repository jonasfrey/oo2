import * as THREE from 'three';
import { OrbitControls }   from 'three/addons/controls/OrbitControls.js';
import { STLLoader }       from 'three/addons/loaders/STLLoader.js';
import { PLYLoader }       from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader }      from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader }       from 'three/addons/loaders/OBJLoader.js';
import { STLExporter }     from 'three/addons/exporters/STLExporter.js';
import { GLTFExporter }    from 'three/addons/exporters/GLTFExporter.js';
import { PLYExporter }     from 'three/addons/exporters/PLYExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, MeshBVH }
  from 'three-mesh-bvh';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { SculptController } from './sculpt/SculptController.js';
import { BRUSH } from './sculpt/Brush.js';
import { repairGeometry } from './sculpt/MeshRepair.js';
import { DisplacementController } from './heightmap/DisplacementController.js';
import { HeightmapEditor }        from './heightmap/HeightmapEditor.js';

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
  DEFAULT_PLATE_MM    : 220,    // square build plate edge
  PART_COLOR          : 0x9aa7b4,
  PIN_COLOR           : 0xff5d5d,
  HOLE_COLOR          : 0x5db0ff,
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
  MAX_VERTS_PER_LINK  : 2000,   // default per-link vertex cap — auto-simplify targets this
                                // (≈4k tris/link → 400 links ≈ 1.6M tris ≈ 76 MB STL)
};

/* The Alpine component instance — set in init(). All reactive UI state lives on it;
   the engine reads/writes UI.* the way the old code read/wrote DOM elements. */
let UI = null;
/* getElementById is still used for the few raw DOM nodes Alpine doesn't drive:
   the Monaco editor containers and the hidden <input type=file> elements. */
const $ = id => document.getElementById(id);
const status = (msg,kind='') => { if(UI){ UI.statusMsg=msg; UI.statusKind=kind; } };

/* ================================ SCENE ================================== */
const wrap = document.getElementById('canvasWrap');
const renderer = new THREE.WebGLRenderer({antialias:true});
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

scene.add(new THREE.HemisphereLight(0xffffff, 0x202830, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4); dir.position.set(80,-120,200); scene.add(dir);

// Build-plate grid + axes (XY plane, Z up)
let grid = new THREE.GridHelper(CONST.DEFAULT_PLATE_MM, 22, 0x33424f, 0x222b33);
grid.rotation.x = Math.PI/2;               // lay grid flat on XY
scene.add(grid);
const axes = new THREE.AxesHelper(40); scene.add(axes);
let plateOutline = makePlateOutline(CONST.DEFAULT_PLATE_MM); scene.add(plateOutline);

function makePlateOutline(size){
  const h=size/2;
  const g=new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-h,-h,0),new THREE.Vector3(h,-h,0),
    new THREE.Vector3(h,h,0),new THREE.Vector3(-h,h,0),new THREE.Vector3(-h,-h,0)]);
  return new THREE.Line(g,new THREE.LineBasicMaterial({color:0x3a4a58}));
}

function resize(){
  const r=wrap.getBoundingClientRect();
  renderer.setSize(r.width,r.height,false);
  camera.aspect=(r.width/r.height)||1; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap); resize();

(function loop(){requestAnimationFrame(loop);controls.update();renderer.render(scene,camera);})();

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
  partZ:0,               // baked-in part rotation about Z (deg) — tracker for delta rotations
  alignMatrix:new THREE.Matrix4(),   // cumulative rotation baked into baseGeo (auto-align/lay-flat/Z-nudge) —
                                      // reapplied (rotation only) to any link-swap upload, so it shares the same orientation
  meshId:null,           // server filename of the uploaded (aligned) mesh, if saved
  meshName:'part',       // original file name (sans extension), used when uploading
  meshDirty:true,        // geometry changed since last upload → re-upload on save
  poses:[],              // Matrix4 per link (world)
  chain:null,            // InstancedMesh preview
  collideSet:new Set(),  // indices currently colliding
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
  geoPristine:null,      // pre-simplify copy of baseGeo, for "restore full detail"
  appliedPct:0,          // reduction % currently baked into baseGeo (0 = full detail)
  geoPreCut:null,        // pre-flatten copy of baseGeo, for "undo cut"
  cutPlaneViz:null,      // translucent plane previewing the flatten-bottom cut height
  overrides:new Map(),   // link index → {geo,name}: that slot uses a custom model
  overrideGroup:null,    // THREE.Group of the custom-link meshes
  selectedLink:null,     // index of the link picked in the viewport (for swapping)
  selBox:null,           // Box3Helper around the selected link
  uiStep:'s1',           // which wizard step's view is showing (drives part-vs-chain visibility)
  dbgPoints:null, dbgWire:null,
  chainLength:0, linkSpan:0,
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
  if (S.geoPristine){ S.geoPristine.dispose(); S.geoPristine=null; }   // new part → drop the old detail master
  if (S.geoPreCut){ S.geoPreCut.dispose(); S.geoPreCut=null; }         // and any pending "undo cut" for the old part
  clearCutPreview();
  if (UI){ UI.hasCutUndo=false; UI.cutHeight=0; }
  for (const i of [...S.overrides.keys()]) clearOverride(i);           // and any per-link swaps (slots no longer valid)
  if (S.overrideGroup){ scene.remove(S.overrideGroup); S.overrideGroup.traverse(o=>o.material&&o.material.dispose()); S.overrideGroup=null; }
  S.alignMatrix.identity();                         // fresh part → its own alignment starts from scratch
  S.selectedLink=null; if(S.selBox){ scene.remove(S.selBox); S.selBox=null; }
  S.appliedPct=0;
  UI.simResetDisabled=true; UI.simPct=0;
  if (S.baseGeo){ S.baseGeo.disposeBoundsTree?.(); S.baseGeo.dispose(); }

  S.baseGeo = geo;
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
  if(UI.simAuto) autoFitReduction(false); else updateSimEstimate();   // show the recommended reduction
  UI.s1nextDisabled=false;
  UI.dropHide=true;                         // load done → drop the overlay
  status('Part loaded. Auto-align, then pick the face to lay flat.','ok');
}

function updateMeshChips(){
  if(!S.baseGeo) return;
  const b=new THREE.Box3().setFromBufferAttribute(S.baseGeo.attributes.position);
  const s=b.getSize(new THREE.Vector3());
  UI.chipMesh=`<b>${S.baseGeo.attributes.position.count.toLocaleString()}</b> verts · ${Math.round(triCount(S.baseGeo)).toLocaleString()} tris`;
  UI.chipSize=`bbox <b>${s.x.toFixed(1)}×${s.y.toFixed(1)}×${s.z.toFixed(1)}</b> mm`;
}

function frameCamera(){
  S.baseGeo.computeBoundingSphere();
  const r=S.baseGeo.boundingSphere.radius||50;
  controls.target.set(0,0,r*0.3);
  camera.position.set(r*2.2,-r*2.8,r*2.4);
  camera.updateProjectionMatrix();
}

function contentBounds(){
  const box=new THREE.Box3();
  if(S.chain&&S.chain.visible){ box.setFromObject(S.chain); }
  else if(S.baseGeo){ S.baseGeo.computeBoundingBox(); box.copy(S.baseGeo.boundingBox); }
  else { box.set(new THREE.Vector3(-60,-60,0),new THREE.Vector3(60,60,60)); }
  return { center:box.getCenter(new THREE.Vector3()),
           radius:(box.getSize(new THREE.Vector3()).length()/2)||60 };
}
function setView(name){
  const {center,radius}=contentBounds();
  const d=radius*3.0;
  const off={
    iso  :[d*0.62,-d*0.78,d*0.66],
    top  :[0,-radius*0.001, d],
    front:[0,-d,0],
    side :[d,0,0],
  }[name] || [d*0.62,-d*0.78,d*0.66];
  controls.target.copy(center);
  camera.position.set(center.x+off[0], center.y+off[1], center.z+off[2]);
  camera.updateProjectionMatrix();
  controls.update();
}

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
  status('Auto-aligned to principal axes. Now pick the face to lay flat.','ok');
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

/* ----- 90° nudges ----- */
function nudge(axis){
  if(!S.baseGeo) return;
  const m=new THREE.Matrix4();
  if(axis==='x')m.makeRotationX(Math.PI/2);
  if(axis==='y')m.makeRotationY(Math.PI/2);
  if(axis==='z')m.makeRotationZ(Math.PI/2);
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

// resolve the mirror plane: detected symmetry by default, manual X/Y/Z + offset override
function applySculptMirror(){
  let pt, nrm;
  if(!UI.sculptManual && S.symPlanes[0]){
    pt = S.symPlanes[0].p.clone();
    nrm = S.symPlanes[0].n.clone();
  }else{
    const ax = UI.sculptAxis || 'x';
    nrm = new THREE.Vector3(ax==='x'?1:0, ax==='y'?1:0, ax==='z'?1:0);
    pt = new THREE.Vector3(); pt[ax] = UI.sculptOffset || 0;
  }
  sculpt.setMirror(pt, nrm, UI.sculptMirror);
}
function enterSculpt(){
  if(!S.baseGeo) return;
  ensureBVH();
  sculpt.attach(S.partMesh);
  sculpt.brush.type     = UI.sculptTool || BRUSH.DRAW;
  sculpt.brush.radius   = UI.sculptRadius;
  sculpt.brush.strength = UI.sculptStrength;
  applySculptMirror();
  sculpt.enable();
  status('Sculpt: left-drag to paint, Alt+drag to orbit, right-drag to pan.','ok');
}
function exitSculpt(){
  sculpt.disable();
  // refresh everything downstream that reads S.baseGeo
  S.baseGeo.disposeBoundsTree?.(); S.baseGeo.boundsTree=null;   // chain build rebuilds via ensureBVH()
  if(S.geoPristine){ S.geoPristine.dispose(); S.geoPristine=null; } // pre-simplify master no longer valid
  S.appliedPct=0; if(UI){ UI.simResetDisabled=true; UI.simPct=0; }
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
  disp.enable();
  status('Heightmap: load an image, then left-drag to paint relief. Alt+drag orbits.','ok');
}
function exitHeight(){
  disp.disable();
  // same downstream invalidation as exitSculpt — geometry changed in place
  S.baseGeo.disposeBoundsTree?.(); S.baseGeo.boundsTree=null;
  if(S.geoPristine){ S.geoPristine.dispose(); S.geoPristine=null; }
  S.appliedPct=0; if(UI){ UI.simResetDisabled=true; UI.simPct=0; }
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
  status(`Face picked (normal ${fmtV(S.pickedNormal)}). Press “Lay flat”.`,'ok');
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
  status('Laid flat & in-plane aligned. Use “Rotate to align” or Z-90° to fine-tune.','ok');
}

/* ----- FLATTEN BOTTOM: slice off everything below a Z height, cap the new floor ----- */
function clearCutPreview(){
  if(S.cutPlaneViz){ scene.remove(S.cutPlaneViz); S.cutPlaneViz.geometry.dispose(); S.cutPlaneViz.material.dispose(); S.cutPlaneViz=null; }
  if(UI) UI.cutPreview=false;
}
function updateCutPreview(){
  if(!UI.cutPreview || !S.baseGeo) return;
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox, s=b.getSize(new THREE.Vector3());
  if(!S.cutPlaneViz){
    const g=new THREE.PlaneGeometry(1,1);
    const m=new THREE.MeshBasicMaterial({color:0xff5d5d,transparent:true,opacity:.3,side:THREE.DoubleSide,depthWrite:false});
    S.cutPlaneViz=new THREE.Mesh(g,m); S.cutPlaneViz.renderOrder=998; scene.add(S.cutPlaneViz);
  }
  S.cutPlaneViz.scale.set(s.x*1.4+10, s.y*1.4+10, 1);
  S.cutPlaneViz.position.set((b.min.x+b.max.x)/2,(b.min.y+b.max.y)/2,UI.cutHeight);
}
function cutFlatBottom(){
  if(!S.baseGeo) return;
  const cutZ=UI.cutHeight;
  if(!(cutZ>0)){ status('Set a cut height above 0 first.','warn'); return; }
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox;
  if(cutZ>=b.max.z){ status('Cut height is at or above the part — nothing would be left.','err'); return; }
  if(!S.geoPreCut) S.geoPreCut=S.baseGeo.clone();
  const size=b.getSize(new THREE.Vector3()), c=b.getCenter(new THREE.Vector3());
  const boxH=(cutZ-b.min.z)+10;                      // reaches well below the part, top face = cutZ
  const boxGeo=new THREE.BoxGeometry(size.x*3+20,size.y*3+20,boxH);
  const brushA=new Brush(S.baseGeo); brushA.updateMatrixWorld();
  const brushB=new Brush(boxGeo);
  brushB.position.set(c.x,c.y,cutZ-boxH/2); brushB.updateMatrixWorld();
  const evaluator=new Evaluator(); evaluator.attributes=['position','normal'];   // our geometries carry no uvs
  const result=evaluator.evaluate(brushA,brushB,SUBTRACTION);
  const g=result.geometry;
  g.computeBoundingBox();
  g.translate(0,0,-g.boundingBox.min.z);             // rebase the new floor to z=0
  swapBaseGeometry(g);
  S.meshDirty=true; clearCutPreview(); UI.cutHeight=0; UI.hasCutUndo=true;
  regen(); frameCamera();
  status(`Cut flat — removed ${cutZ.toFixed(1)} mm from the bottom.`,'ok');
}
function undoCutFlat(){
  if(!S.geoPreCut) return;
  swapBaseGeometry(S.geoPreCut.clone());
  S.geoPreCut.dispose(); S.geoPreCut=null; UI.hasCutUndo=false;
  S.meshDirty=true; regen(); frameCamera();
  status('Cut undone.','ok');
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

function detectSymmetry(){
  if(!S.baseGeo){status('Load a part first.','err');return;}
  ensureBVH();
  status('Searching for mirror symmetry…');
  UI.symOut='Searching…';
  setTimeout(()=>{                                        // defer so the UI paints
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
    if(planes.length){
      const errs=planes.map(p=>(p.score/diag*100).toFixed(1)+'%').join(', ');
      status(`Found ${planes.length} mirror line${planes.length>1?'s':''} (RMS error: ${errs}).`,'ok');
      UI.symOut=`<b>${planes.length}</b> mirror line(s) — error ${errs}.`;
    }else{
      status('No vertical mirror symmetry found. Lay the part flat first, or it may be asymmetric.');
      UI.symOut='No vertical mirror symmetry detected.';
    }
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
 *  STEP 2 — PIN / HOLE ANCHOR FRAMES + the mating transform J
 * ======================================================================== */
let pinGizmo,holeGizmo;
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
function buildGizmos(){
  if(pinGizmo){scene.remove(pinGizmo);pinGizmo.geometry.dispose();}
  if(holeGizmo){scene.remove(holeGizmo);holeGizmo.geometry.dispose();}
  pinGizmo =makeCylinderGizmo(CONST.PIN_COLOR);  pinGizmo.renderOrder=997;
  holeGizmo=makeCylinderGizmo(CONST.HOLE_COLOR); holeGizmo.renderOrder=997;
  scene.add(pinGizmo,holeGizmo);
  buildMatePreview();
  syncGizmos();
}
function syncGizmos(){
  if(pinGizmo) pinGizmo.position.set(UI.pin.x,UI.pin.y,UI.pin.z||0);
  if(holeGizmo)holeGizmo.position.set(UI.hole.x,UI.hole.y,UI.hole.z||0);
  syncMatePreview();
}
/* Bound the anchor sliders to the part's footprint (+30% margin). */
function setAnchorRanges(){
  if(!S.baseGeo) return;
  S.baseGeo.computeBoundingBox();
  const b=S.baseGeo.boundingBox;
  const padX=Math.max(2,(b.max.x-b.min.x)*0.3), padY=Math.max(2,(b.max.y-b.min.y)*0.3), padZ=Math.max(2,(b.max.z-b.min.z)*0.3);
  UI.anchorXmin=+(b.min.x-padX).toFixed(1); UI.anchorXmax=+(b.max.x+padX).toFixed(1);
  UI.anchorYmin=+(b.min.y-padY).toFixed(1); UI.anchorYmax=+(b.max.y+padY).toFixed(1);
  UI.anchorZmin=+(b.min.z-padZ).toFixed(1); UI.anchorZmax=+(b.max.z+padZ).toFixed(1);
}
function anchorsValid(){
  const dist=Math.hypot(UI.pin.x-UI.hole.x,UI.pin.y-UI.hole.y,(UI.pin.z||0)-(UI.hole.z||0));
  if(dist<1e-3){
    UI.anchorWarn='⚠ Pin and hole are at the same spot — links would stack. Separate them.';
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
const DEFAULT_SCALE_CODE = `// n_it     – index of this part (0 … count-1)
// n_it_nor – that index normalized to 0 … 1
// Return either a single number (uniform scale) or {x, y, z} to scale each axis
// independently (1 = original size on that axis; any axis you omit defaults to 1).
const TAU = Math.PI * 2;

let n_freq = 6; 
let nitn = (n_it_nor*n_freq)%1;
let namp = .3;
let noff = 1;
let ny_linear = (-Math.abs(nitn-0.5)+0.5)*namp + noff;


let ny_sine = (Math.sin(nitn*TAU)*.5+0.5)*namp;
let n = ny_linear;
n-= n_it_nor*.2;
return { x: n, y: n, z: n };`

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
    minimap:{enabled:false}, fontSize:12, lineNumbers:'on', tabSize:2,
    scrollBeyondLastLine:false, automaticLayout:true, padding:{top:8,bottom:8},
  });
  scaleEditor.onDidChangeModelContent(()=>applyScaleCode(scaleEditor.getValue()));
}

/* ---- per-part colour ---- */
const DEFAULT_COLOR_CODE =
`// n_it     – index of this part (0 … count-1)
// n_it_nor – that index normalized to 0 … 1
// base     – this part's natural colour as {r, g, b}, each 0 … 1
// Return one of:
//   'invert'  – swap this part's colours (e.g. white<->green on a 2-colour model)
//   a colour  – tint this part: hex (0xff0000), CSS ('#ff0000' / 'tomato'),
//               or {r, g, b} 0…1. The tint MULTIPLIES a coloured model's own
//               colours; on a plain, un-coloured part it sets the colour outright.
//   base      – leave this part untouched

// Swap the colours on every 2nd part:
if (n_it % 2 === 1) return 'invert';
return base;`;

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
    minimap:{enabled:false}, fontSize:12, lineNumbers:'on', tabSize:2,
    scrollBeyondLastLine:false, automaticLayout:true, padding:{top:8,bottom:8},
  });
  colorEditor.onDidChangeModelContent(()=>applyColorCode(colorEditor.getValue()));
}

/* ---- chain centre-line ---- */
const PATH_DOC =
`// Chain centre-line.  t grows continuously along the chain (its scale depends on
// the curve, NOT 1-per-link — don't use it to count links). n_it is the index (0…count-1)
// of the link currently being placed; n_it_nor is that index normalized to 0…1.
// Use n_it / n_it_nor for anything that should step per link.
// z_stack is the height (mm) ALREADY added by the pin/hole z slider's stair-stepping, before
// this link — it's informational, the engine applies it on top of your z automatically. Read
// it if your own z formula needs to react to the current stair height; don't return it as-is
// (z_stack + z_stack would double it) — it's already added even if you just "return z: 0".
// Return the joint {x, y, z} in mm. z is optional (defaults to 0 = flat on the plate). It only
// ever LIFTS each link — rotation is always computed in the x/y plane only, so z (from here, or
// from the pin/hole slider) never tilts a link, just stacks it higher/lower.`;
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
// Straight chain along +X. The link pitch comes from the pin/hole spacing, not from t.
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
    minimap:{enabled:false}, fontSize:12, lineNumbers:'on', tabSize:2,
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
function renderChain(poses){
  if(S.chain){scene.remove(S.chain);S.chain.dispose();}
  const mat=partMaterial(S.baseGeo,{roughness:.7});
  if(hasVColor(S.baseGeo)) installSwapShader(mat);   // enable per-part colour swap on coloured models
  S.chain=new THREE.InstancedMesh(S.baseGeo, mat, poses.length);
  S.chain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let i=0;i<poses.length;i++)
    S.chain.setMatrixAt(i, S.overrides.has(i)?_HIDDEN:poses[i]);   // custom slots drawn separately
  S.chain.instanceMatrix.needsUpdate=true;
  paintChain(poses, null);
  scene.add(S.chain);
  rebuildOverrideMeshes(poses);
  if(S.partMesh)S.partMesh.visible=false;
  if(pinGizmo)pinGizmo.visible=false; if(holeGizmo)holeGizmo.visible=false;
  if(S.symGroup)S.symGroup.visible=false;     // mirror lines belong to the single part
  syncPartEdges(); syncMatePreview();         // hide single-part overlays while the chain shows
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
  const boxes=poses.map((p,i)=>worldAABB(p,linkGeom(i)));
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
  const bad=new Set(), tested=new Set(); let pairs=0;
  const inv=new THREE.Matrix4();
  for(const arr of grid.values()){
    for(let a=0;a<arr.length;a++)for(let bI=a+1;bI<arr.length;bI++){
      let i=arr[a],j=arr[bI]; if(i>j){const t=i;i=j;j=t;}
      const pk=i*n+j; if(tested.has(pk))continue; tested.add(pk);   // dedupe multi-cell pairs
      if(!boxes[i].intersectsBox(boxes[j]))continue;
      pairs++;
      inv.copy(poses[i]).invert().multiply(poses[j]);               // bring link j into link i's frame
      if(linkGeom(i).boundsTree.intersectsGeometry(linkGeom(j),inv)){ bad.add(i); bad.add(j); }
    }
  }
  return {bad,pairs};
}

let regenTimer=null;
function regen(force){
  if(!S.baseGeo||!anchorsValid()) return;
  const poses=buildPoses();
  S.poses=poses;
  const mm=S.chainLength;
  UI.chainLenVal = mm>=1000 ? `${(mm/1000).toFixed(2)} m` : `${mm.toFixed(1)} mm`;
  UI.chainLenSub = `${poses.length} links · ${(mm/poses.length).toFixed(2)} mm avg pin↔hole span`;
  if(S.selectedLink!=null && S.selectedLink>=poses.length){ S.selectedLink=null; updateSwapUI(); }
  renderChain(poses);
  const doCheck = force || poses.length<=CONST.COLLISION_AUTO_MAX;
  let bad=new Set(), pairs=0;
  if(doCheck) ({bad,pairs}=checkCollisions(poses));
  S.collideSet=bad;
  paintChain(poses, bad);            // re-tint, flagging collisions red
  recolorOverrides(bad); showSelection();
  const fp=new THREE.Box3(); poses.forEach((p,i)=>fp.union(worldAABB(p,linkGeom(i))));
  const fs=fp.getSize(new THREE.Vector3());
  const plate=P().plate;
  const off = fs.x>plate||fs.y>plate;
  updatePlate(plate);
  if(!doCheck){UI.chipCollide=`<span class="warn">${poses.length} links — press “Re-check”</span>`;}
  else if(bad.size===0){UI.chipCollide=`<span class="ok">✓ no overlaps</span> · ${pairs} pairs tested`;}
  else{UI.chipCollide=`<span class="err">✗ ${bad.size} links overlap</span>`;}
  UI.chipSize=`footprint <b>${fs.x.toFixed(0)}×${fs.y.toFixed(0)}</b> mm`;
  let msg=`${poses.length} links · footprint ${fs.x.toFixed(0)}×${fs.y.toFixed(0)} mm.`;
  let kind = bad.size? 'err':'ok';
  if(!doCheck){ msg+=' Collision check skipped (large count) — press “Re-check”.'; kind=''; }
  else if(bad.size) msg+=` ${bad.size} links collide (red).`;
  else msg+=' No mesh overlaps.';
  if(off){msg+=` ⚠ Exceeds ${plate} mm plate.`; if(!bad.size)kind='';}
  status(msg,kind);
  UI.s3nextDisabled=false;
  if(UI.simAuto) autoFitReduction(false);   // keep the auto reduction target current with link count
  return {bad,off};
}
let lastPlate=CONST.DEFAULT_PLATE_MM;
function updatePlate(size){
  if(size===lastPlate) return;             // only rebuild when it actually changes
  lastPlate=size;
  scene.remove(grid); grid.geometry.dispose();
  grid=new THREE.GridHelper(size,Math.max(10,Math.round(size/10)),0x33424f,0x222b33);
  grid.rotation.x=Math.PI/2; scene.add(grid);
  scene.remove(plateOutline); plateOutline.geometry.dispose();
  plateOutline=makePlateOutline(size); scene.add(plateOutline);
}

/* ======================================================================== *
 *  STEP 4 — MERGE + EXPORT  /  SAVE-LOAD CONFIG
 * ======================================================================== */
function exportFormat(){ const f=(S.loadFormat||'stl').toLowerCase(); return ['stl','obj','ply','glb','gltf'].includes(f)?f:'stl'; }
function updateExportLabel(){ UI.exportLabel='⬇ Download '+exportFormat().toUpperCase(); }
function writeOBJ(geo){
  const pos=geo.getAttribute('position'), col=geo.getAttribute('color'), nrm=geo.getAttribute('normal'), idx=geo.index;
  const n=pos.count, out=['# articulated chain export'];
  for(let i=0;i<n;i++){
    let l='v '+pos.getX(i).toFixed(5)+' '+pos.getY(i).toFixed(5)+' '+pos.getZ(i).toFixed(5);
    if(col) l+=' '+col.getX(i).toFixed(5)+' '+col.getY(i).toFixed(5)+' '+col.getZ(i).toFixed(5);
    out.push(l);
  }
  if(nrm) for(let i=0;i<n;i++) out.push('vn '+nrm.getX(i).toFixed(5)+' '+nrm.getY(i).toFixed(5)+' '+nrm.getZ(i).toFixed(5));
  const v=a=>nrm?`${a+1}//${a+1}`:`${a+1}`;   // OBJ indices are 1-based
  if(idx) for(let i=0;i<idx.count;i+=3) out.push('f '+v(idx.getX(i))+' '+v(idx.getX(i+1))+' '+v(idx.getX(i+2)));
  else    for(let i=0;i<n;i+=3)         out.push('f '+v(i)+' '+v(i+1)+' '+v(i+2));
  return out.join('\n')+'\n';
}
async function encodeChain(mesh, geo, fmt){
  const base=S.meshName||'articulated_spiral';
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
  if(UI.simAuto) await autoFitReduction(true);   // make sure the file meets the size cap
  const fmt=exportFormat();
  const keepColor = fmt!=='stl' && hasVColor(S.baseGeo);   // STL has no color; every other format keeps it
  const geos=[];
  for(let i=0;i<S.poses.length;i++){
    const g=linkGeom(i).clone();     // base part, or this slot's custom model
    g.applyMatrix4(S.poses[i]);      // bake world matrix → separate solid
    for(const a of Object.keys(g.attributes)) if(a!=='position'&&a!=='normal'&&!(keepColor&&a==='color')) g.deleteAttribute(a);
    if(keepColor && !g.getAttribute('color'))   // an uncolored override → white-fill so the merge's attrs match
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(1),3));
    if(keepColor && S.colorFn){                  // bake the per-part colour callback into the exported colours
      const ca=g.getAttribute('color'), nor=S.poses.length>1?i/(S.poses.length-1):0;
      let rv; try{ rv=S.colorFn(i,nor,{r:1,g:1,b:1}); }catch(e){ rv=undefined; }
      if(isInvert(rv)){                          // palette swap → reflect through SWAP_SUM (same as the viewport shader)
        for(let v=0;v<ca.count;v++) ca.setXYZ(v, SWAP_SUM.x-ca.getX(v), SWAP_SUM.y-ca.getY(v), SWAP_SUM.z-ca.getZ(v));
      } else {                                   // a colour → multiply tint
        const tint=new THREE.Color(); applyColorValue(tint.copy(WHITE), rv);
        for(let v=0;v<ca.count;v++) ca.setXYZ(v, ca.getX(v)*tint.r, ca.getY(v)*tint.g, ca.getZ(v)*tint.b);
      }
    }
    if(!g.attributes.normal) g.computeVertexNormals();   // keep every solid's attribute set identical for the merge
    geos.push(g);
  }
  const merged=BufferGeometryUtils.mergeGeometries(geos,false);
  geos.forEach(g=>g.dispose());
  const mesh=new THREE.Mesh(merged, keepColor?partMaterial(merged):undefined);
  const tris=merged.index?merged.index.count/3:merged.attributes.position.count/3;
  const {blob,name}=await encodeChain(mesh, merged, fmt);
  merged.dispose();
  download(blob,name);
  UI.exportOut=`✓ Exported <b>${S.poses.length}</b> links · ${tris.toLocaleString()} triangles · ${fmtBytes(blob.size)}.`;
  status(name.toUpperCase().split('.').pop()+' downloaded: '+name,'ok');
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
async function ensureMeshUploaded(){
  if(!S.baseGeo) return null;
  if(S.meshId && !S.meshDirty) return S.meshId;
  const glb=await exportGLB(new THREE.Mesh(S.baseGeo, partMaterial(S.baseGeo)));   // ArrayBuffer (vertexColors mat → COLOR_0 written)
  const res=await fetch('/api/meshes',{method:'POST',
    headers:{'content-type':'model/gltf-binary','x-filename':(S.meshName||'part')+'.glb'},
    body:glb});
  if(!res.ok) throw new Error(await res.text());
  const j=await res.json();
  S.meshId=j.id; S.meshDirty=false;
  return S.meshId;
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
    const glb=await exportGLB(new THREE.Mesh(o.geo, partMaterial(o.geo)));
    const res=await fetch('/api/meshes',{method:'POST',
      headers:{'content-type':'model/gltf-binary','x-filename':'link-'+i+'.glb'}, body:glb});
    if(!res.ok) throw new Error(await res.text());
    o.meshId=(await res.json()).id;
  }
}
function geoFromArrays(pos,nrm,idx){
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  if(Array.isArray(idx)) g.setIndex(idx);
  if(Array.isArray(nrm)) g.setAttribute('normal',new THREE.Float32BufferAttribute(nrm,3)); else g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function gatherConfig(opts={}){
  const cfg={
    version:4, pin:{x:UI.pin.x,y:UI.pin.y,z:UI.pin.z||0}, hole:{x:UI.hole.x,y:UI.hole.y,z:UI.hole.z||0}, partZ:UI.partZ,
    params:P(),
    scaleCode:S.scaleCode,
    colorCode:S.colorCode,
    pathCode:S.pathCode,
    symPlanes:S.symPlanes.map(pl=>({p:[pl.p.x,pl.p.y,pl.p.z],n:[pl.n.x,pl.n.y,pl.n.z]})),
    meshId:S.meshId,                          // aligned mesh stored in data/meshes/ on the server
  };
  if(opts.inlineGeometry && S.baseGeo){
    cfg.geometry=Array.from(S.baseGeo.attributes.position.array);
    const nrm=S.baseGeo.getAttribute('normal'); if(nrm) cfg.normals=Array.from(nrm.array);
    if(S.baseGeo.index) cfg.indices=Array.from(S.baseGeo.index.array);
  }
  if(S.overrides.size){
    cfg.overrides=[...S.overrides].map(([i,o])=>{
      const e={index:i, name:o.name||('link '+i)};
      if(o.meshId) e.meshId=o.meshId;
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
    if(cfg.meshId){
      await loadMeshFromServer(cfg.meshId);     // also clears symmetry
      S.meshId=cfg.meshId;
    }else if(cfg.geometry){                     // geometry embedded in the JSON
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(cfg.geometry,3));
      if(Array.isArray(cfg.indices)) g.setIndex(cfg.indices);
      const faithful=Array.isArray(cfg.normals);
      if(faithful) g.setAttribute('normal',new THREE.Float32BufferAttribute(cfg.normals,3));
      else g.computeVertexNormals();
      setBaseGeometry(g,{faithful});
      S.meshId=null;
    }
    S.meshDirty=false;                          // whatever we just loaded is the current saved mesh
    if(cfg.pin) Object.assign(UI.pin,cfg.pin);
    if(cfg.hole) Object.assign(UI.hole,cfg.hole);
    S.partZ=cfg.partZ||0; UI.partZ=S.partZ;
    const p=cfg.params||{};
    if(p.shape!=null)UI.shape=p.shape;
    if(p.count!=null)UI.count=p.count; if(p.startR!=null)UI.startR=p.startR;
    if(p.spacing!=null)UI.spacing=p.spacing; if(p.plate!=null)UI.plate=p.plate;
    if(Array.isArray(cfg.symPlanes)){
      S.symPlanes=cfg.symPlanes.map(pl=>({p:new THREE.Vector3(...pl.p),n:new THREE.Vector3(...pl.n),score:0}));
      buildSymLines();
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
          if(g) S.overrides.set(e.index,{geo:g,name:e.name||('link '+e.index),meshId:e.meshId||null});
        }catch(err){ status('A swapped link failed to load: '+err.message,'err'); }
      }
      updateSwapUI();
    }
    markDone('s1'); unlock('s2'); unlock('s3'); buildGizmos();
    setAnchorRanges();
    ensureScaleEditor(); ensureColorEditor(); ensurePathEditor(); openStep('s3'); regen();
    UI.dropHide=true;
  } finally { UI._loading=false; }
}
async function saveCfg(){
  let cfg;
  if(hasServer){
    try{ await ensureMeshUploaded(); await ensureOverridesUploaded(); }
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

function projStatus(msg,kind=''){ if(UI){ UI.projMsg=msg; UI.projMsgErr=(kind==='err'); } }

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
    await ensureMeshUploaded(); await ensureOverridesUploaded();
    const p=await apiCreate(name,gatherConfig());
    UI.projectId=p.id; UI.projectName='';
    projStatus(`Saved “${p.name}”.`); refreshProjects();
  }catch(e){ projStatus('Save failed: '+e.message,'err'); }
}
async function updateCurrentProject(){
  if(!hasServer)return projStatus('Server not running.','err');
  if(!UI.projectId)return projStatus('No project loaded — use “Save as new”.','err');
  try{
    await ensureMeshUploaded(); await ensureOverridesUploaded();
    const name=(UI.projectName||'').trim();
    const p=await apiUpdate(UI.projectId,{name:name||undefined,config:gatherConfig()});
    projStatus(`Updated “${p.name}”.`); refreshProjects();
  }catch(e){ projStatus('Update failed: '+e.message,'err'); }
}
async function loadProject(id){
  try{
    const p=await apiGet(id);
    await applyConfig(p.config||{});
    UI.projectId=p.id; UI.projectName=p.name;
    projStatus(`Loaded “${p.name}”.`); refreshProjects();
  }catch(e){ projStatus('Load failed: '+e.message,'err'); }
}
async function deleteProject(id){
  if(!confirm('Delete this project?'))return;
  try{
    await apiDelete(id);
    if(UI.projectId===id)UI.projectId=null;
    projStatus('Deleted.'); refreshProjects();
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
  parseMeshFile(buf,name).then(g=>setBaseGeometry(g)).catch(e=>status('Load error: '+e.message,'err'));
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
view().addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)loadFile(f);});
function view(){return document.getElementById('view');}
function maybeHide(){ if(UI&&S.baseGeo) UI.dropHide=true; }

/* ======================================================================== *
 *  RENDER MODES — X-RAY · SECTION/LAYER VIEW · MATING PREVIEW · SIMPLIFY
 * ======================================================================== */
function overrideMaterials(){ return S.overrideGroup ? S.overrideGroup.children.map(c=>c.material) : []; }
function clipMaterials(){
  const o=[];
  if(S.partMesh)    o.push(S.partMesh.material);
  if(S.chain)       o.push(S.chain.material);
  if(S.matePreview) o.push(S.matePreview.material);
  return o.concat(overrideMaterials());
}
function xrayMaterials(){
  const o=[];
  if(S.partMesh) o.push(S.partMesh.material);
  if(S.chain)    o.push(S.chain.material);
  return o.concat(overrideMaterials());
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
    const partMode = S.uiStep==='s1'||S.uiStep==='s2'||S.uiStep==='proj';
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
  const full=S.geoPristine?S.geoPristine.attributes.position.count:null;
  UI.dbgOut = full!=null && full!==v
    ? `now <b>${v.toLocaleString()}</b> verts · ${t.toLocaleString()} tris  (was ${full.toLocaleString()} verts — ${(100*(1-v/full)).toFixed(0)}% off)`
    : `<b>${v.toLocaleString()}</b> verts · ${t.toLocaleString()} tris`;
}
function applyXray(){
  const on=UI.xray;
  for(const m of xrayMaterials()){ m.transparent=on; m.opacity=on?CONST.XRAY_OPACITY:1; m.depthWrite=!on; m.needsUpdate=true; }
  syncPartEdges();
}

const _clipPlanes=[ new THREE.Plane(new THREE.Vector3(0,0,-1),0) ];   // keeps z ≤ constant
function contentZRange(){
  if(S.baseGeo){ S.baseGeo.computeBoundingBox(); const b=S.baseGeo.boundingBox; return {min:b.min.z,max:b.max.z}; }
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
  return new THREE.Matrix4().makeTranslation(UI.pin.x-UI.hole.x, UI.pin.y-UI.hole.y, (UI.pin.z||0)-(UI.hole.z||0));
}
function buildMatePreview(){
  if(!S.baseGeo) return;
  if(S.matePreview){ scene.remove(S.matePreview); S.matePreview.material.dispose(); S.matePreview=null; }
  const mat=new THREE.MeshStandardMaterial({color:CONST.MATE_COLOR,metalness:.1,roughness:.75,
    transparent:true,opacity:CONST.MATE_OPACITY,side:THREE.DoubleSide,depthWrite:false});
  S.matePreview=new THREE.Mesh(S.baseGeo,mat);
  S.matePreview.matrixAutoUpdate=false; S.matePreview.renderOrder=1;
  scene.add(S.matePreview);
  applySection();                         // adopt the clip plane if section view is on
  syncMatePreview();
}
function syncMatePreview(){
  if(!S.matePreview) return;
  const show=UI.matePreviewOn && S.uiStep==='s2' && !!S.partMesh && S.partMesh.visible && anchorsValid();
  S.matePreview.visible=show;
  if(!show){ UI.mateOut=''; return; }
  const M=relMate();
  S.matePreview.matrix.copy(M); S.matePreview.updateMatrixWorld(true);
  ensureBVH();
  const hit=S.baseGeo.boundsTree.intersectsGeometry(S.baseGeo,M);
  S.matePreview.material.color.set(hit?0xff6b6b:CONST.MATE_COLOR);
  UI.mateOut = hit
    ? '<span style="color:var(--bad)">✗ neighbour meshes overlap — links would fuse. Move pin/hole apart or pick a cleaner mating spot.</span>'
    : '<span style="color:var(--accent2)">✓ neighbour clears — the two meshes don\'t touch at this mating.</span>';
}

/* ---- SIMPLIFY ---- */
function triCount(g){ return g ? (g.index ? g.index.count/3 : g.attributes.position.count/3) : 0; }
function estStlBytes(tris){ return 84 + tris*CONST.STL_BYTES_PER_TRI; }
function fmtBytes(b){ return b>=1048576 ? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB'; }
function chainTriBudget(){
  const links=Math.max(1,UI.count||1);
  let ovTris=0, ovCount=0;
  for(const [i,o] of S.overrides){ if(i<links){ ovTris+=triCount(o.geo); ovCount++; } }
  return {links, baseLinks:Math.max(0,links-ovCount), baseFull:triCount(S.geoPristine||S.baseGeo), ovTris, ovCount};
}
function actualChainTris(){
  if(S.poses.length){ let t=0; for(let i=0;i<S.poses.length;i++) t+=triCount(linkGeom(i)); return t; }
  const b=chainTriBudget(); return b.baseFull*b.baseLinks+b.ovTris;
}
function baseVertCount(){ const g=S.geoPristine||S.baseGeo; return g?g.attributes.position.count:0; }
function updateSimEstimate(){
  if(!S.baseGeo){ UI.simEst=''; return; }
  const {links,baseLinks,baseFull,ovTris,ovCount}=chainTriBudget();
  const pct=UI.simPct/100;
  const fullV=baseVertCount(), tgtV=Math.max(4,Math.round(fullV*(1-pct)));
  const tgtTotal=Math.round(baseFull*(1-pct)*baseLinks+ovTris);
  const fullTotal=Math.round(baseFull*baseLinks+ovTris);
  const note = ovCount?`, ${ovCount} custom`:'';
  UI.simEst = pct>0
    ? `${fullV.toLocaleString()} → <b>${tgtV.toLocaleString()}</b> verts/link · whole chain ≈ <b>${fmtBytes(estStlBytes(tgtTotal))}</b> (${links} links${note})`
    : `${fullV.toLocaleString()} verts/link · whole chain ≈ ${fmtBytes(estStlBytes(fullTotal))} (${links} links${note})`;
}
function swapBaseGeometry(geo){
  geo = weldByPosition(geo);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  const old=S.baseGeo;
  S.baseGeo=geo;
  if(S.partMesh)    S.partMesh.geometry=geo;
  if(S.matePreview) S.matePreview.geometry=geo;
  if(old){ old.disposeBoundsTree?.(); old.dispose(); }     // chain is rebuilt by regen() right after
  updatePartEdges(); updateDebugViz(); updateMeshChips();
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
async function applyVertexTarget(target){
  if(!S.baseGeo) return;
  if(!S.geoPristine) S.geoPristine=S.baseGeo.clone();      // keep a full-detail master
  target=Math.max(8,Math.round(target));
  UI.simApplyDisabled=true; status('Simplifying…');
  await new Promise(r=>setTimeout(r,10));                   // let the panel repaint
  let g;
  try{ g=await decimateToVertexTarget(S.geoPristine,target); }
  catch(e){ status('Simplify failed: '+e.message,'err'); UI.simApplyDisabled=false; return; }
  swapBaseGeometry(g);
  const full=S.geoPristine.attributes.position.count, now=S.baseGeo.attributes.position.count;
  S.appliedPct=Math.round(100*(1-now/full));
  S.meshDirty=true; UI.simResetDisabled=false; UI.simApplyDisabled=false;
  regen(); updateSimEstimate();
  status(`Simplified ${full.toLocaleString()} → ${now.toLocaleString()} verts/link.`,'ok');
}
async function applySimplify(){               // manual: reduce by the % slider
  const pct=UI.simPct/100;
  if(pct<=0){ status('Set a reduction above 0% first.','warn'); return; }
  const full=(S.geoPristine||S.baseGeo).attributes.position.count;
  await applyVertexTarget(full*(1-pct));
}
function restoreDetail(){
  if(!S.geoPristine) return;
  swapBaseGeometry(S.geoPristine.clone());
  S.appliedPct=0; S.meshDirty=true; UI.simResetDisabled=true;
  regen(); updateSimEstimate(); status('Full detail restored.','ok');
}
async function autoFitReduction(apply){
  if(!S.baseGeo) return;
  const cap=Math.max(50,(UI.simMaxVerts||CONST.MAX_VERTS_PER_LINK));
  const full=baseVertCount();
  UI.simPct = full>cap ? Math.min(99,Math.round(100*(1-cap/full))) : 0;
  updateSimEstimate();
  if(!apply) return;
  if(full<=cap){ if(S.appliedPct>0) restoreDetail(); return; }
  if(S.baseGeo.attributes.position.count<=cap && S.appliedPct>0) return;   // already at/under cap
  await applyVertexTarget(cap);
}
function syncSimMode(){
  if(UI.simAuto) autoFitReduction(false);     // refresh the shown target (auto-applies when you confirm orientation)
  else updateSimEstimate();
}

/* ======================================================================== *
 *  PER-LINK MODEL OVERRIDES
 * ======================================================================== */
function linkGeom(i){
  const o=S.overrides.get(i);
  const g=o?o.geo:S.baseGeo;
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
function rebuildOverrideMeshes(poses){
  if(S.overrideGroup){ scene.remove(S.overrideGroup); S.overrideGroup.traverse(o=>o.material&&o.material.dispose()); }
  S.overrideGroup=new THREE.Group(); scene.add(S.overrideGroup);
  for(const [i,o] of S.overrides){
    if(i>=poses.length) continue;
    const m=new THREE.Mesh(o.geo,new THREE.MeshStandardMaterial({color:CONST.OVERRIDE_COLOR,metalness:.1,roughness:.7}));
    m.matrixAutoUpdate=false; m.matrix.copy(poses[i]); m.updateMatrixWorld(true);
    m.userData.linkIndex=i; S.overrideGroup.add(m);
  }
}
function recolorOverrides(bad){
  if(!S.overrideGroup) return;
  for(const m of S.overrideGroup.children)
    m.material.color.copy(bad&&bad.has(m.userData.linkIndex)?CONST.LINK_BAD_COLOR:CONST.OVERRIDE_COLOR);
}
function clearOverride(i){ const o=S.overrides.get(i); if(o){ o.geo.disposeBoundsTree?.(); o.geo.dispose(); } S.overrides.delete(i); }

function showSelection(){
  if(S.selBox){ scene.remove(S.selBox); S.selBox=null; }
  if(S.selectedLink==null || !S.poses[S.selectedLink]) return;
  S.selBox=new THREE.Box3Helper(worldAABB(S.poses[S.selectedLink],linkGeom(S.selectedLink)),CONST.SELECT_COLOR);
  scene.add(S.selBox);
}
function selectLinkAt(ev){
  if(!S.chain){ status('Build the chain first.','warn'); return; }
  pointerNDC(ev);
  const hits=[];
  const ch=raycaster.intersectObject(S.chain,false)[0];
  if(ch&&ch.instanceId!=null) hits.push({d:ch.distance,i:ch.instanceId});
  if(S.overrideGroup) for(const h of raycaster.intersectObjects(S.overrideGroup.children,false)) hits.push({d:h.distance,i:h.object.userData.linkIndex});
  if(!hits.length){ status('No link under the cursor — click directly on a link.','warn'); return; }
  hits.sort((a,b)=>a.d-b.d);
  S.selectedLink=hits[0].i; showSelection(); updateSwapUI();
  status('Selected link #'+S.selectedLink+'.');
}
function updateSwapUI(){
  const has=S.selectedLink!=null;
  UI.swapSel = has
    ? `Link #${S.selectedLink} selected — ${S.overrides.has(S.selectedLink)?'custom: '+S.overrides.get(S.selectedLink).name:'base part'}`
    : 'No link selected — click “Select link in viewport”, then a link.';
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
    S.overrides.set(idx,{geo:fitReplacement(g),name:file.name,meshId:null});   // meshId filled in on save
    regen(); showSelection(); updateSwapUI(); updateSimEstimate();
    status(`Link #${idx} → “${file.name}”.`,'ok');
  }).catch(e=>status('Replace failed: '+e.message,'err'));
  r.readAsArrayBuffer(file);
}

/* ======================================================================== *
 *  WIZARD GATING + low-level helpers used by the Alpine component
 * ======================================================================== */
function openStep(id){ if(UI){ UI.openId=id; UI.activeId=id; } showStepView(id); }
function unlock(id){ if(UI)UI.steps[id].locked=false; }
function markDone(id){ if(UI)UI.steps[id].done=true; }

function showStepView(id){
  const wasSculpt = S.uiStep==='sculpt';
  const wasHeight = S.uiStep==='height';
  S.uiStep=id;
  const partMode = id==='s1'||id==='s2'||id==='proj'||id==='sculpt'||id==='height';
  if(wasSculpt && id!=='sculpt') exitSculpt();
  if(wasHeight && id!=='height') exitHeight();
  if(id==='sculpt' && !sculpt.active && S.baseGeo) enterSculpt();
  if(id==='height' && !disp.active && S.baseGeo) enterHeight();
  if(S.partMesh) S.partMesh.visible = partMode && !!S.baseGeo;
  if(pinGizmo)  pinGizmo.visible  = id==='s2';
  if(holeGizmo) holeGizmo.visible = id==='s2';
  if(S.symGroup) S.symGroup.visible = partMode && S.symVisible;
  if(S.chain) S.chain.visible = !partMode;
  if(S.overrideGroup) S.overrideGroup.visible = !partMode;
  if(S.selBox) S.selBox.visible = !partMode;
  if(S.dbgPoints) S.dbgPoints.visible = partMode;
  if(S.dbgWire) S.dbgWire.visible = partMode;
  syncPartEdges();
  syncMatePreview();         // restores the ghost neighbour when returning to step 2
}

/* ---- arm helper for click-modes (the pills are driven by UI.arm) ---- */
function setArm(mode){ if(!UI)return; UI.arm = (UI.arm===mode)?null:mode; }

function debounceRegen(){clearTimeout(regenTimer);regenTimer=setTimeout(regen,80);}

/* free part rotation about Z — bake the DELTA so geometry stays the single source
   of truth, and carry the anchor points along so the cylinders track the part. */
function rotatePartZ(deg){
  if(!S.baseGeo)return;
  const delta=THREE.MathUtils.degToRad(deg-S.partZ); S.partZ=deg;
  if(Math.abs(delta)<1e-12) return;
  bakeMatrix(new THREE.Matrix4().makeRotationZ(delta));   // also rotates sym lines
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
  if(UI.arm==='pickFace'){ if(hit)pickFace(hit); setArm(null); return; }
  // anchor modes need a surface point projected to XY (z=0)
  let pt;
  if(hit) pt=hit.point;
  else { // fall back to intersection with the Z=0 plane
    const plane=new THREE.Plane(new THREE.Vector3(0,0,1),0); pt=new THREE.Vector3();
    if(!raycaster.ray.intersectPlane(plane,pt))return;
  }
  if(UI.arm==='placePin'){ UI.pin.x=+pt.x.toFixed(2);UI.pin.y=+pt.y.toFixed(2); }
  if(UI.arm==='placeHole'){ UI.hole.x=+pt.x.toFixed(2);UI.hole.y=+pt.y.toFixed(2); }
  syncGizmos();
  UI.s2nextDisabled=!anchorsValid();
  setArm(null);
});

/* ---- drag the pin / hole cylinders directly on the plate (step 2) ---- */
let dragAnchor=null;
const _platePlane=new THREE.Plane(new THREE.Vector3(0,0,1),0), _plateHit=new THREE.Vector3();
function gizmoUnder(ev){
  if(!pinGizmo||!pinGizmo.visible) return null;
  pointerNDC(ev);
  return raycaster.intersectObjects([pinGizmo,holeGizmo],false)[0]||null;
}
function plateUnder(ev){
  pointerNDC(ev);
  if(!raycaster.ray.intersectPlane(_platePlane,_plateHit)) return null;
  const {radius}=contentBounds();          // ignore wild hits when the plate is edge-on
  if(Math.hypot(_plateHit.x,_plateHit.y) > radius*8) return null;
  return _plateHit;
}
wrap.addEventListener('pointerdown',ev=>{
  if(!UI||UI.arm||ev.button!==0) return;
  const hit=gizmoUnder(ev); if(!hit) return;
  dragAnchor = hit.object===pinGizmo?'pin':'hole';
  controls.enabled=false;
  renderer.domElement.style.cursor='grabbing';
  ev.stopPropagation(); ev.preventDefault();
},true);
window.addEventListener('pointermove',ev=>{
  if(!dragAnchor){
    if(UI&&!UI.arm){ const h=gizmoUnder(ev); if(pinGizmo&&pinGizmo.visible) renderer.domElement.style.cursor=h?'grab':''; }
    return;
  }
  const pt=plateUnder(ev); if(!pt) return;
  const a = dragAnchor==='pin'?UI.pin:UI.hole;
  a.x=+pt.x.toFixed(2); a.y=+pt.y.toFixed(2);
  syncGizmos();
  UI.s2nextDisabled=!anchorsValid();
});
window.addEventListener('pointerup',()=>{
  if(!dragAnchor) return;
  dragAnchor=null; controls.enabled=true; renderer.domElement.style.cursor='';
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
    const w=Math.min(Math.max(ev.clientX,280),Math.min(window.innerWidth-280,1100));
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

/* ---- small format helpers ---- */
function fmtV(v){return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;}

/* ======================================================================== *
 *  ALPINE COMPONENT — all reactive UI state + the template entry points
 * ======================================================================== */
function chainApp(){
  return {
    /* ----- status / wizard ----- */
    statusMsg:'Drop a part or use “Choose file…”.', statusKind:'',
    openId:'s1', activeId:'s1',
    steps:{ proj:{done:false,locked:false}, s1:{done:false,locked:false},
            sculpt:{done:false,locked:true}, height:{done:false,locked:true},
            s2:{done:false,locked:true}, s3:{done:false,locked:true}, s4:{done:false,locked:true} },
    arm:null,
    _loading:false,
    /* ----- drop overlay ----- */
    dropHide:false, dropHot:false,
    /* ----- HUD chips ----- */
    chipMesh:'No mesh loaded', chipSize:'', chipCollide:'',
    /* ----- step 1 ----- */
    unitScale:1, colorShades:2, purify:false, partZ:0,
    symOut:'',
    simAuto:true, simMaxVerts:2000, simPct:0,
    simEst:'', dbgOut:'Load a part to see its vertex / triangle count.',
    simResetDisabled:true, simApplyDisabled:false,
    showVerts:false, showWire:false,
    cutHeight:0, cutPreview:false, hasCutUndo:false,
    s1nextDisabled:true,
    /* ----- sculpt (optional step) ----- */
    sculptTool:'draw', sculptRadius:8, sculptStrength:0.5,
    sculptMirror:true, sculptManual:false, sculptAxis:'x', sculptOffset:0,
    /* ----- heightmap (optional step) ----- */
    hmStrength:4, hmDir:'normal', hmMode:'planar', hmAxis:'z',
    hmRadius:8, hmFlow:0.6, hmErase:false,
    hmBlack:0, hmWhite:1, hmBright:0, hmContrast:1, hmShadows:0, hmHi:0, hmInvert:false,
    hmLoaded:false,
    /* ----- step 2 ----- */
    pin:{x:0,y:0,z:0}, hole:{x:0,y:0,z:0},
    anchorXmin:-100, anchorXmax:100, anchorYmin:-100, anchorYmax:100, anchorZmin:-20, anchorZmax:20,
    mateOut:'', matePreviewOn:true, anchorWarn:'', s2nextDisabled:true,
    /* ----- step 3 ----- */
    chainLenVal:'—', chainLenSub:'',
    shape:'straight', count:14, startR:25, spacing:16, plate:220,
    scaleErr:'', scaleErrColor:'', colorErr:'', colorErrColor:'', pathErr:'', pathErrColor:'', solveOut:'',
    s3nextDisabled:true,
    /* ----- step 4 ----- */
    swapSel:'No link selected — click “Select link in viewport”, then a link.',
    swapFileBtnDisabled:true, swapClearDisabled:true, swapClearAllDisabled:true,
    exportOut:'', exportLabel:'⬇ Download STL',
    /* ----- render toggles ----- */
    xray:false, section:false, sectionZ:100, sectionZval:'',
    /* ----- projects ----- */
    projectName:'', projMsg:'', projMsgErr:false, projects:[], projectId:null, hasServer:true,

    /* ---- lifecycle ---- */
    init(){
      UI = this;
      this.hasServer = hasServer;
      // seed the editor default functions from the current slider values
      S.scaleCode=DEFAULT_SCALE_CODE; S.scaleFn=compileScaleFn(DEFAULT_SCALE_CODE).fn;
      S.colorCode=DEFAULT_COLOR_CODE; S.colorFn=compileColorFn(DEFAULT_COLOR_CODE).fn;
      S.pathCode=pathCodeFor(this.shape, this.startR, this.spacing/(2*Math.PI)); S.pathFn=compilePathFn(S.pathCode).fn;

      // reactive → engine bridges
      this.$watch('colorShades', ()=>applyColorShades());
      this.$watch('purify', ()=>applyColorShades());
      this.$watch('pin.x', ()=>onAnchorChange());
      this.$watch('pin.y', ()=>onAnchorChange());
      this.$watch('pin.z', ()=>onAnchorChange());
      this.$watch('hole.x', ()=>onAnchorChange());
      this.$watch('hole.y', ()=>onAnchorChange());
      this.$watch('hole.z', ()=>onAnchorChange());
      this.$watch('partZ', v=>{ if(!this._loading) rotatePartZ(v); });
      this.$watch('count', ()=>{ if(!this._loading) debounceRegen(); });
      this.$watch('shape', ()=>{ if(!this._loading) regeneratePathFromSliders(); });
      this.$watch('startR', ()=>{ if(!this._loading) regeneratePathFromSliders(); });
      this.$watch('spacing', ()=>{ if(!this._loading) regeneratePathFromSliders(); });
      this.$watch('plate', ()=>{ if(!this._loading) debounceRegen(); });
      this.$watch('simAuto', ()=>syncSimMode());
      this.$watch('simMaxVerts', ()=>{ if(this.simAuto)autoFitReduction(false); else updateSimEstimate(); });
      this.$watch('simPct', ()=>updateSimEstimate());
      this.$watch('sectionZ', ()=>updateSectionPlane());
      this.$watch('cutHeight', ()=>updateCutPreview());
      this.$watch('sculptTool',     v=>sculpt.brush.type=v);
      this.$watch('sculptRadius',   v=>sculpt.brush.radius=v);
      this.$watch('sculptStrength', v=>sculpt.brush.strength=v);
      this.$watch('sculptMirror',   ()=>applySculptMirror());
      this.$watch('sculptManual',   ()=>applySculptMirror());
      this.$watch('sculptAxis',     ()=>applySculptMirror());
      this.$watch('sculptOffset',   ()=>applySculptMirror());

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

      syncSimMode();          // controls start in the (default) automatic mode
      refreshProjects();
      status('Drop a part or use “Choose file…”.');
    },

    /* ---- wizard navigation ---- */
    toggleStep(id){
      if(this.steps[id].locked) return;
      if(this.openId===id){ this.openId=''; return; }   // collapse
      this.openId=id; this.activeId=id;
      showStepView(id);
      const toChain=(id==='s3'||id==='s4');
      if(toChain){ if(S.baseGeo && anchorsValid()) regen(); }
      else if(S.baseGeo){ frameCamera(); }
    },
    async s1Next(){
      if(!S.baseGeo)return;
      if(this.simAuto) await autoFitReduction(true);   // reduce the part BEFORE any chain work
      const b=S.baseGeo.boundingBox;
      if(this.pin.x===0&&this.pin.y===0&&this.hole.x===0&&this.hole.y===0){
        this.pin={x:b.max.x*0.7,y:0}; this.hole={x:b.min.x*0.7,y:0};   // seed near the two ends
      }
      markDone('s1'); unlock('sculpt'); unlock('height'); unlock('s2'); openStep('s2');
      buildGizmos(); setAnchorRanges();
      if(S.partMesh)S.partMesh.visible=true;
      if(S.symGroup)S.symGroup.visible=S.symVisible;     // keep mirror lines visible as anchor guides
      status('Place the pin and hole anchors on the part.');
    },
    async s2Next(){
      if(!anchorsValid())return;
      if(this.simAuto) await autoFitReduction(true);   // safety: ensure reduced before the first build
      markDone('s2'); unlock('s3'); openStep('s3');
      ensureScaleEditor(); ensureColorEditor(); ensurePathEditor(); regen();
    },
    s3Next(){
      markDone('s3'); unlock('s4'); openStep('s4');
      if(this.simAuto) autoFitReduction(true); else updateSimEstimate();
      updateSwapUI(); status('Ready to export — or swap individual links.','ok');
    },

    /* ---- step 1 actions ---- */
    chooseFile(){ $('fileInput').click(); },
    onFileInput(e){ if(e.target.files[0])loadFile(e.target.files[0]); },
    autoAlign, nudge, setArm, layFlat, detectSymmetry,
    alignZ(){ alignInPlane(); S.partZ=0; this.partZ=0; frameCamera(); status('Auto-rotated: longest axis on X.','ok'); },
    toggleSym(){ S.symVisible=!S.symVisible; if(S.symGroup)S.symGroup.visible=S.symVisible; },
    toggleVerts(){ this.showVerts=!this.showVerts; updateDebugViz(); },
    toggleWire(){ this.showWire=!this.showWire; updateDebugViz(); },
    applySimplify, restoreDetail,
    cutFlatBottom, undoCutFlat,
    toggleCutPreview(){ this.cutPreview=!this.cutPreview; if(this.cutPreview)updateCutPreview(); else clearCutPreview(); },

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
      status('Heightmap loaded — left-drag on the part to paint relief.','ok');
    },
    hmClearMask(){ disp.clearMask(); },
    hmSmooth(){ disp.smoothMask(0.6, 2); },

    /* ---- step 2 actions ---- */
    toggleMate(){ this.matePreviewOn=!this.matePreviewOn; syncMatePreview(); },

    /* ---- step 3 actions ---- */
    recheck(){ regen(true); },
    pathReset(){ regeneratePathFromSliders(); },
    scaleReset(){ if(scaleEditor)scaleEditor.setValue(DEFAULT_SCALE_CODE); else applyScaleCode(DEFAULT_SCALE_CODE); },
    colorReset(){ if(colorEditor)colorEditor.setValue(DEFAULT_COLOR_CODE); else applyColorCode(DEFAULT_COLOR_CODE); },

    /* ---- render-mode + camera ---- */
    toggleXray(){ this.xray=!this.xray; applyXray(); },
    toggleSection(){ this.section=!this.section; applySection(); },
    setView,

    /* ---- step 4 actions ---- */
    chooseSwapFile(){ $('swapFileInput').click(); },
    onSwapFileInput(e){ if(e.target.files[0]){ replaceSelectedLink(e.target.files[0]); e.target.value=''; } },
    swapClear(){ if(S.selectedLink!=null&&S.overrides.has(S.selectedLink)){ clearOverride(S.selectedLink); regen(); showSelection(); updateSwapUI(); updateSimEstimate(); status('Link reverted to the base part.'); } },
    swapClearAll(){ for(const i of [...S.overrides.keys()]) clearOverride(i); regen(); showSelection(); updateSwapUI(); updateSimEstimate(); status('All links reverted to the base part.'); },
    exportChain, saveCfg,
    chooseCfg(){ $('cfgInput').click(); },
    onCfgInput(e){ if(e.target.files[0])loadCfg(e.target.files[0]); },

    /* ---- projects ---- */
    refreshProjects, saveNewProject, updateCurrentProject, loadProject, deleteProject,
  };
}
