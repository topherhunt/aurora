import THREE from '../three-instance.js'
import { TEX_SIZE } from '../textures.js'
import { createImpostorBakeMaterial, CARD_UP_MARK } from '../material.js'

// ---------------------------------------------------------------------------
// Prop impostors: a photograph of the LOD0 mesh, stood up as crossed planes.
//
// Written for trees, and the argument below is told in trees because that is
// where it was had. Ferns use the same two functions unchanged -- see
// bakeFernImpostors in props/fern-bank.js for the two places a rosette wants a
// different NUMBER (two planes rather than three, two layers rather than one
// per species) and why. Nothing here is tree-specific except the prose.
//
// WHY THIS INSTEAD OF A SECOND MESH TIER. DESIGN.md §5 argues at length that a
// third conifer tier installs "a 45-triangle conifer at 94 px with no needles
// and no silhouette" in place of an impostor of the real canopy. The same
// argument reaches the SECOND tier once you have looked at one: a coarser
// regeneration of a tree keeps the parts a generator can count -- limbs,
// cards -- and loses the only thing that reads at distance, which is that a
// tree is a dense lump of foliage with light coming through it. Six triangles
// carrying a picture of the real canopy keep that; 190 triangles arranged into
// a sparser version of the tree do not.
//
// What an impostor gives up is PARALLAX, and that is the thing to watch rather
// than the pixel count. §5's rule is `crossover = depth x 28.6` (the range at
// which a flat card's failure to turn stays under 2 degrees), which for a 5.7 m
// pine crown is 164 m. THREE crossed planes are not a flat card -- you are
// never more than 30 degrees off the normal of one of them, and the other two
// carry real depth -- so the usable range comes in a long way nearer than that,
// but not to zero. Where exactly is a thing to judge in the previewer at the
// distance the swap happens, not to derive here.
//
// THE CAPTURE IS NOT SQUARE AND THE CARD UNDOES THE STRETCH. A texture layer is
// 128x128 because TEX_SIZE is an invariant of the whole array (see
// textures.js), and a tree is nothing like square -- a 9 m pine is 5.7 m wide.
// Framing a square around the taller axis would throw away a third of the
// texels on empty sky. So the bake camera is framed to the tree's OWN extents,
// which stretches it to fill the square slice, and the card is built at those
// same extents, which stretches it back. Every texel is spent on tree, and the
// only cost is that horizontal and vertical texel density differ -- which for a
// thing seen at 128 px and falling is not a cost at all.
// ---------------------------------------------------------------------------

// Transparent border left around the capture, as a fraction of the tree's size.
// The atlas is RepeatWrapping -- barkRepeat needs it -- so a leaf touching the
// edge of the slice would be bilinearly blended with whatever is on the far
// side, which is the other side of the same tree. The margin is on the sides
// and the top only; by default the bottom is the ground line, and what sits
// against it is an opaque trunk rather than a leaf.
//
// A CALLER CAN BUY BOTTOM MARGIN with `foot`, and pays for it by sinking the
// card below y = 0 -- see impostorCardExtents. Only the apex-down triangle
// asks; a quad has nothing to gain, since its bottom edge is already full width.
//
// A FERN puts leaves against that bottom edge -- a drooping frond tip really
// does reach the ground -- so there the wrap blends the last row of tips with
// the first row of empty sky. It is left as it is, and the reason is the range
// rather than the geometry: the card only ever draws from 26 m out, where the
// whole 128-texel slice covers about 20 screen pixels, so the affected texel is
// a sixth of a pixel wide and the mip chain has averaged it away before it gets
// there.
const MARGIN = 0.06

// How far colour is pushed outward into fully transparent texels before the
// bytes are stored. Nothing samples those texels directly -- alphaTest 0.5
// discards them -- but bilinear filtering right at the silhouette blends
// TOWARD them, and an unwritten texel is transparent BLACK. Without this every
// leaf edge in the impostor gets a dark fringe that reads as soot, and it gets
// worse with every mip. Two passes is enough for the one-texel blend a
// magnified impostor does; the mip chain is discussed at the bottom of buildImpostorCard.
const DILATE_PASSES = 2

// The capture is rendered this many times oversized on each axis and boxed down
// in JS. Not for prettiness: an alpha-tested cutout rendered straight at 128 px
// has a HARD binary silhouette, one texel wide, and every mip after that is a
// worse and worse guess at where the edge was. Downsampling 4x4 coverage into
// each texel gives the alpha 17 levels to sit at, so the silhouette lands
// mid-texel and mips down honestly. It is one render at load and a 1 MB
// readback, and it is done in JS rather than by asking the render target for
// MSAA so that the result does not depend on what the driver decided to do.
export const SUPERSAMPLE = 4

// The canopy fan, in the units the header describes. 0.55 puts the top corners
// at normal.y 0.876 and the skirt corners at 0.633 -- a lean of about 29 and 51
// degrees off vertical, so the two edges of a quad are roughly 80 degrees apart
// in normal. That is enough spread to read as a round crown under a low sun and
// well short of the 90 degrees the old per-plane normals had between NEIGHBOURS.
const CANOPY_SPREAD = 0.55
const CANOPY_SKIRT_UP = 0.45

