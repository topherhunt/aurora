import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural mushrooms.
//
// A mushroom is neither of the two prop shapes this project already knows how
// to build, and saying why is most of the design.
//
// It is not a fern. A fern is a rosette of FLAT CARDS whose entire silhouette
// lives in an alpha channel, and that works because a frond is genuinely flat:
// photograph it once and you have it from every angle that matters. A mushroom
// cap is a SOLID OF REVOLUTION seen from above at ankle height and from below
// when it is three metres tall in a cave. Its silhouette is a curve -- the
// difference between a cone, a dome, a parasol and a funnel is the entire
// identity of the thing -- and an alpha cutout of a dome is a semicircle, which
// is to say nothing at all.
//
// It is not a rock either. A rock's shape is noise and its texture is one tile
// repeated; a mushroom's shape is a PROFILE CURVE that has to be right to the
// millimetre at the rim, and its texture is radial -- gills, streaks, concentric
// scales -- all of which run from the axis outward. Feed a mushroom the rock's
// per-face planar projection and the gills run diagonally across the underside.
//
// So this file builds surfaces of revolution with polar UVs, and everything
// below follows from those two words.
//
// 1. THE WHOLE CAP FAMILY IS TWO NUMBERS.
//
// Mycology names about eight cap shapes -- conical, campanulate, convex, plane,
// umbonate, depressed, infundibuliform, offset. They are not eight shapes. They
// are one profile with two knobs:
//
//     y(t) = capRise * (1 - t^capCurve) + margin * t^3
//
// where t is the normalised radius from axis (0) to rim (1). `capRise` is how
// far the apex stands above the rim -- POSITIVE for every cap that sheds water,
// NEGATIVE for a funnel, and the sign change is the only difference between a
// bolete and a chanterelle. `capCurve` is where the drop happens: 1 is a
// straight cone, 2 a paraboloid dome, 6 a flat parasol with a cliff at the rim.
// `margin` then lifts or drops the outer eighth on its own, which is the
// inrolled rim of a young button (negative) and the flaring rim of an old one
// (positive).
//
// Two knobs, eight named shapes, and -- more to the point -- every shape
// BETWEEN them, which is where the real ones actually live.
//
// 2. NORMALS ARE COMPUTED FROM THE SURFACE, NOT FROM THE TRIANGLES.
//
// `computeVertexNormals` is wrong here for a specific reason that would have
// been found late and blamed on lighting. A polar UV needs a duplicated column
// of vertices at theta = 0 = TAU, because one vertex cannot hold both u = 0 and
// u = 1. Those duplicates are coincident in space but separate in the index, so
// triangle-averaged normals give each of them HALF the neighbourhood -- and the
// cap gets a visible bright seam running from apex to rim, on every mushroom,
// at every angle. Sampling the parametric surface instead makes theta a
// continuous variable that simply wraps, so the seam cannot exist.
//
// It also gets the crease at the rim right for free: the cap top and the cap
// underside are separate surfaces that happen to share an edge, so they get
// their own normals and the rim reads as an edge rather than as a soft fold.
//
// 3. COLOUR LIVES IN THE TEXTURE, NOT IN THE TINT.
//
// The shared prop material tints PER INSTANCE (`BatchedMesh.setColorAt`, see
// props/rock.js) and that is a scalar multiply over the whole instance. A rock
// is one material throughout, so a multiply is exactly right for it. A mushroom
// is two: the thing that makes a fly agaric read as a fly agaric is a SCARLET
// CAP ON A WHITE STEM, and no per-instance multiply can produce two hues.
//
// So the cap sheet and the flesh sheet (props/mushroom-texture.js) carry
// colour, addressed per vertex by which cell of the sheet a surface samples --
// `capCell` for the top, `fleshCell` for the underside, stem and ring. Cap and
// stem are therefore coloured INDEPENDENTLY at zero cost: no extra attribute,
// no extra material, no extra draw call. The per-instance tint is then left to
// do what a tint is good at, which is a gentle value and warmth jitter so no
// two mushrooms in one clump are the same mushroom twice.
//
// The cost is named rather than hidden: sheet cells bleed into each other in
// the low mips, so a mushroom far enough away to be sampling a 4 px mip is
// converging on the average of its sheet. That is a card's job long before it
// happens -- the grass class takes its card at 20 m -- but it is why the sheets
// are 2x2 rather than 4x4.
//
// 4. A CLUMP IS ONE GEOMETRY.
//
// Mushrooms come in troops. One mushroom alone reads as a placed object; six of
// staggered ages around one patch of mycelium reads as something that grew. So
// `cluster` builds them into ONE geometry, which is also the cheaper answer:
// §5's binding cost for small props is 37 ns per visible INSTANCE regardless of
// triangles, so six caps in one instance is a sixth of the per-frame CPU of six
// instances. Same argument as `shards` in props/rock.js.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, indexed. That is
// the shared prop material's layout (src/material.js) and BatchedMesh rejects a
// geometry that disagrees. Unlike buildFern there is no second `uv` layout,
// because the bench renders the real material -- a mushroom without its two
// sheets is a grey lamp.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

