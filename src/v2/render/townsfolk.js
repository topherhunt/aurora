import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CHAPTER_S, TICK_HZ, TICK_S, chapterOf, hash32, swing, tickAfter, tickOf } from '../../sim/score.js'
import { LOD_RUNGS, critterTier } from './critters.js'
import { Hearth } from './hearth.js'
import { LOD_FADE_S, Puppet, cloneBones, groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { DOOR_FADE_S, PLANTED, SEAT_M, SIT, SIT_CUT, TALKS, TURN_RATE, dijkstra, pathTo } from './villagers.js'

// The towns' people (DESIGN.md §32): a campfire and stools in each clearing (hearth.js, grown to a human seat), and townsfolk walking the town's ways between the doors, the fire and the roads, stopping to chat, and turning to greet her. Each town's day is a deterministic sim over the room's clock, replayed from its chapter's start when the town comes alive; the greeting is this client's alone.

// The seated underside in the idle-sit pose, in asset units: the hip joints less a thigh's half-depth. villagers.js seatY takes the lowest vertex skinned to the hips, which on these coated avatars is the coat hem at the ground.
const THIGH = 0.05
function hipSeat(asset) {
  const copies = new Map()
  const rig = cloneBones(asset.root, copies)
  const mixer = new THREE.AnimationMixer(rig)
  mixer.clipAction(asset.clips.find((c) => c.name === 'idle-sit')).play()
  mixer.update(0)
  rig.updateMatrixWorld(true)
  const byName = new Map([...copies.values()].map((b) => [b.name, b]))
  const hips = asset.legs.map((l) => byName.get(THREE.PropertyBinding.sanitizeNodeName(l.chain[0])).getWorldPosition(new THREE.Vector3()).y)
  const y = hips.reduce((a, b) => a + b, 0) / hips.length - THIGH * asset.height
  if (!(y > 0.05 * asset.height && y < 0.5 * asset.height)) throw new Error(`Townsfolk: the seated underside measures ${y} against a body ${asset.height} tall`)
  return y
}

export const TOWNSFOLK = {
  // The avatars (public/creatures/<id>.glb) and puppets per avatar: the most drawn at once is their product.
  bodies: ['farmer', 'shepherd', 'woodcutter'],
  puppets: 4,
  people: { hut: 1, cottage: 1, longhouse: 2, inn: 2 },
  sizeVar: 0.04,
  pace: [0.85, 1.15],
  // Metres past a town's radius it comes alive at, and is let go past.
  live: [250, 330],
  // The walk round the clearing, inside its edge, that the paths and roads join.
  ring: { r: 9, nodes: 14 },
  lane: 0.35,
  node: 0.35,
  sitNear: 0.05,
  inside: [20, 90],
  stand: [4, 12],
  sit: [25, 70],
  homing: 60,
  talk: { m: 2.2, s: [8, 20], cool: 45, chatter: [1.5, 3], everyTicks: 10 },
  errands: [['visit', 0.25], ['home', 0.15], ['sit', 0.3], ['wander', 0.3]],
  // Her within `m`: they stop, face her and gesture for `s`, then catch up with themselves at `catchUp` times the pace; `cool` seconds before the same one greets again.
  greet: { m: 3, s: [2.5, 4], cool: 20, catchUp: 1.5, clips: [['wave', 0.3], ['beckon', 0.2], ['idle', 0.5]] },
}

export const CLIPS = ['idle', 'walk', 'sit', 'idle-sit', 'wave', 'beckon', ...TALKS]

const LOD_TIERS = LOD_RUNGS
const STEP_S = 2
const ROSTER_URL = 'creatures/avatars.json'

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const pick = (rand, pairs) => {
  let r = rand() * pairs.reduce((s, [, w]) => s + w, 0)
  for (const [name, w] of pairs) if ((r -= w) < 0) return name
  return pairs[pairs.length - 1][0]
}

function roll(c) {
  c.rs = (c.rs + 0x6d2b79f5) >>> 0
  let t = c.rs
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * A town's ways as a graph (villagers.js dijkstra): the ring round the
 * clearing, each road's points past it, and each door's path in the order
 * the plan laid them, every path's far end spliced into the nearest edge laid
 * before it. `doors` is each building's door node, in `town.buildings` order.
 */
export function townGraph(town) {
  const N = TOWNSFOLK.node
  const nodes = [], adj = []
  const add = (x, z, kind) => { nodes.push({ x, z, kind }); adj.push([]); return nodes.length - 1 }
  const link = (a, b) => { if (a === b || adj[a].includes(b)) return; adj[a].push(b); adj[b].push(a) }
  const attach = (x, z) => {
    let best = null
    for (let i = 0; i < nodes.length; i++) {
      for (const j of adj[i]) {
        if (j < i) continue
        const a = nodes[i], b = nodes[j], ux = b.x - a.x, uz = b.z - a.z, L2 = ux * ux + uz * uz
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ux + (z - a.z) * uz) / L2)) : 0
        const d = Math.hypot(x - a.x - t * ux, z - a.z - t * uz)
        if (best === null || d < best.d) best = { i, j, t, d, L: Math.sqrt(L2) }
      }
    }
    const { i, j, t, L } = best
    if (t * L < N) return i
    if ((1 - t) * L < N) return j
    const n = add(nodes[i].x + (nodes[j].x - nodes[i].x) * t, nodes[i].z + (nodes[j].z - nodes[i].z) * t, 'way')
    adj[i].splice(adj[i].indexOf(j), 1)
    adj[j].splice(adj[j].indexOf(i), 1)
    link(i, n)
    link(n, j)
    return n
  }
  const R = TOWNSFOLK.ring
  const ring = Array.from({ length: R.nodes }, (_, k) => add(town.x + Math.cos((2 * Math.PI * k) / R.nodes) * R.r, town.z + Math.sin((2 * Math.PI * k) / R.nodes) * R.r, 'ring'))
  ring.forEach((n, k) => link(n, ring[(k + 1) % ring.length]))
  for (const pts of town.roads) {
    let prev = -1
    for (const [x, , z] of pts) {
      if (Math.hypot(x - town.x, z - town.z) <= R.r + N) continue
      const onto = prev < 0 ? attach(x, z) : prev
      prev = add(x, z, 'road')
      link(onto, prev)
    }
  }
  if (town.paths.length !== town.buildings.length) throw new Error(`townGraph: ${town.id} has ${town.paths.length} paths for ${town.buildings.length} buildings`)
  const doors = town.paths.map(({ pts }) => {
    const last = pts[pts.length - 1]
    const onto = attach(last[0], last[2])
    const door = add(pts[0][0], pts[0][2], 'door')
    let prev = door
    for (let i = 1; i < pts.length - 1; i++) {
      const n = add(pts[i][0], pts[i][2], 'path')
      link(prev, n)
      prev = n
    }
    link(prev, onto)
    return door
  })
  const targets = nodes.map((_, i) => i).filter((i) => nodes[i].kind === 'ring' || nodes[i].kind === 'road' || nodes[i].kind === 'way')
  return { nodes, adj, doors, ring, targets }
}

