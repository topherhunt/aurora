import THREE from '../three-instance.js'
import { mulberry32, smoothstep } from '../sim/mathx.js'
import { LAYER, TEX_SIZE } from '../textures.js'
import { createImpostorBakeMaterial } from '../material.js'
import { buildRock } from './rock.js'
import { rockParams, TINTS, TINT_GAIN } from './rock-bank.js'
import { SUPERSAMPLE, downsample, flipY, dilate, coveredLuma, coverage } from './impostor.js'

// ---------------------------------------------------------------------------
// STREWN LITTER: a photograph, taken from directly overhead, of a few dozen
// small stones lying in a drift on a square of ground.
//
// A DRIFT, AND NOT A SQUARE FULL OF STONES, which is the one thing about this
// picture the eye can catch out. The stones used to be dropped uniformly over an
// inset square, and a square of gravel is what it then read as: the covered
// ground ended on four straight lines, the corners carried stones as large as
// the middle did, and two stamps overlapping drew the join. Yaw does not hide
// that -- a rotated square is still a square, and rotating two of them against
// each other only makes the corners cross. So the stones are laid inside a
// LOBED DISC instead (see LITTER_REACH), with the size range tapering to
// grit at its rim: the covered set has no straight edge anywhere, no corner to
// recognise, and it thins into bare ground rather than stopping on a line. Two
// stamps overlapping now read as one wider drift, which is what they are meant
// to be.
//
// WHAT IT REPLACES. The rock scatter used to draw this look as geometry -- the
// `underfoot` bed, running at a stone every 1.7 m across every cliff and every
// wood, with the stones 11 cm across. That is forty-one small stones for every
// rock big enough to read as a rock, and each one cost a full BatchedMesh
// instance regardless of its triangle count, so nearly the whole prop budget
// was going to specks. The LOOK was right and the mechanism was wrong: ground
// scattered with small stones is a TEXTURE, and it has been a texture in every
// renderer since the word existed. One quad and two triangles now buy what
// eighty instances used to.
//
// WHY IT IS BAKED AT LOAD RATHER THAN SHIPPED AS A PNG, which is the same
// argument impostor.js and fern-bank.js make and is repeated here only because
// it is the reason this file exists instead of an asset: the stones in this
// picture are built by buildRock from the same variants, the same tint palette
// and the same stone photograph the full-size rocks use. A bake cannot disagree
// with the bank. A PNG on disk can, silently, for as long as nobody looks --
// and it would disagree the first time anyone touched the tint table.
//
// WHY ORTHOGRAPHIC AND STRAIGHT DOWN. Two reasons and they are separate. Ortho
// because the patch is stamped flat on the ground and seen from every range, so
// any baked-in convergence is wrong everywhere except at one distance. Straight
// down because the stamp has a FIXED WORLD ORIENTATION -- unlike an impostor
// card, which turns to face the camera and can therefore key its bake to the
// camera's own azimuth, a litter patch lies on the hillside at whatever yaw the
// scatter rolled. Any off-axis light would bake a compass direction into it and
// be wrong for every patch that landed pointing the other way.
//
// THAT IS ALSO WHY THE KEY POINTS STRAIGHT DOWN. Lit from directly above, a
// facet's brightness is a function of how far it tilts off vertical and nothing
// else -- rotationally symmetric, so it survives the yaw. What that buys is
// FORM: the crown of each stone lifts, the flanks fall away, and the picture
// reads as rounded objects rather than as grey confetti. What it deliberately
// does NOT bake is any opinion about where the sun is, because the quad goes
// through the ordinary prop material and gets the world's own lighting on top.
//
// THE ONE THING THE RIG CANNOT GIVE IS CONTACT. A stone bedded in soil has a
// dark line where it meets the ground, and that line is an occlusion term:
// there is no shadow map here and no ground plane to catch one (a ground plane
// would fill the layer with opaque pixels and there would be nothing left to
// stamp). The stones' own falling flanks carry most of it. If the patches ever
// read as pasted on rather than lying in, this is the thing that is missing.
// ---------------------------------------------------------------------------

/** The four layers, in bake order. The scatter rolls one per patch. */
export const LITTER_LAYERS = [LAYER.LITTER_0, LAYER.LITTER_1, LAYER.LITTER_2, LAYER.LITTER_3]

