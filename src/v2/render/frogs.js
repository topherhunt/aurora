// ---------------------------------------------------------------------------
// Frogs: the Tripo marsh frog, scattered on dry ground within a few metres of
// every riverbank and lake shore below the cold, sitting and hopping about.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION. Each 8 m tile around her rolls its
// candidates from its own seed (critters.js tileSeed), so the same shore has the
// same frogs every visit and nothing is stored between visits. A candidate is a
// frog if the ground is dry, gentle, under the snow line by a margin, clear of
// stone (Rocks.blockTopAt) and within SHORE_M of a shore -- WaterSurfaces.
// shoreDistAt, which answers for lakes and rivers alike. DENSITY is per square
// metre of tile and is the brief's number; the shore band then keeps a small
// fraction of the candidates, which is the point of rolling everything and
// rejecting rather than sampling the band -- the band has no closed form.
//
// A frog sits, then moves in a bout: usually a WALK, a string of short hops
// along one heading with a beat between them, now and then a LEAP or three in
// any direction. A hop may land in the water, where the frog floats sunk SINK
// of its height into the surface (WaterSurfaces.levelAt, bobbing on BOB_S)
// and DRIFTs without stopping, its heading and pace each wandering as a random
// walk so the track winds; it probes a body length ahead (DRIFT_PROBE_EVERY),
// and dry ground there is the bank, hopped onto, where the land bouts resume. It is
// tethered to where it was placed, never landing past TETHER_M from home
// (aimed home once it is out that far, on the water as on the land), and every
// hop target passes the tests its placement did but for dryness, so a frog
// never hops up a rock, into the cold or off the band, which runs SHORE_M to
// either side of the waterline. A frog sits on the DRAWN ground, and is put
// back on it whenever the terrain's render set changes under it (_reseat), so
// a chunk re-splitting at distance never buries it; a frog whose seat turns
// out to be inside a boulder that landed after it leaves. The mesh faces +X; a
// hop turns it to face where it is going, and it sits with its up along the
// field's normal there (the world's up on the water), turning from the one
// slope to the other in the air.
//
// A LURE HAS IT. A spider or a butterfly in her hand (hands.js lures) within
// LURE_M of a frog takes it off its tether: it CHASEs, one hop at a time, each
// aimed at her and swung by up to CHASE.turn either way so the track is a
// scribble, and within ORBIT_M of her feet aimed across her instead, so it
// dances about them; afloat, it hops for her off the water. It forgets the
// lure once the hand is empty or the lure is LURE_FORGET_M off, and sits;
// left outside its tether, its bouts take it home, no hop going further out.
//
// A frog is drawn as the tier of its LOD ladder its apparent size calls for
// (critters.js critterTier, the rungs a ratio of its own body length), one
// InstancedMesh per tier under one material, and not at all under the last
// rung; the tiers together hold every live frog she can see.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CRITTER_GLB, LOD_RUNGS, critterLodUrl, critterTier, glint, hueVary, loadCritterGlb, makeHueAttribute, setCritterAsset, tileSeed, walkTiles,
} from './critters.js'

