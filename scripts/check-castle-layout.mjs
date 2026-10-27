// Node-side gates for the castle layout (src/v2/castles/layout.js) and its preview shells (shell.js).
//
//   node scripts/check-castle-layout.mjs
//
// Ways a layout goes wrong without throwing: a seed that differs between runs, too many seeds failing the maze score, a passing
// layout with a stranded node, a route that does not run gate to summit along real edges, a summit that is not the castle's
// highest point, a route edge whose door sits on neither of its rooms, shells over their triangle budget, or exterior faces that z-fight.
// What this can NOT check: whether the castle reads as a castle, or the maze is fun. That needs eyes, in gen-castle.html.

import { castleLayout, CASTLE } from '../src/v2/castles/layout.js'
import { exteriorGeometry, interiorGeometries } from '../src/v2/castles/shell.js'

let failures = 0
function check(ok, label, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const SEEDS = 200
const lays = []
for (let s = 1; s <= SEEDS; s++) lays.push(castleLayout(s))
const good = lays.filter((l) => l.stats.ok)

const sig = (l) => JSON.stringify([l.nodes.map((n) => [n.id, n.pos]), l.edges.map((e) => [e.a.id, e.b.id, e.kind])])
check([1, 7, 42].every((s) => sig(castleLayout(s)) === sig(lays[s - 1])), 'a seed lays out the same castle twice')
check(good.length >= SEEDS * 0.9, 'nine seeds in ten pass the maze score', `${good.length}/${SEEDS}`)
check(good.every((l) => l.stats.stranded === 0), 'a passing castle strands no node')
check(good.every((l) => l.stats.routeEdges >= CASTLE.minRoute && l.stats.switches >= CASTLE.minSwitches), 'a passing route is long and goes in and out',
  `min ${Math.min(...good.map((l) => l.stats.routeEdges))} edges`)

const routeOk = (l) => {
  const ns = l.route.nodes, es = l.route.edges
  if (ns[0].kind !== 'entry' || ns.at(-1).kind !== 'summit' || es.length !== ns.length - 1) return false
  return es.every((e, i) => l.edges.includes(e) && new Set([e.a, e.b]).has(ns[i]) && new Set([e.a, e.b]).has(ns[i + 1]))
}
check(good.every(routeOk), 'the route runs entry to summit along chosen edges')
check(good.every((l) => { const top = l.nodes.find((n) => n.kind === 'summit'); return l.nodes.every((n) => n === top || n.pos[1] < top.pos[1]) }), 'the summit is the highest node')

// A door belongs on the boundary of each room it joins.
const onRoom = (l, d, n) => n.kind !== 'room' || (d.axis === 'x'
  ? [n.x0, n.x0 + n.w].some((x) => Math.abs(d.x - l.X(x)) < 1e-6)
  : [n.z0, n.z0 + n.d].some((z) => Math.abs(d.z - l.Z(z)) < 1e-6))
const badDoor = good.flatMap((l) => l.edges.filter((e) => e.kind === 'door').filter((e) => !e.doors.every((d) => onRoom(l, d, e.a) && onRoom(l, d, e.b))).map((e) => `${l.seed}:${e.a.id}-${e.b.id}`))
check(badDoor.length === 0, 'every room door lies on both rooms\' walls', badDoor.slice(0, 3).join(' '))

const ms = good.map((l) => l.stats.ms).sort((a, b) => a - b)
console.log(`       layout ms: median ${ms[ms.length >> 1].toFixed(1)}, worst ${ms.at(-1).toFixed(1)}`)

const tri = (g) => g.getAttribute('position').count / 3
const ext = good.map((l) => tri(exteriorGeometry(l)))
const int = good.slice(0, 40).map((l) => interiorGeometries(l).reduce((a, s) => a + tri(s.geometry), 0))
check(Math.max(...ext) < 20000, 'an exterior shell stays under 20k triangles', `worst ${Math.max(...ext)}`)
check(Math.max(...int) < 30000, 'an interior shell stays under 30k triangles', `worst ${Math.max(...int)}`)

// Two same-facing triangles sharing a plane z-fight; only a colour difference makes it visible. The straight (unwarped) shell is
// scanned, since the warp moves coincident faces together.
function zFights(g) {
  const p = g.getAttribute('position').array, c = g.getAttribute('color').array, buckets = new Map()
  for (let t = 0; t < p.length / 9; t++) {
    const v = [0, 1, 2].map((i) => [p[t * 9 + i * 3], p[t * 9 + i * 3 + 1], p[t * 9 + i * 3 + 2]])
    const e1 = v[1].map((x, i) => x - v[0][i]), e2 = v[2].map((x, i) => x - v[0][i])
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...n)
    const u = n.map((x) => x / l), d = u[0] * v[0][0] + u[1] * v[0][1] + u[2] * v[0][2]
    const ax = [0, 1, 2].reduce((a, i) => (Math.abs(u[i]) > Math.abs(u[a]) ? i : a), 0)
    const key = [...u, d].map((x) => Math.round(x * 200)).join()
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ q: v.map((w) => w.filter((_, i) => i !== ax)), col: [c[t * 9], c[t * 9 + 1], c[t * 9 + 2]].map((x) => x.toFixed(3)).join() })
  }
  const sep = (A, B) => [A, B].some((T) => T.some((a, i) => {
    const b = T[(i + 1) % 3], n = [b[1] - a[1], a[0] - b[0]], pr = (P) => P.map((w) => w[0] * n[0] + w[1] * n[1])
    const l = Math.hypot(...n), [pa, pb] = [pr(A), pr(B)]
    return Math.min(...pa) >= Math.max(...pb) - 1e-3 * l || Math.min(...pb) >= Math.max(...pa) - 1e-3 * l
  }))
  let hits = 0
  for (const b of buckets.values()) for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) if (b[i].col !== b[j].col && !sep(b[i].q, b[j].q)) hits++
  return hits
}
const fights = good.slice(0, 30).map((l) => [l.seed, zFights(exteriorGeometry(l, { warp: false }))]).filter(([, h]) => h)
check(fights.length === 0, 'no two differently coloured exterior faces share a plane', fights.slice(0, 4).map(([s, h]) => `seed ${s}: ${h}`).join(', '))

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
