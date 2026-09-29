// Node-side gates for the procedural leafkin house (src/v2/render/house-exterior.js, design/36-leafkin-houses.md).
//
//   node scripts/check-leafkin-house.mjs
//
// A spread of seeds and village heights builds deterministically, in the prop material's layout, all finite, inside the triangle and build-time budgets, with the door on +X at the floor and every window on the trunk.

import { HOUSE_KINDS, buildHouse, rollHouse } from '../src/v2/render/house-exterior.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1)
const heightOf = (s) => 3.75 + ((s * 0.618) % 1) * (9.4 - 3.75)
const houses = SEEDS.map((s) => ({ s, spec: rollHouse(s, heightOf(s)) }))
// Warm the JIT so the timing check measures steady state, as the glade's second house would.
for (const { spec } of houses.slice(0, 3)) buildHouse(spec)
const built = houses.map(({ s, spec }) => ({ s, spec, h: buildHouse(spec) }))

const a = buildHouse(rollHouse(7, 6)).geometry.getAttribute('position').array
const b = buildHouse(rollHouse(7, 6)).geometry.getAttribute('position').array
check(a.length === b.length && a.every((v, i) => v === b[i]), 'a seed builds the same house twice')
const c = buildHouse(rollHouse(8, 6)).geometry.getAttribute('position').array
check(a.length !== c.length || a.some((v, i) => v !== c[i]), 'neighbouring seeds build different houses')

const layout = { position: 3, normal: 3, color: 3, uvProj: 2, texLayer: 1 }
const badLayout = built.filter(({ h }) => Object.entries(layout).some(([n, size]) => !h.geometry.getAttribute(n) || h.geometry.getAttribute(n).itemSize !== size))
check(!badLayout.length, "every house carries the prop material's attributes", badLayout.map((x) => x.s).join(' '))
const finite = (g) => Object.values(g.attributes).every((attr) => attr.array.every(Number.isFinite))
const nonFinite = built.filter(({ h }) => !finite(h.geometry) || !finite(h.glow))
check(!nonFinite.length, 'every attribute is finite', nonFinite.map((x) => x.s).join(' '))

const tris = built.map(({ h }) => h.stats.triangles)
check(Math.max(...tris) <= 8000, 'every house is under 8k triangles', `${Math.min(...tris)}..${Math.max(...tris)}`)
const roofs = built.map(({ h }) => h.stats.roofTriangles)
check(Math.max(...roofs) <= 250, 'every roof cap is under 250 triangles', `${Math.min(...roofs)}..${Math.max(...roofs)}`)
const ms = built.map(({ h }) => h.stats.ms).sort((x, y) => x - y)
check(ms[Math.floor(ms.length / 2)] < 12, 'the median house builds in under 12 ms on this machine', `median ${ms[Math.floor(ms.length / 2)].toFixed(1)} ms, worst ${ms[ms.length - 1].toFixed(1)} ms`)

const doorOff = built.filter(({ spec, h }) => {
  const d = h.door
  return !(d.n[0] > 0.9 && Math.abs(d.p[2]) < 0.2 && d.p[0] > 0.5 && Math.abs(d.p[1] - spec.sill) < 0.12)
})
check(!doorOff.length, 'the door faces +X at its sill on the trunk', doorOff.map((x) => x.s).join(' '))
const winOff = built.filter(({ h }) => h.windows.some((w) => {
  const r = Math.hypot(w.p[0], w.p[2])
  return w.p[1] < 0.6 || w.p[1] > h.eave.y || r < h.trunk.r * 0.6 || Math.abs(Math.hypot(w.n[0], w.n[2]) - 1) > 0.1
}))
check(!winOff.length, 'every window sits on the trunk wall below the eave, facing out', winOff.map((x) => x.s).join(' '))
// The builder spaces frames by the trunk's bare radius, so the built wall's noise gets 10 cm of slack.
const crowded = built.filter(({ h }) => h.windows.some((a, i) => h.windows.slice(i + 1).some((b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) - a.r - b.r - 0.2 < 0.9)))
check(!crowded.length, 'window frames stand at least 1 m apart', crowded.map((x) => x.s).join(' '))
const tall = built.filter(({ spec, h }) => Math.abs(h.top - spec.height) > 0.8)
check(!tall.length, 'the roof tip lands near the rolled height', tall.map((x) => `${x.s}:${x.h.top.toFixed(2)}/${x.spec.height.toFixed(2)}`).join(' '))

for (const [key, kinds] of Object.entries(HOUSE_KINDS)) {
  const seen = new Set(built.map(({ spec }) => spec[key]))
  check(kinds.every((k) => seen.has(k)), `40 seeds roll every ${key}`, [...seen].join(' '))
}
for (const [key, kinds] of Object.entries(HOUSE_KINDS)) for (const k of kinds) {
  const h = buildHouse({ ...rollHouse(3, 5), [key]: k })
  check(h.stats.triangles > 1000 && finite(h.geometry), `${key} ${k} builds`, `${h.stats.triangles} tris`)
}

console.log(failures ? `\n${failures} failure(s)` : '\nall leafkin house checks pass')
process.exit(failures ? 1 : 0)
