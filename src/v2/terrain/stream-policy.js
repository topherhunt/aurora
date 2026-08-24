import { WORLD_SIZE, WORLD_HALF, CHUNK_RES, MAX_DEPTH, SLOT_COUNT, PINNED_CHUNKS } from '../config.js'
import { nodeKey, parentKey, unpackKey } from './quadtree-v2.js'

// ---------------------------------------------------------------------------
// Streaming POLICY for the v2 chunk manager: every decision terrain-v2.js makes
// that is a pure function of bookkeeping state rather than of three.js.
//
// WHY THIS FILE EXISTS AT ALL, since v1 inlines all of it in src/terrain/terrain.js.
//
// The honest reason is testability, and it is worth being blunt that the split is
// a real structural improvement rather than a testing hack. terrain-v2.js imports
// three.js and constructs Worker, so it cannot be instantiated in node and the
// node gate can only ever assert that it parses. But NONE of the four things that
// have actually shipped as visible bugs in v1's streamer are three.js problems:
// "which entries may be evicted", "is there a complete cover of finer tiles",
// "is there a coarser stand-in", and now in v2 "which chunks did this edit
// invalidate" are all decisions about a Map, a Set and some integers. Pulling
// them out gives them names, arguments and return values instead of leaving them
// as three interleaved loops over `this`, and a gate that can drive every branch.
//
// The rule for what belongs here: if it touches `this.batch`, `this._free` or a
// THREE type it stays in terrain-v2.js; if it only reads keys, states, lastUsed
// stamps and rectangles it lives here. Nothing in this file allocates a slot or
// knows a slot exists.
//
// Three-free, like everything under src/v2/height/ and src/v2/layers/, so
// scripts/check-v2-terrain.mjs runs it headless (DESIGN.md constraint 3).
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Node geometry. A node's XZ box, which is the only geometric fact the
// invalidation test needs.
// ---------------------------------------------------------------------------

export function nodeBox(depth, ix, iz) {
  const size = WORLD_SIZE / (1 << depth)
  const minX = -WORLD_HALF + ix * size
  const minZ = -WORLD_HALF + iz * size
  return { minX, minZ, maxX: minX + size, maxZ: minZ + size }
}

export function nodeBoxFromKey(key) {
  const { depth, ix, iz } = unpackKey(key)
  return nodeBox(depth, ix, iz)
}

// The cell size a chunk at this depth resolves, in metres. This is the number the
// panel puts front and centre -- "am I actually seeing 10 cm" -- so it is derived
// here from WORLD_SIZE and CHUNK_RES rather than written down anywhere as a
// literal. At MAX_DEPTH 13 it is 8192 / 2^13 / 16 = 6.25 cm.
export function cellSize(depth) {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    throw new Error(`cellSize: depth ${depth} is outside 0..${MAX_DEPTH}`)
  }
  return WORLD_SIZE / (1 << depth) / CHUNK_RES
}


// ---------------------------------------------------------------------------
// PARTIAL INVALIDATION. The new logic in v2 and the one with no v1 counterpart.
//
// v1's retune() rebuilds the entire world because a tuning constant moves the
// entire world. A v2 edit does not: dragging one river control point changes the
// field inside a few hundred metres and leaves the rest of the 8 km box alone.
// Re-meshing everything would cost most of the pool per mousemove-debounce, so
// the whole world would dissolve to the pinned base layer and crawl back for the
// duration of a drag, which is the opposite of the interactive editing the route
// exists for.
//
// So the test is per-chunk and geometric: a resident chunk is invalidated if and
// only if its node box intersects the edit's dirty rect.
//
// OVERLAP IS INCLUSIVE AT THE EDGES, and that is load-bearing rather than
// arbitrary. Chunks share their boundary vertex rows: the east column of one
// chunk and the west column of its neighbour are the same world positions
// evaluated twice. A chunk whose maxX exactly equals the rect's minX therefore
// has a whole column of vertices sitting on ground the edit changed. Excluding it
// leaves those two columns disagreeing by the height of the carve, which is a
// crack straight through to the fog one vertex wide -- the same class of failure
// as a missing chunk, in a shape that is much harder to recognise. Half-open
// intervals are right for pixel grids and wrong for shared-vertex meshes.
//
// COST. This is a linear scan of the resident set, not a spatial query. The
// resident set is bounded by SLOT_COUNT (1024) and an edit arrives at most every
// 120 ms (the editor's debounce), so the worst case is ~1024 unpackKey calls plus
// four comparisons each, which is tens of microseconds. A quadtree descent over
// the rect would be asymptotically better and measurably slower at this n, and it
// would need its own correctness argument. Revisit if SLOT_COUNT ever grows by an
// order of magnitude.
// ---------------------------------------------------------------------------

