// ---------------------------------------------------------------------------
// THE VILLAGERS: the leafkin who live in the village (rooms/village.js), one a
// house and EXTRA more, a metre tall, going about the roads. DESIGN.md §30 has
// the whole of it; here is the state machine and how it is stepped.
//
// They walk a GRAPH of the build's roads (roadGraph): every road but the pads
// sampled SAMPLE_M apart, a road's end joined to the nearest node of another
// within JOIN_M, and every house door a node off its nearest road node. Every
// trip is a shortest path over it, so a villager is always on the cobbles,
// which the build keeps dry, clear of the huts and off the lamps -- no step is
// probed. They step on the score's ticks (sim/score.js stepTo) of the room's
// clock, every roll off a PRNG seeded from the room, the villager and the
// chapter; at boot each is put inside its house at the chapter's start and
// its chapter so far is replayed silent, so she arrives on a village already
// about its day.
//
//   inside   in its house, unseen, INSIDE_S; then out of the door on an --
//   errand   home (walk to the door, inside), gaze (to one of GAZE_SPOTS on
//            the loop, GAZE_OFF_M off it toward the water, and stand facing
//            the lake GAZE_S), sit (to a free one of the room's `seats`, the
//            hearth's stools and the scattered ones, round its side to the
//            point its feet stand at) or wander (to a node of the loop, the
//            ring or a branch, and stand STAND_S), weighted by ERRANDS; then
//            another. Each goes at its own PACE, and a RUNNERS share run.
//   sit      at its stool: turns to its look (the fire, the lake), sits down
//            on the sit clip's first SIT_CUT[0] seconds, holds on idle-sit
//            SIT_S facing it, rises on the clip from SIT_CUT[1], and plans
//            again from its node. The stool is its from the errand's roll to
//            its rising; a talk or a fright on the way lets it go.
//   talk     two passing within TALK_M with neither TALK_COOL_S from its last
//            talk stop, face each other and chatter by turns TALK_S, a talk
//            gesture with every call.
//   flee     her feet within STARTLE_M: it runs home if home is CALM_M from
//            her and goes inside, else to the node farthest from her within
//            FLEE_M of road, whimpering and panting by turns, and plans again
//            from there; it never stands its ground. It calms only once she
//            is CALM_M off, and takes up an errand.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CHAPTER_S, SILENT_TICKS, TICK_S, chapterOf, hash32, stepTo, swing, tickAfter, tickOf } from '../../sim/score.js'
import { Spline } from '../layers/spline.js'
import { CRITTER_GLB, LOD_RUNGS, critterTier } from './critters.js'
import { Puppet, groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'

export const LOD_TIERS = LOD_RUNGS
export const PUPPETS = 8
// Villagers past one a house; each lives in house k % houses.
export const EXTRA = 1
export const SIZE_M = 1
export const SIZE_VAR = 0.15
// Each villager's own pace, on the gait's ground speed and the clip's rate alike, and the share that run their errands rather than walk (never fewer than one a village).
export const PACE = [0.75, 1.3]
export const RUNNERS = 0.25
// The graph: metres between a road's nodes, how far a road's end reaches for another road, and how near a node counts as reached.
export const SAMPLE_M = 1.5
export const JOIN_M = 3
export const NODE_M = 0.35
// Gazing spots round the loop, each this far off it toward the water where that is dry and clear.
export const GAZE_SPOTS = 4
export const GAZE_OFF_M = 1
export const INSIDE_S = [20, 90]
export const STAND_S = [3, 10]
export const GAZE_S = [15, 40]
export const SIT_S = [20, 60]
export const ERRANDS = [['home', 0.2], ['gaze', 0.25], ['sit', 0.25], ['wander', 0.3]]
// The sit clip is one round trip, down by SIT_CUT[0] seconds and rising from SIT_CUT[1], the hold between them idle-sit's pose (tools/creatures/anim/clips/human/sit.json); at the hold the hips sit `back` of the wheelbase behind the feet and `drop` of the height down. The feet stand `clear` metres past the stool's edge at the least, or the walker would lift the sitter onto it, reached within `near` metres (NODE_M's slack would leave the hips off the stool), and it comes round the stool `round` metres wide of its side.
export const SIT_CUT = [1.4, 3.0]
export const SIT = { back: 0.5, drop: 0.2, clear: 0.05, near: 0.03, round: 0.5 }
export const TALK_M = 1.6
export const TALK_S = [8, 20]
export const TALK_COOL_S = 45
export const CHATTER_S = [1.5, 3]
export const CHATTERS = 4
export const STARTLE_M = 3
export const CALM_M = 30
export const FLEE_M = 60
export const WHIMPER_S = [2.7, 4.1]
// Road within this of her feet costs a fleer this many times its length, so it runs round her rather than past her.
const SHUN_M = 6
const SHUN = 10
export const TURN_RATE = 6
export const FLEE_TURN = 10
// A gait or a hold extended in place when it runs out; the chest, as a fraction of the body, the voice comes from.
const STEP_S = 2
const CHEST = 0.5
const FADE_S = 0.25
// Ticks between looks for someone to talk to.
const MEET_TICKS = 10

export const TALKS = ['talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug']
export const CLIPS = ['idle', 'walk', 'run', 'sit', 'idle-sit', ...TALKS]
// The clips whose feet stay put (puppet.js FootIK).
export const PLANTED = new Set(['idle', 'sit', 'idle-sit', ...TALKS])

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _trunk = { x: 0, z: 0, r: 0 }

/**
 * The roads as a graph: `nodes` `[{ x, z, road }]`, `adj` each node's
 * neighbours, and `doorNodes`, the node of each door in `doors` order (road
 * 'door'). `roads` are the build's doc roads, `[x, y, z, w]` points.
 */
export function roadGraph(roads, doors) {
  const nodes = [], adj = []
  const add = (x, z, road) => { nodes.push({ x, z, road }); adj.push([]); return nodes.length - 1 }
  const link = (a, b) => { if (a === b || adj[a].includes(b)) return; adj[a].push(b); adj[b].push(a) }
  const nearest = (x, z, skip) => {
    let best = -1, at = Infinity
    for (let i = 0; i < nodes.length; i++) {
      if (skip(i)) continue
      const d = Math.hypot(nodes[i].x - x, nodes[i].z - z)
      if (d < at) { at = d; best = i }
    }
    return [best, at]
  }
  const ends = []
  for (const r of roads) {
    if (r.id.startsWith('pad-')) continue
    const s = new Spline(r.pts).flatten(SAMPLE_M)
    let prev = -1, first = -1
    for (let i = 0; i < s.length; i += 4) {
      const n = add(s[i], s[i + 2], r.id)
      if (prev >= 0) link(prev, n); else first = n
      prev = n
    }
    ends.push(first, prev)
  }
  if (nodes.length === 0) throw new Error('roadGraph: no roads')
  // A road's end onto whatever road it was drawn to meet: another, or its own far end where it closes on itself.
  for (const e of ends) {
    const n = nodes[e]
    const [j, d] = nearest(n.x, n.z, (i) => i === e || (nodes[i].road === n.road && Math.abs(i - e) < 3))
    if (j >= 0 && d <= JOIN_M) link(e, j)
  }
  const doorNodes = doors.map(({ x, z }) => {
    const [j] = nearest(x, z, () => false)
    const n = add(x, z, 'door')
    link(n, j)
    return n
  })
  return { nodes, adj, doorNodes }
}

/**
 * Dijkstra over the graph from `from`: `dist` to every node and `parent`
 * along the way, stopped once `to` is settled (-1 for the whole graph). A
 * node's `weight`, if given, scales the length of every edge into it.
 */
export function dijkstra(g, from, to = -1, weight = null) {
  const n = g.nodes.length
  const dist = new Float64Array(n).fill(Infinity), parent = new Int32Array(n).fill(-1), done = new Uint8Array(n)
  const heapK = [], heapF = []
  const push = (k, f) => {
    let i = heapK.length
    heapK.push(k); heapF.push(f)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapF[p] <= heapF[i]) break
      ;[heapK[p], heapK[i]] = [heapK[i], heapK[p]]; [heapF[p], heapF[i]] = [heapF[i], heapF[p]]
      i = p
    }
  }
  const pop = () => {
    const k = heapK[0]
    const lk = heapK.pop(), lf = heapF.pop()
    if (heapK.length > 0) {
      heapK[0] = lk; heapF[0] = lf
      let i = 0
      for (;;) {
        const a = 2 * i + 1, b = a + 1
        let m = i
        if (a < heapK.length && heapF[a] < heapF[m]) m = a
        if (b < heapK.length && heapF[b] < heapF[m]) m = b
        if (m === i) break
        ;[heapK[m], heapK[i]] = [heapK[i], heapK[m]]; [heapF[m], heapF[i]] = [heapF[i], heapF[m]]
        i = m
      }
    }
    return k
  }
  dist[from] = 0
  push(from, 0)
  while (heapK.length > 0) {
    const k = pop()
    if (done[k]) continue
    done[k] = 1
    if (k === to) break
    const a = g.nodes[k]
    for (const j of g.adj[k]) {
      if (done[j]) continue
      const b = g.nodes[j]
      const d = dist[k] + Math.hypot(b.x - a.x, b.z - a.z) * (weight ? weight(j) : 1)
      if (d >= dist[j]) continue
      dist[j] = d
      parent[j] = k
      push(j, d)
    }
  }
  return { dist, parent }
}

