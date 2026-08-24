// Does the ground ever DISAPPEAR while you fly away from close terrain?
//
//   node scripts/probe-hole.mjs [seed]
//
// probe-popping.mjs asks whether the drawn ground is too coarse. This asks the
// harsher question: is there any ground drawn there at all? The reported artifact
// was a square of terrain blinking out to the horizon colour for a few frames
// before the low-poly version appeared -- not wrong terrain, no terrain, with the
// sky showing through where a hillside had been.
//
// Two things have to be true for that never to happen, and this probe measures
// both because each of them was broken:
//
//   1. Every node has a loaded ancestor. The depth 0-2 base layer is pinned for
//      exactly this reason, and it was never being built: _seedBaseLayer pushed
//      its 21 requests onto terrain.queue, and _select replaces that queue
//      wholesale from the desired set on the first update, before _pump has run.
//      Measured on a settled camera, depths 0 and 1 were 0/1 and 0/4 resident.
//      _loadedAncestor therefore returned null for ~2100 lookups over a 2 km
//      back-away, and a node with no stand-in draws nothing.
//
//   2. Coarsening prefers finer resident chunks to coarser ones. A coarse node is
//      not in the desired set while you are standing on top of it, so it is never
//      requested; backing away puts it back in the set cold, while its children
//      are resident and cover the same ground exactly. Reaching past them to the
//      base layer swaps a hillside for a 256 m-celled plate.
//
// The worker stub delays every reply by a fixed number of frames. This is the
// whole reason the probe can see any of it: a stub that answers inside the
// requesting frame never has an absent chunk to stand in for, which is why the
// existing checks passed throughout.

import * as THREE from 'three'
import { TerrainHeight, TUNING, SNOW } from '../src/sim/terrain-height.js'
import { buildChunk } from '../src/sim/chunk-mesh.js'

const SEED = Number(process.argv[2] ?? 20260804)
// Frames from request to reply. Two workers at ~0.4 ms a chunk clear a frame's
// queue in well under a frame, so the real latency is a couple of frames of
// message passing; six is pessimistic on purpose.
const LATENCY = Number(process.env.LATENCY ?? 6)
const th = new TerrainHeight(SEED)

// Every chunk ever built, so the probe can sample the surface that is actually
// drawn rather than re-deriving what it thinks should have been drawn.
const built = new Map()

let clock = 0
const inflight = [] // {due, fn}
globalThis.Worker = class {
  constructor() { this.onmessage = null }
  postMessage(msg) {
    if (msg.type === 'init') {
      inflight.push({ due: clock, fn: () => this.onmessage({ data: { type: 'ready' } }) })
      return
    }
    if (msg.type === 'tuning') {
      Object.assign(TUNING, msg.tuning)
      Object.assign(SNOW, msg.snow)
      inflight.push({ due: clock, fn: () => this.onmessage({ data: { type: 'tuned', epoch: msg.epoch } }) })
      return
    }
    const r = buildChunk(th, msg)
    built.set(msg.key, { positions: r.positions, ox: msg.ox, oz: msg.oz, res: msg.res, step: msg.size / msg.res })
    const data = {
      type: 'chunk', key: msg.key, epoch: msg.epoch,
      positions: r.positions, normals: r.normals, colors: r.colors, indices: r.indices,
      minY: r.minY, maxY: r.maxY, skirtDepth: r.skirtDepth, ms: 0.4,
    }
    inflight.push({ due: clock + LATENCY, fn: () => this.onmessage({ data }) })
  }
  terminate() {}
}

const { Terrain } = await import('../src/terrain/terrain.js')
const terrain = new Terrain(new THREE.Scene(), { seed: SEED, workers: 2, queueDepth: 32 })

// NOBASE=1 / NOFINE=1 disable one half of the fix each, so the guards below can
// be shown to fail for the reason they claim to.
if (process.env.NOBASE) terrain._baseQueue.length = 0
if (process.env.NOFINE) terrain._addLoadedDescendants = () => false

const deliver = () => {
  for (let i = inflight.length - 1; i >= 0; i--) {
    if (inflight[i].due <= clock) {
      const f = inflight[i].fn
      inflight.splice(i, 1)
      f()
    }
  }
}

// The height the drawn mesh shows at (x,z), bilinear inside the chunk's grid.
const surfaceAt = (entry, x, z) => {
  const c = built.get(entry.node.key)
  if (!c) return null
  const fx = (x - c.ox) / c.step
  const fz = (z - c.oz) / c.step
  const i = Math.min(c.res - 1, Math.max(0, Math.floor(fx)))
  const j = Math.min(c.res - 1, Math.max(0, Math.floor(fz)))
  const tx = Math.min(1, Math.max(0, fx - i))
  const tz = Math.min(1, Math.max(0, fz - j))
  const vpr = c.res + 1
  const h = (a, b) => c.positions[(b * vpr + a) * 3 + 1]
  return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) +
    (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz
}

// The finest chunk in the render set covering this point, or null for a hole.
const coverAt = (x, z) => {
  let best = null
  for (const e of terrain._render) {
    const n = e.node
    if (x < n.x || x >= n.x + n.size || z < n.z || z >= n.z + n.size) continue
    if (!best || n.depth > best.node.depth) best = e
  }
  return best
}

// A fan across the view, out to the far LOD rings. 11 bearings x 6 ranges.
const RANGES = [60, 120, 250, 500, 900, 1500]
const POINTS = 11 * RANGES.length
// Cell size is only judged in the near field. A 256 m cell at 1.5 km is what the
// selection asks for on purpose -- scoring it as a defect makes the guard track
// worker latency rather than the swap it is meant to be watching.
const NEAR = 250
const samplePoints = (cam) => {
  const pts = []
  for (let a = -5; a <= 5; a++) {
    const yaw = cam.yaw + (a / 5) * 0.7
    for (const d of RANGES) pts.push({ x: cam.x + Math.sin(yaw) * d, z: cam.z + Math.cos(yaw) * d, d })
  }
  return pts
}