export const MUSHROOM_DEFAULTS = {
  seed: 1,

  // --- size ----------------------------------------------------------------
  // Everything below is RELATIVE to a unit-tall mushroom; the geometry is
  // measured and rescaled at the end so the built thing is exactly `height`
  // metres. Same reasoning as buildFern: `capRise` and `stemCurve` both move
  // the top, so the only honest way to hit a metre target is to build it and
  // then measure it.
  height: 0.09, // metres, tip of cap to ground. 6-15 cm is a forest floor
                // mushroom; the bench's cave presets go to 3 m and the shape
                // holds, which is the whole reason this is one generator

  // --- cap ------------------------------------------------------------------
  capRadius: 0.42, // half-width of the cap, relative to total height
  capRise: 0.26,   // apex height above the rim. NEGATIVE = funnel / vase
  capCurve: 2.2,   // 1 = cone, 2 = dome, 4+ = flat parasol with a cliff at the rim
  margin: 0.0,     // rim lift (+) or inroll (-), applied to the outer eighth only
  inroll: 0.0,     // rim pulled radially INWARD, 0..1. A young button tucks under
  wavy: 0.0,       // rim undulation as a fraction of cap radius -- chanterelles,
                   // oysters, anything that reads as fungal rather than umbrella
  lobes: 5,        // how many undulations around the rim
  umbo: 0.0,       // a raised nipple at the apex. Small, and unmistakably a mushroom
  capTilt: 0.0,    // whole cap tipped off horizontal, radians. Brackets need it
  sweep: TAU,      // arc of the cap. < TAU with no stem is a BRACKET fungus

  // --- underside ------------------------------------------------------------
  underside: false, // build the gilled underside at all. OFF by default, and it
                   // is worth being clear that this is a DEFAULT rather than a
                   // tier setting: a forest-floor mushroom is a thing you look
                   // down on, so its gills are a third of its triangles spent
                   // on the one face nobody sees. Turn it on for anything you
                   // can walk under. What "off" actually leaves behind is a cap
                   // that is a single sheet, and since the prop material is
                   // DoubleSide and re-flips the normal (src/material.js), that
                   // sheet's far side is lit by the cap's own UPWARD normal --
                   // so from below the cap reads as lit rather than shadowed,
                   // which is exactly the trade and is fine right up until you
                   // are standing under it
  gillDrop: 0.06,  // how far the underside hangs below the rim before running
                   // back up to the stem. 0 = a flat disc, which reads as paper
  gillBlades: 0,   // ACTUAL radial gill geometry, 0 = texture only. 2 triangles
                   // each and worth it only on a cave mushroom you stand under
  gillDepth: 0.5,  // how far a blade hangs, as a fraction of gillDrop

  // --- stem -----------------------------------------------------------------
  stemHeight: 0.62,  // relative to total height. 0 = no stem at all (bracket)
  stemRadius: 0.062, // at mid-height, relative to total height
  stemTaper: 0.35,   // >0 thicker at the base (clavate), <0 thicker at the top
  bulb: 0.0,         // abrupt swelling in the lowest fifth -- amanita's volva.
                     // Separate from taper because a bulb is a STEP, not a slope
  lean: 0.0,         // stem tilt off vertical at the base, radians
  stemCurve: 0.3,    // additional bend accumulated up the stem, radians.
                     // Positive curves back toward upright, which is what a
                     // mushroom on a slope actually does. Non-zero by default
                     // because a dead-straight stalk is the single loudest tell
                     // that a prop was generated rather than grown
  ring: 0.0,         // annulus skirt, 0..1 as a fraction of cap radius. 0 = none
  ringHeight: 0.72,  // where up the stem it sits
  ringDroop: 0.35,   // how far the skirt hangs, relative to its own width

  // --- clump ----------------------------------------------------------------
  cluster: 1,        // caps in this geometry. The single knob that most makes a
                     // mushroom read as grown rather than placed
  clusterSpread: 0.5,// footprint radius of the clump, relative to total height
  clusterVary: 0.55, // how much smaller the youngest member is, 0..1
  clusterLean: 0.25, // how far outward the outer members lean, radians

  // --- tiers ----------------------------------------------------------------
  // The LOD knobs, and they are re-generations rather than decimations -- the
  // same argument DESIGN.md §5 makes for the bush class. Triangles are exactly
  //   cluster x ( radial     x (2*capRings - 1)      <- cap top
  //             + radial     x 2 x underRings        <- underside, if any
  //             + stemRadial x 2 x stemRings         <- stem, if any
  //             + stemRadial x 2                     <- ring, if any
  //             + gillBlades x 2 )
  // The cap top is the odd one out because its innermost ring collapses to a
  // point, so half of that row's quads are degenerate and never emitted. The
  // underside does the same, but only on a STEMLESS mushroom: given a stalk its
  // inner edge is trimmed to the stalk's radius and never reaches the axis, so
  // subtract another `radial` from the underside row when stemHeight is 0.
  radial: 16,    // columns around the CAP. 5 is the floor at which a cap still
                 // reads as round and 6 is what the coarse mesh tier drops to;
                 // 16 is the near tier, where the rim is the silhouette you are
                 // looking straight at. This went from 9 to 16 once the cap's
                 // UV became a planar decal (see capUV): under the old polar
                 // chart a coarse cap SLICED its own texture, so column count
                 // and texture quality were the same knob and 9 was a
                 // compromise between them. They are independent now, which is
                 // what makes both a finer near tier and a coarser far tier
                 // worth having
  stemRadial: 3, // columns around the STEM and its ring, and deliberately not
                 // the same number as the cap's. The two surfaces are looked at
                 // completely differently: a cap is a broad silhouette against
                 // the ground and every facet on it shows, while a stalk is a
                 // few millimetres wide and mostly in its own cap's shadow, so
                 // a triangular prism reads as a stalk at any distance you will
                 // ever see one from. Splitting the knob is worth more than it
                 // sounds -- at radial 9 the stem was two thirds of the whole
                 // mushroom's triangles, and it is now a fifth
  capRings: 2,   // rings from apex to rim. 1 is a faceted cone, 2 carries the
                 // profile curve, 3 is only visible above about 1 m of cap
  underRings: 1, // rings from rim back to the stem
  stemRings: 2,  // segments up the stem. 1 cannot show `stemCurve` at all

  // --- material -------------------------------------------------------------
  capLayer: LAYER.MUSHROOM_CAP,
  fleshLayer: LAYER.MUSHROOM_FLESH,
  capCell: 0,   // which cell of the cap sheet this cap wears (0..3)
  fleshCell: 0, // ...and of the flesh sheet, for underside + stem + ring
}