export function boxesOverlap(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxZ < b.minZ || a.minZ > b.maxZ)
}

export function validRect(rect) {
  return (
    rect !== null &&
    typeof rect === 'object' &&
    Number.isFinite(rect.minX) &&
    Number.isFinite(rect.minZ) &&
    Number.isFinite(rect.maxX) &&
    Number.isFinite(rect.maxZ) &&
    rect.maxX >= rect.minX &&
    rect.maxZ >= rect.minZ
  )
}

/**
 * Which of `keys` an edit over `rect` invalidates.
 *
 * `rect === null` means "everything changed" -- the whole document was replaced,
 * or a layer reported a dirty region it could not bound. That is v1's retune()
 * case and it returns every key, so the caller's full-reset path and its partial
 * path are the same code with a different key list.
 */
export function invalidatedKeys(keys, rect) {
  const out = []
  if (rect === null) {
    for (const key of keys) out.push(key)
    return out
  }
  if (!validRect(rect)) {
    throw new Error(`invalidatedKeys: ${JSON.stringify(rect)} is not a dirty rect (need finite minX/minZ/maxX/maxZ, max >= min)`)
  }
  for (const key of keys) {
    if (boxesOverlap(nodeBoxFromKey(key), rect)) out.push(key)
  }
  return out
}


// ---------------------------------------------------------------------------
// THE EPOCH / STALENESS RULE, and the one place in v2 a wrong call produces
// stale-terrain patches that read as a meshing bug.
//
// v1's rule is `drop every reply whose epoch !== this.epoch`, and it is exactly
// right for v1 because a retune invalidates the entire world: after the bump
// there is no key for which an old reply is still correct.
//
// That rule is WRONG for v2, and not marginally. A chunk built under epoch 3 that
// was outside epoch 4's dirty rect is still a bit-exact answer, because the only
// thing that changed between doc 3 and doc 4 is inside a rect its box does not
// touch. Dropping it costs a needless re-mesh. Worse, it compounds: the editor
// debounces at 120 ms, so a two-second drag bumps the epoch ~16 times, and a
// global equality gate would discard essentially every reply in flight at each
// bump -- including all the far-field streaming the drag never touched. The
// streamer would re-request the same chunks over and over and converge on nothing
// for as long as the mouse is down. That is a stall, produced by the gate, in the
// one interaction the editor is built around.
//
// THE RULE v2 USES: a reply is accepted if and only if the epoch it was built
// under is at least as new as the last edit that invalidated ITS OWN KEY.
//
//     accept(key, replyEpoch)  iff  replyEpoch >= floor(key)
//     floor(key) = max(globalFloor, perKey.get(key) ?? 0)
//
// `perKey` is stamped with the NEW epoch for every key a partial invalidation
// touches; `globalFloor` is raised instead when the invalidation is total, so a
// full reset does not have to enumerate four billion keys to express itself.
//
// The three cases the gate pins, and they are the three that matter:
//
//   1. A reply in flight for a chunk that was just invalidated. Its request went
//      out at an epoch strictly BELOW the bump, so it is below that key's floor
//      and it is dropped. This is the case v1's rule exists for and it must keep
//      working.
//   2. A reply in flight for a chunk the edit did not touch. Its key has no
//      perKey floor and globalFloor did not move, so it is kept. This is the case
//      v1's rule gets wrong.
//   3. A chunk invalidated and then re-requested, with both replies outstanding.
//      They are distinguished by their epoch alone: the re-request carries the
//      post-bump epoch and passes, the original carries the pre-bump epoch and
//      fails, and the order they arrive in does not matter because the test is a
//      floor rather than a match against "the newest reply seen".
//
// WHY THE ECHOED EPOCH IS TRUSTWORTHY. The worker protocol is fixed and carries
// no doc version on a reply beyond the epoch the REQUEST was stamped with, so
// this rule leans on postMessage ordering: messages to one worker are delivered
// in the order they were posted, so a chunk request posted after a `layers`
// message cannot be meshed against the older doc. The request's epoch is
// therefore a lower bound on the doc version the reply was built from. If a
// worker were ever changed to buffer chunk requests across a `layers` message,
// the echoed epoch would UNDERSTATE the doc used, and the failure mode of that is
// dropping a reply that was actually fine -- a wasted re-mesh, never a stale
// patch. The dangerous direction, an epoch that overstates the doc, is not
// reachable without reordering.
//
// PRUNING. `perKey` grows one entry per invalidated key per edit. Every entry is
// dead once nothing older than it is in flight, so terrain-v2.js clears the map
// whenever inFlight reaches zero, which is the cheapest correct condition there
// is. A drag that never lets the queue drain holds at most a few thousand
// number-to-number entries in the meantime.
// ---------------------------------------------------------------------------

