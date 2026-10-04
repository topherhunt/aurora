// Meshes one cave system off the main thread (design/39-caves.md §4): plans it from { seed, entries }, then posts its chunks nearest `from` first, each at both LODs, and 'near' once every chunk within NEAR_M of it is out, so the room round her arrival is ready long before the far caverns.

import { planCave } from './build.js'
import { chunkList, meshChunk, CHUNK, VOXEL, VOXEL_LO } from './mesh.js'

const NEAR_M = 28
let job = 0

self.onmessage = (ev) => {
  const { id, seed, entries, from, cancel } = ev.data
  job = id
  if (cancel) return
  const cave = planCave({ seed, entries })
  const list = chunkList(cave.field)
  const dist = ([i, j, k]) => Math.hypot((i + 0.5) * CHUNK - from.x, (j + 0.5) * CHUNK - from.y, (k + 0.5) * CHUNK - from.z)
  list.sort((a, b) => dist(a) - dist(b))
  let n = 0
  let near = false
  const next = () => {
    // A newer job supersedes this one; its own onmessage has already started.
    if (job !== id) return
    const t0 = performance.now()
    while (n < list.length && performance.now() - t0 < 30) {
      if (!near && dist(list[n]) > NEAR_M) {
        near = true
        self.postMessage({ id, type: 'near' })
      }
      const [i, j, k] = list[n++]
      for (const [lod, voxel] of [[0, VOXEL], [1, VOXEL_LO]]) {
        const m = meshChunk(cave.field, i, j, k, cave.lights, voxel)
        if (m === null) continue
        self.postMessage({ id, type: 'chunk', key: `${i},${j},${k}`, lod, ...m }, [m.position.buffer, m.normal.buffer, m.color.buffer, m.glow.buffer, m.index.buffer, m.parts.buffer])
      }
    }
    if (n < list.length) setTimeout(next, 0)
    else {
      if (!near) self.postMessage({ id, type: 'near' })
      self.postMessage({ id, type: 'done', chunks: list.length })
    }
  }
  next()
}
