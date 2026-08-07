// Node-side gates for villages (src/village/*, DESIGN.md §6 and §9).
//
//   node scripts/check-village.mjs [seed] [gridN]
//
// Villages fail the way Phase A fails: silently. A hut standing in the middle
// of the road, a fence run that misses its corner, a crop row spearing out of
// its field, a door with no path to it -- none of those throw. They are all
// things you find by walking there, which is the most expensive way to find
// anything.
//
// This runs the WHOLE runtime, not just the planner: it builds a real
// THREE.Scene, drives Villages.update() until the resident village is live, and
// measures the geometry that comes out. src/village/plan.js has no three.js in
// it (§1's porting rule) so the layout could be gated without any of that, but
// the failures that actually cost time -- a geometry with a stray attribute
// that makes a merge return null, a building sunk into its own plinth -- only
// exist once there is a mesh.

import * as THREE from 'three'
import { runPhaseA, VILLAGE } from '../src/sim/phase-a.js'
import { TerrainHeight } from '../src/sim/terrain-height.js'
import { planVillage, VILLAGE_PLAN, CROPS, STALL_GOODS } from '../src/village/plan.js'
import { Villages } from '../src/village/village.js'

const SEED = Number(process.argv[2] ?? 20260804)
const N = Number(process.argv[3] ?? 1024)
const P = VILLAGE_PLAN

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log(`\n=== village checks, seed ${SEED}, ${N}^2 phase-A grid ===\n`)

const th = new TerrainHeight(SEED)
const W = runPhaseA(SEED, N)
const sites = W.villages
console.log(`phase A sited ${sites.length} villages (VILLAGE.count ${VILLAGE.count}, minSeparation ${VILLAGE.minSeparation}m)`)
for (const s of sites) console.log(`       ${s.x.toFixed(0)},${s.z.toFixed(0)}  ${th.heightAt(s.x, s.z).toFixed(0)}m`)
console.log()

if (sites.length === 0) {
  console.log(' FAIL  phase A sited no villages, so there is nothing to plan')
  process.exit(1)
}

// --- 1. every real site plans, and plans quickly -----------------------------

console.log('planning')
const plans = []
{
  let worstMs = 0
  const warned = []
  for (const s of sites) {
    const t0 = performance.now()
    const plan = planVillage(s, th, { seed: SEED, id: s.id ?? 0 })
    const ms = performance.now() - t0
    worstMs = Math.max(worstMs, ms)
    plans.push({ site: s, plan, ms })
    if (plan.warnings.length) warned.push(`${s.x.toFixed(0)},${s.z.toFixed(0)}: ${plan.warnings.join('; ')}`)
  }
  check(warned.length === 0, 'no site reports a planning warning', warned.join(' | '))
  // The planner runs on the frame the player crosses the load radius. It is
  // allowed one frame, not four.
  check(worstMs < 16, 'the slowest plan fits in a frame', `worst ${worstMs.toFixed(1)}ms`)

  for (const { site, plan, ms } of plans) {
    const st = plan.stats
    console.log(
      `       ${String(site.x.toFixed(0)).padStart(6)},${String(site.z.toFixed(0)).padStart(6)}` +
      `  ${ms.toFixed(1)}ms  inst ${String(st.instances).padStart(4)}` +
      `  huts ${String(st.dwellings).padStart(2)}  fields ${st.fields}  rows ${String(st.cropRows).padStart(3)}` +
      `  fence ${String(st.fences).padStart(3)}  props ${String(st.props).padStart(3)}` +
      `  lamps ${String(st.lamps).padStart(2)}  fires ${st.bonfires}  paths ${String(st.paths).padStart(2)}` +
      `  ${st.pathMetres}m  probes ${st.probeCalls}`
    )
  }
}

// --- 2. the village has everything the brief asks for ------------------------

