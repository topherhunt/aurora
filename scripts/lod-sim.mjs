// Headless stand-in for the streaming loop in src/terrain/terrain.js, so probes
// and checks can ask "what does the LOD rule actually settle on" without a
// browser, a GPU or a worker.
//
// One selectNodes() call on an empty table answers a slightly wrong question.
// The range test uses each node's vertical extent, and that extent is only known
// once the mesher has built the node -- until then the node falls back to its
// horizontal distance, which under-estimates range and so over-refines. Settling
// is the honest measurement: select, mesh whatever is new, feed the bounds back,
// select again, until it stops moving.
//
// It converges downward and fast. Bounds can only make a node FURTHER away than
// the horizontal fallback claimed, so each round can only coarsen, and there is
// no oscillation to worry about -- typically two or three rounds.
//
// buildChunk is called rather than reimplementing what it measures, which is the
// point: a probe that models the mesher instead of running it is measuring a
// renderer that does not exist.

import { selectNodes } from '../src/terrain/quadtree.js'
import { buildChunk, CHUNK_RES } from '../src/sim/chunk-mesh.js'

// `info` is shared across calls on purpose: a node's vertical extent is a
// property of the world, not of where anyone is standing, so measuring it once
// and reusing it across every camera in a sweep is both correct and the only
// thing that makes a 60-camera sweep finish.
export function settle(th, cam, info, opts = {}, maxRounds = 16) {
  let sel = []
  for (let round = 0; round < maxRounds; round++) {
    sel = selectNodes(cam, { ...opts, info })
    let fresh = 0
    for (const n of sel) {
      if (info.has(n.key)) continue
      const r = buildChunk(th, { ox: n.x, oz: n.z, size: n.size, res: CHUNK_RES })
      info.set(n.key, { minY: r.minY, maxY: r.maxY })
      fresh++
    }
    if (fresh === 0) return { sel, rounds: round + 1 }
  }
  return { sel, rounds: maxRounds }
}
