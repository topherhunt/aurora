// Node-side gates for a rider held in a conversation with her (src/v2/render/townsfolk.js hold, _pose, _poseMount).
//
//   node scripts/check-talk-rider.mjs
//
// What can go wrong without throwing: a hailed rider stood up in its saddle on the standing idle or a talk gesture, or its strider walking on under it while it talks.

import { Townsfolk } from '../src/v2/render/townsfolk.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/** A layer with only what the pose reads, and a rider at the origin heading +x on a walking strider, the sim moving them +x at `v` m/s. */
function riding(v = 1.25) {
  const T = Object.create(Townsfolk.prototype)
  T.bodies = [{ durations: { idle: 2, 'ride-idle': 2, ride: 1, walk: 1, 'talk-gesture': 2 }, gait: { walk: 1 } }]
  T.walk = { heightAt: () => 0 }
  T.bond = { grown: new Map() }
  T.lent = new Set()
  const m = { state: 'ridden', active: true, base: 1, key: 'm', held: null, treat: null, x: 0, z: 0, y: 0, px: 0, pz: 0, py: 0, heading: 0, ph: 0, clip: 'walk', speed: v, cue: 3, pose: { x: 0, y: 0, z: 0, heading: 0 } }
  const c = { body: 0, k: 1, pace: 1, graph: null, x: 0, z: 0, y: 0, px: 0, pz: 0, py: 0, heading: 0, ph: 0, hop: 1, phop: 1, mount: m, job: { kind: 'depart' }, state: 'walk', hidden: false, clip: 'ride', cue: 7, from: -1, speed: v, greet: null, lag: false, saddle: null, cool: 0, gcue: 0, shove: { x: 0, z: 0 }, pose: { x: 0, y: 0, z: 0, heading: 0, hop: 1 } }
  m.rider = c
  T._shove = () => {}
  const sim = { t: 0 }
  // One frame at `t`: the sim stepped on, then the rider and its strider posed as update() orders them.
  const frame = (t, feet, dt = 1 / 60) => {
    const d = v * (t - sim.t)
    sim.t = t
    for (const o of [c, m]) { o.px = o.x; o.x += d }
    T._pose(c, 1, feet, t, dt)
    T._poseMount(m, 1)
  }
  return { T, c, m, frame }
}

{
  const { T, c, m, frame } = riding()
  const her = { x: 2, z: -2 }
  frame(0, her)
  T.hold(c, 0)
  const at = { x: m.pose.x, z: m.pose.z }
  for (let t = 1 / 60; t < 4; t += 1 / 60) frame(t, her)
  check(Math.hypot(m.pose.x - at.x, m.pose.z - at.z) < 1e-9 && m.pose.speed === 0 && m.pose.clip === 'idle', 'a held rider\'s strider stops where it was hailed', `moved ${Math.hypot(m.pose.x - at.x, m.pose.z - at.z).toFixed(3)} m, clip ${m.pose.clip}`)
  const want = Math.atan2(-(her.z - at.z), her.x - at.x)
  check(Math.abs(wrap(m.pose.heading - want)) < 0.05 && m.pose.heading === c.pose.heading, 'the strider turns to her with its rider', `off by ${wrap(m.pose.heading - want).toFixed(3)} rad`)
  check(c.pose.clip === 'ride-idle' && c.pose.hop === 1, 'the held rider sits in the saddle', `clip ${c.pose.clip}, hop ${c.pose.hop}`)
  T.gesture(c, 'talk-gesture', 4, null)
  frame(4 + 1 / 60, her)
  check(c.pose.clip === 'ride-idle', 'a talk gesture does not stand the rider up', `clip ${c.pose.clip}`)

  T.release(c, 5)
  frame(5, her)
  frame(5 + 1 / 60, her)
  check(c.lag && c.pose.clip === 'ride' && m.pose.clip === 'walk' && m.pose.speed > 0 && m.pose.x === c.pose.x, 'let go, it rides back onto its sim on its strider', `rider ${c.pose.clip}, strider ${m.pose.clip} at ${m.pose.speed.toFixed(2)} m/s`)
  let t = 5 + 1 / 60
  while (c.lag && t < 60) frame((t += 1 / 60), her)
  check(!c.lag && c.saddle === null && m.held === null && Math.abs(m.pose.x - m.x) < 1e-9, 'caught up, rider and strider are the sim\'s again', `lag ${c.lag}, ${(m.pose.x - m.x).toFixed(3)} m off`)
}

{
  const { T, c, m, frame } = riding()
  frame(0, { x: 2, z: 0 })
  T.hold(c, 0)
  frame(1, { x: 2, z: 0 })
  // Down at a rail in the sim meanwhile.
  c.mount = null
  c.hop = 0
  m.state = 'tied'
  T.release(c, 2)
  frame(2, { x: 2, z: 0 })
  check(c.saddle === null && m.held === null, 'off its strider in the sim meanwhile, a let-go rider leaves the saddle')
}

{
  const { T, c, frame } = riding()
  c.mount.state = 'led'
  frame(0, { x: 2, z: 0 })
  T.hold(c, 0)
  check(c.saddle === null, 'one leading a strider afoot is held as anyone afoot is')
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall ok')
process.exit(failures ? 1 : 0)
