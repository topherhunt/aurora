// ---------------------------------------------------------------------------
// Mushroom sheets: two cap palettes and one flesh sheet, all generated in code.
//
// WHY THIS IS CODE AND NOT A PNG.
//
// Every other textured prop in this project wears a photograph, because a fern
// frond and a granite face are things you cannot write down: the frond's shape
// IS its alpha channel, and stone is noise all the way down. A mushroom is the
// opposite case on both counts. Its shape is geometry (props/mushroom.js), so
// there is no cutout to store, and what is left for the texture to carry is a
// list of about five things -- a flat colour, a rim shade, warts, radial
// fibres, gills -- each of which is one line of arithmetic. Photographing that
// would be storing the output of a function instead of the function.
//
// So the mushroom costs ZERO BYTES ON DISK beyond this file, no `npm run props`
// step, no entry in IMAGE_LAYERS, and nothing that can 404. Adding a colour is
// an edit to an array below, not a trip through Blender. That is the same trade
// the fern bench already prices out loud -- "adding a variant costs 0 bytes" --
// taken one step further, because here even the first variant is free.
//
// WHY NOT VERTEX COLOURS INSTEAD, WHICH WOULD COST NOTHING AT ALL.
//
// Because they are architecturally unavailable, and it is worth writing down
// exactly why so nobody re-proposes it. `createPropMaterial` is built with
// `vertexColors: false` and must stay that way: turning it on changes the
// compiled program, and BatchedMesh fixes its attribute set from the FIRST
// geometry it is handed and then throws on any later geometry missing one
// (`BatchedMesh: Added geometry missing "color"`). So a `color` attribute on a
// mushroom is not a mushroom decision -- it is a demand that every tree, rock,
// fern and grass blade in the same batch grow a third vertex attribute they do
// not use. src/material.js states this rule three separate times.
//
// What IS free is the per-instance tint, `BatchedMesh.setColorAt`, which needs
// no material flag at all. That is left for what a per-instance multiply is
// actually good at: a gentle value and warmth jitter so no two mushrooms in one
// clump are the same mushroom twice. It cannot do the main job, because a
// multiply has ONE hue and a fly agaric is a scarlet cap on a WHITE stem.
//
// HOW A CELL IS ADDRESSED.
//
// Each sheet is 128 px holding a 2x2 grid of 64 px cells, and a geometry picks
// its cell by UV offset (`capCell` / `fleshCell` in props/mushroom.js). 2x2 and
// not 4x4 because sheet cells bleed into one another in the low mips, and at
// 32 px a cell has two usable mip levels before it is averaging its neighbours.
//
// THE CAP CELL IS A POLAR CHART. Its u axis is the angle around the cap and its
// v axis is the distance from apex (0) to rim (1), because that is how a
// surface of revolution is unwrapped and because everything a cap wears is
// radial. Two consequences worth stating: a wart drawn at radius v has to be
// stretched in u by 1/v to come out round on the mushroom, and the chart must
// be seamless across u = 0 = 1 or every cap gets a meridian.
//
// THE FLESH CELL IS SHARED BY THE UNDERSIDE, THE STEM AND THE RING, and that is
// not a compromise -- gills radiating from the axis and fibres running up a
// stalk are the same picture, lines of constant u. They differ only in
// contrast, so the stripes harden toward v = 0 (deep under the cap, where gills
// live) and soften toward v = 1 (the stem band). See STEM_V in props/mushroom.js
// for which slice of v the stalk actually samples.
//
// GLOWING MUSHROOMS are not built and this is where they will hook in. The
// cheap version is a third sheet whose cells are the emissive mask, added
// rather than multiplied in the fragment shader for the handful of variants
// that want it -- which is a material change, not a texture one, and should not
// be pre-paid here. Nothing below forecloses it.
// ---------------------------------------------------------------------------

const SHEET = 128
const CELL = 64
const GRID = 2

// ---------------------------------------------------------------------------
// Noise that WRAPS in u.
//
// Load-bearing, not a nicety: u is an angle, so a noise field that does not
// close at u = 1 draws a seam from the apex to the rim of every cap in the
// world. Built from a lattice whose x index is taken modulo the period, which
// is the same trick preview-stage.js uses to keep its ground tileable.
// ---------------------------------------------------------------------------

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 3266489917)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

const smooth = (t) => t * t * (3 - 2 * t)

// Value noise on a `pu` x `pv` lattice, periodic in u.
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

