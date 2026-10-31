// Node-side gates for the castle layout (src/v2/castles/layout.js) and its preview shells (shell.js).
//
//   node scripts/check-castle-layout.mjs
//
// Ways a layout goes wrong without throwing: a seed that differs between runs, too many seeds failing the maze score, a passing
// layout with a stranded node, a route that does not run gate to summit along real edges, a summit that is not the castle's
// highest point, a route edge whose door sits on neither of its rooms, shells over their triangle budget, exterior faces that z-fight
// or crack open under the warp, door leaves hidden behind stone,
// collision that throws (over a wide seed sweep) or passes the walk's span cap, a castle without its doors, spirals and rope, or a
// dungeon whose chest she can reach without unlocking its door, or cannot reach with it, or that is over its triangle budget.
// What this can NOT check: whether the castle reads as a castle, or the maze is fun. That needs eyes, in gen-castle.html.

import { readFileSync } from 'node:fs'
import { castleLayout, CASTLE } from '../src/v2/castles/layout.js'
import { DOOR_SLOT, exteriorGeometry, GATE_SLOT, interiorGeometries, SPIRAL, warpOf } from '../src/v2/castles/shell.js'
import { castleSolids, exteriorSpans, interiorSpans, spiralTreadAt, SPANS, SPAN_CAP } from '../src/v2/castles/solids.js'
import { dungeonPlan } from '../src/v2/castles/dungeon.js'
import { dungeonGeometry } from '../src/v2/castles/dungeon-mesh.js'
import { dungeonProps } from '../src/v2/castles/furnish.js'
import { FOLK_CHAT, FOLK_SAYS, folkMoment, insideCast, maidSays, outsideCast } from '../src/v2/render/castle-folk.js'
import { fits } from '../src/v2/talk/caption.js'

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

const tri = (g) => g.position.length / 9
const ext = good.map((l) => tri(exteriorGeometry(l)))
const int = good.slice(0, 40).map((l) => interiorGeometries(l).reduce((a, s) => a + tri(s.geometry), 0))
check(Math.max(...ext) < 20000, 'an exterior shell stays under 20k triangles', `worst ${Math.max(...ext)}`)
check(Math.max(...int) < 110000, 'an interior shell stays under 110k triangles', `median ${[...int].sort((a, b) => a - b)[int.length >> 1]}, worst ${Math.max(...int)}`)

