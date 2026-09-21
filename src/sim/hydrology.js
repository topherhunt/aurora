import { NB_DI, NB_DJ, NB_DIST } from './world-grid.js'

// Float32 slack. See the note on the outlet test in breachDepressions.
const TOL = 1e-3

// ---------------------------------------------------------------------------
// Hydrology: depression filling, flow routing, flow accumulation (§2 Phase A,
// steps 2-3). Pure math on typed arrays, no three.js, no world knowledge beyond
// the grid dimensions.
//
// The failure mode this whole file exists to avoid is rivers that run over
// hilltops. That happens when you route flow on a raw noise field: noise has
// local minima everywhere, so every stream terminates in a puddle a few cells
// long and nothing ever accumulates into a river. Filling the depressions first
// is what turns a bumpy surface into one with a connected drainage network.
// ---------------------------------------------------------------------------

// Binary min-heap over (float key, int32 payload), in typed arrays.
//
// Object-per-entry would allocate several million short-lived objects and hand
// the GC a pause in the middle of a load screen. Two parallel typed arrays cost
// 8 bytes per slot and never allocate after growth settles.
class MinHeap {
  constructor(capacity = 1 << 16) {
    this.k = new Float32Array(capacity)
    this.v = new Int32Array(capacity)
    this.n = 0
  }

  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float32Array(this.n * 2)
      const v = new Int32Array(this.n * 2)
      k.set(this.k)
      v.set(this.v)
      this.k = k
      this.v = v
    }
    const { k, v } = this
    let i = this.n++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= key) break
      k[i] = k[p]
      v[i] = v[p]
      i = p
    }
    k[i] = key
    v[i] = val
  }

  pop() {
    const { k, v } = this
    const top = v[0]
    const n = --this.n
    const key = k[n]
    const val = v[n]
    let i = 0
    for (;;) {
      let c = 2 * i + 1
      if (c >= n) break
      if (c + 1 < n && k[c + 1] < k[c]) c++
      if (k[c] >= key) break
      k[i] = k[c]
      v[i] = v[c]
      i = c
    }
    if (n > 0) {
      k[i] = key
      v[i] = val
    }
    return top
  }
}

/**
 * Priority-Flood depression filling (Barnes, Lehman & Mulla 2014), the variant
 * with a plain FIFO alongside the heap.
 *
 * Flood inward from the map edge, always expanding from the lowest frontier
 * cell. Any cell the flood reaches that sits BELOW the water already there is
 * inside a depression, so it is raised to that level -- which is exactly its
 * spill elevation, the height at which the depression would overflow. That is
 * the lake surface, for free and by construction rather than by iteration.
 *
 * The FIFO is the standard optimisation and it is not a micro-optimisation: a
 * raised cell is at exactly the current frontier elevation, so it can be
 * processed immediately without a heap round trip. Depressions are where most
 * of the work is, so this takes the bulk of the traffic off the heap.
 *
 * Three things come out, and the last two are what make everything downstream
 * cheap:
 *
 *   filled  the depression-free surface. Lakes are FLAT in it, which is what
 *           makes `filled > elev` a lake test and `filled` a lake level.
 *   order   the pop sequence, which is non-decreasing in `filled`. Reversed, it
 *           is a valid topological order for anything that flows downhill --
 *           see flowAccumulation, which needs no sort because of it.
 *   tree    which cell discovered each cell. This is a spanning tree rooted at
 *           the map edge, and every edge of it points to a cell that is no
 *           higher and was popped earlier. That makes it a guaranteed-acyclic
 *           fallback for flats, where steepest descent has no answer at all.
 */
