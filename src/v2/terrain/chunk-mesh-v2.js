import { clamp01, lerp, smoothstep } from '../../sim/mathx.js'
import { Noise } from '../../sim/noise.js'
import { CHUNK_VERTS, CHUNK_INDICES } from '../config.js'

// ---- THE STIPPLE FRAME, one per vertex, read per FACE.
//
// The plain-stipple terrain rung (terrain-material.js) tiles one stipple
// texture over every triangle, axis-aligned and anchored to the WORLD origin,
// at a tile size that grows with the triangle's distance from the camera AT
// BUILD TIME, so the texel stays a roughly constant size on screen instead of
// mipping out to flat past twenty metres. The frame is baked here as a vec4
// attribute, (tiles per metre, offset u, offset v, plane), and the shader
// reads it as a `flat` varying, so each triangle takes its provoking vertex's
// frame whole: one fetch, no derivatives.
//
// The plane is the DOMINANT AXIS of the geometric normal -- 0 for xz (the
// walkable world), 1 for zy (a wall facing x), 2 for xy (a wall facing z) --
// so a cliff gets the tile laid on its face instead of XZ smeared up it. This
// is the shipping shader's per-fragment axis pick (terrain-material.js AXIS)
// decided once per face at build time; where the pick flips along a contour
// the pattern changes phase, not brightness.
//
// The tile size is QUANTISED to powers of two of STIPPLE_TILE_MIN. Two faces
// with the same size then tile as one continuous sheet (uv = k * world xz for
// both), so the only seams are the rings where the size doubles. Continuous
// sizing would put a seam on every edge instead: uv = k * wxz jumps by
// (k_a - k_b) * wxz between neighbours, and wxz is hundreds of metres.
//
// The offset is frac(k * chunk origin) on the plane's axes: the shader adds
// k * chunk-local position to it, which is k * world position mod 1 without
// ever forming a world coordinate at float precision in the vertex stage.
//
// The size is per VERTEX and not per chunk on purpose: the far edge of an 8 m
// chunk is not the near edge, and a 128 m chunk spans a doubling of distance.
// It is still only as current as the last rebuild -- the ring swap is what
// refreshes it -- so within a ring it drifts up to 2x from ideal. Rough by
// design.
//
// STIPPLE_TILE_PER_M is the tile's size as a fraction of viewing distance: 0.5
// puts one 256-texel tile across ~29 degrees, a texel across ~0.11 degrees,
// about two Quest pixels. STIPPLE_TILE_MIN stops the tile shrinking under the
// feet, where distance goes to eye height.
export const STIPPLE_TILE_PER_M = 0.5
export const STIPPLE_TILE_MIN = 1.5

/** Tiles per metre for ground at this distance: the nearest power-of-two step. */
export function stippleTilesPerM(dist) {
  const step = Math.max(0, Math.round(Math.log2((dist * STIPPLE_TILE_PER_M) / STIPPLE_TILE_MIN)))
  return 1 / (STIPPLE_TILE_MIN * 2 ** step)
}

// ---------------------------------------------------------------------------
// The v2 chunk mesher. Pure math -- no three.js, no worker globals -- so it runs
// under node in scripts/check-v2-field.mjs. It lives under terrain/ rather than
// height/ only because the renderer is its sole caller.
//
// This is v1's src/sim/chunk-mesh.js grown a content-layer branch. Four things
// carried across unchanged in substance, each of which was paid for once and
// should not be rediscovered:
//
//   THE EXTRA SAMPLING RING. Heights are taken one cell outside the chunk on
//   every side so edge normals come from real neighbours. Without it two
//   adjacent chunks compute different normals for the same shared edge and a
//   lighting seam runs along every chunk join, brightest exactly where the sun
//   is lowest -- which in this game is most of the time.
//
//   SKIRTS. Vertical flanges hiding the crack between two LOD levels, with the
//   winding worked out per edge so they face outward; see `edges` below. Far
//   simpler than stitching resolutions and invisible in practice, because a
//   skirt is only ever seen edge-on through the crack it is filling.
//
//   THE SHORTER DIAGONAL. Every quad has to pick a diagonal and picking the same
//   one everywhere is visible: vertex colours interpolate along triangle edges,
//   so a snow-to-rock boundary can only run straight along the chosen diagonal
//   and staircases across it. Connecting the two corners closest in height also
//   happens to be the better surface, because splitting a saddle the wrong way
//   invents a ridge that is not in the field.
//
//   THE FIXED-WORLD-SCALE CLASSIFICATION SLOPE. See CLASS_EPS. This is the fix
//   for "coarsening a chunk REPAINTED it and the world flashed white in
//   chunk-shaped squares", and v2 needs it more than v1 did, not less.
//
// New in v2, and both are §18 claims rather than conveniences:
//
//   PER-CHUNK LAYER CULLING. One `layers.overlaps` call decides whether this
//   chunk's 361 samples walk the carve chain or skip it entirely.
//
//   A PER-CHUNK BAND LIMIT. `cell = size / res` goes into every field query,
//   including the ring's, so the octaves a chunk's triangles cannot resolve fade
//   out instead of aliasing.
//
// And one term that is neither of those and is OFF unless a knob is up: THE
// CREST BIAS, which lets a coarse chunk lean toward its local maximum so a
// distant ridge keeps its edge. See CREST_CELL_LO -- it is the only thing in
// this file that deliberately draws the ground somewhere other than where she
// collides with it, and the only reason that is allowed is that it fades to
// nothing before the cell gets fine enough for her to stand on.
// ---------------------------------------------------------------------------

