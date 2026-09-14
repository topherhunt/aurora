/**
 * Turn a gait spec into per-joint rotation tracks.
 *
 * A spec is written in terms an animator can reason about -- stride, duty
 * factor, footfall phase, step height, body bob -- rather than in quaternions.
 * Footfall phase is what separates the gaits: a walk is four beats evenly
 * spread, a trot is diagonal pairs together.
 *
 * FEET ARE DRIVEN BY POSITION, LIMBS BY IK; everything else (spine, neck, tail)
 * is forward kinematics on sinusoids phase-locked to the gait. That split is the
 * whole point. A leg posed by rotating its joints slides its foot along the
 * ground, and foot slide is the loudest tell of bad quadruped animation.
 *
 * Cycles are IN PLACE -- the ground moves under a stationary animal, which is
 * what a game engine wants and what the bench previews. The forward speed that
 * implies is `stride / (duty * duration)`, and `diagnose()` uses it to check that
 * a planted foot is genuinely still in the ground's frame.
 */

import {
  add, compose, cross, decompose, dot, invert, len, loadSkeleton, mul, norm,
  qAxisAngle, qBetween, qConj, qMul, qRotate, scale, sub, xformDir,
} from './skeleton.mjs'

const TAU = Math.PI * 2
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
const wrap01 = (v) => ((v % 1) + 1) % 1

// --- posing -----------------------------------------------------------------

/**
 * A skeleton with local rotations overridden joint by joint, plus one world
 * offset on the root. World transforms are rebuilt from scratch whenever
 * anything changes: the hierarchy is a few dozen joints, so the simple thing is
 * fast enough and cannot go stale mid-solve.
 */
export function poser(skel) {
  const local = new Map()
  const roots = skel.joints.filter((j) => !skel.isJoint.has(skel.parent.get(j)))
  // Where each root joint's parent chain puts it. Non-joint nodes above the
  // skeleton (the armature's own transform) are part of the bind and stay fixed.
  const above = new Map(roots.map((r) => {
    const p = skel.parent.get(r)
    return [r, p === undefined ? IDENTITY : skel.world(p)]
  }))
  let offset = [0, 0, 0]
  let cache = null

  const localMatrix = (j) => {
    const rest = decompose(skel.restLocal(j))
    const q = local.get(j) ?? rest.rotation
    // A world offset on the root has to be expressed in the root's parent space,
    // which is also the space glTF's translation channel is written in.
    const t = above.has(j) ? add(rest.translation, xformDir(invert(above.get(j)), offset)) : rest.translation
    return compose(t, q, rest.scale)
  }

  const rebuild = () => {
    cache = new Map()
    const visit = (j, parentWorld) => {
      const m = mul(parentWorld, localMatrix(j))
      cache.set(j, m)
      for (const c of skel.childrenOf(j)) visit(c, m)
    }
    for (const r of roots) visit(r, above.get(r))
  }

  const api = {
    roots,
    setLocal(j, q) { local.set(j, q); cache = null },
    /** Move the whole skeleton by a world-space vector. */
    setOffset(v) { offset = v; cache = null },
    world(j) { if (!cache) rebuild(); return cache.get(j) },
    pos(j) { const m = api.world(j); return [m[9], m[10], m[11]] },
    rotation(j) { return decompose(api.world(j)).rotation },
    localRotation(j) { return local.get(j) ?? decompose(skel.restLocal(j)).rotation },
    localTranslation(j) { return decompose(localMatrix(j)).translation },
    /** Rotate joint `j` by `delta` about its own origin, `delta` given in world space. */
    rotateWorld(j, delta) {
      const p = skel.parent.get(j)
      const pr = skel.isJoint.has(p) ? api.rotation(p) : decompose(above.get(j)).rotation
      // local' = inv(Rparent) * delta * Rparent * local
      api.setLocal(j, qMul(qMul(qMul(qConj(pr), delta), pr), api.localRotation(j)))
    },
    posed() { return local },
  }
  return api
}

// --- limbs ------------------------------------------------------------------
//
// A quadruped leg is NOT a two-bone chain. The fox's hind leg zig-zags -- the
// stifle bends forward 31 degrees and the hock bends back 44 -- and an analytic
// two-bone solve has to pick one of those and flatten the other, which turns a
// fox leg into a dog-toy leg. So the solver is CCD over the whole chain with
// every interior joint pinned to the hinge axis it already has in the rest pose.
//
// The hinge constraint is what does the work. Because both the axis and the
// positive direction come from the rest pose, a joint can only bend the way it
// already bends: no knee inverts, no hock folds forward, and none of it depends
// on naming a joint "knee" or on a pole vector that a near-straight leg cannot
// supply. Chain length stops mattering too, which matters because Tripo gives
// the fox three bones in front and four behind.

