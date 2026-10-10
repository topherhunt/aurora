// One shared per-frame budget for tile builds (grass, ferns, trees, litter, rocks, mushrooms, deadwood). Each layer
// keeps its own `queue` of tile jobs sorted farthest-first with a `d2`; the scheduler drains the NEAREST job across
// all of them until the frame's milliseconds are spent, so the ground under the player fills before any layer's
// outskirts do and placement can never cost more than `ms` a frame on average. Order: distance ring first (doubling
// from RING0_M), then the layer's rank (big things before small), then distance. See _notes/perf-ledger.md.

/** Outer edge of the innermost ring in metres; each ring outward doubles. Everything inside a ring is built before anything outside it. */
const RING0_SQ = 40 * 40

/** Frames of allowance a single dear tile may borrow, so a freak build cannot starve placement for long. */
const DEBT_CAP = 6

export class BuildScheduler {
  /**
   * @param ms wall-clock ms a frame may spend on tile builds, averaged: a tile dearer than the allowance is built
   *   alone and the overrun is repaid by skipping the following frames.
   */
  constructor(ms) {
    this.ms = ms
    this.sources = []
    this.debt = 0
    this.lastMs = 0
    this.built = 0
  }

  /**
   * `owner` has `queue` (jobs with `d2`, nearest last). `grow(job)` builds one (default `owner._growTile`). `on()` says whether its layer runs.
   * `rank` orders layers inside a ring: lower builds first (trees, then boulders, ferns, grass, litter).
   */
  add(owner, grow = (job) => owner._growTile(job), { on = () => true, rank = 0 } = {}) {
    owner.buildBudgetMs = 0
    this.sources.push({ owner, grow, on, rank, cost: 0.1 })
  }

  run() {
    const t0 = performance.now()
    const allowance = this.ms - this.debt
    let built = 0
    for (;;) {
      let best = null
      let bestRing = Infinity, bestRank = Infinity, bestD = Infinity
      for (const s of this.sources) {
        const job = s.owner.queue[s.owner.queue.length - 1]
        if (job === undefined || !s.on()) continue
        const ring = job.d2 <= RING0_SQ ? 0 : Math.ceil(Math.log2(job.d2 / RING0_SQ) / 2)
        if (ring < bestRing || (ring === bestRing && (s.rank < bestRank || (s.rank === bestRank && job.d2 < bestD)))) {
          bestRing = ring; bestRank = s.rank; bestD = job.d2; best = s
        }
      }
      if (best === null) break
      const spent = performance.now() - t0
      if (built > 0 && spent + best.cost > allowance) break
      if (built === 0 && allowance <= 0) break
      const t1 = performance.now()
      best.grow(best.owner.queue.pop())
      const took = performance.now() - t1
      best.cost += (took - best.cost) * 0.2
      built++
    }
    const total = performance.now() - t0
    this.debt = built === 0 ? Math.max(0, this.debt - this.ms) : Math.min(DEBT_CAP * this.ms, Math.max(0, this.debt + total - this.ms))
    this.lastMs = total
    this.built = built
  }
}