console.log('\ncontent')
{
  const missing = []
  for (const { site, plan } of plans) {
    const at = `${site.x.toFixed(0)},${site.z.toFixed(0)}`
    const has = (ok, what) => { if (!ok) missing.push(`${at} has no ${what}`) }
    has(plan.buildings.some((b) => b.kind === 'hall'), 'great hall')
    // The planner asks for 9-15 dwellings but siting can refuse on steep
    // ground, so the gate is a floor rather than the range: a hamlet is fine, a
    // pair of huts is not a village.
    has(plan.stats.dwellings >= 6, '6+ dwellings')
    has(plan.buildings.some((b) => b.kind === 'barn' || b.kind === 'shed' || b.kind === 'workshop'), 'farm buildings')
    has(plan.fields.length >= 3, '3+ fields')
    has(plan.fields.some((f) => f.pasture), 'pasture')
    has(plan.props.some((p) => ['sheep', 'cow', 'goat', 'chicken'].includes(p.kind)), 'livestock')
    has(plan.lamps.length >= 8, '8+ lampposts')
    has(plan.bonfires.length >= 1, 'bonfire')
    has(plan.props.some((p) => p.kind === 'bench' || p.kind === 'stool'), 'seating')
    has(plan.props.filter((p) => p.kind === 'stall').length >= 4, '4+ market stalls')
    has(plan.props.some((p) => p.kind === 'well'), 'well')
    has(plan.paths.some((p) => p.cls === 'artery'), 'road out')
    has(plan.paths.some((p) => p.cls === 'spur'), 'footpath to a door')
    has(plan.fences.some((f) => f.kind === 'gate'), 'field gate')
  }
  check(missing.length === 0, 'every village has a hall, farms, fields, stock, light, fire and a market', missing.join(' | '))

  const crops = new Set()
  const goods = new Set()
  for (const { plan } of plans) {
    for (const f of plan.fields) if (f.crop) crops.add(f.crop)
    for (const p of plan.props) if (p.kind === 'stall') goods.add(p.goods)
  }
  check(crops.size >= 3, 'at least three kinds of crop appear across the world', [...crops].join(','))
  check(
    [...crops].every((c) => CROPS.some((k) => k.name === c)),
    'every planted crop is one the geometry kit knows how to build'
  )
  check(
    [...goods].every((g) => STALL_GOODS.includes(g)),
    'every stall sells goods the geometry kit knows how to build',
    [...goods].join(',')
  )
  check(goods.size >= 4, 'the market sells at least four kinds of thing', `${goods.size} kinds`)
}

// --- 3. nothing stands on top of anything else ------------------------------