// How much ground one 128-texel layer covers, in metres. This is the single
// number that decides what the picture IS, so it is worth being explicit: at
// 1.6 m the texel is 1.25 cm, a 20 cm stone is sixteen texels across and reads
// as a stone, and the patch is about a stride wide -- small enough that the
// scatter can break up a hillside with them and large enough that one stamp is
// worth its two triangles. Much larger and the stones dissolve into noise; much
// smaller and a patch is one rock and may as well have been geometry.
export const LITTER_PATCH_M = 1.6

// The clear rim, and the reach of the drift that falls out of it. Two jobs, and
// the second is the one that would be missed. It keeps every stone whole -- a
// centre may not land closer to the edge than half of the largest stone, or the
// picture has cut-off rocks along its border. And the atlas is RepeatWrapping
// (barkRepeat needs it, see textures.js), so a stone touching the edge would be
// bilinearly blended with whatever is on the OPPOSITE side of the same patch. An
// empty rim means that blend mixes transparent with transparent and nothing
// shows.
//
// MEASURED RADIALLY NOW, as a fraction of the HALF-patch, because the stones no
// longer land in a square and the old per-axis reading of the same number would
// describe nothing. The margin buys a little more than it looks: the widest a
// stone can be out at the reach is LITTER_RIM_TAPER's tapered top, 14 cm rather
// than the range's own 26, so 0.175 leaves 7 cm of guaranteed clear rim against
// the 1.25 cm one texel of the wrap blend actually needs. check-litter.mjs sweeps
// the taper for the true worst rather than trusting that arithmetic.
export const LITTER_MARGIN = 0.175
export const LITTER_REACH = (LITTER_PATCH_M / 2) * (1 - LITTER_MARGIN)

// How far the drift's rim is pushed off a circle, as two harmonics of the angle
// -- a 2-fold squash and a 3-fold wobble, each at its own phase per patch. A
// disc is a better patch than a square (it has no corners and no straight edge)
// but it is still a shape the eye can name, and four discs of gravel on a
// hillside read as four dropped plates. At 0.18 + 0.12 the rim wanders by up to
// 30% of the reach, which is enough that no two of the four bakes have the same
// outline and none of them has a nameable one.
export const LITTER_LOBES = [0.18, 0.12]

// Where the size range starts giving way toward the rim, as a fraction of the
// reach, and how much of it is gone by the rim itself.
//
// THIS IS WHAT ACTUALLY DISSOLVES THE EDGE, and it is worth separating from the
// shape above. A drift with a lobed outline but full-sized stones out to that
// outline still ends on a readable line, because a 25 cm stone at the rim IS the
// rim. Tapering the range instead means the last thing before bare ground is
// 5-14 cm grit, which at 1.25 cm a texel is a handful of pixels the eye cannot
// find a boundary in. It is the same trick the scatter plays at its own scale
// with the rim dissolve, one level down.
//
// The taper multiplies the RANGE and not the size, so the small end of
// LITTER_SIZE is still the small end at the rim and no stone escapes underneath
// it.
export const LITTER_RIM_KNEE = 0.5
export const LITTER_RIM_TAPER = 0.55

// How many stones land in one patch. Tuned to coverage rather than to taste:
// bakeLitter logs the covered fraction, and the target is a little under half.
// Fuller than that and the transparent gaps close up, the patch becomes a solid
// grey tile, and two stamps overlapping read as a slab rather than as a drift.
//
// 52, and the number has been up and down for two separate reasons that pull
// opposite ways, which is why it is not the 54 the original square used.
//
// UP, for the drift: giving up the four corners and tapering the rim costs about
// a third of the stone on the ground, so at 54 the drift rasterised at 14-20% of
// the patch against the square's own 22-28, and 74 was what brought that back.
// DOWN, for the wider size range: coverage goes as the SQUARE of the stone size,
// so widening LITTER_SIZE's top from 0.26 to 0.34 raised the same 74 stones to
// 26-29% and the summed footprint past the "under half" this comment promises.
// 52 lands at 19-27% rasterised, which is where 74 had it before the range
// moved. Fewer, larger, more varied stones for the same ground covered.
export const LITTER_STONES = 52

