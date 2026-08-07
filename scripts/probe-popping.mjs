// Why does the terrain flash a huge flat facet for a few frames while you pan?
//
//   node scripts/probe-popping.mjs [seed]
//
// check-terrain.mjs drains the worker stub to completion between frames, so it
// never sees a partially-streamed world -- which is exactly the state this
// glitch lives in. This probe delivers at most one round of replies per frame,
// which is what the real WORKER_QUEUE_DEPTH cap produces, and then asks a
// single question every frame: for each node the quadtree WANTED, what is
// actually being drawn over that ground, and how far is it from the truth?
//
// The number to watch is the stand-in's error IN DEGREES, not in metres. A
// depth-2 chunk is 115 m off the real surface, and that is a perfectly good
// thing to draw at 8 km -- the selection picks it there on purpose -- while at
// 500 m it is a mountain punching up through the sky. Metres alone cannot tell
// those apart, and scoring this probe in metres made a fix look like it worked.
//
// The whole LOD rule is stated in degrees (quadtree.js), so the glitch should be
// too: a stand-in is acceptable if its angular error is near the triangle cap it
// replaces, and it is the artifact the user reported when it is many times that.

import * as THREE from 'three'
import { TerrainHeight, TUNING, SNOW } from '../src/sim/terrain-height.js'
import { buildChunk } from '../src/sim/chunk-mesh.js'
import { selectNodes, nodeRange, MAX_DEPTH } from '../src/terrain/quadtree.js'

const SEED = Number(process.argv[2] ?? 20260804)
const th = new TerrainHeight(SEED)

// Worker stub. Replies are held until the frame loop releases them, so
// "in flight" means what it means in the browser.
let pending = []
globalThis.Worker = class {
  constructor() { this.onmessage = null }
  postMessage(msg) {
    if (msg.type === 'init') { pending.push(() => this.onmessage({ data: { type: 'ready' } })); return }
    if (msg.type === 'tuning') {
      Object.assign(TUNING, msg.tuning); Object.assign(SNOW, msg.snow)
      pending.push(() => this.onmessage({ data: { type: 'tuned', epoch: msg.epoch } })); return
    }
    pending.push(() => {
      const r = buildChunk(th, msg)
      this.onmessage({ data: { type: 'chunk', key: msg.key, epoch: msg.epoch,
        positions: r.positions, normals: r.normals, colors: r.colors, indices: r.indices,
        minY: r.minY, maxY: r.maxY, skirtDepth: r.skirtDepth, ms: 0.4 } })
    })
  }
  terminate() {}
}

const { LOD } = await import('../src/terrain/quadtree.js')
// PERIPH=90 reproduces the ORIGINAL binary cull exactly: tan(90 deg) is
// infinite, so no out-of-cone node ever passes the split test and descent stops
// at the cone edge, which is what the first version of the cull did explicitly.
// Kept as a flag so the before/after here stays reproducible rather than
// remembered.  node scripts/probe-popping.mjs 20260804 90
if (process.argv[3]) LOD.periphDeg = Number(process.argv[3])
console.log(`peripheral target: ${LOD.periphDeg} deg, queue depth ${process.argv[4] ?? 32}${process.argv[3] === '90' ? '  (== the original binary cull)' : ''}`)

const { Terrain } = await import('../src/terrain/terrain.js')

const scene = new THREE.Scene()
const QUEUE = Number(process.argv[4] ?? 32)
const terrain = new Terrain(scene, { seed: SEED, workers: 2, queueDepth: QUEUE })

// One round of replies per frame: everything the workers had in hand when the
// frame started lands, and _pump refills on the next update().
const step = (cam) => {
  terrain.update(cam)
  const round = pending
  pending = []
  for (const f of round) f()
}

