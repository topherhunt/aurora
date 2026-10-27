// Each townsperson's quirk (_notes/conversation-and-quests.md, "A person is a role plus an overlay"): bitter, timid, adoring, or one need they cannot stop bringing up. It colours their talk without claiming anything about the world: an aside after an answer, a word added to a greeting or a goodbye, a line about themself, and a need's own answer to "Do you need anything?". No line may name a lore topic (check-talk). Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'

export const QUIRKS = {
  // Odds a quirk shows on an answer (a mood's on any, a need's on small talk), a greeting and a goodbye.
  odds: { aside: 0.2, need: 0.6, greet: 0.5, bye: 0.5 },
}

const MOODS = {
  bitter: {
    aside: ['Not that anyone ever thanks me for knowing.', 'Write it down. Nobody listens to me anyway.', 'There. Now go and bother someone else with it.', 'Free advice. Worth every coin you paid for it.', 'I knew that before any of them, and who got the credit? Not me.', 'Mark my words, it will all go wrong. It always does.', "You'll forget I told you. They always do."],
    greet: ['Another one wanting something, I suppose.', "If you're selling hope, I'm not buying.", 'Make it quick. The day is bad enough already.'],
    bye: ["Don't hurry back.", 'Go on, then. Everyone does.', 'Mind the door. It hates me too.'],
    self: 'Nobody here appreciates a thing I do, and I have long since stopped expecting them to.',
  },
  timid: {
    aside: ["Please don't tell anyone I said so.", 'Um. I think. I might be wrong. Sorry.', "Sorry, was that too much? I talk when I'm nervous.", 'Is someone behind you? No? Good. Sorry.', "I'm not used to being asked things. It's nice. Terrifying, but nice.", "You won't shout, will you? People shout.", "Sorry. I'll stop now."],
    greet: ['Oh! You startled me.', "S-sorry, I didn't see you there.", "Please don't loom. Thank you."],
    bye: ['Oh. Bye. Sorry. Bye.', 'Mind how you go. Really mind it. Things lurk.', "Was I all right? Don't answer that."],
    self: 'I keep to myself, mostly. Loud noises, crowds, birds. Birds are the worst.',
  },
  adoring: {
    aside: ['You ask such clever questions!', 'Oh, I could listen to you ask things all day.', 'Has anyone told you that you have a lovely way of standing?', "You're going to be famous. I can feel it.", "I'm telling everyone I talked to you.", 'Wait till I tell my mother you asked me that.', "Whatever you do next, I just know it'll be wonderful."],
    greet: ["It's you! It's really you!", "I was hoping you'd come by. I'm not just saying that.", 'You look marvellous today. Every day, really.'],
    bye: ['Come back soon! Or now! Now is good too.', "I'll wave until you're out of sight.", 'Bye! You were wonderful!'],
    self: "But never mind me. You're far more interesting.",
  },
}