// The size range of one stone, in metres, and the power that skews the roll.
// A real spread of loose stone is mostly small with a few large ones, not
// uniform between the bounds -- u^2 puts about half the stones under 10 cm and
// leaves a handful up near the top, which is what makes the patch read as
// natural rather than as a hatch pattern of same-sized dots.
//
// THE TOP OF THE RANGE IS WHERE THE VARIETY LIVES, not the bottom, and that is
// worth knowing before reaching for either end. The floor is pinned by the
// texel: at LITTER_PATCH_M / 128 one texel is 1.25 cm, so 4.5 cm is under four
// of them and anything smaller is a stone the downsample cannot resolve into a
// shape -- it aliases into a speck of noise and adds nothing but shimmer. The
// ceiling has no such limit, so 0.26 -> 0.34 is what actually widened the
// spread: the coefficient of variation across the four bakes went 0.52-0.56 to
// 0.52-0.65, the 90th percentile stone from 17-22 cm to 19-27, and the largest
// from 24-26 cm to 30-33. Half the stones are still under 10 cm, which is the
// part that must not change -- a drift of uniformly LARGE stones is as monotone
// as a drift of uniformly small ones, and reads as rubble rather than litter.
export const LITTER_SIZE = [0.045, 0.34]
export const LITTER_SIZE_POW = 2.0

// The bake rig. The world's lighting is applied to the quad on top of this, so
// what is wanted from the bake is the part a flat quad cannot express (each
// stone's own curvature) and not a second opinion about the sun.
//
// KEY + SKY = 1.0 AND THAT IS THE WHOLE OF THE EXPOSURE DECISION. A stone's
// crown in the world faces straight up, and so does the quad the patch is
// stamped onto, so the world hands the crown exactly the light it hands the
// quad. Bake the crown at 1.0 x albedo and the two agree; bake it at 2.0 and
// every pebble on the ground is lit by two suns. The quad's instance colour in
// v2/render/litter.js only trims from there (TONE x the ground-brightness cue,
// about 0.66 to 1.8, centred near 1.0), so this rig has to land the absolute
// level and the split below decides only the form.
//
// The split is what is left over: 0.7 from a key straight down, 0.3 from the
// hemisphere. Because the hemisphere's ground colour is nearly black a facet
// turning away from vertical loses both terms at once -- a crown reads 1.00, a
// 45-degree shoulder 0.75, a vertical flank 0.15, an undercut nearly nothing.
// That is a ratio of about 7:1 across one stone, which is where the form comes
// from now that the level is spoken for.
//
// It also puts clipping out of reach, which the old 1.35/0.95 rig did not. The
// palest tints in the litter list land near 0.46 linear albedo once TINT_GAIN
// has divided the stone photograph's own mean out (rock-bank.js caps the
// palette there for exactly this reason), so the brightest texel this rig can
// produce is about 0.46 linear, 0.71 once encoded. Before, the same texel came
// out at 1.06 and clipped: sandstone's red, pale granite's red and frost grey's
// blue all flattened to white on any crown facing the key, in a target that is
// 8-bit, sRGB and toneMapped: false, which cannot represent anything over 1.
export const LITTER_KEY = 0.7
export const LITTER_SKY = 0.3

// How many distinct rocks a patch is assembled from. There is one boulder in
// this world (rock-bank.js) and no variants to draw on, so the pool is fifteen
// SEEDS of it: same parameters, different noise, and at these sizes that is the
// whole of what a silhouette is.
//
// A POOL, NOT A ROCK PER STONE. Every one of the two hundred-odd stones across
// the four layers is one of those fifteen under a different yaw, scale and tint,
// and the repeat is invisible because at these sizes a stone IS a silhouette,
// and a silhouette turned 40 degrees and scaled by 2.5 is a different one.
// Fifteen buildRock calls at load rather than two hundred.
export const LITTER_SEEDS = 15

// Which tier the pooled rocks are built at. ROCK_TIERS is finest-first, so 1 is
// T80. Not tier 0: this geometry is thrown away the moment the photograph is
// taken, but it is still built on the main thread at load, and at 512 px across
// a 1.6 m patch even the largest stone here is 83 pixels wide -- the difference
// between 80 faces and 180 is well under a texel once it has been downsampled
// by four. Not tier 2 either: twenty faces photographs as a gem rather than as
// a stone, and this is the one place the geometry exists only to be looked at.
export const LITTER_TIER = 1

