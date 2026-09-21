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
//   THE HEAD turns exactly as the headset does, the whole turn at the neck --
//   Tripo weights the skull to whichever head joint it likes, and a turn split
//   up the chain showed as a third of itself on a skull hung from the lower
//   one -- and the neck stretches straight up or down to put the eyes at the
//   headset, by up to HEAD_SLACK_M. It never slides sideways: a neck slid off
//   its shoulders to a wiggling headset read as rubber, so THE FEET FOLLOW at
//   once, the body standing under its head every frame, feet planted. A
//   TELEPORT -- the head TELEPORT_M or more from where it was a frame ago --
//   is the one trip it walks: the body glides after her playing `walk` at the
//   clip's own ground speed, or `run` from further, and the arms and head let
//   go of their targets while it is more than IK_OFF_M from them, since a
//   body a room away cannot reach them.
//
//   THE FEET STAND ON THE GROUND, not under the head: the body is placed on
//   the walk surface where it stands, and while it stands its feet are planted
//   to the hillside through the puppet's own FootIK. A head lower than the
//   standing body's eyes by more than the slack is a CROUCH: the waist bends
//   forward, up to LEAN_MAX, and the hips sink, the knees folding under them,
//   by whatever brings the eyes down to the headset, until the legs are folded
//   to CROUCH_FOLD of their length -- a deep squat bent double, which is what
//   she looks like to the others when she kneels to a mushroom. The neck the
//   lean carries forward is where the body stands its feet from, so a head
//   that goes forward as she bends is read as the bend, not as a step. A head
//   higher over the ground than a standing body's eyes by more than FLY_M is
//   ALOFT -- she is flying, or the ground is a lake bed under a boat's sole
//   that the walk surface's ceiling rule can never lift the body onto -- and
//   the body is carried under its head, feet loose, until ground comes up.
//
//   THE BODY'S YAW follows the head's with a deadzone: the neck twists up to
//   YAW_SLACK before the body turns under it, and once turning it turns until
//   the twist is under YAW_SETTLE. On a long walk it faces the way it walks.
//
//   EACH ARM is a two-bone chain, shoulder-elbow-wrist off the shipped map
//   (tools/creatures/ship-skinned.mjs `arms`): the elbow bends by the law of
//   cosines about the axis the clip already bends it, the shoulder aims the
//   arm at the grip and rolls the elbow toward a pole under and behind the
//   shoulder. The wrist is the clip's: a controller's orientation is not
//   read, since the hands Tripo rigs bend at the wrong joints when it is, and
//   a hand hanging off its forearm reads right from any distance a peer is
//   seen at. A controller not held leaves that arm to the clip.
//
// The solve runs inside the puppet's pose step, on its cadence, over the pose
// the mixer just wrote, and what it writes it UNDOES before the mixer next
// runs -- the FootIK contract, for the same reason: a clip that does not track
// a joint would otherwise see this frame's bend as next frame's rest.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

// How far the neck stretches up or down for the headset before the crouch
// takes over. EYE_LINE is the eye height as a fraction of stature: a standing
// body's eyes, which the crouch measures the headset against. A head further
// than TELEPORT_M from where it was last frame has teleported, and the body
// walks there rather than following.
export const HEAD_SLACK_M = 0.1
export const EYE_LINE = 0.93
export const TELEPORT_M = 1
// A head higher over the ground than the standing eyes by more than this is in the air, and the body hangs under it. Wider than
// any headset stood taller than its avatar, narrower than the walk surface's reach, so a body the ceiling rule holds under a
// boat's sole is always lifted.
export const FLY_M = 0.75
// A crouch folds a leg to no shorter than this fraction of its rest length, and bends the waist forward no further than LEAN_MAX.
export const CROUCH_FOLD = 0.35
export const LEAN_MAX = (40 * Math.PI) / 180
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

// A headset facing +X in body space: its own -Z along the body's forward.
const FACING_X = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)
const UNFACING_X = FACING_X.clone().invert()
const UP = new THREE.Vector3(0, 1, 0)
const SIDE = new THREE.Vector3(0, 0, 1)
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
 * loadBipedGlb), `k` the scale it is drawn at, `walk` the ground it stands on
 * (v2/walk.js WalkSurface: heightAt). `drive` it once a frame: it plays the
 * clips, steps the puppet and writes the puppet group's matrix.
 */