/**
 * One town's day, three-free. `bodies` are the avatars as the sim needs them:
 * `{ heightM, height, gait, wheelbase, sitY, durations }`, heights in metres
 * and the rest in each asset's own units. `seats` are the stools in the world,
 * `{ x, z, top, r, lookX, lookZ }`; `heightAt(x, z, y)` the walk surface's.
 */
export class TownLife {
  constructor(town, { index, seed, bodies, seats, heightAt }) {
    if (!Array.isArray(bodies) || bodies.length === 0) throw new Error('TownLife: needs the bodies')
    if (typeof heightAt !== 'function') throw new Error('TownLife: needs heightAt')
    this.town = town
    this.key = `town:${town.id}`
    this.seed = hash32(seed, index)
    this.bodies = bodies
    this.heightAt = heightAt
    this.graph = townGraph(town)
    const { nodes, ring } = this.graph
    this.seats = seats.map((s) => {
      if (![s.x, s.z, s.top, s.r, s.lookX, s.lookZ].every(Number.isFinite)) throw new Error(`TownLife: a seat is { x, z, top, r, lookX, lookZ }: ${JSON.stringify(s)}`)
      let node = -1, at = Infinity
      for (const i of ring) {
        const d = Math.hypot(nodes[i].x - s.x, nodes[i].z - s.z)
        if (d < at) { at = d; node = i }
      }
      return { ...s, node, by: null }
    })
    this.all = []
    town.buildings.forEach((b, i) => {
      const n = TOWNSFOLK.people[b.kind]
      if (!(n > 0)) throw new Error(`TownLife: no head count for a ${b.kind}`)
      for (let j = 0; j < n; j++) {
        const id = this.all.length
        const rand = mulberry32(hash32(this.seed, id))
        // Dealt in turn, so no body's puppet pool runs dry while another's idles.
        const body = (this.seed + id) % bodies.length
        const size = bodies[body].heightM * (1 + TOWNSFOLK.sizeVar * (2 * rand() - 1))
        this.all.push({
          id, body, home: this.graph.doors[i], size, k: size / bodies[body].height, pace: between(rand, TOWNSFOLK.pace), rs: 0, rand: null,
          x: 0, y: 0, z: 0, heading: 0, px: 0, py: 0, pz: 0, ph: 0, aim: 0,
          // inside (drawn by nobody), walk, stand, sit or talk; the node it is at, the route on, and what its end is for: stand, sit, enter, errand; where it enters.
          state: 'inside', hidden: true, at: 0, route: [], wp: 0, then: 'stand', dest: 0,
          hold: 0, talked: 0, voice: 0, partner: null, seat: null, phase: '',
          clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0, from: -1,
        })
      }
    })
    for (const c of this.all) c.rand = () => roll(c)
    this.tick = null
    this.turnTick = 0
    this.homing = false
    this.grounded = true
    this.alpha = 0
    this.talks = 0
  }