// The bake rig's two intensities, in the same units clock.js's palette uses --
// a daylight row there is a 2.1 sun against a 0.85 hemisphere, and these are
// deliberately a weaker, flatter version of that. They have to be, because the
// card gets the palette's own lighting multiplied on top at draw time: what is
// wanted from the bake is the part the card's four normals cannot express (the
// crown's interior and underside), not a second opinion about which way the sun
// is. Aim: an exposed top leaf bakes near 0.8 of albedo, a leaf facing the
// camera near 0.36, one facing straight down near 0.02.
//
// bakeImpostor logs the measured mean over the covered texels of every layer it
// writes, which is the number to tune these against -- the card is meant to sit
// at roughly a third of raw leaf albedo, because that is what a real canopy at
// distance does and looking lighter than the grass underneath was the symptom
// that got the flat bake replaced.
const BAKE_KEY = 1.5
const BAKE_SKY = 1.0

/**
 * The hemisphere's GROUND colour -- what a surface facing straight down
 * collects, and the whole of the "a canopy is a third of leaf albedo" figure
 * above. Nearly black, because the thing under a leaf is more crown.
 *
 * WRONG FOR A SOLID. A boulder has no interior to shade; what is under its
 * lower half is open ground, which bounces roughly its own albedo of the same
 * sky back up. Baked against this constant a rock's underside comes out at
 * half a percent of its top and the card reads as a black wedge sitting in
 * mid-grey scree, so `bounce` lets a solid subject ask for a real one --
 * BAKE_ROCK_BOUNCE is 0.2 in linear light, which is what open ground is.
 */
const BAKE_GROUND = 0x0e0f12
export const BAKE_ROCK_BOUNCE = 0x7b7b7b

/**
 * The card size a subject of `width` x `height` gets framed into: its own
 * extents plus the transparent MARGIN, and how far below the subject's feet the
 * card's bottom edge sits.
 *
 * Exported because the card GEOMETRY and the card PIXELS do not have to be made
 * at the same moment, and in the game they are not -- the quads go into the
 * batch's arena when the scatter is constructed, while the photograph cannot be
 * taken until the frond PNG has landed in the array. Both have to agree about
 * the framing to the last texel or the picture is stretched across the quad, so
 * both ask this rather than each applying the margin themselves.
 *
 * `foot` IS THE WIDTH THE CARD MUST STILL HAVE WHERE THE SUBJECT STANDS, in the
 * same units as `width`, and it exists for exactly one shape: the apex-down
 * triangle. That card is a point at y = 0, so the bottom of a trunk tapers to
 * nothing and a lollipop tree reads as a pencil standing on its tip. A triangle
 * `cardW` wide at its top and a point at its apex is `cardW * (y + sink) /
 * (top + sink)` wide at y, so asking it to be `foot` wide at y = 0 solves for
 * one number: how far to drop the apex BELOW the ground. The bake then frames
 * that extra strip of empty ground into the picture and the card draws it, so
 * the subject's own feet land where they belong with a real trunk under them.
 *
 * It costs card height, which for a triangle is fill: a 12% sink is a 6% bigger
 * card. Everything else is a gain -- the triangle is wider at every height below
 * its top, so it keeps MORE of the silhouette, not less.
 */
export function impostorCardExtents({ width, height, foot = 0 }) {
  const cardW = width * (1 + MARGIN * 2)
  if (foot < 0) throw new Error(`impostorCardExtents: foot is a width, got ${foot}`)
  if (foot >= cardW) {
    throw new Error(`impostorCardExtents: a ${foot} foot does not fit inside a ${cardW.toFixed(3)} card`)
  }
  const top = height * (1 + MARGIN)
  const sink = foot > 0 ? (foot * top) / (cardW - foot) : 0
  return { width: cardW, height: top + sink, sink }
}

/**
 * Render `geometry` SIDE-ON into one layer of the texture array, in place.
 *
 * Returns the card extents the capture was framed to, which is what
 * `buildImpostorCard` has to be given for the stretch to cancel.
 *
 * `renderer` is the live WebGLRenderer -- this is a load-time step that borrows
 * the context for one frame, the way fern-bank borrows a millisecond of startup
 * rather than shipping an asset. It restores the render target and clear state
 * it found.
 *
 * A subject that is far wider than it is tall wants `bakeImpostorPlate` instead.
 */
export function bakeImpostor(
  renderer, geometry, texArray, layer,
  { width, height, foot = 0, azimuth = 0, tint = null, vertexColors = false, hemFray = null, bounce = BAKE_GROUND }
) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`bakeImpostor: need a positive width and height, got ${width}x${height}`)
  }

  const { width: cardW, height: cardH, sink } = impostorCardExtents({ width, height, foot })

  // How far back to stand and how deep to see. An ortho capture does not care
  // about the distance -- that is the point of it -- so this only has to put
  // the whole prop between the near and far planes, and it keys off the LARGER
  // extent because a fern is wider than it is tall and a spreading one is
  // deeper than it is high. Keying it off `height` alone would clip the front
  // fronds off exactly the variant that most needs a card.
  const reach = Math.max(width, height)

  // Ortho, because an impostor seen from 30 m and from 130 m has to be the same
  // picture. A perspective capture bakes in one distance's worth of convergence
  // and is visibly wrong at every other.
  const cam = new THREE.OrthographicCamera(-cardW / 2, cardW / 2, cardH - sink, -sink, 0.01, reach * 8)
  // Level with the ground and looking horizontally, so camera-y IS world-y and
  // the frustum's [bottom, top] of [-sink, cardH - sink] puts the subject's feet
  // exactly `sink` above the texture's bottom edge -- on the edge itself when no
  // `foot` was asked for. Any tilt here bakes a worm's- or bird's-eye view into
  // a card that will be seen from neither.
  cam.position.set(Math.sin(azimuth) * reach * 2, 0, Math.cos(azimuth) * reach * 2)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()

  // THE KEY SITS AT THE CAMERA'S OWN AZIMUTH and well above it. Anywhere else
  // and the photograph gets a left-right terminator burned into it, which is
  // fatal for a picture that will be seen from every direction on the compass
  // -- half the time the baked bright side would be facing away from the real
  // sun. From the camera's azimuth there is no left-right term at all: the
  // gradient runs top to bottom, which is the one axis a card cannot fake and
  // the one the real sun does not move along much at 65 N.
  const key = new THREE.Vector3(
    Math.sin(azimuth) * reach * 0.9, reach * 2.1, Math.cos(azimuth) * reach * 0.9)

  const pixels = captureLayer(
    renderer, geometry, texArray, layer, cam, key, { tint, vertexColors, hemFray, bounce })
  return { width: cardW, height: cardH, sink, meanLuma: coveredLuma(pixels), coverage: coverage(pixels) }
}

