// Drill for the river router (src/v2/layers/route.js), DESIGN.md §18.
//
// The router is what turns two river nodes into the path between them, and every one of its promises is a geometry that can be measured on a synthetic heightmap in node. The claims:
//
//   on flat ground a leg is the chord -- the tie-break that keeps A* from handing back a dogleg of texel steps that costs the same as the straight line;
//   a ridge in the way is gone around, not over -- the rise cost, which is the whole reason the router exists;
//   a valley beside the chord is taken -- the pull toward low ground, without which the route contours along a hillside;
//   a leg that cannot avoid a climb still arrives -- the search is over a fully connected window and must never fail;
//   and a route is cached per terrain buffer and dropped by invalidateRoutes only where the terrain changed -- the thing that makes sculpting under a river re-route it live and sculpting elsewhere free.
//
//   node scripts/check-v2-route.mjs

import { fileURLToPath } from 'node:url'
import { WORLD_HALF, WORLD_SIZE } from '../src/v2/config.js'
import { routeLeg, invalidateRoutes, ROUTE_SPACING } from '../src/v2/layers/route.js'
import { fieldOf } from './lib/synthetic-terrain.mjs'

const W = WORLD_HALF

// Largest perpendicular distance of any waypoint from the chord A -> B, and the largest gap between consecutive waypoints.
function shape(pts) {
  const ax = pts[0]
  const az = pts[1]
  const bx = pts[pts.length - 2]
  const bz = pts[pts.length - 1]
  const len = Math.hypot(bx - ax, bz - az)
  const nx = -(bz - az) / len
  const nz = (bx - ax) / len
  let off = 0
  let gap = 0
  let signed = 0
  for (let i = 0; i < pts.length; i += 2) {
    const o = (pts[i] - ax) * nx + (pts[i + 1] - az) * nz
    if (Math.abs(o) > off) off = Math.abs(o)
    if (Math.abs(o) > Math.abs(signed)) signed = o
    if (i > 0) gap = Math.max(gap, Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
  }
  return { off, gap, signed, n: pts.length / 2 }
}

export async function run() {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log(`\n=== v2 river router, ${WORLD_SIZE} m world ===`)

  console.log('\nflat ground')
  {
    const flat = fieldOf(() => 100)
    // Endpoints off the texel lattice and at an angle no texel walk can follow exactly, so the staircase is real and the tie-break has something to break.
    const r = routeLeg(flat, -1000, -300, 1400, 500)
    const s = shape(r.pts)
    console.log(`        ${s.n} waypoints, worst offset from the chord ${s.off.toFixed(1)} m, longest gap ${s.gap.toFixed(1)} m`)
    check(r.pts[0] === -1000 && r.pts[1] === -300 && r.pts[r.pts.length - 2] === 1400 && r.pts[r.pts.length - 1] === 500, 'the route starts and ends exactly on the nodes')
    check(s.off < flat.texelSize * 1.5, 'on flat ground the route hugs the chord instead of running its diagonals first', `${s.off.toFixed(1)} m off over a ${Math.hypot(2400, 800).toFixed(0)} m leg`)
    check(s.gap < ROUTE_SPACING * 2.5, `waypoints come at about ROUTE_SPACING (${ROUTE_SPACING} m)`, `longest gap ${s.gap.toFixed(1)} m`)

    // A leg along a line BETWEEN texel rows: the walk runs along the nearest row, and the route it hands back must be shifted onto the nodes' own line rather than jogging over to the row at each end.
    const row = shape(routeLeg(flat, -200, -300, 200, -300).pts)
    check(row.off < 1e-9 && row.n > 4, 'a leg between two texel rows is handed back on its own line, not on the nearest row', `${row.off.toExponential(1)} m off over ${row.n} waypoints`)

    const same = routeLeg(flat, -1000, -300, 1400, 500)
    check(same === r, 'the same leg on the same terrain is served from the cache')
    const short = routeLeg(flat, 10, 10, 12, 14)
    check(short.pts.length === 4, 'two nodes in one texel route as the segment between them', `${short.pts.length / 2} points`)
  }

  console.log('\na ridge in the way')
  {
    // A 40 m ridge running along z through x = 0, with a gap in it at z = 600. The straight leg crosses the ridge at z = 0; the route should go through the gap.
    const ridge = fieldOf((x, z) => 100 + 40 * Math.exp(-((x / 120) ** 2)) * (1 - Math.exp(-(((z - 600) / 150) ** 2))))
    const r = routeLeg(ridge, -800, 0, 800, 0)
    const s = shape(r.pts)
    let crest = -Infinity
    for (let i = 0; i < r.pts.length; i += 2) {
      const x = r.pts[i]
      const z = r.pts[i + 1]
      const h = 100 + 40 * Math.exp(-((x / 120) ** 2)) * (1 - Math.exp(-(((z - 600) / 150) ** 2)))
      if (h > crest) crest = h
    }
    console.log(`        route bows ${s.signed.toFixed(0)} m off the chord, highest ground under a waypoint ${crest.toFixed(1)} m against a ${140} m crest`)
    check(s.signed > 400, 'a leg across a ridge detours to the gap in it', `${s.signed.toFixed(0)} m toward the gap at z = 600`)
    check(crest < 110, 'and never climbs the ridge', `highest waypoint ground ${crest.toFixed(1)} m`)
  }

  console.log('\na valley beside the chord')
  {
    // Ground sloping gently down toward -z, with a valley floor 20 m deep along z = -300. The chord along z = 0 is a hillside the route could contour along at constant height; the pull toward low ground takes it down into the valley instead.
    const valley = fieldOf((x, z) => 100 + 0.02 * z - 20 * Math.exp(-(((z + 300) / 120) ** 2)))
    const r = routeLeg(valley, -1200, 0, 1200, 0)
    let inValley = 0
    for (let i = 0; i < r.pts.length; i += 2) if (Math.abs(r.pts[i + 1] + 300) < 100 && Math.abs(r.pts[i]) < 800) inValley++
    const mid = Math.round(r.pts.length / 4) * 2
    console.log(`        midpoint of the route at z = ${r.pts[mid + 1].toFixed(0)} m, ${inValley} waypoints on the valley floor`)
    check(inValley > 10 && Math.abs(r.pts[mid + 1] + 300) < 100, 'the route drops into the valley floor rather than contouring the hillside on the chord', `z = ${r.pts[mid + 1].toFixed(0)} m at the midpoint`)
  }

  console.log('\na climb that cannot be avoided')
  {
    // A leg from the bottom to the top of a uniform slope: nothing to go around, and the search must still hand back a route.
    const slope = fieldOf((x) => 100 + 0.1 * x)
    let r = null
    let err = ''
    try {
      r = routeLeg(slope, -500, 0, 500, 0)
    } catch (e) {
      err = e.message
    }
    check(r !== null && r.pts.length >= 4, 'a leg that has to climb still arrives', err || `${r.pts.length / 2} waypoints`)
    check(r !== null && shape(r.pts).off < slope.texelSize * 1.5, 'and takes the straight line up, there being nothing to gain by wandering', r === null ? '' : `${shape(r.pts).off.toFixed(1)} m off the chord`)
  }

  console.log('\ncache invalidation')
  {
    const flat = fieldOf(() => 100)
    const a = routeLeg(flat, -1000, 0, 1000, 0)
    const b = routeLeg(flat, 2000, 2000, 3000, 2000)
    invalidateRoutes(flat.field, { minX: -50, minZ: -50, maxX: 50, maxZ: 50 })
    check(routeLeg(flat, -1000, 0, 1000, 0) !== a, "a sculpt inside a route's search box drops that route")
    check(routeLeg(flat, 2000, 2000, 3000, 2000) === b, 'and leaves a route the sculpt cannot see in the cache')

    // Re-routing after a sculpt actually follows the new ground: raise a hill on the chord and the leg moves.
    const hill = fieldOf(() => 100)
    const before = shape(routeLeg(hill, -1000, 0, 1000, 0).pts)
    const n = hill.width
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -W + (i * WORLD_SIZE) / (n - 1)
        const z = -W + (j * WORLD_SIZE) / (n - 1)
        hill.field[j * n + i] = 100 + 30 * Math.exp(-((x / 150) ** 2 + (z / 150) ** 2))
      }
    }
    const stale = routeLeg(hill, -1000, 0, 1000, 0)
    check(shape(stale.pts).off === before.off, 'until invalidated, the cache still answers with the pre-sculpt route', `${shape(stale.pts).off.toFixed(1)} m`)
    invalidateRoutes(hill.field, { minX: -200, minZ: -200, maxX: 200, maxZ: 200 })
    const after = shape(routeLeg(hill, -1000, 0, 1000, 0).pts)
    console.log(`        route offset from the chord ${before.off.toFixed(1)} m before the hill, ${after.off.toFixed(1)} m after`)
    check(after.off > 150, 'after invalidation the leg re-routes around the new hill', `${after.off.toFixed(1)} m off the chord`)

    // Only the buffer identifies the terrain: another Heightmap over the same texels shares the routes.
    const view = hill.view()
    check(routeLeg(view, -1000, 0, 1000, 0) === routeLeg(hill, -1000, 0, 1000, 0), 'two Heightmaps over one buffer share a cache, since they are one terrain')
  }

  console.log(`\nv2 route: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) throw new Error(`check-v2-route: ${failures} check(s) failed`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