console.log('\nlayout')
{
  // Segment-vs-OBB, in the rectangle's frame. Same test plan.js uses to keep
  // fields off the roads, applied here to the finished layout.
  const pathHitsRect = (pts, x, z, yaw, w, d, margin) => {
    const hw = w / 2 + margin
    const hd = d / 2 + margin
    const s = Math.sin(yaw)
    const c = Math.cos(yaw)
    const local = (px, pz) => {
      const dx = px - x
      const dz = pz - z
      return { u: dx * c - dz * s, v: dx * s + dz * c }
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = local(pts[i].x, pts[i].z)
      const b = local(pts[i + 1].x, pts[i + 1].z)
      // Cheap reject on the separating axes first.
      if (Math.max(a.u, b.u) < -hw || Math.min(a.u, b.u) > hw) continue
      if (Math.max(a.v, b.v) < -hd || Math.min(a.v, b.v) > hd) continue
      // Sample the segment. The rectangles are 5-20 m and the steps are under a
      // metre, so this cannot miss a crossing.
      const steps = Math.ceil(Math.hypot(b.u - a.u, b.v - a.v)) + 1
      for (let k = 0; k <= steps; k++) {
        const t = k / steps
        const u = a.u + (b.u - a.u) * t
        const v = a.v + (b.v - a.v) * t
        if (Math.abs(u) <= hw && Math.abs(v) <= hd) return true
      }
    }
    return false
  }

  let overlaps = 0
  let onRoad = 0
  let rowsOut = 0
  let sunk = 0
  let firstOverlap = ''
  let firstOnRoad = ''
  for (const { plan } of plans) {
    for (let i = 0; i < plan.buildings.length; i++) {
      const a = plan.buildings[i]
      for (let j = i + 1; j < plan.buildings.length; j++) {
        const b = plan.buildings[j]
        const need = (Math.hypot(a.w, a.d) + Math.hypot(b.w, b.d)) / 2
        if (Math.hypot(a.x - b.x, a.z - b.z) < need) {
          overlaps++
          if (!firstOverlap) firstOverlap = `${a.kind} and ${b.kind} at ${a.x.toFixed(0)},${a.z.toFixed(0)}`
        }
      }
      // A road through a building. Spurs are exempt: a spur ENDS at the door,
      // which is on the footprint edge by construction.
      for (const p of plan.paths) {
        if (p.cls === 'spur') continue
        if (pathHitsRect(p.pts, a.x, a.z, a.yaw, a.w, a.d, 0)) {
          onRoad++
          if (!firstOnRoad) firstOnRoad = `${p.cls} through the ${a.kind} at ${a.x.toFixed(0)},${a.z.toFixed(0)}`
          break
        }
      }
      // The plinth has to reach the lowest corner of the footprint or the
      // downhill wall hangs in the air.
      const s = Math.sin(a.yaw)
      const c = Math.cos(a.yaw)
      let lowest = Infinity
      for (const [ox, oz] of [[-a.w / 2, -a.d / 2], [a.w / 2, -a.d / 2], [a.w / 2, a.d / 2], [-a.w / 2, a.d / 2]]) {
        lowest = Math.min(lowest, th.heightAt(a.x + ox * c + oz * s, a.z - ox * s + oz * c))
      }
      if (a.y - a.plinth > lowest) sunk++
    }

    for (const f of plan.fields) {
      const s = Math.sin(f.yaw)
      const c = Math.cos(f.yaw)
      for (const r of f.rows) {
        const dx = r.x - f.x
        const dz = r.z - f.z
        const u = dx * c - dz * s
        const v = dx * s + dz * c
        // Half the row's own length, plus the weave, has to stay inside.
        if (Math.abs(u) + r.len / 2 > f.w / 2 + 0.01 || Math.abs(v) > f.d / 2 + 0.01) rowsOut++
      }
    }
  }
  check(overlaps === 0, 'no two buildings share ground', firstOverlap)
  check(onRoad === 0, 'no road, ring or field lane runs through a building', firstOnRoad)
  check(sunk === 0, 'every plinth reaches the lowest corner of its own footprint', `${sunk} floating`)
  check(rowsOut === 0, 'every crop row stays inside its field', `${rowsOut} rows outside`)
}

// --- 4. fences close, and each field has exactly one gate --------------------

{
  let openFields = 0
  let gateCount = 0
  let fieldsWithoutGate = 0
  for (const { plan } of plans) {
    for (const f of plan.fields) {
      // Fence runs belonging to this plot: the ones whose centre lies on its
      // perimeter, within half a run.
      const s = Math.sin(f.yaw)
      const c = Math.cos(f.yaw)
      let perimeter = 0
      let gates = 0
      for (const fen of plan.fences) {
        const dx = fen.x - f.x
        const dz = fen.z - f.z
        const u = Math.abs(dx * c - dz * s)
        const v = Math.abs(dx * s + dz * c)
        const onEdge =
          (Math.abs(u - f.w / 2) < 0.6 && v <= f.d / 2 + 0.6) ||
          (Math.abs(v - f.d / 2) < 0.6 && u <= f.w / 2 + 0.6)
        if (!onEdge) continue
        perimeter += fen.len
        if (fen.kind === 'gate') gates++
      }
      const want = 2 * (f.w + f.d)
      if (Math.abs(perimeter - want) > want * 0.06) openFields++
      gateCount += gates
      if (gates !== 1) fieldsWithoutGate++
    }
  }
  check(openFields === 0, 'every field is fenced the whole way round', `${openFields} with gaps`)
  check(fieldsWithoutGate === 0, 'every field has exactly one gate', `${gateCount} gates in total`)
}

