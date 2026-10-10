// One shared per-frame budget for tile builds (grass, ferns, trees, litter, rocks, mushrooms, deadwood). Each layer
// keeps its own `queue` of tile jobs; the scheduler builds the best job across all of them until the frame's
// milliseconds are spent, so the ground under the player fills before any layer's outskirts do and placement can
// never cost more than `ms` a frame on average. Order: distance ring first (doubling from RING0_M, measured from the
// player to the NEAREST point of the job's tile, so a 200 m boulder tile underfoot is ring 0), then the layer's
// `rank` (big things before small), then distance. See _notes/perf-ledger.md.

/** Outer edge of the innermost ring in metres; each ring outward doubles. Everything inside a ring is built before anything outside it. */
const RING0_SQ = 40 * 40
/** Frames of allowance a single dear tile may borrow, so a freak build cannot starve placement for long. */
const DEBT_CAP = 6
/**
 * Jobs looked at from the end of a queue. Layers sort a rebuilt queue farthest-first but then push level-change jobs
 * onto the end in any order, so the last entry is not always the nearest.
 */
const WINDOW = 512

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
    this.camX = 0
    this.camZ = 0
  }

  /**
   * `owner` has `queue` (jobs with `tx`, `tz`) and a `tile` size in metres (or pass `tile`). `grow(job)` builds one
   * (default `owner._growTile`). `on()` says whether its layer runs. `rank` orders layers inside a ring: lower
   * builds first (trees, then boulders, ferns, grass, litter).
   */
  add(owner, grow = (job) => owner._growTile(job), { on = () => true, rank = 0, tile = owner.tile } = {}) {
    if (!(tile > 0)) throw new Error('BuildScheduler.add: needs the layer\'s tile size')
    owner.buildBudgetMs = 0
    this.sources.push({ owner, grow, on, rank, tile, cost: 0.1, at: -1, ring: Infinity, d2: Infinity })
  }

  /** Squared distance from the player to the nearest point of a job's tile. */
  _near2(s, job) {
    const t = s.tile
    const nx = Math.max(job.tx * t, Math.min(this.camX, (job.tx + 1) * t))
    const nz = Math.max(job.tz * t, Math.min(this.camZ, (job.tz + 1) * t))
    return (nx - this.camX) ** 2 + (nz - this.camZ) ** 2
  }

  /** Points `s` at its best queued job: lowest ring, then the nearest. Leaves `at` -1 when it has none or is off. */
  _look(s) {
    s.at = -1
    s.ring = s.d2 = Infinity
    const q = s.owner.queue
    if (q.length === 0 || !s.on()) return
    for (let i = q.length - 1, stop = Math.max(0, q.length - WINDOW); i >= stop; i--) {
      const d2 = this._near2(s, q[i])
      if (d2 < s.d2) { s.d2 = d2; s.at = i }
    }
    s.ring = s.d2 <= RING0_SQ ? 0 : Math.ceil(Math.log2(s.d2 / RING0_SQ) / 2)
  }

  run(camX, camZ) {
    this.camX = camX
    this.camZ = camZ
    const t0 = performance.now()
    const allowance = this.ms - this.debt
    for (const s of this.sources) this._look(s)
    let built = 0
    for (;;) {
      let best = null
      for (const s of this.sources) {
        if (s.at < 0) continue
        if (best === null || s.ring < best.ring || (s.ring === best.ring && (s.rank < best.rank || (s.rank === best.rank && s.d2 < best.d2)))) best = s
      }
      if (best === null) break
      const spent = performance.now() - t0
      if (built > 0 && spent + best.cost > allowance) break
      if (built === 0 && allowance <= 0) break
      const q = best.owner.queue
      const job = q[best.at]
      q[best.at] = q[q.length - 1]
      q.pop()
      const t1 = performance.now()
      best.grow(job)
      const took = performance.now() - t1
      best.cost += (took - best.cost) * 0.2
      built++
      this._look(best)
    }
    const total = performance.now() - t0
    this.debt = built === 0 ? Math.max(0, this.debt - this.ms) : Math.min(DEBT_CAP * this.ms, Math.max(0, this.debt + total - this.ms))
    this.lastMs = total
    this.built = built
  }
}
