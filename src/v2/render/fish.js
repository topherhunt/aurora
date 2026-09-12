import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import { packedPbr } from './critters.js'

// ---------------------------------------------------------------------------
// Fish: every authored lake and river stocked with the three roster species,
// swimming on their own with nothing to react to but each other and the shore.
//
// THE POOL FOLLOWS HER. Underwater visibility is 20 m (water.js UNDERWATER) and
// the surface is nearly opaque from above, so a fish 100 m away is a fish
// nobody can see. Every species has a fixed pool of slots that only ever hold
// fish inside POOL_RADIUS of her head: a school whose anchor drifts past
// RETIRE_RADIUS is retired whole and its slots re-seeded at a fresh site in the
// disc, found by rejection sampling against the water and the bed. A full pool
// also turns over as she swims: every few metres of her travel, the school
// farthest out past the murk is recycled, so the water ahead of her is never
// empty just because the water behind her was full. Standing on dry land, the
// sampling fails and the pool simply empties. Nothing is stored per tile: the
// fish are not a function of position the way the plants are, so leaving a
// lake and coming back meets a different shoal.
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
// NO NEIGHBOUR SEARCH. Separation runs only inside a school, and a school is
// at most 14 fish, so the whole step is linear in the pool. Pike keep apart
// from other pike by a scan over their own ten slots. Bed and surface are
// probed every PROBE_EVERY frames per fish and cached, because heightAt is the
// one thing in this file that is not arithmetic.
//
// THE TAIL IS THE SHADER'S. public/fauna/fish.json (tools/fauna/ship.mjs)
// carries each species' picked Tripo mesh, nose at -Z, with a per-vertex
// swim-bend weight, and each fish is one InstancedMesh instance with (phase,
// amplitude, curve, lift): the vertex stage bends every vertex sideways by
// bend * (amplitude * sin(phase - k * z) + curve) and up by bend * lift. The
// CPU advances the phase at a rate that follows the fish's speed, so a lurking
// pike barely sculls and a bolting glimmerfin is a blur, and it sets curve and
// lift from the turn and the pitch in hand, so the body arcs into every turn
// and climb and the tail beats harder through it: a fish never swings round
// or tilts straight as a board.
// ---------------------------------------------------------------------------

const ASSET_URL = 'fauna/fish.json'
const TEXTURE_URL = (file) => `fauna/${file}`

// The seed disc and the retire ring, both sized against the 20 m murk: 40% of the disc is in sight, and a school is gone before it is 20 m past it.
export const POOL_RADIUS = 32
export const RETIRE_RADIUS = 40
// No school seeds closer than this to her head: a shoal appearing at arm's length is the pop-in the whole pool exists to hide.
const NEAR_RADIUS = 10
// A school past this is out of sight and may be recycled once she has swum RECYCLE_TRAVEL metres, per species. Standing still recycles nothing; 30 m of swimming turns most of the pool over.
export const RECYCLE_RADIUS = 24
const RECYCLE_TRAVEL = 3
// Seconds a newborn takes to grow to size, so a school seeded at the edge of the murk swims in rather than popping in.
const BORN_FOR = 1.5
// Water this deep, under a fish's own spot, hands out the species' full size ceiling; 0.5 m hands out the shore's.
const DEEP_M = 12
// Seed attempts per frame across all species. A lake shore is roughly half water, so a dozen tries a frame refills an emptied pool in well under a second.
const SEEDS_PER_FRAME = 12
const PROBE_EVERY = 4
// A startle crosses a shoal at BOLT_WAVE m/s, each fish reacting up to BOLT_JITTER s late on top, and BOLT_MISS of the shoal never bolts at all: a fright is a ripple through the shoal, never one frame's broadcast.
const BOLT_WAVE = 4
const BOLT_JITTER = 0.4
const BOLT_MISS = 0.15
// How far off the bed and under the surface a fish is held, in metres, plus a fifth of its own length. The probe is PROBE_EVERY frames stale, so this also covers the distance a bolting fish crosses between probes.
const BED_MARGIN = 0.25
const SURFACE_MARGIN = 0.3

