# Porting guide — bringing oo2's mesh tools into another 3D sculpting app

This is written for someone re-implementing the *mesh-editing* functionality of the Articulated
Spiral Builder in a different (three.js-based or otherwise) sculpting app. Each section states the
contract, the algorithm, the data it needs, the gotchas discovered in this codebase, and where the
reference code lives. Verbatim sources are in `reference_code/`.

Features ranked by how directly they transfer to a sculpting app:

| Priority | Feature | Reference |
|---|---|---|
| ★★★ | Brush sculpt (draw / carve / smooth) with BVH vertex gathering | `reference_code/sculpt/SculptController.js`, `Brush.js` |
| ★★★ | Mirror / symmetry sculpting + automatic mirror-plane detection | `MirrorHelper.js`, `app_js_excerpts.md` § symmetry |
| ★★★ | Undo / redo | `EditHistory.js` |
| ★★★ | Heightmap / alpha relief painting (mask-gated displacement) | `reference_code/heightmap/*` |
| ★★☆ | Node-based progressive deformation (push / inflate / pinch with falloff + gizmo) | `app_js_excerpts.md` § loop-sculpt |
| ★★☆ | Decimation with vertex budget + file-size estimate | `app_js_excerpts.md` § decimation |
| ★★☆ | Orientation tools: PCA align, lay-flat on picked face, CSG flatten, centre | `app_js_excerpts.md` |
| ★★☆ | Mesh repair, half-mesh mirroring | `MeshRepair.js`, excerpts § half-part |
| ★☆☆ | X-ray, section/clipping view, wireframe/vertex overlays, view cube | excerpts § x-ray, `ViewCube.js` |
| ★☆☆ | Collision detection between instances, mating test | excerpts § collision |

---

## 0. Shared infrastructure every feature relies on

### 0.1 Geometry conventions
* **Indexed, welded `BufferGeometry`** with `position`, `normal`, optional `color`. Loaders that
  return triangle soup (STL) are welded with `BufferGeometryUtils.mergeVertices` (`weldByPosition`),
  otherwise smoothing and adjacency don't work.
* **Transform baked into vertices**; the `Mesh.matrix` stays identity. `bakeMatrix(m)` applies `m`
  to positions, `normalMatrix` to normals, then recomputes bounds and **disposes the BVH** so it is
  rebuilt lazily. Benefit: raycast hit points, mirror planes, brush centres and gizmo positions are
  all in one space — nothing needs `worldToLocal`.
* After *any* topology change (decimate, CSG cut, repair, mirror-merge): `swapBaseGeometry(newGeo)`
  rebuilds the mesh, BVH, edge overlays, adjacency, and **clears undo history** (snapshots would
  have the wrong vertex count).

### 0.2 three-mesh-bvh wiring
```js
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
raycaster.firstHitOnly = true;
```
After moving vertices call `geometry.boundsTree.refit()` (cheap) rather than rebuilding, so the
cursor raycast stays accurate mid-stroke.

### 0.3 Vertex adjacency
Built once per geometry: `adjacency[v] = Int32Array of neighbour vertex ids`, from the index buffer
(both controllers have `_buildAdjacency`). Needed by Smooth, mask blur, and any Laplacian operation.
~O(tris); for 100 k+ vertex meshes consider building it in a worker or lazily.

### 0.4 Pointer contract that coexists with OrbitControls
Both brush controllers use the same pattern, worth copying exactly:
```
renderer.domElement.addEventListener('pointerdown', onDown, /*capture*/ true)   // beat OrbitControls
window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
onDown: left button only, ignore if altKey (Alt+drag = orbit); raycast; if hit:
        controls.enabled=false; setPointerCapture; stopPropagation; preventDefault;
        onStrokeStart() (undo snapshot); apply first stamp
onMove: always raycast to position the cursor ring; if painting && hit → apply
onUp:   controls.enabled=true; finish deferred normals; recompute bounds; onStrokeEnd() (commit undo)
```
Right/middle drag still reaches OrbitControls (pan/orbit) because the capture handler returns early.