  /** Stepped to the room clock's `seconds`: placed and replayed from its chapter's start on the first call or past a chapter's skip. */
  advance(seconds) {
    const tick = tickOf(seconds)
    if (this.tick === null || tick - this.tick > CHAPTER_S * TICK_HZ) this._placeAll(seconds)
    for (let t = this.tick + 1; t <= tick; t++) {
      if (t >= this.turnTick) { this._placeAll(t / TICK_HZ); continue }
      this.tick = t
      this.homing = t >= this.turnTick - TOWNSFOLK.homing * TICK_HZ
      // The ground is only for drawing, so a replay reads it on the last two ticks alone, the pair the frame lerps between.
      this.grounded = t >= tick - 1
      for (const c of this.all) this._tick(c, t)
    }
    this.alpha = Math.min(1, Math.max(0, (seconds - this.tick * TICK_S) * TICK_HZ))
  }

  get stats() {
    const states = { inside: 0, walk: 0, stand: 0, sit: 0, talk: 0 }
    for (const c of this.all) states[c.state]++
    return { people: this.all.length, states, talks: this.talks, nodes: this.graph.nodes.length, seats: this.seats.length, taken: this.seats.filter((s) => s.by !== null).length }
  }

  _placeAll(seconds) {
    const { index, start } = chapterOf(seconds, this.key)
    this.tick = tickOf(start)
    this.turnTick = tickAfter(start + CHAPTER_S)
    this.homing = false
    for (const s of this.seats) s.by = null
    for (const c of this.all) {
      c.rs = hash32(this.seed, c.id, index)
      const door = this.graph.nodes[c.home]
      c.x = c.px = door.x
      c.z = c.pz = door.z
      // The field, never the eaves overhead.
      c.y = c.py = this.heightAt(c.x, c.z, -Infinity)
      c.heading = c.ph = c.aim = 0
      c.at = c.home
      c.partner = null
      c.seat = null
      c.talked = 0
      c.phase = ''
      this._inside(c, c.rand() * TOWNSFOLK.inside[1])
    }
  }

  _toward(c, x, z) { return Math.atan2(-(z - c.z), x - c.x) }

  _play(c, clip, seconds, from = -1) {
    const body = this.bodies[c.body]
    c.clip = clip
    c.dur = c.left = seconds
    c.cycle = body.durations[clip] / c.pace
    c.cue++
    c.from = from
    const speed = body.gait[clip]
    c.speed = speed === undefined ? 0 : speed * c.k * c.pace
  }

  _step(c) {
    if (c.state === 'talk' && c.clip !== 'idle') { this._play(c, 'idle', STEP_S); return }
    if (c.state === 'sit' && c.phase === 'down') { this._phase(c, 'hold'); return }
    if (c.state === 'sit' && c.phase === 'up') { this._rise(c); return }
    c.left = c.dur = STEP_S
  }

