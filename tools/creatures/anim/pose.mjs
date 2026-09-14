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
 *   spine  pitch, yaw, roll   radians, spread along the chain
 *   head   pitch, yaw, roll   radians, spread along the neck
 *   tail   pitch, yaw, curl   radians, spread along the tail
 *   wings  spread, sweep      radians, mirrored across the pair
 *   arms   pitch, spread      radians, mirrored across the pair
 *   legs   <legId>: { fore, lat, lift, pitch }  foot target offset, paw tilt
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

import { add, loadSkeleton, scale } from './skeleton.mjs'
import { bend, limbSetup, pairsOf, poser, seed, solveLimb } from './gait.mjs'

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
  const spec = { samples: 30, loop: false, ...rawSpec }
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
  const arms = pairsOf(map, 'arms', named)
  const driven = [...spine, ...head, ...tail, ...legs.flatMap((l) => l.chain),
    ...wings.flatMap((w) => w.chain), ...arms.flatMap((a) => a.chain)]

  // One getter per handle, so `sample` never has to know the spec's shape and a
  // key that omits a group simply reads zero.
  const scaleOf = spec.scale ?? {}
  const at = (t, group, field) => sample(keys, t, (k) => (k.pose[group] ?? ZERO)[field] ?? 0) * (scaleOf[group] ?? 1)
  const legAt = (t, id, field) => sample(keys, t, (k) => ((k.pose.legs ?? {})[id] ?? ZERO)[field] ?? 0) * (scaleOf.legs ?? 1)
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
    seed(pose, driven)
    if (root === null) root = pose.roots[0]

    pose.setOffset(add(add(
      scale(up, at(t, 'root', 'lift') * map.height),
      scale(fwd, at(t, 'root', 'fore') * map.wheelbase)),
      scale(lat, at(t, 'root', 'lat') * map.wheelbase)))

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
    }
    for (const a of arms) {
      bend(pose, a.chain, lat, at(t, 'arms', 'pitch'))
      bend(pose, a.chain, fwd, at(t, 'arms', 'spread') * a.side)
    }

    const feet = []
    for (const leg of legs) {
      const target = add(add(add(leg.restFoot,
        scale(fwd, legAt(t, leg.id, 'fore') * map.wheelbase)),
        scale(lat, legAt(t, leg.id, 'lat') * map.wheelbase)),
        scale(up, legAt(t, leg.id, 'lift') * map.height))
      solveLimb(pose, leg, target, { ...limits, pitch: legAt(t, leg.id, 'pitch'), pitchAxis: lat })
      // A pose clip has no swing, so every foot is load-bearing unless the spec
      // deliberately lifted it. Measured against the leg's OWN rest foot, not a
      // single ground plane: `ground` is the lowest joint in the rig, while a
      // foot joint sits wherever the rigger put it -- the hare's hind pair are
      // ankles 16cm up -- so against one plane a leg reads permanently airborne
      // and drops out of the slide check entirely.
      const planted = !unweighted.has(leg.id) && target[1] - leg.restFoot[1] < 1e-4
      feet.push({ id: leg.id, target, planted, actual: pose.pos(leg.foot) })
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
