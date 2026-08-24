import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// Procedural building tiles: the placeholder art for DESIGN.md §19.
//
// WHY THESE EXIST AT ALL, given that real scans are sitting in tmp/. Because
// for a building the texture is NOT the silhouette. That is the one place the
// fern's pipeline does not transfer: a fern's alpha channel carries every
// pinna, so no arrangement of geometry can be judged before the cutout exists.
// A wall is a rectangle either way. What actually has to be right before the
// massing can be judged is the TEXEL SCALE -- how many log courses per metre,
// how coarse a shingle reads at 15 m -- and that is a UV decision. A generated
// plank tile at the correct scale answers it exactly as well as a photographed
// one, and it answers it today.
//
// So the split is: everything here is provisional and expected to be replaced
// by crops off the Megascans sheets, EXCEPT where the alpha channel carries
// shape. THATCH_FRINGE, IRON and RUNE are cut for real (tools/props/), because
// a ragged eave and a hinge strap are silhouette and a placeholder lies about
// them. The six opaque tiles below are judged on scale, not on beauty.
//
// EVERY TILE IN HERE MUST WRAP IN BOTH AXES. That is not a quality bar, it is
// a correctness one: these are Class A tiling surfaces (§9) sampled with
// RepeatWrapping at UVs well past 1.0, so a seam is not "slightly wrong", it is
// a bright line repeating every 1.2 m across a wall. Everything periodic below
// is periodic on an INTEGER count for that reason, and the noise runs on a
// lattice whose indices wrap. scripts/check-buildings.mjs measures the seam.
//
// The decal sheets (IRON, RUNE) are the exception and do not tile. They are
// addressed by island: a 2-triangle quad takes UVs from IRON_ISLANDS and never
// samples outside [0,1], which is what makes them safe to keep in the same
// RepeatWrapping array as the tiles -- wrap mode only bites outside the unit
// square. Two rules make that hold, and check-buildings.mjs asserts both:
//
//   1. Every island keeps a transparent GUTTER (4 texels) so bilinear
//      filtering at an island edge cannot pick up its neighbour.
//   2. One material family per sheet. Coarse mips average the WHOLE layer, so
//      a sheet mixing iron with runes would fade a hinge into a knotwork band
//      at distance -- which is exactly the mip-bleed argument textures.js uses
//      to reject packed atlases. Iron bleeding into iron is invisible, so the
//      objection does not reach a single-family sheet. Hence two sheets.
//
// Colours are sRGB bytes, like bark()/mottled() in textures.js, because the
// array is uploaded as SRGBColorSpace. This is the opposite convention from
// village/shapes.js, whose vertex colours are linear.
// ---------------------------------------------------------------------------

// --- helpers ----------------------------------------------------------------

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t)
const smooth = (t) => t * t * (3 - 2 * t)
const lerp = (a, b, t) => a + (b - a) * t
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k]

/** Deterministic hash of two integers to [0,1). Used for per-course, per-plank
 *  and per-block jitter, where the index is what must wrap, not the position. */
function hash2(a, b) {
  let t = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0
  t = Math.imul(t ^ (t >>> 13), 1274126177)
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296
}

/**
 * Split an axis into `count` modules of UNEQUAL width that still tile.
 *
 * Returns `{ index, t, edge }` for a position `f` measured in module units:
 * which module it lands in, how far across it is (0-1), and its distance to the
 * nearer joint (in module units).
 *
 * This is the difference between masonry and bathroom tile, and between split
 * shakes and brickwork. A uniform partition is the single thing that most makes
 * a generated surface read as generated, and the first version of this file got
 * it wrong three times. The wrap works because the jitter is hashed on the
 * index MODULO count, so joint number `count` is joint number 0 shifted by
 * exactly one tile.
 */
function modules(f, count, row, seed, amount = 0.6) {
  const joint = (k) => {
    const kk = ((k % count) + count) % count
    return k + (hash2(row * 7919 + kk, seed) - 0.5) * amount
  }
  let i = Math.floor(f)
  // Jitter is under half a module, so the true index is within one of floor(f).
  if (f < joint(i)) i -= 1
  else if (f >= joint(i + 1)) i += 1
  const a = joint(i)
  const b = joint(i + 1)
  return {
    index: ((i % count) + count) % count,
    t: (f - a) / (b - a),
    edge: Math.min(f - a, b - f),
  }
}

/**
 * Tileable value noise on a gx by gy lattice. Wrapping the lattice indices is
 * the whole trick and the only reason these tiles have no seam -- same
 * construction as the previewer ground in gen-fern-main.js.
 *
 * THE RULE THAT KEEPS THESE TILES SEAMLESS, and the one way this file gets
 * broken by a well-meaning edit: a noise field is periodic with period exactly
 * 1, so it must ALWAYS be sampled as f(u, v) and never as f(u * 1.6, v * 0.35).
 * A non-integer argument scale walks off the end of the period and puts a
 * bright line down the wall every tile. Anisotropy -- grain that runs along a
 * log rather than across it -- therefore goes in the LATTICE DIMENSIONS, which
 * is what gx and gy are separate for. Constant offsets are out for the same
 * reason: f(u + 0.37, v) does not wrap either.
 */
