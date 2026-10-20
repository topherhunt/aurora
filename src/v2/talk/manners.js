// Kind words (_notes/conversation-and-quests.md, "Manners"): pleasantries that warm nearly everyone, some more than
// others. A move's warmth is its base times how much this person cares for that kind of consideration, never below
// MANNERS.floor, so nothing considerate backfires on a first saying; repetition, fawning and the per-day cap are what
// stop it being spammed. Three-free.

export const MANNERS = {
  // Warmth words alone can earn from one person in a quest epoch (quests.js epochS, about an in-world day).
  cap: 0.2,
  // A move's reception multiplier is clamped to this range.
  floor: 0.5,
  ceil: 1.6,
  // Gain on a move's 1st, 2nd and later saying to one person in one epoch.
  repeat: [1, 0.4, 0],
  // Praise and small talk in a row before it reads as buttering up, and what that costs.
  fawn: 3,
  sour: -0.04,
  // Already-warm people warm more easily: the multiplier gains this times standing.
  warm: 0.3,
  // A worried parent hears little but sympathy and help; late at night everyone is shorter.
  worried: 0.4,
  night: 0.7,
  // A gain at least this times the move's base lands visibly (a warm mood and a nod): they took it better than most.
  shows: 1,
  // Pushing past someone's patience until they send her off.
  overstay: -0.03,
}

// Each move: `base` warmth, `lean` trait -> weight (a trait at 0.5 adds nothing, at 1 adds the weight, at 0 takes it),
// `by` extra multiplier by body or class, `fawns` whether it counts toward buttering up, `calm` whether it ignores the
// hour, `worried` the multiplier a worried parent gives it (default MANNERS.worried).
export const MOVES = {
  greet: { base: 0.04, lean: { wariness: 0.5 }, by: { jarlsthane: 0.3, guard: 0.15 } },
  thanks: { base: 0.04, lean: { kindness: 0.4, boast: 0.3 } },
  work: { base: 0.06, lean: { chattiness: 0.5, boast: 0.4 }, fawns: true },
  life: { base: 0.05, lean: { chattiness: 0.5, kindness: 0.2 }, fawns: true },
  town: { base: 0.05, lean: { boast: 0.3 }, by: { jarlsthane: 0.4, innkeeper: 0.3, guard: 0.2, travel: -0.4 }, fawns: true },
  craft: { base: 0.07, lean: { boast: 0.6, greed: 0.2 }, fawns: true },
  sorry: { base: 0.08, lean: { kindness: 0.5 }, calm: true, worried: 1.5 },
  help: { base: 0.05, lean: { kindness: 0.3, greed: 0.3 }, calm: true, worried: 1 },
  leave: { base: 0.05, lean: { chattiness: -0.6 }, calm: true, worried: 1 },
}

/** How much `mind` cares for move `move`, `worried` and `night` their mood, `standing` hers with them: a multiplier. */
export function reception(mind, move, { worried, night, standing }) {
  const m = MOVES[move]
  if (m === undefined) throw new Error(`manners: no move ${move}`)
  let k = 1
  for (const [trait, w] of Object.entries(m.lean)) k += w * (2 * mind.traits[trait] - 1)
  k += (m.by?.[mind.body] ?? 0) + (m.by?.[mind.cls] ?? 0)
  k *= 1 + MANNERS.warm * Math.max(0, standing)
  k = Math.min(MANNERS.ceil, Math.max(MANNERS.floor, k))
  if (worried) k *= m.worried ?? MANNERS.worried
  if (!m.calm && night) k *= MANNERS.night
  return k
}

/** Late enough that a pleasantry lands softer. */
export const isNight = (hour) => hour >= 22 || hour < 6