export class VrBody {
  constructor(puppet, asset, k, walk) {
    if (!(asset.height > 0)) throw new Error('VrBody: the asset has no height')
    if (!(asset.gait?.walk > 0) || !(asset.gait?.run > 0)) throw new Error('VrBody: the asset has no walk and run speeds')
    if (!asset.head?.length) throw new Error('VrBody: the asset names no head chain -- re-ship it')
    if (!asset.spine?.length) throw new Error('VrBody: the asset names no spine -- re-ship it')
    if (!puppet.ik) throw new Error('VrBody: the asset names no legs -- re-ship it')
    if (typeof walk?.heightAt !== 'function') throw new Error('VrBody needs the walk surface, for the ground under its feet')
    if (asset.arms?.length !== 2 || !asset.arms.some((a) => a.side === 1) || !asset.arms.some((a) => a.side === -1)) throw new Error('VrBody: the asset does not name a left and a right arm -- re-ship it')
    this.puppet = puppet
    this.k = k
    this.walk = walk
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
    // The rest pose in body space: the neck's neutral and the head's rest turn.
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
    // The top joint's rest turn is what the headset's turn is measured from; the
    // bottom joint is the neck, which turns and slides, and takes the rest of the head with it.
    this.top = this.head[headChain.length - 1]
    this.topRestQuat = rest[this.top.i].q.clone()
    this.neck = this.head[0]
    this.neckRest = rest[this.neck.i].p.clone()
    this.neckSavedPos = new THREE.Vector3()
    // The eyes, above the neck at rest: what the neck slides to put at the headset.
    this.eyeOffset = new THREE.Vector3(0, EYE_LINE * asset.height - this.neckRest.y, 0)
    // The waist -- the first spine joint, which a crouch bends forward with the torso above it -- and how far the legs may fold under one.
    this.waist = slot(resolve(asset.spine[0]))
    for (const l of puppet.ik.legs) for (let b = l.A; b?.isBone; b = b.parent) if (b === this.waist.bone) throw new Error(`VrBody: the spine's first joint ${b.name} carries leg ${l.id} -- a crouch would bend it`)
    this.torso = this.neckRest.clone().sub(rest[this.waist.i].p)
    this.crouchMax = (1 - CROUCH_FOLD) * puppet.ik.legRest
    this.dys = puppet.feet.map(() => 0)

    // Left arm first, right second: the order the grips come in the pose.
    this.arms = [1, -1].map((side) => {
      const a = asset.arms.find((arm) => arm.side === side)
      const chain = chainOf(`arm ${a.id}`, a.chain)
      const S = resolve(a.shoulder), E = resolve(a.elbow), W = resolve(a.wrist)
      const iS = chain.indexOf(S), iE = chain.indexOf(E), iW = chain.indexOf(W)
      if (!(iS >= 0 && iE > iS && iW > iE)) throw new Error(`VrBody: arm ${a.id} does not run shoulder, elbow, wrist down its chain`)
      const pole = new THREE.Vector3(POLE.x, POLE.y, -side * POLE_OUT).normalize()
      return { id: a.id, S: slot(S), E: slot(E), W: slot(W), pole, w: 0, on: false, target: new THREE.Vector3() }
    })
    // Every bone a solve composes: the ancestors of both wrists, the head and the waist, in tree order.
    const need = new Set()
    for (const b of [...this.arms.map((a) => a.W.bone), this.top.bone, this.waist.bone]) for (let x = b; x?.isBone; x = x.parent) need.add(x)
    this.path = bones.map((b, i) => (need.has(b) ? i : -1)).filter((i) => i >= 0).map((i) => ({ bone: bones[i], i, par: bones[i].parent?.isBone ? index.get(bones[i].parent) : -1 }))
    this.pos = bones.map(() => new THREE.Vector3())
    this.quat = bones.map(() => new THREE.Quaternion())
    this.dirty = false

    // Where the body stands and faces in the world, whether it is walking to its head and turning to it, and the clip under it.
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0
    this.headYaw = 0
    this.placed = false
    this.gliding = false
    this.aloft = false
    this.running = false
    this.pace = 0
    this.turning = false
    this.clip = 'idle'
    // For the solve: the headset and the head's turn off its rest, in body space, how far the targets are held, and the crouch -- metres the hips sink, radians the waist bends.
    this.headAt = new THREE.Vector3()
    this.headTurn = new THREE.Quaternion()
    this.hold = 0
    this.crouch = 0
    this.lean = 0
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
    const eye = EYE_LINE * this.height * this.k

    // Where the body would stand with its neck under the head -- the neck as the crouch's lean carries it forward,
    // since a head that goes forward as she bends is the lean, not a step. A body not yet placed stands there at once, facing as she does.
    if (!this.placed) { this.yaw = headYaw; this.y = hy - eye }
    // The crouch, off the ground it last stood on: the headset below the standing eyes by more than the neck's slack
    // bends the waist, further the deeper it goes, and the hips take up exactly what the bend has not, as far as the legs fold.
    // A body in the air hangs straight; a descent is not a squat.
    const deficit = this.aloft ? 0 : Math.max(0, this.y + eye - hy - HEAD_SLACK_M) * this.hold
    this.lean = LEAN_MAX * Math.min(1, deficit / (this.crouchMax * this.k + this.leanDrop(LEAN_MAX)))
    this.crouch = Math.min(this.crouchMax * this.k, Math.max(0, deficit - this.leanDrop(this.lean)))
    const nx = (this.neckRest.x + this.leanReach(this.lean)) * this.k, nz = this.neckRest.z * this.k
    const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw)
    const underX = hx - (nx * cs + nz * sn), underZ = hz - (nz * cs - nx * sn)
    if (!this.placed) {
      this.placed = true
      this.x = underX; this.z = underZ
    }
    let dx = underX - this.x, dz = underZ - this.z
    let dist = Math.hypot(dx, dz)
    if (!this.gliding && dist > TELEPORT_M) { this.gliding = true; this.running = false; this.pace = 0 }
    // In the air: the head higher over the ground than a standing body's eyes by more than FLY_M -- flying, or a lake bed under
    // a boat's sole the ceiling rule can never lift it onto. The body is carried under its head, feet loose, until ground comes
    // up under it. On a trip the ground under the HEAD decides, read as a body stood there would, so a teleport up a hill is
    // still walked and a flight is never walked after.
    const ground = this.walk.heightAt(this.x, this.z, this.y)
    this.aloft = hy - (this.gliding ? this.walk.heightAt(underX, underZ, hy - eye) : ground) > eye + FLY_M
    if (this.aloft) this.gliding = false
    let faceYaw = headYaw
    let facingTravel = false
    if (this.gliding && dist <= GLIDE_STOP_M) this.gliding = false
    else if (this.gliding) {
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
    // Not on a trip, it stands under its head, idle.
    if (!this.gliding) { this.x = underX; this.z = underZ; dx = dz = dist = 0; this.clip = 'idle' }
    // The body turns under a twisted neck, and to face a long walk.
    const twist = wrap(faceYaw - this.yaw)
    if (facingTravel || Math.abs(twist) > YAW_SLACK) this.turning = true
    else if (Math.abs(twist) < YAW_SETTLE) this.turning = false
    if (this.turning) this.yaw = wrap(this.yaw + twist * (1 - Math.exp(-dt / TURN_TAU_S)))
    // Under its head in the air, else on the ground where it stands, read from where it last stood so that stone over its head is not ground.
    this.y = this.aloft ? hy - eye : this.walk.heightAt(this.x, this.z, this.y)

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
    this.headAt.set(hx, hy, hz).applyMatrix4(this.bodyInv)
    // The head's turn off its rest, in body space: the headset's yaw against the body's, clamped to what a neck does, then its tilt.
    const neckYaw = Math.max(-NECK_MAX, Math.min(NECK_MAX, wrap(headYaw - this.yaw)))
    this.headTurn.setFromAxisAngle(UP, neckYaw)
      .multiply(_q2.setFromAxisAngle(UP, -headYaw).multiply(_quat))
      .multiply(UNFACING_X)
    for (let i = 0; i < 2; i++) {
      const at = 7 + i * 7
      this.arms[i].target.set(pose[at], pose[at + 1], pose[at + 2]).applyMatrix4(this.bodyInv)
    }

    // Standing, the feet are planted to the ground under each and the hips sunk by the crouch; walking or in the air, they are the clip's.
    if (this.gliding || this.aloft) this.puppet.unplant()
    else {
      const feet = this.puppet.feet
      const cs = Math.cos(this.yaw), sn = Math.sin(this.yaw)
      for (let i = 0; i < feet.length; i++) {
        const fx = feet[i].x * this.k, fz = feet[i].z * this.k
        this.dys[i] = (this.walk.heightAt(this.x + fx * cs + fz * sn, this.z - fx * sn + fz * cs, this.y) - this.y) / this.k
      }
      this.puppet.plant(this.dys, this.yaw, this.crouch / this.k)
    }

    if (!this.gliding) this.puppet.play('idle')
    this.puppet.step(dt)
    this.puppet.group.matrix.copy(this.body)
    this.puppet.group.matrixWorldNeedsUpdate = true
  }