function lattice(seed, gx, gy = gx) {
  const rand = mulberry32(seed)
  const v = new Float32Array(gx * gy)
  for (let i = 0; i < v.length; i++) v[i] = rand()
  return (x, y) => {
    const fx = x * gx
    const fy = y * gy
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const x0 = ((ix % gx) + gx) % gx
    const y0 = ((iy % gy) + gy) % gy
    const x1 = (x0 + 1) % gx
    const y1 = (y0 + 1) % gy
    const tx = smooth(fx - ix)
    const ty = smooth(fy - iy)
    const a = v[y0 * gx + x0]
    const b = v[y0 * gx + x1]
    const c = v[y1 * gx + x0]
    const d = v[y1 * gx + x1]
    return lerp(lerp(a, b, tx), lerp(c, d, tx), ty)
  }
}

/** Sum of wrapping lattices at doubling frequency. Still wraps, because every
 *  octave does. */
function fbm(seed, gx, gy = gx, octaves = 3) {
  const layers = []
  for (let o = 0; o < octaves; o++) layers.push(lattice(seed + o * 101, gx << o, gy << o))
  return (x, y) => {
    let sum = 0
    let amp = 1
    let norm = 0
    for (let o = 0; o < octaves; o++) {
      sum += layers[o](x, y) * amp
      norm += amp
      amp *= 0.5
    }
    return sum / norm
  }
}

/**
 * Rasterise one tile. `fn(u, v)` returns [r,g,b] or [r,g,b,a] in 0-255.
 *
 * u runs left to right and v runs BOTTOM to TOP, matching the UV space the
 * geometry addresses. Authoring in UV space rather than image space means the
 * drawing code and the parts kit share one convention and nothing has to
 * remember to invert.
 *
 * ROW 0 OF THE BUFFER IS v = 0, and that is the whole subtlety here. An earlier
 * version wrote row 0 as v = 1 on the strength of three flipping on upload --
 * but flipY is false on every data texture, and UNPACK_FLIP_Y cannot be applied
 * to the texImage3D a DataArrayTexture uploads with in any case. There is no
 * flip to compensate for, so every tile in this file came out mirrored top to
 * bottom. Invisible on logs, plaster and rubble, and visible on exactly the one
 * tile whose whole content is a direction: the thatch fringe hung its ragged
 * tips along the ridge and pressed its solid edge into the sky.
 *
 * The same convention reaches the shipped PNGs, which loadImageLayers decodes
 * with drawImage/getImageData and uploads unflipped: PNG row 0 is v = 0 too. So
 * public/buildings/thatch_fringe.png looks upside down in an image viewer, and
 * is right on the roof.
 */
function paint(n, fn) {
  const data = new Uint8Array(n * n * 4)
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n
      const c = fn(u, v)
      const i = (y * n + x) * 4
      data[i] = Math.max(0, Math.min(255, c[0] | 0))
      data[i + 1] = Math.max(0, Math.min(255, c[1] | 0))
      data[i + 2] = Math.max(0, Math.min(255, c[2] | 0))
      data[i + 3] = c.length > 3 ? Math.max(0, Math.min(255, c[3] | 0)) : 255
    }
  }
  return data
}

// --- palette ----------------------------------------------------------------
// One place, because the whole point of a shared tile set is that a log wall
// and a plank door read as the same building. Weathered northern timber: grey
// has taken most of the red out of everything that has stood outside.

const P = {
  logLit: [136, 112, 84],
  logMid: [104, 84, 62],
  logDark: [52, 40, 29],
  plankLit: [124, 110, 94],
  plankMid: [96, 83, 70],
  plankDark: [44, 37, 31],
  strawLit: [178, 142, 88],
  strawMid: [138, 104, 60],
  strawDark: [74, 53, 29],
  shakeLit: [124, 110, 98],
  shakeMid: [96, 84, 74],
  shakeDark: [40, 34, 30],
  stoneLit: [148, 145, 136],
  stoneMid: [116, 113, 105],
  stoneDark: [74, 72, 67],
  mortar: [96, 94, 88],
  moss: [76, 92, 54],
  plasterLit: [206, 198, 182],
  plasterMid: [178, 170, 154],
  grime: [128, 118, 100],
  ironLit: [118, 118, 124],
  ironMid: [72, 72, 78],
  ironDark: [34, 34, 38],
  carveLit: [150, 126, 92],
  carveDark: [46, 34, 22],
}

