import * as THREE from 'three'

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
