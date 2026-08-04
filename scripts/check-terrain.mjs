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


// --- scattered props ---------------------------------------------------------
//
// A scale reference, not the placement system (§6). Three things matter and all
// three are invisible in a screenshot:
//
//   Determinism. Props that shuffle when she walks away and back are worse than
//   no props at all for judging distance, and the bug only shows up on a return
//   trip nobody makes by accident.
//   Grounding. A cabin floating over a gorge is the loudest possible tell that
//   placement and the height field disagree.
//   Cost. The rebuild is synchronous main-thread work between two frames.

console.log('\nscale-reference props')
{
  const { Scatter } = await import('../src/props/scatter.js')
  const propScene = new THREE.Scene()
  const props = new Scatter(propScene, th, { seed: SEED })

  check(propScene.children.length === 1, 'all props are one BatchedMesh', `${propScene.children.length} scene child(ren)`)

  // One kind rebuilds per update() by design, so settling takes as many calls as
  // there are kinds. Anything that needs a settled world must go through this.
  const settle = (px, pz) => {
    for (let i = 0; i < props.kinds.length + 2; i++) props.update(px, pz)
  }

  const box = new THREE.Box3()
  for (const s of props.kinds) {
    const sizes = s.geometryIds.map((id) => {
      props.batch.getBoundingBoxAt(id, box)
      return box.max.y - box.min.y
    })
    console.log(
      `        ${s.cfg.name.padEnd(6)} ${s.geometryIds.length} variants   ` +
        `${s.trisPer.join('/')} tris   ${sizes.map((h) => h.toFixed(2)).join('/')} m tall`
    )
  }

  // The brief for boulders was "one metre tall", and it is the one prop whose
  // real size a person can check by eye, so it is worth pinning.
  {
    const rock = props.byName.rock
    props.batch.getBoundingBoxAt(rock.geometryIds[0], box)
    const h = box.max.y - box.min.y
    check(h > 0.75 && h < 1.35, 'the base boulder is about a metre tall', `${h.toFixed(2)} m`)
  }

  const SITES = [
    [114, 39],
    [1200, -800],
    [-3000, 2400],
    [5000, 5000],
  ]

  const snapshot = (px, pz) => {
    settle(px, pz)
    const m = new THREE.Matrix4()
    const out = {}
    for (const s of props.kinds) {
      const rows = []
      for (let i = 0; i < s.count; i++) {
        props.batch.getMatrixAt(s.instances[i], m)
        rows.push(m.elements.slice())
      }
      out[s.cfg.name] = rows
    }
    return out
  }

  let worstMs = 0
  let anyCapped = false
  for (const [px, pz] of SITES) {
    const before = snapshot(px, pz)
    worstMs = Math.max(worstMs, props.stats.lastBuildMs)
    anyCapped = anyCapped || props.stats.capped
    const summary = props.kinds.map((s) => `${s.cfg.name} ${s.count}`).join(' ')
    const tris = props.stats.tris

    // Far enough away that every kind is rebuilt from scratch, then back.
    snapshot(px + 4000, pz - 4000)
    const after = snapshot(px, pz)

    let drift = 0
    for (const name of Object.keys(before)) {
      const a = before[name]
      const b = after[name]
      if (a.length !== b.length) {
        drift = Infinity
        continue
      }
      for (let i = 0; i < a.length; i++) {
        for (let k = 0; k < 16; k++) if (a[i][k] !== b[i][k]) drift++
      }
    }
    check(drift === 0, `at ${px},${pz}: placement is stable across a round trip`, `${summary}, ${(tris / 1000).toFixed(1)}k tris`)
  }

  console.log(`        worst single-kind rebuild ${worstMs.toFixed(1)}ms`)
  // One frame at 72 Hz is 13.9 ms and the terrain, the quadtree and the render
  // all have to fit in it too.
  check(worstMs < 4, 'a rebuild fits inside a frame with room to spare', `${worstMs.toFixed(1)}ms`)
  check(!anyCapped, 'no kind hit its instance cap')

  // Only one kind may rebuild per update(), or a bad moment stacks all four.
  //
  // The walk is deterministic, so the three passes do identical work and differ
  // only in noise -- a GC pause landing inside a rebuild swung this from 2.1 ms
  // to 5.1 ms between runs and failed the build for nothing. Taking the min of
  // the three per-pass worsts measures the work rather than the interruption.
  {
    let worstPerCall = Infinity
    for (let pass = 0; pass < 3; pass++) {
      settle(600, 600)
      let worst = 0
      for (let i = 0; i < 60; i++) {
        const before = props.stats.lastBuildKind + '|' + props.frame
        props.update(600 + i * 9, 600 + i * 9)
        if (props.stats.lastBuildMs > worst && props.stats.lastBuildKind !== before) {
          worst = props.stats.lastBuildMs
        }
      }
      worstPerCall = Math.min(worstPerCall, worst)
    }
    check(worstPerCall < 4, 'no single update() call exceeds one kind of work', `${worstPerCall.toFixed(1)}ms while walking`)
  }

  // Placement rules. Every prop on the height field, under its own ceiling, off
  // ground it has no business being on.
  settle(114, 39)
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const sc = new THREE.Vector3()
  for (const s of props.kinds) {
    const k = s.cfg
    let floating = 0
    let tooSteep = 0
    let tooHigh = 0
    let outside = 0
    // The disc is centred on the kind's own rebuild cell, not on the camera --
    // grass rebuilds every 14 m but places every 4.6 m, so it lags deliberately.
    // Measure the radius from the centre that was actually used.
    const grid = k.rebuildEvery ?? k.spacing
    const ox = s.cellX * grid
    const oz = s.cellZ * grid
    for (let i = 0; i < s.count; i++) {
      props.batch.getMatrixAt(s.instances[i], m)
      m.decompose(p, q, sc)
      // Props are sunk by sink * scale so they do not sit on a visible seam.
      if (Math.abs(p.y - (th.heightAt(p.x, p.z) - k.sink * sc.x)) > 1e-3) floating++
      if (th.slopeAt(p.x, p.z, 1.5) > (k.maxSlopeDeg * Math.PI) / 180) tooSteep++
      if (th.heightAt(p.x, p.z) > k.maxElev) tooHigh++
      if (Math.hypot(p.x - ox, p.z - oz) > k.radius + 1) outside++
    }
    // ...and that the lag can never leave her standing outside her own disc.
    check(
      Math.hypot(114 - ox, 39 - oz) < k.radius * 0.5,
      `${k.name}: she stays well inside her own scatter disc`,
      `${Math.hypot(114 - ox, 39 - oz).toFixed(1)} m off centre, radius ${k.radius}`
    )
    check(
      floating === 0 && tooSteep === 0 && tooHigh === 0 && outside === 0,
      `${k.name}: placement obeys its own rules`,
      `${s.count} placed, ${floating} floating, ${tooSteep} too steep, ${tooHigh} too high, ${outside} beyond radius`
    )
  }

  // The whole point of the density taper is that there are more props nearby
  // than far away. A hard cull radius would give a flat distribution instead.
  {
    const tree = props.byName.tree
    let inner = 0
    let outer = 0
    const rr = tree.cfg.radius
    for (let i = 0; i < tree.count; i++) {
      props.batch.getMatrixAt(tree.instances[i], m)
      m.decompose(p, q, sc)
      const d = Math.hypot(p.x - 114, p.z - 39)
      // Equal-area rings, so a flat density would put the same count in each.
      if (d < rr / Math.SQRT2) inner++
      else outer++
    }
    console.log(`        trees by equal-area ring: ${inner} inner / ${outer} outer`)
    check(inner > outer * 1.25, 'density genuinely tapers with distance', `${inner} vs ${outer}`)
  }

  // Cabins are rare on purpose but must not be so rare they never appear.
  {
    let seen = 0
    for (let i = 0; i < 12; i++) {
      settle(i * 900 - 4000, 2200 - i * 700)
      seen += props.byName.cabin.count
    }
    check(seen > 0, 'cabins appear somewhere across 12 sample sites', `${seen} total`)
  }

  props.dispose()
}

console.log(`\nres ${CHUNK_RES}: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
