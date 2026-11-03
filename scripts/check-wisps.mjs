// Node-side gates for the wisps (src/v2/render/wisps.js).
//
//   node scripts/check-wisps.mjs
//
// The vertex shader flies the wisps from a travel segment and a clock, so the
// CPU's whole job is to write that segment when the waypoint changes. What can
// go wrong without anything throwing: a segment rewritten every frame, ground
// read every frame, a wisp that runs on past its waypoint when the wrapped
// clock comes round, a seam at the clock wrap, a path that is not the one the
// old per-frame integration drew. The shader reads wispPose's twin; GLSL
// itself runs in tmp/glow-parity-drive.mjs.

import * as THREE from 'three'
import { PERIOD_S, WISP, Wisps, wispPose } from '../src/v2/render/wisps.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const wisps = new Wisps(new THREE.Scene())
const places = [{ key: 'cave:7', x: 200, z: 0 }]
const feet = { x: 0, y: 0, z: 0 }
let reads = 0
const heightAt = (x) => { reads++; return 0.1 * x }
let time = 0
const dt = 1 / 72
const frame = (opts = {}) => { time += dt; wisps.update(dt, time, feet, { dayness: 0, outdoors: true, places, heightAt, ...opts }) }
const u = wisps.material.uniforms
const segState = () => JSON.stringify([u.uSeg.value.toArray(), u.uSegB.value.toArray(), u.uGround.value.toArray()])

check(wisps.mesh.isInstancedMesh && wisps.mesh.count === WISP.count && wisps.material.blending === THREE.AdditiveBlending && !wisps.material.depthWrite, 'one additive instanced draw, a quad a wisp, no depth write')
frame({ dayness: 0.9 })
check(!wisps.group.visible, 'nothing by day')
for (let f = 0; f < 72 * 3; f++) frame()
check(wisps.group.visible && wisps.stats.target === 'cave:7', 'they show after dark')
check(Math.abs(wisps.stats.at.x - WISP.aheadM) < 1e-6 && reads === 1, 'waiting aheadM before her, one ground read for it', `at ${wisps.stats.at.x.toFixed(2)}, ${reads} reads`)

// A steady frame: the segment uniforms and the ground do not move, only the clocks and opacity.
{
  const seg = segState(), r0 = reads
  const now0 = u.uNow.value
  for (let f = 0; f < 500; f++) frame()
  check(segState() === seg && reads === r0, 'a steady frame writes no segment and reads no ground', `${reads - r0} reads`)
  check(u.uNow.value !== now0, 'while the clock uniform still moves')
}

// She catches up: one hop, one segment, three ground reads, and the wisp runs at speedMps.
{
  feet.x = wisps.stats.at.x
  const r0 = reads, from = wisps.stats.at.x
  frame()
  const dist = u.uSegB.value.x
  check(Math.abs(dist - WISP.hopM) < 1e-6 && reads - r0 === 3, 'she catches up: one hop of hopM, ground read at its start, middle and end', `dist ${dist.toFixed(2)}, ${reads - r0} reads`)
  const a = wisps.stats.at.x
  for (let f = 0; f < 72; f++) frame()
  check(Math.abs(wisps.stats.at.x - a - WISP.speedMps) < 0.1, 'it runs at speedMps', `${(wisps.stats.at.x - a).toFixed(3)} m in a second`)
  feet.x = from + 1
  for (let f = 0; f < 72 * 6; f++) frame()
  check(Math.abs(wisps.stats.at.x - (from + WISP.hopM)) < 1e-6, 'and stops at the waypoint', wisps.stats.at.x.toFixed(3))
  check(u.uSegB.value.x === 0, 'where the segment is parked, so the wrapped clock cannot run it again')
}

// The pose against the old per-frame formulas, early enough that the snapped rates have not drifted from the old ones.
{
  const seg = { fromX: 40, fromZ: -10, dirX: 0.6, dirZ: 0.8, dist: 14, t0: 5, ground: [4, 5.4, 6.8] }
  let worst = 0
  for (let i = 0; i < WISP.count; i++) for (let now = 0; now < 1; now += 0.05) {
    const clock = 7, p = wispPose(i, seg, now, clock)
    const run = Math.min(seg.dist, WISP.speedMps * (clock - seg.t0))
    const ph = now * (0.7 + 0.23 * i) + i * 2.1
    const want = {
      x: seg.fromX + seg.dirX * run + Math.cos(ph) * 0.7,
      z: seg.fromZ + seg.dirZ * run + Math.sin(ph * 1.3) * 0.7,
      y: 4 + (run / seg.dist) * 2.8 + WISP.hoverM + Math.sin(now * 1.7 + i * 1.9) * 0.25,
      size: WISP.sizeM * (0.8 + 0.2 * Math.sin(now * 9 + i * 4)),
    }
    worst = Math.max(worst, Math.abs(p.x - want.x), Math.abs(p.y - want.y), Math.abs(p.z - want.z), Math.abs(p.size - want.size))
  }
  check(worst < 0.03, 'the pose matches the old per-frame formulas to the rate snapping', `worst ${worst.toFixed(4)} m`)
  let seam = 0
  for (let i = 0; i < WISP.count; i++) {
    const a = wispPose(i, { ...seg, t0: PERIOD_S - 1 }, 0, PERIOD_S - 0.001), b = wispPose(i, { ...seg, t0: PERIOD_S - 1 }, PERIOD_S, 0.001)
    seam = Math.max(seam, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z), Math.abs(a.size - b.size))
  }
  check(seam < 0.02, 'no seam where the clocks wrap', `gap ${seam.toFixed(4)} m`)
}

// Gone indoors and by day.
frame({ outdoors: false })
check(!wisps.group.visible, 'gone the moment she is indoors')
wisps.dispose()

console.log(failures ? `\n${failures} failure(s)` : '\nall wisp checks passed')
process.exit(failures ? 1 : 0)