// v1's palette, unchanged, and the values are LINEAR. The first pass had them
// far too high -- linear 0.33 is sRGB 0.60, which under a 2.1-intensity sun came
// out a pale mint green. Dark gritty ground lives near linear 0.05.
//
// Grass is deliberately green-dominant: terrain-material.js classifies "is this
// ground vegetated" off exactly that, so do not neutralise it.
const C_GRASS = [0.048, 0.088, 0.03]
const C_SCRUB = [0.075, 0.07, 0.042]
const C_ROCK = [0.085, 0.082, 0.078]
const C_SNOW = [0.86, 0.88, 0.93]

// New in v2. Packed earth, for ground a road or a carved lake bed has flattened.
// Warmer and lighter than C_SCRUB and much less saturated than C_GRASS, so a
// road reads as a line of bare ground through vegetation rather than as
// suspiciously smooth grass -- which is what flattening alone looks like, and
// was the first thing anyone noticed about an early road.
const C_DIRT = [0.070, 0.058, 0.041]

// How far toward C_DIRT fully-flattened ground goes. Not 1.0: a road surface
// that ignores altitude entirely reads as a decal pasted over the terrain, and
// keeping 15% of the underlying colour lets a road high on a mountain stay
// visibly paler than the same road in a valley.
const DIRT_MAX = 0.85

// THE ALTITUDE RAMP IS NOT IN THIS FILE, and that is the point.
//
// v1 hardcodes clamp01((h - 107) / 100), tuned against v1's own relief, and its
// own comment records that a band written for the previous relief silently puts
// snow nowhere at all and that this has already happened twice. The failure mode
// is not a crash: the world renders, nothing looks broken, the mountains are
// simply the wrong colour and nobody can say why.
//
// §18's premise is that the coarse shape is an IMPORT and a human replaces it.
// During this build alone the world went 16 km at 16 m texels, to 4 km at 4 m,
// to 8 km at 8 m, with the vertical range still being surveyed off the source
// jpg -- an 8-bit image, which carries no metres at all, so its min and max are
// CHOSEN at bake time. Any literal here would be a number describing a world
// that is no longer being rendered, and it would look plausible while being
// wrong.
//
// So `altLo` and `altSpan` arrive from V2Height.bands, measured off whatever
// image is loaded (p25 and p90 of its texels). When the vertical range lands the
// shading follows it with no second edit pass, and check-v2-field asserts the
// RELATIONSHIPS -- ramp monotone, anchors inside the relief, snow line above the
// ramp's foot -- rather than any value.

// Half-width of the stencil the SURFACE CLASSIFICATION measures slope over, in
// metres, and the reason it is a fixed world distance rather than the chunk's
// own cell.
//
// shade() decides rock-vs-grass and, far more visibly, snow-vs-no-snow off
// steepness. The mesh normal is a central difference over the chunk's OWN cell,
// and in v2 that ranges from 50 cm at a leaf to 512 m at the root -- a factor
// of 1024. An alpine face standing at 74 deg over a metre averages to 24 deg
// over 128 m, so the identical ground classified itself as bare rock up close
// and as solid snow from far away, and since chunks coarsen one at a time as you
// fly away the world flashed white in chunk-shaped squares. Measuring over a
// fixed world distance instead makes the colour a function of position alone.
//
// 1.0 m, which is half of LOCOMOTION.stride's 1.5 m -- so the steepness the
// shader paints and the steepness the slope limiter refuses are measured at
// nearly the same scale, and ground drawn as rock is ground she cannot climb.
// The two ramps are one decision: LOCOMOTION.maxSlopeDeg 50 was DERIVED from
// shade()'s smoothstep(0.86, 0.62, ny) below. Moving either moves both.
//
// v1 SKIPS this stencil whenever `step <= CLASS_EPS`, on the grounds that for a
// leaf the mesh normal already IS the fixed-scale slope. That argument holds
// only where step EQUALS CLASS_EPS, which in v1 was true of the leaf by
// construction. It is false in v2: below a metre the field still has real
// energy -- that is what detail.js is for -- so a 50 cm central difference
// reports a systematically steeper slope than a 1 m one, and taking the skip
// would reintroduce the very repaint it was written to fix, running the other
// way (fine chunks too dark rather than coarse chunks too white). So the skip
// here is an EQUALITY, and it costs four extra field evaluations per vertex at
// every other depth. Those four are cheap: they are taken at cell = CLASS_EPS,
// which fades out every octave below 4 m, so a classification sample runs about
// eight simplex octaves against the geometry sample's twelve.
const CLASS_EPS = 1.0

// The chunk's own AABB has to be grown before asking the layers whether anything
// touches it, and the amount is set by THIS FILE's stencils, not by the layers':
// every layer already pads its own index entries by its own reach (a path's
// swept box by halfWidth + feather, a snow point by its radius, a lake by its
// box, outside which the footprint is exactly zero). What the layers cannot know
// about is that the mesher reads one cell outside the chunk for the normal ring
// and another CLASS_EPS outside that for the classification slope.
//
// A THIRD STENCIL EXISTS WHEN `crest` IS UP and it is NOT in this number, because
// it scales with the cell rather than sitting at a fixed world distance -- see
// CREST_CELL_LO and the call site, which adds it separately.
const cullMargin = (step) => step + CLASS_EPS

