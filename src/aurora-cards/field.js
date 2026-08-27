// ---------------------------------------------------------------------------
// The ley-line potential, ported to JavaScript.
//
// ===========================================================================
// WHY THERE IS A CPU COPY OF A SHADER AT ALL
// ===========================================================================
//
// `src/aurora-lab/algo/leyline.js` builds a scalar potential over the sky's
// plan and draws its LEVEL SETS -- `tri(phi)` lights every contour of the
// family in one evaluation. That is beautiful and it is also why it costs what
// it costs: a field is defined everywhere, so the only way to find out where
// the channels ARE is to evaluate it at every point along every view ray. At
// forty steps and twenty-one noise lookups a step that is ~840 lookups per
// pixel, which is the 200x this whole exercise exists to remove.
//
// A contour is a CURVE. Curves can be found once, on the CPU, by marching
// squares (see trace.js) and then drawn as geometry -- at which point the
// fragment shader no longer has to search for them, because the triangles are
// already standing exactly where they are. The field is evaluated a few tens of
// thousands of times per REBUILD instead of a few hundred million times per
// frame.
//
// So this file is the same field, in JS. It is a port and not an invention:
// every constant below is copied from `src/aurora-lab/glsl/noise.js` and
// `algo/leyline.js`, and the reason to keep it faithful rather than to write a
// cheaper CPU field is that the ley-line sky has already been judged by eye and
// called gorgeous. Changing the field would throw that judgement away.
//
// ===========================================================================
// THE ONE PLACE THE TWO COPIES ARE ALLOWED TO DISAGREE
// ===========================================================================
//
// GLSL evaluates these in `highp float`, which is 32-bit; JS evaluates them in
// float64. `fract()` of a large argument therefore returns different bits in
// the two languages, and the hash lattices drift apart somewhere past a few
// thousand field units.
//
// That does not matter HERE and it would matter enormously in the lab, and the
// difference is worth stating: nothing on the GPU re-evaluates this field. The
// shader is handed vertex positions and never asks where they came from, so the
// CPU copy is the sole authority and there is no second opinion to disagree
// with. If a future version ever samples the same field in a shader -- to
// displace cards against the potential's gradient, say -- that stops being true
// and the two will need `Math.fround` at every step to stay in register.
// ---------------------------------------------------------------------------

const fract = (x) => x - Math.floor(x)

// Dave Hoskins' "Hash without Sine". Chosen in the GLSL over the
// fract(sin(dot())) idiom because that one depends on sin()'s precision at
// large arguments, which is implementation-defined; kept here so the CPU field
// is the same field.
export function hash21(px, py) {
  // vec3( p.xyx ) * 0.1031 -- note .x appears twice, so p3.x and p3.z start equal
  let x = fract(px * 0.1031)
  let y = fract(py * 0.1031)
  let z = x
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33)
  x += d; y += d; z += d
  return fract((x + y) * z)
}

// Returned through a module scratch pair rather than an array, because gnoise2
// calls this four times and gfbm2 calls gnoise2 three times and the warp calls
// gfbm2 four times: at 40,000 grid nodes that is 1.9M calls per rebuild, and
// 1.9M two-element arrays is a garbage-collection pause in the middle of a
// rebuild the user is watching.
let h22x = 0, h22y = 0

function hash22(px, py) {
  let x = fract(px * 0.1031)
  let y = fract(py * 0.1030)
  let z = fract(px * 0.0973)
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33)
  x += d; y += d; z += d
  // ( p3.xx + p3.yz ) * p3.zy
  h22x = fract((x + y) * z)
  h22y = fract((x + z) * y)
}

export function vnoise2(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py)
  const fx = px - ix, fy = py - iy
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const a = hash21(ix, iy)
  const b = hash21(ix + 1, iy)
  const c = hash21(ix, iy + 1)
  const d = hash21(ix + 1, iy + 1)
  const top = a + (b - a) * ux
  const bot = c + (d - c) * ux
  return top + (bot - top) * uy
}

