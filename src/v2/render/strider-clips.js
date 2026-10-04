import THREE from '../../three-instance.js'
import { cloneBones } from './puppet.js'

// Two strider clips made at load from the shipped ones, so a skinned and a baked body (baked-puppet.js) play them alike: `fidget` with a wet dog's feather shake laid over it, and `paddle`, `idle` with the feet stroking, for a body afloat.

export const SHAKE = {
  // The shake grows from `from` s into the fidget to its peak at `peak` and dies over `settle` s after it; the flutter sound starts with the clip.
  from: 0.25, peak: 1.45, settle: 0.12,
  // Cycles a second, quickening from the first to the second as it grows.
  hz: [3.5, 5],
  // Peak radians about the creature's own axes. Hips and chest roll the trunk about the spine; the legs undo the hips' roll so the feet stay under it; the neck leads by `lead` rad a joint, the tail lags by `lag`.
  hips: 0.15, chest: { roll: 0.3, yaw: 0.1 }, neck: { roll: 0.22, yaw: 0.15 }, lead: 0.35,
  tail: { yaw: 0.35, pitch: 0.2 }, lag: 0.8,
  // The wings flared off the flanks and trembling at twice the shake.
  wing: { flare: 0.4, flutter: 0.15 },
}

export const PADDLE = {
  // Strokes a second treading water and at a full swim (the layer sets the clip's timeScale between them); peak radians of each joint down the leg (the last for any further), the lag between joints, and the thigh's trailing lean.
  hz: [1.6, 2.8], swing: [0.45, 0.65, 0.8], lag: 1.1, trail: -0.35,
}

// Samples a second of a made clip; the shake's 5 Hz wants more than the VAT's 30.
const FPS = 60

const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const _pq = new THREE.Quaternion()
const _r = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const Z = new THREE.Vector3(0, 0, 1)
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

/** How much of the shake is on at `t` s into the fidget, 0..1. */
const shakeAmount = (t) => (t < SHAKE.peak ? smooth((t - SHAKE.from) / (SHAKE.peak - SHAKE.from)) : Math.exp(-(t - SHAKE.peak) / SHAKE.settle))

/** The paddle clip's strokes a second at timeScale 1: whole strokes over one idle, nearest the treading rate. */
export const paddleHz = (idle) => Math.max(1, Math.round(idle.duration * PADDLE.hz[0])) / idle.duration

