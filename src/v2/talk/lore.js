// What people say about the world (_notes/conversation-and-quests.md, "Lore"): hints, misinformation and tall tales,
// each fact told through the answer pipeline (speak.js `_answer`) so who knows it, who lies and who boasts is the
// speaker's temperament. A gated topic has no button until someone mentions it to her (`unlocks`); what she has heard
// of is kept in her save. Truths are true of the game as built; facts about the trade that is not built yet are
// marked `rumour` and stay vague. Three-free.

export const TOPICS = {
  striders: { label: 'striders', gated: false },
  dragons: { label: 'dragons', gated: false },
  alchemist: { label: 'the alchemist', gated: false },
  blacksmith: { label: 'the blacksmith', gated: false },
  coins: { label: 'coins', gated: false },
  snowlands: { label: 'the snowlands', gated: false },
  yetis: { label: 'yetis', gated: true, contested: true },
  leafkin: { label: 'leafkin', gated: true },
  caves: { label: 'caves', gated: true },
  labyrinths: { label: 'labyrinths', gated: true },
  gems: { label: 'gems', gated: true },
  mushrooms: { label: 'mushrooms', gated: true },
  eating: { label: 'eating wild things', gated: true },
  ores: { label: 'flint and ores', gated: true },
}

/** The topics she may ask about before anyone has mentioned any. */
export const OPEN_TOPICS = Object.keys(TOPICS).filter((k) => !TOPICS[k].gated)

// How likely a class is to know a fact at all, and what a body knows better (added).
const KNOW = { folk: 0.55, travel: 0.75, guard: 0.5, child: 0.35, leafkin: 0.6 }
const EXPERT = {
  alchemist: { mushrooms: 0.45, eating: 0.3, alchemist: 0.45, ores: 0.2 },
  herbalist: { mushrooms: 0.4, eating: 0.4, leafkin: 0.2 },
  healer: { mushrooms: 0.3, eating: 0.35 },
  blacksmith: { ores: 0.45, blacksmith: 0.45, coins: 0.2 },
  miner: { ores: 0.4, caves: 0.4, gems: 0.3 },
  hunter: { striders: 0.35, dragons: 0.25, snowlands: 0.2, yetis: 0.2 },
  trapper: { snowlands: 0.35, labyrinths: 0.3, striders: 0.2, yetis: 0.3 },
  shepherd: { striders: 0.3 },
  farmer: { striders: 0.25, eating: 0.2 },
  thief: { gems: 0.35, coins: 0.35, labyrinths: 0.25 },
  skald: { dragons: 0.3, snowlands: 0.2, labyrinths: 0.2, yetis: 0.25 },
  innkeeper: { coins: 0.3 },
  jarlsthane: { dragons: 0.2, coins: 0.2 },
}

// A `common` fact is everyday knowledge: anyone but a child knows it at these odds, whatever their class.
const COMMON = { adult: 0.92, child: 0.7 }

/** How likely `mind` is to know fact `fact` of `topic`, 0..1. A leafkin knows only facts with a leafkin telling. */
export function knowOdds(mind, topic, fact) {
  const odds = Math.min(1, (KNOW[mind.cls] ?? 0.5) + (EXPERT[mind.body]?.[topic] ?? 0))
  return fact.common && mind.kind === 'human' ? Math.max(odds, mind.cls === 'child' ? COMMON.child : COMMON.adult) : odds
}

// A contested fact (`doubt`) is believed at these odds by class, plus expertise: the worldly and the young believe.
const BELIEVE = { travel: 0.55, folk: 0.25, guard: 0.15, child: 0.7 }

/** How likely `mind` is to believe a contested fact of `topic` they have heard. */
export function beliefOdds(mind, topic) {
  return Math.min(1, (BELIEVE[mind.cls] ?? 0.3) + expertise(mind.body, topic))
}

/** How likely `mind` is to have seen a contested fact of `topic` for themself: travellers, and those whose work takes them there. */
export function sawOdds(mind, topic) {
  return Math.min(1, (mind.cls === 'travel' ? 0.3 : 0) + expertise(mind.body, topic))
}

/** How much better than most body `body` knows `topic`: 0 for no better. */
export function expertise(body, topic) {
  return EXPERT[body]?.[topic] ?? 0
}

/** The body that knows `topic` best anywhere, or null. */
export function expertBody(topic) {
  let best = null
  for (const body of Object.keys(EXPERT)) if (expertise(body, topic) > (best === null ? 0 : expertise(best, topic))) best = body
  return best
}

