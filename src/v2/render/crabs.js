// ---------------------------------------------------------------------------
// Crabs: the Tripo shore crab, crawling on the boulders that stand in and beside
// the lakes -- and on NOTHING ELSE. A crab never touches the terrain: every
// spot it stands on is a point over stone inside its own rock's disc
// (Rocks.blockTopAt, unsettled), and the line it crosses between two of them
// rides whatever stone is under it. Only one she has let go of runs on the
// ground, and that one is running away.
//
// THE ROCKS ARE THE SCATTER. Each 16 m tile around her asks Rocks.perchesInto
// for the perch beds' rocks with their origin in the tile, and each perch
// qualifies by the lake: underwater at its origin (WaterSurfaces.lakeLevelAt over
// the field height) or within SHORE_M of a lake shore on dry ground (lakeShoreDistAt).
// Rivers do not count; a stream bank is not a crab's shore. How many crabs a
// perch carries and how big they are comes from the perch's own position, so a
// rock has the same crabs every visit. DEPTH IS SIZE: a crab under eight metres
// of water is DEEP_MUL times the one on the beach, but never more than
// ROCK_FRACTION of its rock's size (or SIZE_M[0], whichever is more); the rock is never under a metre.
//
// The rocks arrive over frames after a move, so a tile scanned before its
// boulders exist would stay empty; every tile is rescanned in turn, one per
// RESCAN_FRAMES, and a rescan adds the perches it has not seen without
// disturbing the crabs it has. THE STONE MOVES TOO: a rock is seated on the
// drawn terrain and re-seated when the chunk under it re-splits
// (Rocks._reground), by tens of centimetres where a far 2 m chunk becomes a
// near 0.5 m one, and a pausing crab's matrix is held rather than recomposed,
// so it would never follow the rock. So every crab re-reads its stone once per
// RESEAT_EVERY frames.
//
// EVERYTHING A CRAB DOES IS A PURE FUNCTION OF ITS KEY AND THE ROOM'S CLOCK
// (_notes/creature-sync.md), so two clients standing on the same shore watch
// the same crab cross the same stone at the same moment and the only thing
// ever sent is a release: the second and the spot a hand let one go at, which
// no client can derive (creature-net.js, mode DROP).
// Its life is cut into SPELLs of SPELL_S seconds on its own grid (sim/score.js,
// offset by its key's hash so a shoal of rocks does not turn over at once), and
// every spell runs from one SPOT to the next: a point over stone inside its own
// rock's disc rolled from the key and the spell index alone. It SITS at the
// first spot, SCUTTLES the line between them at a pace rolled with the spell,
// then sits out the rest at the second -- so every spell ends on the next
// one's first spot, and a client meeting a crab mid-spell plans that spell
// alone and lands on the same poses as one that has watched all along.
// Nothing is integrated: the frame's length does not enter into it. The one
// term that is not shared is the seat HEIGHT, which is the drawn rock's top
// and so moves with each client's own LOD by tens of centimetres; where a crab
// is on its rock, and when, is the same everywhere.
//
// The mesh faces +X with its claws and is broad along Z; a crab scuttles
// sideways, along its own ±Z, and rides the stone's slope (a finite-difference
// normal off the same surface query). The legs -- the parts of the mesh out past
// the body along Z and below its middle -- lift and fall in the vertex shader
// while it moves.
//
// Past CARD_M from her head a crab is its cross card (critters.js) -- its side
// and its top, since a crab is seen clinging to a rock from above -- written to
// the card mesh under the same matrix and hue the body would have had, legs
// still; once the card's picture is baked, the two meshes together hold every
// live crab.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { keyHash, phraseRand } from '../../sim/score.js'
import { DROP, dropWire, snap } from '../creature-net.js'
import {
  CARD_M, CRAB_VIEWS, CRITTER_GLB, bakeCritterCard, createCritterCardMaterial, glint, hueVary, loadCritterGlb, makeHueAttribute,
  setCritterAsset, setCritterCard, tierTintSplice, tileKey, walkTiles,
} from './critters.js'
import { PERCH_STRIDE } from './rocks.js'
import { taken, TOLERANCE_M } from '../taken.js'

