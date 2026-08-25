import * as THREE from 'three'
import { TEX_SIZE } from '../textures.js'
import { createImpostorBakeMaterial } from '../material.js'

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
// and the top; the bottom is the ground line, and what sits against it is an
// opaque trunk rather than a leaf.
//
// A FERN puts leaves against that bottom edge -- a drooping frond tip really
// does reach the ground -- so there the wrap blends the last row of tips with
// the first row of empty sky. It is left as it is, and the reason is the range
// rather than the geometry: the card only ever draws from 26 m out, where the
// whole 128-texel slice covers about 20 screen pixels, so the affected texel is
// a sixth of a pixel wide and the mip chain has averaged it away before it gets
// there. A bottom margin would have to be paid for by sinking the card below
// y = 0, which is a real change to every caller for an artefact nobody can see.
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
const SUPERSAMPLE = 4

/**
 * Render `geometry` side-on into one layer of the texture array, in place.
 *
 * Returns the card extents the capture was framed to, which is what
 * `buildImpostorCard` has to be given for the stretch to cancel.
 *
 * `renderer` is the live WebGLRenderer -- this is a load-time step that borrows
 * the context for one frame, the way fern-bank borrows a millisecond of startup
 * rather than shipping an asset. It restores the render target and clear state
 * it found.
 */
/**
 * The card size a subject of `width` x `height` gets framed into: its own
 * extents plus the transparent MARGIN.
 *
 * Exported because the card GEOMETRY and the card PIXELS do not have to be made
 * at the same moment, and in the game they are not -- the quads go into the
 * batch's arena when the scatter is constructed, while the photograph cannot be
 * taken until the frond PNG has landed in the array. Both have to agree about
 * the framing to the last texel or the picture is stretched across the quad, so
 * both ask this rather than each applying the margin themselves.
 */
export function impostorCardExtents({ width, height }) {
  return { width: width * (1 + MARGIN * 2), height: height * (1 + MARGIN) }
}

export function bakeImpostor(renderer, geometry, texArray, layer, { width, height, azimuth = 0 }) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`bakeImpostor: need a positive width and height, got ${width}x${height}`)
  }
  if (layer < 0 || layer >= texArray.image.depth) {
    throw new Error(`bakeImpostor: layer ${layer} is outside the ${texArray.image.depth}-layer array`)
  }

  const { width: cardW, height: cardH } = impostorCardExtents({ width, height })

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
  const cam = new THREE.OrthographicCamera(-cardW / 2, cardW / 2, cardH, 0, 0.01, reach * 8)
  // Level with the ground and looking horizontally, so camera-y IS world-y and
  // the frustum's [bottom, top] of [0, cardH] is the tree standing on the
  // texture's bottom edge. Any tilt here bakes a worm's- or bird's-eye view
  // into a card that will be seen from neither.
  cam.position.set(Math.sin(azimuth) * reach * 2, 0, Math.cos(azimuth) * reach * 2)
  cam.lookAt(0, 0, 0)
  cam.updateMatrixWorld()

  const material = createImpostorBakeMaterial(texArray)
  const mesh = new THREE.Mesh(geometry, material)
  const scene = new THREE.Scene()
  scene.add(mesh)

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

  return { width: cardW, height: cardH }
}

// Box-filter `big` x `big` RGBA down to TEX_SIZE, resolving colour the only way
// a cutout can be resolved: WEIGHTED BY ALPHA. A plain average would mix the
// transparent texels' colour -- which is black, because nothing ever wrote them
// -- into every edge and hand back a canopy with a sooty rim. Alpha itself
// averages plainly, because that is exactly what coverage means.
function downsample(src, big) {
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

function flipY(px) {
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
function dilate(px) {
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
 * `upNormal` REPLACES THE PER-PLANE NORMAL WITH A VERTICAL ONE, and it exists
 * for exactly one caller: a single-plane card drawn as a camera-facing
 * billboard (see billboardVertex in material.js). Everywhere else it is wrong
 * and the paragraph below is why. On a billboard the horizontal normal is worse
 * than wrong, it is UNSTABLE: the quad's facing tracks the camera but a normal
 * left in object space does not, so material.js's back-facing ramp swings as
 * the player turns on the spot and the whole bed twinkles. A vertical normal is
 * both steady and closer to true, because a fern bed seen from 14 m out is a
 * ground surface and is lit like one.
 *
 * NORMALS ARE OUTWARD AND HORIZONTAL, one per plane. The bake is unlit albedo
 * (see createImpostorBakeMaterial), so all of the shading lives here, and this
 * is the same normal the LOD0 canopy carries -- tree.js's canopy pass gives
 * every leaf the crown shell's outward normal. The result is that a tree does
 * not change brightness when it swaps tiers. material.js keeps that authored
 * normal when you are looking at the back of a plane and applies its gentle
 * back-facing ramp instead, which here is the shaded side of a canopy.
 *
 * ONE THING THIS DOES NOT SOLVE: mip coverage. The impostor's alpha is binary
 * out of the bake, and each mip averages it, so a canopy that is half holes
 * drops toward alpha 0.5 as it shrinks and alphaTest 0.5 starts eating it --
 * the tree thins with distance instead of just getting smaller. If that shows
 * up at 100 m the fix is coverage-preserving mips (rescale each level's alpha
 * until it discards the same fraction the top level does), not a lower
 * alphaTest, which is shared by every prop in the batch.
 */
export function buildImpostorCard(width, height, layer, planes = 3, { upNormal = false } = {}) {
  const n = Math.max(1, Math.round(planes))
  const positions = []
  const normals = []
  const uvs = []
  const layers = []
  const indices = []
  const hw = width / 2

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    // The plane spans `d` and up; its normal is the remaining horizontal axis.
    const nx = -dz
    const nz = dx
    const base = positions.length / 3
    // Every other plane reads its u backwards -- see the mirroring note above.
    const flip = i % 2 === 1
    // v = 0 at the top -- see the note by flipY in bakeImpostor.
    const corners = [
      [-hw, 0, 0, 1],
      [hw, 0, 1, 1],
      [hw, height, 1, 0],
      [-hw, height, 0, 0],
    ]
    for (const [x, y, u0, v] of corners) {
      const u = flip ? 1 - u0 : u0
      positions.push(dx * x, y, dz * x)
      if (upNormal) normals.push(0, 1, 0)
      else normals.push(nx, 0, nz)
      uvs.push(u, v)
      layers.push(layer)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layers, 1))
  geo.setIndex(indices)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.impostor = {
    width, height, planes: n, layer, triangles: n * 2, mirrored: n > 1, upNormal,
  }
  return geo
}
