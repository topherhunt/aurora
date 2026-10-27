// Spare fragments a human answer is dressed in (speak.js `_dress`): a punctuated lead-in, a generic aside and a closing,
// each rolled apart per tone, so one question seldom comes back in the same words. None of them claims anything about the
// world. Leafkin dress with the LK lead/detail/tail pools (leafkin.js). Three-free.

export const WORDS = {
  lead: {
    cheery: ['Ah, good question. ', 'Oh, happily. ', 'Let me think. ', 'Well now. ', 'Funny you should ask. ', 'Right, so. ', 'Hm, yes. ', 'Glad you asked. '],
    plain: ['Well. ', 'Hm. ', 'Let me think. ', 'Right. ', 'Now then. ', 'Ah. ', 'Let me see. ', 'Hm, that. '],
    curt: ['Hm. ', 'Look. ', 'Right. ', 'Well. ', 'Aye. '],
  },
  detail: {
    cheery: ['Everyone round here would tell you the same.', 'That is how I have always heard it.', 'You can take my word on it.', 'It has been so as long as I can remember.', 'There is not much more to it than that.', 'I would not tell you wrong.'],
    plain: ['That is what I know.', 'Make of it what you will.', 'That is the long and short of it.', 'It is as I heard it.', 'I have nothing to add.', 'There it is.'],
    curt: ['That is all.', 'No more.', 'Mm.', 'There.'],
  },
  closing: {
    cheery: ['Anything else?', 'Ask away, if there is more.', 'Is there more you would like to know?', 'Happy to say more.', 'What else is on your mind?'],
    plain: ['Anything else?', 'Was there more?', 'Does that settle it?', 'What else?'],
    curt: ['Well?', 'Anything else?', 'Next.'],
  },
  // Odds each fragment is used, by tone.
  odds: {
    cheery: { lead: 0.65, detail: 0.35, closing: 0.35 },
    plain: { lead: 0.6, detail: 0.3, closing: 0.3 },
    curt: { lead: 0.4, detail: 0.15, closing: 0.15 },
  },
}

const at = (r, list) => list[Math.min(list.length - 1, (r * list.length) | 0)]

/** `text` dressed for `tone` from rolls `r` (6 numbers in 0..1: use and pick for lead, detail, closing); `lead` false when the line already opens with a prefix of its own. */
export function dress(text, tone, r, lead) {
  const o = WORDS.odds[tone]
  const head = lead && r[0] < o.lead ? at(r[1], WORDS.lead[tone]) : ''
  const detail = r[2] < o.detail ? ` ${at(r[3], WORDS.detail[tone])}` : ''
  const closing = r[4] < o.closing ? ` ${at(r[5], WORDS.closing[tone])}` : ''
  return head + text + detail + closing
}
