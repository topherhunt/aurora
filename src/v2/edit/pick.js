import THREE from '../../three-instance.js'

import { WORLD_SIZE } from '../config.js'

// ---------------------------------------------------------------------------
// Analytic terrain picking for the v2 editor.
//
// EVERY click that places or moves something raymarches the HEIGHT FIELD, never
// the rendered mesh, and that is the load-bearing decision in this file. The
// terrain under the cursor is a pooled BatchedMesh holding the CURRENT LOD
// selection: at 200 m the chunk there may be a depth-8 stand-in with 64 m cells,
// and at 2 km it may not be resident at all because the streamer has not got to
// it yet. A raycast against that geometry answers a question about the stand-in,
// so a river control point dropped at 2 km would land tens of metres from the
// ground the player can see -- and it would MOVE as she walked toward it and the
// LOD refined. `V2Height.heightAt(x, z, 0)` is the exact field everywhere at any
// range and is LOD-independent by construction, so it is the only surface an
// editor may pick against. src/measure.js reached the same conclusion for the
// measuring beam; this is that routine adapted to v2's much finer world.
//
// THE STEP SCHEDULE, and why these numbers:
//
//   step(t) = clamp(t * 0.01, 0.05 m, 64 m)
//
// The 5 cm floor is the v2-specific part. v1's measure.js floors at 1 m because
// v1's leaf CELL is 1 m and there is nothing finer to step over. v2's finest
// cell is 6.25 cm (config.js: 8192 m over MAX_DEPTH 13 is a 1 m leaf node, and a
// node holds CHUNK_RES = 16 cells) and its finest detail octave has a 25 cm
// wavelength (§18 LAMBDA_MIN), so the narrowest real feature in the field is
// ~25 cm across. A 5 cm step samples that five times, which is enough that the
// ray cannot straddle a bump and miss it. A 1 m step would step clean over the
// very ground the "down to 10 cm" claim is about -- check-v2-edit.mjs asserts
// exactly that, in both directions, on a 30 cm bump at 3.5 m.
//
// The 1%-of-range growth is the same angular argument the LOD split rule uses:
// at range t a feature smaller than ~t/100 is under a third of a degree wide and
// cannot be aimed at anyway, so sampling proportionally is not losing anything
// the mouse could have expressed. The 64 m cap bounds the worst bracket; at 1%
// growth it starts binding at t = 6.4 km, so over the 8 km world it shapes only
// the last stretch of a corner-to-corner ray.
//
// COST: 0.05 m steps out to t = 5 m is 100 samples, then 1.01^n from 5 m to the
// 6.4 km cap is ln(1280)/ln(1.01) = 719 more, then 64 m steps for the remaining
// 5.2 km of the 11585 m diagonal is 81. ~900 heightAt calls for the very longest
// ray; the gate measures 604 averaged over a sweep of angles, because most rays
// hit something before the horizon. That is a click-rate cost, and the one
// per-frame caller (the cursor readout) is capped at one pick per frame.
//
// ERROR: the coarse march brackets the crossing inside one step, at most the
// 64 m cap. BISECT = 24 halvings takes that to 64 / 2^24 = 3.8e-6 m, i.e. under
// 4 microns along the ray, and the near-field bracket (5 cm) to 3e-9 m. The
// returned point is then re-evaluated as
// `heightAt(x, z, 0)` so it sits EXACTLY on the field rather than 4 microns off
// it along the ray. The residual error is therefore the horizontal one: under
// 4 microns of XZ displacement, four orders of magnitude below the 6.25 cm cell
// this world resolves to. The gate measures 1.6e-6 m off the ray, worst case.
//
// The one thing bisection cannot fix is a bracket containing an even number of
// crossings -- a ray that clips a ridge and comes out the other side inside the
// same step. Near the camera the 5 cm floor makes that require a feature
// narrower than the field can represent. FAR from the camera it is real: at
// 3 km the step is 30 m, and a grazing ray can pass through a ridge crest
// thinner than that and report the hillside behind it instead. The gate measures
// this rather than hiding it, over a field with a 6 m ripple on a 23 m
// wavelength: inside 50 m the worst missed crossing is EXACTLY zero, from 50 m
// to 500 m it is 0.28 m, and beyond 500 m it is 5.6 m. So placement is a WALK-UP
// activity -- author near what you are authoring -- and `growth` is the lever if
// that ever bites, at a directly proportional cost in heightAt calls.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // Corner to corner of the world box (11585 m at WORLD_SIZE 8192), which is the
  // longest ray that can touch anything. v1's measure.js says a flat 8000; this
  // is the same quantity derived rather than typed, which is what keeps it right
  // across a world size that has already been restated twice mid-build.
  maxDist: Math.hypot(WORLD_SIZE, WORLD_SIZE),
  nearStep: 0.05,
  growth: 0.01,
  maxStep: 64,
  bisect: 24,
}