// The flesh sheet is a 2x2 grid of 64 px cells. UVs are inset by one texel on
// every side: without it the bilinear tap at a cell edge reaches into its
// neighbour, and a white-gilled mushroom gets a hairline of the brown one next
// door all the way round its rim.
const SHEET_GRID = 2
const CELL = 1 / SHEET_GRID
const INSET = 1 / 128 // one texel of a 128 px sheet

function cellUV(cell, u, v) {
  const cx = (cell % SHEET_GRID) * CELL
  const cy = Math.floor(cell / SHEET_GRID) * CELL
  const span = CELL - 2 * INSET
  return [cx + INSET + u * span, cy + INSET + v * span]
}

// The cap top does NOT use cellUV's polar mapping. It is projected along the
// cap's own axis instead -- a decal laid on the cap from above -- and the
// reason is triangulation rather than art.
//
// A polar mapping hands each of the `radial` apex triangles a WEDGE of the
// chart and lets the GPU interpolate the angle linearly across it, which the
// true angle does not do. On the fly agaric's 9-gon that slices any wart wider
// than 40 degrees of arc (an inner-ring wart is 1.02 wedges wide, so all of
// them) and runs the radius 6% long inside every wedge. Both artefacts grow
// toward the middle, where the wedges converge and a cap is most visible.
//
// A planar projection has neither, and not by being finer -- by being AFFINE. u
// and v come out linear in the cap's local x and z; a triangle's x and z are
// already linear in its barycentrics; so the hardware's linear interpolation is
// EXACT and the texture stops caring how many triangles the cap has. It also
// collapses the apex fan to a single point in UV instead of `cols + 1`
// different ones, which is the same statement read the other way round.
//
// `rN` is the vertex's radius as a fraction of the cap's widest radius and
// `theta` its angle, so this is the disc of props/mushroom-texture.js addressed
// in its own coordinates. Inset on all four sides like any other cell -- the
// disc has no wrap to protect, and the rim touches the cell edge at four points
// without it.
function capUV(cell, rN, theta) {
  const cx = (cell % SHEET_GRID) * CELL
  const cy = Math.floor(cell / SHEET_GRID) * CELL
  const half = (CELL - 2 * INSET) * 0.5
  return [
    cx + CELL * 0.5 + rN * half * Math.cos(theta),
    cy + CELL * 0.5 + rN * half * Math.sin(theta),
  ]
}

// The stalk and the gills share one flesh cell, which sounds like a compromise
// and is not: gills radiating from the axis and fibres running up a stalk are
// the same picture -- lines of constant u -- so they can be the same pixels.
// What differs is contrast and shading, and the cell's v axis carries both. The
// underside takes v across its whole range, dark at the axis and bright at the
// rim; the stalk takes only this slice of the pale end, and takes it INVERTED,
// so the stem is brightest at the ground and falls into shadow where the cap
// overhangs it. See props/mushroom-texture.js, which paints the ramp.
const STEM_V_BASE = 0.95
const STEM_V_TOP = 0.55
const stemV = (s) => STEM_V_BASE + (STEM_V_TOP - STEM_V_BASE) * s

// ---------------------------------------------------------------------------
// The cap surface.
//
// Closed form in (t, theta) so normals can be taken by central difference,
// which is what makes the polar seam invisible -- see point 2 in the header.
// `t` is 0 at the apex and 1 at the rim.
// ---------------------------------------------------------------------------

function capRadiusAt(t, theta, p) {
  let r = p.capRadius * t
  // Undulation grows with t so the axis stays put and only the rim ripples.
  if (p.wavy !== 0) r *= 1 + p.wavy * Math.cos(p.lobes * theta) * t * t
  // Inroll bites only at the very edge: t^4 is 0.06 at t = 0.5.
  if (p.inroll !== 0) r *= 1 - p.inroll * Math.pow(t, 4)
  return r
}

function capHeightAt(t, theta, p) {
  // The profile. `capRise` sets the apex, `capCurve` decides where the fall is.
  let y = p.capRise * (1 - Math.pow(t, p.capCurve))
  // The rim's own term, confined to the outer eighth by t^3.
  y += p.margin * Math.pow(t, 3)
  // A wavy rim goes up and down as well as in and out, a quarter turn out of
  // phase with the radial ripple. In phase, the rim reads as a cog.
  if (p.wavy !== 0) {
    y += p.wavy * p.capRadius * 0.45 * Math.sin(p.lobes * theta) * t * t
  }
  // The umbo: a narrow bump at the apex, on top of whatever the profile does.
  // exp(-(t/0.22)^2) is 0.02 by t = 0.4, so it never disturbs the shoulder.
  if (p.umbo !== 0) y += p.umbo * p.capRadius * Math.exp(-Math.pow(t / 0.22, 2))
  return y
}

