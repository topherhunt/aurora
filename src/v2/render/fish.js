import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CHAPTER_S, GRID_S, TICK_S, CATCH_UP_TICKS, SILENT_TICKS, hash32, keyHash, phraseRand, chapterOf, tickAfter, stepTo, easeWeight } from '../../sim/score.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import { hueVary, makeHueAttribute, tierTintSplice, tileSeed, walkTiles } from './critters.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { atMost } from '../eating.js'

// ---------------------------------------------------------------------------
// Fish: every authored lake and river stocked with the three roster species,
// swimming on their own with nothing to react to but each other and the shore.
//
// THE BEDS ARE THE WATER'S. The water within RADIUS of her head is cut into
// TILE-metre beds and each grows its schools from its tile seed (critters.js
// tileSeed): `perTile` sites a species, kept where the water is `minDepth`
// deep with `clearance` of the same around, every roll of a member (station,
// size, colour, temperament) drawn before the site is tested so a refused
// site leaves the stream where an accepted one would. A bed is a pure
// function of position like the plants, so leaving a lake and coming back
// meets the same schools, and so does everyone else in the room; a fish her
// hand took is recorded in taken.js against its bed's home, and the bed grows
// without it. Underwater visibility is 20 m (water.js UNDERWATER), so a bed
// further than RADIUS is a bed nobody can see. Standing on dry land every
// site fails and the layer is simply empty.
//
// EVERY CLIENT SWIMS THE SAME FISH (_notes/creature-sync.md). A school's
// anchor is a chain of hops rolled from hash(key, chapter): from home at the
// chapter turn, a new target every `anchorEvery` seconds within `anchorHop`
// of the anchor and `tether` of home, drifted to at `anchorSpeed`; a
// glimmerfin shoal's anchor also jumps `boltHop` every `boltEvery` seconds,
// the fright that sends the shoal after it; and the chapter's last hop goes
// home, so the next chapter starts from nothing. The anchor at any world time
// is that chain walked from the chapter start, every roll and every shore
// test a pure function, so two clients hold it to the bit. The fish are
// stepped at TICK_HZ on absolute ticks of the room's clock, each from its own
// PRNG keyed by segment, and every GRID_S seconds (the school's grid, offset
// by its key) each is put back at its station -- a pose closed-form in (key,
// segment) -- with the last EASE_S of a segment a pull onto the next station,
// so what one client integrates never strays from what another does for
// longer than a segment. A frame draws each fish between its last two ticks.
//
// ONE AI, THREE PERSONALITIES. Every fish is a heading that wanders, a speed
// that is steered toward a target, a pull toward its own station in the
// school, a push away from its nearest school-mates, and a probe ahead that
// turns it back to the anchor when the water ends. Every fish also rolls its
// own pace, verve, tail beat, station and bob at birth, so a school moves as
// a crowd and not as one mesh drawn nine times. The species table is the
// rest of the difference:
//
//   ironscale bass   -- schools of 4-9, a loose 3 m ball, mid-water, steady,
//                       one fish or another darting or hanging back.
//   rime fangpike    -- alone, on the bed. Glides, then hangs, then bursts.
//   glimmerfin       -- shoals of 6-14 under the surface, jittery, and
//                       STARTLING: every few seconds a fright ripples through
//                       the shoal, fish by fish, and it bolts a few metres
//                       and then hangs again.
//
// THE DEEP IS WHERE THE BIG ONES ARE. A fish's size is drawn at birth from the
// water under its own spot: the shore hands out fry, and the ceiling and the
// skew of the draw both climb with depth until DEEP_M, where most of a school
// is near the species' sizeMax and only the odd one is small.
//
// A LURE IS LIVE. A spider, butterfly or grasshopper in a hand (hands.js
// lures) has the fish within LURE_M swimming through it, kept to
// LURE_FORGET_M; a lured fish skips its station until the lure ends and
// rejoins at the next grid turn. The fish her own hand has are told to the
// room per bed as a lured set, `[bedKey, 'fs', null, indices]`
// (creature-net.js), so a peer's copy of her hand keeps the same fish on it.
//
// NO NEIGHBOUR SEARCH. Separation runs only inside a school, and a school is
// at most 14 fish, so a tick is linear in the fish. Pike keep apart from the
// other pike of their bed. Bed and surface are probed every PROBE_EVERY ticks
// per fish and cached, because heightAt is the one thing in this file that
// is not arithmetic.
//
// THE TAIL IS THE SHADER'S. public/fauna/fish.json (tools/fauna/ship.mjs)
// carries each species' picked Tripo mesh, nose at -Z, with a per-vertex
// swim-bend weight, and each fish is one InstancedMesh instance with (phase,
// amplitude, curve, lift): the vertex stage bends every vertex sideways by
// bend * (amplitude * sin(phase - k * z) + curve) and up by bend * lift. The
// frame advances the phase at a rate that follows the fish's speed, so a
// lurking pike barely sculls and a bolting glimmerfin is a blur, and it sets
// curve and lift from the turn and the pitch in hand, so the body arcs into
// every turn and climb and the tail beats harder through it: a fish never
// swings round or tilts straight as a board.
//
// NO TWO FISH ARE THE SAME COLOUR. Each rolls a brightness (instanceColor) and
// a hue, a turn of up to HUE radians either way round the colour wheel
// (critters.js hueVary), at birth.
// ---------------------------------------------------------------------------

const ASSET_URL = 'fauna/fish.json'
const TEXTURE_URL = (file) => `fauna/${file}`

// A bed's side and how far out beds are kept, both against the 20 m murk: the furthest bed's near edge is just past it.
export const TILE = 24
export const RADIUS = 36
// Metres her head moves before the beds are walked again.
const WALK_M = 4
// Water this deep, under a fish's own spot, hands out the species' full size ceiling; 0.5 m hands out the shore's.
const DEEP_M = 12
// A fish probes the bed, the surface and the water ahead every this many ticks.
const PROBE_EVERY = 4
// A startle crosses a shoal at BOLT_WAVE m/s, each fish reacting up to BOLT_JITTER s late on top, and BOLT_MISS of the shoal never bolts at all: a fright is a ripple through the shoal, never one tick's broadcast.
const BOLT_WAVE = 4
const BOLT_JITTER = 0.4
const BOLT_MISS = 0.15
// How far off the bed and under the surface a fish is held, in metres, plus a fifth of its own length. The probe is PROBE_EVERY ticks stale, so this also covers the distance a bolting fish crosses between probes.
const BED_MARGIN = 0.25
const SURFACE_MARGIN = 0.3
// A hop's path is tested for water every this many metres, so a school is never led across a spit its fish would beach on.
const HOP_STEP_M = 2
// The pull onto the next station over a segment's last EASE_S seconds: the fraction of the gap closed a second at full weight.
const EASE_PULL = 4
export const HUE = 0.35
// A fish setting off at a target speed of at least this, m/s, is listed in startled() for the ear: a glimmerfin's bolt, a pike's burst, a bass's dart, but not a glimmerfin's fidget or any hang.
export const DART_SPEED = 1

// A fish she let go of in the water: seconds it hangs stunned before it wakes, the speed it then darts from her at (a multiple of its cruise), how often its line is jinked, and how far from her head it is forgotten.
export const STUN_S = [1, 2]
export const LOOSE_HASTE = 3
const LOOSE_JINK = 1.2
export const LOOSE_GONE_M = 40

// A LURE. A spider, butterfly or grasshopper in a hand (hands.js lures) within LURE_M of a fish has it swimming at the hand at LURE_HASTE times its cruise and LURE_AGILITY times its agility, kept to LURE_FORGET_M, its station forgotten. The walk swings onto the hand's bearing at LURE_TURN radians a second and no faster, with its jitter still on it, so the fish runs through the hand and comes round on a circle of its speed over LURE_TURN to run through it again.
export const LURES = ['spider', 'butterfly', 'grasshopper']
export const LURE_M = 3
export const LURE_FORGET_M = 6
export const LURE_HASTE = 3
const LURE_AGILITY = 2
export const LURE_TURN = 3
// A bed's lured set goes to the room at most this often while it changes; an emptied set goes at once.
export const LURED_EVERY_S = 1
const NO_LURES = []
// HER AS PREY. Her height is `heightM` times her size (sized). A fish over `nibble` times that long with her head within `notice` of its own lengths swims at her as at a lure, kept to twice that, and from half its length off bites for `harm` every `biteS`; one over `gulp` times her height swallows her whole. Hers alone: the room does not hear it.
export const PREY = { heightM: 1.8, nibble: 2, gulp: 4, notice: 2, harm: 10, biteS: 1 }

export const bedKey = (tx, tz) => `fs:${tx},${tz}`
export const keyOf = (tx, tz, s) => `${bedKey(tx, tz)}:${s}`

