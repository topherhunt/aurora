// Node-side gates for the cave systems (src/v2/caves/, design/39-caves.md).
//
//   node scripts/check-caves.mjs
//
// Plans a spread of systems from fixed seeds and checks the promises: the same cave from the same seed, a way back to a mouth from everywhere (on the graph, then by walking the built walk surface), water where the sumps and pools say, and a mesh within budget. What this can NOT check: how dark or how lost it feels. That needs a headset.

import { planCave, EXIT_R } from '../src/v2/caves/build.js'
import { DROP_MIN } from '../src/v2/caves/graph.js'
import { CaveWalk } from '../src/v2/caves/walk.js'
import { chunkList, meshChunk, CHUNK, LODS, drawnLod, drawnRegions, chunkGap } from '../src/v2/caves/mesh.js'
import { Chalk, ChalkPen, encode, decode, valid, onRock, rayRock, ribbons, QUANT_M, STEP_M, STROKE_MAX, BATCH } from '../src/v2/caves/chalk.js'
import { groupSystems, caveEntries, CELLAR_LINK_M, MOUTH } from '../src/v2/caves/sites.js'
import { readFileSync } from 'node:fs'
import { SEED, SPAWN } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planWorld } from '../src/v2/layers/world-plan.js'
import { ROAD } from '../src/v2/layers/roads.js'
import { mouthBankFrom } from '../src/v2/render/entrances.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const MAX_TAN = Math.tan((50 * Math.PI) / 180)
const STEP = 0.25
const STRIDE = 1.5
// Her feet under the surface afloat.
const FLOAT = 1.32
// Cave wall triangles CaveRoom draws at once, wherever she stands.
const DRAWN_MAX = 80000
const SYSTEMS = [
  { seed: 11, entries: [{ x: 0, z: 0, dx: 1, dz: 0 }] },
  { seed: 12, entries: [{ x: 0, z: 0, dx: 0, dz: 1 }, { x: 90, z: 140, dx: -0.6, dz: -0.8 }] },
  { seed: 13, entries: [{ x: -60, z: 0, dx: 1, dz: 0 }, { x: 60, z: 10, dx: -1, dz: 0 }, { x: 0, z: 120, dx: 0, dz: -1 }] },
  { seed: 14, entries: [{ x: 0, z: 0, dx: 0.6, dz: 0.8 }] },
  { seed: 15, entries: [{ x: 0, z: 0, dx: -1, dz: 0 }, { x: -150, z: 90, dx: 0.8, dz: -0.6 }] },
  { seed: 16, entries: [{ x: 0, z: 0, dx: 0, dz: -1 }, { x: 100, z: 0, dx: 0, dz: -1 }, { x: 200, z: 0, dx: 0, dz: -1 }, { x: 100, z: -180, dx: 0, dz: 1 }] },
  // A cliff mouth and a cellar under a house.
  { seed: 17, entries: [{ x: 0, z: 0, dx: 1, dz: 0 }, { x: 140, z: 70, dx: 0.6, dz: -0.8, cellar: true }] },
]

