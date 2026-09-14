// ---------------------------------------------------------------------------
// WorldSense: what the ambience needs to know about where she is, read off the
// world's own oracles (V2Height, WaterSurfaces, Rocks, Frogs, BiomeField) and
// nothing else -- no three, no scene graph, so a gate can run it on fakes.
//
// Everything here is answered at the SENSE_HZ cadence, not per frame: a sample
// is a few dozen field evaluations, and a shoreline or a snowline does not move
// between frames at walking pace.
// ---------------------------------------------------------------------------

import { smoothstep } from '../../sim/mathx.js'
import { TREE_TUNING } from '../render/trees.js'

const { TREELINE, BIOME } = TREE_TUNING

export const SENSE_HZ = 4

// How far the ambience listens for a shore, a frog, a boulder field. The spec's
// 10 m gets a margin so a fade can finish before the rule switches off.
export const SHORE_REACH = 12
export const FROG_REACH = 10
export const FROG_CAP = 16
// Half-side of the box looseCountIn counts around her, and the ring the cliff
// probe samples on.
export const BOULDER_HALF = 20
export const CLIFF_RING = 12
const CLIFF_SAMPLES = 8
// Step of the finite difference that turns a shore distance into a bearing.
const SHORE_EPS = 2.5
// The band limit every terrain read here runs at; see V2Height.scatterAt.
const SENSE_CELL = 4

export class WorldSense {
  constructor({ field, water, rocks, frogs, biome }) {
    for (const [k, v] of Object.entries({ field, water, rocks, frogs, biome })) {
      if (!v) throw new Error(`WorldSense: missing ${k}`)
    }
    this.field = field
    this.water = water
    this.rocks = rocks
    this.frogs = frogs
    this.biome = biome
    this._scatter = { h: 0, tan: 0 }
  }

  static blank() {
    return {
      fieldH: 0, groundH: 0, tan: 0,
      onBoulder: false,
      snowLine: 0, aboveSnow: -Infinity,
      forest: 0,
      cliff: 0,
      // Signed metres to the nearest lake shore (negative = out over water) and
      // the unit XZ bearing toward the water; same for the rivers.
      lakeShore: SHORE_REACH, lakeDirX: 0, lakeDirZ: 0,
      riverShore: SHORE_REACH, riverDirX: 0, riverDirZ: 0,
      // World positions of the frogs within FROG_REACH, flat, three per frog.
      frogs: new Float32Array(FROG_CAP * 3), frogCount: 0,
      boulders: 0,
    }
  }

  /** Read the world around the head at (hx, hy, hz) into `out`. */
  sample(hx, hy, hz, out) {
    const field = this.field
    const s = field.scatterAt(hx, hz, SENSE_CELL, this._scatter)
    out.fieldH = s.h
    out.tan = s.tan
    const top = this.rocks.blockTopAt(hx, hz, 0.5)
    out.onBoulder = top > s.h
    out.groundH = out.onBoulder ? top : s.h

    out.snowLine = field.snowLineAt(hx, hz)
    out.aboveSnow = s.h - out.snowLine
    out.forest = this.forestAt(hx, hz, out.aboveSnow)
    out.cliff = this.cliffAt(hx, hz)

    const lake = this.water.lakeShoreDistAt(hx, hz, SHORE_REACH, s.h, s.tan)
    out.lakeShore = lake
    if (Math.abs(lake) < SHORE_REACH) {
      this._bearing(out, 'lake', hx, hz, (x, z) => {
        const q = field.scatterAt(x, z, SENSE_CELL, this._scatter)
        return this.water.lakeShoreDistAt(x, z, SHORE_REACH, q.h, q.tan)
      })
    } else {
      out.lakeDirX = out.lakeDirZ = 0
    }

    const river = this.water.riverShoreDistAt(hx, hz, SHORE_REACH)
    out.riverShore = river
    if (Math.abs(river) < SHORE_REACH) {
      this._bearing(out, 'river', hx, hz, (x, z) => this.water.riverShoreDistAt(x, z, SHORE_REACH))
    } else {
      out.riverDirX = out.riverDirZ = 0
    }

    out.frogCount = this.frogsNear(hx, hy, hz, out.frogs)
    out.boulders = this.rocks.looseCountIn(hx - BOULDER_HALF, hz - BOULDER_HALF, hx + BOULDER_HALF, hz + BOULDER_HALF)
    return out
  }

  /**
   * The forest's own keep-probability at a point -- the product Trees rolls a
   * tree against (trees.js, TREELINE and BIOME) -- so "in a forest" means the
   * same thing to the ear as to the eye. 0 on a summit or in a meadow, 1 deep
   * in full wood.
   */
  forestAt(x, z, aboveSnow) {
    if (aboveSnow > TREELINE.top) return 0
    const snowT = smoothstep(0, TREELINE.fade, aboveSnow)
    const keep = (1 + (TREELINE.floor - 1) * snowT) * (1 - smoothstep(TREELINE.fade, TREELINE.top, aboveSnow))
    const cover = smoothstep(BIOME.ramp[0], BIOME.ramp[1], this.biome.coverAt(x, z))
    return keep * (BIOME.meadowKeep + (1 - BIOME.meadowKeep) * cover)
  }

  /** The steepest ground on a ring CLIFF_RING out, as a slope tangent: 1 is 45 degrees. */
  cliffAt(x, z) {
    let worst = 0
    for (let i = 0; i < CLIFF_SAMPLES; i++) {
      const a = (i / CLIFF_SAMPLES) * Math.PI * 2
      const q = this.field.scatterAt(x + Math.cos(a) * CLIFF_RING, z + Math.sin(a) * CLIFF_RING, SENSE_CELL, this._scatter)
      if (q.tan > worst) worst = q.tan
    }
    return worst
  }

  /** Down the gradient of a signed shore distance is toward the water. Writes `<key>DirX/Z`. */
  _bearing(out, key, x, z, distAt) {
    const gx = distAt(x + SHORE_EPS, z) - distAt(x - SHORE_EPS, z)
    const gz = distAt(x, z + SHORE_EPS) - distAt(x, z - SHORE_EPS)
    const len = Math.hypot(gx, gz)
    if (len < 1e-6) {
      out[key + 'DirX'] = out[key + 'DirZ'] = 0
      return
    }
    out[key + 'DirX'] = -gx / len
    out[key + 'DirZ'] = -gz / len
  }

  /** Positions of the frogs within FROG_REACH of the head into `into` (xyz triples), nearest-first not guaranteed; returns the count. */
  frogsNear(hx, hy, hz, into) {
    // A frog the panel has hidden is frozen where it sat, and does not croak from there.
    if (!this.frogs.batch.visible) return 0
    let n = 0
    const r2 = FROG_REACH * FROG_REACH
    for (const tile of this.frogs.tiles.values()) {
      for (const f of tile.frogs) {
        const dx = f.x - hx, dy = f.y - hy, dz = f.z - hz
        if (dx * dx + dy * dy + dz * dz > r2) continue
        into[n * 3] = f.x
        into[n * 3 + 1] = f.y
        into[n * 3 + 2] = f.z
        if (++n >= FROG_CAP) return n
      }
    }
    return n
  }
}
