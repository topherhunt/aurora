// ---------------------------------------------------------------------------
// THE LEAFKIN: one per village entrance (render/entrances.js), a metre tall,
// scurrying about its own ROAM_M of wood for mushrooms, chattering as it goes,
// and bolting home the moment she comes near. DESIGN.md §30 has the whole of
// it; here is the state machine and how it is stepped.
//
// LOCKSTEP (DESIGN.md §30 Netplay): every client steps a site's leafkin alike
// on the score's ticks (sim/score.js) over the same ground (leafkin-ground.js,
// pure of the viewer), its PRNG seeded from the site and the chapter. It comes
// out of its mouth at the chapter's start, makes for home HOMING_S before the
// turn, and is stepped while her feet are within its roam and cull; met
// mid-chapter it replays from the start, hidden until caught up. The room
// hears only her doings, as `lk` anchors: a `fright` (her feet within
// STARTLE_M) and a `pick` (a cap her hand took inside its reach), each logged
// on its tick and stepped again from the last state kept before it when heard
// late, as the villagers' startles are.
//
//   roam     a target inside the site's disc every RETARGET_S, run (run-carry
//            with a bundle) on a chain of ARC_M arcs bent toward it more often
//            than away; a refused probe turns it away, REFUSALS in a row pick a
//            new target; a cap within SEEK_M ->
//   gather   run to the cap, the gather clip, and at its key the cap is taken
//            into the bundle (CARRY_MAX); then the next cap in reach, else roam.
//   startle  a fright: face her, recoil, the bundle scattered, a scream,
//            STARTLE_S; then
//   flee     run home on a path planned over the ground (A* on a CELL grid,
//            planPath), weaving about it; inside FINAL_M of the mouth, straight
//            at the arch, and inside within HOME_M of it for EMPTY_S.
//   home     the flight's path without the fright, HOMING_S before the turn.
//   inside   out of sight, until it comes out again or the chapter turns.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { clamp, mulberry32 } from '../../sim/mathx.js'
import { CATCH_UP_TICKS, CHAPTER_S, SILENT_TICKS, TICK_HZ, TICK_S, chapterOf, hash32, keyHash, swing, tickAfter, tickOf } from '../../sim/score.js'
import { snap } from '../creature-net.js'
import { CARRY_MAX, CARRIERS } from '../hands.js'
import { TOLERANCE_M } from '../taken.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier, cullRange } from './critters.js'
import { BLOCKED, STONE } from './leafkin-ground.js'
import { Puppet, groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { JUMP_M, LEAD_TICKS, ease, easeFields, keepWas, warnPop } from './net-ease.js'

export const LOD_TIERS = LOD_RUNGS
// Sites stepped at once: those whose roam and cull reach her feet, on a 300 m tiling of mouths far fewer than this.
export const MAX = 16
export const PUPPETS = 4

// A metre tall, give or take this fraction, from the site.
export const SIZE_M = 1
export const SIZE_VAR = 0.15
// The disc about the mouth it roams, and a new target every so often.
export const ROAM_M = 150
export const RETARGET_S = [5, 15]
// Stepped while her feet are within its roam and its cull of the mouth; let go this much further out.
export const SIM_OUT_M = 20
// The roam's path: a chain of arcs, each ARC_M metres long at a curvature (1/radius) of ARC_CURVE, so no metre of it is straight; each bends toward the target with odds from even (on the bearing) to certain (a quarter turn or more off it).
export const ARC_M = [0.8, 3]
export const ARC_CURVE = [0.15, 0.5]
// The flight's weave about its path: a damped swing with this period, driven by noise of this much (rad/s^2), clamped at this far off.
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
// The mouth point this close, and it makes for the arch itself, its step no longer probed and stone underfoot allowed -- the boulder's own; the arch this close is home.
export const FINAL_M = 1.2
export const HOME_M = 0.3
// Inside this long after a flight; home this long before the chapter's turn.
export const EMPTY_S = 300
export const HOMING_S = 90
// Radians a second the body swings, roaming and fleeing -- an about-face in 0.4 s or 0.3 s, a turn on the spot that is still drawn as a turn; body heights ahead a step is probed.
export const TURN_RATE = 8
export const FLEE_TURN = 10
const AHEAD = 0.75
// A refused probe turns it away this far for this long; this many in a row and the target was a bad one.
const DETOUR = [Math.PI / 2, (5 * Math.PI) / 6]
const DETOUR_S = 1
const REFUSALS = 10
// A flight's path home: the grid it is planned on (the ground's), the cells A* may open before it settles for the one nearest home, how near a waypoint counts as reached, how many waypoints ahead a clear line is looked for, a probe every this far along it, the weave about the line (the WOBBLE_* walk, scaled), and the ticks a refused step waits before the path is planned again.
const CELL = 0.5
const PLAN_OPEN = 800
const WAYPOINT_M = 0.4
const LOOKAHEAD = 8
const LINE_STEP = 0.25
const FLEE_WOBBLE = (25 * Math.PI) / 180
const REPLAN_TICKS = 10
// A flanking stone of the mouth (entrances.js) grown by the ground's own cell margin.
const FLANK_PAD = CELL * Math.SQRT1_2
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
// State kept every SNAP_TICKS, SNAPS deep, for an anchor heard late to roll back to; one older than that replays the chapter.
const SNAP_TICKS = 20
const SNAPS = 30
const KEPT = ['rs', 'x', 'z', 'heading', 'px', 'pz', 'ph', 'aim', 'state', 'tx', 'tz', 'retarget', 'curve', 'arc', 'detour', 'refused', 'wob', 'wobv', 'wp', 'planned', 'cx', 'cz', 'took', 'bundle', 'hold', 'voice', 'panted', 'squeal', 'clip', 'left', 'dur', 'cycle', 'speed', 'until']

export const CLIPS = ['idle', 'run', 'run-carry', 'gather', 'recoil']
// The clips whose feet stay put (puppet.js FootIK): a recoil steps back, a gait walks.
export const PLANTED = new Set(['idle', 'gather'])

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
// mulberry32 over a field, so the PRNG's state is kept with the rest.
function roll(c) {
  c.rs = (c.rs + 0x6d2b79f5) >>> 0
  let t = c.rs
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
// A site's name to the room; an anchor's key is it, the tick and a hash, `lk:<site>:<tick>:<hash>`.
const wireOf = (key) => `lk:${keyHash(key).toString(36)}:`
const sizeOf = (key) => SIZE_M * (1 + SIZE_VAR * (2 * mulberry32(keyHash(key))() - 1))

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

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

export class Leafkin {
  /**
   * @param opts.ground    LeafkinGround (or its like): cell, capsNear
   * @param opts.walk      WalkSurface: heightAt, for the drawn pose and the ear
   * @param opts.entrances Entrances: sites()
   * @param opts.mushrooms Mushrooms: pickAt, take, instX/instZ, onTake; null and no cap is pulled here
   * @param opts.hands     Hands: carry(); null and a taken cap is simply gone
   * @param opts.asset     a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, { ground, walk, entrances, mushrooms = null, hands = null, asset = null } = {}) {
    if (!ground || typeof ground.cell !== 'function' || typeof ground.capsNear !== 'function') throw new Error('Leafkin needs its ground, for cell and capsNear')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Leafkin needs the WalkSurface, for heightAt')
    if (!entrances || typeof entrances.sites !== 'function') throw new Error('Leafkin needs the Entrances, for sites()')
    if (mushrooms && (typeof mushrooms.pickAt !== 'function' || typeof mushrooms.take !== 'function' || !mushrooms.instX)) {
      throw new Error('Leafkin: the mushrooms need pickAt, take and the instance positions')
    }
    if (mushrooms && mushrooms.onTake) throw new Error('Leafkin: the mushrooms already tell someone of her takes')
    if (hands && typeof hands.carry !== 'function') throw new Error('Leafkin: the hands need carry()')
    this.ground = ground
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
      const c = {
        id: i, key: '', wire: '', site: null, rs: 0, rand: null, size: 1, k: 1,
        // The chapter's first tick (placed on, never stepped), its turn and when homing starts; the tick stepped to, the furthest ever stepped, the earliest tick an anchor heard late owes a replay from, and the states kept for one.
        startTick: 0, turnTick: 0, homingTick: 0, tick: 0, live: -1, rewind: Infinity, snaps: [], alpha: 0,
        // Whether this frame's ticks are heard (not a catch-up), and the tick being stepped is.
        loud: false, voicing: false,
        // The tick's pose and the one before it, for the frame to lerp; the ground's height is read only for the frame.
        x: 0, z: 0, heading: 0, px: 0, pz: 0, ph: 0, aim: 0,
        // The frame's pose, what the puppet and the ear are given.
        pose: { x: 0, y: 0, z: 0, heading: 0, k: 1, speed: 0, clip: 'idle', cycle: 0, size: 1 },
        state: 'inside', until: 0,
        // The roam's target and when it is replaced, the arc it is on (signed curvature, metres left), seconds left of a turn off a refused probe, and probes refused in a row.
        tx: 0, tz: 0, retarget: 0, curve: 0, arc: 0, detour: 0, refused: 0,
        // The flight's weave.
        wob: 0, wobv: 0,
        // The flight's path home: its waypoints, the one it is making for, the cells' passability as planned over (pure, so never rolled back), and the tick it was last planned on.
        path: [], wp: 0, cells: new Map(), planned: -1,
        // The cap it is going for, whether this gather has taken it, the caps gone this chapter (flat x, z: its own and her picks), and the bundle: caps carried, and the carrier drawing them.
        cx: 0, cz: 0, took: false, eaten: [], bundle: 0, carrier: null,
        // Seconds the recoil has left, and to the next call or pant, and whether the last was a pant.
        hold: 0, voice: 0, panted: false, squeal: 0,
        // The clip playing, how long it holds, that step's whole length, the clip's own length, a count of starts, and the ground speed.
        clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0,
        lod: LOD_TIERS, puppet: null,
        ...easeFields(),
      }
      c.rand = () => roll(c)
      this.slots.push(c)
    }
    this.free = this.slots.slice()
    this.byKey = new Map()
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.durations = null
    // One-shots for the ear, drained by voices(): { sound, x, y, z }.
    this.calls = []
    this.feet = { x: 0, y: 0, z: 0 }
    this.head = { x: 0, y: 0, z: 0 }
    // The room: wire -> tick -> its anchors in key order; anchors owed, drained by pending(); the last frame's tick; every site's wire.
    this.hearsOwn = true
    this.logs = new Map()
    this.outbox = []
    this.now = null
    this.pruneAt = 0
    this.wires = new Map()
    this._sites = []
    this._seen = new Set()
    this._caps = []
    // Set while this layer pulls a cap itself, so its own takes are not her picks.
    this.taking = false
    if (mushrooms) mushrooms.onTake = (x, z) => { if (!this.taking) this._picked(x, z) }
    this.frame = 0
    this.loaded = false
    this.starved = 0
    this.overflow = 0
    this.fled = 0
    this.frights = 0
    this.picks = 0
    this.rewinds = 0
    // The deepest rollback yet in ticks, and pops drawn and when one was last said (net-ease.js).
    this.maxRewind = 0
    this.jumps = 0
    this.jumpSaidAt = -Infinity

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

  /** Whether a leafkin of `site` may stand at (x, z): the ground's open cells and clear of every resident mouth's flanking stones, or anything short of BLOCKED inside FINAL_M of its own mouth. */
  open(site, x, z) {
    const v = this.ground.cell(x, z)
    if (v === BLOCKED) return false
    const hx = x - site.x, hz = z - site.z
    if (hx * hx + hz * hz <= FINAL_M * FINAL_M) return true
    if (v === STONE) return false
    for (const s of this._sites) {
      const sx = x - s.x, sz = z - s.z
      const reach = s.flankReach + FLANK_PAD
      if (sx * sx + sz * sz > reach * reach) continue
      for (const f of s.flank) {
        const dx = x - f.x, dz = z - f.z, r = f.r + FLANK_PAD
        if (dx * dx + dz * dz < r * r) return false
      }
    }
    return true
  }

  get stats() {
    const states = { roam: 0, gather: 0, startle: 0, flee: 0, home: 0, inside: 0 }
    for (const c of this.byKey.values()) states[c.state]++
    return { alive: this.byKey.size, states, puppets: this.puppets.length - this.freePuppets.length, fled: this.fled, frights: this.frights, picks: this.picks, rewinds: this.rewinds, maxRewind: this.maxRewind, jumps: this.jumps, starved: this.starved, overflow: this.overflow }
  }

  /** Every leafkin drawn this frame, for the ear: its frame pose, with x, y, z, size, clip, cycle and speed. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.byKey.values()) if (c.lod < LOD_TIERS && c.state !== 'inside') into.push(c.pose)
    return into
  }

  /** The one-shots since the last call, each `{ sound, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
    return into
  }

  // -------------------------------------------------------------------------
  // Coming and going.
  // -------------------------------------------------------------------------

  /** A free slot made the site's. */
  _claim(site) {
    const c = this.free.pop()
    if (!c) { this.overflow++; return null }
    c.key = site.key
    c.wire = this.wires.get(site.key)
    c.site = site
    c.size = sizeOf(site.key)
    c.k = c.size / this.asset.height
    c.live = -1
    c.rewind = Infinity
    c.cells.clear()
    c.lod = LOD_TIERS
    c.puppet = null
    c.cue = 0
    c.shown = false
    this.byKey.set(site.key, c)
    return c
  }

  /** Let go: she is out of its reach, or its site evicted. */
  _retire(c) {
    this._releasePuppet(c)
    c.carrier?.release()
    c.carrier = null
    c.snaps.length = 0
    this.byKey.delete(c.key)
    c.key = ''
    c.site = null
    this.free.push(c)
  }

  /** At the chapter `seconds` falls in, placed on its first tick, which is never stepped, and out of its mouth; the anchors before it let go. */
  _place(c, seconds) {
    const { index, start } = chapterOf(seconds, c.key)
    c.startTick = c.tick = tickAfter(start)
    c.turnTick = tickAfter(start + CHAPTER_S)
    c.homingTick = c.turnTick - HOMING_S * TICK_HZ
    c.live = Math.max(c.live, c.tick)
    c.rs = hash32(keyHash(c.key), index)
    c.eaten.length = 0
    c.bundle = 0
    c.carrier?.clear()
    const log = this.logs.get(c.wire)
    if (log) for (const t of log.keys()) if (t <= c.startTick) log.delete(t)
    this._emerge(c)
    c.snaps.length = 0
    this._snap(c)
  }

  /** Out of the mouth point, facing out from the face, give or take an eighth of a turn. */
  _emerge(c) {
    const site = c.site
    c.x = c.px = site.x
    c.z = c.pz = site.z
    c.heading = c.ph = c.aim = Math.atan2(-site.nz, site.nx) + (c.rand() - 0.5) * (Math.PI / 2)
    c.wob = c.wobv = 0
    c.squeal = 0
    c.took = false
    this._roam(c)
  }

  /** Home: its bundle into the village, and in until EMPTY_S from now. */
  _inside(c, tick) {
    c.state = 'inside'
    c.until = tick + EMPTY_S * TICK_HZ
    c.bundle = 0
    c.carrier?.clear()
    this.fled++
  }

  // -------------------------------------------------------------------------
  // What it is doing.
  // -------------------------------------------------------------------------

  _toward(c, x, z) { return Math.atan2(-(z - c.z), x - c.x) }

  /** A one-shot at its chest, on a tick heard. */
  _voice(c, sound) {
    if (!c.voicing) return
    this.calls.push({ sound, x: c.x, y: this.walk.heightAt(c.x, c.z) + c.size * CHEST, z: c.z })
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
    this._arc(c)
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

  _arc(c) {
    const off = swing(c.heading, this._toward(c, c.tx, c.tz))
    const toward = Math.sign(off) || 1
    c.curve = (c.rand() < 0.5 + 0.5 * Math.min(1, Math.abs(off) / (Math.PI / 2)) ? toward : -toward) * between(c.rand, ARC_CURVE)
    c.arc = between(c.rand, ARC_M)
  }

  _eaten(c, x, z) {
    const e = c.eaten
    for (let i = 0; i < e.length; i += 2) if (Math.abs(e[i] - x) < TOLERANCE_M && Math.abs(e[i + 1] - z) < TOLERANCE_M) return true
    return false
  }

  /** The nearest cap within SEEK_M not gone this chapter, gone for with a squeal; false with none, or the bundle full. */
  _seek(c) {
    if (c.bundle >= CARRY_MAX) return false
    this._caps.length = 0
    const caps = this.ground.capsNear(c.x, c.z, SEEK_M, this._caps)
    let best = -1, bestD = Infinity
    for (let i = 0; i < caps.length; i += 2) {
      const d = Math.hypot(caps[i] - c.x, caps[i + 1] - c.z)
      if (d < bestD && !this._eaten(c, caps[i], caps[i + 1])) { bestD = d; best = i }
    }
    if (best < 0) return false
    c.state = 'gather'
    c.detour = 0
    c.refused = 0
    c.cx = caps[best]
    c.cz = caps[best + 1]
    if (c.squeal <= 0) { this._voice(c, 'leafkinSqueal'); c.squeal = SQUEAL_S }
    this._play(c, 'run', STEP_S)
    return true
  }

  /** A fright: face where her feet were, recoil, the bundle let fall. Screamed the first time it is stepped on a frame that is heard. */
  _startle(c, e) {
    c.state = 'startle'
    c.hold = STARTLE_S
    c.aim = this._toward(c, e.x, e.z)
    c.bundle = 0
    this._drop(c)
    if (!e.done && !e.screamed && c.loud) this.calls.push({ sound: 'leafkinScream', x: c.x, y: this.walk.heightAt(c.x, c.z) + c.size * CHEST, z: c.z })
    this._play(c, 'recoil', STARTLE_S)
  }

  /** The way home, fleeing or (`calm`) homing. */
  _flee(c, calm) {
    c.state = calm ? 'home' : 'flee'
    c.path = []
    c.wp = 0
    c.planned = -1
    c.refused = 0
    c.wob = 0; c.wobv = 0
    c.voice = between(c.rand, calm ? CHATTER_S : WHIMPER_S)
    c.panted = true
    this._play(c, calm && c.bundle > 0 ? 'run-carry' : 'run', STEP_S)
  }

  /** The step's clip has run out: a gait is extended in place, a gather ends on the next cap or the roam. */
  _step(c) {
    if (c.state === 'gather' && c.clip === 'gather') {
      if (!this._seek(c)) this._roam(c)
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
    return !this.open(c.site, c.x + Math.cos(heading) * ahead, c.z - Math.sin(heading) * ahead)
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
    if (tick % 5 === 0 && this._seek(c)) return
    if (c.detour <= 0) {
      const d = c.speed * dt
      c.arc -= d
      if (c.arc <= 0) this._arc(c)
      c.aim = c.heading + c.curve * d
    }
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
    // The cap picked from under it, or the ground refusing three times: back to the roam.
    if (c.refused >= 3 || this._eaten(c, c.cx, c.cz)) { this._roam(c); return }
    if (c.detour <= 0) c.aim = this._toward(c, c.cx, c.cz)
    this._advance(c, dt)
  }

  /** The gather's key: the cap into the bundle, and out of this client's ground and into the arms if it stands here. Picked meanwhile, and the reach closes on air. */
  _take(c) {
    if (this._eaten(c, c.cx, c.cz)) return
    c.eaten.push(c.cx, c.cz)
    c.bundle++
    const m = this.mushrooms
    if (!m) return
    const hit = m.pickAt(c.cx, this.walk.heightAt(c.cx, c.cz) + 0.1, c.cz, REACH_M)
    if (!hit || Math.abs(m.instX[hit.id] - c.cx) >= TOLERANCE_M || Math.abs(m.instZ[hit.id] - c.cz) >= TOLERANCE_M) return
    this.taking = true
    let rec
    try { rec = m.take(hit) } finally { this.taking = false }
    if (!this.hands) return
    if (!c.carrier) {
      if (this.hands.carriers >= CARRIERS) return
      c.carrier = this.hands.carry(`leafkin:${c.key}`, c.size * CARRY_SPAN)
    }
    if (c.carrier.count() < CARRY_MAX) c.carrier.add(rec, m)
  }

  /** The arms emptied: let fall where it is drawn, or gone with it where it is not. */
  _drop(c) {
    if (!c.carrier || c.carrier.count() === 0) return
    if (c.lod < LOD_TIERS && c.state !== 'inside') c.carrier.scatter()
    else c.carrier.clear()
  }

  _tickFlee(c, tick, dt) {
    const site = c.site
    const calm = c.state === 'home'
    if (Math.hypot(site.ax - c.x, site.az - c.z) <= HOME_M) { this._inside(c, tick); return }
    const dx = site.x - c.x, dz = site.z - c.z
    if (Math.hypot(dx, dz) <= FINAL_M) {
      c.aim = Math.atan2(c.z - site.az, site.ax - c.x)
      const d = c.speed * dt * this._turn(c, dt, FLEE_TURN)
      c.x += Math.cos(c.heading) * d
      c.z -= Math.sin(c.heading) * d
    } else {
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
      if (this.open(site, nx, nz)) { c.x = nx; c.z = nz; c.refused = 0 } else {
        c.wob = 0; c.wobv = 0
        if (++c.refused >= REPLAN_TICKS && tick - c.planned >= REPLAN_TICKS) this._plan(c, tick)
      }
    }
    c.voice -= dt
    if (c.voice <= 0) {
      if (calm) this._call(c, `leafkinChatter${1 + Math.min(CHATTERS - 1, (c.rand() * CHATTERS) | 0)}`, CHATTER_S)
      else this._call(c, 'leafkinWhimper', WHIMPER_S)
    }
  }

  /** The path home from where it stands: planPath's over the ground's own grid, to a cell whose reach puts it inside FINAL_M of the mouth point. */
  _plan(c, tick) {
    const site = c.site
    c.path = planPath((x, z) => this.open(site, x, z), c.cells, Math.round(site.x / CELL) * CELL, Math.round(site.z / CELL) * CELL, c.x, c.z, site.x, site.z, FINAL_M - WAYPOINT_M, PLAN_OPEN)
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
      for (let i = 1; i <= n && clear; i++) clear = this.open(c.site, c.x + (dx * i) / n, c.z + (dz * i) / n)
      if (clear) return k
    }
    return c.wp + 1
  }

  /**
   * Tick `t`, `want` the frame's: the chapter's turn places it afresh; a tick
   * heard near the frame's looks for her feet first; the tick's anchors
   * (key order), the homing, then its state.
   */
  _stepOne(c, t, want) {
    if (t >= c.turnTick) {
      this._place(c, t / TICK_HZ)
      return
    }
    c.tick = t
    c.voicing = c.loud && t > c.live
    if (c.voicing && t > want - SILENT_TICKS && (c.state === 'roam' || c.state === 'gather' || c.state === 'home')) {
      const f = this.feet
      if (Math.hypot(c.x - f.x, c.z - f.z) < STARTLE_M && Math.abs(this.walk.heightAt(c.x, c.z) - f.y) < STARTLE_M && !this._owed(c, t)) {
        // Raised LEAD_TICKS on so a peer hears it before stepping that tick (net-ease.js), and screamed now on this client.
        const e = this._raise(c.wire, t + LEAD_TICKS, 'fright', f.x, f.y, f.z)
        e.screamed = true
        this.calls.push({ sound: 'leafkinScream', x: c.x, y: this.walk.heightAt(c.x, c.z) + c.size * CHEST, z: c.z })
      }
    }
    const events = this.logs.get(c.wire)?.get(t)
    if (events) {
      for (const e of events) {
        if (e.kind === 'pick') c.eaten.push(e.x, e.z)
        else if (c.state === 'roam' || c.state === 'gather' || c.state === 'home') { if (!e.done) this.frights++; this._startle(c, e) }
      }
    }
    if (t >= c.homingTick && (c.state === 'roam' || c.state === 'gather')) this._flee(c, true)
    this._tick(c, t)
    if (events) for (const e of events) e.done = true
    c.live = Math.max(c.live, t)
    c.voicing = false
    if (t % SNAP_TICKS === 0) this._snap(c)
  }

  _tick(c, tick) {
    c.px = c.x; c.pz = c.z; c.ph = c.heading
    const dt = TICK_S
    c.squeal -= dt
    switch (c.state) {
      case 'roam': this._tickRoam(c, tick, dt); break
      case 'gather': this._tickGather(c, dt); break
      case 'startle':
        c.hold -= dt
        this._turn(c, dt, FLEE_TURN)
        if (c.hold <= 0) this._flee(c, false)
        break
      case 'flee': case 'home': this._tickFlee(c, tick, dt); break
      case 'inside':
        if (tick >= c.until && tick < c.homingTick) this._emerge(c)
        return
      default: throw new Error(`Leafkin: no state named ${c.state}`)
    }
    if (c.state === 'inside') return
    c.left -= dt
    if (c.left <= 0) this._step(c)
  }

  /** Whether a fright already stands on tick `t` (stepped after this looks) or one her lead could reach. */
  _owed(c, t) {
    const log = this.logs.get(c.wire)
    if (log) for (let k = t; k <= t + LEAD_TICKS; k++) if (log.get(k)?.some((e) => e.kind === 'fright')) return true
    return false
  }

  /** The state as it stands, kept for a rollback. */
  _snap(c) {
    c.snaps.push({ tick: c.tick, kept: KEPT.map((f) => c[f]), path: c.path, eaten: c.eaten.length })
    if (c.snaps.length > SNAPS) c.snaps.shift()
  }

  /** Back to the last state kept before the anchor heard late, or the chapter's start if none is. */
  _rollback(c) {
    this.rewinds++
    while (c.snaps.length > 0 && c.snaps[c.snaps.length - 1].tick >= c.rewind) c.snaps.pop()
    const s = c.snaps[c.snaps.length - 1]
    const clip = c.clip
    if (!s) this._place(c, c.tick / TICK_HZ)
    else {
      c.tick = s.tick
      KEPT.forEach((f, k) => { c[f] = s.kept[k] })
      // A path is replaced whole, never edited, so the one kept is the one it had.
      c.path = s.path
      c.eaten.length = s.eaten
    }
    // A clip the rollback changed is started afresh, the puppet reading a new cue.
    if (c.clip !== clip) c.cue++
  }

  // -------------------------------------------------------------------------
  // The room: her frights and picks out, the others' in (creature-net.js).
  // -------------------------------------------------------------------------

  /** Her doing on tick `tick` at a site: snapped as the room will carry it, logged, and owed to the room. */
  _raise(wire, tick, kind, x, y, z) {
    x = snap(x); y = snap(y); z = snap(z)
    const key = `${wire}${tick.toString(36)}:${hash32(Math.round(x * 1000), Math.round(z * 1000), kind === 'pick' ? 1 : 0).toString(36)}`
    const e = this._log(wire, { key, tick, kind, x, y, z, done: false })
    this.outbox.push([key, tick / TICK_HZ, x, y, z, 0, 0, kind, null])
    return e
  }

  /** Into the site's log in key order, so every client steps a tick's anchors alike; the one already there if the key is. */
  _log(wire, e) {
    let log = this.logs.get(wire)
    if (!log) this.logs.set(wire, (log = new Map()))
    let events = log.get(e.tick)
    if (!events) log.set(e.tick, (events = []))
    const had = events.find((o) => o.key === e.key)
    if (had) return had
    events.push(e)
    events.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return e
  }

  /** Her hand took a cap at (x, z): a pick for every resident site whose leafkin could go for it, on the next tick stepped. */
  _picked(x, z) {
    if (this.now === null) return
    const reach = ROAM_M + SEEK_M
    for (const site of this._sites) {
      if (Math.hypot(x - site.x, z - site.z) > reach) continue
      this._raise(this.wires.get(site.key), this.now + 1, 'pick', x, 0, z)
      this.picks++
    }
  }

  /** Her anchors since the last call, as `[key, T, x, y, z, 0, 0, 'fright' | 'pick', null]`, drained. */
  pending(into) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** Someone's fright or pick: logged, and stepped again from before it if its site is stepped past it. One before its site's chapter, or already logged, is let go. */
  apply(a) {
    const kind = a[7]
    const at = typeof a[0] === 'string' && a[0].startsWith('lk:') ? a[0].indexOf(':', 3) : -1
    const tick = Math.round(a[1] * TICK_HZ)
    if (at < 0 || (kind !== 'fright' && kind !== 'pick') || ![tick, a[2], a[3], a[4]].every(Number.isFinite)) throw new Error(`Leafkin: a malformed anchor ${JSON.stringify(a)}`)
    const wire = a[0].slice(0, at + 1)
    const c = this.byKey.get(this._siteOf(wire))
    if (c && tick <= c.startTick) return
    const e = { key: a[0], tick, kind, x: a[2], y: a[3], z: a[4], done: false }
    if (this._log(wire, e) !== e) return
    if (c && tick <= c.tick) c.rewind = Math.min(c.rewind, tick)
  }

  _siteOf(wire) {
    for (const [key, w] of this.wires) if (w === wire) return key
    return undefined
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
   * room's clock (clock.js WorldClock.seconds) and `dt` the frame's own time,
   * for the puppets. A site is taken up when her feet come within its roam and
   * cull, placed at its chapter's start and caught up CATCH_UP_TICKS a frame,
   * silent and undrawn; let go SIM_OUT_M further out or when evicted.
   */
  update(feet, head, seconds, dt) {
    if (!this.loaded) return
    this.frame++
    this.feet.x = feet.x; this.feet.y = feet.y; this.feet.z = feet.z
    this.head.x = head.x; this.head.y = head.y; this.head.z = head.z
    const want = tickOf(seconds)
    this.now = want

    const sites = this._sites
    sites.length = 0
    this.entrances.sites(sites)
    const seen = this._seen
    seen.clear()
    for (const site of sites) {
      if (!this.wires.has(site.key)) this.wires.set(site.key, wireOf(site.key))
      seen.add(site.key)
      const reach = ROAM_M + cullRange(sizeOf(site.key))
      const d = Math.hypot(site.x - feet.x, site.z - feet.z)
      const c = this.byKey.get(site.key)
      if (c) {
        c.site = site
        if (d > reach + SIM_OUT_M) this._retire(c)
      } else if (d <= reach) {
        const n = this._claim(site)
        if (n) this._place(n, seconds)
      }
    }
    for (const c of [...this.byKey.values()]) if (!seen.has(c.key)) this._retire(c)

    for (const c of this.byKey.values()) {
      let rewound = -1
      if (want - c.tick > CHAPTER_S * TICK_HZ) this._place(c, seconds)
      else if (c.rewind <= c.tick) {
        if (c.shown) keepWas(c, (seconds - c.tick * TICK_S) * TICK_HZ, 0)
        rewound = c.tick - c.rewind
        this.maxRewind = Math.max(this.maxRewind, rewound)
        this._rollback(c)
      }
      c.rewind = Infinity
      c.loud = want - c.live <= SILENT_TICKS
      const end = Math.min(want, c.tick + CATCH_UP_TICKS)
      for (let t = c.tick + 1; t <= end; t++) this._stepOne(c, t, want)
      c.alpha = c.tick < want ? 1 : clamp((seconds - c.tick * TICK_S) * TICK_HZ, 0, 1)
      // Arms holding more than the bundle does: a rollback undid a take, or a fright let it fall.
      if (c.carrier && c.carrier.count() > c.bundle) this._drop(c)
      this._draw(c, dt, want, rewound, seconds)
    }

    // Anchors older than a chapter are no site's any more.
    if (want >= this.pruneAt) {
      const old = want - CHAPTER_S * TICK_HZ
      for (const [wire, log] of this.logs) {
        for (const t of log.keys()) if (t < old) log.delete(t)
        if (log.size === 0) this.logs.delete(wire)
      }
      this.pruneAt = want + 60 * TICK_HZ
    }
  }

  /** The frame's pose between the last two ticks, stood on the walker's ground, and the puppet on it; nothing drawn inside or still catching up. */
  _draw(c, dt, want, rewound, seconds) {
    const a = c.alpha
    const pose = c.pose
    const site = c.site
    const hidden = c.state === 'inside' || c.tick < want
    const wasX = pose.x, wasZ = pose.z
    ease(c, pose, c.px + (c.x - c.px) * a, 0, c.pz + (c.z - c.pz) * a, c.ph + swing(c.ph, c.heading) * a, rewound >= 0, dt)
    if (c.shown && !hidden && Math.hypot(pose.x - wasX, pose.z - wasZ) > JUMP_M) warnPop(this, seconds, { key: c.key, state: c.state, m: +Math.hypot(pose.x - wasX, pose.z - wasZ).toFixed(2), rewound })
    c.shown = !hidden
    // The last stretch is over the boulder's own footprint, where the walker's ground is the boulder's top: the arch's floor caps it there.
    pose.y = this.walk.heightAt(pose.x, pose.z)
    if (Math.hypot(site.x - pose.x, site.z - pose.z) <= FINAL_M) pose.y = Math.min(pose.y, Math.max(site.y, site.ay))
    pose.k = c.k
    pose.size = c.size
    pose.speed = c.speed
    pose.clip = c.clip
    pose.cycle = c.cycle
    if (c.carrier) c.carrier.place(pose.x, pose.y, pose.z, pose.heading, c.size * CHEST)

    const dist = Math.hypot(pose.x - this.head.x, pose.y - this.head.y, pose.z - this.head.z)
    c.lod = hidden ? LOD_TIERS : critterTier(c.size, dist, c.lod, LOD_TIERS)
    const tier = c.lod === LOD_TIERS ? -1 : c.lod
    const puppet = tier === -1 && !c.puppet ? null : this._takePuppet(c)
    if (!puppet) return
    puppet.show(tier)
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
    if (this.mushrooms) this.mushrooms.onTake = null
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