// The underside, as its own surface rather than as a mirrored cap. It hangs
// `gillDrop` below the rim and runs back up to meet the stem, which is what
// gives a mushroom the dark band under its edge that says "there is something
// under here" from a metre away.
// `t` is the cap parameter (stalk to rim) and `u` runs the other way, 1 at the
// inner edge and 0 at the rim. They are handed in separately rather than as
// `1 - t` because the underside does not start at the axis -- see `tFloor`.
function underHeightAt(t, u, theta, p) {
  const rim = capHeightAt(1, theta, p)
  const apexY = capHeightAt(0, theta, p) // where the flesh meets the stem
  // Hang below the rim, then climb back to meet the stalk.
  const hang = -p.gillDrop * p.capRadius * Math.pow(t, 0.6)
  const climb = (apexY - p.gillDrop * p.capRadius * 0.35 - rim) * Math.pow(u, 1.7)
  return rim + hang + climb
}

// Central difference on whichever surface pair is handed in. Returns a unit
// normal; `flip` reverses it for the downward-facing underside.
const _du = new THREE.Vector3()
const _dt = new THREE.Vector3()
const _n = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

function surfaceNormal(point, t, theta, flip) {
  const dt = 1e-3
  const dth = 1e-3
  const t0 = Math.max(0, t - dt)
  const t1 = Math.min(1, t + dt)

  point(t1, theta, _a)
  point(t0, theta, _b)
  _dt.subVectors(_a, _b)

  point(t, theta + dth, _a)
  point(t, theta - dth, _b)
  _du.subVectors(_a, _b)

  _n.crossVectors(_du, _dt).normalize()
  if (!Number.isFinite(_n.x) || _n.lengthSq() < 0.5) _n.set(0, flip ? -1 : 1, 0)
  else if (flip) _n.negate()
  return _n
}

// ---------------------------------------------------------------------------
// The stem.
//
// Swept along an integrated centreline, exactly the way props/fern.js walks a
// frond: every parameter is then a physical quantity (lean at the base, bend
// accumulated over the length) rather than a spline control point nobody can
// picture. Frames are parallel-transported so a curved stem does not twist its
// texture as it bends.
// ---------------------------------------------------------------------------

function stemProfile(s, p) {
  // Taper is a slope through the mid-point, so `stemRadius` stays the radius at
  // half height whatever the taper does. Without that, dialling taper up also
  // silently fattens the whole stem.
  let r = 1 + p.stemTaper * (0.5 - s)
  // The bulb is a step, not a slope: it lives in the bottom fifth and is gone
  // by a third. That abruptness is the entire difference between an amanita's
  // volva and a merely thick stalk.
  if (p.bulb !== 0) r += p.bulb * Math.exp(-Math.pow(s / 0.18, 2))
  return Math.max(0.12, r) * p.stemRadius
}

// Walk the centreline and return one frame per ring: { pos, tangent, side, fwd,
// radius }. `rings` is the number of SEGMENTS, so this returns rings + 1 frames.
function stemFrames(p, rings, leanYaw) {
  const frames = []
  const pos = new THREE.Vector3(0, 0, 0)
  // Launch direction: `lean` off vertical, in the `leanYaw` azimuth.
  const tangent = new THREE.Vector3(
    Math.sin(p.lean) * Math.cos(leanYaw),
    Math.cos(p.lean),
    Math.sin(p.lean) * Math.sin(leanYaw)
  ).normalize()
  // Bend axis: perpendicular to both the lean direction and up, so the stem
  // curves back through the plane it leaned out of rather than corkscrewing.
  const bendAxis = new THREE.Vector3(-Math.sin(leanYaw), 0, Math.cos(leanYaw)).normalize()

  let side = new THREE.Vector3(Math.cos(leanYaw), 0, Math.sin(leanYaw))
  side.projectOnPlane(tangent).normalize()

  const ds = 1 / rings
  for (let k = 0; k <= rings; k++) {
    const s = k * ds
    // side x tangent, in that order. The reverse is equally orthonormal and
    // silently left-handed: with tangent +Y and side +X it yields -Z, so
    // `side*cos + fwd*sin` sweeps theta clockwise seen from above -- the mirror
    // of the (R cos t, y, R sin t) convention that both stitchGrid's winding
    // and surfaceNormal's cross product are derived against. Nothing errors;
    // every normal on the mushroom just comes out negated.
    const fwd = new THREE.Vector3().crossVectors(side, tangent).normalize()
    frames.push({
      pos: pos.clone(),
      tangent: tangent.clone(),
      side: side.clone(),
      fwd,
      radius: stemProfile(s, p),
      s,
    })
    if (k === rings) break
    // Step forward, then bend. `stemCurve` is the TOTAL bend over the stem, so
    // each step turns by its share.
    pos.addScaledVector(tangent, p.stemHeight * ds)
    if (p.stemCurve !== 0) {
      tangent.applyAxisAngle(bendAxis, -p.stemCurve * ds).normalize()
      // Re-orthogonalise rather than recomputing from scratch: this is parallel
      // transport, and it is what stops the texture twisting as the stem bends.
      side = side.projectOnPlane(tangent).normalize()
    }
  }
  return frames
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function makeSink() {
  return { positions: [], normals: [], uvs: [], layers: [], indices: [] }
}

function vert(out, x, y, z, nx, ny, nz, u, v, layer) {
  out.positions.push(x, y, z)
  out.normals.push(nx, ny, nz)
  out.uvs.push(u, v)
  out.layers.push(layer)
  return out.positions.length / 3 - 1
}

// A grid of (rings + 1) x (cols + 1) vertices stitched into quads. `up` picks
// the winding: true for a surface whose outward face points away from the axis
// or upward, false for the underside. Rows are inner-to-outer.
function stitchGrid(out, base, rings, cols, up, skipDegenerateFirstRow) {
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < cols; j++) {
      const a = base + k * (cols + 1) + j
      const b = a + 1
      const c = a + (cols + 1)
      const d = c + 1
      if (up) {
        // Derived in the header of this file: for positions (R cos t, y, R sin t)
        // with t increasing, (inner_j, outer_j1, outer_j) faces +Y.
        out.indices.push(a, d, c)
        if (!(skipDegenerateFirstRow && k === 0)) out.indices.push(a, b, d)
      } else {
        out.indices.push(a, c, d)
        if (!(skipDegenerateFirstRow && k === 0)) out.indices.push(a, d, b)
      }
    }
  }
}