export function priorityFlood(elev, n) {
  const size = n * n
  const filled = Float32Array.from(elev)
  const closed = new Uint8Array(size)
  const order = new Int32Array(size)
  const tree = new Int32Array(size).fill(-1)
  const heap = new MinHeap()
  // Every cell is pushed at most once (`closed` is set at push time, not at pop
  // time), so a plain array with a moving head never needs to wrap.
  const pit = new Int32Array(size)
  let pitHead = 0
  let pitTail = 0

  const seed = (c) => {
    closed[c] = 1
    heap.push(filled[c], c)
  }
  for (let i = 0; i < n; i++) {
    seed(i)
    seed((n - 1) * n + i)
  }
  for (let j = 1; j < n - 1; j++) {
    seed(j * n)
    seed(j * n + n - 1)
  }

  let count = 0
  let lakeCells = 0
  while (pitHead < pitTail || heap.n > 0) {
    const c = pitHead < pitTail ? pit[pitHead++] : heap.pop()
    order[count++] = c
    const ci = c % n
    const cj = (c / n) | 0
    const hc = filled[c]
    for (let d = 0; d < 8; d++) {
      const ni = ci + NB_DI[d]
      const nj = cj + NB_DJ[d]
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nn = nj * n + ni
      if (closed[nn]) continue
      closed[nn] = 1
      tree[nn] = c
      if (filled[nn] <= hc) {
        if (filled[nn] < hc) lakeCells++
        filled[nn] = hc
        pit[pitTail++] = nn
      } else {
        heap.push(filled[nn], nn)
      }
    }
  }

  if (count !== size) {
    throw new Error(`priority-flood reached ${count} of ${size} cells -- the grid is not connected`)
  }
  return { filled, order, tree, lakeCells }
}

/**
 * Depression BREACHING -- §2 step 4, channel carving, in its cheapest and most
 * load-bearing form.
 *
 * Why this exists, measured rather than assumed: on this terrain, priority-flood
 * raises 43% of the map, and the depressions it fills are a median of 21 m deep
 * and 90 m deep at the 90th percentile. Those are not the roughness of the noise.
 * They are genuine enclosed basins, and fbm has exactly as many of them as it has
 * peaks, because it is symmetric about its mean and nothing has ever eroded it.
 * Real mountain DEMs have almost no depressions at all -- rivers spent a million
 * years cutting outlets through every rim. Fill alone would hand us a world that
 * is 40% lake, which is not the world in DESIGN.md.
 *
 * So: for each basin, instead of raising the floor to the rim, cut a channel
 * through the rim down to the floor. That is what a river does, it is what §2
 * step 4 asks for, and it produces gorges exactly where a deep basin sits behind
 * a high rim -- which is the geologically right place for one.
 *
 * The route is a LEAST-COST PATH (Lindsay 2016), not the flood's spanning tree.
 * The tree version is the obvious cheap answer -- the flood already crossed the
 * rim at the spill point, so the path is sitting in its output for free -- and it
 * is where this function started. It is also wrong in a way no invariant can
 * catch: inside a depression the tree is a BFS across a FLAT surface, so it takes
 * the straightest route an 8-neighbourhood allows and ignores the valley under
 * it. The whole map came out as straight segments meeting at right angles. See
 * the search itself for the cost function and for why one of its three terms is
 * the difference between a river network and a road network.
 *
 * THE KNOB IS HOW MUCH SURFACE A LAKE MAY KEEP. Three framings were tried and
 * measured before this one; the two that failed are worth recording, because
 * both look obviously right on paper.
 *
 *   Cap the cut depth, refuse anything deeper. Binary on this terrain. Nearly
 *   every basin here is 85-100 m deep, so they all flip together: a cap of 85 m
 *   leaves 33% of the map under water and a cap of 100 m leaves 0%. There is no
 *   setting in between that yields "a few lakes".
 *
 *   Cap the cut depth, incise partially, iterate. Not idempotent. A partially
 *   drained basin still has a floor with no lower neighbour, so the next pass
 *   incises it another maxDepth, and iterating to convergence is just full
 *   breaching taking longer to get there.
 *
 *   Cap the retained DEPTH. Idempotent, continuous, and wrong for a different
 *   reason: it makes every lake in the world exactly as deep as the cap. At the
 *   1-2 m that keeps total water reasonable, a 0.7 km^2 body is a flooded
 *   meadow, not a lake.
 *
 * Capping the retained AREA instead draws each basin down to the level at which
 * its own surface fits under `maxLakeArea`, so the depth that survives is
 * whatever the shape of the basin gives. A steep-walled bowl reaches the area
 * cap while still deep and keeps a tarn; a broad flat floodplain hits it almost
 * at its floor and drains to a river. That is both the right visual answer and
 * the right geological one -- it is a hypsometric argument, and it is why real
 * lakes cluster in cirques and not on outwash plains.
 *
 * It is idempotent for free: a basin already at the cap contains no more than
 * `k` cells, so the next pass computes a zero-length cut.
 *
 *   maxLakeArea  square metres of water surface a basin may keep. 0 fully drains
 *                the world. This is the knob.
 *   maxLakeDepth backstop only, so a pathological narrow shaft cannot keep a
 *                200 m water column just because it is narrow.
 *   maxCut       refuse rather than gouge. A basin needing more than this keeps
 *                its lake instead. A backstop against one absurd slot, not a
 *                tuning knob.
 *   maxLength    cells of channel. Guards against a pathological path running
 *                half the map before it finds ground below the basin floor.
 *   minBite      metres. Below this a cut is not draining anything and is
 *                refused, which is what makes the outer loop terminate.
 *
 * Call this repeatedly until `breached` reaches 0. One pass is never enough:
 * basins nest, and a basin's flat lake surface hides the sub-basins in the
 * terrain underneath it, which only become visible once it drains.
 *
 * Returns a NEW elevation array. The input is not modified, because callers want
 * to keep the uncarved surface around to compute the carve delta that Phase B
 * applies per chunk.
 */