// ---------------------------------------------------------------------------
// Tiling surfaces
// ---------------------------------------------------------------------------

/**
 * Horizontal round-log courses -- the log-cabin wall, seen from outside.
 *
 * The shading is what sells it and it is one line: brightness follows
 * sin(pi * f) across each course, so every log is lit along its belly and goes
 * dark into the chink above and below it. That reads as a cylinder at 3 m
 * without a normal map, which we could not use anyway (§9: no consumer).
 */
export function tileLogs(n, { courses = 2, seed = 11 } = {}) {
  // Wide and short: grain runs ALONG the log, which is what gx >> gy buys.
  const grain = fbm(seed, 16, 3, 3)
  const fine = lattice(seed + 7, 48, 12)
  return paint(n, (u, v) => {
    const fc = v * courses
    const idx = Math.floor(fc)
    const f = fc - idx

    // Cylinder falloff, then a hard chink line where two logs meet.
    const belly = Math.sin(Math.PI * clamp01(f))
    const chink = smooth(clamp01(Math.min(f, 1 - f) / 0.09))

    // Per-log tint, hashed on the course index so it wraps with the tile.
    const tone = hash2(idx, 3) * 0.44 - 0.22
    const g = grain(u, v) * 0.55 + fine(u, v) * 0.45

    let c = mixc(P.logDark, P.logLit, clamp01(0.2 + belly * 0.5 + g * 0.42 + tone))

    // One knot per course, where a branch was trimmed off. Placed by hash on
    // the course index, so it moves down the wall rather than forming a column.
    const kx = hash2(idx, 41)
    const du = Math.abs(u - kx)
    const kd = Math.hypot(Math.min(du, 1 - du) * 2.4, (f - 0.5) * 1.1)
    if (kd < 0.14) {
      const ring = Math.abs(Math.sin(kd * 46)) * 0.35 + 0.4
      c = mixc(shade(P.logDark, 1.1), c, clamp01(kd / 0.14) * 0.55 + ring * 0.45)
    }

    c = mixc(P.logDark, c, chink)
    return c
  })
}

/**
 * Vertical sawn planks / staves. The Norse stave wall, and also door leaves,
 * shutters, gable boarding and porch decking -- one tile, five jobs, which is
 * the whole argument for a shared tile set.
 */
export function tilePlanks(n, { planks = 5, seed = 21 } = {}) {
  // Tall and narrow: the boards stand up, so the grain does too.
  const grain = fbm(seed, 3, 14, 3)
  const fine = lattice(seed + 9, 10, 56)
  return paint(n, (u, v) => {
    const fp = u * planks
    const idx = Math.floor(fp)
    const f = fp - idx

    // Groove between boards, and a narrow bright arris on the lit side of it.
    const groove = smooth(clamp01(Math.min(f, 1 - f) / 0.055))
    const arris = f < 0.14 ? smooth(clamp01((0.14 - f) / 0.14)) * 0.22 : 0

    const tone = hash2(idx, 5) * 0.36 - 0.18
    const g = grain(u, v) * 0.6 + fine(u, v) * 0.4

    let c = mixc(P.plankMid, P.plankLit, clamp01(g * 0.75 + tone + arris))
    c = mixc(P.plankDark, c, groove)
    return c
  })
}

/**
 * Thatch. Straw runs DOWN the roof slope, so this tile is authored with the
 * straw along v and the courses banded across it -- which fixes the UV
 * convention for every roof surface in the kit: v runs up the slope, u runs
 * along the eave.
 *
 * `public/buildings/thatch.png` is patched over this a few frames in. Keep both
 * in the same convention: the photograph is healed, graded and course-banded to
 * match what is drawn here, so the placeholder-to-real swap is a change of
 * detail and not a change of layout.
 */
