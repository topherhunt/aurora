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
  // §4 -- the steepest ground she may walk UP. Down is never refused.
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

  // --- swimming: where the water is over her head (§12) --------------------
  // Afloat, her eye rides this far over the drawn surface. The margin over the
  // lap (WATER.lapHeight 0.08) plus the bob is what keeps a floating head from
  // dipping under and flickering the whole submersion effect.
  swimEyeClear: 0.15,
  // At rest with her eye less than this under the surface, she rises to float;
  // deeper, she hangs where she is. Wider than the bob plus the lap, so a
  // resting swimmer is always clearly under or clearly afloat.
  swimSurfaceBand: 0.35,
  swimSettleTau: 0.8, // seconds to rise to the surface from inside the band
  swimBob: 0.035, // metres either way, at rest only
  swimBobPeriod: 3.2,
  swimBobTau: 0.6, // seconds for the bob to fade in on stopping, and out on moving
  // Afloat, an aim this far below level dives; shallower keeps her on the
  // surface, since a walker's gaze sits a little below the horizon anyway.
  swimDiveDeg: 20,
  // Walking in, she floats once the ground is this much under where floating
  // would put her feet; afloat, she stands once it reaches that. The gap stops
  // a lap flipping her between the two at the shelf's edge.
  swimEnterHyst: 0.1,
}

const UP = new THREE.Vector3(0, 1, 0)
// Metres between the samples pathClear takes along a line. Under the smallest
// padded trunk's diameter (a 3 cm sapling plus WalkSurface's 15 cm pad).
const PATH_STEP = 0.3