/** The nodes from `from` to `to` after `from`, by `parent`; empty when `to` is unreached or is `from`. */
export function pathTo(parent, from, to) {
  if (to === from || parent[to] < 0) return []
  const path = []
  for (let k = to; k !== from; k = parent[k]) path.push(k)
  return path.reverse()
}

export class Villagers {
  /**
   * @param water        WaterSurfaces: isSubmerged, for the gazing spots
   * @param opts.walk    WalkSurface: heightAt, obstacleAt
   * @param opts.roads   the build's doc roads
   * @param opts.doors   RoomProps.doors(): `[{ x, z }]`
   * @param opts.lake    the build's lake: x, z
   * @param opts.seats   the stools, `[{ x, z, top, r, lookX, lookZ }]`: each a disc of `r` about (x, z) whose top is `top` in the world, sat on facing (lookX, lookZ)
   * @param opts.seed    the room's seed
   * @param opts.asset   a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, water, { walk, roads, doors, lake, seats = [], seed = 1, asset = null } = {}) {
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Villagers need WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.obstacleAt !== 'function') throw new Error('Villagers need the WalkSurface, for heightAt and obstacleAt')
    if (!Array.isArray(roads) || !Array.isArray(doors) || doors.length === 0) throw new Error('Villagers need the roads and at least one door')
    if (!lake || !Number.isFinite(lake.x) || !Number.isFinite(lake.z)) throw new Error('Villagers need the lake, for where to gaze')
    if (!Array.isArray(seats)) throw new Error('Villagers: seats is a list')
    this.water = water
    this.walk = walk
    this.seed = seed
    this.graph = roadGraph(roads, doors)
    const { nodes, doorNodes } = this.graph
    // Where a wander may end: any node of a road but the trunk, which leads only to her door.
    this.targets = nodes.map((n, i) => i).filter((i) => nodes[i].road !== 'd1' && nodes[i].road !== 'door')
    if (this.targets.length === 0) throw new Error('Villagers: no road to wander')
    // The seats, each reached from the node nearest it, and who has claimed it.
    this.seats = seats.map((s) => {
      if (![s.x, s.z, s.top, s.r, s.lookX, s.lookZ].every(Number.isFinite) || !(s.r > 0)) throw new Error(`Villagers: a seat is { x, z, top, r, lookX, lookZ }: ${JSON.stringify(s)}`)
      let node = -1, at = Infinity
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.hypot(nodes[i].x - s.x, nodes[i].z - s.z)
        if (d < at) { at = d; node = i }
      }
      return { x: s.x, z: s.z, top: s.top, r: s.r, lookX: s.lookX, lookZ: s.lookZ, node, by: null }
    })
    // The gazing spots: GAZE_SPOTS nodes spread along the loop, each with a stand a step toward the water where it can stand there, and no stool stands.
    const loop = nodes.map((n, i) => i).filter((i) => nodes[i].road === 'd2')
    if (loop.length === 0) throw new Error('Villagers: no loop to gaze from')
    this.spots = Array.from({ length: GAZE_SPOTS }, (_, k) => {
      const node = loop[Math.floor(((k + 0.5) / GAZE_SPOTS) * loop.length)]
      const n = nodes[node]
      const a = Math.atan2(lake.z - n.z, lake.x - n.x)
      const x = n.x + Math.cos(a) * GAZE_OFF_M, z = n.z + Math.sin(a) * GAZE_OFF_M
      const stool = this.seats.some((s) => Math.hypot(s.x - x, s.z - z) < s.r + SIT.round)
      return stool || this.seat(x, z) === null ? { node, x: n.x, z: n.z } : { node, x, z }
    })
    this.lake = { x: lake.x, z: lake.z }

    this.batch = new THREE.Group()
    this.batch.name = 'v2-villagers'
    scene.add(this.batch)
    this.plain = makeSettledMaterial('villagers')
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('villagers', this.plain)
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    this.all = []
    for (let k = 0; k < doors.length + EXTRA; k++) {
      this.all.push({
        id: k, key: `villager:${k}`, home: doorNodes[k % doors.length], rand: null, size: 1, k: 1, pace: 1, runner: false, turnTick: 0,
        // The tick's pose and the one before it, for the frame to lerp; `tick` and `alpha` are the score's.
        x: 0, y: 0, z: 0, heading: 0, px: 0, py: 0, pz: 0, ph: 0, aim: 0, tick: 0, alpha: 0,
        // The frame's pose, what the puppet and the ear are given.
        pose: { x: 0, y: 0, z: 0, heading: 0, k: 1, speed: 0, clip: 'idle', cycle: 0, size: 1 },
        // inside, walk, stand, gaze, sit, talk or flee; inside, it is drawn by nobody.
        state: 'inside', hidden: true,
        // The node it stands at or is making for, the route on from it (`{ x, z, node }`, node -1 off the road), the point of it it is on, and what the route's end is for: stand, gaze, sit, enter, calm.
        at: 0, route: [], wp: 0, then: 'stand',
        // Seconds the state has left, to the next call, whether the last was a pant, and until it will talk again; who it is talking to; the seat it has claimed and where a sit is: turn, down, hold, up.
        hold: 0, voice: 0, panted: false, talked: 0, partner: null, seat: null, phase: '',
        // The clip playing, how long it holds, that step's whole length, the clip's own length, a count of steps, the ground speed, and the second of the clip the step cuts in at (-1 to fade in from its start).
        clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0, from: -1,
        lod: LOD_TIERS, puppet: null,
      })
    }
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.durations = null
    // One-shots for the ear, drained by voices(): { sound, x, y, z }.
    this.pending = []
    this.feet = { x: 0, y: 0, z: 0 }
    this.head = { x: 0, y: 0, z: 0 }
    this.frame = 0
    this.loaded = false
    this.placed = false
    this.starved = 0
    this.talks = 0
    this.startles = 0

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
    for (const name of CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`Villagers: the asset has no ${name} clip`)
    this.asset = asset
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    if (!(this.durations.sit > SIT_CUT[1] && SIT_CUT[0] < SIT_CUT[1])) throw new Error(`Villagers: the sit clip is ${this.durations.sit} s, cut at ${SIT_CUT}`)
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
    let fastest = null
    for (const c of this.all) {
      const rand = mulberry32(hash32(this.seed, c.id))
      c.size = SIZE_M * (1 + SIZE_VAR * (2 * rand() - 1))
      c.k = c.size / asset.height
      c.pace = between(rand, PACE)
      c.runner = rand() < RUNNERS
      if (fastest === null || c.pace > fastest.pace) fastest = c
    }
    if (!this.all.some((c) => c.runner)) fastest.runner = true
    this.loaded = true
  }

  /** The ground at (x, z) it may stand on, or null: dry and clear of a trunk. */
  seat(x, z) {
    const y = this.walk.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (this.walk.obstacleAt(x, z, _trunk)) return null
    return y
  }