/**
 * The card size a PLATE of `width` x `depth` gets framed into, seen from above.
 *
 * The same transparent border as `impostorCardExtents`, on all four sides: a
 * top-down shot has no ground line to sit against, so neither edge of either
 * axis is the special one.
 */
export function plateCardExtents({ width, depth }) {
  if (!(width > 0) || !(depth > 0)) {
    throw new Error(`plateCardExtents: need a positive width and depth, got ${width}x${depth}`)
  }
  return { width: width * (1 + MARGIN * 2), depth: depth * (1 + MARGIN * 2) }
}

/**
 * Photograph `geometry` from STRAIGHT ABOVE into one layer of the array.
 *
 * For a subject that is far wider than it is tall, which is what a cliff-facade
 * plate is: 2 m across and 0.31 m high. Shot side-on it fills a fifth of a
 * square slice and the other four fifths are transparent sky, so the picture the
 * far band draws is 128 texels of which about 25 carry stone. Shot from above it
 * fills the slice, and the face it fills it with is the one a camera out in the
 * valley actually sees.
 *
 * THE FRUSTUM RUNS FROM THE CAMERA DOWN TO y = 0, which is the top-down analogue
 * of the side-on shot's "bottom edge is the bed plane": everything below is the
 * skirt, and the skirt is the part inside the hill wherever the plate is laid.
 *
 * THE KEY POINTS STRAIGHT DOWN, unlike bakeImpostor's. A plate is laid at a
 * random yaw and its card is not spun, so any tilt on the key would be a compass
 * direction baked into the picture and wrong on half the wall. Straight down
 * costs nothing here: what carries the relief is that the lumps tilt their own
 * normals off vertical, so `dot(N, L)` still runs from the crown to the rim --
 * a radial gradient with no bearing in it, which is what a plate lit from the
 * sky looks like from any side.
 *
 * `height` is the subject's, and only sets how far back to stand.
 */
export function bakeImpostorPlate(
  renderer, geometry, texArray, layer,
  { width, depth, height, tint = null, vertexColors = false, bounce = BAKE_GROUND }
) {
  if (!(width > 0) || !(depth > 0) || !(height > 0)) {
    throw new Error(`bakeImpostorPlate: need positive extents, got ${width}x${height}x${depth}`)
  }

  const { width: cardW, depth: cardD } = plateCardExtents({ width, depth })

  // Clear of the crown by the crown's own height again, so the subject is never
  // behind the near plane however lumpy it turned out. Ortho, so the distance
  // costs nothing.
  const camY = Math.max(cardW, cardD) + height * 2

  const cam = new THREE.OrthographicCamera(-cardW / 2, cardW / 2, cardD / 2, -cardD / 2, 0.01, camY)
  cam.position.set(0, camY, 0)
  // Camera-up is world -z, which makes camera-right world +x. So the image's top
  // row is the subject's -z edge and its right column the +x edge, which is the
  // mapping buildPlateCard's corners are written against. Three's lookAt picks
  // the whole basis off this one vector, and the default (0, 1, 0) is degenerate
  // looking straight down.
  cam.up.set(0, 0, -1)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()

  const pixels = captureLayer(
    renderer, geometry, texArray, layer, cam, new THREE.Vector3(0, camY, 0),
    { tint, vertexColors, bounce })
  return { width: cardW, depth: cardD, meanLuma: coveredLuma(pixels), coverage: coverage(pixels) }
}

/**
 * Render `geometry` through `cam` into `layer`, lit by a white key at `keyPos`
 * over a hemisphere whose ground is `bounce`. Returns the bytes it stored.
 *
 * The half both bakes share; what a bake chooses is its camera and where the key
 * stands. Restores the render target and clear state it found.
 */
