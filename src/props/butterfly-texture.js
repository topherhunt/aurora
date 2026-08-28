// ---------------------------------------------------------------------------
// Butterfly sheets: one wing pattern (an alpha-cutout silhouette carrying its
// own markings) and one paired body tone, both generated in code.
//
// Same reasoning as props/crab-texture.js, not repeated in full here: the
// mesh (props/butterfly.js) is deliberately dumb -- two flat rectangular
// cards for wings, a thin tube for the body -- so all of a butterfly's
// identity, including its very SILHOUETTE, is carried by this texture. That
// is the fern card's trick (see props/fern.js's header) turned up one notch:
// a fern's alpha channel cuts a frond out of a rectangle, this one cuts a
// whole insect wing out of one.
//
// SHEET SHAPE: a 128 px layer holding four 64 px cells in a 2x2 grid, same
// `cellUV` addressing as the crab/mushroom sheets. Cells 0 and 1 are the two
// WING patterns ("spotted" and "rayed") -- the "2 different 64x64px texture
// patterns" the fauna brief asked for. Cells 2 and 3 are the body tones,
// PAIRED BY INDEX with the wing cell exactly like the crab's shell/limb
// pairing: a butterfly wearing wing pattern 1 wears body tone 1 (cell 3).
//
// A WING CELL is a silhouette in POLAR COORDINATES around the hinge point,
// because a wing card's whole reason to exist is that its outline (not its
// area) is a butterfly's. See wingMask below.
//
// A BODY CELL is a polar tube chart (u around, v root to tip), same as the
// crab's limbCell, because the body and antennae are swept tubes.
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
// The shipped palettes. Two wing patterns, two paired body tones. Colours
// are sRGB bytes, matching the array's SRGBColorSpace upload. Real butterfly
// colour is famously loud, so the shipped defaults lean saturated on purpose
// -- gen-butterfly.html's reroll then throws them much wider still.
// ---------------------------------------------------------------------------

export const BUTTERFLY_WING = [
  {
    name: 'spotted',
    kind: 'spots',
    base: [214, 96, 34], edge: [40, 30, 26],
    accent: [255, 214, 60], spots: 5, seed: 71,
  },
  {
    name: 'rayed',
    kind: 'rays',
    base: [70, 90, 210], edge: [18, 20, 40],
    accent: [220, 230, 255], rays: 9, seed: 72,
  },
]

export const BUTTERFLY_BODY = [
  { name: 'spotted', base: [40, 30, 26], accent: [66, 50, 42], seed: 81 },
  { name: 'rayed', base: [22, 22, 34], accent: [46, 46, 62], seed: 82 },
]

// ---------------------------------------------------------------------------
// Wing silhouette: a double-lobed radius(theta) around a hinge point near the
// cell's left edge (u=0, v=0.5), the forewing lobe reaching up and out, the
// hindwing lobe reaching down and in a little short of it -- the classic
// two-lobe fan every real wing reduces to at this resolution. A scalloped
// margin (a sine wobble plus per-texel noise) keeps the edge from reading as
// a mechanically perfect ellipse.
// ---------------------------------------------------------------------------

function lobe(theta, center, width, amp) {
  const d = (theta - center) / width
  return amp * Math.exp(-0.5 * d * d)
}

function wingRadius(theta, spec) {
  // theta = 0 points straight out from the hinge (toward the wingtip);
  // positive is the forewing side (toward the leading/upper edge), negative
  // the hindwing side.
  const fore = lobe(theta, 0.32, 0.62, 0.92)
  const hind = lobe(theta, -0.62, 0.5, 0.62)
  let r = Math.max(fore, hind)
  r *= 1 + 0.05 * Math.sin(theta * 7 + spec.seed)
  return r
}

function wingMask(u, v, spec) {
  const hx = 0.06
  const hy = 0.5
  const dx = u - hx
  const dy = v - hy
  const dist = Math.hypot(dx, dy)
  const theta = Math.atan2(hy - v, dx) // flip v so +theta is "up" (forewing side)
  const rim = wingRadius(theta, spec) * 0.86
  const n = (wrapNoise(u, v, 20, 20, spec.seed) - 0.5) * 0.05
  return dist < rim + n
}

