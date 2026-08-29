// Bakes reference/skyrim-height-map.jpg into the coarse heightmap v2 reads.
//
//   node scripts/make-heightmap.mjs [--minY m] [--maxY m] [--size n]
//   node scripts/make-heightmap.mjs --survey        # the vertical-range table
//
// Writes public/world/height.png + public/world/height.json.
//
// The source is the ONE authored input to v2's world. §18 makes the coarse shape
// something a human moves rather than something a seed decides, and this script
// is the whole of "imports". It is deliberately a bake and not a load: every
// costly or scale-dependent decision -- JPEG decode, deblocking, the non-square
// fit, the metre range -- happens once, here, and src/v2/height/heightmap.js
// receives a square 16-bit image on the grid it already expects, with no runtime
// branch on the shape or the format of whatever the world came from.
//
// The PNG encoder lives in src/v2/height/png.js, next to the decoder that has to
// invert it, because the terrain brush in the v2 editor writes this same file
// from the browser and two encoders for one asset is one encoder too many. v1's
// scripts/heightmap-png.mjs keeps its own grayscale writer: that one is a
// diagnostic renderer, and folding it in would make a debug tool depend on v2's
// encoding.
//
// Everything the gate needs is exported. scripts/check-v2-heightmap.mjs re-runs
// this pipeline in memory and compares it against the shipped PNG, which is the
// only way an assertion about the asset can be about the asset rather than about
// a number this script also wrote into height.json.

import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { encodePng, readPng } from '../src/v2/height/png.js'
import { WORLD_SIZE, WORLD_HALF } from '../src/v2/config.js'

export const SOURCE_JPG = fileURLToPath(new URL('../reference/skyrim-height-map.jpg', import.meta.url))
const OUT_DIR = new URL('../public/world/', import.meta.url)
const PNG_PATH = new URL('height.png', OUT_DIR)
const JSON_PATH = new URL('height.json', OUT_DIR)

// The source's own dimensions, asserted rather than read, because every number
// below (the 6984 m of Z coverage, the 604 m mirror band) is derived from them
// and a different image silently reshapes the world.
export const SRC_W = 1024
export const SRC_H = 873

// THE VERTICAL RANGE, and where it came from.
//
// The JPEG is 8-bit and carries no metres, so this is a decision and not a
// measurement. It was made from the --survey table; re-run `--survey` before
// moving it rather than re-deriving the argument from this comment.
//
// The deciding number is the fraction of the world under the locomotion slope
// limit -- LOCOMOTION.maxSlopeDeg = 50 in src/player.js, itself derived from
// where chunk-mesh.js starts shading bare rock. Measured two ways, because the
// two read different fields at different stencils:
//
//   span   step  detail ratio | COARSE @8.01m       | COMPOSED @1.5m stride
//                             | walk%  med   p90    | walk%  med   p90   p99
//    300   1.18   0.38  1.55  | 99.2%   5.4  15.2   | 99.2%  11.6  23.5  46.4
//    450   1.76   0.38  2.33  | 98.6%   8.0  22.2   | 98.4%  13.1  28.8  56.4
//    600   2.35   0.38  3.12  | 97.8%  10.7  28.6   | 97.5%  15.0  33.9  63.4
//    900   3.53   0.38  4.70  | 95.5%  15.8  39.2   | 94.0%  19.5  43.1  71.7
//   1200   4.71   0.37  6.28  | 91.8%  20.6  47.4   | 89.8%  24.4  50.4  76.2
//
// The composed column is the honest instrument and the coarse one is not: the
// coarse column reads half the field (no detail.js) with a stencil five times
// wider than the slope limiter's stride, so it is optimistic by construction.
// The composed column can also be checked against a known answer -- run the same
// measurement on v1's shipped field and it returns 88.8% walkable, median 27.8
// deg, p90 51.1, the exact table in src/player.js, which is where the 50 deg
// limit came from.
//
// THE DETAIL COLUMN NO LONGER MOVES DOWN THE TABLE, and that is what makes the
// table readable as a choice at all. detail.js is calibrated against the
// import's UNEXAGGERATED relief (NATURAL_MAX_Y below), so raising this constant
// tilts the coarse ground and leaves the gravel where it was; the composed
// column therefore tracks the coarse one within 1.5 points at every span, and
// the gap between them is simply what detail costs. It used to be otherwise --
// detail grew with the span, the 900 m row read 86.8% composed against 95.5%
// coarse, and a rule of "match v1's 88.8%" moved by hundreds of metres whenever
// calibrateRough was retuned.
//
// The column that does still move is `ratio`, and it is now the binding
// constraint rather than walkability -- see QUANTISATION below.
//
// RELIEF PER KILOMETRE, as a cross-check rather than a criterion. v1 spans
// -0.62..313.06 m over 16 km, i.e. 19 m/km. 900 m over 8 km is 113 m/km, 5.9x
// v1's, because this is an authored range and not a procedural continent. The
// 8 km reading is also what makes it credible: heightmap-png.mjs has called this
// same image 6437 m across since build step 2, and 8192 is within 27% of that
// where the earlier 4096 was out by 1.57x.
//
// QUANTISATION IS THE ARGUMENT AGAINST GOING HIGHER, and the survey's ratio
// column is where to read it. The step is span/255, so the worst ripple bicubic
// leaves through it is span/510 -- 1.77 m at the shipped 900 m span, on a
// wavelength of one or two texels, i.e. 8 to 16 m of gentle terracing on ground
// too shallow to hide it.
//
// That ripple used to be invisible in the table because detail.js grew with the
// span alongside it and the ratio between them stayed at 1.55 down every row.
// It does not any more: the detail term is calibrated against the import's
// UNEXAGGERATED relief (NATURAL_MAX_Y below), so its rms sits at 0.38 m whatever
// this constant says, while the source staircase keeps scaling. At 900 m the
// ratio is 4.7, which means the largest feature in the fine band is now the
// 8-bit source step and not the terrain -- §18 wanted the detail an order of
// magnitude ABOVE the ripple and it is most of an order of magnitude below.
//
// The cure is a 16-bit source image, not a louder detail term: turning detail
// back up to cover the staircase is what put gravel and craters on the ground at
// 6 cm cells, which is the complaint the exaggeration divide exists to answer.
//
// minY is 0 and not a negative sea level. §18's water is a LAYER (lakes carve
// basins, see src/v2/layers/water-bodies.js), so the import has no reason to
// spend codes on ground below the darkest pixel of the image -- and 9.8% of the
// image already sits on that floor.
//
// MAX_Y WENT 300 -> 600 -> 900, BY EYE AND ON PURPOSE. The survey chooses a
// range that keeps slopes walkable; what it cannot judge is whether the world
// reads as mountains, and at 300 m over 8 km it did not -- nor, from the ground,
// at 600. Every raise scales every coarse slope with it, so this is a trade and
// here is the current side of it: at 900 the coarse column is 95.5% walkable and
// the composed column is 94.0%, against v1's shipped 88.8%. The composed p99 is
// 71.7 deg, past LOCOMOTION.maxSlopeDeg, so the steepest percentile of the world
// is ground she is refused rather than ground she climbs slowly -- acceptable
// for scenery, since a cliff is allowed to be a cliff and the rivers and roads
// are authored layers that flatten their own way through.
//
// The wall is no longer walkability. Detail stopped scaling with this constant
// when the exaggeration divide landed, so the composed column now sits within
// 1.5 points of the coarse one and 1200 m would still be 89.8% -- fine on that
// axis. What does NOT survive the raise is the 8-bit source: see the ratio
// column above. Anything past 900 should come with a 16-bit import, not with a
// bigger number here.
//
// Raising it is a one-flag experiment: this constant is the only thing that has
// to move, because the PNG stores normalised levels and every metre in v2 is
// recovered through minY/maxY in world/height.json. What does NOT follow it is
// the authored content -- snow base, snow point deltas, lake and spline
// elevations are metres in public/world/layers.json and a rebake leaves them
// where they were, at the wrong height on the new ground. Run
// `node scripts/rescale-world.mjs <factor>` over the document in the same pass.
export const MIN_Y = 0
export const MAX_Y = 900

