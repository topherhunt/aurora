import { priorityFlood, MinHeap } from '../sim/hydrology.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'

const TOL = 1e-3

// ---------------------------------------------------------------------------
// Step D, first of all -- the basins drain. Eleven octaves of height jitter make a landscape that reads beautifully dry and holds water in thousands of places it should not: every dip is a lake. This pass empties them, and it is the first thing that touches the field.
//
//   THE ONLY THING A BASIN IS JUDGED ON IS HOW DEEP IT IS. The `keep` deepest keep their water and every other basin is drained until under `pond` metres stands in it. Not shape, not roundness, not the widest disc that fits inside it -- a lake picked for its roundness is a round lake, and the shapes the terrain actually offers are the interesting ones.
//   A KEPT BASIN IS STILL DRAINED, down to `keepDepth`. Left alone the deepest basins on the island flood to their spills and put a whole biome under water; held to fifty metres they are lakes in a valley rather than the valley.
//   THE RIM IS CUT WITH A BROAD DISH AND NOTHING ELSE. Find the pond's lowest rim point, lower it by `drop` under a dish of radius half the pond's width that eases back into the ground at its edge, then solve the pond again -- new level, new rim point, usually somewhere else -- and repeat. The cut per round is `max(elev - drop * (1 - smoothstep), want)`, so its depth tapers to nothing at the dish's edge (no step) and it stops at the level this round is aiming for (the floor is not dug out from under the water). The union of a dozen overlapping dishes walking down and inward is a valley, which is what a basin that has drained looks like. Carving a line from the floor to a point past the rim is what it does not look like.
//   IT ONLY EVER LOWERS A TEXEL, like the carve after it. `elev = min(elev, target)` everywhere, so no round can stand a spike or a fin, and "the drain never raised a texel" is a one-line invariant over sixteen million cells.
//   ONE FLOOD, THEN LOCAL WORK. The global priority flood is 3.7 s on 4097 square and there is no budget to repeat it per round, so `esc` -- the level at which water on a cell gets away to the sea -- is taken from it once and then kept true by hand: a pond that drains has its cells written down to their ground, a pond that is kept to its surface. Basins are worked lowest spill first, so whatever a basin spills into has already been settled. `solvePond` then grows from a seed over its lowest frontier cell, raising the level to whatever it has had to admit, and stops at the first cell under that level whose `esc` is lower -- the ground the water gets away over. That is a few thousand cells per round instead of sixteen million.
//
// Heights are metres. Three-free and DOM-free like the rest of src/v3.
// ---------------------------------------------------------------------------

export const BASINS = {
  keep: 20,          // the deepest basins that keep their water. Everything else is emptied
  pond: 1,           // metres; a basin is drained until less than this stands in it, and less than this was never a basin. What is left is the silt step's
  keepDepth: 50,     // metres a kept basin may hold. A deeper one is drained down to this, so the island's biggest hollows are lakes in a valley and not the valley
  steps: 8,          // rounds the excess is meant to come off over, so each round's drop is a fraction of what is left rather than a fixed step
  minStep: 1.5,      // metres; never less than this in a round, so a shallow basin is done in one or two rather than creeping
  brush: 0.5,        // the dish's radius as a fraction of the pond's width -- half the width, so the dish spans about the water it is draining
  minBrush: 40,      // metres. The pond shrinks as it drains, so this is the width of the last and deepest rounds -- the bottom of the outlet. Too small and a deep basin ends in a slot at the foot of a dish
  maxBrush: 320,     // metres. Bounds the cost of one round at 80k cells on the 2 m grid
  rounds: 240,       // rounds per pond before it is given up on and reported as stuck. A cap, not a budget: `steps` rounds should do it, and what needs hundreds is a basin whose rim is a row of cols at nearly one height, each of which has to be cut in its turn before the level moves
}

/**
 * `drainBasins(elev, sea, n, cell, opts)` -> { lakes, spare, surface, stats }
 *
 * Works on `elev` in place and may widen `sea` (a pocket the flood fills to the waterline is the sea's). `lakes` is the basins that kept their water, each `{ seed, level, depth, cells }` with `seed` the deepest cell; `spare` marks those cells and `surface` holds their level, which is what the carve after this reads to leave them alone. Every other basin is left holding under `opts.pond` metres.
 */