export function breachDepressions(elev, n, cell, { maxLakeArea = 0, maxLakeDepth = 60, maxCut = 200, maxLength = 2500, slope = 0.01, minBite = 0.1, maxPops = 40000 } = {}) {
  const size = n * n
  const out = Float32Array.from(elev)
  // The spanning tree is deliberately unused here. It was the outlet path in the
  // previous version and that is exactly what produced straight-line drainage;
  // see the least-cost search below.
  const { filled } = priorityFlood(out, n)
  // The area cap, in cells. A basin with no more than this many cells under
  // water is already small enough and is left alone entirely.
  const maxLakeCells = Math.floor(maxLakeArea / (cell * cell))

  // Find each basin's floor: the lowest cell of each connected component of
  // "was raised". One breach per basin, started from its deepest point, so the
  // single channel drains the whole thing.
  const seen = new Uint8Array(size)
  const queue = new Int32Array(size)
  const levels = new Float32Array(size) // scratch: one basin's cell elevations
  const basins = []
  for (let s = 0; s < size; s++) {
    if (seen[s] || filled[s] <= out[s] + 1e-4) continue
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    let floor = s
    while (head < tail) {
      const c = queue[head++]
      if (out[c] < out[floor]) floor = c
      levels[head - 1] = out[c]
      const ci = c % n
      const cj = (c / n) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (seen[nn] || filled[nn] <= out[nn] + 1e-4) continue
        seen[nn] = 1
        queue[tail++] = nn
      }
    }
    // Where to draw this basin down to. `levels[0..tail)` holds every cell
    // elevation in the basin, so the level at which the surface first exceeds
    // the area cap is simply the k-th smallest of them -- one quickselect, no
    // hypsometric curve to build and no iteration over stages.
    let level
    if (tail <= maxLakeCells) {
      level = filled[s] // already small enough: keep the whole thing, cut nothing
    } else {
      level = select(levels, tail, maxLakeCells)
      const capped = out[floor] + maxLakeDepth
      if (level > capped) level = capped
    }
    basins.push({ floor, level, cells: tail })
  }

  // Deepest basins first. A big basin's channel often passes through smaller
  // ones on its way out, draining them for free, and doing it in the other order
  // wastes the cut.
  basins.sort((a, b) => out[a.floor] - out[b.floor])

  // --- least-cost outlet search --------------------------------------------
  //
  // THIS IS THE PART THAT DECIDES WHETHER THE WORLD HAS RIVERS OR ROADS, and it
  // replaces a version that walked the priority-flood spanning tree from the
  // basin floor. That version was correct -- every invariant held, all 42 checks
  // passed -- and the map view showed a drainage network made of straight
  // 45-degree segments meeting at right angles in closed polygons. Not a river
  // in it.
  //
  // The cause is that inside a depression the flood's tree is a BFS from the
  // spill point across a FLAT surface, so it has no reason to prefer one route
  // over another and takes the straightest one available on an 8-neighbourhood.
  // Every channel therefore ran dead straight across whatever the basin floor
  // happened to contain, ignoring the valley actually under it.
  //
  // The comment this replaces argued least-cost breaching "buys smaller VOLUME,
  // never a smaller maximum depth -- which is why there is no point implementing
  // it here." The depth claim is true and irrelevant. What least-cost buys is the
  // SHAPE of the path, and the shape is the entire visible output of this pass.
  //
  // Dijkstra from the floor, where the cost of stepping onto a cell is:
  //
  //   cutCost   how far the cell stands above the draw-down level -- zero for
  //             anything already under it, which makes the whole sub-level set
  //             free to cross and sends the search straight at the lowest saddle
  //   lowPref   a small preference for lower ground, non-zero even inside the
  //             free region. WITHOUT THIS TERM THE STRAIGHT LINES COME BACK:
  //             a tie among free cells is exactly the degenerate case the flood
  //             tree had, and this is what makes the channel hug the valley
  //             bottom rather than any equally-cheap route across it
  //   lenCost   per step, so it does not wander
  //
  // All three are in metres, so they can be compared without a scale factor.
  const LOW_PREF = 0.05
  const LEN_COST = 0.02
  // How much the tie-break sum is allowed to matter against the bottleneck. Small
  // enough that it can never reorder two genuinely different barrier heights.
  const TIE = 1e-4

  const gcost = new Float32Array(size) // the bottleneck: highest barrier so far
  const gtie = new Float32Array(size) // the accumulated tie-break, kept separately
  const parent = new Int32Array(size)
  const plen = new Int32Array(size)
  // Generation stamps rather than clearing four size-of-map arrays per basin.
  // At ten thousand basins that would be forty thousand full-array clears.
  const stamp = new Int32Array(size)
  const done = new Int32Array(size)
  const heap = new MinHeap(1 << 14)
  let gen = 0

  /** Cheapest cell that drains this basin, or -1 if there isn't one in budget. */
  // Set by route() when the outlet was accepted by the map-edge rule rather than
  // by the below-the-ramp test; see there.
  let viaBorder = false

  const route = (floor, level) => {
    gen++
    viaBorder = false
    heap.n = 0
    const floorH = out[floor]
    gcost[floor] = 0
    gtie[floor] = 0
    parent[floor] = -1
    plen[floor] = 0
    stamp[floor] = gen
    heap.push(0, floor)
    let pops = 0
    while (heap.n > 0) {
      const c = heap.pop()
      if (done[c] === gen) continue // stale heap entry; this is lazy deletion
      done[c] = gen
      if (++pops > maxPops) return -1
      const len = plen[c]
      const ci = c % n
      const cj = (c / n) | 0
      if (c !== floor) {
        // An outlet is a cell BELOW THE RAMP AND OUTSIDE EVERY DEPRESSION. Both
        // halves are load-bearing, and leaving off the second half is a bug that
        // hides completely: the first steps out of a basin floor are still under
        // water, and any of them below the draw-down level would end the search
        // immediately with a zero-length channel. The basin then reports itself
        // already drained and keeps its lake forever. Measured on the tree-walk
        // version, this no-oped every large basin on the map -- 17 of 10,284
        // breached instead of 9,345 -- while looking exactly like a converged run.
        //
        // TOL, not zero: `out` is float32 and the ramp is computed in float64, so
        // a cell written by a previous pass reads back a few 1e-7 above the target
        // that produced it. Without the tolerance every pass re-cuts every channel
        // by a millionth of a metre and the caller's converge loop never ends.
        if (out[c] <= level - len * slope + TOL && filled[c] <= out[c] + TOL) return c
        // The map edge drains off the world by definition (§2: the world is an
        // island in fog), so reaching it ends the search whatever the height.
        //
        // WHATEVER THE HEIGHT is the whole point and also the trap. An outlet
        // accepted by the test above is by definition already below the ramp, so
        // the caller excludes it from the channel; a border cell accepted here
        // can be ABOVE it and still has to be cut through. Flagging which rule
        // fired is the only way the caller can tell. Getting this wrong strands
        // every basin whose floor sits next to the map edge: the channel comes
        // back zero-length, nothing is carved, and the basin survives to be
        // re-routed identically on every subsequent pass. Measured: 136 basins.
        if (ci === 0 || cj === 0 || ci === n - 1 || cj === n - 1) {
          viaBorder = true
          return c
        }
      }
      if (len >= maxLength - 1) continue
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (done[nn] === gen) continue
        const above = out[nn] - level
        const rise = out[nn] - floorH
        // MAX, not sum, and this one operator is the difference between a river
        // network and a road network -- see the note above. The bottleneck and
        // the tie-break are carried SEPARATELY: folding the tie into gcost would
        // let it accumulate through every subsequent max() and slowly turn the
        // bottleneck back into a sum, which is the thing being avoided.
        const nb = Math.max(gcost[c], above > 0 ? above : 0)
        const nt = gtie[c] + (rise > 0 ? LOW_PREF * rise : 0) + LEN_COST * NB_DIST[k]
        const key = nb + TIE * nt
        if (stamp[nn] === gen && gcost[nn] + TIE * gtie[nn] <= key) continue
        stamp[nn] = gen
        gcost[nn] = nb
        gtie[nn] = nt
        parent[nn] = c
        plen[nn] = len + 1
        heap.push(key, nn)
      }
    }
    return -1
  }

  const path = new Int32Array(maxLength)
  const rev = new Int32Array(maxLength)
  let breached = 0
  let ponded = 0
  let refused = 0
  let deepestCut = 0
  let longest = 0
  for (const basin of basins) {
    const floor = basin.floor
    // The basin may already have been drained by an earlier, deeper breach
    // passing through it, in which case there is nothing to do.
    let hasLower = false
    const fi = floor % n
    const fj = (floor / n) | 0
    for (let k = 0; k < 8; k++) {
      const ni = fi + NB_DI[k]
      const nj = fj + NB_DJ[k]
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      if (out[nj * n + ni] < out[floor]) {
        hasLower = true
        break
      }
    }
    if (hasLower) continue

    // Incise the outlet down to the level the area cap allows. Routing at that
    // level rather than at the floor is what makes a second pass over the same
    // basin a no-op.
    const level = basin.level
    const outlet = route(floor, level)
    if (outlet < 0) {
      refused++
      continue
    }

    // Reconstruct floor -> outlet, excluding the floor (already at the bottom)
    // and excluding the outlet ONLY when it was accepted for being below the
    // ramp. A border outlet has passed no height test and is part of the cut.
    // `parent` runs backwards, so collect and flip.
    let cnt = 0
    for (let c = viaBorder ? outlet : parent[outlet]; c >= 0 && c !== floor && cnt < maxLength; c = parent[c]) rev[cnt++] = c
    for (let k = 0; k < cnt; k++) path[k] = rev[cnt - 1 - k]

    // The deepest bite the channel takes. Note this is NOT the same quantity the
    // tree-walk version measured: least-cost picks the cheapest crossing rather
    // than the flood's spill point, so on ground with more than one saddle it can
    // report a different -- never larger -- number for the same basin.
    let cut = 0
    for (let k = 0; k < cnt; k++) {
      const d = out[path[k]] - (level - (k + 1) * slope)
      if (d > cut) cut = d
    }
    if (cut > maxCut) {
      refused++
      continue
    }
    const m = { len: cnt, cut }
    if (m.len === 0) continue // already at its cap; nothing to cut
    // A channel that only shaves a few centimetres off its rim is not draining
    // anything; it is the area cap chasing its own tail. Drawing a basin down
    // slightly lowers the cells inside it, which lowers the k-th smallest
    // elevation the cap selects, which asks for a slightly lower outlet, forever.
    // Measured: without this floor, ~7,400 basins were re-cut every pass with a
    // deepest bite of 0.0 m and the basin count fell by 24 per pass out of 11,000.
    //
    // ONLY IN THAT REGIME, though, and the qualifier is the whole fix. The tail
    // needs an area cap to chase: when `level` is the floor itself, carving the
    // path cannot move the level, so a small bite is not a symptom of an
    // oscillation, it is a real sill a few centimetres high with lower ground on
    // the far side. Refusing those stranded 437 basins on this map -- mean cut
    // 5.5 cm over a mean path of 1.2 cells -- and, because refusing is not
    // `refused`, the outer loop read the stall as convergence. `!changed` below
    // is the guard that holds in this regime, and it holds exactly: the writes
    // are monotone, so a re-cut of an already-cut channel changes nothing.
    if (m.cut < minBite && level > out[floor] + TOL) continue
    let changed = false
    for (let k = 0; k < m.len; k++) {
      const v = level - (k + 1) * slope
      if (out[path[k]] > v + TOL) {
        out[path[k]] = v
        changed = true
      }
    }
    if (!changed) continue
    breached++
    if (level > out[floor] + 1e-3) ponded++
    if (m.cut > deepestCut) deepestCut = m.cut
    if (m.len > longest) longest = m.len
  }

  return { elev: out, basins: basins.length, breached, ponded, refused, deepestCut, longestChannel: longest }
}