// THE STRETCH IS DECLARED, because the procedural detail must not follow it.
//
// NATURAL_MAX_Y is the range the survey argues for on its own terms -- the row
// where the composed field's walkable fraction still sits comfortably above the
// world v1 was tuned against -- and 300 m over 8 km is it. Everything above that
// is DRAMA: a deliberate vertical exaggeration, chosen by eye, for a world that
// otherwise reads as hills rather than mountains.
//
// The distinction has to be recorded because detail.js cannot see it. Its
// amplitude comes from calibrateRough, which measures the coarse field's own
// structure function and scales the octave table to continue it below one texel.
// That is exactly right for an unexaggerated import and exactly wrong for a
// stretched one: stretching the image 3x multiplies its roughness at every lag
// by 3, so the calibration faithfully asks for 3x the sub-texel detail and the
// ground turns to gravel and craters at 6 cm cells while the mountains behind it
// look correct. The macro shape is exaggerated on purpose; the boulder under her
// boot is not, and a boulder scaled by the same 3 is a boulder in the wrong
// world.
//
// So the ratio travels with the bake, in world/height.json, and V2Height divides
// the calibrated amplitude by it. See calibrateRough in src/v2/height/detail.js.
// An import with no `exaggeration` in its meta reads as 1, which is the only
// honest reading of an image that never said it was stretched.
export const NATURAL_MAX_Y = 300

// The 8x8 DCT grid. Baseline JPEG transforms 8x8 blocks of luma aligned to pixel
// zero regardless of chroma subsampling, so the block edges sit between columns
// 7|8, 15|16, ... in both axes.
const BLOCK = 8

// The most a single boundary correction may move the field, in SOURCE LEVELS.
//
// One level is the step the 8-bit encoding already quantised the terrain to, so
// this says: the deblocker may never displace the ground by more than the amount
// the file format has already thrown away. A ridge line crossing a block
// boundary can be softened by at most 1/3 of a level per axis pass (the
// correction is split three ways, see deblockAxis), i.e. 0.67 levels = 2.35 m at
// the shipped 900 m span, and that bound is what the gate's ridge test enforces.
export const DEBLOCK_CAP = 1

// ---------------------------------------------------------------------------
// 1. Decode the JPEG.
//
// No dependency and no hand-written JPEG decoder: shell out to a converter that
// is already on the machine, then read the PNG with the repo's own decoder. This
// is why the committed .jpg is enough to reproduce the bake.
// ---------------------------------------------------------------------------

/**
 * Convert the source JPEG to PNG in `dir` and decode it.
 *
 * The image is grayscale stored as RGB. That is ASSERTED, not assumed -- if the
 * three channels ever disagree, "luminance" becomes a weighting choice and the
 * baked elevations depend on it, so the script would rather stop than pick one.
 */
