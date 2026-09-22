import { Noise } from '../sim/noise.js'
import { clamp01, smoothstep } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// The island's field -- §31 steps A and B. Three terms, added:
//
//   1. THE CONE. A circular cone standing in a sea that keeps falling, its coast pushed in and out by a warp of the position and a per-angle coast radius so the shore has bays and headlands at three sizes. Height is a function of `r / R(theta)`, so ground that reaches further out reaches further out at height and a peninsula carries a ridge on its own.
//   2. THE JITTER. One octave of value noise per entry of `amps`, from `start` metres between nodes down, halving each time: a lattice of nodes at that spacing, each node moved up or down by up to that octave's amp, and the ground between nodes interpolated. Each octave refines the one before it. The same everywhere inland, eased down over the last `shore.band` of the radius so the coast is not cut into islets.
//   3. THE RIDGE. A ridged multifractal on the high ground: crests where the noise crosses zero, hollows where it does not, each octave riding on the one above it so the detail gathers on the crests and leaves the hollows broad. This is where jaggedness comes from now, and it is jagged because it is ASYMMETRIC -- `1 - |s|` has a corner at every crest and a smooth floor between them, which is a mountain's profile and not a hill's.
//
// THE CASCADE STOPS AT FOUR TEXELS, and it is the most important number in this file. The field is rasterised at 8 m a texel, so a lattice at 8 m puts one independent node under every texel (white noise, and its golden-angle rotation beats against the texel grid as visible moire) and a lattice at 16 m puts one under every second texel (the Nyquist period exactly, which samples as a regular two-texel sawtooth). Both were in the cascade and both read, once the bicubic had rounded them off, as a row of identical humps marching along every crest at a fixed interval -- grain, not landform: they doubled the field's curvature and its slope reversals (10.5% of texels to 22.2%) while adding 0.3 m to the mean step. The finest octave is therefore 32 m, four texels to a node, which is the finest lattice this grid can carry without aliasing. Relief below that scale is the droplets' (erosion.js), the cliffs' (cliffs.js) and v2's own procedural detail's -- all three of which put it where the ground gives a reason for it, rather than everywhere at once.
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

export const JITTER = {
  start: 512,             // metres between nodes in the first octave, halving each octave: 512, 256, 128, 64, 32
  // Metres a node moves up or down by, at most, per octave; a quarter of the spacing each. FIVE octaves, not seven: see THE CASCADE STOPS AT FOUR TEXELS above. Adding entries here takes the lattice to 16 m and then 8 m, which is the sawtooth.
  amps: [128, 64, 32, 16, 8],
  interp: 'smooth',       // 'smooth' (a smoothstep between nodes) or 'linear' (a straight lerp, which shows the lattice as creases)
  rotate: true,           // turn each octave's lattice by the golden angle so no two share axes
  // The jitter is full inland and eases over the last `band` of the radius to `floor` of itself at the waterline, holding there over the sea. Full jitter at the shore is +-128 m on a 54 m apron: islets. 0.3 cuts the apron into coves and leaves it a coast.
  shore: { band: 0.2, floor: 0.3 },
}

// The ridged term. Crests, not humps: what the jitter's dead octaves used to supply, supplied by something with a corner on it.
export const RIDGE = {
  wavelength: 440,        // metres between one crest line and the next in the first octave
  octaves: 4,             // halving: 440, 220, 110, 55 -- the last is seven texels, so the grid can still draw its crest
  amp: 26,                // metres the first octave's crest stands over its hollow
  gain: 0.5,              // each octave's amplitude as a share of the one before
  ride: true,             // weight each octave by the one above it, so detail gathers on the crests and the hollows stay broad -- the multifractal half of "ridged multifractal", and what stops this reading as another layer of bumps
  sharp: 2,               // exponent on 1 - |s|: at 1 the crest is a plain corner, over it the crest narrows and the floor broadens. This is the asymmetry.
  // Where ridges run at all. Two gates, multiplied: height, so the lowland is never spiked, and a slow patch noise, so the high ground carries RANGES of jagged ground with smooth country between them rather than a uniform rash of spires.
  floor: 0.35,            // fraction of MACRO.summit under which no ridge runs
  band: 0.3,              // fraction of it over which that gate opens
  patchScale: 1500,       // metres of the patch noise
  patch: 0.1,             // the noise level the patch has to stand above
  patchBand: 0.4,         // noise units over which it opens
}

/** Softplus with a shoulder of `eps`: max(0, v) without the crease at zero. */
function soft(v, eps) {
  return 0.5 * (v + Math.sqrt(v * v + eps * eps))
}

/** A node's displacement in -1..1 from its lattice coordinates and a salt, the same every time it is asked. */
function nodeAt(ix, iz, salt) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return ((h >>> 0) / 4294967296) * 2 - 1
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5))

