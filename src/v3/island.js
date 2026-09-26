import { Noise } from '../sim/noise.js'
import { smoothstep } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// The island's field -- §31 steps A and B. Two terms, added:
//
//   1. THE CONE. A circular cone standing in a sea that keeps falling, its coast pushed in and out by a warp of the position and a per-angle coast radius so the shore has bays and headlands at three sizes. Height is a function of `r / R(theta)`, so ground that reaches further out reaches further out at height and a peninsula carries a ridge on its own.
//   2. THE JITTER. One octave of value noise per entry of `amps`, from `start` metres between nodes down, halving each time: a lattice of nodes at that spacing, each node moved up or down by up to that octave's amp, and the ground between nodes interpolated. Each octave refines the one before it. The same everywhere inland, eased down over the last `shore.band` of the radius so the coast is not cut into islets.
//
// ONE LADDER, TWO PLACES IT IS EVALUATED. The ladder runs from 1024 m between nodes down to 1 m, eleven rungs, each moving its nodes by a quarter of its own spacing. No grid can hold all of it: a lattice needs TEXELS_PER_NODE samples across a node spacing to be recorded rather than aliased, so at 2 m a texel the image carries the rungs down to 8 m and the last three -- 4, 2 and 1 m -- are added at READ time, per sample, by `fine.js`. `octaveTable` builds the whole ladder and `splitOctaves` cuts it at the grid, so both halves are rungs of the same ladder with the same rotation and the same salt: the split is a storage decision and nothing else, and moving it changes which rungs are baked, never what the terrain is.
//
// WHY A LATTICE NEEDS FOUR SAMPLES AND NOT TWO. Two is the Nyquist period exactly, which samples as a regular two-texel sawtooth; one is white noise, and the golden-angle rotation then beats against the texel grid as moire. Both were tried in the image and both came back, once the reconstruction had rounded them off, as a row of identical humps marching along every crest at a fixed interval -- grain, not landform. Four samples to a node is the finest lattice an image can carry honestly. That is a limit on the IMAGE, not on the terrain: the rungs below it are real and wanted, which is why they are evaluated rather than dropped.
//
// Nothing else. Three-free and DOM-free: the gate and the PNG script run this in node.
// ---------------------------------------------------------------------------

export const MACRO = {
  coastRadius: 2500,      // R0, metres: the mean distance from the centre to the shore
  summit: 450,            // H, metres, before the summit rounding
  profileExp: 1.2,        // (1 - d)^p: 1 is a straight cone, above it the skirt is gentler and the massif steeper
  summitRound: 0.08,      // fraction of H over which the cone's point is rounded into a massif
  apron: 0.12,            // fraction of H under which the profile bends toward lowland
  apronSlope: 0.15,       // share of the cone's own slope the apron keeps at the waterline, so the beach is never a plane the sea can fight
  shelfDepth: 6,          // metres under the sea the coastal shelf sits
  shelfDrop: 24,          // metres past the waterline over which the shelf is reached
  shelfWidth: 120,        // metres of shelf before the sea floor falls
  seaSlope: 1 / 9,        // the fall past the shelf, all the way to the box edge
  // [wavelength, amplitude] in metres. Three sizes of bay and headland. Amplitude under a tenth of the wavelength, or the warp folds the plane over itself and the fold is a crease running inland.
  warp: [[1600, 150], [520, 45], [170, 15]],
  // Angular harmonics of the coast radius: `k` is the noise radius on the unit circle (about 2*pi*k features around the coast), `amp` the fraction of R0.
  coastLow: { k: 0.7, amp: 0.32 },
  // Because height is a function of r / R(theta), every bay and headland runs inward as a valley or ridge, and the small ones would converge on the summit as creases. So the high harmonic is skin-deep: full at `fade[1]` R0 from the centre, gone by `fade[0]` R0.
  coastHigh: { k: 2.8, amp: 0.09, fade: [0.35, 0.9] },
}

/** Samples a grid must put across one node spacing for the lattice to be recorded rather than aliased. See the header. */
export const TEXELS_PER_NODE = 4

