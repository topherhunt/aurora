import THREE from '../../three-instance.js'

// A strider shaking out its feathers, a wet dog's shake on top of its fidget clip, timed to strider-flutter.mp3. A puppet solver (puppet.js `solver` contract) with a second solver chained after it in `then`.

export const SHAKE = {
  // The sound builds from `from` s to its crack at `peak`, and is quiet by `s`: the shake grows over that, holds a beat, and dies over `settle` s.
  from: 0.25, peak: 1.45, settle: 0.12, s: 2.1,
  // Cycles a second, quickening from the first to the second as it grows.
  hz: [3.5, 5],
  // Peak radians about the creature's own axes. Hips and chest roll the trunk about the spine; the legs undo the hips' roll so the feet stay under it; the neck leads by `lead` rad a joint, the tail lags by `lag`.
  hips: 0.15, chest: { roll: 0.3, yaw: 0.1 }, neck: { roll: 0.22, yaw: 0.15 }, lead: 0.35,
  tail: { yaw: 0.35, pitch: 0.2 }, lag: 0.8,
  // The wings flared off the flanks and trembling at twice the shake.
  wing: { flare: 0.4, flutter: 0.15 },
}

const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const _pq = new THREE.Quaternion()
const _r = new THREE.Quaternion()
const _t = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()

const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

export class StriderShake {
  /** `puppet` a strider's (puppet.js), `asset` its loaded asset with the shipped `spine`, `head`, `tail` and `legs` names. */
  constructor(puppet, asset) {
    this.rig = puppet.rig
    const bones = puppet.skeleton.bones
    const bone = (name) => {
      const i = bones.findIndex((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(name))
      if (i < 0) throw new Error(`StriderShake: no bone named ${name}`)
      return bones[i]
    }
    const S = SHAKE, [hips, chest] = asset.spine.map(bone), neck = asset.head.map(bone)
    const wings = chest.children.filter((b) => b.isBone && b !== neck[0])
    if (wings.length !== 2) throw new Error(`StriderShake: the chest carries ${wings.length} bones besides the neck, not two wings`)
    // A wing on the left (-Z) flares by rolling +, one on the right by -; read off the bind pose.
    const side = (b) => -Math.sign(_v.setFromMatrixPosition(_m.copy(asset.skeleton.boneInverses[bones.indexOf(b)]).invert()).z)
    // Parents before children, each as a function of the shake's phase `a` to { roll, yaw, pitch }.
    this.joints = [
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
    this.saved = this.joints.map(() => new THREE.Quaternion())
    this.t = -1
    this.phase = 0
    this.on = false
    this.then = null
  }

  /** A shake from its start, as the flutter is heard. */
  start() {
    this.t = 0
    this.phase = 0
  }

  /** How much of the shake is on at `t` s into it, 0..1. */
  _amount(t) {
    const S = SHAKE
    if (t < S.peak) return smooth((t - S.from) / (S.peak - S.from))
    return Math.exp(-(t - S.peak) / S.settle)
  }

  restore() {
    this.then?.restore()
    if (!this.on) return
    this.joints.forEach(({ b }, i) => { b.quaternion.copy(this.saved[i]); b.updateMatrix() })
    this.on = false
  }

  solve(dt) {
    if (this.t >= 0) this._shake(dt)
    this.then?.solve(dt)
  }

  _shake(dt) {
    const S = SHAKE
    this.t += dt
    if (this.t > S.s) { this.t = -1; return }
    const k = this._amount(this.t)
    this.phase += 2 * Math.PI * (S.hz[0] + (S.hz[1] - S.hz[0]) * k) * dt
    if (k < 1e-3) return
    // The mixer has set the locals; their parents' world matrices are last pose's until this walk.
    this.rig.updateMatrixWorld(true)
    this.joints.forEach(({ b, at }, i) => {
      const { roll = 0, yaw = 0, pitch = 0 } = at(this.phase)
      this.saved[i].copy(b.quaternion)
      // The root bone is the rig's, under nothing: its frame is the creature's.
      if (b.parent) b.parent.matrixWorld.decompose(_v, _pq, _s)
      else _pq.identity()
      _r.setFromEuler(_e.set(roll * k, yaw * k, pitch * k, 'YZX'))
      b.quaternion.premultiply(_t.copy(_pq).invert().multiply(_r).multiply(_pq))
      b.updateMatrix()
      b.updateMatrixWorld(true)
    })
    this.on = true
  }

  reset() {
    this.restore()
    this.then?.reset()
    this.t = -1
  }
}
