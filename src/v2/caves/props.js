// What stands in the cave (design/39-caves.md §6): dripstone, mushrooms, ruin columns, chalk, each region's landmark, and the spots fish and crabs keep to. Pure and seeded.
//
// Anything she cannot step past (a stalagmite over a metre, a column, a giant stem) is kept CLEAR of every passage line into its node, so dressing can never close a route the graph promised; check-caves.mjs walks the routes to prove it.

import { mulberry32 } from '../../sim/mathx.js'
import { PALETTES, GLOWS } from './regions.js'

// A stalagmite this tall is a trunk to her.
export const MITE_BLOCKS = 1.0
// Plan metres any obstacle keeps from a passage's line.
const CLEAR = 2.0

/** Floor and roof on the vertical through (x, z), marching from `y` (in air): { floor, roof } or null when `y` is in rock. */
export function columnAt(field, x, z, y) {
  if (field.at(x, y, z) > 0) return null
  let floor = y, roof = y
  while (field.at(x, floor, z) <= 0 && floor > y - 60) floor -= 0.1
  while (field.at(x, roof, z) <= 0 && roof < y + 60) roof += 0.1
  return { floor: floor + 0.05, roof: roof - 0.05 }
}

export function placeProps(graph, field, seed) {
  const rand = mulberry32(seed ^ 0x9f05)
  const rr = (a, b) => a + (b - a) * rand()
  const out = { mites: [], tites: [], mush: [], ruins: [], chalk: [], fish: [], crabs: [], obstacles: [], lights: [] }
  const lines = graph.nodes.map(() => [])
  for (const e of graph.edges) { lines[e.a].push(e.pts); lines[e.b].push(e.pts) }
  const clear = (n, x, z, pad) => lines[n.i].every((pts) => pts.every((p, k) => k + 1 >= pts.length || segDist(x, z, p, pts[k + 1]) > CLEAR + pad))
  const block = (x, z, r, y0, y1) => out.obstacles.push({ x, z, r: r + 0.3, y0, y1 })

  // A random spot on node n's floor at normalised radius rho0..rho1.
  const spot = (n, rho0, rho1) => {
    const a = rand() * Math.PI * 2, rho = Math.sqrt(rr(rho0 * rho0, rho1 * rho1))
    const lx = Math.cos(a) * rho * n.rx, lz = Math.sin(a) * rho * n.rz
    const c = Math.cos(n.rot), s = Math.sin(n.rot)
    const x = n.x + lx * c - lz * s, z = n.z + lx * s + lz * c
    const col = columnAt(field, x, z, n.y + 1.2)
    if (col === null || col.floor < n.y - 0.6 || col.roof - col.floor < 2) return null
    return { x, z, y: col.floor, roof: col.roof }
  }

  for (const n of graph.nodes) {
    if (n.kind === 'mouth') continue
    const pal = PALETTES[graph.regions[n.region].palette]
    const area = n.rx * n.rz
    const big = n.kind === 'cavern'

    // Dripstone: stalactites over, stalagmites under, now and then the two met as a column.
    const drips = Math.round(area * 0.12 * pal.tites)
    for (let k = 0; k < drips; k++) {
      const p = spot(n, 0.15, 0.95)
      if (p === null) continue
      const room = p.roof - p.y
      const tl = Math.min(room * 0.35, rr(0.3, big ? 6 : 2.2))
      out.tites.push({ x: p.x, y: p.roof, z: p.z, len: tl, r: tl * rr(0.1, 0.16), seed: rand() })
      if (rand() < 0.55) {
        let ml = Math.min(room * 0.3, rr(0.2, big ? 4 : 1.8))
        const r = ml * rr(0.18, 0.26)
        if (ml > MITE_BLOCKS && !clear(n, p.x, p.z, r)) ml = rr(0.2, 0.8)
        out.mites.push({ x: p.x, y: p.y, z: p.z, len: ml, r: Math.max(0.06, ml * 0.22), seed: rand() })
        if (ml > MITE_BLOCKS) block(p.x, p.z, ml * 0.22, p.y, p.y + ml)
      }
    }

    // Mushrooms: carpets of small ones, a few huge.
    const caps = Math.round(area * 0.06 * pal.mush)
    for (let k = 0; k < caps; k++) {
      const p = spot(n, 0.5, 0.97)
      if (p === null) continue
      const huge = rand() < 0.18
      const h = huge ? Math.min(p.roof - p.y - 0.4, rr(1.8, big ? 6 : 3.6)) : rr(0.08, 0.45)
      if (huge && (h < 1.5 || !clear(n, p.x, p.z, h * 0.6))) continue
      const glow = rand() < pal.glow * 0.4 ? GLOWS[Math.floor(rand() * GLOWS.length)] : null
      out.mush.push({ x: p.x, y: p.y, z: p.z, h, cap: h * rr(0.45, 0.7), lean: rr(-0.15, 0.15), yaw: rand() * 6.28, glow, seed: rand() })
      if (huge) block(p.x, p.z, Math.max(0.12, h * 0.07), p.y, p.y + h)
      if (glow && huge) out.lights.push({ x: p.x, y: p.y + h, z: p.z, color: glow, reach: 6 + h, power: 0.35 })
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

    // Wildlife spots: fish over a pool's deep middle, crabs round its shore.
    if (n.dish > 1.2) {
      for (let k = 0; k < Math.round(rr(2, big ? 9 : 5)); k++) out.fish.push({ node: n.i, x: n.x, z: n.z, y: n.y - 0.25 - rr(0.4, n.dish * 0.7), r: Math.min(n.rx, n.rz) * rr(0.15, 0.45), phase: rand() * 6.28, speed: rr(0.25, 0.6) })
      for (let k = 0; k < Math.round(rr(1, 4)); k++) {
        const p = spot(n, 0.6, 0.85)
        if (p !== null) out.crabs.push({ x: p.x, y: p.y, z: p.z, yaw: rand() * 6.28, seed: rand() })
      }
    }
  }

  // Each region's landmark, at its biggest chamber's middle: the thing she names the place by.
  for (const r of graph.regions) {
    if (r.landmark < 0) continue
    const n = graph.nodes[r.landmark]
    const kind = PALETTES[r.palette].landmark
    const col = columnAt(field, n.x, n.z, n.y + 1.2)
    if (col === null) continue
    const room = col.roof - col.floor
    const off = (a, d) => ({ x: n.x + Math.cos(a) * d, z: n.z + Math.sin(a) * d })
    // A landmark never sits on the passage lines; it stands off the middle to the clearest side.
    let at = null
    for (let k = 0; k < 12 && at === null; k++) {
      const p = off(rand() * 6.28, Math.min(n.rx, n.rz) * rr(0.25, 0.5))
      if (clear(n, p.x, p.z, 1.6)) at = p
    }
    if (at === null) continue
    const c = columnAt(field, at.x, at.z, n.y + 1.2)
    if (c === null) continue
    if (kind === 'pillar' || kind === 'column') {
      const r0 = kind === 'pillar' ? rr(0.9, 1.5) : rr(0.6, 0.9)
      out.mites.push({ x: at.x, y: c.floor, z: at.z, len: c.roof - c.floor + 0.3, r: r0, seed: rand(), pillar: true, fluted: kind === 'column' })
      block(at.x, at.z, r0, c.floor, c.roof)
    } else if (kind === 'giant') {
      const h = Math.min(room - 0.6, rr(6, 9))
      const glow = GLOWS[Math.floor(rand() * GLOWS.length)]
      out.mush.push({ x: at.x, y: c.floor, z: at.z, h, cap: h * 0.6, lean: rr(-0.1, 0.1), yaw: rand() * 6.28, glow, seed: rand(), giant: true })
      block(at.x, at.z, h * 0.08, c.floor, c.floor + h)
      out.lights.push({ x: at.x, y: c.floor + h, z: at.z, color: glow, reach: 18, power: 0.5 })
    } else {
      // An arch, or a colonnade: columns in a row with lintels across.
      const yaw = rand() * 3.14
      const count = kind === 'arch' ? 2 : 5
      const gap = kind === 'arch' ? 2.4 : 2.8
      let prev = null
      for (let k = 0; k < count; k++) {
        const d = (k - (count - 1) / 2) * gap
        const x = at.x + Math.cos(yaw) * d, z = at.z + Math.sin(yaw) * d
        const cc = columnAt(field, x, z, n.y + 1.2)
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
    const col = columnAt(field, g.x, g.z, n.y + 1.2)
    if (col === null || !clear(n, g.x, g.z, 0.5)) continue
    const h = Math.min(col.roof - col.floor - 0.5, rr(1.2, n.kind === 'cavern' ? 4.5 : 2.6))
    if (h < 0.8) continue
    out.mush.push({ x: g.x, y: col.floor, z: g.z, h, cap: h * 0.6, lean: rr(-0.12, 0.12), yaw: rand() * 6.28, glow: g.color, seed: rand() })
    for (let k = 0; k < 6; k++) {
      const a = rand() * 6.28, d = rr(0.4, 1.6)
      out.mush.push({ x: g.x + Math.cos(a) * d, y: col.floor, z: g.z + Math.sin(a) * d, h: rr(0.15, 0.6), cap: 0, lean: rr(-0.2, 0.2), yaw: rand() * 6.28, glow: g.color, seed: rand() })
    }
    if (h > MITE_BLOCKS) block(g.x, g.z, h * 0.07, col.floor, col.floor + h)
    out.lights.push({ x: g.x, y: col.floor + h, z: g.z, color: g.color, reach: g.reach, power: 0.45 })
  }
  for (const m of out.mush) if (m.cap === 0) m.cap = m.h * rr(0.5, 0.8)
  return out
}

function segDist(x, z, a, b) {
  const ex = b.x - a.x, ez = b.z - a.z
  const l2 = ex * ex + ez * ez
  let u = l2 > 0 ? ((x - a.x) * ex + (z - a.z) * ez) / l2 : 0
  u = u < 0 ? 0 : u > 1 ? 1 : u
  return Math.hypot(x - a.x - u * ex, z - a.z - u * ez)
}