export async function decodeSource(dir) {
  if (!existsSync(SOURCE_JPG)) throw new Error(`make-heightmap: no source image at ${SOURCE_JPG}`)
  const out = join(dir, 'source.png')
  const argv = ['-s', 'format', 'png', SOURCE_JPG, '--out', out]
  try {
    execFileSync('sips', argv, { stdio: 'pipe' })
  } catch (e) {
    // Loudly, and with the command, because the next person's machine is the one
    // this fails on. Deliberately no second-choice converter: ffmpeg and magick
    // would each decode the JPEG with their own IDCT and colour handling, and a
    // silent fallback would mean the world quietly changed shape depending on
    // what happened to be installed.
    throw new Error(`make-heightmap: JPEG -> PNG conversion failed. Ran: sips ${argv.join(' ')}\n${e.message}`)
  }

  const png = await readPng(out)
  if (png.width !== SRC_W || png.height !== SRC_H) {
    throw new Error(`make-heightmap: source is ${png.width}x${png.height}, expected ${SRC_W}x${SRC_H} -- the fit constants below are derived from that shape`)
  }
  if (png.channels < 3) throw new Error(`make-heightmap: source decoded to ${png.channels} channel(s), expected RGB`)
  if (png.depth !== 8) throw new Error(`make-heightmap: source decoded at depth ${png.depth}, expected 8`)

  const n = png.width * png.height
  let maxRG = 0
  let maxGB = 0
  const levels = new Float64Array(n)
  for (let i = 0, o = 0; i < n; i++, o += png.channels) {
    const r = png.data[o]
    maxRG = Math.max(maxRG, Math.abs(r - png.data[o + 1]))
    maxGB = Math.max(maxGB, Math.abs(png.data[o + 1] - png.data[o + 2]))
    levels[i] = r
  }
  if (maxRG !== 0 || maxGB !== 0) {
    throw new Error(`make-heightmap: source channels disagree (max |R-G| ${maxRG}, |G-B| ${maxGB}) -- it is not the grayscale-in-RGB image this bake assumes`)
  }
  return { levels, width: png.width, height: png.height, maxRG, maxGB }
}

// ---------------------------------------------------------------------------
// 2. Deblocking.
//
// WHY THIS MATTERS AT ALL: v2's finest cell is 50 cm (config.js MAX_DEPTH), and
// bicubic interpolation reproduces whatever is in the samples. An 8-px DCT
// artifact in a 1024-px image is a 64 m period on an 8 km world -- corduroy
// running the full width of the map, at an amplitude of a metre or two, which is
// exactly the scale a low sun picks out.
//
// WHY NOT A GAUSSIAN: the artifact is a fraction of a level and so are the
// features. Any isotropic low-pass strong enough to remove the block edges takes
// the ridge lines with it -- and ridge lines are the only reason to import a
// hand-authored heightmap in the first place. The gate runs a 1-2-1 binomial
// blur as a control and shows it failing the ridge test while passing the block
// test, which is what makes the block test worth having.
//
// WHAT THIS DOES INSTEAD: it targets the artifact by its signature. Across a
// block boundary between samples c-1 and c, take
//
//     t3 = f[c+1] - 3 f[c] + 3 f[c-1] - f[c-2]
//
// the third difference straddling the seam. t3 is identically zero for ANY
// polynomial of degree <= 2 -- it is antisymmetric about the boundary and
// annihilates constants, ramps and curvature alike -- so a hillside, a valley
// floor and the shoulder of a ridge all read zero no matter how steep. What it
// does not annihilate is a step, and a step is precisely what a mismatched pair
// of IDCTs leaves behind. d = -t3/2 is the size of that step.
//
// Terrain has genuine third differences too, so d is not all artifact. The
// natural scale T is measured locally from |t3| at the four nearest NON-boundary
// positions (two in each block, none of them straddling the seam), and the
// correction is a soft shrinkage: only the excess |d| - k*T is removed, capped
// at DEBLOCK_CAP. Soft rather than hard because a hard threshold puts a
// discontinuity into the filter's own response, which reappears as a different
// artifact at the same 8-px period.
//
// Applying a/3 to f[c-1] and -a/3 to f[c] annihilates exactly `a` of the seam's
// third difference and nothing else: with p0 += a/3 and q0 -= a/3, t3 changes by
// 2a and the two second differences that touch the seam each change by a.
//
// k IS SOLVED FOR, NOT CHOSEN. The criterion is physical and needs no taste: an
// isotropic field has no reason to be rougher on multiples of 8, so k is
// bisected, per axis, until the mean |second difference| at boundary positions
// equals the mean at interior positions. It comes out near 1.6 on X and 0.61 on
// Z for this image -- they differ because a hillshaded map has a light direction
// and its two axes genuinely have different spectra, which is the whole reason
// one hand-picked constant could not serve both.
// ---------------------------------------------------------------------------

/**
 * Mean |second difference| by position-mod-8, and the boundary/interior ratio.
 *
 * The seam between blocks lies between index 7 and index 8, so BOTH phase 0 and
 * phase 7 carry it (each of their three-point stencils straddles it) and the
 * boundary statistic is their mean. Phases 1..6 are the interior.
 */
export function blockRatio(f, w, h, axis) {
  const sum = new Float64Array(BLOCK)
  const n = new Int32Array(BLOCK)
  if (axis === 'x') {
    for (let j = 0; j < h; j++) {
      for (let i = 1; i < w - 1; i++) {
        sum[i % BLOCK] += Math.abs(f[j * w + i - 1] - 2 * f[j * w + i] + f[j * w + i + 1])
        n[i % BLOCK]++
      }
    }
  } else {
    for (let j = 1; j < h - 1; j++) {
      for (let i = 0; i < w; i++) {
        sum[j % BLOCK] += Math.abs(f[(j - 1) * w + i] - 2 * f[j * w + i] + f[(j + 1) * w + i])
        n[j % BLOCK]++
      }
    }
  }
  const phase = Array.from(sum, (s, k) => s / n[k])
  let interior = 0
  for (let k = 1; k <= 6; k++) interior += phase[k] / 6
  const boundary = (phase[0] + phase[7]) / 2
  return { phase, boundary, interior, ratio: boundary / interior }
}

