// Node-side gates for the cave systems (src/v2/caves/, design/39-caves.md).
//
//   node scripts/check-caves.mjs
//
// Plans a spread of systems from fixed seeds and checks the promises: the same cave from the same seed, a way back to a mouth from everywhere (on the graph, then by walking the built walk surface), water where the sumps and pools say, and a mesh within budget. What this can NOT check: how dark or how lost it feels. That needs a headset.

import { planCave, EXIT_R } from '../src/v2/caves/build.js'
import { DROP_MIN, reliefAt, buildGraph } from '../src/v2/caves/graph.js'
import { columnAt, MUSH_FOOT } from '../src/v2/caves/props.js'
import { CaveWalk } from '../src/v2/caves/walk.js'
import { WalkSurface } from '../src/v2/walk.js'
import { chunkList, meshChunk, drawnSurface, CHUNK, LODS, drawnLod, drawnRegions, chunkGap } from '../src/v2/caves/mesh.js'
import { mulberry32 } from '../src/sim/mathx.js'
import { Surface } from '../src/v2/caves/surface.js'
import { Chalk, ChalkPen, encode, decode, valid, onRock, rayRock, ribbons, QUANT_M, STEP_M, STROKE_MAX, BATCH } from '../src/v2/caves/chalk.js'
import { groupSystems, caveEntries, CELLAR_LINK_M, MOUTH } from '../src/v2/caves/sites.js'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { LOCOMOTION, Player } from '../src/player.js'
import { SEED, SPAWN } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planWorld } from '../src/v2/layers/world-plan.js'
import { ROAD } from '../src/v2/layers/roads.js'
import { mouthBankFrom } from '../src/v2/render/entrances.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import { Fish } from '../src/v2/render/fish.js'

const FISH_ASSETS = JSON.parse(readFileSync(new URL('../public/fauna/fish.json', import.meta.url), 'utf8'))

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// A chunk's seam vertices (those in the half-metre band outside its low faces or inside its high ones), sorted, as one string.
function seamOf(position, ox, oy, oz) {
  const out = []
  const o = [ox, oy, oz]
  for (let v = 0; v < position.length; v += 3) {
    if ([0, 1, 2].some((a) => position[v + a] < o[a] || position[v + a] > o[a] + CHUNK - LODS[0].voxel)) out.push(`${position[v]},${position[v + 1]},${position[v + 2]}`)
  }
  return out.sort().join(';')
}

// Structural equality over plain objects, arrays and typed arrays (a planned graph is too big to compare as JSON).
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b)
  if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && a.length === b.length && a.every((v, i) => v === b[i])
  const ka = Object.keys(a), kb = Object.keys(b)
  return Array.isArray(a) === Array.isArray(b) && ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
}

const MAX_TAN = Math.tan((50 * Math.PI) / 180)
const STEP = 0.25
const STRIDE = 1.5
// Her feet under the surface afloat.
const FLOAT = 1.32
// Cave wall triangles CaveRoom draws at once, wherever she stands.
const DRAWN_MAX = 120000
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

{
  const dead = []
  for (let seed = 1; seed <= 60; seed++) {
    const g = buildGraph({ seed, entries: [{ x: 0, z: 0, dx: 1, dz: 0 }].concat(seed % 3 ? [{ x: 120, z: 60, dx: -1, dz: 0 }] : []) })
    for (const n of g.nodes.filter((q) => q.great)) if (g.edges.filter((e) => e.a === n.i || e.b === n.i).length < 2) dead.push(`seed ${seed} node ${n.i}`)
  }
  check(dead.length === 0, 'over 60 seeds, every great cavern has at least two passages', dead.slice(0, 3).join('; '))
}

