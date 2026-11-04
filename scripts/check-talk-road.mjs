// Node-side gates for a traveller held in talk on the road (src/v2/render/townsfolk.js _road, conversations.js road kind).
//
//   node scripts/check-talk-road.mjs
//
// What can go wrong without throwing: a hailed traveller sliding on along the timetable while it talks, snapping back to it when let go, dropped from under the talk as she or the road's end leaves it behind, or ridden through by its own party.

import { Townsfolk, TOWNSFOLK } from '../src/v2/render/townsfolk.js'
import { Conversations, TALK } from '../src/v2/conversations.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const G = TOWNSFOLK.greet, V = 1, DT = 1 / 60
const J = { road: [], onRoad: (s, out) => out, at: (j, k, t, out) => Object.assign(out, { x: j.speed * (t - j.t0) - k * 2, z: 0, heading: 0 }) }

/** A layer with only what `_road` and the pose read, and a party of `n` afoot along +x at `V` m/s, or one rider, until `t1`. */
function party(n = 1, { ride = false, t1 = 1000 } = {}) {
  const T = Object.create(Townsfolk.prototype)
  Object.assign(T, { bodies: [{ durations: { idle: 2, 'ride-idle': 2, ride: 1, walk: 1, wave: 1, 'talk-gesture': 2 }, gait: { walk: 1 } }], walk: { heightAt: () => 0, crossed: () => false, obstacleAt: () => null }, bond: { grown: new Map() }, lent: new Set(), dread: [], journeys: J, road: new Map(), alive: new Map(), roadAt: Infinity, onRoad: [], _shove: () => {}, dropped: [] })
  T._drop = (key, r) => { T.dropped.push(key); T.road.delete(key) }
  T._roadR = () => TOWNSFOLK.road.person
  const j = { id: 'j', from: 0, to: 1, t0: 0, t1, ride, speed: V, members: Array.from({ length: n }, () => ({ body: 0, size: 0 })) }
  for (let k = 0; k < n; k++) {
    const m = ride ? { state: 'ridden', active: true, base: 1, key: null, held: null, treat: null, x: 0, z: 0, y: 0, px: 0, pz: 0, py: 0, heading: 0, ph: 0, clip: 'walk', speed: V, cue: 0, gone: false, pose: { x: 0, y: 0, z: 0, heading: 0 } } : null
    const c = { id: k, body: 0, k: 1, size: 1.7, pace: 1, graph: null, x: 0, z: 0, y: 0, px: 0, pz: 0, py: 0, heading: 0, ph: 0, hop: ride ? 1 : 0, phop: ride ? 1 : 0, mount: m, job: null, state: ride ? 'ride' : 'walk', hidden: false, clip: ride ? 'ride' : 'walk', cue: 0, from: -1, speed: V, greet: null, lag: false, flee: null, scream: 0, saddle: null, cool: Infinity, gcue: 0, shove: { x: 0, z: 0 }, origin: null, puppet: {}, pose: { x: 0, y: 0, z: 0, heading: 0, hop: ride ? 1 : 0 } }
    if (m) m.rider = c
    T.road.set(`j:${k}`, { j, k, c, m, at: {}, fresh: true, side: 0, late: 0 })
  }
  const clock = { t: 0 }
  const run = (until, feet) => {
    while (clock.t < until) {
      clock.t += DT
      T._road(feet, clock.t, feet, DT, [], [])
    }
  }
  return { T, j, run, clock, r: T.road.get('j:0') }
}

{
  const { T, r, run, clock } = party()
  const her = { x: 12, y: 0, z: 2 }
  run(10, her)
  const on = r.c.pose.x
  check(Math.abs(on - 10) < 0.05, 'unhailed, a traveller keeps the timetable', `at ${on.toFixed(2)} of 10`)
  T.hold(r.c, clock.t)
  const at = r.c.pose.x
  run(30, her)
  check(Math.abs(r.c.pose.x - at) < 1e-6 && r.c.pose.speed === 0, 'held, it stops where it was hailed', `moved ${(r.c.pose.x - at).toFixed(3)} m`)
  check(Math.abs(r.late - 20) < 0.1, 'and falls behind the timetable as long as it talks', `${r.late.toFixed(1)} s late`)
  T.release(r.c, clock.t)
  run(clock.t + 1, her)
  check(r.c.pose.x - at < V * G.catchUp * 1.2 && r.late > 15, 'let go, it walks on from there and does not snap to the timetable', `${(r.c.pose.x - at).toFixed(2)} m on`)
  run(30 + 2 * r.late / (G.catchUp - 1), her)
  check(r.late === 0 && Math.abs(r.c.pose.x - clock.t) < 0.05, 'and makes up the time at catch-up pace until it is back on it', `${r.late.toFixed(2)} s late, ${(r.c.pose.x - clock.t).toFixed(2)} m off`)
}