  _inside(c, wait) {
    c.state = 'inside'
    c.hidden = true
    c.hold = wait
    c.route.length = 0
    c.wp = 0
    this._play(c, 'idle', STEP_S)
  }

  _leaveSeat(c) {
    if (c.seat === null) return
    c.seat.by = null
    c.seat = null
  }

  /** A path's nodes as route points, each between its ends `lane` to the right of the way it is walked, so two meeting pass. */
  _keepRight(path) {
    const { nodes } = this.graph, L = TOWNSFOLK.lane
    return path.map((k, i) => {
      const n = nodes[k]
      if (i === 0 || i === path.length - 1 || n.kind === 'door') return { x: n.x, z: n.z, node: k }
      const a = nodes[path[i - 1]], b = nodes[path[i + 1]], len = Math.hypot(b.x - a.x, b.z - a.z) || 1
      return { x: n.x + (L * (b.z - a.z)) / len, z: n.z - (L * (b.x - a.x)) / len, node: k }
    })
  }

  _go(c, node, then, extra = []) {
    this._leaveSeat(c)
    const { parent } = dijkstra(this.graph, c.at, node)
    const path = pathTo(parent, c.at, node)
    // Stopped past its node (a chat, a stool), it walks back to it rather than cutting the corner.
    const at = this.graph.nodes[c.at]
    if (path.length && Math.hypot(at.x - c.x, at.z - c.z) > TOWNSFOLK.node) path.unshift(c.at)
    c.route = this._keepRight(path)
    for (const p of extra) c.route.push({ x: p.x, z: p.z, node: -1 })
    c.wp = 0
    c.then = then
    c.dest = node
    c.state = 'walk'
    this._play(c, 'walk', STEP_S)
    if (c.route.length === 0) this._arrive(c)
  }

  _errand(c) {
    if (this.homing) { this._go(c, c.home, 'enter'); return }
    const kind = pick(c.rand, TOWNSFOLK.errands)
    const { doors, targets } = this.graph
    if (kind === 'visit') {
      let door = doors[(c.rand() * doors.length) | 0]
      if (door === c.at) door = doors[(doors.indexOf(door) + 1) % doors.length]
      if (door !== c.at) { this._go(c, door, 'enter'); return }
    }
    if (kind === 'home' && c.at !== c.home) { this._go(c, c.home, 'enter'); return }
    if (kind === 'sit') {
      const free = this.seats.filter((s) => s.by === null)
      if (free.length > 0) { this._seat(c, free[(c.rand() * free.length) | 0]); return }
    }
    let node = targets[(c.rand() * targets.length) | 0]
    if (node === c.at) node = targets[(targets.indexOf(node) + 1) % targets.length]
    this._go(c, node, 'stand')
  }

  /** Its way onto `seat` (villagers.js _approach at its size): the feet short of the stool toward its look, and a point wide of them on its node's side. */
  _approach(c, seat) {
    const ax = seat.lookX - seat.x, az = seat.lookZ - seat.z, len = Math.hypot(ax, az)
    const ux = ax / len, uz = az / len
    const fore = Math.max(SIT.back * this.bodies[c.body].wheelbase * c.k, seat.r + SIT.clear)
    const n = this.graph.nodes[seat.node]
    const wide = (Math.sign(-uz * (n.x - seat.x) + ux * (n.z - seat.z)) || 1) * (seat.r + SIT.round * c.size)
    const feet = { x: seat.x + ux * fore, z: seat.z + uz * fore }
    return { feet, round: { x: feet.x - uz * wide, z: feet.z + ux * wide } }
  }

  _seat(c, seat) {
    const { feet, round } = this._approach(c, seat)
    this._go(c, seat.node, 'sit', [round, feet])
    c.seat = seat
    seat.by = c
  }

  _rise(c) {
    const { round } = this._approach(c, c.seat)
    const n = this.graph.nodes[c.at]
    this._go(c, c.at, 'errand', [round, { x: n.x, z: n.z }])
  }

