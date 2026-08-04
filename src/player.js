import * as THREE from 'three'
import { WORLD_HALF } from './sim/terrain-height.js'

// ---------------------------------------------------------------------------
// Locomotion and comfort. DESIGN.md §4 and §12.
//
// She is a first-time-ish VR user, so comfort outranks capability everywhere
// these two conflict.
// ---------------------------------------------------------------------------

export const LOCOMOTION = {
  maxSpeed: 1.45, // m/s -- normal walking pace
  accelTau: 0.5, // seconds; the ease-in curve is what prevents nausea, not the top speed
  maxSlopeDeg: 38, // §4 -- this is what makes traps impossible by construction
  snapDeg: 60, // §12 -- one tunable constant, easy to try 45 instead
  snapEnter: 0.75, // stick deflection to fire a snap turn
  snapExit: 0.4, // must fall back below this before it can fire again
  vertTau: 0.12, // vertical damping; pitch and bob from naive terrain-following is a nausea source
  eyeHeight: 1.65, // desktop only -- in XR the headset supplies this
  stickDeadzone: 0.18,

  // --- fly mode: a DESKTOP SURVEY TOOL, not a game mechanic ----------------
  // Reading a 16 km procedural world on foot at 1.45 m/s is not feasible, and
  // the tuning decisions in §3 (ridge frequency, terrace gating, cliff amount)
  // are all macro-scale judgements. So desktop gets a free camera.
  //
  // It is disabled on entering XR and bound to no controller button. Free
  // flight at 14.5 m/s with no ground reference is a nausea generator, and §12
  // gives comfort priority over capability wherever they conflict.
  flySpeed: 14.5, // 10x walking
  flyAccelTau: 0.15, // snappier than walking; nothing here is about comfort
  flyClearance: 2.0, // stay this far above ground, so she cannot fly inside a mountain
}

const UP = new THREE.Vector3(0, 1, 0)