// Shortest signed distance between two angles expressed as u in [0,1).
function wrapDelta(a, b) {
  let d = a - b
  if (d > 0.5) d -= 1
  else if (d < -0.5) d += 1
  return d
}

const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x))
const mix = (a, b, t) => a + (b - a) * t
const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// The shipped palettes.
//
// Two cap sheets rather than one, split by WHERE rather than by hue, because
// that is the decision the world actually makes: a forest floor wants colours
// that have been rained on, and a cave wants the ones that never saw the sun.
// Splitting them also means a cave scatter and a forest scatter never sample
// each other's cells across a mip boundary.
//
// Colours are sRGB BYTES, because the array is uploaded as SRGBColorSpace --
// so these are the numbers you would pick in a colour picker, not the linear
// values props/shapes.js mixes. Every one of them is a real fungus read a
// little further toward saturation, which is the whole of "mildly fantasy":
// the shapes and the hues are ones you could find, they are just more sure of
// themselves than the real thing on an overcast day.
// ---------------------------------------------------------------------------

export const CAP_FOREST = [
  {
    name: 'scarlet',
    // Fly agaric. The one mushroom everybody can already picture, which makes
    // it the one worth getting exactly right -- and the reason cap colour lives
    // in this sheet rather than in a per-instance tint, since its stem is white.
    base: [198, 44, 30], edge: 0.72, centre: 1.12,
    pattern: 'warts', accent: [240, 236, 220], accentN: 66, accentSize: 0.05,
    grain: 0.09, seed: 11,
  },
  {
    name: 'chestnut',
    // Bolete / porcini. Darker at the crown because that is the part the
    // weather reaches, which is true of most brown caps and is the single
    // cheapest cue that a cap is a dome rather than a disc.
    base: [134, 88, 52], edge: 1.14, centre: 0.78,
    pattern: 'fibres', accent: [92, 58, 34], accentN: 26, accentSize: 0,
    grain: 0.13, seed: 12,
  },
  {
    name: 'ivory',
    // Field mushroom, young. Also the cheapest thing to tint per instance --
    // a near-neutral cap is the one cell where setColorAt has real range, so
    // this is the cell a scatter reaches for when it wants an unnamed colour.
    base: [216, 205, 180], edge: 0.9, centre: 1.05,
    pattern: 'scales', accent: [176, 160, 132], accentN: 5, accentSize: 0,
    grain: 0.07, seed: 13,
  },
  {
    name: 'amber',
    // Chanterelle. Wrinkled rather than gilled, and paired in the bank with a
    // negative `capRise` -- the funnel is half of what makes it read.
    base: [220, 152, 54], edge: 1.06, centre: 0.86,
    pattern: 'wrinkles', accent: [168, 106, 30], accentN: 22, accentSize: 0,
    grain: 0.1, seed: 14,
  },
]

export const CAP_CAVE = [
  {
    name: 'violet',
    // Wood blewit, pushed. The most convincingly unreal colour that is also a
    // real one, which is exactly the register the brief asked for.
    base: [124, 86, 168], edge: 0.78, centre: 1.1,
    pattern: 'fibres', accent: [78, 52, 118], accentN: 30, accentSize: 0,
    grain: 0.11, seed: 21,
  },
  {
    name: 'verdigris',
    // Stropharia. Blue-green caps exist and nobody believes them, which makes
    // this the cell that will carry a cave's colour identity.
    base: [72, 152, 148], edge: 0.84, centre: 1.06,
    pattern: 'scales', accent: [206, 224, 214], accentN: 7, accentSize: 0,
    grain: 0.1, seed: 22,
  },
  {
    name: 'bone',
    // The pale, etiolated thing that grows with no light at all. Deliberately
    // low-contrast: in a cave it is lit by whatever the player brought.
    base: [204, 198, 186], edge: 0.86, centre: 1.04,
    pattern: 'warts', accent: [166, 158, 146], accentN: 46, accentSize: 0.045,
    grain: 0.06, seed: 23,
  },
  {
    name: 'ink',
    // Near-black with a cold cast. Reads as a silhouette rather than as an
    // object, which is what the biggest cave caps want to do overhead.
    base: [58, 54, 66], edge: 1.35, centre: 0.7,
    pattern: 'wrinkles', accent: [30, 28, 38], accentN: 16, accentSize: 0,
    grain: 0.14, seed: 24,
  },
]

