// What stands in the cave (design/39-caves.md §6): dripstone, mushrooms and the ferns in their light, ruin columns, chalk, each region's landmark, the mouths' boulders and greenery. Pure and seeded.
//
// Anything she cannot step past (a stalagmite over a metre, a column, a giant stem) is kept CLEAR of every passage line into its node, so dressing can never close a route the graph promised; check-caves.mjs walks the routes to prove it.

import { mulberry32 } from '../../sim/mathx.js'
import { PALETTES, GLOWS } from './regions.js'
import { onRock, rayRock } from './chalk.js'
import { reliefAt } from './graph.js'
import { mouthFlare, FLARE_M } from './field.js'
import { waterBodies } from './walk.js'

// A stalagmite this tall is a trunk to her.
export const MITE_BLOCKS = 1.0
// Plan metres any obstacle keeps from a passage's line.
const CLEAR = 2.0
// A scatter of pebbles per this much of a node's rx * rz, and one per this many metres of passage.
const PEBBLE_M2 = 3
const PEBBLE_STEP = 2

// Metres from (x, y, z), in air, to the first rock along the vertical `dir` (+1 up, -1 down), or `limit` if none: sphere-traced on the field, then bisected to 0.1 m.
function reach(field, x, y, z, dir, limit) {
  let t = 0, v = field.at(x, y, z)
  while (t < limit) {
    const nt = Math.min(limit, t + Math.max(0.1, -v * 0.8))
    v = field.at(x, y + dir * nt, z)
    if (v > 0) {
      let lo = t, hi = nt
      while (hi - lo > 0.1) {
        const mid = (lo + hi) / 2
        if (field.at(x, y + dir * mid, z) > 0) hi = mid; else lo = mid
      }
      return (lo + hi) / 2
    }
    t = nt
  }
  return limit
}

/** Floor and roof on the vertical through (x, z), marching from `y` (in air): { floor, roof } or null when `y` is in rock. */
export function columnAt(field, x, z, y) {
  if (field.at(x, y, z) > 0) return null
  return { floor: y - reach(field, x, y, z, -1, 60), roof: y + reach(field, x, y, z, 1, 60) }
}

// The rock face met marching from `y` (in air) in direction `dir` (+1 up, -1 down) within `reach` metres, or null.
function surface(field, x, z, y, dir, reachM) {
  if (field.at(x, y, z) > 0) return null
  const d = reach(field, x, y, z, dir, reachM)
  return d < reachM ? y + dir * d : null
}

