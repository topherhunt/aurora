// Ward barriers and their runebooks (design/46-castle-wards.md): pure topology over a layout's nodes and edges, no geometry.
import { mulberry32 } from '../../sim/mathx.js'

export const WARDS = { min: 5, max: 10, runes: 10, extra: 0.3 }
/** The runes, in the order the panel and atlas lay them out. */
export const RUNES = ['strider', 'crab', 'frog', 'rabbit', 'deer', 'fox', 'dragon', 'pine', 'rock', 'castle']

/** Rope and barred door each lead only out to where she already stands, so neither widens what she can reach. */
const walkable = (e) => e.kind !== 'rope' && e.kind !== 'barred'

/** Whether edge `e` can hold a ward whose gem stands on room `gem`'s side: a doorway, the gem indoors. A spiral's helix cannot; the
 * doors into its drum can. */
export function wardable(e, gem) {
  return (e.kind === 'door' || e.kind === 'bridge' || (e.kind === 'outstair' && e.doors.length > 0)) && gem.kind === 'room' && (e.a === gem || e.b === gem)
}

function graphOf(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]))
  for (const e of edges) if (walkable(e)) { adj.get(e.a).push([e.b, e]); adj.get(e.b).push([e.a, e]) }
  return adj
}
/** Hops from `from` and the edge each node was first reached by, skipping `blocked` edges. */
function bfs(adj, from, blocked) {
  const hops = new Map([[from, 0]]), via = new Map([[from, null]]), queue = [from]
  for (let i = 0; i < queue.length; i++) for (const [q, e] of adj.get(queue[i])) {
    if (hops.has(q) || blocked.has(e)) continue
    hops.set(q, hops.get(queue[i]) + 1); via.set(q, [queue[i], e]); queue.push(q)
  }
  return { hops, via }
}
const lengthOf = (e) => e.pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - e.pts[i - 1][0], p[1] - e.pts[i - 1][1], p[2] - e.pts[i - 1][2]) : 0), 0)
/** Metres walked from `from` to `to` with `blocked` edges shut. */
function metres(adj, len, from, to, blocked) {
  const d = new Map([[from, 0]]), done = new Set()
  for (;;) {
    let v = null
    for (const [n, x] of d) if (!done.has(n) && (v === null || x < d.get(v))) v = n
    if (v === null) return Infinity
    if (v === to) return d.get(v)
    done.add(v)
    for (const [q, e] of adj.get(v)) if (!blocked.has(e) && !done.has(q) && (!d.has(q) || d.get(v) + len.get(e) < d.get(q))) d.set(q, d.get(v) + len.get(e))
  }
}
/** The edges whose loss would split the walkable graph (Tarjan's bridges, iterative). */
function bridgesOf(adj, root) {
  const disc = new Map([[root, 0]]), low = new Map([[root, 0]]), out = new Set(), stack = [[root, null, 0]]
  let t = 1
  while (stack.length) {
    const top = stack.at(-1), [v, pe] = top, list = adj.get(v)
    if (top[2] < list.length) {
      const [q, e] = list[top[2]++]
      if (e === pe) continue
      if (!disc.has(q)) { disc.set(q, t); low.set(q, t++); stack.push([q, e, 0]) } else low.set(v, Math.min(low.get(v), disc.get(q)))
      continue
    }
    stack.pop()
    if (!stack.length) continue
    const p = stack.at(-1)[0]
    low.set(p, Math.min(low.get(p), low.get(v)))
    if (low.get(v) > disc.get(p)) out.add(pe)
  }
  return out
}

/**
 * The search over every order she might open wards in: from each reachable set of opened wards, she knows every book in reach and
 * has spent one per ward opened. Fails when some state leaves wards shut with no gem in reach, no code unspent (`slack` unspent where
 * two gems are in reach), or ends with a used node out of reach. Returns { ok, states, toSummit, shut } -- toSummit the fewest wards any order opens before the summit is
 * in reach, shut the share of rooms out of reach before any.
 */
