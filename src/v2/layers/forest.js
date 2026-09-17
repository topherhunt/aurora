import { smoothstep } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// The forest law: how much wood a place carries, as a keep-probability and a
// height multiplier over position alone.
//
// ONE LAW, TWO READERS. render/trees.js rolls every candidate tree against
// `forestKeepAt` and scales it by `forestScaleAt`; terrain/chunk-mesh-v2.js
// bakes `forestKeepAt` into every terrain vertex so the far ground can be
// drawn the colour of the canopy that stands on it (terrain-material.js, the
// forest tint). The two have to agree to the vertex, or the ground goes green
// where there are no trees and stays meadow under a wood -- so neither file
// holds a number of its own. Water is the one thing the terrain does not ask:
// a lake bed's tint is under the lake.
// ---------------------------------------------------------------------------

// Where a tree can stand at all, lifted from v1's `tree` kind so the two
// routes agree. `sink` is how it stands once there (trees.js alone reads it).
export const PLACEMENT = {
  minElev: 25,
  maxSlopeDeg: 32,
  sink: 0.15, // metres of trunk buried, so a tree on a slope does not float
}
const MAX_SLOPE_TAN = Math.tan((PLACEMENT.maxSlopeDeg * Math.PI) / 180)

// The treeline, as a gradient rather than a contour. All metres are ABOVE the
// local snow line -- a real treeline sits well above where the snow starts.
// Below the snow line nothing here applies. Over the first `fade` metres above
// it a candidate's keep-probability eases from 1 down to `floor` and its height
// multiplier from 1 down to `stunt`, so the wood thins into scattered, stunted
// trees rather than stopping at a line; from `fade` to `top` the floor itself
// eases to nothing, and past `top` a summit is bare. 70 m is about where the
// old hard cut stood (67 m), so the forest reaches the same height it did and
// then keeps going, thinner.
export const TREELINE = {
  fade: 70,
  floor: 0.1,
  stunt: 0.5,
  top: 220,
}

// How the biome field (biome.js) reads onto the forest. `ramp` is the band of
// cover over which a place goes from open meadow to full forest; below it the
// keep-probability is `meadowKeep` (a lone tree in a clearing, not none) and
// the height multiplier is scale[0], above it the wood is untouched at full
// density and scale[1]. The field is flat over 0..1, so 15% of the ground is
// meadow, 15% is towering, and the rest is the gradient between.
export const BIOME = {
  ramp: [0.15, 0.85],
  meadowKeep: 0.04,
  scale: [0.65, 1.2],
}

/**
 * The keep-probability of a tree at height `h` on a slope of `tan`, `above`
 * metres above the local snow line, or 0 where nothing stands. `biome` is a
 * BiomeField (or null for a world without one), asked only once the cheap
 * cuts have passed. Both gradients fold into one probability, so a stunted
 * tree in a high meadow is rarer than either alone.
 */
export function forestKeepAt(h, tan, above, biome, x, z) {
  if (h < PLACEMENT.minElev) return 0
  if (tan > MAX_SLOPE_TAN) return 0
  if (above > TREELINE.top) return 0
  const snowT = smoothstep(0, TREELINE.fade, above)
  let keep = (1 + (TREELINE.floor - 1) * snowT) * (1 - smoothstep(TREELINE.fade, TREELINE.top, above))
  if (biome) {
    const cover = smoothstep(BIOME.ramp[0], BIOME.ramp[1], biome.coverAt(x, z))
    keep *= BIOME.meadowKeep + (1 - BIOME.meadowKeep) * cover
  }
  return keep
}

/** The height multiplier that goes with `forestKeepAt`, over the same two gradients. */
export function forestScaleAt(above, biome, x, z) {
  let scale = 1 + (TREELINE.stunt - 1) * smoothstep(0, TREELINE.fade, above)
  if (biome) {
    const cover = smoothstep(BIOME.ramp[0], BIOME.ramp[1], biome.coverAt(x, z))
    scale *= BIOME.scale[0] + (BIOME.scale[1] - BIOME.scale[0]) * cover
  }
  return scale
}