// THE CREST BIAS: the band of CELL SIZES, in metres, over which a chunk is
// allowed to bias its samples toward the local maximum. Cell sizes and not
// ranges, because what loses a ridge is the spacing between samples, not the
// distance the ridge is drawn at.
//
// A chunk POINT-SAMPLES the field on a grid, so a crest that happens to fall
// between two samples is not in the mesh at all: the quad cuts the corner and
// the skyline sags below the terrain. The error runs the wrong way with
// distance -- the coarser the cell the likelier a crest lands between samples,
// and the coarse cells are the far ones, which are exactly the ones drawing the
// horizon. The per-chunk band limit does not help here and cannot: it fades the
// octaves the triangles cannot resolve, which is the right answer for aliasing,
// but a ridge line is in the coarse IMPORT as well, and low-passing a maximum
// does not put it back onto a vertex.
//
// LO IS 1 m BECAUSE A FINE CELL IS THE SURFACE SHE COLLIDES WITH. field.js's
// banner is explicit that a chunk is a low-pass image of the cell = 0 field, and
// that this is the reason she never falls through a coarse chunk; Detail.at
// gives every octave weight exactly 1 at cell = 0 for the same reason.
// smoothstep(1, 6, step) is 0 for every step at or under a metre, so a leaf
// chunk is bit-identical to what it was before this term existed. Lift the
// finest chunks off the collision field instead and she is drawn ankle-deep in
// every ridge she is standing on.
//
// AND IT FADES RATHER THAN SWITCHING, for the same reason the band limit fades:
// a term that appeared all at once at an LOD boundary would pop as the chunk
// under it re-split, and a pop on a skyline is more visible than the sag this
// is fixing.
//
// HI IS 6 m, so full weight starts at the 8 m cell. The split rule (refine while
// cell > range * tan(triDeg)) holds an 8 m cell at least 8 / tan(3.0 deg) = 153 m
// from the eye at the editor default, 91 m out in the graded 5.0 deg periphery,
// and the 4 m cell that still carries 65% of the weight no nearer than 76 m.
// That distance is the entire licence for the "only ever raises the mesh"
// property at the sampler below.
const CREST_CELL_LO = 1
const CREST_CELL_HI = 6

// PEAKS: the footprint maximum, the `peaks` relief knob. Every vertex of a
// chunk whose cell is coarser than the texel takes the MAX of the band-limited
// field over the step x step square it owns, sampled at texel pitch, so no
// summit in the import can fall between two samples. The drawn far ground is
// then an upper envelope of the near ground: a peak re-splitting under the eye
// NARROWS but never rises, which is the growth `crest` only damped. Ungated,
// unlike `crest` -- a valley narrower than the cell fills at distance, and that
// is accepted as the skyline's price -- and at full strength at every rung
// rather than faded in, because the thing being removed is a height change at
// each swap and a fade would leave a fraction of it at each. OFF at every cell
// under a texel (the 4 m rung and finer), where the point sample already lands
// within a texel of every summit and where the leaf identity of CLASS_EPS has
// to hold. PEAKS_TAPS_MAX bounds the stencil on the two coarsest rungs: a 512 m
// cell would otherwise be 65 x 65 evaluations per vertex.
const PEAKS_TAPS_MAX = 17

// Vertex colour. v1's construction -- alt ramp, then rock over it by steepness,
// then snow over that -- with the dirt blend appended.
//
// `ny` is the Y component of the CLASSIFICATION normal, not the mesh normal.
// Feeding the mesh normal in here was the bug in the CLASS_EPS banner above.
// ---- MOTTLE: the ground's colour variation, carried by the VERTEX COLOURS the
// mesher already writes rather than by a fragment shader.
//
// WHY IT LIVES HERE. A Quest 2 measures the whole terrain fragment shader at
// 2.7-3.1 ms against a stock Lambert, and the half of that spent drawing surface
// detail inside 55 m buys one grit fetch and its speckle. Baked into vColor the
// same variation is FREE at draw time: it is three floats a vertex on an
// attribute that already exists, computed once when a chunk is meshed, on a
// worker, and interpolated by fixed-function hardware.
//
// WHAT IT CAN AND CANNOT DO. The finest cell in the world is 50 cm (8 m leaf /
// CHUNK_RES 16), so the Nyquist limit on anything vColor can carry is a metre,
// and a chunk two LOD levels out is sampling on 2 m cells. This is
// therefore VARIEGATION AND NOT GRAIN -- a hillside that changes colour across
// itself, not a surface with texture underfoot. MOTTLE_FINE is set so the
// shortest octave stays resolved on the cell sizes actually drawn near the
// camera; shortening it does not buy detail, it buys aliasing.
//
// A PURE FUNCTION OF WORLD POSITION, with no dependence on cell size or depth,
// and that is not a simplification -- it is the same invariant the CLASS_EPS
// banner below is defending. Band-limiting the octaves per chunk would be the
// textbook fix for the undersampling above, and it would make mottle amplitude a
// property of the CHUNK: one step of it along every LOD seam, which is the
// chunk-shaped-squares bug that stencil exists to prevent, in a quieter colour.
// Undersampling a position-only field costs contrast at distance; a chunk-keyed
// amplitude costs a visible grid. The first is the cheaper mistake.
// TWO FIELDS AND NOT ONE, decorrelated by their offsets. Level and hue are
// separate questions about a piece of ground -- a dark patch can be dark because
// it is mossy or because it is wet mud, and locking the two together produces a
// surface that only ever gets lighter and darker, which is what a lit smooth
// surface already does. Independent fields are what make it read as ground made
// of different things.
const MOTTLE = new Noise(0x6d07713)
const MOTTLE_COARSE = 31 // m, the hillside-scale swing
const MOTTLE_FINE = 6.5 // m, the shortest octave -- see the Nyquist note above
const MOTTLE_HUE = 17 // m, the patch scale for what the ground is MADE of
// +/- brightness, as a fraction. GROUND AND SNOW ARE A FACTOR OF TWO APART, and
// the ground figure is set where it is because with the plain rung shipping this
// and the bump normals are the ONLY near-field texture the ground has -- no grit
// fetch, no photograph, nothing else -- so it is turned up until a hollow reads
// as a hollow from standing height. Snow stays where both used to be: it is the
// brightest surface in the world by an order of magnitude, so an equal fraction
// is a far larger step in absolute terms, and at the ground's setting a snowfield
// reads as dirty rather than as relieved. Same trade as BUMP_SNOW.
const MOTTLE_VALUE = 0.26
const MOTTLE_VALUE_SNOW = 0.13
const MOTTLE_TINT = 0.30 // how far the hue swing pulls the palette
const MOTTLE_EARTH = 0.62 // how far a bare-earth patch pulls it, at the dry tail