// Which tints the stones wear. The whole palette except `lichen`, which is the
// one entry that says "this boulder has not moved in a century" -- loose litter
// has, by definition, and a green-grey chip in a scatter of bare stone reads as
// a mistake rather than as variety. Rolled per stone, so a single patch carries
// five or six stone colours; see ENV_TINTS in rock-bank.js for the same
// argument applied to the full-size scatter.
export const LITTER_TINTS = TINTS.map((_, i) => i).filter((i) => TINTS[i][0] !== 'lichen')

/**
 * Build the fifteen rocks every patch is assembled from.
 *
 * Built at `size: 1` and scaled per stone rather than built at each size: the
 * geometry is identical up to a uniform scale, and `texRepeat` is authored in
 * repeats-across-the-rock rather than in metres, so a stone scaled to 5 cm
 * shows the same fraction of the granite tile as one scaled to 25 cm. Building
 * per size would cost fourteen more buildRock calls to produce the same picture.
 *
 * The caller owns the geometries and must dispose them.
 */
export function buildLitterPool() {
  const pool = []
  for (let s = 0; s < LITTER_SEEDS; s++) {
    pool.push(buildRock({ ...rockParams(s), size: 1, tier: LITTER_TIER }))
  }
  return pool
}

/**
 * Where every stone in patch `seed` lands, as a pure function of the seed.
 *
 * SPLIT OUT FROM THE BAKE ON PURPOSE. Everything that decides what the picture
 * contains is here, and everything below needs a GL context -- which means the
 * half that can be got wrong (a stone hanging off the edge into the wrapping
 * border, a size roll that collapses to one size, a tint roll that only ever
 * draws two colours) is the half that node can test. What is left in bakeLitter
 * is the camera, the rig and a readback, and none of that has a decision in it.
 *
 * Returns `[{ shape, tint, size, x, z, yaw }]`, where `shape` indexes the pool.
 */
export function litterPlacements(seed, poolSize = LITTER_SEEDS) {
  const rand = mulberry32(seed * 7919 + 13)
  // Drawn once, before the loop: the lobes are the PATCH's shape and not any
  // stone's, so a phase per stone would average them away to a circle.
  const phase2 = rand() * Math.PI * 2
  const phase3 = rand() * Math.PI * 2
  const [minS, maxS] = LITTER_SIZE
  const out = []
  for (let i = 0; i < LITTER_STONES; i++) {
    const shape = (rand() * poolSize) | 0
    const tint = LITTER_TINTS[(rand() * LITTER_TINTS.length) | 0]

    // Polar, so the drift's rim is a function of the angle and the taper is a
    // function of how far out along it the stone sits.
    const th = rand() * Math.PI * 2
    const edge = LITTER_REACH * (1
      - LITTER_LOBES[0] * (0.5 + 0.5 * Math.cos(2 * th + phase2))
      - LITTER_LOBES[1] * (0.5 + 0.5 * Math.cos(3 * th + phase3)))
    // sqrt, so the stones spread evenly over the drift's AREA. A raw uniform
    // radius packs half of them inside the inner quarter and the picture becomes
    // a cairn with a halo.
    const t = Math.sqrt(rand())
    const rim = 1 - LITTER_RIM_TAPER * smoothstep(LITTER_RIM_KNEE, 1, t)

    out.push({
      shape,
      tint,
      size: minS + (maxS - minS) * Math.pow(rand(), LITTER_SIZE_POW) * rim,
      x: Math.cos(th) * edge * t,
      z: Math.sin(th) * edge * t,
      yaw: rand() * Math.PI * 2,
    })
  }
  return out
}

/**
 * Render one patch of strewn stones into one layer of the texture array, in
 * place. Deterministic in `seed`: the same seed is the same patch, always.
 *
 * `renderer` is the live WebGLRenderer -- a load-time step that borrows the
 * context for one frame and restores the render target and clear state it
 * found, exactly as bakeImpostor does.
 *
 * Returns `{ meanLuma, coverage }`, which are the two numbers the rig is tuned
 * against: see LITTER_KEY for the first and LITTER_STONES for the second. Both
 * are logged at load, and both have a predicted value to be read against --
 * meanLuma 0.50 to 0.56 (the litter tints average 0.318 linear albedo, the rig
 * lands a projected-area-weighted 0.7 to 0.85 of that on them, and the target
 * encodes to sRGB on the way out), coverage a little under 0.5. Well over the
 * top of the luma band means something is lighting the stones twice; well under
 * it means the patch is a smear of dark grit rather than stones.
 */
