import { buildFern, FERN_DEFAULTS, geometryBytes } from './fern.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The fern variant bank: every fern mesh in the world, baked once at load.
//
// THERE IS NO OFFLINE BAKE STEP AND THERE SHOULD NOT BE. This runs in the
// constructor of whatever owns the batch, hands its geometries to
// BatchedMesh.addGeometry(), and then disposes them -- the GPU arena keeps the
// only copy. Cost is about a millisecond at startup and 121 KB resident, so an
// asset file on disk would buy nothing and cost a build step, a cache to
// invalidate and a way for the mesh to disagree with the generator. Change a
// number here, reload, see it.
//
// The bank is a CROSS PRODUCT, and that is the whole reason it stays small.
// 16 meshes per tier, three tiers, 48 geometries; each fern instance then picks
// a variant, a uniform scale and a yaw. The combinations a player sees are far more
// numerous than the meshes we store, which is the trade every procedural asset
// in this project should make: spend the frame, not the pool.
//
// The CARD is a fourth tier and it deliberately breaks that pattern: two baked
// geometries for all sixteen variants, because past 26 m the cross product has
// collapsed to two silhouettes. It is the bottom half of this file, and it is
// the one thing here that arrives in two pieces -- quads at construction,
// pixels once the frond PNG has landed. See the note above fernCardGeometries.
//
// LOCKED SPEC -- TASKS.md carries the same list and scripts/probe-fern-bank.mjs
// prices it. Change one, change all three in the same commit.
// ---------------------------------------------------------------------------

// Held constant across the bank. These were chosen in the previewer (gen-fern.html)
// against the whole spec, not one variant at a time.
export const FERN_BASE = {
  curve: 1.6,
  pitchFalloff: 0.5,
  lengthVar: 0.5,
  widthScale: 1.2,
  sway: 1.2,
  roll: 0.7,
  yawJitter: 0,
  crownRadius: 0,
  crozier: 0,
}

// The combinatorial axes. 2 x 2 x 2 x 2 = 16.
export const FERN_AXES = {
  fronds: [5, 9],
  pitch: [1.0, 1.4],
  arch: [0.6, 2],
  taper: [0, 0.6],
}

// The scan each frond wears, and its measured aspect from
// public/ferns/fern_fronds.json. The two arrays are parallel and both are
// indexed by frond position within a fern -- a mismatch would texture a card at
// the wrong width, which reads as a stretched frond rather than as an error.
//
// One entry, deliberately: see the note on LAYER.FROND_0 in textures.js for why
// the other two scans are not here. The round-robin machinery stays because it
// costs nothing at length 1 and it is the same mechanism a tree uses to put
// bark on its trunk and leaves on its canopy.
export const FERN_LAYERS = [LAYER.FROND_0]
export const FERN_ASPECTS = [0.3785]

// Segments per frond, coarsest first. Triangles are exactly fronds x segments
// x 2, so this list IS the cost curve: 84 / 56 / 28 average triangles.
//
// 6 / 4 / 2 rather than 8 / 4 / 2. Judged in the previewer: 4 -> 6 segments is
// a large, obvious gain in how smooth a frond's curve reads, and 6 -> 8 is
// close to undetectable while costing another 33%.
export const FERN_TIERS = [
  { name: 'LOD2', segments: 2 },
  { name: 'LOD1', segments: 4 },
  { name: 'LOD0', segments: 6 },
]

// ---------------------------------------------------------------------------
// The card: what a fern is past 26 m.
//
// The three tiers above are RE-GENERATIONS at 6 / 4 / 2 segments, and that
// ladder stops where a frond's arc stops being legible. Past it the fern is a
// green blob, and the cheapest honest green blob is a photograph of the real
// plant rather than a fourth mesh -- DESIGN.md §5 makes that argument for trees
// at length and it lands harder here, because a 2-segment fern is already 28
// triangles and a card is 4.
//
// It is FOUR triangles, not the 2 that §5's bush row originally tabled. One
// quad is a camera-facing billboard, and nothing in a BatchedMesh multi-draw
// turns to face anything -- a fixed single card seen along its own plane is
// gone, not merely flat. Two crossed quads never vanish, and the 45-degree
// worst case they leave is what a card at 20 px can carry: parallax stopped
// mattering long before this range, since §5's `depth x 28.6` rule puts a
// 0.5 m-deep fern's crossover at 14 m and the card does not start until 26.
//
// PLANES IS 2 BY ASSERTION. It is a triangle-for-solidity trade and the place
// to settle it is `gen-fern.html`'s `card` button, which has a `planes` slider
// exactly so 1, 2 and 3 can be walked around before one is locked.
export const FERN_CARD_PLANES = 2

