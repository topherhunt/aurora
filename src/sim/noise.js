import { mulberry32 } from './mathx.js'

// ---------------------------------------------------------------------------
// Seeded 2D simplex noise plus the fractal variants DESIGN.md §3 calls for.
//
// Simplex rather than classic Perlin because Perlin has visible axis-aligned
// directional artifacts, and on a terrain heightfield those read as a faint
// grid pressed into the mountains.
// ---------------------------------------------------------------------------

const F2 = 0.5 * (Math.sqrt(3) - 1)
const G2 = (3 - Math.sqrt(3)) / 6

const GRAD = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
]

export class Noise {
  constructor(seed) {
    const rand = mulberry32(seed)
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    // Fisher-Yates, seeded.
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    // Doubled so index arithmetic never needs a modulo in the inner loop.
    this.perm = new Uint8Array(512)
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  // Returns roughly -1..1.
  simplex2(xin, yin) {
    const perm = this.perm

    const s = (xin + yin) * F2
    const i = Math.floor(xin + s)
    const j = Math.floor(yin + s)
    const t = (i + j) * G2
    const x0 = xin - (i - t)
    const y0 = yin - (j - t)

    let i1, j1
    if (x0 > y0) {
      i1 = 1
      j1 = 0
    } else {
      i1 = 0
      j1 = 1
    }

    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1 + 2 * G2
    const y2 = y0 - 1 + 2 * G2

    const ii = i & 255
    const jj = j & 255

    let n = 0

    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 > 0) {
      const g = GRAD[perm[ii + perm[jj]] & 7]
      t0 *= t0
      n += t0 * t0 * (g[0] * x0 + g[1] * y0)
    }

    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 > 0) {
      const g = GRAD[perm[ii + i1 + perm[jj + j1]] & 7]
      t1 *= t1
      n += t1 * t1 * (g[0] * x1 + g[1] * y1)
    }

    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 > 0) {
      const g = GRAD[perm[ii + 1 + perm[jj + 1]] & 7]
      t2 *= t2
      n += t2 * t2 * (g[0] * x2 + g[1] * y2)
    }

    return 70 * n
  }

  // Fractal Brownian motion. Returns roughly -1..1 (amplitude-normalized).
  fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0
    let amp = 1
    let freq = 1
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x * freq, y * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return sum / norm
  }

  // Ridged multifractal -- DESIGN.md §3 item 1. `1 - abs(n)` inverts valleys
  // into ridges, and multiplying each octave by the previous one concentrates
  // detail on the ridgelines, which is what produces aretes rather than domes.
  // Returns roughly 0..1.
  //
  // `round` replaces the `abs` crease with a smooth minimum of that radius:
  // sqrt(n^2 + r^2) equals |n| everywhere except within r of zero, where it
  // rounds off to r instead of coming to a point. Two reasons it exists.
  // Aesthetically, a knife edge everywhere reads as wrinkled cloth rather than
  // as mountains. Practically, a crest whose curvature radius is smaller than
  // the cell it is sampled on CANNOT be represented -- the coarse LOD rings
  // land on alternating sides of the edge and the ridgeline renders as a row of
  // saw teeth. No amount of LOD tuning fixes that; the crest has to be wider
  // than the sample spacing. Divided by (1 - round) so the field keeps its 0..1
  // range and `round` changes shape without changing amplitude.
  ridged(x, y, octaves = 6, lacunarity = 2, gain = 0.5, round = 0) {
    const r2 = round * round
    const scale = 1 / (1 - round)
    let sum = 0
    let amp = 0.5
    let freq = 1
    let prev = 1
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      const s = this.simplex2(x * freq, y * freq)
      let n = (1 - Math.sqrt(s * s + r2)) * scale
      n *= n
      sum += n * amp * prev
      norm += amp
      prev = n
      freq *= lacunarity
      amp *= gain
    }
    return sum / norm
  }

  // Worley/cellular, for DESIGN.md §3 item 5 -- angular fractured boundaries
  // rather than round ones. Writes into `out` instead of returning: this runs
  // per sample inside _field, the hottest path in the project, and a fresh
  // object literal per call would be millions of allocations per chunk.
  //
  //   f1, f2  distance to the nearest and second-nearest feature point
  //   o1, o2  those two cells' own random elevations, each in -1..1
  //
  // THIS USED TO RETURN F1 ALONE, and every caller of it was wrong about what
  // that meant. F1 is the distance to the nearest feature POINT: it is SMALLEST
  // AT THE POINT and largest out on the cell boundary. So `F1 < k` selects a
  // DISC AROUND EACH POINT, and using it to cut a step drew a field of round
  // dimples -- measured at 15 m radius and 9 m deep -- not fractured lines.
  //
  // The quantity that is small on a boundary is F2 - F1, which goes to zero
  // exactly where the two nearest points are equidistant. That is why f2 is
  // here. o1/o2 are what make the result a one-sided STEP rather than a
  // symmetric trench: a trench along the boundaries is a gorge, and gorges were
  // built, measured and cut for looking fake.
  worleyMesa(x, y, out) {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    let f1 = 8
    let f2 = 8
    let o1 = 0
    let o2 = 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx
        const cy = yi + dy
        // Hash the cell to a feature point inside it.
        const h = this.perm[(cx & 255) + this.perm[cy & 255]]
        const fx = cx + (h & 15) / 15
        const fy = cy + ((h >> 4) & 15) / 15
        const ddx = fx - x
        const ddy = fy - y
        const d = ddx * ddx + ddy * ddy
        // A SECOND trip through the permutation table for the cell's own
        // height. Reusing bits of `h` would tie a cell's elevation to where its
        // point happens to sit, which lays a visible diagonal drift across the
        // mosaic; re-hashing decorrelates the two.
        const off = this.perm[(h + 37) & 255] / 127.5 - 1
        if (d < f1) {
          f2 = f1
          o2 = o1
          f1 = d
          o1 = off
        } else if (d < f2) {
          f2 = d
          o2 = off
        }
      }
    }
    out.f1 = Math.sqrt(f1)
    out.f2 = Math.sqrt(f2)
    out.o1 = o1
    out.o2 = o2
    return out
  }
}