for (const sys of SYSTEMS) {
  const tag = `system ${sys.seed} (${sys.entries.length} mouth${sys.entries.length > 1 ? 's' : ''})`
  const t0 = performance.now()
  const cave = planCave(sys)
  const planMs = performance.now() - t0
  const { graph, field, props, doors } = cave
  const again = planCave(sys)
  check(JSON.stringify(again.graph) === JSON.stringify(graph) && JSON.stringify(again.props) === JSON.stringify(props), `${tag}: the same seed plans the same graph and props`)

  // The graph: every node reaches a mouth over two-way edges and downhill drops.
  const back = graph.nodes.map(() => [])
  for (const e of graph.edges) {
    if (e.kind === 'drop') back[e.b].push(e.a)
    else { back[e.a].push(e.b); back[e.b].push(e.a) }
  }
  const out = new Set(graph.nodes.filter((n) => n.kind === 'mouth').map((n) => n.i))
  const queue = [...out]
  while (queue.length > 0) for (const j of back[queue.shift()]) if (!out.has(j)) { out.add(j); queue.push(j) }
  check(out.size === graph.nodes.length, `${tag}: every node reaches a mouth without climbing a drop`, `${graph.nodes.length - out.size} trapped`)
  const treeBad = graph.edges.filter((e) => e.tree && e.kind === 'drop')
  check(treeBad.length === 0, `${tag}: the spanning tree is all walks and sumps`)
  const drops = graph.edges.filter((e) => e.kind === 'drop')
  check(drops.every((e) => e.drop >= DROP_MIN), `${tag}: every drop is over her reach`, drops.map((e) => e.drop.toFixed(1)).join(' '))

  // The built surface: walk every two-way passage both ways along its line.
  const walk = new CaveWalk(field, graph, props.obstacles)
  const stuck = []
  let swum = 0
  const t1 = performance.now()
  let queries = 0
  for (const e of graph.edges) {
    if (e.kind === 'drop') continue
    for (const dir of [1, -1]) {
      const pts = dir > 0 ? e.pts : [...e.pts].reverse()
      let y = pts[0].y, surface = null
      let x = pts[0].x, z = pts[0].z
      for (let k = 1; k < pts.length && stuck.length < 20; k++) {
        const p = pts[k]
        const n = Math.ceil(Math.hypot(p.x - x, p.z - z) / STEP)
        const sx = (p.x - x) / n, sz = (p.z - z) / n
        for (let s = 0; s < n; s++) {
          x += sx; z += sz
          walk.hintY = y
          const h = walk.heightAt(x, z, y)
          queries++
          // Player._swim: afloat with her feet FLOAT under the surface (or the roof), she stands once the bed rises to her feet, and mantles onto a bank within her reach of her feet, or of the surface by half that.
          const water = walk.waterAt(x, z)
          if (water !== null && h < water - FLOAT) {
            swum++
            y = water - FLOAT
            surface = water
            continue
          }
          if (surface !== null && (water !== null || h <= Math.max(y + walk.reach, surface + 0.5 * walk.reach))) y = h
          surface = null
          // Player._walkable: a step too steep on its own passes if the ground a stride on is not.
          const rise = h - y
          const len = Math.hypot(sx, sz)
          const climbs = rise <= MAX_TAN * STEP || walk.heightAt(x + (sx / len) * (STRIDE - STEP), z + (sz / len) * (STRIDE - STEP), y) - y <= MAX_TAN * STRIDE
          const ok = climbs && walk.fits(x, z, h) && walk.obstacleAt(x, z, {}) === null
          if (!ok) { stuck.push(`edge ${e.i}${dir > 0 ? '+' : '-'} at (${x.toFixed(1)}, ${h.toFixed(1)}, ${z.toFixed(1)}) rise ${rise.toFixed(2)} fits ${walk.fits(x, z, h)}`); break }
          y = h
        }
      }
    }
  }
  const walkMs = performance.now() - t1
  check(stuck.length === 0, `${tag}: every walk and sump passes both ways on the built surface (${swum} steps swum)`, stuck.slice(0, 3).join('; '))
  check(walkMs / queries < 0.05, `${tag}: a walk step costs under 50 us`, `${((walkMs / queries) * 1000).toFixed(1)} us`)

  // The doors: arrival on dry floor with room to stand, and the exit within reach of it.
  for (const d of doors) {
    walk.hintY = d.y
    const ok = walk.fits(d.x, d.z, d.y) && walk.trueWaterAt(d.x, d.z, d.y + 1.6) === null && Math.hypot(d.x - d.mx, d.z - d.mz) > EXIT_R + 1
    check(ok, `${tag}: mouth ${doors.indexOf(d)} lands her standing and dry, clear of the exit`)
  }

  // Sunk to the world depth main.js builds caves at, every answer moves by oy and nothing else.
  const OY = -2000
  const deep = new CaveWalk(field, graph, props.obstacles, OY)
  const shifted = doors.every((d) => {
    walk.hintY = d.y
    deep.hintY = d.y + OY
    const w = walk.waterAt(d.x, d.z), dw = deep.waterAt(d.x, d.z)
    return Math.abs(deep.heightAt(d.x, d.z) - OY - walk.heightAt(d.x, d.z)) < 1e-6 && deep.fits(d.x, d.z, d.y + OY) === walk.fits(d.x, d.z, d.y) && (w === null ? dw === null : Math.abs(dw - OY - w) < 1e-6)
  })
  const o = props.obstacles[0]
  if (o !== undefined) deep.hintY = o.y0 + OY
  check(shifted && (o === undefined || deep.obstacleAt(o.x, o.z, {}) !== null),`${tag}: a cave sunk by oy answers floor, fit, water and obstacles shifted by oy`)

  // Water: every sump's dip is under water to the roof.
  for (const e of graph.edges.filter((q) => q.kind === 'sump')) {
    const mid = e.pts.reduce((a, b) => (b.y < a.y ? b : a))
    const level = walk.trueWaterAt(mid.x, mid.z, mid.y + 1)
    const roof = walk.ceilingAt(mid.x, mid.z, mid.y + 0.5)
    check(level !== null && roof < level, `${tag}: sump ${e.i} is flooded to the roof at its dip`, `level ${level === null ? 'none' : level.toFixed(1)} roof ${roof.toFixed(1)}`)
  }

  // The mesh: every chunk at every LOD, timed; then the triangles CaveRoom draws standing at each node, within a budget.
  const t2 = performance.now()
  let tris = 0
  const chunks = []
  for (const [i, j, k] of chunkList(field)) {
    const c = { x: (i + 0.5) * CHUNK, y: (j + 0.5) * CHUNK, z: (k + 0.5) * CHUNK, lods: LODS.map(() => null) }
    LODS.forEach(({ voxel }, lod) => {
      const m = meshChunk(field, i, j, k, cave.lights, voxel)
      if (m === null) return
      c.lods[lod] = new Map()
      for (let p = 0; p < m.parts.length; p += 3) c.lods[lod].set(m.parts[p], m.parts[p + 2] / 3)
      if (lod === 0) tris += m.index.length / 3
    })
    chunks.push(c)
  }
  const meshMs = performance.now() - t2
  let worst = 0, at = -1
  for (const n of graph.nodes) {
    const shown = drawnRegions(graph, n.region)
    let drawn = 0
    for (const c of chunks) {
      const d = chunkGap(c, n.x, n.y + 1.6, n.z)
      const lod = drawnLod(c.lods, d)
      if (lod < 0) continue
      for (const [r, t] of c.lods[lod]) if (shown.has(r)) drawn += t
    }
    if (drawn > worst) { worst = drawn; at = n.i }
  }
  check(worst < DRAWN_MAX, `${tag}: under ${DRAWN_MAX / 1000}k triangles drawn from any node`, `${(worst / 1000).toFixed(0)}k at node ${at}, ${(tris / 1000).toFixed(0)}k near-LOD in ${chunks.length} chunks, plan ${planMs.toFixed(0)} ms, mesh ${(meshMs / 1000).toFixed(1)} s`)
  const kinds = {}
  for (const n of graph.nodes) kinds[n.kind] = (kinds[n.kind] || 0) + 1
  console.log(`       ${JSON.stringify(kinds)} edges ${graph.edges.length} (${drops.length} drops, ${graph.edges.filter((q) => q.kind === 'sump').length} sumps, ${graph.rivers.length} rivers) pools ${graph.pools.length} regions ${graph.regions.length} depth ${Math.min(...graph.nodes.map((n) => n.y)).toFixed(0)} m; props mites ${props.mites.length} tites ${props.tites.length} mush ${props.mush.length} ruins ${props.ruins.length} chalk ${props.chalk.length} lights ${cave.lights.length}`)
}

