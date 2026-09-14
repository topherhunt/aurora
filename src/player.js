import THREE from './three-instance.js'
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
// Metres between the samples pathClear takes along a line. Under the smallest
// padded trunk's diameter (a 3 cm sapling plus WalkSurface's 15 cm pad).
const PATH_STEP = 0.3

export class Player {
  constructor(rig, camera, terrainHeight) {
    this.rig = rig
    this.camera = camera
    this.th = terrainHeight
    // Solid things she walks AROUND rather than over -- v2's tree trunks, via
    // WalkSurface.obstacleAt. v1's TerrainHeight has none, so the hook is
    // optional and the check below is skipped without it.
    this.obstacles = typeof terrainHeight.obstacleAt === 'function' ? terrainHeight : null
    this._obstacle = { x: 0, z: 0, r: 0 }
    // Her capsule against the stone -- v2's WalkSurface.fits, which also makes
    // its heightAt read from a foot height. v1 has neither; its heightAt ignores
    // the third argument and the headroom check below is skipped.
    this.capsule = typeof terrainHeight.fits === 'function' ? terrainHeight : null
    this._push = { x: 0, z: 0 }
    this._inStone = null

    this.speed = 0
    this.snapArmed = true
    this.smoothY = null
    // The ground under her feet, undamped, and what the next ground query is
    // asked FROM: which stone is a step and which is a ceiling depends on where
    // her feet are, and the damped smoothY lags a mantle by up to its whole
    // rise. null until she has stood somewhere.
    this.standY = null
    this.blocked = false // true when the slope limiter refused a move, for the HUD
    this.flying = false
    this.travel = null // non-null while a double-click flight is in progress

    this._head = new THREE.Vector3()
    this._origin = new THREE.Vector3()
    this._quat = new THREE.Quaternion()
    this._fwd = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._step = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._maxTan = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180)
  }

  // World position of her head, which is where she is LOOKING FROM.
  //
  // Used for what the eye decides: which way she walks, what the terrain
  // selection points at, which way a snap turn pivots. NOT for terrain height
  // or slope -- those key off originPosition below, and the comment there says
  // why the two must not be confused.
  headPosition(out = this._head) {
    this.camera.getWorldPosition(out)
    return out
  }

  // Where LOCOMOTION is, as opposed to where her head is.
  //
  // The rig is what the sticks move. The head is the rig PLUS whatever the HMD
  // reports for her physical pose in the play space, so the two differ by
  // however far she has leaned or stepped -- up to a couple of metres in
  // roomscale, and a few centimetres just from breathing.
  //
  // Ground following, the slope tests and the fly floor all key off THIS rather
  // than off the head, and that is a comfort requirement rather than a
  // preference. Sampling the ground under her HEAD means leaning on a slope
  // re-samples it at a different point, so `rig.position.y` moves, so the whole
  // world heaves up or down underneath a head that only translated sideways.
  // That is a vestibular mismatch -- the eyes report vertical motion the inner
  // ear did not -- and it is the fastest way to make somebody sick in a headset.
  // On desktop the camera is a child of the rig at (0, eyeHeight, 0), so this
  // returns the same XZ headPosition does and nothing changes.
  //
  // DIRECTION still comes from the head: she walks where she is looking, and
  // _snapTurn still rotates about the head so a turn does not shove her
  // sideways through the world.
  originPosition(out = this._origin) {
    this.rig.getWorldPosition(out)
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
    this.smoothY = this.standY = this.rig.position.y
    this.speed = 0
  }

  teleportTo(x, z) {
    this.travel = null
    this.flying = false
    this.rig.position.set(x, this.th.heightAt(x, z), z)
    this.smoothY = this.standY = this.rig.position.y
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
      // Asked from where she is hovering, so a landing under an overhang is on
      // the ground beneath it rather than on top of the stone.
      const origin = this.originPosition()
      this.rig.position.y = this.th.heightAt(origin.x, origin.z, origin.y)
      this.smoothY = this.standY = this.rig.position.y
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
      this.smoothY = this.standY = this.th.heightAt(p.x, p.z, p.y)
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
    const origin = this.originPosition()
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

    const top = this.flying ? this.flySpeedAt(origin) : L.maxSpeed
    if (drive <= 0) {
      this.speed = 0 // instant stop on release (§12)
    } else if (input.instant) {
      this.speed = drive * top
    } else {
      this.speed += (drive * top - this.speed) * (1 - Math.exp(-dt / L.accelTau))
    }

    // TEMPORARY diagnostic for the "walking glides like ice" report: prints
    // once a second, while actually moving, whether `instant` is really true
    // and what speed/top/flying actually resolved to. Remove once confirmed.
    if (drive > 0) {
      const now = performance.now()
      if (!this._lastMoveLog || now - this._lastMoveLog > 1000) {
        this._lastMoveLog = now
        console.warn('[player] move:', {
          instant: input.instant, flying: this.flying, drive, top,
          speed: this.speed, dt, accelTau: L.accelTau,
        })
      }
    } else {
      this._lastMoveLog = 0
    }

    if (this.flying) {
      this._fly(dt, fwdIn, strafeIn, liftIn, input.flyDirection)
      return
    }

    if (this.speed > 0.001) this._tryMove(this.speed * dt, origin, fwdIn, strafeIn, demand)

    if (input.unstick) this._unstick(origin)

    // Terrain following with damping. Recompute the origin because _tryMove may
    // have shifted the rig.
    this.originPosition(origin)
    const ground = this.standY === null
      ? this.th.heightAt(origin.x, origin.z)
      : this.th.heightAt(origin.x, origin.z, this.standY)
    this.standY = ground
    if (this.smoothY === null) this.smoothY = ground
    this.smoothY += (ground - this.smoothY) * (1 - Math.exp(-dt / L.vertTau))
    this.rig.position.y = this.smoothY
  }

  // Fly speed at a given locomotion origin, from height above the ground
  // directly below. The HUD already shows both halves of this -- `agl` and
  // `speed` on the position block -- which is what makes a speed that changes on
  // its own legible rather than mysterious.
  flySpeedAt(origin) {
    const L = LOCOMOTION
    const alt = origin.y - this.th.heightAt(origin.x, origin.z)
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
    // only way out is guesswork, so the floor just pushes her back up. On the
    // origin, not the head: a floor that tracked the head would lift the rig
    // whenever she leaned out over a drop. See originPosition.
    const origin = this.originPosition()
    const floor = this.th.heightAt(origin.x, origin.z) + LOCOMOTION.flyClearance
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
  _tryMove(dist, origin, fwdIn, strafeIn, demand) {
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
    // Before the first ground-following pass there is no foot height to ask
    // from, and the topmost surface is the one she was spawned on.
    if (this.standY === null) this.standY = this.th.heightAt(origin.x, origin.z)
    const y = this.standY
    this._inStone = null

    let h1 = this._walkable(origin.x, origin.z, y, dx, dz, dist)
    if (Number.isNaN(h1)) {
      // Too steep head-on. Slide along the contour instead of stopping dead --
      // stopping at a wall she is pressed against feels broken, whereas sliding
      // reads as "the mountain is steering me", which is the intended experience.
      const eps = 1.0
      const gx = (this.th.heightAt(origin.x + eps, origin.z, y) - this.th.heightAt(origin.x - eps, origin.z, y)) / (2 * eps)
      const gz = (this.th.heightAt(origin.x, origin.z + eps, y) - this.th.heightAt(origin.x, origin.z - eps, y)) / (2 * eps)
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
      h1 = this._walkable(origin.x, origin.z, y, dx, dz, dist)
      if (Number.isNaN(h1)) {
        this.blocked = true
        return
      }
    }

    // Stone at head height -- an overhang too low, or a boulder's flank at her
    // shoulder. Slid along exactly as a trunk is below: the step is projected
    // onto the tangent of the push direction fits() reports, and a push with no
    // side to favour stops her. Only ENTERING stone blocks, see _enters.
    if (this._enters(origin.x + dx, origin.z + dz, y, h1, this._push)) {
      const tx = -this._push.z
      const tz = this._push.x
      const along = tx * dx + tz * dz
      if (Math.abs(along) < 0.05 * dist) {
        this.blocked = true
        return
      }
      dx = tx * along
      dz = tz * along
      h1 = this._walkable(origin.x, origin.z, y, dx, dz, Math.abs(along))
      if (Number.isNaN(h1) || this._enters(origin.x + dx, origin.z + dz, y, h1, null)) {
        this.blocked = true
        return
      }
    }

    // A trunk in the way. Only ENTERING one blocks: if she is already inside --
    // a tile regrown under her, a spawn on a sapling -- every step out would
    // be refused too, and she would be stuck in a tree. The step is projected
    // onto the bark's tangent, NOT redirected along it at full speed like the
    // contour slide: walking straight at a tree stops her at it, brushing past
    // one deflects her round it, and neither reads as being shoved.
    if (this.obstacles && !this.obstacles.obstacleAt(origin.x, origin.z, this._obstacle)) {
      const ob = this.obstacles.obstacleAt(origin.x + dx, origin.z + dz, this._obstacle)
      if (ob) {
        let tx = -(origin.z - ob.z)
        let tz = origin.x - ob.x
        const tlen = Math.hypot(tx, tz)
        if (tlen < 1e-6) {
          this.blocked = true
          return
        }
        tx /= tlen
        tz /= tlen
        const along = tx * dx + tz * dz
        if (Math.abs(along) < 0.05 * dist) {
          this.blocked = true
          return
        }
        dx = tx * along
        dz = tz * along
        h1 = this._walkable(origin.x, origin.z, y, dx, dz, Math.abs(along))
        if (Number.isNaN(h1) || this._enters(origin.x + dx, origin.z + dz, y, h1, null) ||
          this.obstacles.obstacleAt(origin.x + dx, origin.z + dz, this._obstacle)) {
          this.blocked = true
          return
        }
      }
    }

    this.blocked = false
    const nx = THREE.MathUtils.clamp(this.rig.position.x + dx, -WORLD_HALF + 32, WORLD_HALF - 32)
    const nz = THREE.MathUtils.clamp(this.rig.position.z + dz, -WORLD_HALF + 32, WORLD_HALF - 32)
    this.rig.position.x = nx
    this.rig.position.z = nz
    // The ground at the far end of the step is the ground she now stands on,
    // and what update() asks the next one from -- a mantle onto a ledge is
    // decided here, not by the damped follower.
    this.standY = h1
  }

  // Whether a step from feet at `y` to (x, z), feet at `h`, would take her INTO
  // stone at head height that she is not already in. If she is already in it
  // -- a tile regrown under her, a spawn inside a boulder -- every step out
  // would be refused too, so the check is waived, the same way a trunk only
  // blocks on entry. Whether she is in stone is asked once per _tryMove and
  // only on the frames a step is refused, which are the frames she is not
  // moving anyway. `_origin` is the origin _tryMove was handed, and `standY`
  // her feet there.
  //
  // JUDGED FROM THE HIGHER OF THE TWO FOOT HEIGHTS. Stepping off a ledge drops
  // her feet by up to reach in one 2 cm step, and judged from the lower height
  // the ledge she was just standing on is stone at her shoulder: she could
  // climb every step and get down off none. A body that has not fallen yet is
  // still at the upper height, so that is where the head volume is taken.
  _enters(x, z, y, h, out) {
    if (!this.capsule || this.capsule.fits(x, z, y > h ? y : h, out)) return false
    if (this._inStone === null) {
      this._inStone = !this.capsule.fits(this._origin.x, this._origin.z, this.standY, null)
    }
    return !this._inStone
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
  //
  // EVERY HEIGHT IS ASKED FROM HER FEET, `y` at the near end and the near end's
  // answer at the far, so a stone over her head is not ground at either. On
  // stone the probe pair is therefore near-identical rather than bit-identical:
  // the ground at (x, z) asked from `h1` on the way back can be a stone the way
  // out could not reach, if one tops out in (y + reach, h1 + reach]. It is
  // always within the slope rule of where she is, so she is never fenced in --
  // she can only find herself seated on a slightly different surface coming
  // back than going. design/04-traversability.md has the argument.
  /**
   * Whether she could WALK the straight line from (x0, z0) to (x1, z1): every
   * step of it passes the slope rule below and none enters a trunk. What the
   * teleport asks before it accepts a landing, so a lob over a boulder or round
   * a tree cannot reach ground her feet could not. Straight-line only -- the
   * contour slide might get her round a small obstacle, but "can I go THAT way"
   * is the question being asked. Steps are shorter than the thinnest padded
   * trunk so a sapling cannot fall between two samples.
   */
  pathClear(x0, z0, x1, z1) {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const n = Math.max(1, Math.ceil(len / PATH_STEP))
    const dx = (x1 - x0) / n
    const dz = (z1 - z0) / n
    const step = len / n
    let x = x0
    let z = z0
    // Walked from the topmost surface at the start, which is where a teleport
    // lands her; the headroom along the way is her own line only, since a lob
    // is a coarse question and the ring's shoulder test at 30 cm buys nothing.
    let y = this.th.heightAt(x, z)
    for (let i = 0; i < n; i++) {
      let h = y
      if (step > 1e-6) {
        h = this._walkable(x, z, y, dx, dz, step)
        if (Number.isNaN(h)) return false
      }
      x += dx
      z += dz
      if (this.obstacles && this.obstacles.obstacleAt(x, z, this._obstacle)) return false
      // The higher foot height, as _enters does, so a path can step down.
      if (this.capsule && !this.capsule.fits(x, z, y > h ? y : h, null)) return false
      y = h
    }
    return true
  }

  /**
   * The ground at the far end of a step from (x, z), feet at `y`, along (dx,
   * dz) of length `dist` -- or NaN when the slope rule refuses the step.
   */
  _walkable(x, z, y, dx, dz, dist) {
    const h0 = this.th.heightAt(x, z, y)
    const h1 = this.th.heightAt(x + dx, z + dz, h0)
    if (Math.abs(h1 - h0) / dist <= this._maxTan) return h1
    const k = LOCOMOTION.stride / dist
    const h2 = this.th.heightAt(x + dx * k, z + dz * k, h0)
    return Math.abs(h2 - h0) / LOCOMOTION.stride <= this._maxTan ? h1 : NaN
  }

  _unstick(origin) {
    if (this.th.slopeAt(origin.x, origin.z) <= (LOCOMOTION.maxSlopeDeg * Math.PI) / 180) return
    for (let r = 3; r <= 80; r += 3) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2 + r * 0.37
        const tx = origin.x + Math.cos(ang) * r
        const tz = origin.z + Math.sin(ang) * r
        if (this.th.slopeAt(tx, tz) <= (LOCOMOTION.maxSlopeDeg * Math.PI) / 180) {
          this.rig.position.x += tx - origin.x
          this.rig.position.z += tz - origin.z
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
