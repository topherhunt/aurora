// No invisible walls in the palisade labyrinths (render/palisades.js, layers/labyrinths.js; design/41-palisade-labyrinths.md), on the shipped world.
//
//   node scripts/check-labyrinth-walls.mjs [every=3]
//
// The drawn solids of a labyrinth are read off the data Palisades instances: poseSitePosts' posts (axis and girth), poseFixtures'
// poles, plinths and decks (their geometry's faces), and netGeometry's quads. The walker is WalkSurface over Palisades' columnAt.
// Over every `every`th labyrinth it samples a plan grid, rings round every drawn solid and runs of walks, with her feet on the
// ground and on every drawn top beside the point, and asserts both ways:
//   stopped -- wherever the walker is blocked (a column crossed, her capsule not fitting), a drawn solid stands within its
//              collision radius plus TOL of the blocked column at the heights that block; a floor she stands on is a drawn top;
//   drawn   -- she cannot stand inside a drawn post, net wall or slab.
// Also that no column holds more spans than the walker reads (a truncated column blocks every height).

import * as THREE from 'three'
import { readFileSync } from 'node:fs'

import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { BiomeField } from '../src/v2/layers/biome.js'
import { ALTAR, BEACON, CRACK, POST_R, POST_STRIDE, TOWER, entranceOf } from '../src/v2/layers/labyrinths.js'
import { SCAFFOLD } from '../src/v2/layers/scaffold.js'
import { POST_VARY, Palisades, fixtureGeometries, poseFixtures, poseSitePosts } from '../src/v2/render/palisades.js'
import { NET_THICK, WALL_R, netGeometry } from '../src/v2/render/scaffold-parts.js'
import { POST, TORCH_POLE } from '../src/props/palisade.js'
import { WalkSurface } from '../src/v2/walk.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'

const EVERY = Number(process.argv[2] ?? 3)
// Metres a collision radius may fall short of a drawn surface's distance: a mesh's roughness and a polyline's bend.
const TOL = 0.04
// A step's stride and the plan grid of a free column, and the finer grid over a scaffold.
const GRID = 0.25
const FINE = 0.1
const HALF_CRACK = CRACK.width[1] / 2 + 0.002
// Walker constants (walk.js, palisades.js).
const SPAN_CAP = 8
const ON_TOP = 0.05
const REACH = 1.2
const HEIGHT = 1.9
// How far a wall post's shaft strays from its line (render/palisades.js POST_VARY): its shift, plus its lean over the head volume above its pivot, and over the shaft above that to its top.
// A wall post's top is under its base's POST.height by the lean's drop (a few centimetres) and the mesh's roughness.
const TOP_SLACK = 0.1
const SHAFT_HEAD = POST_VARY.shift + (HEIGHT - POST_VARY.pivot) * Math.tan(POST_VARY.lean)
const SHAFT_TOP = POST_VARY.shift + (POST.height - POST_VARY.pivot) * Math.tan(POST_VARY.lean)
const RING = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4) * 0.3, Math.sin((k * Math.PI) / 4) * 0.3])

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const flagged = {}
const note = (kind, s, x, z, detail) => {
  const rows = (flagged[kind] ??= { n: 0, shown: [] })
  rows.n++
  if (rows.shown.length < 6) rows.shown.push(`at (${x.toFixed(4)}, ${z.toFixed(4)}) in (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)}): ${detail}`)
}

const hm = await Heightmap.read({ path: new URL('../public/world/height.png', import.meta.url), metaPath: new URL('../public/world/height.json', import.meta.url) })
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
field.setLayers(layers)
new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field }).rebuild()
const labyrinths = new BiomeField({ seed: SEED, ground: field }).labyrinths
const sites = labyrinths.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF).slice()
const ground = (x, z) => field.heightAt(x, z)

const palisades = Object.assign(Object.create(Palisades.prototype), { labyrinths, field, _ladders: new WeakMap() })
const walk = new WalkSurface(field, { columnAt: () => 0, blockTopAt: () => -Infinity }, { trunkAt: () => false })
walk.addStone(palisades)

// ---- the drawn solids of one labyrinth ------------------------------------------------------------------------------
// Items: { t: 'cyl', ax, az, bx, bz, y0, y1, r, hit } a post or pole (axis from its base a to its top b, `hit` its collision radius);
// { t: 'wall', x0, z0, x1, z1, y0, y1 } a net wall; { t: 'tri', p: [x, z] x3, top, bottom } a face looking up of a slab,
// `bottom` the slab's underside. Filed by bounding box in a 2 m hash.
const CELL = 2
const geos = fixtureGeometries()
const _m = new THREE.Matrix4()
const _v = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