/**
 * Ridge sharpness. The load-bearing half of the deblock gate: a filter that
 * flattens everything passes blockRatio trivially, and these are the numbers it
 * cannot fake.
 *
 * `tv` is the mean |first difference| over both axes -- total variation per
 * sample, the amount of relief per texel in the image. The percentiles are the
 * steep tail: p9999 and max are single ridge crests and cliff lips, the features
 * a too-eager filter rounds off first and the ones a heightmap exists to carry.
 */
export function ridgeStat(f, w, h) {
  const d = new Float64Array((w - 1) * h + w * (h - 1))
  let at = 0
  let tv = 0
  for (let j = 0; j < h; j++) for (let i = 1; i < w; i++) d[at++] = Math.abs(f[j * w + i] - f[j * w + i - 1])
  for (let j = 1; j < h; j++) for (let i = 0; i < w; i++) d[at++] = Math.abs(f[j * w + i] - f[(j - 1) * w + i])
  for (let i = 0; i < d.length; i++) tv += d[i]
  d.sort()
  const q = (p) => d[Math.min(d.length - 1, Math.floor(d.length * p))]
  return { tv: tv / d.length, p99: q(0.99), p999: q(0.999), p9999: q(0.9999), max: d[d.length - 1] }
}

/** One deblocking pass along `axis`. Returns a new field; `f` is untouched. */
export function deblockAxis(f, w, h, axis, k, cap) {
  const out = Float64Array.from(f)
  const idx = axis === 'x' ? (a, line) => line * w + a : (a, line) => a * w + line
  const len = axis === 'x' ? w : h
  const lines = axis === 'x' ? h : w
  const t3 = (line, n) => f[idx(n + 2, line)] - 3 * f[idx(n + 1, line)] + 3 * f[idx(n, line)] - f[idx(n - 1, line)]
  let moved = 0
  let total = 0
  for (let line = 0; line < lines; line++) {
    for (let c = BLOCK; c + BLOCK <= len; c += BLOCK) {
      const n = c - 1
      // The natural-scale taps reach from n-4 to n+5; near the image edge there
      // is no honest local estimate of T, so those seams are left alone. Four
      // seams out of 127 per line.
      if (n - 4 < 0 || n + 5 >= len) continue
      total++
      const d = -t3(line, n) / 2
      // n-3 and n-2 sit wholly inside the left block, n+2 and n+3 wholly inside
      // the right one. None of the four straddles the seam, so none of them is
      // contaminated by the thing being measured.
      const nat = [Math.abs(t3(line, n - 3)), Math.abs(t3(line, n - 2)), Math.abs(t3(line, n + 2)), Math.abs(t3(line, n + 3))]
      nat.sort((a, b) => a - b)
      // Median of the four, halved into the same units as d (d = -t3/2).
      const T = (nat[1] + nat[2]) / 4
      let a = Math.sign(d) * Math.max(0, Math.abs(d) - k * T)
      if (a > cap) a = cap
      else if (a < -cap) a = -cap
      if (a === 0) continue
      out[idx(c - 1, line)] += a / 3
      out[idx(c, line)] -= a / 3
      moved++
    }
  }
  return { out, moved, total }
}

/** Bisect k so that one pass along `axis` lands the boundary/interior ratio on 1. */
function solveK(f, w, h, axis, cap) {
  // k = 0 removes the whole seam third difference and overshoots below 1;
  // k = 16 leaves the field alone. The ratio is monotone in k between them, so
  // 24 bisections put k to within 1e-6.
  let lo = 0
  let hi = 16
  let best = null
  for (let it = 0; it < 24; it++) {
    const k = (lo + hi) / 2
    const pass = deblockAxis(f, w, h, axis, k, cap)
    const ratio = blockRatio(pass.out, w, h, axis).ratio
    best = { k, ratio, ...pass }
    if (ratio < 1) lo = k
    else hi = k
  }
  if (!(Math.abs(best.ratio - 1) < 0.02)) {
    throw new Error(`make-heightmap: deblock on ${axis} could not reach a boundary/interior ratio of 1 (got ${best.ratio.toFixed(4)} at k=${best.k.toFixed(4)}) -- the artifact does not look like a block-edge step`)
  }
  return best
}

/**
 * Deblock both axes, X then Z, one calibrated pass each.
 *
 * The two are independent for the purposes of the statistic: the X pass only
 * ever moves pairs of samples that are adjacent in X, which shifts every row's
 * contribution to the Z statistic by the same phase-independent amount, and vice
 * versa. So solving them in sequence rather than jointly is not an approximation
 * -- measured, the X ratio moves by under 0.001 when the Z pass runs after it.
 */
