import { Heightmap } from '../height/heightmap.js'
import { V2Height } from '../height/field.js'
import { Layers } from '../layers/layers.js'
import { buildChunkV2 } from './chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The v2 terrain worker. Message plumbing only -- every line that computes
// anything lives in chunk-mesh-v2.js or under height/, so scripts/check-v2-field.mjs
// can exercise the whole pipeline under node with no worker global.
//
// DESIGN.md §2: "Never generate terrain on the main thread -- hitches read as
// stutter in VR, which is worse for comfort than a lower average framerate."
//
// THE PROTOCOL. Fixed by the renderer side; terrain-v2.js codes against it too.
//
//   main -> worker   { type: 'init',   heightmap: { width, height, data, meta }, doc, relief, epoch }
//                    { type: 'layers', doc, epoch }
//                    { type: 'relief', relief, epoch }
//                    { type: 'height', rect, data, epoch }
//                    { type: 'chunk',  key, epoch, ox, oz, size, res }
//   worker -> main   { type: 'ready' }
//                    { type: 'layered',  epoch, bakeMs }
//                    { type: 'relieved', epoch, ms }
//                    { type: 'chunk',    key, epoch, positions, normals, colors, indices, minY, maxY, skirtDepth, ms }
//
// `height` has no reply. Messages from one port arrive in order, so a chunk
// request posted after a patch is meshed against the patched field by
// construction, and there is nothing for the main thread to wait on.
//
// WHY `relief` IS ON THE WIRE AT ALL, when the seed deliberately is not (see
// onInit, and WORLD_SEED in height/field.js). The seed can be a shared module
// constant because it never changes; the relief knobs are live and authored, so
// there is nothing for both sides to default to. The composed field is evaluated
// in THREE places that do not share memory -- the main thread does player
// collision, the editor raycast and the prop scatter, and each worker meshes --
// so a relief that reaches the mesher and not the main thread makes the ground
// she is DRAWN standing on and the ground she COLLIDES with two different
// surfaces, and she hovers or sinks with nothing thrown anywhere. That is why it
// travels on the same footing as the layers document, through the same epoch,
// rather than being read out of a global on whichever thread happens to look.
//
// `epoch` is the whole concurrency story. A chunk is meshed against whichever
// document the worker holds, and the reply carries the epoch it was built from,
// so terrain-v2.js can drop a mesh that arrived after the author moved the river
// it was cut around. The worker never reorders and never queues: it answers in
// arrival order and lets the epoch sort out what is stale.
// ---------------------------------------------------------------------------

let field = null
let layers = null

function onInit(msg) {
  // fromRaw, not a second decode. The main thread has already parsed the PNG to
  // put it on the screen's side of the pipeline; shipping the decoded metres and
  // TRANSFERRING the buffer costs nothing on either end, where a second decode
  // would be a 1024^2 inflate blocking this worker's first chunk. The buffer
  // arrives neutered on the main thread, which is correct -- the renderer never
  // samples the coarse field.
  const heightmap = Heightmap.fromRaw(msg.heightmap)
  layers = Layers.deserialize(msg.doc)
  bakeSnow()
  // No seed in the message, deliberately: V2Height defaults it from a shared
  // module constant so this worker's field and the main thread's collision field
  // cannot drift apart. See WORLD_SEED in height/field.js.
  //
  // `relief` is the mirror case and takes the opposite route for the same
  // reason. It is authored and it moves, so there is no constant either side
  // could default to, and the only way this field and the main thread's stay the
  // same surface is for the value to arrive here from the one place that owns
  // it. Passed straight through rather than defaulted: normalizeRelief throws on
  // an unknown key, so a protocol that has drifted takes the worker down at init
  // instead of meshing a world with one knob quietly missing.
  field = new V2Height({ heightmap, layers, relief: msg.relief })
  // Force the lazy percentile pass now rather than inside the first chunk, where
  // it would show up as one inexplicably slow mesh in the ms/chunk numbers.
  field.bands
  self.postMessage({ type: 'ready' })
}

// Layers.deserialize does NOT bake the snow grid -- SnowField bakes lazily, on
// the first deltaAt. Left alone that puts a full GRID_RES^2 bake inside whichever
// chunk happens to ask first, which is both a mystery spike in the per-chunk
// timings and a stall on the wrong side of the ready message. Bake it here, where
// it can be measured and reported.
function bakeSnow() {
  const t0 = performance.now()
  layers.snow.bake()
  return performance.now() - t0
}