  get stats() {
    const states = { inside: 0, walk: 0, stand: 0, gaze: 0, sit: 0, talk: 0, flee: 0 }
    for (const c of this.all) states[c.state]++
    return { count: this.all.length, states, puppets: this.puppets.length - this.freePuppets.length, starved: this.starved, talks: this.talks, startles: this.startles, nodes: this.graph.nodes.length, seats: this.seats.length, taken: this.seats.filter((s) => s.by !== null).length }
  }

  /** Every villager drawn this frame, for the ear: its frame pose, with x, y, z, size, clip, cycle and speed. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const c of this.all) if (!c.hidden && c.lod < LOD_TIERS) into.push(c.pose)
    return into
  }

  /** The one-shots since the last call, each `{ sound, x, y, z }`, drained. */
  voices(into) {
    for (const v of this.pending) into.push(v)
    this.pending.length = 0
    return into
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

  _chatter(c) {
    return `leafkinChatter${1 + Math.min(CHATTERS - 1, (c.rand() * CHATTERS) | 0)}`
  }

  /** The step's clip: faded in from its start, or cut in at `from` seconds of it. */
  _play(c, clip, seconds, from = -1) {
    c.clip = clip
    c.dur = seconds
    c.left = seconds
    c.cycle = this.durations[clip] / c.pace
    c.cue++
    c.from = from
    const speed = this.asset.gait[clip]
    c.speed = speed === undefined ? 0 : speed * c.k * c.pace
  }

  /** The step's clip has run out: extended in place, a talk gesture ending on the idle, a sit's cut ending its phase. */
  _step(c) {
    if (c.state === 'talk' && c.clip !== 'idle') { this._play(c, 'idle', STEP_S); return }
    if (c.state === 'sit' && c.phase === 'down') { this._phase(c, 'hold'); return }
    if (c.state === 'sit' && c.phase === 'up') { this._rise(c); return }
    c.left = c.dur = STEP_S
  }

  /** Into its house at the chapter's start, `wait` seconds from coming out; the frame it is placed on is the chapter's first tick. */
  _place(c, seconds) {
    const { index, start } = chapterOf(seconds, c.key)
    c.rand = mulberry32(hash32(this.seed, c.id, index))
    c.turnTick = tickAfter(start + CHAPTER_S)
    c.tick = tickOf(start)
    c.alpha = 0
    const home = this.graph.nodes[c.home]
    c.x = c.px = home.x
    c.z = c.pz = home.z
    // The road at the door, read from under any stone: the door stands under the house's awning.
    c.y = c.py = this.walk.heightAt(c.x, c.z, -Infinity)
    c.heading = c.ph = c.aim = 0
    c.at = c.home
    c.partner = null
    c.talked = 0
    c.lod = LOD_TIERS
    this._leaveSeat(c)
    this._inside(c, c.rand() * INSIDE_S[1])
  }

  _leaveSeat(c) {
    if (c.seat === null) return
    if (c.seat.by !== c) throw new Error(`Villagers: ${c.key} leaves a seat it does not hold`)
    c.seat.by = null
    c.seat = null
  }

  _inside(c, wait) {
    c.state = 'inside'
    c.hidden = true
    c.hold = wait
    c.route.length = 0
    c.wp = 0
    this._play(c, 'idle', STEP_S)
  }

  /** Out of the door and off on an errand. */
  _exit(c) {
    c.hidden = false
    this._errand(c)
  }

  /** A route to `node`, and beyond it `extra` off-road points, ending in `then`; a seat claimed for anything else is let go. */
  _go(c, node, then, extra = []) {
    this._leaveSeat(c)
    const { nodes } = this.graph
    const { parent } = dijkstra(this.graph, c.at, node)
    c.route = pathTo(parent, c.at, node).map((k) => ({ x: nodes[k].x, z: nodes[k].z, node: k }))
    for (const p of extra) c.route.push({ x: p.x, z: p.z, node: -1 })
    c.wp = 0
    c.then = then
    c.state = 'walk'
    this._play(c, c.runner ? 'run' : 'walk', STEP_S)
    if (c.route.length === 0) this._arrive(c)
  }

  _errand(c) {
    let roll = c.rand() * ERRANDS.reduce((s, [, w]) => s + w, 0)
    let kind = ERRANDS[ERRANDS.length - 1][0]
    for (const [k, w] of ERRANDS) { roll -= w; if (roll < 0) { kind = k; break } }
    if (kind === 'home' && c.at !== c.home) { this._go(c, c.home, 'enter'); return }
    if (kind === 'gaze') {
      const s = this.spots[(c.rand() * this.spots.length) | 0]
      this._go(c, s.node, 'gaze', s.x === this.graph.nodes[s.node].x && s.z === this.graph.nodes[s.node].z ? [] : [s])
      return
    }
    if (kind === 'sit') {
      const free = this.seats.filter((s) => s.by === null)
      if (free.length > 0) { this._seat(c, free[(c.rand() * free.length) | 0]); return }
    }
    let node = this.targets[(c.rand() * this.targets.length) | 0]
    if (node === c.at) node = this.targets[(this.targets.indexOf(node) + 1) % this.targets.length]
    this._go(c, node, 'stand')
  }

  _stand(c, hold) {
    c.state = 'stand'
    c.hold = hold
    this._play(c, 'idle', STEP_S)
  }

  _gaze(c) {
    c.state = 'gaze'
    c.hold = between(c.rand, GAZE_S)
    c.aim = this._toward(c, this.lake.x, this.lake.z)
    this._play(c, 'idle', STEP_S)
  }

  /** Its way onto `seat` from the seat's node: `feet`, where they stand, `SIT.back` of the wheelbase short of the stool's centre toward its look, and `round`, level with them SIT.round wide of the stool on the side its node is on. */
  _approach(c, seat) {
    const ax = seat.lookX - seat.x, az = seat.lookZ - seat.z, len = Math.hypot(ax, az)
    if (!(len > seat.r)) throw new Error(`Villagers: a seat looks at its own stool`)
    const ux = ax / len, uz = az / len
    const fore = Math.max(SIT.back * this.asset.wheelbase * c.k, seat.r + SIT.clear)
    const n = this.graph.nodes[seat.node]
    const wide = (Math.sign(-uz * (n.x - seat.x) + ux * (n.z - seat.z)) || 1) * (seat.r + SIT.round)
    const feet = { x: seat.x + ux * fore, z: seat.z + uz * fore }
    return { feet, round: { x: feet.x - uz * wide, z: feet.z + ux * wide } }
  }

  /** Off to `seat`, its from now. */
  _seat(c, seat) {
    const { feet, round } = this._approach(c, seat)
    this._go(c, seat.node, 'sit', [round, feet])
    c.seat = seat
    seat.by = c
  }

  /** Up from its stool: back round it to its node, and an errand from there. */
  _rise(c) {
    const { round } = this._approach(c, c.seat)
    const n = this.graph.nodes[c.at]
    this._go(c, c.at, 'errand', [round, { x: n.x, z: n.z }])
  }

  /** A sit's phases in turn: turn to the look, down on the sit clip's first cut, the seated hold, and up on its last; the cuts end with their step (_step). */
  _phase(c, phase) {
    c.phase = phase
    switch (phase) {
      case 'turn': c.aim = this._toward(c, c.seat.lookX, c.seat.lookZ); this._play(c, 'idle', STEP_S); break
      case 'down': this._play(c, 'sit', SIT_CUT[0] / c.pace); break
      case 'hold': c.hold = between(c.rand, SIT_S); this._play(c, 'idle-sit', STEP_S); break
      case 'up': this._play(c, 'sit', (this.durations.sit - SIT_CUT[1]) / c.pace, SIT_CUT[1]); break
      default: throw new Error(`Villagers: no sit phase named ${phase}`)
    }
  }

  /** The route's end. A gazer or a sitter walks back to its node before its next errand. */
  _arrive(c) {
    switch (c.then) {
      case 'stand': this._stand(c, between(c.rand, STAND_S)); break
      case 'gaze': this._gaze(c); break
      case 'sit': c.state = 'sit'; this._phase(c, 'turn'); break
      case 'enter': this._inside(c, between(c.rand, INSIDE_S)); break
      case 'errand': this._errand(c); break
      case 'calm':
        if (this._farFromHer(c) >= CALM_M) this._errand(c)
        else this._flee(c)
        break
      default: throw new Error(`Villagers: a route ends in ${c.then}`)
    }
  }

  _talk(a, b) {
    const hold = between(a.rand, TALK_S)
    for (const [c, other, first] of [[a, b, true], [b, a, false]]) {
      c.state = 'talk'
      c.partner = other
      c.hold = hold
      c.voice = first ? 0.2 : between(c.rand, CHATTER_S) / 2
      c.aim = this._toward(c, other.x, other.z)
      c.route.length = 0
      c.wp = 0
      this._leaveSeat(c)
      this._play(c, 'idle', STEP_S)
    }
    this.talks++
  }

  /** Out of a talk: the partner left standing takes up an errand of its own. */
  _untalk(c) {
    const p = c.partner
    c.partner = null
    c.talked = TALK_COOL_S
    if (p && p.partner === c) {
      p.partner = null
      p.talked = TALK_COOL_S
      this._stand(p, between(p.rand, STAND_S))
    }
  }

  _farFromHer(c) { return Math.hypot(c.x - this.feet.x, c.z - this.feet.z) }

  _startle(c) {
    this.startles++
    if (c.state === 'talk') this._untalk(c)
    c.voice = 0.1
    c.panted = true
    this._flee(c)
  }

  /** Home if home is CALM_M from her, else the node farthest from her within FLEE_M of road, never the one it stands on: a cornered villager runs back the way it came rather than stand. */
  _flee(c) {
    this._leaveSeat(c)
    const { nodes } = this.graph
    const home = nodes[c.home]
    const shun = (j) => (Math.hypot(nodes[j].x - this.feet.x, nodes[j].z - this.feet.z) < SHUN_M ? SHUN : 1)
    if (Math.hypot(home.x - this.feet.x, home.z - this.feet.z) >= CALM_M && c.at !== c.home) {
      const { parent } = dijkstra(this.graph, c.at, c.home, shun)
      c.route = pathTo(parent, c.at, c.home).map((k) => ({ x: nodes[k].x, z: nodes[k].z, node: k }))
      c.then = 'enter'
    } else {
      const { dist, parent } = dijkstra(this.graph, c.at, -1, shun)
      let best = -1, far = -Infinity
      for (let j = 0; j < nodes.length; j++) {
        if (j === c.at || dist[j] > FLEE_M) continue
        const d = Math.hypot(nodes[j].x - this.feet.x, nodes[j].z - this.feet.z)
        if (d > far) { far = d; best = j }
      }
      if (best < 0) throw new Error(`Villagers: ${c.key} has nowhere to run from node ${c.at}`)
      c.route = pathTo(parent, c.at, best).map((k) => ({ x: nodes[k].x, z: nodes[k].z, node: k }))
      c.then = 'calm'
    }
    c.wp = 0
    c.state = 'flee'
    this._play(c, 'run', STEP_S)
  }

  /** Ease the heading toward the aim, and report the cosine of the swing still owed, so a body half turned makes half a step. */
  _turn(c, dt, rate = TURN_RATE) {
    const s = swing(c.heading, c.aim)
    c.heading += Math.sign(s) * Math.min(Math.abs(s), rate * dt)
    return Math.max(0, Math.cos(s))
  }

  /**
   * A step along the route at the gait, carried through every point it
   * passes: a point within NODE_M is left behind where the villager stands
   * (never snapped to -- a snap every node was a lurch every 1.5 m of walk),
   * and the last left behind is the arrival; a seat's feet within SIT.near.
   */
  _follow(c, dt, rate) {
    const step = c.speed * dt
    let left = step
    while (left > 0) {
      const p = c.route[c.wp]
      const d = Math.hypot(p.x - c.x, p.z - c.z)
      if (d <= (c.then === 'sit' && c.wp === c.route.length - 1 ? SIT.near : NODE_M)) {
        if (p.node >= 0) c.at = p.node
        c.wp++
        if (c.wp >= c.route.length) { c.route.length = 0; c.wp = 0; this._arrive(c); return }
        continue
      }
      c.aim = this._toward(c, p.x, p.z)
      const m = Math.min(left, d)
      const moved = m * this._turn(c, (dt * m) / step, rate)
      c.x += Math.cos(c.heading) * moved
      c.z -= Math.sin(c.heading) * moved
      left -= m
    }
  }

  /** Someone else passing within TALK_M, with neither just out of a talk. */
  _meet(c) {
    if (c.talked > 0) return null
    for (const o of this.all) {
      if (o === c || o.talked > 0 || o.hidden || (o.state !== 'walk' && o.state !== 'stand')) continue
      if (Math.hypot(o.x - c.x, o.z - c.z) <= TALK_M) return o
    }
    return null
  }

  _tick(c, tick) {
    if (tick >= c.turnTick) {
      const { index, start } = chapterOf(tick * TICK_S, c.key)
      c.rand = mulberry32(hash32(this.seed, c.id, index))
      c.turnTick = tickAfter(start + CHAPTER_S)
    }
    c.px = c.x; c.py = c.y; c.pz = c.z; c.ph = c.heading
    const dt = TICK_S
    c.talked = Math.max(0, c.talked - dt)
    if (c.state !== 'inside' && c.state !== 'flee' && Math.hypot(c.x - this.feet.x, c.y - this.feet.y, c.z - this.feet.z) < STARTLE_M) this._startle(c)
    switch (c.state) {
      case 'inside':
        c.hold -= dt
        if (c.hold <= 0) this._exit(c)
        break
      case 'walk':
        if (tick % MEET_TICKS === 0) {
          const o = this._meet(c)
          if (o) { this._talk(c, o); break }
        }
        this._follow(c, dt, TURN_RATE)
        break
      case 'stand':
        c.hold -= dt
        if (c.hold <= 0) this._errand(c)
        break
      case 'gaze':
        c.hold -= dt
        this._turn(c, dt)
        if (c.hold <= 0) this._go(c, c.at, 'errand')
        break
      case 'sit':
        if (c.phase === 'turn') {
          this._turn(c, dt)
          if (Math.abs(swing(c.heading, c.aim)) < 0.02) this._phase(c, 'down')
        } else if (c.phase === 'hold') {
          c.hold -= dt
          if (c.hold <= 0) this._phase(c, 'up')
        }
        break
      case 'talk':
        c.hold -= dt
        c.aim = this._toward(c, c.partner.x, c.partner.z)
        this._turn(c, dt)
        c.voice -= dt
        if (c.voice <= 0) {
          c.voice = between(c.rand, CHATTER_S)
          this._voice(c, this._chatter(c))
          const gesture = TALKS[(c.rand() * TALKS.length) | 0]
          this._play(c, gesture, this.durations[gesture])
        }
        if (c.hold <= 0) { this._untalk(c); this._stand(c, between(c.rand, STAND_S)) }
        break
      case 'flee':
        c.voice -= dt
        if (c.voice <= 0) this._call(c, 'leafkinWhimper', WHIMPER_S)
        this._follow(c, dt, FLEE_TURN)
        break
      default: throw new Error(`Villagers: no state named ${c.state}`)
    }
    c.left -= dt
    if (c.left <= 0) this._step(c)
    // From its own feet, so a house's awning or roof overhead is not ground it is lifted onto.
    c.y = this.walk.heightAt(c.x, c.z, c.y)
    // A sitter's hips on its stool's top where the ground would leave them under it.
    if (c.state === 'sit') c.y = Math.max(c.y, c.seat.top - (this.asset.wheelbase - SIT.drop * this.asset.height) * c.k)
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
      // The clip at its pace, so the feet cover the ground the speed does, and as far into the step as the tick is.
      p.mixer.timeScale = c.pace
      p.play(c.clip, c.cue, Math.max(0, c.from) + (c.dur - c.left) * c.pace)
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
   * for the puppets. The first frame places everyone at the chapter's start
   * and replays it in one go, as does a clock skip past a chapter; a shorter
   * skip is caught up in one frame too, silent.
   */
  update(feet, head, seconds, dt) {
    if (!this.loaded) return
    this.frame++
    this.feet.x = feet.x; this.feet.y = feet.y; this.feet.z = feet.z
    this.head.x = head.x; this.head.y = head.y; this.head.z = head.z
    const tick = tickOf(seconds)
    let stepped = 0
    for (const c of this.all) {
      if (!this.placed || tick - c.tick > CHAPTER_S / TICK_S) this._place(c, seconds)
      stepped = Math.max(stepped, stepTo(c, seconds, (t) => this._tick(c, t), Infinity))
      this._draw(c, dt)
    }
    this.placed = true
    if (stepped > SILENT_TICKS) this.pending.length = 0
  }

  /** The frame's pose between the last two ticks, and the puppet on it. */
  _draw(c, dt) {
    if (c.hidden) { this._releasePuppet(c); return }
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
    puppet.play(c.clip, c.cue, c.from)
    groundFeet(puppet, pose, this.walk, PLANTED, (this.frame + c.id) % 6 === 0)
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
    if (puppet.done) this._releasePuppet(c)
  }

  dispose() {
    for (const c of this.all) this._releasePuppet(c)
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
