import * as THREE from 'three'

// ---------------------------------------------------------------------------
// THE CARD IS THE TECHNIQUE.
//
// Everything else in this spike is bookkeeping around one claim: a wide card
// carrying MANY BLADES is strictly better than many cards carrying one tuft
// each, and the further away it is the more true that gets. It is also, as far
// as anyone outside those studios can tell, most of what Breath of the Wild and
// Genshin actually do -- see the long note at the top of grass-field.js for why
// "they replaced the polygons with a shader" is not what happened.
//
// The arithmetic, at the far tier, against the shipped scatter:
//
//   shipped   0.55 m tuft, 1 quad, 2 triangles, ~3 blades in the cutout
//             at 3/m^2 thinned to 0.4/m^2 by 70 m
//   here      3.10 m card, 1 quad, 2 triangles, ~14 blades in the cutout
//             at 0.128/m^2, which is the SAME BLADES PER SQUARE METRE
//
// Two triangles either way. One eighth of the instances, one eighth of the
// vertex shading, one eighth of the per-instance anything -- for the same
// number of blades on the same ground. The card got bigger and the blades came
// with it. That is the entire trick and it is not subtle.
//
// WHAT IT COSTS, because it does cost something. A wide card is FLAT over a
// wider patch of ground, so it cannot follow a hummock, and its blades all bend
// with one wind sample instead of six. Both are invisible past about 25 m and
// both are ruinous at 3 m, which is exactly why the near ring keeps small
// crossed cards and only the two far rings widen out. The card width per ring
// is the dial that trades those two things off, and it is on the panel.
//
// WHY THE ART IS GENERATED HERE rather than cut from a photograph like
// public/grass/grass_tuft.png. A spike that has to be fed a texture before it
// can be looked at is a spike nobody looks at. Generating means the blade
// count, the blade weight and the card aspect are PARAMETERS -- which is what
// the panel is sweeping -- and it means the three rings' cards are provably the
// same grass at three densities rather than three drawings that nearly match.
// Production would swap in cut art; the shape of the ladder would not change.
// ---------------------------------------------------------------------------

// Variants per ring, as layers of one array texture. Each instance picks one
// from its own hash, so a hillside is not one drawing repeated.
//
// FOUR, and it is worth saying why not one and why not sixteen. One is visible
// immediately: the card is 3 m wide at the far ring, so a repeat lands every
// few metres and the eye reads the ground as tiled. Past four the returns
// collapse, because the instance is ALSO rolling yaw, height, tint and a
// horizontal flip -- 4 variants x 2 flips x continuous yaw and scale is already
// more distinct silhouettes than a bed of real grass has.
const VARIANTS = 4

// Texels across one variant. The far card is 3.1 m wide and lands about 10
// screen pixels tall at 50 m on a Quest eye buffer, so this is generous by an
// order of magnitude and stays here for the near ring's sake -- the same
// builder draws all three, and the 0.75 m card IS looked at from 1 m.
const TILE_W = 256

// An array texture, not an atlas. Four variants side by side in one image would
// bleed across their own seams the moment mipmaps existed, and the blades most
// likely to bleed are the ones at the card's edge, which are the silhouette.
// A layer has its own edges and its own mip chain and cannot bleed at all.
const LAYER_AXIS = 'array'

/** Deterministic 32-bit PRNG. The project's usual one. */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Draw one card's worth of blades into a 2D context, bottom-rooted.
 *
 * THE ROOTS SIT ON THE BOTTOM EDGE and the tips fall short of the top, both on
 * purpose. A card is seated on the ground by its bottom edge, so a blade that
 * starts a few texels up leaves a visible strip of floating grass; a blade that
 * reaches the top edge gets its tip cut off square, and a row of square tips is
 * the single most obvious way a grass card announces itself.
 *
 * THE FILL IS A VALUE, NOT A COLOUR. Same decision as LAYER.GRASS_TUFT in
 * src/textures.js and for the same reason: colour is per instance, so one
 * greyscale drawing serves lush, dry, and everything between. What IS baked in
 * is the root-to-tip gradient, which is not a colour -- it is the ambient
 * occlusion of standing at the bottom of a clump, and it is the difference
 * between a card that reads as grass and a card that reads as a decal.
 */
