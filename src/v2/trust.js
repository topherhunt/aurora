// Which villagers trust the players (design/30-leafkin.md, Trust): `[village,
// villager, player]` entries, the village its seed in base 36, the player who
// fed it the id their saved game carries. Kept in the save, told to the room,
// and taught to every client in it; a villager fed by anyone trusts every
// player. The sim never reads it: each client alone decides whom to greet.

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
    // `village villager` of every entry, whoever fed it.
    this.friends = new Set()
    // Entries of hers the room has yet to hear.
    this.unsent = []
  }

  _add(t) {
    if (!valid(t)) throw new Error(`Trust: a malformed entry ${JSON.stringify(t)}`)
    const key = t.join(' ')
    if (this.known.has(key)) return false
    this.known.set(key, t)
    this.friends.add(`${t[0]} ${t[1]}`)
    return true
  }

  /** Villager `id` of the village seeded `seed` trusts her from now; false if it did already. */
  grant(seed, id) {
    const t = [village36(seed), id, this.player]
    if (!this._add(t)) return false
    this.unsent.push(t)
    return true
  }

  /** Whether villager `id` of the village seeded `seed` trusts the players: anyone has fed it. */
  trusts(seed, id) {
    return this.friends.has(`${village36(seed)} ${id}`)
  }

  /** How many of the village's `count` villagers trust the players. */
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

  /** A new game: a new player, her old self's trust forgotten. What the room taught of others is kept. */
  clear() {
    for (const [key, t] of this.known) if (t[2] === this.player) this.known.delete(key)
    this.friends.clear()
    for (const t of this.known.values()) this.friends.add(`${t[0]} ${t[1]}`)
    this.player = newPlayer()
    this.unsent.length = 0
  }
}