/**
 * March `origin + t * dir` until it crosses the height field, then bisect.
 *
 * `height` is anything with `heightAt(x, z, cell)`; it is always called with
 * cell = 0, the exact field. Returns `{x, y, z}` on the surface, or null for a
 * ray that reaches the horizon without touching ground (or one that starts
 * below it, where there is no sensible answer to give).
 */
export function raymarchGround(height, origin, dir, opts = {}) {
  const { maxDist, nearStep, growth, maxStep, bisect } = { ...DEFAULTS, ...opts }
  if (typeof height.heightAt !== 'function') throw new Error('raymarchGround: height has no heightAt(x, z, cell)')

  const len = Math.hypot(dir.x, dir.y, dir.z)
  if (!(len > 0)) throw new Error(`raymarchGround: direction has no length (${dir.x}, ${dir.y}, ${dir.z})`)
  const dx = dir.x / len
  const dy = dir.y / len
  const dz = dir.z / len

  // Signed height of the ray above the surface at parameter t. Positive is sky.
  const above = (t) => origin.y + dy * t - height.heightAt(origin.x + dx * t, origin.z + dz * t, 0)

  let prevT = Math.min(nearStep, maxDist)
  if (above(prevT) <= 0) return null

  let t = prevT
  while (t < maxDist) {
    t = Math.min(t + Math.min(maxStep, Math.max(nearStep, t * growth)), maxDist)
    if (above(t) > 0) {
      prevT = t
      continue
    }

    let lo = prevT // known above
    let hi = t // known below
    for (let i = 0; i < bisect; i++) {
      const mid = (lo + hi) * 0.5
      if (above(mid) > 0) lo = mid
      else hi = mid
    }
    const x = origin.x + dx * hi
    const z = origin.z + dz * hi
    return { x, y: height.heightAt(x, z, 0), z }
  }

  return null
}

/**
 * The world-space ray through a normalised device coordinate. Perspective only:
 * an orthographic camera needs a different construction and v2 has no such
 * camera, so an ortho one here is a wiring mistake and says so.
 */
export function screenRay(camera, ndcX, ndcY) {
  if (camera.isPerspectiveCamera !== true) throw new Error('screenRay: expects a PerspectiveCamera')
  camera.updateMatrixWorld()
  const origin = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
  const dir = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(origin).normalize()
  return { origin, dir }
}