/**
 * Joint limits, in radians: how far past its rest bend a joint may fold, how far
 * it may straighten back out, and how far the whole leg may swing off its rest
 * direction at the hip. Fold has to be generous -- a swing foot lifting clear of
 * the ground folds the hock hard, and a tight limit silently truncates the step
 * arc rather than failing. `solveLimb` takes overrides for a pose, like a sit,
 * that swings a leg further off its rest direction than any gait does.
 */
const FOLD_LIMIT = 1.9
const STRAIGHTEN = 0.85
const HIP_LIMIT = 0.95

const projectPerp = (v, axis) => sub(v, scale(axis, dot(v, axis)))
const signedAngle = (a, b, axis) => Math.atan2(dot(cross(a, b), axis), dot(a, b))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Everything the IK needs about one leg, measured once from the rest pose.
 *
 * `hinge[i]` is joint i's bend axis in its OWN frame, so it rides along when the
 * spine bends or the hip swings. `restBend[i]` is how far it is already bent,
 * which sets how far it is allowed to straighten back out.
 */
export function limbSetup(skel, legMap, byName) {
  const chain = legMap.chain.map((n) => {
    const j = byName.get(n)
    if (j === undefined) throw new Error(`rig map names joint "${n}", which this rig does not have`)
    return j
  })
  if (chain.length < 3) throw new Error(`leg ${legMap.id} has ${chain.length} joints, need at least 3`)

  const P = chain.map(skel.pos)
  const hinge = [], restBend = []
  for (let i = 1; i < chain.length - 1; i++) {
    const a = sub(P[i], P[i - 1]), b = sub(P[i + 1], P[i])
    if (len(a) < 1e-6 || len(b) < 1e-6) throw new Error(`leg ${legMap.id} has a zero-length bone at ${skel.name(chain[i])}`)
    const da = norm(a), db = norm(b)
    const axis = cross(da, db)
    if (len(axis) < 1e-4) {
      // A dead-straight joint has no bend axis to preserve. Hinging it about an
      // arbitrary axis is worse than leaving it rigid, so it just holds.
      hinge[i] = null
      restBend[i] = 0
      continue
    }
    const worldRot = decompose(skel.world(chain[i])).rotation
    hinge[i] = qRotate(qConj(worldRot), norm(axis))
    restBend[i] = Math.acos(clamp(dot(da, db), -1, 1))
  }

  const hip = chain[0], foot = chain[chain.length - 1]
  // The rest hip->foot direction, held in the hip's PARENT frame so the hip's
  // own swing does not move the reference that swing is measured against. A leg
  // hanging straight off the skeleton root has no posable parent, so the
  // reference is simply fixed in world space.
  const parent = skel.parent.get(hip)
  const parentIsJoint = skel.isJoint.has(parent)
  const parentRot = parent === undefined ? [0, 0, 0, 1] : decompose(skel.world(parent)).rotation
  let reach = 0
  for (let i = 1; i < P.length; i++) reach += len(sub(P[i], P[i - 1]))
  return {
    id: legMap.id, chain, hip, foot, hinge, restBend, parent, parentIsJoint, reach,
    restFoot: P[P.length - 1],
    footRest: decompose(skel.world(foot)).rotation,
    restDirLocal: qRotate(qConj(parentRot), norm(sub(P[P.length - 1], P[0]))),
  }
}

/**
 * Place `limb`'s foot on `target` by cyclic coordinate descent. Sixteen passes
 * puts the residual under a millimetre on a fox-sized leg, which `diagnose`
 * measures rather than assumes; a target genuinely out of reach stops at the
 * nearest pose the joint limits allow instead of straining for it.
 *
 * `pitch` tilts the paw about `pitchAxis` once the leg is placed -- the body's
 * lateral axis, for toe-off and heel strike. `fold`/`straighten`/`hipLimit`
 * override the walking joint limits for a pose that needs more range.
 */
