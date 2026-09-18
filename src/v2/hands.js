import THREE from '../three-instance.js'

// ---------------------------------------------------------------------------
// Her hands: what a controller can pick up, hold, drop and put in the backpack.
//
// A hand is a node in the scene -- a Quest grip, or a point under the desktop
// camera -- with a reach. A press with an empty hand asks every SOURCE (a bed
// or a creature layer: mushrooms, carrots, spiders, butterflies, fish, crabs)
// for the drawn thing nearest the hand within that reach, takes the nearest of
// their answers, and holds it. The source pulls it out of its own scatter and
// hands back a RECORD: the geometry and material it was drawn with, the
// instance's own attributes, tint and scale, so the thing in her hand is the
// thing she reached for, pixel for pixel. Held and loose things are drawn here,
// one InstancedMesh per geometry (a POOL), rewritten every frame.
//
// A press with a full hand lets go. Over the shoulder -- the BACKPACK ZONE,
// behind and above her head -- the thing goes in the backpack instead, and the
// controller buzzes as the hand enters that zone, only while it holds
// something that will fit. Anywhere else the source is offered it first: a
// creature let go of runs, swims or flies off in its own layer, and the source
// says so. A thing no source takes back -- flora, a fish out of water -- is
// simulated here for a moment: a fall to the ground, a roll downhill that
// slows to a stop, or a fish flapping itself still, and then it is frozen
// where it lies; anything but a fish or a crab let go over or under water
// comes to its surface and bobs there, turning and drifting. No physics
// beyond that.
//
// A bed regrows from its seed, so a source records what was taken in
// taken.js; a creature the layer would re-seed anywhere is simply freed.
//
// The backpack keeps a record PACKED -- everything but the geometry and
// material, so the save can write it -- and a source DRESSES a packed slot
// back into a record on the way out, by the kind and variant the slot names.
// The backpack's picture of a slot is a photograph of that record, taken here
// in a studio of its own: the thing as it is held, under fixed lights.
// ---------------------------------------------------------------------------

// Metres from the hand's point to a thing's surface within which it is grabbed. A controller is a hand; the desktop's point stands off the camera and reaches further (main.js).
export const REACH_M = 0.25
// Metres a thing may be along its longest side and still be lifted, and still be stowed.
export const GRAB_MAX_M = 2
export const STOW_MAX_M = 1
// Loose things kept in the world; past this the oldest is forgotten.
export const LOOSE_MAX = 24
// A drop's roll: the slope's pull on it fades out over ROLL_S, as if it settled into the grass, and it is frozen where it is at ROLL_MAX_S whatever it is doing; a beached fish flaps at full strength for FLAP_S and fades over FLAP_FADE_S.
export const ROLL_S = 2.5
export const ROLL_MAX_S = 5
export const FLAP_S = 15
export const FLAP_FADE_S = 5
// The backpack zone, in metres about her head: the hand at least this far behind the head's forward line, no lower than this under the head, and within this of it.
export const ZONE = { behind: 0.05, below: 0.25, within: 0.7 }
// The buzz as the hand enters the zone: intensity and milliseconds.
export const ZONE_PULSE = [0.6, 120]