// ---------------------------------------------------------------------------
// PROP PICKING, which is a different problem from ground picking and solved a
// different way.
//
// The ground is a field, so it can be marched. The props are forty thousand
// instances drawn by a vertex shader that spins cards to face the camera and
// cross-dissolves them between tiers -- there is no CPU-side geometry to cast
// against, and building one would cost more than the whole scatter does. What
// there IS, in every scatter module, is the same handful of public arrays:
// `tiles` (a Map of live tiles, each with `n` and `ids`), `instX/instY/instZ`,
// and an integer variant array. So this walks those directly and duck-types
// across the six systems rather than putting a sixth copy of one loop into six
// files.
//
// It is a NAMING tool and not a hit test. The readout it feeds exists so that
// "that tree is too tall" can be said as "tree 11 is too tall", and being one
// instance off inside a thicket does not cost anything. Hence the pick volumes
// below: a vertical cylinder per instance, with no attempt to follow a crown
// that leans or a log that lies across the slope. The caller's ground distance
// is a ceiling, so a hillside in front of a tree hides it exactly as it does on
// screen.
//
// WHAT THE RAY TAKES is the instance whose volume it ENTERS FIRST, and that is
// a depth test rather than a proximity one. It used to rank by closest approach
// to the instance's axis, which sounds like the same thing and is not: a ray
// grazing the near edge of a boulder passes closest to that boulder's axis
// somewhere in the middle of it, so a smaller rock standing a couple of metres
// nearer could win on that number while being nowhere near the cursor. The
// answer now is the first cylinder FACE the forward ray crosses -- the near one
// from outside, the far one when the camera is already inside the volume, which
// is the common case standing next to a tree and is the only reading of "first
// face" that does not make a tree you are leaning on unnameable.
//
// SIZED TO THE INSTANCE, NOT THE SPECIES, wherever a system has more than one
// shape. A single radius/rise pair is fine for a mushroom and hopeless for a
// rock: the bank runs from a `capslab` seven times wider than it is tall to a
// `spire` three times taller than it is wide, and instance scale spreads that
// another fifty-fold (0.16 to 8.33 over the placed beds). One constant over
// that range misses the top of the spire -- which reads as the cursor pointing
// straight THROUGH it at whatever is behind -- while claiming several metres of
// empty air above the slab. See `sizeAt`.
//
// A VOLUME THAT IS TOO BIG POINTS THROUGH ITS OWN PROP, which is the less
// obvious half of that and is what the tree constant did. Trees were a 3 m
// radius column 26 m tall -- crown-sized, applied all the way to the ground --
// and it failed in both directions at once. Standing 3.5 m from a trunk the
// ray "entered the tree" at 0.5 m, three metres of open air short of any wood.
// Standing NEARER than 3 m, which is where anyone inspecting a tree stands, the
// eye was inside the column, so by the rule below the tree ranked at its FAR
// wall, five metres away and behind the trunk -- and a fern standing between
// those two numbers won. The cursor pointed through the trunk at the fern
// behind it, and the cause was a pick volume with the trunk nowhere near its
// surface. Trees are now two cylinders, trunk and crown, off the generator's
// own published `trunkDiameter`, `firstBranchHeight` and `crownWidth`.
//
// COST is two cheap rejects per instance on the axis foot -- everything behind
// the camera and everything past whatever has already been hit, which because
// the ceiling starts at the ground range means everything the hillside is
// covering -- and then one sqrt for whatever survives them. There is no
// per-tile reject; the beds hand over their live tiles and this walks them all.
// At the panel's 4 Hz that is nothing; it is not fit for a per-frame caller and
// has no reason to be, since the readout it feeds updates at the panel's rate.
// ---------------------------------------------------------------------------

/**
 * A scatter to pick against.
 *
 * `radius` is the pick cylinder's radius and `rise` its height above the
 * instance's own y. Both are in metres at instance scale 1, the scale array
 * multiplies both where a system has one, and both are DELIBERATELY GENEROUS --
 * a pick volume that undershoots reads as a readout that does not work, while
 * one that overshoots reads as a readout that is easy to aim.
 *
 * They are a SPECIES constant, which is only honest for a system whose members
 * are one shape at one aspect. A system whose members are not gives `sizeAt`
 * instead and omits both.
 *
 * ONE INSTANCE MAY BE MORE THAN ONE SOURCE. Nothing here says a scatter appears
 * in the list once, and a shape that is not a cylinder is picked by binding it
 * twice with two `sizeAt`s: a tree is a thin trunk under a wide crown, and one
 * cylinder over both is either three metres of air around the trunk or a crown
 * that cannot be pointed at. Two sources sharing a `label` and a `nameAt` read
 * as one prop in the readout and cost one more pass over the same tiles.
 *
 * @typedef {object} PickSource
 * @property {string} label     what to call it in the readout
 * @property {object} sys       the scatter, needing tiles/instX/instY/instZ
 * @property {string} idKey     the variant array's property name on `sys`
 * @property {number} [radius]  pick radius, metres at scale 1
 * @property {number} [rise]    pick height, metres at scale 1
 * @property {string} [scaleKey] per-instance scale array, if the system has one
 * @property {(sys: object, id: number, out: {radius: number, base: number, rise: number}) => void} [sizeAt]
 *   the pick volume for ONE instance, written into `out`. Overrides
 *   radius/rise/scaleKey and is responsible for applying the instance scale
 *   itself, since a system with a real per-instance size has the measurement
 *   the scale is multiplying and this file does not. `base` is how far ABOVE
 *   the instance's own y the cylinder starts, and arrives zeroed, so a volume
 *   that stands on the ground can ignore it; it is there for the upper half of
 *   a two-part prop.
 * @property {(sys: object, id: number) => string} [nameAt] the id to QUOTE for
 *   this instance, when the raw integer is not one. A variant index is only
 *   quotable where it indexes a list the previewer also shows -- true for the
 *   scatters whose `variantAt` indexes their bank in order, false for rocks,
 *   whose `shapeAt` indexes ONE BED'S OWN ROSTER: a subset of the bank picked
 *   per environment, so the same integer means a different rock in each of the
 *   five beds and none of them means anything in /gen-rock. Such a source hands
 *   back the string the previewer would accept instead.
 */

