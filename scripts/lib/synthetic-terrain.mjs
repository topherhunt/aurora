// ---------------------------------------------------------------------------
// A synthetic terrain for the gates that exercise rivers without a baked world.
//
// A river's route and level are functions of the ground (PathSet.setTerrain), so
// any fixture with a river needs a coarse Heightmap and a groundAt. Sampling both
// from one analytic fn(x, z) keeps them consistent and lets a gate state its
// expectations in closed form. 257 texels over the 8192 m world is 32 m per texel,
// with texel 128 on x = z = 0.
// ---------------------------------------------------------------------------

import { WORLD_HALF, WORLD_SIZE } from '../../src/v2/config.js'
import { Heightmap } from '../../src/v2/height/heightmap.js'
import { RELIEF_SHIPPED } from '../../src/v2/height/relief.js'

export function fieldOf(fn) {
  const n = 257
  const data = new Float32Array(n * n)
  let minY = Infinity
  let maxY = -Infinity
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = fn(-WORLD_HALF + (i * WORLD_SIZE) / (n - 1), -WORLD_HALF + (j * WORLD_SIZE) / (n - 1))
      data[j * n + i] = v
      if (v < minY) minY = v
      if (v > maxY) maxY = v
    }
  }
  return Heightmap.fromRaw({ width: n, height: n, data, meta: { world: WORLD_SIZE, minY, maxY, encoding: 'raw' } })
}

// The shape PathSet.setTerrain takes; `peaks` as the shipped relief has it, so a gate's river lift is the shipped one.
export function terrainOf(fn, peaks = RELIEF_SHIPPED.peaks > 0) {
  const hm = fieldOf(fn)
  return { coarse: () => hm, peaks: () => peaks, groundAt: fn, detailAt: () => 0 }
}

export const FLAT_100 = () => 100