export function solveLimb(pose, limb, target, {
  iterations = 16, pitch = 0, pitchAxis = null,
  fold = FOLD_LIMIT, straighten = STRAIGHTEN, hipLimit = HIP_LIMIT,
} = {}) {
  const { chain, foot } = limb
  const applied = new Array(chain.length).fill(0)

  // Root outward, not the textbook foot-inward order. Swinging the hip first
  // puts the leg roughly where it belongs and leaves the small joints a small
  // correction; going foot-first lets the hock straighten into its stop chasing
  // a target the hip should have covered, and then it is wedged there.
  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < chain.length - 1; i++) {
      const j = chain[i]
      const at = pose.pos(j)
      const cur = sub(pose.pos(foot), at)
      const want = sub(target, at)
      if (len(cur) < 1e-9 || len(want) < 1e-9) continue

      if (i === 0) {
        // The hip is a ball joint, limited to a cone about its rest direction so
        // a far target cannot pull the whole leg out of its socket.
        const ref = limb.parentIsJoint
          ? qRotate(pose.rotation(limb.parent), limb.restDirLocal) : limb.restDirLocal
        let goal = norm(want)
        const off = Math.acos(clamp(dot(ref, goal), -1, 1))
        if (off > hipLimit) goal = qRotate(qAxisAngle(cross(ref, goal), hipLimit), ref)
        pose.rotateWorld(j, qBetween(cur, goal))
        continue
      }
      if (!limb.hinge[i]) continue

      const axis = qRotate(pose.rotation(j), limb.hinge[i])
      const a = projectPerp(cur, axis), b = projectPerp(want, axis)
      if (len(a) < 1e-9 || len(b) < 1e-9) continue
      const wanted = signedAngle(norm(a), norm(b), axis)
      const next = clamp(applied[i] + wanted, -limb.restBend[i] * straighten, fold)
      const step = next - applied[i]
      if (Math.abs(step) < 1e-9) continue
      applied[i] = next
      pose.rotateWorld(j, qAxisAngle(axis, step))
    }
  }

  // Level the paw. It is the chain's leaf, so nothing downstream depends on its
  // rotation -- but left alone it inherits every correction the carpus made, and
  // the toe swings up or ploughs into the ground through the step. `pitch` tilts
  // it about the body's lateral axis for toe-off. rotateWorld pre-multiplies the
  // world rotation, so the delta that lands on a target T is T * inv(current).
  const want = pitch ? qMul(qAxisAngle(pitchAxis, pitch), limb.footRest) : limb.footRest
  pose.rotateWorld(foot, qMul(want, qConj(pose.rotation(foot))))
  return applied
}

// --- the gait ---------------------------------------------------------------

/**
 * Where one foot sits at phase `p` in [0,1): an offset along the body's forward
 * axis and a lift above the ground.
 *
 * Stance is LINEAR by construction. The body advances at constant speed, so only
 * a linear stance keeps a planted foot still in the ground's frame; easing it
 * would look smoother in isolation and slide visibly in motion.
 */
export function footAt(p, { stride, duty, stepHeight, toeOff = 0 }) {
  if (p < duty) {
    const u = p / duty
    // The paw stays flat for most of the stance and the heel only comes up at
    // the end. Rolling it from the moment the foot lands instead puts the animal
    // on tiptoe for the whole step.
    return { fore: stride * (0.5 - u), lift: 0, planted: true, pitch: toeOff * smooth(clamp01((u - 0.55) / 0.45)) }
  }
  const u = (p - duty) / (1 - duty)
  return {
    fore: stride * (u - 0.5),
    lift: stepHeight * Math.sin(Math.PI * u),
    planted: false,
    // Level early in the swing, so the paw is flat well before it lands.
    pitch: toeOff * (1 - smooth(clamp01(u / 0.35))),
  }
}

const smooth = (u) => u * u * (3 - 2 * u)
const clamp01 = (u) => Math.min(1, Math.max(0, u))

/**
 * Spread a total angle over a chain, so no one joint takes a visible crease.
 * Each joint inherits its parent's share as well as its own, so the tip receives
 * the whole angle and the base only a fraction: a curl, not a rigid swing.
 *
 * Sign follows the chain, not the body. Positive about the lateral axis pitches
 * a chain that points FORWARD -- the spine, the neck -- downward. A tail points
 * backward, so the same positive number lifts it.
 */
export function bend(pose, chain, axis, total) {
  if (!total || !chain.length) return
  for (const j of chain) pose.rotateWorld(j, qAxisAngle(axis, total / chain.length))
}