  /** Metres the neck comes down when the waist bends forward by `lean`, the torso turning about it, and creature units it goes forward. */
  leanDrop(lean) {
    return (this.torso.y * (1 - Math.cos(lean)) + this.torso.x * Math.sin(lean)) * this.k
  }

  leanReach(lean) {
    return this.torso.x * (Math.cos(lean) - 1) + this.torso.y * Math.sin(lean)
  }

  /** Put back what the last solve wrote, so the mixer starts from the clip. */
  restore() {
    if (!this.dirty) return
    this.dirty = false
    for (const h of this.head) h.bone.quaternion.copy(h.saved)
    this.neck.bone.position.copy(this.neckSavedPos)
    this.waist.bone.quaternion.copy(this.waist.saved)
    for (const arm of this.arms) for (const j of [arm.S, arm.E]) j.bone.quaternion.copy(j.saved)
  }

  /** Off at once, nothing written: for a puppet handed back. */
  reset() {
    this.restore()
    this.hold = 0
    this.lean = 0
    this.crouch = 0
    for (const arm of this.arms) arm.w = 0
  }

  /** The pose as the bones now stand, in body space, down every path a solve writes on. */
  compose() {
    for (const { bone, i, par } of this.path) {
      if (par < 0) {
        this.pos[i].copy(bone.position)
        this.quat[i].copy(bone.quaternion)
      } else {
        this.quat[i].multiplyQuaternions(this.quat[par], bone.quaternion)
        this.pos[i].copy(bone.position).applyQuaternion(this.quat[par]).add(this.pos[par])
      }
    }
  }

