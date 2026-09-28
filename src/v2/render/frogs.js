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
// AND SO IS EVERYTHING A FROG DOES (_notes/creature-sync.md). A frog's life
// runs on the room's clock, cut into segments of GRID_S seconds on its own
// grid (sim/score.js), and every segment runs from one POST to the next: a
// seat within TETHER_M of home rolled from the frog's key and the segment's
// index, so any client, meeting the bed at any moment, plans the same segment
// and draws the frog in the same place. Between two posts the frog sits, then
// moves in a bout laid at plan time: usually a WALK, a string of short hops
// along the line between the posts with a beat between them, else a LEAP or
// a few, each landing swung off the line and every landing passing the tests
// its placement did but for dryness -- so a frog never hops up a rock, into
// the cold or off the band, which runs SHORE_M to either side of the
// waterline. A landing in the water floats there, sunk SINK of its height
// into the surface (WaterSurfaces.levelAt, bobbing on BOB_S) for a longer
// beat, and hops on; a post may be in the water too, within WADE_M of the
// bank, and the frog floats out its sits there. A bout no jitter can lay past a stone sits the segment
// out. A hop is a parabola between its two landings, so a frog's pose at any
// second is arithmetic on the plan: nothing is integrated, nothing depends on
// the frame, and a frog out of view costs one plan a segment. A frog sits on
// the DRAWN ground, and is put back on it whenever the terrain's render set
// changes under it (_reseat), so a chunk re-splitting at distance never
// buries it; a frog whose home turns out to be inside a boulder that landed
// after it leaves. The mesh faces +X; a hop turns it to face where it is
// going, and it sits with its up along the field's normal there (the world's
// up on the water), turning from the one slope to the other in the air.
//
// A LURE HAS IT. A spider, a butterfly or a grasshopper in a hand (hands.js
// lures, hers and the peers') within LURE_M of a frog takes it off its plan:
// it CHASEs, one hop at a time, each aimed at the lure and swung by up to
// CHASE.turn either way so the track is a scribble, and within ORBIT_M of it
// aimed across instead, so it dances about her feet; afloat, it hops for the
// lure off the water. It forgets the lure once the hand is empty or the lure
// is LURE_FORGET_M off, and REJOINS: a bout laid from where it is to the post
// of the next segment turn at least REJOIN_MIN_S off, and the plan has it
// again from that turn. The chase runs on every client off the relayed hand,
// so a peer's frog chases here too; the one thing sent is the bed's LURED
// SET (creature-net.js), which frogs of a bed her hand has, so a client
// hearing it keeps a frog the lure is between LURE_M and LURE_FORGET_M from,
// as she does.
//
// A HOB IS PREY. In a glade the hobs are lures too (hobs.js lures), chased
// the same way but on each client's own hobs, so never in a lured set; the
// hob runs from it (chasers()). A villager who sees it CATCHES the frog
// (villagers.js claims): it freezes where it was seen ('wait'), is posed in
// the villager's fist ('held') and is thrown as one hop into the water from
// the release second ('thrown'), then floats WET_PAUSE_S and rejoins; let go
// unthrown, it drops and rejoins. Either way it ignores hobs CALM_S after.
//
// A HOP IS HEARD. The frame a frog starts a hop, and the frame one lands in
// the water off dry ground, it says so to the ear (voices(), ambience.js
// frogHop and splash); the queue is this frame's only, so nothing said while
// the ambience is not listening is heard late.
//
// A frog is drawn as the tier of its LOD ladder its apparent size calls for
// (critters.js critterTier, the rungs a ratio of its own body length), one
// InstancedMesh per tier under one material, and not at all under the last
// rung; the tiers together hold every live frog she can see.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { GRID_S, hash32, keyHash, phraseRand } from '../../sim/score.js'
import {
  CRITTER_GLB, LOD_RUNGS, TIER_TINTS, critterLodUrl, critterTier, glint, hueVary, loadCritterGlb, makeHueAttribute, setCritterAsset, tierTintOn, tileSeed, walkTiles,
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
// A segment: sit SIT_S at its first post, then the bout to its next, then sit out the rest. A bout is `hops` hops of `m` body lengths, each `dur` seconds long with a `pause` sit between, WALK_P of the time a walk when the posts are within HOPS_MAX walking hops of each other, else a leap; each landing but the last is swung off the line between the posts by the sine of up to `turn` radians of the hop's reach, so a walk holds its line and a leap scribbles. Every hop rises HOP_RISE of its distance. A bout longer than a segment is hurried to fit; one no jitter can lay is not made, and the frog sits the segment out (LAY_TRIES jitters, HOPS_MAX hops).
export const SIT_S = [1, 5]
const WALK_P = 0.7
export const WALK = { hops: [3, 8], m: [0.6, 1.2], dur: [0.18, 0.28], pause: [0.3, 1], turn: 0.3 }
export const LEAP = { hops: [1, 3], m: [3, 6], dur: [0.3, 0.45], pause: [0.15, 0.5], turn: Math.PI / 4 }
const HOP_RISE = 0.45
const LAY_TRIES = 3
export const HOPS_MAX = 12
// A post is rolled within TETHER_M of home, as often near it as far, POST_TRIES seats tried before it is home itself; one in the water within WADE_M of the bank will do, and the frog floats there.
export const TETHER_M = 4
const POST_TRIES = 4
export const WADE_M = 1.5
// A landing in the water floats there this long before the next hop.
export const WET_PAUSE_S = [1.5, 4]
// The lure: what a frog wants, in a hand or (the hob) on its own feet, how near (across the ground) it is noticed and how far it is kept, the bout it is chased with, within what of the lure a hop goes across it rather than at it, how soon a sitting frog reacts, and the least a rejoin is given to reach its post.
export const LURES = ['spider', 'butterfly', 'grasshopper', 'hob']
export const LURE_M = 3
export const LURE_FORGET_M = 8
export const CHASE = { hops: [1, 1], m: [1.5, 3], dur: [0.22, 0.34], pause: [0.1, 0.45], turn: 1.6 }
export const ORBIT_M = 0.7
export const NOTICE_S = 0.3
export const REJOIN_MIN_S = 2
const NO_LURES = []
// A bed's lured set goes to the room when the frogs her hand has change, at most once in LURED_EVERY_S.
export const LURED_EVERY_S = 1
// Caught: the hop to where it was seen, the throw's flight and its rise over the line, and how long after it hobs are let be.
const FREEZE_HOP_S = 0.3
export const THROW_S = 0.7
const THROW_RISE = 1
export const CALM_S = 30
const NO_CLAIMS = new Map()
// Afloat, a frog sits SINK of its height under the surface and rides it up and down by BOB_AMP metres once every BOB_S seconds, on its breath's phase.
export const SINK = 0.5
export const BOB_S = 0.5
export const BOB_AMP = 0.04
// The tiles are re-walked once her head has moved this far from where they were last walked: RADIUS is generous by more than this, and a walk is a Map of a hundred tiles read and as many looked up.
const WALK_M = 4
// A frog further than this from her head says nothing to the ear: the splash's reach (ambience.js RULES.splash), the farther of its two sounds.
const HEAR_M = 30

/** The room's key for a bed of frogs, its tile; a frog's is the bed's and its candidate index (creature-net.js routes the `fg` prefix here). */
export const bedKey = (tx, tz) => `fg:${tx},${tz}`
export const keyOf = (tx, tz, i) => `${bedKey(tx, tz)}:${i}`

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
/** The heading from `a` to `b`: a hop along it is x += cos, z -= sin. */
const bearing = (a, b) => Math.atan2(-(b.z - a.z), b.x - a.x)
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

    // Wet skin glints: critters.js's glint. One material for every tier; the tiers share the pick's colour map.
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: WET_ROUGHNESS, metalness: 0 })
    this.material.onBeforeCompile = (shader) => { glint(shader); hueVary(shader) }
    this.material.customProgramCacheKey = () => 'frogs'
    this.tinted = false
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
        id: i, tile: null, key: '', index: 0, offset: 0,
        x: 0, y: 0, z: 0, homeX: 0, homeZ: 0, yaw: 0, size: 0.36, breath: 0, r: 1, g: 1, b: 1, hue: 0, lod: LOD_TIERS,
        // The ground normal the frog sits along.
        nx: 0, ny: 1, nz: 0,
        // The phrase playing -- a 'sit' at a spot or a 'hop' between two -- `t` seconds into it, `wet` when the frog is afloat; `u` the hop's fraction flown.
        state: 'sit', ph: null, t: 0, u: 0, wet: false,
        // The planned segment (see _segment), and off the plan -- chasing a lure, or rejoining it -- the live phrase and when it began, its queue of laid phrases (a rejoin) and the turn the plan is back at.
        seg: null, live: null,
        // Its own noise for the chase, and the lure it is chasing (hands.js lures: kind, x, y, z, by), if any.
        rand: null, lured: false, lure: null,
        // A villager's hold on it (villagers.js claims) as last applied: null, 'wait', 'held' or 'thrown'; and the second it heeds hobs again.
        caught: null, calm: -Infinity,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.head = { x: 0, z: 0 }
    this.now = 0
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
    // Lured sets owed to the room (pendingLured), and the peers' by bed key (applyLured): { by, has }.
    this.owed = []
    this.luredIn = new Map()
    this.stats = { alive: 0, tiles: 0, overflow: 0, segments: 0 }
    // This frame's one-shots for the ear, drained by voices(): { sound, rule, x, y, z }.
    this.calls = []

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
   * Every landing put back on the drawn ground, which just changed shape: a
   * chunk re-splitting swaps the leaf's half-metre cells for metre ones 19 m
   * out (11 m in the periphery), and where the new chord rises through a seat
   * it buries the frog until its next hop. A frog afloat rides the water, not
   * the ground.
   */
  _reseat() {
    const spot = (s) => { if (s && !s.wet) s.y = this._groundFor(s.x, s.z, s.h) }
    const phrase = (ph) => { if (ph.kind === 'sit') spot(ph.at); else { spot(ph.from); spot(ph.to) } }
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) {
        if (f.seg) for (const ph of f.seg.phrases) phrase(ph)
        if (f.live) { phrase(f.live.ph); if (f.live.queue) for (const ph of f.live.queue) phrase(ph) }
      }
    }
  }

  /**
   * Whether a frog may sit at (x, z): warm, clear of stone, and either on the
   * water or on gentle dry ground, within SHORE_M of the waterline either way.
   * Returns the field's sample there -- height `h` and the gradient `gx`, `gz`
   * the frog sits across -- with `wet`, on the water the surface `level`, and
   * `shore`, how far from the waterline it is, negative on the water; or null.
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
    s.shore = shore
    return s
  }

  /** A spot frog `f` can sit at: the seat `s` at (x, z) as a landing, on the drawn ground or sunk into the water, with the normal it sits along (the world's up on the water) and the way it faces. */
  _spot(f, x, z, s, yaw = 0) {
    const len = s.wet ? 1 : Math.hypot(s.gx, 1, s.gz)
    return {
      x, z, h: s.h, wet: s.wet, level: s.level,
      y: s.wet ? s.level - f.size * this.sink : this._groundFor(x, z, s.h),
      nx: s.wet ? 0 : -s.gx / len, ny: 1 / len, nz: s.wet ? 0 : -s.gz / len,
      yaw,
    }
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, key: bedKey(tx, tz), frogs: [], luredSent: '', luredAt: -Infinity }
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
      const breath = rand() * Math.PI * 2
      // Placed on dry ground only; the water is reached by hopping in.
      const s = this.seat(x, z)
      if (s === null || s.wet) continue
      const f = this.free.pop()
      if (!f) { this.overflow++; continue }
      f.tile = t
      f.key = keyOf(tx, tz, i)
      f.index = i
      f.offset = keyHash(f.key) % GRID_S
      f.x = f.homeX = x
      f.z = f.homeZ = z
      f.size = size
      f.y = this._groundFor(x, z, s.h)
      const home = this._spot(f, x, z, s)
      f.nx = home.nx; f.ny = home.ny; f.nz = home.nz
      f.r = r; f.g = g; f.b = b
      f.hue = hue
      f.yaw = 0
      f.breath = breath
      f.lod = LOD_TIERS
      f.state = 'sit'
      f.ph = null
      f.wet = false
      f.seg = null
      f.live = null
      f.rand = mulberry32(hash32(keyHash(f.key), 0x1e))
      f.lured = false
      f.lure = null
      f.caught = null
      f.calm = -Infinity
      t.frogs.push(f)
    }
    return t
  }

  _leave(t) {
    // A bed her hand had frogs of: the room hears they are let go.
    if (t.luredSent !== '') this.owed.push([t.key, 'fg', null, []])
    this.luredIn.delete(t.key)
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

  // --- the plan ---------------------------------------------------------------

  /**
   * Where frog `f` sits at the turn of its segment `g`: a seat within TETHER_M
   * of home rolled from its key and `g`, its distance uniform so the posts
   * crowd home, dry or afloat within WADE_M of the bank, home itself when
   * POST_TRIES find none; null once home is stone. A pure function, so every
   * client has it.
   */
  _post(f, g) {
    const rand = phraseRand(f.key, g, 0)
    for (let k = 0; k < POST_TRIES; k++) {
      const a = rand() * Math.PI * 2
      const r = rand() * TETHER_M
      const x = f.homeX + Math.cos(a) * r
      const z = f.homeZ - Math.sin(a) * r
      const s = this.seat(x, z)
      if (s !== null && (!s.wet || s.shore > -WADE_M)) return this._spot(f, x, z, s)
    }
    const s = this.seat(f.homeX, f.homeZ)
    return s === null || s.wet ? null : this._spot(f, f.homeX, f.homeZ, s)
  }

  /** `spot` turned to face the way in from `prev`, and returned. */
  static _facing(prev, spot) {
    if (spot !== null && prev !== null) spot.yaw = Math.hypot(spot.x - prev.x, spot.z - prev.z) < 1e-9 ? prev.yaw : bearing(prev, spot)
    return spot
  }

  /**
   * The hops of a bout from spot `a` to spot `b` for frog `f`, with the beat
   * after each but the last, as `[hop, sit, hop, sit, ..., hop]` phrases; the
   * bout hurried to fit `budget` seconds. Null when no jitter lays every
   * landing on a seat, or nothing when the spots are one. `rand` is the
   * plan's or the frog's own.
   */
  _lay(f, rand, a, b, budget) {
    const D = Math.hypot(b.x - a.x, b.z - a.z)
    if (D < 1e-9) return []
    const bout = D <= WALK.m[1] * HOPS_MAX * f.size && rand() < WALK_P ? WALK : LEAP
    const n = Math.min(HOPS_MAX, Math.max(bout.hops[0], Math.ceil(D / (between(rand, bout.m) * f.size))))
    const reach = D / n
    const ax = (b.x - a.x) / D, az = (b.z - a.z) / D
    for (let attempt = 0; attempt < LAY_TRIES; attempt++) {
      const out = []
      let prev = a
      let laid = true
      for (let k = 1; k <= n; k++) {
        let spot = b
        if (k < n) {
          const side = Math.sin((rand() * 2 - 1) * bout.turn) * reach
          const x = a.x + ax * reach * k - az * side
          const z = a.z + az * reach * k + ax * side
          const s = this.seat(x, z)
          if (s === null) { laid = false; break }
          spot = this._spot(f, x, z, s)
          spot.yaw = bearing(prev, spot)
        }
        out.push({ kind: 'hop', dur: between(rand, bout.dur), from: prev, to: spot, rise: Math.hypot(spot.x - prev.x, spot.z - prev.z) * HOP_RISE, bout })
        if (k < n) out.push({ kind: 'sit', dur: between(rand, spot.wet ? WET_PAUSE_S : bout.pause), at: spot })
        prev = spot
      }
      if (!laid) continue
      const total = out.reduce((sum, ph) => sum + ph.dur, 0)
      if (total > budget) for (const ph of out) ph.dur *= budget / total
      return out
    }
    return null
  }

  /** The phrases' start offsets, and the list returned. */
  static _starts(phrases) {
    let t = 0
    for (const ph of phrases) { ph.start = t; t += ph.dur }
    return phrases
  }

  /**
   * Segment `g` of frog `f`: from its post at the turn to its post at the
   * next, `{ g, start, a, b, phrases }`, the phrases a sit of SIT_S at `a`,
   * the bout laid between (_lay) and the sit that fills the segment at `b`,
   * each stamped with its start offset; a bout that cannot be laid is a sit
   * of the whole segment at `a`, and the turn puts the frog at `b`. Null once
   * home is stone. Rolled from the key and `g` alone, so the same on every
   * client.
   */
  _segment(f, g) {
    const a = f.seg !== null && f.seg.g === g - 1 ? f.seg.b : Frogs._facing(this._post(f, g - 1), this._post(f, g))
    const b = Frogs._facing(a, this._post(f, g + 1))
    if (a === null || b === null) return null
    const rand = phraseRand(f.key, g, 1)
    const hops = this._lay(f, rand, a, b, GRID_S - SIT_S[0])
    let phrases
    if (hops === null) {
      phrases = [{ kind: 'sit', dur: GRID_S, at: a }]
    } else {
      const bout = hops.reduce((sum, ph) => sum + ph.dur, 0)
      const sit = Math.min(between(rand, SIT_S), GRID_S - bout)
      phrases = [{ kind: 'sit', dur: sit, at: a }, ...hops, { kind: 'sit', dur: GRID_S - sit - bout, at: b }]
    }
    this.stats.segments++
    return { g, start: g * GRID_S + f.offset, a, b, phrases: Frogs._starts(phrases) }
  }

  /** The phrase of `phrases` playing `e` seconds in, the last one past the end. */
  static _phraseAt(phrases, e) {
    let i = phrases.length - 1
    while (i > 0 && phrases[i].start > e) i--
    return phrases[i]
  }

  /** Frog `f` posed `e` seconds into phrase `ph`: sitting at its spot, or on the parabola between a hop's two, turning from the one slope and heading to the other in the air. */
  _pose(f, ph, e) {
    f.ph = ph
    f.t = e
    if (ph.kind === 'sit') {
      const s = ph.at
      f.state = 'sit'
      f.x = s.x; f.y = s.y; f.z = s.z
      f.yaw = s.yaw
      f.nx = s.nx; f.ny = s.ny; f.nz = s.nz
      f.wet = s.wet
      f.u = 0
      return
    }
    const { from, to } = ph
    const u = Math.min(1, e / ph.dur)
    f.state = 'hop'
    f.u = u
    f.wet = false
    f.x = from.x + (to.x - from.x) * u
    f.z = from.z + (to.z - from.z) * u
    f.y = from.y + (to.y - from.y) * u + 4 * ph.rise * u * (1 - u)
    // Turning from the slope it left to the one it lands on, ready before touchdown; and from the hop's bearing to the way it lands facing.
    const v = Math.min(1, u * 1.5)
    _nrm.set(from.nx + (to.nx - from.nx) * v, from.ny + (to.ny - from.ny) * v, from.nz + (to.nz - from.nz) * v).normalize()
    f.nx = _nrm.x; f.ny = _nrm.y; f.nz = _nrm.z
    const head = Math.hypot(to.x - from.x, to.z - from.z) < 1e-9 ? to.yaw : bearing(from, to)
    f.yaw = head + Math.atan2(Math.sin(to.yaw - head), Math.cos(to.yaw - head)) * v
  }

  // --- the lure ---------------------------------------------------------------

  /**
   * The lure this frog is on this frame: the nearest of `lures` (hands.js
   * lures) it wants, noticed within LURE_M across the ground and kept to
   * LURE_FORGET_M -- or, for a peer's lure whose bed's lured set names this
   * frog, kept from LURE_M on. Noticing one takes the frog off its plan;
   * losing one starts its rejoin.
   */
  _notice(f, lures, now) {
    let lure = null
    let best = Infinity
    for (const l of lures) {
      if (!LURES.includes(l.kind) || (l.kind === 'hob' && now < f.calm)) continue
      const d = Math.hypot(l.x - f.x, l.z - f.z)
      if (d < best) { best = d; lure = l }
    }
    if (lure !== null) {
      const set = lure.by !== null ? this.luredIn.get(f.tile.key) : undefined
      const kept = f.lured || (set !== undefined && set.by === lure.by && set.has.has(f.index))
      if (best <= (kept ? LURE_FORGET_M : LURE_M)) {
        f.lure = lure
        if (!f.lured) { f.lured = true; this._startChase(f, now) }
        return
      }
    }
    if (!f.lured) return
    f.lured = false
    f.lure = null
    this._startRejoin(f, now)
  }

  /** Off the plan: the phrase playing goes on as the first live one, a sit cut to NOTICE_S at most, and the chase follows it. */
  _startChase(f, now) {
    if (f.live !== null) { f.live.queue = null; f.live.until = Infinity; return }
    const ph = f.ph
    const at = now - f.t
    const live = ph.kind === 'sit' ? { kind: 'sit', dur: Math.min(ph.dur, f.t + NOTICE_S), at: ph.at } : ph
    f.live = { ph: live, at, queue: null, until: Infinity }
  }

  /** The chase's next phrase after `prev`: after a hop the beat, after a sit a hop at the lure -- or across it, a quarter turn off either way, within ORBIT_M of it -- swung by up to CHASE.turn and landing on a seat, dry or wet; none of three found, the beat again. */
  _chaseNext(f, prev) {
    const spot = prev.kind === 'sit' ? prev.at : prev.to
    if (prev.kind === 'hop') return { kind: 'sit', dur: between(f.rand, CHASE.pause), at: spot }
    const l = f.lure
    let heading = bearing(spot, l)
    if (Math.hypot(l.x - spot.x, l.z - spot.z) < ORBIT_M) heading += (f.rand() < 0.5 ? 1 : -1) * (Math.PI / 2)
    const reach = between(f.rand, CHASE.m) * f.size
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = heading + (f.rand() - 0.5) * CHASE.turn
      const x = spot.x + Math.cos(a) * reach
      const z = spot.z - Math.sin(a) * reach
      const s = this.seat(x, z)
      if (s === null) {
        // Blocked that way: swing a quarter to three-quarters of a turn and try again.
        heading += (f.rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + f.rand() * Math.PI / 2)
        continue
      }
      const to = this._spot(f, x, z, s, a)
      return { kind: 'hop', dur: between(f.rand, CHASE.dur), from: spot, to, rise: reach * HOP_RISE, bout: CHASE }
    }
    return { kind: 'sit', dur: between(f.rand, CHASE.pause), at: spot }
  }

  /**
   * The lure lost: the phrase playing finishes (a sit ends now), and from
   * where it ends a bout is laid to the post of the first segment turn at
   * least REJOIN_MIN_S past that, the frog sitting there until the turn puts
   * it on its plan. No bout to be laid, it sits where it is until the turn.
   */
  _startRejoin(f, now) {
    const L = f.live
    if (L.ph.kind === 'sit') L.ph = { kind: 'sit', dur: now - L.at, at: L.ph.at }
    Object.assign(L, this._rejoin(f, L.ph.kind === 'sit' ? L.ph.at : L.ph.to, L.at + L.ph.dur))
  }

  /** The rejoin from spot `from` at second `end`: `{ queue, until }`, the bout to the post of the first turn REJOIN_MIN_S past it and the sit there to the turn. */
  _rejoin(f, from, end) {
    const g = Math.floor((end + REJOIN_MIN_S - f.offset) / GRID_S) + 1
    const turn = g * GRID_S + f.offset
    const post = Frogs._facing(this._post(f, g - 1), this._post(f, g))
    const hops = post === null ? null : this._lay(f, f.rand, from, post, turn - end)
    if (hops === null) return { queue: [{ kind: 'sit', dur: turn - end, at: from }], until: turn }
    const bout = hops.reduce((sum, ph) => sum + ph.dur, 0)
    return { queue: [...hops, { kind: 'sit', dur: turn - end - bout, at: post }], until: turn }
  }

  /** One frame off the plan: the live phrase advanced to `now`, the chase choosing each next phrase as the last ends and a rejoin playing its queue out; false once the queue is spent, the plan's again. */
  _live(f, now) {
    const L = f.live
    while (now >= L.at + L.ph.dur) {
      if (L.queue !== null) {
        if (L.queue.length === 0 || now >= L.until) { f.live = null; return false }
        L.at += L.ph.dur
        L.ph = L.queue.shift()
      } else {
        L.at += L.ph.dur
        L.ph = this._chaseNext(f, L.ph)
      }
    }
    this._pose(f, L.ph, now - L.at)
    return true
  }

  // --- caught -----------------------------------------------------------------

  /** Frogs chasing a hob on dry ground, uncaught, for the villagers to see and the hobs to run from: `{ key, tx, tz, index, x, y, z, hob }` onto `into`. */
  chasers(into) {
    for (const t of this.tiles.values()) {
      for (const f of t.frogs) if (f.lured && f.lure.kind === 'hob' && f.caught === null && !f.wet) into.push({ key: f.key, tx: t.tx, tz: t.tz, index: f.index, x: f.x, y: f.y, z: f.z, hob: f.lure.id })
    }
    return into
  }

  /** A spot on the ground under (x, z), not seated: where a frog let go in the air lands. */
  _groundSpot(f, x, z, yaw) {
    const h = this.height.heightAt(x, z)
    return { x, z, h, y: this._groundFor(x, z, h), wet: false, level: null, nx: 0, ny: 1, nz: 0, yaw }
  }

  /** The villager's hold `cl` on frog `f` this frame (undefined: none), after its plan has posed it: taken off the plan to sit where it was seen, posed in the fist, thrown, or let go. */
  _caught(f, cl, now) {
    if (cl === undefined) {
      if (f.caught === 'wait') this._startRejoin(f, now)
      else if (f.caught === 'held') {
        const from = this._groundSpot(f, f.x, f.z, f.yaw)
        const r = this._rejoin(f, from, now + FREEZE_HOP_S)
        f.live = { ph: { kind: 'hop', dur: FREEZE_HOP_S, from: { ...from, y: f.y }, to: from, rise: 0, bout: CHASE }, at: now, queue: r.queue, until: r.until }
      }
      f.caught = null
      f.calm = now + CALM_S
      return
    }
    if (cl.phase === 'wait' && f.caught === null) {
      f.lured = false
      f.lure = null
      const here = f.ph.kind === 'sit' ? f.ph.at : f.ph.to
      const s = this.seat(cl.x, cl.z)
      const spot = s === null || s.wet ? here : this._spot(f, cl.x, cl.z, s, Math.hypot(cl.x - here.x, cl.z - here.z) < 1e-3 ? here.yaw : bearing(here, cl))
      const stay = { kind: 'sit', dur: Infinity, at: spot }
      const ph = f.ph.kind === 'sit' ? { kind: 'sit', dur: f.t, at: here } : f.ph
      const queue = spot === here ? [stay] : [{ kind: 'hop', dur: FREEZE_HOP_S, from: here, to: spot, rise: Math.hypot(spot.x - here.x, spot.z - here.z) * HOP_RISE, bout: CHASE }, stay]
      f.live = { ph, at: now - f.t, queue, until: Infinity }
    } else if (cl.phase === 'held') {
      // Dangling from the fist by its back, nose up and belly out.
      f.state = 'held'
      f.x = cl.x; f.y = cl.y - f.size * 0.6; f.z = cl.z
      f.yaw = cl.heading
      _nrm.set(-Math.cos(cl.heading), 0.45, Math.sin(cl.heading)).normalize()
      f.nx = _nrm.x; f.ny = _nrm.y; f.nz = _nrm.z
      f.u = 0.5
      f.wet = false
    } else if (cl.phase === 'thrown' && f.caught !== 'thrown') {
      this._throw(f, cl, now)
    }
    f.caught = cl.phase
  }

  /** Out of the fist at `cl.from` on the release second, one hop onto the water toward `cl.to` (nearer where that is not water), a float, and the rejoin. */
  _throw(f, cl, now) {
    const t0 = Math.min(cl.t0, now)
    const from = { x: cl.from.x, y: cl.from.y, z: cl.from.z, h: cl.from.y, wet: false, level: null, nx: 0, ny: 1, nz: 0, yaw: cl.heading }
    let to = null
    for (const k of [1, 0.8, 0.6, 0.4]) {
      const x = from.x + (cl.to.x - from.x) * k, z = from.z + (cl.to.z - from.z) * k
      const s = this.seat(x, z)
      if (s !== null && s.wet) { to = this._spot(f, x, z, s, cl.heading); break }
    }
    to ??= this._groundSpot(f, cl.to.x, cl.to.z, cl.heading)
    const float = { kind: 'sit', dur: between(f.rand, WET_PAUSE_S), at: to }
    const r = this._rejoin(f, to, t0 + THROW_S + float.dur)
    f.live = { ph: { kind: 'hop', dur: THROW_S, from, to, rise: THROW_RISE, bout: LEAP }, at: t0, queue: [float, ...r.queue], until: r.until }
    this._live(f, now)
  }

  // --- the room ---------------------------------------------------------------

  /** The lured sets owed since the last call, pushed onto `into` (creature-net.js): `[bedKey, 'fg', null, indices]`, one a bed. */
  pendingLured(into = []) {
    for (const set of this.owed) into.push(set)
    this.owed.length = 0
    return into
  }

  /** A peer's lured set for one of the beds: the frogs its hand has, kept from LURE_M on while that hand's lure is near them. */
  applyLured(set) {
    if (!Array.isArray(set) || set.length !== 4 || typeof set[0] !== 'string' || !Array.isArray(set[3])) throw new Error(`Frogs.applyLured: bad set ${JSON.stringify(set)}`)
    if (set[3].length === 0) this.luredIn.delete(set[0])
    else this.luredIn.set(set[0], { by: set[2], has: new Set(set[3]) })
  }

  /** Bed `t`'s lured set owed when the frogs her own hand has changed since the last sent and LURED_EVERY_S has passed, or when they are none now and were not. */
  _owe(t, now) {
    let mine = ''
    for (const f of t.frogs) if (f.lured && f.lure.by === null) mine += `${f.index},`
    if (mine === t.luredSent) return
    if (mine !== '' && now - t.luredAt < LURED_EVERY_S) return
    t.luredSent = mine
    t.luredAt = now
    this.owed.push([t.key, 'fg', null, mine === '' ? [] : mine.slice(0, -1).split(',').map(Number)])
  }

  /** The one-shots since the last call, each `{ sound, rule, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
    return into
  }

  /** What frog `f` did going from phrase `prev` to the one it is posed on: a hop begun, or a hop off dry ground that came down in the water. */
  _heard(f, prev, hx, hy, hz) {
    if (prev === null || f.ph === prev || Math.hypot(f.x - hx, f.y - hy, f.z - hz) > HEAR_M) return
    if (prev.kind === 'hop' && prev.to.wet && !prev.from.wet) this.calls.push({ sound: 'splash', rule: 'splash', x: prev.to.x, y: prev.to.level, z: prev.to.z })
    if (f.ph.kind === 'hop') this.calls.push({ sound: 'frogBoing', rule: 'frogHop', x: f.x, y: f.y, z: f.z })
  }

  /** `now` the room's clock in seconds; `lures`: hands.js lures() this frame and the hobs', the spiders, butterflies, grasshoppers and hobs among them chased; `claims` the villagers' holds on frogs by key. */
  update(hx, hy, hz, now, lures = NO_LURES, claims = NO_CLAIMS) {
    if (!Number.isFinite(now)) throw new Error(`Frogs.update: bad time ${now}`)
    this.head.x = hx
    this.head.z = hz
    this.now = now
    this.calls.length = 0
    if (Math.hypot(hx - this.walkedX, hz - this.walkedZ) > WALK_M) {
      walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
      this.walkedX = hx
      this.walkedZ = hz
    }
    if (this.ground && this.ground.groundVersion !== this.gver) {
      this.gver = this.ground.groundVersion
      this._reseat()
    }

    // The tint row (critters.js): each tier's mesh onto its flat colour, or all of them back onto the one shared material.
    if (this.tinted !== tierTintOn()) {
      this.tinted = tierTintOn()
      this.tiers.forEach((m, k) => { m.material = this.tinted ? TIER_TINTS[k] : this.material })
    }

    const breath = (now * Math.PI * 2) / BREATH_S
    const bob = (now * Math.PI * 2) / BOB_S
    const counts = this.tiers.map(() => 0)
    for (const t of this.tiles.values()) {
      // Backwards, because a frog whose home has turned to stone leaves the list mid-walk.
      for (let i = t.frogs.length - 1; i >= 0; i--) {
        const f = t.frogs[i]
        if (f.seg === null || now < f.seg.start || now >= f.seg.start + GRID_S) {
          const seg = this._segment(f, Math.floor((now - f.offset) / GRID_S))
          if (seg === null) { this._drop(f); continue }
          f.seg = seg
        }
        // Posed first, so a lure is measured from where the frog is, on its plan or off it; a lure noticed or lost this frame changes what plays from the next.
        const prev = f.ph
        if (f.live === null || !this._live(f, now)) {
          const ph = Frogs._phraseAt(f.seg.phrases, now - f.seg.start)
          this._pose(f, ph, now - f.seg.start - ph.start)
        }
        const claim = claims.get(f.key)
        if (claim !== undefined || f.caught !== null) this._caught(f, claim, now)
        this._heard(f, prev, hx, hy, hz)
        if (f.caught === null) this._notice(f, lures, now)
        let sy = 1
        let sx = 1
        let sz = 1
        // The surface's bob, ridden while afloat.
        let lift = 0
        if (f.state === 'sit') {
          if (f.wet) {
            lift = BOB_AMP * Math.sin(bob + f.breath)
          } else {
            // The breath: a swell that is mostly height, a little girth.
            const s = BREATH_AMP * (0.5 + 0.5 * Math.sin(breath + f.breath))
            sy = 1 + s
            sx = sz = 1 + s * 0.4
          }
        } else {
          // Stretched along the leap in the air, flattened a little on landing.
          const s = Math.sin(Math.PI * f.u)
          sx = 1 + 0.25 * s
          sy = 1 - 0.15 * s
        }
        // The tier its apparent size calls for; past the ladder's foot it is not drawn.
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
      this._owe(t, now)
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
    this.stats.alive = MAX - this.free.length
    this.stats.tiles = this.tiles.size
    this.stats.overflow = this.overflow
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const tier of this.tiers) tier.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
