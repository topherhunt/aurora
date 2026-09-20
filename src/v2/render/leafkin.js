// ---------------------------------------------------------------------------
// THE LEAFKIN: one per village entrance (render/entrances.js), a metre tall,
// scurrying about its own ROAM_M of wood for mushrooms, chattering as it goes,
// and bolting home the moment she comes near. DESIGN.md §30 has the whole of
// it; here is the state machine and how it is stepped.
//
// It steps on the score's fixed ticks (sim/score.js stepTo) of world time,
// every roll off a PRNG seeded from its site and its spawn tick, so two
// instances stepped on different frame times land on the same pose to the bit,
// and the frame lerps the last two ticks. It is minded as long as its site is
// resident (entrances.js RADIUS_M, past its whole roam) and drawn only within
// critterTier's cull, some 36 m for a metre of body.
//
//   roam     a target inside the site's disc every RETARGET_S, run (run-carry
//            with a bundle -- it never walks) on a heading that random-walks
//            about the bearing, so the path arcs and doubles; a refused probe
//            turns it away, REFUSALS in a row pick a new target; a cap within
//            SEEK_M ->
//   gather   run to the cap, the gather clip, and at its key the cap is taken
//            (mushrooms.take) into the bundle (hands.js carry, CARRY_MAX);
//            then the next cap in reach, else roam.
//   startle  she is within STARTLE_M, feet to feet: face her, recoil, the
//            bundle scattered, a scream, STARTLE_S; then
//   flee     run home on a path planned over the walker's ground (A* on a
//            CELL grid, planPath), weaving about it, a refused step
//            re-planning; inside FINAL_M of the mouth, straight at the arch
//            unprobed, and gone within HOME_M of the arch, or out past its
//            own cull.
//   gone     the site is empty EMPTY_S, then refilled only with her inside
//            ROAM_M -- at a random point of the disc, SPAWN_CLEAR_M from her.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { clamp, mulberry32 } from '../../sim/mathx.js'
import { CATCH_UP_TICKS, SILENT_TICKS, TICK_S, hash32, keyHash, stepTo, swing, tickOf } from '../../sim/score.js'
import { CARRY_MAX, CARRIERS } from '../hands.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier, cullRange } from './critters.js'
import { Puppet, groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'

export const LOD_TIERS = LOD_RUNGS
// Resident sites within the entrances' radius (400 m, on a 300 m tiling: at most 16) each keep a leafkin once she has passed within its roam; how many can be within the cull at once, where two villages' leafkin can meet.
export const MAX = 16
export const PUPPETS = 4

// A metre tall, give or take this fraction, from the site.
export const SIZE_M = 1
export const SIZE_VAR = 0.15
// The disc about the mouth it roams, is spawned for and spawns in, a new target every so often, and how far from her feet a spawn lands so it is never seen to appear.
export const ROAM_M = 100
export const RETARGET_S = [5, 15]
export const SPAWN_CLEAR_M = 15
const SPAWN_TRIES = 12
// The heading's wander about the bearing: a damped swing with this period, driven by noise of this much (rad/s^2), clamped at this far off. A random walk would hold one offset the length of a leg and walk it straight.
export const WOBBLE_PERIOD_S = 4
export const WOBBLE_DRIVE = 10
export const WOBBLE_MAX = (75 * Math.PI) / 180
const WOBBLE_W = (2 * Math.PI) / WOBBLE_PERIOD_S
// A cap it sees and goes for, how close it must stand to take one, and where in the gather clip the take is.
export const SEEK_M = 3
export const REACH_M = 0.6
export const GATHER_KEY = 0.5
// Her feet within this of its own, and it is startled; how long the recoil holds before it runs.
export const STARTLE_M = 3
export const STARTLE_S = 1.0
// The mouth point this close, and it makes for the arch itself, its step no longer probed -- the probe lands on the boulder there and refuses a step that is the whole point; the arch this close is home.
export const FINAL_M = 1.2
export const HOME_M = 0.3
// A scared-out village stays empty this long.
export const EMPTY_S = 300
// Ground it will not step onto: hers (player.js LOCOMOTION.maxSlopeDeg).
export const MAX_SLOPE = (50 * Math.PI) / 180
// Radians a second the body swings, roaming and fleeing; body heights ahead a step is probed.
export const TURN_RATE = 2.5
export const FLEE_TURN = 4
const AHEAD = 0.75
// A refused probe turns it away this far for this long; this many in a row and the target was a bad one.
const DETOUR = [Math.PI / 2, (5 * Math.PI) / 6]
const DETOUR_S = 1
const REFUSALS = 10
// A flight's path home: the grid it is planned on, the cells A* may open before it settles for the one nearest home, how near a waypoint counts as reached, how many waypoints ahead a clear line is looked for, a probe every this far along it, the weave about the line (the roam's wobble, scaled), and the ticks a refused step waits before the path is planned again.
const CELL = 0.5
const PLAN_OPEN = 800
const WAYPOINT_M = 0.4
const LOOKAHEAD = 8
const LINE_STEP = 0.25
const FLEE_WOBBLE = (25 * Math.PI) / 180
const REPLAN_TICKS = 10
// A call and a pant by turns, this long apart: chatter while it roams, whimpers while it flees.
export const CHATTER_S = [2, 3.5]
export const WHIMPER_S = [2.7, 4.1]
export const CHATTERS = 4
// The squeal at a cap in sight, no oftener than this: a bed of caps is a run of gathers seconds apart.
export const SQUEAL_S = 5
// A gait step, extended in place when it runs out; the chest, as a fraction of the body, where the bundle rides, and what each cap in it is drawn across: half the torso's width.
const STEP_S = 2
const CHEST = 0.5
export const CARRY_SPAN = 0.14
const FADE_S = 0.25

export const CLIPS = ['idle', 'run', 'run-carry', 'gather', 'recoil']
// The clips whose feet stay put (puppet.js FootIK): a recoil steps back, a gait walks.
export const PLANTED = new Set(['idle', 'gather'])

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _trunk = { x: 0, z: 0, r: 0 }

// A cell's key: i and j within +-1024 cells (512 m) of the grid's origin.
const cellKey = (i, j) => (i + 1024) * 2048 + (j + 1024)
const STEPS8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]]