/**
 * Scratch, so a 4 Hz readout allocates nothing. `variant` is the raw integer
 * and `name` is what to print: the same thing spelled two ways for a source
 * with no `nameAt`, and only `name` is meaningful for one with.
 */
const pickHit = { label: '', variant: 0, name: '', dist: 0 }

/** Scratch for `sizeAt`, for the same reason. */
const pickSize = { radius: 0, base: 0, rise: 0 }

/**
 * Where the forward ray first crosses the surface of the vertical cylinder of
 * radius `r` standing on (ax, ay, az) and `rise` tall. -1 for a miss.
 *
 * A cylinder and not a capsule, because the thing being approximated is a rock
 * sitting on the ground or a trunk standing on it, and both have a flat top and
 * a flat bottom in the only sense that matters here -- a capsule's domed cap
 * would put pick volume above the top of a slab, which is the failure being
 * fixed.
 *
 * `dxz` is the ray direction's squared horizontal length, hoisted by the caller
 * because it is a property of the ray and not of any instance. It is also the
 * quadratic's leading coefficient, which is why the halved-b form below is the
 * convenient one: with A = dxz the discriminant is b*b - A*c and both roots
 * divide by A.
 *
 * A CAMERA INSIDE THE VOLUME gets the far face rather than the near one, since
 * the near one is behind it. Returning a miss instead would make the readout go
 * blank exactly when the player is closest to the thing they want named.
 *
 * That fallback is only sound while the volume FITS THE PROP, and it is the
 * mechanism by which one that does not goes unnameable: an inside-the-volume
 * rank is a distance measured out the far side, so every prop between the eye
 * and that far wall outranks it. The volume must be tight enough that being
 * inside it means being inside the prop -- see the note at the top of this
 * section for the tree that was not.
 */
function cylinderEntry(origin, dir, dxz, ax, ay, az, r, rise) {
  // The ray origin measured from the axis, horizontally.
  const ox = origin.x - ax
  const oz = origin.z - az

  let tIn = -Infinity
  let tOut = Infinity

  if (dxz > 1e-12) {
    const b = ox * dir.x + oz * dir.z
    const c = ox * ox + oz * oz - r * r
    const disc = b * b - dxz * c
    if (disc < 0) return -1
    const root = Math.sqrt(disc)
    tIn = (-b - root) / dxz
    tOut = (-b + root) / dxz
  } else if (ox * ox + oz * oz > r * r) {
    // Straight up or straight down, and outside the circle: the ray never
    // enters it however far it runs. Inside the circle it always is, so the
    // height slab alone decides and tIn/tOut stay unbounded.
    return -1
  }

  if (Math.abs(dir.y) > 1e-12) {
    let ta = (ay - origin.y) / dir.y
    let tb = (ay + rise - origin.y) / dir.y
    if (ta > tb) {
      const swap = ta
      ta = tb
      tb = swap
    }
    if (ta > tIn) tIn = ta
    if (tb < tOut) tOut = tb
  } else if (origin.y < ay || origin.y > ay + rise) {
    // Dead level, and above or below the slab: never enters.
    return -1
  }

  if (tOut < 0 || tIn > tOut) return -1
  return tIn > 0 ? tIn : tOut
}