export function drainBasins(elev, sea, n, cell, opts = BASINS) {
  const O = opts
  const t0 = Date.now()
  const size = n * n
  const cellArea = cell * cell
  if (!(cell > 0)) throw new Error(`drainBasins: cell must be a positive number of metres, got ${cell}`)
  if (sea.length !== size) throw new Error(`drainBasins: sea has ${sea.length} texels, the field ${size}`)
  const before = Float32Array.from(elev)

  const flood = priorityFlood(elev, n)
  for (let c = 0; c < size; c++) if (flood.filled[c] <= 0) sea[c] = 1
  // The level at which water standing on a cell gets away to the sea. The flood gives it for the raw field; every cut below only lowers ground, so it is never an underestimate, and the two places it would go stale -- a pond that has drained, a pond that is kept -- are written by hand as each is settled.
  const esc = Float32Array.from(flood.filled)
  for (let c = 0; c < size; c++) if (sea[c]) esc[c] = elev[c]

  // --- the basins ---------------------------------------------------------------
  // Connected components of standing water on land, of which the ones more than `pond` metres deep are the basins. The margin is in the component however shallow it is: a basin whose middle is pinched by a saddle under a metre of water is still ONE basin, and splitting it there would mark the deep half for keeping and the shallow half for a drain it cannot have -- the two share a water table, so draining one means draining the other.
  const seen = new Uint8Array(size)
  const scan = new Int32Array(size)
  const basins = []
  for (let c0 = 0; c0 < size; c0++) {
    if (seen[c0] || sea[c0] || esc[c0] - elev[c0] <= TOL) continue
    let top = 0
    scan[top++] = c0
    seen[c0] = 1
    const cells = []
    let depth = 0
    let level = -Infinity
    while (top > 0) {
      const c = scan[--top]
      cells.push(c)
      const d = esc[c] - elev[c]
      if (d > depth) depth = d
      if (esc[c] > level) level = esc[c]
      const ci = c % n
      const cj = (c / n) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (seen[nn] || sea[nn] || esc[nn] - elev[nn] <= TOL) continue
        seen[nn] = 1
        scan[top++] = nn
      }
    }
    if (depth > O.pond) basins.push({ cells, depth, level })
  }

  // Deepest first, and the first `keep` of them hold their water. Depth and nothing else.
  const byDepth = basins.slice().sort((a, b) => b.depth - a.depth)
  for (let k = 0; k < byDepth.length; k++) byDepth[k].keep = k < O.keep
  const keptBasins = Math.min(O.keep, basins.length)
  // Worked lowest spill first, so a basin that spills into another meets it already settled and reads a true `esc` there.
  const order = basins.slice().sort((a, b) => a.level - b.level)

  // --- the drain ----------------------------------------------------------------
  const done = new Uint8Array(size)
  const spare = new Uint8Array(size)
  const surface = new Float32Array(size)
  const visit = new Int32Array(size).fill(-1)
  const heap = new MinHeap()
  const lakes = []
  let stamp = 0
  let cuts = 0
  let roundSum = 0
  let roundMax = 0
  let brushSum = 0
  let brushMax = 0
  let ponds = 0
  let stuck = 0
  let drowned = 0
  let absorbed = 0
  let drainedDeepest = 0

  /** The pond a seed sits in and the level its water stands at. Grows over the lowest frontier cell each time, raising `level` to whatever it has had to admit, and stops at the first cell under that level that already gets away lower -- the ground the water leaves over. `spill` is the cell that last raised the level, which is the pond's lowest rim point. Every cell it admits is pushed onto `touched`, which is how the drain knows afterwards which ground this pond was responsible for: the pond shrinks as its level falls, so the cells that fall dry on the way are in no later round's region and would otherwise each be re-seeded as a pond of its own. */
  function solvePond(seed, touched) {
    stamp++
    heap.n = 0
    heap.push(elev[seed], seed)
    visit[seed] = stamp
    let level = elev[seed]
    let floor = elev[seed]
    let floorCell = seed
    let spill = seed
    const region = []
    for (;;) {
      if (heap.n === 0) throw new Error(`drainBasins: the water at ${seed % n},${(seed / n) | 0} has nowhere to go`)
      const c = heap.pop()
      if (elev[c] < level - TOL && esc[c] < level - TOL) break
      if (elev[c] > level) {
        level = elev[c]
        spill = c
      }
      if (elev[c] < floor) {
        floor = elev[c]
        floorCell = c
      }
      region.push(c)
      touched.push(c)
      const ci = c % n
      const cj = (c / n) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (visit[nn] === stamp) continue
        visit[nn] = stamp
        heap.push(elev[nn], nn)
      }
    }
    const wet = []
    for (const c of region) if (elev[c] < level - TOL) wet.push(c)
    return { level, floor, floorCell, spill, wet }
  }

  /** One round's cut: a dish of radius `R` centred on the rim point, `drop` metres deep at the middle and tapering to nothing at the edge, and never below `want`. The taper is what keeps the dish's edge from standing as a step; `want` is what keeps the round from digging the floor out from under the water it is lowering. */
  function cutRim(spill, drop, R) {
    const want = elev[spill] - drop
    const ci = spill % n
    const cj = (spill / n) | 0
    const lo = Math.ceil(R / cell)
    for (let dj = -lo; dj <= lo; dj++) {
      const nj = cj + dj
      if (nj < 0 || nj >= n) continue
      for (let di = -lo; di <= lo; di++) {
        const ni = ci + di
        if (ni < 0 || ni >= n) continue
        const r = Math.hypot(di, dj) * cell
        if (r >= R) continue
        const c = nj * n + ni
        if (sea[c] || spare[c]) continue
        const t = r / R
        const target = Math.max(want, elev[c] - drop * (1 - t * t * (3 - 2 * t)))
        if (target < elev[c]) elev[c] = target
      }
    }
  }

  for (const b of order) {
    const target = b.keep ? O.keepDepth : 0
    const stop = b.keep ? O.keepDepth : O.pond
    // Seeded from the lowest cell of the basin upward: each pass drains the pond round the lowest cell that is still wet, so a basin that splits into lobes as its level falls has every lobe drained in turn.
    const foot = Array.from(b.cells).sort((x, y) => elev[x] - elev[y])
    for (const s of foot) {
      if (done[s]) continue
      ponds++
      let round = 0
      const touched = []
      for (;;) {
        const p = solvePond(s, touched)
        const deep = p.level - p.floor
        // Water standing at or under the waterline is the ocean's, whatever the drain was going to do with it: a round that cuts a coastal basin's outlet below zero has joined it to the sea, and v2's ocean plane will draw it. Cutting on is pointless -- the dish skips sea cells, so the outlet cannot be taken any lower.
        if (p.level <= 0) {
          for (const c of touched) {
            done[c] = 1
            esc[c] = elev[c]
          }
          for (const c of p.wet) sea[c] = 1
          done[s] = 1
          drowned++
          break
        }
        // The pond has run into a kept lake: its rim point is water the drain has already settled, so there is nothing to cut (the dish skips spare cells) and nothing to drain -- whatever lies under that surface is the lake's bottom. Two basins the flood read as separate can end up one body, because a cut made for a third basin joined them.
        if (spare[p.spill]) {
          const lvl = surface[p.spill]
          for (const c of touched) {
            done[c] = 1
            if (elev[c] < lvl - TOL) {
              spare[c] = 1
              surface[c] = lvl
              esc[c] = lvl
            } else esc[c] = elev[c]
          }
          done[s] = 1
          absorbed++
          break
        }
        if (deep <= stop + TOL || round >= O.rounds) {
          if (deep > stop + TOL) stuck++
          if (target === 0 && deep > drainedDeepest) drainedDeepest = deep
          // Everything the pond ever covered is settled, dry first: ground that fell dry as the level dropped now sheds its water into the pond, so it escapes at its own elevation. Then the cells still under water, whose escape is the surface if the basin is keeping it.
          for (const c of touched) {
            done[c] = 1
            esc[c] = elev[c]
          }
          for (const c of p.wet) {
            esc[c] = target > 0 ? p.level : elev[c]
            if (target > 0) {
              spare[c] = 1
              surface[c] = p.level
            }
          }
          done[s] = 1
          if (target > 0 && deep > O.pond) lakes.push({ seed: p.floorCell, level: p.level, depth: deep, cells: p.wet })
          break
        }
        const drop = Math.max(O.minStep, (deep - target) / O.steps)
        const width = 2 * Math.sqrt((p.wet.length * cellArea) / Math.PI)
        const R = Math.min(O.maxBrush, Math.max(O.minBrush, O.brush * width))
        cutRim(p.spill, drop, R)
        brushSum += R
        if (R > brushMax) brushMax = R
        cuts++
        round++
      }
      roundSum += round
      if (round > roundMax) roundMax = round
    }
  }

  let cutCells = 0
  let cutSum = 0
  let deepest = 0
  let raised = 0
  for (let c = 0; c < size; c++) {
    const d = before[c] - elev[c]
    if (d > 0.01) {
      cutCells++
      cutSum += d
      if (d > deepest) deepest = d
    } else if (d < -1e-6) raised++
  }

  return {
    lakes,
    spare,
    surface,
    stats: {
      basins: basins.length,
      kept: keptBasins,
      bodies: lakes.length,
      drained: basins.length - keptBasins,
      ponds,
      stuck,
      drowned,
      absorbed,
      cuts,
      roundMean: ponds ? roundSum / ponds : 0,
      roundMax,
      brushMean: cuts ? brushSum / cuts : 0,
      brushMax,
      drainedDeepest,
      keptKm2: (lakes.reduce((s, l) => s + l.cells.length, 0) * cellArea) / 1e6,
      keptDeepest: lakes.reduce((s, l) => Math.max(s, l.depth), 0),
      cutCells,
      cutKm2: (cutCells * cellArea) / 1e6,
      cutMean: cutCells ? cutSum / cutCells : 0,
      deepest,
      raised,
      ms: Date.now() - t0,
    },
  }
}
