// ---------------------------------------------------------------------------
// THE LEAFKIN'S GROUND (DESIGN.md §30): where a leafkin may stand and which
// caps it may gather, as pure functions of position -- the field, the water,
// and the tree, rock, dead-wood and mushroom scatters read at full density
// without their pools or the viewer (trees.pureTrunksInto,
// rocks.pureRocksInto, mushrooms.pureCapsInto). So every client of a room
// steps a leafkin over the same ground whatever it has grown. The stone is a
// superset -- each rock's hull circle at its unfitted scale -- so a leafkin
// gives a rock a wide berth rather than ever walking into one some client drew.
//
// Memoized: a CELL grid of answers and the scatters' tiles, each map cleared
// when it passes its cap. A cell's answer is its centre's, the obstacles
// grown by half the cell's diagonal, so it holds for every point in it.
// ---------------------------------------------------------------------------

import { TILE as TREE_TILE } from './trees.js'

export const CELL = 0.5
// Ground it will not step onto: hers (player.js LOCOMOTION.maxSlopeDeg).
export const MAX_SLOPE = (50 * Math.PI) / 180
// A cell's answer: open, blocked, or blocked by stone alone (which a leafkin at its mouth walks through).
export const OPEN = 0
export const BLOCKED = 1
export const STONE = 2
// The walker's own pad about a trunk (walk.js TRUNK_PAD) and the smallest stone it stands on rather than walks round (walk.js ROCK_WALK_MIN).
const TRUNK_PAD = 0.15
const ROCK_MIN = 0.5
const GROW = CELL * Math.SQRT1_2
// FIXED BOUNDS, the widest trunk and the furthest a cap stands from its trunk's centre (the trunk, the gap and the ring twice over, mushrooms.js _drawClump), and a tile breaking one throws: a bound learned from the tiles read so far would make a cell's answer hang on which ground this client happened to read first.
const TRUNK_REACH = 2
const CAP_REACH = 8
const CELLS_CAP = 1 << 19
const TILES_CAP = 4096
const MAX_SLOPE_TAN = Math.tan(MAX_SLOPE)
const cellKey = (i, j) => (i + 0x8000) * 0x10000 + (j + 0x8000)
const tileKey = (tx, tz) => (tx + 0x8000) * 0x10000 + (tz + 0x8000)

export class LeafkinGround {
  /**
   * @param field     V2Height: heightAndSlopeAt
   * @param water     WaterSurfaces: isSubmerged
   * @param trees     Trees: pureTrunksInto; null for none
   * @param rocks     Rocks: pureBeds, hollowOver; null for none
   * @param deadwood  Deadwood: occupiesAt; null for none
   * @param mushrooms Mushrooms: pureCapsInto; null and there are no caps
   */
  constructor({ field, water, trees = null, rocks = null, deadwood = null, mushrooms = null }) {
    if (!field || typeof field.heightAndSlopeAt !== 'function') throw new Error('LeafkinGround needs the field, for heightAndSlopeAt')
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('LeafkinGround needs WaterSurfaces, for isSubmerged')
    if (trees && typeof trees.pureTrunksInto !== 'function') throw new Error('LeafkinGround: the trees need pureTrunksInto')
    if (rocks && (typeof rocks.pureBeds !== 'function' || typeof rocks.hollowOver !== 'function')) throw new Error('LeafkinGround: the rocks need pureBeds and hollowOver')
    if (deadwood && typeof deadwood.occupiesAt !== 'function') throw new Error('LeafkinGround: the dead wood needs occupiesAt')
    if (mushrooms && typeof mushrooms.pureCapsInto !== 'function') throw new Error('LeafkinGround: the mushrooms need pureCapsInto')
    if (mushrooms && !trees) throw new Error('LeafkinGround: caps grow off the trees, so the mushrooms need them')
    this.field = field
    this.water = water
    this.trees = trees
    this.rocks = rocks
    this.deadwood = deadwood
    this.mushrooms = mushrooms
    this.beds = rocks ? rocks.pureBeds() : []
    this.cells = new Map()
    this.trunks = new Map()
    this.caps = new Map()
    this.stones = this.beds.map(() => new Map())
    // Work done, for the gates: cells answered and scatter tiles read.
    this.asked = 0
    this.tilesRead = 0
  }

  /** The answer for the cell holding (x, z): OPEN, BLOCKED (water, slope, a trunk, dead wood) or STONE. */
  cell(x, z) {
    const i = Math.round(x / CELL), j = Math.round(z / CELL)
    const k = cellKey(i, j)
    let v = this.cells.get(k)
    if (v === undefined) {
      if (this.cells.size >= CELLS_CAP) this.cells.clear()
      v = this._cell(i * CELL, j * CELL)
      this.cells.set(k, v)
    }
    return v
  }