// Two same-facing triangles sharing a plane z-fight; only a colour difference makes it visible. The straight (unwarped) shell is
// scanned, since the warp moves coincident faces together.
function zFights(g) {
  const p = g.position, c = g.color, buckets = new Map()
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

// The warp moves each vertex on its own, so a vertex partway along another face's edge (a T-junction) opens a crack the sky shows
// through. Returns the widest such crack between faces turned alike (back-to-back faces of abutting bodies hide theirs).
function widestCrack(l) {
  const P = exteriorGeometry(l, { warp: false }).position, W = warpOf(l.seed, 1), ids = new Map(), V = [], adj = [], faces = new Map()
  const vid = (i) => { const k = [0, 1, 2].map((a) => Math.round(P[i * 3 + a] * 1e4)).join(); if (!ids.has(k)) { ids.set(k, V.length); V.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]) } return ids.get(k) }
  const sub = (a, b) => a.map((x, i) => x - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`)
  for (let t = 0; t < P.length / 9; t++) {
    const v = [0, 1, 2].map((k) => vid(t * 3 + k)), e1 = sub(V[v[1]], V[v[0]]), e2 = sub(V[v[2]], V[v[0]])
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3]
      if (!faces.has(ek(a, b))) faces.set(ek(a, b), []); faces.get(ek(a, b)).push(n); (adj[a] ??= new Set()).add(b); (adj[b] ??= new Set()).add(a)
    }
  }
  const grid = new Map(), cell = (p) => p.map((x) => Math.floor(x / 0.5)).join()
  V.forEach((p, i) => { if (!grid.has(cell(p))) grid.set(cell(p), []); grid.get(cell(p)).push(i) })
  const off = (A, d, p) => { const w = sub(p, A), t = dot(w, d) / dot(d, d); return [t, Math.hypot(...sub(w, d.map((x) => x * t)))] }
  let worst = { gap: 0 }
  for (const [key, ns] of faces) {
    const [a, b] = key.split(',').map(Number), A = V[a], d = sub(V[b], A), lo = A.map((x, i) => Math.floor(Math.min(x, V[b][i]) / 0.5)), hi = A.map((x, i) => Math.floor(Math.max(x, V[b][i]) / 0.5))
    if (Math.hypot(...d) < 0.05) continue
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) for (const v of grid.get(`${x},${y},${z}`) || []) {
      const [t, o] = off(A, d, V[v])
      if (v === a || v === b || t <= 1e-3 || t >= 1 - 1e-3 || o > 2e-4) continue
      const mine = [...adj[v]].filter((w) => off(A, d, V[w])[1] < 2e-4).flatMap((w) => faces.get(ek(v, w)))
      if (!mine.some((m) => ns.some((n) => dot(m, n) > -0.5 * Math.hypot(...m) * Math.hypot(...n)))) continue
      const wa = W(...A), wb = W(...V[b]), gap = Math.hypot(...sub(W(...V[v]), wa.map((q, i) => q + (wb[i] - q) * t)))
      if (gap > worst.gap) worst = { gap, seed: l.seed, at: V[v].map((q) => q.toFixed(1)).join(' ') }
    }
  }
  return worst
}
const crack = good.slice(0, 30).map(widestCrack).reduce((a, b) => (b.gap > a.gap ? b : a))
check(crack.gap < 0.06, 'no exterior seam opens 6 cm under the warp', `widest ${(crack.gap * 100).toFixed(1)} cm, seed ${crack.seed} at ${crack.at}`)

// A leaf vanishes behind stone that stands across it: the warped wall sagging between its far-apart vertices, or a parapet running
// past a door onto its roof. Rays from 1.5 m out up each unbarred door's centreline must meet its leaf first for 2 m of its height.
function leafSeen(l) {
  const g = exteriorGeometry(l), P = g.position, tris = [], leaf = []
  for (const [start, count, slot] of g.groups) for (let v = start; v < start + count; v += 3) {
    tris.push([0, 1, 2].map((j) => [P[(v + j) * 3], P[(v + j) * 3 + 1], P[(v + j) * 3 + 2]])); leaf.push(slot === DOOR_SLOT || slot === GATE_SLOT)
  }
  const sub = (a, b) => a.map((v, k) => v - b[k]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const box = tris.map((t) => [0, 1, 2].flatMap((k) => [Math.min(t[0][k], t[1][k], t[2][k]) - 0.01, Math.max(t[0][k], t[1][k], t[2][k]) + 0.01]))
  const first = (o, p) => {
    let best = Infinity, hit = -1
    const d = sub(p, o)
    tris.forEach(([A, B, C], i) => {
      if ([0, 1, 2].some((k) => Math.max(o[k], p[k]) < box[i][k * 2] || Math.min(o[k], p[k]) > box[i][k * 2 + 1])) return
      const f1 = sub(B, A), f2 = sub(C, A), h = cross(d, f2), det = dot(f1, h)
      if (Math.abs(det) < 1e-12) return
      const s = sub(o, A), u = dot(s, h) / det, q = cross(s, f1), w = dot(d, q) / det, t = dot(f2, q) / det
      if (u >= 0 && u <= 1 && w >= 0 && u + w <= 1 && t > 0 && t < best) { best = t; hit = i }
    })
    return hit >= 0 && leaf[hit]
  }
  let worst = Infinity
  for (const e of l.edges) if (e.a.out || e.b.out || e.kind === 'bridge') for (const d of e.doors) {
    if (d.look === 'barred') continue
    const n = d.axis === 'x' ? [d.side, 0, 0] : [0, 0, d.side], at = (y, r) => [d.x + n[0] * r, d.y + y, d.z + n[2] * r]
    let seen = 0
    for (let y = 0.1; y < d.h; y += 0.2) if (first(at(y, 1.5), at(y, -0.5))) seen += 0.2
    worst = Math.min(worst, seen)
  }
  return worst
}
const seen = good.slice(0, 60).map((l) => [l.seed, leafSeen(l)]), shortSeen = seen.filter(([, m]) => m < 2)
check(shortSeen.length === 0, "every door's leaves show 2 m of their height past the stone in front of them", shortSeen.length ? shortSeen.slice(0, 4).map(([s, m]) => `seed ${s}: ${m.toFixed(1)} m`).join(', ') : `worst ${Math.min(...seen.map(([, m]) => m)).toFixed(1)} m`)

const lowTri = good.slice(0, 40).map((l, i) => tri(exteriorGeometry(l, { full: false })) / ext[i])
check(Math.max(...lowTri) < 0.9, 'the mid-distance exterior is lighter than the full one', `worst ${(Math.max(...lowTri) * 100).toFixed(0)}% of full`)

// Collision: castleSolids throws where a portal has nowhere to set her down. Columns are sampled on a 0.5 m grid over each footprint,
// the interior at every storey.
let solidFail = null, worstEx = 0, worstIn = 0, portalsShort = []
for (const l of good.slice(0, 60)) {
  let sol
  try { sol = castleSolids(l) } catch (e) { solidFail ??= `seed ${l.seed}: ${e.message}`; continue }
  const x0 = l.X(0) - 8, x1 = l.X(l.cw) + 8, z0 = l.Z(0) - 8, z1 = l.Z(l.cd) + 16, top = Math.max(...l.sections.map((s) => s.floors ?? 1))
  for (let x = x0; x <= x1; x += 0.5) for (let z = z0; z <= z1; z += 0.5) {
    worstEx = Math.max(worstEx, exteriorSpans(sol.ex, x, z))
    for (let k = -1; k <= top; k++) worstIn = Math.max(worstIn, interiorSpans(sol.it, x * CASTLE.scale, z * CASTLE.scale, k * CASTLE.storey * CASTLE.tall + 0.5))
  }
  const P = sol.portals, want = l.edges.filter((e) => e.stair).length + 1
  if (P.doors.length === 0 || sol.it.spirals.length !== want || !P.rope || !P.chest) portalsShort.push(l.seed)
}
// A castle whose collision throws never loads in, so far more seeds are swept here than the grid above can afford.
for (let seed = 100000; seed < 103000 && solidFail === null; seed++) {
  const l = castleLayout(seed)
  if (l.stats.ok) try { castleSolids(l) } catch (e) { solidFail = `seed ${seed}: ${e.message}` }
}
for (const seed of [661222, 111589]) if (solidFail === null) try { const l = castleLayout(seed); if (l.stats.ok) castleSolids(l) } catch (e) { solidFail = `seed ${seed}: ${e.message}` }
check(solidFail === null, 'every castle\'s collision and portals build', solidFail ?? '')
check(worstEx < SPAN_CAP && worstIn < SPAN_CAP, 'no castle column passes the walk\'s span cap', `worst exterior ${worstEx}, interior ${worstIn} of ${SPAN_CAP}`)
check(portalsShort.length === 0, 'every castle has doors, its spirals, a rope and a chest', portalsShort.slice(0, 5).join(' '))

// A teleport lob falls 0.26 m a sample at most: on every tread, at any phase, the first sample that meets a spiral is on that tread.
const lobThrough = []
for (const l of good.slice(0, 20)) {
  const it = castleSolids(l).it, SH = CASTLE.storey * CASTLE.tall, rise = SH / SPIRAL.steps / SPIRAL.treads
  for (const sp of it.spirals) for (let j = 0; j < SPIRAL.steps * SPIRAL.treads; j++) for (const r of [0.5, 1.2, 1.9]) for (const phase of [0, 0.09, 0.18]) {
    const a = sp.a0 + (j + 0.5) * Math.PI / 8 / SPIRAL.treads, x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r, top = sp.k * SH + (j + 1) * rise
    let hit = null
    for (let y = top + 0.9 - phase; y > top - 1 && hit === null; y -= 0.26) hit = spiralTreadAt(it, x, y, z)
    if (hit === null || Math.abs(hit - top) > 1e-6) lobThrough.push(`${l.seed}:${sp.k}:${j}`)
  }
}
check(lobThrough.length === 0, 'a teleport lob falling onto a spiral tread meets that tread', `${lobThrough.length}: ${lobThrough.slice(0, 6).join(' ')}`)

// The dungeon, walked on a 0.5 m grid from its foot chamber: a step is a floor within 0.45 m of the last with 1.7 m over it.
function walkDungeon(l, it) {
  const g = dungeonPlan(l), seen = new Set(), key = (i, j) => i + ',' + j
  const floorAt = (x, z, y) => {
    const n = interiorSpans(it, x, z, -5.5)
    for (let i = 0; i < n; i++) if (Math.abs(SPANS.HI[i] - y) <= 0.45 && (i + 1 === n || SPANS.LO[i + 1] - SPANS.HI[i] >= 1.7)) return SPANS.HI[i]
    return null
  }
  const { door } = g, start = [door.x - door.side * (door.axis === 'x' ? 1.5 : 0), door.z - door.side * (door.axis === 'z' ? 1.5 : 0)]
  const queue = [[Math.round(start[0] * 2), Math.round(start[1] * 2), -6]]
  seen.add(key(queue[0][0], queue[0][1]))
  while (queue.length) {
    const [i, j, y] = queue.pop()
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = key(i + a, j + b)
      if (seen.has(k)) continue
      const f = floorAt((i + a) / 2, (j + b) / 2, y)
      if (f === null || f > -5) continue
      seen.add(k)
      queue.push([i + a, j + b, f])
    }
  }
  const chest = dungeonProps(l).find((o) => o.kind === 'chest'), front = [chest.x + Math.sin(chest.yaw) * 0.8, chest.z + Math.cos(chest.yaw) * 0.8]
  const reached = [-1, 0, 1].some((a) => [-1, 0, 1].some((b) => seen.has(key(Math.round(front[0] * 2) + a, Math.round(front[1] * 2) + b))))
  let air = 0
  for (let c = 0; c < g.W * g.D; c++) if (!Number.isNaN(g.lo[c])) air++
  return { reached, share: seen.size / 4 / air }
}
let dungeonOpen = [], dungeonShut = [], dungeonShare = 1, dungeonTri = 0
for (const l of good.slice(0, 20)) {
  const sol = castleSolids(l)
  sol.it.unlocked = false
  if (walkDungeon(l, sol.it).reached) dungeonOpen.push(l.seed)
  sol.it.unlocked = true
  const w = walkDungeon(l, sol.it)
  if (!w.reached) dungeonShut.push(l.seed)
  dungeonShare = Math.min(dungeonShare, w.share)
  dungeonTri = Math.max(dungeonTri, tri(dungeonGeometry(l).geometry))
}
check(dungeonOpen.length === 0, 'a dungeon\'s chest is out of reach while its door is locked', dungeonOpen.slice(0, 5).join(' '))
check(dungeonShut.length === 0 && dungeonShare > 0.85, 'unlocked, she walks from the stair foot to its chest and most of the maze', `worst ${(dungeonShare * 100).toFixed(0)}% walked ${dungeonShut.slice(0, 5).join(' ')}`)
check(dungeonTri < 25000, 'a dungeon stays under 25k triangles', `worst ${dungeonTri}`)

// The household and garrison (render/castle-folk.js), less the two travellers a castle without a trail lacks.
const fewFolk = [], offFloor = [], noMaid = [], unvoiced = new Set()
const voiced = JSON.parse(readFileSync(new URL('../public/sounds/voice/moments.json', import.meta.url), 'utf8')).human
for (const l of good) {
  const inside = insideCast(l), outside = outsideCast(l, { x: 0, y: 0, z: 0, yaw: 0 }, null), it = castleSolids(l).it
  if (inside.length + outside.length < 10 || outside.filter((p) => p.who === 'watch').length < 3) fewFolk.push(l.seed)
  if (!inside.some((p) => p.who === 'maid') || ![true, false].every((h) => fits(maidSays(l, h, false)))) noMaid.push(l.seed)
  for (const p of [...inside, ...outside]) {
    if (FOLK_SAYS[p.who] === undefined || FOLK_SAYS[p.who].flat().some((m) => !(m in voiced) || voiced[m].length === 0)) unvoiced.add(p.who)
    if (FOLK_CHAT[p.who] === undefined) { unvoiced.add(`${p.who} chat`); continue }
    for (const step of FOLK_CHAT[p.who].flat()) {
      const [m, ids] = step.split(': '), have = new Set((voiced[m] ?? []).map((l) => l.slice(0, l.indexOf('.'))))
      if (have.size === 0 || (ids !== undefined && ids.split(' ').some((id) => !have.has(id)))) unvoiced.add(`${p.who} ${step}`)
    }
  }
  for (const p of inside) {
    const n = interiorSpans(it, p.x, p.z, p.y + 0.5)
    let ok = false
    for (let i = 0; i < n; i++) if (Math.abs(SPANS.HI[i] - p.y) < 0.1 && (i + 1 === n || SPANS.LO[i + 1] - SPANS.HI[i] >= 1.7)) ok = true
    if (!ok) offFloor.push(`${l.seed}:${p.who}`)
  }
}
check(fewFolk.length === 0, 'every castle has 10+ folk besides its travellers, 3 of them on the walls', fewFolk.slice(0, 5).join(' '))
check(noMaid.length === 0, 'every castle has its kitchen maid, her hint within the caption', noMaid.slice(0, 5).join(' '))
let roll = 12345
const rand = () => ((roll = (roll * 16807) % 2147483647) / 2147483647)
const rolls = Array.from({ length: 400 }, () => folkMoment('gate', false, rand))
const spoken = rolls.filter((m) => m !== null && m !== 'pass.nod')
check(unvoiced.size === 0, 'every castle folk speaks, and talks among themselves, in recorded words', [...unvoiced].slice(0, 6).join(', '))
check(folkMoment('gate', true, rand) === 'castle.halt' && !rolls.includes('castle.halt') && spoken.some((m) => m.startsWith('castle.')) && spoken.some((m) => !m.startsWith('castle.')), 'a gate guard halts her first, then speaks castle and everyday lines', spoken.slice(0, 4).join(' '))
const silent = rolls.filter((m) => m === null).length / rolls.length, nods = rolls.filter((m) => m === 'pass.nod').length / rolls.length
check(silent > 0.2 && nods > 0.1 && spoken.length / rolls.length < 0.6 && Array.from({ length: 20 }, () => folkMoment('maid', false, rand)).every((m) => m !== null && m !== 'pass.nod'), 'castle folk only sometimes speak to her, else nod or let her pass, but the maid always tells her hint', `${(silent * 100).toFixed(0)}% silent, ${(nods * 100).toFixed(0)}% nod`)
check(offFloor.length === 0, 'everyone inside stands on clear floor, 1.7 m under the ceiling', `${offFloor.length}: ${offFloor.slice(0, 6).join(' ')}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
if (failures) process.exit(1)