// Chalk: the codec, the store, the pen, and the ribbon on real rock.
{
  const cave = planCave(SYSTEMS[0])
  const d = cave.doors[0]
  const pts = []
  for (let i = 0; i < 40; i++) pts.push(d.x + 400 + i * 0.03, d.y + 1 + Math.sin(i) * 0.1, d.z - 300)
  const b64 = encode(pts, 5, -7)
  const back = decode(b64, 5, -7)
  check(back.length === pts.length && pts.every((v, i) => Math.abs(back[i] - v) <= QUANT_M / 2 + 1e-4), `chalk: a stroke decodes within half a quantum`, `${b64.length} chars for ${pts.length / 3} points`)
  let threw = false
  try { encode([700, 0, 0], 0, 0) } catch { threw = true }
  check(threw, 'chalk: a point beyond int16 of the centre throws rather than wraps')

  const me = 'abcdef123456'
  const a = new Chalk(() => me), b = new Chalk(() => 'zzzzzz999999')
  const t = a.draw(77, pts, 0, 0)
  check(valid(t) && a.rev(77) === 1 && a.strokes(77, 0, 0).length === 1, 'chalk: her stroke is valid and counted')
  const sent = []
  a.flush((batch) => { sent.push(...batch); return true })
  b.merge(sent)
  b.merge(sent)
  check(b.strokes(77, 0, 0).length === 1 && b.rev(77) === 1 && a.unsent.length === 0, 'chalk: a peer learns a stroke once, however often it is told')
  b.draw(77, pts.slice(0, 6), 0, 0)
  const saved = JSON.parse(JSON.stringify(b.save()))
  const c = new Chalk(() => 'zzzzzz999999')
  c.load(saved)
  check(saved.mine.length === 1 && c.strokes(77, 0, 0).length === 1 && c.unsent.length === 1 && c.next === 1, 'chalk: a save keeps only her strokes, owed to the room again on load')
  for (let i = 0; i < BATCH + 3; i++) a.draw(78, pts.slice(0, 3), 0, 0)
  a.resend()
  const batches = []
  a.flush((batch) => { batches.push(batch.length); return true })
  a.flush(() => false)
  a.flush((batch) => { batches.push(batch.length); return true })
  check(batches.join() === `${BATCH},4` && a.unsent.length === 0, 'chalk: a resend trickles out a batch a flush, and a refused flush keeps the batch', batches.join())
  a.clear()
  check(a.rev(77) > 1 && a.strokes(77, 0, 0).length === 0 && a.next === 0, 'chalk: a new game rubs out her strokes')

  const got = []
  const pen = new ChalkPen((p) => got.push(p))
  for (let i = 0; i <= 100; i++) pen.touch(i * 0.01, 0, 0)
  pen.touch(5, 0, 0)
  pen.touch(5, 0.2, 0)
  pen.lift()
  const gaps = got[0].length === 0 ? [] : Array.from({ length: got[0].length / 3 - 1 }, (_, i) => got[0][i * 3 + 3] - got[0][i * 3])
  check(got.length === 2 && gaps.every((g) => Math.abs(g - STEP_M) < 1e-6) && got[1].length / 3 === 1 + Math.floor(0.2 / STEP_M), 'chalk: the pen resamples every STEP_M and a jump starts a new stroke', `${got.length} strokes`)
  const long = []
  const pen2 = new ChalkPen((p) => long.push(p))
  for (let i = 0; i < STROKE_MAX * 3; i++) pen2.touch(i * STEP_M, 0, 0)
  pen2.lift()
  check(long.every((p) => p.length <= STROKE_MAX * 3) && long.every((p) => valid([1, 0, me, encode(p, 0, 0)])), 'chalk: a long line splits into strokes the relay takes', `${long.length} strokes`)

  // On rock: a point a hand-width off the wall by the door lands on it, and the ribbon stands off it.
  const out = [0, 0, 0]
  let wall = null
  for (let k = 0; k < 64 && wall === null; k++) {
    const a = (k / 64) * Math.PI * 2
    if (rayRock(cave.field, d.x, d.y + 1.2, d.z, Math.cos(a), 0, Math.sin(a), 6, out)) wall = [...out, Math.cos(a), Math.sin(a)]
  }
  const near = wall !== null && onRock(cave.field, wall[0] - wall[3] * 0.02, wall[1], wall[2] - wall[4] * 0.02, 0.05, out)
  check(wall !== null && Math.abs(cave.field.at(wall[0], wall[1], wall[2])) < 0.01 && near && Math.abs(cave.field.at(...out)) < 0.005, 'chalk: a ray from the door meets the wall, and a pen 2 cm off it lands on the rock', wall === null ? 'no wall' : `field ${cave.field.at(...out).toFixed(4)}`)
  // The wall is lumpy, so a point 3 cm up it is put back on the rock as a pen would.
  const up = [0, 0, 0]
  if (wall !== null) onRock(cave.field, wall[0], wall[1] + 0.03, wall[2], 0.05, up)
  const stroke = new Float32Array(wall === null ? [0, 0, 0] : [wall[0], wall[1], wall[2], ...up])
  const r = ribbons([stroke, stroke.slice(0, 3)], cave.field)
  let off = true
  for (let i = 0; i < r.position.length; i += 3) off &&= cave.field.at(r.position[i], r.position[i + 1], r.position[i + 2]) < -0.002
  check(r.index.length === 12 && r.index.every((i) => i < r.position.length / 3) && off, 'chalk: a stroke and a dab ribbon off the rock on its air side')
}