// Frogs per square metre, a quarter of the brief's figure (which crowded the banks); candidates per tile before the shore band rejects most of them.
export const DENSITY = 0.025
export const TILE = 8
// Tiles whose centre is within this of her are grown; the biggest frog is under the last rung past twenty-nine metres.
export const RADIUS = 48
// Tiers on the ladder: the pick and the shipped -lod1..3, one per rung of the world ladder (critters.js LOD_RUNGS). A 0.36 m frog steps down at 2.4, 4.8 and 9.6 m and is gone past 19.2.
export const LOD_TIERS = LOD_RUNGS
// How far from the waterline a frog may sit, on the dry side.
export const SHORE_M = 5
// The ground a frog will not sit on: steeper than this (a tangent), or within SNOW_MARGIN metres of the snow line, which is the cold the brief excludes.
export const MAX_TAN = Math.tan((35 * Math.PI) / 180)
export const SNOW_MARGIN = 25
// Body length in metres, half to one and a half times the 0.36 m middle; and the pool: 200 slots is a shore's worth at the density and radius above, with room over.
export const SIZE_M = [0.18, 0.54]
export const MAX = 200
// A sitting frog breathes: its body swells by BREATH_AMP (more in height than in length) once every BREATH_S seconds, each frog on its own phase.
export const BREATH_S = 1.3
export const BREATH_AMP = 0.05
// Wet skin: the one roughness the whole frog glints at (critters.js's glint), set by eye -- a tighter lobe read as cling film, not skin.
export const WET_ROUGHNESS = 0.6
// A frog's colour morph, rolled by weight `w`: its hue, a turn of that many radians round the colour wheel (critters.js hueVary; negative turns the map's green toward orange), and its tint, a per-channel multiplier on the texture. Green frogs turn a little either way from the map, olive ones sit dark on it, and brown ones turn a quarter of the wheel and go dark and warm, which lands the map's green on a tawny brown.
export const MORPHS = [
  { name: 'green', w: 5, hue: [-0.5, 0.5], r: [0.7, 1.15], g: [0.8, 1.2], b: [0.6, 1.1] },
  { name: 'olive', w: 2, hue: [-0.3, 0.15], r: [0.55, 0.75], g: [0.6, 0.8], b: [0.35, 0.55] },
  { name: 'brown', w: 3, hue: [-1.1, -0.75], r: [0.75, 0.95], g: [0.6, 0.78], b: [0.4, 0.55] },
]
const MORPH_W = MORPHS.reduce((sum, m) => sum + m.w, 0)
// Sit SIT_S, then a bout: WALK_P of the time a walk, otherwise a leap. A bout is `hops` hops of `m` body lengths, each `dur` seconds long with a `pause` sit between, and each hop turns from the bout's heading by up to `turn` radians either way: a walk holds its line, a leap's full turn is a fresh direction every hop. Every hop rises HOP_RISE of its distance.
const SIT_S = [2, 8]
const WALK_P = 0.7
export const WALK = { hops: [3, 8], m: [0.6, 1.2], dur: [0.18, 0.28], pause: [0.3, 1], turn: 0.6 }
export const LEAP = { hops: [1, 3], m: [3, 6], dur: [0.3, 0.45], pause: [0.15, 0.5], turn: Math.PI * 2 }
const HOP_RISE = 0.45
export const TETHER_M = 4
// The lure: what in her hand a frog wants, how near (across the ground) it is noticed and how far it is kept, the bout it is chased with, within what of her feet a hop goes across her rather than at her, and how soon a sitting frog reacts.
export const LURES = ['spider', 'butterfly']
export const LURE_M = 3
export const LURE_FORGET_M = 8
export const CHASE = { hops: [1, 1], m: [1.5, 3], dur: [0.22, 0.34], pause: [0.1, 0.45], turn: 1.6 }
export const ORBIT_M = 0.7
const NOTICE_S = 0.3
const NO_LURES = []
// Afloat, a frog sits SINK of its height under the surface and rides it up and down by BOB_AMP metres once every BOB_S seconds, on its breath's phase.
export const SINK = 0.5
export const BOB_S = 0.5
export const BOB_AMP = 0.04
// And drifts without stopping, at DRIFT_MPS metres per second for a frog of the middle size (a bigger one proportionally faster), the pace and the heading's turn each wandering as a random walk: the pace jogged by DRIFT_SURGE m/s per second, the turn rate by DRIFT_JOG rad/s per second and held within DRIFT_TURN rad/s. The bank is CLIMB_M body lengths ahead when the probe there is dry.
export const DRIFT_MPS = [0.04, 0.2]
const DRIFT_SURGE = 0.15
export const DRIFT_TURN = 1.2
const DRIFT_JOG = 2.5
const CLIMB_M = 1
const SIZE_MID = (SIZE_M[0] + SIZE_M[1]) / 2
// A drifting frog reads the water a body length ahead on one frame in DRIFT_PROBE_EVERY -- five ground and water queries a read, over a track of a few centimetres a second -- and rides on between reads.
export const DRIFT_PROBE_EVERY = 8
// A frog past the ladder's foot is stepped on one frame in FAR_EVERY, on the time banked since: nothing of it is drawn, and its sits, hops and drift need only add up. Its distance is still read every frame, so it steps and is drawn the frame it comes inside.
export const FAR_EVERY = 8
// The tiles are re-walked once her head has moved this far from where they were last walked: RADIUS is generous by more than this, and a walk is a Map of a hundred tiles read and as many looked up.
const WALK_M = 4

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _tilt = new THREE.Quaternion()
const _nrm = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

