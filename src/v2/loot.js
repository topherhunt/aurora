// What has been taken from which place (design/42-valuables.md, The loot ledger): `[place, bit]` entries, the place a
// kind letter and a stable id (`l` labyrinth hash, `r` roost key, `c` cave system seed, `d` a dead dragon), the bit
// one thing there. Only the last PLACES places are kept; an evicted place regrows. Saved, told to the room, and
// taught to every client in it, like trust.js.

export const PLACES = 100
// server/src/main.js LOOT_BATCH.
export const BATCH = 64

const PLACE = /^[lrcd][0-9a-z]{1,12}$/

function valid(t) {
  return Array.isArray(t) && t.length === 2 && typeof t[0] === 'string' && PLACE.test(t[0]) && Number.isInteger(t[1]) && t[1] >= 0 && t[1] < 4096
}

/** A place's ledger key: `kind` one of l r c d, `id` a non-negative integer. */
export function place(kind, id) {
  if (!/^[lrcd]$/.test(kind) || !Number.isInteger(id) || id < 0) throw new Error(`Loot: a place is a kind letter and an id, got ${kind} ${id}`)
  return kind + id.toString(36)
}

export class Loot {
  constructor() {
    // place -> Set of bits taken, in the order each place was first looted.
    this.places = new Map()
    this.unsent = []
  }

  _add(t) {
    if (!valid(t)) throw new Error(`Loot: a malformed entry ${JSON.stringify(t)}`)
    let bits = this.places.get(t[0])
    if (!bits) {
      bits = new Set()
      this.places.set(t[0], bits)
      if (this.places.size > PLACES) this.places.delete(this.places.keys().next().value)
    }
    if (bits.has(t[1])) return false
    bits.add(t[1])
    return true
  }

  /** Thing `bit` of `place` is hers now; false if someone took it already. */
  take(place, bit) {
    const t = [place, bit]
    if (!this._add(t)) return false
    this.unsent.push(t)
    return true
  }

  taken(place, bit) {
    const bits = this.places.get(place)
    return bits !== undefined && bits.has(bit)
  }

  /** Entries the room told, anyone's. */
  merge(list) {
    for (const t of list) this._add(t)
  }

  resend() {
    this.unsent = this.entries()
  }

  entries() {
    const out = []
    for (const [p, bits] of this.places) for (const b of bits) out.push([p, b])
    return out
  }

  flush(send) {
    while (this.unsent.length > 0) {
      const batch = this.unsent.slice(0, BATCH)
      if (!send(batch)) return
      this.unsent.splice(0, batch.length)
    }
  }

  save() {
    return this.entries()
  }

  load(list) {
    if (!Array.isArray(list)) throw new Error(`Loot: a malformed save ${JSON.stringify(list)}`)
    this.merge(list)
    this.resend()
  }
}