export function wingCell(spec) {
  const px = new Uint8Array(CELL * CELL * 4)
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u = (x + 0.5) / CELL
      const v = (y + 0.5) / CELL
      const o = (y * CELL + x) * 4
      if (!wingMask(u, v, spec)) {
        px[o + 3] = 0
        continue
      }

      const hx = 0.06
      const hy = 0.5
      const dist = Math.hypot(u - hx, v - hy)
      const theta = Math.atan2(hy - v, u - hx)

      let r = spec.base[0]
      let g = spec.base[1]
      let b = spec.base[2]

      if (spec.kind === 'spots') {
        // Rings of colour outward from the hinge, wobbled so they read as
        // organic bands rather than a dartboard, plus a ring of round
        // accent spots (the classic eyespot/marginal-spot look) toward the
        // outer edge.
        const band = Math.sin(dist * spec.spots * Math.PI * 2 - theta * 1.4) * 0.5 + 0.5
        const t = smoothstep(0.35, 0.65, band)
        r = mix(r, spec.edge[0], t * 0.5)
        g = mix(g, spec.edge[1], t * 0.5)
        b = mix(b, spec.edge[2], t * 0.5)

        const spotLattice = wrapNoise(u * 3, v * 3, 6, 6, spec.seed + 5)
        const nearRim = smoothstep(0.55, 0.82, dist / (wingRadius(theta, spec) * 0.86 + 1e-4))
        const spot = smoothstep(0.62, 0.72, spotLattice) * nearRim
        r = mix(r, spec.accent[0], spot)
        g = mix(g, spec.accent[1], spot)
        b = mix(b, spec.accent[2], spot)
      } else {
        // Rays: alternating light/dark wedges fanned out from the hinge --
        // the vein-and-band look of a fritillary or a monarch.
        const wedge = Math.sin(theta * spec.rays + dist * 4) * 0.5 + 0.5
        const t = smoothstep(0.4, 0.6, wedge)
        r = mix(spec.edge[0], r, t)
        g = mix(spec.edge[1], g, t)
        b = mix(spec.edge[2], b, t)

        const vein = smoothstep(0.06, 0.0, Math.abs(Math.sin(theta * spec.rays * 2)) * dist)
        r = mix(r, spec.accent[0], vein * 0.5)
        g = mix(g, spec.accent[1], vein * 0.5)
        b = mix(b, spec.accent[2], vein * 0.5)
      }

      // Margin darkening: the outer rim of a real wing is almost always the
      // darkest part of it.
      const rim = wingRadius(theta, spec) * 0.86
      const edgeT = smoothstep(rim * 0.78, rim, dist)
      r = mix(r, spec.edge[0], edgeT * 0.7)
      g = mix(g, spec.edge[1], edgeT * 0.7)
      b = mix(b, spec.edge[2], edgeT * 0.7)

      const tooth = hash2(x, y, spec.seed + 13) * 0.7 + wrapNoise(u, v, 24, 24, spec.seed + 19) * 0.3
      const bite = 1 + (tooth - 0.5) * 0.16
      r *= bite
      g *= bite
      b *= bite

      px[o] = clamp255(r)
      px[o + 1] = clamp255(g)
      px[o + 2] = clamp255(b)
      px[o + 3] = 255
    }
  }
  return px
}

// A plain fuzzy tube tone for the body and antennae -- opaque, no cutout,
// same reasoning as the crab's limbCell.
export function bodyCell(spec) {
  const px = new Uint8Array(CELL * CELL * 4)
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u = (x + 0.5) / CELL
      const v = (y + 0.5) / CELL

      let shade = mix(1.05, 0.82, v)
      const n = wrapNoise(u, v, 10, 5, spec.seed) * 0.6 + wrapNoise(u, v, 26, 12, spec.seed + 6) * 0.4
      shade *= 1 + (n - 0.5) * 0.3

      let r = spec.base[0] * shade
      let g = spec.base[1] * shade
      let b = spec.base[2] * shade

      const band = smoothstep(0.45, 0.55, Math.sin(v * 26) * 0.5 + 0.5)
      r = mix(r, spec.accent[0] * shade, band * 0.35)
      g = mix(g, spec.accent[1] * shade, band * 0.35)
      b = mix(b, spec.accent[2] * shade, band * 0.35)

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
// Sheet assembly -- a 2x2 grid of 64 px cells in one 128 px layer.
//
//     wing 0    wing 1
//     body 0    body 1
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

export function butterflyWingSheet(wingSpecs = BUTTERFLY_WING, bodySpecs = BUTTERFLY_BODY) {
  return pack([wingCell(wingSpecs[0]), wingCell(wingSpecs[1]), bodyCell(bodySpecs[0]), bodyCell(bodySpecs[1])])
}

export const BUTTERFLY_CELL_PX = CELL
