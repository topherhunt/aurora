// Mining a vein with the pickaxe (design/42-valuables.md): a strike is an end of the pick coming within `reach` of a vein while moving faster than `mps`; `strikes` of them on one vein, each within `gapS` of the last, pry it loose.

export const PICK = { mps: 3, reach: 0.35, strikes: 3, gapS: 3 }

export class Pick {
  constructor() {
    this.vein = null
    this.count = 0
    this.at = -Infinity
    // Whether a fast end is in reach of `vein` now: a strike is counted as it comes in, not each frame it stays.
    this.inside = false
  }

  /** One frame: `tips` the pick's fast-moving ends ({ x, y, z }, empty while it is slow), `veins` those still in the wall ({ id, x, y, z }). The vein pried loose, or null. */
  step(tips, veins, now) {
    let hit = null
    for (const t of tips) {
      for (const v of veins) {
        if (Math.hypot(t.x - v.x, t.y - v.y, t.z - v.z) < PICK.reach) { hit = v; break }
      }
      if (hit !== null) break
    }
    if (hit === null) { this.inside = false; return null }
    if (this.inside && hit === this.vein) return null
    this.inside = true
    if (hit !== this.vein || now - this.at > PICK.gapS) { this.vein = hit; this.count = 0 }
    this.at = now
    if (++this.count < PICK.strikes) return null
    this.vein = null
    this.count = 0
    return hit
  }
}