// Which of the two impostor layers a variant's silhouette belongs to. `arch` is
// the cut and textures.js argues why; this is the function that has to agree
// with FERN_AXES, so it reads the axis rather than hardcoding a threshold.
export function fernCardLayer(arch) {
  const [lo, hi] = FERN_AXES.arch
  return arch - lo < hi - arch ? LAYER.IMPOSTOR_FERN_UPRIGHT : LAYER.IMPOSTOR_FERN_ARCHED
}

// What gets photographed for each layer. Not a bank variant: a card that stands
// in for eight variants should be the MIDDLE of them, so `fronds`, `pitch` and
// `taper` are averaged across their axes and only `arch` takes an end value.
// Baking variant 0 instead would make every distant fern the sparsest, most
// upright one in the bank.
function cardSubject(arch) {
  const mid = (a) => (a[0] + a[1]) / 2
  return {
    ...FERN_DEFAULTS,
    ...FERN_BASE,
    fronds: Math.round(mid(FERN_AXES.fronds)),
    pitch: mid(FERN_AXES.pitch),
    taper: mid(FERN_AXES.taper),
    arch,
    // Photographed at the FINEST tier. The bake resolves to 128 px either way,
    // so a coarse subject would only donate its own faceting to the picture.
    segments: FERN_TIERS[FERN_TIERS.length - 1].segments,
  }
}

/**
 * Build the subject for one impostor layer and measure what it has to be framed
 * to. Returns the geometry as well, because the bake wants to photograph the
 * very thing that was measured rather than a second build of it.
 *
 * Width is the DIAMETER of the enclosing cylinder about the axis, not the
 * bounding box's span. `bakeImpostor` centres its frustum on x = 0 and the card
 * crosses its planes on the same axis, so a rosette that happens to throw more
 * frond one way than the other has to be framed by its furthest reach in either
 * -- take the span and the long side walks out of shot.
 *
 * Measured, not assumed: `arch` changes how wide a rosette spreads for a given
 * height by more than a third, and framing to the subject means no texel is
 * spent on empty sky.
 */
function cardFrame(arch, height) {
  const geo = buildFern({
    ...cardSubject(arch),
    height,
    frondLayers: FERN_LAYERS,
    frondAspect: FERN_ASPECTS,
  })
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const reach = Math.max(
    Math.abs(bb.min.x), Math.abs(bb.max.x),
    Math.abs(bb.min.z), Math.abs(bb.max.z)
  )
  return { geo, frame: { width: reach * 2, height: bb.max.y - bb.min.y } }
}

// ---------------------------------------------------------------------------
// The card is made in two halves, at two different moments, and that split is
// forced by the texture array rather than chosen.
//
// The QUADS have to exist when the batch is constructed: a BatchedMesh sizes
// its vertex arena up front from the geometries it is given, so a tier that
// shows up later has nowhere to live. They need no pixels to be built -- a card
// is four vertices and a layer index.
//
// The PIXELS cannot exist that early. The photograph is of the fern wearing
// FROND_0, and FROND_0 is a PNG that arrives some hundreds of milliseconds into
// the session; bake before it lands and the card is a photograph of an
// invisible plant. So the bake runs off the back of loadImageLayers().
//
// In between, the cards draw with an empty layer -- fully transparent, which
// alphaTest discards. That is exactly what every other image layer in this
// project does for its first few frames, and it is why distant ferns fade in
// rather than flashing.
//
// The two halves MUST be given the same `height`, because each measures its own
// framing from a fresh build of the subject. They cannot check each other, so
// they share `cardFrame` and this note instead.
// ---------------------------------------------------------------------------

