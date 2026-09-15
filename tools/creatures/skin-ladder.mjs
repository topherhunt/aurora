// ---------------------------------------------------------------------------
// THE SKINNED LOD LADDER: a rigged mesh decimated into tiers that all hang off
// the ONE skeleton it already has.
//
// Nothing here re-rigs anything. A skeleton is a tree of joints and a stack of
// inverse bind matrices; a clip is a set of tracks naming those joints. Neither
// mentions a vertex, so neither cares how many vertices the mesh has. What a
// decimated tier is actually missing is two PER-VERTEX attributes -- JOINTS_0
// and WEIGHTS_0, which bones pull this vertex and how hard -- and those are
// carried straight through: src/mesh/decimate.js never interpolates an
// attribute, so every output vertex IS one of the input vertices, and its
// `sourceVertex` map says which. The joints and weights are copied from it
// verbatim. That is exact, not a nearest-vertex guess.
//
// So a shipped creature is N meshes, ONE skin and ONE set of animations, and
// swapping tiers at runtime is swapping which geometry is bound -- see
// src/v2/render/puppet.js. The file grows by the tiers' vertices and nothing
// else.
//
// THE COST OF A TIER IS ITS TRIANGLES AND NOT ITS BONES. Every tier is skinned
// by the same 29 to 42 joints, so stepping down the ladder does not make the
// skinning cheaper -- three uploads a skeleton's bone texture once a frame
// however many tiers are drawn from it. A ladder buys triangles and draw
// distance. It does not buy bones.
// ---------------------------------------------------------------------------

import { decimateLadder } from '../../src/mesh/decimate.js'

// One per rung of the runtime ladder below tier 0 (critters.js LOD_RUNGS),
// halving as the rungs double in distance.
export const TIER_FRACTIONS = [0.5, 0.25, 0.125]
// Weights within this of summing to one are the rig's own rounding; further off
// than this and the input is broken and a tier would inherit the breakage.
const WEIGHT_TOL = 1e-3

/**
 * `mesh` is `{ positions, normals, uvs, indices, joints, weights }` of plain
 * arrays -- `joints` and `weights` four per vertex, the glTF JOINTS_0/WEIGHTS_0
 * layout. `fractions` are of the input's triangle count.
 *
 * Returns the whole ladder INCLUDING the input as tier 0, so a caller writes
 * `tiers` and does not special-case the top. Each tier has the same six arrays
 * plus `stats` from the decimator.
 */
export function skinnedLadder(mesh, fractions = TIER_FRACTIONS, opts = {}) {
  const { positions, normals, uvs, indices, joints, weights } = mesh
  const verts = positions.length / 3
  if (!joints || !weights) throw new Error('skinnedLadder: the mesh carries no joints and weights -- it is not rigged')
  if (joints.length !== verts * 4 || weights.length !== verts * 4) {
    throw new Error(`skinnedLadder: ${verts} vertices want ${verts * 4} joints and weights, got ${joints.length} and ${weights.length}`)
  }
  for (let v = 0; v < verts; v++) {
    let sum = 0
    for (let k = 0; k < 4; k++) sum += weights[v * 4 + k]
    if (Math.abs(sum - 1) > WEIGHT_TOL) throw new Error(`skinnedLadder: vertex ${v} has weights summing to ${sum.toFixed(4)}, not 1 -- the rig is broken and every tier would inherit it`)
  }

  const tris = indices.length / 3
  const targets = fractions.map((f) => {
    const t = Math.round(tris * f)
    if (t < 4) throw new Error(`skinnedLadder: ${(f * 100).toFixed(0)}% of ${tris} triangles is ${t}, which is not a mesh`)
    return t
  })
  // uvMode 'auto' keeps the atlas exact where it can and stretches only where
  // holding it would stop the tier reaching its target -- the bench's setting,
  // and the one that matters on a 128 px creature texture.
  const tiers = decimateLadder({ positions, normals, uvs, indices }, targets, { uvMode: 'auto', ...opts })

  return [
    { positions, normals, uvs, indices, joints, weights, stats: null },
    ...tiers.map((t) => {
      const n = t.positions.length / 3
      const J = new joints.constructor(n * 4)
      const W = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const s = t.sourceVertex[i]
        for (let k = 0; k < 4; k++) {
          J[i * 4 + k] = joints[s * 4 + k]
          W[i * 4 + k] = weights[s * 4 + k]
        }
      }
      // 'auto' may have resolved to 'drop', which leaves `uvs` null and the
      // coordinates under `sampleUvs`. On a creature that is still the right
      // texture to read -- one atlas, one map -- so it ships as the tier's uv.
      const uv = t.uvs ?? t.sampleUvs
      if (!uv) throw new Error('skinnedLadder: a tier came back with no texture coordinates at all')
      return { positions: t.positions, normals: t.normals, uvs: uv, indices: t.indices, joints: J, weights: W, stats: t.stats }
    }),
  ]
}

/** A one-line report per tier, for a shipper's console. */
export const ladderLine = (tiers) => tiers.map((t) => `${t.indices.length / 3}${t.stats?.uvMode === 'stretch' ? '*' : ''}`).join('/')