/**
 * The field as a sampler over world metres, (x, z) -> metres. Built once per seed; `at` is what the grid loop and the instruments call.
 */
export class Island {
  constructor(seed, macro = MACRO, jitter = JITTER, ridge = RIDGE) {
    if (!Number.isFinite(seed)) throw new Error(`Island: seed must be a finite number, got ${seed}`)
    if (jitter.interp !== 'smooth' && jitter.interp !== 'linear') throw new Error(`Island: interp must be 'smooth' or 'linear', got ${jitter.interp}`)
    // The cascade's finest lattice, in metres. Under four texels it aliases; see the header.
    const finest = jitter.start / 2 ** (jitter.amps.length - 1)
    if (!(finest >= 32)) throw new Error(`Island: the finest jitter lattice is ${finest} m, under the 32 m the 8 m grid can carry without aliasing`)
    this.macro = macro
    this.jitter = jitter
    this.ridge = ridge
    this.seed = seed | 0
    // One noise per ridge octave plus the patch mask, seeded clear of the warp and the coast.
    this.ridgeN = []
    for (let k = 0; k < ridge.octaves; k++) this.ridgeN.push(new Noise(seed * 7 + 211 + k))
    this.patchN = new Noise(seed * 7 + 241)
    // One noise per role, seeded apart, so a warp octave and the coast harmonic never share a lattice and line up.
    this.warpX = macro.warp.map((_, i) => new Noise(seed * 7 + 11 + i))
    this.warpZ = macro.warp.map((_, i) => new Noise(seed * 7 + 31 + i))
    this.coastLow = new Noise(seed * 7 + 101)
    this.coastHigh = new Noise(seed * 7 + 103)
    // Each octave's lattice rotation, precomputed.
    this.octaves = []
    for (let k = 0; k < jitter.amps.length; k++) {
      const a = jitter.rotate ? k * GOLDEN : 0
      if (!Number.isFinite(jitter.amps[k])) throw new Error(`Island: jitter amp ${k} is ${jitter.amps[k]}`)
      this.octaves.push({ spacing: jitter.start / 2 ** k, amp: jitter.amps[k], cos: Math.cos(a), sin: Math.sin(a), salt: this.seed * 31 + 7 * k + 1 })
    }
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

  /** The field: cone plus jitter plus ridge. */
  at(x, z) {
    const f = this.frame(x, z)
    const m = this.macroIn(f)
    return m + this.jitterAt(x, z, f) + this.ridgeAt(x, z, m)
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

  /** Step B: the octaves of jitter at this position, given its frame. */
  jitterAt(x, z, f) {
    const j = this.jitter
    const smooth = j.interp === 'smooth'
    const scale = 1 - (1 - j.shore.floor) * smoothstep(1 - j.shore.band, 1, f.d)
    let sum = 0
    for (const o of this.octaves) {
      // Lattice coordinates: the position turned by the octave's angle, in node spacings.
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
      sum += (top + (bottom - top) * tz) * o.amp
    }
    return scale * sum
  }

  /**
   * The ridged term, in metres and never negative: it lifts crests out of the cone rather than cutting valleys into it, so the hollows between ridges are the cone's own ground and keep whatever the jitter and the droplets put there.
   *
   * `macro` is the cone's height at this position, which is what the height gate reads -- the cone and not the field, so a jitter node cannot push a patch of lowland over the line and stand a range of spires on it.
   */
  ridgeAt(x, z, macro) {
    const R = this.ridge
    const lift = smoothstep(R.floor * this.macro.summit, (R.floor + R.band) * this.macro.summit, macro)
    if (lift <= 0) return 0
    const patch = clamp01((this.patchN.simplex2(x / R.patchScale, z / R.patchScale) - R.patch) / R.patchBand)
    if (patch <= 0) return 0
    let sum = 0
    let amp = R.amp
    let lam = R.wavelength
    let prev = 1
    for (let k = 0; k < R.octaves; k++) {
      // 1 - |s|: 1 on the crest line, 0 where the noise is furthest from it. The corner at the crest is the point; `sharp` narrows it.
      const r = Math.pow(1 - Math.abs(this.ridgeN[k].simplex2(x / lam, z / lam)), R.sharp)
      sum += amp * r * prev
      if (R.ride) prev = clamp01(r)
      amp *= R.gain
      lam *= 0.5
    }
    return lift * patch * sum
  }
}

/** Fill an n x n row-major grid over the WORLD_SIZE box, centred on the origin, `cell` metres a texel. */
export function rasterise(island, n, cell, out = new Float32Array(n * n)) {
  if (out.length !== n * n) throw new Error(`rasterise: out has ${out.length} texels, ${n}x${n} needs ${n * n}`)
  const half = ((n - 1) * cell) / 2
  for (let j = 0; j < n; j++) {
    const z = j * cell - half
    for (let i = 0; i < n; i++) out[j * n + i] = island.at(i * cell - half, z)
  }
  return out
}