  _phase(c, phase) {
    c.phase = phase
    const sit = this.bodies[c.body].durations.sit
    switch (phase) {
      case 'turn': c.aim = this._toward(c, c.seat.lookX, c.seat.lookZ); this._play(c, 'idle', STEP_S); break
      case 'down': this._play(c, 'sit', SIT_CUT[0] / c.pace); break
      case 'hold': c.hold = between(c.rand, TOWNSFOLK.sit); this._play(c, 'idle-sit', STEP_S); break
      case 'up': this._play(c, 'sit', (sit - SIT_CUT[1]) / c.pace, SIT_CUT[1]); break
      default: throw new Error(`TownLife: no sit phase named ${phase}`)
    }
  }

  _arrive(c) {
    switch (c.then) {
      case 'stand': c.state = 'stand'; c.hold = between(c.rand, TOWNSFOLK.stand); this._play(c, 'idle', STEP_S); break
      case 'sit': c.state = 'sit'; this._phase(c, 'turn'); break
      case 'enter': this._inside(c, between(c.rand, TOWNSFOLK.inside)); break
      case 'errand': this._errand(c); break
      default: throw new Error(`TownLife: a route ends in ${c.then}`)
    }
  }

  _talk(a, b) {
    const hold = between(a.rand, TOWNSFOLK.talk.s)
    for (const [c, other, first] of [[a, b, true], [b, a, false]]) {
      c.state = 'talk'
      c.partner = other
      c.hold = hold
      c.voice = first ? 0.2 : between(c.rand, TOWNSFOLK.talk.chatter) / 2
      c.aim = this._toward(c, other.x, other.z)
      c.route.length = 0
      c.wp = 0
      this._play(c, 'idle', STEP_S)
    }
    this.talks++
  }

  _untalk(c) {
    for (const o of [c, c.partner]) {
      o.partner = null
      o.talked = TOWNSFOLK.talk.cool
      o.state = 'stand'
      o.hold = between(o.rand, TOWNSFOLK.stand)
      this._play(o, 'idle', STEP_S)
    }
  }

  _meet(c) {
    const busy = (o) => o.talked > 0 || o.seat !== null || o.partner !== null
    if (this.homing || busy(c)) return null
    for (const o of this.all) {
      if (o === c || o.hidden || busy(o) || (o.state !== 'walk' && o.state !== 'stand')) continue
      if (Math.hypot(o.x - c.x, o.z - c.z) <= TOWNSFOLK.talk.m) return o
    }
    return null
  }