export function placeProps(graph, field, seed) {
  const rand = mulberry32(seed ^ 0x9f05)
  const rr = (a, b) => a + (b - a) * rand()
  const out = { mites: [], tites: [], mush: [], boulders: [], ferns: [], grass: [], torches: [], ruins: [], chalk: [], obstacles: [], lights: [], pebbles: [] }
  const lines = graph.nodes.map(() => [])
  for (const e of graph.edges) { lines[e.a].push(e.pts); lines[e.b].push(e.pts) }
  const clear = (n, x, z, pad) => lines[n.i].every((pts) => pts.every((p, k) => k + 1 >= pts.length || segDist(x, z, p, pts[k + 1]) > CLEAR + pad))
  const block = (x, z, r, y0, y1) => out.obstacles.push({ x, z, r: r + 0.3, y0, y1 })
  const stone = (x, y, z, r) => out.boulders.push({ x, y, z, r, yaw: rand() * 6.28, seed: rand() })
  // A scatter of litter.js's pebbles on the floor within a metre of (x, y, z), `s` across and skewed small as on the overworld's ground.
  const strew = (x0, y0, z0) => {
    for (let j = 3 + Math.floor(rand() * 6); j > 0; j--) {
      const a = rand() * 6.28, d = 1.2 * Math.sqrt(rand())
      const x = x0 + Math.cos(a) * d, z = z0 + Math.sin(a) * d
      const y = surface(field, x, z, y0 + 0.3, -1, 0.8)
      if (y !== null) out.pebbles.push({ x, y, z, s: 0.06 + 0.24 * rand() ** 2, yaw: rand() * 6.28, seed: rand() })
    }
  }
  // Each region's mushrooms glow one colour: its first glow's, so they match the light on its walls.
  const regionGlow = graph.regions.map((r) => GLOWS[(r.i * 7 + seed) % GLOWS.length])
  for (const g of [...graph.glows].reverse()) regionGlow[graph.nodes[g.node].region] = g.color
  const hit = [0, 0, 0], nrm = [0, 0, 0], at = [0, 0, 0]
  // Under a pool's or river's surface, where nothing that grows is placed. Floors stack, so a body counts only down to a little under its own bed.
  const waters = waterBodies(graph)
  const drowned = (x, y, z) => waters.some((b) => {
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return false
    const level = b.levelAt(x, z)
    return level !== null && y < level && y > b.bed - 1.5
  })

  // Node n's floor at (x, z), or null where that is rock, a pit, or under 2 m of headroom.
  const stand = (n, x, z) => {
    const base = n.y + reliefAt(n, x, z)
    const col = columnAt(field, x, z, base + 1.2)
    if (col === null || col.floor < base - 0.6 || col.roof - col.floor < 2) return null
    return { x, z, y: col.floor, roof: col.roof }
  }
  // A random spot on node n's floor at normalised radius rho0..rho1.
  const spot = (n, rho0, rho1) => {
    const a = rand() * Math.PI * 2, rho = Math.sqrt(rr(rho0 * rho0, rho1 * rho1))
    const lx = Math.cos(a) * rho * n.rx, lz = Math.sin(a) * rho * n.rz
    const c = Math.cos(n.rot), s = Math.sin(n.rot)
    return stand(n, n.x + lx * c - lz * s, n.z + lx * s + lz * c)
  }

  // A cellar's way in: a torch in the passage wall 3 to 5 m from its door (mouthFlare's, 2.4 m behind the node) so the door shows in its light, and maybe a second 4 to 9 m on, on the other side.
  const cellarTorches = (n) => {
    const e = graph.edges.find((q) => q.a === n.i || q.b === n.i)
    const pts = e.a === n.i ? e.pts : [...e.pts].reverse()
    const torch = (at, side) => {
      const p = alongPts(pts, at)
      if (p === null || !rayRock(field, p.x, p.y + 1.7, p.z, -p.dz * side, 0, p.dx * side, 4, hit)) return false
      outward(field, hit, nrm)
      const l = Math.hypot(nrm[0], nrm[2])
      if (l < 0.5) return false
      const nx = nrm[0] / l, nz = nrm[2] / l
      // Its foot is TORCH_SINK deep in the rock, marched back along its lean from where the lean leaves the wall, so a wall that bulges or falls away under it can't leave it standing off in air (a spot whose lean runs along the rock, or finds none, is refused); `out` is foot to that exit.
      const ax = nx * Math.sin(TORCH_LEAN), ay = Math.cos(TORCH_LEAN), az = nz * Math.sin(TORCH_LEAN), rock = (s) => field.at(hit[0] + ax * s, hit[1] + ay * s, hit[2] + az * s)
      let exit = 0, foot = 0
      while (rock(exit) > 0) if ((exit += 0.02) > 0.6) return false
      while (rock(-foot) < TORCH_SINK) if ((foot += 0.02) > 0.6) return false
      out.torches.push({ x: hit[0] - ax * foot, y: hit[1] - ay * foot, z: hit[2] - az * foot, nx, nz, out: exit + foot })
      out.lights.push({ x: hit[0] + nx * 0.4, y: hit[1] + 0.45, z: hit[2] + nz * 0.4, ...TORCHLIGHT })
      return true
    }
    const side = rand() < 0.5 ? 1 : -1, at = rr(0.6, 1.9)
    if (![0, 0.5, -0.5, 1, -1].some((d) => torch(at + d, side) || torch(at + d, -side))) throw new Error(`caves/props: cellar ${n.i} has no wall for its torch by the door`)
    if (rand() < 0.5) torch(at + rr(4, 9), -side)
  }

  // A sky mouth's way out: small boulders against the flare's walls by the exit and round the opening, grass and ferns on its floor thickening toward the sky, a few on this side of the exit. None blocks: she leaves at the exit.
  const mouthDressing = (n) => {
    const pts = mouthFlare(n).pts
    const floorAt = (x, z, y) => {
      const col = columnAt(field, x, z, y + 1)
      return col === null ? null : col.floor
    }
    for (let k = 0; k < 10; k++) {
      const p = alongPts(pts, k < 3 ? rr(0.5, 3) : rr(FLARE_M * 0.55, FLARE_M - 0.5))
      const side = k % 2 === 0 ? 1 : -1
      if (p === null || !rayRock(field, p.x, p.y + 0.4, p.z, -p.dz * side, 0, p.dx * side, 5, hit)) continue
      const r = rr(0.2, 0.55)
      const x = hit[0] + p.dz * side * r * 0.5, z = hit[2] - p.dx * side * r * 0.5
      const y = floorAt(x, z, p.y)
      if (y !== null) out.boulders.push({ x, y: y - 0.3 * r, z, r, yaw: rand() * 6.28, seed: rand() })
    }
    for (let k = 0; k < 46; k++) {
      // Metres outward from the exit, negative inside it.
      const at = k < 6 ? -rr(0.3, 3) : FLARE_M * Math.sqrt(rand())
      const p = at < 0 ? { x: n.x - n.dx * at, y: n.y, z: n.z - n.dz * at, dx: -n.dx, dz: -n.dz } : alongPts(pts, at)
      if (p === null) continue
      const off = rr(-1, 1) * (at < 0 ? 0.8 : 1.1 + at * 0.04)
      const x = p.x - p.dz * off, z = p.z + p.dx * off
      const y = floorAt(x, z, p.y)
      if (y === null || y < p.y - 0.8) continue
      const row = { x, y: y - 0.02, z, yaw: rand() * 6.28, s: rr(0.6, 1.15) }
      if (rand() < 0.3) out.ferns.push(row)
      else out.grass.push(row)
    }
  }

  for (const n of graph.nodes) {
    if (n.kind === 'mouth') {
      if (n.cellar) {
        cellarTorches(n)
        // The door is a wall: a row of posts just behind its face, the passage's rock running on past it, so she stops short of the face by about her radius.
        const { end } = mouthFlare(n)
        for (let s = -1.5; s <= 1.5; s += 0.3) block(end.x - n.dx * 0.15 - n.dz * s, end.z - n.dz * 0.15 + n.dx * s, 0.15, end.y - 1, end.y + 3)
      } else mouthDressing(n)
      continue
    }
    const pal = PALETTES[graph.regions[n.region].palette]
    const area = n.rx * n.rz
    const big = n.kind === 'cavern'

    // Dripstone in bunches: a lead stalactite and up to seven round it, sized over a tenfold range so a bunch never reads as a row of equals. A stalagmite stands under one now and then, likelier the bigger it is, and a few stand alone where their stalactite fell.
    const bunches = Math.round(area * 0.2 * pal.tites)
    for (let k = 0; k < bunches; k++) {
      const p = spot(n, 0.15, 0.95)
      if (p === null) continue
      const count = 1 + Math.floor(rand() ** 1.6 * 8), spread = rr(0.4, big ? 3 : 1.6), lead = rr(0.6, 1)
      for (let j = 0; j < count; j++) {
        const a = rand() * Math.PI * 2, d = j === 0 ? 0 : spread * Math.sqrt(rand())
        const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d
        // Its roof read up from its own floor: read from just under the lead's roof, it would start above any shelf of rock between.
        const floor = j === 0 ? p.y : surface(field, x, z, p.y + 0.8, -1, 2.5)
        const roof = j === 0 ? p.roof : floor === null ? null : surface(field, x, z, floor + 0.1, 1, p.roof - floor + 2.5)
        if (roof === null || floor === null || roof - floor < 2) continue
        const room = roof - floor, size = j === 0 ? 1 : 0.1 * 10 ** rand()
        const lone = j > 0 && rand() < 0.12
        if (!lone) {
          const tl = Math.min(room * 0.35, lead * size * rr(0.7, 1.3) * (big ? 5 : 2))
          out.tites.push({ x, y: roof, z, len: tl, r: tl * rr(0.1, 0.16), seed: rand() })
          if (rand() >= 0.25 + 0.4 * size) continue
        }
        let ml = Math.min(room * 0.3, lead * size * rr(0.5, 1.2) * (big ? 3.5 : 1.6))
        const r = ml * rr(0.18, 0.26)
        if (ml > MITE_BLOCKS && !clear(n, x, z, r)) ml = rr(0.2, 0.8)
        out.mites.push({ x, y: floor, z, len: ml, r: Math.max(0.06, ml * 0.22), seed: rand() })
        if (ml > MITE_BLOCKS) block(x, z, ml * 0.22, floor, floor + ml)
      }
    }

    // Mushrooms: carpets of small ones, a few huge. The second `caps` rolls keep only the glowing, so glowing caps come twice as often as plain ones.
    const caps = Math.round(area * 0.1 * (0.3 + pal.mush))
    const glowing = []
    for (let k = 0; k < caps * 2; k++) {
      const glow = rand() < 0.2 + pal.glow * 0.6 ? regionGlow[n.region] : null
      if (k >= caps && glow === null) continue
      const p = spot(n, 0.5, 0.97)
      if (p === null || drowned(p.x, p.y, p.z)) continue
      const huge = rand() < 0.18
      const h = huge ? Math.min(p.roof - p.y - 0.4, rr(1.8, big ? 6 : 3.6)) : rr(0.1, 0.5)
      if (huge && (h < 1.5 || !clear(n, p.x, p.z, h * 0.6))) continue
      out.mush.push({ x: p.x, y: p.y, z: p.z, h, lean: rr(-0.15, 0.15), yaw: rand() * 6.28, glow, seed: rand(), region: n.region, up: UP })
      if (huge) block(p.x, p.z, Math.max(0.12, h * 0.07), p.y, p.y + h)
      // Every glowing cap tints the rock round it, the small ones a few paces of floor and wall.
      if (!glow) continue
      glowing.push(p)
      out.lights.push({ x: p.x, y: p.y + h, z: p.z, color: glow, reach: huge ? 9 + 1.5 * h : 3 + 5 * h, power: huge ? 0.5 : 0.22 })
    }

    // Wall clumps: a few small glowing caps standing out of the rock, each lighting its own patch of wall faintly.
    const clumps = Math.round(2 * (1 + area * 0.012) * (0.3 + pal.mush + pal.glow))
    for (let k = 0; k < clumps; k++) {
      const a = rand() * Math.PI * 2, y0 = n.y + reliefAt(n, n.x, n.z) + rr(0.3, 2.6)
      if (field.at(n.x, y0, n.z) > -0.3) continue
      if (!rayRock(field, n.x, y0, n.z, Math.cos(a), 0, Math.sin(a), Math.max(n.rx, n.rz) * 1.5 + 2, hit)) continue
      outward(field, hit, nrm)
      if (nrm[1] < -0.3) continue
      const glow = regionGlow[n.region]
      const t1 = [-nrm[2], 0, nrm[0]]
      const tl = Math.hypot(t1[0], t1[2])
      if (tl < 0.2) { t1[0] = 1; t1[2] = 0 } else { t1[0] /= tl; t1[2] /= tl }
      const t2 = [nrm[1] * t1[2], nrm[2] * t1[0] - nrm[0] * t1[2], -nrm[1] * t1[0]]
      const count = 3 + Math.floor(rand() * 5)
      for (let j = 0; j < count; j++) {
        const u = rr(-0.35, 0.35), v = rr(-0.3, 0.3)
        const x = hit[0] + nrm[0] * 0.15 + t1[0] * u + t2[0] * v
        const y = hit[1] + nrm[1] * 0.15 + t1[1] * u + t2[1] * v
        const z = hit[2] + nrm[2] * 0.15 + t1[2] * u + t2[2] * v
        if (!onRock(field, x, y, z, 0.5, at)) continue
        const mx = at[0] - nrm[0] * 0.02, my = at[1] - nrm[1] * 0.02, mz = at[2] - nrm[2] * 0.02
        if (drowned(mx, my, mz)) continue
        out.mush.push({ x: mx, y: my, z: mz, h: rr(0.07, 0.24), lean: rr(-0.35, 0.35), yaw: rand() * 6.28, glow, seed: rand(), region: n.region, up: [nrm[0] * 0.8, nrm[1] * 0.8 + 0.2, nrm[2] * 0.8] })
      }
      out.lights.push({ x: hit[0] + nrm[0] * 0.3, y: hit[1] + nrm[1] * 0.3, z: hit[2] + nrm[2] * 0.3, color: glow, reach: 5, power: 0.3 })
    }

    // Where the caps glow thick: their light filling the chamber, and now and then a fern grown in it.
    if (glowing.length >= FILL_GLOWS) {
      const col = columnAt(field, n.x, n.z, n.y + reliefAt(n, n.x, n.z) + 1.2)
      if (col !== null) out.lights.push({ x: n.x, y: col.floor + Math.min(2.5, (col.roof - col.floor) * 0.5), z: n.z, color: regionGlow[n.region], reach: Math.min(FILL_REACH, Math.max(n.rx, n.rz) + 4), power: Math.min(0.5, 0.05 * glowing.length) })
      for (const g of glowing) {
        if (rand() > 0.3) continue
        const a = rand() * 6.28, d = rr(0.4, 1.4)
        const p = stand(n, g.x + Math.cos(a) * d, g.z + Math.sin(a) * d)
        if (p !== null && !drowned(p.x, p.y, p.z)) out.ferns.push({ x: p.x, y: p.y - 0.02, z: p.z, yaw: rand() * 6.28, s: rr(0.6, 1.1) })
      }
    }

    // Ruins: stacked blocks in columns, some fallen.
    if (pal.ruins > 0 && rand() < pal.ruins * (big ? 1 : 0.6)) {
      const cols = Math.round(rr(2, big ? 9 : 5))
      for (let k = 0; k < cols; k++) {
        const p = spot(n, 0.35, 0.85)
        if (p === null || !clear(n, p.x, p.z, 0.6)) continue
        const blocks = 1 + Math.floor(rand() * Math.min(5, (p.roof - p.y) / 0.9))
        const yaw = rand() * 1.57
        let y = p.y - 0.15
        for (let b = 0; b < blocks; b++) {
          const hh = rr(0.6, 1.0)
          out.ruins.push({ x: p.x + rr(-0.05, 0.05), y, z: p.z + rr(-0.05, 0.05), w: rr(0.5, 0.7), h: hh, yaw: yaw + rr(-0.12, 0.12), tilt: 0 })
          y += hh
        }
        if (y - p.y > MITE_BLOCKS) block(p.x, p.z, 0.4, p.y, y)
        if (rand() < 0.5) {
          const q = spot(n, 0.3, 0.9)
          if (q !== null) out.ruins.push({ x: q.x, y: q.y - 0.1, z: q.z, w: rr(0.5, 0.7), h: rr(0.6, 1.0), yaw: rand() * 6.28, tilt: rr(0.6, 1.57) })
        }
      }
    }

    // Chalk: a few lumps in most chambers, so a careful explorer always finds some.
    const lumps = n.kind === 'junction' ? (rand() < 0.15 ? 1 : 0) : Math.floor(rr(1, big ? 5 : 3))
    for (let k = 0; k < lumps; k++) {
      const p = spot(n, 0.1, 0.8)
      if (p !== null) out.chalk.push({ x: p.x, y: p.y, z: p.z, yaw: rand() * 6.28 })
    }

    // Boulders: strewn on the floor, small ones heaped in rubble, now and then a big one jutting from the floor or a wall. Heaps and big ones are obstacles, so they keep clear of the passage lines.
    if (!n.great) {
      for (let k = Math.round(rr(2, 6) + area * 0.024); k > 0; k--) {
        const p = spot(n, 0.2, 0.95)
        if (p === null) continue
        const r = 0.12 + (big ? 1.4 : 0.8) * rand() ** 3
        if (r > 0.5 && !clear(n, p.x, p.z, r)) continue
        stone(p.x, p.y - 0.3 * r, p.z, r)
        if (r > 0.5) block(p.x, p.z, r * 0.9, p.y, p.y + r)
      }
    }
    for (let k = rand() < 0.6 ? Math.floor(rr(2, big ? 7 : 5)) : 0; k > 0; k--) {
      const c = spot(n, 0.3, 0.9)
      if (c === null) continue
      const spread = clear(n, c.x, c.z, 1.6) ? rr(0.8, 1.6) : rr(0.4, 0.7), H = spread * 0.45
      for (let j = 6 + Math.floor(rand() * 14); j > 0; j--) {
        const a = rand() * 6.28, d = spread * Math.sqrt(rand())
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d
        const floor = surface(field, x, z, c.y + 0.8, -1, 2.5)
        if (floor === null) continue
        const r = rr(0.1, 0.32) * (1.2 - 0.6 * d / spread)
        stone(x, floor + H * (1 - (d / spread) ** 2) - 0.3 * r, z, r)
      }
      if (spread > 0.75) block(c.x, c.z, spread * 0.7, c.y, c.y + H)
    }
    for (let k = 0; k < 2; k++) {
      if (rand() >= (big ? 0.6 : 0.3)) continue
      const p = spot(n, 0.3, 0.85), r = rr(1, big ? 3 : 1.8)
      if (p !== null && p.roof - p.y > r + 1 && clear(n, p.x, p.z, r)) {
        stone(p.x, p.y - 0.25 * r, p.z, r)
        block(p.x, p.z, r * 0.85, p.y, p.y + r)
      }
    }
    for (let k = 0; k < 2; k++) {
      if (rand() >= (big ? 0.7 : 0.4)) continue
      const a = rand() * Math.PI * 2, y0 = n.y + reliefAt(n, n.x, n.z) + rr(0.4, 2.4)
      if (field.at(n.x, y0, n.z) < -0.3 && rayRock(field, n.x, y0, n.z, Math.cos(a), 0, Math.sin(a), Math.max(n.rx, n.rz) * 1.5 + 2, hit)) {
        outward(field, hit, nrm)
        const r = rr(0.8, big ? 2.5 : 1.6)
        const x = hit[0] - nrm[0] * 0.3 * r, y = hit[1] - nrm[1] * 0.3 * r, z = hit[2] - nrm[2] * 0.3 * r
        if (Math.abs(nrm[1]) < 0.5 && clear(n, x, z, r)) {
          stone(x, y, z, r)
          block(x, z, r * 0.8, y - r, y + r)
        }
      }
    }

    for (let k = Math.round(area / PEBBLE_M2); k > 0; k--) {
      const p = spot(n, 0, 0.95)
      if (p !== null) strew(p.x, p.y, p.z)
    }

    // A great cavern: groves of giant glowing mushrooms on its dry ground, boulders strewn between.
    if (n.great) {
      let lit = 0
      for (let g = Math.round(area / 200); g > 0; g--) {
        const c = spot(n, 0.1, 0.9)
        if (c === null) continue
        const count = 3 + Math.floor(rand() * 10), spread = rr(3, 10)
        for (let j = 0; j < count; j++) {
          const a = rand() * 6.28, d = spread * Math.sqrt(rand())
          const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d
          // Low ground is where the river and the pools lie.
          if (reliefAt(n, x, z) < -0.5) continue
          const p = stand(n, x, z)
          if (p === null || drowned(x, p.y, z)) continue
          const h = Math.min(p.roof - p.y - 1, 1.5 + 10.5 * rand() ** 2.2)
          if (h < 1.5 || !clear(n, x, z, Math.max(0.6, h * 0.1))) continue
          const glow = rand() < 0.8 ? regionGlow[n.region] : null
          out.mush.push({ x, y: p.y, z, h, lean: rr(-0.12, 0.12), yaw: rand() * 6.28, glow, seed: rand(), giant: h > 5, region: n.region, up: UP })
          block(x, z, Math.max(0.12, h * 0.07), p.y, p.y + h)
          if (glow !== null && h > 4 && lit++ < GROVE_LIGHTS) out.lights.push({ x, y: p.y + h, z, color: glow, reach: 9 + 1.5 * h, power: 0.5 })
        }
      }
      for (let k = Math.round(area / 25); k > 0; k--) {
        const p = spot(n, 0.05, 0.95)
        if (p === null) continue
        const r = 0.15 + 3.35 * rand() ** 2.5
        if (r > 0.5 && !clear(n, p.x, p.z, r)) continue
        stone(p.x, p.y - 0.3 * r, p.z, r)
        if (r > 0.5) block(p.x, p.z, r * 0.9, p.y, p.y + r)
      }
    }
  }

  // Each region's landmark, at its biggest chamber's middle: the thing she names the place by.
  for (const r of graph.regions) {
    if (r.landmark < 0) continue
    const n = graph.nodes[r.landmark]
    const kind = PALETTES[r.palette].landmark
    const col = columnAt(field, n.x, n.z, n.y + reliefAt(n, n.x, n.z) + 1.2)
    if (col === null) continue
    const room = col.roof - col.floor
    const off = (a, d) => ({ x: n.x + Math.cos(a) * d, z: n.z + Math.sin(a) * d })
    // A landmark never sits on the passage lines; it stands off the middle to the clearest side.
    let at = null
    for (let k = 0; k < 12 && at === null; k++) {
      const p = off(rand() * 6.28, Math.min(n.rx, n.rz) * rr(0.25, 0.5))
      if (clear(n, p.x, p.z, kind === 'pillar' || kind === 'column' ? 4 : 1.6)) at = p
    }
    if (at === null) continue
    const c = columnAt(field, at.x, at.z, n.y + reliefAt(n, at.x, at.z) + 1.2)
    if (c === null) continue
    if (kind === 'pillar' || kind === 'column') {
      // A giant stalagmite (slim for a column) at most 55% of the way to the roof, its giant stalactite over it. The roof is re-read from just over the found floor: the relief's guess can start above an overhang.
      const foot = columnAt(field, at.x, at.z, c.floor + 0.5)
      if (foot === null) continue
      const room2 = foot.roof - c.floor
      const ml = room2 * rr(0.42, 0.55), tl = Math.min(ml * rr(0.65, 0.9), room2 * 0.9 - ml)
      const r0 = Math.min(ml * (kind === 'pillar' ? 0.2 : 0.13), 3)
      out.mites.push({ x: at.x, y: c.floor, z: at.z, len: ml, r: r0, seed: rand() })
      out.tites.push({ x: at.x, y: foot.roof, z: at.z, len: tl, r: Math.min(tl * 0.16, 2.4), seed: rand() })
      block(at.x, at.z, r0 * 1.4, c.floor, c.floor + ml)
    } else if (kind === 'giant') {
      if (drowned(at.x, c.floor, at.z)) continue
      const h = Math.min(room - 0.6, rr(6, 9))
      const glow = regionGlow[r.i]
      out.mush.push({ x: at.x, y: c.floor, z: at.z, h, lean: rr(-0.1, 0.1), yaw: rand() * 6.28, glow, seed: rand(), giant: true, region: r.i, up: UP })
      block(at.x, at.z, h * 0.08, c.floor, c.floor + h)
      out.lights.push({ x: at.x, y: c.floor + h, z: at.z, color: glow, reach: 24, power: 0.7 })
    } else {
      // An arch, or a colonnade: columns in a row with lintels across.
      const yaw = rand() * 3.14
      const count = kind === 'arch' ? 2 : 5
      const gap = kind === 'arch' ? 2.4 : 2.8
      let prev = null
      for (let k = 0; k < count; k++) {
        const d = (k - (count - 1) / 2) * gap
        const x = at.x + Math.cos(yaw) * d, z = at.z + Math.sin(yaw) * d
        const cc = columnAt(field, x, z, n.y + reliefAt(n, x, z) + 1.2)
        if (cc === null || !clear(n, x, z, 0.6)) { prev = null; continue }
        const top = cc.floor + Math.min(cc.roof - cc.floor - 0.5, 4.2)
        for (let y = cc.floor - 0.1; y < top; y += 0.9) out.ruins.push({ x, y, z, w: 0.75, h: Math.min(0.9, top - y), yaw, tilt: 0 })
        block(x, z, 0.45, cc.floor, top)
        if (prev !== null) out.ruins.push({ x: (x + prev.x) / 2, y: Math.min(top, prev.top), z: (z + prev.z) / 2, w: 0.7, h: 0.6, yaw, tilt: 0, span: gap + 0.75 })
        prev = { x, z, top }
      }
    }
  }

  // The graph's own glows: a cluster of glowing caps at each, bright enough to read across a chamber.
  for (const g of graph.glows) {
    const n = graph.nodes[g.node]
    const col = columnAt(field, g.x, g.z, n.y + reliefAt(n, g.x, g.z) + 1.2)
    if (col === null || !clear(n, g.x, g.z, 0.5)) continue
    const h = Math.min(col.roof - col.floor - 0.5, rr(1.2, n.kind === 'cavern' ? 4.5 : 2.6))
    if (h < 0.8 || drowned(g.x, col.floor, g.z)) continue
    out.mush.push({ x: g.x, y: col.floor, z: g.z, h, lean: rr(-0.12, 0.12), yaw: rand() * 6.28, glow: g.color, seed: rand(), region: n.region, up: UP })
    for (let k = 0; k < 6; k++) {
      const a = rand() * 6.28, d = rr(0.4, 1.6)
      const x = g.x + Math.cos(a) * d, z = g.z + Math.sin(a) * d
      if (!drowned(x, col.floor, z)) out.mush.push({ x, y: col.floor, z, h: rr(0.15, 0.6), lean: rr(-0.2, 0.2), yaw: rand() * 6.28, glow: g.color, seed: rand(), region: n.region, up: UP })
    }
    if (h > MITE_BLOCKS) block(g.x, g.z, h * 0.07, col.floor, col.floor + h)
    out.lights.push({ x: g.x, y: col.floor + h, z: g.z, color: g.color, reach: g.reach * 1.4, power: 0.6 })
  }

  // Along the passages: pebbles, a few small stones against the walls, and at a braid's `choke` (graph.js) a rockfall filling it wall to wall and floor to roof, an obstacle she cannot pass.
  for (const e of graph.edges) {
    const len = e.pts[e.pts.length - 1].s
    for (let k = Math.round(len / PEBBLE_STEP); k > 0; k--) {
      const p = alongPts(e.pts, rr(0, len)), u = rr(-0.6, 0.6) * e.pts[e.pts.length >> 1].w
      if (p !== null) strew(p.x - p.dz * u, p.y, p.z + p.dx * u)
    }
    for (let k = Math.round((len / 5) * rand()); k > 0; k--) {
      const p = alongPts(e.pts, rr(3, Math.max(3, len - 3))), side = rand() < 0.5 ? 1 : -1
      if (p === null || !rayRock(field, p.x, p.y + 0.4, p.z, -p.dz * side, 0, p.dx * side, 5, hit)) continue
      const r = rr(0.12, 0.4)
      const y = surface(field, hit[0] + p.dz * side * r, hit[2] - p.dx * side * r, p.y + 0.8, -1, 2.5)
      if (y !== null) stone(hit[0] + p.dz * side * r, y - 0.3 * r, hit[2] - p.dx * side * r, r)
    }
    if (e.choke === null) continue
    const p = alongPts(e.pts, e.choke)
    const col = columnAt(field, p.x, p.z, p.y + 1)
    if (col === null) throw new Error(`caves/props: choke on edge ${e.i} is in rock`)
    const reach = 2 * e.pts.reduce((m, q) => (Math.abs(q.s - e.choke) < Math.abs(m.s - e.choke) ? q : m)).w + 1
    const wide = [0, 0]
    for (let y = col.floor + 0.3; y < col.roof; y += 0.65) {
      const half = [-1, 1].map((sd) => (rayRock(field, p.x, y, p.z, -p.dz * sd, 0, p.dx * sd, reach, hit) ? Math.hypot(hit[0] - p.x, hit[2] - p.z) : reach))
      wide[0] = Math.max(wide[0], half[0]); wide[1] = Math.max(wide[1], half[1])
      for (const along of [-0.45, 0.45]) {
        for (let u = -half[0]; u < half[1] + 0.3; u += 0.85) {
          const v = along + rr(-0.2, 0.2)
          stone(p.x + p.dx * v - p.dz * u, y + rr(-0.15, 0.15), p.z + p.dz * v + p.dx * u, rr(0.5, 0.85))
        }
      }
    }
    for (let k = 0; k < 12; k++) {
      const v = (k % 2 === 0 ? 1 : -1) * rr(0.9, 2.6), u = rr(-0.8, 0.8)
      const x = p.x + p.dx * v - p.dz * u, z = p.z + p.dz * v + p.dx * u
      const y = surface(field, x, z, p.y + 1, -1, 3)
      if (y !== null) stone(x, y - 0.1, z, rr(0.15, 0.45))
    }
    for (let u = -wide[0]; u <= wide[1]; u += 0.5) block(p.x - p.dz * u, p.z + p.dx * u, 0.4, col.floor - 1, col.roof + 1)
  }
  // Seated, a floor cap may sink under a pool's edge, and is dropped. A wall clump on rock that faces up is seated as one.
  out.mush = out.mush.filter((m) => m.up[1] <= 0.9 || (plant(field, m), !drowned(m.x, m.y, m.z)))
  return out
}