/** `asset.clips` with `fidget` shaken and `paddle` added. `asset` is a loaded strider with its bird extras (`spine`, `head`, `tail`, `legs`). */
export function striderClips(asset) {
  const clip = (name) => {
    const c = asset.clips.find((c) => c.name === name)
    if (!c) throw new Error(`striderClips: no ${name} clip`)
    return c
  }
  const copies = new Map()
  const rig = cloneBones(asset.root, copies)
  const bones = asset.skeleton.bones.map((b) => copies.get(b))
  const rest = new Map(bones.map((b) => [b, b.quaternion.clone()]))
  const bone = (name) => {
    const b = bones.find((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(name))
    if (!b) throw new Error(`striderClips: no bone named ${name}`)
    return b
  }
  const S = SHAKE, P = PADDLE
  const [hips, chest] = asset.spine.map(bone), neck = asset.head.map(bone)
  const wings = chest.children.filter((b) => b.isBone && b !== neck[0])
  if (wings.length !== 2) throw new Error(`striderClips: the chest carries ${wings.length} bones besides the neck, not two wings`)
  // A wing on the left (-Z) flares by rolling +, one on the right by -; read off the bind pose.
  const side = (b) => -Math.sign(_v.setFromMatrixPosition(_m.copy(asset.skeleton.boneInverses[bones.indexOf(b)]).invert()).z)
  // Parents before children, each as a function of the shake's phase `a` to { roll, yaw, pitch }.
  const shaken = [
    { b: hips, at: (a) => ({ roll: S.hips * Math.sin(a - 0.3) }) },
    ...asset.legs.map((l) => ({ b: bone(l.chain[0]), at: (a) => ({ roll: -S.hips * Math.sin(a - 0.3) }) })),
    { b: chest, at: (a) => ({ roll: S.chest.roll * Math.sin(a), yaw: S.chest.yaw * Math.sin(a + 0.5) }) },
    ...neck.map((b, i) => ({ b, at: (a) => ({ roll: S.neck.roll * Math.sin(a + S.lead * (i + 1)), yaw: S.neck.yaw * Math.sin(a + S.lead * (i + 1) + 0.6) }) })),
    ...wings.flatMap((b) => {
      const f = side(b)
      return [
        { b, at: (a) => ({ roll: f * (S.wing.flare + S.wing.flutter * Math.sin(2 * a)) }) },
        ...b.children.filter((c) => c.isBone).map((c) => ({ b: c, at: (a) => ({ roll: f * S.wing.flutter * Math.sin(2 * a + 1) }) })),
      ]
    }),
    ...asset.tail.map(bone).map((b, i) => ({ b, at: (a) => ({ yaw: S.tail.yaw * Math.sin(a - S.lag * (i + 1)), pitch: S.tail.pitch * Math.max(0, Math.sin(a - S.lag * i)) }) })),
  ]
  const paddled = asset.legs.flatMap((l, leg) => l.chain.map((name, j) => ({ b: bone(name), leg, j })))

  // The shake's phase at each sample, its quickening integrated finely.
  const fidget = clip('fidget')
  const phases = []
  for (let i = 0, phase = 0, t = 0, n = Math.ceil(fidget.duration * FPS); i <= n; i++) {
    const at = (i / n) * fidget.duration
    for (; t < at; t += 1 / 960) phase += 2 * Math.PI * (S.hz[0] + (S.hz[1] - S.hz[0]) * shakeAmount(t)) / 960
    phases.push(phase)
  }
  const shake = layOver(rig, rest, fidget, 'fidget', shaken.map((x) => x.b), (i, t) => {
    const k = shakeAmount(t)
    return shaken.map(({ at }) => {
      const { roll = 0, yaw = 0, pitch = 0 } = at(phases[i])
      return new THREE.Quaternion().setFromEuler(_e.set(roll * k, yaw * k, pitch * k, 'YZX'))
    })
  })
  const idle = clip('idle'), w = 2 * Math.PI * paddleHz(idle)
  const paddle = layOver(rig, rest, idle, 'paddle', paddled.map((x) => x.b), (i, t) => paddled.map(({ leg, j }) =>
    new THREE.Quaternion().setFromAxisAngle(Z, (j === 0 ? P.trail : 0) + P.swing[Math.min(j, P.swing.length - 1)] * Math.sin(w * t + leg * Math.PI - j * P.lag))))
  return [...asset.clips.filter((c) => c !== fidget), shake, paddle]
}

/**
 * `base` resampled as `name`, each of `joints` (parents first) turned at each
 * sample by the creature-space rotation `turns(i, t)` gives it, on top of the
 * clip's pose (`rest` holds each bone's untouched local rotation). The other
 * bones keep `base`'s own tracks.
 */
function layOver(rig, rest, base, name, joints, turns) {
  // The tracks evaluated by hand: a mixer writes a bone only when its value changes, so a held key would leave a joint at the rest it was reset to.
  const sets = base.tracks.map((tr) => {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(tr.name)
    const node = THREE.PropertyBinding.findNode(rig, nodeName)
    if (!node) throw new Error(`striderClips: ${base.name} drives ${tr.name}, not on the rig`)
    return { at: tr.createInterpolant(), to: node[propertyName] }
  })
  const n = Math.ceil(base.duration * FPS)
  const times = new Float32Array(n + 1)
  const values = joints.map(() => new Float32Array((n + 1) * 4))
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * base.duration
    times[i] = t
    for (const b of joints) b.quaternion.copy(rest.get(b))
    for (const { at, to } of sets) to.fromArray(at.evaluate(t))
    rig.updateMatrixWorld(true)
    const r = turns(i, t)
    joints.forEach((b, j) => {
      // The root has no parent: its frame is the creature's.
      if (b.parent) b.parent.matrixWorld.decompose(_v, _pq, _s)
      else _pq.identity()
      b.quaternion.premultiply(_r.copy(_pq).invert().multiply(r[j]).multiply(_pq))
      b.updateMatrixWorld(true)
      b.quaternion.toArray(values[j], i * 4)
    })
  }
  const mine = new Set(joints.map((b) => `${b.name}.quaternion`))
  const tracks = base.tracks.filter((t) => !mine.has(t.name)).map((t) => t.clone())
  joints.forEach((b, j) => tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values[j])))
  return new THREE.AnimationClip(name, base.duration, tracks)
}