export function wardSearch(nodes, edges, entry, summit, wards, books, slack = 1) {
  const W = wards.length, full = (1 << W) - 1, wardOf = new Map(wards.map((w, i) => [w.edge, i]))
  const adj = graphOf(nodes, edges)
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
    if (known < opened + (open.length > 1 ? slack : 1) || !open.length) return { ok: false, states: visited.size, toSummit, shut }
    for (const i of open) { const T = S | (1 << i); if (!visited.has(T)) { visited.add(T); stack.push(T) } }
  }
  return { ok: true, states: visited.size, toSummit, shut }
}

/**
 * 5-10 wards and a runebook for each, one spare (two at times), each book with its own 3-rune code; design/46-castle-wards.md, Planning.
 * The spine: single-file doorways on the entry-summit route, spread along it, every one of which she must open. The detours: doorways
 * on loops, each chosen to add the most metres to her walks to `goals` (summit first) while the castle stays whole without them.
 * Each book lies in a room or on a tower top she must pass through before she can reach its ward's gem. `drum` rooms take neither, except as the node
 * a stair's tunnel gem is reached from (`tunnels`, layout.js tunnelWards). Returns { wards: [{ edge, gem, tunnel? }], books:
 * [{ node, code }], toSummit, spine } or null when the route has too few single-file doorways.
 */