/**
 * Give every joint a clip drives an entry for this frame, even one the frame
 * leaves at its rest rotation. Without it a keyframe that happens to be zero --
 * the first key of a sit, say -- writes no rotation, and the track comes out a
 * sample short of the times it is sampled against.
 */
export function seed(pose, joints) {
  for (const j of joints) pose.setLocal(j, pose.localRotation(j))
}

const DEFAULTS = {
  duration: 1, samples: 24, stride: 0.55, stepHeight: 0.12, duty: 0.62,
  // Tripo binds a creature standing at nearly full leg extension -- the fox has
  // 4mm of slack in a 355mm leg -- so a stride reaches past what the limb can
  // do and the foot skates. Dropping the body first is what buys the bend back,
  // which is why this defaults to a real value rather than zero.
  crouch: 0.045, toeOff: 0.3,
  // A walk and a trot rise twice per cycle, once under each diagonal pair; a
  // gallop rises once, on the single suspension, which is what `bobFreq` is for.
  bodyBob: 0, bobFreq: 2, bodySway: 0,
  spineYaw: 0, spineRoll: 0, spineFlex: 0,
  tailSway: 0, tailLift: 0, headBob: 0, headYaw: 0, headYawPhase: 0,
  // Constant carriage, applied before the waves. A Tripo bind pose is whatever
  // the generator felt like -- the fox's tail lies on the ground, where it hides
  // the hind legs -- so a clip has to state the posture it wants.
  spinePitch: 0, headPitch: 0, tailPitch: 0,
  // Overrides for the IK joint limits -- see `solveLimb`. A fast gait folds a
  // leg harder than a walk does.
  limits: {},
}

export function solveClip(rigFile, map, rawSpec) {
  const spec = { ...DEFAULTS, ...rawSpec }
  const skel = loadSkeleton(rigFile)
  const byName = new Map(skel.joints.map((j) => [skel.name(j), j]))
  const named = (names) => (names ?? []).map((n) => byName.get(n)).filter((j) => j !== undefined)

  const { forward: fwd, lateral: lat } = map.frame
  const up = [0, 1, 0]
  const stride = spec.stride * map.wheelbase
  const stepHeight = spec.stepHeight * map.height

  const legs = map.legs.map((l) => ({
    ...limbSetup(skel, l, byName),
    phase: spec.phases?.[l.id] ?? 0,
  }))
  const spine = named(map.spine)
  const head = named(map.head)
  const tail = named(map.tail)
  const driven = [...spine, ...head, ...tail, ...legs.flatMap((l) => l.chain)]

  const n = spec.samples
  const times = []
  const tracks = new Map()
  const frames = []
  const rootTranslations = []
  let root = null

  for (let i = 0; i <= n; i++) {
    const u = i / n
    times.push(u * spec.duration)
    const pose = poser(skel)
    seed(pose, driven)
    if (root === null) root = pose.roots[0]

    // Body: the standing crouch, a vertical bob at twice the stride rate -- each
    // diagonal pair passes under the body once per half cycle -- and a lateral
    // sway at the stride rate.
    const bob = Math.cos(TAU * u * spec.bobFreq) * spec.bodyBob * map.height - spec.crouch * map.height
    const sway = Math.sin(TAU * u) * spec.bodySway * map.height
    pose.setOffset(add(scale(up, bob), scale(lat, sway)))

    // Spine, neck and tail: FK sinusoids phase-locked to the gait. Each joint in
    // a chain lags the one before it, which is what reads as follow-through.
    const wave = (list, amp, axis, freq, lagPer, phase = 0) => {
      if (!amp || !list.length) return
      list.forEach((j, k) => {
        const a = Math.sin(TAU * u * freq - k * lagPer + phase) * amp / list.length
        pose.rotateWorld(j, qAxisAngle(axis, a))
      })
    }
    bend(pose, spine, lat, spec.spinePitch)
    bend(pose, head, lat, spec.headPitch)
    bend(pose, tail, lat, spec.tailPitch)
    wave(spine, spec.spineYaw, up, 1, 0.4)
    wave(spine, spec.spineRoll, fwd, 2, 0.3)
    // Back flexion: negligible at a walk, and the whole engine of a gallop.
    wave(spine, spec.spineFlex, lat, 1, 0.25)
    wave(tail, spec.tailSway, up, 1, 0.8, Math.PI)
    wave(tail, spec.tailLift, lat, 2, 0.6)
    wave(head, spec.headBob, lat, 2, 0.5)
    wave(head, spec.headYaw, up, 1, 0.5, spec.headYawPhase)

    // Legs last: they reach a world-space target, so everything that moves a
    // shoulder has to already be in place before the IK runs.
    const feet = []
    for (const leg of legs) {
      const f = footAt(wrap01(u + leg.phase), { stride, duty: spec.duty, stepHeight, toeOff: spec.toeOff })
      const target = add(add(leg.restFoot, scale(fwd, f.fore)), scale(up, f.lift))
      solveLimb(pose, leg, target, { ...spec.limits, pitch: f.pitch, pitchAxis: lat })
      feet.push({ id: leg.id, target, planted: f.planted, actual: pose.pos(leg.foot) })
    }

    for (const [j, q] of pose.posed()) {
      if (!tracks.has(j)) tracks.set(j, [])
      tracks.get(j).push(...q)
    }
    rootTranslations.push(...pose.localTranslation(root))
    frames.push({ u, t: u * spec.duration, bob, sway, feet })
  }

  // A joint only some frames touched would write a short track, which glTF
  // cannot represent. Nothing in the loop above is conditional on the frame, so
  // this firing means a leg or a wave silently skipped a sample.
  for (const [j, q] of tracks) {
    if (q.length !== (n + 1) * 4) {
      throw new Error(`joint ${skel.name(j)} got ${q.length / 4} of ${n + 1} samples`)
    }
  }

  return { skel, map, spec, times, tracks, root, rootTranslations, frames, legs, stride, stepHeight }
}

