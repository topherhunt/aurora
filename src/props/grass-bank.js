import * as THREE from 'three'
import { bakeImpostor, impostorCardExtents } from './impostor.js'
import { geometryBytes } from './fern.js' // generic; it lives there for historical reasons
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The grass tuft bank: every blade of grass in the world, built at load.
//
// This is the smallest bank in the project by a wide margin and that is the
// point. A grass tuft is N QUADS STANDING ON A FOOTPRINT, all wearing the same
// greyscale cutout -- there is nothing else to it -- so the whole ladder is
// three geometries totalling 12 triangles, and every scrap of variety a player
// sees comes from per-instance yaw, scale and tint. See LAYER.GRASS_TUFT in
// textures.js for why one greyscale slice serves every colour of grass we will
// ever want.
//
// IT IS THE SAME ASSET AS /props gen_grass_tall, rebuilt rather than loaded.
// `tools/trees/generate.mjs` authors that GLB out of exactly this construction
// (its `crossQuads`, at 3 / 2 / 1 cards), `tools/props/build.py` grounds it,
// scales it to 0.55 m and bakes AO into COLOR_0, and the props browser draws
// the result. Nothing in that chain survives into a BatchedMesh: the batch
// needs `uvProj` and `texLayer` attributes the GLB does not carry, the v2 prop
// material ignores COLOR_0 entirely (colour is per INSTANCE, see
// createPropMaterial), and the geometry is twelve triangles. Fetching, parsing
// and re-attributing a GLB to arrive at twelve triangles would be a build
// dependency bought for nothing. The numbers below are the manifest's; the
// gate that they still agree is scripts/check-grass.mjs.
//
// THE TUFT HAS ITS OWN BUILDER rather than borrowing buildImpostorCard, and the
// difference between them is the whole reason this file has geometry in it. An
// impostor card is `planes` quads CROSSED ON ONE AXIS -- an asterisk in plan --
// because that is the right shape for a stand-in whose job is to present the
// same silhouette from every azimuth. It is the wrong shape for a clump. Every
// plane through one point means all three cards pile their alpha into a single
// vertical seam and taper to nothing at the edges, which is a star, not a tuft,
// and 20,000 stars on a hillside read as a pattern. buildGrassTuft below stands
// the same quads on the EDGES OF A TRIANGLE and TWISTS them, for no extra
// vertices; see its own note. buildImpostorCard is left alone because trees and
// ferns are exactly the case it is right for.
// ---------------------------------------------------------------------------

// The tuft's own size in metres, before any per-instance scale. Both numbers
// are `gen_grass_tall`'s: build.py scales that asset to height_m 0.55 and the
// authored quad is as wide as it is tall, so the tuft is square and so is the
// texture. No stretch anywhere in the chain, which is why `impostorCardExtents`
// is a no-op here and is called anyway -- the card and the mesh tiers have to
// be framed by the same function or the bake and the quad disagree.
//
// `width` is the FOOTPRINT DIAMETER, not a card's width. On the asterisk those
// were the same number because every card was a diameter; on the triangle the
// cards are its chords, so each one is width * sqrt(3)/2 = 0.476 m and the tuft
// still fits in the same 0.55 m circle. Framing keys off the circle, so nothing
// downstream of here had to move: bakeImpostor frames to `width` inflated by
// the impostor margin, the subject's widest azimuth is 0.476 m, and both the
// photograph and the card it lands on draw the grass back at 0.476 m.
export const GRASS_BASE = { width: 0.55, height: 0.55 }

// Cards per tier, finest first. 3 / 2 / 1 is the manifest's ladder and the
// bottom of it is the interesting entry: ONE plane is only legal because the
// vertex shader turns it (see billboardVertex in material.js). A fixed single
// quad seen along its own plane covers no pixels at all.
//
// There is no fourth tier and no "coarser mesh" below the billboard. A tuft
// is already 6 triangles at its finest; the entire ladder spans 6 -> 2, and the
// only thing left to cut after that is the instance itself, which is what the
// graded thinning in render/grass.js does instead.
export const GRASS_TIERS = [
  { name: 'LOD0', planes: 3 },
  { name: 'LOD1', planes: 2 },
  { name: 'LOD2', planes: 1, billboard: true },
]

