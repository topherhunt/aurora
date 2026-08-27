import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER, TEX_SIZE } from '../textures.js'
import { createImpostorBakeMaterial } from '../material.js'
import { buildRock } from './rock.js'
import { rockParams, TINTS, TINT_GAIN } from './rock-bank.js'
import { SUPERSAMPLE, downsample, flipY, dilate, coveredLuma, coverage } from './impostor.js'

// ---------------------------------------------------------------------------
// STREWN LITTER: a photograph, taken from directly overhead, of a few dozen
// small stones dropped at random on a square of ground.
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

// The clear rim, as a fraction of the patch. Two jobs, and the second is the
// one that would be missed. It keeps every stone whole -- a centre may not land
// closer to the edge than half of the largest stone, or the picture has cut-off
// rocks along its border. And the atlas is RepeatWrapping (barkRepeat needs it,
// see textures.js), so a stone touching the edge would be bilinearly blended
// with whatever is on the OPPOSITE side of the same patch. An empty rim means
// that blend mixes transparent with transparent and nothing shows.
export const LITTER_MARGIN = 0.14

// How many stones land in one patch. Tuned to coverage rather than to taste:
// bakeLitter logs the covered fraction, and the target is a little under half.
// Fuller than that and the transparent gaps close up, the patch becomes a solid
// grey tile, and stamping two of them overlapping shows a visible square.
export const LITTER_STONES = 54

// The size range of one stone, in metres, and the power that skews the roll.
// A real spread of loose stone is mostly small with a few large ones, not
// uniform between the bounds -- u^2 puts about half the stones under 10 cm and
// leaves a handful up near the top, which is what makes the patch read as
// natural rather than as a hatch pattern of same-sized dots.
export const LITTER_SIZE = [0.045, 0.26]
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

// The shapes that get dropped, and how many distinct rocks are built of each.
// SMALL VARIANTS ONLY: these are the stones that used to be scattered as the
// underfoot bed, so the list is that bed's roster minus the ones too big to
// belong in a patch a stride wide.
//
// A POOL, NOT A ROCK PER STONE. Five variants at three seeds is fifteen
// distinct meshes, and every one of the two hundred-odd stones across the four
// layers is one of those fifteen under a different yaw, scale and tint. That is
// the same trade rock-bank.js makes for the world itself, and the repeat is
// just as invisible here for the same reason: at these sizes a stone is a
// silhouette, and a silhouette turned 40 degrees and scaled by 2.5 is a
// different silhouette. Fifteen buildRock calls at load rather than two hundred.
export const LITTER_VARIANTS = ['pebble', 'grit', 'cobble', 'shingle', 'scree']
export const LITTER_SEEDS = 3

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
  for (const name of LITTER_VARIANTS) {
    for (let s = 0; s < LITTER_SEEDS; s++) {
      pool.push(buildRock({ ...rockParams(name, s), size: 1, tier: LITTER_TIER }))
    }
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
export function litterPlacements(seed, poolSize = LITTER_VARIANTS.length * LITTER_SEEDS) {
  const rand = mulberry32(seed * 7919 + 13)
  const inner = LITTER_PATCH_M * (1 - LITTER_MARGIN * 2)
  const [minS, maxS] = LITTER_SIZE
  const out = []
  for (let i = 0; i < LITTER_STONES; i++) {
    out.push({
      shape: (rand() * poolSize) | 0,
      tint: LITTER_TINTS[(rand() * LITTER_TINTS.length) | 0],
      size: minS + (maxS - minS) * Math.pow(rand(), LITTER_SIZE_POW),
      x: (rand() - 0.5) * inner,
      z: (rand() - 0.5) * inner,
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

  renderer.setRenderTarget(target)
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, true, false)
  renderer.render(scene, cam)

  const raw = new Uint8Array(big * big * 4)
  renderer.readRenderTargetPixels(target, 0, 0, big, big, raw)

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