export class Player {
  /**
   * `scale` is her size against the world, 1 outside a leafkin glade (DESIGN.md
   * §30). It is set on the rig, which is what WebXR composes the headset's pose
   * through, so her eye height, her stride across the room and her hands all
   * shrink with it; every metre LOCOMOTION states is hers, so it is scaled
   * here too. `terrainHeight` carries its own (WalkSurface's `scale`).
   */
  constructor(rig, camera, terrainHeight, { scale = 1 } = {}) {
    if (!(scale > 0)) throw new Error(`Player: scale must be positive, not ${scale}`)
    this.rig = rig
    this.camera = camera
    this.scale = scale
    rig.scale.setScalar(scale)
    this.setGround(terrainHeight)
    this._obstacle = { x: 0, z: 0, r: 0 }
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
    // A drop steeper than she could climb is a fall: `_fallTop` is where it began,
    // and `fell` is how far she landed below it, in her own metres, for the one
    // frame she lands (v2/vitals.js). Only a step can start one: the ground
    // sinking under her as a room builds, or arriving any way but walking, never counts.
    this._fallTop = null
    this.fell = 0
    this.flying = false
    this.travel = null // non-null while a double-click flight is in progress
    // Afloat or under: the rig's height is swimY plus the bob, not the ground.
    this.swimming = false
    this.swimY = 0
    // Her eye over the rig, taken when she starts swimming and held, so ducking
    // in the headset dips her head rather than lifting the world with it.
    this._headUp = 0
    this._swimT = 0
    this._bobGain = 0

    this._head = new THREE.Vector3()
    this._origin = new THREE.Vector3()
    this._quat = new THREE.Quaternion()
    this._fwd = new THREE.Vector3()
    this._right = new THREE.Vector3()
    this._step = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._maxTan = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180)
  }

  /**
   * The ground she walks on. `obstacles` are v2's trunks (WalkSurface.obstacleAt)
   * and `capsule` her body against its stone (WalkSurface.fits, which also makes
   * heightAt read from a foot height); v1's TerrainHeight has neither and those
   * checks are skipped. All three swap together: a house's walk with the glade's
   * capsule lets her through the house's walls. The water is the surface's too
   * (WalkSurface.waterAt), so a house's walk is dry.
   */
  setGround(terrainHeight) {
    this.th = terrainHeight
    this.obstacles = typeof terrainHeight.obstacleAt === 'function' ? terrainHeight : null
    this.capsule = typeof terrainHeight.fits === 'function' ? terrainHeight : null
    this.water = typeof terrainHeight.waterAt === 'function' ? terrainHeight : null
    this._inStone = null
    this.swimming = false
  }

  _waterAt(x, z) {
    return this.water === null ? null : this.water.waterAt(x, z)
  }

  /** Where her feet float with her eye swimEyeClear over a surface at `level`. */
  _floatY(level, headUp = this._headUp) {
    return level + LOCOMOTION.swimEyeClear * this.scale - headUp
  }

  /**
   * Put her feet on `ground` at the rig's (x, z) -- or, where the water there is
   * over her head, afloat: at `feetY` if that is under the surface, else on it.
   * Every way of arriving somewhere without walking there ends here.
   */
  _landAt(ground, feetY) {
    const p = this.rig.position
    this.swimming = false
    this._fallTop = null
    this.smoothY = this.standY = p.y = ground
    const level = this._waterAt(p.x, p.z)
    if (level === null) return
    const headUp = this.headPosition().y - p.y
    const float = this._floatY(level, headUp)
    if (ground >= float) return
    this._startSwim(headUp, feetY === undefined ? float : Math.min(float, Math.max(ground, feetY)))
  }

  _startSwim(headUp, y) {
    this.swimming = true
    this._fallTop = null
    this._headUp = headUp
    this.swimY = y
    this._bobGain = 0
    this.rig.position.y = this.smoothY = y
  }

  /** A swim teleport: her eye to (x, eyeY, z), held under the surface and over the bed. */
  swimTo(x, eyeY, z) {
    const headUp = this.swimming ? this._headUp : this.headPosition().y - this.rig.position.y
    const feetY = eyeY - headUp
    this.travel = null
    this.flying = false
    this.speed = 0
    this.blocked = false
    this.rig.position.x = x
    this.rig.position.z = z
    this._landAt(this.th.heightAt(x, z, feetY), feetY)
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
    this.rig.position.x = x
    this.rig.position.z = z
    this._landAt(this.th.heightAt(x, z))
    this.speed = 0
  }

  // With `y`, onto the ground within reach of that height (a landing under an awning) rather than the topmost stone. Onto the surface where the water is over her head.
  teleportTo(x, z, y) {
    this.travel = null
    this.flying = false
    this.rig.position.x = x
    this.rig.position.z = z
    this._landAt(this.th.heightAt(x, z, y))
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
    if (on) this.swimming = false
    else {
      // Asked from where she is hovering, so a landing under an overhang is on
      // the ground beneath it rather than on top of the stone.
      const origin = this.originPosition()
      this._landAt(this.th.heightAt(origin.x, origin.z, origin.y))
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
      cruiseY: peak + LOCOMOTION.travelClearance * this.scale,
    }
    this.flying = false // travel owns the rig until it finishes
    this.blocked = false
    this.speed = LOCOMOTION.travelSpeed * this.scale
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
    T.t = Math.min(1, T.t + (LOCOMOTION.travelSpeed * this.scale * dt) / T.dist)

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
    const floor = this.th.heightAt(p.x, p.z) + LOCOMOTION.flyClearance * this.scale
    // A room's roof is nearer than the cruise (travelClearance), so the rail runs under it.
    const ceiling = this._ceiling(p.x, p.z, floor, this.headPosition().y - p.y)
    if (p.y > ceiling) p.y = ceiling
    if (p.y < floor) p.y = floor

    if (T.t >= 1) {
      this.travel = null
      this.speed = 0
      this._landAt(this.th.heightAt(p.x, p.z, p.y))
    }
  }

  // input: {move: -1..1 forward/back, strafe: -1..1, lift: -1..1 up/down,
  //         turn: raw stick X, unstick: bool, instant: bool}
  update(dt, input) {
    this.fell = 0
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
    const drive = this.flying || this.swimming ? Math.min(1, Math.hypot(demand, liftIn)) : demand

    const top = this.flying ? this.flySpeedAt(origin) : L.maxSpeed * this.scale
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

    if (this.swimming) {
      this._swim(dt, fwdIn, strafeIn, liftIn, input.flyDirection)
      return
    }

    // Before the step moves the rig, while the camera's world pose is this frame's.
    const headUp = head.y - this.rig.position.y
    const fromY = this.standY
    const fromX = origin.x
    const fromZ = origin.z

    if (this.speed > 0.001) this._tryMove(this.speed * dt, origin, fwdIn, strafeIn, demand)

    if (input.unstick) this._unstick(origin)

    // Terrain following with damping. Recompute the origin because _tryMove may
    // have shifted the rig.
    this.originPosition(origin)
    const ground = this.standY === null
      ? this.th.heightAt(origin.x, origin.z)
      : this.th.heightAt(origin.x, origin.z, this.standY)
    this.standY = ground
    const run = Math.hypot(origin.x - fromX, origin.z - fromZ)
    if (fromY !== null && fromY - ground > this._maxTan * run + 0.01 * this.scale) {
      if (this._fallTop === null && run > 0) this._fallTop = fromY
    } else if (this._fallTop !== null) {
      this.fell = (this._fallTop - ground) / this.scale
      this._fallTop = null
    }
    if (this.smoothY === null) this.smoothY = ground
    this.smoothY += (ground - this.smoothY) * (1 - Math.exp(-dt / L.vertTau))
    this.rig.position.y = this.smoothY

    // Walked (or fell) into water over her head: she floats from here.
    const level = this._waterAt(origin.x, origin.z)
    if (level !== null) {
      const float = this._floatY(level, headUp)
      if (ground < float - L.swimEnterHyst * this.scale) this._startSwim(headUp, Math.min(this.smoothY, float))
    }
  }

  /**
   * One frame in the water. Along `flyDirection` (the headset's hand) or the
   * gaze, pitch and all, like flight -- except that afloat, an aim above
   * swimDiveDeg below level keeps her on the surface at full pace, and nothing
   * takes her above it. The bed is a floor, a bank she could not mantle from
   * the water is a wall, and ground under her that reaches where her feet float
   * stands her up to walk out. At rest she rounds to one of two states --
   * afloat, or clearly under -- and bobs there; see swimSurfaceBand.
   */
  _swim(dt, fwdIn, strafeIn, liftIn, flyDirection = null) {
    const L = LOCOMOTION
    const k = this.scale
    const p = this.rig.position
    this._swimT += dt
    let level = this._waterAt(p.x, p.z)
    let moved = false
    let onTop = false

    if (this.speed > 0.001 && level !== null) {
      if (flyDirection) this._fwd.copy(flyDirection)
      else {
        this.camera.getWorldQuaternion(this._quat)
        this._fwd.set(0, 0, -1).applyQuaternion(this._quat)
      }
      this.camera.getWorldQuaternion(this._quat)
      this._right.set(1, 0, 0).applyQuaternion(this._quat)
      this._right.y = 0
      if (this._right.lengthSq() > 1e-6) this._right.normalize()
      this._step.set(0, 0, 0).addScaledVector(this._fwd, fwdIn).addScaledVector(this._right, strafeIn)
      this._step.y += liftIn
      const len = this._step.length()
      const afloat = this.swimY >= this._floatY(level) - 0.01 * k
      if (len > 1e-6 && afloat && this._step.y / len > -Math.sin((L.swimDiveDeg * Math.PI) / 180)) {
        this._step.y = 0
        onTop = true
      }
      const n = this._step.length()
      if (n > 1e-6) {
        this._step.multiplyScalar((this.speed * dt) / n)
        const nx = THREE.MathUtils.clamp(p.x + this._step.x, -WORLD_HALF + 32, WORLD_HALF - 32)
        const nz = THREE.MathUtils.clamp(p.z + this._step.z, -WORLD_HALF + 32, WORLD_HALF - 32)
        // A mantle out of the water: onto anything within her reach of her
        // feet, or of the surface by half that.
        const bank = this.th.heightAt(nx, nz, this.swimY)
        const wall = bank > Math.max(this.swimY + this.th.reach, level + 0.5 * this.th.reach)
        const trunk = this.obstacles && !this.obstacles.obstacleAt(p.x, p.z, this._obstacle) &&
          this.obstacles.obstacleAt(nx, nz, this._obstacle)
        this.blocked = wall || !!trunk
        if (!this.blocked) {
          p.x = nx
          p.z = nz
        }
        this.swimY += this._step.y
        moved = true
      }
    }

    level = this._waterAt(p.x, p.z)
    const floor = this.th.heightAt(p.x, p.z, this.swimY)
    if (this.swimY < floor) this.swimY = floor
    if (level === null || floor >= this._floatY(level)) {
      this.swimming = false
      this.smoothY = p.y = this.swimY
      this.standY = floor
      return
    }
    const float = this._floatY(level)
    if (this.swimY > float || onTop) this.swimY = float
    else if (!moved && this.swimY + this._headUp > level - L.swimSurfaceBand * k) {
      this.swimY += (float - this.swimY) * (1 - Math.exp(-dt / L.swimSettleTau))
    }
    this._bobGain += ((moved ? 0 : 1) - this._bobGain) * (1 - Math.exp(-dt / L.swimBobTau))
    const bob = L.swimBob * k * this._bobGain * Math.sin((2 * Math.PI * this._swimT) / L.swimBobPeriod)
    this.smoothY = p.y = this.swimY + bob
    this.standY = floor
  }

  // Fly speed at a given locomotion origin, from height above the ground
  // directly below. The HUD already shows both halves of this -- `agl` and
  // `speed` on the position block -- which is what makes a speed that changes on
  // its own legible rather than mysterious.
  flySpeedAt(origin) {
    const L = LOCOMOTION
    const alt = (origin.y - this.th.heightAt(origin.x, origin.z)) / this.scale
    const t = THREE.MathUtils.clamp((alt - L.flyLowAlt) / (L.flyHighAlt - L.flyLowAlt), 0, 1)
    return (L.flyLowSpeed + (L.flyHighSpeed - L.flyLowSpeed) * t) * this.scale
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
    const headUp = this.headPosition().y - p.y
    const x0 = p.x, y0 = p.y, z0 = p.z
    p.x = THREE.MathUtils.clamp(p.x + this._step.x, -WORLD_HALF + 32, WORLD_HALF - 32)
    p.z = THREE.MathUtils.clamp(p.z + this._step.z, -WORLD_HALF + 32, WORLD_HALF - 32)
    p.y += this._step.y

    // Never below the ground. Flying inside a mountain is disorienting and the
    // only way out is guesswork, so the floor just pushes her back up. On the
    // origin, not the head: a floor that tracked the head would lift the rig
    // whenever she leaned out over a drop. See originPosition. Nor above a
    // roof (WalkSurface.ceilingAt): her head keeps the same clearance under it
    // that her feet keep over the ground, and a column with no room for both
    // -- the foot of a room's wall -- refuses the step, unless she was already
    // in one, so a step out of stone is never refused the way a step in is.
    const origin = this.originPosition()
    const floor = this.th.heightAt(origin.x, origin.z) + LOCOMOTION.flyClearance * this.scale
    const ceiling = this._ceiling(origin.x, origin.z, floor, headUp)
    if (ceiling < floor) {
      const floor0 = this.th.heightAt(x0, z0) + LOCOMOTION.flyClearance * this.scale
      if (this._ceiling(x0, z0, floor0, headUp) >= floor0) {
        p.set(x0, y0, z0)
        this.blocked = true
        return
      }
    }
    this.blocked = false
    if (p.y > ceiling) p.y = ceiling
    if (p.y < floor) p.y = floor
    this.smoothY = p.y
  }

  /** The highest the rig may fly over (x, z): the roof's underside read from `floor`, less the head's height over the rig and its clearance; Infinity under the sky. */
  _ceiling(x, z, floor, headUp) {
    if (typeof this.th.ceilingAt !== 'function') return Infinity
    return this.th.ceilingAt(x, z, floor) - LOCOMOTION.flyClearance * this.scale - headUp
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
      const eps = 1.0 * this.scale
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

  /**
   * Whether she could WALK the straight line from (x0, z0) to (x1, z1): every
   * step of it passes the slope rule below and none enters a trunk. What the
   * teleport asks before it accepts a landing, so a lob over a boulder or round
   * a tree cannot reach ground her feet could not. Straight-line only -- the
   * contour slide might get her round a small obstacle, but "can I go THAT way"
   * is the question being asked. Steps are shorter than the thinnest padded
   * trunk so a sapling cannot fall between two samples.
   */
  pathClear(x0, z0, x1, z1, y0) {
    const len = Math.hypot(x1 - x0, z1 - z0)
    const n = Math.max(1, Math.ceil(len / PATH_STEP))
    const dx = (x1 - x0) / n
    const dz = (z1 - z0) / n
    const step = len / n
    let x = x0
    let z = z0
    // Walked from her feet at `y0` (standing under an awning), else from the
    // topmost surface at the start; the headroom along the way is her own line
    // only, since a lob is a coarse question and the ring's shoulder test at
    // 30 cm buys nothing.
    let y = this.th.heightAt(x, z, y0)
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
   *
   * ONLY CLIMBING IS REFUSED. Down is always allowed, off a ledge or a cliff
   * alike, and the damped follower in update() is the fall -- so a pit she
   * cannot climb out of is a trap now, and §4 says why the world accepts that.
   *
   * Two baselines, and a climb is refused only when BOTH say wall. `dist` is
   * one frame of travel -- 2 cm at 72 Hz -- so on its own a 46 cm patch of 42
   * deg stops her where a person would step over it; the stride baseline asks
   * whether it is still uphill two paces on, so anything shorter than a stride
   * averages out and a real cliff does not. The near test is kept first rather
   * than replaced, so she walks up to the foot of a wall instead of stopping a
   * stride short, and the contour slide has it to slide along. Every height is
   * asked from her feet, so a stone over her head is not ground at either end.
   */
  _walkable(x, z, y, dx, dz, dist) {
    const h0 = this.th.heightAt(x, z, y)
    const h1 = this.th.heightAt(x + dx, z + dz, h0)
    if ((h1 - h0) / dist <= this._maxTan) return h1
    const stride = LOCOMOTION.stride * this.scale
    const k = stride / dist
    const h2 = this.th.heightAt(x + dx * k, z + dz * k, h0)
    return (h2 - h0) / stride <= this._maxTan ? h1 : NaN
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

    // The pose is in the reference space's metres; the rig's scale takes it to the world's.
    const shift = new THREE.Vector3(local.x, 0, local.z).applyQuaternion(this.rig.quaternion).multiplyScalar(this.scale)
    this.rig.position.x += shift.x
    this.rig.position.z += shift.z
    return true
  }
}