// A fact: `truth`, `lies` (misinformation, said by the dishonest), `tales` (told by boasters, or by anyone who does
// not know and will not admit it), `lk` the truth in leafkin pidgin, `unlocks` the other topics the telling names: each her follow-up after, and a gated one hers to ask anyone.
// `doubt` makes a fact contested: one who heard it but does not believe it (beliefOdds) honestly scoffs with a doubt line, and one who saw it (sawOdds) tells `seen` to someone they trust.
// Belief is held per subject, `of` (default the fact's topic; a TOPICS entry marked `contested` is one whole subject), so a speaker scoffs at yetis however they come up.
const f = (id, truth, { lies = [], tales = [], lk = null, unlocks = [], sens = 0, rumour = false, common = false, doubt = [], seen = null, of = null } = {}) => ({ id, truth, lies, tales, lk, unlocks, sens, rumour, common, doubt, seen, of })

export const LORE = {
  striders: [
    f('wild', 'Frost striders roam all over the wild country. Tall as a hayloft, all legs and beak.', { common: true, tales: ['There is a white strider in the hills, bigger than a house.'], lk: 'Long-legs walk everywhere. Big-big.' }),
    f('charge', 'Never walk straight up on a wild strider. Get too close and it will charge you.', { common: true, lies: ['Wild striders are gentle as lambs. Walk right up.'], lk: 'Long-legs angry close. Keesh! Run.' }),
    f('shy', 'Come at a strider from the side or behind and it shrieks and runs off.', { common: true, lies: ['Sneak up behind a strider and you can grab it.'] }),
    f('tame', 'Hold a fish out to a strider and it goes meek. Feed it and it trusts you after.', { common: true, lies: ['Striders eat carrots. Hold one out and it is yours.', 'Never feed a strider. It will follow you home and eat your roof.'], tales: ['I rode a strider clean across the lake once. It ran on the water.'], lk: 'Long-legs love fish. Give fish, long-legs friend.' }),
    f('ride', 'A strider that trusts you, take its rein from the front and it will follow. Climb on and it carries you.', { lies: ['Nobody can ride a strider. They throw you.'] }),
    f('town', 'Every town keeps striders tied at a rail. Feed one a fish and it will carry you.', { lies: ['Town striders bite strangers. Stay well back.'], tales: ['The jarl\'s strider can outrun the wind. I timed it.'] }),
    f('mad', 'Eat a chanterelle and every beast near you turns on you, striders worst of all.', { lies: ['Striders are scared of mushrooms. Hold one up and they flee.'], unlocks: ['mushrooms', 'eating'] }),
  ],
  dragons: [
    f('roost', 'Dragons roost on the high peaks. You can see their nests from the valley.', { common: true, lies: ['Dragons live under the lakes. Watch the water.'], tales: ['I fought a dragon once. With a stick.'], lk: 'Big-wing live up-up. Keesh! Leafkin hide.', unlocks: ['snowlands'] }),
    f('return', 'The old folk say the dragons are coming back. More of them every year.', { lies: ['There are no dragons. That is a story for children.'], tales: ['A dragon egg is worth more than this whole town.', 'Dragons are afraid of yetis. True as I stand here.'] }),
    f('pair', 'Dragons keep in pairs. One hunts while the other guards the nest.', { rumour: true, lies: ['Dragons only fly at midsummer.'], tales: ['A dragon once carried off a whole cow. And the farmer.'] }),
  ],
  alchemist: [
    f('brews', 'The potion master brews from mushrooms and stranger things. Ask before you eat anything wild.', { common: true, lies: ['The alchemist turns lead into gold. Mostly.'], tales: ['The alchemist once brewed a potion that made a man fly. Briefly.'], unlocks: ['mushrooms', 'eating'] }),
    f('wants', 'The alchemist always wants red mushrooms. Bring some and you will have a friend.', { lies: ['The alchemist hates mushrooms. Never bring one.'], unlocks: ['mushrooms'] }),
    f('firestone', 'Alchemists burn firestone in their brews. Rare stuff, and dear.', { rumour: true, lies: ['Firestone is just coal with airs.'], unlocks: ['ores'] }),
    f('flare', 'Do the alchemist a good turn and you may get a flare gun out of it.', { rumour: true, lies: ['The alchemist sells flare guns for a copper each.'], tales: ['I once shot a flare so high it became a star.'] }),
  ],
  blacksmith: [
    f('forge', 'The smith works iron at the forge, morning to night.', { common: true, lies: ['The smith only works by moonlight.'], unlocks: ['ores'] }),
    f('sword', 'Bring the smith good metal, or do a favour, and you might walk off with a sword.', { rumour: true, lies: ['The smith will forge you anything for a smile.'], tales: ['The smith made a blade that cuts stone. I saw it split a boulder.'], unlocks: ['ores'] }),
    f('flint', 'Strike flint near something dry and you will have a fire. The smith swears by it.', { lies: ['Flint only sparks if you spit on it first.'], unlocks: ['ores'] }),
  ],
  coins: [
    f('buy', 'Gold coins buy food, a bed at the inn, a smith\'s time.', { common: true, rumour: true, lies: ['Coins? We trade in carrots here.'], lk: 'Shiny-round? Leafkin no eat. Big-folk like.' }),
    f('traders', 'Traders buy valuables for gold, but they will never sell you the rare things.', { rumour: true, lies: ['Any trader will sell you a diamond, if you haggle.'], unlocks: ['gems'] }),
  ],
  snowlands: [
    f('cold', 'Climb high enough and it is all snow. Bitter cold up there, and nothing to eat.', { common: true, lies: ['It never snows on the peaks. That is just cloud.'], tales: ['They say yetis live up in the snow. And that they love flowers.'], lk: 'White-cold up-up. Brrm. Leafkin no go.', unlocks: ['eating'] }),
    f('yetis', 'Some say yetis roam the snowy wastes, and taunt anyone who comes near.', { rumour: true, lies: ['Nothing lives up in the snow. Not even yetis.'], doubt: ['Folk talk of yetis up there. Bears and bad eyesight, I say.'], of: 'yetis', unlocks: ['yetis'] }),
    f('dragons', 'Above the snow is where the dragons nest.', { lies: ['The dragons nest down by the lakes.'], tales: ['There is a giant\'s skeleton up in the snow, big as a hall.'], unlocks: ['dragons'] }),
  ],
  leafkin: [
    f('shy', 'Leafkin are shy little leaf-folk. Bring them mushrooms and they will warm to you.', { lies: ['Leafkin are vicious. They bite ankles.'], tales: ['Leafkin steal children and leave changelings in their beds.'], lk: 'Leafkin good! Give momo, leafkin tikka.', unlocks: ['mushrooms'] }),
    f('homes', 'Their villages are hidden in the hills, through little mouths in the rock.', { lies: ['Leafkin live at the bottom of the lake.'], tales: ['Inside a leafkin hill there is a whole other sky.'], lk: 'Leafkin home in hill. Secret. Shh.', sens: 0.3 }),
    f('friend', 'A leafkin that trusts you will run up to say hello. Then it will talk.', { lies: ['Leafkin cannot talk. They only squeak.'], lk: 'Tikka come, leafkin say hoola!' }),
  ],
  caves: [
    f('dark', 'Caves open at the feet of cliffs. Pitch dark inside, so carry a light.', { common: true, lies: ['Caves are lit inside, by glowing moss.'], tales: ['There is a cave with a sleeping giant in it. I heard it snore.'], lk: 'Dark-dark inside. Brrm. Leafkin no go deep.' }),
    f('lost', 'Caves are devilish. The passages fork and twist and double back. Easy to get lost down there.', { common: true, lies: ['Every cave goes straight through the mountain. You cannot get lost.'], tales: ['A man went into a cave after his goat. Came out forty years later, still looking.'], lk: 'Cave twisty-twisty. Leafkin lost, never come home.' }),
    f('chalk', 'There is chalk in the caves, a soft whitish stone. Pick some up and mark the walls as you go, or you may never find the way out.', { lies: ['Chalk marks wash off in the damp. Do not bother.'], lk: 'White-stone in cave. Draw-draw on wall, find way home.' }),
    f('falls', 'Deep down, the roof comes down when you least expect it. Listen for the rumble.', { lies: ['Cave roofs never fall. Mountains do not move.'] }),
    f('gems', 'Gems glitter in the deep caves, for those who dare.', { rumour: true, lies: ['There is nothing in caves but bats.'], unlocks: ['gems'] }),
  ],
  labyrinths: [
    f('stakes', 'Deep in the forest are mazes walled with sharpened stakes. Easy to get in, hard to get out.', { lies: ['The mazes in the woods move at night.'], lk: 'Stick-twisty in deep wood. Leafkin get lost. Hee.' }),
    f('wall', 'In a maze, keep one hand on the wall and you will come out in the end.', { lies: ['In a maze, always turn left. Always.'] }),
    f('heart', 'Somebody built mazes of stakes out in the wild. There is always something at the heart.', { rumour: true, tales: ['At the heart of a maze I found a chest of gold. Gave it all away.'], unlocks: ['gems'] }),
    f('giants', 'Green giants guard the mazes in the woods. Whatever lies at the heart, they keep it.', { rumour: true, lies: ['The giants in the mazes are friendly. They show you the way out.'], tales: ['I wrestled a green giant for its treasure once. We called it a draw.'], doubt: ['Green giants? A fireside tale for children.', 'Giants in the woods! Next you will tell me the trees talk.'], of: 'giants', seen: 'I saw one once, through the stakes. Green as moss and twice my height. I did not go in.', lk: 'Big-green in stick-twisty. Keesh! Leafkin no go.' }),
  ],
  yetis: [
    f('wastes', 'Yetis live out in the snowy wastes. Great white brutes, taller than a man.', { rumour: true, lies: ['Yetis live in the deep woods, under the roots.'], tales: ['They say yetis love flowers. Bring one a posy and it weeps.'], doubt: ['Yetis? A story to keep children out of the snow.', 'There are no yetis. Snow-blind trappers seeing bears.'], seen: 'I saw one myself, up in the snow. White as the drifts, and it watched me the whole way down.', lk: 'Big-white up in cold. Brrm! Leafkin hide.', unlocks: ['snowlands'] }),
    f('taunt', 'Get near a yeti and it taunts you. Hoots and drums and throws snow at you, then it comes.', { rumour: true, lies: ['Yetis are gentle. They will share their fire with you.'], doubt: ['Drums in the snow? That is the wind in the ice, nothing more.'], unlocks: ['snowlands'] }),
    f('kill', 'Never go close to a yeti. Most likely it will kill you.', { rumour: true, lies: ['A yeti is all noise. Shout back and it runs off.'], tales: ['I wrestled a yeti once. It cried for its mother.'], doubt: ['Nobody was ever killed by a yeti. The cold kills them, and the yeti gets the blame.'] }),
  ],
  gems: [
    f('diamond', 'Diamonds are the prize. A trader will give a hundred gold for one.', { rumour: true, lies: ['Jade is worth more than diamonds, everyone knows.'], tales: ['I held a diamond the size of an egg once.'] }),
    f('prices', 'A ruby fetches sixty gold, a piece of jade forty.', { rumour: true, lies: ['Gems are pretty rocks. Worthless.', 'A ruby is worth five gold, no more.'] }),
    f('find', 'You will never buy a gem. You find them, deep in caves or at the heart of a maze.', { rumour: true, lies: ['Gems grow on bushes in the snowlands.'], unlocks: ['caves', 'labyrinths'] }),
  ],
  mushrooms: [
    f('wary', 'Never eat a mushroom you do not know. Every one stings, and some do very odd things.', { common: true, lies: ['Mushrooms are good for you. Eat all you find.'], lk: 'Momo good for leafkin! Big-folk belly no like.', unlocks: ['eating', 'leafkin'] }),
    f('size', 'An ink cap shrinks you. A parasol grows you back, or past.', { lies: ['An ink cap makes you tall as a tree.', 'A parasol will put you to sleep for a day.'], lk: 'Ink-shroom make small-small. Umbrella-shroom make big.' }),
    f('agaric', 'Eat a fly agaric and for a while you see what is hidden, far off, burning green.', { lies: ['Fly agaric is perfectly safe. Eat all you like.'], tales: ['I ate a fly agaric and saw my own grandmother. She has been dead ten years.'], unlocks: ['eating'] }),
    f('porcini', 'A porcini toughens your hide. Blows land half as hard for a minute.', { lies: ['Porcini make you weak as a kitten.'] }),
    f('chanterelle', 'Never eat a chanterelle. Every beast near you will come for blood.', { lies: ['Chanterelle calms wild beasts. Hunters swear by it.'], lk: 'Gold-shroom brrm! Keesh! Beasts come bite.', unlocks: ['eating'] }),
  ],
  eating: [
    f('food', 'Carrots and fish fill your belly and mend you. Mushrooms only hurt you.', { common: true, lies: ['Raw fish will make you sick for days.'], lk: 'Carrot good. Fish good. Momo for leafkin.', unlocks: ['mushrooms'] }),
    f('how', 'Hold the food to your mouth a moment and you will eat it.', { lies: ['You have to cook a carrot or it will kill you.'] }),
  ],
  ores: [
    f('flint', 'Flint is common enough, two gold a stone. Strike it to make fire.', { common: true, lies: ['Flint is the rarest stone there is.'] }),
    f('iron', 'Iron is common too, five gold. Copper is dearer, twenty-five, and flare guns need it.', { rumour: true, lies: ['Copper is worthless. Only fools carry it.'] }),
    f('titanium', 'Titanium is the metal for real weapons. Rare as hen\'s teeth.', { rumour: true, tales: ['I once saw a titanium sword. It sang when it moved.'] }),
    f('miners', 'Miners dig the hills for ore. The deep caves hold the best of it.', { lies: ['Ore is only found in riverbeds.'], unlocks: ['caves'] }),
  ],
}

for (const [topic, facts] of Object.entries(LORE)) {
  if (TOPICS[topic] === undefined) throw new Error(`lore: ${topic} has facts but no TOPICS entry`)
  for (const fact of facts) for (const u of fact.unlocks) if (TOPICS[u] === undefined) throw new Error(`lore: ${topic}.${fact.id} unlocks unknown ${u}`)
}