function drawnOf(s) {
  const m = labyrinths.mazeOf(s)
  const items = []
  const add = (it, x0, z0, x1, z1) => { it.box = [Math.min(x0, x1) - 0.6, Math.min(z0, z1) - 0.6, Math.max(x0, x1) + 0.6, Math.max(z0, z1) + 0.6]; items.push(it) }
  const posts = labyrinths.postsOf(s)
  poseSitePosts(m, posts, ground, (i, _variant, matrix) => {
    const k = i * POST_STRIDE
    const a = _a.set(0, 0, 0).applyMatrix4(matrix), b = _b.set(0, POST.height, 0).applyMatrix4(matrix)
    const wall = posts[k + 7] === 1
    const girth = i >= m.scaffoldFrom ? SCAFFOLD.girth : TOWER.girth
    const r = POST.radius * new THREE.Vector3().setFromMatrixColumn(matrix, 0).length()
    add({ t: 'cyl', kind: wall ? 'wall post' : i >= m.scaffoldFrom ? 'scaffold post' : 'lookout post', ax: a.x, az: a.z, bx: b.x, bz: b.z, y0: a.y, y1: b.y, r, hit: wall ? POST_R + HALF_CRACK : POST_R * girth, stray: wall ? SHAFT_HEAD : 0, strayTop: wall ? SHAFT_TOP : 0 }, a.x, a.z, b.x, b.z)
  })
  const slab = (kind, matrix, geometry) => {
    const P = geometry.getAttribute('position')
    const n = P.count
    let low = Infinity
    const w = []
    for (let i = 0; i < n; i++) { w.push(new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(matrix)); low = Math.min(low, w[i].y) }
    for (let i = 0; i + 2 < n; i += 3) {
      _b.subVectors(w[i + 1], w[i])
      _c.subVectors(w[i + 2], w[i])
      if (_b.cross(_c).y < 1e-6) continue
      const y = (w[i].y + w[i + 1].y + w[i + 2].y) / 3
      if (Math.abs(w[i].y - y) > 1e-4 || Math.abs(w[i + 1].y - y) > 1e-4) continue
      add({ t: 'tri', kind, stand: kind !== 'plinths' || y > low + ALTAR.height - 0.02, p: [w[i].x, w[i].z, w[i + 1].x, w[i + 1].z, w[i + 2].x, w[i + 2].z], top: y, bottom: low }, Math.min(w[i].x, w[i + 1].x, w[i + 2].x), Math.min(w[i].z, w[i + 1].z, w[i + 2].z), Math.max(w[i].x, w[i + 1].x, w[i + 2].x), Math.max(w[i].z, w[i + 1].z, w[i + 2].z))
    }
  }
  poseFixtures(m, ground, (kind, matrix) => {
    if (kind === 'poles' || kind === 'beacons') {
      const x = matrix.elements[12], y = matrix.elements[13], z = matrix.elements[14]
      add({ t: 'cyl', kind: 'pole', ax: x, az: z, bx: x, bz: z, y0: y, y1: y + (kind === 'poles' ? TORCH_POLE.height : BEACON.height), r: TORCH_POLE.radius, hit: 0.12, stray: 0, strayTop: 0 }, x, z, x, z)
    } else if (kind === 'decks' || kind === 'plinths' || kind === 'scaffoldDecks' || kind === 'hatchDecks') slab(kind, matrix, geos[kind])
  })
  if (m.scaffold !== null) {
    const { geometry } = netGeometry([m.scaffold], ground)
    const P = geometry.getAttribute('position')
    for (let q = 0; q < P.count; q += 6) {
      const v = (i) => new THREE.Vector3().fromBufferAttribute(P, q + i)
      const c0 = v(0), c1 = v(1), c2 = v(2), c3 = v(5)
      if (Math.abs(c0.y - c2.y) < 1e-6) {
        // A floor quad, thin: its two triangles' faces looking up.
        for (const [p, r, t] of [[c0, c1, c2], [c0, c2, c3]]) {
          add({ t: 'tri', kind: 'net floor', p: [p.x, p.z, r.x, r.z, t.x, t.z], top: c0.y, bottom: c0.y - NET_THICK }, Math.min(p.x, r.x, t.x), Math.min(p.z, r.z, t.z), Math.max(p.x, r.x, t.x), Math.max(p.z, r.z, t.z))
        }
      } else add({ t: 'wall', kind: 'net wall', x0: c0.x, z0: c0.z, x1: c1.x, z1: c1.z, y0: c0.y, y1: c2.y }, c0.x, c0.z, c1.x, c1.z)
    }
  }
  const hash = new Map()
  for (const it of items) {
    for (let i = Math.floor(it.box[0] / CELL); i <= Math.floor(it.box[2] / CELL); i++) {
      for (let j = Math.floor(it.box[1] / CELL); j <= Math.floor(it.box[3] / CELL); j++) {
        const key = i * 65536 + j
        if (!hash.has(key)) hash.set(key, [])
        hash.get(key).push(it)
      }
    }
  }
  return { m, items, hash }
}