### 0.5 Brush cursor
A unit `TorusGeometry(1, 0.025)` ring, `depthTest:false`, `renderOrder 999`, positioned at the hit
point, oriented with `quaternion.setFromUnitVectors(+Z, faceNormal)`, scaled to the radius. Colour
switches to red for erase mode in the heightmap tool.

---

## 1. Brush sculpting (`SculptController`)

**Parameters** (`Brush.js`): `type ∈ {draw, carve, smooth}`, `radius` (model units), `strength` 0..1,
`falloff ∈ {smooth, linear, constant}`.
Falloff weight: `t = clamp(d/r)`, smooth = `(1 − t²)²` (C1 at the rim), linear = `1 − t`.

**Vertex gathering** (`_collect`): `bvh.shapecast` with a sphere test.
`intersectsBounds` returns `CONTAINED` when the box's farthest corner is inside the sphere (then all
three vertices of every triangle in it are accepted without a distance test), `INTERSECTED`
otherwise, `NOT_INTERSECTED` when disjoint. Output is a `Set` of vertex indices. This is the
single most important piece for performance — never loop over all vertices per stamp.

**Draw / Carve**: for each gathered vertex `v` with normal `n`: skip if `n · faceNormal ≤ 0`
(front-facing filter, prevents the brush from dragging the far wall of a thin part), then
`p += sign · strength · w(d) · (0.12 · radius) · n`. The `0.12·radius` makes displacement per stamp
scale with brush size, so the feel is consistent at any zoom.

**Smooth**: compute all targets from the *pre-move* positions first (collect writes), then apply, so
neighbours don't cascade within one stamp: `p += (avg(neighbours) − p) · w · strength`.

**After each stamp**: `position.needsUpdate = true`, `boundsTree.refit()`, recompute vertex normals
if `count ≤ 40 000`, else mark dirty and recompute on pointer-up (`LIVE_NORMAL_LIMIT`).

**Stamp rate**: one stamp per `pointermove` event; no spacing/interpolation along the stroke. If
you port this, adding stroke spacing (stamp every `radius·0.25` of travel) is the first upgrade.

**Undo integration** (app glue, see `app_js_excerpts.md` § sculpt glue): `onStrokeStart` snapshots
`position.array.slice()`; `onStrokeEnd` compares with the current array (`arraysEqual`) and, if
changed, pushes `{undo: restore(before), redo: restore(after)}` onto `EditHistory`. `restorePositions`
writes the array back, recomputes normals/bounds, refits BVH.

**Repair** (`MeshRepair.repairGeometry`): to non-indexed → drop triangles with
`|(b−a)×(c−a)|² ≤ 1e-10` → keep only position (+color) → `mergeVertices(tolerance 1e-4)` →
recompute normals. Returns a *new* geometry (vertex order changes) so caller must rebuild BVH,
adjacency, mirror seam and clear history. No hole filling, no self-intersection fix.

**Voxel remesh**: not implemented; `Voxelizer.js` documents the recommended pipeline
(SDF via three-mesh-bvh → marching cubes in a worker → re-weld; expect colour loss unless
re-sampled).

---

## 2. Mirror sculpting + symmetry detection

### 2.1 MirrorHelper (plane = point + unit normal)
* `signedDistance(p)`, `reflectPoint(p)`, `reflectDir(d)`.
* `collectSeam(geometry, eps)` → indices of vertices lying on the plane.
* Optional `buildCorrespondence(geometry, eps)`: hash-bucket reflected positions to find each
  vertex's mirror partner (−1 if none). Only needed for an "exact" mode on perfectly symmetric
  topology; not used by default.

### 2.2 Strategy used: **double stamp**, not vertex correspondence
Each stamp is applied at the cursor hit *and* at `(reflectPoint(center), reflectDir(faceNormal))`.
Skip the mirror stamp if the two centres are closer than `0.2·radius` (cursor on the seam, avoids
double-hitting). After the stamp, **snap seam vertices back onto the plane**
(`p -= n · signedDistance(p)`) so the mesh never tears or doubles along the symmetry line. This
works on any topology, symmetric or not, and on a single mesh.

