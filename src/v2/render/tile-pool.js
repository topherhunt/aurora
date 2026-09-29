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
// glade is a bowl some 70 m across, and the rest of its 8 km heightmap is that
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

// How far the eye stands above the highest ground within `reach` of it, floored to LIFT_STEP. A ground bed adds its square to every horizontal tile distance, so from the air it holds only tiles whose ground is within its radius in 3D, and none at all above it. The rim already hides by 3D distance, so this drops only instances nothing would draw. The highest ground, not the ground underfoot: a ridge beside a valley is nearer than the valley floor.
//
// The max is memoised per LIFT_CELL cell, from heightAt on a LIFT_SAMPLE grid plus LIFT_PAD, and shared by every bed on the same field. It is dropped whenever the surface can have moved: a new `ground` (relief, erosion, a sculpt stroke), a new layers document or a layers edit, or setFlat.
export const LIFT_STEP = 2
const LIFT_CELL = 64
const LIFT_SAMPLE = 8
const LIFT_PAD = 4
const liftCaches = new WeakMap()

export function eyeLift(field, x, y, z, reach) {
  let c = liftCaches.get(field)
  // The gates' stub fields have no layers and never change.
  const epoch = field.layers === undefined ? 0 : field.layers.epoch
  if (!c || c.ground !== field.ground || c.layers !== field.layers || c.epoch !== epoch || c.flatY !== field.flatY) {
    c = { ground: field.ground, layers: field.layers, epoch, flatY: field.flatY, max: new Map() }
    liftCaches.set(field, c)
  }
  const i0 = Math.floor((x - reach) / LIFT_CELL)
  const i1 = Math.floor((x + reach) / LIFT_CELL)
  const j0 = Math.floor((z - reach) / LIFT_CELL)
  const j1 = Math.floor((z + reach) / LIFT_CELL)
  let top = -Infinity
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const key = i * 0x10000 + j
      let m = c.max.get(key)
      if (m === undefined) {
        m = -Infinity
        for (let v = 0; v <= LIFT_CELL; v += LIFT_SAMPLE) {
          for (let u = 0; u <= LIFT_CELL; u += LIFT_SAMPLE) m = Math.max(m, field.heightAt(i * LIFT_CELL + u, j * LIFT_CELL + v))
        }
        m += LIFT_PAD
        c.max.set(key, m)
      }
      if (m > top) top = m
    }
  }
  return y <= top ? 0 : Math.floor((y - top) / LIFT_STEP) * LIFT_STEP
}
