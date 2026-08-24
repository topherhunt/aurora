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
import { TerrainHeight, TUNING, SNOW, WORLD_SIZE, WORLD_HALF } from '../src/sim/terrain-height.js'
import { buildChunk, CHUNK_RES } from '../src/sim/chunk-mesh.js'
import { LOD, MIN_TRI_DEG } from '../src/terrain/quadtree.js'
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
    // Mirrors terrain-worker.js's live-retune branch. The stub has to echo the
    // epoch too: the manager drops any chunk whose epoch does not match, so a
    // stub that forgot it would silently deliver nothing at all.
    if (msg.type === 'tuning') {
      Object.assign(TUNING, msg.tuning)
      Object.assign(SNOW, msg.snow)
      pending.push(() => this.onmessage({ data: { type: 'tuned', epoch: msg.epoch } }))
      return
    }
    pending.push(() => {
      const r = buildChunk(th, msg)
      this.onmessage({
        data: {
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

// Selection is view-dependent, so the drill has to carry a heading as well as a
// position. Walking east is arbitrary but fixed: what is being checked here is
// slot bookkeeping, and holding the heading still is the harder case for it --
// a turning camera keeps replacing the whole selection, while a straight walk
// makes the SAME chunks fall in and out of range at the cone edges.
const camAt = (x, z, yaw = 0) => ({ x, y: th.heightAt(x, z) + 1.7, z, yaw })

const settle = (px, pz, frames = 400) => {
  for (let i = 0; i < frames; i++) {
    terrain.update(camAt(px, pz))
    drain()
    if (terrain.stats.pending === 0 && !terrain._dirty) return i
  }
  return frames
}

let peakSlots = 0
let peakCached = 0
let peakDesired = 0
let peakTris = 0
let x = 168
let z = 64
for (let step = 0; step < 400; step++) {
  const ang = step * 0.11
  x += Math.cos(ang) * 45
  z += Math.sin(ang) * 45
  for (let i = 0; i < 6; i++) {
    // Face along the walk, so the streaming margin sweeps the way it does in
    // play rather than trailing a fixed compass bearing.
    terrain.update(camAt(x, z, Math.atan2(Math.cos(ang), Math.sin(ang))))
    drain()
    const s = terrain.stats
    peakSlots = Math.max(peakSlots, s.slots)
    peakCached = Math.max(peakCached, s.cached)
    peakDesired = Math.max(peakDesired, s.desired)
    peakTris = Math.max(peakTris, s.drawnTris)
  }
}

console.log(
  `        walked ~18 km: peak slots ${peakSlots}/${terrain.maxReady} (pool ${SLOT_COUNT}), peak cached ${peakCached}, ` +
    `peak DRAWN ${(peakTris / 1000).toFixed(0)}k tris (${((peakTris / TRI_BUDGET) * 100).toFixed(0)}% of budget)`
)
// Drawn, not resident: the streaming margin keeps ~40% more terrain in the
// render set than the headset's field of view ever rasterises.
check(peakTris < TRI_BUDGET / 3, 'drawn ground never took more than a third of the budget while walking', `${(peakTris / 1000).toFixed(0)}k of ${TRI_BUDGET / 1000}k`)
// Eviction is counted in slot-holding entries, and the margin it leaves under
// SLOT_COUNT is the in-flight cap -- so this is the invariant that keeps
// _onWorkerMessage from ever finding an empty pool.
check(peakSlots <= terrain.maxReady, 'resident chunks stayed inside the eviction target while streaming', `${peakSlots} vs ${terrain.maxReady}`)
// An append-only request queue makes the cache grow without bound (measured at
// 1002 entries over this same walk); a rebuilt one cannot exceed the selection
// plus what is already resident plus the requests in flight for it.
check(peakCached <= SLOT_COUNT + peakDesired, 'request queue did not grow without bound while streaming', `${peakCached} cached vs ${SLOT_COUNT} slots + ${peakDesired} outstanding`)

// --- push the LOD knob to the finest the [ ] keys allow ----------------------
//
// The selection is exempt from eviction, so the pool has to hold the WORST case
// the player can dial in, not the typical one. check-sim.mjs asserts the same
// bound analytically over 605 positions; this one asserts it against the real
// slot allocator, which is where a leak would actually show up.

const wasTriDeg = LOD.triDeg
LOD.triDeg = MIN_TRI_DEG
const frames = settle(x, z)
console.log(
  `        at ${MIN_TRI_DEG}deg (finest the knob reaches): settled in ${frames} frames, ${terrain.stats.rendered}/${terrain.stats.desired} nodes shown, ` +
    `slots ${terrain.stats.slots}/${SLOT_COUNT}, ${(terrain.stats.tris / 1000).toFixed(0)}k tris`
)
check(terrain.stats.slots <= SLOT_COUNT, 'slot pool survived the finest reachable LOD setting', `${terrain.stats.slots} vs ${SLOT_COUNT}`)
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


// --- live retune (the tuning panel's path) -----------------------------------
//
// The panel mutates TUNING on the main thread and asks Terrain to rebuild. Three
// things can go wrong and none of them look like a crash:
//
//   the workers keep the old table, so the drawn mesh and the surface she
//   collides against drift apart;
//   chunks generated before the change land afterwards and leave patches of the
//   previous world behind, which reads as a meshing bug;
//   slots freed during the flush are not all recovered, and the pool bleeds a
//   little on every slider drag.

console.log('\nlive retune')
{
  const sampleY = () => {
    const pos = terrain.batch.geometry.attributes.position.array
    let sum = 0
    let n = 0
    for (const e of terrain.cache.values()) {
      if (!e.slot || !e.visible) continue
      const info = terrain.batch._geometryInfo[e.slot.geometryId]
      sum += pos[info.vertexStart * 3 + 1]
      n++
    }
    return { mean: sum / n, n }
  }

  LOD.triDeg = wasTriDeg
  settle(x, z)
  const before = sampleY()

  // Captured, not hardcoded. The restore at the end of this block used to name
  // its own literals -- massifRelief 370, SNOW.base 95 -- and when SNOW.base
  // moved to 275 for the continent tier the restore silently put the snow line
  // back 180 m too low for every check that runs AFTER this one. Trees, grass
  // and cabins are all quoted relative to that line, so all three placed zero
  // and three prop checks failed with nothing wrong in the code they test.
  const shippedRelief = TUNING.massifRelief
  const shippedSnowBase = SNOW.base

  const epochBefore = terrain.epoch
  terrain.retune({ tuning: { massifRelief: 120 }, snow: { base: 140 } })
  check(terrain.epoch === epochBefore + 1, 'a retune bumps the epoch', `${epochBefore} -> ${terrain.epoch}`)

  // A reply stamped with the previous epoch, delivered by hand. It must be
  // ignored: nothing cached, no slot taken.
  const freeBefore = terrain._free.length
  terrain._onWorkerMessage({ type: 'chunk', key: '0|0|0', epoch: epochBefore, ms: 0.4 })
  check(
    terrain._free.length === freeBefore,
    'a chunk from the previous tuning is dropped rather than shown',
    `${freeBefore} free slots before and after`
  )

  settle(x, z)
  const after = sampleY()
  console.log(
    `        massifRelief ${shippedRelief} -> 120: mean corner height ${before.mean.toFixed(1)}m -> ${after.mean.toFixed(1)}m ` +
      `over ${after.n} visible chunks`
  )
  check(
    Math.abs(after.mean - before.mean) > 5,
    'the drawn mesh actually follows the new tuning',
    `${before.mean.toFixed(1)}m -> ${after.mean.toFixed(1)}m`
  )
  // The workers hold their own module instance of terrain-height.js, so this is
  // the check that the values crossed the postMessage boundary at all.
  check(TUNING.massifRelief === 120 && SNOW.base === 140, 'the worker stub received the new table')

  {
    const seen = new Set()
    for (const e of terrain.cache.values()) if (e.slot) seen.add(e.slot.geometryId)
    for (const sl of terrain._free) seen.add(sl.geometryId)
    check(seen.size === SLOT_COUNT, 'no slots leaked across the retune', `${seen.size} of ${SLOT_COUNT}`)
  }

  // Put the world back before the prop checks, which assume the shipped values.
  terrain.retune({ tuning: { massifRelief: shippedRelief }, snow: { base: shippedSnowBase } })
  drain()
}

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
  const { buildTextureArray } = await import('../src/textures.js')
  const propScene = new THREE.Scene()
  const props = new Scatter(propScene, th, buildTextureArray(), { seed: SEED })

  // TWO batches, not one, and the number is a ceiling rather than a target: the
  // atlas batch is the real pipeline and the placeholder batch is the old
  // vertexColors art on its way out (see the constructor of scatter.js). When
  // the last placeholder kind flips to `atlas: true` this goes back to 1. It
  // must never GROW -- a third child would mean a third material, and a third
  // material would mean BatchedMesh could no longer collapse props into one
  // multi-draw call, which is §5's whole constraint.
  check(
    propScene.children.length <= 2 && propScene.children.every((c) => c.isBatchedMesh === true),
    'props are at most two BatchedMeshes',
    `${propScene.children.length} scene child(ren): ${propScene.children.map((c) => c.name).join(', ')}`
  )

  // One kind rebuilds per update() by design, so settling takes as many calls as
  // there are kinds. Anything that needs a settled world must go through this.
  const settle = (px, pz) => {
    for (let i = 0; i < props.kinds.length + 2; i++) props.update(px, pz)
  }

  // Geometry ids and instance ids are BOTH per-batch, so every read has to go
  // through `s.batch` and not through a batch picked once. Reading a fern's ids
  // out of the placeholder batch does not error -- it silently returns some
  // tree's matrix, which reads as hundreds of ferns floating in mid-air.
  const box = new THREE.Box3()
  for (const s of props.kinds) {
    const sizes = s.geometryIds.map((id) => {
      s.batch.getBoundingBoxAt(id, box)
      return box.max.y - box.min.y
    })
    // A tiered kind bakes tiers x variants geometries, all the same shape at
    // different densities, so summarise rather than printing 48 of them.
    const per = s.geometryIds.length / s.tierCount
    const brief =
      s.tierCount === 1
        ? `${s.trisPer.join('/')} tris   ${sizes.map((h) => h.toFixed(2)).join('/')} m tall`
        : `${per} x ${s.tierCount} tiers, ` +
          `${s.tierTris.map((t) => `${Math.min(...t)}-${Math.max(...t)}`).join(' / ')} tris   ` +
          `${Math.min(...sizes).toFixed(2)}-${Math.max(...sizes).toFixed(2)} m tall`
    console.log(`        ${s.cfg.name.padEnd(6)} ${per} variants   ${brief}`)
  }

  // The brief for boulders was "one metre tall", and it is the one prop whose
  // real size a person can check by eye, so it is worth pinning.
  {
    const rock = props.byName.rock
    rock.batch.getBoundingBoxAt(rock.geometryIds[0], box)
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
        s.batch.getMatrixAt(s.instances[i], m)
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
      s.batch.getMatrixAt(s.instances[i], m)
      m.decompose(p, q, sc)
      // Props are sunk by sink * scale so they do not sit on a visible seam.
      if (Math.abs(p.y - (th.heightAt(p.x, p.z) - k.sink * sc.x)) > 1e-3) floating++
      // Same measure scatter.js filters on -- forward differences at SCARP.eps.
      // Re-deriving it a different way here (central differences at 1.5 m) put
      // the check and the rule a few degrees apart and made props near a cap
      // read as violations when they were placed correctly.
      if (th.heightAndSlopeAt(p.x, p.z).tan > Math.tan((k.maxSlopeDeg * Math.PI) / 180)) tooSteep++
      // snowRel kinds read maxElev as an offset from the LOCAL snow line, so the
      // cap is a field and not a number. Comparing against the raw config value
      // is how this check failed the moment the treeline started following the
      // snow line -- which is the correct failure, but it was the instrument
      // that was wrong, not the placement.
      const cap = k.snowRel ? th.snowLineAt(p.x, p.z) + k.maxElev : k.maxElev
      if (th.heightAt(p.x, p.z) > cap) tooHigh++
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
      tree.batch.getMatrixAt(tree.instances[i], m)
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

// --- surface colour must not depend on LOD -----------------------------------
// The bug this guards against: shade() used to take the MESH normal, which is a
// central difference over the chunk's own cell -- 1 m at a leaf, 128 m at depth
// 3. Steepness is what keeps snow off cliffs, and a face that stands at 74 deg
// over 1 m averages out to 24 deg over 128 m, so coarsening a chunk repainted
// its rock as snow. Flying away from close terrain therefore made the world
// flash white in chunk-shaped squares, one square per LOD swap.
//
// None of the existing drills could see it: they all watch geometry and
// bookkeeping, and this artifact is entirely in the vertex colours.
//
// The test fixes a set of world points, colours each one at every depth, and
// insists the fraction of ground that comes out white does not drift with cell
// size. Per-vertex disagreement is expected and allowed -- a 128 m vertex
// cannot resolve a 20 m snowfield, so it can only report an unbiased sample of
// the steepness around it. What must not happen is a systematic drift, because
// that is what the eye reads as a flash.
{
  console.log('\nsurface colour vs LOD')

  // The material calls a vertex snow at vColor.b > ~0.45 (smoothstep .30...60).
  const isSnow = (b) => b > 0.45
  const chunks = new Map()
  const colorAt = (x, z, depth) => {
    const size = WORLD_SIZE / (1 << depth)
    const ix = Math.floor((x + WORLD_HALF) / size)
    const iz = Math.floor((z + WORLD_HALF) / size)
    const key = `${depth}|${ix}|${iz}`
    let c = chunks.get(key)
    if (!c) {
      const ox = -WORLD_HALF + ix * size
      const oz = -WORLD_HALF + iz * size
      c = { ...buildChunk(th, { ox, oz, size, res: CHUNK_RES }), ox, oz, step: size / CHUNK_RES }
      chunks.set(key, c)
    }
    const i = Math.min(CHUNK_RES, Math.max(0, Math.round((x - c.ox) / c.step)))
    const j = Math.min(CHUNK_RES, Math.max(0, Math.round((z - c.oz) / c.step)))
    return c.colors[(j * (CHUNK_RES + 1) + i) * 3 + 2]
  }

  // Only ground that can hold snow; below the line every depth agrees trivially
  // and would dilute the statistic to nothing.
  const sites = []
  for (let i = 0; sites.length < 400 && i < 200000; i++) {
    const x = ((i * 977) % 12000) - 6000
    const z = ((i * 1597) % 12000) - 6000
    if (th.heightAt(x, z) > th.snowLineAt(x, z)) sites.push({ x, z })
  }

  const DEPTHS = [10, 8, 6, 4, 3]
  const white = new Map()
  for (const d of DEPTHS) {
    let n = 0
    for (const s of sites) if (isSnow(colorAt(s.x, s.z, d))) n++
    white.set(d, n / sites.length)
  }
  console.log(
    `        white fraction by depth: ${DEPTHS.map((d) => `${d}:${(white.get(d) * 100).toFixed(1)}%`).join('  ')}`
  )

  const leaf = white.get(10)
  let worst = 0
  let worstDepth = null
  for (const d of DEPTHS) {
    const drift = Math.abs(white.get(d) - leaf)
    if (drift > worst) { worst = drift; worstDepth = d }
  }
  // Before the fix this drift was 0.243 (31.5% white at the leaf, 55.8% at
  // depth 3) and rose monotonically with cell size. 0.06 leaves room for the
  // sampling noise of 400 sites without leaving room for that.
  check(
    worst < 0.06,
    'snow coverage does not drift as chunks coarsen',
    `worst ${(worst * 100).toFixed(1)} points at depth ${worstDepth}, leaf ${(leaf * 100).toFixed(1)}%`
  )

  // And the drift must not be one-directional, which is the signature of a
  // scale-dependent classifier even when the magnitude is small.
  let up = 0
  for (const d of DEPTHS) if (white.get(d) > leaf) up++
  check(
    up < DEPTHS.length - 1,
    'coarsening does not whiten the world monotonically',
    `${up}/${DEPTHS.length - 1} coarser levels whiter than the leaf`
  )

  // The leaf itself must be untouched by any of this: its cells are already the
  // classification stencil width, so close-up terrain has to be bit-identical
  // to a plain field query.
  {
    const size = WORLD_SIZE / (1 << 10)
    const c = buildChunk(th, { ox: 1024, oz: 2048, size, res: CHUNK_RES })
    let worstDiff = 0
    for (let j = 0; j <= CHUNK_RES; j++) {
      for (let i = 0; i <= CHUNK_RES; i++) {
        const o = (j * (CHUNK_RES + 1) + i) * 3
        const want = th.heightAt(1024 + i * (size / CHUNK_RES), 2048 + j * (size / CHUNK_RES))
        worstDiff = Math.max(worstDiff, Math.abs(c.positions[o + 1] - want))
      }
    }
    check(worstDiff < 1e-4, 'leaf geometry still comes straight off the field', `worst ${worstDiff.toExponential(1)} m`)
  }
}

console.log(`\nres ${CHUNK_RES}: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
