// ---------------------------------------------------------------------------
// A VILLAGER BODY POSED OFF A HEADSET AND TWO CONTROLLERS: the three poses a
// peer sends (net.js: head and two grips, world space) become a whole standing
// figure, on the same puppet the snowmen and the wildlife are drawn with
// (render/puppet.js), playing its own idle and gait clips underneath.
//
// It is three small solves and no full-body solver, and each one is a lerp
// with a threshold, because a body that chases every millimetre of a headset
// reads as nervous and one that contorts to reach a head half a metre off its
// neck reads as broken:
//
//   THE HEAD turns exactly as the headset does, the turn split up the head
//   chain, and its joint slides to the headset sideways by up to HEAD_SLACK_M
//   -- a wiggle, a lean. Past that the FEET FOLLOW: the body glides to put its
//   neck back under the head, playing `walk` at the clip's own ground speed,
//   then settles back to `idle`. A teleport is the same thing further off: the
//   body walks, or runs, over to where she went, and the arms and head let go
//   of their targets while it is more than IK_OFF_M from them, since a body a
//   room away cannot reach them.
//
//   THE BODY'S YAW follows the head's with a deadzone: the neck twists up to
//   YAW_SLACK before the body turns under it, and once turning it turns until
//   the twist is under YAW_SETTLE. On a long walk it faces the way it walks.
//
//   EACH ARM is a two-bone chain, shoulder-elbow-wrist off the shipped map
//   (tools/creatures/ship-skinned.mjs `arms`): the elbow bends by the law of
//   cosines about the axis the clip already bends it, the shoulder aims the
//   arm at the grip and rolls the elbow toward a pole under and behind the
//   shoulder, and the wrist takes the controller's orientation through a rest
//   offset. A controller not held leaves that arm to the clip.
//
// The solve runs inside the puppet's pose step, on its cadence, over the pose
// the mixer just wrote, and what it writes it UNDOES before the mixer next
// runs -- the FootIK contract, for the same reason: a clip that does not track
// a joint would otherwise see this frame's bend as next frame's rest.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

// How far the head slides off its neck before the feet come after it and the
// whole body walks. EYE_LINE is the eye height as a fraction of stature: the
// body hangs from the head pose so the mesh's eyes sit where the headset is.
export const HEAD_SLACK_M = 0.1
export const EYE_LINE = 0.93
// The neck's twist that starts the body turning, the twist it turns down to, and how fast it turns.
export const YAW_SLACK = (40 * Math.PI) / 180
export const YAW_SETTLE = (8 * Math.PI) / 180
const TURN_TAU_S = 0.2
// The twist the neck is never asked past, whatever the body has yet to turn.
const NECK_MAX = (70 * Math.PI) / 180
// A glide ends this close to its mark; with more than FACE_TRAVEL_M left the body faces the way it walks,
// with more than RUN_FROM_M it runs, and it is never asked to take longer than MAX_TRAVEL_S over a trip.
export const GLIDE_STOP_M = 0.02
export const FACE_TRAVEL_M = 0.75
export const RUN_FROM_M = 5
export const MAX_TRAVEL_S = 6
// Further than this from its head the body is only walking there: the arms and head are the clip's.
export const IK_OFF_M = 1
// Seconds an arm or the head takes to take up or let go of its target.
const HOLD_S = 0.2
// An arm is never stretched past this fraction of straight.
const REACH = 0.995
// Where an elbow goes, in body space, for a body facing +X: down, back, and out on its own side.
const POLE = new THREE.Vector3(-0.5, -0.7, 0)
const POLE_OUT = 0.5
// The share of a head turn the top joint takes; the neck joints under it split the rest.
const HEAD_SHARE = 0.65

// A headset facing +X in body space: its own -Z along the body's forward.
const FACING_X = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)
const UNFACING_X = FACING_X.clone().invert()
const UP = new THREE.Vector3(0, 1, 0)
const IDENTITY_Q = new THREE.Quaternion()

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _t = new THREE.Vector3()
const _n = new THREE.Vector3()
const _u = new THREE.Vector3()
const _v = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _qp = new THREE.Quaternion()
const _qt = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scl = new THREE.Vector3()

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
// The yaw a body facing +X turns through to face (x, z): rotY(yaw) takes +X to (cos yaw, 0, -sin yaw).
const yawTo = (x, z) => Math.atan2(-z, x)

/** Turn `bone` by `q` in body space, given its parent's body-space quaternion (null at the root). */
function turnInBody(bone, parentQuat, q) {
  if (parentQuat) _qt.copy(parentQuat).invert().multiply(q).multiply(parentQuat)
  else _qt.copy(q)
  bone.quaternion.premultiply(_qt)
}