const near = (d, x, z) => d.hash.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL)) ?? []
const segDist = (x, z, x0, z0, x1, z1) => {
  const dx = x1 - x0, dz = z1 - z0, len = dx * dx + dz * dz
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / len))
  return Math.hypot(x - x0 - t * dx, z - z0 - t * dz)
}
const triDist = (x, z, [x0, z0, x1, z1, x2, z2]) => {
  const e = (ax, az, bx, bz) => (x - ax) * (bz - az) - (z - az) * (bx - ax)
  const s0 = e(x0, z0, x1, z1), s1 = e(x1, z1, x2, z2), s2 = e(x2, z2, x0, z0)
  if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) return 0
  return Math.min(segDist(x, z, x0, z0, x1, z1), segDist(x, z, x1, z1, x2, z2), segDist(x, z, x2, z2, x0, z0))
}

// The drawn solid that explains a column blocked for feet at `f`: the least (plan distance - collision radius) over the drawn
// solids standing at the heights that block, or Infinity. `sheer` solids block from the feet up; the rest only in the head volume.
function explained(d, x, z, f) {
  let best = Infinity, who = null
  for (const it of near(d, x, z)) {
    let gap = Infinity
    if (it.t === 'cyl') {
      const lo = Math.max(it.y0, f), hi = Math.min(it.y1, f + HEIGHT)
      if (it.y1 - ON_TOP <= f || lo > hi) continue
      for (const y of [lo, (lo + hi) / 2, hi]) {
        const u = (y - it.y0) / (it.y1 - it.y0)
        gap = Math.min(gap, Math.hypot(x - it.ax - u * (it.bx - it.ax), z - it.az - u * (it.bz - it.az)) - Math.max(it.hit, it.r) - it.stray)
      }
    } else if (it.t === 'wall') {
      if (it.y1 - ON_TOP <= f || it.y0 > f + HEIGHT) continue
      gap = segDist(x, z, it.x0, it.z0, it.x1, it.z1) - WALL_R
    } else {
      if (it.top <= f + REACH || it.bottom >= f + HEIGHT) continue
      gap = triDist(x, z, it.p) - (it.kind === 'net floor' ? 0 : 0.0)
    }
    if (gap < best) { best = gap; who = it.kind }
  }
  return { gap: best, who }
}

// ---- the probes -----------------------------------------------------------------------------------------------------
const buf = new Float64Array(SPAN_CAP * 2)
const stats = { columns: 0, blocked: 0, floors: 0, fitsStops: 0, steps: 0, inside: 0, crowded: 0, sites: 0 }
const worst = {}
const track = (who, gap) => { worst[who] = Math.max(worst[who] ?? -Infinity, gap) }

// Feet worth testing on a column: the ground, and every drawn top within a pace.
function feetAt(d, x, z, g, out) {
  out.length = 0
  out.push(g)
  for (const it of near(d, x, z)) {
    if (it.t !== 'tri' || !it.stand || it.top < g + 0.3 || out.includes(it.top)) continue
    if (triDist(x, z, it.p) < 0.6) out.push(it.top)
  }
  return out
}

