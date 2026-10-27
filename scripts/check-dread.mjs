// Node-side gates for townsfolk fleeing a dragon (src/v2/render/townsfolk.js _flee, TOWNSFOLK.dread).
//
//   node scripts/check-dread.mjs
//
// What can go wrong without throwing: a townsperson running toward the dragon or never coming back to its sim, screaming every frame, or a rider or one in talk with her bolting.

import { TOWNSFOLK, Townsfolk } from '../src/v2/render/townsfolk.js'
import { TRADES } from '../src/v2/layers/trades.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const D = TOWNSFOLK.dread

/** A layer with only what the pose reads, and a `body` standing at the origin on its sim. */
function standing(body = 'blacksmith') {
  const T = Object.create(Townsfolk.prototype)
  T.bodies = TRADES.bodies.map(() => ({ durations: { idle: 2, walk: 1, run: 0.7 }, gait: { walk: 1.2, run: 3.5 } }))
  T.walk = { heightAt: () => 0 }
  T.dread = []
  T.screamed = []
  T._shove = () => {}
  const c = { body: TRADES.bodies.indexOf(body), k: 1, size: 1.7, pace: 1, graph: null, x: 0, z: 0, y: 0, px: 0, pz: 0, py: 0, heading: 0, ph: 0, hop: 0, phop: 0, mount: null, job: null, state: 'stand', hidden: false, clip: 'idle', cue: 1, from: -1, speed: 0, greet: null, lag: false, flee: null, scream: 0, saddle: null, cool: 0, gcue: 0, shove: { x: 0, z: 0 }, pose: { x: 0, y: 0, z: 0, heading: 0, hop: 0 } }
  const far = { x: 100, z: 100 }
  const frame = (t, dt = 1 / 30) => T._pose(c, 1, far, t, dt)
  return { T, c, frame }
}

{
  const { T, c, frame } = standing('blacksmith')
  const dragon = { x: -10, y: 2, z: 0 }
  T.dread = [dragon]
  let t = 0
  frame(t)
  check(c.flee !== null && c.lag && c.pose.clip === 'run', 'a dragon 10 m off sets a townsperson running', `clip ${c.pose.clip}`)
  for (; t < 2; t += 1 / 30) frame(t)
  check(c.pose.x > 5 && Math.abs(c.pose.z) < 1e-6, 'it runs straight away from the dragon', `at (${c.pose.x.toFixed(2)}, ${c.pose.z.toFixed(2)})`)
  const said = T.screams([])
  check(said.length === 1 && /^humanScreamMan[12]$/.test(said[0].sound), 'it screams once as it bolts, in its body\'s voice', said.map((v) => v.sound).join(', '))
  check(T.screams([]).length === 0, 'the screams are drained')
  T.dread = []
  for (; t < 2 + D.s + 0.1; t += 1 / 30) frame(t)
  check(c.flee === null && c.lag && c.pose.clip === 'walk', `${D.s} s with no dragon near, it walks back to its sim`, `clip ${c.pose.clip}`)
  T.dread = [{ x: c.pose.x - 5, y: 0, z: 0 }]
  frame((t += 1 / 30))
  check(c.flee !== null && T.screams([]).length === 0, `bolting again within ${D.cool} s, it does not scream again`)
  T.dread = []
  for (; t < 2 * D.s + 3; t += 1 / 30) frame(t)
  for (; t < 60 && c.lag; t += 1 / 30) frame(t)
  check(!c.lag && c.pose.x === 0 && c.pose.clip === 'idle', 'it is back on its sim', `lag ${c.lag}, x ${c.pose.x.toFixed(3)}`)
}

{
  const voices = { alchemist: /Woman/, 'child-villager-2': /Child/ }
  for (const [body, re] of Object.entries(voices)) {
    const { T, frame } = standing(body)
    T.dread = [{ x: 3, y: 0, z: 0 }]
    frame(0)
    const said = T.screams([])
    check(said.length === 1 && re.test(said[0].sound), `the ${body} screams in its own voice`, said.map((v) => v.sound).join(', '))
  }
}

{
  const { T, c, frame } = standing()
  T.dread = [{ x: 0, y: D.m + 1, z: 0 }]
  frame(0)
  check(c.flee === null && c.pose.clip === 'idle', `a dragon ${D.m + 1} m overhead is past its dread`)
}

{
  const { T, c, frame } = standing()
  c.greet = { until: Infinity, at: 0, clip: 'idle' }
  T.dread = [{ x: 3, y: 0, z: 0 }]
  frame(0)
  check(c.flee === null && c.greet !== null, 'one held in talk with her stays')
}

{
  const { T, c, frame } = standing()
  c.hop = c.phop = 1
  T.dread = [{ x: 3, y: 0, z: 0 }]
  frame(0)
  check(c.flee === null, 'a rider stays in its saddle')
}

console.log(failures ? `\n${failures} failing` : '\nall ok')
process.exit(failures ? 1 : 0)