  /** Drop the answers for every cell within `reach` of (x, z), a square: stone there has moved (an entrance boulder's ladder, rocks.js HOLLOW_LADDER). */
  forget(x, z, reach) {
    const i1 = Math.round((x + reach) / CELL) + 1, j1 = Math.round((z + reach) / CELL) + 1
    for (let i = Math.round((x - reach) / CELL) - 1; i <= i1; i++) {
      for (let j = Math.round((z - reach) / CELL) - 1; j <= j1; j++) this.cells.delete(cellKey(i, j))
    }
  }

  _cell(x, z) {
    this.asked++
    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    if (tan > MAX_SLOPE_TAN || this.water.isSubmerged(x, z, h)) return BLOCKED
    if (this.deadwood && this.deadwood.occupiesAt(x, z, GROW)) return BLOCKED
    if (this.trees) {
      const reach = TRUNK_REACH + TRUNK_PAD + GROW
      for (let tx = Math.floor((x - reach) / TREE_TILE); tx <= Math.floor((x + reach) / TREE_TILE); tx++) {
        for (let tz = Math.floor((z - reach) / TREE_TILE); tz <= Math.floor((z + reach) / TREE_TILE); tz++) {
          const t = this._trunks(tx, tz)
          for (let n = 0; n < t.length; n += 3) {
            const r = t[n + 2] + TRUNK_PAD + GROW
            const dx = x - t[n], dz = z - t[n + 1]
            if (dx * dx + dz * dz < r * r) return BLOCKED
          }
        }
      }
    }
    for (let b = 0; b < this.beds.length; b++) {
      const tile = this.beds[b].tile
      const gx = Math.floor(x / tile), gz = Math.floor(z / tile)
      // The 3x3 block about the cell's tile is enough for every blocking bed: see rocks.js _blockAt.
      for (let tx = gx - 1; tx <= gx + 1; tx++) {
        for (let tz = gz - 1; tz <= gz + 1; tz++) {
          const s = this._stones(b, tx, tz)
          for (let n = 0; n < s.length; n += 3) {
            const r = s[n + 2] + GROW
            const dx = x - s[n], dz = z - s[n + 1]
            if (dx * dx + dz * dz < r * r) return STONE
          }
        }
      }
    }
    // The entrance boulder by its mesh, not its hull circle, which can swallow the ground before its own mouth: the centre, corners and edge midpoints, so only a sliver under 1/8 of a cell deep across one edge goes unseen.
    if (this.rocks) {
      const h = CELL / 2
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (this.rocks.hollowOver(x + a * h, z + b * h)) return STONE
    }
    return OPEN
  }

  _trunks(tx, tz) {
    const k = tileKey(tx, tz)
    let t = this.trunks.get(k)
    if (t === undefined) {
      if (this.trunks.size >= TILES_CAP) { this.trunks.clear(); this.caps.clear() }
      this.tilesRead++
      t = this.trees.pureTrunksInto(tx, tz, [])
      for (let n = 2; n < t.length; n += 3) if (t[n] > TRUNK_REACH) throw new Error(`LeafkinGround: a trunk of ${t[n].toFixed(2)} m past TRUNK_REACH`)
      this.trunks.set(k, t)
    }
    return t
  }

  _stones(b, tx, tz) {
    const map = this.stones[b]
    const k = tileKey(tx, tz)
    let s = map.get(k)
    if (s === undefined) {
      if (map.size >= TILES_CAP) map.clear()
      this.tilesRead++
      s = this.beds[b].pureRocksInto(tx, tz, ROCK_MIN, [])
      map.set(k, s)
    }
    return s
  }

  _capsOf(tx, tz) {
    const k = tileKey(tx, tz)
    let c = this.caps.get(k)
    if (c === undefined) {
      const t = this._trunks(tx, tz)
      c = []
      for (let n = 0; n < t.length; n += 3) {
        const from = c.length
        this.mushrooms.pureCapsInto(t[n], t[n + 1], t[n + 2], c)
        for (let m = from; m < c.length; m += 2) {
          if (Math.hypot(c[m] - t[n], c[m + 1] - t[n + 1]) > CAP_REACH) throw new Error(`LeafkinGround: a cap past CAP_REACH of its trunk at ${t[n].toFixed(1)}, ${t[n + 1].toFixed(1)}`)
        }
      }
      this.caps.set(k, c)
    }
    return c
  }

  /** Every cap within `reach` of (x, z), as [x, z] pairs appended to `out`, in an order every client shares. */
  capsNear(x, z, reach, out) {
    if (!this.mushrooms) return out
    const far = reach + CAP_REACH
    const r2 = reach * reach
    for (let tx = Math.floor((x - far) / TREE_TILE); tx <= Math.floor((x + far) / TREE_TILE); tx++) {
      for (let tz = Math.floor((z - far) / TREE_TILE); tz <= Math.floor((z + far) / TREE_TILE); tz++) {
        const c = this._capsOf(tx, tz)
        for (let n = 0; n < c.length; n += 2) {
          const dx = c[n] - x, dz = c[n + 1] - z
          if (dx * dx + dz * dz <= r2) out.push(c[n], c[n + 1])
        }
      }
    }
    return out
  }
}
