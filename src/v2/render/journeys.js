import { mulberry32 } from '../../sim/mathx.js'
import { CHAPTER_S, chapterOf, hash32 } from '../../sim/score.js'
import { Heap } from '../layers/route.js'
import { TRADES } from '../layers/trades.js'

// Who is on the roads between towns (DESIGN.md §32), three-free and the same on every client: each town's chapter holds a few departure slots, each maybe a rider or a party on foot bound for a town the roads reach from one of its ports. A journey leaves its town's port end at t0 and reaches the destination's at t1; the towns' sims (townsfolk.js TownLife) hand off at those two points, and the road between is drawn from `at` alone.

export const JOURNEYS = {
  // Departure slots a town's chapter, the chance each holds one, and the seconds into the chapter they leave the port within: late enough to have fetched a strider, early enough to be gone before the town homes.
  slots: 2,
  chance: 0.5,
  leave: [300, 480],
  rider: 0.55,
  party: [[1, 0.5], [2, 0.3], [3, 0.2]],
  // Trades that keep their townsfolk at home.
  home: ['smith', 'potions', 'inn'],
  // Each class's weight in the draw for a journey's members (TRADES.roles): travellers are mostly the ones on the road, children never.
  road: { travel: 6, folk: 1, guard: 0.4, child: 0 },
  // Metres a second along the road: the strider's walk a touch brisk, and a human's.
  speed: { ride: 1.25, foot: 1.05 },
  // Metres between a party's members, and right of the road's middle each keeps to.
  gap: 1.6,
  lane: 0.7,
  // Destinations are towns the roads reach from a port without passing another town's, at most `far` m.
  far: 2400,
  // Seconds after its chapter's start and before its end that an arrival may land at the destination, so the destination's sim sees it and settles it before homing.
  settle: [5, 210],
}

export const townKey = (town) => `town:${town.id}`

const pick = (rand, pairs) => {
  let r = rand() * pairs.reduce((s, [, w]) => s + w, 0)
  for (const [v, w] of pairs) if ((r -= w) < 0) return v
  return pairs[pairs.length - 1][0]
}

/**
 * Every town's routes over `plan` (roads.js planRoads), port end to port end:
 * `{ to, stub, toStub, pts: [[x, z]], s, length }`, the shortest to each town
 * the ways reach without passing a port. `bodies` are the avatars' ids; a
 * journey's members are townsfolk of its town (town.folk) whose trade does not
 * keep them home, none the destination has, and none twice in a chapter.
 */
export class Journeys {
  constructor(towns, plan, { seed, bodies }) {
    if (!Array.isArray(bodies) || bodies.length === 0) throw new Error('Journeys: needs the avatar ids')
    for (const t of towns) if (!Array.isArray(t.folk)) throw new Error(`Journeys: ${t.id} has no folk`)
    this.towns = towns
    this.seed = seed
    this.bodies = bodies
    this.keys = towns.map(townKey)
    this.offsets = this.keys.map((k) => chapterOf(0, k).offset)
    this.routes = routesOf(towns, plan)
    this.into = towns.map((_, ti) => towns.map((_, a) => a).filter((a) => this.routes[a].some((r) => r.to === ti)))
    const longest = Math.max(0, ...this.routes.flat().map((r) => r.length))
    // Longest a journey stays on the road, a party's last member included.
    this.maxS = longest / JOURNEYS.speed.foot + 1
    this.cache = new Map()
  }

  /** Town `ti`'s departures in its chapter `index`, t0 ordered. */
  departures(ti, index) {
    const id = `${ti}:${index}`
    let list = this.cache.get(id)
    if (list) return list
    list = []
    const routes = this.routes[ti]
    const start = index * CHAPTER_S + this.offsets[ti]
    const [lo, hi] = JOURNEYS.leave
    const w = (hi - lo) / JOURNEYS.slots
    const gone = new Set()
    for (let slot = 0; routes.length > 0 && slot < JOURNEYS.slots; slot++) {
      const rand = mulberry32(hash32(this.seed, ti, index, slot, 0x10ad))
      if (rand() >= JOURNEYS.chance) continue
      const t0 = start + lo + w * (slot + rand())
      const route = routes[(rand() * routes.length) | 0]
      const ride = rand() < JOURNEYS.rider
      const there = new Set(this.towns[route.to].folk.map((f) => f.body))
      const free = this.towns[ti].folk.filter((f) => !JOURNEYS.home.includes(f.trade) && !there.has(f.body) && !gone.has(f.body) && JOURNEYS.road[TRADES.roles[f.body]] > 0)
      const n = Math.min(ride ? 1 : pick(rand, JOURNEYS.party), free.length)
      if (n === 0) continue
      const speed = ride ? JOURNEYS.speed.ride : JOURNEYS.speed.foot
      const t1 = t0 + route.length / speed
      const into = t1 - chapterOf(t1, this.keys[route.to]).start
      if (into < JOURNEYS.settle[0] || into > CHAPTER_S - JOURNEYS.settle[1]) continue
      const members = Array.from({ length: n }, () => {
        const { body } = free.splice(free.indexOf(pick(rand, free.map((f) => [f, JOURNEYS.road[TRADES.roles[f.body]]]))), 1)[0]
        gone.add(body)
        return { body: this.bodies.indexOf(body), size: 2 * rand() - 1 }
      })
      list.push({ id: `${id}:${slot}`, from: ti, to: route.to, route, t0, t1, ride, speed, members })
    }
    if (this.cache.size > 4096) this.cache.clear()
    this.cache.set(id, list)
    return list
  }