// --- checking ---------------------------------------------------------------

/**
 * Numbers that say whether a solved clip is any good, for the gate and for
 * deciding what to change before re-rendering a sheet.
 *
 * `stanceSlide` is the one that matters. The clip runs in place, so in the
 * ground's frame a planted foot travels forward at `stride / (duty * duration)`;
 * subtracting that motion leaves a number that should be zero. It catches both
 * IK error and a stance curve that is not linear.
 */
export function diagnose(solved) {
  const { frames, map, spec, stride, times } = solved
  const fwd = map.frame.forward
  const speed = stride / (spec.duty * spec.duration)

  // Stance and swing residuals are different facts. A stance foot that misses
  // its target is skating; a swing foot that misses one just did not lift as far
  // as the spec asked, because the leg ran out of leg. Only the first is a bug.
  let ikStance = 0, ikSwing = 0, lowest = Infinity, stanceFloat = 0
  const settled = new Map()
  for (let i = 0; i < frames.length; i++) {
    for (const f of frames[i].feet) {
      const miss = len(sub(f.actual, f.target))
      if (f.planted) ikStance = Math.max(ikStance, miss)
      else ikSwing = Math.max(ikSwing, miss)
      lowest = Math.min(lowest, f.actual[1])
      if (!f.planted) continue
      stanceFloat = Math.max(stanceFloat, f.actual[1] - map.ground)
      // Undo the ground's motion, so a correctly planted foot holds still.
      if (!settled.has(f.id)) settled.set(f.id, [])
      settled.get(f.id).push({ i, p: add(f.actual, scale(fwd, speed * times[i])) })
    }
  }

  // Only compare samples from ADJACENT frames: the jump between the end of one
  // stance and the start of the next is the swing the foot took in between, not
  // a slip, and measuring it would swamp the number this is trying to report.
  let stanceSlide = 0
  for (const pts of settled.values()) {
    for (let k = 1; k < pts.length; k++) {
      if (pts[k].i !== pts[k - 1].i + 1) continue
      stanceSlide = Math.max(stanceSlide, len(sub(pts[k].p, pts[k - 1].p)))
    }
  }

  // The loop point: sample 0 and sample n are the same phase, so every track
  // must come back where it started or the clip pops once per cycle.
  let loopGap = 0
  for (const q of solved.tracks.values()) {
    const a = q.slice(0, 4), b = q.slice(q.length - 4)
    const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
    loopGap = Math.max(loopGap, 2 * Math.acos(Math.min(1, d)))
  }

  return {
    speed,
    ikStance,
    ikSwing,
    stanceSlide,
    // Below the map's ground plane is a foot through the floor; a stance foot
    // measurably above it is the animal skating on air.
    penetration: Math.max(0, map.ground - lowest),
    stanceFloat,
    loopGap,
  }
}
