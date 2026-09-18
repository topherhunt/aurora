// ---------------------------------------------------------------------------
// The things she has picked up, so the scatters do not grow them back.
//
// Every prop and creature bed is a pure function of its tile seed and regrows
// whenever its tile is re-entered or thickened, so a mushroom pulled out of the
// ground would be standing there again the moment she walked 60 m away and
// back. Each bed asks here, by kind and by the position it is about to grow
// at, before it spends an instance. Positions are matched to TOLERANCE_M
// because a bed stores float32 and recomputes in float64. Session memory only:
// the save does not carry it, so a reload regrows everything.
// ---------------------------------------------------------------------------

const TOLERANCE_M = 0.05

export class Taken {
  constructor() {
    // kind -> flat [x0, z0, x1, z1, ...]
    this.byKind = new Map()
  }

  add(kind, x, z) {
    if (typeof kind !== 'string' || kind === '' || !Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`Taken.add: bad entry ${kind} ${x} ${z}`)
    let list = this.byKind.get(kind)
    if (!list) this.byKind.set(kind, (list = []))
    list.push(x, z)
  }

  has(kind, x, z) {
    const list = this.byKind.get(kind)
    if (!list) return false
    for (let i = 0; i < list.length; i += 2) {
      if (Math.abs(list[i] - x) < TOLERANCE_M && Math.abs(list[i + 1] - z) < TOLERANCE_M) return true
    }
    return false
  }

  get count() {
    let n = 0
    for (const list of this.byKind.values()) n += list.length / 2
    return n
  }

  clear() {
    this.byKind.clear()
  }
}

/** The one registry every bed consults; a gate makes its own. */
export const taken = new Taken()