// How far the top of a card is turned from its base, about the tuft's own axis.
//
// A quad standing on a straight base with a straight top is a straight wall,
// and a bed of them is a bed of straight walls: the eye finds the verticals and
// the whole carpet reads as cardboard. Rotating the TOP EDGE of every card by a
// common angle about the tuft's centre turns the prism into a twisted one. It
// costs NOTHING -- same four vertices, same two triangles, the top pair just
// land somewhere else -- and it is free of texture cost too, because uvProj on
// these quads is an explicit 0..1 UV rather than a world projection, so moving
// a corner slides the art with it instead of shearing it.
//
// 22 degrees, in the 10-30 range that reads as a lean rather than a shear. Past
// about 35 the two triangles of the quad fold hard enough to crease visibly at
// the diagonal, which is the real ceiling here.
//
// It is a CONSTANT, not per instance: one geometry serves every tuft in the
// batch, so the twist cannot vary per tuft the way yaw, scale and tint do. What
// stops 26,000 identical twists reading as a pattern is that per-instance yaw
// spins each one to a different azimuth.
const TUFT_TWIST_DEG = 22

/** The twist in radians, exported so scripts/check-grass.mjs gates the shape. */
export const TUFT_TWIST = (TUFT_TWIST_DEG * Math.PI) / 180

/**
 * A grass tuft: `planes` quads seated at y = 0, in the batch's attribute layout.
 *
 * THREE OR MORE CARDS STAND ON THE EDGES OF A REGULAR POLYGON inscribed in the
 * footprint circle, so at LOD0 the three of them close a triangle base to base
 * instead of radiating from one central seam. That buys two things for the same
 * six triangles. The alpha stops stacking -- an asterisk overlaps all three
 * cutouts down the middle and has nothing at the rim, so it is dark in the
 * centre and frayed at the edge, where a clump of grass is the other way round.
 * And the tuft acquires a plan area: it occupies a patch of ground roughly
 * 0.1 m^2 rather than three lines through a point, which is what makes a bed of
 * them read as ground cover instead of as scattered markers.
 *
 * TWO OR FEWER CARDS STAY CROSSED ON THE CENTRE, which is not an oversight. A
 * polygon needs three edges to close; the two-edge case degenerates to both
 * cards lying on the same diameter. The tempting alternative -- two parallel
 * chords, spread like the triangle -- has a killer azimuth: sighted along the
 * chords both cards go edge-on together and the tuft vanishes. Crossed cards
 * never do, because one of them is always at 45 degrees or better to the eye.
 * That matters at LOD1's 8-20 m and it is why the near tier eats the shape
 * change at 8 m instead. The change is small in practice: same circle, same
 * texture, same twist, and per-instance yaw means the two tiers were never
 * lined up with each other anyway.
 *
 * EVERY VERTEX TAKES THE VERTICAL NORMAL, including on the crossed tiers, and
 * this is the one place the grass bank departs from what the GLB carries.
 * impostor.js argues for outward horizontal normals on a fixed card because a
 * tree card stands in for a canopy, which is lit as a vertical wall of leaves.
 * A grass carpet is not that. Its aggregate surface IS the ground: 20,000 tufts
 * over a hillside are lit by what the hillside is lit by, and giving each blade
 * a horizontal normal makes the whole bed go dark whenever the sun is high --
 * which is precisely when a meadow should be at its brightest. The second
 * reason is mechanical and settles it on its own: the far tier MUST take the
 * vertical normal (impostor.js: a horizontal normal on a billboard is unstable,
 * because the quad's facing tracks the camera and an object-space normal does
 * not, so the bed twinkles as the player turns on the spot). If the mesh tiers
 * kept horizontal normals, every tuft would change brightness as it crossed the
 * 20 m boundary, and at this density that boundary has a few thousand tufts
 * sitting on it. One normal for the ladder, no swap artefact.
 *
 * @param {number} width  footprint DIAMETER -- the circle the cards inscribe
 * @param {number} twist  radians the top edge is turned from the base edge
 */