{
  // design/39-caves.md §2: cellars joining the systems leave the cliff systems' ids, seeds and centres (chalk's keys) as they were, and each lands in one system near enough its centre for chalk to pack.
  const mouths = () => Array.from({ length: 12 }, (_, k) => ({ id: k, x: (k % 4) * 300, z: Math.floor(k / 4) * 280, nx: 1, nz: 0 }))
  const cellars = Array.from({ length: 40 }, (_, k) => ({ id: k, t: k, i: 0, x: ((k * 137) % 1100) - 50, z: ((k * 89) % 700) - 50, dx: 0, dz: 1 }))
  const bare = groupSystems(mouths(), 99), full = groupSystems(mouths(), 99, cellars)
  const same = bare.every((s, k) => full[k].seed === s.seed && full[k].cx === s.cx && full[k].cz === s.cz && JSON.stringify(full[k].mouths) === JSON.stringify(s.mouths))
  const homes = cellars.map((c) => full.filter((s) => s.cellars.includes(c.id)))
  const far = cellars.filter((c, k) => homes[k].length === 1 && Math.hypot(homes[k][0].cx - c.x, homes[k][0].cz - c.z) > CELLAR_LINK_M).length
  const joined = cellars.filter((c, k) => homes[k].length === 1 && homes[k][0].mouths.length > 0).length
  check(same && homes.every((h) => h.length === 1 && h[0].id === cellars[homes.indexOf(h)].system) && far === 0 && joined > 0 && joined < cellars.length, 'cellars join the systems without moving a cliff system, each in one near its centre', `${joined} of ${cellars.length} share a cliff system`)
  const e = caveEntries(full.find((s) => s.mouths.length > 0 && s.cellars.length > 0), mouths(), cellars)
  check(e.findIndex((q) => q.cellar) === e.filter((q) => !q.cellar).length, "a system's doors are its mouths, then its cellars")
}

