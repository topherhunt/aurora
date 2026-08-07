import { TerrainHeight, TUNING, SNOW } from './terrain-height.js'
import { buildChunk } from './chunk-mesh.js'

// ---------------------------------------------------------------------------
// Thin worker shell around chunk-mesh.js.
//
// DESIGN.md §2: "Never generate terrain on the main thread -- hitches read as
// stutter in VR, which is worse for comfort than a lower average framerate."
//
// All the actual work lives in chunk-mesh.js so it can be run and checked in
// Node without a worker global (scripts/check-sim.mjs). This file holds only
// the message plumbing.
// ---------------------------------------------------------------------------

let terrain = null

self.onmessage = (e) => {
  const msg = e.data

  if (msg.type === 'init') {
    terrain = new TerrainHeight(msg.seed)
    self.postMessage({ type: 'ready' })
    return
  }

  // Live retune from the tuning panel. A worker has its OWN module instance, so
  // mutating TUNING on the main thread is invisible here -- the values have to
  // be shipped across explicitly, and a worker that silently kept the old ones
  // would draw terrain that disagrees with what the player collides against.
  //
  // Applied to the existing TUNING object rather than replacing it, because
  // terrain-height.js closed over that object at module load (`const T = TUNING`).
  // SNOW travels with it because chunk-mesh.js paints the snow line into vertex
  // colours here, in the worker -- a snow-line slider that only moved the main
  // thread's copy would change nothing visible at all.
  if (msg.type === 'tuning') {
    Object.assign(TUNING, msg.tuning)
    Object.assign(SNOW, msg.snow)
    self.postMessage({ type: 'tuned', epoch: msg.epoch })
    return
  }

  if (msg.type === 'chunk') {
    if (!terrain) throw new Error('terrain worker got a chunk request before init')
    const t0 = performance.now()
    const r = buildChunk(terrain, msg)
    // Transfer rather than copy: these buffers are the bulk of the per-chunk
    // cost and structured-cloning them would put it back on the main thread,
    // which is the one thing this worker exists to avoid.
    self.postMessage(
      {
        type: 'chunk',
        key: msg.key,
        epoch: msg.epoch,
        positions: r.positions,
        normals: r.normals,
        colors: r.colors,
        indices: r.indices,
        minY: r.minY,
        maxY: r.maxY,
        skirtDepth: r.skirtDepth,
        ms: performance.now() - t0,
      },
      [r.positions.buffer, r.normals.buffer, r.colors.buffer, r.indices.buffer]
    )
    return
  }

  throw new Error(`terrain worker got unknown message type: ${msg.type}`)
}