export function tileThatch(n, { straws = 48, bands = 4, seed = 31 } = {}) {
  const clump = fbm(seed, 6, 3, 3)
  // Very tall lattices: these ARE the straw, drawn as noise stretched down the
  // slope. Two of them at different frequencies, because one reads as combing.
  const streak = lattice(seed + 3, 72, 160)
  const coarse = lattice(seed + 11, 26, 40)
  return paint(n, (u, v) => {
    const fb = v * bands
    const bi = Math.floor(fb)
    const bf = fb - bi

    // Bundles of straw, not individual stalks -- at 128 px across 1.6 m a
    // single stalk is a third of a texel, so what has to be drawn is the clump.
    //
    // The bundle layout is hashed on the COURSE index, which matters more than
    // it looks: with one layout shared by every course the bundle edges run as
    // unbroken vertical lines from eave to ridge, they cross the horizontal
    // course shadows, and the roof reads as tartan. Each course is combed
    // separately in reality, so each course gets its own bundles here.
    const m = modules(u * straws, straws, bi + 1, 19, 0.7)
    const core = Math.sin(Math.PI * clamp01(m.t)) * 0.35 + 0.65
    const bright = hash2(bi * 131 + m.index, 17) * 0.6 - 0.3
    const along = streak(u, v) * 0.62 + coarse(u, v) * 0.38

    // Weighted hard toward the stretched noise. A strong per-bundle flat value
    // turns each bundle into a rectangle and the roof into a chequerboard --
    // what has to dominate is streaking ALONG the slope, which is the one thing
    // that reads as straw rather than as panelling.
    const t = clamp01(0.08 + core * 0.12 + along * 0.72 + clump(u, v) * 0.14 + bright * 0.22)
    const c = mixc(P.strawDark, P.strawLit, t)

    // Courses. Thatch is combed, not lapped like a shingle, so there is no hard
    // line anywhere except the one place there genuinely is one: the butt ends
    // of each course, which sit proud and catch the light, with the head of the
    // course below falling into their shadow.
    const wob = clump(u, v) * 0.1 - 0.05
    const butt = 1 + 0.22 * (1 - smooth(clamp01((bf - wob) / 0.16)))
    const shadow = lerp(1, 0.66, smooth(clamp01((bf - wob - 0.7) / 0.3)))
    return shade(c, butt * shadow)
  })
}

/**
 * Wood shakes. Slate is deliberately NOT a second layer: at 128 px from 15 m
 * the two differ in hue and value and almost nothing else, and per-instance
 * tint is free (§9, "where variety comes from instead"). If that turns out to
 * be wrong in the previewer it is a two-line change to add the layer.
 */
export function tileShingles(n, { cols = 5, rows = 6, seed = 41 } = {}) {
  const grain = fbm(seed, 6, 20, 2)
  const fibre = lattice(seed + 5, 96, 24)
  return paint(n, (u, v) => {
    const fr = v * rows
    const ri = Math.floor(fr)
    const rf = fr - ri

    // Every other course steps sideways, which is the thing that stops a
    // shingle roof reading as a grid -- and the shakes are riven by hand, so
    // no two are the same width either.
    const offset = (ri & 1) * 0.5
    const m = modules((u + offset / cols) * cols, cols, ri, 7, 0.55)
    const key = ri * 31 + m.index

    // A split shake sits a little proud and a little low of its neighbours, so
    // the butt line staggers instead of ruling straight across the roof.
    const drop = (hash2(key, 3) - 0.5) * 0.26
    const butt = smooth(clamp01((rf - drop) / 0.07))
    const side = smooth(clamp01(m.edge / 0.05))

    const tone = hash2(key, 7) * 0.5 - 0.25
    const g = grain(u, v) * 0.6 + fibre(u, v) * 0.4

    let c = mixc(P.shakeMid, P.shakeLit, clamp01(g * 0.7 + tone))
    // The course above overhangs, so the head of each shake sits in its shadow
    // and its exposed butt is the brightest thing on the roof.
    c = shade(c, lerp(0.55, 1.12, smooth(clamp01((1 - rf - drop) / 0.55))))
    c = mixc(P.shakeDark, c, Math.min(butt, side))
    return c
  })
}

/**
 * Coursed rubble stone. One layer serves foundations, plinths and chimneys --
 * they are the same masonry on the same building, and differentiating them
 * costs 64 KB to say something nobody looks at.
 */
export function tileStone(n, { courses = 4, perCourse = 4, seed = 51 } = {}) {
  const rough = fbm(seed, 14, 14, 3)
  const pit = lattice(seed + 3, 64, 64)
  const mossField = fbm(seed + 5, 5, 5, 2)
  return paint(n, (u, v) => {
    // Courses run level -- this is COURSED rubble, not random rubble -- but no
    // two are the same height and no two stones in a course are the same width,
    // and each course breaks its joints somewhere else so nothing ever lines up
    // vertically. All three of those are needed. With any one of them missing
    // the tile reads as a bathroom floor, which is what the first three
    // versions of this function did.
    const row = modules(v * courses, courses, 0, 23, 0.55)
    const ci = row.index
    const cf = row.t
    const shift = hash2(ci, 2) * 0.9
    const m = modules((u + shift) * perCourse, perCourse, ci + 1, 11, 0.66)
    const key = ci * 17 + m.index

    const vJoint = smooth(clamp01(m.edge / 0.05))
    const hJoint = smooth(clamp01(row.edge / 0.05))
    const joint = Math.min(vJoint, hJoint)

    // Variation lives INSIDE the stone, not between stones. A wide per-stone
    // offset over a flat interior is exactly a chequerboard of painted panels;
    // real rubble is the other way round, every stone roughly the same value
    // and every stone mottled to bits.
    const tone = hash2(key, 13) * 0.3 - 0.15
    const r = rough(u, v) * 0.55 + pit(u, v) * 0.45

    let c = mixc(P.stoneDark, P.stoneLit, clamp01(0.2 + r * 0.95 + tone))

    // Relief as a RIM, not as a full-height gradient: a ramp from dark at the
    // bottom of every stone to light at the top is what a bevelled tile does.
    // A narrow lit edge where the stone stands proud of the mortar says the
    // same thing about the light without imposing a repeating gradient.
    const rim = 1 - smooth(clamp01(joint / 0.5))
    c = shade(c, 1 + rim * (cf > 0.55 ? 0.26 : -0.24))
    c = mixc(shade(P.mortar, 0.55), c, joint)

    // Moss creeps out of the joints, which is where a plinth actually grows it.
    // Note it does NOT fade toward the bottom of the tile: a height gradient
    // inside a tiling texture is a seam, and an earlier version of this line
    // put the worst one in the set here. Height-driven moss is the parts kit's
    // job, applied per vertex.
    const g = clamp01(mossField(u, v) * 1.9 - 0.7) * lerp(1, 0.35, joint)
    return mixc(c, P.moss, clamp01(g) * 0.7)
  })
}