  /** Over the pose the mixer just wrote, and the feet: the waist bent to the crouch, the head to the headset, each held arm's wrist to its grip. */
  solve() {
    if (this.hold <= 0 && this.lean <= 0 && this.arms.every((a) => a.w <= 0)) return
    this.compose()
    for (const h of this.head) h.saved.copy(h.bone.quaternion)
    this.neckSavedPos.copy(this.neck.bone.position)
    this.waist.saved.copy(this.waist.bone.quaternion)
    for (const arm of this.arms) for (const j of [arm.S, arm.E]) j.saved.copy(j.bone.quaternion)
    this.dirty = true

    if (this.lean > 0) {
      // The waist bends forward, and the torso, arms and head above it go with it: the rest is solved over that.
      _q.setFromAxisAngle(SIDE, -this.lean)
      turnInBody(this.waist.bone, this.waist.par >= 0 ? this.quat[this.waist.par] : null, _q)
      this.waist.bone.updateMatrix()
      this.compose()
    }
    if (this.hold > 0) this._solveHead()
    for (const arm of this.arms) if (arm.w > 0) this._solveArm(arm)
  }

  _solveHead() {
    const w = this.hold
    // From the head the clip posed to the headset's turn of the rest head, in body space, all of it at the neck.
    _q2.copy(this.headTurn).multiply(this.topRestQuat).multiply(_q.copy(this.quat[this.top.i]).invert())
    if (w < 1) _q2.slerp(IDENTITY_Q, 1 - w)
    const neck = this.neck
    turnInBody(neck.bone, neck.par >= 0 ? this.quat[neck.par] : null, _q2)
    for (const h of this.head) this.quat[h.i].premultiply(_q2)
    // And stretches, straight up or down, to put the eyes, turned with the head, at the headset, as far as the slack lets it, in its parent's frame.
    _t.copy(this.eyeOffset).applyQuaternion(this.headTurn).add(this.pos[neck.i])
    _t.subVectors(this.headAt, _t)
    const slack = HEAD_SLACK_M / this.k
    _t.set(0, Math.max(-slack, Math.min(slack, _t.y)) * w, 0)
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
  }
}