/**
 * D8 flow direction on the filled surface, with the flood's spanning tree as
 * the fallback.
 *
 * Steepest descent alone cannot route a flat, and after depression filling the
 * map is full of flats -- every lake is one. The usual fixes (iterative flat
 * resolution, epsilon gradients) are extra passes. The flood already produced a
 * tree whose every edge points to a no-higher, earlier-popped cell, so on a flat
 * we simply follow it and the water leaves the lake by the route the flood came
 * in, which is the spill point. That is the correct answer, not an approximation
 * of one.
 *
 * The guarantee worth stating: EVERY receiver is earlier in `order` than its
 * donor. A strictly-lower cell must be, because the pop sequence is
 * non-decreasing in `filled`; a tree parent must be, because it did the
 * discovering. So the flow graph cannot contain a cycle, whatever the terrain
 * does, and flowAccumulation below needs no cycle guard.
 *
 * -1 means the cell drains off the edge of the world.
 */
export function flowDirections(filled, tree, n) {
  const size = n * n
  const recv = new Int32Array(size)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const hc = filled[c]
      let best = -1
      let bestSlope = 0
      for (let d = 0; d < 8; d++) {
        const ni = i + NB_DI[d]
        const nj = j + NB_DJ[d]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        const drop = hc - filled[nn]
        if (drop <= 0) continue
        const s = drop / NB_DIST[d]
        if (s > bestSlope) {
          bestSlope = s
          best = nn
        }
      }
      recv[c] = best >= 0 ? best : tree[c]
    }
  }
  return recv
}