/**
 * Lime plaster / daub infill for half-timbered panels. Nearly flat by design:
 * its job is to be the bright field the timbers read against, and any texture
 * strong enough to notice fights them.
 */
export function tilePlaster(n, { seed = 61 } = {}) {
  const blotch = fbm(seed, 5, 5, 3)
  const stain = fbm(seed + 4, 3, 7, 2)
  const fine = lattice(seed + 8, 56, 56)
  return paint(n, (u, v) => {
    const b = blotch(u, v)
    const c = mixc(P.plasterMid, P.plasterLit, clamp01(b * 0.8 + fine(u, v) * 0.2))
    // Grime, as vertically-stretched blotches rather than as a gradient from
    // the bottom of the tile. The gradient is the more truthful thing to draw
    // -- rain runs down and dirt splashes up -- but it does not tile, and it
    // put the worst seam in the whole set here. Where the grime actually
    // belongs is low on the WALL, not low in the TILE, so the panel darkens
    // toward its sill by per-vertex colour instead.
    return mixc(c, P.grime, clamp01(stain(u, v) * 1.5 - 0.6) * 0.55)
  })
}

/**
 * The frayed thatch fringe: the ragged hanging edge of a thatched eave.
 *
 * ALPHA CARRIES THE SHAPE, so this is one of the three layers a placeholder
 * genuinely lies about. What ships is `public/buildings/thatch_fringe.png`,
 * which `loadImageLayers` patches over this a few frames in -- and it keeps
 * THIS alpha channel verbatim, because the photograph is a continuous field of
 * straw with no cut edge anywhere in frame to trace. The PNG replaces the RGB
 * with real straw so the fringe matches the roof it hangs off; the hanging
 * profile below is the asset. See tools/props/extract-thatch.mjs.
 *
 * UV convention, and the parts kit depends on it: v = 1 is the eave line where
 * the strip meets the roof and is fully opaque, v = 0 is the hanging tip. The
 * strip tiles in u along the eave and is never repeated in v.
 */
export function tileFringe(n, { straws = 34, seed = 71 } = {}) {
  const wisp = lattice(seed + 2, 32, 8)
  return paint(n, (u, v) => {
    const fs = u * straws
    const si = Math.floor(fs)
    const sf = fs - si
    // Straw index MOD the count, so the last straw's right-hand neighbour is
    // the first straw and not a phantom straw `straws`. Without the modulo the
    // hanging lengths blend toward a value that exists nowhere else in the
    // tile, and the eave gets one wrongly-cut straw every repeat -- which the
    // RGB-only seam metric misses entirely, because the discontinuity is in
    // ALPHA and alpha is where this tile keeps its shape.
    const idx = (k) => ((k % straws) + straws) % straws

    // Each straw hangs its own distance. Neighbours are blended a little so
    // the edge reads as a torn fringe rather than as a barcode.
    const l0 = 0.3 + hash2(idx(si), 23) * 0.62
    const l1 = 0.3 + hash2(idx(si + 1), 23) * 0.62
    const len = lerp(l0, l1, smooth(sf)) - wisp(u, v) * 0.08

    const alpha = v > 1 - len ? 255 : 0
    const core = Math.sin(Math.PI * clamp01(sf))
    // Tips are bleached and the head of the straw is in the roof's shadow.
    const t = clamp01(core * 0.4 + (1 - v) * 0.45 + hash2(idx(si), 29) * 0.3)
    const c = mixc(P.strawMid, P.strawLit, t)
    return [...shade(c, lerp(0.55, 1.05, clamp01((1 - v) / 0.9))), alpha]
  })
}

