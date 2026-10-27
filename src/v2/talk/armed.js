// What people say to a stranger who walks through town with a sword in her hand (_notes/2026-10-27-feature-batch.md, "Sword in town"): a passer-by's jeer, a guard's warning, and the refusal that opens every talk she starts while armed. Each line is a roll `r` (0..1) into pools chosen by the speaker's temperament and trade. Three-free.

const pick = (r, list) => list[Math.min(list.length - 1, (r * list.length) | 0)]
const sub = (r, i) => (r * 7919 * (i + 1)) % 1

/** The temperament that colours `mind`'s manner: the trait furthest from the middle, as a pool key. */
function temper(mind) {
  const T = mind.traits
  const score = { kind: T.kindness - 0.5, meek: T.wariness - 0.5, proud: T.boast - 0.5, curt: 0.5 - T.chattiness }
  return Object.keys(score).reduce((best, k) => (score[k] > score[best] ? k : best), 'curt')
}

const JEER = {
  kind: ['Oh, put that thing away, dear. You will frighten someone.', 'A sword, in town? Whatever are you thinking?', 'Mind where you wave that, friend.'],
  meek: ['Is that a sword? Keep it away from me!', 'Oh no. A sword. Please keep walking.', 'Do not look at me with that thing in your hand.'],
  proud: ['A sword in the street. How very uncouth.', 'Look at her, playing at warrior. Uncouth.', 'Where were you raised, in a barn? Put that away.'],
  curt: ['Put that away.', 'Sword. In town. Honestly.', 'Uncouth.'],
}
const JEER_BY = {
  blacksmith: ['I made better than that, and I would not wave it about in a street.', 'Fine edge, poor manners.'],
  alchemist: ['Steel in the street. Tsk. Mind the potions.', 'Put that blade away before it cuts something expensive.'],
  innkeeper: ['No blades at my door, thank you.', 'Take that sword elsewhere. This is a respectable town.'],
  skald: ['A sword in town and no song to go with it. Uncouth.', 'Ah, a hero. In a street full of hens.'],
  thief: ['Bold, walking about with that. The watch notices.', 'Put it away, fool. You will bring the guards.'],
  healer: ['Is somebody hurt? No? Then put that blade away.', 'I mend what swords do. Please do not give me work.'],
  trapper: ['You hold it like a spade. Put it away.', 'Not much use against a bear, that.'],
  'child-villager-2': ['Ooh, a sword! Are you going to hurt someone?', 'That is a big sword. Mama says swords are rude.'],
}

const WARN = {
  kind: ['Stranger, a word. We do not carry blades about in this town. Put it away, please, before someone else asks less kindly.', 'Friend, that sword stays sheathed in town. Do keep it so.'],
  meek: ['You there. The sword. Put it away, now. I do not want trouble, and neither do you.', 'Stop. Put the sword away. Please. We do not want a scene.'],
  proud: ['You. Stranger. A sword in my town? Put it away, or I will see you out of it myself.', 'I keep this watch, and I say no blades in the street. Put it away. Now.'],
  curt: ['Sword. Put it away.', 'No blades in town. Sheathe it or leave.'],
}

const UNCOUTH = {
  kind: ['Oh dear. A sword in your hand, in a town like this. How uncouth.', 'That is no way to come among people, with a sword out.'],
  meek: ['A sword! In my town! Have you no manners at all?', 'Oh, how rude, coming among us armed like that.'],
  proud: ['A sword out among decent folk. How uncouth you are.', 'Walking in with a drawn blade. I have not seen such bad manners in years.'],
  curt: ['Uncouth. A sword, in town.', 'Armed, and in town. Uncouth.'],
}
const SCOLD = {
  kind: ['Shame on you. Put it away and learn some manners.', 'You should know better than that.'],
  meek: ['Put it away this instant. You are making everyone nervous.', 'Take it away from here. Please. You are frightening folk.'],
  proud: ['Put it away, and learn how people behave.', 'I will not be spoken to by someone who carries steel like a child with a stick.'],
  curt: ['Put it away.', 'Sheathe it. Learn manners.'],
}
const SCOLD_BY = {
  blacksmith: ['I forge blades. I know what they are for, and it is not the market square.'],
  alchemist: ['Steel in a street where people carry potions. Have you any sense at all?'],
  innkeeper: ['My guests would flee. Put it away.'],
  skald: ['I have sung of fools with swords. It does not end well for them.'],
  thief: ['Even I know to keep steel out of sight in town.'],
  healer: ['I have mended too many who thought as you do.'],
  trapper: ['A blade belongs in the hills, not among folk.'],
}
const LEAVE = {
  kind: ['I am sorry, I will not talk with you like this. Good day.', 'Come back when it is put away. Not before.'],
  meek: ['I cannot speak with you. Go away, please.', 'No. No talking. Please go.'],
  proud: ['I have nothing to say to you. Good day.', 'We are done. Go.'],
  curt: ['No talking. Go.', 'Not a word more.'],
}
const GUARD = {
  uncouth: ['Drawn steel in my town. That is uncouth, and I will not have it.', 'Armed, in a town under my watch? How uncouth.'],
  scold: ['I will not warn you twice. Put it away.', 'I could have you out of the gates for this.'],
  leave: ['I will not talk with an armed stranger. Move along.', 'Not a word from me until it is sheathed. Move.'],
}
const CHILD = {
  uncouth: ['That sword is rude!', 'Mama says only bad people carry swords in town.'],
  scold: ['You should put it away!', 'I am telling the guards on you!'],
  leave: ['I am not talking to you.', 'Go away, sword lady.'],
}

/** A passer-by's remark at a stranger armed in town, `r` a roll 0..1: `{ text, moment }`. */
export function jeer(mind, r) {
  if (typeof r !== 'number') throw new Error('armed: jeer needs a roll r')
  if (mind.cls === 'guard') throw new Error(`armed: ${mind.id} is a guard, who warns (swordWarning)`)
  const own = JEER_BY[mind.body]
  const pool = own !== undefined && sub(r, 0) < 0.5 ? own : JEER[temper(mind)]
  return { text: pick(r, pool), moment: 'social.disagree' }
}

/** A guard's warning to a stranger armed in town, `r` a roll 0..1: `{ text, moment }`. */
export function swordWarning(mind, r) {
  if (typeof r !== 'number') throw new Error('armed: swordWarning needs a roll r')
  if (mind.cls !== 'guard') throw new Error(`armed: ${mind.id} is no guard and cannot give a sword warning`)
  return { text: pick(r, WARN[temper(mind)]), moment: 'refuse.wary' }
}

/** What `mind` says when she hails them or they hail her while she is armed in town: calls her uncouth, tells her off and ends it, `r` a roll 0..1: `{ text, moment }`. */
export function armedRefusal(mind, r) {
  if (typeof r !== 'number') throw new Error('armed: armedRefusal needs a roll r')
  const t = temper(mind)
  const set = mind.cls === 'guard' ? GUARD : mind.cls === 'child' ? CHILD : null
  const uncouth = set === null ? UNCOUTH[t] : set.uncouth
  const own = SCOLD_BY[mind.body]
  const scold = set !== null ? set.scold : own !== undefined && sub(r, 1) < 0.5 ? own : SCOLD[t]
  const leave = set === null ? LEAVE[t] : set.leave
  return { text: `${pick(sub(r, 2), uncouth)} ${pick(sub(r, 3), scold)} ${pick(sub(r, 4), leave)}`, moment: 'refuse.wary' }
}