const step = (cam) => {
  clock++
  terrain.update(cam)
  // Inspected BETWEEN update and delivery, because that is the state that is
  // drawn: replies that land later cannot repair this frame's picture.
  let holes = 0
  let worstDrop = 0
  let worstCell = 0
  for (const p of samplePoints(cam)) {
    const e = coverAt(p.x, p.z)
    if (!e) { holes++; continue }
    const drawn = surfaceAt(e, p.x, p.z)
    if (drawn === null) continue
    const drop = th.heightAt(p.x, p.z) - drawn
    if (drop > worstDrop) worstDrop = drop
    const cell = e.node.size / 16
    if (p.d <= NEAR && cell > worstCell) worstCell = cell
  }
  deliver()
  return { holes, worstDrop, worstCell }
}

console.log(`\n=== terrain hole probe, seed ${SEED}, worker latency ${LATENCY} frames ===\n`)

const gy = th.heightAt(2200, -1400)
let cam = { x: 2200, z: -1400, y: gy + 1.7, yaw: 0.8 }
for (let i = 0; i < 1200; i++) {
  step(cam)
  if (terrain.stats.pending === 0 && !terrain._dirty) break
}

// The base layer, counted directly. Everything below rests on this.
let baseReady = 0
for (let d = 0; d <= 2; d++) {
  const n = 1 << d
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const e = terrain.cache.get(`${d}|${ix}|${iz}`)
      if (e && e.state === 'ready') baseReady++
    }
  }
}
console.log(`settled: ${terrain.stats.rendered} drawn, ${terrain.stats.cached} cached, base layer ${baseReady}/21 resident\n`)

const results = []
const run = (label, camAt, frames) => {
  let holeFrames = 0
  let holePoints = 0
  let worstDrop = 0
  let worstFrame = -1
  let worstCell = 0
  let peakSlots = 0
  for (let f = 0; f < frames; f++) {
    const r = step(camAt(f))
    if (r.holes) { holeFrames++; holePoints += r.holes }
    if (r.worstDrop > worstDrop) { worstDrop = r.worstDrop; worstFrame = f }
    if (r.worstCell > worstCell) worstCell = r.worstCell
    if (terrain.stats.slots > peakSlots) peakSlots = terrain.stats.slots
  }
  console.log(label)
  console.log(`  GROUND MISSING ENTIRELY: ${holePoints} of ${frames * POINTS} sample points, on ${holeFrames}/${frames} frames`)
  console.log(`  worst the drawn ground sits below the true surface: ${worstDrop.toFixed(1)} m (frame ${worstFrame})`)
  console.log(`  coarsest cell drawn within ${NEAR} m: ${worstCell.toFixed(0)} m    peak slots held: ${peakSlots}\n`)
  const r = { label, holeFrames, holePoints, worstDrop, worstCell, frames }
  results.push(r)
  return r
}

// Speeds are per frame at 60 fps: 1 m/frame is 60 m/s, a fast but flyable cruise.
// An earlier version of this probe flew at 9 m/frame -- 1900 km/h -- where 61% of
// the selection is missing every frame no matter what the renderer does, and no
// fix can look like it worked.
const back = run('BACK AWAY from close terrain, 85 m/s for 360 frames', (f) => ({
  x: 2200 - f, z: -1400 - f, y: gy + 60, yaw: 0.8,
}), 360)

const climb = run('CLIMB AWAY from close terrain, 60 m/s for 360 frames', (f) => ({
  x: 2200, z: -1400, y: gy + 1.7 + f, yaw: 0.8,
}), 360)

// Turning asks for ground that was outside the streaming cone, which is the other
// way to want a chunk nobody built.
const spin = run('SPIN in place at 120 m AGL, one full turn over 360 frames', (f) => ({
  x: 2200, z: -1400, y: gy + 120, yaw: (f / 360) * Math.PI * 2,
}), 360)

// Absurdly fast, purely to prove the failure mode is graceful. At 765 m/s the
// world genuinely cannot stream and the ground falls back to the base layer --
// that is fine. What must not happen is a hole, or the slot pool throwing.
const rush = run('RUSH AWAY at 765 m/s for 360 frames (stress, not a real speed)', (f) => ({
  x: 2200 - f * 9, z: -1400 - f * 9, y: gy + 60, yaw: 0.8,
}), 360)

// --- guard ------------------------------------------------------------------

let failures = 0
const check = (ok, label, detail) => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}   ${detail}`)
}

console.log('--- guard ---')
check(baseReady === 21, 'the pinned base layer is actually built', `${baseReady}/21 resident after settling`)
for (const r of [back, climb, spin, rush]) {
  check(r.holePoints === 0, `no hole in the ground: ${r.label.split(',')[0].toLowerCase()}`,
    `${r.holePoints} missing of ${r.frames * POINTS} samples`)
}
// At a flyable speed the coarsening swap should keep the detail it already had,
// not drop to the base layer. Measured 4 m and 8 m cells within 250 m; the bound
// is a couple of levels of slack on that, and without the descendant stand-ins it
// is 256 m -- the base layer, 69 m below the ridge it is standing in for.
check(back.worstCell <= 16, 'backing away keeps its fine detail through the swap', `coarsest cell ${back.worstCell.toFixed(0)} m`)
check(spin.worstCell <= 32, 'turning keeps its detail through the swap', `coarsest cell ${spin.worstCell.toFixed(0)} m`)
check(back.worstDrop < 15, 'backing away never drops the surface far below the mountain', `${back.worstDrop.toFixed(1)} m`)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