/**
 * Flow accumulation: how many cells drain through each cell, counting itself.
 *
 * One pass in reverse pop order. No sort, no queue, no repeated sweeps until
 * convergence -- the flood already handed us a topological order and this is
 * the payoff for having kept it. O(size), and the whole thing is two array
 * reads and one add per cell.
 */
export function flowAccumulation(recv, order, size) {
  const acc = new Float32Array(size).fill(1)
  for (let k = size - 1; k >= 0; k--) {
    const c = order[k]
    const r = recv[c]
    if (r >= 0) acc[r] += acc[c]
  }
  return acc
}

/**
 * Chamfer distance transform: metres to the nearest set cell in `mask`.
 *
 * Two sweeps (forward then backward) with the 3x3 chamfer weights, which is
 * O(size) and within a couple of percent of true Euclidean -- far better than
 * the 8-connected city-block distance a naive BFS gives, and that error matters
 * here because the moisture field feeds biome boundaries directly. A visibly
 * octagonal moisture field would draw visibly octagonal forests.
 */
export function distanceTo(mask, n, cell) {
  const size = n * n
  const D = new Float32Array(size)
  const FAR = 1e9
  for (let c = 0; c < size; c++) D[c] = mask[c] ? 0 : FAR

  const A = 0.95509 // chamfer weights for the 3x3 neighbourhood (Borgefors)
  const B = 1.36930

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      let d = D[c]
      if (d === 0) continue
      if (i > 0 && D[c - 1] + A < d) d = D[c - 1] + A
      if (j > 0) {
        if (D[c - n] + A < d) d = D[c - n] + A
        if (i > 0 && D[c - n - 1] + B < d) d = D[c - n - 1] + B
        if (i < n - 1 && D[c - n + 1] + B < d) d = D[c - n + 1] + B
      }
      D[c] = d
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const c = j * n + i
      let d = D[c]
      if (d === 0) continue
      if (i < n - 1 && D[c + 1] + A < d) d = D[c + 1] + A
      if (j < n - 1) {
        if (D[c + n] + A < d) d = D[c + n] + A
        if (i < n - 1 && D[c + n + 1] + B < d) d = D[c + n + 1] + B
        if (i > 0 && D[c + n - 1] + B < d) d = D[c + n - 1] + B
      }
      D[c] = d
    }
  }
  for (let c = 0; c < size; c++) D[c] = D[c] >= FAR ? FAR : D[c] * cell
  return D
}