const GRAVITY = 9.8
// Rolling: the fraction of the downhill pull a rolling thing takes, the rolling resistance that slows it in m/s^2, and the speed under which it is still.
const ROLL_PULL = 0.5
const ROLL_FRICTION = 0.8
const ROLL_STILL = 0.04
// A thing on the ground is a ball of this fraction of its size, for the contact and the roll.
const BALL = 0.4
// A beached fish: the tail's beats a second and its swing as a fraction of the length at full strength; a jerk of the body every so often, a turn of up to this and a hop of this speed.
const FLAP_HZ = 6
const FLAP_AMP = 0.15
const JERK_S = [0.3, 0.8]
const JERK_RAD = 1.2
const HOP_MPS = 0.6
const FLAP_LIE = 0.08
// Afloat: what the water takes back at its surface rather than floating; where a floating thing's centre sits over the line as a fraction of its ball; how fast one rises from under the water and settles from over it; the bob's swing and beats a second; the slow turn in rad/s; the drift's top speed, how long a heading holds, and how long a change of heading takes.
const SWIMMERS = new Set(['fish', 'crab'])
const FLOAT_LINE = 0.2
const RISE_MPS = 0.3
const SETTLE_MPS = 0.6
const BOB_AMP = 0.02
const BOB_HZ = 0.35
const SPIN_RAD = [0.15, 0.4]
const DRIFT_MPS = 0.06
const TACK_S = [2, 5]
const DRIFT_EASE_S = 1.5
// Two spots on one lake read the same level to this, in metres; a river's runs down its course.
const LEVEL_EPS = 0.05
// Where a held thing's centre sits in the hand's frame: a little under and ahead of the grip.
const HOLD_OFFSET = new THREE.Vector3(0, -0.03, -0.06)
// Instances a pool holds: every loose thing and a hand each, with room.
const POOL_CAP = LOOSE_MAX + 8
// What a source's instanced attribute holds when the record does not say: the arena's fade slot is "never fade", the rest rest.
const ATTR_DEFAULT = { aPropFade: 1 }
// The studio: where the camera looks from (a unit direction, front and a little above), the sky, ground and sun of its lights, and how much room the frame leaves round the thing.
const STUDIO_VIEW = new THREE.Vector3(0.35, 0.55, 1).normalize()
const STUDIO_SKY = 0xffffff
const STUDIO_GROUND = 0x8a8f99
const STUDIO_SUN = new THREE.Vector3(0.6, 1, 0.9)
const STUDIO_LIGHT = [0.6, 0.9]
const STUDIO_MARGIN = 1.08

const _p = new THREE.Vector3()
const _c = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _dq = new THREE.Quaternion()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()
const _col = new THREE.Color()
const _n = { x: 0, y: 1, z: 0 }
// The step the ground's normal is read over, in metres.
const SLOPE_EPS = 0.2
const UP = new THREE.Vector3(0, 1, 0)
const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

export class Hands {
  /**
   * `walk.heightAt(x, z, y)` and `walk.normalAt(x, z)` are the ground a loose
   * thing lands on; `water.levelAt(x, z)` is where a falling thing meets the
   * lake. `haptic(key, intensity, ms)` buzzes a hand; `stow(rec)` takes a
   * record into the backpack and says whether it fit; `thud(x, y, z)` is a
   * dropped thing meeting the ground. `rand` is the roll's, the flap's and
   * the drift's own stream.
   */
  constructor(scene, { walk, water, haptic, stow, thud, rand = Math.random }) {
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function') throw new Error('Hands needs the WalkSurface, for heightAt and normalAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Hands needs WaterSurfaces, for levelAt')
    if (typeof haptic !== 'function' || typeof stow !== 'function' || typeof thud !== 'function') throw new Error('Hands needs haptic(key, intensity, ms), stow(rec) and thud(x, y, z)')
    this.walk = walk
    this.water = water
    this.haptic = haptic
    this.stow = stow
    this.thud = thud
    this.rand = rand
    this.batch = new THREE.Group()
    this.batch.name = 'v2-hands'
    scene.add(this.batch)
    this.sources = []
    // kind -> the source that hands it out and dresses it.
    this.byKind = new Map()
    this.hands = new Map()
    // The things let go of and not taken back, oldest first.
    this.loose = []
    // One pool per source geometry.
    this.pools = new Map()
    // The photographs' scene, lights and camera, and a subject per source geometry; built at the first photograph.
    this.studio = null
    // For the panel: things taken, stowed, dropped.
    this.taken = 0
    this.stowed = 0
    this.dropped = 0
  }

  /**
   * A bed or a creature layer that can be picked from, and the kind or kinds
   * of record it hands out: pickAt(x, y, z, reach, maxSize) -> hit | null,
   * take(hit, stowMax) -> record, dress(slot) -> { geometry, material } for a
   * packed slot of its kind (null while its asset has not landed), and
   * release(record, x, y, z, head) -> boolean.
   */
  addSource(src, kinds) {
    if (typeof src.pickAt !== 'function' || typeof src.take !== 'function' || typeof src.dress !== 'function') throw new Error('Hands.addSource: a source has pickAt(x, y, z, reach, maxSize), take(hit, stowMax) and dress(slot)')
    const list = typeof kinds === 'string' ? [kinds] : kinds
    if (!Array.isArray(list) || list.length === 0 || list.some((k) => typeof k !== 'string' || k === '')) throw new Error('Hands.addSource: a source names the kind or kinds it hands out')
    for (const kind of list) if (this.byKind.has(kind)) throw new Error(`Hands.addSource: two sources hand out a ${kind}`)
    for (const kind of list) this.byKind.set(kind, src)
    this.sources.push(src)
  }