export function planWards(seed, nodes, edges, entry, goals, drum, tunnels) {
  const r = mulberry32(Math.imul(seed + 3, 69069))
  const adj = graphOf(nodes, edges), none = new Set(), used = nodes.filter((n) => !n.unused)
  // A ward's record for edge e with its gem on node gem's side, or null.
  const fits = (e, gem) => {
    if (wardable(e, gem)) return drum.has(gem) ? null : { edge: e, gem }
    const t = (tunnels.get(e) ?? []).find((q) => q.gem === gem)
    return t ? { edge: e, gem, tunnel: t.tunnel } : null
  }
  const { hops, via } = bfs(adj, entry, none)
  const route = []
  for (let n = goals[0]; via.get(n); n = via.get(n)[0]) route.unshift(via.get(n))
  const bridges = bridgesOf(adj, entry)
  const spine = route.filter(([from, e]) => bridges.has(e) && fits(e, from)).map(([from, e]) => fits(e, from))
  if (spine.length < WARDS.min) return null
  const n = WARDS.min + Math.floor(r() * (WARDS.max - WARDS.min + 1))

  const len = new Map(edges.map((e) => [e, lengthOf(e)]))
  const walk = (blocked) => goals.reduce((s, g) => s + metres(adj, len, entry, g, blocked), 0)
  const detours = [], blocked = new Set()
  let base = walk(blocked)
  const pool = edges.filter((e) => walkable(e) && !bridges.has(e) && !e.a.unused && !e.b.unused)
  while (detours.length < n - WARDS.min) {
    let best = null
    for (const e of pool) {
      if (blocked.has(e)) continue
      const [near, far] = hops.get(e.a) <= hops.get(e.b) ? [e.a, e.b] : [e.b, e.a], w = fits(e, near) ?? fits(e, far)
      if (!w) continue
      blocked.add(e)
      const whole = bfs(adj, entry, blocked).hops.size === used.length, d = whole ? walk(blocked) : 0
      blocked.delete(e)
      const gain = d - base + r()
      if (whole && gain > 2 && (!best || gain > best.gain)) best = { gain, w, d }
    }
    if (!best) break
    detours.push(best.w)
    blocked.add(best.w.edge)
    base = best.d
  }
  const b = Math.min(spine.length, n - detours.length)
  const wards = [...spine.map((w, i) => [r(), i, w]).sort((p, q) => p[0] - q[0]).slice(0, b).sort((p, q) => p[1] - q[1]).map((p) => p[2]), ...detours]

  // Cells: what joins up with every ward shut. She crosses a ward from its gem's cell; a cell's dominators are those she must
  // stand in before she can reach it.
  const shutAll = new Set(wards.map((w) => w.edge)), cellOf = new Map(), cells = []
  for (const s of used) {
    if (cellOf.has(s)) continue
    const c = cells.length
    cells.push([])
    for (const q of bfs(adj, s, shutAll).hops.keys()) { cellOf.set(q, c); cells[c].push(q) }
  }
  const out = cells.map(() => [])
  for (const w of wards) out[cellOf.get(w.gem)].push(cellOf.get(w.edge.a === w.gem ? w.edge.b : w.edge.a))
  const reachCells = (skip) => {
    const seen = new Set([cellOf.get(entry)]), queue = [cellOf.get(entry)]
    for (let i = 0; i < queue.length; i++) for (const q of out[queue[i]]) if (q !== skip && !seen.has(q)) { seen.add(q); queue.push(q) }
    return seen
  }
  if (reachCells(-1).size !== cells.length) throw new Error(`castle ${seed}: a ward cell cannot be reached from its gems`)
  const doms = cells.map((_, c) => new Set([c, cellOf.get(entry)]))
  cells.forEach((_, d) => { const seen = reachCells(d); cells.forEach((__, c) => { if (!seen.has(c)) doms[c].add(d) }) })

  // Books: tower tops and dead ends first, then the place farthest in hops from the books and gems placed so far; each pick keeps every ward matched.
  const deg = new Map(used.map((q) => [q, adj.get(q).length]))
  const roomsIn = (cs) => used.filter((q) => (q.kind === 'room' || q.kind === 'roof') && !drum.has(q) && cs.has(cellOf.get(q)))
  const opts = wards.map((w) => roomsIn(doms[cellOf.get(w.gem)]))
  const hopsFrom = new Map()
  const apart = (p, q) => { if (!hopsFrom.has(p)) hopsFrom.set(p, bfs(adj, p, none).hops); return hopsFrom.get(p).get(q) }
  const taken = new Map()
  const matched = (left) => {
    const own = new Map()
    const seat = (i, seen) => opts[i].some((q) => {
      if (taken.has(q) || seen.has(q)) return false
      seen.add(q)
      if (own.has(q) && !seat(own.get(q), seen)) return false
      own.set(q, i)
      return true
    })
    return left.every((i) => seat(i, new Set()))
  }
  const order = wards.map((_, i) => i).sort((p, q) => opts[p].length - opts[q].length)
  if (!matched(order)) return null
  const marks = wards.map((w) => w.gem)
  const worth = (q) => (deg.get(q) === 1 ? 3 : 0) + (q.kind === 'roof' ? 3 : 0) + Math.min(6, ...[...taken.keys(), ...marks].map((p) => apart(p, q))) + r()
  order.forEach((i, j) => {
    const pick = opts[i].filter((q) => !taken.has(q)).map((q) => [worth(q), q]).sort((p, q) => q[0] - p[0])
      .find(([, q]) => { taken.set(q, i); const ok = matched(order.slice(j + 1)); taken.delete(q); return ok })
    taken.set(pick[1], i)
  })
  // A spare in the free room fewest wards in: a code to lose before she first has a choice of gems.
  const best = (qs) => qs.map((q) => [worth(q), q]).sort((p, q) => q[0] - p[0])[0][1]
  const spare = roomsIn(new Set(cells.keys())).filter((q) => !taken.has(q))
  if (!spare.length) return null
  const depth = (q) => doms[cellOf.get(q)].size
  taken.set(best(spare.filter((q) => depth(q) === Math.min(...spare.map(depth)))), -1)
  const more = spare.filter((q) => !taken.has(q))
  if (r() < WARDS.extra && more.length) taken.set(best(more), -1)
  const books = [...taken.keys()].map((node) => ({ node, code: null }))
  const codes = new Set()
  for (const bk of books) {
    do bk.code = shuffleCode(r); while (codes.has(bk.code.join()))
    codes.add(bk.code.join())
  }
  const res = wardSearch(nodes, edges, entry, goals[0], wards, books)
  if (!res.ok || res.toSummit < b) throw new Error(`castle ${seed}: wards planned by construction fail the search (toSummit ${res.toSummit}, spine ${b})`)
  return { wards, books, toSummit: res.toSummit, spine: b }
}

/** Three distinct runes. */
function shuffleCode(r) {
  const out = []
  while (out.length < 3) { const i = Math.floor(r() * WARDS.runes); if (!out.includes(i)) out.push(i) }
  return out
}
