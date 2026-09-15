// ---------------------------------------------------------------------------
// How far a river has to stand above its own level to clear the terrain as the
// mesher DRAWS it at each LOD rung. Three-free, like ribbon.js, so the gate can
// hold it against the mesher in node.
//
// A river's level is solved against the ground at full detail, and the ground
// under it is carved down to that level. The far terrain is not that surface:
// a cell wider than the channel has its vertices on the banks and draws the
// chord between them over the water, and under the `peaks` knob every vertex
// from the 8 m cell up is the MAX of the ground over its own footprint
// (chunk-mesh-v2.js PEAKS), so the valley fills in with distance as well. The
// deficit grows with the rung, and the rung is the eye's distance times the LOD
// knob, so a fixed lift is wrong at every distance but one. This file measures
// the deficit per rung once, at build, and src/water.js's vertex stage reads it
// off the rung of the terrain chunk drawn under the vertex (water-surfaces.js
// updateLod writes that, per ten metres walked or per re-split, never per frame)
// and scales it by how steeply the eye looks down on the vertex (RAISE_SLOPE):
// seen from near its own level a river lies in its bed behind the near bank, as
// it would if the bank were drawn in full, instead of floating over the far one.
//
// The replica reads the coarse import through the carve chain at the mesher's
// grid vertices, with its stencil when `peaks` is up and its shorter-diagonal
// cut always -- the carve has to be in at every rung, because a vertex it lowers
// can flip the diagonal, and the other cut runs above this one's. What it leaves
// out is the fractal detail, which the flatten mask has already removed along a
// river, and the chord between two ribbon samples under a ground that kinks
// between them; RAISE_MARGIN covers both. What it cannot see is the chunk split
// itself: which rung is drawn where is the terrain's call, so the vertex asks
// it (TerrainV2.groundKeyAt) instead of guessing from distance -- a node is
// sixteen cells wide, so distance alone is ambiguous by a full octave.
// ---------------------------------------------------------------------------

import { WORLD_HALF, WORLD_SIZE, CHUNK_RES, MAX_DEPTH } from '../config.js'
import { peaksStencil } from '../terrain/chunk-mesh-v2.js'

// The cells a river needs lifting for, coarsest last: from the first cell wider than a channel, which is also the first the footprint max is on for the shipped 8 m texel. The 4 m rung and finer sample the surface the level was solved on inside the channel, and need no lift.
export const RAISE_RUNGS = Object.freeze([8, 16, 32, 64, 128, 256, 512])

// Per rung, metres added over the replica for what it leaves out. Measured along the shipped rivers against the mesher's own field with `peaks` both up and down, the replica came within 1.2 m of the drawn ground at 16 m and within 1.0 m elsewhere; these hold half a metre past that.
export const RAISE_MARGIN = Object.freeze([1.5, 2.0, 1.5, 1.5, 1.5, 1.5, 1.5])

// The sight-line slope -- the eye's height over the vertex per metre of plan distance to it -- below which none of the lift is drawn and from which all of it is, smoothstepped between. A shore stands under 0.05 over every river it can see across a lake; the far side of a valley seen from a mountainside is 0.4 and more.
export const RAISE_SLOPE = Object.freeze([0.05, 0.25])

// Metres of arc from either end of a river over which the lift ramps up from nothing, so a mouth meets its lake and a source meets the ground at the level they were solved at.
export const RAISE_END = 30

/**
 * The `aRung` a vertex carries for a terrain chunk at quadtree depth `depth` drawn under it: 0 for a cell under the first rung, which lifts nothing, else 1 + the rung's index, so the shader's tent at that integer is the one that fires. One table lookup per sample per read.
 */
export const RUNG_AT_DEPTH = Object.freeze(Array.from({ length: MAX_DEPTH + 1 }, (_, depth) => {
  const cell = WORLD_SIZE / ((1 << depth) * CHUNK_RES)
  const k = RAISE_RUNGS.indexOf(cell)
  if (k < 0 && cell >= RAISE_RUNGS[0]) throw new Error(`river-raise: depth ${depth} draws a ${cell} m cell, which is no rung of RAISE_RUNGS`)
  return k < 0 ? 0 : k + 1
}))

// Where across the ribbon the terrain is read, as a fraction from the right vertex to the left. Each bank vertex carries what its own side of the channel needs, so the sheet lies on the drawn ground at both banks instead of floating level over the lower one; the pair is then pushed up until the line between them clears every tap.
const LATERAL = [0, 0.25, 0.5, 0.75, 1]

/**
 * The terrain as the mesher draws it at cell `step`: every grid vertex `ground.sample` there, or under `peaks` the max of it over the PEAKS footprint, each quad cut along its shorter diagonal. `carve(x, z, h)`, when given, is applied to every tap. Vertices are memoised, so a river walking cell by cell pays each once.
 */
export class DrawnTerrain {
  constructor(ground, step, carve = null, peaks = true) {
    if (!ground || typeof ground.sample !== 'function' || !(ground.texelSize > 0)) throw new Error('DrawnTerrain: needs a Heightmap')
    if (!(step > 0)) throw new Error(`DrawnTerrain: bad cell ${step}`)
    if (typeof peaks !== 'boolean') throw new Error('DrawnTerrain: peaks must be a boolean, the relief knob as the mesher sees it')
    this.ground = ground
    this.step = step
    this.carve = carve
    this.peaks = peaks ? peaksStencil(step, ground.texelSize) : null
    this.cache = new Map()
  }

  sample(x, z) {
    const h = this.ground.sample(x, z)
    return this.carve === null ? h : this.carve(x, z, h)
  }