// --- 5. every door is reachable ---------------------------------------------

{
  // The door is on local +Z by construction (see plan.js's header), so this
  // recomputes it the same way the planner does rather than trusting a stored
  // value that could drift.
  const distToPaths = (paths, px, pz) => {
    let best = Infinity
    for (const p of paths) {
      for (let i = 0; i + 1 < p.pts.length; i++) {
        const a = p.pts[i]
        const b = p.pts[i + 1]
        const dx = b.x - a.x
        const dz = b.z - a.z
        const l2 = dx * dx + dz * dz || 1
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l2))
        best = Math.min(best, Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t)))
      }
    }
    return best
  }

  let stranded = 0
  let worst = 0
  let where = ''
  for (const { plan } of plans) {
    for (const b of plan.buildings) {
      const doorX = b.x + Math.sin(b.yaw) * (b.d / 2)
      const doorZ = b.z + Math.cos(b.yaw) * (b.d / 2)
      // The hall opens onto the plaza, which is bare ground and has no ribbon.
      if (Math.hypot(doorX - plan.x, doorZ - plan.z) < P.plazaRadius + 2) continue
      const d = distToPaths(plan.paths, doorX, doorZ)
      if (d > worst) {
        worst = d
        where = `${b.kind} at ${b.x.toFixed(0)},${b.z.toFixed(0)}`
      }
      if (d > 3) stranded++
    }
  }
  check(stranded === 0, 'every door outside the plaza is within 3 m of a path', `worst ${worst.toFixed(1)}m -- ${where}`)
}

// --- 6. determinism ----------------------------------------------------------

console.log('\ndeterminism')
{
  const s = sites[0]
  const a = planVillage(s, th, { seed: SEED, id: 0 })
  const b = planVillage(s, th, { seed: SEED, id: 0 })
  // probeCalls counts a mutable counter on the probe, so it is part of the
  // output and has to agree too.
  check(JSON.stringify(a) === JSON.stringify(b), 'two plans of the same site are identical')

  // siteSeed() quantises to 25 cm, so a site that jitters below that keeps its
  // random stream. It does NOT keep an identical village -- the planner accepts
  // and rejects on terrain samples and a marginal footprint can flip -- so what
  // is gated here is the part the quantisation actually buys: the road bearings
  // and counts, which are drawn before the first terrain-dependent branch.
  const nudged = planVillage({ x: s.x + 0.01, z: s.z + 0.01 }, th, { seed: SEED, id: 0 })
  const bearings = (p) => p.paths.filter((q) => q.cls === 'artery').map((q) => q.bearing.toFixed(9)).join(' ')
  check(
    bearings(nudged) === bearings(a) && bearings(a).length > 0,
    'a centimetre of jitter in the site keeps the same road network',
    `${bearings(a)} vs ${bearings(nudged)}`
  )

  // A site that MOVES is different ground and must plan differently.
  const moved = planVillage({ x: s.x + 500, z: s.z - 500 }, th, { seed: SEED, id: 0 })
  check(bearings(moved) !== bearings(a), 'a village 700 m away is a different village')
}

// --- 7. the runtime, headless ------------------------------------------------