### 2.3 Where the plane comes from
Default: the best plane from **mirror-plane detection** (below), falling back to the mesh centre
with normal +X. The UI offers a manual override (axis X/Y/Z + offset).

### 2.4 Mirror-plane detection (`detectSymmetry`, app.js)
Input: welded geometry with BVH. Output: list of vertical planes `{p: centroid, n: (cos θ, sin θ, 0), score}`.
1. Subsample vertices with stride `max(1, n/1400)`.
2. Centroid `c` of all vertices.
3. For `θ = π·i/72`: score = RMS over samples of `distance(reflect(p), surface)` using
   `bvh.closestPointToPoint`.
4. Candidates = local minima with score `< 0.02 · bboxDiagonal`; refine each by scanning
   `θ ± one step` in tenths.
5. Deduplicate planes within 4°. Sort by score.
Only planes containing the Z axis direction are searched (vertical mirror lines) because the part
is already laid flat — for a general sculpting app extend the search to the full hemisphere of
normals (e.g. a Fibonacci sphere of ~200 directions, then refine) or seed from PCA axes.
Runtime: ~1400 × 72 closest-point queries, done in a `setTimeout` so the UI can paint.

### 2.5 Half-mesh → full mesh (`detectHalfPart`, `buildMirroredGeo`)
Detects a flat cut face: the axis/side with the highest fraction of vertices within 1.5 % of the
bbox extent; ≥ 8 % of vertices → "looks like a half". Mirroring: clone non-indexed, reflect the
chosen component (`v = 2·offset − v`), **reverse winding** by swapping vertex 0↔2 of every triangle
for every attribute except normals, merge both halves, `mergeVertices(0.01)`, recompute normals.

---

## 3. Undo / redo (`EditHistory.js`)

56 lines, fully generic. `push(label, undoFn, redoFn)` clears the redo stack and caps the depth at
40. `undo()`/`redo()` move the entry between stacks and call its closure. `onChange` callback
updates button enabled state. Keyboard: Ctrl+Z / Ctrl+Shift+Z handled in the app.

What a step stores in this app:
* Sculpt: full `Float32Array` copy of positions before and after a stroke (simple, memory = 2 ×
  12 bytes × verts per step; fine for < 200 k vertices and 40 steps). An obvious refinement is
  storing only the gathered indices + their old/new xyz.
* Heightmap: copy of the paint **mask** before/after; redo/undo re-runs `redisplaceAll()`.
* Loop-sculpt nodes, chain parameters: not in history.
`clear()` on mode switch, geometry swap, project load.

---

## 4. Heightmap / relief painting (`heightmap/`)

Four small classes; the decomposition is good and worth keeping:

1. **HeightmapEditor** — image → `Float32Array` luminance (Rec. 709 weights), max 1024 px on the
   long edge, decoded once via a 2D canvas. Tonal pipeline per pixel, *always re-run from the
   cached source* (non-destructive): levels remap `[black, white] → [0,1]` → shadows/highlights
   (`L += shadows·(1−L)² + highlights·L²`) → contrast about 0.5 + brightness → invert → clamp.
   Paints a preview canvas and fires `onChange(buffer, w, h)`.
2. **HeightmapProjector** — bakes per-vertex `(u,v)` **once** from the *rest* positions: `planar`
   (two axes perpendicular to the chosen axis, normalised by bbox — default), `uv` (mesh UVs if
   present), `camera` (project through a frozen view-projection matrix, i.e. "decal from here").
   `sampleAll()` is a bilinear lookup per vertex into the height buffer, clamp or repeat.
3. **PaintMask** — `Float32Array` 0..1 per vertex. `stamp(indices, weightFn, flow, erase)` is
   additive with clamp, so overlapping strokes build up smoothly to 1 and erase subtracts.
   `blur(adjacency, amount, iterations)` is a Laplacian relax for feathering.
