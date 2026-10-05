// What there is to talk about (_notes/conversation-and-quests.md): the towns, their buildings and their people as named things with places, built from layers/towns.js `planTowns` and the seed. Every answer an NPC gives is a claim about one of these, so it can be checked by walking there. Three-free.

import { castMinds, townName } from './mind.js'

// North is -z (sim/horizon.js), east +x.
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
// [metres under which, words]. Walkers go about 1 m/s.
const BANDS = [[6, 'right here'], [25, "a stone's throw"], [90, 'a short walk'], [400, 'a fair walk'], [1500, 'a long walk'], [Infinity, 'a long road']]

export const TRADE_PLACE = { smith: 'the smithy', potions: 'the potion shop', inn: 'the inn', farm: 'the farm' }
// What players ask for by title, and the body that holds it.
export const TITLES = { elder: 'jarlsthane', smith: 'blacksmith', potionmaster: 'alchemist', innkeeper: 'innkeeper', healer: 'healer' }

export function compass(dx, dz) {
  const a = Math.atan2(dx, -dz)
  return COMPASS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]
}

export function band(d) {
  return BANDS.find(([m]) => d < m)[1]
}

export class TalkWorld {
  /** `towns` as planTowns returns them, in order. */
  constructor(seed, towns) {
    this.seed = seed
    this.towns = towns.map((town, index) => ({ town, index, name: townName(seed, index), minds: castMinds(seed, town, index) }))
    this.people = new Map()
    for (const t of this.towns) for (const m of t.minds) this.people.set(m.id, m)
  }

  person(id) {
    const m = this.people.get(id)
    if (m === undefined) throw new Error(`TalkWorld: no person ${id}`)
    return m
  }

  townOf(mind) {
    return this.towns[mind.town]
  }

  /** The town whose ground (x, z) is on, or null out in the wild. */
  townAt(x, z) {
    return this.towns.find(({ town }) => Math.hypot(x - town.x, z - town.z) <= town.radius) ?? null
  }

  /** The nearest town to (x, z) other than `except` (an index or null). */
  nearestTown(x, z, except = null) {
    let best = null
    for (const t of this.towns) {
      if (t.index === except) continue
      const d = Math.hypot(x - t.town.x, z - t.town.z)
      if (best === null || d < best.d) best = { t, d }
    }
    if (best === null) throw new Error('TalkWorld: no towns')
    return best.t
  }

  /** What building `bi` of town entry `t` is called: its trade's place, else its keeper's house. */
  buildingLabel(t, bi) {
    const b = t.town.buildings[bi]
    if (b.trade !== undefined && TRADE_PLACE[b.trade]) return TRADE_PLACE[b.trade]
    const owner = t.minds.find((m) => m.home === bi && m.cls !== 'child')
    return owner ? `${owner.name}'s house` : `the empty ${b.kind}`
  }

  /** Where `mind` is found most days: `{ x, z, label, building }`, at their work when it has a place of its own, else at home. */
  placeOf(mind) {
    const t = this.townOf(mind)
    if (mind.trade === 'smith' && mind.work !== null) {
      const w = t.town.works[mind.work]
      return { x: w.x, z: w.z, label: 'the smithy', building: null }
    }
    return this.buildingPlace(t, mind.home)
  }

  buildingPlace(t, bi) {
    const b = t.town.buildings[bi]
    return { x: b.x, z: b.z, label: this.buildingLabel(t, bi), building: bi }
  }

  /** The person of town entry `t` holding title `title` (TITLES), or null. */
  titled(t, title) {
    const body = TITLES[title]
    if (body === undefined) throw new Error(`TalkWorld: no title ${title}`)
    return t.minds.find((m) => m.body === body) ?? null
  }

  /** How to get from `from` to `to` ({x, z}) in words: `{ dir, far, d, near }`, `near` the label of a named place within 12 m of `to` in town entry `t` (other than `to` itself), for "by the inn". */
  way(from, to, t = null) {
    const dx = to.x - from.x
    const dz = to.z - from.z
    const d = Math.hypot(dx, dz)
    let near = null
    if (t !== null) {
      if (Math.hypot(to.x - t.town.x, to.z - t.town.z) < 12) near = 'the fire'
      else {
        let best = 12
        t.town.buildings.forEach((b, bi) => {
          const e = Math.hypot(b.x - to.x, b.z - to.z)
          if (e > 0.5 && e < best && b.trade !== undefined && TRADE_PLACE[b.trade]) { best = e; near = TRADE_PLACE[b.trade] }
        })
      }
    }
    return { dir: compass(dx, dz), far: band(d), d, near }
  }
}