export const JITTER = {
  start: 1024,            // metres between nodes in the first octave, halving each octave: 1024, 512, ... 2, 1
  // Metres a node moves up or down by, at most, per octave: a quarter of that octave's spacing, all the way down. ELEVEN rungs, 1024 m to 1 m. Which of them the image carries is decided by the grid, not here -- see splitOctaves.
  amps: [256, 128, 64, 32, 16, 8, 4, 2, 1, 0.5, 0.25],
  interp: 'smooth',       // 'smooth' (a smoothstep between nodes) or 'linear' (a straight lerp, which shows the lattice as creases)
  rotate: true,           // turn each octave's lattice by the golden angle so no two share axes
  // The jitter is full inland and eases over the last `band` of the radius to `floor` of itself at the waterline, holding there over the sea. Full jitter at the shore is hundreds of metres on a 54 m apron: islets.
  shore: { band: 0.2, floor: 0.3 },
}

/** Softplus with a shoulder of `eps`: max(0, v) without the crease at zero. */
function soft(v, eps) {
  return 0.5 * (v + Math.sqrt(v * v + eps * eps))
}

/** A node's displacement in -1..1 from its lattice coordinates and a salt, the same every time it is asked. */
export function nodeAt(ix, iz, salt) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * 2 - 1
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/**
 * The whole ladder as octave records, coarsest first. `k` is the rung's index and it is what fixes the lattice rotation and the hash salt, so rung 8 is the same 4 m lattice whether it was summed into the image or added at read time.
 */
export function octaveTable(seed, jitter = JITTER) {
  if (!Number.isFinite(seed)) throw new Error(`octaveTable: seed must be a finite number, got ${seed}`)
  if (jitter.interp !== 'smooth' && jitter.interp !== 'linear') throw new Error(`octaveTable: interp must be 'smooth' or 'linear', got ${jitter.interp}`)
  const out = []
  for (let k = 0; k < jitter.amps.length; k++) {
    if (!Number.isFinite(jitter.amps[k])) throw new Error(`octaveTable: jitter amp ${k} is ${jitter.amps[k]}`)
    const a = jitter.rotate ? k * GOLDEN : 0
    out.push({ k, spacing: jitter.start / 2 ** k, amp: jitter.amps[k], cos: Math.cos(a), sin: Math.sin(a), salt: (seed | 0) * 31 + 7 * k + 1 })
  }
  return out
}

/**
 * The ladder cut at what a grid of `cell` metres a texel can carry: `coarse` is baked into the image, `fine` is added per sample at read time. `cell` of 0 asks for the exact field and puts every rung in `coarse`, which is what a sampler with no grid under it wants.
 */
export function splitOctaves(table, cell) {
  if (!(cell >= 0)) throw new Error(`splitOctaves: cell must be 0 or more metres, got ${cell}`)
  const floor = TEXELS_PER_NODE * cell
  return { coarse: table.filter((o) => o.spacing >= floor), fine: table.filter((o) => o.spacing < floor) }
}

/** One octave's contribution at (x, z), before the shore easing: the lattice turned by its angle, the four corner nodes, interpolated. */
export function octaveAt(o, x, z, smooth) {
  const fx = (x * o.cos - z * o.sin) / o.spacing
  const fz = (x * o.sin + z * o.cos) / o.spacing
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  let tx = fx - ix
  let tz = fz - iz
  if (smooth) {
    tx = tx * tx * (3 - 2 * tx)
    tz = tz * tz * (3 - 2 * tz)
  }
  const a = nodeAt(ix, iz, o.salt)
  const b = nodeAt(ix + 1, iz, o.salt)
  const c = nodeAt(ix, iz + 1, o.salt)
  const d = nodeAt(ix + 1, iz + 1, o.salt)
  const top = a + (b - a) * tx
  const bottom = c + (d - c) * tx
  return (top + (bottom - top) * tz) * o.amp
}

/**
 * The field as a sampler over world metres, (x, z) -> metres. Built once per seed; `at` is what the grid loop and the instruments call.
 *
 * `cell` is the grid this island is about to be rasterised onto, and it decides which rungs of the jitter ladder `at` sums: the ones the grid can hold. The rest are `this.fine`, for `fine.js` to add at read time. Pass 0 for the exact field.
 */
export class Island {
  constructor(seed, macro = MACRO, jitter = JITTER, cell = 0) {
    this.macro = macro
    this.jitter = jitter
    this.seed = seed | 0
    this.cell = cell
    const { coarse, fine } = splitOctaves(octaveTable(seed, jitter), cell)
    if (coarse.length === 0) throw new Error(`Island: a ${cell} m grid can hold none of the jitter ladder; its coarsest rung is ${jitter.start} m`)
    this.octaves = coarse
    this.fine = fine
    // One noise per role, seeded apart, so a warp octave and the coast harmonic never share a lattice and line up.
    this.warpX = macro.warp.map((_, i) => new Noise(seed * 7 + 11 + i))
    this.warpZ = macro.warp.map((_, i) => new Noise(seed * 7 + 31 + i))
    this.coastLow = new Noise(seed * 7 + 101)
    this.coastHigh = new Noise(seed * 7 + 103)
  }