/**
 * A* over a CELL grid about (ox, oz) from (sx, sz) to within `near` of
 * (gx, gz): a cell passable where `open(x, z)` says so, its answer kept in
 * `cells` for the next plan; eight-connected, a diagonal refused past a
 * blocked cell so no corner is cut. Opens at most `budget` cells and then
 * settles for the opened one nearest the goal, so the way out of a pocket is
 * found before the whole wood is. Returns the waypoints `[x, z][]` past the
 * start cell -- none where nothing opened.
 */
export function planPath(open, cells, ox, oz, sx, sz, gx, gz, near, budget) {
  const pass = (i, j) => {
    const k = cellKey(i, j)
    let v = cells.get(k)
    if (v === undefined) { v = open(ox + i * CELL, oz + j * CELL); cells.set(k, v) }
    return v
  }
  const octile = (i, j) => {
    const di = Math.abs(gx - ox - i * CELL) / CELL, dj = Math.abs(gz - oz - j * CELL) / CELL
    return Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)
  }
  let si = Math.round((sx - ox) / CELL), sj = Math.round((sz - oz) / CELL)
  // Standing on a blocked cell's centre, it starts from the nearest passable neighbour.
  if (!pass(si, sj)) {
    let found = false
    for (const [di, dj] of STEPS8) if (pass(si + di, sj + dj)) { si += di; sj += dj; found = true; break }
    if (!found) return []
  }
  const g = new Map(), parent = new Map(), closed = new Set()
  const heapK = [], heapF = []
  const push = (k, f) => {
    let n = heapK.length
    heapK.push(k); heapF.push(f)
    while (n > 0) {
      const p = (n - 1) >> 1
      if (heapF[p] <= heapF[n]) break
      ;[heapK[p], heapK[n]] = [heapK[n], heapK[p]]; [heapF[p], heapF[n]] = [heapF[n], heapF[p]]
      n = p
    }
  }
  const pop = () => {
    const k = heapK[0]
    const lk = heapK.pop(), lf = heapF.pop()
    if (heapK.length > 0) {
      heapK[0] = lk; heapF[0] = lf
      let n = 0
      for (;;) {
        const a = 2 * n + 1, b = a + 1
        let m = n
        if (a < heapK.length && heapF[a] < heapF[m]) m = a
        if (b < heapK.length && heapF[b] < heapF[m]) m = b
        if (m === n) break
        ;[heapK[m], heapK[n]] = [heapK[n], heapK[m]]; [heapF[m], heapF[n]] = [heapF[n], heapF[m]]
        n = m
      }
    }
    return k
  }
  const sk = cellKey(si, sj)
  g.set(sk, 0)
  push(sk, octile(si, sj))
  let bestK = sk, bestH = octile(si, sj), goalK = -1, opened = 0
  while (heapK.length > 0 && opened < budget) {
    const k = pop()
    if (closed.has(k)) continue
    closed.add(k)
    opened++
    const i = Math.floor(k / 2048) - 1024, j = (k % 2048) - 1024
    if (Math.hypot(ox + i * CELL - gx, oz + j * CELL - gz) <= near) { goalK = k; break }
    const h = octile(i, j)
    if (h < bestH) { bestH = h; bestK = k }
    const gk = g.get(k)
    for (const [di, dj, cost] of STEPS8) {
      const ni = i + di, nj = j + dj
      if (!pass(ni, nj)) continue
      if (di !== 0 && dj !== 0 && !(pass(i + di, j) && pass(i, j + dj))) continue
      const nk = cellKey(ni, nj)
      if (closed.has(nk)) continue
      const ng = gk + cost
      const old = g.get(nk)
      if (old !== undefined && old <= ng) continue
      g.set(nk, ng)
      parent.set(nk, k)
      push(nk, ng + octile(ni, nj))
    }
  }
  const path = []
  for (let k = goalK >= 0 ? goalK : bestK; k !== sk; k = parent.get(k)) {
    path.push([ox + (Math.floor(k / 2048) - 1024) * CELL, oz + ((k % 2048) - 1024) * CELL])
  }
  return path.reverse()
}
const _norm = { x: 0, y: 1, z: 0 }