function captureLayer(renderer, geometry, texArray, layer, cam, keyPos, { tint, vertexColors, hemFray = null, bounce }) {
  if (layer < 0 || layer >= texArray.image.depth) {
    throw new Error(`captureLayer: layer ${layer} is outside the ${texArray.image.depth}-layer array`)
  }

  // `vertexColors` is the building kit's and `hemFray` the trees' -- see
  // createImpostorBakeMaterial. A prop leaves both off and carries neither
  // attribute.
  const material = createImpostorBakeMaterial(texArray, { vertexColors, hemFray })
  // A FAMILY MAY BE TINTED, and if it is, the photograph has to be tinted the
  // same way or the card is a different colour from the mesh it stands in for --
  // which is the most visible artefact an impostor can have, because the swap
  // happens at a fixed distance in front of the player and a colour step there
  // reads as a wall. Dead wood is the case: it is drawn through a material whose
  // `color` browns and darkens live bark into dead bark (DEADWOOD_TINT), and the
  // multiply belongs here for the same reason it belongs there -- before the
  // atlas sample is handed on, so moss and snow still mix over the top of it in
  // their own colours.
  if (tint !== null) material.color.setHex(tint)
  const mesh = new THREE.Mesh(geometry, material)
  const scene = new THREE.Scene()
  scene.add(mesh)

  // THE BAKE RIG. What it is for and why it is shaped this way is in the note
  // on createImpostorBakeMaterial; the numbers are here, and where the key
  // stands is the caller's, next to the camera it is aimed relative to.
  //
  // The hemisphere is doing the heavier job of the two despite the lower
  // number. Its ground colour is what a downward-facing texel collects, and for
  // a canopy that is nearly nothing -- the shadowed interior mass that makes a
  // distant crown read as a third of leaf albedo instead of as a flat green
  // cutout. A subject with no interior passes its own `bounce`; see BAKE_GROUND.
  const key = new THREE.DirectionalLight(0xffffff, BAKE_KEY)
  key.position.copy(keyPos)
  scene.add(key)
  scene.add(new THREE.HemisphereLight(0xffffff, bounce, BAKE_SKY))

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
  material.dispose()

  // readRenderTargetPixels hands back GL's row order, bottom row first. Every
  // other layer in this array came through a canvas, whose row 0 is the TOP of
  // the image, and the whole atlas has to agree about which way up v runs or
  // half of it is upside down. So: flip here, and the impostor card puts v = 0
  // at its top like everything else.
  const pixels = downsample(raw, big)
  flipY(pixels)
  dilate(pixels)

  const stride = TEX_SIZE * TEX_SIZE * 4
  texArray.image.data.set(pixels, layer * stride)
  texArray.needsUpdate = true

  return pixels
}

// Mean luminance over the texels the prop actually COVERS, 0..1 in sRGB, and
// the coverage fraction beside it. This is the one number that says whether the
// bake rig is aimed right -- see BAKE_KEY. Averaging over the whole layer would
// not: a card is mostly empty, and a picture that got darker would be
// indistinguishable from one that got thinner. `dilate` has already pushed
// colour into the transparent margin by the time this runs, which is exactly
// why the alpha test is here and not a check for a non-black texel.
export function coveredLuma(px) {
  let sum = 0
  let n = 0
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue
    sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
    n++
  }
  return n > 0 ? sum / n : 0
}

export function coverage(px) {
  let n = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] >= 128) n++
  return n / (px.length / 4)
}

// Box-filter `big` x `big` RGBA down to TEX_SIZE, resolving colour the only way
// a cutout can be resolved: WEIGHTED BY ALPHA. A plain average would mix the
// transparent texels' colour -- which is black, because nothing ever wrote them
// -- into every edge and hand back a canopy with a sooty rim. Alpha itself
// averages plainly, because that is exactly what coverage means.
export function downsample(src, big) {
  const n = big / TEX_SIZE
  const out = new Uint8Array(TEX_SIZE * TEX_SIZE * 4)
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let w = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const j = ((y * n + sy) * big + (x * n + sx)) * 4
          const sa = src[j + 3]
          r += src[j] * sa
          g += src[j + 1] * sa
          b += src[j + 2] * sa
          a += sa
          w += sa
        }
      }
      const i = (y * TEX_SIZE + x) * 4
      if (w > 0) {
        out[i] = r / w
        out[i + 1] = g / w
        out[i + 2] = b / w
      }
      out[i + 3] = a / (n * n)
    }
  }
  return out
}

export function flipY(px) {
  const row = TEX_SIZE * 4
  const tmp = new Uint8Array(row)
  for (let y = 0; y < TEX_SIZE / 2; y++) {
    const a = y * row
    const b = (TEX_SIZE - 1 - y) * row
    tmp.set(px.subarray(a, a + row))
    px.copyWithin(a, b, b + row)
    px.set(tmp, b)
  }
}

// Push colour outward into transparent texels, alpha untouched. See
// DILATE_PASSES.
export function dilate(px) {
  for (let pass = 0; pass < DILATE_PASSES; pass++) {
    const src = px.slice()
    for (let y = 0; y < TEX_SIZE; y++) {
      for (let x = 0; x < TEX_SIZE; x++) {
        const i = (y * TEX_SIZE + x) * 4
        if (src[i + 3] !== 0) continue
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= TEX_SIZE || ny >= TEX_SIZE) continue
            const j = (ny * TEX_SIZE + nx) * 4
            if (src[j + 3] === 0) continue
            r += src[j]
            g += src[j + 1]
            b += src[j + 2]
            n++
          }
        }
        if (!n) continue
        px[i] = r / n
        px[i + 1] = g / n
        px[i + 2] = b / n
      }
    }
  }
}