/**
 * Leaded glass: small quarries in a lead came, the panes cylinder-blown so each
 * one warps the light differently.
 *
 * OPAQUE, and that is a rendering constraint rather than an art choice. Alpha
 * blending cannot be depth-sorted inside a batched draw call (DESIGN.md §7), so
 * real transparency is architecturally unavailable and a window has to be a
 * painted surface. Which is fine, because it is also what an actual small-paned
 * window looks like from outside in daylight: not a hole, a bright grey sheet
 * with the sky in it. The warp is what stops it reading as a mirror.
 */
export function tileGlass(n, { panes = 2, seed = 101 } = {}) {
  const warp = fbm(seed, 6, 6, 3)
  const flow = lattice(seed + 4, 8, 20)
  const came = [52, 50, 48]
  const sky = [176, 190, 202]
  const deep = [58, 70, 76]
  return paint(n, (u, v) => {
    const m = modules(u * panes, panes, 0, 31, 0.22)
    const r = modules(v * panes, panes, m.index + 1, 37, 0.22)

    // The lead came between quarries, plus the thin bright solder line on it.
    const lead = Math.min(m.edge, r.edge)
    const leadA = smooth(clamp01(lead / 0.07))

    // Each quarry is its own thickness of glass, so each catches the sky at its
    // own angle -- that per-pane value jump is most of what says "old window".
    const bias = hash2(m.index * 13 + r.index, 3) * 0.42 - 0.21
    // Ripples from the blowing, stretched vertically because the cylinder was.
    const ripple = warp(u, v) * 0.6 + flow(u, v) * 0.4

    let c = mixc(deep, sky, clamp01(0.24 + ripple * 0.72 + bias))
    // A hard specular streak across the top-left of each quarry.
    const glint = clamp01(1 - Math.hypot(m.t - 0.32, r.t - 0.74) * 3.4)
    c = mixc(c, [232, 240, 246], glint * glint * 0.7)
    return mixc(came, c, leadA)
  })
}

// ---------------------------------------------------------------------------
// Decal sheets
//
// Islands are declared in UV space and the drawing code works in the same
// space, so parts.js and this file cannot disagree about where a hinge is.
// Every island keeps GUTTER clear on all four sides.
// ---------------------------------------------------------------------------

/** Transparent margin around every island, as a fraction of the sheet. 4 texels
 *  at 128 -- enough that bilinear filtering never reaches a neighbour. */
export const GUTTER = 4 / 128

export const IRON_ISLANDS = {
  // A long hinge strap with a spade terminal. Doors take two or three.
  hingeStrap: { u0: 0.032, v0: 0.72, u1: 0.72, v1: 0.94 },
  // Ring pull on a backplate.
  ringHandle: { u0: 0.76, v0: 0.7, u1: 0.97, v1: 0.97 },
  // Lock escutcheon.
  lockPlate: { u0: 0.76, v0: 0.42, u1: 0.95, v1: 0.66 },
  // A row of clench nails, for banding a plank door or a shutter.
  nailRow: { u0: 0.032, v0: 0.52, u1: 0.68, v1: 0.64 },
  // Corner bracket for a gate or a chest-like shutter.
  bracket: { u0: 0.032, v0: 0.12, u1: 0.36, v1: 0.46 },
  // A simple strap hinge for shutters -- shorter, no spade.
  shutterStrap: { u0: 0.42, v0: 0.2, u1: 0.94, v1: 0.34 },
}

export const RUNE_ISLANDS = {
  // Horizontal interlace, for a door lintel or a wall band.
  lintelBand: { u0: 0.03, v0: 0.76, u1: 0.97, v1: 0.96 },
  // The same idea turned vertical, for a corner post or door jamb.
  postBand: { u0: 0.03, v0: 0.06, u1: 0.19, v1: 0.7 },
  // A sun-wheel medallion for a gable apex.
  gableMedallion: { u0: 0.26, v0: 0.32, u1: 0.62, v1: 0.68 },
  // A line of angular staves -- reads as writing without being any real futhark.
  runeRow: { u0: 0.26, v0: 0.08, u1: 0.97, v1: 0.26 },
}

/** Map a point inside an island to local 0-1 coordinates, or null if outside. */
function local(isl, u, v) {
  if (u < isl.u0 || u > isl.u1 || v < isl.v0 || v > isl.v1) return null
  return [(u - isl.u0) / (isl.u1 - isl.u0), (v - isl.v0) / (isl.v1 - isl.v0)]
}

// Soft-ish coverage from a signed distance, in local units. Kept narrow: the
// material runs alphaTest 0.5, so a wide ramp just moves the cut line.
const cover = (d, w = 0.06) => clamp01(0.5 - d / w)

/**
 * The iron sheet: hinge straps, handles, nails, brackets. All one material
 * family, which is what licenses packing them together (see the header).
 */