  vertex(gi, gj) {
    const key = gj * 65536 + gi
    const hit = this.cache.get(key)
    if (hit !== undefined) return hit
    const x = -WORLD_HALF + gi * this.step
    const z = -WORLD_HALF + gj * this.step
    let h = this.sample(x, z)
    const p = this.peaks
    if (p !== null) {
      for (let b = 0; b < p.n; b++) {
        const zz = z - p.r + b * p.pitch
        for (let a = 0; a < p.n; a++) {
          const v = this.sample(x - p.r + a * p.pitch, zz)
          if (v > h) h = v
        }
      }
    }
    this.cache.set(key, h)
    return h
  }

  at(x, z) {
    const u = (x + WORLD_HALF) / this.step
    const w = (z + WORLD_HALF) / this.step
    const gi = Math.floor(u)
    const gj = Math.floor(w)
    const fx = u - gi
    const fz = w - gj
    const ya = this.vertex(gi, gj)
    const yb = this.vertex(gi + 1, gj)
    const yc = this.vertex(gi, gj + 1)
    const yd = this.vertex(gi + 1, gj + 1)
    if (Math.abs(ya - yd) < Math.abs(yb - yc)) {
      return fz <= fx ? ya + fx * (yb - ya) + fz * (yd - yb) : ya + fz * (yc - ya) + fx * (yd - yc)
    }
    return fx + fz <= 1 ? ya + fx * (yb - ya) + fz * (yc - ya) : yd + (1 - fx) * (yc - yd) + (1 - fz) * (yb - yd)
  }
}

/**
 * Per ribbon vertex, per rung, the lift in metres that puts the ribbon's edge on the drawn terrain at that rung plus the rung's margin, never below zero. Laid out like the ribbon's positions, right then left per sample, RAISE_RUNGS.length floats each. `layers` supplies the carve chain and `peaks` says whether the mesher is drawing the footprint max.
 *
 * Across the channel the two lifts are the smallest pair whose straight line clears every LATERAL tap, solved from each bank in turn and keeping the lower pair. Along it, a coarse sample's lift is the max over the fine samples it spans, from the coarse sample before it to the one after: the coarse strip interpolates between coarse samples alone, and two values each at least the span's max bound every point of the span. Both ends are then ramped to zero over RAISE_END of arc, after the span max so the end samples themselves carry exactly nothing.
 */
export function riverRaise(ribbon, lod, ground, layers, peaks) {
  if (!layers || typeof layers.carve !== 'function') throw new Error('riverRaise: needs Layers, for the carve chain')
  if (typeof peaks !== 'boolean') throw new Error('riverRaise: needs the relief\'s peaks knob as a boolean')
  const { count: n, positions, arc } = ribbon
  if (!arc || arc.length !== n) throw new Error('riverRaise: the ribbon carries no arc -- build it with ribbonVertices')
  const R = RAISE_RUNGS.length
  const T = LATERAL.length
  const need = new Float32Array(n * 2 * R)
  const taps = new Float64Array(T)
  for (let k = 0; k < R; k++) {
    const step = RAISE_RUNGS[k]
    const drawn = new DrawnTerrain(ground, step, (x, z, h) => layers.carve(x, z, h, step), peaks)
    const margin = RAISE_MARGIN[k]
    for (let i = 0; i < n; i++) {
      const o = i * 6
      const rx = positions[o], y = positions[o + 1], rz = positions[o + 2]
      const lx = positions[o + 3], lz = positions[o + 5]
      for (let j = 0; j < T; j++) {
        const t = LATERAL[j]
        taps[j] = Math.max(0, drawn.at(rx + (lx - rx) * t, rz + (lz - rz) * t) - y + margin)
      }
      // Fix the left lift at the max of the left half, lift the right until the line clears all; then the mirror; keep the pair that lifts less.
      let l0 = 0
      for (let j = 0; j < T; j++) if (LATERAL[j] >= 0.5 && taps[j] > l0) l0 = taps[j]
      let r0 = 0
      for (let j = 0; j < T; j++) if (LATERAL[j] < 1) r0 = Math.max(r0, (taps[j] - LATERAL[j] * l0) / (1 - LATERAL[j]))
      let r1 = 0
      for (let j = 0; j < T; j++) if (LATERAL[j] <= 0.5 && taps[j] > r1) r1 = taps[j]
      let l1 = 0
      for (let j = 0; j < T; j++) if (LATERAL[j] > 0) l1 = Math.max(l1, (taps[j] - (1 - LATERAL[j]) * r1) / LATERAL[j])
      const mirror = r1 + l1 < r0 + l0
      need[(i * 2) * R + k] = mirror ? r1 : r0
      need[(i * 2 + 1) * R + k] = mirror ? l1 : l0
    }
  }

  const out = Float32Array.from(need)
  const { coarse } = lod
  for (let c = 0; c < coarse.length; c++) {
    const lo = coarse[Math.max(0, c - 1)]
    const hi = coarse[Math.min(coarse.length - 1, c + 1)]
    for (let side = 0; side < 2; side++) {
      const at = (coarse[c] * 2 + side) * R
      for (let k = 0; k < R; k++) {
        let top = 0
        for (let i = lo; i <= hi; i++) if (need[(i * 2 + side) * R + k] > top) top = need[(i * 2 + side) * R + k]
        out[at + k] = top
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const ramp = Math.min(1, arc[i] / RAISE_END, (arc[n - 1] - arc[i]) / RAISE_END)
    if (ramp >= 1) continue
    for (let q = i * 2 * R; q < (i + 1) * 2 * R; q++) out[q] *= ramp
  }
  return out
}