for (const sys of SYSTEMS) {
  const tag = `system ${sys.seed} (${sys.entries.length} mouth${sys.entries.length > 1 ? 's' : ''})`
  const t0 = performance.now()
  const cave = planCave(sys)
  const planMs = performance.now() - t0
  const { graph, field, props, doors } = cave
  const again = planCave(sys)
  check(deepEqual(again.graph, graph) && deepEqual(again.props, props), `${tag}: the same seed plans the same graph and props`)

  // The graph: every node reaches a mouth over two-way edges and downhill drops, none of them choked by a rockfall.
  const back = graph.nodes.map(() => [])
  for (const e of graph.edges) {
    if (e.choke !== null) continue
    if (e.kind === 'drop') back[e.b].push(e.a)
    else { back[e.a].push(e.b); back[e.b].push(e.a) }
  }
  const out = new Set(graph.nodes.filter((n) => n.kind === 'mouth').map((n) => n.i))
  const queue = [...out]
  while (queue.length > 0) for (const j of back[queue.shift()]) if (!out.has(j)) { out.add(j); queue.push(j) }
  check(out.size === graph.nodes.length, `${tag}: every node reaches a mouth without climbing a drop`, `${graph.nodes.length - out.size} trapped`)
  const treeBad = graph.edges.filter((e) => e.tree && e.kind === 'drop')
  check(treeBad.length === 0, `${tag}: the spanning tree is all walks and sumps`)
  const chokes = graph.edges.filter((e) => e.choke !== null)
  check(chokes.every((e) => !e.tree && e.kind === 'walk'), `${tag}: only braid walks are choked`, `${chokes.length} chokes`)
  const drops = graph.edges.filter((e) => e.kind === 'drop')
  check(drops.every((e) => e.drop >= DROP_MIN), `${tag}: every drop is over her reach`, drops.map((e) => e.drop.toFixed(1)).join(' '))

  // The built surface: walk every two-way passage both ways along its line; a choked one must stop her.
  const walk = new CaveWalk(field, graph, props.obstacles)
  const stuck = [], unchoked = []
  let swum = 0
  const t1 = performance.now()
  let queries = 0
  for (const e of graph.edges) {
    if (e.kind === 'drop') continue
    for (const dir of [1, -1]) {
      const pts = dir > 0 ? e.pts : [...e.pts].reverse()
      let y = pts[0].y, surface = null
      let x = pts[0].x, z = pts[0].z, jam = null
      for (let k = 1; k < pts.length && jam === null; k++) {
        const p = pts[k]
        const n = Math.ceil(Math.hypot(p.x - x, p.z - z) / STEP)
        const sx = (p.x - x) / n, sz = (p.z - z) / n
        for (let s = 0; s < n; s++) {
          x += sx; z += sz
          // A drowned passage is dived (swimDiveDeg): under water she follows its line, needing a swimmer's room over any bed that rises to it.
          const py = pts[k - 1].y + ((p.y - pts[k - 1].y) * (s + 1)) / n
          if (e.kind === 'drowned' && walk.trueWaterAt(x, z, py + 1) !== null) {
            const bed = walk.heightAt(x, z, py + 1)
            queries++
            if (bed - py > walk.reach || walk.ceilingAt(x, z, bed + 0.3) - bed < 1) { jam = `edge ${e.i}${dir > 0 ? '+' : '-'} dive at (${x.toFixed(1)}, ${bed.toFixed(1)}, ${z.toFixed(1)})`; break }
            swum++
            y = bed
            continue
          }
          walk.hintY = y
          const h = walk.heightAt(x, z, y)
          queries++
          // Player._swim: afloat with her feet FLOAT under the surface (or the roof), she stands once the bed rises to her feet, and mantles onto a bank within her reach of her feet, or of the surface by half that.
          const water = walk.waterAt(x, z)
          if (water !== null && h < water - FLOAT) {
            if (walk.obstacleAt(x, z, {}) !== null) { jam = `edge ${e.i}${dir > 0 ? '+' : '-'} swims into an obstacle at (${x.toFixed(1)}, ${z.toFixed(1)})`; break }
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
          if (!ok) { jam = `edge ${e.i}${dir > 0 ? '+' : '-'} at (${x.toFixed(1)}, ${h.toFixed(1)}, ${z.toFixed(1)}) rise ${rise.toFixed(2)} fits ${walk.fits(x, z, h)}`; break }
          y = h
        }
      }
      if (e.choke === null && jam !== null) stuck.push(jam)
      if (e.choke !== null && jam === null) unchoked.push(`edge ${e.i}${dir > 0 ? '+' : '-'}`)
    }
  }
  const walkMs = performance.now() - t1
  check(stuck.length === 0, `${tag}: every walk and sump passes both ways on the built surface (${swum} steps swum)`, stuck.slice(0, 3).join('; '))
  check(unchoked.length === 0, `${tag}: every rockfall stops her both ways`, unchoked.join(' '))
  check(walkMs / queries < 0.05, `${tag}: a walk step costs under 50 us`, `${((walkMs / queries) * 1000).toFixed(1)} us`)

  // The doors: arrival on dry floor with room to stand, and the exit within reach of it.
  for (const d of doors) {
    walk.hintY = d.y
    const ok = walk.fits(d.x, d.z, d.y) && walk.trueWaterAt(d.x, d.z, d.y + 1.6) === null && Math.hypot(d.x - d.mx, d.z - d.mz) > EXIT_R + 1
    check(ok, `${tag}: mouth ${doors.indexOf(d)} lands her standing and dry, clear of the exit`)
    if (!d.cellar) continue
    // Walking straight at a cellar's door from its arrival she stops in front of its face, within main.js HOUSE_DOOR.walk (0.5 m) of it.
    let gap = Infinity
    for (let s = 0; s < 8; s += 0.02) {
      const x = d.x - d.dx * s, z = d.z - d.dz * s, h = walk.heightAt(x, z, d.y + 0.5)
      if (!walk.fits(x, z, h) || walk.obstacleAt(x, z, {}) !== null) break
      gap = (x - d.mx) * d.dx + (z - d.mz) * d.dz
    }
    check(gap > 0 && gap <= 0.5, `${tag}: walking at cellar ${doors.indexOf(d)}'s door she stops at its face, near enough to touch it`, `${gap.toFixed(2)} m in front of it`)
  }

  // Flight in a cave is a steady flyLowSpeed. In rock heightAt answers its WALL sentinel, a kilometre over her: read as a floor it threw her up there in a frame.
  {
    const d = doors[0]
    walk.hintY = d.y
    const rig = new THREE.Group(), camera = new THREE.PerspectiveCamera()
    rig.add(camera)
    const player = new Player(rig, camera, walk)
    player.spawnAt(d.x, d.z)
    player.setFlying(true)
    const o = player.originPosition(), up = o.clone()
    up.y += 50
    const low = player.flySpeedAt(o), high = player.flySpeedAt(up)
    check(low === LOCOMOTION.flyLowSpeed && high === low, `${tag}: she flies at flyLowSpeed by a cave floor and 50 m over it`, `${low.toFixed(0)} vs ${high.toFixed(0)} m/s`)
    const y0 = rig.position.y
    for (let f = 0; f < 144; f++) {
      walk.hintY = player.originPosition().y
      player.update(1 / 72, { move: 0, strafe: 0, lift: 1, turn: 0, unstick: false, instant: true })
      rig.updateMatrixWorld(true)
    }
    const rise = rig.position.y - y0
    // Plus her takeoff, which seats her a flight clearance over the floor.
    check(rise <= 2 * LOCOMOTION.flyLowSpeed + 2.5, `${tag}: two seconds of lift from a door climb no more than two seconds at that speed and her takeoff`, `${rise.toFixed(1)} m`)
  }

  const drowned = props.mush.filter((m) => { const l = walk.trueWaterAt(m.x, m.z, m.y); return l !== null && m.y < l })
  check(drowned.length === 0, `${tag}: no mushroom grows under water`, `${drowned.length} drowned`)
  // A floor mushroom's whole base disc, tilted with it, is on or in the rock: no edge of its stem stands over air.
  let floating = 0, worstGap = 0, tilted = 0
  const floorMush = props.mush.filter((m) => m.up[1] > 0.9)
  for (const m of floorMush) {
    const u = new THREE.Vector3(...m.up).normalize(), t1 = new THREE.Vector3(1, 0, 0).cross(u).normalize(), t2 = u.clone().cross(t1)
    if (u.y < 0.999) tilted++
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2, R = MUSH_FOOT * m.h
      const gap = -field.at(m.x + R * (Math.cos(a) * t1.x + Math.sin(a) * t2.x), m.y + R * (Math.cos(a) * t1.y + Math.sin(a) * t2.y), m.z + R * (Math.cos(a) * t1.z + Math.sin(a) * t2.z))
      worstGap = Math.max(worstGap, gap)
      if (gap > 0.06) { floating++; break }
    }
  }
  check(floating === 0 && tilted > 0, `${tag}: every floor mushroom's base is planted in the rock, tilted with its slope`, `${floating} of ${floorMush.length} float, worst ${worstGap.toFixed(2)} m, ${tilted} tilted`)
  // No dripstone reaches past 55% of its floor to roof, and each giant one has a giant stalactite over it.
  let tallMites = 0, bare = 0, giants = 0
  for (const t of props.mites) {
    const col = columnAt(field, t.x, t.z, t.y + 0.5)
    if (col !== null && t.len > 0.55 * (col.roof - col.floor) + 0.2) tallMites++
    if (t.len < 6) continue
    giants++
    if (!props.tites.some((q) => Math.hypot(q.x - t.x, q.z - t.z) < 0.1 && q.len > 0.5 * t.len)) bare++
  }
  check(tallMites === 0 && bare === 0, `${tag}: no stalagmite stands past 55% of its room, and every giant one has its stalactite`, `${tallMites} too tall, ${bare} of ${giants} giants bare`)
  // A great cavern's hills run on up its wall: its relief stands metres high somewhere on its rim.
  for (const n of graph.nodes.filter((q) => q.great)) {
    let rim = 0
    for (let a = 0; a < 6.28; a += 0.05) {
      const lx = Math.cos(a) * n.rx, lz = Math.sin(a) * n.rz
      rim = Math.max(rim, reliefAt(n, n.x + lx * Math.cos(n.rot) - lz * Math.sin(n.rot), n.z + lx * Math.sin(n.rot) + lz * Math.cos(n.rot)))
    }
    check(rim > 2, `${tag}: great cavern ${n.i}'s hills reach its wall`, `${rim.toFixed(1)} m of relief at its rim`)
  }
  const forms = new Set(field.prims.filter((p) => !p.node).map((p) => (p.form === null ? 'plain' : `${p.form.fw > 1.2 ? 'wide' : p.form.tube ? 'tube' : p.form.crumple > 0 ? 'crumpled' : 'tall'}`)))
  check(forms.size >= 4, `${tag}: its passages come in at least four cross-sections`, [...forms].join(', '))
  // The drip is placed on water itself, not on the dry corner of a pool's box.
  const dry = walk.waters.filter((b) => b.kind !== 'river').filter((b) => { const q = walk.nearestWater(b.x0, b.level + 1, b.z0, 10, {}); return q !== null && walk.trueWaterAt(q.x, q.z, q.y) === null })
  check(dry.length === 0, `${tag}: nearestWater from a pool's box corner lands on its water`, `${dry.length} on dry ground`)

  // main.js asks the ground under her whichever it is: a query WalkSurface answers that CaveWalk lacks is a TypeError the first time she aims a teleport underground.
  const walkQueries = (C) => Object.getOwnPropertyNames(C.prototype).filter((k) => !['constructor', 'setScale', 'setWater', 'addStone', 'addBody', 'removeBody'].includes(k))
  const missing = walkQueries(WalkSurface).filter((k) => typeof walk[k] !== 'function')
  check(missing.length === 0 && walk.stairAt(doors[0].x, doors[0].y, doors[0].z) === null, `${tag}: the cave walk answers every WalkSurface query, with no stairs`, missing.join(', '))

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

  // The fish as main.js aims them: placed from the door's height, yet each pool a fish fits in (some site clear of its shore) is stocked.
  const pools = deep.fishWorld()
  const fish = new Fish(new THREE.Scene(), pools.bed, pools.water, { seed: sys.seed, assets: FISH_ASSETS })
  fish.setSpots(pools.spots)
  deep.hintY = doors[0].y + OY
  const stockable = deep.waters.filter((b) => b.kind !== 'river').map((b) => ({ b, mine: pools.spots.filter(([x, z]) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.levelAt(x, z) !== null) }))
    .filter(({ mine }) => fish.species.some((sp) => mine.some(([x, z]) => fish.site(sp, x, z, sp.cfg.clearance) !== null)))
  const unstocked = stockable.filter(({ b, mine }) => {
    // Swimming over its deepest spot: a body's box can be far wider than its water.
    const [x, z] = mine.reduce((a, s) => (s[2] > a[2] ? s : a))
    fish.place(x, z)
    return !fish.species.some((sp) => sp.schools.some((s) => b.levelAt(s.home.x, s.home.z) !== null))
  })
  check(unstocked.length <= Math.max(1, stockable.length / 10), `${tag}: fish placed from the door stock all but one, or nine in ten, of the pools they fit`, `${unstocked.length} of ${stockable.length} empty: ${unstocked.map(({ b }) => b.node ?? `sump ${b.edge}`).join(' ')}`)

  // Water: every sump's dip is under water to the roof.
  for (const e of graph.edges.filter((q) => q.kind === 'sump')) {
    const mid = e.pts.reduce((a, b) => (b.y < a.y ? b : a))
    const level = walk.trueWaterAt(mid.x, mid.z, mid.y + 1)
    const roof = walk.ceilingAt(mid.x, mid.z, mid.y + 0.5)
    check(level !== null && roof < level, `${tag}: sump ${e.i} is flooded to the roof at its dip`, `level ${level === null ? 'none' : level.toFixed(1)} roof ${roof.toFixed(1)}`)
    if (level === null) continue
    // The ambience's drip (RULES.caveDrip) is placed by nearestWater, in the sunk cave's world heights.
    const near = deep.nearestWater(mid.x, level + OY + 3, mid.z, 15, {})
    const far = deep.nearestWater(mid.x, level + OY + 3, mid.z, 2, {})
    check(near !== null && Math.abs(Math.hypot(near.x - mid.x, near.y - level - OY - 3, near.z - mid.z) - 3) < 0.01 && far === null, `${tag}: 3 m over sump ${e.i}'s water, nearestWater finds it 3 m off, and nothing within 2 m`, near === null ? 'none' : `${near.x.toFixed(1)},${near.y.toFixed(1)},${near.z.toFixed(1)}`)
  }

  // Every drowned passage is its pool's water to the roof where it leaves the cavern's rim.
  for (const e of graph.edges.filter((q) => q.kind === 'drowned')) {
    const q = e.pts.filter((p) => p.y === e.pts[0].y).pop()
    const level = walk.trueWaterAt(q.x, q.z, q.y + 1)
    const roof = walk.ceilingAt(q.x, q.z, q.y + 0.5)
    check(level !== null && roof < level, `${tag}: drowned passage ${e.i} is flooded to the roof under its cavern's rim`, `level ${level === null ? 'none' : level.toFixed(1)} roof ${roof.toFixed(1)}`)
  }

  // The mesh: every chunk at every LOD, timed; then the triangles CaveRoom draws standing at each node, within a budget.
  const t2 = performance.now()
  let tris = 0, cracked = 0
  const chunks = []
  for (const [i, j, k] of chunkList(field)) {
    const c = { x: (i + 0.5) * CHUNK, y: (j + 0.5) * CHUNK, z: (k + 0.5) * CHUNK, lods: LODS.map(() => null) }
    const tiers = meshChunk(field, i, j, k, cave.lights)
    const seams = tiers.map((m) => (m === null ? '' : seamOf(m.position, i * CHUNK, j * CHUNK, k * CHUNK)))
    if (seams.some((q) => q !== seams[0])) cracked++
    tiers.forEach((m, lod) => {
      if (m === null) return
      c.lods[lod] = new Map()
      for (let p = 0; p < m.parts.length; p += 3) c.lods[lod].set(m.parts[p], m.parts[p + 2] / 3)
      if (lod === 0) tris += m.index.length / 3
    })
    chunks.push(c)
  }
  const meshMs = performance.now() - t2
  check(cracked === 0, `${tag}: every chunk's seam vertices are the same at every LOD`, `${cracked} cracked chunks`)
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
  console.log(`       ${JSON.stringify(kinds)} edges ${graph.edges.length} (${drops.length} drops, ${graph.edges.filter((q) => q.kind === 'sump').length} sumps, ${graph.edges.filter((q) => q.kind === 'drowned').length} drowned, ${graph.rivers.length} rivers, ${chokes.length} chokes) pools ${graph.pools.length} regions ${graph.regions.length} depth ${Math.min(...graph.nodes.map((n) => n.y)).toFixed(0)} m; props mites ${props.mites.length} tites ${props.tites.length} mush ${props.mush.length} ruins ${props.ruins.length} chalk ${props.chalk.length} boulders ${props.boulders.length} (${props.boulders.filter((b) => b.r >= 0.5).length} over 1 m) pebbles ${props.pebbles.length} lights ${cave.lights.length}`)
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
  // Ribbons lie 2 to 3 cm out from the triangles tier 0 draws, over many surfaces of two systems: strokes are walked as a pen walks them (ray to the wall, then 3 cm steps put back on the rock), then lifted.
  for (const sys of [SYSTEMS[0], SYSTEMS[2]]) {
    const plan = planCave(sys)
    const surface = new Surface((key) => drawnSurface(plan.field, ...key.split(',').map(Number)))
    const rng = mulberry32(sys.seed)
    const strokes = []
    const nodes = plan.graph.nodes.filter((n) => n.kind !== 'mouth')
    for (let tries = 0; strokes.length < 300 && tries < 6000; tries++) {
      const n = nodes[Math.floor(rng() * nodes.length)]
      const a = rng() * Math.PI * 2, el = (rng() - 0.5) * 2.2
      const hit = [0, 0, 0]
      if (!rayRock(plan.field, n.x + (rng() - 0.5) * n.rx, n.y + 1.2 + rng() * 2, n.z + (rng() - 0.5) * n.rz, Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el), 30, hit)) continue
      const pen = new ChalkPen((p) => strokes.push(p))
      const dir = rng() * Math.PI * 2
      pen.touch(hit[0], hit[1], hit[2])
      const at = [...hit], next = [0, 0, 0]
      for (let k = 0; k < 24; k++) {
        if (!onRock(plan.field, at[0] + Math.cos(dir) * 0.04, at[1] + Math.sin(dir) * 0.04 * (k % 5 === 0 ? 1 : 0.3), at[2] + Math.sin(dir) * 0.04, 0.1, next)) break
        at[0] = next[0]; at[1] = next[1]; at[2] = next[2]
        pen.touch(at[0], at[1], at[2])
      }
      pen.lift()
    }
    // How much of the field's own surface lies under the drawn mesh: the cause, were a mark laid on the field.
    const s6 = [0, 0, 0, 0, 0, 0, 0]
    let sunk = 0, total = 0
    for (const p of strokes) for (let k = 0; k < p.length; k += 3) {
      if (!surface.nearest(p[k], p[k + 1], p[k + 2], 0.6, s6)) continue
      total++
      if ((p[k] - s6[0]) * s6[3] + (p[k + 1] - s6[1]) * s6[4] + (p[k + 2] - s6[2]) * s6[5] < -0.002) sunk++
    }
    const r = ribbons(strokes, surface)
    // A rock fin thinner than a voxel is in the field but not in the mesh: a pen can hit it, no triangle is near.
    check(r.skipped <= strokes.length * 0.01, `${sys.seed} chalk: nearly every sampled stroke sits on the drawn mesh`, `${r.skipped} of ${strokes.length} off it`)
    let lo = Infinity, hi = -Infinity, wrong = 0, ribbonPts = 0
    for (let v = 0; v + 1 < r.position.length / 3; v += 2) {
      const c = [0, 1, 2].map((a) => (r.position[v * 3 + a] + r.position[v * 3 + 3 + a]) / 2)
      if (!surface.nearest(c[0], c[1], c[2], 0.2, s6)) { wrong++; continue }
      ribbonPts++
      lo = Math.min(lo, s6[6]); hi = Math.max(hi, s6[6])
      if ((c[0] - s6[0]) * s6[3] + (c[1] - s6[1]) * s6[4] + (c[2] - s6[2]) * s6[5] <= 0) wrong++
    }
    check(ribbonPts > 3000 && wrong <= ribbonPts * 0.01 && lo >= 0.01 && hi <= 0.03, `${sys.seed} chalk: ribbon centres stand 2 to 3 cm out from the drawn triangles, on the air side (creases and fins under 5 cm wide excepted)`, `${ribbonPts} centres on ${strokes.length} strokes, ${lo.toFixed(4)}..${hi.toFixed(4)} m, ${wrong} wrong, field-surface points under the mesh ${((100 * sunk) / total).toFixed(0)}%`)
    check(sunk / total > 0.1, `${sys.seed} chalk: the field's surface lies under the drawn mesh often enough that it needed the mesh`, `${((100 * sunk) / total).toFixed(0)}% of ${total} points`)
    const dab = ribbons([strokes[0].slice(0, 3)], surface)
    check(dab.index.length === 6 && dab.skipped === 0, `${sys.seed} chalk: a one-point dab is a single quad`, `${dab.index.length / 3} triangles`)
  }
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
  const { roadPlan, mouths, trailPlan } = planWorld({ heightmap: hm, ground: (x, z) => hm.sample(x, z), field, surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, spawn: SPAWN })
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
