// ---------------------------------------------------------------------------
// Crab sheet: one palette, worn by the carapace AND every limb -- legs, arm,
// claws, eyestalks all sample the same 64 px cell as the shell they hang off,
// generated in code.
//
// Same reasoning as props/mushroom-texture.js, not repeated in full here: a
// crab's shape is geometry (props/crab.js) and what is left for the texture
// to carry is a mottled shell colour -- a handful of arithmetic terms, not a
// photograph. Zero bytes on disk, no IMAGE_LAYERS entry, adding a colour is
// an edit to the array below.
//
// SHEET SHAPE: a 128 px layer holding four 64 px cells in a 2x2 grid, same
// `cellUV`/`capUV` addressing as the mushroom sheets (props/crab.js).
//
// EVERY SURFACE READS THE SAME CELL through two different charts. The
// carapace is addressed by its own planar projection (see capUV in
// props/crab.js), which is affine in the carapace's local x/z, so the GPU's
// linear interpolation is exact regardless of triangle count and there is no
// polar seam to manage. A limb is addressed by a polar chart, u around the
// tube and v from body to tip, because every limb -- leg, arm, claw,
// eyestalk -- is a swept tube and a tube's natural chart is (angle, length
// along). The cell's own mottling is noisy enough that either chart reads as
// the same animal's hide.
// ---------------------------------------------------------------------------

const SHEET = 128
const CELL = 64
const GRID = 2

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 3266489917)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

const smooth = (t) => t * t * (3 - 2 * t)

// Value noise on a `pu` x `pv` lattice, periodic in u -- load-bearing on the
// limb cell (u is an angle around the tube) and simply unused on the disc.
function wrapNoise(u, v, pu, pv, seed) {
  const fx = u * pu
  const fy = v * pv
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = smooth(fx - ix)
  const ty = smooth(fy - iy)
  const x0 = ((ix % pu) + pu) % pu
  const x1 = (x0 + 1) % pu
  const a = hash2(x0, iy, seed)
  const b = hash2(x1, iy, seed)
  const c = hash2(x0, iy + 1, seed)
  const d = hash2(x1, iy + 1, seed)
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
}

const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x))
const mix = (a, b, t) => a + (b - a) * t
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// The shipped palettes. Four species per sheet, one per cell of the 2x2 grid.
// Colours are sRGB bytes, matching the array's SRGBColorSpace upload.
// ---------------------------------------------------------------------------

export const CRAB_SHELL = [
  {
    name: 'russet',
    base: [150, 74, 40], edge: 0.8, centre: 1.12,
    accent: [92, 44, 26], accentN: 5, grain: 0.22, seed: 41,
  },
  {
    name: 'cobalt',
    base: [58, 92, 132], edge: 0.82, centre: 1.14,
    accent: [26, 46, 74], accentN: 6, grain: 0.2, seed: 42,
  },
  {
    name: 'sand',
    base: [198, 168, 118], edge: 0.88, centre: 1.06,
    accent: [150, 120, 78], accentN: 4, grain: 0.16, seed: 43,
  },
  {
    name: 'moss',
    base: [92, 110, 62], edge: 0.82, centre: 1.12,
    accent: [54, 68, 34], accentN: 5, grain: 0.2, seed: 44,
  },
]

// ---------------------------------------------------------------------------
// Cell painter. Alpha is 255 everywhere -- a crab is an opaque closed solid
// and the shared prop material runs alphaTest 0.5 with transparent: false, so
// any texel under 128 is a hole punched through the shell, not a soft edge.
// ---------------------------------------------------------------------------

export function shellCell(spec) {
  const px = new Uint8Array(CELL * CELL * 4)
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const cx = (x + 0.5) / CELL
      const cy = (y + 0.5) / CELL
      const dx = cx * 2 - 1
      const dy = cy * 2 - 1
      const rr = Math.hypot(dx, dy)
      const v = Math.min(1, rr) // apex (0) to rim (1)

      let shade = mix(spec.centre, spec.edge, Math.pow(v, 0.8))
      const n = wrapNoise(cx, cy, 8, 6, spec.seed) * 0.44
              + wrapNoise(cx, cy, 24, 18, spec.seed + 5) * 0.28
              + hash2(x, y, spec.seed + 31) * 0.28
      shade *= 1 + (n - 0.5) * 2 * spec.grain

      let r = spec.base[0] * shade
      let g = spec.base[1] * shade
      let b = spec.base[2] * shade

      // Mottling: irregular blotches of the accent colour, two lattice scales
      // thresholded together so the patches vary in size rather than reading
      // as an even dot screen. This is the "not just a boring colour" mark.
      const p1 = wrapNoise(cx, cy, spec.accentN, spec.accentN, spec.seed + 3)
      const p2 = wrapNoise(cx, cy, spec.accentN * 2.3, spec.accentN * 2.3, spec.seed + 17)
      const patch = smoothstep(0.4, 0.6, p1 * 0.7 + p2 * 0.3)
      r = mix(r, spec.accent[0] * shade, patch * 0.85)
      g = mix(g, spec.accent[1] * shade, patch * 0.85)
      b = mix(b, spec.accent[2] * shade, patch * 0.85)

      // Per-texel tooth so a saturated shell does not read as flat plastic.
      const tooth = hash2(x, y, spec.seed + 47) * 0.62
                  + wrapNoise(cx, cy, 32, 24, spec.seed + 53) * 0.38
      const bite = 1 + (tooth - 0.5) * 2 * spec.grain * 0.34
      r *= bite
      g *= bite
      b *= bite

      const o = (y * CELL + x) * 4
      px[o] = clamp255(r)
      px[o + 1] = clamp255(g)
      px[o + 2] = clamp255(b)
      px[o + 3] = 255
    }
  }
  return px
}

// ---------------------------------------------------------------------------
// Sheet assembly -- a 2x2 grid of 64 px cells in one 128 px layer, same shape
// as the mushroom sheets so `cellUV`/`capUV` in props/crab.js decode either.
//
//     0 1
//     2 3
// ---------------------------------------------------------------------------

function pack(cells) {
  const out = new Uint8Array(SHEET * SHEET * 4)
  for (let i = 0; i < GRID * GRID; i++) {
    const cell = cells[i % cells.length]
    const ox = (i % GRID) * CELL
    const oy = Math.floor(i / GRID) * CELL
    for (let y = 0; y < CELL; y++) {
      const src = y * CELL * 4
      const dst = ((oy + y) * SHEET + ox) * 4
      out.set(cell.subarray(src, src + CELL * 4), dst)
    }
  }
  return out
}

export function crabShellSheet(specs = CRAB_SHELL) {
  return pack(specs.map(shellCell))
}

export const CRAB_CELL_PX = CELL