/**
 * One body. `puppet` is a render/puppet.js Puppet over an asset shipped by
 * ship-biped.mjs, `asset` that asset with its extras spread on (snowmen.js
 * loadBipedGlb), `k` the scale it is drawn at. `drive` it once a frame: it
 * plays the clips, steps the puppet and writes the puppet group's matrix.
 */
export class VrBody {
  constructor(puppet, asset, k) {
    if (!(asset.height > 0)) throw new Error('VrBody: the asset has no height')
    if (!(asset.gait?.walk > 0) || !(asset.gait?.run > 0)) throw new Error('VrBody: the asset has no walk and run speeds')
    if (!asset.head?.length) throw new Error('VrBody: the asset names no head chain -- re-ship it')
    if (asset.arms?.length !== 2 || !asset.arms.some((a) => a.side === 1) || !asset.arms.some((a) => a.side === -1)) throw new Error('VrBody: the asset does not name a left and a right arm -- re-ship it')
    this.puppet = puppet
    this.k = k
    this.gait = asset.gait
    this.height = asset.height
    const bones = puppet.bones
    const byName = new Map(bones.map((b) => [b.name, b]))
    const index = new Map(bones.map((b, i) => [b, i]))
    const resolve = (name) => {
      const b = byName.get(THREE.PropertyBinding.sanitizeNodeName(name))
      if (!b) throw new Error(`VrBody: no bone named ${name}`)
      return b
    }
    // A chain is walked parent to child, so each joint must hang from the one before.
    const chainOf = (what, names) => {
      const chain = names.map(resolve)
      for (let i = 1; i < chain.length; i++) if (chain[i].parent !== chain[i - 1]) throw new Error(`VrBody: ${what} joint ${chain[i].name} does not hang from ${chain[i - 1].name}`)
      return chain
    }
    // The rest pose in body space: the neck's neutral, the head's rest turn, each hand's rest frame.
    const rest = bones.map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }))
    bones.forEach((b, i) => {
      const par = b.parent?.isBone ? rest[index.get(b.parent)] : null
      if (par) {
        rest[i].q.multiplyQuaternions(par.q, b.quaternion)
        rest[i].p.copy(b.position).applyQuaternion(par.q).add(par.p)
      } else {
        rest[i].q.copy(b.quaternion)
        rest[i].p.copy(b.position)
      }
    })
    const slot = (b) => ({ bone: b, i: index.get(b), par: b.parent?.isBone ? index.get(b.parent) : -1, saved: new THREE.Quaternion() })

    const headChain = chainOf('head', asset.head)
    this.head = headChain.map(slot)
    const under = headChain.length - 1
    this.headShare = headChain.map((_, i) => (i === under ? (under ? HEAD_SHARE : 1) : (1 - HEAD_SHARE) / under))
    // The top joint's rest turn is what the headset's turn is measured from; the
    // bottom joint is the neck, which slides and takes the rest of the head with it.
    this.top = this.head[under]
    this.topRestQuat = rest[this.top.i].q.clone()
    this.neck = this.head[0]
    this.neckRest = rest[this.neck.i].p.clone()
    this.neckSavedPos = new THREE.Vector3()

    // Left arm first, right second: the order the grips come in the pose.
    this.arms = [1, -1].map((side) => {
      const a = asset.arms.find((arm) => arm.side === side)
      const chain = chainOf(`arm ${a.id}`, a.chain)
      const S = resolve(a.shoulder), E = resolve(a.elbow), W = resolve(a.wrist)
      const iS = chain.indexOf(S), iE = chain.indexOf(E), iW = chain.indexOf(W)
      if (!(iS >= 0 && iE > iS && iW > iE)) throw new Error(`VrBody: arm ${a.id} does not run shoulder, elbow, wrist down its chain`)
      const tip = iW + 1 < chain.length ? chain[iW + 1] : null
      // The hand's rest frame as a grip pose would spell it -- +Y down the
      // fingers, +Z out the back of the hand -- assuming what every Tripo human
      // rest pose has shown: arms hanging, palms to the thighs, backs out.
      const fingers = (tip ? rest[index.get(tip)].p.clone().sub(rest[index.get(W)].p) : rest[index.get(W)].p.clone().sub(rest[index.get(E)].p)).normalize()
      const back = new THREE.Vector3(0, 0, -side).addScaledVector(fingers, -fingers.z * -side)
      if (back.lengthSq() < 1e-6) back.set(-1, 0, 0).addScaledVector(fingers, fingers.x)
      back.normalize()
      const x = new THREE.Vector3().crossVectors(fingers, back)
      const gripRest = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, fingers, back))
      const pole = new THREE.Vector3(POLE.x, POLE.y, -side * POLE_OUT).normalize()
      return {
        id: a.id, S: slot(S), E: slot(E), W: slot(W), pole,
        // The shoulder's parent down to the wrist's, for recomposing the wrist's frame after the solve turns them.
        toWrist: chain.slice(iS, iW),
        // The wrist's rest orientation in the rest grip's frame: what a live grip is multiplied by.
        offset: gripRest.invert().multiply(rest[index.get(W)].q),
        w: 0, on: false, target: new THREE.Vector3(), quat: new THREE.Quaternion(),
      }
    })
    // Every bone a solve composes: the ancestors of both wrists and the head, in tree order.
    const need = new Set()
    for (const b of [...this.arms.map((a) => a.W.bone), this.top.bone]) for (let x = b; x?.isBone; x = x.parent) need.add(x)
    this.path = bones.map((b, i) => (need.has(b) ? i : -1)).filter((i) => i >= 0).map((i) => ({ bone: bones[i], i, par: bones[i].parent?.isBone ? index.get(bones[i].parent) : -1 }))
    this.pos = bones.map(() => new THREE.Vector3())
    this.quat = bones.map(() => new THREE.Quaternion())
    this.dirty = false

    // Where the body stands and faces in the world, whether it is walking to its head and turning to it, and the clip under it.
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0
    this.headYaw = 0
    this.placed = false
    this.gliding = false
    this.running = false
    this.pace = 0
    this.turning = false
    this.clip = 'idle'
    // For the solve: the head's turn off its rest and the neck's slide, in body space, and how far the targets are held.
    this.headTurn = new THREE.Quaternion()
    this.neckSlide = new THREE.Vector3()
    this.hold = 0
    this.body = new THREE.Matrix4()
    this.bodyInv = new THREE.Matrix4()
    puppet.solver = this
  }

  /** Metres a second the body walks at, and runs at. */
  get walkSpeed() { return this.gait.walk * this.k }
  get runSpeed() { return this.gait.run * this.k }

  /**
   * One frame off one pose: the 21 floats of net.js (head, left grip, right
   * grip; position then quaternion, world space) and which grips are held.
   * The puppet's tier is the caller's; this steps it.
   */
  drive(pose, hands, dt) {
    const hx = pose[0], hy = pose[1], hz = pose[2]
    _quat.set(pose[3], pose[4], pose[5], pose[6])
    _a.set(0, 0, -1).applyQuaternion(_quat)
    // Looking straight up or down leaves no gaze to face; the last heading holds.
    if (Math.hypot(_a.x, _a.z) > 0.25) this.headYaw = yawTo(_a.x, _a.z)
    const headYaw = this.headYaw
    this.y = hy - EYE_LINE * this.height * this.k

    // Where the body would stand with its neck under the head; a body not yet placed stands there at once, facing as she does.
    if (!this.placed) this.yaw = headYaw
    const nx = this.neckRest.x * this.k, nz = this.neckRest.z * this.k
    const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw)
    const underX = hx - (nx * cs + nz * sn), underZ = hz - (nz * cs - nx * sn)
    if (!this.placed) {
      this.placed = true
      this.x = underX; this.z = underZ
    }
    let dx = underX - this.x, dz = underZ - this.z
    let dist = Math.hypot(dx, dz)
    if (!this.gliding && dist > HEAD_SLACK_M) { this.gliding = true; this.running = false; this.pace = 0 }
    let faceYaw = headYaw
    let facingTravel = false
    if (this.gliding && dist <= GLIDE_STOP_M) {
      this.gliding = false
      this.clip = 'idle'
    } else if (this.gliding) {
      // The trip's gait and pace are settled as it starts, and raised only if the
      // head jumps further off mid-trip: a walk, a run once RUN_FROM_M off, and
      // faster than a run only so a teleport is over in MAX_TRAVEL_S. Settled per
      // frame instead, a long trip would slow as it closed and never end.
      if (dist > RUN_FROM_M) this.running = true
      this.pace = Math.max(this.pace, this.running ? this.runSpeed : this.walkSpeed, dist / MAX_TRAVEL_S)
      const step = Math.min(dist, this.pace * dt)
      this.x += (dx / dist) * step
      this.z += (dz / dist) * step
      this.clip = this.running ? 'run' : 'walk'
      if (dist > FACE_TRAVEL_M) { faceYaw = yawTo(dx, dz); facingTravel = true }
      this.puppet.play(this.clip)
      // The feet keep the ground's pace whatever the speed: the clip plays at the pace over its own.
      this.puppet.actions.get(this.clip).timeScale = this.pace / (this.gait[this.clip] * this.k)
      dx = underX - this.x; dz = underZ - this.z
      dist = Math.hypot(dx, dz)
    }
    // The body turns under a twisted neck, and to face a long walk.
    const twist = wrap(faceYaw - this.yaw)
    if (facingTravel || Math.abs(twist) > YAW_SLACK) this.turning = true
    else if (Math.abs(twist) < YAW_SETTLE) this.turning = false
    if (this.turning) this.yaw = wrap(this.yaw + twist * (1 - Math.exp(-dt / TURN_TAU_S)))

    // The head and arms hold their targets while the body is near enough to reach them.
    const holdTo = dist > IK_OFF_M ? 0 : 1
    this.hold = holdTo > this.hold ? Math.min(holdTo, this.hold + dt / HOLD_S) : Math.max(holdTo, this.hold - dt / HOLD_S)
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i]
      arm.on = !!hands?.[i]
      const to = arm.on ? this.hold : 0
      arm.w = to > arm.w ? Math.min(to, arm.w + dt / HOLD_S) : Math.max(to, arm.w - dt / HOLD_S)
    }

    // The body's frame -- feet at (x, y, z), facing its yaw, at scale -- and the targets in it.
    _pos.set(this.x, this.y, this.z)
    _q.setFromAxisAngle(UP, this.yaw)
    _scl.setScalar(this.k)
    this.body.compose(_pos, _q, _scl)
    this.bodyInv.copy(this.body).invert()
    // The neck's slide: the head's offset from the neck's rest, sideways only, clamped to the slack.
    this.neckSlide.set(hx, hy, hz).applyMatrix4(this.bodyInv).sub(this.neckRest)
    this.neckSlide.y = 0
    const slack = HEAD_SLACK_M / this.k
    if (this.neckSlide.lengthSq() > slack * slack) this.neckSlide.setLength(slack)
    // The head's turn off its rest, in body space: the headset's yaw against the body's, clamped to what a neck does, then its tilt.
    const neckYaw = Math.max(-NECK_MAX, Math.min(NECK_MAX, wrap(headYaw - this.yaw)))
    this.headTurn.setFromAxisAngle(UP, neckYaw)
      .multiply(_q2.setFromAxisAngle(UP, -headYaw).multiply(_quat))
      .multiply(UNFACING_X)
    _q.invert()
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i]
      const at = 7 + i * 7
      arm.target.set(pose[at], pose[at + 1], pose[at + 2]).applyMatrix4(this.bodyInv)
      _q2.set(pose[at + 3], pose[at + 4], pose[at + 5], pose[at + 6])
      arm.quat.copy(_q).multiply(_q2).multiply(arm.offset)
    }

    if (!this.gliding) this.puppet.play('idle')
    this.puppet.step(dt)
    this.puppet.group.matrix.copy(this.body)
    this.puppet.group.matrixWorldNeedsUpdate = true
  }

  /** Put back what the last solve wrote, so the mixer starts from the clip. */
  restore() {
    if (!this.dirty) return
    this.dirty = false
    for (const h of this.head) h.bone.quaternion.copy(h.saved)
    this.neck.bone.position.copy(this.neckSavedPos)
    for (const arm of this.arms) for (const j of [arm.S, arm.E, arm.W]) j.bone.quaternion.copy(j.saved)
  }

  /** Off at once, nothing written: for a puppet handed back. */
  reset() {
    this.restore()
    this.hold = 0
    for (const arm of this.arms) arm.w = 0
  }

  /** Over the pose the mixer just wrote: the head to the headset, each held arm to its grip. */
  solve() {
    if (this.hold <= 0 && this.arms.every((a) => a.w <= 0)) return
    for (const { bone, i, par } of this.path) {
      if (par < 0) {
        this.pos[i].copy(bone.position)
        this.quat[i].copy(bone.quaternion)
      } else {
        this.quat[i].multiplyQuaternions(this.quat[par], bone.quaternion)
        this.pos[i].copy(bone.position).applyQuaternion(this.quat[par]).add(this.pos[par])
      }
    }
    for (const h of this.head) h.saved.copy(h.bone.quaternion)
    this.neckSavedPos.copy(this.neck.bone.position)
    for (const arm of this.arms) for (const j of [arm.S, arm.E, arm.W]) j.saved.copy(j.bone.quaternion)
    this.dirty = true

    if (this.hold > 0) this._solveHead()
    for (const arm of this.arms) if (arm.w > 0) this._solveArm(arm)
  }

  _solveHead() {
    const w = this.hold
    // From the head the clip posed to the headset's turn of the rest head, in body space, split up the chain.
    _q2.copy(this.headTurn).multiply(this.topRestQuat).multiply(_q.copy(this.quat[this.top.i]).invert())
    if (w < 1) _q2.slerp(IDENTITY_Q, 1 - w)
    for (let s = 0; s < this.head.length; s++) {
      const h = this.head[s]
      _qp.copy(IDENTITY_Q).slerp(_q2, this.headShare[s])
      turnInBody(h.bone, h.par >= 0 ? this.quat[h.par] : null, _qp)
      h.bone.updateMatrix()
      // Every joint from here down the chain turned with it.
      for (let t = s; t < this.head.length; t++) this.quat[this.head[t].i].premultiply(_qp)
    }
    // The neck slides to the head, in its parent's frame.
    const neck = this.neck
    _t.copy(this.neckSlide).multiplyScalar(w)
    if (neck.par >= 0) _t.applyQuaternion(_q.copy(this.quat[neck.par]).invert())
    neck.bone.position.add(_t)
    neck.bone.updateMatrix()
  }

  _solveArm(arm) {
    const S = this.pos[arm.S.i], E = this.pos[arm.E.i], W = this.pos[arm.W.i]
    const a = S.distanceTo(E), b = E.distanceTo(W), d0 = S.distanceTo(W)
    const w = arm.w
    // The target, in reach: down the shoulder's line to it, no further than the arm is long.
    _u.subVectors(arm.target, S)
    let d = _u.length()
    if (d < 1e-6) { _u.set(0, -1, 0); d = 1e-6 } else _u.divideScalar(d)
    d = Math.min(REACH * (a + b), Math.max(Math.abs(a - b) + 1e-4, d))
    _t.copy(S).addScaledVector(_u, d)

    // The elbow, about the axis the pose already bends it on -- or, posed straight, the pole's.
    _a.subVectors(S, E); _c.subVectors(W, E)
    _n.crossVectors(_a, _c)
    if (_n.lengthSq() < 1e-8 * a * a * b * b) _n.crossVectors(_u, arm.pole)
    _n.normalize()
    const cos0 = Math.max(-1, Math.min(1, (a * a + b * b - d0 * d0) / (2 * a * b)))
    const cos1 = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)))
    _q.setFromAxisAngle(_n, Math.acos(cos1) - Math.acos(cos0))
    if (w < 1) _q.slerp(IDENTITY_Q, 1 - w)
    turnInBody(arm.E.bone, this.quat[arm.E.par], _q)
    // Where the wrist went, about the unturned shoulder.
    _c.applyQuaternion(_q).add(E)
    // The shoulder aims the arm down the target's line...
    _a.subVectors(_c, S).normalize()
    _b.subVectors(_t, S).normalize()
    _q2.setFromUnitVectors(_a, _b)
    // ...and rolls it about that line to put the elbow toward the pole.
    _a.subVectors(E, S).applyQuaternion(_q2)
    _a.addScaledVector(_b, -_a.dot(_b))
    _v.copy(arm.pole).addScaledVector(_b, -arm.pole.dot(_b))
    if (_a.lengthSq() > 1e-10 && _v.lengthSq() > 1e-10) {
      _a.normalize(); _v.normalize()
      _n.crossVectors(_a, _v)
      _q.setFromAxisAngle(_b, Math.atan2(_n.dot(_b), _a.dot(_v)))
      _q2.premultiply(_q)
    }
    if (w < 1) _q2.slerp(IDENTITY_Q, 1 - w)
    turnInBody(arm.S.bone, arm.S.par >= 0 ? this.quat[arm.S.par] : null, _q2)
    arm.S.bone.updateMatrix()
    arm.E.bone.updateMatrix()
    // The wrist takes the grip's orientation outright, in its parent's frame as the bones now stand.
    _qp.copy(arm.S.par >= 0 ? this.quat[arm.S.par] : IDENTITY_Q)
    for (const bone of arm.toWrist) _qp.multiply(bone.quaternion)
    _q.copy(_qp).invert().multiply(arm.quat)
    if (w < 1) arm.W.bone.quaternion.slerp(_q, w)
    else arm.W.bone.quaternion.copy(_q)
    arm.W.bone.updateMatrix()
  }
}
