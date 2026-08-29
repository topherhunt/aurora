// ---------------------------------------------------------------------------
// The quantised distance ladder every scatter bed shares.
//
// Ferns, mushrooms, litter, deadwood, rocks, trees and grass all scatter
// instances over the same tile grid and thin them the same way: a tile's
// distance from the eye picks a level q, and each level keeps a fraction of
// what the level before it kept. The two pieces of that which are pure
// arithmetic live here, because seven copies of a loop nest is seven places for
// a fix to be applied six times.
//
// What does NOT live here is the ladder each bed builds in its constructor
// (`maxQ`, `uAt`, `loSq`) or how it demotes a tile's geometry. Those read
// similar but differ per bed in ways that matter -- grass quantises from a strip
// radius and derives its keep-fraction from a curve, rocks keeps a per-tier
// fraction -- and collapsing them would mean a parameter per difference.
// ---------------------------------------------------------------------------

// Thinning steps per doubling of distance. 4 gives 2^(1/4) = 1.19x per step,
// which is under the ~1.25x where a bed visibly pops as you walk toward it.
export const QUANT = 4

// The level a tile at squared distance `d2` sits on. `ladderFrom` is the radius
// level 0 ends at -- for most beds that is `fullRadius`, for grass the strip
// bed's own start -- and `fullSq` is its square, passed in rather than squared
// here because a bed may hold the two apart.
export function levelFor(d2, fullSq, ladderFrom, maxQ) {
  if (d2 <= fullSq) return 0
  const q = Math.floor(Math.log2(Math.sqrt(d2) / ladderFrom) * QUANT)
  return q < 0 ? 0 : q > maxQ ? maxQ : q
}

// The instance pool a bed has to allocate, summed over the real tile grid
// rather than integrated over the disc: the law is applied per tile, and a tile
// takes its level from its NEAREST corner, so the continuous form overcounts
// the near ring and undercounts the far one. Running short does not degrade,
// it throws, so the sum is taken over the worst arrangement and multiplied by
// `headroom`.
//
// `perTileAt(d2)` returns how many instances one tile at that squared distance
// contributes -- that is where a bed folds in its own per-tile count and its
// own keep-fraction.
export function poolBound(tile, span, evictSq, headroom, perTileAt) {
  const c = tile / 2
  let bound = 0
  for (let iz = -span; iz <= span; iz++) {
    for (let ix = -span; ix <= span; ix++) {
      const dcx = (ix + 0.5) * tile - c
      const dcz = (iz + 0.5) * tile - c
      if (dcx * dcx + dcz * dcz > evictSq) continue
      const nx = Math.max(ix * tile, Math.min(c, (ix + 1) * tile))
      const nz = Math.max(iz * tile, Math.min(c, (iz + 1) * tile))
      bound += perTileAt((nx - c) ** 2 + (nz - c) ** 2)
    }
  }
  return Math.ceil(bound * headroom)
}