// Build one mushroom (cap + optional stem + optional ring) into `out`,
// positioned and scaled by `place`.
function addMushroom(out, p, place) {
  const cols = Math.max(3, Math.round(p.radial))
  const stemCols = Math.max(3, Math.round(p.stemRadial))
  const closed = p.sweep >= TAU - 1e-6
  const arc = Math.min(TAU, Math.max(0.15, p.sweep))
  const theta0 = place.yaw

  // Where the cap sits. A stemless cap (bracket) attaches at y = 0.
  const stem = p.stemHeight > 1e-4 ? stemFrames(p, Math.max(1, Math.round(p.stemRings)), place.leanYaw) : null
  const top = stem ? stem[stem.length - 1] : null
  const capOrigin = top ? top.pos.clone() : new THREE.Vector3(0, 0, 0)
  // The cap rides the stem's tip direction, plus its own tilt. A leaning stem
  // carries its cap over with it -- a cap that stayed level on a bent stalk
  // reads as a hat resting on a stick.
  const capAxis = top ? top.tangent.clone() : new THREE.Vector3(0, 1, 0)

  // Orthonormal frame for the cap, built from its axis. Right-handed: see the
  // note on the stem's frame for why the operand order is load-bearing.
  const capSide = (top ? top.side.clone() : new THREE.Vector3(1, 0, 0))
  const capFwd = new THREE.Vector3().crossVectors(capSide, capAxis).normalize()

  // Cap tilt rotates the axis about the side vector -- brackets need it, and it
  // is also what lets a clump's outer members flop outward.
  if (p.capTilt !== 0) {
    const axis = capSide.clone()
    capAxis.applyAxisAngle(axis, p.capTilt).normalize()
    capFwd.crossVectors(capSide, capAxis).normalize()
  }

  // The stalk's radius WHERE THE CAP MEETS IT, which is the top frame's own
  // radius and not `stemRadius`. `stemRadius` is the radius at HALF height by
  // definition (see stemProfile), so on anything with real taper the two differ
  // by tens of percent, and every "is this inside the stalk" test below wants
  // the one at the top.
  const stalkR = top ? top.radius : 0

  // --- the cap must not be impaled on its own stalk --------------------------
  //
  // A dome sits above the stem tip and needs nothing done to it. A FUNNEL does:
  // with `capRise` negative the profile's low point is the axis, which is
  // exactly where the stalk is, so a chanterelle built naively has its stem
  // standing up through the middle of its own cap.
  //
  // The fix is to raise the cap until its surface meets the stalk AT THE
  // STALK'S RADIUS rather than at the axis, and aligning there is the whole of
  // it: the cap then closes onto the top rim of the tube with no slit, and the
  // bowl carries on falling away INSIDE the tube where the tube's own walls
  // hide it. That is also what the real thing does, since a chanterelle's
  // funnel is continuous with its stalk rather than resting on top of one.
  //
  // "The stalk's radius" is its INSCRIBED radius, not `stalkR`. A stem drawn
  // with `stemRadial` columns is a prism, and the middle of a prism's flat face
  // is only stalkR * cos(pi/stemCols) from the axis -- at the default 3 columns
  // that is HALF the circumradius. Align to the circumradius instead and the
  // three flat faces each poke a corner up through the cap, which is the exact
  // bug this block exists to remove. Aligning to the inscribed radius leaves
  // the opposite error, a sub-millimetre slit at the three vertices, and a slit
  // you cannot see beats a spike you can.
  //
  // Sampled around theta rather than solved because `wavy` and `umbo` both
  // perturb the height and neither inverts. Clamped at zero, so nothing whose
  // cap already sheds water moves at all.
  let capLift = 0
  if (stem) {
    const tStalk = Math.min(1, (stalkR * Math.cos(Math.PI / stemCols)) / Math.max(1e-4, p.capRadius))
    let lowest = Infinity
    for (let j = 0; j < 8; j++) {
      lowest = Math.min(lowest, capHeightAt(tStalk, theta0 + (j / 8) * TAU, p))
    }
    capLift = Math.max(0, -lowest)
  }

  // Map a local (radius, height) about the cap axis into world space.
  const toWorld = (r, y, theta, target) => {
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    return target
      .copy(capOrigin)
      .addScaledVector(capSide, r * c)
      .addScaledVector(capFwd, r * s)
      .addScaledVector(capAxis, y + capLift)
  }

  const capPoint = (t, theta, target) =>
    toWorld(capRadiusAt(t, theta, p), capHeightAt(t, theta, p), theta, target)

  // The underside's inner edge is the STALK, not the axis. Everything inside
  // `tFloor` is cap narrower than the stem it lands on -- triangles buried in
  // the stalk, invisible and paid for anyway.
  //
  // The previous answer clamped the radius up to the stem instead, and that is
  // worse than wasteful: a clamped band has dr/dt exactly zero, so its normal
  // is decided by dy alone, and dy's sign flips with `capRise`. Every funnel
  // therefore grew an inside-out collar while every dome came out right.
  // Trimming the domain removes the degenerate band rather than orienting it.
  const tFloor = p.stemHeight > 1e-4
    ? Math.min(0.6, (stalkR * 0.98) / Math.max(1e-4, p.capRadius))
    : 0
  const underPoint = (t, theta, target) =>
    toWorld(
      capRadiusAt(tFloor + (1 - tFloor) * t, theta, p),
      // `1 - t`, not `1 - tt`, so the climb still reaches the flesh/stalk
      // junction exactly at the trimmed inner edge instead of stopping short
      // of it and opening a gap between the gills and the stalk.
      underHeightAt(tFloor + (1 - tFloor) * t, 1 - t, theta, p),
      theta,
      target,
    )

  const tmp = new THREE.Vector3()

  // --- cap top --------------------------------------------------------------
  const capRings = Math.max(1, Math.round(p.capRings))
  const capBase = out.positions.length / 3
  // The disc's normalising radius, measured over the grid that is about to be
  // emitted rather than taken as `p.capRadius`. `wavy` and `inroll` both bend
  // the radius by theta, and `inroll` makes it non-monotonic in t, so the
  // widest point of a lobed cap is neither at t = 1 nor the same at every
  // angle. Measuring it is 3 lines and guarantees the projected disc lands
  // inside its cell instead of near enough.
  let capMaxR = 1e-4
  for (let k = 0; k <= capRings; k++) {
    for (let j = 0; j < cols; j++) {
      const th = theta0 + (closed ? (j / cols) * TAU : (j / cols) * arc - arc / 2)
      capMaxR = Math.max(capMaxR, capRadiusAt(k / capRings, th, p))
    }
  }
  for (let k = 0; k <= capRings; k++) {
    const t = k / capRings
    for (let j = 0; j <= cols; j++) {
      const theta = theta0 + (closed ? (j / cols) * TAU : (j / cols) * arc - arc / 2)
      capPoint(t, theta, tmp)
      const n = surfaceNormal(capPoint, t, theta, false)
      // Planar UV, projected along the cap axis. `capRadiusAt` is the same
      // radius `capPoint` just used, so this is literally the vertex's own
      // (x, z) in the cap's frame -- which is what makes the mapping affine and
      // the interpolation exact. See capUV.
      const [u, v] = capUV(p.capCell, capRadiusAt(t, theta, p) / capMaxR, theta)
      vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, p.capLayer)
    }
  }
  // The apex row is `cols + 1` coincident vertices, so its second triangle per
  // quad has zero area. Skipping it is `cols` triangles saved on every cap in
  // the world, which at a forest floor's worth of mushrooms is not nothing.
  stitchGrid(out, capBase, capRings, cols, true, true)

  // --- cap underside --------------------------------------------------------
  if (p.underside) {
    const underRings = Math.max(1, Math.round(p.underRings))
    const underBase = out.positions.length / 3
    for (let k = 0; k <= underRings; k++) {
      // Axis-first, like every other grid in this file, because that IS
      // stitchGrid's stated convention: row 0 inner, last row outer. Emitting
      // rim-first reverses the parametrisation, which mirrors the surface and
      // flips its facing -- cancelling the very flip `up = false` is passed to
      // apply, and leaving the gills wound to face the sky.
      const t = k / underRings
      for (let j = 0; j <= cols; j++) {
        const theta = theta0 + (closed ? (j / cols) * TAU : (j / cols) * arc - arc / 2)
        underPoint(t, theta, tmp)
        const n = surfaceNormal(underPoint, t, theta, true)
        // v = 0 at the AXIS on the flesh sheet, so a gill drawn as a line of
        // constant u reaches the rim regardless of how many rings this tier has.
        const [u, v] = cellUV(p.fleshCell, j / cols, t)
        vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, p.fleshLayer)
      }
    }
    // With no stalk to trim against, `tFloor` is 0 and the inner row collapses
    // to a point exactly like the cap's apex, so half of that row's quads are
    // degenerate. Same skip, same reason.
    stitchGrid(out, underBase, underRings, cols, false, tFloor === 0)
  }

  // --- gill blades ----------------------------------------------------------
  // Real geometry, and only worth it on something you stand under. ONE quad
  // per blade, not the mirrored pair props/shapes.js buildGrass emits: the
  // shared prop material is already `side: DoubleSide` and undoes three's
  // back-face normal flip (`normal *= faceDirection`, src/material.js), so a
  // single quad is lit by its AUTHORED normal from both sides. Mirroring it
  // here would double the most expensive optional part of the mushroom to buy
  // something the material already gives away.
  const blades = Math.max(0, Math.round(p.gillBlades))
  if (blades > 0 && p.underside) {
    const inner = new THREE.Vector3()
    const outer = new THREE.Vector3()
    const innerLow = new THREE.Vector3()
    const outerLow = new THREE.Vector3()
    const drop = p.gillDrop * p.capRadius * p.gillDepth
    for (let g = 0; g < blades; g++) {
      const theta = theta0 + (closed ? (g / blades) * TAU : (g / blades) * arc - arc / 2)
      const tIn = Math.min(0.98, Math.max(0.05, stalkR / Math.max(1e-4, p.capRadius)) * 1.1)
      underPoint(tIn, theta, inner)
      underPoint(0.995, theta, outer)
      innerLow.copy(inner).addScaledVector(capAxis, -drop * 0.45)
      outerLow.copy(outer).addScaledVector(capAxis, -drop)

      const nx = Math.cos(theta + Math.PI / 2)
      const nz = Math.sin(theta + Math.PI / 2)
      const nrm = new THREE.Vector3()
        .addScaledVector(capSide, nx)
        .addScaledVector(capFwd, nz)
        .normalize()

      const b = out.positions.length / 3
      const pts = [inner, outer, outerLow, innerLow]
      // u is the SAME for all four corners on purpose. A blade is one gill seen
      // edge-on, so it wants one flat colour across its width; letting u run
      // 0..1 would smear the whole cell's worth of gill lines across a fin two
      // centimetres deep. The v axis still runs axis-to-rim, so the blade picks
      // up the same shadow gradient as the surface it hangs off.
      const uv = [[0.5, 0.12], [0.5, 0.9], [0.5, 0.9], [0.5, 0.12]]
      for (let i = 0; i < 4; i++) {
        const [u, v] = cellUV(p.fleshCell, uv[i][0], uv[i][1])
        vert(out, pts[i].x, pts[i].y, pts[i].z, nrm.x, nrm.y, nrm.z, u, v, p.fleshLayer)
      }
      out.indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
  }

  // --- stem -----------------------------------------------------------------
  if (stem) {
    const stemBase = out.positions.length / 3
    for (const f of stem) {
      for (let j = 0; j <= stemCols; j++) {
        const theta = (j / stemCols) * TAU
        const c = Math.cos(theta)
        const s = Math.sin(theta)
        tmp.copy(f.pos).addScaledVector(f.side, f.radius * c).addScaledVector(f.fwd, f.radius * s)
        // Swept-tube normal, exact: the radial direction, tipped back by how
        // fast the radius is changing along the sweep. A bulb whose normals
        // ignored dR/ds would be lit like a cylinder and the swelling would
        // vanish under the shading.
        const dR = (stemProfile(Math.min(1, f.s + 0.02), p) - stemProfile(Math.max(0, f.s - 0.02), p))
          / Math.max(1e-5, 0.04 * p.stemHeight)
        const n = new THREE.Vector3()
          .addScaledVector(f.side, c)
          .addScaledVector(f.fwd, s)
          .addScaledVector(f.tangent, -dR)
          .normalize()
        const [u, v] = cellUV(p.fleshCell, j / stemCols, stemV(f.s))
        vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, p.fleshLayer)
      }
    }
    // A tube's outward face is the opposite winding from a cap's upward face --
    // derived alongside it in the header.
    for (let k = 0; k < stem.length - 1; k++) {
      for (let j = 0; j < stemCols; j++) {
        const a = stemBase + k * (stemCols + 1) + j
        const b = a + 1
        const c = a + (stemCols + 1)
        const d = c + 1
        out.indices.push(a, d, b, a, c, d)
      }
    }
  }

  // --- ring -----------------------------------------------------------------
  // One band of quads, normals up and out. It is seen from below as often as
  // from above and that costs nothing extra: the prop material is DoubleSide
  // and re-flips the normal, so one face is lit correctly from either side.
  if (stem && p.ring > 1e-4) {
    const ringBase = out.positions.length / 3
    const hIdx = Math.min(stem.length - 1, p.ringHeight * (stem.length - 1))
    const k0 = Math.floor(hIdx)
    const k1 = Math.min(stem.length - 1, k0 + 1)
    const mix = hIdx - k0
    const centre = stem[k0].pos.clone().lerp(stem[k1].pos, mix)
    const side = stem[k0].side
    const fwd = stem[k0].fwd
    const axis = stem[k0].tangent
    const rIn = stem[k0].radius * 1.02
    const rOut = p.ring * p.capRadius
    const droop = -p.ringDroop * rOut

    // `stemCols`, not `cols`, and it is not a stylistic choice. The skirt's
    // inner edge has to land ON the stalk, and the stalk is a prism: give the
    // ring the cap's nine columns and its inner polygon crosses the stem's
    // three flat faces, sinking inside the stalk at the vertices and floating
    // clear of it in between. Sharing the column count makes the two polygons
    // share their vertices' angles, so the join is exact at every one.
    for (let ring = 0; ring < 2; ring++) {
      const r = ring === 0 ? rIn : rOut
      const dy = ring === 0 ? 0 : droop
      for (let j = 0; j <= stemCols; j++) {
        const theta = (j / stemCols) * TAU
        tmp.copy(centre)
          .addScaledVector(side, r * Math.cos(theta))
          .addScaledVector(fwd, r * Math.sin(theta))
          .addScaledVector(axis, dy)
        // Tipped outward by the droop, so the skirt catches light along its
        // slope rather than reading as a flat washer.
        const n = new THREE.Vector3()
          .addScaledVector(axis, 1)
          .addScaledVector(side, -droop * Math.cos(theta) * 2)
          .addScaledVector(fwd, -droop * Math.sin(theta) * 2)
          .normalize()
        // The skirt is stalk, not gill, so it samples the stem band -- and its
        // outer edge takes the shaded end, because the underside of a drooping
        // ring never sees the sky.
        const [u, v] = cellUV(p.fleshCell, j / stemCols, ring === 0 ? STEM_V_BASE : STEM_V_TOP)
        vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, p.fleshLayer)
      }
    }
    stitchGrid(out, ringBase, 1, stemCols, true, false)
  }

  // Move the finished mushroom into its slot in the clump. Done here rather
  // than by transforming a whole geometry afterwards because the members have
  // different sizes and rotating a merged buffer would need the normals
  // rebuilt -- which is exactly the surface information we went to the trouble
  // of computing analytically.
  if (place.scale !== 1 || place.x !== 0 || place.z !== 0) {
    const n = out.positions.length / 3
    for (let i = place.vertexStart; i < n; i++) {
      out.positions[i * 3] = out.positions[i * 3] * place.scale + place.x
      out.positions[i * 3 + 1] = out.positions[i * 3 + 1] * place.scale
      out.positions[i * 3 + 2] = out.positions[i * 3 + 2] * place.scale + place.z
    }
  }
}