export function makeFloors() {
  return { globalFloor: 0, perKey: new Map() }
}

export function replyFloor(floors, key) {
  const p = floors.perKey.get(key)
  return p === undefined ? floors.globalFloor : Math.max(floors.globalFloor, p)
}

export function acceptsReply(floors, key, replyEpoch) {
  if (!Number.isInteger(replyEpoch)) throw new Error(`acceptsReply: reply epoch ${replyEpoch} is not an integer`)
  return replyEpoch >= replyFloor(floors, key)
}

// Stamp a partial invalidation. Every listed key must be rebuilt at `epoch` or
// later; every other key keeps whatever floor it already had.
export function invalidateKeys(floors, keys, epoch) {
  for (const key of keys) floors.perKey.set(key, epoch)
}

// Stamp a total invalidation. perKey is cleared rather than merged, because
// globalFloor now dominates every entry it could hold.
export function invalidateAll(floors, epoch) {
  floors.globalFloor = epoch
  floors.perKey.clear()
}

// Safe once nothing predating the newest floor can still land. terrain-v2.js
// calls this when inFlight hits zero.
export function pruneFloors(floors) {
  floors.perKey.clear()
}


// ---------------------------------------------------------------------------
// THE TWO FALLBACK WALKS. Both of them, and v1 shipped without the second one.
//
// Between asking for a chunk and getting it there has to be SOMETHING drawn in
// its place, and which direction to look for it depends on which way the LOD is
// moving. Refining (walking towards ground) wants a coarser ancestor; coarsening
// (flying away from it) wants the finer tiles that are already resident and cover
// exactly the same ground. v1 had only the ancestor walk and the bug was
// reported as "a square of terrain visibly fell away to the fog and popped back":
// the fine tiles were dropped from the render set in the same frame the coarse
// replacement was requested, so the stand-in reached past perfectly good resident
// geometry to a pinned depth-2 chunk, whose cells there were 256 m across and sat
// a hundred metres below a real ridgeline. v2's base layer is finer than that (an
// 8 km world puts depth 2 at 128 m cells) and it does not help: 128 m still misses
// a ridge by tens of metres, and the fine tiles it reaches past are 6 cm.
//
// DEPTH 13 rather than v1's 10. Both walks are bounded by depth, so the question
// is whether three more levels make them expensive. Measured in
// scripts/check-v2-terrain.mjs over a synthetic resident set: the ancestor walk
// is at most MAX_DEPTH map probes and terminates at depth 0 by construction, and
// the descendant walk's failing case -- overwhelmingly the common one -- aborts
// at the first uncovered subtree, so it costs four probes per level along one
// path rather than a walk of the whole subtree. Neither is a function of how many
// chunks are resident. The numbers are in the gate's output.
// ---------------------------------------------------------------------------

/**
 * The nearest already-loaded ancestor of this node, or null if there is none.
 *
 * This is the REFINING direction, and the pinned depth 0-2 base layer is what
 * guarantees it almost always finds something: depth 0 covers the whole world.
 * Returning null here means the base layer is not resident yet, which at runtime
 * is only true for the first few frames of a session or of a full invalidation.
 *
 * `isReady(key)` is a predicate rather than the cache itself so this stays
 * three-free and so the gate can drive it with a bare Set.
 */