// The mottle palettes: what each surface varies BETWEEN. Level lives in
// MOTTLE_VALUE; these are only about hue.
//
// BOTH GRASS TARGETS ARE GREEN-DOMINANT BY CONSTRUCTION, and that is a hard
// constraint rather than a preference. terrain-material.js classifies vegetated
// ground as `smoothstep( 0.004, 0.030, vColor.g - max( vColor.r, vColor.b ) )`,
// and C_GRASS clears that knee by only 0.010. A dry-grass target that reached for
// real ochre would push mottled grass back under the knee and the shader would
// stop treating it as vegetation -- wrong grit layer, no moss, and the change
// would arrive as patches, because the mottle is patchy. So the dry side yellows
// and brightens while keeping g above both other channels: C_STRAW clears the
// knee by 0.034, C_MOSS by 0.052, and a 30% pull toward either leaves grass at
// 0.038 and 0.044. THE LEVEL SWING EATS INTO THAT MARGIN, because it scales all
// three channels together and so scales their difference: measured over low
// shallow ground at MOTTLE_VALUE, the darkest meadow in the world reads 0.89
// vegetated rather than 1.00. Check the arithmetic before moving any of these
// three, and check the number before moving MOTTLE_VALUE -- check-v2-field's
// "the plain rung" section is where it is measured.
//
// The one place the classification does move is SCRUB at altitude, which is not
// green-dominant to start with and reaches 0.23 vegetated on the mossy side. That
// is wanted: a damp high meadow is what it looks like, and it is a ramp rather
// than a switch.
const C_MOSS = [0.030, 0.082, 0.026]
const C_STRAW = [0.058, 0.092, 0.036]

// BARE EARTH, and it is the ONE target that deliberately breaks the dominance
// rule above -- r above g, so the classifier reads a patch of it as unvegetated.
// That is the point rather than a cost: a mud patch in a meadow IS bare ground,
// and having the shader agree is more correct than a brown that still grows
// moss. It is kept off the smooth moss/straw ramp and driven by its own
// smoothstep on the dry tail of the hue field so it arrives as PATCHES with
// grass between them; a third target lerped continuously would just desaturate
// the whole meadow toward mud. Steep ground and snow take none of it.
const C_EARTH = [0.078, 0.053, 0.031]

// Rock has no such constraint -- it is the classifier's fallback -- but it must
// not become green-dominant either, or a cliff grows moss the shader believes in.
// Both of these keep g below max(r, b).
const C_ROCK_WARM = [0.098, 0.086, 0.068]
const C_ROCK_COOL = [0.070, 0.074, 0.082]

// ---- BUMP: the same trick as the mottle, applied to the vertex NORMALS.
//
// WHY THIS AND NOT A NORMAL MAP. The near block's one grit fetch is the single
// most expensive thing in the terrain shader -- of the 1.33 ms between the full
// near field and none of it, the arithmetic accounts for about 0.3 and the rest
// is that one textureGrad. Any shader-side normal map, however cheap its
// arithmetic, pays that. Perturbing the normals the mesher is already writing
// costs nothing at draw time at all.
//
// TWO OCTAVES, and the fine one is set against the cell it will actually be
// sampled on. Measured over 96 eye poses at the XR route's 5.72 deg, the leaf's
// 50 cm band covers ground to a median 19.4 m ahead, so BUMP_FINE at 1.7 m gets
// 3.4 samples across a wavelength everywhere inside that. It degrades past the
// 1 m cell beyond it, where the fine octave falls under Nyquist -- the same trade
// MOTTLE_FINE makes and it is accepted for the same reason: the coarse octave
// still carries the surface out there, and band-limiting per chunk would key
// the amplitude to the CHUNK, which puts a lighting step along every LOD seam.
//
// ROCK IS BUMPIEST, SNOW LEAST. Rock and grass are what the eye is on and
// nothing else draws them, so they carry the full slope. Snow sits below both:
// it is the brightest surface in the world, so the same dy/dx reads as far more
// contrast there than it does on ground at a twentieth the albedo.
//
// The same position-only rule as the mottle, for the same reason. This is a
// SHADING perturbation only -- the mesh, the collision field and the
// classification normal nyClass are all untouched, so the ground she walks on is
// still the ground that was meshed.
const BUMP_SCALE = 3.4 // m, the form scale -- boulder-and-hollow
const BUMP_FINE = 1.7 // m, the grain scale -- see the Nyquist note above
const BUMP_FINE_MIX = 0.45 // share of the slope the fine octave carries
const BUMP_ROCK = 0.48 // slope added on rock, as dy/dx
const BUMP_GRASS = 0.15
const BUMP_SNOW = 0.12