export const TILE = 16
export const RADIUS = 40
// How far from a lake's waterline a dry perch may stand.
export const SHORE_M = 5
// A rock under this (metres, its longest extent) is not a perch; the same measure blockTopAt screens on, so a crab's every step stays on metre-plus stone.
export const PERCH_MIN = 1
// Body span in metres at the surface, times up to DEEP_MUL at DEEP_M of water, capped at ROCK_FRACTION of the rock's size -- but never under SIZE_M[0], so a metre of rock carries the smallest crab at nearly a third of its size.
export const SIZE_M = [0.3, 0.5]
export const DEEP_M = 8
export const DEEP_MUL = 2.5
export const ROCK_FRACTION = 0.2
// Crabs per perch: PER_PERCH * (1 + rand * min(PERCH_CAP, r^2)), r the hull radius, rounded at random so a half is a crab on every other rock; a two-metre stone has none or one and a shed-sized one a couple.
export const PER_PERCH = 0.5
const PERCH_CAP = 7
export const MAX = 160
// Wet shell: the one roughness the whole crab glints at (critters.js's glint), set by eye near the mean of the Tripo map it replaces.
export const WET_ROUGHNESS = 0.7
// A crab's hue: a turn of up to HUE radians either way round the colour wheel (critters.js hueVary), so a rock's crabs run from olive through the shipped brown to red.
export const HUE = 0.6
// A perch buffer this size covers a 16 m tile of the densest shore.
const PERCH_BUF = 64
// A crab's life is cut into spells this long on its own grid, each a sit at one spot on its rock and a scuttle to the next. It sits still most of the time: the sit takes PAUSE_S of what the spell has to spare, and the scuttle's pace is a draw from `SPEED` body spans per second, the draw squared so most are a slow, leisurely crawl and a few a dash, and never so brisk that it crosses in under MIN_GO_S.
export const SPELL_S = 32
export const PAUSE_S = [6, 30]
export const SPEED = [0.08, 1.2]
const MIN_GO_S = 0.5
// Tries for a point over stone inside a perch's disc, at the roll and at every spell's turn; the disc is circumscribed, so its corners are air.
const POST_TRIES = 8
// Drawn STRETCH_Y taller than the mesh (which is squashed flat), and sunk SINK of its height into the stone along the normal, so the legs grip the surface instead of tiptoeing on it.
export const STRETCH_Y = 1.25
export const SINK = 0.2
// Frames between a crab's re-reads of its stone's height (see the header), and per tile rescan.
export const RESEAT_EVERY = 8
const RESCAN_FRAMES = 4
// The normal is read from the surface NORMAL_SPAN of the crab's span either side of it; two sides whose rises differ by more than LIP of that are a lip, not a slope (see _slope).
const NORMAL_SPAN = 0.25
const LIP = 2
// The leg wiggle: amplitude in unit-mesh metres, and the wave's cadence in cycles per span travelled.
const LEG_AMP = 0.04
const LEG_CYCLES = 1.5

// A crab she let go of: it scuttles away from the drop over the ground at LOOSE_SPEED sizes a second in LOOSE_LEGS legs a spell -- a second each, so it jinks about once a second -- each leg's line swung off the outward one by up to LOOSE_WOBBLE radians, until it is RADIUS from where it was let go and forgotten. The drop, not her head, is what it runs from: her head is a different point on every client.
export const LOOSE_SPEED = 1.5
const LOOSE_LEGS = 32
const LOOSE_WOBBLE = 1.2

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _n = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _yawQ = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