// Perlin, remapped to 0..1 to be interchangeable with the value noise. The
// gradients are left UNNORMALISED exactly as in the GLSL -- the amplitude
// wobbles a few percent and a warp does not care.
export function gnoise2(px, py) {
  const ix = Math.floor(px), iy = Math.floor(py)
  const fx = px - ix, fy = py - iy
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)

  hash22(ix, iy)
  const a = (h22x * 2 - 1) * fx + (h22y * 2 - 1) * fy
  hash22(ix + 1, iy)
  const b = (h22x * 2 - 1) * (fx - 1) + (h22y * 2 - 1) * fy
  hash22(ix, iy + 1)
  const c = (h22x * 2 - 1) * fx + (h22y * 2 - 1) * (fy - 1)
  hash22(ix + 1, iy + 1)
  const d = (h22x * 2 - 1) * (fx - 1) + (h22y * 2 - 1) * (fy - 1)

  const top = a + (b - a) * ux
  const bot = c + (d - c) * ux
  return (top + (bot - top) * uy) * 0.7 + 0.5
}

// rot2( 0.6458 ), the ~37-degree inter-octave turn. GLSL's mat2( c, -s, s, c )
// is COLUMN major, so m * p is ( c*x + s*y, -s*x + c*y ). Ported literally
// rather than "fixed" to the textbook convention, because the field's look is
// the field this rotation produces.
const RC = Math.cos(0.6458)
const RS = Math.sin(0.6458)

// Gradient-noise fBm, three octaves. Used for warping only.
export function gfbm2(px, py) {
  let x = px, y = py
  let a = 0.5, s = 0, norm = 0
  for (let i = 0; i < 3; i++) {
    s += a * gnoise2(x, y)
    norm += a
    const nx = (RC * x + RS * y) * 2.13
    const ny = (-RS * x + RC * y) * 2.13
    x = nx; y = ny
    a *= 0.5
  }
  return s / norm
}

// The two-stage domain warp. Time enters as the SECOND coordinate of the noise
// lookups rather than as an addition to the first, so the pattern MORPHS IN
// PLACE instead of sliding across the sky -- see the long note in
// src/aurora-lab/glsl/noise.js, which is most of the difference between this
// family and the polygon bands it replaces.
export let warpX = 0, warpY = 0

export function warp2(px, py, t, amp, freq, stages) {
  const qx = gfbm2(px * freq, py * freq + t * 0.11) - 0.5
  const qy = gfbm2(px * freq + 5.2, py * freq + 1.3 + t * 0.09) - 0.5

  if (stages < 1.5) {
    warpX = px + amp * qx * 2.0
    warpY = py + amp * qy * 2.0
    return
  }

  const bx = px * freq * 2.1 + 3.4 * qx
  const by = py * freq * 2.1 + 3.4 * qy
  const rx = gfbm2(bx + 1.7, by + t * 0.15) - 0.5
  const ry = gfbm2(bx + 8.3, by + 2.8 - t * 0.13) - 0.5

  warpX = px + amp * (qx * 2.0 + rx * 0.9)
  warpY = py + amp * (qy * 2.0 + ry * 0.9)
}

// ---------------------------------------------------------------------------
// The potential itself.
//
//   phi = (warped y) * frequency + (an independent low-frequency field) * bend
//
// The first term alone gives horizontal lines. The warp is what makes them
// snake, and where the warp stops being injective the contour genuinely doubles
// back on itself -- folding is not a feature that had to be added, it is what a
// warp does. The bend breaks the contours out of being a strict function of one
// axis, so they can turn past ninety degrees, arch, and close into loops.
//
// `p` is in FIELD UNITS: kilometres times `fieldScale`, eye at the origin, -z
// north. Same convention as the lab's `auroraField`, so a tuning transfers.
// ---------------------------------------------------------------------------
export function phi(px, py, t, P) {
  const sx = px + P.fieldSeed * 37.13
  const sy = py + P.fieldSeed * 91.7

  warp2(sx, sy, t * P.leyMorph, P.leyWarp, P.leyWarpFreq, P.warpStages)

  let v = warpY * P.leyFreq
  if (P.leyBend > 0) {
    v += (gfbm2(warpX * P.leyBendFreq, warpY * P.leyBendFreq) - 0.5) * P.leyBend
  }
  return v
}