  /** A hand: the node whose world position is its point, and how far from that point it grabs. */
  addHand(key, node, { reach = REACH_M } = {}) {
    if (this.hands.has(key)) throw new Error(`Hands.addHand: ${key} twice`)
    if (!node || !node.isObject3D) throw new Error(`Hands.addHand: ${key} needs an Object3D`)
    this.hands.set(key, { key, node, reach, held: null, inZone: false })
  }

  /** The record the hand holds, or null. */
  holding(key) {
    return this._hand(key).held?.rec ?? null
  }

  _hand(key) {
    const hand = this.hands.get(key)
    if (!hand) throw new Error(`Hands: no hand ${key}`)
    return hand
  }

  /**
   * The trigger on one hand. `head` is {x, y, z, yaw}: her head and the
   * bearing it faces. Empty, the hand takes the nearest thing in reach; full,
   * it stows the thing when the hand is in the backpack zone and the thing
   * fits, and lets it go anywhere else. Returns what happened -- 'pick',
   * 'drop', 'stow', 'full' (the backpack had no room; still held) -- or null
   * when there was nothing to take.
   */
  press(key, head) {
    const hand = this._hand(key)
    if (hand.held) {
      const rec = hand.held.rec
      if (rec.stowable && this._inZone(hand, head)) {
        if (!this.stow(rec)) return 'full'
        this._unhold(hand)
        this.stowed++
        return 'stow'
      }
      this._drop(hand, head)
      this.dropped++
      return 'drop'
    }
    const best = this._nearest(hand)
    if (!best) return null
    if (best.loose) {
      this.loose.splice(this.loose.indexOf(best.loose), 1)
      hand.held = best.loose
      hand.held.state = 'held'
    } else {
      const rec = best.src.take(best.hit, STOW_MAX_M)
      this._checkRecord(rec)
      if (this.byKind.get(rec.kind) !== best.src) throw new Error(`Hands: a source handed out a ${rec.kind}, which is not its kind`)
      hand.held = this._item(rec, best.src)
    }
    hand.inZone = false
    this.taken++
    return 'pick'
  }

  // -- the backpack ------------------------------------------------------------

  /** The record without its geometry and material, its arrays copied: what the backpack keeps and the save writes. */
  pack(rec) {
    this._checkRecord(rec)
    const { geometry, material, ...slot } = rec
    slot.color = rec.color ? Array.from(rec.color) : null
    slot.scale = Array.from(rec.scale)
    slot.attrs = {}
    for (const [name, values] of Object.entries(rec.attrs ?? {})) slot.attrs[name] = Array.from(values)
    return slot
  }

  /** A packed slot dressed by its source back into a record, or null while that source's asset has not landed. */
  dressed(slot) {
    if (!slot || typeof slot.kind !== 'string') throw new Error('Hands.dressed: a slot has a kind')
    const src = this.byKind.get(slot.kind)
    if (!src) throw new Error(`Hands: no source hands out a ${slot.kind}`)
    const dress = src.dress(slot)
    if (dress === null) return null
    const rec = { ...slot, geometry: dress?.geometry, material: dress?.material }
    this._checkRecord(rec)
    return rec
  }

  /** A packed slot out of the backpack and into a hand, which lets go of whatever it held first. */
  give(key, slot, head) {
    const hand = this._hand(key)
    const rec = this.dressed(slot)
    if (!rec) throw new Error(`Hands.give: the ${slot.kind} source has not landed its asset`)
    if (hand.held) {
      this._drop(hand, head)
      this.dropped++
    }
    hand.held = this._item(rec, this.byKind.get(slot.kind))
    hand.inZone = false
  }