export class Frogs {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt, shoreDistAt
   * @param opts.rocks   Rocks, for blockTopAt; a frog never sits on stone
   * @param opts.ground  TerrainV2 or null: the drawn surface to seat on, falling back to the field
   * @param opts.assets  a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, rocks, ground = null, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Frogs needs a height field with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.shoreDistAt !== 'function' || typeof water.levelAt !== 'function') {
      throw new Error('Frogs needs WaterSurfaces, for shoreDistAt and levelAt')
    }
    if (!rocks || typeof rocks.blockTopAt !== 'function') throw new Error('Frogs needs Rocks, for blockTopAt')
    if (ground && (typeof ground.groundAt !== 'function' || typeof ground.groundVersion !== 'number')) {
      throw new Error('Frogs: `ground` was given but has no groundAt and groundVersion -- pass the TerrainV2 or nothing')
    }
    this.height = height
    this.water = water
    this.rocks = rocks
    this.ground = ground
    this.gver = ground ? ground.groundVersion : 0
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x5f0a)

    // Wet skin glints: critters.js's glint. One material for every tier; the tiers share the pick's colour map.
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: WET_ROUGHNESS, metalness: 0 })
    this.material.onBeforeCompile = (shader) => { glint(shader); hueVary(shader) }
    this.material.customProgramCacheKey = () => 'frogs'
    this.tiers = Array.from({ length: LOD_TIERS }, (_, k) => {
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
      mesh.name = k ? `v2-frogs-lod${k}` : 'v2-frogs'
      mesh.count = 0
      // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
      mesh.visible = false
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
      return mesh
    })
    this.hues = this.tiers.map((mesh) => makeHueAttribute(mesh, MAX))
    this.mesh = this.tiers[0]
    this.hue = this.hues[0]
    // The layer toggle flips the group, so it cannot unhide a mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-frogs'
    this.batch.add(...this.tiers)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, yaw: 0, size: 0.36, breath: 0, r: 1, g: 1, b: 1, hue: 0, lod: LOD_TIERS,
        // The ground normal the frog sits along, and the normals at a hop's two ends.
        nx: 0, ny: 1, nz: 0, n0x: 0, n0y: 1, n0z: 0, n1x: 0, n1y: 1, n1z: 0,
        // 'sit' counts `left` down then hops; 'hop' flies from (x0, y0, z0) to (x1, y1, z1) over `dur` seconds, `t` elapsed, `wet0` and `wet1` saying which ends are on the water; 'drift' floats along `heading` at `speed` m/s, turning at `spin` rad/s. `bout` is WALK or LEAP with `hops` of it to go, `heading` the bout's line.
        state: 'sit', left: 0, bout: LEAP, hops: 0, heading: 0, t: 0, dur: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, rise: 0,
        wet0: false, wet1: false, speed: 0, spin: 0,
        // The lure it is chasing (hands.js lures: kind, x, y, z), if any.
        lured: false, lure: null,
        // Seconds banked while a far frog waits for its frame (FAR_EVERY), and the seconds the last update stepped it by, 0 on a frame that held it.
        held: 0, stepped: 0,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.head = { x: 0, z: 0 }
    this.time = 0
    this.frame = 0
    // Where the tiles were last walked from.
    this.walkedX = Infinity
    this.walkedZ = Infinity
    // The pick's bounds (setCritterAsset) and its unit span; the instance scale is size / span, for every tier. `sink` is how far under the surface a floating frog's feet sit, per metre of its size.
    this.bounds = null
    this.span = 1
    this.sink = SINK
    this.loaded = false
    // Candidates the shore band would have kept that found no free slot.
    this.overflow = 0

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  /** The pick and its ladder, the tiers moved as the pick was so they stay in register whatever each one's own box. */
  async load() {
    const pick = await loadCritterGlb(CRITTER_GLB.frog)
    const tiers = await Promise.all(Array.from({ length: LOD_TIERS - 1 }, (_, k) => loadCritterGlb(critterLodUrl(CRITTER_GLB.frog, k + 1), { origin: pick.origin })))
    this.setAsset([pick, ...tiers])
    return true
  }

  /** One asset per tier, the pick first; a gate may pass fewer, and the last given stands in for the rest. */
  setAsset(assets) {
    if (!Array.isArray(assets) || assets.length < 1 || assets.length > LOD_TIERS) throw new Error(`Frogs.setAsset: ${LOD_TIERS} tiers at most, the pick first`)
    this.bounds = setCritterAsset(this.tiers[0], this.material, assets[0], 'frogs')
    this.span = this.bounds.span
    this.sink = (SINK * this.bounds.height) / this.span
    for (let k = 1; k < LOD_TIERS; k++) {
      const asset = assets[Math.min(k, assets.length - 1)]
      // Its own decode of the same WebP: the pick's is the one drawn.
      if (k < assets.length) asset.map?.dispose()
      setCritterAsset(this.tiers[k], this.material, { ...asset, map: null }, `frogs lod${k}`)
    }
    this.loaded = true
  }

  _groundFor(x, z, fieldH) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return fieldH
  }

  /**
   * Every frog put back on the drawn ground, which just changed shape: a chunk
   * re-splitting swaps the leaf's half-metre cells for metre ones 19 m out (11 m
   * in the periphery), and where the new chord rises through a seat it buries
   * the frog until its next hop. A hop in the air has both its ends re-read, so
   * it lands on the new surface too. A frog afloat rides the water, not the ground.
   */
  _reseat() {
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) {
        if (f.state === 'sit') {
          f.y = this._groundFor(f.x, f.z, this.height.heightAt(f.x, f.z))
        } else if (f.state === 'hop') {
          if (!f.wet0) f.y0 = this._groundFor(f.x0, f.z0, this.height.heightAt(f.x0, f.z0))
          if (!f.wet1) f.y1 = this._groundFor(f.x1, f.z1, this.height.heightAt(f.x1, f.z1))
        }
      }
    }
  }

  /**
   * Whether a frog may sit at (x, z): warm, clear of stone, and either on the
   * water or on gentle dry ground, within SHORE_M of the waterline either way.
   * Returns the field's sample there -- height `h` and the gradient `gx`, `gz`
   * the frog sits across -- with `wet` and, on the water, the surface `level`;
   * or null.
   */
  seat(x, z) {
    const s = this.height.heightAndSlopeAt(x, z)
    const { h, tan } = s
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    if (this.rocks.blockTopAt(x, z, 0) > -Infinity) return null
    const level = this.water.levelAt(x, z)
    s.wet = level !== null && h < level
    s.level = s.wet ? level : null
    if (!s.wet && tan > MAX_TAN) return null
    const shore = this.water.shoreDistAt(x, z, SHORE_M, h, tan)
    if (!(shore < SHORE_M && shore > -SHORE_M)) return null
    return s
  }

  /** The unit normal of a seat's ground, into the frog's n1 (the slope it lands on); the world's up on the water. */
  static _normal(f, { gx, gz, wet }) {
    const len = wet ? 1 : Math.hypot(gx, 1, gz)
    f.n1x = wet ? 0 : -gx / len
    f.n1y = 1 / len
    f.n1z = wet ? 0 : -gz / len
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, frogs: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      let roll = rand() * MORPH_W
      const morph = MORPHS.find((m) => (roll -= m.w) < 0) ?? MORPHS[MORPHS.length - 1]
      const r = between(rand, morph.r)
      const g = between(rand, morph.g)
      const b = between(rand, morph.b)
      const hue = between(rand, morph.hue)
      const yaw = rand() * Math.PI * 2
      // Placed on dry ground only; the water is reached by hopping in.
      const s = this.seat(x, z)
      if (s === null || s.wet) continue
      const f = this.free.pop()
      if (!f) { this.overflow++; continue }
      f.tile = t
      f.x = f.homeX = x
      f.z = f.homeZ = z
      f.y = this._groundFor(x, z, s.h)
      Frogs._normal(f, s)
      f.nx = f.n1x; f.ny = f.n1y; f.nz = f.n1z
      f.size = size
      f.r = r; f.g = g; f.b = b
      f.hue = hue
      f.yaw = yaw
      f.breath = this.rand() * Math.PI * 2
      f.lod = LOD_TIERS
      f.state = 'sit'
      f.left = between(this.rand, SIT_S)
      f.hops = 0
      f.held = 0
      f.lured = false
      f.lure = null
      t.frogs.push(f)
    }
    return t
  }

  _leave(t) {
    for (const f of t.frogs) {
      f.tile = null
      this.free.push(f)
    }
    t.frogs.length = 0
  }

  _drop(f) {
    const list = f.tile.frogs
    list.splice(list.indexOf(f), 1)
    f.tile = null
    this.free.push(f)
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = cx
    this.walkedZ = cz
  }

  get stats() {
    return { alive: MAX - this.free.length, tiles: this.tiles.size, overflow: this.overflow }
  }

  /** Turn the heading for home, within a quarter turn of it. */
  _aimHome(f) {
    f.heading = Math.atan2(-(f.homeZ - f.z), f.homeX - f.x) + (this.rand() - 0.5) * (Math.PI / 2)
  }

  /** Swing the heading a quarter to three-quarters of a turn, either way. */
  _turnAway(f) {
    f.heading += (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + this.rand() * Math.PI / 2)
  }

  /** Launch `f` from where it is toward the seat `s1` at (x1, z1), on the bearing `a`, over `dur` seconds. */
  _launch(f, a, x1, z1, s1, dur) {
    f.x0 = f.x; f.z0 = f.z; f.y0 = f.y; f.wet0 = f.state === 'drift'
    f.x1 = x1; f.z1 = z1; f.wet1 = s1.wet
    f.y1 = s1.wet ? s1.level - f.size * this.sink : this._groundFor(x1, z1, s1.h)
    f.n0x = f.nx; f.n0y = f.ny; f.n0z = f.nz
    Frogs._normal(f, s1)
    f.yaw = a
    f.rise = Math.hypot(x1 - f.x, z1 - f.z) * HOP_RISE
    f.dur = dur
    f.t = 0
    f.state = 'hop'
  }

  /**
   * The lure this frog is on this frame: the nearest of `lures` (hands.js
   * lures) it wants, noticed within LURE_M across the ground and kept to
   * LURE_FORGET_M. Noticing one cuts a sit short; losing one ends the chase.
   */
  _notice(f, lures) {
    let lure = null
    let best = Infinity
    for (const l of lures) {
      if (!LURES.includes(l.kind)) continue
      const d = Math.hypot(l.x - f.x, l.z - f.z)
      if (d < best) { best = d; lure = l }
    }
    if (lure !== null && best <= (f.lured ? LURE_FORGET_M : LURE_M)) {
      f.lure = lure
      if (!f.lured) {
        f.lured = true
        f.hops = 0
        if (f.state === 'sit') f.left = Math.min(f.left, NOTICE_S)
      }
      return
    }
    if (!f.lured) return
    f.lured = false
    f.lure = null
    f.hops = 0
  }

  /** The chase's next hop lined up: the bout is CHASE and the heading is at the lure, or across it -- a quarter turn off, either way -- within ORBIT_M of it. */
  _chase(f) {
    const l = f.lure
    f.bout = CHASE
    f.hops = 1
    f.heading = Math.atan2(-(l.z - f.z), l.x - f.x)
    if (Math.hypot(l.x - f.x, l.z - f.z) < ORBIT_M) f.heading += (this.rand() < 0.5 ? 1 : -1) * (Math.PI / 2)
  }

  /** Pick the next hop of a sitting frog's bout, or return false to keep sitting. A chasing frog is off its tether; one a chase left outside it may hop no further out, and heads home. */
  _hop(f) {
    const stray = Math.hypot(f.homeX - f.x, f.homeZ - f.z)
    if (!f.lured && stray > TETHER_M) this._aimHome(f)
    const leash = Math.max(TETHER_M, stray)
    const reach = between(this.rand, f.bout.m) * f.size
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = f.heading + (this.rand() - 0.5) * f.bout.turn
      const x1 = f.x + Math.cos(a) * reach
      const z1 = f.z - Math.sin(a) * reach
      const s1 = this.seat(x1, z1)
      if (s1 === null || (!f.lured && Math.hypot(x1 - f.homeX, z1 - f.homeZ) > leash)) {
        // The bout's line is blocked: try another way.
        this._turnAway(f)
        continue
      }
      this._launch(f, a, x1, z1, s1, between(this.rand, f.bout.dur))
      return true
    }
    return false
  }

  /**
   * One frame of a floating frog. The heading's turn and the pace each wander
   * as a random walk so the track winds; on a probe frame the water a body
   * length ahead is read, and is dry ground (the bank, hopped onto with a
   * walk's timing), blocked or past the tether (turned away from, and the frog
   * holds this frame), or water (drifted into, at its level). Between probes it
   * drifts on at the level it has.
   */
  _drift(f, dt, probing) {
    const k = f.size / SIZE_MID
    f.spin = Math.max(-DRIFT_TURN, Math.min(DRIFT_TURN, f.spin + (this.rand() - 0.5) * DRIFT_JOG * dt))
    f.heading += f.spin * dt
    f.speed = Math.max(DRIFT_MPS[0] * k, Math.min(DRIFT_MPS[1] * k, f.speed + (this.rand() - 0.5) * DRIFT_SURGE * k * dt))
    if (probing) {
      // A lured frog is off the water at the lure's bearing the first hop that lands.
      if (f.lured) {
        this._chase(f)
        if (this._hop(f)) return
      }
      const ahead = f.size * CLIMB_M
      const ax = f.x + Math.cos(f.heading) * ahead
      const az = f.z - Math.sin(f.heading) * ahead
      const s = this.seat(ax, az)
      if (!f.lured && Math.hypot(ax - f.homeX, az - f.homeZ) > TETHER_M) {
        this._aimHome(f)
        f.spin = 0
        return
      }
      if (s === null) {
        this._turnAway(f)
        f.spin = 0
        return
      }
      if (!s.wet) {
        f.hops = 0
        this._launch(f, f.heading, ax, az, s, between(this.rand, WALK.dur))
        return
      }
      f.y = s.level - f.size * this.sink
    }
    f.x += Math.cos(f.heading) * f.speed * dt
    f.z -= Math.sin(f.heading) * f.speed * dt
    f.yaw = f.heading
  }

  /** `lures`: hands.js lures() this frame, the spiders and butterflies among them chased. */
  update(hx, hy, hz, dt, lures = NO_LURES) {
    this.head.x = hx
    this.head.z = hz
    this.time += dt
    this.frame++
    if (Math.hypot(hx - this.walkedX, hz - this.walkedZ) > WALK_M) {
      walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
      this.walkedX = hx
      this.walkedZ = hz
    }
    if (this.ground && this.ground.groundVersion !== this.gver) {
      this.gver = this.ground.groundVersion
      this._reseat()
    }

    const breath = (this.time * Math.PI * 2) / BREATH_S
    const bob = (this.time * Math.PI * 2) / BOB_S
    const counts = this.tiers.map(() => 0)
    for (const t of this.tiles.values()) {
      // Backwards, because a frog that finds itself inside a rock leaves the list mid-walk.
      for (let i = t.frogs.length - 1; i >= 0; i--) {
        const f = t.frogs[i]
        let step = dt
        if (f.lod === LOD_TIERS) {
          // Held until its frame, unless it has come inside the ladder's foot, which is read every frame so it is drawn the frame it is in view.
          f.held += dt
          if ((this.frame + f.id) % FAR_EVERY !== 0 && critterTier(f.size, Math.hypot(f.x - hx, f.y - hy, f.z - hz), f.lod, LOD_TIERS) === LOD_TIERS) { f.stepped = 0; continue }
          step = f.held
        }
        f.held = 0
        f.stepped = step
        this._notice(f, lures)
        let sy = 1
        let sx = 1
        let sz = 1
        // The surface's bob, ridden while afloat.
        let lift = 0
        if (f.state === 'sit') {
          // The breath: a swell that is mostly height, a little girth.
          const s = BREATH_AMP * (0.5 + 0.5 * Math.sin(breath + f.breath))
          sy = 1 + s
          sx = sz = 1 + s * 0.4
          f.left -= step
          if (f.left <= 0) {
            // A boulder placed after the frog sat here: the seat is stone now, and the frog goes.
            if (this.rocks.blockTopAt(f.x, f.z, 0) > -Infinity) { this._drop(f); continue }
            if (f.lured) {
              this._chase(f)
            } else if (f.hops <= 0) {
              f.bout = this.rand() < WALK_P ? WALK : LEAP
              f.hops = Math.round(between(this.rand, f.bout.hops))
              f.heading = this.rand() * Math.PI * 2
            }
            if (this._hop(f)) {
              f.hops--
            } else {
              f.hops = 0
              f.left = between(this.rand, f.lured ? CHASE.pause : SIT_S)
            }
          }
        } else if (f.state === 'drift') {
          lift = BOB_AMP * Math.sin(bob + f.breath)
          this._drift(f, step, (this.frame + f.id) % DRIFT_PROBE_EVERY === 0)
        } else {
          f.t += step
          const u = Math.min(1, f.t / f.dur)
          f.x = f.x0 + (f.x1 - f.x0) * u
          f.z = f.z0 + (f.z1 - f.z0) * u
          f.y = f.y0 + (f.y1 - f.y0) * u + 4 * f.rise * u * (1 - u)
          // Turning from the slope it left to the one it lands on, ready before touchdown.
          const v = Math.min(1, u * 1.5)
          _nrm.set(f.n0x + (f.n1x - f.n0x) * v, f.n0y + (f.n1y - f.n0y) * v, f.n0z + (f.n1z - f.n0z) * v).normalize()
          f.nx = _nrm.x; f.ny = _nrm.y; f.nz = _nrm.z
          // Stretched along the leap in the air, flattened a little on landing.
          const s = Math.sin(Math.PI * u)
          sx = 1 + 0.25 * s
          sy = 1 - 0.15 * s
          if (u >= 1) {
            f.y = f.y1
            if (f.wet1) {
              // Into the water: the bout is over, and the frog drifts on from the hop's line at an easy pace.
              f.state = 'drift'
              f.hops = 0
              f.heading = f.yaw
              f.spin = 0
              f.speed = ((DRIFT_MPS[0] + DRIFT_MPS[1]) / 2) * (f.size / SIZE_MID)
            } else {
              f.state = 'sit'
              f.left = between(this.rand, f.hops > 0 || f.lured ? f.bout.pause : SIT_S)
            }
          }
        }
        // The tier its apparent size calls for; past the ladder's foot it is not drawn, and steps on its FAR_EVERY frames.
        f.lod = critterTier(f.size, Math.hypot(f.x - hx, f.y - hy, f.z - hz), f.lod, LOD_TIERS)
        if (f.lod === LOD_TIERS) continue
        const k = f.size / this.span
        _pos.set(f.x, f.y + lift, f.z)
        // Yaw about the world up, then that up tilted onto the ground's normal.
        _quat.setFromAxisAngle(UP, f.yaw)
        _tilt.setFromUnitVectors(UP, _nrm.set(f.nx, f.ny, f.nz))
        _quat.premultiply(_tilt)
        _scl.set(k * sx, k * sy, k * sz)
        _mat.compose(_pos, _quat, _scl)
        const tier = this.tiers[f.lod]
        const w = counts[f.lod]++
        _mat.toArray(tier.instanceMatrix.array, w * 16)
        const c = tier.instanceColor.array
        c[w * 3] = f.r; c[w * 3 + 1] = f.g; c[w * 3 + 2] = f.b
        this.hues[f.lod].array[w] = f.hue
      }
    }
    // A tier that held nothing and holds nothing is not re-uploaded.
    this.tiers.forEach((tier, k) => {
      if (counts[k] > 0 || tier.count > 0) {
        tier.instanceMatrix.needsUpdate = true
        tier.instanceColor.needsUpdate = true
        this.hues[k].needsUpdate = true
      }
      tier.count = counts[k]
    })
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const tier of this.tiers) tier.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