export function deblock(f, w, h, cap = DEBLOCK_CAP) {
  const before = { x: blockRatio(f, w, h, 'x'), y: blockRatio(f, w, h, 'y'), ridge: ridgeStat(f, w, h) }
  const sx = solveK(f, w, h, 'x', cap)
  const sy = solveK(sx.out, w, h, 'y', cap)
  const out = sy.out
  let maxDelta = 0
  let sse = 0
  for (let i = 0; i < out.length; i++) {
    const e = out[i] - f[i]
    sse += e * e
    maxDelta = Math.max(maxDelta, Math.abs(e))
  }
  const after = { x: blockRatio(out, w, h, 'x'), y: blockRatio(out, w, h, 'y'), ridge: ridgeStat(out, w, h) }
  return {
    field: out,
    kx: sx.k,
    kz: sy.k,
    cap,
    touchedX: sx.moved / sx.total,
    touchedZ: sy.moved / sy.total,
    rms: Math.sqrt(sse / out.length),
    maxDelta,
    before,
    after,
  }
}

// ---------------------------------------------------------------------------
// 3. The non-square fit.
//
// The image is 1024 x 873 and the world box is square, so the image covers the
// full WORLD_SIZE in X and SRC_H/SRC_W * WORLD_SIZE in Z, centred. Beyond that
// the field is MIRRORED about the last real row rather than clamped: clamping
// extrudes the edge row into flat ridges running the width of the map, which
// reads as a bug in the mesher rather than as the edge of the world.
//
// A whole-sample mirror is C0 and has ZERO Z-gradient at the seam by
// construction. That is a real consequence and it is asserted rather than hoped
// for: a watershed line runs the full width of the map at each seam, and the
// 604 m band beyond it is the interior terrain reflected -- not flat, but not
// new either. It is the far edge of the map, past anything the play area uses,
// and the gate pins its extent so it cannot grow silently.
//
// This happens at BAKE time. The shipped PNG is square and edge-to-edge on the
// world box, so heightmap.js needs no fit mode and no runtime branch.
// ---------------------------------------------------------------------------

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

/** Metres of Z the source covers, centred on the origin. */
export const SRC_Z_SPAN = (SRC_H / SRC_W) * WORLD_SIZE
/** Half-width of the mirrored band at each Z edge. */
export const MIRROR_BAND = (WORLD_SIZE - SRC_Z_SPAN) / 2
/** World Z of the first and last real source rows -- where the seam sits. */
export const SEAM_Z = SRC_Z_SPAN / 2

/**
 * Resample the source grid onto the square output grid with the SAME bicubic
 * (Catmull-Rom) heightmap.js reads it back with, so the bake and the runtime
 * agree about what lies between texels.
 *
 * Registration is heightmap.js's, exactly: texel 0 on the -X/-Z world edge,
 * texel size-1 on the +X/+Z edge, spacing WORLD_SIZE / (size - 1). At size ===
 * SRC_W the X mapping is the identity -- the two spacings are the same
 * expression and divide to exactly 1.0 -- so X is passed through untouched and
 * only Z is genuinely resampled.
 */
export function fitSquare(f, w, h, size) {
  const srcStepX = WORLD_SIZE / (w - 1)
  const srcStepZ = SRC_Z_SPAN / (h - 1)
  const outStep = WORLD_SIZE / (size - 1)

  const mirror = (j) => {
    let v = j
    // Whole-sample symmetric: reflect about row 0 and about row h-1. A loop
    // rather than one reflection because a much smaller source would need more
    // than one bounce, and a wrong answer there would be a folded world.
    for (let guard = 0; guard < 64; guard++) {
      if (v < 0) v = -v
      else if (v > h - 1) v = 2 * (h - 1) - v
      else return v
    }
    throw new Error(`make-heightmap: mirror(${j}) did not converge for a ${h}-row source`)
  }
  const tap = (i, j) => f[mirror(j) * w + (i < 0 ? 0 : i >= w ? w - 1 : i)]

  const out = new Float64Array(size * size)
  for (let oj = 0; oj < size; oj++) {
    const z = -WORLD_HALF + oj * outStep
    const v = (z + SEAM_Z) / srcStepZ
    const j = Math.floor(v)
    const fz = v - j
    for (let oi = 0; oi < size; oi++) {
      const x = -WORLD_HALF + oi * outStep
      const u = (x + WORLD_HALF) / srcStepX
      const i = Math.floor(u)
      const fx = u - i
      const r0 = catmull(tap(i - 1, j - 1), tap(i, j - 1), tap(i + 1, j - 1), tap(i + 2, j - 1), fx)
      const r1 = catmull(tap(i - 1, j), tap(i, j), tap(i + 1, j), tap(i + 2, j), fx)
      const r2 = catmull(tap(i - 1, j + 1), tap(i, j + 1), tap(i + 1, j + 1), tap(i + 2, j + 1), fx)
      const r3 = catmull(tap(i - 1, j + 2), tap(i, j + 2), tap(i + 1, j + 2), tap(i + 2, j + 2), fx)
      out[oj * size + oi] = catmull(r0, r1, r2, r3, fz)
    }
  }
  return { field: out, srcStepX, srcStepZ, outStep }
}

// ---------------------------------------------------------------------------
// 4. The whole pipeline, in one call, so the gate runs exactly what shipped.
// ---------------------------------------------------------------------------