export function sheetIron(n, { seed = 81 } = {}) {
  const pit = lattice(seed, n >> 1)

  // Rolled and hammered iron: dark, with a hammered highlight along the top.
  const ironAt = (t, edge) => {
    // Hammered, so the highlight is patchy rather than a clean gradient. The
    // top of a fitting catches the sky and the bottom goes to nothing.
    const p = pit(t[0], t[1])
    const lit = clamp01(t[1] * 0.85 + p * 0.75 - 0.25)
    const c = mixc(P.ironDark, P.ironLit, lit * lit)
    return mixc(c, P.ironLit, clamp01(edge) * 0.45)
  }

  const nail = (t, cx, cy, r) => {
    const d = Math.hypot(t[0] - cx, t[1] - cy)
    return d < r ? clamp01((r - d) / r) : 0
  }

  return paint(n, (u, v) => {
    let t

    // --- hinge strap: tapering bar, spade terminal, three clench nails ------
    t = local(IRON_ISLANDS.hingeStrap, u, v)
    if (t) {
      const half = lerp(0.42, 0.15, clamp01((t[0] - 0.12) / 0.88))
      const bar = Math.abs(t[1] - 0.5) - half
      // Spade: a lens that widens again at the far end.
      const sx = clamp01((t[0] - 0.74) / 0.26)
      const spade = Math.abs(t[1] - 0.5) - Math.sin(Math.PI * sx) * 0.44
      const d = t[0] > 0.74 ? Math.min(bar, spade) : bar
      const a = cover(d, 0.05)
      if (a > 0.02) {
        const nails = Math.max(nail(t, 0.08, 0.5, 0.13), nail(t, 0.38, 0.5, 0.1), nail(t, 0.86, 0.5, 0.11))
        return [...ironAt(t, clamp01(1 - -d / 0.22) * 0.5 + nails * 0.6), (a * 255) | 0]
      }
    }

    // --- shutter strap: same bar, blunt end --------------------------------
    t = local(IRON_ISLANDS.shutterStrap, u, v)
    if (t) {
      const half = lerp(0.44, 0.2, t[0])
      const d = Math.max(Math.abs(t[1] - 0.5) - half, t[0] - 0.97, -t[0] + 0.02)
      const a = cover(d, 0.05)
      if (a > 0.02) return [...ironAt(t, nail(t, 0.1, 0.5, 0.16) * 0.7), (a * 255) | 0]
    }

    // --- ring handle: annulus over a backplate ------------------------------
    t = local(IRON_ISLANDS.ringHandle, u, v)
    if (t) {
      const dr = Math.abs(Math.hypot(t[0] - 0.5, t[1] - 0.42) - 0.33) - 0.075
      const plate = Math.hypot((t[0] - 0.5) / 0.28, (t[1] - 0.86) / 0.13) - 1
      const d = Math.min(dr, plate)
      const a = cover(d, 0.05)
      if (a > 0.02) return [...ironAt(t, clamp01(-d / 0.1) * 0.4), (a * 255) | 0]
    }

    // --- lock plate: rounded rect with a keyhole ----------------------------
    t = local(IRON_ISLANDS.lockPlate, u, v)
    if (t) {
      const box = Math.max(Math.abs(t[0] - 0.5) - 0.4, Math.abs(t[1] - 0.5) - 0.44)
      const holeR = Math.hypot(t[0] - 0.5, t[1] - 0.62) - 0.12
      const holeSlot = Math.max(Math.abs(t[0] - 0.5) - 0.05, Math.abs(t[1] - 0.4) - 0.16)
      const d = Math.max(box, -Math.min(holeR, holeSlot))
      const a = cover(d, 0.05)
      if (a > 0.02) {
        const nails = Math.max(nail(t, 0.16, 0.86, 0.09), nail(t, 0.84, 0.86, 0.09), nail(t, 0.16, 0.14, 0.09), nail(t, 0.84, 0.14, 0.09))
        return [...ironAt(t, nails * 0.7), (a * 255) | 0]
      }
    }

    // --- nail row -----------------------------------------------------------
    t = local(IRON_ISLANDS.nailRow, u, v)
    if (t) {
      let best = 1
      for (let i = 0; i < 6; i++) {
        const cx = (i + 0.5) / 6
        best = Math.min(best, Math.hypot((t[0] - cx) / 0.055, (t[1] - 0.5) / 0.4) - 1)
      }
      const a = cover(best, 0.35)
      if (a > 0.02) return [...ironAt(t, clamp01(-best) * 0.5), (a * 255) | 0]
    }

    // --- corner bracket -----------------------------------------------------
    t = local(IRON_ISLANDS.bracket, u, v)
    if (t) {
      const armH = Math.max(Math.abs(t[1] - 0.12) - 0.1, -t[0] + 0.03, t[0] - 0.97)
      const armV = Math.max(Math.abs(t[0] - 0.12) - 0.1, -t[1] + 0.03, t[1] - 0.97)
      const d = Math.min(armH, armV)
      const a = cover(d, 0.05)
      if (a > 0.02) {
        const nails = Math.max(nail(t, 0.82, 0.12, 0.08), nail(t, 0.12, 0.82, 0.08))
        return [...ironAt(t, nails * 0.7), (a * 255) | 0]
      }
    }

    return [0, 0, 0, 0]
  })
}

