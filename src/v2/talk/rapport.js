// How each person stands with the players and what they have come to believe (_notes/conversation-and-quests.md): warmth, debt and suspicion, the claims they have made (so they repeat them), and beliefs the players planted. Kept per person id; the room's share of it is to ride the relay as trust.js's entries do.

export const RAPPORT = {
  // A leafkin that trusts the players (trust.js) starts this warm.
  fed: 0.5,
  // A caught lie: suspicion up, warmth down.
  caught: { suspicion: 0.4, warmth: -0.2 },
  // A favour done.
  favour: 0.3,
}

export class Rapport {
  constructor() {
    this.of = new Map()
  }

  get(id) {
    let r = this.of.get(id)
    if (r === undefined) {
      r = { warmth: 0, debt: 0, suspicion: 0, said: new Map(), beliefs: new Map(), sentBy: null }
      this.of.set(id, r)
    }
    return r
  }

  /** What `id` will risk for her: warmth and debt, less suspicion. */
  standing(id) {
    const r = this.get(id)
    return r.warmth + r.debt - r.suspicion
  }

  warm(id, by) {
    const r = this.get(id)
    r.warmth = Math.max(-1, Math.min(1, r.warmth + by))
  }

  owe(id, by) {
    this.get(id).debt += by
  }

  catchLie(id) {
    const r = this.get(id)
    r.suspicion += RAPPORT.caught.suspicion
    this.warm(id, RAPPORT.caught.warmth)
  }
}