  /**
   * Photograph a packed slot into a rect of a render target, for the backpack:
   * the thing as it is held, centred, under the studio's own lights, framed
   * orthographically from the front and a little above over a clear
   * background. A null slot clears the rect. Returns false, the rect cleared,
   * while the slot's source has not landed its asset.
   */
  photograph(renderer, slot, target, { x, y, w, h }) {
    const rec = slot ? this.dressed(slot) : null
    const prevTarget = renderer.getRenderTarget()
    const prevXR = renderer.xr.enabled
    renderer.getClearColor(_col)
    const prevAlpha = renderer.getClearAlpha()
    // XR off for the capture, or a presenting renderer photographs the headset's view.
    renderer.xr.enabled = false
    renderer.setRenderTarget(target)
    renderer.setViewport(x, y, w, h)
    renderer.setScissor(x, y, w, h)
    renderer.setScissorTest(true)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    if (rec) {
      const studio = this._studio()
      const subject = this._subject(rec)
      const attrs = this._attrs(rec, subject.instanced)
      for (const { name, attr, size } of subject.instanced) {
        for (let i = 0; i < size; i++) attr.array[i] = attrs[name][i]
        attr.needsUpdate = true
      }
      if (subject.mesh.instanceColor) {
        const c = rec.color ?? [1, 1, 1]
        subject.mesh.instanceColor.array.set(c)
        subject.mesh.instanceColor.needsUpdate = true
      }
      // Its scaled box centred on the origin, and the frame a little wider than that box's diagonal.
      _s.fromArray(rec.scale)
      subject.geo.boundingBox.getCenter(_c).multiply(_s)
      _p.set(-_c.x, -_c.y, -_c.z)
      _m.compose(_p, _q.identity(), _s)
      subject.mesh.setMatrixAt(0, _m)
      subject.mesh.instanceMatrix.needsUpdate = true
      const r = subject.geo.boundingBox.getSize(_p).multiply(_s).length() * 0.5 * STUDIO_MARGIN
      const cam = studio.cam
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r
      cam.near = 0.01; cam.far = 4 * r
      cam.position.copy(STUDIO_VIEW).multiplyScalar(2 * r)
      cam.lookAt(0, 0, 0)
      cam.updateProjectionMatrix()
      cam.updateMatrixWorld(true)
      studio.scene.add(subject.mesh)
      renderer.render(studio.scene, cam)
      studio.scene.remove(subject.mesh)
    }
    renderer.setScissorTest(false)
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(_col, prevAlpha)
    renderer.xr.enabled = prevXR
    return rec !== null
  }