function drawCard(ctx, w, h, count, weight, rand) {
  ctx.clearRect(0, 0, w, h)

  // Back to front by height, so the tall blades in a clump overlap the short
  // ones rather than being cut into by them.
  const blades = []
  for (let i = 0; i < count; i++) {
    // Stratified across the width -- one blade per column, jittered inside it.
    // Pure random x clumps and gaps at these counts, and a gap in a 3 m card is
    // 3 m of bald ground once it is on a hillside.
    const x = ((i + 0.15 + 0.7 * rand()) / count) * w
    blades.push({
      x,
      // Tall blades dominate what you see -- screen area goes as the square --
      // so the range is skewed short and the tall end is left long.
      len: h * (0.5 + 0.5 * rand() ** 1.4),
      lean: (rand() * 2 - 1) * h * 0.42,
      // Blade width scales with the card's HEIGHT, not its width, because a
      // blade of grass is the same real blade on every card in the ladder.
      wide: h * 0.045 * weight * (0.7 + 0.6 * rand()),
      // The blade's own value, before the root gradient. Grass is not one
      // green: some blades catch the light and some are in the clump's shade.
      val: 0.62 + 0.5 * rand(),
      curl: (rand() * 2 - 1) * 0.5,
    })
  }
  blades.sort((a, b) => a.len - b.len)

  for (const b of blades) {
    const tipX = b.x + b.lean
    const tipY = h - b.len
    // The bend: a control point pulled along the lean and biased upward, so the
    // blade leaves the ground near-vertical and arcs over near the tip. A
    // straight blade reads as a stick, and a bed of sticks reads as a hairbrush.
    const cx = b.x + b.lean * 0.28
    const cy = h - b.len * 0.62

    const grad = ctx.createLinearGradient(0, h, 0, tipY)
    // 0.30 at the root is the clump's own shadow. Anything lighter and the card
    // glows where it meets the ground, which is the tell that gives away every
    // cheap grass billboard ever shipped.
    grad.addColorStop(0, shade(b.val * 0.3))
    grad.addColorStop(0.35, shade(b.val * 0.62))
    grad.addColorStop(1, shade(Math.min(1, b.val * 1.12)))
    ctx.fillStyle = grad

    ctx.beginPath()
    ctx.moveTo(b.x - b.wide * 0.5, h + 1)
    ctx.quadraticCurveTo(cx - b.wide * 0.5 + b.curl * b.wide, cy, tipX, tipY)
    ctx.quadraticCurveTo(cx + b.wide * 0.5 + b.curl * b.wide, cy, b.x + b.wide * 0.5, h + 1)
    ctx.closePath()
    ctx.fill()
  }
}

function shade(v) {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255)
  return `rgb(${c},${c},${c})`
}

/**
 * The blade art for one ring, as a 4-layer array texture.
 *
 * @param aspect  card width / card height. Sets the texel shape so blades are
 *                never stretched: the same builder serves a 1.7:1 near card and
 *                a 5.6:1 far card and the grass is the same grass in both.
 * @param count   blades per card.
 * @param weight  blade width multiplier. The far card wants heavier blades --
 *                not because real grass gets fatter, but because a 2-texel
 *                blade does not survive its own mip chain, and a far card whose
 *                blades have mipped away is a rectangle of fog.
 */
export function buildBladeTexture({ aspect, count, weight = 1, seed = 1 }) {
  if (!(aspect > 0)) throw new Error(`buildBladeTexture: aspect must be positive, got ${aspect}`)
  if (!(count > 0)) throw new Error(`buildBladeTexture: count must be positive, got ${count}`)

  const w = TILE_W
  const h = Math.max(16, Math.round(TILE_W / aspect))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const data = new Uint8Array(w * h * 4 * VARIANTS)
  const rand = mulberry32(seed)
  for (let layer = 0; layer < VARIANTS; layer++) {
    drawCard(ctx, w, h, count, weight, rand)
    const px = ctx.getImageData(0, 0, w, h).data
    data.set(px, layer * w * h * 4)
  }

  const texture = new THREE.DataArrayTexture(data, w, h, VARIANTS)
  texture.format = THREE.RGBAFormat
  texture.type = THREE.UnsignedByteType
  // NoColorSpace: these are not pictures of anything, they are linear
  // multipliers over a per-instance tint. Letting three sRGB-decode them would
  // darken the root gradient by a curve that was never applied to it.
  texture.colorSpace = THREE.NoColorSpace
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = true
  texture.anisotropy = 4
  texture.needsUpdate = true

  return { texture, width: w, height: h, layers: VARIANTS, axis: LAYER_AXIS }
}
