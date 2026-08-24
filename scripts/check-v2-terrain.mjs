// Node-side gate for the v2 chunk streamer's POLICY -- src/v2/terrain/stream-policy.js
// (DESIGN.md §18).
//
//   node scripts/check-v2-terrain.mjs
//
// scripts/check-v2.mjs owns the combined run and imports run() from here.
//
// WHAT THIS GATE CAN AND CANNOT SEE, stated up front so nothing here implies
// coverage it does not have.
//
// src/v2/terrain/terrain-v2.js imports three.js and constructs Worker in its
// constructor, so it cannot be instantiated in node and a gate that imported it
// could only assert that the file parses. That is not worth writing down.
// scripts/check-terrain.mjs solves the same problem for v1 by stubbing
// globalThis.Worker and calling the mesher synchronously, and that route is open
// to v2 as well -- but only once src/v2/terrain/worker.js and chunk-mesh-v2.js
// exist, and it still cannot see anything the GPU does.
//
// So this gate takes the other half: every decision the streamer makes that is a
// function of bookkeeping state rather than of three.js now lives in
// stream-policy.js as a named function with arguments and a return value, and
// this file drives all of them. That split is a real structural improvement over
// v1 -- terrain.js interleaves the eviction policy, both fallback walks and the
// staleness gate into loops over `this`, where none of them can be called, named
// or reasoned about in isolation -- and the fact that it also makes them testable
// is the confirmation rather than the motive.
//
// NOT COVERED HERE, and the list is deliberate:
//
//   - BatchedMesh slot mechanics. Whether setGeometryAt writes at the right
//     offset, whether a freed instance stops drawing, whether indices stay inside
//     their own slot. check-terrain.mjs asserts all of that for v1 against a real
//     THREE.BatchedMesh and the v2 equivalent needs the worker to exist first.
//   - The worker round trip. postMessage ordering, the heightmap transfer, the
//     epoch a worker actually echoes. The staleness rule below LEANS on that
//     ordering, and this gate asserts the rule given the ordering rather than the
//     ordering itself.
//   - Visual hole-freeness. That the cover a walk returns actually tiles the node
//     on screen with no crack is asserted here combinatorially (a cover is
//     complete or it is empty) and not optically.
//   - Timing. Nothing here measures a frame.

import {
  boxesOverlap,
  cellSize,
  invalidatedKeys,
  nodeBox,
  nodeBoxFromKey,
  validRect,
  makeFloors,
  replyFloor,
  acceptsReply,
  invalidateKeys,
  invalidateAll,
  pruneFloors,
  loadedAncestorKey,
  loadedDescendantKeys,
  slotBudget,
  selectEvictions,
  staleQueuedKeys,
} from '../src/v2/terrain/stream-policy.js'
import { nodeKey, unpackKey, selectNodes, LOD, MIN_TRI_DEG } from '../src/v2/terrain/quadtree-v2.js'
import { WORLD_SIZE, WORLD_HALF, CHUNK_RES, MAX_DEPTH, SLOT_COUNT, PINNED_CHUNKS } from '../src/v2/config.js'

// The shipped construction defaults from terrain-v2.js. Duplicated rather than
// imported because importing terrain-v2.js pulls in three.js and Worker; the
// gate asserts the arithmetic these produce, so a drift between the two files
// shows up as a failing budget check rather than as silence.
const WORKERS = 2
const QUEUE_DEPTH = 24