// Every blocked column must be a drawn solid's; every floor over the ground a drawn top.
function probeColumn(s, d, x, z, feet) {
  stats.columns++
  const g = ground(x, z)
  for (const f of feetAt(d, x, z, g, feet)) {
    const n = palisades.columnAt(x, z, 0, buf, f)
    if (n >= SPAN_CAP) { stats.crowded++; note('crowded', s, x, z, `${n} spans at foot ${(f - g).toFixed(2)} over the ground`) }
    if (walk.crossed(x, z, f + REACH, f + HEIGHT)) {
      stats.blocked++
      const { gap, who } = explained(d, x, z, f)
      if (who !== null) track(who, gap)
      if (!(gap <= TOL)) note('invisible wall', s, x, z, `foot ${(f - g).toFixed(2)} over the ground, nearest drawn solid ${who} ${gap === Infinity ? 'none' : `${gap.toFixed(3)} m past its collision`}`)
    }
    const h = walk.heightAt(x, z, f)
    if (h > g + 1e-6 && Math.abs(h - f) > 1e-6) {
      stats.floors++
      let ok = false
      for (const it of near(d, x, z)) {
        if (it.t === 'tri') ok ||= Math.abs(it.top - h) < 1e-3 && triDist(x, z, it.p) <= TOL
        else if (it.t === 'cyl') ok ||= Math.abs(it.y1 - h) < Math.abs(ground(x, z) - ground(it.ax, it.az)) + TOP_SLACK && Math.hypot(x - it.bx, z - it.bz) <= Math.max(it.hit, it.r) + it.strayTop + TOL
        else ok ||= Math.abs(it.y1 - h) < 0.05 && segDist(x, z, it.x0, it.z0, it.x1, it.z1) <= WALL_R + TOL
      }
      if (!ok) note('invisible floor', s, x, z, `walker stands at ${(h - g).toFixed(2)} over the ground, foot ${(f - g).toFixed(2)}, no drawn top there`)
    }
  }
}

// She cannot stand inside a drawn solid: fits is false at a point on its axis (post), line (net wall) or face (slab) for feet where it blocks her.
function probeInside(s, d, it) {
  const tests = []
  if (it.t === 'cyl') {
    const g = ground(it.ax, it.az)
    const u = Math.min(1, (g + 1.5 - it.y0) / (it.y1 - it.y0))
    tests.push([it.ax + u * (it.bx - it.ax), it.az + u * (it.bz - it.az), g])
  } else if (it.t === 'wall') {
    for (const u of [0.25, 0.5, 0.75]) tests.push([it.x0 + u * (it.x1 - it.x0), it.z0 + u * (it.z1 - it.z0), it.y0])
  } else {
    const cx = (it.p[0] + it.p[2] + it.p[4]) / 3, cz = (it.p[1] + it.p[3] + it.p[5]) / 3
    tests.push([cx, cz, ground(cx, cz)])
  }
  for (const [x, z, f] of tests) {
    const lo = it.t === 'tri' ? it.bottom : it.y0, hi = it.t === 'tri' ? it.top : it.y1
    if (hi <= f + REACH || lo >= f + HEIGHT) continue
    stats.inside++
    if (walk.fits(x, z, f, null)) note('walks through', s, x, z, `${it.kind}: fits at foot ${(f - ground(x, z)).toFixed(2)} over the ground inside it`)
  }
}

// A walk from (x, z) along (dx, dz): the foot carried as the flood does; where she is stopped, a drawn solid explains it.
function walkRun(s, d, x, z, dx, dz, len) {
  let f = ground(x, z)
  if (!walk.fits(x, z, f, null)) return
  for (let t = 0; t < len; t += FINE) {
    const nx = x + dx * FINE, nz = z + dz * FINE
    const h = walk.heightAt(nx, nz, f)
    if (!walk.fits(nx, nz, h, null)) {
      stats.fitsStops++
      let ok = false
      for (const [ox, oz] of [[0, 0], ...RING]) {
        if (!walk.crossed(nx + ox, nz + oz, h + REACH, h + HEIGHT)) continue
        const e = explained(d, nx + ox, nz + oz, h)
        if (e.gap <= TOL) { ok = true; break }
      }
      if (!ok) note('invisible stop', s, nx, nz, `fits false at foot ${(h - ground(nx, nz)).toFixed(2)} over the ground and no blocked ring column has a drawn solid`)
      return
    }
    stats.steps++
    x = nx
    z = nz
    f = h
  }
}

