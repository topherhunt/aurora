// What does a bank of N baked procedural variants actually cost?
//   node scripts/probe-variants.mjs

import { buildFern, FERN_DEFAULTS } from '../src/props/fern.js'

const bytesOf = (g) => {
  let b = 0
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name]
    b += a.array.byteLength
  }
  if (g.index) b += g.index.array.byteLength
  return b
}

const attrs = (g) =>
  Object.entries(g.attributes)
    .map(([n, a]) => `${n}:${a.itemSize}x${a.array.constructor.name.replace('Array', '')}`)
    .join(' ')

// One variant at defaults, to read the shape of the data.
const g0 = buildFern(FERN_DEFAULTS)
const tris0 = g0.index.count / 3
console.log(`\ndefaults: ${tris0} tris, ${g0.attributes.position.count} verts, ${bytesOf(g0)} B`)
console.log(`attributes: ${attrs(g0)}`)

// A plausible variant bank: vary the knobs that change SHAPE, not the ones a
// per-instance transform already gives you for free (uniform scale, yaw, tint).
const AXES = {
  fronds: [5, 7, 9],
  segments: [2, 3, 4],
  pitch: [1.1, 1.35, 1.6],
  arch: [0.75, 0.95, 1.15],
  curve: [1.1, 1.35, 1.6],
}

const variantAt = (i) => {
  const p = { ...FERN_DEFAULTS }
  let n = i
  for (const [k, vals] of Object.entries(AXES)) {
    p[k] = vals[n % vals.length]
    n = Math.floor(n / vals.length)
  }
  return p
}

for (const N of [6, 12, 40]) {
  const t0 = performance.now()
  let bytes = 0
  let tris = 0
  let maxTris = 0
  for (let i = 0; i < N; i++) {
    const g = buildFern(variantAt(i))
    bytes += bytesOf(g)
    const t = g.index.count / 3
    tris += t
    if (t > maxTris) maxTris = t
    g.dispose()
  }
  const ms = performance.now() - t0
  console.log(
    `${String(N).padStart(3)} variants: ${(bytes / 1024).toFixed(1)} KB, ` +
      `${tris} tris total, ${(tris / N).toFixed(0)} avg / ${maxTris} max per variant, ` +
      `built in ${ms.toFixed(1)} ms`
  )
}

// The low tier, which every variant also needs.
const lo = buildFern({ ...FERN_DEFAULTS, fronds: 4, segments: 1 })
console.log(`\nLOD1 (4 fronds, 1 segment): ${lo.index.count / 3} tris, ${bytesOf(lo)} B`)

// And a card, for scale.
console.log(`card (1 quad): 2 tris, ${4 * 32 + 6 * 2} B if it shares the same vertex layout`)