/**
 * The card geometries, and the map from variant to card. No renderer, no
 * pixels: safe in a constructor and in node.
 *
 * Returns `{ layers, cards, perVariant, bytes }`. `cards[i]` wears `layers[i]`;
 * `perVariant` is one card per entry of `fernVariants()`, in the same order, so
 * it drops straight into a tier table beside the mesh tiers.
 *
 * TWO GEOMETRIES FOR SIXTEEN VARIANTS, and that is not a shortcut -- it is what
 * a shared bake MEANS. Every variant on a layer shows the same picture at the
 * same aspect; what still varies per instance is yaw and scale, which is where
 * variety at this range was always going to come from.
 */
export function fernCardGeometries({
  height = FERN_DEFAULTS.height,
  planes = FERN_CARD_PLANES,
  // ONE PLANE IS ONLY LEGAL IF SOMETHING TURNS IT, which is the note above this
  // function and still holds. `billboard` is that something: it asks for the
  // single quad with a vertical normal that material.js's billboardVertex spins
  // toward the eye. Two flags rather than one because they are independent
  // questions -- v2's carpet passes { planes: 1, billboard: true }, the sparse
  // v1 scatter passes neither, and asking for one plane WITHOUT the billboard
  // is the broken case that vanishes edge-on.
  billboard = false,
} = {}) {
  const layers = FERN_AXES.arch.map(fernCardLayer)
  const cards = FERN_AXES.arch.map((arch, i) => {
    const { geo, frame } = cardFrame(arch, height)
    geo.dispose()
    const ext = impostorCardExtents(frame)
    return buildImpostorCard(ext.width, ext.height, layers[i], planes, { upNormal: billboard })
  })
  return {
    layers,
    cards,
    perVariant: fernVariants().map((v) => cards[layers.indexOf(fernCardLayer(v.arch))]),
    bytes: cards.reduce((n, g) => n + geometryBytes(g), 0),
  }
}

/**
 * Photograph the fern into its two impostor layers, in place.
 *
 * Call ONCE, after `loadImageLayers()` has resolved and with the same `height`
 * `fernCardGeometries` was given. Returns what was written, for logging.
 *
 * Needs the live renderer, so it cannot live in `buildFernBank` -- that runs in
 * a constructor and in node. Same shape as the tree bench: borrow the context
 * for one frame, read the pixels back, dispose everything.
 */
export function bakeFernImpostors(renderer, texArray, { height = FERN_DEFAULTS.height } = {}) {
  return FERN_AXES.arch.map((arch) => {
    const layer = fernCardLayer(arch)
    const { geo, frame } = cardFrame(arch, height)
    const ext = bakeImpostor(renderer, geo, texArray, layer, frame)
    geo.dispose()
    return { layer, ...ext }
  })
}

/** Every axis combination, in a stable order. Index into this is a variant id. */
export function fernVariants() {
  const keys = Object.keys(FERN_AXES)
  const out = []
  const walk = (i, acc) => {
    if (i === keys.length) return out.push({ ...acc })
    for (const v of FERN_AXES[keys[i]]) walk(i + 1, { ...acc, [keys[i]]: v })
  }
  walk(0, {})
  return out
}

/**
 * Bake the whole bank in the shared batch's attribute layout.
 *
 * Returns `{ tiers, variants, bytes }`, where `tiers[t].geometries[v]` is the
 * geometry for tier `t` and variant `v`. Tiers are ordered coarsest-first to
 * match FERN_TIERS, so a distance band maps to an index without a lookup.
 *
 * The caller owns the geometries and MUST dispose them once they are in the
 * batch -- BatchedMesh copies the vertex data into its arena, so holding the
 * originals doubles the cost for nothing.
 */
export function buildFernBank({ seed = 1 } = {}) {
  const variants = fernVariants()
  let bytes = 0

  const tiers = FERN_TIERS.map(({ name, segments }) => ({
    name,
    segments,
    geometries: variants.map((axes, i) => {
      const geo = buildFern({
        ...FERN_DEFAULTS,
        ...FERN_BASE,
        ...axes,
        segments,
        // Same seed per variant across tiers, so a fern's frond placement does
        // not shuffle when it crosses an LOD boundary. Without this the swap
        // reads as the plant twitching rather than as detail arriving.
        seed: seed + i,
        frondLayers: FERN_LAYERS,
        frondAspect: FERN_ASPECTS,
      })
      bytes += geometryBytes(geo)
      return geo
    }),
  }))

  return { tiers, variants, bytes }
}