{
  // design/39-caves.md §2 on the shipped world, as the game lays it: every mouth's notch levels the floor under its arch and stands a wall behind it, a trail runs from it to the roads, and no system outgrows chalk.
  const root = new URL('../public/world/', import.meta.url)
  const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
  const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
  const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
  field.setLayers(layers)
  const { roadPlan, mouths, trailPlan } = planWorld({ heightmap: hm, ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, spawn: SPAWN })
  layers.setClefts(mouths.map((m) => [m.x, m.z, m.nx, m.nz, m.y]))
  const bank = mouthBankFrom(readShippedLadder('cave-mouth'))
  const half = (bank.width * MOUTH.scale) / 2, depth = bank.depth * MOUTH.scale
  check(half + 0.5 <= MOUTH.floorW && depth + 1 <= MOUTH.floorOut, 'the arch stands inside its notch with room to walk round it', `arch ${(half * 2).toFixed(1)} m across and ${depth.toFixed(1)} m out, floor ${MOUTH.floorW * 2} by ${MOUTH.floorOut} m`)
  let rough = 0, low = 0, worstFloor = 0, worstWall = Infinity, grown = 0, fenced = 0
  for (const m of mouths) {
    const at = (s, t) => field.heightAt(m.x - m.nx * s + m.nz * t, m.z - m.nz * s - m.nx * t) - m.y
    const keeps = (s, t, pad) => layers.clefts.occupiesAt(m.x - m.nx * s + m.nz * t, m.z - m.nz * s - m.nx * t, pad)
    for (let s = MOUTH.wall - 10.5; s <= MOUTH.wall; s += 0.5) for (const t of [-half, 0, half]) if (!keeps(s, t, 0.3)) grown++
    if (keeps(-30, 0, 0.3) && !mouths.some((o) => o !== m && Math.hypot(o.x - m.x - m.nx * 30, o.z - m.z - m.nz * 30) < 30)) fenced++
    let off = 0, top = Infinity
    for (let s = MOUTH.wall - depth - 0.5; s <= MOUTH.wall + 0.4; s += 0.25) for (let t = -half - 0.3; t <= half + 0.3; t += 0.25) off = Math.max(off, Math.abs(at(s, t) + 0.05))
    for (let s = MOUTH.wall + 1.2; s <= MOUTH.wall + 3; s += 0.25) for (let t = -half - 0.5; t <= half + 0.5; t += 0.25) top = Math.min(top, at(s, t))
    if (off > 0.02) rough++
    if (top < 4) low++
    worstFloor = Math.max(worstFloor, off)
    worstWall = Math.min(worstWall, top)
  }
  check(mouths.length >= 100 && rough === 0 && low === 0, "every mouth's notch is level under its arch with a wall behind it", `${mouths.length} mouths, floor within ${worstFloor.toFixed(3)} m, wall at least ${worstWall.toFixed(1)} m`)
  check(grown === 0 && fenced === 0, 'trees and rocks keep off every notch and the approach to its arch, and no further', `${grown} spots refused nothing, ${fenced} mouths kept clear 30 m out`)
  // Trails: one per mouth, from its floor to a road or another trail, half a road wide, and no signpost by where it joins.
  const distTo = (pts, x, z) => {
    let best = Infinity
    for (let k = 1; k < pts.length; k++) {
      const [ax, , az] = pts[k - 1], [bx, , bz] = pts[k]
      const vx = bx - ax, vz = bz - az
      const f = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)))
      best = Math.min(best, Math.hypot(ax + vx * f - x, az + vz * f - z))
    }
    return best
  }
  const byId = new Map(trailPlan.records.map((r) => [r.id, r]))
  let loose = 0, signed = 0, wrong = 0, steep = 0
  for (const t of trailPlan.trails) {
    const m = mouths[t.mouth], pts = byId.get(t.record).pts
    const [x0, y0, z0] = pts[0]
    if (Math.hypot(x0 - m.x + m.nx * (MOUTH.wall - 0.5), z0 - m.z + m.nz * (MOUTH.wall - 0.5)) > 1e-6 || y0 !== m.y || pts.some((p) => p[3] !== ROAD.width / 2)) wrong++
    const [x1, , z1] = pts.at(-1)
    const lines = t.onto === 'road' ? roadPlan.ways.filter((w) => w.crossing < 0).map((w) => w.pts) : [byId.get(t.onto).pts]
    if (Math.min(...lines.map((l) => distTo(l, x1, z1))) > 0.01) loose++
    if (roadPlan.signs.some((g) => Math.hypot(g.x - x1, g.z - z1) < 20)) signed++
    for (let k = 1; k < pts.length; k++) steep = Math.max(steep, Math.abs(pts[k][1] - pts[k - 1][1]) / Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][2] - pts[k - 1][2]))
  }
  const lengths = trailPlan.trails.map((t) => t.length).sort((a, b) => a - b)
  check(trailPlan.failed.length === 0 && trailPlan.trails.length === mouths.length && wrong === 0 && steep < MAX_TAN, "a walkable trail half a road wide runs out from every mouth's floor", `${trailPlan.trails.length} trails, median ${lengths[lengths.length >> 1].toFixed(0)} m, longest ${lengths.at(-1).toFixed(0)} m, steepest pitch ${steep.toFixed(2)}`)
  check(loose === 0 && signed === 0, 'every trail ends on a road or another trail, with no signpost by the join', `${trailPlan.trails.filter((t) => t.onto !== 'road').length} join another trail`)
  const systems = groupSystems(mouths, SEED)
  const span = Math.max(...systems.map((s) => Math.max(...s.mouths.map((i) => Math.hypot(mouths[i].x - s.cx, mouths[i].z - s.cz)))))
  const biggest = Math.max(...systems.map((s) => s.mouths.length))
  check(span < 600, "a system's mouths stay inside chalk's ±655 m reach of its centre", `${systems.length} systems, the largest ${biggest} mouths, the furthest ${span.toFixed(0)} m out`)
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nall cave checks passed')
