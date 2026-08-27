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
// Each sheet is a 128 px layer holding four 64 px cells in a 2x2 grid, and a
// geometry picks its cell by UV offset (`cellUV` in props/mushroom.js). 2x2 and
// not 4x4 because sheet cells bleed into one another in the low mips, and at
// 32 px a cell has two usable mip levels before it is averaging its neighbours.
//
// THE TWO SHEET KINDS ARE THE SAME SHAPE AND MEAN DIFFERENT THINGS.
//
// A CAP CELL IS A DISC seen from above: the cap's rim inscribed in the square,
// the corners unused. The mesh gets it by projecting along the cap's own axis,
// which makes UV affine in the cap's local x and z and so makes the hardware's
// interpolation exact -- see CAP below, which is the whole argument.
//
// A FLESH CELL IS A POLAR CHART, u the angle and v the distance from the axis,
// because gills and stalk fibres are lines of constant u and because the
// underside is never seen from straight on. Its u wraps, so `wrapNoise` and the
// seam gate still matter there.
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

// A CAP CELL IS A DISC SEEN FROM ABOVE, not a polar chart, and that is the one
// decision the fly agaric's spots depend on.
//
// The obvious layout for a surface of revolution is the polar chart -- u the
// angle round the cap, v apex to rim -- and it was the layout here, and it has
// a defect that no amount of resolution fixes. A polar chart has to be UNROLLED
// onto the mesh, and the mesh is a fan of `radial` triangles meeting at the
// apex. Each triangle carries a WEDGE of the chart, 360/radial degrees wide,
// and the GPU interpolates u linearly across it while the true angle does not
// vary linearly across a flat triangle at all. Two artefacts follow and both
// get worse toward the middle:
//
//   The chart is sliced at every wedge boundary. A wart of radius 0.05 sitting
//   at v = 0.14 spans 11% of the u axis, which on the fly agaric's 9-gon is
//   1.02 wedges -- WIDER THAN A WHOLE TRIANGLE, so it is guaranteed to be cut
//   by at least one edge and to kink there.
//
//   And v is interpolated as the ring parameter while the surface crosses the
//   chord, so the texture runs 6% long in radius inside every wedge (9-gon),
//   pulling the spot into a lens.
//
// A planar overlay has neither, because projecting the cap along its own axis
// makes u and v AFFINE functions of the cap's local x and z -- and a triangle's
// x and z are already linear in its barycentric coordinates, so the hardware's
// linear interpolation is EXACT. Triangle count stops being a texture problem
// and goes back to being only a silhouette problem. The chart also has no apex
// singularity to pinch and no angular seam to close, so the whole class of
// bugs that `wrapNoise` and the u-inset existed to manage simply is not there.
//
// SO: CAP x CAP texels, the cap's rim inscribed as a circle, and the corners
// outside it filled by clamping the radius (below) so a bilinear tap at the
// disc edge finds more rim rather than a cell boundary.
//
// The cost is the corners: pi/4 of the cell is the disc, so 21.5% of the texels
// are never sampled. It buys back more than it costs. A wart at the rim is 3.2
// texels across here, exactly what the 128 x 32 polar strip gave it, but it is
// 3.2 texels across AT EVERY RADIUS instead of ballooning to 15 near the apex
// where the chart had to spend u to stay round -- and none of it is sliced.
//
// The one real loss is at the skirt. A planar projection samples by projected
// radius, so a steep rim gets fewer texels per unit of surface: on the fly
// agaric's profile the rim slope is 57 degrees, which is 1.9x compression in
// the last few texels. That is also what a decal projected from above genuinely
// looks like, and it is how a real cap photographs from above, so it reads as
// foreshortening rather than as an error.
const CAP = CELL

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
    grain: 0.2, seed: 11,
  },
  {
    name: 'chestnut',
    // Bolete / porcini. Darker at the crown because that is the part the
    // weather reaches, which is true of most brown caps and is the single
    // cheapest cue that a cap is a dome rather than a disc.
    base: [134, 88, 52], edge: 1.14, centre: 0.78,
    pattern: 'fibres', accent: [92, 58, 34], accentN: 26, accentSize: 0,
    grain: 0.22, seed: 12,
  },
  {
    name: 'ivory',
    // Field mushroom, young. Also the cheapest thing to tint per instance --
    // a near-neutral cap is the one cell where setColorAt has real range, so
    // this is the cell a scatter reaches for when it wants an unnamed colour.
    base: [216, 205, 180], edge: 0.9, centre: 1.05,
    pattern: 'scales', accent: [176, 160, 132], accentN: 5, accentSize: 0,
    grain: 0.16, seed: 13,
  },
  {
    name: 'amber',
    // Chanterelle. Wrinkled rather than gilled, and paired in the bank with a
    // negative `capRise` -- the funnel is half of what makes it read.
    base: [220, 152, 54], edge: 1.06, centre: 0.86,
    pattern: 'wrinkles', accent: [168, 106, 30], accentN: 22, accentSize: 0,
    grain: 0.19, seed: 14,
  },
]

