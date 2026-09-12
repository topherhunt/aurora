// ---------------------------------------------------------------------------
// Backface culling for every mesh that comes out of Tripo.
//
// Tripo writes `doubleSided: true` on its glTF material and GLTFLoader honours
// it. A Tripo creature is a closed volume, and its thin parts -- fish fins,
// ears, a cloak hem -- are closed slabs whose two sheets sit 0 to 0.1 mm apart
// with DIFFERENT texture islands on each. Drawn double-sided, both sheets
// rasterise on top of each other and z-fight at every distance. Culled, the
// far sheet is never drawn: the meshes are consistently wound (measured: 0-4
// conflicting edges in ~750 on the fish, 0 on the fox and shieldmaiden), so
// from any viewpoint exactly one sheet faces the camera.
//
// RULE: every loader of Tripo output -- bench previews AND world placement --
// calls this on the loaded root, so a preview fails the way the game would.
// The world keeps culling unless a placement explicitly decides otherwise and
// says why at the call site. The one standing exception is a Tripo trunk
// batched into the tree prop material, which is DoubleSide because the LEAF
// CARDS in the same draw call are single-sided geometry (material.js,
// createPropMaterial); the trunk has no thin slabs, so that costs raster work
// and nothing visible.
//
// scripts/check-creatures.mjs asserts that every src file loading from a Tripo
// work directory or from public/creatures imports this module.
// ---------------------------------------------------------------------------

import THREE from './three-instance.js'

/** Sets FrontSide on every material under `root`; returns `root`. */
export function cullTripoBackfaces(root) {
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.side = THREE.FrontSide
  })
  return root
}