export const FLESH = [
  {
    // White gills on a white stalk. The default, and the partner to `scarlet`.
    name: 'white', base: [226, 220, 206], gills: 42, dark: 0.42, grain: 0.07, pattern: 'gills', seed: 31,
  },
  {
    // Cream stalk, buff gills -- the brown-cap partner.
    name: 'buff', base: [200, 182, 148], gills: 38, dark: 0.5, grain: 0.09, pattern: 'gills', seed: 32,
  },
  {
    // A pored underside (bolete) rather than a gilled one. Different enough at
    // arm's length to be worth a cell of its own: pores read as a sponge and
    // gills as a fan, and a forest with both in it stops looking like one plant.
    name: 'pored', base: [206, 190, 132], gills: 0, dark: 0.46, grain: 0.1, pattern: 'pores', seed: 33,
  },
  {
    // Dark, for the cave palette and for anything mature enough to have dropped
    // its spores over its own stalk.
    name: 'dusk', base: [128, 118, 122], gills: 46, dark: 0.55, grain: 0.11, pattern: 'gills', seed: 34,
  },
]

// ---------------------------------------------------------------------------
// Cell painters. Each returns a CELL x CELL RGBA buffer.
//
// Alpha is 255 everywhere and must stay that way. A mushroom is an opaque
// closed solid, and the shared prop material runs `alphaTest: 0.5` with
// `transparent: false` -- so any texel that dips under 128 is not a soft edge,
// it is a HOLE punched through the cap.
// ---------------------------------------------------------------------------