export class Leafkin {
  /**
   * @param water          WaterSurfaces: isSubmerged
   * @param opts.walk      WalkSurface: heightAt, normalAt, obstacleAt
   * @param opts.entrances Entrances: sites()
   * @param opts.mushrooms Mushrooms: pickAt, take, instX/instY/instZ; null and nothing is gathered
   * @param opts.hands     Hands: carry(); null and a taken cap is simply gone
   * @param opts.asset     a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, water, { walk, entrances, mushrooms = null, hands = null, asset = null } = {}) {
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Leafkin needs WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function' || typeof walk.obstacleAt !== 'function') {
      throw new Error('Leafkin needs the WalkSurface, for heightAt, normalAt and obstacleAt')
    }
    if (!entrances || typeof entrances.sites !== 'function') throw new Error('Leafkin needs the Entrances, for sites()')
    if (mushrooms && (typeof mushrooms.pickAt !== 'function' || typeof mushrooms.take !== 'function' || !mushrooms.instX)) {
      throw new Error('Leafkin: the mushrooms need pickAt, take and the instance positions')
    }
    if (hands && typeof hands.carry !== 'function') throw new Error('Leafkin: the hands need carry()')
    this.water = water
    this.walk = walk
    this.entrances = entrances
    this.mushrooms = mushrooms
    this.hands = hands

    this.batch = new THREE.Group()
    this.batch.name = 'v2-leafkin'
    scene.add(this.batch)
    this.plain = makeSettledMaterial('leafkin')
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('leafkin', this.plain)
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, key: '', site: null, rand: null, size: 1, k: 1,
        // The tick's pose and the one before it, for the frame to lerp; `tick` and `alpha` are the score's.
        x: 0, y: 0, z: 0, heading: 0, px: 0, py: 0, pz: 0, ph: 0, aim: 0, tick: 0, alpha: 0,
        // The frame's pose, what the puppet and the ear are given.
        pose: { x: 0, y: 0, z: 0, heading: 0, k: 1, speed: 0, clip: 'idle', cycle: 0, size: 1 },
        // roam, gather, startle or flee.
        state: 'roam',
        // The roam's target and when it is replaced, the heading's wander, seconds left of a turn off a refused probe, and probes refused in a row.
        tx: 0, tz: 0, retarget: 0, wob: 0, wobv: 0, detour: 0, refused: 0,
        // The flight's path home: its waypoints, the one it is making for, the cells' passability as planned over, and the tick the path was last planned on.
        path: [], wp: 0, cells: new Map(), planned: -1,
        // The cap it is going for, whether this gather has taken it, and the bundle: caps carried and the carrier holding them.
        cx: 0, cy: 0, cz: 0, took: false, bundle: 0, carrier: null,
        // Seconds the recoil has left, and to the next call or pant, and whether the last was a pant.
        hold: 0, voice: 0, panted: false, squeal: 0,
        // The clip playing, how long it holds, that step's whole length, the clip's own length, a count of steps, and the ground speed.
        clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0,
        lod: LOD_TIERS, puppet: null,
      })
    }
    this.free = this.slots.slice()
    this.byKey = new Map()
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.durations = null
    // One-shots for the ear, drained by voices(): { sound, x, y, z }.
    this.pending = []
    this.feet = { x: 0, y: 0, z: 0 }
    this.head = { x: 0, y: 0, z: 0 }
    this._sites = []
    this._seen = new Set()
    this.frame = 0
    this.loaded = false
    this.starved = 0
    this.overflow = 0
    this.spawned = 0
    this.fled = 0

    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadBipedGlb(CRITTER_GLB.leafkin))
    return true
  }

  setAsset(asset) {
    for (const name of CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`Leafkin: the asset has no ${name} clip`)
    this.asset = asset
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    for (const mats of this.puppetMats) {
      for (const m of [mats.in, mats.out]) {
        m.map = asset.map
        m.needsUpdate = true
      }
      this.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S }))
    }
    this.freePuppets = this.puppets.slice()
    this.loaded = true
  }

  /** The ground at (x, z) it may stand on, or null: dry, clear of a trunk, no steeper than MAX_SLOPE. */
  seat(x, z) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (this.walk.obstacleAt(x, z, _trunk)) return null
    this.walk.normalAt(x, z, undefined, _norm)
    if (Math.acos(Math.min(1, _norm.y)) > MAX_SLOPE) return null
    return y
  }

  get stats() {
    const states = { roam: 0, gather: 0, startle: 0, flee: 0 }
    for (const c of this.byKey.values()) states[c.state]++
    return { alive: this.byKey.size, states, puppets: this.puppets.length - this.freePuppets.length, spawned: this.spawned, fled: this.fled, starved: this.starved, overflow: this.overflow }
  }

  /** Every leafkin drawn this frame, for the ear: its frame pose, with x, y, z, size, clip, cycle and speed. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.byKey.values()) if (c.lod < LOD_TIERS) into.push(c.pose)
    return into
  }

  /** The one-shots since the last call, each `{ sound, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.pending) into.push(v)
    this.pending.length = 0
    return into
  }

  // -------------------------------------------------------------------------
  // Coming and going.
  // -------------------------------------------------------------------------

  _spawn(site, seconds) {
    const c = this.free.pop()
    if (!c) { this.overflow++; return null }
    const tick = tickOf(seconds)
    c.key = site.key
    c.site = site
    c.tick = tick
    c.alpha = 0
    c.rand = mulberry32(hash32(keyHash(site.key), tick))
    c.size = SIZE_M * (1 + SIZE_VAR * (2 * mulberry32(keyHash(site.key))() - 1))
    c.k = c.size / this.asset.height
    // Somewhere in the disc it can stand, clear of her; every try burns the same draws, and none passing it is at the mouth.
    let x = site.x, z = site.z, y = null
    for (let i = 0; i < SPAWN_TRIES; i++) {
      const r = ROAM_M * Math.sqrt(c.rand())
      const a = c.rand() * Math.PI * 2
      const sx = site.x + r * Math.cos(a), sz = site.z + r * Math.sin(a)
      if (y !== null || Math.hypot(sx - this.feet.x, sz - this.feet.z) < SPAWN_CLEAR_M) continue
      const sy = this.seat(sx, sz)
      if (sy !== null) { x = sx; z = sz; y = sy }
    }
    c.x = c.px = x
    c.z = c.pz = z
    c.y = c.py = y ?? this.walk.heightAt(x, z)
    c.heading = c.ph = c.aim = c.rand() * Math.PI * 2
    c.wob = c.wobv = 0
    c.bundle = 0
    c.carrier = null
    c.lod = LOD_TIERS
    c.puppet = null
    c.cue = 0
    this._roam(c)
    this.byKey.set(site.key, c)
    this.spawned++
    return c
  }

  /** Out of the world at once: into the mouth, culled, or its site evicted. */
  _retire(c) {
    this._releasePuppet(c)
    c.carrier?.release()
    c.carrier = null
    c.bundle = 0
    this.byKey.delete(c.key)
    c.key = ''
    c.site = null
    this.free.push(c)
  }

  /** Home, or lost to the cull: the village is empty for EMPTY_S. */
  _gone(c, seconds) {
    c.site.state.emptyUntil = seconds + EMPTY_S
    this.fled++
    this._retire(c)
  }

  // -------------------------------------------------------------------------
  // What it is doing.
  // -------------------------------------------------------------------------

  _toward(c, x, z) { return Math.atan2(-(z - c.z), x - c.x) }

  _voice(c, sound) {
    this.pending.push({ sound, x: c.x, y: c.y + c.size * CHEST, z: c.z })
  }

  /** The state's call, or a pant if the last was the call, and the wait to the next. */
  _call(c, sound, gap) {
    c.voice = between(c.rand, gap)
    c.panted = !c.panted
    this._voice(c, c.panted ? 'panting' : sound)
  }

  _roam(c) {
    c.state = 'roam'
    c.detour = 0
    c.voice = between(c.rand, CHATTER_S)
    c.panted = true
    this._target(c)
    this._play(c, c.bundle > 0 ? 'run-carry' : 'run', STEP_S)
  }

  _target(c) {
    const r = ROAM_M * Math.sqrt(c.rand())
    const a = c.rand() * Math.PI * 2
    c.tx = c.site.x + r * Math.cos(a)
    c.tz = c.site.z + r * Math.sin(a)
    c.retarget = between(c.rand, RETARGET_S)
    c.refused = 0
  }

  /** A cap in sight: off to it, with a squeal. */
  _gather(c, hit) {
    const m = this.mushrooms
    c.state = 'gather'
    c.detour = 0
    c.refused = 0
    c.cx = m.instX[hit.id]
    c.cy = m.instY[hit.id]
    c.cz = m.instZ[hit.id]
    if (c.squeal <= 0) { this._voice(c, 'leafkinSqueal'); c.squeal = SQUEAL_S }
    this._play(c, 'run', STEP_S)
  }

  _startle(c) {
    c.state = 'startle'
    c.hold = STARTLE_S
    c.aim = this._toward(c, this.feet.x, this.feet.z)
    if (c.carrier) c.carrier.scatter()
    c.bundle = 0
    this._voice(c, 'leafkinScream')
    this._play(c, 'recoil', STARTLE_S)
  }

  _flee(c) {
    c.state = 'flee'
    c.cells.clear()
    c.path.length = 0
    c.wp = 0
    c.planned = -1
    c.refused = 0
    c.wob = 0; c.wobv = 0
    c.voice = between(c.rand, WHIMPER_S)
    c.panted = true
    this._play(c, 'run', STEP_S)
  }

  /** Whether the bundle can take another: a carrier in hand, or one to be had. */
  _canCarry(c) {
    if (c.bundle >= CARRY_MAX) return false
    if (c.carrier || !this.hands) return true
    return this.hands.carriers < CARRIERS
  }

  /** A cap within `reach` of its feet, or null. */
  _seek(c, reach) {
    if (!this.mushrooms || !this._canCarry(c)) return null
    return this.mushrooms.pickAt(c.x, c.y + c.size * 0.3, c.z, reach)
  }

  /** The step's clip has run out: a gait is extended in place, a gather ends on the next cap or the roam. */
  _step(c) {
    if (c.state === 'gather' && c.clip === 'gather') {
      const hit = this._seek(c, SEEK_M)
      if (hit) this._gather(c, hit)
      else this._roam(c)
      return
    }
    c.left = c.dur = c.speed > 0 ? STEP_S : STARTLE_S
  }

  _play(c, clip, seconds) {
    c.clip = clip
    c.dur = seconds
    c.left = seconds
    c.cycle = this.durations[clip]
    c.cue++
    // The shipped file carries a speed for the walk and the run; the run-carry is the run at the same stride, on the arms.
    const speed = this.asset.gait[clip === 'run-carry' ? 'run' : clip]
    c.speed = speed === undefined ? 0 : speed * c.k
  }

  /** Ease the heading toward the aim, and report the cosine of the swing still owed, so a body half turned makes half a step. */
  _turn(c, dt, rate = TURN_RATE) {
    const s = swing(c.heading, c.aim)
    c.heading += Math.sign(s) * Math.min(Math.abs(s), rate * dt)
    return Math.max(0, Math.cos(s))
  }

  _blocked(c, heading) {
    const ahead = c.size * AHEAD
    return this.seat(c.x + Math.cos(heading) * ahead, c.z - Math.sin(heading) * ahead) === null
  }

  /** A step along the heading at the gait, after the probe: refused, it turns off instead. */
  _advance(c, dt) {
    c.detour = Math.max(0, c.detour - dt)
    if (this._blocked(c, c.heading)) {
      c.refused++
      c.detour = DETOUR_S
      c.aim = c.heading + (c.rand() < 0.5 ? 1 : -1) * between(c.rand, DETOUR)
      this._turn(c, dt)
      return
    }
    c.refused = 0
    const d = c.speed * dt * this._turn(c, dt)
    c.x += Math.cos(c.heading) * d
    c.z -= Math.sin(c.heading) * d
  }

  _tickRoam(c, tick, dt) {
    c.retarget -= dt
    if (c.retarget <= 0 || c.refused >= REFUSALS) this._target(c)
    if (tick % 5 === 0) {
      const hit = this._seek(c, SEEK_M)
      if (hit) { this._gather(c, hit); return }
    }
    c.wobv += ((c.rand() * 2 - 1) * WOBBLE_DRIVE - c.wobv * WOBBLE_W - c.wob * WOBBLE_W * WOBBLE_W) * dt
    c.wob = clamp(c.wob + c.wobv * dt, -WOBBLE_MAX, WOBBLE_MAX)
    if (c.detour <= 0) c.aim = this._toward(c, c.tx, c.tz) + c.wob
    this._advance(c, dt)
    c.voice -= dt
    if (c.voice <= 0) this._call(c, `leafkinChatter${1 + Math.min(CHATTERS - 1, (c.rand() * CHATTERS) | 0)}`, CHATTER_S)
  }

  _tickGather(c, dt) {
    if (c.clip === 'gather') {
      if (!c.took && c.dur - c.left >= c.dur * GATHER_KEY) {
        c.took = true
        this._take(c)
      }
      return
    }
    const d = Math.hypot(c.cx - c.x, c.cz - c.z)
    if (d <= REACH_M) {
      c.aim = this._toward(c, c.cx, c.cz)
      c.took = false
      this._play(c, 'gather', this.durations.gather)
      return
    }
    // The cap gone from under it -- her hand, or the tile -- or the ground refusing three times: back to the roam.
    if (c.refused >= 3 || !this.mushrooms.pickAt(c.cx, c.cy + 0.1, c.cz, REACH_M)) { this._roam(c); return }
    if (c.detour <= 0) c.aim = this._toward(c, c.cx, c.cz)
    this._advance(c, dt)
  }

  /** The gather's key: the cap out of the ground and into the arms. Nothing there any more, and the reach closes on air. */
  _take(c) {
    const m = this.mushrooms
    const hit = m.pickAt(c.cx, c.cy + 0.1, c.cz, REACH_M)
    if (!hit || !this._canCarry(c)) return
    const rec = m.take(hit)
    if (this.hands) {
      if (!c.carrier) c.carrier = this.hands.carry(`leafkin:${c.key}`, c.size * CARRY_SPAN)
      c.carrier.add(rec, m)
    }
    c.bundle++
  }

  _tickFlee(c, tick, dt) {
    const site = c.site
    const seconds = tick * TICK_S
    if (Math.hypot(site.ax - c.x, site.az - c.z) <= HOME_M || Math.hypot(c.x - this.head.x, c.y - this.head.y, c.z - this.head.z) > cullRange(c.size)) { this._gone(c, seconds); return }
    const dx = site.x - c.x, dz = site.z - c.z
    if (Math.hypot(dx, dz) <= FINAL_M) {
      c.aim = Math.atan2(c.z - site.az, site.ax - c.x)
      const d = c.speed * dt * this._turn(c, dt, FLEE_TURN)
      c.x += Math.cos(c.heading) * d
      c.z -= Math.sin(c.heading) * d
      c.voice -= dt
      if (c.voice <= 0) this._call(c, 'leafkinWhimper', WHIMPER_S)
      return
    }
    // Along the planned path, weaving about it; a step onto ground it cannot stand on is refused, and REPLAN_TICKS of those plan the path again from here.
    if (c.wp >= c.path.length && (c.planned < 0 || tick - c.planned >= REPLAN_TICKS)) this._plan(c, tick)
    // The path run out, or none found: straight at the mouth point.
    let wx = site.x, wz = site.z
    if (c.wp < c.path.length) {
      if (Math.hypot(c.path[c.wp][0] - c.x, c.path[c.wp][1] - c.z) <= WAYPOINT_M) c.wp = this._lookahead(c)
      if (c.wp < c.path.length) [wx, wz] = c.path[c.wp]
    }
    c.wobv += ((c.rand() * 2 - 1) * WOBBLE_DRIVE - c.wobv * WOBBLE_W - c.wob * WOBBLE_W * WOBBLE_W) * dt
    c.wob = clamp(c.wob + c.wobv * dt, -WOBBLE_MAX, WOBBLE_MAX)
    c.aim = this._toward(c, wx, wz) + c.wob * (FLEE_WOBBLE / WOBBLE_MAX)
    const d = c.speed * dt * this._turn(c, dt, FLEE_TURN)
    const nx = c.x + Math.cos(c.heading) * d, nz = c.z - Math.sin(c.heading) * d
    if (this.seat(nx, nz) !== null) { c.x = nx; c.z = nz; c.refused = 0 } else {
      c.wob = 0; c.wobv = 0
      if (++c.refused >= REPLAN_TICKS && tick - c.planned >= REPLAN_TICKS) { c.cells.clear(); this._plan(c, tick) }
    }
    c.voice -= dt
    if (c.voice <= 0) this._call(c, 'leafkinWhimper', WHIMPER_S)
  }

  /** One tick of world time. A slot retired mid-catch-up is left alone. */
  /** The path home from where it stands, over the site's ground: planPath's, from the cell it is in to a cell whose reach puts it inside FINAL_M of the mouth point. */
  _plan(c, tick) {
    const site = c.site
    c.path = planPath((x, z) => this.seat(x, z) !== null, c.cells, site.x, site.z, c.x, c.z, site.x, site.z, FINAL_M - WAYPOINT_M, PLAN_OPEN)
    c.wp = 0
    c.planned = tick
    c.refused = 0
  }

  /** The furthest of the next LOOKAHEAD waypoints it can run straight at, probed every LINE_STEP along the line; the next one when none. */
  _lookahead(c) {
    const last = Math.min(c.path.length - 1, c.wp + LOOKAHEAD)
    for (let k = last; k > c.wp + 1; k--) {
      const [wx, wz] = c.path[k]
      const dx = wx - c.x, dz = wz - c.z
      const n = Math.ceil(Math.hypot(dx, dz) / LINE_STEP)
      let clear = true
      for (let i = 1; i <= n && clear; i++) clear = this.seat(c.x + (dx * i) / n, c.z + (dz * i) / n) !== null
      if (clear) return k
    }
    return c.wp + 1
  }

  _tick(c, tick) {
    if (c.site === null) return
    c.px = c.x; c.py = c.y; c.pz = c.z; c.ph = c.heading
    const dt = TICK_S
    c.squeal -= dt
    if ((c.state === 'roam' || c.state === 'gather') && Math.hypot(c.x - this.feet.x, c.y - this.feet.y, c.z - this.feet.z) < STARTLE_M) this._startle(c)
    switch (c.state) {
      case 'roam': this._tickRoam(c, tick, dt); break
      case 'gather': this._tickGather(c, dt); break
      case 'startle':
        c.hold -= dt
        this._turn(c, dt, FLEE_TURN)
        if (c.hold <= 0) this._flee(c)
        break
      case 'flee': this._tickFlee(c, tick, dt); break
      default: throw new Error(`Leafkin: no state named ${c.state}`)
    }
    if (c.site === null) return
    c.left -= dt
    if (c.left <= 0) this._step(c)
    // The last stretch is over the boulder's own footprint, where the walker's ground is the boulder's top: the arch's floor caps it there.
    c.y = this.walk.heightAt(c.x, c.z)
    if (c.state === 'flee' && Math.hypot(c.site.x - c.x, c.site.z - c.z) <= FINAL_M) c.y = Math.min(c.y, Math.max(c.site.y, c.site.ay))
  }

  // -------------------------------------------------------------------------
  // The frame.
  // -------------------------------------------------------------------------

  _takePuppet(c) {
    if (!c.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      this.batch.add(p.group)
      p.play(c.clip, c.cue, c.dur - c.left)
    }
    return c.puppet
  }

  _releasePuppet(c) {
    const p = c.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
    c.puppet = null
  }

  /**
   * One frame. `feet` is where she stands and `head` her eyes, `seconds` the
   * world clock (clock.js WorldClock.seconds) and `dt` the frame's own time,
   * for the puppets.
   */
  update(feet, head, seconds, dt) {
    if (!this.loaded) return
    this.frame++
    this.feet.x = feet.x; this.feet.y = feet.y; this.feet.z = feet.z
    this.head.x = head.x; this.head.y = head.y; this.head.z = head.z

    // The sites: a resident one without its leafkin gets one when the village is not lying empty and she is inside its roam; a gone one takes its leafkin with it. A leafkin too long unstepped to replay (a clock skip) is born again like one never met, not walked through the gap under her feet.
    const sites = this._sites
    sites.length = 0
    this.entrances.sites(sites)
    const seen = this._seen
    seen.clear()
    const tick = tickOf(seconds)
    for (const site of sites) {
      seen.add(site.key)
      const c = this.byKey.get(site.key)
      if (c) {
        c.site = site
        if (tick - c.tick <= CATCH_UP_TICKS) continue
        this._retire(c)
      }
      const until = site.state.emptyUntil
      if (until !== undefined && seconds <= until) continue
      if (Math.hypot(site.x - feet.x, site.z - feet.z) > ROAM_M) continue
      this._spawn(site, seconds)
    }
    for (const c of [...this.byKey.values()]) if (!seen.has(c.key)) this._retire(c)

    let stepped = 0
    for (const c of [...this.byKey.values()]) {
      stepped = Math.max(stepped, stepTo(c, seconds, (tick) => this._tick(c, tick)))
      if (c.site === null) continue
      this._draw(c, dt)
    }
    // A catch-up frame says nothing in the ear: she was not there for it.
    if (stepped > SILENT_TICKS) this.pending.length = 0
  }

  /** The frame's pose between the last two ticks, and the puppet on it. */
  _draw(c, dt) {
    const a = c.alpha
    const pose = c.pose
    pose.x = c.px + (c.x - c.px) * a
    pose.y = c.py + (c.y - c.py) * a
    pose.z = c.pz + (c.z - c.pz) * a
    pose.heading = c.ph + swing(c.ph, c.heading) * a
    pose.k = c.k
    pose.size = c.size
    pose.speed = c.speed
    pose.clip = c.clip
    pose.cycle = c.cycle
    if (c.carrier) c.carrier.place(pose.x, pose.y, pose.z, pose.heading, c.size * CHEST)

    const dist = Math.hypot(pose.x - this.head.x, pose.y - this.head.y, pose.z - this.head.z)
    c.lod = critterTier(c.size, dist, c.lod, LOD_TIERS)
    const want = c.lod === LOD_TIERS ? -1 : c.lod
    const puppet = want === -1 && !c.puppet ? null : this._takePuppet(c)
    if (!puppet) return
    puppet.show(want)
    _pos.set(pose.x, pose.y, pose.z)
    _quat.setFromAxisAngle(UP, pose.heading)
    _scl.setScalar(c.k)
    _mat.compose(_pos, _quat, _scl)
    puppet.play(c.clip, c.cue)
    groundFeet(puppet, pose, this.walk, PLANTED, (this.frame + c.id) % 6 === 0)
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
    if (puppet.done) this._releasePuppet(c)
  }

  dispose() {
    for (const c of [...this.byKey.values()]) this._retire(c)
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
