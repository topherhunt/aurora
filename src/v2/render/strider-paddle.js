import THREE from '../../three-instance.js'

// A strider's feet paddling as it swims, on top of its idle clip: each leg swings fore and aft about the creature's lateral axis (it faces +X, up +Y), the two legs half a stroke apart and each joint down a leg lagging the one above, so a foot loops, kicking back and drawn forward. A puppet solver (puppet.js `solver` contract), chained like the shake (strider-shake.js) by `then`.

export const PADDLE = {
  // Strokes a second treading water and at a full swim; peak radians of each joint down the leg (the last for any further), the lag between joints, and the thigh's trailing lean.
  hz: [1.6, 2.8], swing: [0.45, 0.65, 0.8], lag: 1.1, trail: -0.35,
  // Seconds the paddle takes to come on and to die away.
  ease: 0.3,
}

const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const _pq = new THREE.Quaternion()
const _r = new THREE.Quaternion()
const _t = new THREE.Quaternion()
const Z = new THREE.Vector3(0, 0, 1)

export class StriderPaddle {
  /** `puppet` a strider's (puppet.js), `asset` its loaded asset with the shipped `legs`. */
  constructor(puppet, asset) {
    this.rig = puppet.rig
    const bones = puppet.skeleton.bones
    const bone = (name) => {
      const b = bones.find((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(name))
      if (!b) throw new Error(`StriderPaddle: no bone named ${name}`)
      return b
    }
    // Parents before children.
    this.joints = asset.legs.flatMap((l, leg) => l.chain.map((name, j) => ({ b: bone(name), leg, j })))
    this.saved = this.joints.map(() => new THREE.Quaternion())
    this.want = 0
    this.pace = 0
    this.k = 0
    this.phase = 0
    this.on = false
    this.then = null
  }

  /** Paddling `want` (1 swimming, 0 not) at `pace`, 0 treading water to 1 a full swim. */
  set(want, pace) {
    this.want = want
    this.pace = THREE.MathUtils.clamp(pace, 0, 1)
  }

  restore() {
    this.then?.restore()
    if (!this.on) return
    this.joints.forEach(({ b }, i) => { b.quaternion.copy(this.saved[i]); b.updateMatrix() })
    this.on = false
  }

  solve(dt) {
    this.k += (this.want - this.k) * (1 - Math.exp(-dt / PADDLE.ease))
    if (this.k > 1e-3) this._paddle(dt)
    this.then?.solve(dt)
  }

  _paddle(dt) {
    const P = PADDLE
    this.phase = (this.phase + 2 * Math.PI * (P.hz[0] + (P.hz[1] - P.hz[0]) * this.pace) * dt) % (2 * Math.PI)
    // The mixer has set the locals; their parents' world matrices are last pose's until this walk.
    this.rig.updateMatrixWorld(true)
    this.joints.forEach(({ b, leg, j }, i) => {
      const pitch = this.k * ((j === 0 ? P.trail : 0) + P.swing[Math.min(j, P.swing.length - 1)] * Math.sin(this.phase + leg * Math.PI - j * P.lag))
      this.saved[i].copy(b.quaternion)
      b.parent.matrixWorld.decompose(_v, _pq, _s)
      _r.setFromAxisAngle(Z, pitch)
      b.quaternion.premultiply(_t.copy(_pq).invert().multiply(_r).multiply(_pq))
      b.updateMatrix()
      b.updateMatrixWorld(true)
    })
    this.on = true
  }

  reset() {
    this.restore()
    this.then?.reset()
    this.k = this.want = 0
  }
}