export function buildMushroom(options = {}) {
  const p = { ...MUSHROOM_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)
  const out = makeSink()

  const count = Math.max(1, Math.round(p.cluster))

  for (let i = 0; i < count; i++) {
    // Maturity. The first member is the full-size one and the rest are younger,
    // which is what a real troop looks like -- not N mushrooms of one age.
    const age = count === 1 ? 1 : 1 - (i / (count - 1)) * p.clusterVary * (0.55 + rand() * 0.45)
    const yaw = rand() * TAU
    const dist = count === 1 ? 0 : Math.sqrt(rand()) * p.clusterSpread * p.height

    // Younger caps are more domed and less open, which is the actual
    // developmental sequence: a mushroom's cap unfolds as it grows. Driving it
    // off `age` rather than off a separate random number is what makes a clump
    // read as one organism at several stages.
    const young = 1 - age
    const member = {
      ...p,
      capCurve: p.capCurve * (1 + young * 0.55),
      capRise: p.capRise * (1 + young * 0.7),
      margin: p.margin - young * 0.04,
      inroll: Math.min(0.85, p.inroll + young * 0.35),
      stemHeight: p.stemHeight * (1 - young * 0.25),
      // Outer members of a clump lean away from the centre, reaching for light.
      lean: p.lean + (count === 1 ? 0 : (dist / Math.max(1e-4, p.clusterSpread * p.height)) * p.clusterLean),
    }

    addMushroom(out, member, {
      yaw,
      leanYaw: count === 1 ? 0 : yaw,
      scale: age,
      x: Math.cos(yaw) * dist,
      z: Math.sin(yaw) * dist,
      vertexStart: out.positions.length / 3,
    })
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.layers, 1))
  geo.setIndex(out.indices)

  // Rescale to the requested height, then sit it on y = 0. Everything above
  // works in units of "one tall" because `capRise`, `stemCurve` and `cluster`
  // all move the top -- so the only honest way to hit a metre target is to
  // build it and measure it. Same reasoning as buildFern and buildBoulder.
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const raw = bb.max.y - bb.min.y
  if (raw > 1e-9) geo.scale(p.height / raw, p.height / raw, p.height / raw)
  geo.computeBoundingBox()
  geo.translate(0, -geo.boundingBox.min.y, 0)
  geo.computeBoundingSphere()

  geo.userData.mushroom = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    cluster: count,
    height: p.height,
    // The rim's reach in either direction about the axis -- the DEPTH that
    // §5's parallax rule takes, and therefore the number that says how close a
    // card is allowed to be. A cap is as deep as it is wide.
    spread: 2 * Math.max(
      Math.abs(geo.boundingBox.min.x), Math.abs(geo.boundingBox.max.x),
      Math.abs(geo.boundingBox.min.z), Math.abs(geo.boundingBox.max.z)
    ),
  }
  return geo
}

