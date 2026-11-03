// Node-side gates for far townsfolk coasting between their sim's ticks (src/v2/render/townsfolk.js _glide).
//
//   node scripts/check-townsfolk-coast.mjs
//
// What can go wrong without throwing: a coasting body gliding off its sim's lerp, drifting on after it stopped, gliding while shoved or near, or drawn stale when its rung changes.

import { TICK_HZ } from '../src/sim/score.js'
import { LOD_RUNGS, critterTier } from '../src/v2/render/critters.js'
import { Townsfolk } from '../src/v2/render/townsfolk.js'
import { TRADES } from '../src/v2/layers/trades.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const FAR = LOD_RUNGS - 1
/** The middle of the distances that keep a 1.7 m body on the far rung, and one on the rung nearer. */
const span = (rung) => { const d = []; for (let m = 0.5; m < 400; m += 0.5) if (critterTier(1.7, m, rung, LOD_RUNGS) === rung) d.push(m); return d[Math.floor(d.length / 2)] }
const farM = span(FAR), nearM = span(FAR - 1)

/** A layer with one live town holding one walker `c` on the far rung, its baked puppet a recorder. */
function town() {
  const T = Object.create(Townsfolk.prototype)
  T.loaded = true
  T.towns = []
  T.bodies = TRADES.bodies.map(() => ({ durations: { idle: 2, walk: 1 }, gait: { walk: 1.4, run: 3.5 } }))
  T.walk = { heightAt: () => 0, obstacleAt: () => null }
  T.parts = { fires: false, people: true, striders: false }
  T.striders = null
  T.ranks = new Array(TRADES.bodies.length).fill(0)
  T.shown = []
  T.frame = 0
  T.settle = () => {}
  T._tools = () => {}
  T._ground = (c, x, z, y) => y
  let posed = 0
  const pose = T._pose
  T._pose = function (...a) { posed++; return pose.apply(this, a) }
  const glides = []
  const puppet = {
    baked: true, pool: 0, to: FAR, fade: 1, done: false, mixer: { timeScale: 1 },
    group: { matrix: { copy() {} }, matrixWorldNeedsUpdate: false },
    feet: [], planted: false, plantHeading: 0, show(t) { this.to = t }, play() {}, plant() {}, unplant() {}, step() {},
    glide(...v) { glides.push(v) },
  }
  const c = ({ id: 0, body: 0, k: 1, size: 1.7, pace: 1, x: 0.07, y: 0, z: 0, px: 0, py: 0, pz: 0, heading: 0.2, ph: 0, hop: 0, phop: 0, mount: null, job: null, state: 'walk', hidden: false, missing: false, clip: 'walk', cue: 1, from: -1, speed: 1.4, lod: FAR, puppet, greet: null, lag: false, flee: null, scream: 0, saddle: null, cool: Infinity, gcue: 0, shove: { x: 0, z: 0 }, side: 1, stuck: 0, coast: -1, coasting: false, gliding: false, sim: null, pose: { x: 0, y: 0, z: 0, heading: 0, k: 1, speed: 0, clip: 'idle', hop: 0 } })
  const life = { caught: true, all: [c], mounts: [], tick: 10, alpha: 0.2 }
  T.alive = new Map([[0, { life, hearth: { group: {}, flames: { group: {} } }, forge: null }]])
  const head = { x: farM, y: 0, z: 0 }
  const frame = (tick, alpha) => { life.tick = tick; life.alpha = alpha; T.update(head, head, tick / TICK_HZ, 1 / 72, 0) }
  return { T, c, life, head, puppet, glides, frame, posed: () => posed }
}

{
  const { c, glides, frame, posed } = town()
  frame(10, 0.2)
  const [vx, vy, vz, w] = glides[0]
  check(posed() === 1 && glides.length === 1 && Math.abs(vx - 0.07 * TICK_HZ) < 1e-9 && vy === 0 && vz === 0 && Math.abs(w - 0.2 * TICK_HZ) < 1e-9, 'a far walker on its sim glides at its lerp\'s own rate as the tick turns', JSON.stringify(glides[0]))
  const at = c.pose.x
  frame(10, 0.5)
  frame(10, 0.8)
  check(posed() === 1 && glides.length === 1 && c.pose.x === at, 'between ticks it is neither posed nor drawn: the shader carries it')
  // What the glide puts it at 0.6 of a tick on is where the lerp would.
  check(Math.abs(at + vx * (0.6 / TICK_HZ) - 0.07 * 0.8) < 1e-9, 'the glide lands on the lerp', `${(at + vx * 0.6 / TICK_HZ).toFixed(4)} vs ${(0.07 * 0.8).toFixed(4)}`)
  c.px = 0.07; c.x = 0.07; c.ph = 0.2
  frame(11, 0)
  check(posed() === 2 && glides.length === 2 && glides[1].every((v) => v === 0), 'the next tick poses it again, and a body that stopped glides no more', JSON.stringify(glides[1]))
}

{
  const { c, glides, frame, posed } = town()
  frame(10, 0.2)
  c.shove.x = 0.3
  frame(11, 0.1)
  check(glides.length === 2 && glides[1].every((v) => v === 0) && !c.gliding, 'a shoved body stands where it is drawn')
  frame(11, 0.4)
  check(posed() === 3, 'and is posed every frame while shoved')
}

{
  const { c, glides, head, puppet, frame, posed } = town()
  frame(10, 0.2)
  head.x = nearM
  frame(10, 0.6)
  check(posed() === 2 && puppet.to === FAR - 1 && Math.abs(c.pose.x - 0.07 * 0.6) < 1e-9, 'a coasting body whose rung changes is posed afresh before it is drawn', `x ${c.pose.x.toFixed(4)}, rung ${puppet.to}`)
  check(glides.length === 2 && glides[1].every((v) => v === 0), 'and nearer than the far rung it does not glide')
}

{
  const { c, frame, posed } = town()
  frame(10, 0.2)
  c.greet = { until: Infinity, at: 0, clip: 'wave' }
  frame(10, 0.5)
  check(posed() === 2, 'held in talk mid-tick, it is posed that same frame')
}

{
  const { T, c, puppet, glides } = town()
  c.puppet = puppet
  c.sim = null
  T._glide(c, FAR)
  check(glides.length === 0 && c.coast === -1, 'a traveller, posed by the road and not a lerp, never glides')
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