// A perch's identity and its seed come from its quantised origin: the same rock, the same crabs.
const perchKey = (x, z) => Math.round(x * 8) * 0x100000 + Math.round(z * 8)
// The room's key for a crab: its rock, quantised as perchKey is, and its place in the rock's roll. A rolled crab sends nothing -- its whole life is closed form -- and the one thing that goes on the wire under the `cb` prefix is a release.
export const bedKey = (px, pz) => `cb:${Math.round(px * 8)},${Math.round(pz * 8)}`
export const keyOf = (px, pz, k) => `${bedKey(px, pz)}:${k}`
// The key of one let go at (x, z) heading `yaw` rather than rolled by a rock: the drop to the centimetre and the heading to the milliradian, so a peer told the same release plans the same run.
export const dropKey = (x, z, yaw) => `cb@${x.toFixed(2)},${z.toFixed(2)},${Math.round(yaw * 1000)}`
// The crabs' prefix in the room's creature keys (creature-net.js): a release is all they send.
export const PREFIX = 'cb'
function perchSeed(x, z, seed) {
  const qx = Math.round(x * 8) | 0
  const qz = Math.round(z * 8) | 0
  let h = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qz, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

export class Crabs {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt
   * @param water   WaterSurfaces: lakeLevelAt, lakeShoreDistAt
   * @param opts.rocks   Rocks: perchesInto and blockTopAt(x, z, min, false)
   * @param opts.assets  a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, rocks, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function') {
      throw new Error('Crabs needs a height field with heightAt and heightAndSlopeAt')
    }
    if (!water || typeof water.lakeLevelAt !== 'function' || typeof water.lakeShoreDistAt !== 'function') {
      throw new Error('Crabs needs WaterSurfaces, for lakeLevelAt and lakeShoreDistAt')
    }
    if (!rocks || typeof rocks.perchesInto !== 'function' || typeof rocks.blockTopAt !== 'function') {
      throw new Error('Crabs needs Rocks, for perchesInto and blockTopAt')
    }
    this.height = height
    this.water = water
    this.rocks = rocks
    this.seed = seed

    // A wet shell glints: critters.js's glint.
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: WET_ROUGHNESS, metalness: 0 })
    // `aLegs` is per instance: the wave's phase and its amplitude (zero at rest). Weighted onto the parts of the unit mesh that are legs -- out past the body along Z and low -- so the shell holds still.
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aLegs;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            'float legW = smoothstep( 0.18, 0.36, abs( position.z ) ) * ( 1.0 - smoothstep( 0.08, 0.22, position.y ) );\n' +
            'transformed.y += legW * aLegs.y * sin( aLegs.x + 12.0 * position.x + sign( position.z ) * 1.5708 );'
        )
      glint(shader)
      hueVary(shader)
      tierTintSplice(shader, 0)
    }
    this.material.customProgramCacheKey = () => 'crabs'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    this.mesh.name = 'v2-crabs'
    this.mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.legs = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2)
    this.legs.setUsage(THREE.DynamicDrawUsage)
    this.mesh.geometry.setAttribute('aLegs', this.legs)
    this.hue = makeHueAttribute(this.mesh, MAX)
    // The far crabs, as cards; hidden until the picture is baked, and until then every crab is the mesh.
    this.cardMaterial = createCritterCardMaterial('crabs')
    this.card = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.cardMaterial, MAX)
    this.card.name = 'v2-crabs-card'
    this.card.count = 0
    this.card.visible = false
    this.card.frustumCulled = false
    this.card.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cardHue = makeHueAttribute(this.card, MAX)
    // The layer toggle flips the group, so it cannot unhide the mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-crabs'
    this.batch.add(this.mesh, this.card)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, perch: null,
        // Its key in the room, its grid's offset into SPELL_S, and the world second its grid starts from -- zero for a rolled crab, the drop for a loose one, so a released crab's first spell opens where her hand let it go.
        key: '', offset: 0, epoch: 0,
        // The spot the rock's own roll gave it, which every spell falls back to, and the heading rolled with it.
        seatX: 0, seatZ: 0, seatYaw: 0,
        x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, yaw: 0, side: 1, size: 0.3, hue: 0, speed: 0,
        // The spell planned (_spell), the phrase of it playing -- 'pause' at a spot, 'go' from one spot to another -- and how far into that phrase the pose is. `phase` drives the legs and `amp` is their swing.
        spell: null, phrase: null, elapsed: 0, state: 'pause', phase: 0, amp: 0, depth: 0,
        // The composed instance matrix, rebuilt only while `stale`; a pausing crab copies it.
        m: new Float32Array(16), stale: true,
        // Which of its perch's rolled crabs it is, for the taken registry; and, for one she let go of, the drop it runs from -- off any perch, on no rock.
        member: 0, loose: false, drop: null,
      })
    }
    this.free = this.slots.slice()
    this.loose = []
    // The releases owed to the room (pending), and the drop key of every release made here, hers or a peer's, so one heard twice lets one crab go.
    this.outbox = []
    this.drops = new Set()
    // Set while a peer's release is being made here: it is theirs, and is not owed back to the room.
    this.applying = false
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    // The world second the last update posed the crabs at, so place() and release() can seat one without being told it twice.
    this.now = 0
    this.spells = 0
    this.head = { x: 0, z: 0 }
    // Whether the last update stepped the crabs under the water too (she was submerged).
    this.under = true
    this.perchBuf = new Float32Array(PERCH_BUF * PERCH_STRIDE)
    // The baked mesh's bounds (setCritterAsset), its unit span and its unit height; the instance scale is size / span.
    this.bounds = null
    this.span = 1
    this.bodyH = 0
    this.loaded = false
    // Perch crabs that found no free slot, and perches whose tile buffer was full.
    this.overflow = 0
    this.saturated = 0

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadCritterGlb(CRITTER_GLB.crab))
    return true
  }

  setAsset(asset) {
    this.bounds = setCritterAsset(this.mesh, this.material, asset, 'crabs')
    this.span = this.bounds.span
    this.bodyH = this.bounds.height
    setCritterCard(this.card, this.bounds, CRAB_VIEWS)
    this.loaded = true
  }

  /** Photograph the loaded crab onto its card and start drawing the far crabs as cards. Once, after `ready`. */
  bakeCard(renderer) {
    if (!this.loaded) throw new Error('Crabs.bakeCard: the asset has not landed')
    this.setCard(bakeCritterCard(renderer, this.mesh.geometry, this.material.map, this.bounds, CRAB_VIEWS))
  }

  setCard(map) {
    if (map) {
      this.cardMaterial.map = map
      this.cardMaterial.needsUpdate = true
    }
    this.card.visible = true
  }

  /** The stone surface a crab may stand on at (x, z), or -Infinity: stone of perch size, proud of the terrain. */
  stoneAt(x, z) {
    const top = this.rocks.blockTopAt(x, z, PERCH_MIN, false)
    if (top === -Infinity) return top
    return top > this.height.heightAt(x, z) + 0.02 ? top : -Infinity
  }

  /** Whether a perch at (x, z) is a crab's: { depth, level } -- how deep the lake is over it and its surface, or depth 0 and level -Infinity on a dry shore perch -- or null. */
  qualify(x, z) {
    const { h, tan } = this.height.heightAndSlopeAt(x, z)
    const level = this.water.lakeLevelAt(x, z)
    if (level !== null && level > h) return { depth: level - h, level }
    if (this.water.lakeShoreDistAt(x, z, SHORE_M, h, tan) < SHORE_M) return { depth: 0, level: -Infinity }
    return null
  }

  _enter(tx, tz) {
    // `live` counts the crabs seated in the tile, so a tile of bare perches is skipped whole each frame.
    const t = { tx, tz, perches: new Map(), live: 0 }
    this._scan(t)
    return t
  }

  /** Add every perch in the tile this tile has not seen. Idempotent, so a rescan costs nothing new. */
  _scan(t) {
    const x0 = t.tx * TILE
    const z0 = t.tz * TILE
    const buf = this.perchBuf
    const n = this.rocks.perchesInto(x0, z0, x0 + TILE, z0 + TILE, buf)
    if (n === PERCH_BUF) this.saturated++
    for (let i = 0; i < n; i++) {
      const o = i * PERCH_STRIDE
      const px = buf[o]
      const pz = buf[o + 2]
      const r = buf[o + 3]
      const rockSize = buf[o + 4]
      const key = perchKey(px, pz)
      if (t.perches.has(key)) continue
      const perch = { x: px, z: pz, r, level: -Infinity, crabs: [] }
      t.perches.set(key, perch)
      // The rock as a whole must be a perch, not just the stone under one step.
      if (rockSize < PERCH_MIN) continue
      const site = this.qualify(px, pz)
      if (site === null) continue
      const { depth, level } = site
      perch.level = level
      const rand = mulberry32(perchSeed(px, pz, this.seed))
      const want = PER_PERCH * (1 + rand() * Math.min(PERCH_CAP, r * r))
      const count = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
      const mul = 1 + (DEEP_MUL - 1) * Math.min(1, depth / DEEP_M)
      const cap = Math.max(SIZE_M[0], ROCK_FRACTION * rockSize)
      for (let k = 0; k < count; k++) {
        const size = Math.min(between(rand, SIZE_M) * mul, cap)
        const yaw = rand() * Math.PI * 2
        const hue = (rand() * 2 - 1) * HUE
        // Up to eight tries for a point over stone inside the hull's disc; the disc is circumscribed, so its corners are air.
        let x = 0, z = 0, y = -Infinity
        for (let a = 0; a < 8 && y === -Infinity; a++) {
          const ang = rand() * Math.PI * 2
          const d = Math.sqrt(rand()) * r * 0.85
          x = px + Math.cos(ang) * d
          z = pz + Math.sin(ang) * d
          y = this.stoneAt(x, z)
        }
        if (y === -Infinity) continue
        const c = this.free.pop()
        if (!c) { this.overflow++; continue }
        const side = rand() < 0.5 ? -1 : 1
        // After every roll of the perch's stream, so one she took leaves the rest of the perch as it grew.
        if (taken.has(`crab${k}`, px, pz)) { this.free.push(c); continue }
        c.perch = perch
        c.member = k
        c.loose = false
        c.drop = null
        c.key = keyOf(px, pz, k)
        c.offset = keyHash(c.key) % SPELL_S
        c.epoch = 0
        c.seatX = x; c.seatZ = z; c.seatYaw = yaw
        c.side = side
        c.size = size
        c.hue = hue
        c.depth = depth
        c.spell = null
        c.phrase = null
        c.state = 'pause'
        c.speed = 0
        c.phase = 0
        c.amp = 0
        c.stale = true
        this._seat(c, x, y, z, yaw)
        perch.crabs.push(c)
        t.live++
      }
    }
  }

  _leave(t) {
    for (const p of t.perches.values()) {
      for (const c of p.crabs) {
        c.perch = null
        this.free.push(c)
      }
      p.crabs.length = 0
    }
    t.perches.clear()
    t.live = 0
  }

  /** Rebuild every tile around (cx, cz) at world second `now`. Boot, and whenever the ground moves under her. */
  place(cx, cz, now = this.now) {
    if (!Number.isFinite(now)) throw new Error(`Crabs.place: bad world time ${now}`)
    this.now = now
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    for (const c of this.loose) { c.loose = false; c.drop = null; this.free.push(c) }
    this.loose.length = 0
    // The rescan queue holds tile objects; the ones just left must not be scanned, or their crabs would be seated in a tile nothing draws and never freed.
    this.rescan = []
    this.overflow = 0
    this.saturated = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    let perches = 0
    for (const t of this.tiles.values()) perches += t.perches.size
    return { alive: MAX - this.free.length, tiles: this.tiles.size, perches, loose: this.loose.length, spells: this.spells, overflow: this.overflow, saturated: this.saturated }
  }

  /**
   * Every crab stepped this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size and speed on them, `speed > 0` meaning it is
   * scuttling. A hidden layer is frozen and lists nothing, and while she is
   * above the water the crabs under it are not stepped and not listed.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const t of this.tiles.values()) {
      for (const p of t.perches.values()) {
        for (const c of p.crabs) if (this.under || c.y >= p.level) into.push(c)
      }
    }
    for (const c of this.loose) into.push(c)
    return into
  }

  /**
   * The drawn crab nearest a hand at (x, y, z) whose body -- a ball of its own
   * size -- is within `reach` metres, and smaller than `maxSize`: `{ dist, c,
   * size }` for take(), or null. A crab under its lake is not drawn while her
   * head is out of the water, and is not offered. For hands.js.
   */
  pickAt(x, y, z, reach, maxSize) {
    if (!this.batch.visible) return null
    let best = null
    let bestD = reach
    const consider = (c) => {
      if (c.size >= maxSize) return
      const d = Math.hypot(c.x - x, c.y - y, c.z - z) - c.size * 0.5
      if (d < bestD) {
        bestD = d
        best = { dist: Math.max(0, d), c, size: c.size }
      }
    }
    for (const t of this.tiles.values()) {
      if (t.live === 0) continue
      for (const p of t.perches.values()) {
        for (const c of p.crabs) if (this.under || c.y >= p.level) consider(c)
      }
    }
    for (const c of this.loose) consider(c)
    return best
  }

  /**
   * Take the crab of a pickAt() hit off its stone: its slot goes back to the
   * pool, its place on its perch is recorded so the perch never regrows it,
   * and what the hand holds is returned as a record for hands.js -- the
   * shared geometry and material, the legs at rest, its hue, its scale. Only
   * a crab under `stowMax` metres may go in the backpack.
   */
  take(hit, stowMax) {
    const c = hit.c
    if (c.loose) {
      const i = this.loose.indexOf(c)
      if (i < 0) throw new Error(`Crabs.take: loose slot ${c.id} is not in the loose list`)
      this.loose.splice(i, 1)
      c.loose = false
      c.drop = null
    } else {
      const perch = c.perch
      if (!perch) throw new Error(`Crabs.take: slot ${c.id} has no perch`)
      const i = perch.crabs.indexOf(c)
      if (i < 0) throw new Error(`Crabs.take: slot ${c.id} is not on its perch`)
      taken.add(`crab${c.member}`, perch.x, perch.z)
      perch.crabs.splice(i, 1)
      c.perch = null
      for (const t of this.tiles.values()) if (t.perches.get(perchKey(perch.x, perch.z)) === perch) { t.live--; break }
    }
    this.free.push(c)
    const k = c.size / this.span
    return {
      kind: 'crab',
      name: 'crab',
      size: c.size,
      geometry: this.mesh.geometry,
      material: this.material,
      attrs: { aLegs: [c.phase, 0], aHue: [c.hue] },
      color: null,
      scale: [k, k * STRETCH_Y, k],
      stowable: c.size < stowMax,
    }
  }

  /**
   * A peer took the crab named by `crab<member>` off the perch at (x, z): take
   * it here too, drawn or not, and record the place. True when a resident
   * tile has that perch with that member; a loose crab is nobody's to evict.
   * For hands-net.js.
   */
  evict(key, x, z) {
    if (!key.startsWith('crab')) return false
    for (const t of this.tiles.values()) {
      for (const p of t.perches.values()) {
        if (Math.abs(p.x - x) >= TOLERANCE_M || Math.abs(p.z - z) >= TOLERANCE_M) continue
        for (const c of p.crabs) {
          if (`crab${c.member}` !== key) continue
          this.take({ dist: 0, c, size: c.size }, Infinity)
          return true
        }
      }
    }
    return false
  }

  /** The geometry and material a packed crab record is drawn with, or null until the asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'crab') throw new Error(`Crabs.dress: not a crab, ${slot.kind}`)
    if (!this.loaded) return null
    return { geometry: this.mesh.geometry, material: this.material }
  }

  /**
   * Let a taken crab go at (x, _, z): it lands on whatever is under it there,
   * stone or ground, and scuttles away from the drop until it is RADIUS out.
   * False only when the pool is empty, and hands.js drops it as a thing.
   *
   * Its key is the drop point to the centimetre and the heading her hand gave
   * it, and its grid opens on the second it was let go, so two clients told
   * the same release watch it run the same way. The drop is owed to the room
   * (pending), which is the only way the other client is told of it at all.
   */
  release(rec, x, y, z, head, now = this.now) {
    if (rec.kind !== 'crab') throw new Error(`Crabs.release: not a crab, ${rec.kind}`)
    x = snap(x); y = snap(y); z = snap(z)
    const hx = snap(head.x), hz = snap(head.z)
    const c = this.free.pop()
    if (!c) { this.overflow++; return false }
    const yaw = Math.atan2(x - hx, z - hz)
    c.perch = null
    c.loose = true
    c.member = -1
    c.key = dropKey(x, z, yaw)
    c.offset = keyHash(c.key) % SPELL_S
    c.epoch = now - c.offset
    c.drop = { x, z, yaw }
    c.size = rec.size
    c.hue = rec.attrs.aHue[0]
    c.side = 1
    c.depth = 0
    c.spell = null
    c.phrase = null
    c.state = 'go'
    c.speed = LOOSE_SPEED
    c.phase = 0
    c.amp = LEG_AMP
    c.stale = true
    this._play(c, now)
    this.loose.push(c)
    this._owe(c.key, now, x, y, z, yaw, hx, hz, c.size, c.hue)
    return true
  }

  /** A crab let go here goes to the room as one anchor in mode DROP; one heard from the room is only remembered, so it is not sent back. */
  _owe(key, T, x, y, z, yaw, hx, hz, size, hue) {
    this.drops.add(key)
    if (this.applying) return
    this.outbox.push([dropWire(PREFIX, key), T, x, y, z, yaw, 0, DROP, null, hx, hz, size, hue])
  }

  /** The releases this client owes the room since the last call, moved into `into`. For creature-net.js. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /**
   * A crab a peer let go: released here at the spot and the second their hand
   * did, dressed as theirs is, so both watch the one crab run the one way. A
   * drop already made here -- this client's own, come back on a fresh welcome
   * -- is nothing. Where no tile is resident it is refused, and this client
   * never sees that crab. For creature-net.js.
   */
  apply(anchor, now) {
    const [, T, x, y, z, yaw, , mode, by, hx, hz, size, hue] = anchor
    if (by === null) return
    if (mode !== DROP) throw new Error(`Crabs: no anchor mode ${mode}`)
    if (![T, x, y, z, yaw, hx, hz, size, hue].every(Number.isFinite)) throw new Error(`Crabs: a drop short of its numbers: ${JSON.stringify(anchor)}`)
    if (this.drops.has(dropKey(x, z, yaw))) return
    this.applying = true
    try {
      this.release({ kind: 'crab', size, attrs: { aHue: [hue] } }, x, y, z, { x: hx, y, z: hz }, T)
    } finally {
      this.applying = false
    }
  }

  /** A spot on the ground at (x, z): stone where a rock stands proud, else the field, with the surface's normal there. */
  _looseSpot(c, x, z, yaw) {
    const { h, gx, gz } = this.height.heightAndSlopeAt(x, z)
    const top = this.stoneAt(x, z)
    if (top > h) return { x, y: top, z, yaw, stone: true }
    _n.set(-gx, 1, -gz).normalize()
    return { x, y: h, z, yaw, stone: false, nx: _n.x, ny: _n.y, nz: _n.z }
  }

  /**
   * The stone's normal under a crab, from the surface NORMAL_SPAN either side of
   * it along X and Z. Where the two sides of an axis disagree -- one falls off
   * the stone, or the crab stands at the lip of a drop -- the side whose surface
   * runs on from the crab's own seat is used alone, so a crab at the top of a
   * face stands on the top and a crab on the face clings to it. Straight up
   * only where the stone is gone on both sides.
   */
  _normal(c, onStone = true) {
    // Off the rocks -- a crab she let go of, running over the ground -- the field's own slope is the surface.
    if (!onStone) {
      const { gx, gz } = this.height.heightAndSlopeAt(c.x, c.z)
      _n.set(-gx, 1, -gz).normalize()
      c.nx = _n.x; c.ny = _n.y; c.nz = _n.z
      return
    }
    const e = c.size * NORMAL_SPAN
    const sx = this._slope(this.stoneAt(c.x - e, c.z), c.y, this.stoneAt(c.x + e, c.z), e)
    const sz = this._slope(this.stoneAt(c.x, c.z - e), c.y, this.stoneAt(c.x, c.z + e), e)
    _n.set(-sx, 1, -sz).normalize()
    c.nx = _n.x; c.ny = _n.y; c.nz = _n.z
  }

  /** Seat `c` at (x, y, z) facing `yaw`, on the normal of whatever it stands on there. */
  _seat(c, x, y, z, yaw, onStone = true) {
    c.x = x; c.y = y; c.z = z
    c.yaw = yaw
    this._normal(c, onStone)
    c.stale = true
  }

  /** The surface's rise per metre along one axis from the samples `a` and `b` a distance `e` either side of the seat height `y`; -Infinity is no stone. */
  _slope(a, y, b, e) {
    const da = a === -Infinity ? null : y - a
    const db = b === -Infinity ? null : b - y
    if (da !== null && db !== null) {
      if (Math.abs(da - db) <= LIP * e) return (da + db) / (2 * e)
      return (Math.abs(da) <= Math.abs(db) ? da : db) / e
    }
    if (da !== null) return da / e
    if (db !== null) return db / e
    return 0
  }

  // --- the plan -----------------------------------------------------------------

  /**
   * Where crab `c` stands at the turn of its spell `seg`: a point over stone
   * inside its rock's disc rolled from its key and `seg` alone, its own seed
   * spot when POST_TRIES find none. A pure function of the key and the spell,
   * so every client has the same one.
   */
  _spot(c, seg) {
    const rand = phraseRand(c.key, seg, 0)
    const p = c.perch
    for (let k = 0; k < POST_TRIES; k++) {
      const a = rand() * Math.PI * 2
      const d = Math.sqrt(rand()) * p.r * 0.85
      const x = p.x + Math.cos(a) * d
      const z = p.z + Math.sin(a) * d
      const y = this.stoneAt(x, z)
      if (y !== -Infinity) return { x, y, z, stone: true }
    }
    return { x: c.seatX, y: this.stoneAt(c.seatX, c.seatZ), z: c.seatZ, stone: true }
  }

  /**
   * Where a loose crab stands after `k` legs of its run: from the drop, a leg
   * a spell's LOOSE_LEGS'th long each, the first along the heading her hand
   * gave it and each after it outward from the drop swung by up to
   * LOOSE_WOBBLE. Walked from the drop every time rather than carried
   * forward, so it is a pure function of the key and `k`; a run is over inside
   * a handful of spells, since it is forgotten past RADIUS.
   */
  _leg(c, k) {
    let x = c.drop.x, z = c.drop.z, yaw = c.drop.yaw
    const d = LOOSE_SPEED * c.size * (SPELL_S / LOOSE_LEGS)
    for (let i = 0; i < k; i++) {
      if (i > 0) yaw = Math.atan2(x - c.drop.x, z - c.drop.z) + (phraseRand(c.key, i, 2)() - 0.5) * LOOSE_WOBBLE
      x += Math.sin(yaw) * d
      z += Math.cos(yaw) * d
    }
    return this._looseSpot(c, x, z, yaw)
  }

  /** The phrases' start offsets, and the list returned. */
  static _starts(phrases) {
    let t = 0
    for (const ph of phrases) { ph.start = t; t += ph.dur }
    return phrases
  }

  /**
   * Spell `seg` of crab `c`: `{ seg, start, phrases }`, a sit at its spot at
   * the turn, the scuttle to its spot at the next, and the sit that fills the
   * spell out there. Every term is rolled from the key and `seg` alone, never
   * from the spell before, so a client meeting a crab mid-spell plans that
   * spell by itself and lands on the same poses as one that has watched all
   * along (_notes/creature-sync.md).
   *
   * A loose one has no rock: its spell is the LOOSE_LEGS legs of its run, and
   * it is null once the run is RADIUS from the drop and the crab is forgotten.
   */
  _spell(c, seg) {
    const start = seg * SPELL_S + c.offset + c.epoch
    if (c.drop) {
      const legs = []
      let from = this._leg(c, seg * LOOSE_LEGS)
      if (Math.hypot(from.x - c.drop.x, from.z - c.drop.z) > RADIUS) return null
      for (let i = 1; i <= LOOSE_LEGS; i++) {
        const to = this._leg(c, seg * LOOSE_LEGS + i)
        legs.push({ kind: 'go', dur: SPELL_S / LOOSE_LEGS, from, to, speed: LOOSE_SPEED })
        from = to
      }
      return { seg, start, phrases: Crabs._starts(legs) }
    }
    const a = this._spot(c, seg)
    const b = this._spot(c, seg + 1)
    const yawIn = this._facing(this._spot(c, seg - 1), a, c.seatYaw)
    const dist = Math.hypot(b.x - a.x, b.z - a.z)
    const one = [{ kind: 'pause', dur: SPELL_S, at: a, yaw: yawIn }]
    if (dist < 1e-9 || a.y === -Infinity || b.y === -Infinity) return { seg, start, phrases: Crabs._starts(one) }
    const rand = phraseRand(c.key, seg, 1)
    const want = SPEED[0] + (SPEED[1] - SPEED[0]) * rand() ** 2
    const dur = Math.min(Math.max(MIN_GO_S, dist / (want * c.size)), SPELL_S * 0.9)
    // The pace it crosses at, which is the rolled one except where the spell is too short for that: what the ear is told, and what the legs wave to.
    const speed = dist / (dur * c.size)
    const spare = SPELL_S - dur
    const open = Math.min(between(rand, PAUSE_S), spare)
    const yawOut = this._facing(a, b, yawIn)
    return {
      seg,
      start,
      phrases: Crabs._starts([
        { kind: 'pause', dur: open, at: a, yaw: yawIn },
        { kind: 'go', dur, from: a, to: b, speed, yaw: yawOut },
        { kind: 'pause', dur: spare - open, at: b, yaw: yawOut },
      ]),
    }
  }

  /** The heading a crab travelling from `from` to `to` faces, `fallback` where the two are one point. */
  _facing(from, to, fallback) {
    const dx = to.x - from.x, dz = to.z - from.z
    return Math.hypot(dx, dz) < 1e-9 ? fallback : Math.atan2(dx, dz)
  }

  /** The phrase of `phrases` playing `e` seconds in, the last one past the end. */
  static _phraseAt(phrases, e) {
    let i = phrases.length - 1
    while (i > 0 && phrases[i].start > e) i--
    return phrases[i]
  }

  /**
   * Crab `c` posed `e` seconds into phrase `ph`: sat on its spot, or along the
   * line between two of them at the pace the spell rolled, its legs waving
   * through LEG_CYCLES cycles a span travelled.
   */
  _pose(c, ph, e) {
    if (ph.kind === 'pause') {
      c.state = 'pause'
      c.speed = 0
      c.amp = 0
      if (c.x === ph.at.x && c.z === ph.at.z && c.yaw === ph.yaw) return
      this._seat(c, ph.at.x, ph.at.y, ph.at.z, ph.yaw, ph.at.stone)
      return
    }
    const u = ph.dur > 0 ? Math.min(1, e / ph.dur) : 1
    const { from, to } = ph
    c.state = 'go'
    c.speed = ph.speed
    c.amp = LEG_AMP
    const x = from.x + (to.x - from.x) * u
    const z = from.z + (to.z - from.z) * u
    // The stone under the line, where there is any: a rock's disc is circumscribed, so a line across it can cross air, and there the two ends' own heights carry it.
    const top = this.stoneAt(x, z)
    const y = top === -Infinity ? from.y + (to.y - from.y) * u : top
    c.phase = (Math.PI * 2 * LEG_CYCLES * Math.hypot(to.x - from.x, to.z - from.z) * u) / c.size
    this._seat(c, x, y, z, ph.yaw ?? this._facing(from, to, c.yaw), top !== -Infinity)
  }

  /** Pose `c` at world second `now`, planning the spell it falls in; false once a loose crab's run is over. */
  _play(c, now) {
    if (c.spell === null || now < c.spell.start || now >= c.spell.start + SPELL_S) {
      const spell = this._spell(c, Math.floor((now - c.epoch - c.offset) / SPELL_S))
      if (spell === null) return false
      c.spell = spell
      this.spells++
    }
    const e = now - c.spell.start
    const ph = Crabs._phraseAt(c.spell.phrases, e)
    c.phrase = ph
    c.elapsed = e - ph.start
    this._pose(c, ph, c.elapsed)
    return true
  }

  /**
   * One frame: every crab in the tiles is posed from its spell at world time
   * `now` (the room's clock in seconds) and written. Nothing is integrated, so
   * the frame's length does not enter into it and a client that joined a
   * moment ago draws the same crab on the same stone as one that has watched
   * all along.
   *
   * `under` is whether her head is below a water surface: while it is not, a
   * crab under its lake's surface is neither posed nor written -- the surface
   * is nearly opaque from above, so it costs its share of the frame for
   * nothing -- and it picks its spell back up where it stands when she goes
   * under. A crab up on the dry top of a half-sunk boulder is drawn either
   * way.
   */
  update(hx, hy, hz, now, under = true) {
    if (!Number.isFinite(now)) throw new Error(`Crabs.update: bad world time ${now}`)
    this.now = now
    this.head.x = hx
    this.head.z = hz
    this.under = under
    if (walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t)) > 0) {
      this.rescan = []
    }
    // The rocks land over frames; one tile per RESCAN_FRAMES picks up the perches that were not there at the last look.
    if (this.frame % RESCAN_FRAMES === 0) {
      if (!this.rescan.length) this.rescan = Array.from(this.tiles.values())
      const t = this.rescan.pop()
      if (t && this.tiles.has(tileKey(t.tx, t.tz))) this._scan(t)
    }
    this.frame++

    const mat = this.mesh.instanceMatrix.array
    const legs = this.legs.array
    const hue = this.hue.array
    const cmat = this.card.instanceMatrix.array
    const chue = this.cardHue.array
    const card2 = this.card.visible ? CARD_M * CARD_M : Infinity
    let n = 0
    let m = 0
    // A crab's matrix, rebuilt if it moved, into the mesh or the card by its distance.
    const write = (c) => {
      if (c.stale) {
        const k = c.size / this.span
        const sink = SINK * this.bodyH * k
        _pos.set(c.x - c.nx * sink, c.y - c.ny * sink, c.z - c.nz * sink)
        _n.set(c.nx, c.ny, c.nz)
        // `side` is which of the body's two ±Z ends leads, rolled with the crab and fixed for its life: the plan speaks only of the line it crosses, which either end serves.
        _quat.setFromUnitVectors(UP, _n).multiply(_yawQ.setFromAxisAngle(UP, c.side < 0 ? c.yaw + Math.PI : c.yaw))
        _scl.set(k, k * STRETCH_Y, k)
        _mat.compose(_pos, _quat, _scl).toArray(c.m)
        c.stale = false
      }
      const dx = c.x - hx
      const dy = c.y - hy
      const dz = c.z - hz
      if (dx * dx + dy * dy + dz * dz > card2) {
        cmat.set(c.m, m * 16)
        chue[m] = c.hue
        m++
      } else {
        mat.set(c.m, n * 16)
        legs[n * 2] = c.phase
        legs[n * 2 + 1] = c.amp
        hue[n] = c.hue
        n++
      }
    }
    // The loose crabs, running from where her hand let them go; one whose run has carried it past RADIUS is forgotten.
    let kept = 0
    for (const c of this.loose) {
      if (this._play(c, now)) {
        this.loose[kept++] = c
        const level = this.water.lakeLevelAt(c.x, c.z)
        if (under || level === null || c.y >= level) write(c)
      } else {
        c.loose = false
        c.drop = null
        this.free.push(c)
      }
    }
    this.loose.length = kept
    for (const t of this.tiles.values()) {
      if (t.live === 0) continue
      for (const p of t.perches.values()) {
        for (const c of p.crabs) {
          if (!under && c.y < p.level) continue
          this._play(c, now)
          // A re-ground is a vertical shift of the whole rock, so the normal holds; a seat whose stone is gone is kept. A sitting crab reads it back: its stone's drawn top moves with the client's own LOD, which the spell knows nothing of.
          if ((this.frame + c.id) % RESEAT_EVERY === 0) {
            const top = this.stoneAt(c.x, c.z)
            if (top !== -Infinity && top !== c.y) { c.y = top; c.stale = true }
          }
          write(c)
        }
      }
    }
    // A buffer that held nothing and holds nothing is not re-uploaded.
    if (n > 0 || this.mesh.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true
      this.legs.needsUpdate = true
      this.hue.needsUpdate = true
    }
    this.mesh.count = n
    if (m > 0 || this.card.count > 0) {
      this.card.instanceMatrix.needsUpdate = true
      this.cardHue.needsUpdate = true
    }
    this.card.count = m
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
    this.card.geometry.dispose()
    this.cardMaterial.map?.dispose()
    this.cardMaterial.dispose()
  }
}