export function capCell(spec) {
  const px = new Uint8Array(CELL * CELL * 4)

  // Warts are pre-placed on rings rather than rolled per pixel, so their count
  // is exactly `accentN` and their spacing is even. Count per ring goes as the
  // ring's circumference, which is what stops them bunching at the apex.
  const warts = []
  if (spec.pattern === 'warts') {
    // Placed on rings rather than rolled per pixel, so the count is exactly
    // `accentN` and the spacing is even. Each ring's share is proportional to
    // its own RADIUS, because that is proportional to its circumference -- the
    // ring at v = 0.9 has six times the room of the one at v = 0.15, and
    // splitting them evenly is what piles warts up at the crown. Normalised
    // against the total rather than accumulated with a running cap, which
    // would spend the whole budget on the inner rings and leave the rim bare.
    // Rings stop short of the rim on purpose. A fly agaric's veil remnants sit
    // on the crown and the outer eighth is usually bare and striate, and the
    // texture agrees: see the arc-radius floor below for why the rim is the one
    // place a physically-sized wart cannot be drawn at this resolution anyway.
    const rings = 5
    const vs = Array.from({ length: rings }, (_, r) => 0.14 + 0.62 * (r / (rings - 1)))
    const total = vs.reduce((a, b) => a + b, 0)
    vs.forEach((v, r) => {
      const want = Math.max(1, Math.round((spec.accentN * v) / total))
      for (let i = 0; i < want; i++) {
        warts.push({
          // Half a cell of stagger between rings, so they do not line up into
          // radial spokes.
          u: (i + 0.5 + (r % 2) * 0.5) / want + (hash2(r, i, spec.seed) - 0.5) * (0.55 / want),
          v: v + (hash2(r, i + 99, spec.seed) - 0.5) * 0.14,
          r: spec.accentSize * (0.62 + hash2(r, i + 7, spec.seed) * 0.7),
        })
      }
    })
  }

  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u = (x + 0.5) / CELL // angle around the cap
      const v = (y + 0.5) / CELL // apex (0) to rim (1)

      // The radial value ramp. Every cap has one and its SIGN is most of the
      // cap's character: a bolete is dark at the crown, a russula pale there.
      let shade = mix(spec.centre, spec.edge, Math.pow(v, 0.8))

      // Grain, at two frequencies so it does not read as a single screen door.
      const n = wrapNoise(u, v, 8, 6, spec.seed) * 0.62 + wrapNoise(u, v, 24, 18, spec.seed + 5) * 0.38
      shade *= 1 + (n - 0.5) * 2 * spec.grain

      let r = spec.base[0] * shade
      let g = spec.base[1] * shade
      let b = spec.base[2] * shade

      if (spec.pattern === 'fibres') {
        // Radial streaks: a line of constant angle, so noise in u ONLY. This is
        // the pattern that most says "the cap grew outward from the middle".
        // Two octaves, so the streaks vary in width instead of reading as
        // even corduroy. And TWO-SIDED: the previous version clamped k at 0,
        // which threw away half the signal -- every streak the noise put below
        // the midpoint simply did not exist, and on a low-contrast accent
        // (chestnut, violet) that left the cell looking flat.
        const f = wrapNoise(u, 0.5, spec.accentN, 1, spec.seed + 3) * 0.68
                + wrapNoise(u, 0.5, spec.accentN * 3, 1, spec.seed + 13) * 0.32
        const k = (f - 0.5) * 2 * Math.pow(v, 0.45)
        if (k > 0) {
          r = mix(r, spec.accent[0], k * 0.75)
          g = mix(g, spec.accent[1], k * 0.75)
          b = mix(b, spec.accent[2], k * 0.75)
        } else {
          const lift = 1 - k * 0.26
          r *= lift
          g *= lift
          b *= lift
        }
      } else if (spec.pattern === 'wrinkles') {
        // Ridges running apex-to-rim, which is what a chanterelle has instead
        // of gills and what an old cap cracks into. Amplitude grows with v
        // because the ridges fan apart as the cap widens.
        // The wander has to depend on v as well as u or the ridges come out
        // as dead-straight corduroy: a chanterelle's fold snakes and forks on
        // its way to the rim. Two scales of it, and the ridge is sharpened
        // with a power so it reads as a crease rather than as a sine wave.
        const wander = (wrapNoise(u, v, 5, 4, spec.seed + 8) - 0.5) * 4.2
                     + (wrapNoise(u, v, 13, 9, spec.seed + 21) - 0.5) * 1.8
        const phase = u * spec.accentN * Math.PI * 2 + wander
        const ridge = Math.cos(phase) * 0.5 + 0.5
        const k = Math.pow(1 - ridge, 1.6) * 0.62 * Math.pow(v, 0.6)
        r = mix(r, spec.accent[0], k)
        g = mix(g, spec.accent[1], k)
        b = mix(b, spec.accent[2], k)
      } else if (spec.pattern === 'scales') {
        // Concentric torn bands -- the cuticle splitting as the cap expands.
        // The band edge is jittered in u so it reads as tearing rather than as
        // a set of drawn circles.
        const wobble = (wrapNoise(u, v, 9, 3, spec.seed + 2) - 0.5) * 0.3
        const band = (v + wobble) * spec.accentN
        const edge = Math.abs(band - Math.round(band))
        // Break each ring along its length. Without this the bands close into
        // continuous circles and the cap reads as a contour map; a cuticle
        // splits into discrete plates with bare cap showing between them. The
        // mask is keyed on the band INDEX as well as u, so neighbouring rings
        // tear in different places rather than lining up into radial cracks.
        const gap = wrapNoise(u, Math.round(band) / spec.accentN, 7, 5, spec.seed + 17)
        const plate = smoothstep(0.3, 0.52, gap)
        const k = (1 - smoothstep(0.06, 0.2, edge)) * 0.62 * smoothstep(0.15, 0.5, v) * plate
        r = mix(r, spec.accent[0], k)
        g = mix(g, spec.accent[1], k)
        b = mix(b, spec.accent[2], k)
      } else if (spec.pattern === 'warts') {
        for (const w of warts) {
          // The 1/v correction, and the reason this chart is polar. u is an
          // angle, so at radius v one unit of u is 2*pi*v of arc -- draw a
          // circle in chart space and it comes out as a fat lens at the rim
          // and a needle at the crown. Measuring the u offset in ARC LENGTH
          // instead makes the wart round on the actual cap at every radius.
          const arc = wrapDelta(u, w.u) * Math.PI * 2 * Math.max(v, 0.09)
          const rad = v - w.v
          // Two radii, not one, and the difference is a RESOLUTION limit rather
          // than a modelling choice. A wart of physical radius w.r sitting at
          // radius v spans w.r / (2*pi*v) of the u axis -- at the rim of a 64 px
          // cell that is half a pixel, so a correctly-sized wart there aliases
          // into a dashed line. The arc radius is therefore floored at ~1.6 px
          // of u. It stretches the outermost warts tangentially, which is what
          // a real veil remnant does as the cap expands under it, and it leaves
          // the radial size honest.
          const ra = Math.max(w.r, (1.6 / CELL) * Math.PI * 2 * Math.max(v, 0.09))
          const d = Math.hypot(arc / ra, rad / Math.max(1e-4, w.r))
          if (d < 1.15) {
            // Warts are raised, so their own far edge is in shadow. One term,
            // and it is what stops them reading as printed dots.
            const lit = 1 + 0.16 * (1 - smoothstep(0, 1, d)) - 0.22 * smoothstep(0.55, 1.05, d)
            const k = (1 - smoothstep(0.55, 1.05, d)) * 0.95
            r = mix(r, spec.accent[0] * lit, k)
            g = mix(g, spec.accent[1] * lit, k)
            b = mix(b, spec.accent[2] * lit, k)
          }
        }
      }

      const o = (y * CELL + x) * 4
      px[o] = clamp255(r)
      px[o + 1] = clamp255(g)
      px[o + 2] = clamp255(b)
      px[o + 3] = 255
    }
  }
  return px
}