export async function bakeLevels(size = SRC_W) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-heightmap-'))
  try {
    const src = await decodeSource(dir)
    const db = deblock(src.levels, src.width, src.height)
    const fit = fitSquare(db.field, src.width, src.height, size)
    let lo = Infinity
    let hi = -Infinity
    let clamped = 0
    const levels = fit.field
    for (let i = 0; i < levels.length; i++) {
      const v = levels[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
      if (v < 0) {
        levels[i] = 0
        clamped++
      } else if (v > 255) {
        levels[i] = 255
        clamped++
      }
    }
    return { levels, size, src, deblock: db, fit, levelMin: lo, levelMax: hi, clamped }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Levels 0..255 -> metres. Level 0 is minY and level 255 is maxY, exactly. */
export const toMetres = (level, minY = MIN_Y, maxY = MAX_Y) => minY + (level / 255) * (maxY - minY)

// ---------------------------------------------------------------------------
// The PNG writer.
// ---------------------------------------------------------------------------

// The PNG writer lives in src/v2/height/png.js, next to the decoder, because the
// terrain brush in the v2 editor writes the same file from the browser and two
// encoders for one asset is one encoder too many. It is byte-identical to the
// one that used to be here: RGB8, Paeth on every scanline, deflate level 9.
async function writeRgbPng(path, w, h, pixels) {
  writeFileSync(path, await encodePng(w, h, pixels))
}

/**
 * Levels -> rg16 bytes.
 *
 * 65535 and not 65536: a full-white pixel has to land exactly on maxY, matching
 * the decoder in heightmap.js, or the top of every mountain is one quantum low
 * and the gate's round-trip error is biased instead of centred. Level 255 * 257
 * is 65535 exactly, which is the same statement in the source's units.
 */
export function encodeRg16(levels) {
  const px = Buffer.alloc(levels.length * 3)
  for (let i = 0; i < levels.length; i++) {
    let q = Math.round(levels[i] * 257)
    if (q < 0) q = 0
    else if (q > 65535) q = 65535
    const highByte = q >> 8
    px[i * 3] = highByte
    px[i * 3 + 1] = q & 0xff
    // B repeats the high byte so R and B carry a legible 8-bit grayscale of the
    // terrain. An image viewer's perceived luminance is ~70% green and green is
    // the low byte, so the file as a whole reads as noise -- look at the red or
    // blue channel alone to see the landscape.
    px[i * 3 + 2] = highByte
  }
  return px
}

// ---------------------------------------------------------------------------
// --survey: the table that chose MIN_Y / MAX_Y.
// ---------------------------------------------------------------------------

// src/player.js LOCOMOTION.maxSlopeDeg. Duplicated rather than imported because
// player.js pulls in three.js and this script must stay node-runnable; the gate
// asserts the two are still the same number.
export const MAX_SLOPE_DEG = 50

/**
 * Slope in degrees at every interior texel of the FINAL grid, central difference
 * at one texel spacing -- the finest thing this grid can honestly answer, and
 * the same stencil heightmap.js's slopeAt uses.
 *
 * This is the COARSE field only. detail.js adds relief on top of it, and the
 * locomotion limiter reads a 1.5 m stride rather than an 8 m one, so every
 * walkable fraction below is an upper bound on what she will actually find.
 */
function slopeDegrees(levels, size, minY, maxY) {
  const step = WORLD_SIZE / (size - 1)
  const k = (maxY - minY) / 255
  const out = new Float64Array((size - 2) * (size - 2))
  let at = 0
  for (let j = 1; j < size - 1; j++) {
    for (let i = 1; i < size - 1; i++) {
      const gx = ((levels[j * size + i + 1] - levels[j * size + i - 1]) * k) / (2 * step)
      const gz = ((levels[(j + 1) * size + i] - levels[(j - 1) * size + i]) * k) / (2 * step)
      out[at++] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI
    }
  }
  return out
}

/**
 * Build a Heightmap from a level field and a candidate range, without touching
 * the disk.
 *
 * `exaggeration` is carried exactly as the writer below carries it, and it is
 * what makes the survey's composed column mean anything: the runtime divides the
 * detail amplitude by it, so a candidate range that is mostly stretch pays for
 * that stretch in COARSE slope alone. Leave it out and every row would report
 * the composed field of a world nobody ships.
 */
export async function heightmapFor(levels, size, minY, maxY) {
  const { Heightmap } = await import('../src/v2/height/heightmap.js')
  return Heightmap.fromDecoded(
    { width: size, height: size, channels: 3, depth: 8, data: encodeRg16(levels) },
    { world: WORLD_SIZE, size, minY, maxY, encoding: 'rg16', exaggeration: (maxY - minY) / (NATURAL_MAX_Y - MIN_Y) }
  )
}

async function survey(baked) {
  const { levels, size } = baked
  const step = WORLD_SIZE / (size - 1)
  const { Detail, KNEE_TEXELS, calibrateRough } = await import('../src/v2/height/detail.js')

  let atFloor = 0
  for (let i = 0; i < levels.length; i++) if (levels[i] <= 0) atFloor++

  console.log(`\nsource        ${baked.src.width}x${baked.src.height}, channels agree exactly (max |R-G| ${baked.src.maxRG}, |G-B| ${baked.src.maxGB})`)
  console.log(`grid          ${size}x${size}  ${step.toFixed(4)} m/texel over ${WORLD_SIZE} m`)
  console.log(
    `aspect        source X spacing ${(WORLD_SIZE / (baked.src.width - 1)).toFixed(5)} m, Z spacing ${(SRC_Z_SPAN / (baked.src.height - 1)).toFixed(5)} m` +
      `  -- Z/X ${((SRC_Z_SPAN / (baked.src.height - 1)) / (WORLD_SIZE / (baked.src.width - 1))).toFixed(6)}, anisotropy ${(((SRC_Z_SPAN / (baked.src.height - 1)) / (WORLD_SIZE / (baked.src.width - 1)) - 1) * 100).toFixed(4)}%`
  )
  console.log(`levels        ${(atFloor / levels.length * 100).toFixed(2)}% of the world sits on the level-0 floor; 255 usable levels in the source`)
  console.log(`\nwalkable is slope <= ${MAX_SLOPE_DEG} deg (src/player.js LOCOMOTION.maxSlopeDeg), COARSE FIELD ONLY,`)
  console.log(`central difference at the ${step.toFixed(2)} m texel spacing -- detail.js adds slope on top, so these are upper bounds.\n`)

  console.log('                      COARSE FIELD, 8.01 m stencil        COMPOSED (+detail), 1.5 m stride')
  console.log('minY  maxY   step  detail  ratio   walk%   med    p90    p99  |  walk%   med    p90    p99  |  elev p50   p90     >95m   >148m  >250m')

  const elev = Float64Array.from(levels)
  elev.sort()
  const eq = (p) => elev[Math.floor(elev.length * p)]

  for (const [minY, maxY] of [
    [0, 300],
    [0, 450],
    [0, 600],
    [0, 900],
    [0, 1200],
    [-20, 300],
    [-20, 600],
    [-20, 900],
  ]) {
    const span = maxY - minY
    const sl = slopeDegrees(levels, size, minY, maxY)
    let walk = 0
    for (let i = 0; i < sl.length; i++) if (sl[i] <= MAX_SLOPE_DEG) walk++
    sl.sort()
    const sq = (p) => sl[Math.floor(sl.length * p)]

    // What detail.js will actually add on top of THIS range. Not a constant:
    // calibrateRough matches the detail term to the coarse field's own structure
    // function, so the amplitude scales with the span -- which is exactly why the
    // `ratio` column below is flat, and why quantisation cannot be the argument
    // that picks a range. See the note under the table.
    const hm = await heightmapFor(levels, size, minY, maxY)
    const knee = hm.texelSize * KNEE_TEXELS
    const { rough } = calibrateRough({ heightmap: hm, seed: 20260804, knee })
    const detail = new Detail({ seed: 20260804, knee, rough })
    let s2 = 0
    let sd = 0x9e3779b9
    const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296)
    const N = 6000
    for (let n = 0; n < N; n++) {
      const x = (rnd() * 2 - 1) * (WORLD_HALF - 64)
      const z = (rnd() * 2 - 1) * (WORLD_HALF - 64)
      const v = detail.at(x, z, 0, hm.slopeAt(x, z), 0)
      s2 += v * v
    }
    const detailRms = Math.sqrt(s2 / N)

    // The number that is actually comparable to v1's shipped 88.8%: the COMPOSED
    // field (coarse + detail), read the way the slope limiter reads it -- a
    // central difference at eps 0.75 m, i.e. over the 1.5 m stride. Nothing else
    // in this table is that; the coarse columns are a 8 m stencil on half the
    // field, and they run 6-8 points optimistic because of it.
    const eps = 0.75
    const h2 = (x, z) => hm.sample(x, z) + detail.at(x, z, 0, hm.slopeAt(x, z), 0)
    const comp = new Float64Array(N)
    sd = 0x243f6a88
    for (let n = 0; n < N; n++) {
      const x = (rnd() * 2 - 1) * (WORLD_HALF - 64)
      const z = (rnd() * 2 - 1) * (WORLD_HALF - 64)
      const gx = (h2(x + eps, z) - h2(x - eps, z)) / (2 * eps)
      const gz = (h2(x, z + eps) - h2(x, z - eps)) / (2 * eps)
      comp[n] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI
    }
    let cwalk = 0
    for (let n = 0; n < N; n++) if (comp[n] <= MAX_SLOPE_DEG) cwalk++
    comp.sort()
    const cq = (p) => comp[Math.floor(N * p)]

    const m = (l) => toMetres(l, minY, maxY)
    const above = (h) => {
      const lv = ((h - minY) / span) * 255
      let a = 0
      let b = elev.length
      while (a < b) {
        const mid = (a + b) >> 1
        if (elev[mid] < lv) a = mid + 1
        else b = mid
      }
      return (1 - a / elev.length) * 100
    }
    console.log(
      `${String(minY).padStart(4)} ${String(maxY).padStart(5)}  ` +
        `${(span / 255).toFixed(2).padStart(5)}  ${detailRms.toFixed(2).padStart(6)}  ${(span / 510 / detailRms).toFixed(3).padStart(5)}  ` +
        `${((walk / sl.length) * 100).toFixed(1).padStart(5)}%  ${sq(0.5).toFixed(1).padStart(5)}  ${sq(0.9).toFixed(1).padStart(5)}  ${sq(0.99).toFixed(1).padStart(5)}  | ` +
        `${((cwalk / N) * 100).toFixed(1).padStart(5)}%  ${cq(0.5).toFixed(1).padStart(5)}  ${cq(0.9).toFixed(1).padStart(5)}  ${cq(0.99).toFixed(1).padStart(5)}  | ` +
        `${m(eq(0.5)).toFixed(0).padStart(7)}  ${m(eq(0.9)).toFixed(0).padStart(5)}   ` +
        [95, 148, 250].map((h) => `${above(h).toFixed(1)}%`.padEnd(7)).join('')
    )
  }
  console.log('\nstep is span/255, the source quantisation in metres; half-s is the worst residual ripple bicubic leaves through it.')
  console.log('detail is the rms of detail.js at cell 0 over the world, calibrated against this range and then divided by the')
  console.log(`exaggeration this row implies (span / ${NATURAL_MAX_Y - MIN_Y} m). It is CONSTANT down the table, and that is the point: stretching`)
  console.log('the world is a decision about the skyline, and the gravel under her boot is not supposed to hear about it.')
  console.log('ratio = half-s / detail, and it therefore GROWS with the range. Read it as a warning column: above about 2 the largest')
  console.log("thing in the fine band is no longer terrain but the 8-bit source's own staircase, ~8 m of wavelength and half-s tall,")
  console.log('and the cure for that is a 16-bit source image rather than a louder detail term.')
  console.log(`The composed walk% column is the honest one -- compare against v1's shipped 88.8% (the table in src/player.js). It now`)
  console.log('tracks the coarse column closely, because detail no longer grows with the span; the gap between them is what detail costs.')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  let minY = MIN_Y
  let maxY = MAX_Y
  let size = SRC_W
  let wantSurvey = false
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--survey') wantSurvey = true
    else if (a === '--force') force = true
    else if (a === '--minY') minY = Number(argv[++i])
    else if (a === '--maxY') maxY = Number(argv[++i])
    else if (a === '--size') size = Number(argv[++i])
    else throw new Error(`make-heightmap: unknown argument '${a}' (expected --survey, --force, --minY, --maxY, --size)`)
  }

  // THE SCULPT GUARD. The v2 terrain brush writes texels straight into
  // height.png and marks the meta `sculpted` (see the /__height middleware in
  // vite.config.js). Those edits exist in no other file: they are not in
  // layers.json, they are not parametric, and re-baking would silently replace
  // an afternoon of them with the JPEG. Refuse, and say what to do instead.
  if (!wantSurvey && !force && existsSync(JSON_PATH)) {
    const prev = JSON.parse(readFileSync(JSON_PATH, 'utf8'))
    if (prev.sculpted) {
      throw new Error(
        'make-heightmap: public/world/height.png has been sculpted in the v2 editor and re-baking would discard those edits.\n' +
          '  Copy it somewhere first if you want them, then re-run with --force.'
      )
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) throw new Error(`make-heightmap: --minY/--maxY must be finite metres, got ${minY}/${maxY}`)
  if (maxY <= minY) throw new Error(`make-heightmap: --maxY ${maxY} must be above --minY ${minY}`)
  if (!Number.isInteger(size) || size < 8) throw new Error(`make-heightmap: --size ${size} must be an integer >= 8`)

  const baked = await bakeLevels(size)
  const db = baked.deblock

  console.log(
    `\ndeblock       cap ${db.cap} level, solved kx ${db.kx.toFixed(4)} kz ${db.kz.toFixed(4)}  ` +
      `touched ${(db.touchedX * 100).toFixed(0)}% of X seams, ${(db.touchedZ * 100).toFixed(0)}% of Z seams`
  )
  console.log(
    `              block-boundary / interior mean |d2|:  X ${db.before.x.ratio.toFixed(4)} -> ${db.after.x.ratio.toFixed(4)}   ` +
      `Z ${db.before.y.ratio.toFixed(4)} -> ${db.after.y.ratio.toFixed(4)}`
  )
  console.log(
    `              ridge kept: tv ${((db.after.ridge.tv / db.before.ridge.tv) * 100).toFixed(2)}%  ` +
      `p99.99 ${((db.after.ridge.p9999 / db.before.ridge.p9999) * 100).toFixed(2)}%  ` +
      `max ${((db.after.ridge.max / db.before.ridge.max) * 100).toFixed(2)}%   ` +
      `moved rms ${db.rms.toFixed(4)} / max ${db.maxDelta.toFixed(4)} levels`
  )
  console.log(
    `fit           source covers ${SRC_Z_SPAN.toFixed(1)} m of Z, centred; mirror-extended ${MIRROR_BAND.toFixed(1)} m at each edge (seam z = +/-${SEAM_Z.toFixed(1)} m)`
  )
  console.log(`              resampled levels ${baked.levelMin.toFixed(3)}..${baked.levelMax.toFixed(3)}, ${baked.clamped} texel(s) clamped into 0..255`)

  if (wantSurvey) {
    await survey(baked)
    return
  }

  mkdirSync(OUT_DIR, { recursive: true })
  await writeRgbPng(PNG_PATH, size, size, encodeRg16(baked.levels))

  const step = WORLD_SIZE / (size - 1)
  const span = maxY - minY
  const meta = {
    world: WORLD_SIZE,
    size,
    minY,
    maxY,
    // How much of that range is drama rather than terrain. See NATURAL_MAX_Y --
    // the runtime divides the detail term's calibrated amplitude by this, so
    // stretching the mountains does not also stretch the gravel.
    exaggeration: (maxY - minY) / (NATURAL_MAX_Y - MIN_Y),
    encoding: 'rg16',
    source: 'reference/skyrim-height-map.jpg',
    // Everything a reader needs to re-run this bake and get the same bytes.
    sourceSize: [baked.src.width, baked.src.height],
    sourceWidthMetres: WORLD_SIZE,
    metresPerTexel: step,
    fit: {
      zCoverMetres: SRC_Z_SPAN,
      mirrorBandMetres: MIRROR_BAND,
      seamZ: SEAM_Z,
      mode: 'mirror',
      resample: 'catmull-rom',
    },
    deblock: {
      block: BLOCK,
      cap: db.cap,
      kx: db.kx,
      kz: db.kz,
      ratioBefore: { x: db.before.x.ratio, z: db.before.y.ratio },
      ratioAfter: { x: db.after.x.ratio, z: db.after.y.ratio },
    },
  }
  writeFileSync(JSON_PATH, JSON.stringify(meta, null, 2) + '\n')

  console.log(
    `\n${fileURLToPath(PNG_PATH)}\n  ${size}x${size}  ${step.toFixed(4)} m/texel  ` +
      `range ${minY}..${maxY} m (span ${span} m)  source step ${(span / 255).toFixed(3)} m  ` +
      `rg16 quantum ${((span / 65535) * 100).toFixed(3)} cm\n`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