  _turn(c, dt) {
    const s = swing(c.heading, c.aim)
    c.heading += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * dt)
    return Math.max(0, Math.cos(s))
  }

  /** A step along the route at the gait. A stool's feet are walked onto straight, so the turn's circle cannot orbit them. */
  _follow(c, dt) {
    const step = c.speed * dt
    let left = step
    while (left > 0) {
      const p = c.route[c.wp]
      const d = Math.hypot(p.x - c.x, p.z - c.z)
      const last = c.wp === c.route.length - 1
      const onto = c.then === 'sit' && last
      if (d <= (onto ? TOWNSFOLK.sitNear : TOWNSFOLK.node)) {
        if (p.node >= 0) c.at = p.node
        c.wp++
        if (c.wp >= c.route.length) { c.route.length = 0; c.wp = 0; this._arrive(c); return }
        continue
      }
      c.aim = this._toward(c, p.x, p.z)
      const m = Math.min(left, d)
      const turned = this._turn(c, (dt * m) / step)
      if (onto) { c.x += ((p.x - c.x) / d) * m; c.z += ((p.z - c.z) / d) * m } else { c.x += Math.cos(c.heading) * m * turned; c.z -= Math.sin(c.heading) * m * turned }
      left -= m
    }
  }

  _tick(c, tick) {
    c.px = c.x; c.py = c.y; c.pz = c.z; c.ph = c.heading
    const dt = TICK_S
    c.talked = Math.max(0, c.talked - dt)
    if (this.homing && c.state !== 'inside') {
      c.hold = Math.min(c.hold, 0)
      if (c.state === 'walk' && !(c.then === 'enter' && c.dest === c.home) && c.then !== 'sit' && c.then !== 'errand') this._go(c, c.home, 'enter')
    }
    switch (c.state) {
      case 'inside':
        c.hold -= dt
        if (c.hold <= 0 && !this.homing) { c.hidden = false; this._errand(c) }
        break
      case 'walk':
        if (tick % TOWNSFOLK.talk.everyTicks === 0) {
          const o = this._meet(c)
          if (o) { this._talk(c, o); break }
        }
        this._follow(c, dt)
        break
      case 'stand':
        c.hold -= dt
        if (tick % TOWNSFOLK.talk.everyTicks === 0) {
          const o = this._meet(c)
          if (o) { this._talk(c, o); break }
        }
        if (c.hold <= 0) this._errand(c)
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
          c.voice = between(c.rand, TOWNSFOLK.talk.chatter)
          const gesture = TALKS[(c.rand() * TALKS.length) | 0]
          this._play(c, gesture, this.bodies[c.body].durations[gesture] / c.pace)
        }
        if (c.hold <= 0) this._untalk(c)
        break
      default: throw new Error(`TownLife: no state named ${c.state}`)
    }
    c.left -= dt
    if (c.left <= 0) this._step(c)
    if (c.hidden || !this.grounded) return
    c.y = this.heightAt(c.x, c.z, c.y)
    if (c.state === 'sit') {
      const on = c.phase === 'hold' ? 1 : c.phase === 'down' ? 1 - c.left / c.dur : c.phase === 'up' ? c.left / c.dur : 0
      c.y += Math.min(1, Math.max(0, on)) * (c.seat.top - this.bodies[c.body].sitY * c.k - c.y)
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

export class Townsfolk {
  /**
   * @param opts.towns     planTowns()'s towns
   * @param opts.walk      WalkSurface: heightAt, the ground they and the stools stand on
   * @param opts.field     V2Height: heightAt, for the hearths
   * @param opts.bank      buildRockBank()'s answer, for the fire ring
   * @param opts.textures  the prop atlas
   * @param opts.patch     (material, cacheKey) => material, the lighting patch
   * @param opts.seed      the world's seed
   */
  constructor(scene, { towns, walk, field, bank, textures, patch, seed = 1 } = {}) {
    if (!Array.isArray(towns)) throw new Error('Townsfolk: needs the towns')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Townsfolk: needs the WalkSurface')
    if (typeof patch !== 'function') throw new Error('Townsfolk: needs the lighting patch')
    this.scene = scene
    this.towns = towns
    this.walk = walk
    this.hearthOpts = { field, bank, textures, patch }
    this.seed = seed
    this.batch = new THREE.Group()
    this.batch.name = 'v2-townsfolk'
    scene.add(this.batch)
    this.materials = []
    this.pools = TOWNSFOLK.bodies.map((id) => {
      const plain = makeSettledMaterial(`townsfolk-${id}`)
      this.materials.push(plain)
      const mats = Array.from({ length: TOWNSFOLK.puppets }, () => {
        const m = makePuppetMaterials(`townsfolk-${id}`, plain)
        this.materials.push(m.in, m.out)
        return m
      })
      return { id, plain, mats, free: [], puppets: [] }
    })
    this.bodies = null
    this.hearthScale = 1
    // Town index -> { life, hearth } for each town alive.
    this.alive = new Map()
    this.frame = 0
    this.starved = 0
    this.ranks = new Array(TOWNSFOLK.bodies.length).fill(0)
    this.greets = 0
    this.loaded = false
    this.ready = this.load()
  }

  async load() {
    const res = await fetch(ROSTER_URL)
    if (!res.ok) throw new Error(`Townsfolk: ${ROSTER_URL} answered ${res.status}`)
    const { avatars } = await res.json()
    const assets = await Promise.all(TOWNSFOLK.bodies.map((id) => loadBipedGlb(`creatures/${id}.glb`)))
    this.setAssets(assets, assets.map((_, i) => {
      const entry = avatars.find((a) => a.id === TOWNSFOLK.bodies[i])
      if (!entry || !(entry.heightM > 0)) throw new Error(`Townsfolk: ${ROSTER_URL} has no height for ${TOWNSFOLK.bodies[i]}`)
      return entry.heightM
    }))
    return true
  }

  setAssets(assets, heights) {
    this.bodies = assets.map((asset, i) => {
      for (const name of CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`Townsfolk: ${TOWNSFOLK.bodies[i]} has no ${name} clip`)
      const durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
      if (!(durations.sit > SIT_CUT[1])) throw new Error(`Townsfolk: ${TOWNSFOLK.bodies[i]}'s sit clip is ${durations.sit} s, cut at ${SIT_CUT}`)
      const pool = this.pools[i]
      pool.plain.map = asset.map
      pool.plain.needsUpdate = true
      for (const mats of pool.mats) {
        for (const m of [mats.in, mats.out]) { m.map = asset.map; m.needsUpdate = true }
        pool.puppets.push(new Puppet(asset, mats, { clipFade: 0.25 }))
      }
      pool.free = pool.puppets.slice()
      return { asset, heightM: heights[i], height: asset.height, gait: asset.gait, wheelbase: asset.wheelbase, sitY: hipSeat(asset), durations }
    })
    // One hearth for every body: grown so its stools' tops meet the mean seated underside.
    this.hearthScale = this.bodies.reduce((s, b) => s + (b.sitY / b.height) * b.heightM, 0) / this.bodies.length / SEAT_M
    this.loaded = true
  }

  get stats() {
    let people = 0, shown = 0
    for (const { life } of this.alive.values()) {
      people += life.all.length
      for (const c of life.all) if (c.puppet) shown++
    }
    return { alive: this.alive.size, people, shown, starved: this.starved, greets: this.greets, hearthScale: +this.hearthScale.toFixed(2) }
  }

  _wake(i) {
    const town = this.towns[i]
    const s = this.hearthScale
    const hearth = new Hearth(this.scene, this.hearthOpts.field, { ...this.hearthOpts, at: town, seed: hash32(this.seed, i, 0x4ea7), scale: s })
    const seats = hearth.stools.map((st) => ({ x: hearth.x + st.x * s, z: hearth.z + st.z * s, top: hearth.y + st.top * s, r: st.r * s, lookX: hearth.x, lookZ: hearth.z }))
    const life = new TownLife(town, { index: i, seed: this.seed, bodies: this.bodies, seats, heightAt: (x, z, y) => this.walk.heightAt(x, z, y) })
    for (const c of life.all) Object.assign(c, { pose: { x: 0, y: 0, z: 0, heading: 0, k: c.k, speed: 0, clip: 'idle' }, lod: LOD_TIERS, puppet: null, greet: null, lag: false, cool: 0, gcue: 0 })
    this.alive.set(i, { life, hearth })
  }

  _sleep(i) {
    const { life, hearth } = this.alive.get(i)
    for (const c of life.all) this._release(c)
    hearth.dispose()
    this.alive.delete(i)
  }

  _release(c) {
    if (!c.puppet) return
    c.puppet.release()
    this.batch.remove(c.puppet.group)
    this.pools[c.body].free.push(c.puppet)
    c.puppet = null
  }

  /** Once a frame: towns woken and let go by her distance, each alive one stepped to the clock, and its people drawn nearest first. */
  update(feet, head, seconds, dt, t) {
    if (!this.loaded) return
    this.frame++
    const [wake, sleep] = TOWNSFOLK.live
    this.towns.forEach((town, i) => {
      const d = Math.hypot(town.x - head.x, town.z - head.z) - town.radius
      if (!this.alive.has(i) && d < wake) this._wake(i)
      else if (this.alive.has(i) && d > sleep) this._sleep(i)
    })
    const drawn = []
    for (const { life, hearth } of this.alive.values()) {
      hearth.update(head.x, head.y, head.z, t)
      life.advance(seconds)
      for (const c of life.all) {
        if (c.hidden && !c.puppet && !c.greet && !c.lag) continue
        this._pose(c, life.alpha, feet, seconds, dt)
        c.dist = Math.hypot(c.pose.x - head.x, c.pose.y - head.y, c.pose.z - head.z)
        drawn.push(c)
      }
    }
    drawn.sort((a, b) => a.dist - b.dist)
    this.ranks.fill(0)
    for (const c of drawn) this._draw(c, dt)
  }

  /**
   * The frame's pose: the sim's between its last two ticks, or while it greets
   * her, held where it stopped and turned to her; after, walked at `catchUp`
   * pace straight back onto the sim's until it is there.
   */
  _pose(c, a, feet, seconds, dt) {
    const pose = c.pose
    const sx = c.px + (c.x - c.px) * a, sy = c.py + (c.y - c.py) * a, sz = c.pz + (c.z - c.pz) * a
    const G = TOWNSFOLK.greet
    if (c.greet === null && !c.lag && !c.hidden && seconds >= c.cool && (c.state === 'walk' || c.state === 'stand' || c.state === 'talk') && Math.hypot(pose.x - feet.x, pose.z - feet.z) < G.m) {
      c.greet = { until: seconds + between(Math.random, G.s), at: seconds, clip: pick(Math.random, G.clips) }
      c.gcue++
      this.greets++
    }
    if (c.greet !== null) {
      const want = Math.atan2(-(feet.z - pose.z), feet.x - pose.x), s = swing(pose.heading, want)
      pose.heading += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * dt)
      const dur = this.bodies[c.body].durations[c.greet.clip]
      pose.clip = seconds - c.greet.at < dur ? c.greet.clip : 'idle'
      pose.speed = 0
      pose.cue = 1e6 + c.gcue * 2 + (pose.clip === 'idle' ? 1 : 0)
      pose.from = -1
      pose.scale = 1
      if (seconds >= c.greet.until) { c.greet = null; c.lag = true; c.cool = seconds + G.cool }
      return
    }
    if (c.lag) {
      const dx = sx - pose.x, dz = sz - pose.z, d = Math.hypot(dx, dz)
      const body = this.bodies[c.body], speed = body.gait.walk * c.k * c.pace * G.catchUp
      if (d > speed * dt) {
        const m = speed * dt
        pose.x += (dx / d) * m
        pose.z += (dz / d) * m
        pose.y = this.walk.heightAt(pose.x, pose.z, pose.y)
        const s = swing(pose.heading, Math.atan2(-dz, dx))
        pose.heading += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * dt)
        pose.clip = 'walk'
        pose.speed = speed
        pose.cue = 1e6 + c.gcue * 2
        pose.from = -1
        pose.scale = G.catchUp
        return
      }
      c.lag = false
    }
    pose.x = sx; pose.y = sy; pose.z = sz
    pose.heading = c.ph + swing(c.ph, c.heading) * a
    pose.clip = c.clip
    pose.speed = c.speed
    pose.cue = c.cue
    pose.from = c.from
    pose.scale = 1
  }

  _draw(c, dt) {
    const pose = c.pose
    pose.k = c.k
    c.lod = critterTier(c.size, c.dist, c.lod, LOD_TIERS)
    const gone = c.hidden && c.greet === null && !c.lag
    // Past its body's pool in nearness, a holder fades out and frees its puppet for someone nearer.
    const want = gone || c.lod === LOD_TIERS || this.ranks[c.body]++ >= TOWNSFOLK.puppets ? -1 : c.lod
    if (want !== -1 && !c.puppet) {
      const p = this.pools[c.body].free.pop()
      if (!p) { this.starved++; return }
      c.puppet = p
      this.batch.add(p.group)
      p.play(pose.clip, pose.cue, pose.from >= 0 ? pose.from : 0)
    }
    const puppet = c.puppet
    if (!puppet) return
    puppet.show(want, gone ? DOOR_FADE_S : LOD_FADE_S)
    puppet.mixer.timeScale = c.pace * pose.scale
    _pos.set(pose.x, pose.y, pose.z)
    _quat.setFromAxisAngle(UP, pose.heading)
    _scl.setScalar(c.k)
    _mat.compose(_pos, _quat, _scl)
    puppet.play(pose.clip, pose.cue, pose.from)
    groundFeet(puppet, pose, this.walk, PLANTED, (this.frame + c.id) % 6 === 0)
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
    if (puppet.done) this._release(c)
  }

  // -- stone to the walker (walk.js addStone): the alive towns' fire rings and stools ------

  columnAt(x, z, minSize, out) {
    for (const { hearth } of this.alive.values()) if (hearth.occupiesAt(x, z, 0)) return hearth.columnAt(x, z, minSize, out)
    return 0
  }

  blockTopAt(x, z) {
    for (const { hearth } of this.alive.values()) if (hearth.occupiesAt(x, z, 0)) return hearth.blockTopAt(x, z)
    return -Infinity
  }

  dispose() {
    for (const i of [...this.alive.keys()]) this._sleep(i)
    this.batch.removeFromParent()
    for (const m of this.materials) m.dispose()
  }
}