/**
 * The card the bake gets drawn on: `planes` quads crossed about the trunk,
 * seated on the ground, addressing `layer` exactly once.
 *
 * Three planes is the default and the shape the whole idea is named for -- at
 * 60 degrees apart you are never more than 30 degrees off the normal of one of
 * them, so there is always a plane presenting the picture close to square-on
 * while the other two supply depth. Two planes (a cross) leaves a 45-degree
 * worst case and visibly flattens on the diagonals; four costs 8 triangles for
 * a worst case of 22 degrees, which is not a change you can see.
 *
 *   planes  triangles  worst angle off a plane
 *   1       2          90 deg -- edge on, it is GONE
 *   2       4          45 deg
 *   3       6          30 deg
 *   4       8          22.5 deg
 *
 * ONE PLANE IS ONLY LEGAL IF SOMETHING TURNS IT. The 90-degree row is not a
 * quality figure, it is a disappearance: a fixed single quad seen along its own
 * plane covers no pixels at all, and a batched multi-draw has no per-frame
 * chance to yaw it toward the eye. So one plane belongs to a camera-facing
 * billboard and nothing else, and every fixed card here starts at two. That is
 * the whole reason a fern's card is 4 triangles and not the 2 that DESIGN.md §5
 * originally tabled for the bush class.
 *
 * Planes are spread over HALF a turn, not a whole one: a quad at azimuth `a`
 * and a quad at `a + 180` are the same plane, and the material draws double
 * sided, so three planes over 180 degrees is the hex and three over 360 would
 * be two planes and a duplicate.
 *
 * They all intersect in one line up the trunk, which was tried the other way
 * and put back: sliding each plane out along its own normal so their footprint
 * is a triangle rather than a point encloses a volume, but each plane carries a
 * whole tree INCLUDING ITS TRUNK drawn up the plane's own centre line, so the
 * offset splits one trunk into three. Crossing on the axis keeps the three
 * trunk images on top of each other, which is what a trunk has to look like.
 *
 * ALTERNATE PLANES ARE MIRRORED IN U. Three double-sided quads give SIX
 * apparent faces as you walk around, their normals 60 degrees apart, and the
 * order you meet them in is not p0, p1, p2 front then back -- it interleaves:
 * p2-back, p0-front, p1-front, p2-front, p0-back, p1-back. Since the back of a
 * quad is already the mirror of its front, that sequence is M N N N M M, and
 * those three N's in a row are the same picture three times running. Flipping u
 * on the odd-indexed plane turns it into M N M N M N: no two neighbours alike,
 * and from one bake.
 *
 * The parity only works out for an ODD number of planes. At 4 the wrap lands
 * two alike at one of the eight seams. At 2 it does not help at all -- the four
 * apparent faces come out N M M N either way, so mirroring only moves which
 * pair is adjacent. It is left on regardless: it costs nothing, and the case it
 * fails on is a fern, which is a ROSETTE and therefore close to its own mirror
 * image anyway. A pine would notice; a plant with radial symmetry does not.
 *
 * NORMALS COME IN THREE KINDS, and which one a card gets is the single biggest
 * decision about how it looks. material.js keeps whichever one is authored here
 * even when you are looking at the back of a plane -- it undoes three's
 * double-sided flip and applies a gentle back-facing ramp instead, which on a
 * canopy is its shaded side.
 *
 *   PLANE (the default). One constant outward horizontal normal per plane. It
 *   is the right answer for a SOLID whose planes really are facing different
 *   ways -- a rock -- and the wrong one for a canopy, because three planes 60
 *   degrees apart get three different constant values of dot(N, L). Under a low
 *   sun that is one plane fully lit, one at half and one clamped to black,
 *   meeting along the trunk axis with nothing in between: three flat slabs and
 *   a hard line down the middle of the tree. It is the most obviously fake
 *   thing a crossed card does.
 *
 *   CANOPY. Mostly UP, fanning outward from the trunk axis. A crown is a blob,
 *   and a blob's normals point away from its middle, so the top corners lean
 *   out and up and the skirt corners lean out and down. Two things fall out of
 *   that. The average normal over each plane is vertical, which is the SAME
 *   average for all three planes -- so the seam stops being a step in
 *   brightness, because there is no longer a per-plane brightness to step
 *   between. And what replaces it is a gradient ACROSS each quad, bright edge
 *   to dark edge, which is what a lit sphere actually looks like. The variation
 *   did not go away; it moved from between the planes to inside them, which is
 *   where the eye reads it as roundness instead of as geometry.
 *
 *   UP (`upNormal`). Exactly (0, 1, 0), for a single-plane card drawn as a
 *   camera-facing billboard (see billboardVertex in material.js). On a
 *   billboard a horizontal normal is worse than wrong, it is UNSTABLE: the
 *   quad's facing tracks the camera but a normal left in object space does not,
 *   so the back-facing ramp swings as the player turns on the spot and the
 *   whole bed twinkles. A vertical normal is steady and, for a fern bed seen
 *   from 14 m out, closer to true anyway -- that bed IS a ground surface.
 *
 * A canopy fan would work on a billboard too, and correctly: the card's spin
 * tracks the view, so the fan would track it as well and reproduce a sphere's
 * terminator rather than swinging like a plane normal would. It is NOT done,
 * because `normal.y` is the only thing separating the two card tiers that share
 * one baked layer -- see CARD_UP_MARK below -- and because with the bake now
 * lit (createImpostorBakeMaterial) the billboard gets its roundness from the
 * photograph instead. If the tiers are ever given separate layers, revisit.
 *
 * THE TWO NUMBERS. CANOPY_SPREAD is how far the fan leans off vertical: 0 is
 * `upNormal` and 1 is a 45-degree lean at the top corners. CANOPY_SKIRT_UP is
 * how much of that vertical component survives at the bottom of the card, so
 * below 1 the skirt tips outward and darkens, which is what the underside of a
 * canopy does. Both are capped by CARD_UP_MARK, and buildImpostorCard asserts
 * it rather than trusting it.
 *
 * A BILLBOARD CAN BE ONE TRIANGLE (`tri`), and at a forest that is the single
 * biggest saving on the whole ladder: the far band holds tens of thousands of
 * instances, so halving its card halves the tree budget's largest line. What it
 * spends is two CORNERS of the photograph, and which two is the species'
 * choice. `tri: 'up'` is apex at the top, base across the ground, and drops the
 * two top corners; `tri: 'down'` is the inverse and drops the two at the foot.
 *
 * THE FIT IS A SPECIES FACT, not a taste one. A conifer IS a triangle apex-up,
 * and a lollipop -- a round crown over a bare trunk -- is close to one apex-down,
 * because the ground corners either side of a trunk hold nothing.
 *
 * APEX-DOWN NEEDS `sink` TO BE HONEST, and that is not a refinement, it is the
 * difference between a tree and a pencil standing on its tip. Collapsed all the
 * way, the card has ZERO width at y = 0, so the bottom of the trunk tapers to a
 * point -- the one part of a distant tree the eye is guaranteed to be looking at,
 * because it is where the tree meets the ground. Dropping the apex below the
 * ground gives the card real width where the trunk is; `foot` on
 * impostorCardExtents is the end that computes how far, and the bake frames the
 * same strip so the picture and the geometry agree. Rasterized against the real
 * LOD0 silhouette over 6 seeds, apex-down at the sink each species' own trunk
 * asks for, against the un-sunk card and the apex-up alternative:
 *
 *            apex-up   apex-down   apex-down, sunk   sink   card area
 *   pine       89.2%      60.8%     -- (apex-up)      --      0.500
 *   oak        60.7%      81.9%          87.4%       12.2%    0.558
 *   birch      66.6%      82.7%          84.9%        4.5%    0.521
 *   aspen      65.9%      91.8%          93.2%        4.7%    0.522
 *
 * (`sink` as a fraction of tree height; card area against the w x h rectangle a
 * quad would have covered, so a quad is 1.000.) The sink is not a trade -- it
 * widens the triangle at EVERY height below its top, so foliage coverage goes up
 * with it. Wood is where it really tells: the oak's trunk goes from 72.1% to
 * 87.0% covered, and the missing part was all of it at the ground.
 *
 * WHAT THE CLIP COSTS AND WHY IT IS PAID. It is not diffuse -- it is a straight
 * slice off each lower shoulder of a round crown, which at 50 m is a wedge about
 * 24 px wide and 36 px deep on an oak. trees.js cross-dissolves the swap into
 * this tier over a quarter second, so the wedge goes the way the rest of the
 * mesh does rather than between two frames; it would be affordable either way,
 * because that shoulder is the loudest thing in a swap that is already
 * exchanging a whole mesh for a picture of one. Past 300 m it is 4-7 px and the
 * mip chain has eaten it.
 *
 * THE OTHER TRIANGLE IS NOT WORTH LOOKING FOR. The world triangle and the uv
 * triangle are joined by one affine map, so overhanging the square samples a
 * smaller part of the same picture rather than reaching a bigger one -- every
 * proposal reduces to "which triangle inside [0,1]^2". Searched exhaustively
 * against the same silhouettes and restricted to the u-symmetric shapes the
 * mirror trick allows, the best found is within a few points of the inscribed
 * one everywhere (pine 90.2, oak 87.2, birch 77.9, aspen 88.6). Widening the
 * bake's MARGIN is the same lever the sink pulls, on the other axis: it shrinks
 * the tree inside the same square, and at +0.20 a pine's apex-up card keeps
 * 99.8%. It costs texel density on every tier that shares the layer, and the
 * card now starts at 24 m where there is none to spare -- so it is spent only
 * where the artefact is structural, which is the foot.
 *
 * ONE THING THIS DOES NOT SOLVE: mip coverage. The impostor's alpha is binary
 * out of the bake, and each mip averages it, so a canopy that is half holes
 * drops toward alpha 0.5 as it shrinks and alphaTest 0.5 starts eating it --
 * the tree thins with distance instead of just getting smaller. If that shows
 * up at 100 m the fix is coverage-preserving mips (rescale each level's alpha
 * until it discards the same fraction the top level does), not a lower
 * alphaTest, which is shared by every prop in the batch.
 */