export function bakeLitter(renderer, texArray, layer, { seed = 1, pool = null } = {}) {
  if (layer < 0 || layer >= texArray.image.depth) {
    throw new Error(`bakeLitter: layer ${layer} is outside the ${texArray.image.depth}-layer array`)
  }

  const rocks = pool ?? buildLitterPool()
  const ownsPool = pool === null

  const scene = new THREE.Scene()

  // One material per tint rather than one per stone. They differ only in
  // `color` and share a customProgramCacheKey, so all eight are one compiled
  // program and eight uniform uploads -- and the tint gains go in LINEAR, above
  // 1.0, because that is what they are: TINT_GAIN divides the stone
  // photograph's own mean out of the way so the result lands on the authored
  // colour, and every gain in the table is greater than 1. See rock-bank.js.
  const mats = new Map()
  const materialFor = (t) => {
    let m = mats.get(t)
    if (!m) {
      m = createImpostorBakeMaterial(texArray)
      m.color.setRGB(TINT_GAIN[t][0], TINT_GAIN[t][1], TINT_GAIN[t][2])
      mats.set(t, m)
    }
    return m
  }

  // Where each stone goes is litterPlacements' decision, not this function's.
  // Yaw only, and no tumble: the patch is a picture of stones that have
  // SETTLED, every one of these shapes is authored with a `sit` flat on its
  // underside, and rolling one onto its side photographs the part of the rock
  // that is meant to be buried.
  for (const s of litterPlacements(seed, rocks.length)) {
    const mesh = new THREE.Mesh(rocks[s.shape], materialFor(s.tint))
    mesh.position.set(s.x, 0, s.z)
    mesh.rotation.y = s.yaw
    mesh.scale.setScalar(s.size)
    scene.add(mesh)
  }

  // THE CAMERA'S `up` IS NOT OPTIONAL. Looking straight down from (0, h, 0) at
  // the origin makes the view direction parallel to the default up of (0,1,0),
  // and lookAt of two parallel vectors is degenerate -- it produces a NaN
  // matrix and the render comes back empty. Any horizontal up will do; -Z puts
  // world +x along +u, which is the convention the rest of the atlas uses.
  const half = LITTER_PATCH_M / 2
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, LITTER_PATCH_M * 4)
  cam.position.set(0, LITTER_PATCH_M * 2, 0)
  cam.up.set(0, 0, -1)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()

  const key = new THREE.DirectionalLight(0xffffff, LITTER_KEY)
  key.position.set(0, LITTER_PATCH_M * 2, 0)
  scene.add(key)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x0e0f12, LITTER_SKY))

  const big = TEX_SIZE * SUPERSAMPLE
  const target = new THREE.WebGLRenderTarget(big, big, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  })

  const prevTarget = renderer.getRenderTarget()
  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  // XR off for the capture, or a headset already presenting photographs its
  // own view instead of the rig's -- see captureLayer in impostor.js.
  const prevXR = renderer.xr.enabled
  renderer.xr.enabled = false

  renderer.setRenderTarget(target)
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, true, false)
  renderer.render(scene, cam)

  const raw = new Uint8Array(big * big * 4)
  renderer.readRenderTargetPixels(target, 0, 0, big, big, raw)

  renderer.xr.enabled = prevXR
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClear, prevAlpha)
  target.dispose()
  for (const m of mats.values()) m.dispose()
  if (ownsPool) for (const g of rocks) g.dispose()

  const pixels = downsample(raw, big)
  flipY(pixels)
  dilate(pixels)

  texArray.image.data.set(pixels, layer * TEX_SIZE * TEX_SIZE * 4)
  texArray.needsUpdate = true

  return { meanLuma: coveredLuma(pixels), coverage: coverage(pixels) }
}

/**
 * Bake all four variants. One pool of rocks is built and shared across them,
 * so the whole set costs fifteen buildRock calls and four render-target frames.
 */
export function bakeLitterSet(renderer, texArray) {
  const pool = buildLitterPool()
  const out = LITTER_LAYERS.map((layer, i) => bakeLitter(renderer, texArray, layer, { seed: i + 1, pool }))
  for (const g of pool) g.dispose()
  return out
}
