// Walking routes through a cave's passages (design/39-caves.md §11): the graph's edges sampled into a network of floor points, for the pets that lead her to treasure and back out.

import { columnAt } from './props.js'

// A wet passage costs this many times its length, so a dry way round wins whenever there is one.
const WET_COST = 6
// A route's points are never further apart than this.
const STEP_M = 2.5

class Heap {
  constructor() { this.a = [] }
  get size() { return this.a.length }
  push(k, v) {
    const a = this.a
    a.push([k, v])
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop()
    if (a.length > 0) {
      a[0] = last
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

/**
 * The network of `graph` in cave-local points: { x, y, z } flat arrays and `adj[v]` = [[u, cost], ...], one vertex per node centre and per passage sample. A drop is walked only from its high end down, a rockfall's passage not at all, and a flooded one (a sump, a drowned passage) at WET_COST times its length.
 */
export function buildNet(graph) {
  const X = [], Y = [], Z = [], adj = []
  const add = (x, y, z) => { X.push(x); Y.push(y); Z.push(z); adj.push([]); return X.length - 1 }
  const link = (a, b, k) => { adj[a].push([b, Math.hypot(X[a] - X[b], Y[a] - Y[b], Z[a] - Z[b]) * k]) }
  const nodeV = graph.nodes.map((n) => add(n.x, n.y, n.z))
  for (const e of graph.edges) {
    if (e.choke !== null) continue
    const k = e.kind === 'sump' || e.kind === 'drowned' ? WET_COST : 1
    const first = X.length
    for (const p of e.pts) add(p.x, p.y, p.z)
    const last = X.length - 1
    for (let v = first; v < last; v++) {
      link(v, v + 1, k)
      if (e.kind !== 'drop') link(v + 1, v, k)
    }
    link(nodeV[e.a], first, 1)
    link(last, nodeV[e.b], 1)
    if (e.kind !== 'drop') { link(first, nodeV[e.a], 1); link(nodeV[e.b], last, 1) }
  }
  return { x: X, y: Y, z: Z, adj, nodeV }
}

/** The vertex of `net` nearest (x, y, z). */
export function nearestVertex(net, x, y, z) {
  let best = Infinity, at = -1
  for (let v = 0; v < net.x.length; v++) {
    const d = (net.x[v] - x) ** 2 + (net.y[v] - y) ** 2 + (net.z[v] - z) ** 2
    if (d < best) { best = d; at = v }
  }
  return at
}

/** Shortest costs from `from` over `net`: { cost, prev } as typed arrays; unreached vertices cost Infinity. */
export function shortest(net, from) {
  const n = net.x.length
  const cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1)
  const heap = new Heap()
  cost[from] = 0
  heap.push(0, from)
  while (heap.size > 0) {
    const [c, v] = heap.pop()
    if (c > cost[v]) continue
    for (const [u, w] of net.adj[v]) {
      if (c + w < cost[u]) { cost[u] = c + w; prev[u] = v; heap.push(c + w, u) }
    }
  }
  return { cost, prev }
}

/** The vertices from `from` to `to` as { x, y, z } points, `from` first, in cave-local metres; `prev` from shortest(). */
export function walkBack(net, prev, to) {
  const out = []
  for (let v = to; v !== -1; v = prev[v]) out.push({ x: net.x[v], y: net.y[v], z: net.z[v] })
  return out.reverse()
}

/** `pts` with extra points so none is further than STEP_M from the next, each put on the floor under it (the first air above its height, from 0.6 m over it); a point added between two that falls in rock is dropped. */
export function onFloor(field, pts) {
  const out = []
  const put = (p, keep) => {
    const col = columnAt(field, p.x, p.z, p.y + 0.6)
    if (col !== null) out.push({ x: p.x, y: col.floor, z: p.z })
    else if (keep) out.push(p)
  }
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const a = pts[i - 1], b = pts[i]
      const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / STEP_M)
      for (let k = 1; k < n; k++) put({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, z: a.z + ((b.z - a.z) * k) / n }, false)
    }
    put(pts[i], true)
  }
  return out
}