function probeSite(s, k) {
  const d = drawnOf(s)
  const m = d.m
  stats.sites++
  const feet = []
  const R = s.reach
  for (let x = s.cx - R; x <= s.cx + R; x += GRID) for (let z = s.cz - R; z <= s.cz + R; z += GRID) if (Math.hypot(x - s.cx, z - s.cz) <= R) probeColumn(s, d, x, z, feet)
  if (m.scaffold !== null) {
    const sc = m.scaffold, half = (SCAFFOLD.bays * SCAFFOLD.bay) / 2 + 1.2
    for (let a = -half; a <= half; a += FINE) for (let b = -half; b <= half; b += FINE) probeColumn(s, d, sc.cx + a * sc.ux + b * sc.vx, sc.cz + a * sc.uz + b * sc.vz, feet)
  }
  for (const t of m.towers) for (let a = -1.4; a <= 1.4; a += FINE) for (let b = -1.4; b <= 1.4; b += FINE) probeColumn(s, d, t.x + a * t.ux - b * t.uz, t.z + a * t.uz + b * t.ux, feet)
  // Rings round every drawn solid, close in.
  for (const it of d.items) {
    if (it.t === 'tri' && it.kind !== 'plinths' && it.kind !== 'decks') continue
    const at = it.t === 'cyl' ? [[it.ax, it.az, it.r]] : it.t === 'wall' ? [0.1, 0.3, 0.5, 0.7, 0.9].map((u) => [it.x0 + u * (it.x1 - it.x0), it.z0 + u * (it.z1 - it.z0), 0]) : [[(it.p[0] + it.p[2] + it.p[4]) / 3, (it.p[1] + it.p[3] + it.p[5]) / 3, 0]]
    for (const [x, z, r] of at) {
      for (let q = 0; q < 12; q++) for (const rad of [r + 0.02, r + 0.08, r + 0.15, r + 0.25, r + 0.4]) probeColumn(s, d, x + Math.cos((q * Math.PI) / 6) * rad, z + Math.sin((q * Math.PI) / 6) * rad, feet)
    }
    if (it.t !== 'tri' || it.kind === 'plinths') probeInside(s, d, it)
  }
  // Walks at every drawn post and net wall from a pace or two off, and through the gate and across the middle.
  let rnd = (s.rx * 7919 + s.rz * 104729 + k) >>> 0
  const rand = () => { rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0; return rnd / 4294967296 }
  const targets = d.items.filter((it) => it.t !== 'tri')
  for (let q = 0; q < Math.min(targets.length, 400); q++) {
    const it = targets[Math.floor(rand() * targets.length)]
    const [tx, tz] = it.t === 'cyl' ? [it.ax, it.az] : [(it.x0 + it.x1) / 2, (it.z0 + it.z1) / 2]
    const ang = rand() * Math.PI * 2, off = 0.8 + rand() * 1.6
    walkRun(s, d, tx + Math.cos(ang) * off, tz + Math.sin(ang) * off, -Math.cos(ang), -Math.sin(ang), off + 1)
  }
  const e = entranceOf(s)
  const fx = Math.cos(e.heading), fz = -Math.sin(e.heading)
  const before = stats.fitsStops
  walkRun(s, d, e.x, e.z, fx, fz, Math.hypot(m.mouth[0] - e.x, m.mouth[1] - e.z) + 1.5)
  if (stats.fitsStops !== before) note('gate shut', s, e.x, e.z, 'stopped walking in from the entrance past the gate')
}

console.log(`\nwalls: sampling every ${EVERY}th of ${sites.length} labyrinths`)
let k = 0
for (let i = 0; i < sites.length; i += EVERY, k++) probeSite(sites[i], k)
check(stats.sites >= 20, 'enough labyrinths sampled', `${stats.sites}`)
check(stats.columns > 100000 && stats.blocked > 1000, 'the probes met walls', `${stats.columns} columns, ${stats.blocked} blocked, ${stats.floors} floors, ${stats.steps} steps, ${stats.fitsStops} stops, ${stats.inside} inside tests`)
for (const kind of ['crowded', 'invisible wall', 'invisible floor', 'invisible stop', 'walks through', 'gate shut']) {
  const f = flagged[kind] ?? { n: 0, shown: [] }
  check(f.n === 0, { crowded: 'no column holds more spans than the walker reads', 'invisible wall': 'every blocked column is a drawn solid\'s', 'invisible floor': 'every floor she stands on is a drawn top', 'invisible stop': 'every stop of a walk is at a drawn solid', 'walks through': 'she cannot stand inside a drawn solid', 'gate shut': 'the gate lets her in' }[kind], `${f.n}`)
  for (const r of f.shown) console.log(`         ${r}`)
}
console.log(`  worst gap past collision by kind: ${Object.entries(worst).map(([w, g]) => `${w} ${g.toFixed(3)}`).join(', ')}`)
console.log(failures === 0 ? '\nall labyrinth wall checks passed' : `\n${failures} labyrinth wall checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
