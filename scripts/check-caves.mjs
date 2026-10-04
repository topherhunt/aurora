// Node-side gates for the cave systems (src/v2/caves/, design/39-caves.md).
//
//   node scripts/check-caves.mjs
//
// Plans a spread of systems from fixed seeds and checks the promises: the same cave from the same seed, a way back to a mouth from everywhere (on the graph, then by walking the built walk surface), water where the sumps and pools say, and a mesh within budget. What this can NOT check: how dark or how lost it feels. That needs a headset.

import { planCave, EXIT_R } from '../src/v2/caves/build.js'
import { DROP_MIN } from '../src/v2/caves/graph.js'
import { CaveWalk } from '../src/v2/caves/walk.js'
import { chunkList, meshChunk } from '../src/v2/caves/mesh.js'
import { Chalk, ChalkPen, encode, decode, valid, onRock, rayRock, ribbons, QUANT_M, STEP_M, STROKE_MAX, BATCH } from '../src/v2/caves/chalk.js'

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
const SYSTEMS = [
  { seed: 11, entries: [{ x: 0, z: 0, dx: 1, dz: 0 }] },
  { seed: 12, entries: [{ x: 0, z: 0, dx: 0, dz: 1 }, { x: 90, z: 140, dx: -0.6, dz: -0.8 }] },
  { seed: 13, entries: [{ x: -60, z: 0, dx: 1, dz: 0 }, { x: 60, z: 10, dx: -1, dz: 0 }, { x: 0, z: 120, dx: 0, dz: -1 }] },
  { seed: 14, entries: [{ x: 0, z: 0, dx: 0.6, dz: 0.8 }] },
  { seed: 15, entries: [{ x: 0, z: 0, dx: -1, dz: 0 }, { x: -150, z: 90, dx: 0.8, dz: -0.6 }] },
  { seed: 16, entries: [{ x: 0, z: 0, dx: 0, dz: -1 }, { x: 100, z: 0, dx: 0, dz: -1 }, { x: 200, z: 0, dx: 0, dz: -1 }, { x: 100, z: -180, dx: 0, dz: 1 }] },
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

  // The mesh: every chunk, timed, within a triangle budget.
  const t2 = performance.now()
  let tris = 0, built = 0
  for (const [i, j, k] of chunkList(field)) {
    const m = meshChunk(field, i, j, k, cave.lights)
    if (m === null) continue
    built++
    tris += m.index.length / 3
  }
  const meshMs = performance.now() - t2
  check(tris < 450000 * sys.entries.length, `${tag}: under 450k triangles a mouth`, `${(tris / 1000).toFixed(0)}k in ${built} chunks, plan ${planMs.toFixed(0)} ms, mesh ${(meshMs / 1000).toFixed(1)} s`)
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
  const stroke = new Float32Array(wall === null ? [0, 0, 0] : [wall[0], wall[1], wall[2], wall[0], wall[1] + 0.03, wall[2]])
  const r = ribbons([stroke, stroke.slice(0, 3)], cave.field)
  let off = true
  for (let i = 0; i < r.position.length; i += 3) off &&= cave.field.at(r.position[i], r.position[i + 1], r.position[i + 2]) < -0.002
  check(r.index.length === 12 && r.index.every((i) => i < r.position.length / 3) && off, 'chalk: a stroke and a dab ribbon off the rock on its air side')
}

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nall cave checks passed')