/**
 * The rune sheet: knotwork and carved staves, cut into timber rather than
 * applied to it -- so the palette is wood, not paint, and the "carving" is a
 * dark groove with a lit arris on one side.
 */
export function sheetRunes(n, { seed = 91 } = {}) {
  const grain = lattice(seed, n >> 2)

  const carveAt = (t, d) => {
    // d is signed distance to the groove centreline, negative inside.
    const depth = clamp01(-d / 0.05)
    const arris = clamp01((d + 0.045) / 0.03) * clamp01(-d / 0.09)
    let c = mixc(P.carveDark, P.carveLit, arris * 0.9 + grain(t[0], t[1]) * 0.2)
    return shade(c, lerp(1, 0.45, depth))
  }

  // Two out-of-phase ribbons crossing: the cheapest thing that reads as
  // interlace without modelling an actual knot.
  const interlace = (x, y, turns) => {
    const a = Math.sin(x * Math.PI * turns) * 0.34
    const b = Math.sin(x * Math.PI * turns + Math.PI) * 0.34
    return Math.min(Math.abs(y - 0.5 - a), Math.abs(y - 0.5 - b)) - 0.055
  }

  return paint(n, (u, v) => {
    let t

    t = local(RUNE_ISLANDS.lintelBand, u, v)
    if (t) {
      const knot = interlace(t[0], t[1], 6)
      const rails = Math.min(Math.abs(t[1] - 0.06), Math.abs(t[1] - 0.94)) - 0.035
      const d = Math.min(knot, rails)
      const a = cover(d, 0.05)
      if (a > 0.02) return [...carveAt(t, d), (a * 255) | 0]
    }

    t = local(RUNE_ISLANDS.postBand, u, v)
    if (t) {
      // Same interlace, axes swapped.
      const knot = interlace(t[1], t[0], 7)
      const rails = Math.min(Math.abs(t[0] - 0.08), Math.abs(t[0] - 0.92)) - 0.05
      const d = Math.min(knot, rails)
      const a = cover(d, 0.06)
      if (a > 0.02) return [...carveAt(t, d), (a * 255) | 0]
    }

    t = local(RUNE_ISLANDS.gableMedallion, u, v)
    if (t) {
      const dx = t[0] - 0.5
      const dy = t[1] - 0.5
      const r = Math.hypot(dx, dy)
      const ring = Math.abs(r - 0.42) - 0.05
      const inner = Math.abs(r - 0.16) - 0.045
      // Eight spokes: fold the angle into one wedge and measure across it.
      const ang = Math.atan2(dy, dx)
      const fold = Math.abs(((ang / (Math.PI / 4)) % 1) - 0.5) * (Math.PI / 4)
      const spoke = Math.max(Math.sin(fold) * r - 0.035, r - 0.44, 0.14 - r)
      const d = Math.min(ring, inner, spoke)
      const a = cover(d, 0.05)
      if (a > 0.02) return [...carveAt(t, d), (a * 255) | 0]
    }

    t = local(RUNE_ISLANDS.runeRow, u, v)
    if (t) {
      // Seven stave-and-branch glyphs. Deliberately not a real futhark: this
      // is decoration, and inventing letters avoids writing something.
      const cellW = 1 / 7
      const gi = Math.min(6, Math.floor(t[0] / cellW))
      const lx = (t[0] - gi * cellW) / cellW
      const stave = Math.max(Math.abs(lx - 0.5) - 0.07, Math.abs(t[1] - 0.5) - 0.44)
      let d = stave
      // One or two branches per glyph, hashed, at hashed heights and slopes.
      const branches = 1 + (hash2(gi, 3) > 0.5 ? 1 : 0)
      for (let b = 0; b < branches; b++) {
        const hy = 0.25 + hash2(gi, b + 5) * 0.5
        const dir = hash2(gi, b + 9) > 0.5 ? 1 : -1
        const len = 0.22 + hash2(gi, b + 13) * 0.14
        const px = lx - 0.5
        const py = t[1] - hy
        // Distance to a 45-degree segment leaving the stave.
        const s = clamp01((px * dir + py) / (2 * len))
        d = Math.min(d, Math.hypot(px - dir * s * len, py - s * len) - 0.07)
      }
      const a = cover(d, 0.05)
      if (a > 0.02) return [...carveAt(t, d), (a * 255) | 0]
    }

    return [0, 0, 0, 0]
  })
}
