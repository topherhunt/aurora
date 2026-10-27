// Node-side gates for the castle layout (src/v2/castles/layout.js) and its preview shells (shell.js).
//
//   node scripts/check-castle-layout.mjs
//
// Ways a layout goes wrong without throwing: a seed that differs between runs, too many seeds failing the maze score, a passing
// layout with a stranded node, a route that does not run gate to summit along real edges, a summit that is not the castle's
// highest point, a route edge whose door sits on neither of its rooms, or shells over their triangle budget.
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
check(Math.max(...ext) < 8000, 'an exterior shell stays under 8k triangles', `worst ${Math.max(...ext)}`)
check(Math.max(...int) < 20000, 'an interior shell stays under 20k triangles', `worst ${Math.max(...int)}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
