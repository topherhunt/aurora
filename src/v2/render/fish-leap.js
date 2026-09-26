import THREE from '../../three-instance.js'
import { makeHueAttribute } from './critters.js'
import { HUE } from './fish.js'

// ---------------------------------------------------------------------------
// A fish leaping from a lake: now and then, while her head is above the water,
// one clears the surface somewhere within RANGE_M of her on a parabola and
// falls back in with a splash (voices(), ambience.js RULES.splash). Only open
// lake water will do: SHORE_M from its shore, and shallower than MAX_DEPTH_M.
// It is this client's own, like a bird call, and not on the room's score. The
// fish layer draws nothing from above the water, so a leap is one instance of
// its own, borrowing a fish species' vertex buffers and material.
// ---------------------------------------------------------------------------

// A leap is tried on average once every EVERY_S seconds above the water, at up to TRIES points in reach; the more lake about her, the likelier one of them is.
export const EVERY_S = 25
export const TRIES = 6
export const RANGE_M = 30
export const SHORE_M = 4
export const MAX_DEPTH_M = 30
// How far the fish's middle rises over the surface, how far it carries across it, and how long it is.
export const RISE_M = [0.5, 1]
export const RUN_M = [0.6, 1.4]
export const LENGTH_M = [0.25, 0.5]
// Its middle sets off and comes down this far under the surface, as a fraction of its length, so it leaves and enters the water whole rather than popping out of the plane.
const SUBMERGE = 0.3
const GRAVITY = 9.8
const LEAPERS = ['ironscale-bass', 'glimmerfin']
// Tail beats per second in the air: a fish thrashing, not cruising.
const TAIL_HZ = 6

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

export class FishLeap {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt
   * @param water   WaterSurfaces: lakeLevelAt, lakeShoreDistAt
   * @param fish    the Fish layer, whose species' meshes a leap is drawn with once they have loaded
   */
  constructor(scene, height, water, fish, { rand = Math.random } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function') throw new Error('FishLeap needs a height field with heightAt and heightAndSlopeAt')
    if (!water || typeof water.lakeLevelAt !== 'function' || typeof water.lakeShoreDistAt !== 'function') throw new Error('FishLeap needs WaterSurfaces, for lakeLevelAt and lakeShoreDistAt')
    if (!fish || !Array.isArray(fish.species)) throw new Error('FishLeap needs the Fish layer, for its species')
    this.height = height
    this.water = water
    this.species = LEAPERS.map((id) => {
      const sp = fish.species.find((s) => s.id === id)
      if (!sp) throw new Error(`FishLeap: the fish layer has no ${id}`)
      return sp
    })
    this.rand = rand
    this.group = new THREE.Group()
    this.group.name = 'v2-fish-leap'
    scene.add(this.group)
    // One mesh a species, built the first time that species leaps.
    this.meshes = new Map()
    // The leap in the air, or null: its species' mesh, start and end, rise, time and pose.
    this.leap = null
    // This frame's one-shots for the ear, drained by voices(): { sound, rule, x, y, z }.
    this.calls = []
    this.leaps = 0
  }

