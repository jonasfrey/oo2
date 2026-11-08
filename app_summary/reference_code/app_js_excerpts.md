# app.js excerpts (read-only reference)

Key engine routines copied verbatim from `app.js` (2,913 lines) so they can be read without the surrounding UI code. Line numbers refer to the original file at commit 20485e6.

## Tunable constants

```js
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
```

## Bake a matrix into geometry (keeps mesh transform = identity)

```js
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

```

## Auto-align via PCA + Jacobi eigen solver

```js
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

```

## Flatten bottom: CSG cut with three-bvh-csg

```js
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

```

## Mirror-symmetry detection (plane search by reflected closest-point RMS)

```js
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

```

## Half-part detection + mirrored geometry build

```js
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

```

## Chain pose solver (walk a parametric path by chord length)

```js
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

```

## BVH collision check (broadphase grid + bvh.intersectsGeometry)

```js
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
  const bad=new Set(), tested=new Set(); let pairs=0;
  const inv=new THREE.Matrix4();
  for(const arr of grid.values()){
    for(let a=0;a<arr.length;a++)for(let bI=a+1;bI<arr.length;bI++){
      let i=arr[a],j=arr[bI]; if(i>j){const t=i;i=j;j=t;}
      const pk=i*n+j; if(tested.has(pk))continue; tested.add(pk);   // dedupe multi-cell pairs
      if(!boxes[i].intersectsBox(boxes[j]))continue;
      pairs++;
      inv.copy(linkWorldMatrix(i)).invert().multiply(linkWorldMatrix(j));   // bring link j into link i's frame
      if(linkGeom(i).boundsTree.intersectsGeometry(linkGeom(j),inv)){ bad.add(i); bad.add(j); }
    }
  }
  return {bad,pairs};
}

```

## Mating test (ghost neighbour + overlap test)

```js
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

```

## X-ray + section (clipping plane) view

```js
function xrayMaterials(){
  const o=[];
  if(S.partMesh) o.push(S.partMesh.material);
  if(S.chain)    o.push(S.chain.material);
  return o.concat(overrideMaterials(), lsChainMaterials());
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

```

## Decimation: meshoptimizer binary search to a vertex target, grid-cluster fallback

```js
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
```

## Loop-sculpt: node-based progressive deformation applied per link

```js
function compileLSFn(code){
  try{ const fn=new Function('n_it','n_it_nor',code); fn(0,0); return fn; }
  catch(e){ return null; }
}

function applyLSDeform(geo, n_it, n_it_nor){
  if(!S.lsNodes.length) return;
  const nodes = (UI&&UI.mirrorEnabled&&S.lsNodes.length)
    ? [...S.lsNodes, ...getMirroredLSNodes()]
    : S.lsNodes;
  const pos=geo.getAttribute('position');
  const nrm=geo.getAttribute('normal');
  const n=pos.count;
  const v=new THREE.Vector3(), d=new THREE.Vector3();
  for(let vi=0;vi<n;vi++){
    v.fromBufferAttribute(pos,vi);
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

```

## Export: deform + bake matrices + merge into one mesh

```js
async function exportChain(){
  if(!S.poses.length){status('Build the chain first.','err');return;}
  if(UI.simAuto) await autoFitReduction(true);   // make sure the file meets the size cap
  const fmt=exportFormat();
  const keepColor = fmt!=='stl' && hasVColor(S.baseGeo);   // STL has no color; every other format keeps it
  const geos=[];
  for(let i=0;i<S.poses.length;i++){
    let g=(UI.mirrorEnabled&&!S.overrides.has(i)&&S.mirroredBaseGeo)
      ? S.mirroredBaseGeo.clone()    // full symmetric part for non-overridden slots
      : linkGeom(i).clone();         // base or custom model as usual
    if(S.lsNodes.length){ const nor=S.poses.length>1?i/(S.poses.length-1):0; applyLSDeform(g,i,nor); }
    g.applyMatrix4(linkWorldMatrix(i));      // bake world matrix (incl. any gizmo nudge) → separate solid
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
```

## Sculpt / heightmap step glue + undo snapshots

```js
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
  history.clear();                 // fresh undo timeline for this sculpt session
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
  if(!(sculpt.active || disp.active)) return;
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

```
