// The lead-in a human answer may open with (speak.js `_dress`), rolled per tone, so one question seldom comes back in the
// same words. Each must read naturally before any answer -- a direction, a name, a rumour -- and claims nothing. Leafkin
// dress with the LK lead/detail/tail pools (leafkin.js). Three-free.

export const WORDS = {
  lead: {
    cheery: ['Ah. ', 'Well now. ', 'Right, so. ', 'Let me think. ', 'Oh, now. '],
    plain: ['Well. ', 'Hm. ', 'Right. ', 'Now then. ', 'Let me see. '],
    curt: ['Hm. ', 'Look. ', 'Well. '],
  },
  // Odds the lead-in is used, by tone.
  odds: { cheery: 0.5, plain: 0.45, curt: 0.3 },
}

const at = (r, list) => list[Math.min(list.length - 1, (r * list.length) | 0)]

/** `text` dressed for `tone` from rolls `r` (2 numbers in 0..1: use and pick); `lead` false when the line already opens with a prefix of its own. */
export function dress(text, tone, r, lead) {
  return (lead && r[0] < WORDS.odds[tone] ? at(r[1], WORDS.lead[tone]) : '') + text
}