export class Player {
  constructor(rig, camera, terrainHeight) {
    this.rig = rig
    this.camera = camera
    this.th = terrainHeight

    this.speed = 0
    this.snapArmed = true
    this.smoothY = null
    this.blocked = false // true when the slope limiter refused a move, for the HUD
    this.flying = false

    this._head = new THREE.Vector3()
    this._quat = new THREE.Quaternion()
    this._fwd = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._step = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._maxTan = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180)
  }

  // World XZ of her head. Everything -- terrain height, slope tests, movement
  // origin -- keys off the head rather than the rig, because in roomscale those
  // drift apart and the head is where she actually thinks she is.
  headPosition(out = this._head) {
    this.camera.getWorldPosition(out)
    return out
  }

  spawnAt(x, z) {
    this.rig.position.set(x, this.th.heightAt(x, z), z)
    this.smoothY = this.rig.position.y
    this.speed = 0
  }

  // Desktop only. Leaves her at her current altitude on entry so the view does
  // not jump, and drops her back onto the ground on exit.
  setFlying(on) {
    if (this.flying === on) return
    this.flying = on
    this.speed = 0
    this.blocked = false
    if (!on) {
      const head = this.headPosition()
      this.rig.position.y = this.th.heightAt(head.x, head.z)
      this.smoothY = this.rig.position.y
    }
  }

  // input: {move: -1..1 forward/back, strafe: -1..1, turn: raw stick X, unstick: bool}
  update(dt, input) {
    const L = LOCOMOTION
    const head = this.headPosition()
    const strafe = input.strafe ?? 0

    this._snapTurn(input.turn, head)

    // Deadzone applies to magnitude, so pulling back works the same as forward.
    const fwdIn = Math.abs(input.move) > L.stickDeadzone ? THREE.MathUtils.clamp(input.move, -1, 1) : 0
    const strafeIn = Math.abs(strafe) > L.stickDeadzone ? THREE.MathUtils.clamp(strafe, -1, 1) : 0
    const demand = Math.min(1, Math.hypot(fwdIn, strafeIn))

    const top = this.flying ? L.flySpeed : L.maxSpeed
    const tau = this.flying ? L.flyAccelTau : L.accelTau
    if (demand > 0) {
      this.speed += (demand * top - this.speed) * (1 - Math.exp(-dt / tau))
    } else {
      this.speed = 0 // instant stop on release (§12)
    }

    if (this.flying) {
      this._fly(dt, fwdIn, strafeIn, demand)
      return
    }

    if (this.speed > 0.001) this._tryMove(this.speed * dt, head, fwdIn, strafeIn, demand)

    if (input.unstick) this._unstick(head)

    // Terrain following with damping. Recompute the head XZ because _tryMove
    // may have shifted the rig.
    this.headPosition(head)
    const ground = this.th.heightAt(head.x, head.z)
    if (this.smoothY === null) this.smoothY = ground
    this.smoothY += (ground - this.smoothY) * (1 - Math.exp(-dt / L.vertTau))
    this.rig.position.y = this.smoothY
  }

  // Free 6DOF flight. Forward follows the full look direction including pitch,
  // so "any direction" is just a matter of where she is looking -- which is one
  // fewer control to explain than dedicated ascend/descend keys.
  _fly(dt, fwdIn, strafeIn, demand) {
    if (this.speed <= 0.001 || demand <= 0) return

    this.camera.getWorldQuaternion(this._quat)
    this._fwd.set(0, 0, -1).applyQuaternion(this._quat)
    this._right.set(1, 0, 0).applyQuaternion(this._quat)
    this._right.y = 0 // strafe stays level even when looking up or down
    if (this._right.lengthSq() > 1e-6) this._right.normalize()

    this._step
      .set(0, 0, 0)
      .addScaledVector(this._fwd, fwdIn / demand)
      .addScaledVector(this._right, strafeIn / demand)

    const len = this._step.length()
    if (len < 1e-6) return
    this._step.multiplyScalar((this.speed * dt) / len)

    const p = this.rig.position
    p.x = THREE.MathUtils.clamp(p.x + this._step.x, -WORLD_HALF + 32, WORLD_HALF - 32)
    p.z = THREE.MathUtils.clamp(p.z + this._step.z, -WORLD_HALF + 32, WORLD_HALF - 32)
    p.y += this._step.y

    // Never below the ground. Flying inside a mountain is disorienting and the
    // only way out is guesswork, so the floor just pushes her back up.
    const head = this.headPosition()
    const floor = this.th.heightAt(head.x, head.z) + LOCOMOTION.flyClearance
    if (p.y < floor) p.y = floor
    this.smoothY = p.y
  }

  _snapTurn(stickX, head) {
    const L = LOCOMOTION
    const mag = Math.abs(stickX)
    if (this.snapArmed && mag > L.snapEnter) {
      const angle = (-Math.sign(stickX) * L.snapDeg * Math.PI) / 180
      this._q.setFromAxisAngle(UP, angle)
      // Rotate about her head, not the rig origin. Rotating about the rig would
      // swing her sideways through the world, which reads as being shoved.
      this.rig.position.sub(head).applyQuaternion(this._q).add(head)
      this.rig.quaternion.premultiply(this._q)
      this.snapArmed = false
    } else if (mag < L.snapExit) {
      this.snapArmed = true
    }
  }

  // fwdIn/strafeIn are signed; demand is their magnitude. In XR strafeIn is
  // always 0 -- §12 keeps VR locomotion forward-only, and this stays a desktop
  // convenience rather than becoming a second way to move in the headset.
  _tryMove(dist, head, fwdIn, strafeIn, demand) {
    this.camera.getWorldQuaternion(this._quat)
    this._fwd.set(0, 0, -1).applyQuaternion(this._quat)
    this._fwd.y = 0
    if (this._fwd.lengthSq() < 1e-6) return // looking straight up or down
    this._fwd.normalize()
    this._right.set(this._fwd.z, 0, -this._fwd.x) // right-hand perpendicular on the ground plane

    this._step
      .set(0, 0, 0)
      .addScaledVector(this._fwd, fwdIn / demand)
      .addScaledVector(this._right, strafeIn / demand)
    const len = Math.hypot(this._step.x, this._step.z)
    if (len < 1e-6) return
    // Reuse _fwd as the actual travel direction: everything below -- the slope
    // test and the contour slide -- is about where she is going, not where she
    // is looking, and those differ as soon as strafing exists.
    this._fwd.set(this._step.x / len, 0, this._step.z / len)

    let dx = this._fwd.x * dist
    let dz = this._fwd.z * dist

    if (!this._walkable(head.x, head.z, dx, dz, dist)) {
      // Too steep head-on. Slide along the contour instead of stopping dead --
      // stopping at a wall she is pressed against feels broken, whereas sliding
      // reads as "the mountain is steering me", which is the intended experience.
      const eps = 1.0
      const gx = (this.th.heightAt(head.x + eps, head.z) - this.th.heightAt(head.x - eps, head.z)) / (2 * eps)
      const gz = (this.th.heightAt(head.x, head.z + eps) - this.th.heightAt(head.x, head.z - eps)) / (2 * eps)
      let cx = -gz
      let cz = gx
      const clen = Math.hypot(cx, cz)
      if (clen < 1e-6) {
        this.blocked = true
        return
      }
      cx /= clen
      cz /= clen
      if (cx * this._fwd.x + cz * this._fwd.z < 0) {
        cx = -cx
        cz = -cz
      }
      dx = cx * dist
      dz = cz * dist
      if (!this._walkable(head.x, head.z, dx, dz, dist)) {
        this.blocked = true
        return
      }
    }

    this.blocked = false
    const nx = THREE.MathUtils.clamp(this.rig.position.x + dx, -WORLD_HALF + 32, WORLD_HALF - 32)
    const nz = THREE.MathUtils.clamp(this.rig.position.z + dz, -WORLD_HALF + 32, WORLD_HALF - 32)
    this.rig.position.x = nx
    this.rig.position.z = nz
  }

  // Symmetric on purpose: blocking steep descents as well as steep ascents is
  // exactly what guarantees she can leave anywhere she can reach (§4).
  _walkable(x, z, dx, dz, dist) {
    const h0 = this.th.heightAt(x, z)
    const h1 = this.th.heightAt(x + dx, z + dz)
    return Math.abs(h1 - h0) / dist <= this._maxTan
  }

  _unstick(head) {
    if (this.th.slopeAt(head.x, head.z) <= (LOCOMOTION.maxSlopeDeg * Math.PI) / 180) return
    for (let r = 3; r <= 80; r += 3) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2 + r * 0.37
        const tx = head.x + Math.cos(ang) * r
        const tz = head.z + Math.sin(ang) * r
        if (this.th.slopeAt(tx, tz) <= (LOCOMOTION.maxSlopeDeg * Math.PI) / 180) {
          this.rig.position.x += tx - head.x
          this.rig.position.z += tz - head.z
          this.speed = 0
          return
        }
      }
    }
    console.warn('unstick found no walkable cell within 80 m')
  }

  // Zero the accumulated roomscale offset without moving her in the world:
  // shift the XR reference space so the head becomes its origin, then shift the
  // rig by the same amount so her view does not jump.
  //
  // Position only, never yaw. Recentring yaw spins the world underneath her,
  // which is precisely the vestibular mismatch §12 exists to avoid.
  recenterXR(renderer) {
    const base = renderer.xr.getReferenceSpace()
    if (!base) return false
    const local = this.camera.position // pose within the reference space
    const offset = new XRRigidTransform({ x: local.x, y: 0, z: local.z })
    renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(offset))

    const shift = new THREE.Vector3(local.x, 0, local.z).applyQuaternion(this.rig.quaternion)
    this.rig.position.x += shift.x
    this.rig.position.z += shift.z
    return true
  }
}