export async function run() {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log(`\n=== v2 terrain streaming policy, world ${WORLD_SIZE} m, MAX_DEPTH ${MAX_DEPTH}, pool ${SLOT_COUNT} ===\n`)

  // --- 1. node keys ---------------------------------------------------------
  //
  // Everything below is a Map keyed on a packed integer, so injectivity of the
  // packing is the assumption under every other section: two nodes that collide
  // on a key are two owners of one slot, which is a chunk drawn in the wrong
  // place at best and a leaked slot at worst.
  //
  // EXHAUSTIVE, not sampled. The world box moved twice during this build -- 16 km,
  // then 4 km, then 8 km, with MAX_DEPTH following 14 -> 12 -> 13 -- and each move
  // changed how many bits the index fields need. The strides survived all three
  // because they were sized for 14 bits from the start, but a spot check would not
  // have noticed if they had not. Every valid (depth, ix, iz) triple at every depth
  // is 89478485 of them, and round-tripping all of them through unpackKey is a
  // COMPLETE injectivity proof rather than evidence -- an inverse that agrees
  // everywhere cannot exist for a collision -- in O(1) memory. It costs about
  // 480 ms, which is what makes exhaustive affordable at all.

  console.log('node keys')
  {
    const t0 = performance.now()
    let n = 0
    let bad = 0
    let maxKey = -1
    let prevBandMax = -1
    let bandOverlap = 0
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const span = 1 << depth
      let bandMin = Infinity
      let bandMax = -Infinity
      for (let iz = 0; iz < span; iz++) {
        for (let ix = 0; ix < span; ix++) {
          const key = nodeKey(depth, ix, iz)
          const u = unpackKey(key)
          if (u.depth !== depth || u.ix !== ix || u.iz !== iz) bad++
          if (key > maxKey) maxKey = key
          if (key < bandMin) bandMin = key
          if (key > bandMax) bandMax = key
          n++
        }
      }
      if (bandMin <= prevBandMax) bandOverlap++
      prevBandMax = bandMax
    }
    const ms = performance.now() - t0
    console.log(`        ${n} triples round-tripped in ${ms.toFixed(0)} ms, max key ${maxKey}`)
    check(bad === 0, 'every (depth, ix, iz) at every depth survives nodeKey -> unpackKey', `${bad} of ${n} wrong`)
    check(bandOverlap === 0, 'no depth band overlaps the one below it', `${bandOverlap} overlaps`)
    check(Number.isSafeInteger(maxKey), 'the largest key is an exact integer', `${maxKey} vs 2^53 = ${Number.MAX_SAFE_INTEGER}`)

    // Out of range must throw rather than alias onto a neighbour's key.
    let threw = 0
    for (const [d, ix, iz] of [
      [MAX_DEPTH + 1, 0, 0],
      [3, 8, 0],
      [3, 0, 8],
      [3, -1, 0],
    ]) {
      try {
        nodeKey(d, ix, iz)
      } catch {
        threw++
      }
    }
    check(threw === 4, 'out-of-range node coordinates throw rather than aliasing', `${threw}/4 threw`)
  }

  // --- 2. invalidation by dirty rect ---------------------------------------
  //
  // The new logic in v2 and the one most likely to be wrong. Dragging one river
  // control point must free the chunks the edit touched and NOTHING else, or the
  // world dissolves while the mouse is down.
  //
  // The oracle here is a brute-force box test written independently of the one in
  // stream-policy.js, so the two agreeing is a real check rather than the same
  // expression compared with itself.

  console.log('\ninvalidation by dirty rect')
  {
    // A resident set spanning every depth 0..MAX_DEPTH, biased towards a corner
    // of the world so the rects below straddle real boundaries rather than only
    // the origin. Deterministic LCG, same shape check-sim.mjs uses.
    let s = 20260824
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    const resident = []
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const span = 1 << depth
      const want = Math.min(span * span, 40)
      const seen = new Set()
      while (seen.size < want) {
        const ix = Math.floor(rnd() * span)
        const iz = Math.floor(rnd() * span)
        const key = nodeKey(depth, ix, iz)
        if (seen.has(key)) continue
        seen.add(key)
        resident.push(key)
      }
    }

    const depthsPresent = new Set(resident.map((k) => unpackKey(k).depth))
    check(depthsPresent.size === MAX_DEPTH + 1, `the resident fixture covers every depth 0..${MAX_DEPTH}`, `${depthsPresent.size} depths, ${resident.length} nodes`)

    // The independent oracle: expand the node's corners and compare, closed
    // interval on both axes.
    const oracle = (key, r) => {
      const { depth, ix, iz } = unpackKey(key)
      const size = WORLD_SIZE / (1 << depth)
      const x0 = -WORLD_HALF + ix * size
      const z0 = -WORLD_HALF + iz * size
      const x1 = x0 + size
      const z1 = z0 + size
      const xHit = x0 <= r.maxX && x1 >= r.minX
      const zHit = z0 <= r.maxZ && z1 >= r.minZ
      return xHit && zHit
    }

    const RECTS = [
      { minX: -100, minZ: -100, maxX: 100, maxZ: 100 }, // a snow point at the origin
      { minX: 300, minZ: -1900, maxX: 640, maxZ: -1500 }, // a river drag, off-centre
      { minX: -WORLD_HALF, minZ: -WORLD_HALF, maxX: -WORLD_HALF + 1, maxZ: -WORLD_HALF + 1 }, // the far corner
      { minX: 1000.5, minZ: 1000.5, maxX: 1000.5, maxZ: 1000.5 }, // a degenerate point rect
      { minX: -2000, minZ: 700, maxX: 2000, maxZ: 705 }, // a road running the width of the world
    ]
    let mismatches = 0
    let totalHit = 0
    for (const r of RECTS) {
      const got = new Set(invalidatedKeys(resident, r))
      for (const key of resident) {
        if (oracle(key, r) !== got.has(key)) mismatches++
      }
      totalHit += got.size
    }
    check(
      mismatches === 0,
      'the dirty rect drops exactly the intersecting nodes and no others',
      `${RECTS.length} rects over ${resident.length} nodes, ${totalHit} hits, ${mismatches} disagreements`
    )

    // EDGE CONTACT. Chunks share their boundary vertex columns, so a node whose
    // maxX is exactly the rect's minX has a whole column of vertices standing on
    // ground the edit moved. Excluding it leaves those two columns disagreeing by
    // the height of the carve, which is a one-vertex-wide crack straight to the
    // fog. This is the assertion that fails if the overlap test is ever made
    // exclusive at the edges.
    {
      let touching = 0
      let dropped = 0
      for (let depth = 1; depth <= MAX_DEPTH; depth++) {
        const size = WORLD_SIZE / (1 << depth)
        const span = 1 << depth
        const ix = Math.min(span - 1, 3)
        const iz = Math.min(span - 1, 5)
        const box = nodeBox(depth, ix, iz)
        // Four rects, each meeting the node on exactly one edge and overlapping
        // nowhere else, plus one meeting it at a single corner point.
        const rects = [
          { minX: box.maxX, minZ: box.minZ, maxX: box.maxX + size, maxZ: box.maxZ }, // east edge
          { minX: box.minX - size, minZ: box.minZ, maxX: box.minX, maxZ: box.maxZ }, // west edge
          { minX: box.minX, minZ: box.maxZ, maxX: box.maxX, maxZ: box.maxZ + size }, // north edge
          { minX: box.minX, minZ: box.minZ - size, maxX: box.maxX, maxZ: box.minZ }, // south edge
          { minX: box.maxX, minZ: box.maxZ, maxX: box.maxX, maxZ: box.maxZ }, // one corner point
        ]
        const key = nodeKey(depth, ix, iz)
        for (const r of rects) {
          touching++
          if (invalidatedKeys([key], r).length === 1) dropped++
        }
      }
      check(
        dropped === touching,
        'a rect touching a node only along an edge or at a corner still invalidates it',
        `${dropped}/${touching} across depths 1..${MAX_DEPTH}`
      )
    }

    // ...and the converse, or the edge check above would pass for a test that
    // simply invalidates everything.
    {
      let separated = 0
      let kept = 0
      for (let depth = 1; depth <= MAX_DEPTH; depth++) {
        const size = WORLD_SIZE / (1 << depth)
        const span = 1 << depth
        const ix = Math.min(span - 1, 3)
        const iz = Math.min(span - 1, 5)
        const box = nodeBox(depth, ix, iz)
        // The same four rects nudged clear by a nanometre. At depth 13 the node is
        // 1 m across, so the gap has to be small enough to still be a gap and
        // large enough to survive float64, which 1e-9 m is on both counts.
        const eps = 1e-9
        const rects = [
          { minX: box.maxX + eps, minZ: box.minZ, maxX: box.maxX + size, maxZ: box.maxZ },
          { minX: box.minX - size, minZ: box.minZ, maxX: box.minX - eps, maxZ: box.maxZ },
          { minX: box.minX, minZ: box.maxZ + eps, maxX: box.maxX, maxZ: box.maxZ + size },
          { minX: box.minX, minZ: box.minZ - size, maxX: box.maxX, maxZ: box.minZ - eps },
        ]
        const key = nodeKey(depth, ix, iz)
        for (const r of rects) {
          separated++
          if (invalidatedKeys([key], r).length === 0) kept++
        }
      }
      check(kept === separated, 'a rect clear of a node by a nanometre leaves it alone', `${kept}/${separated} across depths 1..${MAX_DEPTH}`)
    }

    // A rect covering the world must be indistinguishable from a full
    // invalidation, or the editor has two "reload everything" paths that disagree.
    {
      const whole = { minX: -WORLD_HALF, minZ: -WORLD_HALF, maxX: WORLD_HALF, maxZ: WORLD_HALF }
      const byRect = invalidatedKeys(resident, whole)
      const byNull = invalidatedKeys(resident, null)
      const same = byRect.length === resident.length && byNull.length === resident.length
      check(same, 'a dirty rect covering the world equals a full invalidation', `${byRect.length} / ${byNull.length} / ${resident.length}`)
    }

    // A malformed rect is a caller bug and must not be silently read as "nothing
    // changed", which would leave stale terrain on screen with no error anywhere.
    {
      let threw = 0
      const BAD = [
        { minX: 0, minZ: 0, maxX: -1, maxZ: 1 },
        { minX: 0, minZ: 0, maxX: 1, maxZ: NaN },
        { minX: 0, minZ: 0, maxX: 1 },
      ]
      for (const r of BAD) {
        check(!validRect(r), `validRect rejects ${JSON.stringify(r)}`)
        try {
          invalidatedKeys(resident, r)
        } catch {
          threw++
        }
      }
      check(threw === BAD.length, 'invalidatedKeys throws on a malformed rect rather than dropping nothing', `${threw}/${BAD.length}`)
    }

    // boxesOverlap is symmetric, which the oracle above assumes.
    {
      let asym = 0
      for (let i = 0; i < 400; i++) {
        const a = nodeBoxFromKey(resident[Math.floor(rnd() * resident.length)])
        const b = nodeBoxFromKey(resident[Math.floor(rnd() * resident.length)])
        if (boxesOverlap(a, b) !== boxesOverlap(b, a)) asym++
      }
      check(asym === 0, 'box overlap is symmetric', `${asym} of 400 pairs disagreed`)
    }
  }

  // --- 3. the epoch / staleness rule ---------------------------------------
  //
  // The one place a wrong call produces stale-terrain patches that read as a
  // meshing bug rather than as a stale read. v1 drops every reply whose epoch
  // does not match; v2 cannot, because with partial invalidation a chunk built
  // under an older doc that no edit touched is still bit-exact, and dropping all
  // of them would stall every far-field stream for the length of a drag.

  console.log('\nepoch / staleness')
  {
    const A = nodeKey(6, 10, 10) // inside the edit
    const B = nodeKey(6, 40, 40) // far away, untouched

    const floors = makeFloors()
    check(acceptsReply(floors, A, 0), 'before any edit, an epoch-0 reply is accepted')

    // Epoch 1: an edit that touches A only. This is the moment a request for A
    // and a request for B are both in flight, both stamped epoch 0.
    invalidateKeys(floors, [A], 1)

    check(!acceptsReply(floors, A, 0), 'an in-flight reply for an INVALIDATED chunk is dropped')
    check(acceptsReply(floors, B, 0), 'an in-flight reply for an UNTOUCHED chunk is kept')
    check(acceptsReply(floors, A, 1), 'the re-request for the invalidated chunk is accepted')

    // Case 3 in full: A is invalidated and re-requested, so two replies for the
    // same key are outstanding and they must be told apart by epoch alone, in
    // either arrival order.
    check(replyFloor(floors, A) === 1 && replyFloor(floors, B) === 0, 'the floor is per key, not global', `A ${replyFloor(floors, A)}, B ${replyFloor(floors, B)}`)

    // Two invalidations in a row while requests from both are in flight -- what a
    // drag actually produces at one edit per 120 ms debounce.
    invalidateKeys(floors, [A], 2)
    check(!acceptsReply(floors, A, 1), 'the reply from the FIRST re-request is dropped once a second edit lands')
    check(acceptsReply(floors, A, 2), 'the reply from the second re-request is accepted')
    check(acceptsReply(floors, B, 0), 'the untouched chunk is still untouched after two edits')

    // A full invalidation raises the global floor instead of enumerating keys.
    invalidateAll(floors, 3)
    check(!acceptsReply(floors, B, 2), 'a full invalidation drops the untouched chunk too')
    check(acceptsReply(floors, B, 3), 'and accepts everything built at or after it')
    check(floors.perKey.size === 0, 'a full invalidation clears the per-key map rather than merging into it', `${floors.perKey.size} entries`)

    // The floor is a FLOOR, not a match: a reply built under a doc newer than the
    // last invalidation of its key is correct and must be kept. This is what makes
    // arrival order irrelevant.
    check(acceptsReply(floors, B, 9), 'a reply newer than the floor is kept, so arrival order does not matter')

    // Pruning must not resurrect a dropped reply.
    invalidateKeys(floors, [A], 4)
    pruneFloors(floors)
    check(acceptsReply(floors, A, 3) === true, 'pruning at inFlight 0 releases the per-key map', `global floor ${floors.globalFloor}`)
    check(!acceptsReply(floors, A, 2), 'pruning cannot lift a reply back over the GLOBAL floor')

    // A non-integer epoch is a protocol violation, not a value to coerce.
    let threw = false
    try {
      acceptsReply(floors, A, '3')
    } catch {
      threw = true
    }
    check(threw, 'a non-integer reply epoch throws rather than being coerced')
  }

  // --- 4. the fallback walks -----------------------------------------------
  //
  // Both of them. v1 shipped with only the ancestor walk and the reported bug was
  // "a square of terrain visibly fell away to the fog and popped back".

  console.log('\nfallback walks')
  {
    // A synthetic resident set: the pinned base layer (depths 0..2 complete) plus
    // one deep branch fully tiled at depth MAX_DEPTH under a chosen node, so both
    // walks have something real to find.
    const readySet = new Set()
    for (let depth = 0; depth <= 2; depth++) {
      const span = 1 << depth
      for (let iz = 0; iz < span; iz++) for (let ix = 0; ix < span; ix++) readySet.add(nodeKey(depth, ix, iz))
    }
    check(readySet.size === PINNED_CHUNKS, `the pinned base layer is ${PINNED_CHUNKS} chunks`, `${readySet.size}`)

    let probes = 0
    const isReady = (key) => {
      probes++
      return readySet.has(key)
    }

    // -- ancestor walk.
    {
      probes = 0
      const anc = loadedAncestorKey(MAX_DEPTH, 1234, 2345, isReady)
      const u = anc === null ? null : unpackKey(anc)
      check(anc !== null && u.depth === 2, 'the ancestor walk finds the NEAREST loaded ancestor, not the root', `depth ${u ? u.depth : 'none'}`)
      check(
        u !== null && u.ix === 1234 >> (MAX_DEPTH - 2) && u.iz === 2345 >> (MAX_DEPTH - 2),
        'and it is the ancestor that actually contains the node',
        `${u.ix},${u.iz} vs ${1234 >> (MAX_DEPTH - 2)},${2345 >> (MAX_DEPTH - 2)}`
      )
      console.log(`        ancestor walk from depth ${MAX_DEPTH}: ${probes} probes (bound is MAX_DEPTH = ${MAX_DEPTH})`)
      check(probes <= MAX_DEPTH, 'the ancestor walk costs at most MAX_DEPTH probes', `${probes}`)

      // Nothing resident at all: it must return null rather than loop or invent a
      // root.
      const empty = loadedAncestorKey(MAX_DEPTH, 0, 0, () => false)
      check(empty === null, 'the ancestor walk returns null when there is no loaded ancestor')
      // The root itself has no ancestor.
      check(loadedAncestorKey(0, 0, 0, () => true) === null, 'the root has no ancestor to find')
      // A node whose only loaded ancestor is the root finds the root.
      const rootOnly = loadedAncestorKey(MAX_DEPTH, 7, 7, (k) => k === nodeKey(0, 0, 0))
      check(rootOnly === nodeKey(0, 0, 0), 'depth 0 is the last resort and it is reachable from the deepest leaf')
    }

    // -- descendant walk.
    {
      // Tile node (4, 5, 6) completely at depth 7 -- three levels down, 64 tiles.
      const PD = 4
      const PIX = 5
      const PIZ = 6
      const CD = 7
      const cover = new Set()
      const shift = CD - PD
      for (let dz = 0; dz < 1 << shift; dz++) {
        for (let dx = 0; dx < 1 << shift; dx++) {
          cover.add(nodeKey(CD, (PIX << shift) + dx, (PIZ << shift) + dz))
        }
      }
      const covered = new Set([...readySet, ...cover])

      probes = 0
      const isCovered = (key) => {
        probes++
        return covered.has(key)
      }
      const out = []
      const ok = loadedDescendantKeys(PD, PIX, PIZ, isCovered, out)
      check(ok && out.length === cover.size, 'the descendant walk returns a COMPLETE cover when one exists', `${out.length} tiles, expected ${cover.size}`)
      check(
        out.every((k) => cover.has(k)) && new Set(out).size === out.length,
        'and the cover is exactly the resident tiles, with no duplicates'
      )
      console.log(`        descendant walk over a 3-level complete cover: ${probes} probes for ${out.length} tiles`)

      // THE HOLE CASE. Remove ONE tile of 64 and the walk must return nothing at
      // all. A partial cover is not a degraded answer, it is the hole -- fine
      // ground with a gap in it, in a shape that looks deliberate.
      const holed = new Set(covered)
      const missing = [...cover][17]
      holed.delete(missing)
      probes = 0
      const out2 = ['sentinel']
      const ok2 = loadedDescendantKeys(PD, PIX, PIZ, (k) => {
        probes++
        return holed.has(k)
      }, out2)
      check(!ok2, 'one missing tile makes the whole cover fail')
      check(out2.length === 1 && out2[0] === 'sentinel', 'and a failed walk appends NOTHING -- a partial cover IS the hole', `${out2.length - 1} strays left behind`)
      console.log(`        descendant walk with one tile missing: ${probes} probes, ${out2.length - 1} appended`)

      // The common case at runtime is a node with no resident descendants at all,
      // and it must abort at the first uncovered subtree rather than walking the
      // subtree. From depth 0 that subtree is the entire tree.
      probes = 0
      const out3 = []
      const ok3 = loadedDescendantKeys(0, 0, 0, (k) => {
        probes++
        return false
      }, out3)
      const bound = 4 * MAX_DEPTH
      console.log(`        descendant walk from depth 0 with nothing resident: ${probes} probes (bound 4 * MAX_DEPTH = ${bound})`)
      check(!ok3 && out3.length === 0, 'a node with no resident descendants yields nothing')
      check(probes <= bound, 'and it aborts down one path rather than walking the subtree', `${probes} probes vs ${bound}`)

      // The recursion must stop at MAX_DEPTH rather than building keys the packing
      // cannot represent.
      const out4 = []
      let threw = false
      try {
        check(loadedDescendantKeys(MAX_DEPTH, 0, 0, () => true, out4) === false, 'a leaf at MAX_DEPTH has no descendants to find')
      } catch {
        threw = true
      }
      check(!threw && out4.length === 0, 'and the walk stops there rather than throwing out of nodeKey')
    }
  }

  // --- 5. eviction ---------------------------------------------------------

  console.log('\neviction')
  {
    // A cache with a mix of states, pinned entries, rendered entries and
    // stand-ins, at spread-out lastUsed stamps so the LRU order is unambiguous.
    const makeCache = (n) => {
      const cache = new Map()
      const render = new Set()
      const standIns = new Set()
      for (let i = 0; i < n; i++) {
        const key = nodeKey(8, i % 256, Math.floor(i / 256))
        const pinned = i < PINNED_CHUNKS
        const state = i % 17 === 3 ? 'queued' : i % 23 === 7 ? 'pending' : 'ready'
        cache.set(key, { state, pinned, lastUsed: i })
        if (state === 'ready' && i % 5 === 0) render.add(key)
        if (state === 'ready' && i % 15 === 0) standIns.add(key)
      }
      return { cache, render, standIns }
    }

    const { cache, render, standIns } = makeCache(600)
    let readyTotal = 0
    for (const e of cache.values()) if (e.state === 'ready') readyTotal++

    // Under target: nothing moves.
    {
      const r = selectEvictions(cache, { maxReady: readyTotal + 10, render, standIns })
      check(r.primary.length === 0 && r.lastResort.length === 0, 'nothing is evicted while under the ready target', `${readyTotal} ready`)
    }

    // Over target: exactly the shortfall, LRU first, never pinned, never rendered.
    {
      const target = readyTotal - 40
      const r = selectEvictions(cache, { maxReady: target, render, standIns })
      check(r.need === 40 && r.primary.length === 40, 'eviction frees exactly the shortfall', `need ${r.need}, freed ${r.primary.length}`)
      let inRender = 0
      let pinned = 0
      let notReady = 0
      for (const key of r.primary) {
        if (render.has(key)) inRender++
        if (cache.get(key).pinned) pinned++
        if (cache.get(key).state !== 'ready') notReady++
      }
      check(inRender === 0, 'eviction never frees an entry in the current render set', `${inRender} of ${r.primary.length}`)
      check(pinned === 0, 'eviction never frees a pinned entry', `${pinned} of ${r.primary.length}`)
      check(notReady === 0, 'eviction only frees entries that actually hold a slot', `${notReady} not ready`)

      // LRU order: everything freed must be older than everything eligible and
      // kept, or "least recently used" is a claim rather than a policy.
      const freed = new Set(r.primary)
      let newestFreed = -Infinity
      let oldestKept = Infinity
      for (const [key, e] of cache) {
        if (e.state !== 'ready' || e.pinned || render.has(key)) continue
        if (freed.has(key)) newestFreed = Math.max(newestFreed, e.lastUsed)
        else oldestKept = Math.min(oldestKept, e.lastUsed)
      }
      check(newestFreed < oldestKept, 'what is freed is strictly older than what is kept', `newest freed ${newestFreed}, oldest kept ${oldestKept}`)
    }

    // The last resort. If the shortfall exceeds what is evictable without touching
    // the render set, stand-ins are reclaimed -- and NOTHING else in the render
    // set is, because losing a stand-in costs one tile of detail for a frame while
    // an empty slot pool throws.
    {
      const evictable = [...cache].filter(([k, e]) => e.state === 'ready' && !e.pinned && !render.has(k)).length
      const target = readyTotal - (evictable + 5)
      const r = selectEvictions(cache, { maxReady: target, render, standIns })
      check(r.primary.length === evictable, 'the primary pass frees everything it is allowed to before degrading', `${r.primary.length} of ${evictable}`)
      check(r.lastResort.length > 0, 'and only then reclaims stand-ins', `${r.lastResort.length} stand-ins`)
      let notStandIn = 0
      let pinned = 0
      for (const key of r.lastResort) {
        if (!standIns.has(key)) notStandIn++
        if (cache.get(key).pinned) pinned++
      }
      check(notStandIn === 0, 'the last resort only ever takes stand-ins, never other rendered ground', `${notStandIn} strays`)
      check(pinned === 0, 'and never a pinned entry even under pressure', `${pinned} pinned`)
      check(new Set([...r.primary, ...r.lastResort]).size === r.primary.length + r.lastResort.length, 'no entry is freed twice across the two passes')
    }

    // Counting READY entries rather than cache.size is the whole point: a frame
    // that queues hundreds of requests must not evict ground that is being drawn.
    {
      const flooded = new Map(cache)
      for (let i = 0; i < 400; i++) {
        flooded.set(nodeKey(9, i, 0), { state: 'queued', pinned: false, lastUsed: 10000 })
      }
      const before = selectEvictions(cache, { maxReady: readyTotal, render, standIns })
      const after = selectEvictions(flooded, { maxReady: readyTotal, render, standIns })
      check(
        before.readyCount === after.readyCount && after.primary.length === 0,
        'queued requests do not push resident ground out of the cache',
        `${flooded.size} entries, ${after.readyCount} ready, ${after.primary.length} evicted`
      )
    }

    // The other half of that policy: queued entries the selection has moved past
    // are dead weight and get dropped regardless of pressure.
    {
      const stale = staleQueuedKeys(cache, 300)
      let wrong = 0
      for (const key of stale) {
        const e = cache.get(key)
        if (e.state !== 'queued' || e.pinned || e.lastUsed >= 300) wrong++
      }
      check(stale.length > 0 && wrong === 0, 'stale queued requests are dropped and nothing else is', `${stale.length} dropped, ${wrong} wrong`)
      const pinnedQueued = [...cache].filter(([, e]) => e.state === 'queued' && e.pinned).length
      check(
        !stale.some((k) => cache.get(k).pinned),
        'the pinned base layer is never dropped from the queue',
        `${pinnedQueued} pinned entries were queued`
      )
    }
  }

  // --- 6. the slot budget --------------------------------------------------
  //
  // MEASURED rather than carried over. The world box settled at 8 km after passing
  // through 16 km and 4 km, and MAX_DEPTH at 13 after 14 and 12. Those two push
  // residency in opposite directions -- a smaller box removes far-field coarse
  // nodes, a deeper cap adds near-camera refinement -- so the net is not something
  // to reason about from the previous number. Slot-pool overflow THROWS by design.
  //
  // The quantity that matters is not the pool but the EVICTION TARGET, because
  // the current render set is exempt from eviction: the worst set the knob can
  // pin down at once has to fit under maxReady, which is the pool minus the
  // in-flight window.

  console.log('\nslot budget')
  {
    const { inFlightCap, maxReady } = slotBudget(WORKERS, QUEUE_DEPTH)
    check(
      maxReady + WORKERS * QUEUE_DEPTH <= SLOT_COUNT,
      'maxReady + workers * queueDepth fits the slot pool',
      `${maxReady} + ${WORKERS} x ${QUEUE_DEPTH} = ${maxReady + inFlightCap} of ${SLOT_COUNT}`
    )
    check(maxReady > PINNED_CHUNKS, 'the eviction target has room for the pinned base layer at all', `${maxReady} vs ${PINNED_CHUNKS}`)

    // A configuration that cannot work must fail at construction rather than at
    // the first busy frame.
    let threw = false
    try {
      slotBudget(WORKERS, Math.ceil(SLOT_COUNT / WORKERS))
    } catch {
      threw = true
    }
    check(threw, 'a queue depth that swallows the pool throws at construction')

    // The sweep. Same shape as check-v2-quadtree.mjs's -- deterministic LCG,
    // half the cameras airborne -- but the claim is different: that file asks
    // whether the selection fits SLOT_COUNT, this one asks whether it fits
    // maxReady with room left over for the stand-ins _select retains.
    const groundAt = (x, z) =>
      200 * Math.sin(x / 1450) * Math.cos(z / 1130) + 100 * Math.sin(x / 260 + z / 340) + 20 * Math.sin(x / 33 + z / 29)
    const boundsCache = new Map()
    const info = {
      get(key) {
        let b = boundsCache.get(key)
        if (b === undefined) {
          const { depth, ix, iz } = unpackKey(key)
          const size = WORLD_SIZE / (1 << depth)
          const x0 = -WORLD_HALF + ix * size
          const z0 = -WORLD_HALF + iz * size
          let minY = Infinity
          let maxY = -Infinity
          for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
              const h = groundAt(x0 + (i / 2) * size, z0 + (j / 2) * size)
              if (h < minY) minY = h
              if (h > maxY) maxY = h
            }
          }
          b = { minY, maxY }
          boundsCache.set(key, b)
        }
        return b
      },
    }

    let s = 20260824
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    const CAMS = []
    for (let i = 0; i < 300; i++) {
      const x = (rnd() * 2 - 1) * WORLD_HALF * 0.96
      const z = (rnd() * 2 - 1) * WORLD_HALF * 0.96
      // Half airborne. The range term is 3D, so a camera well above the ground is
      // genuinely further from it than its map position says, and that is where a
      // range rule falls apart if it is going to.
      const y = i % 2 === 0 ? groundAt(x, z) + 1.65 : groundAt(x, z) + 20 + rnd() * 380
      for (let h = 0; h < 4; h++) CAMS.push({ x, y, z, yaw: (h * Math.PI) / 2 })
    }

    const wasTriDeg = LOD.triDeg
    const ladder = new Map()
    for (const triDeg of [LOD.triDeg, MIN_TRI_DEG]) {
      LOD.triDeg = triDeg
      let worst = 0
      let worstDeepest = 0
      for (const cam of CAMS) {
        const sel = selectNodes(cam, { info })
        if (sel.length > worst) worst = sel.length
        for (const n of sel) if (n.depth > worstDeepest) worstDeepest = n.depth
      }
      ladder.set(triDeg, { worst, worstDeepest })
    }
    LOD.triDeg = wasTriDeg

    for (const [triDeg, m] of ladder) {
      const resident = m.worst + PINNED_CHUNKS
      console.log(
        `        triDeg ${triDeg}: worst selection ${m.worst} leaves (deepest ${m.worstDeepest}), ` +
          `+ ${PINNED_CHUNKS} pinned = ${resident} resident, maxReady ${maxReady}, stand-in budget ${maxReady - resident}`
      )
    }
    const finest = ladder.get(MIN_TRI_DEG)
    const residentAtFloor = finest.worst + PINNED_CHUNKS
    check(
      residentAtFloor <= maxReady,
      `the worst selection at MIN_TRI_DEG ${MIN_TRI_DEG} fits UNDER the eviction target`,
      `${residentAtFloor} resident vs maxReady ${maxReady} (pool ${SLOT_COUNT})`
    )
    check(
      maxReady - residentAtFloor > 0,
      'and leaves a positive stand-in budget, so a back-away at the finest setting can still hold detail',
      `${maxReady - residentAtFloor} chunks spare`
    )
    check(
      finest.worstDeepest <= MAX_DEPTH,
      'no selection asks for a node deeper than MAX_DEPTH',
      `deepest ${finest.worstDeepest} of ${MAX_DEPTH}`
    )
  }

  // --- 7. the panel's headline number --------------------------------------
  //
  // finestCell is what the panel puts front and centre -- "am I actually seeing
  // 10 cm" -- so it is worth pinning that the arithmetic behind it says what
  // config.js claims.

  console.log('\ncell sizes')
  {
    console.log(
      `        ${[0, 2, MAX_DEPTH - 2, MAX_DEPTH].map((d) => `depth ${d}: ${cellSize(d) >= 1 ? `${cellSize(d)} m` : `${(cellSize(d) * 100).toFixed(2)} cm`}`).join('   ')}`
    )
    check(
      Math.abs(cellSize(MAX_DEPTH) - 0.0625) < 1e-12,
      'the leaf cell is 6.25 cm, which is what "down to 10 cm" means in these units',
      `${cellSize(MAX_DEPTH)} m at depth ${MAX_DEPTH}`
    )
    check(cellSize(0) === WORLD_SIZE / CHUNK_RES, 'the root chunk spans the world', `${cellSize(0)} m cells`)
    let monotone = true
    for (let d = 1; d <= MAX_DEPTH; d++) if (!(cellSize(d) < cellSize(d - 1))) monotone = false
    check(monotone, 'cell size shrinks strictly with depth')
    let threw = 0
    for (const d of [-1, MAX_DEPTH + 1, 1.5]) {
      try {
        cellSize(d)
      } catch {
        threw++
      }
    }
    check(threw === 3, 'an impossible depth throws rather than returning a plausible number', `${threw}/3`)
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) throw new Error(`check-v2-terrain: ${failures} check(s) failed`)
}

// Self-run when invoked directly; scripts/check-v2.mjs imports run() instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
