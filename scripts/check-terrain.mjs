// Streaming drill for the terrain chunk manager (src/terrain/terrain.js).
//
// terrain.js puts every chunk into a fixed slot inside one BatchedMesh so the
// whole world costs a single draw call (see the header comment there). The
// failure modes of that design are all bookkeeping ones -- a slot handed out
// twice, a slot leaked on eviction, an instance left visible after its chunk
// was recycled, geometry written at the wrong offset -- and every one of them
// is invisible in a screenshot and cheap to check here.
//
// The DOM Worker is stubbed and buildChunk is called synchronously, so this
// exercises the real Terrain class without a browser. It does NOT compile a
// shader or draw anything; that still has to happen on screen.
//
//   node scripts/check-terrain.mjs

import * as THREE from 'three'
import { TerrainHeight } from '../src/sim/terrain-height.js'
import { buildChunk, CHUNK_RES } from '../src/sim/chunk-mesh.js'
import { MAX_SPLIT_K } from '../src/terrain/quadtree.js'
import { TRI_BUDGET } from '../src/budget.js'

const SEED = Number(process.argv[2] ?? 20260804)
const th = new TerrainHeight(SEED)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- worker stub ------------------------------------------------------------
// Replies are queued rather than delivered inline so the manager still sees
// requests complete asynchronously, which is when eviction races would show up.

const pending = []

globalThis.Worker = class {
  constructor() {
    this.onmessage = null
    this.onerror = null
  }
  postMessage(msg) {
    if (msg.type === 'init') {
      pending.push(() => this.onmessage({ data: { type: 'ready' } }))
      return
    }
    pending.push(() => {
      const r = buildChunk(th, msg)
      this.onmessage({
        data: {
          type: 'chunk',
          key: msg.key,
          positions: r.positions,
          normals: r.normals,
          colors: r.colors,
          indices: r.indices,
          minY: r.minY,
          maxY: r.maxY,
          skirtDepth: r.skirtDepth,
          ms: 0.4,
        },
      })
    })
  }
  terminate() {}
}

// Imported after the stub is installed, because the constructor spawns workers.
const { Terrain, SLOT_COUNT, CHUNK_VERTS, CHUNK_INDICES } = await import('../src/terrain/terrain.js')

console.log(`\n=== terrain streaming drill, seed ${SEED} ===\n`)

const scene = new THREE.Scene()
const terrain = new Terrain(scene, { seed: SEED, workers: 2 })

const drain = () => {
  let n = 0
  while (pending.length) {
    pending.shift()()
    if (++n > 20000) throw new Error('worker stub did not converge')
  }
}

// The whole point: object count is decoupled from draw calls.
check(
  scene.children.length === 1 && scene.children[0].isBatchedMesh === true,
  'all terrain is one BatchedMesh in the scene',
  `${scene.children.length} scene child(ren)`
)

// --- walk a long, curving path so slots are recycled hard --------------------
//
// One update() per simulated frame, which is how main.js drives it. Walking
// speed is exaggerated (7.5 m per frame vs 1.45 m/s) to put the streaming path
// under far more pressure than she can actually generate on foot.

const settle = (px, pz, frames = 400) => {
  for (let i = 0; i < frames; i++) {
    terrain.update(px, pz)
    drain()
    if (terrain.stats.pending === 0 && !terrain._dirty) return i
  }
  return frames
}

let peakSlots = 0
let peakCached = 0
let peakTris = 0
let x = 168
let z = 64
for (let step = 0; step < 400; step++) {
  const ang = step * 0.11
  x += Math.cos(ang) * 45
  z += Math.sin(ang) * 45
  for (let i = 0; i < 6; i++) {
    terrain.update(x, z)
    drain()
    const s = terrain.stats
    peakSlots = Math.max(peakSlots, s.slots)
    peakCached = Math.max(peakCached, s.cached)
    peakTris = Math.max(peakTris, s.tris)
  }
}

