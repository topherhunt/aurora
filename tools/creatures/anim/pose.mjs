/**
 * Clips built from hand-authored keyframes rather than a footfall cycle.
 *
 * Sitting and lying down have no gait to synthesise -- there is no stride, no
 * duty factor, no phase offset, just a body that goes from one shape to another.
 * So they are written as a handful of key poses and interpolated.
 *
 * A pose is deliberately a SMALL VOCABULARY of body-frame scalars, not joint
 * rotations: a rig map gives the same handles on any quadruped, and a spec
 * written in `{ spine: { pitch } }` works on a fox and a stag while one written
 * in quaternions for `bone_14` works on neither. The feet still go through IK,
 * which is what keeps a sitting animal's front paws on the ground instead of
 * hovering wherever the hip rotation left them.
 *
 * Handles, all optional, all relative so they carry across body sizes:
 *   root   lift, fore, lat    fractions of height / wheelbase
 *          pitch, yaw, roll   radians, the whole body turned about its hips
 *   spine  pitch, yaw, roll   radians, spread along the chain
 *   head   pitch, yaw, roll   radians, spread along the neck
 *   tail   pitch, yaw, curl   radians, spread along the tail
 *   wings  spread, sweep      radians, mirrored across the pair
 *          tuck               radians, turned about forward AFTER the sweep: rolls a
 *                             wing swept back flat against the flank, which
 *                             spread cannot, being applied before it
 *   arms   pitch, spread      radians, mirrored across the pair
 *          left, right, both  per-arm handles for a jointed arm, see arm.mjs;
 *                             `both` is added to each side
 *   legs   <legId>: { fore, lat, lift, pitch }  foot target offset, paw tilt
 *          under              0..1, unscaled: slides the base the offsets are
 *                             measured from, fore-aft, from the rest foot to
 *                             under the leg's top joint. A fold-down places the
 *                             foot against the shoulder; a mesh standing
 *                             mid-stride would otherwise fold each leg differently
 *          ground             0..1, unscaled: lowers that base to the rig's ground.
 *                             A no-op where the foot joint is a hoof; a hare's
 *                             hind foot joint is its ankle, 16cm up
 *
 * `crouch` drops the body by a fraction of height on every key, as a gait's
 * does, so a pose clip stands at the same height as the idle it cuts from.
 *
 * `unweighted: [legId, ...]` names feet that are not carrying the animal, which
 * is what a dig needs: the forepaws work at ground level without standing on it.
 *
 * `scale: { <group>: <number> }` dials one group of handles down (or up) for one
 * body, defaulting to 1 so a spec that omits it is unchanged. A shared spec is
 * relative, so it mostly carries across animals -- but only mostly, and where it
 * does not the mismatch is confined to a group. Foot offsets go by `wheelbase`,
 * right for a gait but too far for a fold-down on a long body: a hare does not
 * stretch its forepaws twice as far ahead as a fox just because its body is
 * twice as long, it stretches them as far as its legs go. Tail angles are the
 * same story the other way -- the fox's sit sweeps its tail 2 radians, which a
 * hare's short thick tail turns inside out at the base.
 */

import { add, dot, loadSkeleton, qAxisAngle, qMul, qRotate, scale, sub } from './skeleton.mjs'
import { armsOf, bend, contactOf, limbSetup, pairsOf, poser, seed, solveLimb } from './gait.mjs'
import { ARM_HANDLES, poseArm } from './arm.mjs'

const ZERO = { lift: 0, fore: 0, lat: 0, pitch: 0, yaw: 0, roll: 0, curl: 0 }

/** Ease between keys. Linear interpolation of a body shape reads as robotic. */
const smooth = (u) => u * u * (3 - 2 * u)

/** The value of one handle at time `t`, from the keys that bracket it. */
function sample(keys, t, pick) {
  if (t <= keys[0].t) return pick(keys[0])
  const last = keys[keys.length - 1]
  if (t >= last.t) return pick(last)
  let i = 0
  while (keys[i + 1].t < t) i++
  const a = keys[i], b = keys[i + 1]
  const u = smooth((t - a.t) / (b.t - a.t))
  const va = pick(a), vb = pick(b)
  return va + (vb - va) * u
}