4. **DisplacementController** — same pointer/BVH contract as the sculpt brush, but a stroke edits the
   **mask**, and vertices are re-derived:
   `position[i] = base[i] + dir[i] · heights[i] · strength · mask[i]`
   where `dir` is the rest normal (`'normal'`) or the projection axis (`'axis'`, cleaner embossing).
   Changing image, strength, direction or mapping just calls `redisplaceAll()`; a stroke calls
   `redisplaceVerts(touchedSet)`. Because everything derives from `base`, nothing compounds and the
   result feathers to exactly zero where the mask is zero.

Gotchas: the controller snapshots `base` on `attach()`, so it must be re-attached after any
sculpt-mode edit or topology change (the app does this in `enterHeight()`); the rest *normals* are
also snapshotted so displacement direction doesn't drift as the surface deforms.

---

## 5. Node-based progressive deformation ("Loop sculpting")

A lightweight, non-brush deformer that's easy to add to a sculpting app as "deformation pins":

* Node = `{pos, dir, radius, intensity, mode ∈ {push, inflate, pinch}, falloff ∈ {smooth, cosine,
  gaussian, linear}, fn}` placed by clicking the mesh (pos = hit point, dir = hit normal) and edited
  with a `TransformControls` gizmo (rotate changes `dir`, translate moves `pos`); the node is drawn
  as an `ArrowHelper` plus a translucent sphere of the radius.
* Falloffs for `r = d/radius`: smooth `(1−r)²`, cosine `(1+cos πr)/2`, gaussian `e^(−4r²)`, linear `1−r`.
* Displacement per vertex: push → `dir·I·t·f`; inflate → `normal·I·t·f`; pinch → `normalize(pos−v)·I·t·f`,
  where `t = fn(n_it, n_it_nor)` is a user formula (presets: linear, ease-in/out, bell, waves).
  In a single-mesh sculpting app `t` is just a global multiplier / animation parameter.
* Applied to a **copy** of the geometry (never destructive); the preview slider deforms a display
  copy only. Implementation is a brute-force O(V·nodes) loop — fine up to ~100 k verts; use the BVH
  gather per node if it gets slow.
* Mirror support: when the half-mirror option is on, nodes are reflected across the mirror plane
  (`getMirroredLSNodes`) so the deformation stays symmetric.

---

## 6. Decimation (meshoptimizer) with a vertex budget

* `MeshoptSimplifier.ready` then `simplify(indices, positions, 3, targetIndexCount, 1.0,
  ['LockBorder'])`, or `simplifyWithAttributes(..., colors, 3, COLOR_WEIGHTS, ...)` when vertex
  colours exist so colour boundaries are preserved.
* The library targets a *triangle* count; the UI wants a *vertex* cap. Solution: **binary search**
  on target triangles (12 iterations), keep the densest result whose unique-vertex count ≤ budget.
* Result is compacted (`compactIndexed`: remap used vertices only), normals recomputed.
* Offline fallback: uniform grid **vertex clustering** (average positions per cell, drop collapsed
  triangles), also binary-searched on grid resolution.
* Pristine geometry is kept (`S.geoPristine`) so "Restore full detail" is a swap, not an undo step.
* File-size estimate: binary STL = `84 + 50 · triangles` bytes; the UI shows "N links × tris ⇒ MB"
  and an auto mode targets ≤ 2 000 verts per instance.

---

## 7. Orientation tools

* **PCA auto-align**: covariance of positions about the centroid → Jacobi eigen solver (50 sweeps on
  the 3×3) → sort eigenvectors by eigenvalue, enforce right-handedness via cross products →
  `basis.transpose()` is the world→axes rotation; bake with translation to the centroid.
* **Lay flat on picked face**: raycast picks a triangle (highlighted); rotation
  `setFromUnitVectors(faceNormal, (0,0,−1))`, then translate so `bbox.min.z = 0`.
