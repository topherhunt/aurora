// Node-side gate for mining a vein with the pickaxe (src/v2/pickaxe.js).
//
//   node scripts/check-pickaxe.mjs
//
// What can go wrong without throwing: a pick held still against a vein counting a strike a frame, slow taps or strikes spread over minutes prying it loose, strikes on two veins adding up.

import { PICK, Pick } from '../src/v2/pickaxe.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const a = { id: 'a', x: 0, y: 1, z: 0 }
const b = { id: 'b', x: 2, y: 1, z: 0 }
const veins = [a, b]
const on = (v) => [{ x: v.x + PICK.reach / 2, y: v.y, z: v.z }]
const off = [{ x: 0, y: 1, z: 5 }]

{
  const p = new Pick()
  let got = null, frames = 0
  for (let s = 0; s < PICK.strikes; s++) {
    // Each swing: the head in reach for three frames, then away.
    for (let f = 0; f < 3; f++) { got = got ?? p.step(on(a), veins, s + f / 60); frames++ }
    p.step(off, veins, s + 0.5)
  }
  check(got === a, `${PICK.strikes} fast strikes on a vein pry it loose`, `${frames} frames in reach`)
}
{
  const p = new Pick()
  let got = null
  for (let f = 0; f < 60; f++) got = got ?? p.step(on(a), veins, f / 60)
  check(got === null && p.count === 1, 'held against it a second, a pick has struck once', `${p.count}`)
}
{
  const p = new Pick()
  let got = null
  for (let s = 0; s < PICK.strikes; s++) { got = got ?? p.step([], veins, s); p.step(off, veins, s + 0.5) }
  check(got === null && p.count === 0, 'too slow to count, tapping it does nothing')
}
{
  const p = new Pick()
  let got = null
  for (let s = 0; s < PICK.strikes; s++) { got = got ?? p.step(on(a), veins, s * (PICK.gapS + 1)); p.step(off, veins, s * (PICK.gapS + 1) + 0.5) }
  check(got === null && p.count === 1, `strikes more than ${PICK.gapS} s apart start over`, `${p.count}`)
}
{
  const p = new Pick()
  let got = null
  const order = [a, a, b, a]
  order.forEach((v, s) => { got = got ?? p.step(on(v), veins, s); p.step(off, veins, s + 0.5) })
  check(got === null && p.vein === a && p.count === 1, 'a strike on another vein starts over on that one')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