export function poseClip(rigFile, map, rawSpec) {
  const spec = { samples: 30, crouch: 0, ...rawSpec }
  if (!Array.isArray(spec.keys) || spec.keys.length < 2) {
    throw new Error('a pose clip needs at least two keys')
  }
  const keys = spec.keys.map((k) => ({ ...k, pose: k.pose ?? {} }))
  for (let i = 1; i < keys.length; i++) {
    if (!(keys[i].t > keys[i - 1].t)) throw new Error(`pose keys must ascend in time, got ${keys[i - 1].t} then ${keys[i].t}`)
  }
  const duration = spec.duration ?? keys[keys.length - 1].t

  const skel = loadSkeleton(rigFile)
  const byName = new Map(skel.joints.map((j) => [skel.name(j), j]))
  const named = (names) => (names ?? []).map((n) => byName.get(n)).filter((j) => j !== undefined)
  const { forward: fwd, lateral: lat } = map.frame
  const up = [0, 1, 0]

  // A sit folds a hind leg further than any gait does, so a pose spec may widen
  // the IK's joint limits: `limits: { fold, straighten, hipLimit }` in radians.
  const limits = spec.limits ?? {}
  const legs = map.legs.map((l) => limbSetup(skel, l, byName))
  const spine = named(map.spine)
  const head = named(map.head)
  const tail = named(map.tail)
  const wings = pairsOf(map, 'wings', named)
  const arms = armsOf(map, skel, byName, named)
  const driven = [...spine, ...head, ...tail, ...legs.flatMap((l) => l.chain),
    ...wings.flatMap((w) => w.chain), ...arms.plain.flatMap((a) => a.chain),
    ...arms.jointed.flatMap((a) => a.chain)]
  // The whole body turns about the hips, not about the root joint: Tripo puts a
  // human's root on the ground between the feet, and a lie-down pivoted there
  // would swing the torso through the floor.
  const pivot = scale(legs.reduce((s, l) => add(s, skel.pos(l.hip)), [0, 0, 0]), 1 / Math.max(1, legs.length))

  // One getter per handle, so `sample` never has to know the spec's shape and a
  // key that omits a group simply reads zero.
  const scaleOf = spec.scale ?? {}
  const at = (t, group, field) => sample(keys, t, (k) => (k.pose[group] ?? ZERO)[field] ?? 0) * (scaleOf[group] ?? 1)
  const legAt = (t, id, field) => sample(keys, t, (k) => ((k.pose.legs ?? {})[id] ?? ZERO)[field] ?? 0) * (scaleOf.legs ?? 1)
  const armAt = (t, which, field) => sample(keys, t, (k) => ((k.pose.arms ?? {})[which] ?? ZERO)[field] ?? 0) * (scaleOf.arms ?? 1)
  // Feet this clip declares are not carrying the animal. A digging forepaw rakes
  // backwards through the dirt at its own rest height, so by geometry it is
  // planted -- but it bears no weight, and scoring it as stance reports the
  // intended stroke as skating. The hind feet still have to hold still.
  const unweighted = new Set(spec.unweighted ?? [])

  const n = spec.samples
  const times = []
  const tracks = new Map()
  const frames = []
  const rootTranslations = []
  let root = null

  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration
    times.push(t)
    const pose = poser(skel)
    if (root === null) root = pose.roots[0]
    // The root is a track like any other once a key turns it, so every frame
    // has to carry it, including the ones where the turn is zero.
    seed(pose, [root, ...driven])

    let offset = add(add(
      scale(up, (at(t, 'root', 'lift') - spec.crouch) * map.height),
      scale(fwd, at(t, 'root', 'fore') * map.wheelbase)),
      scale(lat, at(t, 'root', 'lat') * map.wheelbase))
    // Turning the root joint turns everything about the root's own origin, so
    // the offset also carries the hips back to where they were.
    const turn = qMul(qMul(
      qAxisAngle(fwd, at(t, 'root', 'roll')),
      qAxisAngle(up, at(t, 'root', 'yaw'))),
      qAxisAngle(lat, at(t, 'root', 'pitch')))
    if (turn[3] < 1) {
      pose.rotateWorld(root, turn)
      const arm = sub(pivot, pose.pos(root))
      offset = add(offset, sub(arm, qRotate(turn, arm)))
    }
    pose.setOffset(offset)

    bend(pose, spine, lat, at(t, 'spine', 'pitch'))
    bend(pose, spine, up, at(t, 'spine', 'yaw'))
    bend(pose, spine, fwd, at(t, 'spine', 'roll'))
    bend(pose, head, lat, at(t, 'head', 'pitch'))
    bend(pose, head, up, at(t, 'head', 'yaw'))
    bend(pose, head, fwd, at(t, 'head', 'roll'))
    bend(pose, tail, lat, at(t, 'tail', 'pitch') + at(t, 'tail', 'curl'))
    bend(pose, tail, up, at(t, 'tail', 'yaw'))
    // Mirrored pairs: one number opens or sweeps both, the map's `side` negating
    // whichever has to turn the other way. See `pairsOf` in gait.mjs.
    for (const w of wings) {
      bend(pose, w.chain, fwd, at(t, 'wings', 'spread') * w.side)
      bend(pose, w.chain, up, at(t, 'wings', 'sweep') * w.side)
      bend(pose, w.chain, fwd, at(t, 'wings', 'tuck') * w.side)
    }
    for (const a of arms.plain) {
      bend(pose, a.chain, lat, at(t, 'arms', 'pitch'))
      bend(pose, a.chain, fwd, at(t, 'arms', 'spread') * a.side)
    }
    for (const a of arms.jointed) {
      const which = a.side > 0 ? 'left' : 'right'
      const h = {}
      for (const f of ARM_HANDLES) h[f] = armAt(t, 'both', f) + armAt(t, which, f)
      poseArm(pose, a, h, map.frame)
    }

    const feet = []
    for (const leg of legs) {
      const under = sample(keys, t, (k) => ((k.pose.legs ?? {})[leg.id] ?? ZERO).under ?? 0)
      const drop = sample(keys, t, (k) => ((k.pose.legs ?? {})[leg.id] ?? ZERO).ground ?? 0) * (map.ground - leg.restFoot[1])
      const base = add(add(leg.restFoot, scale(fwd, under * dot(sub(skel.pos(leg.hip), leg.restFoot), fwd))), scale(up, drop))
      const target = add(add(add(base,
        scale(fwd, legAt(t, leg.id, 'fore') * map.wheelbase)),
        scale(lat, legAt(t, leg.id, 'lat') * map.wheelbase)),
        scale(up, legAt(t, leg.id, 'lift') * map.height))
      solveLimb(pose, leg, target, { ...limits, pitch: legAt(t, leg.id, 'pitch'), pitchAxis: lat })
      // A pose clip has no swing, so every foot is load-bearing unless the spec
      // deliberately lifted it. Measured against the leg's OWN rest foot, lowered
      // only by the spec's `ground`, not a single ground plane: `map.ground` is
      // the lowest joint in the rig, while a foot joint sits wherever the rigger
      // put it -- the hare's hind pair are ankles 16cm up -- so against one plane
      // a leg reads permanently airborne and drops out of the slide check.
      const planted = !unweighted.has(leg.id) && target[1] - leg.restFoot[1] - drop < 1e-4
      feet.push({ id: leg.id, target, planted, actual: pose.pos(leg.foot), contact: contactOf(pose, leg), floor: leg.restContact[1] + drop })
    }

    for (const [j, q] of pose.posed()) {
      if (!tracks.has(j)) tracks.set(j, [])
      tracks.get(j).push(...q)
    }
    rootTranslations.push(...pose.localTranslation(root))
    frames.push({ u: i / n, t, bob: 0, sway: 0, feet })
  }

  for (const [j, q] of tracks) {
    if (q.length !== (n + 1) * 4) throw new Error(`joint ${skel.name(j)} got ${q.length / 4} of ${n + 1} samples`)
  }

  // `diagnose` measures against a ground that slides backward, which a pose clip
  // has none of. Zero stride zeroes that speed, and stance slide then reports
  // plain drift of a foot that was supposed to stay put.
  return {
    skel, map, frames, times, tracks, root, rootTranslations, legs,
    stride: 0, stepHeight: 0,
    spec: { ...spec, duration, duty: 1, stride: 0 },
  }
}