function buildGrassTuft(width, height, layer, planes, { twist = 0 } = {}) {
  const n = Math.max(1, Math.round(planes))
  const r = width / 2

  // The base edges, as pairs of xz points. The polygon is phased so that one
  // edge is square-on to +z, which is the azimuth bakeGrassImpostor photographs
  // from -- that is the tuft's widest profile, so the card gets the fullest
  // silhouette on offer rather than a vertex-on one.
  const edges = []
  if (n >= 3) {
    const v = []
    for (let k = 0; k < n; k++) {
      const a = Math.PI / 2 + (k / n) * Math.PI * 2
      v.push([Math.cos(a) * r, Math.sin(a) * r])
    }
    for (let i = 0; i < n; i++) edges.push([v[i], v[(i + 1) % n]])
  } else {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI
      const dx = Math.cos(a) * r
      const dz = Math.sin(a) * r
      edges.push([[-dx, -dz], [dx, dz]])
    }
  }

  const positions = []
  const normals = []
  const uvs = []
  const layers = []
  const indices = []
  const ct = Math.cos(twist)
  const st = Math.sin(twist)

  edges.forEach(([a, b], i) => {
    const base = positions.length / 3
    // Every other card reads its u backwards, so the same 128 px cutout does not
    // repeat verbatim inside one tuft. Same trick as buildImpostorCard's.
    const flip = i % 2 === 1
    // The top edge is the base edge turned about the tuft's axis. A rotation,
    // so the top edge is exactly as long as the base and the card is warped
    // rather than stretched -- and the tuft's bounding circle is untouched,
    // which is what keeps the bake framing correct at any twist.
    const ta = [a[0] * ct - a[1] * st, a[0] * st + a[1] * ct]
    const tb = [b[0] * ct - b[1] * st, b[0] * st + b[1] * ct]
    // v = 0 at the top -- see the note by flipY in bakeImpostor.
    const corners = [
      [a[0], 0, a[1], 0, 1],
      [b[0], 0, b[1], 1, 1],
      [tb[0], height, tb[1], 1, 0],
      [ta[0], height, ta[1], 0, 0],
    ]
    for (const [x, y, z, u0, v] of corners) {
      positions.push(x, y, z)
      normals.push(0, 1, 0)
      uvs.push(flip ? 1 - u0 : u0, v)
      layers.push(layer)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  })

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layers, 1))
  geo.setIndex(indices)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.tuft = {
    width, height, planes: n, layer, triangles: n * 2, twist, polygon: n >= 3,
  }
  return geo
}

/**
 * The mesh and card geometries, in the shared batch's attribute layout. No
 * renderer, no pixels: safe in a constructor and in node.
 *
 * Returns `{ tiers, cardLayer, cardTier, bytes }` where `tiers[t].geometry` is
 * the geometry for tier `t`, finest first, so a distance band indexes it
 * directly. There is no variant axis -- see the header: a tuft has no axes, and
 * the variety is per instance.
 *
 * The caller owns the geometries and MUST dispose them once they are in the
 * batch; BatchedMesh copies the vertex data into its arena.
 */