console.log(
  `        walked ~18 km: peak slots ${peakSlots}/${SLOT_COUNT}, peak cached ${peakCached}/${terrain.maxCached}, ` +
    `peak visible ${(peakTris / 1000).toFixed(0)}k tris (${((peakTris / TRI_BUDGET) * 100).toFixed(0)}% of budget)`
)
check(peakTris < TRI_BUDGET / 3, 'ground never took more than a third of the budget while walking')
// An append-only request queue makes this grow without bound; a rebuilt one
// cannot exceed the selection plus what is already resident.
check(peakCached <= terrain.maxCached, 'cache stayed inside its cap while streaming', `${peakCached} vs ${terrain.maxCached}`)

// --- push splitK to the ceiling the [ ] keys allow ---------------------------

terrain.splitK = MAX_SPLIT_K
const frames = settle(x, z)
console.log(
  `        at splitK ${MAX_SPLIT_K}: settled in ${frames} frames, ${terrain.stats.rendered}/${terrain.stats.desired} nodes shown, ` +
    `slots ${terrain.stats.slots}/${SLOT_COUNT}, ${(terrain.stats.tris / 1000).toFixed(0)}k tris`
)
check(terrain.stats.slots <= SLOT_COUNT, 'slot pool survived the worst reachable splitK')
// Once nothing is in flight, every desired leaf must be resident in its own
// right -- any shortfall means a coarse ancestor is permanently standing in for
// a chunk that will never be requested.
check(
  terrain.stats.rendered === terrain.stats.desired,
  'at rest, every desired node has its own chunk',
  `${terrain.stats.rendered}/${terrain.stats.desired}`
)

// --- bookkeeping integrity ---------------------------------------------------

{
  const seen = new Set()
  let dupe = 0
  for (const e of terrain.cache.values()) {
    if (!e.slot) continue
    if (seen.has(e.slot.geometryId)) dupe++
    seen.add(e.slot.geometryId)
  }
  const heldCount = seen.size
  for (const s of terrain._free) {
    if (seen.has(s.geometryId)) dupe++
    seen.add(s.geometryId)
  }
  check(dupe === 0, 'no slot is held twice or both free and held', `${dupe} conflicts`)
  check(seen.size === SLOT_COUNT, 'no slots leaked on eviction', `${heldCount} held + ${terrain._free.length} free = ${seen.size} of ${SLOT_COUNT}`)
}

{
  let mismatch = 0
  for (const e of terrain.cache.values()) {
    if (!e.slot) continue
    if (terrain.batch.getVisibleAt(e.slot.instanceId) !== e.visible) mismatch++
  }
  check(mismatch === 0, 'batch visibility matches cache state', `${mismatch} diverged`)
}

// Geometry must land at its slot's own offset. Getting this wrong draws one
// chunk's terrain at another chunk's position, which reads as the world
// tearing rather than as an obvious crash.
{
  let bad = 0
  let checked = 0
  const pos = terrain.batch.geometry.attributes.position.array
  for (const e of terrain.cache.values()) {
    if (!e.slot) continue
    const info = terrain.batch._geometryInfo[e.slot.geometryId]
    const y = pos[info.vertexStart * 3 + 1]
    if (Math.abs(y - th.heightAt(e.node.x, e.node.z)) > 1e-3) bad++
    checked++
  }
  check(bad === 0, 'every resident chunk sits at its own slot offset', `${bad} of ${checked} misplaced`)
}

// The index buffer stores absolute positions into the shared vertex array, so
// an off-by-vertexStart here silently stitches two chunks together.
{
  let oob = 0
  const idx = terrain.batch.geometry.index.array
  for (const e of terrain.cache.values()) {
    if (!e.slot) continue
    const info = terrain.batch._geometryInfo[e.slot.geometryId]
    for (let i = 0; i < CHUNK_INDICES; i++) {
      const v = idx[info.indexStart + i]
      if (v < info.vertexStart || v >= info.vertexStart + CHUNK_VERTS) oob++
    }
  }
  check(oob === 0, 'indices stay inside their own slot', `${oob} strays`)
}

check(
  terrain.batch.geometry.index.array.BYTES_PER_ELEMENT === 4,
  'batch index widened to 32-bit for the pooled vertex count',
  `${SLOT_COUNT * CHUNK_VERTS} verts`
)

console.log(`\nres ${CHUNK_RES}: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
