// The one dripstone model (design/39-caves.md §6): lumpy, lopsided, 400 triangles, its base ring at y 0 with radius about 1 and its tip at y 1, and the card that stands in for it far off. Drawn pointing down it is a stalactite. Pure and seeded; gen-stalagmite.html shows both.

import { mulberry32 } from '../../sim/mathx.js'

const TAU = Math.PI * 2
const SIDES = 16
const RINGS = 12
// The card's base below y 0, matching the skirt ring.
const SKIRT = -0.15

/** { position: Float32Array, index: Uint16Array } for the dripstone of `seed`. Ring 0 is a skirt below y 0, so the base sinks into floor or roof. */
export function stalagmite(seed) {
  const rand = mulberry32(seed)
  const rr = (a, b) => a + (b - a) * rand()
  // The spine bows toward `la` and kinks sideways toward `ka`; the section is an ellipse squashed across `sa`, fluted by `flutes` shallow grooves that twist up it.
  const la = rand() * TAU, lean = rr(0.08, 0.4)
  const ka = rand() * TAU, kink = rr(-0.18, 0.18)
  const sa = rand() * TAU, squash = rr(0.65, 1)
  const taper = rr(0.55, 1.3)
  const flutes = 3 + Math.floor(rand() * 4), twist = rr(-2, 2), flute = rr(0.03, 0.09), fa = rand() * TAU
  const lumps = Array.from({ length: 5 + Math.floor(rand() * 5) }, () => ({ y: rr(0.05, 0.8), a: rand() * TAU, amp: rr(0.15, 0.55), sy: rr(0.05, 0.16), sa: rr(0.35, 1) }))
  const spine = (y) => {
    const b = lean * y * y, k = kink * Math.sin(Math.PI * y)
    return [Math.cos(la) * b + Math.cos(ka) * k, Math.sin(la) * b + Math.sin(ka) * k]
  }
  const pos = []
  for (let r = 0; r <= RINGS; r++) {
    const y = r === 0 ? SKIRT : Math.pow((r - 1) / RINGS, 0.85) * 0.94
    const [cx, cz] = spine(Math.max(0, y))
    for (let s = 0; s < SIDES; s++) {
      const a = (s / SIDES) * TAU + (rand() - 0.5) * 0.15
      let bump = 1 + flute * Math.cos(flutes * a + twist * y + fa)
      for (const l of lumps) {
        const da = Math.atan2(Math.sin(a - l.a), Math.cos(a - l.a))
        bump += l.amp * Math.exp(-(((y - l.y) / l.sy) ** 2) - (da / l.sa) ** 2)
      }
      const ell = 1 - (1 - squash) * Math.sin(a - sa) ** 2
      const rad = (r === 0 ? 1.15 : Math.pow(1 - y, taper)) * bump * ell * rr(0.93, 1.07)
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

/**
 * The far card of `seed`'s dripstone, baked on the CPU from its rings: its silhouette seen along z, `w` x `h` RGBA8 texels with a rounded shade in R (0.5 at the rim to 1 down its middle) and coverage in A. The card spans x in [-half, half] and y from SKIRT to 1 in the model's own units, and is drawn spun about its axis to face the eye, so it reads the same from every side.
 * Returns { data, half, y0 }.
 */
export function stalagmiteCard(seed, w, h) {
  const { position } = stalagmite(seed)
  const rings = []
  for (let r = 0; r <= RINGS; r++) {
    let lo = Infinity, hi = -Infinity
    for (let s = 0; s < SIDES; s++) {
      const x = position[(r * SIDES + s) * 3]
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
    rings.push({ y: position[r * SIDES * 3 + 1], lo, hi })
  }
  const apex = position.length - 3
  rings.push({ y: 1, lo: position[apex], hi: position[apex] })
  const half = Math.max(...rings.map((r) => Math.max(-r.lo, r.hi))) * 1.02
  const data = new Uint8Array(w * h * 4)
  for (let v = 0; v < h; v++) {
    const y = SKIRT + ((v + 0.5) / h) * (1 - SKIRT)
    let k = 0
    while (k + 2 < rings.length && rings[k + 1].y < y) k++
    const a = rings[k], b = rings[k + 1]
    const t = Math.min(1, Math.max(0, (y - a.y) / (b.y - a.y)))
    const lo = a.lo + (b.lo - a.lo) * t, hi = a.hi + (b.hi - a.hi) * t
    const mid = (lo + hi) / 2, rad = (hi - lo) / 2
    for (let u = 0; u < w; u++) {
      const x = -half + ((u + 0.5) / w) * 2 * half
      const texel = (2 * half) / w
      const cover = Math.min(1, Math.max(0, (rad - Math.abs(x - mid)) / texel + 0.5))
      const across = rad > 1e-6 ? Math.min(1, Math.abs(x - mid) / rad) : 1
      const o = (v * w + u) * 4
      data[o] = data[o + 1] = data[o + 2] = Math.round(255 * (0.5 + 0.5 * Math.sqrt(1 - across * across)))
      data[o + 3] = Math.round(255 * cover)
    }
  }
  return { data, half, y0: SKIRT }
}