export function buildGrassBank({ height = GRASS_BASE.height } = {}) {
  const frame = grassFrame(height)
  // The card is BIGGER than the tuft and that is what keeps the swap invisible.
  // GRASS_TUFT is cropped to its own alpha bounds, so a mesh quad is exactly the
  // tuft; the impostor layer carries a transparent MARGIN (impostor.js) so that
  // bilinear filtering at the silhouette has somewhere to blend to, so the card
  // has to be inflated by the same margin to put the grass inside it back at
  // 0.55 m. Feed `ext` to a mesh tier instead and the art stretches 12%.
  const ext = impostorCardExtents(frame)
  let bytes = 0

  const tiers = GRASS_TIERS.map(({ name, planes, billboard = false }) => {
    // The billboard tier is the ONLY one on the impostor layer, and that is what
    // makes the shader spin it and leave the crossed quads alone -- the pick is
    // by texture layer and nothing else. See LAYER.IMPOSTOR_GRASS.
    const layer = billboard ? LAYER.IMPOSTOR_GRASS : LAYER.GRASS_TUFT
    const size = billboard ? ext : frame
    // The card is NOT twisted, and it is the one tier that must not be. It is a
    // photograph of the tuft, so the twist is already in the picture; twisting
    // the quad the picture hangs on would apply it a second time, and would do
    // it to a surface the vertex shader is busy turning to face the camera.
    const geometry = buildGrassTuft(size.width, size.height, layer, planes, {
      twist: billboard ? 0 : TUFT_TWIST,
    })
    bytes += geometryBytes(geometry)
    return { name, planes, billboard, layer, geometry, triangles: planes * 2 }
  })

  return {
    tiers,
    cardLayer: LAYER.IMPOSTOR_GRASS,
    cardTier: tiers.findIndex((t) => t.billboard),
    bytes,
  }
}

/** The layers `createPropMaterial` has to be told to billboard. */
export function grassBillboardLayers() {
  return [LAYER.IMPOSTOR_GRASS]
}

/**
 * Photograph the LOD0 tuft into LAYER.IMPOSTOR_GRASS, in place.
 *
 * Call ONCE, after `loadImageLayers()` has resolved and with the same `height`
 * `buildGrassBank` was given -- the subject wears GRASS_TUFT, and GRASS_TUFT is
 * a PNG that arrives some hundreds of milliseconds into the session. Bake
 * before it lands and the card is a photograph of nothing. Until then the far
 * tier draws an empty layer, which is fully transparent and so discarded by
 * alphaTest, exactly as the tree and fern cards do.
 *
 * The subject is the FINEST tier, at azimuth 0. Photographing the 2-plane tier
 * instead would donate its thinner silhouette to the 80% of instances that wear
 * the card, and the bake resolves to 128 px either way.
 *
 * The bake is unlit albedo and ignores COLOR_0 (createImpostorBakeMaterial), so
 * what lands in the layer is the same GREY the crossed quads sample -- which is
 * what we want, because the tint is applied per instance at draw time and would
 * otherwise be applied twice to the far tier and once to the near one.
 */
export function bakeGrassImpostor(renderer, texArray, { height = GRASS_BASE.height } = {}) {
  const frame = grassFrame(height)
  // Photographed at the TUFT's size, not the card's: `frame` is what the camera
  // is framed to and bakeImpostor adds the margin itself. Building the subject
  // at `ext` would inflate the grass and then frame a margin around the
  // inflation, so the card would draw a tuft 12% too wide.
  const subject = buildGrassTuft(
    frame.width,
    frame.height,
    LAYER.GRASS_TUFT,
    GRASS_TIERS[0].planes,
    { twist: TUFT_TWIST }
  )
  const baked = bakeImpostor(renderer, subject, texArray, LAYER.IMPOSTOR_GRASS, frame)
  subject.dispose()
  return { layer: LAYER.IMPOSTOR_GRASS, ...baked }
}

/**
 * What the tuft has to be framed to, at a given height. One function so the
 * bake and the geometries cannot disagree about it -- the same split
 * fern-bank.js has, and forced by the same thing: the two halves are built at
 * two different moments and can only agree by construction.
 */
function grassFrame(height) {
  return { width: (GRASS_BASE.width / GRASS_BASE.height) * height, height }
}