/**
 * The species table. Speeds in m/s, times in seconds, depths as a fraction of
 * the water column measured up from the bed. `minDepth` is the column a
 * school will seed in and `clearance` how far around an anchor that column
 * must extend; `wander` is the heading's random walk in rad/s^0.5; `agility`
 * is how fast velocity chases its target, 1/s. `size` is the scale drawn at
 * the shore and the ceiling reached in DEEP_M of water (see sizeAt); `sizeVary`
 * a jitter on top. `fidget` is one fish's own dart or hang: every
 * `fidgetEvery` seconds, `fidgetFor` seconds at `fidgetSpeed` or at a third of
 * cruise, with a kick to the heading.
 */
export const SPECIES = {
  'ironscale-bass': {
    count: 72, school: [4, 9], schoolRadius: 3, separation: 0.5,
    minDepth: 1.0, clearance: 3, depth: [0.3, 0.7],
    cruise: 0.55, agility: 1.4, wander: 0.9, lookahead: 3,
    tailHz: 2.0, tailAmp: 0.11, size: [0.55, 2.6], sizeVary: 0.2,
    anchorSpeed: 0.3, anchorHop: [6, 14], anchorEvery: [8, 16],
    fidgetEvery: [3, 9], fidgetSpeed: 1.3, fidgetFor: 0.5,
    material: { color: 0xffffff },
  },
  'rime-fangpike': {
    count: 10, school: [1, 1], schoolRadius: 6, separation: 6,
    minDepth: 1.5, clearance: 2.5, depth: [0.08, 0.3],
    cruise: 0.28, agility: 0.8, wander: 0.35, lookahead: 6,
    tailHz: 1.1, tailAmp: 0.08, size: [0.6, 2.6], sizeVary: 0.25,
    anchorSpeed: 0.2, anchorHop: [8, 20], anchorEvery: [10, 24],
    // The three moods of an ambush predator: seconds in each, and the speed it holds.
    glide: [6, 14], lurk: [4, 10], lurkSpeed: 0.03, burst: 0.9, burstSpeed: 2.2,
    material: { color: 0xffffff },
  },
  'glimmerfin': {
    count: 90, school: [6, 14], schoolRadius: 1.2, separation: 0.25,
    minDepth: 0.5, clearance: 1.5, depth: [0.6, 0.9],
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

export class Fish {
  /**
   * `height.heightAt(x, z)` is the bed and `water.levelAt(x, z)` the surface
   * (null on dry land) -- the two questions the pool asks the world. The
   * materials exist from construction so the host can patch them for lighting
   * before the assets land; the geometry arrives asynchronously via `ready`,
   * or at once from `assets`, the parsed fish.json, which is how a gate runs
   * this without a page.
   */
  constructor(scene, height, water, { seed = 1, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function') throw new Error('Fish needs a height field with heightAt(x, z)')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Fish needs WaterSurfaces, for levelAt(x, z)')
    this.height = height
    this.water = water
    this.rand = mulberry32(seed)

    this.batch = new THREE.Group()
    this.batch.name = 'v2-fish'
    scene.add(this.batch)

    this.species = []
    for (const [id, cfg] of Object.entries(SPECIES)) this.species.push(this.makeSpecies(id, cfg))

    this.frame = 0
    this.time = 0
    this.head = { x: 0, y: 0, z: 0 }
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
    // The glint is critters.js's packedPbr: Standard, roughness from the alpha of the colour map ship.mjs packs, metalness the species' one number from the same bake. Opaque and front-faced: a Tripo fish is a closed volume whose fins are two sheets a hair apart (tripo-culling.js), and nothing here sorts.
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, ...cfg.material })
    // The swim bend. `aBend` is ship.mjs's per-vertex weight (0 at the nose, 1 at the tail tip); `aSwim` is per instance: phase, amplitude, and the turn's sideways curve and the climb's lift, all in local metres. The wave number is a literal scaled to the species' length, so a pike's wave is one body length long just like a glimmerfin's.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aBend;\nattribute vec4 aSwim;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += aBend * ( aSwim.y * sin( aSwim.x - FISH_WAVE_K * position.z ) + aSwim.z );\ntransformed.y += aBend * aSwim.w;')
      packedPbr(shader)
    }
    material.customProgramCacheKey = () => `fish-${id}`
    material.defines = { FISH_WAVE_K: '0.0' }

    const slots = []
    for (let i = 0; i < cfg.count; i++) {
      slots.push({
        alive: false, school: null,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        // Smoothed facing, so a fish that stops does not snap to whatever its last velocity happened to be.
        hx: 0, hz: -1, pitch: 0, roll: 0,
        wander: 0, depthFrac: 0.5, scale: 1, margin: 0, tint: 1, born: 0,
        phase: 0, amp: 0, curve: 0, lift: 0,
        // The fish's own rolls: speed and wander multipliers, tail-beat multiplier, and its station in the school -- a point `ring` metres from the anchor that circles it at `orbit` rad/s, plus a slow vertical bob.
        pace: 1, verve: 1, beat: 1, ring: 0, station: 0, orbit: 0, bobHz: 0.1, bobAt: 0,
        bed: 0, level: 0, probeAt: i % PROBE_EVERY,
        // Seconds left steering back to the anchor after the probe found the shore ahead, and until the shoal's startle reaches this fish.
        homing: 0, boltIn: 0,
        // Mood: pike glide/lurk/burst, bass and glimmerfin fidget. `speed` is the mood's target speed.
        mood: 'glide', moodLeft: 0, speed: cfg.cruise,
      })
    }
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), material, cfg.count)
    mesh.name = `v2-fish-${id}`
    mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    mesh.visible = false
    // The instances move every frame and the pool is a disc around the head anyway; a per-mesh sphere would have to be rebuilt each frame to cull anything.
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cfg.count * 3).fill(1), 3)
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(cfg.count * 4), 4)
    swim.setUsage(THREE.DynamicDrawUsage)
    mesh.geometry.setAttribute('aSwim', swim)
    cullTripoBackfaces(mesh)
    this.batch.add(mesh)
    // `travel` is the metres she has swum that this species has not yet spent on a recycle.
    return { id, cfg, material, mesh, swim, slots, free: slots.slice(), schools: [], loaded: false, lengthM: 0, travel: 0 }
  }

  /** public/fauna/fish.json and its three colour-plus-roughness maps. Throws on a roster mismatch rather than drawing a species as a blank. */
  async load() {
    const res = await fetch(ASSET_URL)
    if (!res.ok) throw new Error(`fish: ${ASSET_URL} answered ${res.status} -- run tools/fauna/ship.mjs`)
    const assets = await res.json()
    const loader = new THREE.TextureLoader()
    for (const sp of this.species) {
      const asset = this.assetFor(assets, sp)
      this.setAsset(sp, asset)
      const tex = await loader.loadAsync(TEXTURE_URL(asset.texture))
      // sRGB decodes the colour channels only; the roughness in alpha stays linear.
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
    if (!(asset.metalness >= 0 && asset.metalness <= 1)) throw new Error(`fish: ${sp.id} has no metalness -- run tools/fauna/ship.mjs`)
    sp.material.metalness = asset.metalness
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

  /** Drop every school and refill around (cx, cz). The ground moved, or she was put down somewhere new. */
  place(cx, cz) {
    for (const sp of this.species) {
      for (const school of sp.schools.slice()) this.retire(sp, school)
    }
    this.head.x = cx
    this.head.z = cz
    for (let i = 0; i < 400; i++) this.seed()
  }

  get stats() {
    const out = {}
    let alive = 0
    for (const sp of this.species) {
      const n = sp.cfg.count - sp.free.length
      out[sp.id] = { alive: n, schools: sp.schools.length }
      alive += n
    }
    out.alive = alive
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

  /** The vertical band at a site, [bed + margin, level - margin] widened by `extra` for a fish's own bulk, with `frac` of the way up it. */
  column(bed, level, frac, extra = 0) {
    const lo = bed + BED_MARGIN + extra
    const hi = level - SURFACE_MARGIN - extra
    if (hi <= lo) return (lo + hi) / 2
    return lo + (hi - lo) * frac
  }

  /**
   * A size for a fish born over `depth` metres of water. The ceiling climbs
   * from 0.8 at the shore to the species' size[1] at DEEP_M, and the draw's
   * skew turns over with it: shallow, most rolls land near the floor; deep,
   * most land near the ceiling and only the odd one is small.
   */
  sizeAt(cfg, depth) {
    const t = Math.max(0, Math.min(1, (depth - 0.5) / (DEEP_M - 0.5)))
    const ease = t * t * (3 - 2 * t)
    const top = 0.8 + (cfg.size[1] - 0.8) * ease
    const u = Math.pow(this.rand(), 2.2 - 1.75 * ease)
    return (cfg.size[0] + (top - cfg.size[0]) * u) * (1 + (this.rand() * 2 - 1) * cfg.sizeVary)
  }

  /**
   * One attempt to seed one school. The species with the most empty slots
   * goes first, so a lake never fills with bass while the shoals wait. Returns
   * true when a school was placed.
   */
  seed() {
    let sp = null
    let need = 0
    for (const s of this.species) {
      if (!s.loaded) continue
      const frac = s.free.length / s.cfg.count
      if (s.free.length >= s.cfg.school[0] && frac > need) { sp = s; need = frac }
    }
    if (!sp) return false
    const rand = this.rand
    const r = NEAR_RADIUS + (POOL_RADIUS - NEAR_RADIUS) * Math.sqrt(rand())
    const a = rand() * TAU
    const x = this.head.x + Math.cos(a) * r
    const z = this.head.z + Math.sin(a) * r
    const cfg = sp.cfg
    const at = this.site(sp, x, z, cfg.clearance)
    if (!at) return false
    // A solo species does not seed on top of its own kind: ten pike in a disc are otherwise two pike in a ditch now and then.
    if (cfg.school[1] === 1) {
      for (const g of sp.slots) {
        if (g.alive && Math.hypot(g.x - x, g.z - z) < cfg.separation) return false
      }
    }
    const { bed, level } = at
    const size = Math.min(sp.free.length, Math.round(between(rand, cfg.school)))
    const school = {
      x, z, tx: x, tz: z, y: this.column(bed, level, between(rand, cfg.depth)),
      hopLeft: between(rand, cfg.anchorEvery),
      boltLeft: cfg.boltEvery ? between(rand, cfg.boltEvery) : Infinity,
      fleeAt: 0,
      members: [],
    }
    for (let i = 0; i < size; i++) {
      const f = sp.free.pop()
      // Spread around the anchor, unless that spot is shore: the anchor itself is known-good, so a fish whose roll lands dry simply starts on it.
      const spread = size > 1 ? rand() * cfg.schoolRadius : 0
      const b = rand() * TAU
      let fx = x + Math.cos(b) * spread
      let fz = z + Math.sin(b) * spread
      let fLevel = this.water.levelAt(fx, fz)
      let fBed = fLevel === null ? 0 : this.height.heightAt(fx, fz)
      if (fLevel === null || fLevel - fBed < cfg.minDepth) { fx = x; fz = z; fLevel = level; fBed = bed }
      f.alive = true
      f.school = school
      f.x = fx
      f.z = fz
      f.depthFrac = between(rand, cfg.depth)
      f.bed = fBed
      f.level = fLevel
      f.scale = this.sizeAt(cfg, fLevel - fBed)
      f.margin = 0.2 * sp.lengthM * f.scale
      f.y = this.column(fBed, fLevel, f.depthFrac, f.margin)
      f.born = 0
      f.wander = rand() * TAU
      f.hx = Math.cos(f.wander)
      f.hz = Math.sin(f.wander)
      f.vx = f.hx * cfg.cruise
      f.vz = f.hz * cfg.cruise
      f.vy = 0
      f.pitch = 0
      f.roll = 0
      f.curve = 0
      f.lift = 0
      // A big fish swims faster and beats slower than a small one of its kind, and each has its own temperament on top.
      f.pace = (0.8 + 0.4 * rand()) * Math.sqrt(f.scale)
      f.beat = (0.85 + 0.3 * rand()) / Math.sqrt(f.scale)
      f.verve = 0.6 + rand() * rand() * 1.4
      f.ring = size > 1 ? (0.25 + 0.6 * rand()) * cfg.schoolRadius : 0
      f.station = b
      f.orbit = (rand() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rand())
      f.bobHz = 0.05 + 0.1 * rand()
      f.bobAt = rand() * TAU
      f.tint = 0.85 + rand() * 0.2
      f.phase = rand() * TAU
      f.homing = 0
      f.boltIn = 0
      f.mood = 'glide'
      f.moodLeft = cfg.glide ? between(rand, cfg.glide) : cfg.fidgetEvery ? between(rand, cfg.fidgetEvery) : Infinity
      f.speed = cfg.cruise
      school.members.push(f)
    }
    sp.schools.push(school)
    return true
  }

  retire(sp, school) {
    for (const f of school.members) {
      f.alive = false
      f.school = null
      sp.free.push(f)
    }
    school.members.length = 0
    const i = sp.schools.indexOf(school)
    if (i >= 0) sp.schools.splice(i, 1)
  }

  /** One fish out of its school and back to the free list; the school goes with it when it was the last. */
  drop(sp, f) {
    const school = f.school
    school.members.splice(school.members.indexOf(f), 1)
    f.alive = false
    f.school = null
    sp.free.push(f)
    if (!school.members.length) this.retire(sp, school)
  }

  /**
   * One frame: retire what drifted out, seed what is empty, step every school
   * and every fish, and write the instance buffers. (x, y, z) is her head.
   */
  update(x, y, z, dt) {
    const moved = Math.hypot(x - this.head.x, z - this.head.z)
    this.head.x = x
    this.head.y = y
    this.head.z = z
    this.frame++
    this.time += dt

    for (const sp of this.species) {
      let farthest = null
      let farD2 = 0
      for (let i = sp.schools.length - 1; i >= 0; i--) {
        const s = sp.schools[i]
        const dx = s.x - x
        const dz = s.z - z
        const d2 = dx * dx + dz * dz
        if (d2 > RETIRE_RADIUS * RETIRE_RADIUS) this.retire(sp, s)
        else if (d2 > farD2) { farthest = s; farD2 = d2 }
      }
      // The turnover: a full pool spends her travel on recycling its farthest out-of-sight school. The budget caps at a few recycles so a teleport does not empty the pool in one frame.
      sp.travel = Math.min(sp.travel + moved, RECYCLE_TRAVEL * 3)
      if (sp.free.length < sp.cfg.school[0] && sp.travel >= RECYCLE_TRAVEL && farthest && farD2 > RECYCLE_RADIUS * RECYCLE_RADIUS) {
        this.retire(sp, farthest)
        sp.travel -= RECYCLE_TRAVEL
      }
    }
    for (let i = 0; i < SEEDS_PER_FRAME; i++) this.seed()

    for (const sp of this.species) {
      const cfg = sp.cfg
      for (const school of sp.schools) this.stepSchool(sp, school, dt)

      const mat = sp.mesh.instanceMatrix.array
      const col = sp.mesh.instanceColor.array
      const swim = sp.swim.array
      let n = 0
      for (const f of sp.slots) {
        if (!f.alive) continue
        this.stepFish(sp, f, dt)
        if (!f.alive) continue

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

        // Local -Z is the nose (ship.mjs turns every pick that way), so yaw = atan2(-hx, -hz) points it down the heading.
        _euler.set(f.pitch, Math.atan2(-f.hx, -f.hz), f.roll)
        _quat.setFromEuler(_euler)
        _pos.set(f.x, f.y, f.z)
        f.born = Math.min(BORN_FOR, f.born + dt)
        const grown = f.born / BORN_FOR
        _scl.setScalar(f.scale * grown * grown * (3 - 2 * grown))
        _mat.compose(_pos, _quat, _scl)
        _mat.toArray(mat, n * 16)
        col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = f.tint
        swim[n * 4] = f.phase
        swim[n * 4 + 1] = f.amp
        swim[n * 4 + 2] = f.curve
        swim[n * 4 + 3] = f.lift
        n++
      }
      sp.mesh.count = n
      sp.mesh.instanceMatrix.needsUpdate = true
      sp.mesh.instanceColor.needsUpdate = true
      sp.swim.needsUpdate = true
    }
  }

  /** The anchor: a slow drift between hops, each hop a new target that must itself be in deep enough water. Startles are the glimmerfin's. */
  stepSchool(sp, school, dt) {
    const cfg = sp.cfg
    const rand = this.rand
    school.hopLeft -= dt
    if (school.hopLeft <= 0) {
      school.hopLeft = between(rand, cfg.anchorEvery)
      this.hop(sp, school, between(rand, cfg.anchorHop))
    }
    if (cfg.boltEvery) {
      school.boltLeft -= dt
      if (school.boltLeft <= 0) {
        school.boltLeft = between(rand, cfg.boltEvery)
        if (this.hop(sp, school, between(rand, cfg.boltHop))) {
          // The anchor arrives at once. The fright does not: it starts at the edge the shoal flees from and runs through it at BOLT_WAVE, each fish adding its own reaction time, and BOLT_MISS of them never notice and just get pulled along after.
          const fx = school.tx - school.x
          const fz = school.tz - school.z
          const fd = Math.hypot(fx, fz) || 1
          school.fleeAt = Math.atan2(fz, fx)
          school.x = school.tx
          school.z = school.tz
          for (const f of school.members) {
            if (rand() < BOLT_MISS) continue
            const along = ((f.x - school.x) * fx + (f.z - school.z) * fz) / fd + cfg.schoolRadius
            f.boltIn = Math.max(0, along) / BOLT_WAVE + rand() * BOLT_JITTER
          }
        }
      }
    }
    const dx = school.tx - school.x
    const dz = school.tz - school.z
    const d = Math.hypot(dx, dz)
    if (d > 0.05) {
      const step = Math.min(d, cfg.anchorSpeed * dt)
      school.x += (dx / d) * step
      school.z += (dz / d) * step
    }
  }

  /**
   * Try a new anchor target `hop` metres away; keep the old one when the roll
   * lands on shore or shallows. The whole segment is checked, every 2 m, so a
   * school is never led across a spit of land its fish would have to beach on.
   * Returns whether it moved.
   */
  hop(sp, school, hop) {
    const a = this.rand() * TAU
    const tx = school.x + Math.cos(a) * hop
    const tz = school.z + Math.sin(a) * hop
    const steps = Math.max(1, Math.ceil(hop / 2))
    for (let i = 1; i < steps; i++) {
      const x = school.x + (tx - school.x) * (i / steps)
      const z = school.z + (tz - school.z) * (i / steps)
      if (!this.site(sp, x, z, 0)) return false
    }
    const at = this.site(sp, tx, tz, sp.cfg.clearance)
    if (!at) return false
    school.tx = tx
    school.tz = tz
    school.y = this.column(at.bed, at.level, between(this.rand, sp.cfg.depth))
    return true
  }

  stepFish(sp, f, dt) {
    const cfg = sp.cfg
    const rand = this.rand
    const school = f.school

    // The startle wave reaching this fish: it bolts at its own speed, a little off the shoal's line, and the wander is re-aimed so it stays on that line when the bolt ends.
    if (f.boltIn > 0) {
      f.boltIn -= dt
      if (f.boltIn <= 0) {
        f.mood = 'bolt'
        f.moodLeft = cfg.boltFor * (0.6 + 0.8 * rand())
        f.speed = cfg.boltSpeed * (0.7 + 0.6 * rand())
        f.wander = school.fleeAt + (rand() - 0.5) * 1.2
      }
    }
    // Moods. Pike cycle glide -> lurk -> burst -> glide; bass and glimmerfin fidget, each fish on its own clock: a dart or a hang, with a kick to the heading either way.
    f.moodLeft -= dt
    if (cfg.glide) {
      if (f.moodLeft <= 0) {
        if (f.mood === 'glide') { f.mood = 'lurk'; f.moodLeft = between(rand, cfg.lurk); f.speed = cfg.lurkSpeed }
        else if (f.mood === 'lurk') { f.mood = 'burst'; f.moodLeft = cfg.burst; f.speed = cfg.burstSpeed; f.wander += (rand() - 0.5) * 1.5 }
        else { f.mood = 'glide'; f.moodLeft = between(rand, cfg.glide); f.speed = cfg.cruise }
      }
    } else if (cfg.fidgetEvery) {
      if (f.moodLeft <= 0) {
        if (f.mood === 'glide') { f.mood = 'fidget'; f.moodLeft = cfg.fidgetFor * (0.7 + 0.6 * rand()); f.speed = rand() < 0.6 ? cfg.fidgetSpeed : cfg.cruise / 3; f.wander += (rand() - 0.5) * 3 }
        else { f.mood = 'glide'; f.moodLeft = between(rand, cfg.fidgetEvery); f.speed = cfg.cruise }
      }
    }

    // The probe: bed and surface under the fish, and the water ahead of it. Staggered so the pool's heightAt calls spread across frames. A big fish wants proportionally more water ahead.
    if ((this.frame + f.probeAt) % PROBE_EVERY === 0) {
      const level = this.water.levelAt(f.x, f.z)
      // A fish that has beached anyway is better gone than gasping on the bank; its slot re-seeds out in the pool.
      if (level === null || level - this.height.heightAt(f.x, f.z) < BED_MARGIN + SURFACE_MARGIN) return this.drop(sp, f)
      f.level = level
      f.bed = this.height.heightAt(f.x, f.z)
      const ax = f.x + f.hx * cfg.lookahead
      const az = f.z + f.hz * cfg.lookahead
      const aheadLevel = this.water.levelAt(ax, az)
      const shallow = aheadLevel === null || aheadLevel - this.height.heightAt(ax, az) < cfg.minDepth * 0.6 * Math.max(1, f.scale)
      if (shallow && f.homing <= 0) f.homing = 1.5
    }
    if (f.homing > 0) f.homing -= dt

    // Heading: a random walk, pulled toward the fish's own station in the school when it has strayed, or turned hard for the anchor itself when the shore is ahead. The anchor is always in deep water (hop), so it is the one heading that is known to be safe.
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
    const stray = ad / cfg.schoolRadius
    if (stray > 0.6) {
      const pull = f.mood === 'bolt' ? 3 : Math.min(2.5, (stray - 0.6) * 1.5)
      dx += (ax / ad) * pull
      dz += (az / ad) * pull
    }
    // Separation: from school-mates, or for a solo species from every other fish of its kind (ten pike, so a plain scan). Other species are ignored; they are going about their own business.
    const sep = cfg.separation
    const others = school.members.length > 1 ? school.members : cfg.school[1] === 1 ? sp.slots : null
    if (others) {
      for (const g of others) {
        if (g === f || !g.alive) continue
        const gx = f.x - g.x
        const gz = f.z - g.z
        const d2 = gx * gx + gz * gz
        if (d2 < sep * sep && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          const push = (sep - d) / sep * 2
          dx += (gx / d) * push
          dz += (gz / d) * push
        }
      }
    }
    const dl = Math.hypot(dx, dz) || 1
    // A fish left behind swims harder to rejoin: without this a shoal that cruises slower than its anchor drifts never catches it.
    const speed = f.speed * f.pace * Math.max(1, Math.min(2.5, stray))
    const wantX = (dx / dl) * speed
    const wantZ = (dz / dl) * speed
    const k = Math.min(1, cfg.agility * dt)
    f.vx += (wantX - f.vx) * k
    f.vz += (wantZ - f.vz) * k

    // Depth: chase the fish's own place in the column, bobbing slowly about it; the school's anchor y draws it too so a shoal rises and sinks together.
    const bob = 0.06 * Math.sin(this.time * TAU * f.bobHz + f.bobAt)
    const target = 0.5 * (this.column(f.bed, f.level, f.depthFrac + bob, f.margin) + school.y)
    const wantY = Math.max(-0.4, Math.min(0.4, (target - f.y) * 0.6)) * Math.max(0.3, speed / cfg.cruise)
    f.vy += (wantY - f.vy) * Math.min(1, 2 * dt)

    f.x += f.vx * dt
    f.y += f.vy * dt
    f.z += f.vz * dt
    const lo = f.bed + BED_MARGIN + f.margin
    const hi = f.level - SURFACE_MARGIN - f.margin
    if (f.y < lo) { f.y = lo; if (f.vy < 0) f.vy = 0 }
    if (f.y > hi) { f.y = Math.max(lo, hi); if (f.vy > 0) f.vy = 0 }
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