{
  const { T, r, run, clock } = party(1, { t1: 20 })
  run(5, { x: 6, y: 0, z: 2 })
  T.hold(r.c, clock.t)
  run(40, { x: 6, y: 0, z: 2 })
  check(T.road.size === 1 && T.dropped.length === 0, 'held past the end of the journey, it stays to finish talking')
  T.roadAt = 0
  run(41, { x: 9000, y: 0, z: 0 })
  check(T.road.size === 1, 'held, it survives her walking far off')
  T.release(r.c, clock.t)
  run(120, { x: 9000, y: 0, z: 0 })
  check(T.road.size === 0, 'let go, its late journey runs out and it is gone')
}

{
  const { T, r, run, clock } = party(1, { ride: true })
  const her = { x: 8, y: 0, z: 2 }
  run(5, her)
  T.hold(r.c, clock.t)
  const at = r.m.pose.x
  run(9, her)
  check(Math.abs(r.m.pose.x - at) < 1e-6 && r.m.pose.speed === 0 && r.c.saddle !== null, 'a hailed rider stays in the saddle and its strider stops under it', `moved ${(r.m.pose.x - at).toFixed(3)} m`)
  T.release(r.c, clock.t)
  run(14, her)
  check(r.m.pose.speed > 0 && r.m.pose.x > at && r.m.pose.x === r.c.pose.x, 'let go, they ride on together')
}

{
  const { T, run, clock } = party(2)
  const held = T.road.get('j:0'), behind = T.road.get('j:1')
  const her = { x: 12, y: 0, z: 2 }
  run(5, her)
  T.hold(held.c, clock.t)
  let closest = Infinity
  while (clock.t < 14) {
    run(clock.t + DT, her)
    closest = Math.min(closest, Math.hypot(held.c.pose.x - behind.c.pose.x, held.c.pose.z - behind.c.pose.z))
  }
  check(behind.c.pose.x > held.c.pose.x + 1, 'a companion walks on past the one held')
  check(closest >= TOWNSFOLK.road.person, 'stepping round it, not through it', `closest ${closest.toFixed(2)} m`)
}

{
  const { T, r, run, clock } = party()
  const her = { x: 10, y: 0, z: 6 }
  run(5, her)
  T.approach(r.c, clock.t, 1.4)
  const off = () => Math.hypot(r.c.pose.x - her.x, r.c.pose.z - her.z)
  run(30, her)
  check(r.c.greet.at !== Infinity && off() < 1.6 && r.c.pose.speed === 0, 'sent to her, it leaves the road, comes within reach and waits', `${off().toFixed(2)} m off`)
  T.release(r.c, clock.t)
  run(30 + 3 * r.late, her)
  check(r.late === 0 && Math.abs(r.c.pose.z) < 0.05 && Math.abs(r.c.pose.x - clock.t) < 0.05, 'let go, it goes back to the road and the timetable', `${r.late.toFixed(2)} s late, ${r.c.pose.z.toFixed(2)} m off the road`)
}

/** Conversations with only what `_people` and `_approach` read, one traveller of town 0 bound for town 1, `odds` the roll. */
function talkers(ride) {
  const { T, r } = party(1, { ride })
  T.journeys = { ...J, bodies: ['skald'] }
  T.alive = new Map()
  const mind = { id: 'town0:3', town: 0, cls: 'travel' }
  const C = Object.create(Conversations.prototype)
  Object.assign(C, { room: null, townsfolk: T, villagers: null, castle: () => null, now: 50, pack: { holds: () => false }, alone: new Map(), asked: new Map(), coming: null, world: { folk: (t, body) => { if (t !== 0 || body !== 'skald') throw new Error(`folk ${t} ${body}`); return mind } } })
  return { C, T, r, mind }
}

{
  const { C, r, mind } = talkers(false)
  const [p] = C._people([])
  check(p.kind === 'road' && p.mind === mind && p.trip.to === 1 && p.trip.arrived === false && p.c === r.c, 'a traveller on the road is its home town\'s person, bound for the journey\'s end')
  r.c.hidden = true
  check(C._people([]).length === 0, 'unless the road copy is hidden')
  r.c.hidden = false
  r.c.pose.x = TALK.approach.m + 1
  const roll = Math.random
  Math.random = () => 0
  C._approach({ x: 0, z: 0 }, 1)
  check(C.coming === null && r.c.greet === null, 'it does not come over from beyond earshot')
  r.c.pose.x = 3
  C._approach({ x: 0, z: 0 }, 1)
  check(C.coming !== null && r.c.greet.come === TALK.approach.come, 'near her, one afoot may walk over to her')
  C.coming = null
  r.c.greet = null
  C._approach({ x: 0, z: 0 }, 1)
  check(C.coming === null && r.c.greet === null, 'and asks once, not every look')
  Math.random = () => 1
  C.asked.clear()
  C._approach({ x: 0, z: 0 }, 1)
  check(C.coming === null && C.asked.has(mind.id), 'at the odds, it walks on by')
  Math.random = roll
}

{
  const { C, r } = talkers(true)
  r.c.pose.x = 3
  const roll = Math.random
  Math.random = () => 0
  C._approach({ x: 0, z: 0 }, 1)
  Math.random = roll
  check(C.coming !== null && r.c.greet.at !== Infinity && r.c.saddle !== null, 'a rider pulls up where it is, in the saddle')
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall ok')
process.exit(failures ? 1 : 0)