self.onmessage = (e) => {
  const msg = e.data

  if (msg.type === 'init') {
    onInit(msg)
    return
  }

  if (msg.type === 'layers') {
    if (!field) throw new Error('v2 terrain worker got a layers message before init')
    // A FRESH deserialize rather than a mutation. The document is the authored
    // truth and the baked structures are derived from it; rebuilding from the
    // document is the only way to be sure a deleted element left nothing behind
    // in a spatial index. §18's two-representation rule, enforced by throwing the
    // old object away.
    const t0 = performance.now()
    layers = Layers.deserialize(msg.doc)
    bakeSnow()
    // setLayers, not `field.layers =`: the fast-path cache is keyed on the
    // epoch and a fresh document restarts at 0. See V2Height.setLayers.
    field.setLayers(layers)
    const bakeMs = performance.now() - t0
    self.postMessage({ type: 'layered', epoch: msg.epoch, bakeMs })
    return
  }

  if (msg.type === 'relief') {
    if (!field) throw new Error('v2 terrain worker got a relief message before init')
    // Unlike 'layers' there is nothing to deserialize and nothing to rebake here:
    // the knobs are a plain validated object and V2Height.setRelief does the
    // whole rebuild internally, in the same order the constructor used, so a knob
    // cannot behave differently depending on whether it was on at boot.
    //
    // THIS IS THE EXPENSIVE MESSAGE ON THIS PORT, by a wide margin, and it is
    // measured for that reason. With `erode` up the rebuild is a talus relaxation
    // over the whole 1024^2 field -- about 240 ms, against 55 ms with erosion off
    // -- and it blocks this worker, so every chunk request queued behind it waits
    // it out. The main thread is doing the identical rebuild on its own copy of
    // the field at the same time, so the wall-clock is one rebuild rather than
    // three, and `ms` is what lets the panel say that out loud rather than
    // leaving a quarter-second of stalled streaming looking like a hang.
    const t0 = performance.now()
    field.setRelief(msg.relief)
    // Same reason onInit does it: the relief invalidated the percentile
    // histogram (erosion moves the texels it is built from), and leaving it lazy
    // would put the rebuild inside whichever chunk asked first and show up as one
    // inexplicably slow mesh in the ms/chunk numbers.
    field.bands
    self.postMessage({ type: 'relieved', epoch: msg.epoch, ms: performance.now() - t0 })
    return
  }

  if (msg.type === 'height') {
    if (!field) throw new Error('v2 terrain worker got a height patch before init')
    // The one edit that writes the IMPORT rather than the document, so unlike
    // 'layers' there is nothing to deserialize and nothing to rebuild: the texels
    // are the truth and Heightmap.patch stamps them in place.
    //
    // TWO DERIVED THINGS ARE DELIBERATELY NOT REFRESHED HERE.
    //
    // field.bands is the altitude ramp, a set of percentiles over all 1024^2
    // texels. A stroke moves a few hundred of them, which cannot move a
    // percentile -- and clearing it would recompute the histogram inside whichever
    // chunk asked first, mid-drag, then paint the freshly meshed chunks off a
    // ramp their unmeshed neighbours are not using. A seam that follows the brush
    // is a worse lie than a ramp that is a stroke out of date.
    //
    // THAT IS NO LONGER TRUE OF `bands`, and it was not this file that changed
    // it. V2Height.coarsePatched, which the erosion knob obliges the call to
    // below, opens by setting `_bands = null` UNCONDITIONALLY -- erode off
    // included -- so as of the relief knobs every stroke does put the 1024^2
    // histogram back inside whichever chunk asks first, which is exactly the
    // brush-following seam the paragraph above exists to prevent. It is not this
    // file's to fix: the invalidation belongs to the eroded ground moving, not to
    // the patch, so the guard belongs under the `needs.erode` return in
    // field.js. Until it moves, this is the first thing to suspect if the sculpt
    // brush starts leaving a colour edge trailing behind it again.
    //
    // field.calibration.rough is the detail amplitude, fitted to the IMPORT'S
    // structure function at 2 and 4 texel lags across the whole world. It
    // describes the spectrum of the source image, not the ground under the
    // cursor. Both refresh on the next load, which is also when the sculpt
    // becomes part of the import rather than an edit on top of it.
    field.heightmap.patch(msg.rect, msg.data)
    // The import is not what the world is sampled from once `erode` is up --
    // `field.ground` is a relaxed COPY of it, and a stroke that updated the
    // import and not the copy is a brush that draws nothing here while the main
    // thread's field, which got the same patch, moves under her. She would then
    // be colliding with ground this worker never meshed. coarsePatched re-relaxes
    // the same rect the patch just wrote plus the halo material can travel
    // across, so it costs the rect rather than the field.
    field.coarsePatched(msg.rect)
    return
  }

  if (msg.type === 'chunk') {
    if (!field) throw new Error('v2 terrain worker got a chunk request before init')
    const t0 = performance.now()
    const r = buildChunkV2(field, layers, msg)
    // Transfer rather than copy: these four buffers are the bulk of the per-chunk
    // cost and structured-cloning them would put that cost back on the main
    // thread, which is the one thing this worker exists to avoid.
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

  // Not a warning. An unrecognised type means the two sides of a fixed protocol
  // have drifted, and a worker that shrugs at it produces a world that is quietly
  // missing whatever the message was for.
  throw new Error(`v2 terrain worker got unknown message type: ${msg.type}`)
}