function shade(h, ny, snowLine, snowBand, flatten01, altLo, altSpan, wx, wz, out, o) {
  const steep = smoothstep(0.86, 0.62, ny)
  const alt = clamp01((h - altLo) / altSpan)

  let r = lerp(C_GRASS[0], C_SCRUB[0], alt)
  let g = lerp(C_GRASS[1], C_SCRUB[1], alt)
  let b = lerp(C_GRASS[2], C_SCRUB[2], alt)

  // Snow accumulates with altitude but slides off near-vertical faces. Without
  // that term the cliffs read as white walls and all the relief goes invisible.
  // The soft band is what makes it a snow LINE rather than a contour: the same
  // peak is white in the high country and bare in the low.
  //
  // THE BAND IS CENTRED ON THE LINE, not stacked above it. It used to run from
  // snowLine to snowLine + snowBand, which put bare ground AT the elevation the
  // author had just set and the visible edge half a band higher -- 35 m up, as
  // shipped. That is not a rounding error to an author: every snow point placed
  // by clicking the mountain had to be dragged down by roughly that much
  // afterwards, every time, because the click sets the elevation and the eye
  // judges the result by where the white starts. Centred, `snow.base + delta` IS
  // the half-cover contour, so the place you click is the place the snow appears.
  const snow = clamp01(smoothstep(snowLine - snowBand / 2, snowLine + snowBand / 2, h) * (1 - steep * 0.85))
  r = lerp(r, C_ROCK[0], steep)
  g = lerp(g, C_ROCK[1], steep)
  b = lerp(b, C_ROCK[2], steep)
  r = lerp(r, C_SNOW[0], snow)
  g = lerp(g, C_SNOW[1], snow)
  b = lerp(b, C_SNOW[2], snow)

  // The mottle, before the road so a cleared surface stays an even one.
  //
  // TWO OCTAVES AND NOT AN FBM. fbm's gain stacks its short octaves at low
  // amplitude under a dominant long one, which at this scale spends most of the
  // signal below the cell size -- exactly the half that cannot be represented.
  // Two named wavelengths at a stated ratio put the energy where the mesh can
  // actually carry it.
  const m = 0.6 * MOTTLE.simplex2(wx / MOTTLE_COARSE, wz / MOTTLE_COARSE)
    + 0.4 * MOTTLE.simplex2(wx / MOTTLE_FINE + 91.7, wz / MOTTLE_FINE - 43.1)

  const hue = MOTTLE.simplex2(wx / MOTTLE_HUE - 218.3, wz / MOTTLE_HUE + 164.9)

  // The hue swing, per surface, weighted by how much of this vertex each surface
  // is -- so grass varies between moss and straw while the cliff above it varies
  // between warm and cool stone, off the same field and with no seam where they
  // meet. Snow takes none of it: at 0.86 linear against palette entries near
  // 0.07, any hue pull reads as dirt on the brightest thing in the world. It
  // keeps the level swing below at MOTTLE_VALUE_SNOW, which is what gives snow a
  // readable surface without turning it grey.
  const ha = Math.abs(hue) * MOTTLE_TINT * (1 - snow)
  const grassT = hue > 0 ? C_MOSS : C_STRAW
  const rockT = hue > 0 ? C_ROCK_WARM : C_ROCK_COOL
  const grassA = ha * (1 - steep)
  const rockA = ha * steep
  r = lerp(lerp(r, grassT[0], grassA), rockT[0], rockA)
  g = lerp(lerp(g, grassT[1], grassA), rockT[1], rockA)
  b = lerp(lerp(b, grassT[2], grassA), rockT[2], rockA)

  // The bare-earth patches, on the dry tail of the same hue field. The knee is
  // what makes them PATCHES rather than a wash: it puts a visible pull on 9% of
  // flat ground and reaches the full 0.62 only at their cores, so the rest of
  // the dry side stays straw. See C_EARTH for why this one is allowed to take
  // grass out of the vegetated class -- measured, it takes 4.5% of the meadow
  // under half-vegetated and leaves the mean at 0.95.
  const earthA = smoothstep(0.42, 1.0, -hue) * MOTTLE_EARTH * (1 - steep) * (1 - snow)
  r = lerp(r, C_EARTH[0], earthA)
  g = lerp(g, C_EARTH[1], earthA)
  b = lerp(b, C_EARTH[2], earthA)

  const v = 1 + m * lerp(MOTTLE_VALUE, MOTTLE_VALUE_SNOW, snow)
  r *= v
  g *= v
  b *= v

  // LAST, after snow: a road above the snow line is a road that has been
  // cleared, and a road that disappears under the snow layer is a road the
  // player cannot follow to the pass it was drawn to reach.
  if (flatten01 > 0) {
    const t = flatten01 * DIRT_MAX
    r = lerp(r, C_DIRT[0], t)
    g = lerp(g, C_DIRT[1], t)
    b = lerp(b, C_DIRT[2], t)
  }

  out[o] = r
  out[o + 1] = g
  out[o + 2] = b
}

/**
 * @param {V2Height} field
 * @param {Layers} layers
 * @param {{ox:number, oz:number, size:number, res:number, cam:{x:number,y:number,z:number}}} spec
 *   `cam` is where the camera stood when this build was asked for -- see the
 *   STIPPLE FRAME block for what it fixes and how stale it is allowed to be.
 * @returns {{positions:Float32Array, normals:Float32Array, colors:Float32Array, stipple:Float32Array, indices:Uint16Array, minY:number, maxY:number, skirtDepth:number, culled:boolean}}
 */
