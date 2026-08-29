import THREE from '../three-instance.js'
import { bakeImpostor, impostorCardExtents } from './impostor.js'
import { geometryBytes } from './fern.js' // generic; it lives there for historical reasons
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The grass bank: every blade of grass in the world, built at load.
//
// TWO BANKS FOR TWO JOBS, and v2/render/grass.js' header is where the choice
// between them is argued. buildGrassBank below is the CLUMP -- what a grassy
// POINT gets, three quads crossed on a footprint, on a ladder down to a baked
// billboard. buildGrassStripBank, further down, is the STRIP -- what a grassy
// REGION gets, and the default, because scattering lines of grass covers ground
// at a third of the triangles a carpet of clumps costs.
//
// This is the smallest bank in the project by a wide margin and that is the
// point. A grass tuft is N QUADS STANDING ON A FOOTPRINT, all wearing the same
// greyscale cutout -- there is nothing else to it -- so the whole clump ladder
// is three geometries totalling 12 triangles, and every scrap of variety a
// player sees comes from per-instance yaw, scale and tint. See LAYER.GRASS_TUFT
// in textures.js for why one greyscale slice serves every colour of grass we
// will ever want.
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

/**
 * The world size a tuft's own CARD is drawn at, for a tuft `height` metres tall.
 *
 * THE PICTURE IS SQUARE AND THE CARD IS NOT, and that gap is the whole reason
 * this is a function rather than a constant. Two things narrow it:
 *
 *   - the card is a CHORD of the footprint circle, not a diameter (see
 *     GRASS_BASE), so it is sqrt(3)/2 = 0.87 of the tuft's width at 3 planes;
 *   - render/grass.js scales a tuft's width by the SQUARE ROOT of its height,
 *     on purpose -- "sqrt keeps the short ones squat and lets the tall ones be
 *     tall and comparatively narrow, which is what long grass looks like".
 *
 * Together they draw the square cutout at width/height = 0.64 at the bed's mean
 * height and 0.52 at its tallest, and that -- not the square photo -- is the
 * shape of the grass a player has been looking at. Anything else that draws the
 * same cutout has to match it or the grass reads as stretched sideways; the
 * strip did not, and looked 1.5-2x too wide until STRIP_TILE_ASPECT below.
 */
export function grassCardSize(height) {
  return {
    width: GRASS_BASE.width * (Math.sqrt(3) / 2) * Math.sqrt(height / GRASS_BASE.height),
    height,
  }
}

/** width/height of the drawn card, which is what an unstretched tile has to be. */
export function grassCardAspect(height) {
  return grassCardSize(height).width / height
}

// The tuft bed's own height range -- HEIGHT in v2/render/grass.js. Repeated here
// because the dependency only runs one way (render/grass.js imports this file,
// never the reverse), and gated against the real one in check-grass.mjs so the
// copy cannot go stale silently.
export const GRASS_HEIGHT_REF = [0.5, 1.5]

/**
 * The AVERAGE card the tuft bed draws, which is the clump any other grass system
 * has to match if the two are to look like the same meadow.
 *
 * Averaged properly rather than evaluated at the mean height, because the width
 * law is a square root and E[sqrt(h)] is not sqrt(E[h]) -- close here (1% at
 * this range) but wrong in principle, and this is the number two other files
 * size themselves from.
 *
 *   E[sqrt(h)] over h uniform on [lo, hi] = (2/3)(hi^1.5 - lo^1.5)/(hi - lo)
 */
export function grassCardMean([lo, hi] = GRASS_HEIGHT_REF) {
  const eSqrt = (2 / 3) * (hi ** 1.5 - lo ** 1.5) / (hi - lo)
  return {
    width: (GRASS_BASE.width * (Math.sqrt(3) / 2) / Math.sqrt(GRASS_BASE.height)) * eSqrt,
    height: (lo + hi) / 2,
  }
}

/** 0.635 m wide by 1.0 m tall. What one clump of grass IS in this world. */
export const GRASS_CLUMP = grassCardMean()