/**
 * The species table. Speeds in m/s, times in seconds, depths as a fraction of
 * the water column measured up from the bed. `count` is the species' slots,
 * `perTile` the sites a bed rolls for it; `minDepth` is the column a school
 * will seed in and `clearance` how far around an anchor that column must
 * extend; `tether` how far from home the anchor may be sent. `wander` is the
 * heading's random walk in rad/s^0.5; `agility` is how fast velocity chases
 * its target, 1/s. `size` is the scale drawn at the shore and the ceiling
 * reached in DEEP_M of water (see sizeAt); `sizeVary` a jitter on top.
 * `fidget` is one fish's own dart or hang: every `fidgetEvery` seconds,
 * `fidgetFor` seconds at `fidgetSpeed` or at a third of cruise, with a kick to
 * the heading.
 */
export const SPECIES = {
  'ironscale-bass': {
    count: 128, perTile: 2, school: [4, 9], schoolRadius: 3, separation: 0.5,
    minDepth: 1.0, clearance: 3, depth: [0.3, 0.7], tether: 10,
    cruise: 0.55, agility: 1.4, wander: 0.9, lookahead: 3,
    tailHz: 2.0, tailAmp: 0.11, size: [0.55, 2.6], sizeVary: 0.2,
    anchorSpeed: 0.3, anchorHop: [6, 14], anchorEvery: [8, 16],
    fidgetEvery: [3, 9], fidgetSpeed: 1.3, fidgetFor: 0.5,
    material: { color: 0xffffff },
  },
  'rime-fangpike': {
    count: 24, perTile: 2, school: [1, 1], schoolRadius: 6, separation: 6,
    minDepth: 1.5, clearance: 2.5, depth: [0.08, 0.3], tether: 12,
    cruise: 0.28, agility: 0.8, wander: 0.35, lookahead: 6,
    tailHz: 1.1, tailAmp: 0.08, size: [0.6, 2.6], sizeVary: 0.25,
    anchorSpeed: 0.2, anchorHop: [8, 20], anchorEvery: [10, 24],
    // The three moods of an ambush predator: seconds in each, and the speed it holds.
    glide: [6, 14], lurk: [4, 10], lurkSpeed: 0.03, burst: 0.9, burstSpeed: 2.2,
    material: { color: 0xffffff },
  },
  'glimmerfin': {
    count: 176, perTile: 2, school: [6, 14], schoolRadius: 1.2, separation: 0.25,
    minDepth: 0.5, clearance: 1.5, depth: [0.6, 0.9], tether: 5,
    cruise: 0.18, agility: 3.5, wander: 3.0, lookahead: 1.5,
    tailHz: 3.5, tailAmp: 0.12, size: [0.5, 2.2], sizeVary: 0.3,
    anchorSpeed: 0.15, anchorHop: [2, 5], anchorEvery: [3, 8],
    // The startle: the shoal's anchor jumps `boltHop` metres, every fish bolts at `boltSpeed` for `boltFor` seconds.
    boltEvery: [4, 12], boltHop: [2, 4], boltSpeed: 2.0, boltFor: 1.0,
    fidgetEvery: [0.8, 3], fidgetSpeed: 0.7, fidgetFor: 0.25,
    // A little of the folklore glow, so the shoal reads through the murk.
    material: { color: 0xffffff, emissive: 0x2a1650, emissiveIntensity: 0.6 },
  },
}

const TAU = Math.PI * 2
const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _a = { x: 0, z: 0, y: 0 }
const _e = { x: 0, z: 0, y: 0 }
const _s = { sx: 0, sy: 0, sz: 0, bed: 0, level: 0 }
const _o = { x: 0, z: 0, y: 0 }