* **Auto-rotate in plane**: 2D PCA of the footprint `angle = ½·atan2(2·sxy, sxx − syy)` → rotate about Z.
* **Flatten bottom (CSG)**: `three-bvh-csg` `Evaluator.evaluate(partBrush, boxBrush, SUBTRACTION)`
  with `evaluator.attributes = ['position','normal']` (no UVs); the box is 3× the footprint, its top
  face at the cut height; translate result so the new floor is z = 0. Pre-cut geometry retained for
  a dedicated "Undo cut".
* **Centre part**: translate bbox centre to origin.
* Numeric rotation sliders apply *relative* deltas against the previously applied angle so the
  slider is absolute while the geometry is baked incrementally.

---

## 8. Viewport helpers

* **X-ray**: on every content material set `transparent=true, opacity=0.32, depthWrite=false`, and
  show an `EdgesGeometry(geo, 30°)` `LineSegments` overlay (dark lines) for silhouettes.
* **Section / layer view**: `renderer.localClippingEnabled = true`; one `THREE.Plane((0,0,−1),
  constant)` assigned to `material.clippingPlanes` on all content materials; a slider maps 0..100 %
  to the content's z range (plus a 1e-3 epsilon so the top isn't culled). No cap faces are drawn.
* **Vertices / wireframe overlays**: `THREE.Points` sharing the same geometry (`depthTest:false`,
  size ≈ 1.2 % of bounding radius) and `WireframeGeometry` lines.
* **View cube** (`ViewCube.js`): separate 96 px `WebGLRenderer` + ortho camera, box with six
  canvas-texture labels, mini camera placed along the main camera's view direction each frame,
  hover highlight by material index, click (not drag) → `setView(name)`. `setView` frames the content
  bounding sphere at 3× radius from a fixed offset per named view.
* **Camera framing**: `contentBounds()` chooses chain group → part → default box.

---

## 9. Collision / mating (if your app has multiple instances)

* **Pairwise**: world AABBs padded by 0.05 mm, hashed into a uniform grid with cell = largest box
  extent; for each candidate pair `bvh_i.intersectsGeometry(geo_j, inv(M_i)·M_j)`. 290 pair tests
  for 100 links run in well under a frame; auto-check is disabled above 400 instances.
* **Mating test**: a translucent ghost instance at the relative transform `T(pin − hole)`;
  `bvh.intersectsGeometry(sameGeo, T)` colours the ghost red/orange. Cheap, immediate feedback for
  joint clearance.
* Overlapping instances are tinted red via per-instance colour (`paintChain`) — the chain is one
  merged display geometry with a `color` attribute, swapped links are separate meshes.

---

## 10. UI patterns worth keeping

* **Step wizard with locked/done states** keeps destructive operations (decimate, cut) before the
  expensive ones (instance layout, export) and makes the single-mesh editors ("Sculpt", "Heightmap",
  "Loop sculpt") optional modes that are entered/exited explicitly (`showStepView` enables exactly
  one controller at a time and shows/hides per-mode scene objects).
* **"Armed" click modes** (`UI.arm = 'pickFace' | 'placePin' | 'lsPick' | …`) route one viewport
  click handler; a pill in the button shows the armed state.
* **Formula fields as JS** compiled with `new Function` and validated by a trial call, with error
  text shown inline — powerful for parametric variation (size, colour, path, intensity).
* **HUD chips** for counts/footprint/collision and a single status line with ok/warn/err colours.
* All tunables in one `CONST` block at the top of the engine file.

---

## 11. Dependencies to install for a port

```
three            ^0.160  (0.161+ fixes the OrbitControls wheel-zoom bug this app patches)
three-mesh-bvh   ^0.7
three-bvh-csg    ^0.0.17   (only for the CSG flatten)
meshoptimizer    ^0.22     (only for decimation)
```
Everything else (Alpine, Monaco, Deno server) is UI/persistence plumbing specific to this app.