export function buildImpostorCard(
  width,
  height,
  layer,
  planes = 3,
  { upNormal = false, canopy = false, tri = false, sink = 0, spherical = false, azimuth = 0 } = {}
) {
  // `sink` comes out of impostorCardExtents and is already counted INSIDE
  // `height` -- it says how much of that height hangs below y = 0, not how much
  // to add. Taking it as an addition instead would stretch every card that asks
  // for one, which is a thing you would notice only by measuring a tree.
  if (sink < 0 || sink >= height) {
    throw new Error(`buildImpostorCard: sink is part of the card's ${height} height, got ${sink}`)
  }
  if (upNormal && canopy) {
    throw new Error('buildImpostorCard: upNormal and canopy are two answers to the same question')
  }
  // `azimuth` IS THE BAKE ANGLE, NOT A FREE ROTATION. bakeImpostor stands its
  // camera at (sin a, 0, cos a) and photographs whatever faces it; a FIXED card
  // has to lie in the plane that camera was looking at, or it shows a broadside
  // photograph edge-on. A SPUN card never faces anywhere in particular -- the
  // vertex shader turns it to the eye every frame -- so an azimuth on one would
  // be a claim the geometry cannot keep. Refuse rather than ignore it.
  if (azimuth !== 0 && upNormal) {
    throw new Error('buildImpostorCard: a spun card has no fixed azimuth to be baked at')
  }
  // `spherical` is not a shape -- the vertices below are identical either way.
  // It says which of billboardVertex's two spins this card will meet, and the
  // only thing that depends on that is the bounding volume. See the note by
  // the bounds at the end of this function.
  if (spherical && !upNormal) {
    throw new Error('buildImpostorCard: a card that is not marked for spinning cannot be spun spherically')
  }
  if (tri && tri !== 'up' && tri !== 'down') {
    throw new Error(`buildImpostorCard: tri must be 'up', 'down' or false, not ${tri}`)
  }
  // A canopy fan signs its outward lean off `x < 0 ? -SPREAD : SPREAD`, and a
  // triangle has a corner sitting exactly ON x = 0 where that sign is not
  // defined. The two are never wanted together anyway -- `tri` is the billboard
  // tier and `canopy` is the cross -- so refuse rather than pick a sign.
  if (tri && canopy) {
    throw new Error('buildImpostorCard: a canopy fan has no sign at a triangle apex')
  }
  const n = Math.max(1, Math.round(planes))
  const positions = []
  const normals = []
  const uvs = []
  const layers = []
  const indices = []
  const hw = width / 2

  for (let i = 0; i < n; i++) {
    // MINUS the azimuth, so the normal comes out pointing AT the bake camera.
    // The normal below is (-sin a, 0, cos a); at a = -azimuth that is
    // (sin azimuth, 0, cos azimuth), which is exactly where bakeImpostor put the
    // camera. Zero leaves every existing card on the axes it was already on.
    const a = -azimuth + (i / n) * Math.PI
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    // The plane spans `d` and up; its normal is the remaining horizontal axis.
    const nx = -dz
    const nz = dx
    const base = positions.length / 3
    // Every other plane reads its u backwards -- see the mirroring note above.
    const flip = i % 2 === 1
    // v = 0 at the top -- see the note by flipY in bakeImpostor.
    //
    // A `tri` card is the same rectangle with one corner pair collapsed toward
    // the trunk line: HALF the triangles for the corners of the picture the
    // tree was never in. Wound the same way round as the quad, and still
    // symmetric about u = 0.5, which billboardVertex's per-instance u-flip
    // requires -- an asymmetric uv triple would show half the forest a sheared
    // photograph. See the triangle note above for what each species gives up.
    //
    // The bottom edge is at `-sink` rather than at 0, which is the whole of what
    // a sink is: the card hangs below the ground and the picture hangs with it,
    // so an apex-down triangle has real width where the subject's feet are. The
    // buried part is empty in every bake -- there is nothing under a tree -- so
    // it costs the fill of a strip the depth buffer mostly rejects against the
    // terrain in front of it.
    const y0 = -sink
    const y1 = height - sink
    const corners = tri === 'up'
      ? [[-hw, y0, 0, 1], [hw, y0, 1, 1], [0, y1, 0.5, 0]]
      : tri === 'down'
        ? [[0, y0, 0.5, 1], [hw, y1, 1, 0], [-hw, y1, 0, 0]]
        : [
          [-hw, y0, 0, 1],
          [hw, y0, 1, 1],
          [hw, y1, 1, 0],
          [-hw, y1, 0, 0],
        ]
    for (const [x, y, u0, v] of corners) {
      const u = flip ? 1 - u0 : u0
      positions.push(dx * x, y, dz * x)
      if (upNormal) {
        normals.push(0, 1, 0)
      } else if (canopy) {
        // Outward and UP, fanning from the trunk axis -- see the canopy note.
        // The horizontal half points away from the axis along this plane's own
        // direction, so the two vertical edges of a quad lean opposite ways and
        // the shading sweeps across the card instead of stepping at its seam.
        const s = x < 0 ? -CANOPY_SPREAD : CANOPY_SPREAD
        const ny = CANOPY_SKIRT_UP + (1 - CANOPY_SKIRT_UP) * ((y - y0) / height)
        const len = Math.hypot(s, ny)
        normals.push((dx * s) / len, ny / len, (dz * s) / len)
      } else {
        normals.push(nx, 0, nz)
      }
      uvs.push(u, v)
      layers.push(layer)
    }
    if (tri) indices.push(base, base + 1, base + 2)
    else indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  // THE BILLBOARD MARKER IS A CONTRACT, so check it rather than trusting it.
  // material.js's billboardVertex decides whether to spin a quad by testing
  // `normal.y > CARD_UP_MARK`, and a canopy normal that drifted over that line
  // would set a fixed three-plane cross rotating about its own trunk. Assert
  // the two cases stay on their own sides of it, here, where the numbers are.
  const wantUp = upNormal
  for (let k = 1; k < normals.length; k += 3) {
    if (wantUp !== normals[k] > CARD_UP_MARK) {
      throw new Error(
        `buildImpostorCard: normal.y ${normals[k].toFixed(3)} is on the wrong side of the ` +
          `${CARD_UP_MARK} billboard marker for a card with upNormal=${upNormal}`
      )
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layers, 1))
  geo.setIndex(indices)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  // THE BOUNDS HAVE TO HOLD THE SPIN, NOT THE VERTICES. BatchedMesh culls each
  // instance against the bounding sphere of the geometry it is drawing, and
  // billboardVertex moves the vertices after that decision is made. So the
  // sphere has to contain every position the spin can put them in, or the
  // renderer drops a card that is still on screen -- which reads as rocks
  // blinking in and out as you turn, worst near the edge of the view where a
  // frame of head movement flips the test back and forth.
  //
  // The cylindrical spin is safe with the tight sphere for free: it turns
  // (x, z) about the instance's Y axis, so every vertex keeps its height and
  // its horizontal radius and stays inside the box the vertices already
  // describe. That is why only rocks show this and no other card does.
  //
  // The spherical spin does not. It rebuilds the vertex as
  // `x * screenRight + y * screenUp` -- an orthonormal pair -- so a vertex ends
  // up at distance hypot(x, y) FROM THE FOOT, pointing anywhere at all. The
  // envelope is therefore a sphere centred on the foot whose radius is the
  // longest vertex, which is exactly what is measured here. It is bigger than
  // the tight one (about 2x on a square card) and that is the honest price of
  // a quad that can face any direction.
  if (spherical) {
    let r2 = 0
    for (let k = 0; k < positions.length; k += 3) {
      const d2 = positions[k] ** 2 + positions[k + 1] ** 2 + positions[k + 2] ** 2
      if (d2 > r2) r2 = d2
    }
    const r = Math.sqrt(r2)
    geo.boundingSphere.center.set(0, 0, 0)
    geo.boundingSphere.radius = r
    geo.boundingBox.min.set(-r, -r, -r)
    geo.boundingBox.max.set(r, r, r)
  }

  geo.userData.impostor = {
    width, height, planes: n, layer, triangles: n * (tri ? 1 : 2), mirrored: n > 1,
    upNormal, canopy, tri, sink, spherical, azimuth,
  }
  return geo
}

/**
 * The card a top-down bake gets drawn on: two triangles lying FLAT in the
 * subject's own local XZ plane, `lift` above it.
 *
 * THE OTHER KIND OF CARD ENTIRELY, and that is why it is its own function rather
 * than a flag on buildImpostorCard. Every concept in there -- the crossed
 * planes, the sink, the apex triangle, the canopy fan, the u-mirror, the spin --
 * belongs to a card that STANDS UP in front of a camera at eye level and has to
 * cope with being seen from any bearing. This one does none of that. It lies on
 * the surface its subject was laid on, at the subject's own yaw and tilt, and it
 * is looked DOWN on. A flag would have had to switch off nine tenths of that
 * function to arrive here.
 *
 * IT IS NOT A BILLBOARD AND MUST NOT BE IN `uBillboardLayers`. material.js spins
 * a quad when its layer is in that list AND its normal.y clears CARD_UP_MARK,
 * and this card's normal is exactly (0, 1, 0) -- so listing its layer would spin
 * the one card in the world that already knows which way it should face. The
 * instance matrix carries the plate's yaw, its tilt into the cliff and its
 * scale, so "the same angle as the mesh it replaces" costs nothing: it is the
 * same matrix.
 *
 * THE PROPORTIONS ARE THE SUBJECT'S OWN, width by DEPTH, so a plate stretched
 * 2 : 1.2 draws a card stretched 2 : 1.2. There is no mean-over-the-compass here
 * of the kind rockCardFrame takes for a spun quad, and there does not need to be:
 * a card that keeps its own yaw is seen from the same side the photograph was
 * taken from, always.
 *
 * `lift` HOLDS IT OFF THE SURFACE, along the plate's own +Y -- which is the
 * surface normal, because that is what the instance was aligned to. It has to
 * clear not a depth-buffer step but the plate's whole BURIAL: a plate is placed
 * sunk into the face, so its bed plane, which is y = 0 here, is under the wall.
 * A card left in that plane is not dim, it is behind the terrain and gone. The
 * caller owns that arithmetic; see PLATE_CARD_LIFT in rock-bank.js.
 *
 * WINDING. The corners run counter-clockwise seen from +Y, so the front face is
 * the one pointing out of the cliff. That is the only side a camera can be on,
 * which is what makes a FrontSide material safe here without a spin to guarantee
 * it -- see the note by `side` in v2/render/rocks.js.
 *
 * UV. `bakeImpostorPlate` stands its camera on +Y with up = -z, so the image's
 * top row is the subject's -z edge and its right column the +x edge; v = 0 is
 * the top row, as it is for every other layer in the atlas (see flipY). Hence
 * u = 0 at -x, v = 0 at -z. Get this pair wrong and the card is a mirrored or
 * quarter-turned photograph of the right rock, which reads as "the distant
 * plates do not quite line up" and nothing louder.
 */
export function buildPlateCard(width, depth, layer, { lift = 0 } = {}) {
  if (!(width > 0) || !(depth > 0)) {
    throw new Error(`buildPlateCard: need a positive width and depth, got ${width}x${depth}`)
  }
  if (!(lift >= 0)) throw new Error(`buildPlateCard: lift is a height above the surface, got ${lift}`)

  const hw = width / 2
  const hd = depth / 2
  const corners = [
    [-hw, hd, 0, 1],
    [hw, hd, 1, 1],
    [hw, -hd, 1, 0],
    [-hw, -hd, 0, 0],
  ]
  const positions = []
  const normals = []
  const uvs = []
  const layers = []
  for (const [x, z, u, v] of corners) {
    positions.push(x, lift, z)
    normals.push(0, 1, 0)
    uvs.push(u, v)
    layers.push(layer)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layers, 1))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  // Nothing moves these vertices after the cull test, so the tight bounds are
  // the true ones -- the opposite of the spun card's case a few lines up.
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  geo.userData.impostor = { plate: true, width, depth, lift, layer, planes: 1, triangles: 2 }
  return geo
}
