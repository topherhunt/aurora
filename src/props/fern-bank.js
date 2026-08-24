import { buildFern, FERN_DEFAULTS, geometryBytes } from './fern.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The fern variant bank: every fern mesh in the world, baked once at load.
//
// THERE IS NO OFFLINE BAKE STEP AND THERE SHOULD NOT BE. This runs in the
// constructor of whatever owns the batch, hands its geometries to
// BatchedMesh.addGeometry(), and then disposes them -- the GPU arena keeps the
// only copy. Cost is about a millisecond at startup and 121 KB resident, so an
// asset file on disk would buy nothing and cost a build step, a cache to
// invalidate and a way for the mesh to disagree with the generator. Change a
// number here, reload, see it.
//
// The bank is a CROSS PRODUCT, and that is the whole reason it stays small.
// 16 meshes per tier, three tiers, 48 geometries; each fern instance then picks
// a variant, a uniform scale and a yaw. The combinations a player sees are far more
// numerous than the meshes we store, which is the trade every procedural asset
// in this project should make: spend the frame, not the pool.
//
// LOCKED SPEC -- TASKS.md carries the same list and scripts/probe-fern-bank.mjs
// prices it. Change one, change all three in the same commit.
// ---------------------------------------------------------------------------

// Held constant across the bank. These were chosen in the previewer (fern.html)
// against the whole spec, not one variant at a time.
export const FERN_BASE = {
  curve: 1.6,
  pitchFalloff: 0.5,
  lengthVar: 0.5,
  widthScale: 1.2,
  sway: 1.2,
  roll: 0.7,
  yawJitter: 0,
  crownRadius: 0,
  crozier: 0,
}

// The combinatorial axes. 2 x 2 x 2 x 2 = 16.
export const FERN_AXES = {
  fronds: [5, 9],
  pitch: [1.0, 1.4],
  arch: [0.6, 2],
  taper: [0, 0.6],
}

// The scan each frond wears, and its measured aspect from
// public/ferns/fern_fronds.json. The two arrays are parallel and both are
// indexed by frond position within a fern -- a mismatch would texture a card at
// the wrong width, which reads as a stretched frond rather than as an error.
//
// One entry, deliberately: see the note on LAYER.FROND_0 in textures.js for why
// the other two scans are not here. The round-robin machinery stays because it
// costs nothing at length 1 and it is the same mechanism a tree uses to put
// bark on its trunk and leaves on its canopy.
export const FERN_LAYERS = [LAYER.FROND_0]
export const FERN_ASPECTS = [0.3785]

// Segments per frond, coarsest first. Triangles are exactly fronds x segments
// x 2, so this list IS the cost curve: 84 / 56 / 28 average triangles.
//
// 6 / 4 / 2 rather than 8 / 4 / 2. Judged in the previewer: 4 -> 6 segments is
// a large, obvious gain in how smooth a frond's curve reads, and 6 -> 8 is
// close to undetectable while costing another 33%.
export const FERN_TIERS = [
  { name: 'LOD2', segments: 2 },
  { name: 'LOD1', segments: 4 },
  { name: 'LOD0', segments: 6 },
]

/** Every axis combination, in a stable order. Index into this is a variant id. */
export function fernVariants() {
  const keys = Object.keys(FERN_AXES)
  const out = []
  const walk = (i, acc) => {
    if (i === keys.length) return out.push({ ...acc })
    for (const v of FERN_AXES[keys[i]]) walk(i + 1, { ...acc, [keys[i]]: v })
  }
  walk(0, {})
  return out
}

/**
 * Bake the whole bank in the shared batch's attribute layout.
 *
 * Returns `{ tiers, variants, bytes }`, where `tiers[t].geometries[v]` is the
 * geometry for tier `t` and variant `v`. Tiers are ordered coarsest-first to
 * match FERN_TIERS, so a distance band maps to an index without a lookup.
 *
 * The caller owns the geometries and MUST dispose them once they are in the
 * batch -- BatchedMesh copies the vertex data into its arena, so holding the
 * originals doubles the cost for nothing.
 */
export function buildFernBank({ seed = 1 } = {}) {
  const variants = fernVariants()
  let bytes = 0

  const tiers = FERN_TIERS.map(({ name, segments }) => ({
    name,
    segments,
    geometries: variants.map((axes, i) => {
      const geo = buildFern({
        ...FERN_DEFAULTS,
        ...FERN_BASE,
        ...axes,
        segments,
        // Same seed per variant across tiers, so a fern's frond placement does
        // not shuffle when it crosses an LOD boundary. Without this the swap
        // reads as the plant twitching rather than as detail arriving.
        seed: seed + i,
        frondLayers: FERN_LAYERS,
        frondAspect: FERN_ASPECTS,
      })
      bytes += geometryBytes(geo)
      return geo
    }),
  }))

  return { tiers, variants, bytes }
}