  /** The warped position, the coast radius there and the normalised distance `d` (0 centre, 1 shore). Returned as one object so the instruments can ask for the pieces. */
  frame(x, z) {
    const m = this.macro
    let wx = x
    let wz = z
    for (let i = 0; i < m.warp.length; i++) {
      const [lambda, amp] = m.warp[i]
      wx += amp * this.warpX[i].simplex2(x / lambda, z / lambda)
      wz += amp * this.warpZ[i].simplex2(x / lambda + 3.7, z / lambda - 1.9)
    }
    const r = Math.hypot(wx, wz)
    const theta = Math.atan2(wz, wx)
    const cx = Math.cos(theta)
    const sz = Math.sin(theta)
    const low = this.coastLow.simplex2(cx * m.coastLow.k, sz * m.coastLow.k)
    const high = this.coastHigh.simplex2(cx * m.coastHigh.k + 5.1, sz * m.coastHigh.k + 2.3)
    const reach = smoothstep(m.coastHigh.fade[0] * m.coastRadius, m.coastHigh.fade[1] * m.coastRadius, r)
    const R = m.coastRadius * (1 + m.coastLow.amp * low + reach * m.coastHigh.amp * high)
    return { wx, wz, r, R, d: r / R }
  }

  /** The cone alone, in metres. */
  macroAt(x, z) {
    return this.macroIn(this.frame(x, z))
  }

  /** The field this grid can hold: cone plus the jitter rungs at or above its Nyquist. */
  at(x, z) {
    const f = this.frame(x, z)
    return this.macroIn(f) + this.jitterAt(x, z, f)
  }

  macroIn(f) {
    const m = this.macro
    const { R, d } = f
    if (d >= 1) {
      // Sea: a shelf reached by a short steep drop, then a floor that falls to the box edge.
      const s = (d - 1) * R
      const deep = s - m.shelfWidth
      return -(m.shelfDepth * smoothstep(0, m.shelfDrop, s) + m.seaSlope * soft(deep, 40))
    }
    let v = Math.pow(1 - d, m.profileExp)
    // Rounded cap: above 1 - 2s the line is swapped for the parabola tangent to it there and flat at the top, so the summit is a massif at (1 - s) H and not a point at H.
    const s = m.summitRound
    const knee = 1 - 2 * s
    if (v > knee) {
      const t = v - knee
      v = knee + t - (t * t) / (4 * s)
    }
    let h = m.summit * v
    // The apron: under `apron * H` the profile is bent down toward a quadratic so the last few hundred metres before the shore are lowland, blended in over the band so there is no kink at the join.
    const A = m.apron * m.summit
    if (h < 1.5 * A) {
      const u = h / A
      const bent = A * (u * u * (1 - m.apronSlope) + u * m.apronSlope)
      h = bent + (h - bent) * smoothstep(0.5 * A, 1.5 * A, h)
    }
    return h
  }

  /** How much of the jitter survives here: full inland, eased to `shore.floor` over the last `shore.band` of the radius. The read-time rungs use this too, through `shoreScaleAt`. */
  shoreIn(f) {
    const j = this.jitter
    return 1 - (1 - j.shore.floor) * smoothstep(1 - j.shore.band, 1, f.d)
  }

  /** Step B: this grid's own rungs of the jitter ladder, given the position's frame. */
  jitterAt(x, z, f) {
    const smooth = this.jitter.interp === 'smooth'
    let sum = 0
    for (const o of this.octaves) sum += octaveAt(o, x, z, smooth)
    return this.shoreIn(f) * sum
  }
}

/** Fill an n x n row-major grid over the WORLD_SIZE box, centred on the origin, `cell` metres a texel. */
export function rasterise(island, n, cell, out = new Float32Array(n * n)) {
  if (out.length !== n * n) throw new Error(`rasterise: out has ${out.length} texels, ${n}x${n} needs ${n * n}`)
  if (island.cell !== cell) throw new Error(`rasterise: the island was split for a ${island.cell} m grid and this one is ${cell} m; its fine rungs would be baked or dropped`)
  const half = ((n - 1) * cell) / 2
  for (let j = 0; j < n; j++) {
    const z = j * cell - half
    for (let i = 0; i < n; i++) out[j * n + i] = island.at(i * cell - half, z)
  }
  return out
}