// Cards per tier, finest first: the crossed clump, then the billboard, and
// nothing in between. ONE plane is only legal because the vertex shader turns
// it (see billboardVertex in material.js) -- a fixed single quad seen along its
// own plane covers no pixels at all.
//
// THE MIDDLE 2-PLANE TIER IS GONE, and dropping it is a saving on both axes at
// once. Two quads at a random azimuth show, on average, 2 * (2/pi) = 1.27 quads
// of facing area for 4 triangles; a billboard shows a full one for 2. So the
// swap is half the triangles AND about a fifth less rasterised area, over the
// 8-to-20 m ring, which is a large slice of the bed. Fill is what a mobile GPU
// runs out of first, so that second number is the one that matters.
//
// It is a saving on LOOKS too, which is the part that is easy to disbelieve. A
// randomly-yawed card goes edge-on to the player some of the time and is
// invisible when it does; a billboard never does. A ring of billboards reads as
// denser than the same ring of crossed cards while drawing fewer of them.
//
// There is no coarser mesh below the billboard. A tuft is already 6 triangles at
// its finest; the ladder spans 6 -> 2, and the only thing left to cut after that
// is the instance itself, which is what the graded thinning in render/grass.js
// does instead.
export const GRASS_TIERS = [
  { name: 'LOD0', planes: 3 },
  { name: 'LOD1', planes: 1, billboard: true },
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

// THE CARDS DO NOT SPLAY, and this was tried and reverted rather than never
// considered. Leaning them outward from a gathered base -- top ring at width/2,
// base ring pulled in to width/2 - height*tan(20 deg) -- was an attempt to break
// up the Triforce silhouette the straight prism has at three planes. It made the
// bed visibly worse and the reason is the UV.
//
// uvProj is an explicit 0..1 across the quad, so gathering the two bottom
// corners does not shear the cutout, it COMPRESSES it horizontally, and by a
// factor that grows toward the root (0.27x at 20 deg). The texture is not one
// blade, it is a whole tuft of them, so squeezing it squeezes the blades and the
// gaps between them together: every blade reads thin and elongated, like the
// tuft was scaled up in y and down in x. On top of that the trapezoid carries
// only 0.64x the area of the rectangle, so the bed thins out at the same time it
// distorts.
//
// The mechanism that WOULD fix the distortion already exists, in STRIP_VERTEX's
// flare (material.js): widen the quad and displace the texture coordinate by the
// same amount the vertex moved, so a texel stays a fixed number of metres wide at
// every height. Run backwards for a gather it does not compress the cutout -- it
// CROPS it, so the root loses blades instead of pinching them. That is a better
// artefact but it is still a worse tuft, and it does nothing about the lost area.
// Not worth it for a silhouette that per-instance yaw already scatters.

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
 * @param {number} width  the tuft's footprint DIAMETER -- the circle the cards
 *   inscribe, and its bounding circle
 * @param {number} twist  radians the top edge is turned from the base edge
 */
function buildGrassTuft(width, height, layer, planes, { twist = 0 } = {}) {
  const n = Math.max(1, Math.round(planes))
  const r = width / 2

  // The card edges, as pairs of xz points on the footprint circle. The polygon
  // is phased so that one edge is square-on to +z, which is the azimuth
  // bakeGrassImpostor photographs from -- that is the tuft's widest profile, so
  // the card gets the fullest silhouette on offer rather than a vertex-on one.
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
    // The top edge is the edge as given, turned about the tuft's axis. A
    // rotation, so it stays exactly the width the polygon was built at and the
    // tuft's bounding circle is untouched -- which is what keeps the bake
    // framing correct at any twist.
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

// ---------------------------------------------------------------------------
// THE STRIP: HOW A REGION IS GRASSED, and it buys the same meadow for a third
// of the triangles. This is the default -- `style: 'strips'` in
// v2/render/grass.js, which is where the two strategies are laid out. The clump
// ladder above is untouched and is what a grassy POINT gets, because a strip is
// a LINE of grass and cannot be one plant standing in one place.
//
// A strip is ONE FLAT RECTANGLE, several metres wide and about a tuft tall,
// whose u runs 0..tiles so the atlas' repeat wrap draws the same cutout that
// many times across it. Scatter a thin layer of them at random yaw and the
// aggregate is a bed of grass; the per-tile mask, mirror, slide and shrink in
// material.js' STRIP_SAMPLE are what stop it reading as a row of identical
// clumps.
//
// THE ARITHMETIC IT LIVES OR DIES BY, because "fewer triangles" is only true
// against the right baseline. Grass' bill is 70% its BILLBOARD tier -- already
// two triangles a tuft -- and that card spins to face the camera, so it always
// presents its full 0.83 m width at the mean instance height. A fixed strip at
// random yaw presents E|sin t| = 2/pi = 0.64 of its width. Facing area per
// triangle is therefore:
//
//   billboard tuft         2 tri   0.83 x 1.06 = 0.88 m2   0.44 m2/tri
//   strip, 3.0 x 1.33 m    2 tri   0.64 x 2.96 x 1.33 x
//                                  0.63 drawn   = 1.60 m2  0.80 m2/tri
//
// so a strip at the size the bed actually uses is worth about 1.8x. It has been
// as high as 3.1 and as low as 1.4 across the resizings, because a strip's area
// per triangle goes as the SQUARE of its height and nothing else here moves that
// far; the live numbers are printed by check-grass.mjs rather than kept here.
//
// AND THAT IS THE FAR-FIELD COMPARISON ONLY. Inside 8 m the tuft bed is running
// its 3-plane LOD0 and putting 3.7 m2 of card over every square metre of ground;
// the strip bed, which has no ladder to climb, puts 2.6. That ratio -- 0.71x
// where the player is standing, against 1.6x out past 20 m -- is what "it looks
// sparser" was, and it is measured per distance ring in check-grass.mjs. NO
// AMOUNT OF DENSITY CLOSES IT: a near tuft is three cards at 60 degrees that
// never all go edge-on, a strip clump is one card at a fixed yaw, and the gap is
// in the geometry rather than the count. The eventual shape of this is probably
// strips FAR and tufts NEAR, or a crossed pair up close; the everywhere version
// is what is built here, because it is the one you can look at and judge.
//
// IT MUST STAY AT TWO TRIANGLES, and that is the whole design constraint. The
// obvious fix for a flat card on lumpy ground is to segment it and drop each
// interior vertex onto the terrain -- but six segments is twelve triangles and
// 0.23 m2/tri, WORSE than the billboard it is replacing. So the strip is one
// quad and follows the ground by TILTING: render/grass.js samples the height at
// its two ends and rolls it about its own long axis, which is exact on planar
// slope and only wrong over a rise, where the middle sinks rather than floats.
// Sinking is the forgiving direction -- the foot of the picture is frayed (see
// GRASS_FRAY in textures.js) so grass entering the ground reads as grass.
// ---------------------------------------------------------------------------

// How wide a tile is drawn, per unit of its height: the AVERAGE TUFT CARD's own
// aspect, so that a strip's clump and a tuft's clump are the same piece of
// grass. STRIP_HEIGHT in render/grass.js sizes the other axis to match, and
// check-grass.mjs gates the pair of them against GRASS_CLUMP rather than trusting
// either file to have been updated with the other.
//
// THIS WAS 1 AND THAT WAS THE STRETCH BUG. A square tile is the obvious answer
// -- the cutout is a square photograph -- but the tuft bed never drew that photo
// square (see grassCardSize), so switching to strips widened every clump by
// 1/0.64 = 1.56x against what the player was used to, and by nearly 2x against
// the tall tufts.
export const STRIP_TILE_ASPECT = GRASS_CLUMP.width / GRASS_CLUMP.height

// The strip's REFERENCE proportions, and how many copies of the cutout those
// proportions bake into `uvProj.x`.
//
// `height` IS DERIVED AND MUST STAY DERIVED. Setting it to 1/aspect is what
// makes the baked u span come out equal to `width`, and two things downstream
// rely on that identity:
//
//   - render/grass.js' sx keeps its simple form (a whole number of tiles), and
//   - the flare in material.js can compensate its own stretch using nothing but
//     `position.x`, because uvProj.x is then exactly position.x + width/2.
//
// Both are gated in check-grass.mjs. Type a height here and the second one
// fails silently as a shear across the top of every flared card.
//
// IT IS NOT THE LENGTH OF A STRIP. The fragment stage rescales `uvProj.x` by the
// instance's own x/y scale ratio (see the strip block in material.js), so the
// number of clumps a strip actually draws is whatever length render/grass.js
// gave it -- STRIP_TILES there, currently 3 to 6 -- and nothing here caps it.
// What this geometry fixes is only the PROPORTION at which a tile comes out
// unstretched, which is the one thing the shader cannot work out for itself.
export const STRIP_BASE = { width: 4, height: 1 / STRIP_TILE_ASPECT }

/** Copies of the cutout across a strip of the given proportions. */
export function stripTiles({ width, height } = STRIP_BASE) {
  return Math.max(1, Math.round(width / (height * STRIP_TILE_ASPECT)))
}

/**
 * A grass strip: `planes` flat quads seated at y = 0, u running 0..tiles.
 *
 * NO TWIST, unlike the tuft. The twist there turns a prism so the eye cannot
 * find three verticals; a strip has no prism to turn, and warping the top edge
 * of a 4 m quad shears the picture across a metre of grass instead of sliding
 * it, because the shear is spread over the whole card rather than over one
 * card's width. The strip gets its lean from the per-tile shrink instead, which
 * is in the fragment stage and therefore free of geometry.
 *
 * VERTICAL NORMALS, for exactly the reasons buildGrassTuft gives: the aggregate
 * surface of a grass bed IS the ground, and a horizontal normal makes the whole
 * carpet go dark when the sun is high.
 *
 * `planes` = 2 crosses a second strip at right angles through the middle. That
 * is the SAME facing area per triangle as two single strips (a crossed pair
 * presents |sin t| + |cos t|, mean 4/pi = 1.27 of W, over 4 triangles; 1.27/4 =
 * 0.32, and a single is 0.64/2 = 0.32) but it never goes edge-on, so the bed
 * does not thin in the directions the yaws happen to line up with. Free
 * insurance against the one failure mode a fixed card has and a billboard does
 * not; the cost is a visible X where the two meet.
 */
function buildGrassStrip(width, height, layer, planes, tiles) {
  const n = Math.max(1, Math.round(planes))
  const positions = []
  const normals = []
  const uvs = []
  const layers = []
  const indices = []

  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI
    const dx = (Math.cos(a) * width) / 2
    const dz = (Math.sin(a) * width) / 2
    const base = positions.length / 3
    // v = 0 at the top, matching the tuft -- STRIP_SAMPLE shrinks about v = 1
    // and would grow the grass downward through the ground if this were flipped.
    const corners = [
      [-dx, 0, -dz, 0, 1],
      [dx, 0, dz, tiles, 1],
      [dx, height, dz, tiles, 0],
      [-dx, height, -dz, 0, 0],
    ]
    for (const [x, y, z, u, v] of corners) {
      positions.push(x, y, z)
      normals.push(0, 1, 0)
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
  geo.userData.strip = { width, height, planes: n, tiles, layer, triangles: n * 2 }
  return geo
}

/**
 * The strip bank, in the same `{ tiers, cardTier, bytes }` shape buildGrassBank
 * returns, so render/grass.js can hold either without knowing which.
 *
 * ONE TIER AND NO LADDER, which is not a simplification so much as the absence
 * of anything to simplify. The tuft's ladder exists to spend more triangles up
 * close, and a strip has none to spend: it is at its floor already. What that
 * costs is the near field, where the strip is a flat wall the player can walk
 * up to and see is flat -- which is the honest reason the eventual answer here
 * is probably a hybrid rather than a swap.
 *
 * NO BILLBOARD TIER EITHER, and it must not have one: a strip that spins to
 * face the camera is a strip whose ends sweep through the hillside, and the
 * whole saving came from NOT spinning (see the arithmetic in the header).
 */
export function buildGrassStripBank({
  width = STRIP_BASE.width,
  height = STRIP_BASE.height,
  planes = 1,
} = {}) {
  const tiles = stripTiles({ width, height })
  const geometry = buildGrassStrip(width, height, LAYER.GRASS_TUFT, planes, tiles)
  return {
    tiers: [{
      name: 'STRIP', planes, billboard: false, layer: LAYER.GRASS_TUFT,
      geometry, triangles: planes * 2,
    }],
    cardLayer: LAYER.GRASS_TUFT,
    cardTier: 0,
    tiles,
    bytes: geometryBytes(geometry),
  }
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
    // photograph of the tuft, so the twist is already in the picture; applying it
    // to the quad the picture hangs on would apply it a second time, and would do
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
