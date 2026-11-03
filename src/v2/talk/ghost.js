// What a castle ghost says to her as she comes near (quests.js ghostMessage; design/45-bone-friends.md §Castle ghost). Three-free.

import { townWay } from './castle-ways.js'

/** The ghost's line for its message quest `q` as it stands in `log`, `{ text, mood }`, or null once it is at rest. Hearing the ask accepts it; hearing the thanks or the regret ends it. */
export function ghostSays(q, log, world) {
  if (q.ghost === null) throw new Error(`ghostSays: ${q.id} is no ghost's`)
  const to = world.person(q.to)
  const town = world.townOf(to)
  const them = to.voice.he ? 'him' : 'her'
  const state = log.state(q.id)
  const keep = world.hideouts[q.town]
  if (keep === null || keep.kind !== 'castle') throw new Error(`ghostSays: ${q.id}'s town ${q.town} has no castle hideout`)
  // The whole errand, told the same each time: who, where, and the words.
  const errand = `${to.name} in ${town.name} is ${q.bond}, ${townWay(keep, town.town)} of this castle. Tell ${them}: "${q.words[0]}"`
  if (state === null) {
    log.accept(q)
    return { text: `Oh! You can see me? I am ${q.ghost.name}. ${errand} Those words exactly, little one.`, mood: null }
  }
  if (state === 'accepted') return { text: `Have you told ${to.name} yet? ${errand} I have waited down here so long.`, mood: null }
  if (state === 'delivered') {
    log.set(q.id, 'done')
    return { text: `${to.name} heard me at last... Thank you, little one. Now I can rest.`, mood: 'warm' }
  }
  if (state === 'garbled') {
    log.set(q.id, 'done')
    return { text: 'The words came out wrong? Ah well. I think the trying was what mattered. Thank you for going.', mood: 'cold' }
  }
  return null
}