/**
 * The nearest prop whose pick volume the ray enters, or null.
 *
 * `maxDist` is normally the range to the ground under the cursor: props beyond
 * it are behind the hill and must not be reported. Pass Infinity to ignore the
 * terrain.
 *
 * Returns a SHARED object -- read it before the next call. That is the same
 * bargain the scatter's own stats objects make, and for the same reason.
 *
 * @param {PickSource[]} sources
 * @param {{x: number, y: number, z: number}} origin
 * @param {{x: number, y: number, z: number}} dir  unit length
 * @param {number} maxDist
 */
export function pickProp(sources, origin, dir, maxDist) {
  let bestT = maxDist
  let best = null

  // Order matters only for cost, not for the answer: whichever source is walked
  // first pulls bestT in and makes every later source's reject bite harder.
  for (const src of sources) {
    const sys = src.sys
    // LOUDLY. This used to `continue`, and that is how rocks went unnameable
    // without anyone noticing: `Rocks` is a facade over five `RockBed`s and
    // keeps none of these arrays itself, so the source bound to it failed the
    // duck-type and was skipped in silence. A readout that prints nothing looks
    // identical to a ray that hit nothing, so the skip cost nothing to write and
    // hid the bug for as long as it existed. A source with no tiles is a wiring
    // mistake and there is no case where quietly naming one fewer system is the
    // wanted behaviour.
    if (!sys) throw new Error(`pickProp: ${src.label} has no scatter bound`)
    if (!sys.tiles) throw new Error(`pickProp: ${src.label} has no tiles -- bind the sub-scatter that owns them, not the facade over it`)
    const scales = src.scaleKey ? sys[src.scaleKey] : null
    const ids = sys[src.idKey]
    if (!ids) throw new Error(`pickProp: ${src.label} has no ${src.idKey}`)
    if (!src.sizeAt && !(src.radius > 0 && src.rise > 0)) {
      throw new Error(`pickProp: ${src.label} has neither a sizeAt nor a positive radius and rise`)
    }

    // The ray's squared horizontal length: a property of the ray, not of any
    // instance, and the leading coefficient of every cylinder solve below.
    const dxz = dir.x * dir.x + dir.z * dir.z

    for (const tile of sys.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const ax = sys.instX[id]
        let ay = sys.instY[id]
        const az = sys.instZ[id]

        let r
        let rise
        if (src.sizeAt) {
          // Zeroed, not left as the last instance's: a `sizeAt` that only
          // sometimes writes `base` would otherwise inherit a neighbour's.
          pickSize.base = 0
          src.sizeAt(sys, id, pickSize)
          r = pickSize.radius
          rise = pickSize.rise
          ay += pickSize.base
        } else {
          const scale = scales === null ? 1 : scales[id]
          r = src.radius * scale
          rise = src.rise * scale
        }

        // Reject on the foot of the axis before the quadratic. Six multiplies,
        // and it throws out everything behind the camera and everything past
        // whatever has already been hit -- which, because bestT starts at the
        // ground range, means everything the hillside is covering. The `reach`
        // slack is the volume's own half-extent: an instance whose FOOT is a
        // little behind the camera, or a little past the current best, can
        // still have body in front of one or nearer than the other, and the
        // old bare `foot <= 0` quietly dropped exactly the rocks the player was
        // standing over.
        const foot = dir.x * (ax - origin.x) + dir.y * (ay - origin.y) + dir.z * (az - origin.z)
        const reach = r + rise
        if (foot <= -reach) continue
        if (foot >= bestT + reach) continue

        const t = cylinderEntry(origin, dir, dxz, ax, ay, az, r, rise)
        if (t < 0 || t >= bestT) continue

        bestT = t
        best = src
        pickHit.label = src.label
        pickHit.variant = ids[id]
        pickHit.name = src.nameAt ? src.nameAt(sys, id) : String(ids[id])
        pickHit.dist = t
      }
    }
  }

  return best === null ? null : pickHit
}

/**
 * Pointer event -> NDC against the element the event was aimed at. Uses the
 * canvas rect rather than the window, because the canvas is not the whole page
 * once the panel is on screen and an off-by-a-panel-width pick is the kind of
 * bug that looks like the raymarch is wrong.
 */
export function pointerNdc(ev, domElement) {
  const r = domElement.getBoundingClientRect()
  return {
    x: ((ev.clientX - r.left) / r.width) * 2 - 1,
    y: -((ev.clientY - r.top) / r.height) * 2 + 1,
  }
}