// Deviation of a stand-in chunk's mesh from the true field, over the footprint
// of the ground it is covering. This is the vertical distance between what you
// see and where the mountain actually is.
//
// Sampled over a grid rather than at the node centre. The centre alone reads
// ZERO whenever the gap is one level -- it lands exactly on a vertex of the
// ancestor's own grid, where a bilinear mesh is exact by construction -- which
// makes a one-level stand-in look perfect and is an artifact of the sample
// point, not a property of the mesh.
const SAMPLES = 5
const standInError = (entry, node) => {
  const res = 16
  const cell = entry.node.size / res
  const H = (a, b) => th.heightAt(entry.node.x + a * cell, entry.node.z + b * cell)
  let worst = 0
  for (let sj = 0; sj <= SAMPLES; sj++) {
    for (let si = 0; si <= SAMPLES; si++) {
      const px = node.x + (si / SAMPLES) * node.size
      const pz = node.z + (sj / SAMPLES) * node.size
      const fx = (px - entry.node.x) / cell
      const fz = (pz - entry.node.z) / cell
      const i = Math.min(res - 1, Math.max(0, Math.floor(fx)))
      const j = Math.min(res - 1, Math.max(0, Math.floor(fz)))
      const tx = fx - i
      const tz = fz - j
      const drawn =
        H(i, j) * (1 - tx) * (1 - tz) + H(i + 1, j) * tx * (1 - tz) +
        H(i, j + 1) * (1 - tx) * tz + H(i + 1, j + 1) * tx * tz
      const e = Math.abs(drawn - th.heightAt(px, pz))
      if (e > worst) worst = e
    }
  }
  return worst
}

// Look at the ground each frame and report the worst thing on screen.
//
// The headline number is the angular size of the biggest triangle actually
// DRAWN, which is the same quantity quadtree.js caps at LOD.triDeg. In the
// settled state that cap holds by construction. While chunks are streaming it
// does not hold at all: terrain.js substitutes a coarse ancestor for anything
// not yet loaded, and that ancestor's triangles are as wide as its own cells --
// a depth-1 stand-in has 512 m cells, so one triangle of it can span a quarter
// of the view. That is the "one big flat white triangle": not terrain of the
// wrong SHAPE, terrain of the wrong RESOLUTION, drawn for a few frames.
//
// Only what is inside the eye cone counts. The rest is culled by the GPU per
// instance and cannot be the thing anyone saw.
const EYE_HALF = (55 * Math.PI) / 180
const CHUNK_RES_P = 16

const drawnTriDeg = (entry, cam) => {
  const n = entry.node
  const cx = n.x + n.size / 2
  const cz = n.z + n.size / 2
  let d = Math.atan2(cx - cam.x, cz - cam.z) - cam.yaw
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  const spread = Math.atan2(n.size * 0.71, Math.max(Math.hypot(cx - cam.x, cz - cam.z), 1))
  if (Math.abs(d) > EYE_HALF + spread) return null // GPU culls it; nobody saw it

  // The selection's own range function, including the Y term. Measuring this
  // horizontally instead reports ground directly under a flying camera as
  // infinitely under-refined, because it is ~0 m away on the map and 300 m away
  // in fact -- which is a bug in the probe, not in the terrain.
  const range = Math.max(nodeRange(cam, n.x, n.z, n.size, terrain.info.get(n.key)), n.size * 0.5)
  // The chunk she is standing on subtends a huge angle no matter how fine it
  // is -- a 1 m cell at 8 m is 7 degrees -- and it is not what anyone means by
  // a glitch. probe-lod.mjs drops the near field for the same reason. Not to
  // flatter the numbers: nothing inside 50 m is ever the thing that pops,
  // because there is no coarser stand-in for ground that close.
  if (range < 50) return null
  return (Math.atan2(n.size / CHUNK_RES_P, range) * 180) / Math.PI
}

const inspect = (cam) => {
  let worstTri = 0
  let worstDepth = null
  let standIns = 0
  for (const entry of terrain._render) {
    const t = drawnTriDeg(entry, cam)
    if (t === null) continue
    if (t > worstTri) { worstTri = t; worstDepth = entry.node.depth }
  }
  // How many of the drawn chunks are stand-ins rather than the node the
  // quadtree actually asked for?
  const desired = selectNodes(cam, { maxDepth: MAX_DEPTH, info: terrain.info })
  const want = new Set(desired.map((n) => n.key))
  for (const entry of terrain._render) if (!want.has(entry.node.key)) standIns++
  return { worstTri, worstDepth, standIns }
}