export function buildChunkV2(field, layers, { ox, oz, size, res, cam }) {
  if (!cam || !Number.isFinite(cam.x) || !Number.isFinite(cam.y) || !Number.isFinite(cam.z)) {
    throw new Error(`buildChunkV2: spec.cam must be a finite {x, y, z}, got ${JSON.stringify(cam)}`)
  }
  const step = size / res
  const vpr = res + 1
  const innerCount = vpr * vpr
  const total = innerCount + 4 * vpr
  const triCount = res * res * 2 + 4 * res * 2

  // terrain-v2.js pre-allocates one fixed-size BatchedMesh slot per chunk from
  // CHUNK_VERTS / CHUNK_INDICES and recycles a freed slot for whatever arrives
  // next, so a chunk of a different size is not a smaller chunk -- it is memory
  // corruption in the shape of terrain. Throw here, at the one place that knows
  // both numbers.
  if (total !== CHUNK_VERTS) throw new Error(`buildChunkV2: res ${res} yields ${total} vertices, config CHUNK_VERTS is ${CHUNK_VERTS}`)
  if (triCount * 3 !== CHUNK_INDICES) throw new Error(`buildChunkV2: res ${res} yields ${triCount * 3} indices, config CHUNK_INDICES is ${CHUNK_INDICES}`)

  // How hard this chunk leans on its local maximum, decided by its cell alone --
  // see CREST_CELL_LO. Computed up here, above the cull, because the crest
  // stencil is one of the stencils the grown AABB has to cover.
  const crestW = field.relief.crest * smoothstep(CREST_CELL_LO, CREST_CELL_HI, step)
  const crestR = step * 0.35
  // Half a cell each way, when the footprint max is on -- see PEAKS_TAPS_MAX.
  const texel = field.ground.texelSize
  const peaksOn = field.relief.peaks > 0 && step * 2 > texel
  const peaksR = peaksOn ? step / 2 : 0

  // THE PER-CHUNK CULL. One index query decides for all 361 samples.
  //
  // The margin covers this file's own stencils; the layers pad their own reach.
  // Conservative in the right direction: over-reporting costs one chunk a
  // pointless carve pass, under-reporting leaves a river half-carved with a hard
  // edge at the chunk boundary.
  //
  // The crest term is added rather than being folded into cullMargin because it
  // is the one stencil that scales with the cell, and past a 2.9 m cell it
  // reaches further out than cullMargin's fixed CLASS_EPS does. Under-report
  // there and a chunk whose crest corners land in a river its neighbour carved
  // would take an UNCARVED maximum from that ground while the neighbour takes a
  // carved one, and the two would disagree about the height of a shared edge
  // vertex -- a crack, at exactly the coarse LOD where the crest term is loudest.
  // The peaks footprint reaches further than either, for the same reason.
  const m = cullMargin(step) + Math.max(crestW > 0 ? crestR : 0, peaksR)
  const touched = layers.overlaps(ox - m, oz - m, ox + size + m, oz + size + m)

  // Selected ONCE per chunk, not per vertex. The culled path never enters
  // Layers at all -- not flattenAt, not carve, not one Map lookup.
  const heightAtCell = touched
    ? (x, z) => field.heightAt(x, z, step)
    : (x, z) => field.baseAt(x, z, step)
  const heightAtClass = touched
    ? (x, z) => field.heightAt(x, z, CLASS_EPS)
    : (x, z) => field.baseAt(x, z, CLASS_EPS)

  // THE CREST SAMPLER, selected here for exactly the reason heightAtCell is:
  // five field evaluations per sample instead of one is affordable on a coarse
  // chunk -- the band limit's early-out leaves it few octaves, so the marginal
  // cost is mostly the bicubic import taps -- and is not affordable as a branch
  // inside a loop that also runs 361 times at the leaf. With `crest` at 0, which
  // is the shipped default, this IS heightAtCell and none of the below exists.
  //
  // GATED ON CONVEXITY, and that is not a refinement, it is what stops the term
  // doing the opposite of its job. A max filter over concave ground FILLS
  // HOLLOWS: applied everywhere it would close the valleys up with distance,
  // which is a worse artifact than the sagging skyline it was cut in to fix.
  // exposureAt is near 0 in a hollow and near 1 on a rib, so the term cancels
  // itself where it would hurt and reaches full strength only where a crest can
  // actually exist. It returns a flat 0.5 when no knob asked for the grid, but
  // `crest` is in reliefNeeds' exposure list, so a nonzero crestW means a real
  // grid is baked.
  //
  // IT ONLY EVER RAISES THE MESH -- `mx` is a max that includes h0, so the bias
  // is non-negative -- and that DOES mean a coarse chunk sits ABOVE the cell = 0
  // field she collides with by up to crestW * (mx - h0). Measured on one
  // mountain chunk at crest 1: mean 0.64 m and worst 2.02 m at an 8 m cell,
  // mean 2.71 m and worst 10.50 m at 32 m, and exactly 0.000 at 1 m and below.
  // That is a deliberate and bounded violation of the "every LOD is a low-pass
  // image of the same surface" property field.js's banner states. It is accepted
  // because the split rule puts a cell that coarse 150 m away and she is never
  // standing on one, and it is refused where she IS standing by CREST_CELL_LO.
  //
  // THE PEAKS SAMPLER SUPERSEDES IT when both are up: a max over the whole
  // footprint contains crest's four diagonal taps, so the bias would add
  // nothing but its own cost.
  const peaksN = peaksOn ? Math.min(PEAKS_TAPS_MAX, Math.ceil(step / texel) + 1) : 0
  const peaksPitch = peaksOn ? step / (peaksN - 1) : 0
  const sampleHeight = peaksOn
    ? (x, z) => {
        let h = heightAtCell(x, z)
        for (let b = 0; b < peaksN; b++) {
          const zz = z - peaksR + b * peaksPitch
          for (let a = 0; a < peaksN; a++) {
            const v = heightAtCell(x - peaksR + a * peaksPitch, zz)
            if (v > h) h = v
          }
        }
        return h
      }
    : crestW > 0
    ? (x, z) => {
        const h0 = heightAtCell(x, z)
        // The diagonals rather than the axes, at 0.35 of a cell rather than a
        // half: this has to stay INSIDE the quads this vertex owns. A stencil
        // reaching a full cell out would hand the same summit to the vertices
        // on both sides of a ridge and draw it as a plateau, which trades one
        // wrong skyline for another.
        const mx = Math.max(
          h0,
          heightAtCell(x - crestR, z - crestR),
          heightAtCell(x + crestR, z - crestR),
          heightAtCell(x - crestR, z + crestR),
          heightAtCell(x + crestR, z + crestR),
        )
        return h0 + crestW * field.exposureAt(x, z) * (mx - h0)
      }
    : heightAtCell

  // One extra ring on every side, sampled at THE SAME cell as the interior. Two
  // different band limits either side of a chunk edge would put back exactly the
  // seam the ring exists to remove, with the added insult that it would only
  // appear on chunk boundaries where the LOD changes.
  const epr = res + 3
  const H = new Float32Array(epr * epr)
  for (let j = 0; j < epr; j++) {
    const wz = oz + (j - 1) * step
    for (let i = 0; i < epr; i++) {
      H[j * epr + i] = sampleHeight(ox + (i - 1) * step, wz)
    }
  }

  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  const stipple = new Float32Array(total * 4)

  let minY = Infinity
  let maxY = -Infinity

  // Bit-identical reuse, not an approximation: when the cell equals the stencil
  // width, the ring's central difference IS the classification central
  // difference, same four samples at the same band limit.
  //
  // The crest bias does not break that identity, and only because of where
  // CREST_CELL_LO sits: this branch is taken only at step === CLASS_EPS === 1 m,
  // where smoothstep(CREST_CELL_LO, ...) is exactly 0 and the ring holds raw
  // heightAtCell values. Moving CREST_CELL_LO above 1 would make the reused
  // normal a normal of the BIASED surface while the stencil below measures the
  // real one, i.e. one chunk depth shading itself by a different rule than every
  // other -- a chunk-shaped repaint of precisely the kind CLASS_EPS exists to
  // prevent.
  const reuseMeshNormal = step === CLASS_EPS
  const snowBand = layers.snow.band
  // Hoisted: `bands` is a lazy percentile pass over the whole texel array, and
  // reading the getter per vertex would hide a Map-shaped property lookup inside
  // the innermost loop of the only function whose ms/chunk anyone measures.
  const { altLo, altSpan } = field.bands

  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const vi = j * vpr + i
      const e = (j + 1) * epr + (i + 1)
      const h = H[e]
      if (h < minY) minY = h
      if (h > maxY) maxY = h

      const o = vi * 3
      // Chunk-local coordinates; the mesh is positioned at the chunk origin.
      // Keeping vertex values small is what preserves float precision two
      // kilometres from the world centre.
      positions[o] = i * step
      positions[o + 1] = h
      positions[o + 2] = j * step

      const dx = (H[e + 1] - H[e - 1]) / (2 * step)
      const dz = (H[e + epr] - H[e - epr]) / (2 * step)
      const len = Math.hypot(dx, 1, dz)
      const ny = 1 / len

      const wx = ox + i * step
      const wz = oz + j * step

      // The shading bump. See the BUMP constants. Two decorrelated taps of the
      // noise per octave give an XZ slope vector directly -- this is not the
      // gradient of a height field, so the two octaves can be mixed by weight
      // without the fine one's slope compounding as its wavelength shrinks.
      //
      // ADDED TO dx/dz BEFORE NORMALISING, not to the finished unit normal --
      // adding to a normalised vector and renormalising bends a cliff face and a
      // flat meadow by different amounts for the same bump, because the two start
      // at different lengths. In slope space the perturbation means the same
      // thing everywhere: this much extra rise per metre.
      //
      // Snow OVERRIDES rather than joining the max: it is the quietest of the
      // three, so taking the larger of it and the rock weight would hand a snowy
      // cliff the rock number and lose the reason snow is lower at all. `ny` is
      // the mesh normal here rather than nyClass, deliberately -- this is about
      // how the surface catches light, which is a question about the surface that
      // was actually built.
      const snowLine = field.snowLineAt(wx, wz)
      const snowHere = smoothstep(snowLine - snowBand / 2, snowLine + snowBand / 2, h)
      const bumpGround = BUMP_GRASS + (BUMP_ROCK - BUMP_GRASS) * smoothstep(0.86, 0.62, ny)
      const bumpK = lerp(bumpGround, BUMP_SNOW, snowHere)
      const bx = (1 - BUMP_FINE_MIX) * MOTTLE.simplex2(wx / BUMP_SCALE + 7.13, wz / BUMP_SCALE - 2.61)
        + BUMP_FINE_MIX * MOTTLE.simplex2(wx / BUMP_FINE + 128.7, wz / BUMP_FINE - 74.2)
      const bz = (1 - BUMP_FINE_MIX) * MOTTLE.simplex2(wx / BUMP_SCALE - 55.9, wz / BUMP_SCALE + 31.4)
        + BUMP_FINE_MIX * MOTTLE.simplex2(wx / BUMP_FINE - 301.4, wz / BUMP_FINE + 212.8)
      const bdx = dx + bx * bumpK
      const bdz = dz + bz * bumpK
      const blen = Math.hypot(bdx, 1, bdz)
      normals[o] = -bdx / blen
      normals[o + 1] = 1 / blen
      normals[o + 2] = -bdz / blen

      // DELIBERATELY NOT CREST-BIASED, and it is the same argument the CLASS_EPS
      // banner makes: the classification slope is measured over a fixed world
      // distance so that the colour of a piece of ground is a function of
      // position alone and does not repaint when a chunk coarsens. crestW is a
      // function of the CELL, so biasing these four taps would make the snow
      // line move as chunks split and the world would flash white in
      // chunk-shaped squares again -- the exact bug that stencil was written to
      // fix. The mesh may lean toward the crest; what the crest is made of does
      // not change with the viewer's distance.
      let nyClass = ny
      if (!reuseMeshNormal) {
        const gx = (heightAtClass(wx + CLASS_EPS, wz) - heightAtClass(wx - CLASS_EPS, wz)) / (2 * CLASS_EPS)
        const gz = (heightAtClass(wx, wz + CLASS_EPS) - heightAtClass(wx, wz - CLASS_EPS)) / (2 * CLASS_EPS)
        nyClass = 1 / Math.hypot(gx, 1, gz)
      }

      shade(h, nyClass, snowLine, snowBand, touched ? layers.flattenAt(wx, wz) : 0, altLo, altSpan, wx, wz, colors, o)

      // See the STIPPLE FRAME block. The plane is the one the GEOMETRIC normal
      // (-dx, 1, -dz) most faces -- not the bumped shading normal above, whose
      // noise would flip the plane vertex by vertex along a 45 degree
      // contour. Its offset is the chunk origin's phase along that plane's
      // two axes, and the chunk sits at y = 0 in the batch so y has no phase.
      const k = stippleTilesPerM(Math.hypot(wx - cam.x, h - cam.y, wz - cam.z))
      const adx = Math.abs(dx)
      const adz = Math.abs(dz)
      const plane = adx > 1 && adx >= adz ? 1 : adz > 1 ? 2 : 0
      const s = vi * 4
      stipple[s] = k
      stipple[s + 1] = plane === 1 ? ((k * oz) % 1 + 1) % 1 : ((k * ox) % 1 + 1) % 1
      stipple[s + 2] = plane === 0 ? ((k * oz) % 1 + 1) % 1 : 0
      stipple[s + 3] = plane
    }
  }

  const idx = (i, j) => j * vpr + i

  // Skirt depth scales with cell size -- coarse chunks have bigger vertical gaps
  // to hide -- with a 2 m floor so a leaf's 50 cm cell does not produce a 1.5 m
  // flange that a one-level LOD difference can see straight past.
  const skirtDepth = Math.max(2, step * 3)

  // Each edge is traversed in the direction that makes its triangles face
  // outward. With e1 = travel direction and e2 = (0, -depth, 0) the face normal
  // is (dz, 0, -dx), so north needs dx = +1, south dx = -1, west dz = -1, east
  // dz = +1. Getting this wrong makes the skirts invisible from outside, which
  // is the only place they are ever seen.
  const edges = []
  {
    const north = []
    for (let i = 0; i <= res; i++) north.push(idx(i, 0))
    const south = []
    for (let i = res; i >= 0; i--) south.push(idx(i, res))
    const west = []
    for (let j = res; j >= 0; j--) west.push(idx(0, j))
    const east = []
    for (let j = 0; j <= res; j++) east.push(idx(res, j))
    edges.push(north, south, west, east)
  }

  let sv = innerCount
  const skirtIndex = []
  for (const edge of edges) {
    const row = []
    for (const vi of edge) {
      const o = sv * 3
      positions[o] = positions[vi * 3]
      positions[o + 1] = positions[vi * 3 + 1] - skirtDepth
      positions[o + 2] = positions[vi * 3 + 2]
      normals[o] = normals[vi * 3]
      normals[o + 1] = normals[vi * 3 + 1]
      normals[o + 2] = normals[vi * 3 + 2]
      colors[o] = colors[vi * 3]
      colors[o + 1] = colors[vi * 3 + 1]
      colors[o + 2] = colors[vi * 3 + 2]
      for (let c = 0; c < 4; c++) stipple[sv * 4 + c] = stipple[vi * 4 + c]
      row.push(sv)
      sv++
    }
    skirtIndex.push(row)
  }

  const indices = new Uint16Array(triCount * 3)
  let k = 0

  // Shorter diagonal per quad -- see the banner. Data-dependent, so the pattern
  // is irregular and a colour boundary wanders instead of stepping.
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = idx(i, j)
      const b = idx(i + 1, j)
      const c = idx(i, j + 1)
      const d = idx(i + 1, j + 1)
      if (Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]) <
          Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1])) {
        indices[k++] = a
        indices[k++] = d
        indices[k++] = b
        indices[k++] = a
        indices[k++] = c
        indices[k++] = d
      } else {
        indices[k++] = a
        indices[k++] = c
        indices[k++] = b
        indices[k++] = b
        indices[k++] = c
        indices[k++] = d
      }
    }
  }

  for (let e = 0; e < 4; e++) {
    const edge = edges[e]
    const skirt = skirtIndex[e]
    for (let n = 0; n < edge.length - 1; n++) {
      indices[k++] = edge[n]
      indices[k++] = edge[n + 1]
      indices[k++] = skirt[n]
      indices[k++] = edge[n + 1]
      indices[k++] = skirt[n + 1]
      indices[k++] = skirt[n]
    }
  }

  if (k !== indices.length) throw new Error(`buildChunkV2: index count mismatch, wrote ${k} of ${indices.length}`)

  // `culled` travels with the mesh so the panel and the gate can report the
  // fraction of chunks that took the cheap path -- §18 puts a number on that
  // claim rather than asserting it.
  return { positions, normals, colors, stipple, indices, minY, maxY, skirtDepth, culled: !touched }
}

// C_GRASS is exported because the quest flat-ground card has to paint itself the
// grassland colour EXACTLY, not approximately: terrain-material.js decides "is
// this ground vegetated" from the vertex colour alone, so a hand-picked green
// that is a shade off classifies as something else and the card comes out with
// the wrong grain.
export { CLASS_EPS, CREST_CELL_LO, CREST_CELL_HI, PEAKS_TAPS_MAX, cullMargin, shade, C_GRASS }