  _chapters(ti, lo, hi, each) {
    for (let i = chapterOf(lo, this.keys[ti]).index, last = chapterOf(hi, this.keys[ti]).index; i <= last; i++) for (const j of this.departures(ti, i)) each(j)
  }

  /** Town `ti`'s departures leaving in [lo, hi). */
  leaving(ti, lo, hi) {
    const out = []
    this._chapters(ti, lo, hi, (j) => { if (j.t0 >= lo && j.t0 < hi) out.push(j) })
    return out
  }

  /** The journeys reaching town `ti` in [lo, hi), t1 ordered. */
  arriving(ti, lo, hi) {
    const out = []
    for (const a of this.into[ti]) this._chapters(a, lo - this.maxS, hi, (j) => { if (j.to === ti && j.t1 >= lo && j.t1 < hi) out.push(j) })
    return out.sort((p, q) => p.t1 - q.t1)
  }

  /** Every journey on the road at `t`, into `out`. */
  onRoad(t, out) {
    out.length = 0
    this.towns.forEach((_, ti) => this._chapters(ti, t - this.maxS, t, (j) => { if (j.t0 <= t && t < j.t1) out.push(j) }))
    return out
  }

  /** Member `k` of `j` at `t`: `{ x, z, heading }` on the road, `gap` behind the one before and `lane` right of the middle; before the port end, straight back along the road's first run. */
  at(j, k, t, out) {
    const { pts, s } = j.route
    const d = (t - j.t0) * j.speed - k * JOURNEYS.gap
    let i = 1
    while (i < pts.length - 1 && s[i] < d) i++
    const [ax, az] = pts[i - 1]
    const [bx, bz] = pts[i]
    const len = s[i] - s[i - 1]
    const u = (d - s[i - 1]) / len
    const dx = (bx - ax) / len, dz = (bz - az) / len
    out.x = ax + (bx - ax) * u + dz * JOURNEYS.lane
    out.z = az + (bz - az) * u - dx * JOURNEYS.lane
    out.heading = Math.atan2(-dz, dx)
    return out
  }
}

function routesOf(towns, plan) {
  const { nodes } = plan
  const ways = new Map(plan.ways.map((w) => [w.id, w]))
  const line = (w) => (w.pts ? w.pts.map(([x, , z]) => [x, z]) : [[nodes[w.a].x, nodes[w.a].z], [nodes[w.b].x, nodes[w.b].z]])
  return towns.map((_, ti) => {
    const best = new Map()
    for (const from of nodes.filter((n) => n.port && n.town === ti)) {
      const dist = new Float64Array(nodes.length).fill(Infinity)
      const via = new Int32Array(nodes.length).fill(-1)
      const heap = new Heap(64)
      dist[from.id] = 0
      heap.push(0, from.id)
      const seen = new Uint8Array(nodes.length)
      while (heap.n > 0) {
        const u = heap.pop()
        if (seen[u]) continue
        seen[u] = 1
        if (u !== from.id && nodes[u].port) continue
        for (const wid of nodes[u].ways) {
          const w = ways.get(wid)
          const v = w.a === u ? w.b : w.a
          const d = dist[u] + w.length
          if (d < dist[v]) { dist[v] = d; via[v] = wid; heap.push(d, v) }
        }
      }
      for (const n of nodes) {
        if (!n.port || n.town === ti || dist[n.id] > JOURNEYS.far) continue
        if (best.has(n.town) && best.get(n.town).d <= dist[n.id]) continue
        best.set(n.town, { d: dist[n.id], from, end: n, via })
      }
    }
    return [...best.entries()].sort((p, q) => p[0] - q[0]).map(([to, { from, end, via }]) => {
      const legs = []
      for (let v = end.id; v !== from.id;) {
        const w = ways.get(via[v])
        const pts = line(w)
        legs.unshift(w.a === v ? pts.reverse() : pts)
        v = w.a === v ? w.b : w.a
      }
      const pts = [[from.port.end[0], from.port.end[2]]]
      for (const leg of legs) for (const p of leg) if (Math.hypot(p[0] - pts.at(-1)[0], p[1] - pts.at(-1)[1]) > 0.05) pts.push(p)
      const e = [end.port.end[0], end.port.end[2]]
      if (Math.hypot(e[0] - pts.at(-1)[0], e[1] - pts.at(-1)[1]) > 0.05) pts.push(e)
      const s = [0]
      for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
      return { to, stub: from.port.stub, toStub: end.port.stub, pts, s, length: s.at(-1) }
    })
  })
}