export function loadedAncestorKey(depth, ix, iz, isReady) {
  let d = depth
  let x = ix
  let z = iz
  while (d > 0) {
    const key = parentKey(d, x, z)
    d--
    x >>= 1
    z >>= 1
    if (isReady(key)) return key
  }
  return null
}

/**
 * A COMPLETE cover of this node by already-loaded finer chunks, appended to
 * `out`. Returns false, having appended nothing, if the cover is not complete.
 *
 * The all-or-nothing rule is the whole point and it is worth stating as an
 * invariant rather than as an implementation detail: a PARTIAL COVER IS THE HOLE.
 * Drawing three quarters of a node in fine tiles and leaving the fourth quarter
 * to nothing is strictly worse than drawing the coarse ancestor, because it is
 * the same gap in a shape that looks deliberate. Every frame truncates `out` back
 * to its own mark on failure, so an aborted walk at any depth leaves `out`
 * bit-identical to what it was before the top-level call.
 *
 * Overshooting detail for a few frames is the right trade: a cover is made
 * entirely of chunks that were resident and drawn last frame, so accepting one
 * can only hold the triangle count where it already was, and it costs no slots.
 */
export function loadedDescendantKeys(depth, ix, iz, isReady, out) {
  if (depth >= MAX_DEPTH) return false
  const cd = depth + 1
  const mark = out.length
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      const cix = ix * 2 + dx
      const ciz = iz * 2 + dz
      const key = nodeKey(cd, cix, ciz)
      if (isReady(key)) {
        out.push(key)
        continue
      }
      if (!loadedDescendantKeys(cd, cix, ciz, isReady, out)) {
        out.length = mark
        return false
      }
    }
  }
  return true
}


// ---------------------------------------------------------------------------
// EVICTION, counted in READY entries rather than in cache size.
//
// This is v1's hardest-won number and the reasoning carries over unchanged. The
// eviction target used to be a cap on cache.size, which counts QUEUED entries
// too, and those two quantities differ by a hundred or more while anything is
// streaming: a frame that requests 150 chunks pushes the cache over its cap and
// evicts ground that is currently being drawn, to make room for nodes that hold
// no slot at all. That is a hole produced by the eviction policy, in the one
// situation the streamer exists to keep hole-free. Only ready entries hold slots,
// so only ready entries are worth counting.
//
// The margin below SLOT_COUNT is the in-flight cap: up to that many replies can
// land between two eviction passes and every one of them must find a free slot,
// or terrain-v2.js throws.
// ---------------------------------------------------------------------------

/**
 * The two numbers the slot pool is spent on.
 *
 * maxReady + workers * queueDepth <= SLOT_COUNT is not a guideline, it is the
 * condition under which the pool cannot be exhausted, and the gate asserts it.
 */
export function slotBudget(workers, queueDepth) {
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`slotBudget: workers must be a positive integer, got ${workers}`)
  if (!Number.isInteger(queueDepth) || queueDepth < 1) throw new Error(`slotBudget: queueDepth must be a positive integer, got ${queueDepth}`)
  const inFlightCap = workers * queueDepth
  const maxReady = SLOT_COUNT - inFlightCap
  if (maxReady <= PINNED_CHUNKS) {
    throw new Error(
      `slotBudget: ${workers} workers x ${queueDepth} deep leaves ${maxReady} of ${SLOT_COUNT} slots for resident chunks, ` +
        `which does not even cover the ${PINNED_CHUNKS} pinned base-layer chunks`
    )
  }
  return { inFlightCap, maxReady }
}

/**
 * What happens to ONE cached entry when an edit invalidates its key.
 *
 * Three lines, and it lives here rather than inline in _invalidateRect because
 * the sky-flash bug was a wrong answer from exactly this table and there is no
 * other way to assert it: the caller needs a BatchedMesh and a worker pool, so
 * nothing around it can run under a gate.
 *
 *   'hold'   the entry has geometry on the GPU. Keep the slot AND keep it
 *            visible; the chunk is one epoch stale, which is the epoch the
 *            author is in the middle of changing, and it is replaced in place
 *            when the new mesh lands. Freeing it here is what used to punch a
 *            hole through to the sky for the length of every bake.
 *
 *   'reseed' nothing on screen, but pinned. The depth 0-2 base layer is the
 *            floor under every other fallback, so it is re-requested even though
 *            dropping it would cost nothing visible THIS frame.
 *
 *   'drop'   nothing on screen and not pinned: merely queued, or in flight. No
 *            hole to leave, and the next selection asks again if it still wants
 *            it. Re-requesting these is how a drag builds a queue of chunks
 *            nobody is looking at.
 */
