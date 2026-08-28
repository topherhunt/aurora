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
  // Seconds. The ease-in curve is what prevents nausea, not the top speed -- but
  // it is nausea from a moving world your inner ear disagrees with, which only
  // happens in the headset. On a monitor the ramp is pure input lag, so the
  // desktop path passes instant:true and skips it entirely (see update()).
  accelTau: 0.5,
  // §4 -- this is what makes traps impossible by construction.
  //
  // 38 -> 50, and the number is DERIVED rather than chosen. The rule is: she can
  // walk on anything the renderer does not draw as bare rock. chunk-mesh.js
  // shade() ramps rock in over smoothstep(0.86, 0.62, ny), so rock begins to
  // show at 30.7 deg and is total at 51.7 deg -- and a limit of 38 sat inside
  // that ramp, on ground still drawn as mostly grass. Measured across a 4 km
  // box at this stride, the fraction of the world that is BLOCKED while being
  // shaded as vegetation:
  //
  //   limit   38     42     45     48     50     55
  //   grassy-blocked  7.36%  0.43%  0.00%  0.00%  0.00%  0.00%
  //   walkable       70.8%  77.8%  82.4%  86.5%  88.8%  93.6%
  //
  // 7.36% of the world looking climbable and refusing her is exactly the "areas
  // that look like they should be walkable that you can't walk on" report, and
  // it is what sent an earlier pass into the cliff layer looking for the cause.
  // It was never the terrain. 45 is where it reaches zero; 50 keeps 5 deg of
  // margin, because the limiter reads a 1.5 m stride while the shader reads a
  // per-vertex normal at whatever the LOD ring supplies, and those two do not
  // have to agree at the metre scale.
  //
  // IF THE SHADER'S RAMP MOVES, THIS MOVES WITH IT. They are one decision.
  maxSlopeDeg: 50,
  // How far an obstacle has to keep going uphill before it counts as a wall.
  // See _walkable: without it the slope limiter's baseline is one FRAME of
  // travel, 2 cm, and a 46 cm bump refuses her. Roughly two paces, and it wants
  // to stay near slopeAt()'s 1.5 m so the reachability instruments and the
  // limiter keep asking the same question.
  stride: 1.5,
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
  // flight at 29 m/s with no ground reference is a nausea generator, and §12
  // gives comfort priority over capability wherever they conflict.
  //
  // Controls are Minecraft's, because that is the muscle memory she already
  // has: hold space to rise, hold shift to sink, either combined freely with
  // WASD, double-tap space to drop back to walking.
  // Speed scales with HEIGHT ABOVE GROUND, not with a fixed rate, because the
  // two things fly mode is used for want opposite speeds. Down among the rocks
  // you are inspecting a cliff face or a treeline and 29 m/s overshoots
  // everything; up at survey altitude you are crossing a 16 km world and 29 m/s
  // is a four-minute commute. Tying it to altitude means the gesture that says
  // "I want to look at the big picture" -- climbing -- is the same gesture that
  // makes crossing it quick, with no extra control to learn.
  //
  // Linear between the two anchors and clamped outside them. Linear rather than
  // exponential, and now for a stronger reason than when the ratio was 20x: at
  // 100x a power curve is actually FASTER than linear through the low altitudes
  // that matter (at 30 m it gives 96 m/s against linear's 66), which is the
  // opposite of what "10 m/s when I'm two metres off the ground" is asking for.
  // Linear keeps the slow end slow and puts the whole 100x into the climb.
  flyLowAlt: 2,
  flyLowSpeed: 10,
  flyHighAlt: 500,
  flyHighSpeed: 1000,
  flyClearance: 2.0, // stay this far above ground, so she cannot fly inside a mountain

  // --- travel mode: double-click the ground to go there --------------------
  // Free flight at 29 m/s still makes crossing the world a two-minute commute,
  // which is too slow to compare one region against another while tuning §3.
  // This is the survey tool's survey tool: point at a place, arrive, walk.
  //
  // It is a rail, not a control mode -- she cannot steer during it. That is
  // deliberate. Steering at 500 m/s near terrain is unusable, and the whole
  // value of the gesture is that it is over before you would want to.
  travelSpeed: 500,
  travelClearance: 60, // above the HIGHEST ground on the path -- see travelTo()
  travelEase: 0.15, // fraction of the trip spent rising, and again descending
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
    this.travel = null // non-null while a double-click flight is in progress

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

  // Compass bearing of her gaze, in the same atan2(x, z) convention the quadtree
  // addresses nodes in. Terrain selection is view-dependent now (quadtree.js,
  // VIEW_HALF_ANGLE), so this is what decides which part of the world is worth
  // triangles -- read from the CAMERA rather than the rig for the same reason
  // headPosition is: in roomscale she can turn her head without the rig moving,
  // and the rig's yaw would then be pointing somewhere she is not looking.
  headYaw() {
    this.camera.getWorldQuaternion(this._quat)
    this._fwd.set(0, 0, -1).applyQuaternion(this._quat)
    return Math.atan2(this._fwd.x, this._fwd.z)
  }

  spawnAt(x, z) {
    this.rig.position.set(x, this.th.heightAt(x, z), z)
    this.smoothY = this.rig.position.y
    this.speed = 0
  }

  teleportTo(x, z) {
    this.travel = null
    this.flying = false
    this.rig.position.set(x, this.th.heightAt(x, z), z)
    this.smoothY = this.rig.position.y
    this.speed = 0
    this.blocked = false
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

  // Fly to (x, z) at travelSpeed and land there walking. Returns false if she is
  // already essentially on the spot. Desktop only -- see the note in LOCOMOTION.
  //
  // The arc is decided ONCE, here, rather than reacted to frame by frame. At
  // 500 m/s a frame covers 7 m of ground, so a ridge that a reactive altitude
  // rule would start climbing at is a ridge already hit; the only way to clear
  // terrain reliably at this speed is to know the whole profile before setting
  // off. One pass at ~40 m spacing costs a few hundred heightAt calls, which is
  // nothing against doing it wrong.
  travelTo(x, z) {
    const head = this.headPosition()
    const dist = Math.hypot(x - head.x, z - head.z)
    if (dist < 2) return false

    let peak = -Infinity
    const n = Math.max(8, Math.min(512, Math.ceil(dist / 40)))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const h = this.th.heightAt(head.x + (x - head.x) * t, head.z + (z - head.z) * t)
      if (h > peak) peak = h
    }

    this.travel = {
      fromX: head.x,
      fromZ: head.z,
      toX: x,
      toZ: z,
      dist,
      t: 0,
      startY: this.rig.position.y,
      endY: this.th.heightAt(x, z),
      cruiseY: peak + LOCOMOTION.travelClearance,
    }
    this.flying = false // travel owns the rig until it finishes
    this.blocked = false
    this.speed = LOCOMOTION.travelSpeed
    return true
  }

  cancelTravel() {
    if (!this.travel) return
    this.travel = null
    this.speed = 0
    this.flying = true // she is in the air; dropping her would be a surprise
  }

  _travelStep(dt) {
    const T = this.travel
    T.t = Math.min(1, T.t + (LOCOMOTION.travelSpeed * dt) / T.dist)

    const p = this.rig.position
    p.x = T.fromX + (T.toX - T.fromX) * T.t
    p.z = T.fromZ + (T.toZ - T.fromZ) * T.t

    // Altitude is a smoothstep up to cruise and back down, laid over a straight
    // lerp between the two ground heights. Doing it that way rather than as a
    // ballistic arc keeps it continuous at both ends by construction: the ramp
    // is 0 at t=0 and t=1, so she leaves from exactly where she was standing
    // and arrives at exactly the height of the ground she picked, with no jump
    // to correct on the frame the flight ends.
    const e = LOCOMOTION.travelEase
    const ramp = Math.min(1, Math.min(T.t, 1 - T.t) / e)
    const s = ramp * ramp * (3 - 2 * ramp)
    const base = T.startY + (T.endY - T.startY) * T.t
    p.y = base + (T.cruiseY - base) * s

    // The precomputed profile samples every ~40 m and the ground between two
    // samples can be higher than either, so keep the same floor free flight
    // uses as a backstop.
    const floor = this.th.heightAt(p.x, p.z) + LOCOMOTION.flyClearance
    if (p.y < floor) p.y = floor

    if (T.t >= 1) {
      this.travel = null
      this.speed = 0
      this.smoothY = this.th.heightAt(p.x, p.z)
      p.y = this.smoothY
    }
  }

  // input: {move: -1..1 forward/back, strafe: -1..1, lift: -1..1 up/down,
  //         turn: raw stick X, unstick: bool, instant: bool}
  update(dt, input) {
    // Travel runs before anything else and consumes the frame. Input is ignored
    // rather than blended: see the note on it being a rail in LOCOMOTION.
    if (this.travel) {
      this._travelStep(dt)
      return
    }

    const L = LOCOMOTION
    const head = this.headPosition()
    const strafe = input.strafe ?? 0

    this._snapTurn(input.turn, head)

    // Deadzone applies to magnitude, so pulling back works the same as forward.
    const fwdIn = Math.abs(input.move) > L.stickDeadzone ? THREE.MathUtils.clamp(input.move, -1, 1) : 0
    const strafeIn = Math.abs(strafe) > L.stickDeadzone ? THREE.MathUtils.clamp(strafe, -1, 1) : 0
    const liftIn = THREE.MathUtils.clamp(input.lift, -1, 1)
    const demand = Math.min(1, Math.hypot(fwdIn, strafeIn))

    // Vertical has to count toward demand while flying, or holding space with no
    // other key would ask for full lift at zero speed and simply do nothing. On
    // the ground it must NOT count: lift is meaningless there and folding it in
    // would make the ascend key double as a walk key.
    const drive = this.flying ? Math.min(1, Math.hypot(demand, liftIn)) : demand

    const top = this.flying ? this.flySpeedAt(head) : L.maxSpeed
    if (drive <= 0) {
      this.speed = 0 // instant stop on release (§12)
    } else if (input.instant) {
      this.speed = drive * top
    } else {
      this.speed += (drive * top - this.speed) * (1 - Math.exp(-dt / L.accelTau))
    }

    if (this.flying) {
      this._fly(dt, fwdIn, strafeIn, liftIn, input.flyDirection)
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

  // Fly speed at a given head position, from height above the ground directly
  // below. The HUD already shows both halves of this -- `agl` and `speed` on the
  // position block -- which is what makes a speed that changes on its own
  // legible rather than mysterious.
  flySpeedAt(head) {
    const L = LOCOMOTION
    const alt = head.y - this.th.heightAt(head.x, head.z)
    const t = THREE.MathUtils.clamp((alt - L.flyLowAlt) / (L.flyHighAlt - L.flyLowAlt), 0, 1)
    return L.flyLowSpeed + (L.flyHighSpeed - L.flyLowSpeed) * t
  }

  // Free 6DOF flight. Forward follows the full look direction including pitch,
  // so she can dive at a valley just by looking at it -- and `liftIn` is world
  // up regardless of where she is looking, which is what makes "hold space to
  // rise" behave the way it does in Minecraft rather than the way "forward"
  // does. Both at once compose into a diagonal, as they should.
  _fly(dt, fwdIn, strafeIn, liftIn, flyDirection = null) {
    if (this.speed <= 0.001) return

    if (flyDirection) this._fwd.copy(flyDirection)
    else {
      this.camera.getWorldQuaternion(this._quat)
      this._fwd.set(0, 0, -1).applyQuaternion(this._quat)
    }
    this._right.set(1, 0, 0).applyQuaternion(this._quat)
    this._right.y = 0 // strafe stays level even when looking up or down
    if (this._right.lengthSq() > 1e-6) this._right.normalize()

    // Built raw and normalised below. The old version pre-divided each term by
    // `demand` and then normalised anyway, which was redundant -- and with
    // vertical input in the mix `demand` can be zero, so it was also a divide by
    // zero waiting to happen.
    this._step
      .set(0, 0, 0)
      .addScaledVector(this._fwd, fwdIn)
      .addScaledVector(this._right, strafeIn)
    this._step.y += liftIn

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
    // Right-hand perpendicular on the ground plane. Sign matters and is easy to
    // get backwards: facing -Z (three's default forward) must give +X, so it is
    // (-fwd.z, 0, fwd.x). The other sign points left and silently swaps the
    // strafe keys, which is exactly what it did.
    this._right.set(-this._fwd.z, 0, this._fwd.x)

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
  //
  // Two baselines, and she is stopped only when BOTH of them say wall.
  //
  // The immediate one is the original test and carries the whole of §4's
  // argument: its probe pair IS her travel pair, so the step that let her in is
  // bit-identical to the step that lets her back out, and reversibility is a
  // property of the arithmetic rather than of the terrain. What it is not is a
  // slope test. `dist` is one frame of travel -- 1.45 m/s at 72 Hz is 2 cm -- so
  // a 46 cm patch of 42 deg stops her dead where a person would step over it,
  // and that single fact is what three successive terrain operators were written
  // to make visible before it was measured. None of them could have: no amount
  // of sculpting makes a 46 cm feature legible. It was the wrong layer.
  //
  // The stride baseline asks what a walker actually asks -- is this still uphill
  // two paces from now? -- so anything shorter than a stride averages out and a
  // real cliff does not. Taking the min rather than replacing the immediate test
  // matters: a lookahead on its own reads the cliff from 1.5 m back and stops
  // her there, which is an invisible standoff bubble around every wall. This way
  // she walks right up to the foot of it, and the contour slide above still has
  // the near test to slide her along.
  //
  // The extra sample is only paid on the frames the immediate test already
  // failed, which are the frames she is not moving anyway.
  _walkable(x, z, dx, dz, dist) {
    const h0 = this.th.heightAt(x, z)
    const h1 = this.th.heightAt(x + dx, z + dz)
    if (Math.abs(h1 - h0) / dist <= this._maxTan) return true
    const k = LOCOMOTION.stride / dist
    const h2 = this.th.heightAt(x + dx * k, z + dz * k)
    return Math.abs(h2 - h0) / LOCOMOTION.stride <= this._maxTan
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