  /** The studio, built once: a scene with the world's own light count -- one sun, one sky -- and a fog of no density, so the source's material draws with the program it already has. */
  _studio() {
    if (this.studio) return this.studio
    const scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x000000, 0)
    const sun = new THREE.DirectionalLight(0xffffff, STUDIO_LIGHT[1])
    sun.position.copy(STUDIO_SUN)
    scene.add(sun, sun.target)
    scene.add(new THREE.HemisphereLight(STUDIO_SKY, STUDIO_GROUND, STUDIO_LIGHT[0]))
    this.studio = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10), subjects: new Map() }
    return this.studio
  }

  /** The studio's one-instance mesh for a record's geometry, on the record's material. */
  _subject(rec) {
    const studio = this._studio()
    let subject = studio.subjects.get(rec.geometry)
    if (subject) return subject
    const { geo, instanced } = this._solo(rec.geometry, 1)
    const mesh = new THREE.InstancedMesh(geo, rec.material, 1)
    mesh.name = `v2-hands-studio-${rec.kind}`
    mesh.frustumCulled = false
    if (rec.color) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3).fill(1), 3)
    subject = { mesh, geo, instanced }
    studio.subjects.set(rec.geometry, subject)
    return subject
  }

  /** What the hand holds, packed for a backpack slot and out of the hand; null with nothing held, or a thing too big to stow. */
  put(key) {
    const hand = this._hand(key)
    if (!hand.held || !hand.held.rec.stowable) return null
    const slot = this.pack(hand.held.rec)
    this._unhold(hand)
    this.stowed++
    return slot
  }

  /** The desktop's stow key: no shoulder to reach over, so the held thing goes straight to the backpack when it fits. Returns 'stow', 'full', or null with nothing held or a thing too big. */
  stowPress(key) {
    const hand = this._hand(key)
    if (!hand.held || !hand.held.rec.stowable) return null
    if (!this.stow(hand.held.rec)) return 'full'
    this._unhold(hand)
    this.stowed++
    return 'stow'
  }

  _checkRecord(rec) {
    if (!rec || typeof rec.kind !== 'string' || typeof rec.name !== 'string') throw new Error('Hands: a record has a kind and a name')
    if (!(rec.size > 0) || !rec.geometry?.isBufferGeometry || !rec.material?.isMaterial) throw new Error(`Hands: the ${rec.kind} record has no size, geometry or material`)
    if (!Array.isArray(rec.scale) || rec.scale.length !== 3) throw new Error(`Hands: the ${rec.kind} record's scale is not [x, y, z]`)
    if (rec.color !== null && (!Array.isArray(rec.color) || rec.color.length !== 3)) throw new Error(`Hands: the ${rec.kind} record's color is not [r, g, b] or null`)
    if (typeof rec.stowable !== 'boolean') throw new Error(`Hands: the ${rec.kind} record does not say whether it stows`)
  }

  _point(hand) {
    hand.node.updateWorldMatrix(true, false)
    return _p.setFromMatrixPosition(hand.node.matrixWorld)
  }

  /** The nearest thing in the hand's reach: a source's hit, or a loose thing lying where it was dropped, `{ loose }`. */
  _nearest(hand) {
    const p = this._point(hand)
    let best = null
    for (const src of this.sources) {
      const hit = src.pickAt(p.x, p.y, p.z, hand.reach, GRAB_MAX_M)
      if (hit && (!best || hit.dist < best.hit.dist)) best = { src, hit }
    }
    for (const item of this.loose) {
      const d = Math.max(0, Math.hypot(item.x - p.x, item.y - p.y, item.z - p.z) - item.rec.size / 2)
      if (d < hand.reach && (!best || d < best.hit.dist)) best = { loose: item, hit: { dist: d } }
    }
    return best
  }

  /** Whether the hand is over her shoulder: behind the head's forward line, no lower than ZONE.below under it, within ZONE.within of it. */
  _inZone(hand, head) {
    const p = this._point(hand)
    const dx = p.x - head.x, dy = p.y - head.y, dz = p.z - head.z
    const along = dx * Math.sin(head.yaw) + dz * Math.cos(head.yaw)
    return along < -ZONE.behind && dy > -ZONE.below && dx * dx + dy * dy + dz * dz < ZONE.within * ZONE.within
  }

  // -- the drawing -----------------------------------------------------------

  /** The pool for a record's geometry: a solo geometry sharing the source's vertex buffers, with its own instanced attributes, on the source's material. */
  _pool(rec) {
    let pool = this.pools.get(rec.geometry)
    if (pool) return pool
    const src = rec.geometry
    const { geo, instanced } = this._solo(src, POOL_CAP)
    const mesh = new THREE.InstancedMesh(geo, rec.material, POOL_CAP)
    mesh.name = `v2-hands-${rec.kind}`
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    if (rec.color) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 3).fill(1), 3)
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    }
    this.batch.add(mesh)
    pool = { mesh, geo, instanced, centre: geo.boundingBox.getCenter(new THREE.Vector3()), items: [] }
    this.pools.set(src, pool)
    return pool
  }

  /** A geometry sharing a source geometry's vertex buffers and index, with its own instanced attributes for `cap` instances; those are listed as `{ name, attr, size }`. */
  _solo(src, cap) {
    const geo = new THREE.BufferGeometry()
    const instanced = []
    for (const [name, attr] of Object.entries(src.attributes)) {
      if (attr.isInstancedBufferAttribute) {
        const own = new THREE.InstancedBufferAttribute(new Float32Array(cap * attr.itemSize), attr.itemSize)
        own.setUsage(THREE.DynamicDrawUsage)
        geo.setAttribute(name, own)
        instanced.push({ name, attr: own, size: attr.itemSize })
      } else {
        geo.setAttribute(name, attr)
      }
    }
    if (src.index) geo.setIndex(src.index)
    geo.computeBoundingBox()
    return { geo, instanced }
  }

  /** The values a record is drawn with for each instanced attribute: the record's own, or the default. */
  _attrs(rec, instanced) {
    const attrs = {}
    for (const { name, size } of instanced) {
      const given = rec.attrs?.[name]
      if (given) {
        if (given.length !== size) throw new Error(`Hands: the ${rec.kind} record's ${name} has ${given.length} values, the geometry ${size}`)
        attrs[name] = Array.from(given)
      } else {
        attrs[name] = new Array(size).fill(ATTR_DEFAULT[name] ?? 0)
      }
    }
    return attrs
  }

  /** A held or loose thing: its record, the source it came from, its pool, the instanced values it is drawn with, and its pose -- the centre of its ball and its rotation. */
  _item(rec, src) {
    const pool = this._pool(rec)
    const attrs = this._attrs(rec, pool.instanced)
    const item = {
      rec, src, pool, attrs,
      // The ball's centre, its rotation, and the offset from the geometry's origin to its centre, scaled: what the pose is applied to.
      x: 0, y: 0, z: 0, q: new THREE.Quaternion(), off: new THREE.Vector3(pool.centre.x * rec.scale[0], pool.centre.y * rec.scale[1], pool.centre.z * rec.scale[2]),
      r: rec.size * BALL,
      state: 'held', vx: 0, vy: 0, vz: 0, t: 0, tried: false, jerk: 0,
      // Afloat: the bob's phase, the turn, the drift it is easing toward and how long that heading has left.
      phase: 0, spin: 0, ax: 0, az: 0, tack: 0,
    }
    pool.items.push(item)
    return item
  }

  _forget(item) {
    const i = item.pool.items.indexOf(item)
    if (i < 0) throw new Error(`Hands: a ${item.rec.kind} is not in its pool`)
    item.pool.items.splice(i, 1)
  }

  _unhold(hand) {
    this._forget(hand.held)
    hand.held = null
    hand.inZone = false
  }

  // -- letting go --------------------------------------------------------------

  /** The thing goes back to its source where the hand is, if the source will have it; otherwise it is loose here, falling from the hand. */
  _drop(hand, head) {
    const item = hand.held
    const p = this._point(hand)
    const cx = p.x + HOLD_OFFSET.x, cy = p.y + HOLD_OFFSET.y, cz = p.z + HOLD_OFFSET.z
    hand.held = null
    hand.inZone = false
    if (this._giveBack(item, cx, cy, cz, head)) return
    item.x = cx; item.y = cy; item.z = cz
    // Held level; let go level.
    item.q.identity()
    item.vx = item.vy = item.vz = 0
    item.state = 'fall'
    item.t = 0
    item.tried = false
    item.head = { x: head.x, y: head.y, z: head.z }
    this.loose.push(item)
    while (this.loose.length > LOOSE_MAX) this._forget(this.loose.shift())
  }

  /** Offers the thing back to the layer it came from; true when the layer took it. A source without a release never takes anything back. */
  _giveBack(item, x, y, z, head) {
    if (typeof item.src.release !== 'function') return false
    if (!item.src.release(item.rec, x, y, z, head)) return false
    this._forget(item)
    return true
  }

  // -- the frame -------------------------------------------------------------

  /**
   * One frame: the held things follow their hands, the hand entering the
   * backpack zone with something that fits buzzes, the loose things fall,
   * roll or flap, and every pool is rewritten. `head` is {x, y, z, yaw}.
   */
  update(dt, head) {
    dt = Math.min(dt, 0.1)
    for (const hand of this.hands.values()) {
      if (!hand.held) continue
      const item = hand.held
      hand.node.updateWorldMatrix(true, false)
      _m.copy(hand.node.matrixWorld)
      _q.setFromRotationMatrix(_m)
      _p.copy(HOLD_OFFSET).applyMatrix4(_m)
      item.x = _p.x; item.y = _p.y; item.z = _p.z
      item.q.copy(_q)
      const inZone = item.rec.stowable && this._inZone(hand, head)
      if (inZone && !hand.inZone) this.haptic(hand.key, ZONE_PULSE[0], ZONE_PULSE[1])
      hand.inZone = inZone
    }
    let kept = 0
    for (const item of this.loose) {
      if (this._stepLoose(item, dt)) this.loose[kept++] = item
    }
    this.loose.length = kept
    for (const pool of this.pools.values()) this._write(pool)
  }

  /** One frame of a loose thing; false when its source took it back. */
  _stepLoose(item, dt) {
    if (item.state === 'still') return true
    item.t += dt
    if (item.state === 'fall') {
      item.vy -= GRAVITY * dt
      item.y += item.vy * dt
      const bottom = item.y - item.r
      // The lake's surface on the way down: a fish given back there swims off stunned; a swimmer refused goes on to the bed; anything else floats.
      if (!item.tried) {
        const level = this.water.levelAt(item.x, item.z)
        if (level !== null && bottom <= level) {
          item.tried = true
          if (this._giveBack(item, item.x, Math.min(item.y, level), item.z, item.head)) return false
          if (!SWIMMERS.has(item.rec.kind)) {
            item.state = 'float'
            item.t = 0
            item.vx = item.vz = item.vy = 0
            item.phase = this.rand() * Math.PI * 2
            item.spin = between(this.rand, SPIN_RAD) * (this.rand() < 0.5 ? -1 : 1)
            item.tack = 0
            return true
          }
        }
      }
      const ground = this.walk.heightAt(item.x, item.z, bottom)
      if (bottom > ground) return true
      item.y = ground + item.r
      this.thud(item.x, ground, item.z)
      if (this._giveBack(item, item.x, ground, item.z, item.head)) return false
      item.t = 0
      if (item.rec.kind === 'fish') {
        // On its side, its nose along its heading, a hand's breadth of body on the ground.
        item.state = 'flap'
        item.q.setFromAxisAngle(_axis.set(0, 0, 1), Math.PI / 2)
        item.y = ground + item.r * FLAP_LIE / BALL
        item.jerk = between(this.rand, JERK_S)
        item.vy = 0
        return true
      }
      item.state = 'roll'
      item.vx = item.vz = 0
      return true
    }
    if (item.state === 'roll') {
      const n = this.walk.normalAt(item.x, item.z, SLOPE_EPS, _n)
      // Gravity's pull along the slope, the fraction of it a rolling thing takes, fading out over ROLL_S; then the rolling resistance, which takes what speed is left and never reverses it.
      const g = GRAVITY * ROLL_PULL * n.y * Math.max(0, 1 - item.t / ROLL_S)
      item.vx += g * n.x * dt
      item.vz += g * n.z * dt
      let speed = Math.hypot(item.vx, item.vz)
      if (speed > 0) {
        const slowed = Math.max(0, speed - ROLL_FRICTION * dt)
        item.vx *= slowed / speed
        item.vz *= slowed / speed
        speed = slowed
      }
      if ((speed < ROLL_STILL && item.t > 0.25) || item.t >= ROLL_MAX_S) {
        item.state = 'still'
        return true
      }
      item.x += item.vx * dt
      item.z += item.vz * dt
      item.y = this.walk.heightAt(item.x, item.z, item.y) + item.r
      if (speed > 1e-4) {
        // Turned forward about the axis across the travel, up x v, by the arc the ball rolled: its top goes the way it is going.
        _axis.set(item.vz, 0, -item.vx).normalize()
        _dq.setFromAxisAngle(_axis, (speed * dt) / item.r)
        item.q.premultiply(_dq)
      }
      return true
    }
    if (item.state === 'float') {
      const level = this.water.levelAt(item.x, item.z)
      if (level === null) throw new Error(`Hands: a floating ${item.rec.kind} is out of the water at ${item.x.toFixed(1)}, ${item.z.toFixed(1)}`)
      // A new heading every so often, eased into; at the bank -- where the water ends or the bed comes up to the line -- it turns back.
      item.tack -= dt
      if (item.tack <= 0) {
        item.tack = between(this.rand, TACK_S)
        const a = this.rand() * Math.PI * 2
        const v = this.rand() * DRIFT_MPS
        item.ax = Math.cos(a) * v
        item.az = Math.sin(a) * v
      }
      const k = Math.min(1, dt / DRIFT_EASE_S)
      item.vx += (item.ax - item.vx) * k
      item.vz += (item.az - item.vz) * k
      const nx = item.x + item.vx * dt, nz = item.z + item.vz * dt
      const next = this.water.levelAt(nx, nz)
      if (next === null || Math.abs(next - level) > LEVEL_EPS || this.walk.heightAt(nx, nz, level) > level - item.r) {
        item.ax = -item.ax; item.az = -item.az
        item.vx = item.vz = 0
      } else {
        item.x = nx; item.z = nz
      }
      // Up to the line from under the water, down to it from over, then the bob.
      const target = level + item.r * FLOAT_LINE + BOB_AMP * Math.sin(Math.PI * 2 * BOB_HZ * item.t + item.phase)
      const dy = target - item.y
      item.y += dy > 0 ? Math.min(dy, RISE_MPS * dt) : Math.max(dy, -SETTLE_MPS * dt)
      _dq.setFromAxisAngle(UP, item.spin * dt)
      item.q.premultiply(_dq)
      return true
    }
    if (item.state === 'flap') {
      const e = item.t < FLAP_S ? 1 : Math.max(0, 1 - (item.t - FLAP_S) / FLAP_FADE_S)
      if (e <= 0) {
        item.state = 'still'
        item.attrs.aSwim[1] = 0
        return true
      }
      const swim = item.attrs.aSwim
      swim[0] = (swim[0] + Math.PI * 2 * FLAP_HZ * e * dt) % (Math.PI * 2)
      swim[1] = FLAP_AMP * item.rec.size * e
      item.jerk -= dt
      if (item.jerk <= 0) {
        item.jerk = between(this.rand, JERK_S) / Math.max(0.2, e)
        _dq.setFromAxisAngle(UP, (this.rand() - 0.5) * 2 * JERK_RAD * e)
        item.q.premultiply(_dq)
        item.vy = HOP_MPS * e * this.rand()
      }
      const lie = this.walk.heightAt(item.x, item.z, item.y) + item.r * FLAP_LIE / BALL
      item.vy -= GRAVITY * dt
      item.y += item.vy * dt
      if (item.y < lie) { item.y = lie; item.vy = 0 }
      return true
    }
    throw new Error(`Hands: a ${item.rec.kind} in state ${item.state}`)
  }

  _write(pool) {
    const mesh = pool.mesh
    const mat = mesh.instanceMatrix.array
    const col = mesh.instanceColor?.array
    let n = 0
    for (const item of pool.items) {
      if (n === POOL_CAP) throw new Error(`Hands: the ${item.rec.kind} pool is full at ${POOL_CAP}`)
      // The origin is the centre less the (rotated, scaled) offset to it.
      _c.copy(item.off).applyQuaternion(item.q)
      _p.set(item.x - _c.x, item.y - _c.y, item.z - _c.z)
      _s.fromArray(item.rec.scale)
      _m.compose(_p, item.q, _s).toArray(mat, n * 16)
      for (const { name, attr, size } of pool.instanced) {
        const values = item.attrs[name]
        for (let i = 0; i < size; i++) attr.array[n * size + i] = values[i]
      }
      if (col) {
        const c = item.rec.color ?? [1, 1, 1]
        col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2]
      }
      n++
    }
    if (n > 0 || mesh.count > 0) {
      mesh.instanceMatrix.needsUpdate = true
      for (const { attr } of pool.instanced) attr.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    mesh.count = n
  }

  get stats() {
    let held = 0
    for (const hand of this.hands.values()) if (hand.held) held++
    return { held, loose: this.loose.length, pools: this.pools.size, taken: this.taken, stowed: this.stowed, dropped: this.dropped }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const pool of this.pools.values()) {
      // The vertex buffers are the source's; only the pool's own instanced attributes go.
      for (const { attr } of pool.instanced) attr.array = null
    }
    this.pools.clear()
    if (this.studio) {
      for (const { instanced } of this.studio.subjects.values()) for (const { attr } of instanced) attr.array = null
      this.studio = null
    }
  }
}