export function fleshCell(spec) {
  const px = new Uint8Array(CELL * CELL * 4)

  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u = (x + 0.5) / CELL // around the axis, both for gills and for the stalk
      const v = (y + 0.5) / CELL // 0 = deep under the cap, 1 = rim / stem base

      // Ambient occlusion, painted. The underside of a cap is genuinely dark
      // where it meets the stalk and genuinely bright at the rim, and this
      // gradient is doing the job a real AO term would -- which the prop
      // material does not have and is not worth adding for one prop.
      let shade = mix(0.46, 1.0, Math.pow(v, 0.75))
      const n = wrapNoise(u, v, 10, 8, spec.seed) * 0.6 + wrapNoise(u, v, 30, 22, spec.seed + 4) * 0.4
      shade *= 1 + (n - 0.5) * 2 * spec.grain

      let groove = 0
      if (spec.pattern === 'gills' && spec.gills > 0) {
        // Lines of constant u. The contrast RAMPS with v rather than being
        // constant, because this cell is two pictures at once: hard gills near
        // the axis, and soft stalk fibres in the band the stem samples.
        const t = u * spec.gills
        const d = Math.abs(t - Math.round(t)) * 2 // 0 at the groove, 1 between
        const hardness = mix(1.0, 0.22, smoothstep(0.35, 0.95, v))
        groove = (1 - smoothstep(0.1, 0.72, d)) * spec.dark * hardness
      } else if (spec.pattern === 'pores') {
        // A sponge, not a fan. Same v ramp so the stem band stays a stem: the
        // pores fade out and leave the faint lengthwise fibre underneath.
        // A LATTICE, not two noise fields thresholded together -- that gave
        // continent-shaped blotches, which read as camouflage rather than as a
        // bolete's underside. Each lattice cell holds one jittered disc, and
        // the jitter is kept inside its own cell so the count stays even and
        // the u = 0 join cannot cut a pore in half.
        const PU = 30
        const PV = 22
        const iu = Math.floor(u * PU)
        const iv = Math.floor(v * PV)
        const cx = iu + 0.25 + hash2(iu, iv, spec.seed + 6) * 0.5
        const cy = iv + 0.25 + hash2(iu, iv, spec.seed + 9) * 0.5
        const dot = 1 - smoothstep(0.26, 0.44, Math.hypot(u * PU - cx, v * PV - cy))
        const fibre = 1 - smoothstep(0.12, 0.6, Math.abs(u * 34 - Math.round(u * 34)) * 2)
        const hardness = mix(1.0, 0.2, smoothstep(0.35, 0.95, v))
        groove = mix(fibre * 0.4, dot, smoothstep(0.95, 0.35, v)) * spec.dark * hardness
      }

      shade *= 1 - groove

      const o = (y * CELL + x) * 4
      px[o] = clamp255(spec.base[0] * shade)
      px[o + 1] = clamp255(spec.base[1] * shade)
      px[o + 2] = clamp255(spec.base[2] * shade)
      px[o + 3] = 255
    }
  }
  return px
}

// ---------------------------------------------------------------------------
// Sheet assembly. Four cells into one 128 px layer, in reading order:
//   0 1
//   2 3
// which is what `cellUV` in props/mushroom.js decodes, so the two files have to
// agree about this and nothing else.
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

export function mushroomCapSheet(specs = CAP_FOREST) {
  return pack(specs.map(capCell))
}

export function mushroomCaveSheet(specs = CAP_CAVE) {
  return pack(specs.map(capCell))
}

export function mushroomFleshSheet(specs = FLESH) {
  return pack(specs.map(fleshCell))
}

export const MUSHROOM_CELL_PX = CELL
