import THREE from '../../three-instance.js'
import { clamp, mulberry32 } from '../../sim/mathx.js'
import { JOURNEYS } from './journeys.js'
import { CHAPTER_S, TICK_HZ, TICK_S, chapterOf, hash32, swing, tickAfter, tickOf } from '../../sim/score.js'
import { LOD_RUNGS, critterTier } from './critters.js'
import { HEARTH, Hearth, hearthKit } from './hearth.js'
import { lodFadeS, Puppet, cloneBones, groundFeet, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { loadBipedGlb } from './snowmen.js'
import { fromSide, Striders, loadStriderGlb, mountFields, STRIDER, striderSize } from './striders.js'
import { touchesSaddle, WILD } from './wild-striders.js'
import { DOOR_FADE_S, PLANTED, SEAT_M, SIT, SIT_CUT, TALKS, TURN_RATE, dijkstra, pathTo } from './villagers.js'

// The towns' people (DESIGN.md §32): a campfire and stools in each clearing (hearth.js, grown to a human seat), and townsfolk walking the town's ways between the doors, the fire and the roads, stopping to chat, and turning to greet her. Each town's day is a deterministic sim over the room's clock, replayed from its chapter's start when the town comes alive; the greeting is this client's alone.

// The seated underside in a clip's first frame, in asset units: the hip joints' mean less a thigh's half-depth. villagers.js seatY takes the lowest vertex skinned to the hips, which on these coated avatars is the coat hem at the ground.
const THIGH = 0.05
function underside(asset, clip) {
  const copies = new Map()
  const rig = cloneBones(asset.root, copies)
  const mixer = new THREE.AnimationMixer(rig)
  mixer.clipAction(asset.clips.find((c) => c.name === clip)).play()
  mixer.update(0)
  rig.updateMatrixWorld(true)
  const byName = new Map([...copies.values()].map((b) => [b.name, b]))
  const at = new THREE.Vector3()
  for (const l of asset.legs) at.add(byName.get(THREE.PropertyBinding.sanitizeNodeName(l.chain[0])).getWorldPosition(new THREE.Vector3()))
  at.divideScalar(asset.legs.length)
  at.y -= THIGH * asset.height
  if (!(at.y > 0.05 * asset.height && at.y < 0.5 * asset.height)) throw new Error(`Townsfolk: the ${clip} underside measures ${at.y} against a body ${asset.height} tall`)
  return at
}

function boneIndex(asset, name) {
  const i = asset.skeleton.bones.findIndex((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(name))
  if (i < 0) throw new Error(`Townsfolk: no bone named ${name}`)
  return i
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
  // Ticks of replay a frame, shared by the towns still catching up; a full chapter is 12000.
  replay: 400,
  // The walk round the clearing, inside its edge, that the paths and roads join.
  ring: { r: 4, nodes: 10 },
  lane: 0.2,
  node: 0.35,
  sitNear: 0.05,
  inside: [20, 90],
  stand: [4, 12],
  sit: [25, 70],
  homing: 60,
  talk: { m: 2.2, s: [8, 20], cool: 45, chatter: [1.5, 3], everyTicks: 10 },
  errands: [['visit', 0.25], ['home', 0.15], ['sit', 0.3], ['wander', 0.3], ['lead', 0.06]],
  // The striders at the rails: spare mounts past a tether each for the chapter's arrivals, and guests to ride or walk them in; the share of tethers filled at a chapter's start; seconds tied between fidgets, at the knot, and in the hop up or down; the rein a led one keeps; the wander legs of a lead, and no lead within `clear` s of a departure's fetch or `late` s of the chapter's end. A departer fetches its strider `slack` s ahead of its own worst walk and ride to the port at `walk` m/s afoot.
  strider: { spare: 4, guests: 12, fill: [0.3, 0.6], fidget: [8, 30], untie: 2.5, hop: 1, rein: 3, legs: [1, 2], clear: 300, late: 150, slack: 30, walk: 0.85 },
  // Her within `m`: `ignore` of the time they carry on; otherwise they stop, face her and gesture (or just look, `idle`) for `s`, then catch up with themselves at `catchUp` times the pace. Either way `cool` seconds before the same one notices her again.
  greet: { m: 2, ignore: 0.5, s: [2.5, 4], cool: 20, catchUp: 1.5, clips: [['wave', 0.12], ['beckon', 0.08], ['idle', 0.8]] },
  // Travellers on the roads: drawn within `m` of her, the list re-read every `every` s; one meeting another journey's within `ahead` m steps out to its own side over `ease` s, a walker `person` m wide in the reckoning. Metres a hop up or down rises over the straight line.
  road: { m: 300, every: 0.5, ahead: 6, ease: 1, person: 0.4 },
  leap: 0.4,
  // A tied strider that does not trust her, her head within `m` m and no fish of hers in reach: it shrieks and runs off `run` m at `pace` of its run, stands `wait` s, walks back to its rail, and will not again for `cool` s.
  shy: { m: 3, run: [3, 10], pace: 0.7, wait: [3, 6], cool: 5 },
}

export const CLIPS = ['idle', 'walk', 'sit', 'idle-sit', 'wave', 'beckon', 'ride', 'ride-idle', ...TALKS]

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
 * before it. `doors` is each building's door node, in `town.buildings` order;
 * `ports` each road's last node, at its port end; `posts` each hitching rail's
 * gate, spliced in last.
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
  const ports = town.roads.map((pts) => {
    let prev = -1
    for (const [x, , z] of pts) {
      if (Math.hypot(x - town.x, z - town.z) <= R.r + N) continue
      const onto = prev < 0 ? attach(x, z) : prev
      prev = add(x, z, 'road')
      link(onto, prev)
    }
    if (prev < 0) throw new Error(`townGraph: ${town.id}'s road ${pts} never leaves the clearing`)
    return prev
  })
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
  const posts = town.posts.map(({ gate: [x, z] }) => {
    const onto = attach(x, z)
    const n = add(x, z, 'post')
    link(n, onto)
    return n
  })
  const targets = nodes.map((_, i) => i).filter((i) => nodes[i].kind === 'ring' || nodes[i].kind === 'road' || nodes[i].kind === 'way')
  return { nodes, adj, doors, ring, targets, ports, posts }
}

/**
 * One town's day, three-free. `bodies` are the avatars as the sim needs them:
 * `{ heightM, height, gait, wheelbase, sitY, durations }`, heights in metres
 * and the rest in each asset's own units. `seats` are the stools in the world,
 * `{ x, z, top, r, lookX, lookZ }`; `heightAt(x, z, y)` the walk surface's.
 * `index` is the town's in `journeys` (journeys.js), which with `strider`,
 * `{ walk, fidget }` (its walk in m/s, its fidget clip's seconds), brings the
 * striders at the rails and the travellers leaving and arriving; without
 * them the rails stand empty.
 */
export class TownLife {
  constructor(town, { index, seed, bodies, seats, heightAt, journeys = null, strider = null }) {
    if (!Array.isArray(bodies) || bodies.length === 0) throw new Error('TownLife: needs the bodies')
    if (typeof heightAt !== 'function') throw new Error('TownLife: needs heightAt')
    if (!journeys !== !strider) throw new Error('TownLife: the journeys and the strider come together')
    this.town = town
    this.index = index
    this.key = `town:${town.id}`
    this.seed = hash32(seed, index)
    this.journeys = journeys
    this.strider = strider
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
        this.all.push(this._person(id, body, size, this.graph.doors[i], between(rand, TOWNSFOLK.pace), false))
      }
    })
    const S = TOWNSFOLK.strider
    // Travellers arrived this chapter, away until they do; each takes its journey member's body.
    if (journeys) for (let g = 0; g < S.guests; g++) this.all.push(this._person(this.all.length, 0, bodies[0].heightM, this.graph.doors[0], 1, true))
    for (const c of this.all) c.rand = () => roll(c)
    this.tethers = journeys ? town.posts.flatMap((p, post) => p.tethers.map((t) => ({ ...t, post, node: this.graph.posts[post], mount: null, want: null }))) : []
    this.mounts = Array.from({ length: journeys ? this.tethers.length + S.spare : 0 }, (_, id) => ({
      id, active: false, rs: 0, rand: null, x: 0, y: 0, z: 0, heading: 0, px: 0, py: 0, pz: 0, ph: 0, aim: 0,
      // tied at `tether`, led by `leader`, ridden by `rider`, settling onto `tether`, or gone; `reserved` by the one coming for it.
      state: 'gone', tether: null, leader: null, rider: null, reserved: false, clip: 'idle', cue: 0, speed: 0, hold: 0,
    }))
    for (const m of this.mounts) m.rand = () => roll(m)
    // Each port and post's worst walk and ride, for a departer's fetch: from any door to any post, and from any post or door to each port.
    if (journeys) {
      const far = (from, to) => { const { dist } = dijkstra(this.graph, from); return Math.max(...to.map((n) => dist[n])) }
      const { doors, posts, ports } = this.graph
      this.toPost = Math.max(...doors.map((d) => { const { dist } = dijkstra(this.graph, d); return Math.max(...posts.map((p) => dist[p])) }))
      this.toPort = ports.map((p) => ({ fromPost: far(p, posts), fromDoor: far(p, doors) }))
      if (![this.toPost, ...this.toPort.flatMap((p) => [p.fromPost, p.fromDoor])].every(Number.isFinite)) throw new Error(`TownLife: ${town.id}'s posts and ports are not all reached`)
    }
    this.plan = []
    this.next = 0
    this.led = 0
    // The departures whose travellers are still in town: the road draws them only once they have gone.
    this.holding = new Set()
    this.tick = null
    this.turnTick = 0
    this.homing = false
    this.grounded = true
    this.alpha = 0
    this.talks = 0
    this.caught = false
  }

  /** Stepped toward the room clock's `seconds`, at most `budget` ticks: placed and replayed from its chapter's start on the first call or past a chapter's skip. `caught` says whether it got there; returns the ticks stepped. */
  advance(seconds, budget = Infinity) {
    const tick = tickOf(seconds)
    if (this.tick === null || tick - this.tick > CHAPTER_S * TICK_HZ) this._placeAll(seconds)
    const from = this.tick
    const end = Math.min(tick, from + budget)
    for (let t = from + 1; t <= end; t++) {
      if (t >= this.turnTick) { this._placeAll(t / TICK_HZ); continue }
      this.tick = t
      this.homing = t >= this.turnTick - TOWNSFOLK.homing * TICK_HZ
      // The ground is only for drawing, so a replay reads it on the last two ticks alone, the pair the frame lerps between.
      this.grounded = t >= tick - 1
      while (this.next < this.plan.length && this.plan[this.next].tick <= t) this._start(this.plan[this.next++])
      for (const c of this.all) this._tick(c, t)
      for (const m of this.mounts) if (m.active) this._tickMount(m)
    }
    this.caught = end === tick
    this.alpha = Math.min(1, Math.max(0, (seconds - this.tick * TICK_S) * TICK_HZ))
    return end - from
  }

  get stats() {
    const states = { inside: 0, walk: 0, stand: 0, sit: 0, talk: 0, work: 0, away: 0 }
    for (const c of this.all) states[c.state]++
    const mounts = { tied: 0, led: 0, ridden: 0, settle: 0 }
    for (const m of this.mounts) if (m.active) mounts[m.state]++
    return { people: this.all.length, states, mounts, talks: this.talks, nodes: this.graph.nodes.length, seats: this.seats.length, taken: this.seats.filter((s) => s.by !== null).length }
  }

  _person(id, body, size, home, pace, guest) {
    return {
      id, body, home, size, k: size / this.bodies[body].height, pace, rs: 0, rand: null,
      x: 0, y: 0, z: 0, heading: 0, px: 0, py: 0, pz: 0, ph: 0, aim: 0,
      // inside (drawn by nobody), walk, stand, sit, talk, work (a job's hold) or away (gone down the road, or not yet come); the node it is at, the route on, and what its end is for: stand, sit, enter, errand, job; where it enters.
      state: 'inside', hidden: true, at: 0, route: [], wp: 0, then: 'stand', dest: 0,
      hold: 0, talked: 0, voice: 0, partner: null, seat: null, phase: '',
      clip: 'idle', left: 0, dur: 0, cycle: 0, cue: 0, speed: 0, from: -1,
      // A traveller's: its job's steps, the strider it sits, the hop on or off (0 afoot, 1 in the saddle) between the ground point `hopA` and the saddle `hopB`, and its own body under a journey member's borrowed one.
      guest, job: null, mount: null, hop: 0, phop: 0, hopA: null, hopB: null, own: null, planned: false,
    }
  }

  /** This body and size for the chapter, a journey member's. */
  _become(c, member) {
    c.own = { body: c.body, size: c.size, k: c.k }
    c.body = member.body % this.bodies.length
    c.size = this.bodies[c.body].heightM * (1 + TOWNSFOLK.sizeVar * member.size)
    c.k = c.size / this.bodies[c.body].height
  }

  _placeAll(seconds) {
    const { index, start } = chapterOf(seconds, this.key)
    this.tick = tickOf(start)
    this.turnTick = tickAfter(start + CHAPTER_S)
    this.homing = false
    for (const s of this.seats) s.by = null
    for (const t of this.tethers) { t.mount = null; t.want = null }
    for (const m of this.mounts) this._gone(m)
    this.plan.length = 0
    this.next = 0
    this.led = 0
    this.holding.clear()
    for (const c of this.all) {
      if (c.own) { Object.assign(c, c.own); c.own = null }
      c.job = null
      c.mount = null
      c.hop = c.phop = 0
      c.planned = false
      c.rs = hash32(this.seed, c.id, index)
      if (c.guest) { c.state = 'away'; c.hidden = true; continue }
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
    if (this.journeys) this._plan(index, start)
  }

  /**
   * The chapter's journeys out of and into town: who leaves (a resident, of the
   * member's body if one is free) and when it sets off to be at the port end by
   * its t0, which guest arrives at each t1, and how many striders stand at the
   * rails at the start -- enough that each rider leaving finds one, few enough
   * that each rider arriving finds a free tether (the tethers go at t0).
   */
  _plan(index, start) {
    const J = this.journeys, S = TOWNSFOLK.strider, T = this.tethers.length
    const end = start + CHAPTER_S
    const rand = mulberry32(hash32(this.seed, index, 0x57d))
    const out = J.leaving(this.index, start, end)
    const inn = J.arriving(this.index, start, end)
    const fetch = (j) => {
      const P = this.toPort[j.route.stub]
      const prep = j.ride ? this.toPost / S.walk + S.untie + S.hop + P.fromPost / JOURNEYS.speed.ride : P.fromDoor / S.walk
      return Math.max(start + 5, j.t0 - prep - S.slack)
    }
    for (const j of out) {
      this.holding.add(j.id)
      j.members.forEach((member, k) => {
        const free = this.all.filter((c) => !c.guest && !c.planned)
        if (free.length === 0) throw new Error(`TownLife: ${this.town.id} has no one left to send down the road`)
        const same = free.filter((c) => c.body === member.body % this.bodies.length)
        const c = (same.length > 0 ? same : free)[(rand() * (same.length > 0 ? same : free).length) | 0]
        c.planned = true
        this._become(c, member)
        this.plan.push({ tick: tickAfter(fetch(j)), kind: j.ride ? 'depart' : 'walkout', c, j, k })
      })
    }
    let g = 0
    for (const j of inn) j.members.forEach((member, k) => {
      const c = this.all.filter((o) => o.guest)[g++]
      if (!c) throw new Error(`TownLife: ${this.town.id} has more than ${S.guests} arriving in a chapter`)
      c.planned = true
      this._become(c, member)
      this.plan.push({ tick: tickAfter(j.t1), kind: j.ride ? 'ridein' : 'walkin', c, j, k })
    })
    this.plan.sort((p, q) => p.tick - q.tick)
    const leave = out.filter((j) => j.ride).map(fetch)
    const tied = inn.filter((j) => j.ride).map((j) => j.t1 + this.toPort[j.route.toStub].fromPost / JOURNEYS.speed.ride + S.slack)
    let lo = 0, hi = T
    for (const f of leave) lo = Math.max(lo, leave.filter((e) => e <= f).length - tied.filter((e) => e <= f).length)
    for (const j of inn) if (j.ride) hi = Math.min(hi, T - inn.filter((i) => i.ride && i.t1 <= j.t1).length + out.filter((o) => o.ride && o.t0 <= j.t1).length)
    if (lo > hi) throw new Error(`TownLife: ${this.town.id}'s chapter ${index} needs ${lo} striders at the rails and has room for ${hi}`)
    const n0 = clamp(Math.round(T * between(rand, S.fill)), lo, hi)
    const order = this.tethers.map((t, i) => [rand(), t]).sort((a, b) => a[0] - b[0]).map(([, t]) => t)
    for (let i = 0; i < n0; i++) this._tie(this._spare(index), order[i])
  }

  /** An idle mount, woken, its rolls salted by `salt`. */
  _spare(salt) {
    const m = this.mounts.find((o) => !o.active)
    if (!m) throw new Error(`TownLife: ${this.town.id} is out of striders`)
    m.active = true
    m.rs = hash32(this.seed, 0x5791de, m.id, salt)
    m.clip = 'idle'
    m.speed = 0
    return m
  }

  _gone(m) {
    m.active = false
    m.state = 'gone'
    m.tether = m.leader = m.rider = null
    m.reserved = false
  }

  /** Stood at `t`, facing its rail. */
  _tie(m, t) {
    m.state = 'tied'
    m.tether = t
    m.leader = m.rider = null
    t.mount = m
    t.want = null
    m.x = m.px = t.x
    m.z = m.pz = t.z
    m.y = m.py = this.heightAt(t.x, t.z, -Infinity)
    m.heading = m.ph = m.aim = t.heading
    m.hold = between(m.rand, TOWNSFOLK.strider.fidget)
    this._mgait(m, 0)
  }

  _mgait(m, v) {
    const clip = v > 0 ? 'walk' : 'idle'
    if (m.clip !== clip) { m.clip = clip; m.cue++ }
    m.speed = v
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
    if (clip === 'ride') c.speed = c.state === 'walk' ? JOURNEYS.speed.ride : 0
    else c.speed = speed === undefined ? 0 : speed * c.k * c.pace
  }

  /** Stood where it is, or sat in the saddle. */
  _still(c) { this._play(c, c.mount ? 'ride-idle' : 'idle', STEP_S) }

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

  /** To `node` by the ways, then on through the points `extra`; `from` are points walked first, back out of a place off the ways (a rail). */
  _go(c, node, then, extra = [], from = []) {
    this._leaveSeat(c)
    const { parent } = dijkstra(this.graph, c.at, node)
    const path = pathTo(parent, c.at, node)
    // Stopped past its node (a chat, a stool), it walks back to it rather than cutting the corner.
    const at = this.graph.nodes[c.at]
    if ((path.length || from.length) && (from.length || Math.hypot(at.x - c.x, at.z - c.z) > TOWNSFOLK.node)) path.unshift(c.at)
    c.route = [...from.map(([x, z]) => ({ x, z, node: -1 })), ...this._keepRight(path)]
    for (const p of extra) c.route.push({ x: p.x, z: p.z, node: -1 })
    c.wp = 0
    c.then = then
    c.dest = node
    c.state = 'walk'
    this._play(c, c.mount ? 'ride' : 'walk', STEP_S)
    if (c.route.length === 0) this._arrive(c)
  }

  _errand(c) {
    if (this.homing) { this._go(c, c.home, 'enter'); return }
    const kind = pick(c.rand, TOWNSFOLK.errands)
    if (kind === 'lead' && this._lead(c)) return
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
      case 'job': this._jobStep(c); break
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

  // -- the striders and the road: jobs, each a run of steps (`job.step`), advanced by _jobStep as each route or hold ends ------

  /** A planned journey's traveller set going: a departer called off whatever it was doing, an arrival stood on the road at its port end. */
  _start({ kind, c, j, k }) {
    if (c.state === 'talk') this._untalk(c)
    this._leaveSeat(c)
    c.hidden = false
    c.job = { kind, j, k, step: 0, mount: null, tether: null, dest: null, legs: 0 }
    if (kind === 'ridein' || kind === 'walkin') {
      const at = this.journeys.at(j, k, j.t1, {})
      c.x = c.px = at.x
      c.z = c.pz = at.z
      c.y = c.py = this.heightAt(at.x, at.z, -Infinity)
      c.heading = c.ph = c.aim = at.heading
      c.at = this.graph.ports[j.route.toStub]
    }
    this._jobStep(c)
  }

  _work(c, hold, aim = c.heading) {
    c.state = 'work'
    c.hold = hold
    c.aim = aim
    c.route.length = 0
    c.wp = 0
    this._still(c)
  }

  /** A tied mount no one is coming for, or null. */
  _pickMount(c) {
    const free = this.mounts.filter((m) => m.active && m.state === 'tied' && !m.reserved)
    if (free.length === 0) return null
    const m = free[(c.rand() * free.length) | 0]
    m.reserved = true
    return m
  }

  /** Up into the saddle of `m` from where it stands, or (`up` false) down to `to`. */
  _hop(c, m, up, to) {
    c.hopA = up ? { x: c.x, z: c.z } : { x: to[0], z: to[1] }
    c.hopB = { x: m.x, z: m.z }
    this._work(c, TOWNSFOLK.strider.hop, m.heading)
  }

  _landed(c) {
    const { hopA, hopB } = c
    c.hopA = c.hopB = null
    c.hop = c.mount && c.mount.state === 'ridden' ? 1 : 0
    const p = c.hop === 1 ? hopB : hopA
    c.x = p.x
    c.z = p.z
    if (c.hop === 0) c.mount = null
  }

  /** Gone down the road: the road draws it from here (Townsfolk._road). */
  _away(c) {
    const { j } = c.job
    if (!this.all.some((o) => o !== c && o.job !== null && o.job.j === j)) this.holding.delete(j.id)
    if (c.mount) this._gone(c.mount)
    c.mount = null
    c.hop = c.phop = 0
    c.job = null
    c.state = 'away'
    c.hidden = true
  }

  _jobStep(c) {
    const job = c.job, S = TOWNSFOLK.strider
    const now = this.tick * TICK_S
    const t = job.tether, m = job.mount
    const toward = (o) => this._toward(c, o.x, o.z)
    const pt = ([x, z]) => ({ x, z })
    const step = job.step++
    switch (`${job.kind}:${step}`) {
      // Fetch a strider, untie it, up, and off to the port end by t0.
      case 'depart:0': {
        const got = this._pickMount(c)
        if (!got) { job.step = 0; this._work(c, 2); return }
        job.mount = got
        job.tether = got.tether
        this._go(c, got.tether.node, 'job', [pt(got.tether.reach), pt(got.tether.stand)])
        return
      }
      case 'depart:1': this._work(c, S.untie, toward(m)); return
      case 'depart:2':
        t.mount = null
        m.tether = null
        m.state = 'ridden'
        m.rider = c
        c.mount = m
        this._hop(c, m, true)
        return
      case 'depart:3': {
        this._landed(c)
        job.at = this.journeys.at(job.j, 0, job.j.t0, {})
        this._go(c, this.graph.ports[job.j.route.stub], 'job', [job.at], [t.reach])
        return
      }
      case 'depart:4': this._work(c, Math.max(0, job.j.t0 - now), job.at.heading); return
      case 'depart:5': this._away(c); return
      // A party member to its place in the file behind the port end, and off at t0.
      case 'walkout:0':
        job.at = this.journeys.at(job.j, job.k, job.j.t0, {})
        this._go(c, this.graph.ports[job.j.route.stub], 'job', [job.at])
        return
      case 'walkout:1': this._work(c, Math.max(0, job.j.t0 - now), job.at.heading); return
      case 'walkout:2': this._away(c); return
      // Ridden in off the road to a free tether, down, tied, and indoors: a door of its own now.
      case 'ridein:0': {
        const free = this.tethers.filter((o) => o.mount === null && o.want === null)
        if (free.length === 0) throw new Error(`TownLife: ${this.town.id} has no free tether for a rider arriving at ${now}`)
        const got = this._spare(this.tick)
        Object.assign(got, { state: 'ridden', rider: c, x: c.x, z: c.z, y: c.y, px: c.x, pz: c.z, py: c.y, heading: c.heading, ph: c.heading })
        job.mount = c.mount = got
        c.hop = c.phop = 1
        job.tether = free[(c.rand() * free.length) | 0]
        job.tether.want = got
        this._go(c, job.tether.node, 'job', [pt(job.tether.reach), { x: job.tether.x, z: job.tether.z }])
        return
      }
      case 'ridein:1': this._work(c, 0, t.heading); return
      case 'ridein:2': this._tie(m, t); this._hop(c, m, false, t.stand); return
      case 'ridein:3': this._landed(c); this._work(c, S.untie, toward(m)); return
      case 'ridein:4': return this._settle(c, [t.reach])
      case 'walkin:0': return this._settle(c, [])
      // A strider walked on its rein from one rail to another (_lead began it): untied, led a leg or two, tied again.
      case 'lead:0': this._work(c, S.untie, toward(m)); return
      case 'lead:1': {
        t.mount = null
        m.tether = null
        m.state = 'led'
        m.leader = c
        const free = this.tethers.filter((o) => o.mount === null && o.want === null && o !== t)
        const other = free.filter((o) => o.post !== t.post)
        job.dest = other.length > 0 ? other[(c.rand() * other.length) | 0] : t
        job.dest.want = m
        job.legs = Math.round(between(c.rand, S.legs))
        job.step = 2
        return this._leadLeg(c, [t.reach])
      }
      case 'lead:2': return this._leadLeg(c, [])
      case 'lead:3':
        m.state = 'settle'
        m.tether = job.dest
        m.leader = null
        this._work(c, 1, toward(m))
        return
      case 'lead:4':
        if (m.state !== 'tied') { job.step = 4; this._work(c, 0.5, toward(m)); return }
        this._work(c, S.untie, toward(m))
        return
      case 'lead:5':
        m.reserved = false
        this.led--
        c.job = null
        this._go(c, job.dest.node, 'errand', [], [job.dest.reach])
        return
      default: throw new Error(`TownLife: a ${job.kind} job has no step ${step}`)
    }
  }

  /** An arrival's last step: a door of its own, walked to and gone in. */
  _settle(c, from) {
    const { doors } = this.graph
    c.home = doors[(c.rand() * doors.length) | 0]
    c.mount = null
    c.job = null
    this._go(c, c.home, 'enter', [], from)
  }

  /** An errand's lead, when a strider stands free and no departure is due soon. */
  _lead(c) {
    const S = TOWNSFOLK.strider
    if (!this.journeys || c.planned || this.led > 0 || this.homing || this.tick > this.turnTick - S.late * TICK_HZ) return false
    const soon = this.tick + S.clear * TICK_HZ
    for (let i = this.next; i < this.plan.length && this.plan[i].tick <= soon; i++) if (this.plan[i].kind === 'depart') return false
    if (this.all.some((o) => o.job !== null && o.job.kind === 'depart' && o.job.step <= 1)) return false
    const m = this._pickMount(c)
    if (!m) return false
    this.led++
    c.job = { kind: 'lead', j: null, k: 0, step: 0, mount: m, tether: m.tether, dest: null, legs: 0 }
    this._go(c, m.tether.node, 'job', [{ x: m.tether.reach[0], z: m.tether.reach[1] }, { x: m.tether.stand[0], z: m.tether.stand[1] }])
    return true
  }

  _leadLeg(c, from) {
    const job = c.job
    if (job.legs > 0 && !this.homing) {
      job.legs--
      job.step = 2
      const { targets } = this.graph
      this._go(c, targets[(c.rand() * targets.length) | 0], 'job', [], from)
      return
    }
    job.step = 3
    const d = job.dest
    this._go(c, d.node, 'job', [{ x: d.reach[0], z: d.reach[1] }, { x: d.stand[0], z: d.stand[1] }], from)
  }

  /** A mount's tick: fidgeting at its rail, under its rider, on its rein, or walking itself onto its tether. */
  _tickMount(m) {
    m.px = m.x; m.py = m.y; m.pz = m.z; m.ph = m.heading
    const S = TOWNSFOLK.strider, dt = TICK_S, walk = this.strider.walk
    switch (m.state) {
      case 'tied':
        m.hold -= dt
        if (m.hold > 0) break
        if (m.clip === 'fidget') { m.clip = 'idle'; m.hold = between(m.rand, S.fidget) } else { m.clip = 'fidget'; m.hold = this.strider.fidget }
        m.cue++
        break
      case 'ridden': {
        const r = m.rider
        if (r.hop >= 1) { m.x = r.x; m.z = r.z; m.heading = r.heading }
        this._mgait(m, r.state === 'walk' && r.hop >= 1 ? r.speed : 0)
        break
      }
      case 'led': {
        const L = m.leader, dx = L.x - m.x, dz = L.z - m.z, d = Math.hypot(dx, dz)
        if (d > S.rein + (m.speed > 0 ? 0 : 0.3)) {
          m.aim = Math.atan2(-dz, dx)
          const v = Math.min(1.5 * walk, (d - S.rein) / dt)
          const turned = this._turn(m, dt)
          m.x += Math.cos(m.heading) * v * dt * turned
          m.z -= Math.sin(m.heading) * v * dt * turned
          this._mgait(m, v)
        } else this._mgait(m, 0)
        break
      }
      case 'settle': {
        const t = m.tether, dx = t.x - m.x, dz = t.z - m.z, d = Math.hypot(dx, dz)
        if (d > 0.05) {
          const s = Math.min(d, walk * dt)
          m.aim = Math.atan2(-dz, dx)
          this._turn(m, dt)
          m.x += (dx / d) * s
          m.z += (dz / d) * s
          this._mgait(m, walk)
          break
        }
        m.aim = t.heading
        this._turn(m, dt)
        this._mgait(m, 0)
        if (Math.abs(swing(m.heading, m.aim)) < 0.02) this._tie(m, t)
        break
      }
      default: throw new Error(`TownLife: no mount state named ${m.state}`)
    }
    if (this.grounded) m.y = this.heightAt(m.x, m.z, m.y)
  }

  _meet(c) {
    const busy = (o) => o.talked > 0 || o.seat !== null || o.partner !== null || o.job !== null
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

  /** A step along the route at the gait. A stool's feet and a job's mark are walked onto straight, so the turn's circle cannot orbit them. */
  _follow(c, dt) {
    const step = c.speed * dt
    let left = step
    while (left > 0) {
      const p = c.route[c.wp]
      const d = Math.hypot(p.x - c.x, p.z - c.z)
      const last = c.wp === c.route.length - 1
      const onto = (c.then === 'sit' || c.then === 'job') && last
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
    c.phop = c.hop
    if (this.homing && c.state !== 'inside' && c.state !== 'away' && c.job === null) {
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
      case 'work':
        c.hold -= dt
        this._turn(c, dt)
        if (c.hopA) {
          const u = clamp(1 - c.hold / TOWNSFOLK.strider.hop, 0, 1)
          c.hop = c.mount.state === 'ridden' ? u : 1 - u
          c.x = c.hopA.x + (c.hopB.x - c.hopA.x) * c.hop
          c.z = c.hopA.z + (c.hopB.z - c.hopA.z) * c.hop
        }
        if (c.hold <= 0 && Math.abs(swing(c.heading, c.aim)) < 0.02) this._jobStep(c)
        break
      case 'away': break
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
const _hand = new THREE.Vector3()
const _head = new THREE.Vector3()
const _shyOut = { x: 0, z: 0, r: 0 }

export class Townsfolk {
  /**
   * @param opts.towns     planTowns()'s towns
   * @param opts.walk      WalkSurface: heightAt, the ground they and the stools stand on
   * @param opts.field     V2Height: heightAt, for the hearths
   * @param opts.bank      buildRockBank()'s answer, for the fire ring
   * @param opts.textures  the prop atlas
   * @param opts.patch     (material, cacheKey) => material, the lighting patch
   * @param opts.seed      the world's seed
   * @param opts.journeys  journeys.js Journeys over the roads, if any: the striders at the rails and the travellers
   * @param opts.bond      wild-striders.js's { trusted, grown }: a tied strider fed a fish trusts her, as a wild one does
   * @param opts.eat       (lure) => true once her hand holding it has lost it
   */
  constructor(scene, { towns, walk, field, bank, textures, patch, seed = 1, journeys = null, bond = { trusted: new Set(), grown: new Map() }, eat = () => false } = {}) {
    if (!Array.isArray(towns)) throw new Error('Townsfolk: needs the towns')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Townsfolk: needs the WalkSurface')
    if (typeof patch !== 'function') throw new Error('Townsfolk: needs the lighting patch')
    this.scene = scene
    this.towns = towns
    this.walk = walk
    this.journeys = journeys
    this.bond = bond
    this.eat = eat
    // Keys of the tied striders she rides (WildStriders.borrow), hidden at their rails meanwhile.
    this.lent = new Set()
    this.treats = 0
    // Every town's hearth draws this one, built at boot on level ground (hearth.js hearthKit).
    this.kit = hearthKit(bank, hash32(seed, 0x4ea7), () => 0, textures, patch, { decimate: false })
    this.hearthOpts = { field, bank, textures, patch, kit: this.kit }
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
    // Its materials are the caller's to light, as these are.
    this.striders = journeys ? new Striders(scene, { walk, textures, patch }) : null
    this.bodies = null
    this.hearthScale = 1
    // Town index -> { life, hearth, rails } for each town alive.
    this.alive = new Map()
    // The travellers on the roads near her, `${journey}:${member}` -> { j, k, c, m } (a person, and its mount if it rides).
    this.road = new Map()
    this.roadAt = -Infinity
    this.onRoad = []
    this.ids = 0
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
    const [strider, ...assets] = await Promise.all([this.striders ? loadStriderGlb() : null, ...TOWNSFOLK.bodies.map((id) => loadBipedGlb(`creatures/${id}.glb`))])
    this.setAssets(assets, assets.map((_, i) => {
      const entry = avatars.find((a) => a.id === TOWNSFOLK.bodies[i])
      if (!entry || !(entry.heightM > 0)) throw new Error(`Townsfolk: ${ROSTER_URL} has no height for ${TOWNSFOLK.bodies[i]}`)
      return entry.heightM
    }), strider)
    return true
  }

  setAssets(assets, heights, strider = null) {
    if (!this.striders !== !strider) throw new Error('Townsfolk: the strider asset comes with the journeys')
    if (strider) this.striders.setAsset(strider)
    this.bodies = assets.map((asset, i) => {
      for (const name of CLIPS) if (!asset.clips.some((c) => c.name === name)) throw new Error(`Townsfolk: ${TOWNSFOLK.bodies[i]} has no ${name} clip`)
      const durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
      if (!(durations.sit > SIT_CUT[1])) throw new Error(`Townsfolk: ${TOWNSFOLK.bodies[i]}'s sit clip is ${durations.sit} s, cut at ${SIT_CUT}`)
      const right = asset.arms && asset.arms.find((a) => a.side === -1)
      if (!right) throw new Error(`Townsfolk: ${TOWNSFOLK.bodies[i]} names no right arm -- re-ship it`)
      const pool = this.pools[i]
      pool.plain.map = asset.map
      pool.plain.needsUpdate = true
      for (const mats of pool.mats) {
        for (const m of [mats.in, mats.out]) { m.map = asset.map; m.needsUpdate = true }
        const p = new Puppet(asset, mats, { clipFade: 0.25 })
        p.pool = i
        pool.puppets.push(p)
      }
      pool.free = pool.puppets.slice()
      return { asset, heightM: heights[i], height: asset.height, gait: asset.gait, wheelbase: asset.wheelbase, sitY: underside(asset, 'idle-sit').y, ride: underside(asset, 'ride'), wrist: boneIndex(asset, right.wrist), durations }
    })
    // One hearth for every body: grown so its stools' tops meet the mean seated underside.
    this.hearthScale = this.bodies.reduce((s, b) => s + (b.sitY / b.height) * b.heightM, 0) / this.bodies.length / SEAT_M
    this.loaded = true
  }

  /** Every town's campfire flame, woken or not, for ambience.js: the clearing is flattened to `town.y`. */
  get fires() {
    return this.towns.map((t) => ({ x: t.x, y: t.y + HEARTH.fire.lift * this.hearthScale, z: t.z }))
  }

  get stats() {
    let people = 0, shown = 0, mounts = 0
    for (const { life } of this.alive.values()) {
      people += life.all.length
      for (const c of life.all) if (c.puppet) shown++
      for (const m of life.mounts) if (m.active) mounts++
    }
    return { alive: this.alive.size, people, shown, mounts, road: this.road.size, starved: this.starved + (this.striders ? this.striders.starved : 0), greets: this.greets, hearthScale: +this.hearthScale.toFixed(2) }
  }

  _entity(c) {
    return Object.assign(c, { pose: { x: 0, y: 0, z: 0, heading: 0, k: c.k, speed: 0, clip: 'idle', hop: 0 }, lod: LOD_TIERS, puppet: null, greet: null, lag: false, cool: 0, gcue: 0 })
  }

  _wake(i) {
    const town = this.towns[i]
    const s = this.hearthScale
    const hearth = new Hearth(this.scene, this.hearthOpts.field, { ...this.hearthOpts, at: town, seed: hash32(this.seed, i, 0x4ea7), scale: s })
    const seats = hearth.stools.map((st) => ({ x: hearth.x + st.x * s, z: hearth.z + st.z * s, top: hearth.y + st.top * s, r: st.r * s, lookX: hearth.x, lookZ: hearth.z }))
    const J = this.striders ? { journeys: this.journeys, strider: this.striders.sim } : {}
    const life = new TownLife(town, { index: i, seed: this.seed, bodies: this.bodies, seats, heightAt: (x, z, y) => this.walk.heightAt(x, z, y), ...J })
    for (const c of life.all) this._entity(c)
    for (const m of life.mounts) Object.assign(m, mountFields(1), { key: `town:${i}:${m.id}`, base: striderSize(hash32(this.seed, i, m.id, 0x512e) / 4294967296), treat: null })
    this.alive.set(i, { life, hearth, rails: this.striders ? this.striders.rails(town) : null })
  }

  _sleep(i) {
    const { life, hearth, rails } = this.alive.get(i)
    for (const c of life.all) this._release(c)
    for (const m of life.mounts) this.striders.release(m)
    if (rails) this.striders.dropRails(rails)
    hearth.dispose()
    this.alive.delete(i)
  }

  _release(c) {
    if (!c.puppet) return
    c.puppet.release()
    this.batch.remove(c.puppet.group)
    this.pools[c.puppet.pool].free.push(c.puppet)
    c.puppet = null
  }

  /** Once a frame: towns woken and let go by her distance, each alive one stepped to the clock (those catching up sharing the replay budget), the travellers near her on the roads, and all of it drawn nearest first, the striders before their riders. */
  update(feet, head, seconds, dt, t, lures = []) {
    if (!this.loaded) return
    this.frame++
    const [wake, sleep] = TOWNSFOLK.live
    this.towns.forEach((town, i) => {
      const d = Math.hypot(town.x - head.x, town.z - head.z) - town.radius
      if (!this.alive.has(i) && d < wake) this._wake(i)
      else if (this.alive.has(i) && d > sleep) this._sleep(i)
    })
    const drawn = [], mounts = []
    let budget = TOWNSFOLK.replay
    for (const { life, hearth } of this.alive.values()) {
      hearth.update(head.x, head.y, head.z, t)
      if (life.caught) life.advance(seconds)
      else budget -= life.advance(seconds, budget)
      if (!life.caught) continue
      for (const c of life.all) {
        if (c.hidden && !c.puppet && !c.greet && !c.lag) continue
        this._pose(c, life.alpha, feet, seconds, dt)
        c.dist = Math.hypot(c.pose.x - head.x, c.pose.y - head.y, c.pose.z - head.z)
        drawn.push(c)
      }
      for (const m of life.mounts) {
        if (!m.active && !m.puppet) continue
        this._feed(m, dt, lures)
        this._poseMount(m, life.alpha)
        this._shy(m, dt, head, seconds, lures)
        m.dist = Math.hypot(m.pose.x - head.x, m.pose.y - head.y, m.pose.z - head.z)
        mounts.push(m)
      }
    }
    if (this.striders) {
      this._road(seconds, head, dt, drawn, mounts)
      mounts.sort((a, b) => a.dist - b.dist)
      this.striders.begin()
      for (const m of mounts) this.striders.draw(m, dt)
    }
    drawn.sort((a, b) => a.dist - b.dist)
    this.ranks.fill(0)
    for (const c of drawn) this._draw(c, dt)
    if (this.striders) {
      for (const m of mounts) this._rein(m)
      this.striders.end()
    }
  }

  _poseMount(m, a) {
    const pose = m.pose
    pose.x = m.px + (m.x - m.px) * a
    pose.y = m.py + (m.y - m.py) * a
    pose.z = m.pz + (m.z - m.pz) * a
    pose.heading = m.ph + swing(m.ph, m.heading) * a
    pose.size = m.base * (this.bond.grown.get(m.key) ?? 1)
    pose.clip = m.treat ? 'peck' : m.clip
    pose.speed = m.treat ? 0 : m.speed
    pose.cue = m.treat ? -1 - m.treat.cue : m.cue
    m.gone = !m.active || (m.state === 'tied' && this.lent.has(m.key))
  }

  /** A tied strider startled by her (TOWNSFOLK.shy): run off from the rail, stood, and walked back, drawn over the sim's pose, which it rejoins. */
  _shy(m, dt, head, seconds, lures) {
    const Y = TOWNSFOLK.shy, p = m.pose, S = this.striders
    if (m.shy && (m.state !== 'tied' || m.gone)) m.shy = null
    if (!m.shy) {
      if (m.state !== 'tied' || m.gone || m.treat || !m.puppet || seconds < (m.shyAt ?? -Infinity) || this.bond.trusted.has(m.key)) return
      if (Math.hypot(p.x - head.x, p.z - head.z) > Y.m || lures.some((l) => l.by === null && l.kind === 'fish' && Math.hypot(l.x - p.x, l.z - p.z) < 2 * Y.m)) return
      const away = Math.atan2(p.z - head.z, p.x - head.x), far = Y.run[0] + (Y.run[1] - Y.run[0]) * Math.random()
      let tx = p.x, tz = p.z
      for (let d = 0.5; d <= far; d += 0.5) {
        const x = p.x + Math.cos(away) * d, z = p.z + Math.sin(away) * d, level = this.walk.waterAt(x, z)
        if (this.walk.obstacleAt(x, z, _shyOut, m) || (level !== null && level > this.walk.heightAt(x, z, p.y))) break
        tx = x
        tz = z
      }
      m.shy = { phase: 'run', x: p.x, z: p.z, h: p.heading, tx, tz, t: 0, wait: Y.wait[0] + (Y.wait[1] - Y.wait[0]) * Math.random(), cue: -1 - ++this.treats }
      S.say('striderChirp1', p, 1.6, 1)
      S.say('striderWhine', p, 1.3, 0.8)
    }
    const s = m.shy, walkV = S.asset.gait.walk * S.k * p.size, runV = Y.pace * S.asset.gait.run * S.k * p.size
    const next = (phase) => { s.phase = phase; s.t = 0; s.cue = -1 - ++this.treats }
    const go = (x, z, v) => {
      const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz)
      s.h += clamp(swing(s.h, Math.atan2(-dz, dx)), -6 * dt, 6 * dt)
      const step = Math.min(d, v * dt)
      if (d > 1e-3) { s.x += (dx / d) * step; s.z += (dz / d) * step }
      return d - step < 0.05
    }
    s.t += dt
    let clip = 'idle', speed = 0
    if (s.phase === 'run') {
      clip = 'run'; speed = runV
      if (go(s.tx, s.tz, runV)) next('wait')
    } else if (s.phase === 'wait') {
      if (s.t > s.wait) next('back')
    } else if (s.phase === 'back') {
      clip = 'walk'; speed = walkV
      if (go(p.x, p.z, walkV)) next('turn')
    } else {
      const left = swing(s.h, p.heading)
      s.h += clamp(left, -2 * dt, 2 * dt)
      clip = 'walk'; speed = 0.4 * walkV
      if (Math.abs(left) < 0.05) { m.shy = null; m.shyAt = seconds + Y.cool; return }
    }
    p.x = s.x
    p.z = s.z
    p.y = this.walk.heightAt(s.x, s.z, p.y)
    p.heading = s.h
    p.clip = clip
    p.speed = speed
    p.cue = s.cue
  }

  /** A tied strider eating the fish she holds to its beak, over the sim's clip: it trusts her after, or if it did, grows. */
  _feed(m, dt, lures) {
    const S = this.striders, F = WILD.fish
    if (m.treat && m.state !== 'tied') m.treat = null
    if (m.treat) {
      const t = m.treat
      t.t += dt
      if (!t.hit && t.t >= F.eat) {
        t.hit = true
        if (!this.eat(t.lure)) { m.treat = null; return }
        S.say('striderChirp1', m.pose, 1.15, 1)
      }
      if (t.t >= S.asset.clips.find((c) => c.name === 'peck').duration) {
        if (this.bond.trusted.has(m.key)) this.bond.grown.set(m.key, (this.bond.grown.get(m.key) ?? 1) * STRIDER.size.fed)
        else this.bond.trusted.add(m.key)
        S.say('striderChirp2', m.pose, 1.25, 1)
        m.treat = null
      }
      return
    }
    if (m.state !== 'tied' || m.gone || m.shy) return
    const lure = lures.find((l) => l.by === null && l.kind === 'fish' && S.bites(m, l.x, l.y, l.z))
    if (lure) m.treat = { t: 0, hit: false, lure, cue: ++this.treats }
  }

  /**
   * The travellers between towns within `road.m` of her, each member where
   * journeys.js `at` says, until the town it left or reaches has it: a town
   * alive holds its departures until they are off (TownLife.holding), and its
   * arrivals from t1.
   */
  _road(seconds, head, dt, drawn, mounts) {
    const R = TOWNSFOLK.road, J = this.journeys
    if (seconds >= this.roadAt) {
      this.roadAt = seconds + R.every
      const keep = new Set()
      for (const j of J.onRoad(seconds, this.onRoad)) {
        const at = J.at(j, 0, seconds, {})
        if (Math.hypot(at.x - head.x, at.z - head.z) > R.m) continue
        j.members.forEach((member, k) => {
          const key = `${j.id}:${k}`
          keep.add(key)
          if (!this.road.has(key)) this.road.set(key, this._traveller(j, k, member))
        })
      }
      for (const [key, r] of this.road) if (!keep.has(key)) this._drop(key, r)
    }
    for (const [key, r] of this.road) {
      const { j, k, c } = r
      const src = this.alive.get(j.from)
      if (seconds >= j.t1 || seconds < j.t0) { this._drop(key, r); continue }
      c.hidden = src !== undefined && (!src.life.caught || src.life.holding.has(j.id))
      J.at(j, k, seconds, r.at)
    }
    for (const r of this.road.values()) {
      const { c, m } = r, pose = c.pose, at = r.at
      // Out to its own side (JOURNEYS.lane's) past another journey's traveller ahead, both reckoned on their lanes, so neither passes through the other.
      const sx = -Math.sin(at.heading), sz = -Math.cos(at.heading), mine = this._roadR(r)
      let want = 0
      for (const o of this.road.values()) {
        if (o.j === r.j || o.c.hidden) continue
        const dx = o.at.x - at.x, dz = o.at.z - at.z, ahead = dx * Math.cos(at.heading) - dz * Math.sin(at.heading)
        if (ahead <= 0 || ahead > R.ahead) continue
        const lat = dx * sx + dz * sz, clear = mine + this._roadR(o)
        if (Math.abs(lat) < clear) want = Math.max(want, lat + clear)
      }
      r.side = r.fresh ? want : r.side + (want - r.side) * Math.min(1, dt / R.ease)
      pose.x = at.x + sx * r.side
      pose.z = at.z + sz * r.side
      pose.y = this.walk.heightAt(pose.x, pose.z, r.fresh ? -Infinity : pose.y)
      const s = swing(pose.heading, at.heading)
      pose.heading = r.fresh ? at.heading : pose.heading + Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * dt)
      r.fresh = false
      c.dist = Math.hypot(pose.x - head.x, pose.y - head.y, pose.z - head.z)
      if (!c.hidden || c.puppet) drawn.push(c)
      if (!m) continue
      Object.assign(m.pose, { x: pose.x, y: pose.y, z: pose.z, heading: pose.heading })
      m.gone = c.hidden
      m.dist = c.dist
      if (!m.gone || m.puppet) mounts.push(m)
    }
  }

  _traveller(j, k, member) {
    const b = member.body % this.bodies.length, body = this.bodies[b]
    const size = body.heightM * (1 + TOWNSFOLK.sizeVar * member.size)
    const c = this._entity({ id: this.ids++, body: b, size, k: size / body.height, hidden: false, mount: null })
    c.pace = j.ride ? 1 : j.speed / (body.gait.walk * c.k)
    Object.assign(c.pose, { clip: j.ride ? 'ride' : 'walk', speed: j.speed, cue: 0, from: -1, scale: 1, hop: j.ride ? 1 : 0 })
    let m = null
    if (j.ride) {
      m = Object.assign({ id: this.ids++, state: 'ridden', rider: c, key: null }, mountFields(striderSize(hash32(this.seed, j.from, j.to, Math.round(j.t0), k) / 4294967296)))
      Object.assign(m.pose, { clip: 'walk', speed: j.speed })
      c.mount = m
    }
    return { j, k, c, m, at: {}, fresh: true, side: 0 }
  }

  /** A traveller's half-width on the road: its strider's if it rides. */
  _roadR(r) { return r.m ? 0.2 * this.striders.asset.sizeM * r.m.pose.size : TOWNSFOLK.road.person }

  _drop(key, r) {
    this._release(r.c)
    if (r.m) this.striders.release(r.m)
    this.road.delete(key)
  }

  /**
   * The frame's pose: the sim's between its last two ticks, or while it greets
   * her, held where it stopped and turned to her; after, walked at `catchUp`
   * pace straight back onto the sim's until it is there.
   */
  _pose(c, a, feet, seconds, dt) {
    const pose = c.pose
    const sx = c.px + (c.x - c.px) * a, sy = c.py + (c.y - c.py) * a, sz = c.pz + (c.z - c.pz) * a
    pose.hop = c.phop + (c.hop - c.phop) * a
    const G = TOWNSFOLK.greet
    if (c.greet === null && !c.lag && !c.hidden && c.job === null && seconds >= c.cool && (c.state === 'walk' || c.state === 'stand' || c.state === 'talk') && Math.hypot(pose.x - feet.x, pose.z - feet.z) < G.m) {
      c.cool = seconds + G.cool
      if (Math.random() >= G.ignore) {
        c.greet = { until: seconds + between(Math.random, G.s), at: seconds, clip: pick(Math.random, G.clips) }
        c.gcue++
        this.greets++
      }
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
    // A traveller wears its journey member's body for the chapter, from another pool.
    if (c.puppet && c.puppet.pool !== c.body) this._release(c)
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
    puppet.show(want, gone ? DOOR_FADE_S : lodFadeS())
    puppet.mixer.timeScale = c.pace * pose.scale
    if (pose.hop > 0 && c.mount) this._saddle(c)
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

  /** In the saddle of its strider (drawn this frame) by its hop: the ride clip's underside on the saddle, rising `leap` over the line between. */
  _saddle(c) {
    const pose = c.pose, h = pose.hop
    const seat = this.striders.saddle(c.mount, _head)
    const hips = _hand.copy(this.bodies[c.body].ride).multiplyScalar(c.k).applyAxisAngle(UP, pose.heading)
    pose.x += (seat.x - hips.x - pose.x) * h
    pose.y += (seat.y - hips.y - pose.y) * h + Math.sin(Math.PI * h) * TOWNSFOLK.leap
    pose.z += (seat.z - hips.z - pose.z) * h
  }

  /** A strider's rein: to the rail's knot tied, else to the right hand of whoever leads or rides it. */
  _rein(m) {
    const S = this.striders
    if (m.gone || m.shy || !S.head(m, _head)) return
    if (m.state === 'tied') {
      const [x, z] = m.tether.knot
      S.rein(_hand.set(x, S.barY(x, z), z), _head)
      return
    }
    const by = m.state === 'led' ? m.leader : m.state === 'ridden' ? m.rider : null
    if (by === null || !by.puppet) return
    const p = by.puppet
    S.rein(_hand.setFromMatrixPosition(p.skeleton.bones[this.bodies[p.pool].wrist].matrixWorld).applyMatrix4(p.group.matrix), _head)
  }

  // -- her ride on a tied strider that trusts her (WildStriders.borrow) --------

  _mountable(m, head) {
    return m.active && m.state === 'tied' && m.puppet !== null && !m.gone && !m.treat && !m.shy && this.bond.trusted.has(m.key) && fromSide(m.pose, head)
  }

  /** The tied strider trusting her whose back `hand` touches from the side, or null. */
  mountableAt(hand, head) {
    for (const { life } of this.alive.values()) for (const m of life.mounts) {
      if (m.dist < 3 * m.pose.size && this._mountable(m, head) && touchesSaddle(this.striders.saddle(m, _hand), hand)) return m
    }
    return null
  }

  /** The tied strider trusting her whose back a ray from `origin` along unit `dir` passes over within `far`, from the side, or null. */
  mountableOnRay(origin, dir, far, head) {
    for (const { life } of this.alive.values()) for (const m of life.mounts) {
      if (m.dist > far + 2 || !this._mountable(m, head)) continue
      const along = this.striders.saddle(m, _hand).sub(origin).dot(dir)
      if (along > 0 && along < far && _hand.addScaledVector(dir, -along).length() < WILD.ray) return m
    }
    return null
  }

  /** `m` hidden at its rail while she rides it; what WildStriders.borrow needs of it. */
  lend(m) {
    this.lent.add(m.key)
    m.gone = true
    m.shy = null
    return { key: m.key, pose: m.pose, size: m.pose.size }
  }

  /** The tied strider under bond key `key` lent (lend) for a peer riding it, or null where its town is not alive and caught up here. */
  lendKey(key) {
    if (this.lent.has(key)) return null
    for (const { life } of this.alive.values()) {
      if (!life.caught) continue
      for (const m of life.mounts) if (m.key === key && m.active && m.state === 'tied') return this.lend(m)
    }
    return null
  }

  unlend(key) {
    if (!this.lent.delete(key)) throw new Error(`Townsfolk: ${key} was not lent`)
  }

  // -- bodies to the walker (walk.js addBody): the striders drawn at the rails and on the roads --

  bodyAt(x, z, pad, out, skip) {
    if (!this.striders || !this.loaded) return null
    for (const { life } of this.alive.values()) {
      if (!life.caught) continue
      for (const m of life.mounts) if (m !== skip && m.active && !m.gone && this.striders.bodyAt(m, x, z, pad, out)) return out
    }
    for (const { m } of this.road.values()) if (m && m !== skip && !m.gone && this.striders.bodyAt(m, x, z, pad, out)) return out
    return null
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
    for (const key of [...this.road.keys()]) this._drop(key, this.road.get(key))
    this.batch.removeFromParent()
    if (this.striders) this.striders.dispose()
    for (const m of this.materials) m.dispose()
    this.kit.dispose()
  }
}