export const CAP_CAVE = [
  {
    name: 'violet',
    // Wood blewit, pushed. The most convincingly unreal colour that is also a
    // real one, which is exactly the register the brief asked for.
    base: [124, 86, 168], edge: 0.78, centre: 1.1,
    pattern: 'fibres', accent: [78, 52, 118], accentN: 30, accentSize: 0,
    grain: 0.2, seed: 21,
  },
  {
    name: 'verdigris',
    // Stropharia. Blue-green caps exist and nobody believes them, which makes
    // this the cell that will carry a cave's colour identity.
    base: [72, 152, 148], edge: 0.84, centre: 1.06,
    pattern: 'scales', accent: [206, 224, 214], accentN: 7, accentSize: 0,
    grain: 0.19, seed: 22,
  },
  {
    name: 'bone',
    // The pale, etiolated thing that grows with no light at all. Deliberately
    // low-contrast: in a cave it is lit by whatever the player brought.
    base: [204, 198, 186], edge: 0.86, centre: 1.04,
    pattern: 'warts', accent: [166, 158, 146], accentN: 46, accentSize: 0.045,
    grain: 0.15, seed: 23,
  },
  {
    name: 'ink',
    // Near-black with a cold cast. Reads as a silhouette rather than as an
    // object, which is what the biggest cave caps want to do overhead.
    base: [58, 54, 66], edge: 1.35, centre: 0.7,
    pattern: 'wrinkles', accent: [30, 28, 38], accentN: 16, accentSize: 0,
    grain: 0.24, seed: 24,
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
  const px = new Uint8Array(CAP * CAP * 4)

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
    // Rings stop short of the rim on purpose: a fly agaric's veil remnants sit
    // on the crown, and the outer eighth is usually bare and striate. It also
    // keeps every wart clear of the skirt, which is the one part of the disc a
    // planar projection compresses (see CAP above).
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

  for (let y = 0; y < CAP; y++) {
    for (let x = 0; x < CAP; x++) {
      // Cartesian raster, polar maths. The cell is a picture of the cap from
      // above, so the loop walks texels; every pattern below is still written
      // in (angle, radius) because gills, streaks, scales and wart rings are
      // all genuinely radial features. Only the SAMPLING changed.
      const cx = (x + 0.5) / CAP
      const cy = (y + 0.5) / CAP
      const dx = cx * 2 - 1
      const dy = cy * 2 - 1
      const rr = Math.hypot(dx, dy)
      // Clamped, not discarded. The corners of the cell lie outside the rim and
      // nothing samples them -- but `Math.min` continues the rim's own colour
      // out into them, so the bilinear tap at the very edge of the disc finds
      // more rim instead of whatever a bare buffer would hold. Leaving them
      // black would draw a dark fringe right where the cap is thinnest.
      const v = Math.min(1, rr) // apex (0) to rim (1)
      const u = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1 // angle around the cap

      // The radial value ramp. Every cap has one and its SIGN is most of the
      // cap's character: a bolete is dark at the crown, a russula pale there.
      let shade = mix(spec.centre, spec.edge, Math.pow(v, 0.8))

      // Grain, at two lattice frequencies plus the texel lattice itself, and
      // the third term is a different KIND of thing from the first two rather
      // than just a smaller one. The 8x6 and 24x18 octaves are the cap's
      // mottle -- damp patches, uneven flesh -- and they are the part that
      // survives into the mips, but any lattice noise is by construction
      // smooth between its knots, so stacking more of them only ever produces
      // finer cloud. A cap read as flat paint at 1:1 (scarlet worst, since a
      // saturated hue under hard white warts has nowhere to hide) wants the
      // one thing a lattice cannot give: uncorrelated per-texel static, which
      // is `hash2` sampled straight at the pixel with no interpolation at all.
      // It is film grain, and like film grain it is MEANT to average away the
      // moment the cap is a few metres off -- the mottle is what carries the
      // silhouette at range, this is what carries the surface up close.
      // The two lattice octaves are sampled in CELL SPACE, not in (u, v). On
      // the polar chart they had to be polar, and the price was a pinwheel at
      // the crown: as v goes to 0 a texel step in x is a huge step in angle, so
      // the mottle sheared into a star exactly where the cap is flattest and
      // most visible. Sampled on the disc it is isotropic everywhere, which is
      // what mottle is. Nothing needs to wrap here -- the disc has no seam --
      // but `wrapNoise` is the lattice this file has, and its periodicity is
      // simply unused.
      const n = wrapNoise(cx, cy, 8, 6, spec.seed) * 0.44
              + wrapNoise(cx, cy, 24, 18, spec.seed + 5) * 0.28
              + hash2(x, y, spec.seed + 31) * 0.28
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
          // Warts are placed in (angle, radius) but measured in ARC LENGTH, so
          // `arc` and `rad` are both real distances on the cap and the wart is
          // a true circle of radius w.r wherever it sits.
          //
          // ONE RADIUS, not two. The polar chart needed a second, floored one:
          // a wart at the rim spanned half a texel of the u axis there and
          // aliased into a dashed line unless it was stretched tangentially to
          // ~1.6 texels. That floor was the "stretched" half of what the spots
          // looked like, and it is gone -- on the disc a wart is 3.2 texels
          // across at every radius, so there is nothing left to floor against.
          const arc = wrapDelta(u, w.u) * Math.PI * 2 * Math.max(v, 0.09)
          const rad = v - w.v
          const d = Math.hypot(arc, rad) / Math.max(1e-4, w.r)
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

      // Tooth over EVERYTHING, applied last and therefore to the markings too.
      // The grain above is mixed into `shade` before the pattern block runs, so
      // every `mix()` toward `accent` above washes it back out again in
      // proportion to k: a fully-opaque wart, scale plate or ridge crease ends
      // up carrying none of it and reads as plastic sitting on a textured cap,
      // which is the half of "smooth shiny red" that raising `grain` alone does
      // not fix. This pass is a multiply on the finished rgb, so it cannot be
      // erased by anything. Amplitude is a THIRD of the base grain on purpose,
      // because the accents genuinely are the smoother material -- a veil
      // remnant is a wet skin over the cap, not more cap -- so the cell still
      // separates marking from ground by texture, just not by flat-versus-not.
      // Mostly per-texel with some 32x24 lattice mixed in, so a big wart gets a
      // little mottle across it rather than an even dusting of salt.
      const tooth = hash2(x, y, spec.seed + 47) * 0.62
                  + wrapNoise(cx, cy, 32, 24, spec.seed + 53) * 0.38
      const bite = 1 + (tooth - 0.5) * 2 * spec.grain * 0.34
      r *= bite
      g *= bite
      b *= bite

      const o = (y * CAP + x) * 4
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
// Sheet assembly. Both sheet kinds are now the same shape -- a 2x2 grid of
// 64 px cells in one 128 px layer -- so `cellUV` in props/mushroom.js decodes
// either. What differs is what the cell MEANS: a flesh cell is a polar chart
// of the gills and stalk, a cap cell is a disc seen from above.
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