// Quickselect: the k-th smallest of `a[0..len)`, in place. Used to find the
// stage at which a basin's flooded surface first exceeds the area cap, which is
// a pure order statistic -- sorting the whole basin would be O(m log m) for one
// number, and the basins here run to hundreds of thousands of cells.
function select(a, len, k) {
  let lo = 0
  let hi = len - 1
  const target = k < 0 ? 0 : k >= len ? len - 1 : k
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]
    let i = lo
    let j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) {
        const t = a[i]
        a[i] = a[j]
        a[j] = t
        i++
        j--
      }
    }
    if (target <= j) hi = j
    else if (target >= i) lo = i
    else return a[target]
  }
  return a[target]
}

// ---------------------------------------------------------------------------
// Fluvial erosion: the stream-power law, solved implicitly (Braun & Willett
// 2013, "A very efficient O(n), implicit and parallel method to solve the
// stream power equation").
//
// WHY THIS EXISTS. The flow map on uneroded fbm is a LATTICE: closed polygonal
// cells at a uniform ~500 m spacing, drainage density 1.9-2.1 km/km^2, and only
// 0.6-1.6% of channel length carrying more than 100 km^2 of catchment. There is
// no trunk river anywhere in it. That is an egg-carton signature and no amount
// of macro-scale tiering fixes it, because drainage density is set by the
// FINEST scale that has local minima -- add a 20 km landform and you still get
// 500 m puddles on top of it. Real landscapes are not noise; they are noise
// that water has run over. This runs the water.
//
// dh/dt = -K * A^m * S^n, with n = 1 so the solution is linear in h.
//
// The implicit form, taking each cell's receiver as already updated:
//
//   h_i' = (h_i + f * h_r') / (1 + f),   f = K * dt * A^m / dx
//
// Two properties earn it its place over the obvious explicit loop:
//
//   1. It is UNCONDITIONALLY STABLE. The explicit form needs dt small enough
//      that no cell erodes past its receiver in one step, which on a 16 m grid
//      with 300 m of relief means hundreds of tiny steps.
//   2. h_i' is a weighted average of h_i and h_r', both of which are >= h_r',
//      so h_i' >= h_r' ALWAYS: incision cannot invert a slope and therefore
//      CANNOT CREATE A NEW PIT. That is what makes this cheap to bolt onto the
//      existing pipeline -- no re-breaching afterwards, and the flow topology
//      stays valid between iterations.
//
// Requires `order` from priorityFlood, which pops lowest-first and so lists
// every cell after its receiver. Walking it forwards means h_r' is already the
// updated value, which is exactly what the implicit form asks for.
export const EROSION = {
  passes: 25,
  // K * dt, lumped: the two are not separately observable here because there is
  // no independent clock. Sized against the group that actually appears in the
  // update, f = kdt * A^m / dx, at the two ends of the catchment range on a
  // 1024^2 grid (dx 16 m):
  //   a headwater cell,  A ~ 1e5 m^2  ->  f ~ 0.02   (barely touched)
  //   a trunk river,     A ~ 3e8 m^2  ->  f ~ 0.6    (cuts hard)
  // That 30x separation is the whole point: valleys deepen where water collects
  // and divides are left alone, so relief goes UP locally even though the total
  // volume only ever goes down.
  kdt: 2e-3,
  m: 0.5,
  // Below this catchment, in square metres, a cell is a hillslope and not a
  // channel. Without it the finest scale still gets a little incision
  // everywhere, which re-smooths the divides the erosion is meant to sharpen.
  minArea: 4e4,
}