export class Fish {
  /**
   * @param scene   the three.js scene
   * @param height  V2Height: heightAt(x, z)
   * @param water   WaterSurfaces: levelAt(x, z) -> level or null
   * @param opts.seed    the world seed, for the beds and the loose fish
   * @param opts.assets  parsed fish.json for a gate; the world fetches it
   * @param opts.harm    (n, why) => her bitten by a fish (PREY)
   * @param opts.swallow (why) => her swallowed whole by one (PREY)
   */
  constructor(scene, height, water, { seed = 1, assets = null, harm = null, swallow = null } = {}) {
    if (!height || typeof height.heightAt !== 'function') throw new Error('Fish needs a height field with heightAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Fish needs WaterSurfaces, for levelAt')
    if (harm !== null && typeof harm !== 'function') throw new Error('Fish: harm must be a function of (n, why)')
    if (swallow !== null && typeof swallow !== 'function') throw new Error('Fish: swallow must be a function of (why)')
    this.harm = harm
    this.swallow = swallow
    // Her size, a multiple of her full height (sized), and her head as the lure a fish hunting her swims at.
    this.size = 1
    this.her = { kind: 'her', x: 0, y: 0, z: 0, by: null }
    this.height = height
    this.water = water
    this.seed = seed
    // The layer's own noise: the loose fish only. Everything in a bed rolls from its key.
    this.rand = mulberry32(seed)
    this.batch = new THREE.Group()
    this.batch.name = 'v2-fish'
    scene.add(this.batch)
    this.species = Object.entries(SPECIES).map(([id, cfg]) => this.makeSpecies(id, cfg))
    this.frame = 0
    // The room's clock at the last update, or null before the first.
    this.now = null
    this.head = { x: 0, y: 0, z: 0 }
    // The fish that set off fast this frame, for startled().
    this.startles = []
    this.tiles = new Map()
    // Where the beds were last walked from.
    this.walkedX = Infinity
    this.walkedZ = Infinity
    // Members a bed rolled that found no free slot.
    this.overflow = 0
    this.ticks = 0
    // Fish a probe found on the bank, put back at their anchor.
    this.beached = 0
    // Lured sets owed to the room (pendingLured), and the peers' by bed key (applyLured): { by, has }.
    this.owed = []
    this.luredIn = new Map()
    if (assets) {
      for (const sp of this.species) this.setAsset(sp, this.assetFor(assets, sp))
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  assetFor(assets, sp) {
    const asset = assets.species.find((a) => a.id === sp.id)
    if (!asset) throw new Error(`fish: ${ASSET_URL} has no ${sp.id} -- run tools/fauna/ship.mjs`)
    return asset
  }

  makeSpecies(id, cfg) {
    // Lambert, no specular: a fish only glints once it is out of the water -- under it, the sheen the eye reads belongs to the surface, and the fish is a matte thing in dim light. Opaque and front-faced: a Tripo fish is a closed volume whose fins are two sheets a hair apart (tripo-culling.js), and nothing here sorts.
    const material = new THREE.MeshLambertMaterial({ ...cfg.material })
    // The swim bend. `aBend` is ship.mjs's per-vertex weight (0 at the nose, 1 at the tail tip); `aSwim` is per instance: phase, amplitude, and the turn's sideways curve and the climb's lift, all in local metres. The wave number is a literal scaled to the species' length, so a pike's wave is one body length long just like a glimmerfin's.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aBend;\nattribute vec4 aSwim;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += aBend * ( aSwim.y * sin( aSwim.x - FISH_WAVE_K * position.z ) + aSwim.z );\ntransformed.y += aBend * aSwim.w;')
      hueVary(shader)
      tierTintSplice(shader, 0)
    }
    material.customProgramCacheKey = () => `fish-${id}`
    material.defines = { FISH_WAVE_K: '0.0' }

    const slots = []
    for (let i = 0; i < cfg.count; i++) {
      slots.push({
        alive: false, loose: false, school: null, tile: null,
        // Its index in its bed, for the lured sets and the taken registry.
        index: -1,
        // The pose at the last tick and the one before it; the frame draws between them. A loose fish is stepped per frame and drawn at (x, y, z).
        x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
        // Smoothed facing, so a fish that stops does not snap to whatever its last velocity happened to be.
        hx: 0, hz: -1, pitch: 0, roll: 0,
        // `size` is its length in metres, for the ear.
        wander: 0, depthFrac: 0.5, scale: 1, size: 0, margin: 0, tint: 1, hue: 0,
        phase: 0, amp: 0, curve: 0, lift: 0,
        // The fish's own rolls: speed and wander multipliers, tail-beat multiplier, and its station in the school -- a point `ring` metres from the anchor that circles it at `orbit` rad/s from `station0` at world time zero -- plus a slow vertical bob.
        pace: 1, verve: 1, beat: 1, ring: 0, station0: 0, station: 0, orbit: 0, bobHz: 0.1, bobAt: 0,
        bed: 0, level: 0, probeAt: 0,
        // Seconds left steering back to the anchor after the probe found the shore ahead, and until the shoal's startle reaches this fish.
        homing: 0, boltIn: 0,
        // Mood: pike glide/lurk/burst, bass and glimmerfin fidget. `speed` is the mood's target speed.
        mood: 'glide', moodLeft: 0, speed: cfg.cruise,
        // The segment's PRNG, and the station the segment ends at.
        rand: null, ex: 0, ey: 0, ez: 0,
        // Let go of by her hand: no school, stunned for `stun` seconds, then darting from her head (stepLoose).
        stun: 0,
        // The hands.js lure it is swimming at, or null; `lured` while it is off its station for one.
        lure: null, lured: false, bitT: -Infinity,
        // The frame it was last listed for the ear.
        listedAt: -1,
      })
    }
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), material, cfg.count)
    mesh.name = `v2-fish-${id}`
    mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    mesh.visible = false
    // The instances move every frame and the beds are a disc around the head anyway; a per-mesh sphere would have to be rebuilt each frame to cull anything.
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cfg.count * 3).fill(1), 3)
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(cfg.count * 4), 4)
    swim.setUsage(THREE.DynamicDrawUsage)
    mesh.geometry.setAttribute('aSwim', swim)
    const hue = makeHueAttribute(mesh, cfg.count)
    cullTripoBackfaces(mesh)
    this.batch.add(mesh)
    return { id, cfg, material, mesh, swim, hue, slots, free: slots.slice(), schools: [], loaded: false, lengthM: 0 }
  }

  /** public/fauna/fish.json and its three colour maps. Throws on a roster mismatch rather than drawing a species as a blank. */
  async load() {
    const res = await fetch(ASSET_URL)
    if (!res.ok) throw new Error(`fish: ${ASSET_URL} answered ${res.status} -- run tools/fauna/ship.mjs`)
    const assets = await res.json()
    const loader = new THREE.TextureLoader()
    for (const sp of this.species) {
      const asset = this.assetFor(assets, sp)
      this.setAsset(sp, asset)
      const tex = await loader.loadAsync(TEXTURE_URL(asset.texture))
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      sp.material.map = tex
      sp.material.needsUpdate = true
    }
    return true
  }

  /** The shipped mesh onto a species' InstancedMesh. Public so a gate can hand the JSON in without a fetch. */
  setAsset(sp, asset) {
    const n = asset.pos.length / 3
    if (asset.bend.length !== n || asset.uv.length !== n * 2 || asset.nrm.length !== n * 3) throw new Error(`fish: ${sp.id} asset attribute lengths disagree`)
    if (!(asset.lengthM > 0)) throw new Error(`fish: ${sp.id} has no lengthM`)
    const geo = sp.mesh.geometry
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(asset.pos), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(asset.nrm), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(asset.uv), 2))
    geo.setAttribute('aBend', new THREE.BufferAttribute(new Float32Array(asset.bend), 1))
    geo.setIndex(asset.idx)
    sp.lengthM = asset.lengthM
    // Two and a half radians of wave over one body length: the tail is a half-wave behind the head, which is what a real fish's undulation looks like at one glance.
    sp.material.defines.FISH_WAVE_K = (2.5 / asset.lengthM).toFixed(4)
    sp.material.needsUpdate = true
    sp.mesh.visible = true
    sp.loaded = true
  }

  // --- the beds ---------------------------------------------------------------

  /** Rebuild every bed around (cx, cz) and forget the loose fish. Boot, and whenever she is put down somewhere new. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    for (const sp of this.species) for (const f of sp.slots) if (f.loose) this.unslot(sp, f)
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = cx
    this.walkedZ = cz
  }

  _walkTiles(x, z) {
    if (Math.hypot(x - this.walkedX, z - this.walkedZ) <= WALK_M) return
    walkTiles(this.tiles, x, z, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = x
    this.walkedZ = z
  }

  /** The bed at tile (tx, tz): its schools from the tile seed, in species order, `s` the site's index in the bed and every member numbered through the bed. */
  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, key: bedKey(tx, tz), schools: [], fish: [], luredSent: '', luredAt: -Infinity }
    let index = 0
    let s = 0
    for (const sp of this.species) {
      const cfg = sp.cfg
      for (let k = 0; k < cfg.perTile; k++, s++) {
        // Every roll first, so a site refused leaves the stream where an accepted one would.
        const x = (tx + rand()) * TILE
        const z = (tz + rand()) * TILE
        const n = Math.round(between(rand, cfg.school))
        const rolls = []
        for (let i = 0; i < n; i++) rolls.push(this._roll(rand, cfg, n))
        const first = index
        index += n
        const at = this.site(sp, x, z, cfg.clearance)
        if (at === null || !sp.loaded) continue
        // A solo species does not seed on top of its own kind: two pike in a ditch now and then otherwise.
        if (cfg.school[1] === 1 && t.schools.some((o) => o.sp === sp && Math.hypot(o.home.x - x, o.home.z - z) < cfg.separation)) continue
        const key = keyOf(tx, tz, s)
        const school = {
          key, sp, tile: t, offset: keyHash(key) % GRID_S,
          home: { x, z, bed: at.bed, level: at.level },
          // The anchor at the last tick; `chapters` the hop chains by chapter index (_walk); `seg` the segment the members were last put at their stations for, `rec` their tick record (score.js stepTo).
          x, z, y: this.column(at.bed, at.level, 0.5), fleeAt: 0, chapters: new Map(), seg: null, rec: { tick: 0, alpha: 0 },
          members: [],
        }
        for (let i = 0; i < n; i++) {
          if (taken.has(`fish${first + i}`, x, z)) continue
          const f = sp.free.pop()
          if (!f) { this.overflow++; continue }
          this._seat(sp, f, school, first + i, rolls[i])
          school.members.push(f)
          t.fish.push(f)
        }
        if (school.members.length === 0) continue
        sp.schools.push(school)
        t.schools.push(school)
      }
    }
    return t
  }

  /** One member's rolls, in a fixed order, off the bed's stream. */
  _roll(rand, cfg, n) {
    return {
      spread: n > 1 ? rand() * cfg.schoolRadius : 0, b: rand() * TAU, depthFrac: between(rand, cfg.depth),
      sizeU: rand(), sizeJ: rand() * 2 - 1,
      // A big fish swims faster and beats slower than a small one of its kind, and each has its own temperament on top.
      pace: 0.8 + 0.4 * rand(), beat: 0.85 + 0.3 * rand(), verve: 0.6 + rand() * rand() * 1.4,
      ring: n > 1 ? (0.25 + 0.6 * rand()) * cfg.schoolRadius : 0, orbit: (rand() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rand()),
      bobHz: 0.05 + 0.1 * rand(), bobAt: rand() * TAU, tint: 0.85 + rand() * 0.2, hue: (rand() * 2 - 1) * HUE, phase: rand() * TAU,
    }
  }

  /** Slot `f` as member `index` of `school` from its rolls `r`: spread around the home, unless that spot is shore, when it starts on the home itself. */
  _seat(sp, f, school, index, r) {
    const cfg = sp.cfg
    const home = school.home
    let fx = home.x + Math.cos(r.b) * r.spread
    let fz = home.z + Math.sin(r.b) * r.spread
    let level = this.water.levelAt(fx, fz)
    let bed = level === null ? 0 : this.height.heightAt(fx, fz)
    if (level === null || level - bed < cfg.minDepth) { fx = home.x; fz = home.z; level = home.level; bed = home.bed }
    f.alive = true
    f.loose = false
    f.school = school
    f.tile = school.tile
    f.index = index
    f.x = f.px = fx
    f.z = f.pz = fz
    f.depthFrac = r.depthFrac
    f.bed = bed
    f.level = level
    f.scale = this.sizeAt(cfg, level - bed, r.sizeU, r.sizeJ)
    f.size = sp.lengthM * f.scale
    f.margin = 0.2 * f.size
    f.y = f.py = this.column(bed, level, f.depthFrac, f.margin)
    f.wander = r.b
    f.hx = Math.cos(r.b)
    f.hz = Math.sin(r.b)
    f.vx = f.hx * cfg.cruise
    f.vz = f.hz * cfg.cruise
    f.vy = 0
    f.pitch = 0
    f.roll = 0
    f.curve = 0
    f.lift = 0
    f.amp = 0
    f.pace = r.pace * Math.sqrt(f.scale)
    f.beat = r.beat / Math.sqrt(f.scale)
    f.verve = r.verve
    f.ring = r.ring
    f.station0 = f.station = r.b
    f.orbit = r.orbit
    f.bobHz = r.bobHz
    f.bobAt = r.bobAt
    f.tint = r.tint
    f.hue = r.hue
    f.phase = r.phase
    f.probeAt = index % PROBE_EVERY
    f.homing = 0
    f.boltIn = 0
    f.mood = 'glide'
    f.moodLeft = 0
    f.speed = cfg.cruise
    f.rand = null
    f.ex = fx
    f.ey = f.y
    f.ez = fz
    f.stun = 0
    f.lure = null
    f.lured = false
    f.listedAt = -1
  }

  _leave(t) {
    // A bed her hand had fish of: the room hears they are let go.
    if (t.luredSent !== '') this.owed.push([t.key, 'fs', null, []])
    this.luredIn.delete(t.key)
    for (const school of t.schools.slice()) this._retire(school)
    t.fish.length = 0
  }

  /** Every member back to the free list and the school off its species and its bed. */
  _retire(school) {
    const sp = school.sp
    for (const f of school.members) {
      f.alive = false
      f.school = null
      f.tile = null
      sp.free.push(f)
    }
    school.members.length = 0
    const i = sp.schools.indexOf(school)
    if (i >= 0) sp.schools.splice(i, 1)
    const j = school.tile.schools.indexOf(school)
    if (j >= 0) school.tile.schools.splice(j, 1)
  }

  /** One fish out of its school and its bed and back to the free list; the school goes with it when it was the last. */
  _drop(sp, f) {
    const school = f.school
    const t = f.tile
    school.members.splice(school.members.indexOf(f), 1)
    t.fish.splice(t.fish.indexOf(f), 1)
    this.unslot(sp, f)
    if (!school.members.length) this._retire(school)
  }

  /** A fish with no school -- one she let go of, or one just taken -- back to the free list. */
  unslot(sp, f) {
    f.alive = false
    f.loose = false
    f.stun = 0
    f.school = null
    f.tile = null
    f.index = -1
    f.lured = false
    f.lure = null
    sp.free.push(f)
  }

  get stats() {
    const out = { alive: 0, schools: 0, tiles: this.tiles.size, overflow: this.overflow, ticks: this.ticks, beached: this.beached }
    for (const sp of this.species) {
      const n = sp.cfg.count - sp.free.length
      out[sp.id] = { alive: n, schools: sp.schools.length }
      out.alive += n
      out.schools += sp.schools.length
    }
    return out
  }

  /**
   * Whether (x, z) is water deep enough for the species, with `clearance`
   * metres of the same on four sides: an anchor set right against the shore
   * pulls its school onto it. Returns { bed, level } or null.
   */
  site(sp, x, z, clearance) {
    const cfg = sp.cfg
    const level = this.water.levelAt(x, z)
    if (level === null) return null
    const bed = this.height.heightAt(x, z)
    if (level - bed < cfg.minDepth) return null
    for (let i = 0; i < 4 && clearance > 0; i++) {
      const cx = x + (i === 0 ? clearance : i === 1 ? -clearance : 0)
      const cz = z + (i === 2 ? clearance : i === 3 ? -clearance : 0)
      const l = this.water.levelAt(cx, cz)
      if (l === null || l - this.height.heightAt(cx, cz) < cfg.minDepth) return null
    }
    return { bed, level }
  }

  /** The vertical band at a site, [bed + margin, level - margin] narrowed by `extra` for a fish's own bulk, with `frac` of the way up it. */
  column(bed, level, frac, extra = 0) {
    const lo = bed + BED_MARGIN + extra
    const hi = level - SURFACE_MARGIN - extra
    if (hi <= lo) return (lo + hi) / 2
    return lo + (hi - lo) * frac
  }

  /**
   * A size for a fish born over `depth` metres of water from its rolls `u`
   * and `j` in [0, 1] and [-1, 1]. The ceiling climbs from 0.8 at the shore
   * to the species' size[1] at DEEP_M, and the draw's skew turns over with
   * it: shallow, most rolls land near the floor; deep, most land near the
   * ceiling and only the odd one is small.
   */
  sizeAt(cfg, depth, u, j) {
    const t = Math.max(0, Math.min(1, (depth - 0.5) / (DEEP_M - 0.5)))
    const ease = t * t * (3 - 2 * t)
    const top = 0.8 + (cfg.size[1] - 0.8) * ease
    const k = Math.pow(u, 2.2 - 1.75 * ease)
    return (cfg.size[0] + (top - cfg.size[0]) * k) * (1 + j * cfg.sizeVary)
  }

  // --- the anchor's chain -----------------------------------------------------

  /**
   * The hop chain of `school`'s chapter holding world time `t`, walked to
   * `t`: `events` is the anchor's state at each hop -- where it was, what it
   * was sent at, its depth -- from home at the chapter start, `bolts` the
   * frights not yet run through the shoal. The last two chapters are kept, so
   * a segment straddling a chapter turn reads both without rebuilding either.
   */
  _walk(school, t) {
    const c = chapterOf(t, school.key)
    let ch = school.chapters.get(c.index)
    if (ch === undefined) {
      const cfg = school.sp.cfg
      const rand = phraseRand(school.key, c.index, 0)
      const home = school.home
      ch = {
        index: c.index, start: c.start, end: c.start + CHAPTER_S, rand,
        hopAt: c.start + between(rand, cfg.anchorEvery),
        boltAt: cfg.boltEvery ? c.start + between(rand, cfg.boltEvery) : Infinity,
        // The last hop goes home, early enough to get there at the anchor's speed from the tether's edge.
        homeAt: c.start + CHAPTER_S - (cfg.tether / cfg.anchorSpeed + GRID_S), homed: false,
        events: [{ at: c.start, x: home.x, z: home.z, tx: home.x, tz: home.z, y: this.column(home.bed, home.level, between(rand, cfg.depth)) }],
        bolts: [],
      }
      for (const k of school.chapters.keys()) if (k < c.index - 1 || k > c.index + 1) school.chapters.delete(k)
      school.chapters.set(c.index, ch)
    }
    for (;;) {
      const next = Math.min(ch.hopAt, ch.boltAt, ch.homed ? Infinity : ch.homeAt)
      if (next > t) break
      this._event(school, ch, next)
    }
    return ch
  }

  /** The chain's next hop at world time `at`: the anchor moved to where it is, then a new target rolled -- kept only in the tether, over water all the way, deep enough with clearance at the end -- or home once and for all. */
  _event(school, ch, at) {
    const sp = school.sp
    const cfg = sp.cfg
    const rand = ch.rand
    const home = school.home
    const last = ch.events[ch.events.length - 1]
    const ev = { at, x: 0, z: 0, tx: last.tx, tz: last.tz, y: last.y }
    Fish._anchorOf(last, at, cfg.anchorSpeed, ev)
    if (!ch.homed && at >= ch.homeAt) {
      ch.homed = true
      ch.hopAt = Infinity
      ch.boltAt = Infinity
      const site = this._clear(sp, ev.x, ev.z, home.x, home.z)
      if (site !== null) { ev.tx = home.x; ev.tz = home.z; ev.y = this.column(site.bed, site.level, between(rand, cfg.depth)) }
    } else {
      const bolt = at >= ch.boltAt
      if (bolt) ch.boltAt = at + between(rand, cfg.boltEvery)
      else ch.hopAt = at + between(rand, cfg.anchorEvery)
      const a = rand() * TAU
      const hop = between(rand, bolt ? cfg.boltHop : cfg.anchorHop)
      const depth = between(rand, cfg.depth)
      const tx = ev.x + Math.cos(a) * hop
      const tz = ev.z + Math.sin(a) * hop
      const site = Math.hypot(tx - home.x, tz - home.z) <= cfg.tether ? this._clear(sp, ev.x, ev.z, tx, tz) : null
      if (site !== null) {
        ev.tx = tx
        ev.tz = tz
        ev.y = this.column(site.bed, site.level, depth)
        if (bolt) {
          // The anchor arrives at once. The fright does not: it starts at the edge the shoal flees from and runs through it (the tick).
          ch.bolts.push({ at, x: tx, z: tz, fx: tx - ev.x, fz: tz - ev.z, fd: hop })
          ev.x = tx
          ev.z = tz
        }
      }
    }
    ch.events.push(ev)
  }

  /** The anchor's position at `t` from the event `ev` before it: on its way to the target at `speed`, or there. */
  static _anchorOf(ev, t, speed, into) {
    const dx = ev.tx - ev.x
    const dz = ev.tz - ev.z
    const d = Math.hypot(dx, dz)
    const step = Math.min(d, speed * (t - ev.at))
    into.x = d > 0 ? ev.x + (dx / d) * step : ev.x
    into.z = d > 0 ? ev.z + (dz / d) * step : ev.z
    into.y = ev.y
    return into
  }

  /** The anchor at world time `t`, into `into` (x, z, y); the chain it was read off is returned on `into.ch`. */
  _anchorAt(school, t, into) {
    const ch = this._walk(school, t)
    let i = ch.events.length - 1
    while (i > 0 && ch.events[i].at > t) i--
    Fish._anchorOf(ch.events[i], t, school.sp.cfg.anchorSpeed, into)
    into.ch = ch
    return into
  }

  /** The site at (x1, z1) with clearance, when the way there from (x0, z0) is water deep enough every HOP_STEP_M; null otherwise. */
  _clear(sp, x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0)
    const steps = Math.max(1, Math.ceil(d / HOP_STEP_M))
    for (let i = 1; i < steps; i++) {
      if (!this.site(sp, x0 + (x1 - x0) * (i / steps), z0 + (z1 - z0) * (i / steps), 0)) return null
    }
    return this.site(sp, x1, z1, sp.cfg.clearance)
  }

  // --- the segments -----------------------------------------------------------

  /**
   * Segment `g` begins for `school`: the chain is walked through it, and every
   * member not on a lure is put at its station for the segment's start -- its
   * ring point about the anchor, or the anchor itself where that is shore --
   * with its heading, mood and tick PRNG rolled from (key, g, index), and
   * told the station the segment ends at. A lured fish keeps swimming and is
   * put back at the next turn it is free for.
   */
  _reset(sp, school, g) {
    const cfg = sp.cfg
    const start = g * GRID_S + school.offset
    school.seg = g
    school.rec.tick = tickAfter(start) - 1
    const ch = this._walk(school, start + GRID_S)
    // The chain before the segment is history: one event stands for the anchor at its start, and no fright before it reaches a fish put freshly at its station.
    while (ch.events.length > 1 && ch.events[1].at <= start) ch.events.shift()
    while (ch.bolts.length && ch.bolts[0].at < start) ch.bolts.shift()
    this._anchorAt(school, start, _a)
    this._anchorAt(school, start + GRID_S, _e)
    school.x = _a.x
    school.z = _a.z
    school.y = _a.y
    for (const f of school.members) {
      f.rand = mulberry32(hash32(keyHash(school.key), g, f.index))
      const rand = f.rand
      const station = f.station0 + f.orbit * start
      this._station(sp, f, _e, station + f.orbit * GRID_S, _s)
      f.ex = _s.sx; f.ey = _s.sy; f.ez = _s.sz
      if (f.lured) continue
      f.station = station
      this._station(sp, f, _a, station, _s)
      f.x = f.px = _s.sx
      f.y = f.py = _s.sy
      f.z = f.pz = _s.sz
      f.bed = _s.bed
      f.level = _s.level
      // Headed for where the segment ends, which is about where the ease was taking it; a station that stays put gets a fresh heading.
      const ed = Math.hypot(f.ex - f.x, f.ez - f.z)
      f.wander = ed > 0.05 ? Math.atan2(f.ez - f.z, f.ex - f.x) : rand() * TAU
      f.vx = Math.cos(f.wander) * cfg.cruise * f.pace
      f.vz = Math.sin(f.wander) * cfg.cruise * f.pace
      f.vy = 0
      f.homing = 0
      f.boltIn = 0
      if (cfg.glide) {
        if (rand() < 0.6) { f.mood = 'glide'; f.moodLeft = rand() * cfg.glide[1]; f.speed = cfg.cruise }
        else { f.mood = 'lurk'; f.moodLeft = rand() * cfg.lurk[1]; f.speed = cfg.lurkSpeed }
      } else {
        f.mood = 'glide'
        f.moodLeft = rand() * cfg.fidgetEvery[1]
        f.speed = cfg.cruise
      }
    }
  }

  /** Fish `f`'s station about the anchor `a` at ring angle `station`, into `into` (sx, sy, sz, and the bed and level there): over water deep enough, else the anchor. */
  _station(sp, f, a, station, into) {
    let sx = a.x + Math.cos(station) * f.ring
    let sz = a.z + Math.sin(station) * f.ring
    let level = this.water.levelAt(sx, sz)
    let bed = level === null ? 0 : this.height.heightAt(sx, sz)
    if (level === null || level - bed < sp.cfg.minDepth) {
      sx = a.x
      sz = a.z
      level = this.water.levelAt(sx, sz)
      bed = level === null ? 0 : this.height.heightAt(sx, sz)
      if (level === null) throw new Error(`Fish: the anchor of ${f.school.key} is on dry ground at (${sx.toFixed(1)}, ${sz.toFixed(1)})`)
    }
    into.sx = sx
    into.sy = this.column(bed, level, f.depthFrac, f.margin)
    into.sz = sz
    into.bed = bed
    into.level = level
  }

  /** One tick of `school`: the anchor read off its chain, a fright due run through the shoal, every member stepped. */
  _tick(sp, school, tick) {
    this.ticks++
    const tNow = tick * TICK_S
    const ch = this._anchorAt(school, tNow, _a).ch
    school.x = _a.x
    school.z = _a.z
    school.y = _a.y
    while (ch.bolts.length && ch.bolts[0].at <= tNow) this._fright(sp, school, ch.bolts.shift())
    const w = easeWeight(tNow - (school.seg * GRID_S + school.offset), GRID_S)
    for (const f of school.members) this._step(sp, f, school, tNow, tick, w)
  }

  /** A fright `b` through the shoal: each fish reacts when the wave reaches it, at its own delay on top, and BOLT_MISS of them never notice and just get pulled along after. */
  _fright(sp, school, b) {
    school.fleeAt = Math.atan2(b.fz, b.fx)
    for (const f of school.members) {
      if (f.rand() < BOLT_MISS) continue
      const along = ((f.x - b.x) * b.fx + (f.z - b.z) * b.fz) / b.fd + sp.cfg.schoolRadius
      f.boltIn = Math.max(0, along) / BOLT_WAVE + f.rand() * BOLT_JITTER
    }
  }

  /** One tick of a schooled fish, TICK_S long, at world time `tNow`; `w` the ease onto its end station. */
  _step(sp, f, school, tNow, tick, w) {
    const cfg = sp.cfg
    const rand = f.rand
    const dt = TICK_S
    f.px = f.x
    f.py = f.y
    f.pz = f.z

    // The startle wave reaching this fish: it bolts at its own speed, a little off the shoal's line, and the wander is re-aimed so it stays on that line when the bolt ends.
    if (f.boltIn > 0) {
      f.boltIn -= dt
      if (f.boltIn <= 0) {
        f.mood = 'bolt'
        f.moodLeft = cfg.boltFor * (0.6 + 0.8 * rand())
        f.speed = cfg.boltSpeed * (0.7 + 0.6 * rand())
        f.wander = school.fleeAt + (rand() - 0.5) * 1.2
        this.setOff(f)
      }
    }
    // Moods. Pike cycle glide -> lurk -> burst -> glide; bass and glimmerfin fidget, each fish on its own clock: a dart or a hang, with a kick to the heading either way.
    f.moodLeft -= dt
    if (cfg.glide) {
      if (f.moodLeft <= 0) {
        if (f.mood === 'glide') { f.mood = 'lurk'; f.moodLeft = between(rand, cfg.lurk); f.speed = cfg.lurkSpeed }
        else if (f.mood === 'lurk') { f.mood = 'burst'; f.moodLeft = cfg.burst; f.speed = cfg.burstSpeed; f.wander += (rand() - 0.5) * 1.5; this.setOff(f) }
        else { f.mood = 'glide'; f.moodLeft = between(rand, cfg.glide); f.speed = cfg.cruise }
      }
    } else if (cfg.fidgetEvery) {
      if (f.moodLeft <= 0) {
        if (f.mood === 'glide') { f.mood = 'fidget'; f.moodLeft = cfg.fidgetFor * (0.7 + 0.6 * rand()); f.speed = rand() < 0.6 ? cfg.fidgetSpeed : cfg.cruise / 3; f.wander += (rand() - 0.5) * 3; this.setOff(f) }
        else { f.mood = 'glide'; f.moodLeft = between(rand, cfg.fidgetEvery); f.speed = cfg.cruise }
      }
    }

    // The probe: bed and surface under the fish, and the water ahead of it along its velocity. Staggered so the bed's heightAt calls spread across ticks. A big fish wants proportionally more water ahead. A fish that has beached anyway is put back at the anchor, the one spot known to be deep.
    if ((tick + f.probeAt) % PROBE_EVERY === 0) {
      const level = this.water.levelAt(f.x, f.z)
      if (level === null || level - this.height.heightAt(f.x, f.z) < BED_MARGIN + SURFACE_MARGIN) {
        this.beached++
        f.x = school.x
        f.z = school.z
        f.level = this.water.levelAt(f.x, f.z)
        f.bed = this.height.heightAt(f.x, f.z)
        if (f.level === null) throw new Error(`Fish: the anchor of ${school.key} is on dry ground at (${f.x.toFixed(1)}, ${f.z.toFixed(1)})`)
        f.y = this.column(f.bed, f.level, f.depthFrac, f.margin)
      } else {
        f.level = level
        f.bed = this.height.heightAt(f.x, f.z)
      }
      const spd = Math.hypot(f.vx, f.vz)
      const ux = spd > 0.02 ? f.vx / spd : Math.cos(f.wander)
      const uz = spd > 0.02 ? f.vz / spd : Math.sin(f.wander)
      const ax = f.x + ux * cfg.lookahead
      const az = f.z + uz * cfg.lookahead
      const aheadLevel = this.water.levelAt(ax, az)
      const shallow = aheadLevel === null || aheadLevel - this.height.heightAt(ax, az) < cfg.minDepth * 0.6 * Math.max(1, f.scale)
      if (shallow && f.homing <= 0) f.homing = 1.5
    }
    if (f.homing > 0) f.homing -= dt

    // Heading: a random walk, pulled toward the fish's own station in the school when it has strayed, or turned hard for the anchor itself when the shore is ahead. The anchor is always in deep water (the chain), so it is the one heading that is known to be safe.
    f.wander += (rand() - 0.5) * cfg.wander * f.verve * Math.sqrt(dt) * 2
    let dx = Math.cos(f.wander)
    let dz = Math.sin(f.wander)
    f.station += f.orbit * dt
    const ax = school.x + Math.cos(f.station) * f.ring - f.x
    const az = school.z + Math.sin(f.station) * f.ring - f.z
    const ad = Math.hypot(ax, az)
    if (f.homing > 0) {
      const hx = school.x - f.x
      const hz = school.z - f.z
      const hd = Math.hypot(hx, hz)
      if (hd > 0.5) {
        dx = (hx / hd) * 2
        dz = (hz / hd) * 2
        // Re-aim the walk itself, so the fish is still heading in when the timer runs out rather than turning straight back.
        f.wander = Math.atan2(hz, hx)
      }
    }
    if (f.lure !== null) {
      const off = Math.atan2(f.lure.z - f.z, f.lure.x - f.x) - f.wander
      const swing = Math.atan2(Math.sin(off), Math.cos(off))
      f.wander += Math.max(-LURE_TURN * dt, Math.min(LURE_TURN * dt, swing))
      dx = Math.cos(f.wander)
      dz = Math.sin(f.wander)
    }
    const stray = f.lure !== null ? 0 : ad / cfg.schoolRadius
    if (stray > 0.6) {
      const pull = f.mood === 'bolt' ? 3 : Math.min(2.5, (stray - 0.6) * 1.5)
      dx += (ax / ad) * pull
      dz += (az / ad) * pull
    }
    // The ease: over the segment's last EASE_S the heading leans onto the end station too.
    const ease = w > 0 && !f.lured
    if (ease) {
      const ex = f.ex - f.x
      const ez = f.ez - f.z
      const ed = Math.max(0.2, Math.hypot(ex, ez))
      dx += (ex / ed) * w * 2.5
      dz += (ez / ed) * w * 2.5
    }
    // Separation: from school-mates, or for a solo species from every other school of its kind in the bed, at its anchor for this tick -- closed-form, where the other body's integrated position would depend on which school stepped first and how far behind it was. Other species are ignored; they are going about their own business.
    const sep = cfg.separation
    dx += Fish._apart(f, school.members, sep, 0)
    dz += Fish._apart(f, school.members, sep, 1)
    if (cfg.school[1] === 1) {
      for (const s of school.tile.schools) {
        if (s.sp !== sp || s === school) continue
        this._anchorAt(s, tNow, _o)
        const gx = f.x - _o.x, gz = f.z - _o.z
        const d2 = gx * gx + gz * gz
        if (d2 < sep * sep && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          dx += (gx / d) * ((sep - d) / sep) * 2
          dz += (gz / d) * ((sep - d) / sep) * 2
        }
      }
    }
    const dl = Math.hypot(dx, dz) || 1
    // A fish left behind swims harder to rejoin: without this a shoal that cruises slower than its anchor drifts never catches it.
    const speed = (f.lure !== null ? cfg.cruise * LURE_HASTE : f.speed) * f.pace * Math.max(1, Math.min(2.5, stray))
    const wantX = (dx / dl) * speed
    const wantZ = (dz / dl) * speed
    const k = Math.min(1, cfg.agility * (f.lure !== null ? LURE_AGILITY : 1) * dt)
    f.vx += (wantX - f.vx) * k
    f.vz += (wantZ - f.vz) * k

    // Depth: chase the fish's own place in the column, bobbing slowly about it; the school's anchor y draws it too so a shoal rises and sinks together. A lured fish chases the hand's height, within the column.
    const lo = f.bed + BED_MARGIN + f.margin
    const hi = f.level - SURFACE_MARGIN - f.margin
    const bob = 0.06 * Math.sin(tNow * TAU * f.bobHz + f.bobAt)
    const target = f.lure !== null ? Math.max(lo, Math.min(hi, f.lure.y)) : 0.5 * (this.column(f.bed, f.level, f.depthFrac + bob, f.margin) + school.y)
    const wantY = Math.max(-0.4, Math.min(0.4, (target - f.y) * 0.6)) * Math.max(0.3, speed / cfg.cruise)
    f.vy += (wantY - f.vy) * Math.min(1, 2 * dt)

    f.x += f.vx * dt
    f.y += f.vy * dt
    f.z += f.vz * dt
    // The ease closes the gap to the end station, so the turn's snap onto it is nothing the eye reads.
    if (ease) {
      const ke = Math.min(1, w * EASE_PULL * dt)
      f.x += (f.ex - f.x) * ke
      f.y += (f.ey - f.y) * ke
      f.z += (f.ez - f.z) * ke
    }
    if (f.y < lo) { f.y = lo; if (f.vy < 0) f.vy = 0 }
    if (f.y > hi) { f.y = Math.max(lo, hi); if (f.vy > 0) f.vy = 0 }
  }

  /** The push on `f` away from the `others` within `sep` metres, along axis 0 (x) or 1 (z). */
  static _apart(f, others, sep, axis) {
    let push = 0
    for (const g of others) {
      if (g === f || !g.alive) continue
      const gx = f.x - g.x
      const gz = f.z - g.z
      const d2 = gx * gx + gz * gz
      if (d2 < sep * sep && d2 > 1e-6) {
        const d = Math.sqrt(d2)
        push += ((axis === 0 ? gx : gz) / d) * ((sep - d) / sep) * 2
      }
    }
    return push
  }

  // --- the lures --------------------------------------------------------------

  /** The lure fish `f` is on this frame: the nearest of `lures` it wants, noticed within LURE_M of the hand and kept to LURE_FORGET_M -- from LURE_M on when a peer's set says that hand already has it. Taken up at a dart the ear hears, let go of at a cruise. */
  _notice(f, lures) {
    const tall = PREY.heightM * this.size
    if (f.size > PREY.nibble * tall) {
      const her = this.her
      const d = Math.hypot(her.x - f.x, her.y - f.y, her.z - f.z)
      if (d <= PREY.notice * f.size * (f.lure === her ? 2 : 1)) {
        if (f.lure !== her) { f.lure = her; f.lured = true; f.speed = f.school.sp.cfg.cruise * LURE_HASTE; this.setOff(f) }
        return
      }
    }
    if (f.lure === this.her) f.lure = null
    let lure = null
    let best = Infinity
    for (const l of lures) {
      if (!LURES.includes(l.kind)) continue
      const d = Math.hypot(l.x - f.x, l.y - f.y, l.z - f.z)
      if (d < best) { best = d; lure = l }
    }
    if (lure !== null) {
      const set = lure.by !== null ? this.luredIn.get(f.tile.key) : undefined
      const kept = f.lured || (set !== undefined && set.by === lure.by && set.has.has(f.index))
      if (best <= (kept ? LURE_FORGET_M : LURE_M)) {
        f.lure = lure
        if (!f.lured) { f.lured = true; f.speed = f.school.sp.cfg.cruise * LURE_HASTE; this.setOff(f) }
        return
      }
    }
    if (!f.lured) return
    f.lured = false
    f.lure = null
    f.speed = f.school.sp.cfg.cruise
  }

  /** Her size, a multiple of her full height: which fish take her for prey (PREY). */
  sized(size) {
    if (!(size > 0)) throw new Error(`Fish.sized: ${size}`)
    this.size = size
  }

  /** Every fish on her within half its length of her head bites her, or, over PREY.gulp times her height, swallows her and no other fish gets a bite. */
  _prey(now) {
    const her = this.her
    const tall = PREY.heightM * this.size
    for (const t of this.tiles.values()) {
      for (const f of t.fish) {
        if (f.lure !== her || Math.hypot(her.x - f.x, her.y - f.y, her.z - f.z) > f.size * 0.5) continue
        const why = `a ${f.school.sp.id}`
        if (f.size > PREY.gulp * tall) {
          if (this.swallow === null) throw new Error('Fish: a fish swallows her, and no swallow() to end her with')
          this.swallow(why)
          return
        }
        if (now - f.bitT < PREY.biteS) continue
        if (this.harm === null) throw new Error('Fish: a fish bites her, and no harm() to hurt her with')
        f.bitT = now
        this.harm(PREY.harm, why)
      }
    }
  }

  /** The lured sets owed since the last call, pushed onto `into` (creature-net.js): `[bedKey, 'fs', null, indices]`, one a bed. */
  pendingLured(into = []) {
    for (const set of this.owed) into.push(set)
    this.owed.length = 0
    return into
  }

  /** A peer's lured set for one of the beds: the fish its hand has, kept from LURE_M on while that hand's lure is near them. */
  applyLured(set) {
    if (!Array.isArray(set) || set.length !== 4 || typeof set[0] !== 'string' || !Array.isArray(set[3])) throw new Error(`Fish.applyLured: bad set ${JSON.stringify(set)}`)
    if (set[3].length === 0) this.luredIn.delete(set[0])
    else this.luredIn.set(set[0], { by: set[2], has: new Set(set[3]) })
  }

  /** Bed `t`'s lured set owed when the fish her own hand has changed since the last sent and LURED_EVERY_S has passed, or when they are none now and were not. */
  _owe(t, now) {
    let mine = ''
    for (const f of t.fish) if (f.lured && f.lure.by === null && f.lure !== this.her) mine += `${f.index},`
    if (mine === t.luredSent) return
    if (mine !== '' && now - t.luredAt < LURED_EVERY_S) return
    t.luredSent = mine
    t.luredAt = now
    this.owed.push([t.key, 'fs', null, mine === '' ? [] : mine.slice(0, -1).split(',').map(Number)])
  }

  // --- her hand ---------------------------------------------------------------

  /**
   * The drawn fish nearest a hand at (x, y, z) whose body -- a ball of its own
   * length -- is within `reach` metres, and shorter than `maxSize`: `{ dist,
   * sp, f, size }` for take(), or null. Nothing while the fish are not drawn,
   * which is whenever her head is out of the water. For hands.js.
   */
  pickAt(x, y, z, reach, maxSize) {
    if (!this.batch.visible) return null
    let best = null
    let bestD = reach
    for (const sp of this.species) {
      if (!sp.mesh.visible) continue
      for (const f of sp.slots) {
        if (!f.alive || f.size >= maxSize) continue
        const d = Math.hypot(f.x - x, f.y - y, f.z - z) - f.size * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), sp, f, size: f.size }
        }
      }
    }
    return best
  }

  /**
   * Grab the fish of a pickAt() hit: out of its school and, unless it was
   * loose, recorded in taken.js as `fish<index>` at its bed's home so the bed
   * never grows it back, here or on any peer. What the hand holds is returned
   * as a record for hands.js -- the species' geometry and material, its tail's
   * phase and beat, its tint and hue, its scale. Only a fish under a metre may
   * go in the backpack; `stowMax` says where that is.
   */
  take(hit, stowMax) {
    const { sp, f } = hit
    if (!f.alive) throw new Error(`Fish.take: a dead ${sp.id}`)
    const rec = {
      kind: 'fish',
      name: sp.id,
      size: f.size,
      geometry: sp.mesh.geometry,
      material: sp.material,
      attrs: { aSwim: [f.phase, f.amp, 0, 0], aHue: [f.hue] },
      color: [f.tint, f.tint, f.tint],
      scale: [f.scale, f.scale, f.scale],
      stowable: f.size < stowMax,
    }
    if (f.loose) this.unslot(sp, f)
    else {
      taken.add(`fish${f.index}`, f.school.home.x, f.school.home.z)
      this._drop(sp, f)
    }
    return rec
  }

  /**
   * A peer took the fish `fish<index>` of the bed whose home is (x, z): take
   * it here too, drawn or not, and record the place. True when a resident bed
   * has that school with that member; a loose fish is nobody's to evict. For
   * hands-net.js.
   */
  evict(key, x, z) {
    if (!key.startsWith('fish')) return false
    const index = Number(key.slice(4))
    if (!Number.isInteger(index)) return false
    for (const t of this.tiles.values()) {
      for (const school of t.schools) {
        if (Math.abs(school.home.x - x) >= TOLERANCE_M || Math.abs(school.home.z - z) >= TOLERANCE_M) continue
        const f = school.members.find((m) => m.index === index)
        if (!f) continue
        this.take({ dist: 0, sp: school.sp, f, size: f.size }, Infinity)
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed fish record is drawn with, by the species its name is, or null until that species' asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'fish') throw new Error(`Fish.dress: not a fish, ${slot.kind}`)
    const sp = this.species.find((s) => s.id === slot.name)
    if (!sp) throw new Error(`Fish.dress: no species ${slot.name}`)
    if (!sp.loaded) return null
    return { geometry: sp.mesh.geometry, material: sp.material }
  }

  /**
   * Let a taken fish go at (x, y, z). In water of any depth -- the shallows
   * off a bank she stands on included -- it hangs stunned for STUN_S,
   * then wakes and darts from her head until it is LOOSE_GONE_M out, where
   * the layer forgets it. Out of water it is false, and hands.js beaches it.
   * A loose fish is this client's alone: the room sees the drop through
   * hands-net.js, and each client swims its own copy off.
   */
  release(rec, x, y, z, head) {
    if (rec.kind !== 'fish') throw new Error(`Fish.release: not a fish, ${rec.kind}`)
    const level = this.water.levelAt(x, z)
    if (level === null) return false
    const bed = this.height.heightAt(x, z)
    if (y > level || bed >= level) return false
    const sp = this.species.find((s) => s.id === rec.name)
    if (!sp) throw new Error(`Fish.release: no species ${rec.name}`)
    const f = sp.free.pop()
    if (!f) return false
    const rand = this.rand
    f.alive = true
    f.loose = true
    f.school = null
    f.tile = null
    f.index = -1
    f.x = f.px = x; f.y = f.py = y; f.z = f.pz = z
    f.vx = f.vy = f.vz = 0
    f.scale = rec.scale[0]
    f.size = rec.size
    f.margin = 0.2 * f.size
    f.bed = bed
    f.level = level
    // Facing away from her, lying as it was dropped.
    f.wander = Math.atan2(z - head.z, x - head.x)
    f.hx = Math.cos(f.wander)
    f.hz = Math.sin(f.wander)
    f.pitch = 0
    f.roll = 0
    f.curve = 0
    f.lift = 0
    f.pace = (0.8 + 0.4 * rand()) * Math.sqrt(f.scale)
    f.beat = (0.85 + 0.3 * rand()) / Math.sqrt(f.scale)
    f.verve = 1
    f.tint = rec.color[0]
    f.hue = rec.attrs.aHue[0]
    f.phase = rec.attrs.aSwim[0]
    f.amp = 0
    f.probeAt = 0
    f.homing = 0
    f.boltIn = 0
    f.lure = null
    f.lured = false
    f.mood = 'glide'
    f.moodLeft = Infinity
    f.speed = 0
    f.stun = between(rand, STUN_S)
    f.listedAt = -1
    return true
  }

  /**
   * One frame of a loose fish: stunned, it sinks a little and drifts to a
   * stop; awake, it runs from her head at LOOSE_HASTE times its cruise with a
   * jink every LOOSE_JINK seconds, turning along the shore where the water
   * ahead is shallow and shallower than here, and is forgotten LOOSE_GONE_M
   * out or beached. Water too thin for the margins holds it mid-column.
   */
  stepLoose(sp, f, dt) {
    const cfg = sp.cfg
    const rand = this.rand
    const head = this.head
    const dx0 = f.x - head.x, dz0 = f.z - head.z
    if (dx0 * dx0 + dz0 * dz0 > LOOSE_GONE_M * LOOSE_GONE_M) return this.unslot(sp, f)
    if (this.frame % PROBE_EVERY === 0) {
      const level = this.water.levelAt(f.x, f.z)
      const bed = this.height.heightAt(f.x, f.z)
      if (level === null || bed >= level) return this.unslot(sp, f)
      f.level = level
      f.bed = bed
    }
    if (f.stun > 0) {
      f.stun -= dt
      f.vx *= Math.max(0, 1 - 2 * dt)
      f.vz *= Math.max(0, 1 - 2 * dt)
      f.vy += (-0.05 - f.vy) * Math.min(1, 2 * dt)
      if (f.stun <= 0) {
        f.speed = cfg.cruise * LOOSE_HASTE
        f.moodLeft = 0
        this.setOff(f)
      }
    } else {
      f.moodLeft -= dt
      if (f.moodLeft <= 0) {
        f.moodLeft = LOOSE_JINK * (0.5 + rand())
        // Away from her, jinked up to a quarter turn either side.
        f.wander = Math.atan2(dz0, dx0) + (rand() - 0.5) * (Math.PI / 2)
      }
      if (this.frame % PROBE_EVERY === 0) {
        const ax = f.x + f.hx * cfg.lookahead
        const az = f.z + f.hz * cfg.lookahead
        const aheadLevel = this.water.levelAt(ax, az)
        if (aheadLevel === null || aheadLevel - this.height.heightAt(ax, az) < Math.min(cfg.minDepth * 0.6 * Math.max(1, f.scale), f.level - f.bed)) {
          // Shore ahead: a quarter turn, to whichever side leads further from her.
          const left = f.wander + Math.PI / 2
          const right = f.wander - Math.PI / 2
          const lx = f.x + Math.cos(left) - head.x, lz = f.z + Math.sin(left) - head.z
          const rx = f.x + Math.cos(right) - head.x, rz = f.z + Math.sin(right) - head.z
          f.wander = lx * lx + lz * lz > rx * rx + rz * rz ? left : right
          f.moodLeft = LOOSE_JINK
        }
      }
      const speed = f.speed * f.pace
      const k = Math.min(1, cfg.agility * 2 * dt)
      f.vx += (Math.cos(f.wander) * speed - f.vx) * k
      f.vz += (Math.sin(f.wander) * speed - f.vz) * k
      const target = this.column(f.bed, f.level, 0.5, f.margin)
      f.vy += (Math.max(-0.4, Math.min(0.4, (target - f.y) * 0.6)) - f.vy) * Math.min(1, 2 * dt)
    }
    f.x += f.vx * dt
    f.y += f.vy * dt
    f.z += f.vz * dt
    const lo = f.bed + BED_MARGIN + f.margin
    const hi = f.level - SURFACE_MARGIN - f.margin
    if (hi <= lo) { f.y = (f.bed + f.level) / 2; f.vy = 0 }
    else if (f.y < lo) { f.y = lo; if (f.vy < 0) f.vy = 0 }
    else if (f.y > hi) { f.y = hi; if (f.vy > 0) f.vy = 0 }
  }

  // --- the ear ----------------------------------------------------------------

  /** The fish has just taken a new target speed: listed for the ear if it is a fast one, once a frame. */
  setOff(f) {
    if (f.speed >= DART_SPEED && f.listedAt !== this.frame) {
      f.listedAt = this.frame
      this.startles.push(f)
    }
  }

  /** The fish that set off at DART_SPEED or more this frame, for the ear (audio/ambience.js): the slots themselves, with x, y, z and `size` (its length in metres) on them, each once. A hidden layer lists nobody. */
  startled(into) {
    if (!this.batch.visible) return into
    for (const f of this.startles) into.push(f)
    return into
  }

  // --- the frame --------------------------------------------------------------

  /**
   * Her head out of the water: the beds follow her along the shore so the
   * water around her is stocked the moment she goes under, and nothing is
   * stepped or drawn. Cheap: the beds are walked only once she has moved
   * WALK_M, so a forest far from any water pays nothing for the fish.
   */
  follow(x, y, z) {
    this.head.x = x
    this.head.y = y
    this.head.z = z
    this._walkTiles(x, z)
  }

  /**
   * One frame with her head under, at the room's clock `now`: the beds
   * follow her, the lures are noticed, every school is ticked up to `now`
   * and the instance buffers written. `lures`: hands.js lures() this frame,
   * the spiders, butterflies and grasshoppers among them swum at.
   */
  update(x, y, z, now, lures = NO_LURES) {
    if (!Number.isFinite(now)) throw new Error(`Fish.update: bad time ${now}`)
    this.head.x = x
    this.head.y = y
    this.head.z = z
    this._walkTiles(x, z)
    this.frame++
    // The frame's own seconds, for the tail, the facing and the loose fish; the ticks run on `now` itself.
    const dt = this.now === null ? 0 : Math.min(0.1, Math.max(0, now - this.now))
    this.now = now
    this.startles.length = 0
    this.her.x = x
    this.her.y = y
    this.her.z = z
    for (const t of this.tiles.values()) {
      for (const f of t.fish) this._notice(f, lures)
      this._owe(t, now)
    }

    let stepped = 0
    for (const sp of this.species) {
      const cfg = sp.cfg
      for (const school of sp.schools) {
        const g = Math.floor((now - school.offset) / GRID_S)
        if (school.seg !== g) this._reset(sp, school, g)
        stepped = Math.max(stepped, stepTo(school.rec, now, (tick) => this._tick(sp, school, tick), CATCH_UP_TICKS))
      }

      const mat = sp.mesh.instanceMatrix.array
      const col = sp.mesh.instanceColor.array
      const swim = sp.swim.array
      const hue = sp.hue.array
      let n = 0
      for (const f of sp.slots) {
        if (!f.alive) continue
        let x, y, z
        if (f.loose) {
          this.stepLoose(sp, f, dt)
          if (!f.alive) continue
          x = f.x; y = f.y; z = f.z
        } else {
          const a = f.school.rec.alpha
          x = f.px + (f.x - f.px) * a
          y = f.py + (f.y - f.py) * a
          z = f.pz + (f.z - f.pz) * a
        }

        // Facing chases velocity; the pitch is read straight off it and the roll leans into the turn.
        const spd = Math.hypot(f.vx, f.vz)
        // Cross product of the facing and the velocity's direction: the sine of the turn in hand, negative to the left.
        let turn = 0
        if (spd > 0.02) {
          const k = Math.min(1, 6 * dt)
          const wantX = f.vx / spd
          const wantZ = f.vz / spd
          turn = f.hx * wantZ - f.hz * wantX
          f.hx += (wantX - f.hx) * k
          f.hz += (wantZ - f.hz) * k
          const hl = Math.hypot(f.hx, f.hz) || 1
          f.hx /= hl
          f.hz /= hl
          f.roll += (-turn * 0.5 - f.roll) * k
        } else {
          f.roll += (0 - f.roll) * Math.min(1, 3 * dt)
        }
        const wantPitch = Math.atan2(f.vy, Math.max(spd, 0.05))
        const climb = wantPitch - f.pitch
        f.pitch += climb * Math.min(1, 4 * dt)

        // The body arcs into the turn: the tail swings to the inside (left turn, tail left), by up to 0.4 of the length on a hard turn. Vertically it arcs the same way, and keeps arcing for as long as the fish holds a pitch, so a climbing or diving fish is a curve and not a tilted board.
        const kb = Math.min(1, 8 * dt)
        f.curve += (Math.max(-0.4, Math.min(0.4, turn * 2)) * sp.lengthM - f.curve) * kb
        f.lift += (Math.max(-0.3, Math.min(0.3, climb * 1.5 + f.pitch * 0.8)) * sp.lengthM - f.lift) * kb

        // Tail rate follows speed, relative to this fish's own cruise: idle sculling at 40% of its beat, a burst at nearly three times it. The beat deepens through a turn, since a turn is driven by the tail.
        const rel = Math.hypot(f.vx, f.vy, f.vz) / (cfg.cruise * f.pace)
        f.phase = (f.phase + dt * TAU * cfg.tailHz * f.beat * (0.4 + 0.6 * rel)) % TAU
        f.amp = cfg.tailAmp * sp.lengthM * Math.min(1.6, 0.5 + 0.5 * rel) * (1 + 2 * Math.abs(turn))
        // A stunned fish does not scull.
        if (f.stun > 0) f.amp = 0

        // Local -Z is the nose (ship.mjs turns every pick that way), so yaw = atan2(-hx, -hz) points it down the heading.
        _euler.set(f.pitch, Math.atan2(-f.hx, -f.hz), f.roll)
        _quat.setFromEuler(_euler)
        _pos.set(x, y, z)
        _scl.setScalar(f.scale)
        _mat.compose(_pos, _quat, _scl)
        _mat.toArray(mat, n * 16)
        col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = f.tint
        swim[n * 4] = f.phase
        swim[n * 4 + 1] = f.amp
        swim[n * 4 + 2] = f.curve
        swim[n * 4 + 3] = f.lift
        hue[n] = f.hue
        n++
      }
      sp.mesh.count = n
      sp.mesh.instanceMatrix.needsUpdate = true
      sp.mesh.instanceColor.needsUpdate = true
      sp.swim.needsUpdate = true
      sp.hue.needsUpdate = true
    }
    this._prey(now)
    // A catch-up frame (a join, a clock skip) darts nobody in the ear: she was not there for it.
    if (stepped > SILENT_TICKS) this.startles.length = 0
  }

  dispose() {
    for (const sp of this.species) {
      sp.mesh.geometry.dispose()
      sp.material.map?.dispose()
      sp.material.dispose()
    }
    if (this.batch.parent) this.batch.parent.remove(this.batch)
  }
}