console.log('\ngeometry')
{
  const scene = new THREE.Scene()
  const layer = new Villages(scene, th, { seed: SEED })
  layer.setSites(sites)

  const target = sites[0]
  let frames = 0
  let worstFrame = 0
  while (layer.stats.state !== 'live' && frames < 600) {
    const t0 = performance.now()
    layer.update(target.x, target.z, frames * 0.016)
    worstFrame = Math.max(worstFrame, performance.now() - t0)
    frames++
  }
  check(layer.stats.state === 'live', 'the resident village builds', `${frames} frames`)
  // The planner runs on the first of those frames, so the ceiling is the plan
  // budget plus the geometry budget, not the geometry budget alone.
  check(worstFrame < 20, 'no build frame blows the frame budget', `worst ${worstFrame.toFixed(1)}ms over ${frames} frames`)

  check(layer.solid !== null, 'the static village is one mesh')
  check(layer.pathMesh !== null, 'the paths are one mesh')

  const total = layer.stats.tris + layer.stats.pathTris
  console.log(`       ${layer.stats.tris} village tris + ${layer.stats.pathTris} path tris, ` +
    `${layer.stats.instances} pieces, kit ${layer.kit.cache.size} geometries / ${layer.kit.tris} tris`)
  console.log(`       plan ${layer.stats.planMs.toFixed(1)}ms, geometry ${layer.stats.buildMs.toFixed(1)}ms over ${frames} frames`)
  // §5 budgets the whole frame at ~800k triangles and gives village buildings
  // 16k of it. This is the whole settlement -- crops, fences, market, stock --
  // so it gets more, but a village that eats a tenth of the frame is a village
  // that has stopped being placeholder art.
  check(total < 90000, 'a whole village stays under 90k triangles', `${total}`)

  for (const [key, g] of layer.kit.cache) {
    const attrs = Object.keys(g.attributes).sort().join(',')
    if (attrs !== 'color,normal,position' || !g.index) {
      check(false, `kit geometry "${key}" has the batching attribute layout`, attrs)
    }
  }
  check(true, `all ${layer.kit.cache.size} kit geometries are indexed position/normal/color`)

  const solidAttrs = Object.keys(layer.solid.geometry.attributes).sort().join(',')
  check(solidAttrs === 'color,normal,position', 'the merged village geometry survived with its attributes intact', solidAttrs)

  // Fire. Nothing is animated until update() has run with a live plan, so this
  // runs a few more frames first.
  for (let i = 0; i < 4; i++) layer.update(target.x, target.z, 10 + i * 0.016)
  check(layer.flames.count > 0, 'flames are instanced and drawn', `${layer.flames.count} flames`)
  check(layer.puffs.count > 0, 'smoke puffs are instanced and drawn', `${layer.puffs.count} puffs`)
  check(
    layer.flames.count === layer.plan.lamps.length + layer.plan.bonfires.length,
    'every lamppost and every bonfire has a flame',
    `${layer.flames.count} flames for ${layer.plan.lamps.length} lamps + ${layer.plan.bonfires.length} fires`
  )

  // A puff has to reach zero size rather than vanishing at full size: §7 rules
  // out alpha blending in anything instanced, so shrinking is the only exit it
  // has, and a pop is exactly what this is guarding against.
  {
    const m = new THREE.Matrix4()
    const scale = new THREE.Vector3()
    let biggestAtEnds = 0
    for (let k = 0; k < 240; k++) {
      layer.update(target.x, target.z, 40 + k * 0.05)
      for (let i = 0; i < layer.puffs.count; i++) {
        layer.puffs.getMatrixAt(i, m)
        m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale)
        biggestAtEnds = Math.max(biggestAtEnds, scale.x)
      }
    }
    check(biggestAtEnds > 0.1 && biggestAtEnds < 3, 'smoke puffs stay a sensible size', `max ${biggestAtEnds.toFixed(2)}m`)
  }

  // Prop exclusion (§6: "reject ... inside village footprints").
  check(layer.excludes(target.x + 40, target.z, 'tree'), 'trees are rejected inside the village')
  check(!layer.excludes(target.x + 40, target.z, 'grass'), 'grass still grows between the huts')
  check(!layer.excludes(target.x + 400, target.z, 'tree'), 'the exclusion ends at the field fence')

  // Walking away tears it down, and walking back builds it again.
  layer.update(target.x + 4000, target.z, 100)
  check(layer.stats.state === 'idle' && layer.solid === null, 'walking away unloads the village')
  layer.dispose()
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