// A need's asides come in order, one more each time it surfaces with her, so the story builds; the first introduces it,
// and each must follow small talk about the town or their life (speak.js SMALL_TALK). `child` needs are for children only.
const NEEDS = {
  gnome: {
    self: 'I used to have a wife, you know. She forbade me from having garden gnomes. I am still without a gnome.',
    greet: "You're not carrying a gnome, by any chance?",
    want: "A gnome. I need a gnome. I'm not joking.",
    aside: ["Not one garden gnome in the whole place, mind. I've looked.", "You haven't seen a gnome on your travels, have you? Little stone fellow, red hat.", "I used to have a wife. She forbade garden gnomes. I'll let you guess which of them I miss.", "I've cleared a spot by the door for him. The gnome. For when he comes."],
    bye: 'If you find a gnome, you know where I live.',
  },
  goat: {
    self: 'Three winters ago my goat Bertil wandered off. He has one horn and no conscience.',
    greet: "You haven't seen a one-horned goat, have you?",
    want: 'Bertil. My goat. Bring him home, and bring him to justice.',
    aside: ['A goat of mine lived here once. Bertil. One horn, no conscience. He owes me an apology.', 'Bertil would have liked it here. Clever goat. Cruel, but clever.', 'Sorry, I thought I heard bleating.', 'Some nights I leave the gate open. Not for him. For me.'],
    bye: "Say hello to Bertil if you see him. Don't lend him anything.",
  },
  saga: {
    self: "I'm writing a saga. Ninety verses so far, all about me, and every one of them true, more or less.",
    greet: 'Ah! A face for the saga.',
    want: 'Something to rhyme with "magnificent". The saga is stuck on it.',
    aside: ["It'll all go in my saga, of course. Verse ninety-one. The saga is about me.", 'Does anything rhyme with "magnificent"? Asking for the saga.', 'Hold still. I want to remember your face for a minor verse.', "You're in the saga now, by the way. Small part. Don't let it go to your head."],
    bye: 'Look for yourself in verse ninety-four. Third line.',
  },
  uncle: {
    self: 'Any day now my uncle will send for me. He is very rich, in a far town. Probably very rich. Probably a town.',
    greet: 'Are you a rider from my uncle? No? Pity.',
    want: 'A letter from my uncle. Has one come? It will come.',
    aside: ['Not that it matters. When my rich uncle sends for me, I am leaving all this behind.', 'My uncle would like it here. When he writes. He will write.', 'Has a letter come for me? No? Tomorrow, then.', 'I have my bag packed by the door. Have done for nine years.'],
    bye: 'If a rider comes asking for me, tell him I am ready.',
  },
  soup: {
    self: 'My grandmother made a soup that could end a feud. She took the last ingredient to her grave, and I have been guessing ever since.',
    greet: 'You smell of the road. Anything interesting in your pack? For soup.',
    want: 'The last ingredient. I will know it when I taste it.',
    aside: ["Good place for soup, too. I'm one ingredient short of the perfect soup, mind.", "Still hunting the last ingredient. It isn't salt. I've tried salt.", 'If you find something that smells like a summer evening, bring it to me. For the soup.', 'I tried bark last week. It was not bark.'],
    bye: 'Bring me anything strange you find. The soup is waiting.',
  },
  cockerel: {
    self: "I haven't slept a whole night since the cockerel moved in next door. We are at war, he and I.",
    greet: 'Sorry if I look rough. The cockerel.',
    want: 'A quiet night. Or a cockerel-sized sack.',
    aside: ['Lovely and quiet, apart from the cockerel next door. We are at war, he and I.', "Sorry. Haven't slept. The cockerel.", "Did you hear that? No? That's him. He's inside my head now.", 'He looked at me this morning. Right at me. He knows.'],
    bye: "If you hear crowing, don't tell me.",
  },
  goose: {
    self: 'I was a hero once. There was a bridge and a goose, and I won. Ask anyone. Actually, don\'t ask anyone.',
    greet: "Mind the geese out there. I'd know.",
    want: 'For someone to remember the Battle of the Bridge. Properly, this time.',
    aside: ['Not much happens here. Not since the Battle of the Bridge. Me against a goose. I won. Mostly.', "When you've stared down a goose, nothing frightens you. Except geese.", 'They never made a song about it. I would have liked a song.', "I still have the scar. I won't show you. It's in a place."],
    bye: 'Mind the bridges out there. You know why.',
  },
  pony: {
    child: true,
    self: "I'm getting a pony one day. I've named her already. Her name is Pony.",
    greet: 'Did you come on a pony?',
    want: 'A pony. Her name is Pony.',
    aside: ['Do you have a pony? You look like you might have a pony.', "When I get my pony I'll ride her everywhere and never walk again.", "Pony would like you. That's the pony I'm getting.", "I practise on the fence. The fence doesn't mind."],
    bye: "If you see a spare pony, she's mine.",
  },
  frog: {
    child: true,
    self: "I've got a frog in my pocket. His name is Sir. Don't tell.",
    greet: 'Shh. Sir is sleeping. In my pocket.',
    want: 'A bigger pocket. Sir is growing.',
    aside: ["Sir likes it here. Sir is my frog. He's in my pocket. Don't tell.", 'Sir thinks so too. He blinked twice.', "Can you keep a secret? It's about Sir. Never mind, he says no.", 'Sir is hungry. Sir is always hungry.'],
    bye: 'Sir says goodbye. He says it with his eyes.',
  },
}

const SALT = 7106
const KINDS = ['bitter', 'timid', 'adoring', 'need']

/** Mind `mind`'s quirk, the same on every client: `{ kind, need }`, `need` a NEEDS key when `kind` is 'need'. Unkind folk lean bitter, wary ones timid, kind ones adoring. */
export function quirkOf(seed, mind) {
  const rand = mulberry32(hash32(seed, SALT, mind.town, mind.index))
  const T = mind.traits
  const weight = { bitter: 1 - T.kindness, timid: T.wariness, adoring: T.kindness, need: 1.2 }
  const total = KINDS.reduce((s, k) => s + weight[k], 0)
  let r = rand() * total, kind = KINDS[KINDS.length - 1]
  for (const k of KINDS) if ((r -= weight[k]) < 0) { kind = k; break }
  if (kind !== 'need') return { kind, need: null }
  const child = mind.cls === 'child'
  const needs = Object.keys(NEEDS).filter((k) => (NEEDS[k].child === true) === child)
  return { kind, need: needs[(rand() * needs.length) | 0] }
}

/** The lines quirk `q` speaks with: `{ aside, greet, bye, self, want }`, `want` null but for a need, whose `aside` runs in story order. */
export function quirkLines(q) {
  if (q.kind !== 'need') return { ...MOODS[q.kind], want: null }
  const n = NEEDS[q.need]
  if (n === undefined) throw new Error(`quirks: no need ${q.need}`)
  return { aside: n.aside, greet: [n.greet], bye: [n.bye], self: n.self, want: n.want }
}

/** Every line a quirk may say, for checks. */
export const allQuirkLines = () => [...Object.values(MOODS), ...Object.values(NEEDS)].flatMap((x) => [x.self, x.want ?? '', ...(x.aside ?? []), ...[x.greet ?? []].flat(), ...(Array.isArray(x.bye) ? x.bye : [x.bye])].filter((l) => l !== ''))