// The widest stem base of the mushroom species (mushroom-bank.js's barrel), per metre of height.
export const MUSH_FOOT = 0.28
// How far a floor mushroom tilts from upright toward its ground's normal.
const MUSH_TILT = 0.6

// Seats floor mushroom m on the ground under its whole base: tilted part way to the slope its footprint samples, and sunk until no point of its base disc stands over air.
function plant(field, m) {
  const R = MUSH_FOOT * m.h, reach = 0.3 + 1.2 * R
  const floorAt = (x, z) => {
    const y = nearFloor(field, x, z, m.y, reach)
    if (y !== null) return y
    return field.at(x, m.y, z) > 0 ? m.y + reach : m.y - reach
  }
  const rim = []
  let sx = 0, sz = 0, sxx = 0, szz = 0
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2, dx = Math.cos(a) * R, dz = Math.sin(a) * R
    const y = floorAt(m.x + dx, m.z + dz)
    rim.push({ dx, dz, y })
    sx += dx * y; sz += dz * y; sxx += dx * dx; szz += dz * dz
  }
  const c = floorAt(m.x, m.z)
  if (R > 1e-3) {
    // The least-squares slope through the rim (a wall's rock counted a rise), tilted MUSH_TILT of the way, never past about 27 degrees.
    let gx = sx / sxx, gz = sz / szz
    const g = Math.hypot(gx, gz) * MUSH_TILT
    if (g > 0.5) { gx *= 0.5 / g; gz *= 0.5 / g }
    const nx = -gx * MUSH_TILT, nz = -gz * MUSH_TILT
    const l = Math.hypot(nx, 1, nz)
    m.up = [nx / l, 1 / l, nz / l]
    m.y = Math.min(c, ...rim.map((p) => p.y - MUSH_TILT * (gx * p.dx + gz * p.dz)))
  } else {
    m.y = c
  }
  // The rim samples miss the bump between them: sink on until no point of the tilted base disc is in air.
  const [ux, uy, uz] = m.up
  const t1 = [uy, -ux, 0], tl = Math.hypot(uy, ux)
  t1[0] /= tl; t1[1] /= tl
  const t2 = [uy * t1[2] - uz * t1[1], uz * t1[0] - ux * t1[2], ux * t1[1] - uy * t1[0]]
  for (let pass = 0; pass < 8; pass++) {
    let gap = 0
    for (let k = 0; k < 48; k++) {
      const ca = Math.cos((k / 48) * Math.PI * 2) * R, sa = Math.sin((k / 48) * Math.PI * 2) * R
      gap = Math.max(gap, -field.at(m.x + ca * t1[0] + sa * t2[0], m.y + ca * t1[1] + sa * t2[1], m.z + ca * t1[2] + sa * t2[2]))
    }
    if (gap <= 0.02) break
    m.y -= gap + 0.02
  }
}

