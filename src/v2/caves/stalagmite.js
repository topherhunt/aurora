// The one dripstone model (design/39-caves.md §6): lumpy, lopsided, 104 triangles, its base ring at y 0 with radius about 1 and its tip at y 1. Drawn pointing down it is a stalactite. Pure and seeded; gen-stalagmite.html shows it.

import { mulberry32 } from '../../sim/mathx.js'

const TAU = Math.PI * 2
const SIDES = 8
const RINGS = 6

/** { position: Float32Array, index: Uint16Array } for the dripstone of `seed`. Ring 0 is a skirt below y 0, so the base sinks into floor or roof. */
export function stalagmite(seed) {
  const rand = mulberry32(seed)
  const rr = (a, b) => a + (b - a) * rand()
  // The spine bows toward `la` and kinks sideways toward `ka`; the section is an ellipse squashed across `sa`.
  const la = rand() * TAU, lean = rr(0.08, 0.4)
  const ka = rand() * TAU, kink = rr(-0.18, 0.18)
  const sa = rand() * TAU, squash = rr(0.65, 1)
  const taper = rr(0.55, 1.3)
  const lumps = Array.from({ length: 4 + Math.floor(rand() * 4) }, () => ({ y: rr(0.05, 0.75), a: rand() * TAU, amp: rr(0.2, 0.6), sy: rr(0.06, 0.18), sa: rr(0.4, 1.1) }))
  const spine = (y) => {
    const b = lean * y * y, k = kink * Math.sin(Math.PI * y)
    return [Math.cos(la) * b + Math.cos(ka) * k, Math.sin(la) * b + Math.sin(ka) * k]
  }
  const pos = []
  for (let r = 0; r <= RINGS; r++) {
    const y = r === 0 ? -0.15 : Math.pow((r - 1) / RINGS, 0.85) * 0.92
    const [cx, cz] = spine(Math.max(0, y))
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * TAU + (rand() - 0.5) * 0.35
      let bump = 1
      for (const l of lumps) {
        const da = Math.atan2(Math.sin(a - l.a), Math.cos(a - l.a))
        bump += l.amp * Math.exp(-(((y - l.y) / l.sy) ** 2) - (da / l.sa) ** 2)
      }
      const ell = 1 - (1 - squash) * Math.sin(a - sa) ** 2
      const rad = (r === 0 ? 1.15 : Math.pow(1 - y, taper)) * bump * ell * rr(0.85, 1.15)
      pos.push(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad)
    }
  }
  const [tx, tz] = spine(1)
  pos.push(tx + rr(-0.05, 0.05), 1, tz + rr(-0.05, 0.05))
  const idx = []
  for (let r = 0; r < RINGS; r++) {
    for (let s = 0; s < SIDES; s++) {
      const a = r * SIDES + s, b = r * SIDES + ((s + 1) % SIDES)
      idx.push(a, a + SIDES, b, b, a + SIDES, b + SIDES)
    }
  }
  const apex = (RINGS + 1) * SIDES
  for (let s = 0; s < SIDES; s++) idx.push(RINGS * SIDES + s, apex, RINGS * SIDES + ((s + 1) % SIDES))
  return { position: Float32Array.from(pos), index: Uint16Array.from(idx) }
}