export function invalidationAction(entry) {
  if (!entry) throw new Error('invalidationAction: no entry -- invalidatedKeys only yields keys that are in the cache')
  if (entry.slot) return 'hold'
  return entry.pinned ? 'reseed' : 'drop'
}

/**
 * Which resident entries to free this pass.
 *
 * `entries` is any iterable of [key, {slot, pinned, lastUsed}]. `render` and
 * `standIns` are Sets of KEYS -- v2 keys are packed integers, so a Set of keys is
 * cheaper than v1's Set of entry objects and does not tie this function to the
 * cache entry's shape.
 *
 * THE UNIT OF ACCOUNTING IS THE SLOT, NOT THE STATE. This counted `state ===
 * 'ready'` entries, which was the same set right up until an edit was allowed to
 * keep the OLD geometry on screen while the replacement bakes (see
 * TerrainV2._invalidateRect). Such an entry is back in state 'queued' and still
 * holds its slot, so counting states would have left it out of the budget
 * entirely -- and the budget is the only thing standing between the pool and
 * `_free.pop()` returning undefined, which throws. `entry.slot !== null` is the
 * exact question this function has always meant to ask: how many of the pool's
 * slots are spoken for right now.
 *
 * Two lists come back and they are deliberately separate rather than one
 * concatenated answer:
 *
 *   `primary` -- least-recently-used ready entries that are neither pinned nor in
 *   the current render set. This is the whole policy in the normal case, and the
 *   two exemptions are what stop the swap being yanked out from under itself.
 *
 *   `lastResort` -- stand-ins, which ARE in the render set and which everything
 *   above works to keep. A chunk covering for a miss is still less important than
 *   not running out of slots, and running out is fatal: an empty pool throws.
 *   Losing one puts a single tile back on its coarse ancestor for a frame or two.
 *   This only fires if the desired set alone is within a stand-in of the pool,
 *   which quadtree-v2.js's MIN_TRI_DEG ladder sizes against. It exists because
 *   the alternative to degrading here is a crash.
 *
 * Keeping them apart is also what lets the gate assert the strong property --
 * the primary pass NEVER frees a rendered or pinned entry -- without the
 * assertion being quietly false because of the escape hatch.
 */
export function selectEvictions(entries, { maxReady, render, standIns }) {
  const ready = []
  let readyCount = 0
  for (const [key, entry] of entries) {
    if (!entry.slot) continue
    readyCount++
    if (entry.pinned) continue
    ready.push([key, entry])
  }
  const need = readyCount - maxReady
  if (need <= 0) return { primary: [], lastResort: [], readyCount, need: 0 }

  const lru = (a, b) => a[1].lastUsed - b[1].lastUsed

  const primary = []
  for (const pair of ready.filter(([key]) => !render.has(key)).sort(lru)) {
    if (primary.length >= need) break
    primary.push(pair[0])
  }

  const short = need - primary.length
  const lastResort = []
  if (short > 0) {
    for (const pair of ready.filter(([key]) => standIns.has(key)).sort(lru)) {
      if (lastResort.length >= short) break
      lastResort.push(pair[0])
    }
  }

  return { primary, lastResort, readyCount, need }
}

/**
 * Queued entries that fell out of the selection and will never be rendered.
 *
 * Dead weight regardless of how full the cache is, and dropping them is what
 * keeps the cache from outrunning the pool while walking: v1 measured 1002
 * entries against a 720 cap over an 18 km walk before the request queue was
 * rebuilt each selection rather than appended to.
 *
 * `lastSelectFrame` is the frame the current selection was made on. An entry
 * whose lastUsed predates it was not asked for by that selection.
 */
export function staleQueuedKeys(entries, lastSelectFrame) {
  const out = []
  for (const [key, entry] of entries) {
    if (entry.state === 'queued' && !entry.pinned && entry.lastUsed < lastSelectFrame) out.push(key)
  }
  return out
}

// Re-exported so a caller holding this module can write assertions about the pool
// without also reaching into config.js.
export { SLOT_COUNT, PINNED_CHUNKS, MAX_DEPTH }