/**
 * Incise `elev` in place along the drainage network. `recv` and `order` come
 * from flowDirections/priorityFlood; `acc` is in CELLS and is converted to
 * square metres here. Returns the deepest single-cell incision, in metres.
 */
export function incise(elev, recv, order, acc, n, cell, opts = EROSION) {
  const cellArea = cell * cell
  let deepest = 0
  for (let k = 0; k < order.length; k++) {
    const c = order[k]
    const r = recv[c]
    if (r < 0) continue // an outlet: base level, nothing downstream to cut toward
    const area = acc[c] * cellArea
    if (area < opts.minArea) continue
    // Diagonal receivers are further away, and using a uniform dx makes
    // diagonal channels incise ~40% too fast, which shows up as a bias toward
    // 45-degree valleys -- the same lattice artefact in a different direction.
    const di = (c % n) - (r % n)
    const dj = ((c / n) | 0) - ((r / n) | 0)
    const dx = cell * (di !== 0 && dj !== 0 ? Math.SQRT2 : 1)
    const f = (opts.kdt * Math.pow(area, opts.m)) / dx
    const hr = elev[r]
    const before = elev[c]
    const after = (before + f * hr) / (1 + f)
    elev[c] = after
    const cut = before - after
    if (cut > deepest) deepest = cut
  }
  return deepest
}
