// Which villager trusts which player (design/30-leafkin.md, Trust): `[village,
// villager, player]` entries, the village its seed in base 36, the player the
// id her saved game carries. Kept in the save, told to the room, and taught to
// every client in it, so a villager fed by anyone remembers them on every
// client. The sim never reads it: her client alone decides whom to greet.

export const PLAYER_LEN = 12
// server/src/main.js TRUST_BATCH.
export const BATCH = 64

const village36 = (seed) => {
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`Trust: a village is its uint32 seed, got ${seed}`)
  return seed.toString(36)
}

export function newPlayer() {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(PLAYER_LEN)), (b) => (b % 36).toString(36)).join('')
}

function valid(t) {
  return Array.isArray(t) && t.length === 3 && /^[0-9a-z]{1,8}$/.test(t[0]) && Number.isInteger(t[1]) && t[1] >= 0 && t[1] < 256 && typeof t[2] === 'string' && /^[0-9a-z]{6,16}$/.test(t[2])
}

export class Trust {
  constructor(player = newPlayer()) {
    this.player = player
    this.known = new Map()
    // Entries of hers the room has yet to hear.
    this.unsent = []
  }

  _add(t) {
    if (!valid(t)) throw new Error(`Trust: a malformed entry ${JSON.stringify(t)}`)
    const key = t.join(' ')
    if (this.known.has(key)) return false
    this.known.set(key, t)
    return true
  }

  /** Villager `id` of the village seeded `seed` trusts her from now; false if it did already. */
  grant(seed, id) {
    const t = [village36(seed), id, this.player]
    if (!this._add(t)) return false
    this.unsent.push(t)
    return true
  }

  trusts(seed, id, player = this.player) {
    return this.known.has(`${village36(seed)} ${id} ${player}`)
  }

  /** How many of the village's `count` villagers trust her. */
  count(seed, count) {
    let n = 0
    for (let id = 0; id < count; id++) if (this.trusts(seed, id)) n++
    return n
  }

  /** Entries the room told, anyone's. */
  merge(list) {
    for (const t of list) this._add(t)
  }

  /** Everything she knows owed to the room again: a relay just welcomed her, and may have forgotten. */
  resend() {
    this.unsent = [...this.known.values()]
  }

  /** Her owed entries to `send` in BATCHes, until it refuses one. */
  flush(send) {
    while (this.unsent.length > 0) {
      const batch = this.unsent.slice(0, BATCH)
      if (!send(batch)) return
      this.unsent.splice(0, batch.length)
    }
  }

  save() {
    return { player: this.player, known: [...this.known.values()] }
  }

  /** A saved game's player, and its trust beside what the room has taught, all of it owed to the room. */
  load(doc) {
    if (!doc || typeof doc.player !== 'string' || !/^[0-9a-z]{6,16}$/.test(doc.player) || !Array.isArray(doc.known)) throw new Error(`Trust: a malformed save ${JSON.stringify(doc)}`)
    this.player = doc.player
    this.merge(doc.known)
    this.resend()
  }

  /** A new game: a new player nobody trusts yet. What the room taught of others is kept. */
  clear() {
    this.player = newPlayer()
    this.unsent.length = 0
  }
}