const groundCam = (x, z, yaw) => ({ x, y: th.heightAt(x, z) + 1.7, z, yaw })

console.log(`\n=== terrain pop probe, seed ${SEED} ===\n`)

// Settle fully at a standing position first.
let cam = groundCam(2200, -1400, 0)
for (let i = 0; i < 400; i++) {
  step(cam)
  if (terrain.stats.pending === 0 && !terrain._dirty) break
}
console.log(`settled: ${terrain.stats.rendered} chunks drawn, ${terrain.stats.cached} cached\n`)

// A stand-in within a few times the triangle cap reads as ordinary LOD. Five
// degrees is where it stops being a swap and starts being a shape that is not
// the mountain -- roughly a fist at arm's length of vertical error.
const BAD_DEG = 5

const results = []
const run = (label, camAt, frames) => {
  let over = 0
  let worst = 0
  let worstFrame = -1
  let worstDepth = null
  let peakStandIns = 0
  for (let f = 0; f < frames; f++) {
    cam = camAt(f)
    step(cam)
    const r = inspect(cam)
    if (r.worstTri > LOD.triDeg * 2) over++
    if (r.worstTri > worst) { worst = r.worstTri; worstFrame = f; worstDepth = r.worstDepth }
    peakStandIns = Math.max(peakStandIns, r.standIns)
  }
  console.log(`${label}`)
  console.log(`  cap is ${LOD.triDeg} deg. WORST TRIANGLE DRAWN: ${worst.toFixed(1)} deg` +
    ` (${(worst / LOD.triDeg).toFixed(0)}x the cap), frame ${worstFrame}, from a depth-${worstDepth} chunk`)
  console.log(`  frames drawing a triangle more than 2x the cap: ${over}/${frames}`)
  console.log(`  peak coarse stand-ins drawn in one frame: ${peakStandIns}\n`)
  const r = { label, worst, over, frames }
  results.push(r)
  return r
}

// 1. Pan in place: no movement at all, just turning the head.
const base = groundCam(2200, -1400, 0)
run('PANNING IN PLACE (180 deg over 60 frames, ~1 s at 72 Hz)', (f) =>
  ({ ...base, yaw: (f / 60) * Math.PI }), 60)

// 2. Walking forward at a brisk pace.
run('WALKING (1.45 m/s for 120 frames)', (f) =>
  groundCam(2200 + f * 0.02, -1400 + f * 0.02, 0), 120)

// 3. Flying, which is where it was first noticed.
run('FLYING (25 m/s at 300 m AGL for 120 frames)', (f) => {
  const x = 2200 + f * 0.35
  const z = -1400 + f * 0.35
  return { x, y: th.heightAt(x, z) + 300, z, yaw: 0.8 }
}, 120)

// --- guard ------------------------------------------------------------------
//
// Panning is the case with no excuse. Turning the head moves nothing and changes
// no node's range, so every chunk the new heading wants was already the right
// answer a moment ago -- if the terrain visibly coarsens, that is the streaming
// system losing work it had, not the world genuinely changing. The binary cull
// failed this in 16 frames out of 60 and drew a 4.4 deg triangle, 4x the cap.
//
// Walking and flying DO reveal ground nobody had a reason to build, so a brief
// coarse stand-in there is the honest cost of streaming rather than a bug. They
// are held to a much looser bound: it has to clear fast, not never happen.

let failures = 0
const check = (ok, label, detail) => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}   ${detail}`)
}

console.log('--- guard ---')
const [pan, walk, fly] = results
check(pan.over === 0, 'panning in place never coarsens the terrain', `${pan.over}/${pan.frames} frames over 2x the cap`)
check(pan.worst <= LOD.triDeg * 1.5, 'panning stays within half a level of the cap', `${pan.worst.toFixed(1)} deg vs ${LOD.triDeg} cap`)
check(walk.over < walk.frames * 0.1, 'walking clears its stand-ins quickly', `${walk.over}/${walk.frames} frames over 2x the cap`)
check(fly.over < fly.frames * 0.1, 'flying clears its stand-ins quickly', `${fly.over}/${fly.frames} frames over 2x the cap`)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
