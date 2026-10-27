// Node-side gates for townsfolk fleeing a dragon (src/v2/render/townsfolk.js _flee, TOWNSFOLK.dread).
//
//   node scripts/check-dread.mjs
//
// What can go wrong without throwing: a townsperson running toward the dragon or never coming back to its sim, screaming every frame, a rider or one in talk with her bolting, or one fleeing, walking back or coming to her through a wall.

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
  T.walk = { heightAt: () => 0, crossed: () => false, obstacleAt: () => null }
  T.dread = []
  T.screamed = []
  T._shove = () => {}
  const c = { body: TRADES.bodies.indexOf(body), k: 1, size: 1.7, pace: 1, graph: null, x: 0, z: 0, y: 0, px: 0, pz: 0, py: 0, heading: 0, ph: 0, hop: 0, phop: 0, mount: null, job: null, state: 'stand', hidden: false, clip: 'idle', cue: 1, from: -1, speed: 0, greet: null, lag: false, flee: null, scream: 0, saddle: null, cool: 0, gcue: 0, shove: { x: 0, z: 0 }, side: 1, stuck: 0, pose: { x: 0, y: 0, z: 0, heading: 0, hop: 0 } }
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

// A wall 0.5 m thick and 6 m long across x = 5 (walk stone, waist high and up), and a trunk at (-4, 6).
const WALL = { x0: 5, x1: 5.5, z: 3 }
const inWall = (x, z) => x > WALL.x0 && x < WALL.x1 && Math.abs(z) < WALL.z
const walled = (T) => {
  T.walk.crossed = (x, z, lo, hi) => inWall(x, z) && hi > 0.5 && lo < 3
  T.walk.obstacleAt = (x, z, out) => Math.hypot(x + 4, z - 6) < 0.6 ? Object.assign(out, { x: -4, z: 6, r: 0.6 }) : null
}

{
  const { T, c, frame } = standing()
  walled(T)
  T.dread = [{ x: -10, y: 0, z: 0 }]
  let t = 0, through = 0
  for (; t < 8; t += 1 / 30) { frame(t); if (inWall(c.pose.x, c.pose.z)) through++ }
  check(through === 0 && c.pose.x > WALL.x1, 'fleeing into a wall, it goes round it rather than through', `${through} frames in the wall, at (${c.pose.x.toFixed(2)}, ${c.pose.z.toFixed(2)})`)
  T.dread = []
  for (; t < 60 && c.lag; t += 1 / 30) { frame(t); if (inWall(c.pose.x, c.pose.z)) through++ }
  check(through === 0 && !c.lag, 'walking back to its sim, it goes round the wall too', `${through} frames in the wall, lag ${c.lag}`)
}

{
  const { T, c } = standing()
  walled(T)
  const her = { x: 10, z: 0.5 }
  T.approach(c, 0, 1.4)
  let t = 0, through = 0
  for (; t < 30 && c.greet.at === Infinity; t += 1 / 30) { T._pose(c, 1, her, t, 1 / 30); if (inWall(c.pose.x, c.pose.z)) through++ }
  const d = Math.hypot(c.pose.x - her.x, c.pose.z - her.z)
  check(through === 0 && d < 1.6, 'coming to her past a wall, it goes round it and stops by her', `${through} frames in the wall, ${d.toFixed(2)} m off`)
}

{
  const { T, c, frame } = standing()
  walled(T)
  c.pose.x = c.x = c.px = -4; c.pose.z = c.z = c.pz = 3
  T.dread = [{ x: -4, y: 0, z: -5 }]
  let t = 0, inTrunk = 0
  for (; t < 3; t += 1 / 30) { frame(t); if (Math.hypot(c.pose.x + 4, c.pose.z - 6) < 0.6) inTrunk++ }
  check(inTrunk === 0 && c.pose.z > 6.6, 'fleeing into a trunk, it goes round it', `${inTrunk} frames in the trunk, at (${c.pose.x.toFixed(2)}, ${c.pose.z.toFixed(2)})`)
}

console.log(failures ? `\n${failures} failing` : '\nall ok')
process.exit(failures ? 1 : 0)
