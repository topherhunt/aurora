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

// --- the room's bounds -------------------------------------------------------
//
// A room may be a disc inside the map rather than the whole of it: the leafkin
// glade is a bowl some 60 m across, and the rest of its 8 km heightmap is that
// same bowl repeated (rooms/village.js buildHeightmap), so a bed sweeping its
// own draw radius grows thousands of tiles of wood behind a wall she can never
// see through. `bounds` is `{ x, z, r }`, or null for the open world.

/** Whether a tile of `tile` metres at grid `tx, tz` lies wholly outside `bounds`. */
export function tileOutOfBounds(bounds, tx, tz, tile) {
  if (!bounds) return false
  const nx = Math.max(tx * tile, Math.min(bounds.x, (tx + 1) * tile))
  const nz = Math.max(tz * tile, Math.min(bounds.z, (tz + 1) * tile))
  return (nx - bounds.x) ** 2 + (nz - bounds.z) ** 2 > bounds.r * bounds.r
}

// A bed's draw radius in a bounded room: the far side of the disc is the whole
// horizon, however far the bed would otherwise reach. This shrinks the tile
// sweep AND the pool poolBound sizes from it -- the bounds test alone would
// still pay for a 1.5 km grid of rejections.
//
// 2.5 DIAMETERS AND NOT ONE, plus a tile. A bed dissolves its instances as they
// approach its own edge -- the rocks' floor starts at 0.85 of `radius` -- so a
// radius of exactly the diameter has the far side of the room dithering while
// she looks straight at it. It also puts a bounded bed's radius under the far
// distance its biggest instance wants; that check stays on the AUTHORED radius,
// because out here the bed edge is behind the wall with nothing placed on it.
export const boundedRadius = (radius, bounds, tile) => (bounds ? Math.min(radius, 2.5 * bounds.r + tile) : radius)

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
