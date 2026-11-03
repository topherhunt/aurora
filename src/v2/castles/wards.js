// Ward barriers and their runebooks (design/46-castle-wards.md): pure topology over a layout's nodes and edges, no geometry.
import { mulberry32 } from '../../sim/mathx.js'

export const WARDS = { min: 5, max: 8, trials: 150, runes: 10 }
/** The runes, in the order the panel and atlas lay them out. */
export const RUNES = ['strider', 'crab', 'frog', 'rabbit', 'deer', 'fox', 'dragon', 'pine', 'rock', 'castle']

/** Rope and barred door each lead only out to where she already stands, so neither widens what she can reach. */
const walkable = (e) => e.kind !== 'rope' && e.kind !== 'barred'

/**
 * The search over every order she might open wards in: from each reachable set of opened wards, she knows every book in reach and
 * has spent one per ward opened. Fails when some state leaves wards shut with no gem in reach or no code unspent, or ends with a
 * used node out of reach. Returns { ok, states, toSummit, shut } -- toSummit the fewest wards any order opens before the summit is in reach, shut the
 * share of rooms out of reach before any.
 */
export function wardSearch(nodes, edges, entry, summit, wards, books) {
  const W = wards.length, full = (1 << W) - 1, wardOf = new Map(wards.map((w, i) => [w.edge, i]))
  const adj = new Map(nodes.map((n) => [n, []]))
  for (const e of edges) if (walkable(e)) { adj.get(e.a).push([e.b, e]); adj.get(e.b).push([e.a, e]) }
  const used = nodes.filter((n) => !n.unused)
  const reach = (S) => {
    const seen = new Set([entry]), queue = [entry]
    for (let i = 0; i < queue.length; i++) for (const [q, e] of adj.get(queue[i])) {
      const w = wardOf.get(e)
      if (seen.has(q) || (w !== undefined && !(S & (1 << w)))) continue
      seen.add(q); queue.push(q)
    }
    return seen
  }
  const R0 = reach(0), inRooms = used.filter((n) => n.kind === 'room'), shut = inRooms.filter((n) => !R0.has(n)).length / inRooms.length
  const bits = (S) => { let c = 0; for (; S; S &= S - 1) c++; return c }
  const visited = new Set([0]), stack = [0]
  let toSummit = Infinity
  while (stack.length) {
    const S = stack.pop(), R = reach(S), opened = bits(S)
    if (R.has(summit)) toSummit = Math.min(toSummit, opened)
    if (S === full) {
      if (used.some((n) => !R.has(n))) return { ok: false, states: visited.size, toSummit, shut }
      continue
    }
    const known = books.filter((b) => R.has(b.node)).length
    const open = wards.map((w, i) => i).filter((i) => !(S & (1 << i)) && R.has(wards[i].gem))
    if (known <= opened || !open.length) return { ok: false, states: visited.size, toSummit, shut }
    for (const i of open) { const T = S | (1 << i); if (!visited.has(T)) { visited.add(T); stack.push(T) } }
  }
  return { ok: true, states: visited.size, toSummit, shut }
}

/**
 * 5-8 wards on doors between two rooms, each with its gem on one side, and as many runebooks (one more at times) in distinct rooms,
 * dead ends first, each with its own 3-rune code. Of the trials that pass wardSearch, the one whose summit needs the most wards opened
 * and that shuts nearest half the rooms at the start. Returns { wards: [{ edge, gem }], books: [{ node, code }], toSummit, trial }
 * or null.
 */
export function planWards(seed, nodes, edges, entry, summit, avoid) {
  // A one-cell room a spiral climbs through is all drum (planShafts): no floor for a book or a gem. `avoid` adds
  // rooms known to be all drum besides.
  const drum = new Set([...avoid, ...edges.filter((e) => e.stair).flatMap((e) => [e.a, e.b]).filter((n) => n.kind === 'room' && n.w * n.d === 1)])
  const rooms = nodes.filter((n) => n.kind === 'room' && !n.unused && !drum.has(n))
  const doors = edges.filter((e) => e.kind === 'door' && e.a.kind === 'room' && e.b.kind === 'room' && e.doors.length === 1 && !(drum.has(e.a) && drum.has(e.b)))
  if (doors.length < WARDS.min) return null
  const deg = new Map()
  for (const e of edges) if (walkable(e)) for (const n of [e.a, e.b]) deg.set(n, (deg.get(n) ?? 0) + 1)
  // Hops from the entry with every door open: a gem mostly faces the way she comes.
  const hops = new Map([[entry, 0]]), queue = [entry]
  for (let i = 0; i < queue.length; i++) for (const e of edges) if (walkable(e)) for (const [p, q] of [[e.a, e.b], [e.b, e.a]]) {
    if (p === queue[i] && !hops.has(q)) { hops.set(q, hops.get(p) + 1); queue.push(q) }
  }
  const dead = rooms.filter((n) => deg.get(n) === 1)
  let best = null
  for (let trial = 0; trial < WARDS.trials; trial++) {
    const r = mulberry32(Math.imul(seed + 3, 69069) + trial * 104729)
    const shuffle = (list) => list.map((x) => [r(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1])
    const n = Math.min(doors.length, WARDS.min + Math.floor(r() * (WARDS.max - WARDS.min + 1)))
    const wards = shuffle(doors).slice(0, n).map((edge) => {
      const [near, far] = hops.get(edge.a) <= hops.get(edge.b) ? [edge.a, edge.b] : [edge.b, edge.a]
      const flip = r() < 0.2
      return { edge, gem: drum.has(near) ? far : drum.has(far) ? near : flip ? far : near }
    })
    const count = n + (r() < 0.3 ? 1 : 0)
    if (count > rooms.length) continue
    const places = [...shuffle(dead), ...shuffle(rooms.filter((q) => deg.get(q) !== 1))].slice(0, count)
    const books = places.map((node) => ({ node, code: null }))
    const res = wardSearch(nodes, edges, entry, summit, wards, books)
    if (!res.ok) continue
    const score = 10 * res.toSummit + n - 4 * Math.abs(res.shut - 0.5) + r() * 0.01
    if (!best || score > best.score) best = { score, wards, books, toSummit: res.toSummit, trial, r }
  }
  if (!best) return null
  const codes = new Set()
  for (const b of best.books) {
    do b.code = shuffleCode(best.r); while (codes.has(b.code.join()))
    codes.add(b.code.join())
  }
  const { wards, books, toSummit, trial } = best
  return { wards, books, toSummit, trial }
}

/** Three distinct runes. */
function shuffleCode(r) {
  const out = []
  while (out.length < 3) { const i = Math.floor(r() * WARDS.runes); if (!out.includes(i)) out.push(i) }
  return out
}