  /** A one-instance mesh drawing species `sp`: its vertex buffers and index shared, its own swim, colour and hue. */
  _mesh(sp) {
    let mesh = this.meshes.get(sp)
    if (mesh) return mesh
    const src = sp.mesh.geometry
    const geo = new THREE.BufferGeometry()
    for (const [name, attr] of Object.entries(src.attributes)) if (!attr.isInstancedBufferAttribute) geo.setAttribute(name, attr)
    geo.setIndex(src.index)
    geo.setAttribute('aSwim', new THREE.InstancedBufferAttribute(new Float32Array(4), 4))
    mesh = new THREE.InstancedMesh(geo, sp.material, 1)
    mesh.name = `v2-fish-leap-${sp.id}`
    mesh.frustumCulled = false
    mesh.visible = false
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3).fill(1), 3)
    makeHueAttribute(mesh, 1)
    this.group.add(mesh)
    this.meshes.set(sp, mesh)
    return mesh
  }

  /** Where a fish may leap: open lake at (x, z), its surface level, or null. */
  spot(x, z) {
    const level = this.water.lakeLevelAt(x, z)
    if (level === null) return null
    const { h, tan } = this.height.heightAndSlopeAt(x, z)
    const depth = level - h
    if (!(depth > 0 && depth < MAX_DEPTH_M)) return null
    if (this.water.lakeShoreDistAt(x, z, SHORE_M, h, tan) > -SHORE_M) return null
    return level
  }

  /** Up to TRIES points within RANGE_M of her head; the first that is open lake gets a leap. */
  _launch(head) {
    const loaded = this.species.filter((sp) => sp.loaded)
    if (loaded.length === 0) return
    for (let k = 0; k < TRIES; k++) {
      const a = this.rand() * Math.PI * 2
      const r = RANGE_M * Math.sqrt(this.rand())
      const x = head.x + Math.cos(a) * r
      const z = head.z + Math.sin(a) * r
      const level = this.spot(x, z)
      if (level === null) continue
      const sp = loaded[Math.min(loaded.length - 1, (this.rand() * loaded.length) | 0)]
      const len = between(this.rand, LENGTH_M)
      const sink = SUBMERGE * len
      const lift = between(this.rand, RISE_M) + sink
      const run = between(this.rand, RUN_M)
      const b = this.rand() * Math.PI * 2
      const mesh = this._mesh(sp)
      mesh.instanceColor.array.fill(0.8 + 0.3 * this.rand())
      mesh.instanceColor.needsUpdate = true
      mesh.geometry.attributes.aHue.array[0] = (this.rand() * 2 - 1) * HUE
      mesh.geometry.attributes.aHue.needsUpdate = true
      mesh.visible = true
      this.leap = {
        sp, mesh, len, lift, run, level,
        x0: x, z0: z, dx: Math.cos(b), dz: Math.sin(b), y0: level - sink,
        // Up and down again under gravity from `lift` high.
        dur: 2 * Math.sqrt((2 * lift) / GRAVITY),
        t: 0, phase: this.rand() * Math.PI * 2,
      }
      this.leaps++
      return
    }
  }

  /** The leap in the air posed at its fraction `u` flown: along the parabola, its nose on the tangent. */
  _pose(L, u) {
    const x = L.x0 + L.dx * L.run * u
    const z = L.z0 + L.dz * L.run * u
    const y = L.y0 + 4 * L.lift * u * (1 - u)
    _euler.set(Math.atan2(4 * L.lift * (1 - 2 * u), L.run), Math.atan2(-L.dx, -L.dz), 0)
    _quat.setFromEuler(_euler)
    const k = L.len / L.sp.lengthM
    _mat.compose(_pos.set(x, y, z), _quat, _scl.set(k, k, k))
    L.mesh.setMatrixAt(0, _mat)
    L.mesh.instanceMatrix.needsUpdate = true
    const swim = L.mesh.geometry.attributes.aSwim
    swim.array[0] = L.phase
    swim.array[1] = L.sp.cfg.tailAmp * L.sp.lengthM * 1.5
    swim.needsUpdate = true
  }

  /** Once a frame. `head` is her ears; no leap starts while they are under the water, and one in the air finishes. */
  update(dt, head, submerged) {
    this.calls.length = 0
    const L = this.leap
    if (L !== null) {
      L.t += dt
      L.phase = (L.phase + Math.PI * 2 * TAIL_HZ * dt) % (Math.PI * 2)
      if (L.t >= L.dur) {
        L.mesh.visible = false
        this.leap = null
        this.calls.push({ sound: 'splash', rule: 'splash', x: L.x0 + L.dx * L.run, y: L.level, z: L.z0 + L.dz * L.run })
      } else {
        this._pose(L, L.t / L.dur)
      }
      return
    }
    if (!submerged && this.rand() < dt / EVERY_S) this._launch(head)
    if (this.leap !== null) this._pose(this.leap, 0)
  }

  /** The one-shots since the last call, each `{ sound, rule, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
    return into
  }

  dispose() {
    this.group.parent?.remove(this.group)
    // Frees the shared vertex buffers along with this geometry's own instanced ones; the fish layer re-uploads them if it is still drawn (hands.js pools do the same).
    for (const mesh of this.meshes.values()) mesh.geometry.dispose()
  }
}
