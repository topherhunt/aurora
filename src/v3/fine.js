import { clamp01, smoothstep } from '../sim/mathx.js'
import { JITTER, octaveAt, octaveTable, splitOctaves } from './island.js'

// ---------------------------------------------------------------------------
// The jitter ladder's last rungs, added at READ time -- §31 step B.
//
// The image holds the rungs its grid can carry (island.js, splitOctaves). This holds the rest: at 2 m a texel that is 4 m, 2 m and 1 m between nodes, moving their nodes by 1 m, 0.5 m and 0.25 m. Same hash, same salt, same golden-angle rotation, same smoothstep between nodes -- `octaveAt` is the one implementation, called from both sides -- so these are rungs of the one ladder and not a second algorithm that happens to sit underneath it. Sum the image's rungs and these and you have the field the cascade describes, to the metre and then to the quarter metre.
//
// IT IS EVALUATED, NEVER STORED, which is what lets it be finer than any grid. A lattice in an image needs four samples to a node or it aliases; a lattice evaluated at the point being asked about has no such limit, because there is no grid between the question and the answer. This is also the LOD: `cell` is the spacing the caller is sampling at, and a rung fades out as `cell` approaches its Nyquist, so a chunk meshed at 32 m evaluates none of this and a chunk at 0.5 m evaluates all of it. Collision, picking and the editor pass cell = 0 and get every rung at full weight.
//
// This object stands where v2's `Detail` stands (field.js, `detail`), and answers the same `at(x, z, cell, slope01, flatten01)`. Two of v2's conventions are deliberately NOT honoured. There is no amplitude calibration: the cascade's law is a quarter of the spacing at every rung, which is the whole point of it, and a fitted amplitude would be the tuning-by-fitting this replaces. And there is no slope boost: a rung is the same height on a cliff as on a plain. `slope01` is accepted and ignored so the call sites do not have to know which object they hold.
//
// THE SHORE EASING IS NOT APPLIED HERE, and that is a decision and not an oversight. Reading it needs the warped frame -- six simplex calls -- per sample, against rungs that sum to under two metres. So the coast gets its full quarter-metre-to-metre grain while the image's rungs ease off around it.
// ---------------------------------------------------------------------------

export class FineJitter {
  /**
   * `new FineJitter({ seed, cell })`, where `cell` is the metres a texel of the IMAGE covers -- the same number `Island` was split on, so this picks up exactly the rungs the image had to leave out.
   */
  constructor({ seed, cell, jitter = JITTER }) {
    if (!Number.isFinite(seed)) throw new Error(`FineJitter: seed must be a finite number, got ${seed}`)
    if (!(cell > 0)) throw new Error(`FineJitter: cell must be a positive number of metres, got ${cell}`)
    const { fine } = splitOctaves(octaveTable(seed, jitter), cell)
    this.octaves = fine
    this.smooth = jitter.interp === 'smooth'
    this.cell = cell
    // What this term can reach, either way, with every rung at full weight. The gate reads it; nothing in the loop does.
    this.reach = fine.reduce((s, o) => s + Math.abs(o.amp), 0)
  }

  /** Metres of jitter below the image's resolution at (x, z). `cell` band-limits, `flatten01` suppresses (a river bed a layer has levelled keeps no grain), `slope01` is ignored. */
  at(x, z, cell, slope01, flatten01) {
    const suppress = 1 - clamp01(flatten01)
    if (suppress <= 0) return 0
    // The same band limit and the same argument order as detail.js: a rung is dead once its spacing is under twice the sampling cell and fully alive over four times it. At cell = 0 the divide is Infinity and clamp01 pins every weight to exactly 1, so the exact field is a limit of the band-limited one rather than a second code path.
    const lo = cell * 2
    const hi = cell * 4
    let sum = 0
    for (const o of this.octaves) {
      const w = smoothstep(lo, hi, o.spacing)
      if (w <= 0) continue
      sum += w * octaveAt(o, x, z, this.smooth)
    }
    return sum * suppress
  }
}
