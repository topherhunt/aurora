// Node-side gates for seated play (src/v2/eye-level.js): every wearer's eye lifted or lowered to one standing height.
//
//   node scripts/check-eye-level.mjs
//
// What can go wrong without throwing: a seated wearer left low; a lift that jumps rather than eases; a bed's gaze at the ceiling read as her height and lifting her while she lies; a lift that keeps re-offsetting the space every frame.

import { EyeLevel, STAND_EYE_M, LIFT_MAX_M, LIFT_RATE_M_S, LIFT_STEP_M } from '../src/v2/eye-level.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const DT = 1 / 72

// Drives `e` with a wearer whose real eye is at `real`, looking at `pitch`, for `seconds`; returns the reference-space re-offsets.
function wear(e, real, pitch, seconds) {
  const lifts = []
  for (let t = 0; t < seconds; t += DT) {
    const d = e.update(DT, real + e.applied, pitch)
    if (d !== 0) lifts.push(d)
  }
  return lifts
}

console.log('a seated wearer')
{
  const e = new EyeLevel()
  const lifts = wear(e, 1.15, 0, 10)
  check(Math.abs(e.applied - (STAND_EYE_M - 1.15)) < 1e-9, `is lifted to a standing eye at ${STAND_EYE_M} m`, `lift ${e.applied.toFixed(3)}`)
  check(lifts.every((d) => d > 0 && d <= LIFT_STEP_M + LIFT_RATE_M_S * DT + 1e-9), 'in small upward steps, never a jump', `largest ${Math.max(...lifts).toFixed(4)} m over ${lifts.length} steps`)
  check(wear(e, 1.15, 0, 5).length === 0, 'and once there the space is left alone')
  const duck = wear(e, 0.8, 0, 3)
  check(duck.length === 0, 'a duck of a few seconds is a duck, not a new height')
}

console.log('a standing wearer')
{
  const e = new EyeLevel()
  wear(e, 1.75, 0, 10)
  check(Math.abs(e.applied - (STAND_EYE_M - 1.75)) < 1e-9, 'a tall one is lowered to the same eye', `lift ${e.applied.toFixed(3)}`)
  const f = new EyeLevel()
  wear(f, 0.3, 0, 30)
  check(f.applied === LIFT_MAX_M, `a lift is held to ${LIFT_MAX_M} m`, `lift ${f.applied}`)
}

console.log('lying in a bed')
{
  const e = new EyeLevel()
  wear(e, 1.6, 0, 10)
  const lifts = wear(e, 0.4, Math.PI / 2 - 0.1, 120)
  check(lifts.length === 0 && Math.abs(e.applied) < 1e-9, 'gazing at the ceiling for two minutes is never sampled', `lift ${e.applied.toFixed(3)}`)
}

console.log('reset')
{
  const e = new EyeLevel()
  wear(e, 1.1, 0, 10)
  e.reset()
  check(e.applied === 0 && e.count === 0 && wear(e, 1.6, 0, 3).length === 0, 'forgets the lift and the samples')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