// The triangle count a given parameter set will produce, without building it.
// Used by the bench to price a tier before you drag the slider onto it, and by
// scripts/check-mushrooms.mjs to assert the formula in MUSHROOM_DEFAULTS'
// comment is still the truth.
export function mushroomTriangles(options = {}) {
  const p = { ...MUSHROOM_DEFAULTS, ...options }
  const cols = Math.max(3, Math.round(p.radial))
  const stemCols = Math.max(3, Math.round(p.stemRadial))
  const capRings = Math.max(1, Math.round(p.capRings))
  const underRings = Math.max(1, Math.round(p.underRings))
  const stemRings = Math.max(1, Math.round(p.stemRings))
  const blades = Math.max(0, Math.round(p.gillBlades))

  const stemmed = p.stemHeight > 1e-4

  let per = cols * (2 * capRings - 1)
  // The underside loses a row of degenerate quads for the same reason the cap
  // does, but only when there is no stalk to trim its inner edge against.
  if (p.underside) per += cols * (stemmed ? 2 * underRings : 2 * underRings - 1)
  if (blades > 0 && p.underside) per += blades * 2
  if (stemmed) per += stemCols * 2 * stemRings
  if (stemmed && p.ring > 1e-4) per += stemCols * 2
  return per * Math.max(1, Math.round(p.cluster))
}
