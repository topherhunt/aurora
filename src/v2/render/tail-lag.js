// ---------------------------------------------------------------------------
// THE TAIL'S LAG: a tail that trails the body's turns instead of riding
// rigidly behind it. A puppet solver (puppet.js, the `solver` contract:
// restore before the mixer, solve after it, reset on release) that bends each
// tail joint off the clip's pose, in creature space, against the body's yaw
// and pitch rate.
//
// Each joint's bend is the one before it low-passed over LAG_S, so a change of
// turn runs down the tail from root to tip: in a meander the root has already
// swung the new way while the tip still curves the old, which is the S a
// following tail makes. It costs a few quaternion multiplies per tail joint on
// the frames a puppet poses; the skinning is the bone texture's, as ever.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { swing } from '../../sim/score.js'

// Seconds each joint trails the one before it.
export const LAG_S = 0.15
// Radians a joint bends off its parent per rad/s of turn, and at most. A 0.6 rad/s flying turn curls six joints ~0.5 rad; a walking turn on the spot hits the cap.
export const BEND_PER_RATE = 0.15
export const BEND_MAX = 0.15
// The pitch lag's share of the yaw's: a tail droops and lifts less than it swings.
export const PITCH_SHARE = 0.5
// A rate past this is a teleport or a snapped heading, not a turn.
const RATE_MAX = 2

const UP = new THREE.Vector3(0, 1, 0)
const LAT = new THREE.Vector3(0, 0, 1)
const _qp = new THREE.Quaternion()
const _r = new THREE.Quaternion()
const _q = new THREE.Quaternion()

const clampRate = (r) => Math.max(-RATE_MAX, Math.min(RATE_MAX, r))
// Trailing the turn: the body swung +rate, so the tail is behind it by -rate.
const bend = (rate, share) => Math.max(-BEND_MAX, Math.min(BEND_MAX, -BEND_PER_RATE * share * rate))

export class TailLag {
  /** `bones` the puppet's tree, `chain` the shipped tail joint names, root to tip. */
  constructor(bones, chain) {
    if (!chain?.length) throw new Error('TailLag: no tail chain -- re-ship the GLB')
    const byName = new Map(bones.map((b) => [b.name, b]))
    this.joints = chain.map((name) => {
      const b = byName.get(THREE.PropertyBinding.sanitizeNodeName(name))
      if (!b) throw new Error(`TailLag: no bone named ${name}`)
      return b
    })
    // The tail root's ancestors, root first, for its parent's creature-space rotation.
    this.above = []
    for (let b = this.joints[0].parent; b?.isBone; b = b.parent) this.above.unshift(b)
    this.saved = this.joints.map(() => new THREE.Quaternion())
    this.yaw = new Float32Array(this.joints.length)
    this.pitch = new Float32Array(this.joints.length)
    this.dirty = false
    this.reset()
  }

  /** This frame's body heading and pitch, radians, as the layer draws it. */
  steer(heading, pitch) {
    this.heading = heading
    this.bodyPitch = pitch
  }

  reset() {
    this.restore()
    this.yaw.fill(0)
    this.pitch.fill(0)
    this.heading = null
    this.lastHeading = null
  }

  restore() {
    if (!this.dirty) return
    this.dirty = false
    for (let i = 0; i < this.joints.length; i++) this.joints[i].quaternion.copy(this.saved[i])
  }

  /** Over the pose the mixer just wrote, `dt` seconds after the last solve. */
  solve(dt) {
    if (this.heading === null) return
    if (this.lastHeading !== null && dt > 0) {
      let yawIn = clampRate(swing(this.lastHeading, this.heading) / dt)
      let pitchIn = clampRate((this.bodyPitch - this.lastPitch) / dt)
      const ease = 1 - Math.exp(-dt / LAG_S)
      for (let i = 0; i < this.joints.length; i++) {
        this.yaw[i] += (yawIn - this.yaw[i]) * ease
        this.pitch[i] += (pitchIn - this.pitch[i]) * ease
        yawIn = this.yaw[i]
        pitchIn = this.pitch[i]
      }
    }
    this.lastHeading = this.heading
    this.lastPitch = this.bodyPitch

    _qp.identity()
    for (const b of this.above) _qp.multiply(b.quaternion)
    for (let i = 0; i < this.joints.length; i++) {
      const j = this.joints[i]
      this.saved[i].copy(j.quaternion)
      _r.setFromAxisAngle(UP, bend(this.yaw[i], 1))
      _r.multiply(_q.setFromAxisAngle(LAT, bend(this.pitch[i], PITCH_SHARE)))
      // A creature-space turn about the joint, into its parent's frame.
      _q.copy(_qp).invert().multiply(_r).multiply(_qp)
      j.quaternion.premultiply(_q)
      j.updateMatrix()
      _qp.multiply(j.quaternion)
    }
    this.dirty = true
  }
}
