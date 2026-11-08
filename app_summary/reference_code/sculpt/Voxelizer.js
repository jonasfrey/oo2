/**
 * VOXEL REMESH — recommended approach (documented, deliberately not a full impl).
 *
 * Goal: turn a messy sculpted mesh into a clean, uniform, watertight mesh.
 *
 * Recommended pipeline (all doable with libs already loaded):
 *   1. SDF sampling with three-mesh-bvh:
 *        import { generateMeshSDF } from 'three-mesh-bvh';   // (or roll your own via
 *        bvh.closestPointToPoint + a sign test). Sample a regular grid (e.g. 128^3)
 *        over the bbox + a margin; store signed distance per voxel.
 *   2. Marching cubes over the SDF at iso=0 to emit a triangle mesh.
 *        three's addons MarchingCubes (examples/jsm/objects/MarchingCubes.js) is a
 *        metaball renderer, NOT a general iso-mesher — don't use it for this.
 *        Use a standalone MC table impl (e.g. the `isosurface` npm package, or port
 *        Paul Bourke's tables ~200 lines). Output is naturally watertight & uniform.
 *   3. Optional: BufferGeometryUtils.mergeVertices + computeVertexNormals for clean shading.
 *
 * Trade-offs:
 *   - Resolution vs cost: grid is O(n^3). 128^3 ≈ 2M samples — fine in a worker, janky
 *     on the main thread. Run it off-thread; this is why it's a button, not live.
 *   - Detail loss: thin features below voxel size vanish. Pick grid res from the
 *     smallest feature you care about (≈ bbox / 128..256).
 *   - It destroys vertex colors unless you re-sample color from the source mesh per
 *     output vertex (nearest-point lookup via the BVH) — extra pass.
 *
 * For "keep it simple": ship Repair now (MeshRepair.js); add Voxelize as a
 * worker-backed button when you actually hit topology you can't repair.
 */
export async function voxelRemesh() {
  throw new Error('Voxelizer is a documented design recommendation, not yet implemented.');
}