// The floor (rock under air) on the vertical through (x, z) nearest `y`, within `reach` metres either way, or null.
function nearFloor(field, x, z, y, reach) {
  let best = null
  let below = field.at(x, y - reach, z) > 0
  for (let t = y - reach + 0.05; t <= y + reach; t += 0.05) {
    const rock = field.at(x, t, z) > 0
    if (below && !rock && (best === null || Math.abs(t - y) < Math.abs(best - y))) best = t - 0.025
    below = rock
  }
  return best
}

const UP = [0, 1, 0]
const TORCHLIGHT = { color: [0.9, 0.55, 0.25], reach: 7, power: 0.7 }
// A wall torch's lean out from the wall off upright, and how deep its foot is set in the rock.
export const TORCH_LEAN = 0.6
const TORCH_SINK = 0.12
// Lights one great cavern's groves may bake into the rock.
const GROVE_LIGHTS = 24
// Glowing floor caps a chamber needs for a fill light and ferns, and the fill's longest reach.
const FILL_GLOWS = 5
const FILL_REACH = 20

// The unit normal out of the rock at p (the field is positive in rock), into `out`.
function outward(field, p, out) {
  const e = 0.03
  out[0] = field.at(p[0] - e, p[1], p[2]) - field.at(p[0] + e, p[1], p[2])
  out[1] = field.at(p[0], p[1] - e, p[2]) - field.at(p[0], p[1] + e, p[2])
  out[2] = field.at(p[0], p[1], p[2] - e) - field.at(p[0], p[1], p[2] + e)
  const l = Math.hypot(out[0], out[1], out[2])
  if (l < 1e-9) throw new Error('caves/props: no gradient at a wall point')
  out[0] /= l; out[1] /= l; out[2] /= l
}

// The point `at` metres along a polyline, with its unit plan heading, or null past its end.
function alongPts(pts, at) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const p = pts[k], q = pts[k + 1], l = Math.hypot(q.x - p.x, q.z - p.z)
    if (at <= l) { const u = at / l; return { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, z: p.z + (q.z - p.z) * u, dx: (q.x - p.x) / l, dz: (q.z - p.z) / l } }
    at -= l
  }
  return null
}

function segDist(x, z, a, b) {
  const ex = b.x - a.x, ez = b.z - a.z
  const l2 = ex * ex + ez * ez
  let u = l2 > 0 ? ((x - a.x) * ex + (z - a.z) * ez) / l2 : 0
  u = u < 0 ? 0 : u > 1 ? 1 : u
  return Math.hypot(x - a.x - u * ex, z - a.z - u * ez)
}
