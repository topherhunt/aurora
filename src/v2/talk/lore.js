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
  curses: { label: 'mushroom curses', gated: true },
  flares: { label: 'flare guns', gated: true },
  eating: { label: 'eating wild things', gated: true },
  ores: { label: 'flint and ores', gated: true },
}

/** The topics she may ask about before anyone has mentioned any. */
export const OPEN_TOPICS = Object.keys(TOPICS).filter((k) => !TOPICS[k].gated)

// How likely a class is to know a fact at all, and what a body knows better (added).
const KNOW = { folk: 0.55, travel: 0.75, guard: 0.5, child: 0.35, leafkin: 0.6 }
const EXPERT = {
  alchemist: { mushrooms: 0.45, eating: 0.3, alchemist: 0.45, ores: 0.2, curses: 0.3 },
  herbalist: { mushrooms: 0.4, eating: 0.4, leafkin: 0.2, curses: 0.3 },
  healer: { mushrooms: 0.3, eating: 0.35, curses: 0.4 },
  blacksmith: { ores: 0.45, blacksmith: 0.45, coins: 0.2 },
  miner: { ores: 0.4, caves: 0.4, gems: 0.3 },
  hunter: { striders: 0.35, dragons: 0.25, snowlands: 0.2, yetis: 0.2, flares: 0.2 },
  trapper: { snowlands: 0.35, labyrinths: 0.3, striders: 0.2, yetis: 0.3, flares: 0.35 },
  shepherd: { striders: 0.3 },
  farmer: { striders: 0.25, eating: 0.2 },
  thief: { gems: 0.35, coins: 0.35, labyrinths: 0.25, flares: 0.2 },
  skald: { dragons: 0.3, snowlands: 0.2, labyrinths: 0.2, yetis: 0.25 },
  innkeeper: { coins: 0.3 },
  jarlsthane: { dragons: 0.2, coins: 0.2 },
}

// A `common` fact is everyday knowledge: anyone but a child knows it at these odds, whatever their class. A `rare` one,
// a story that happened to someone, is known at RARE of the usual odds.
const COMMON = { adult: 0.92, child: 0.7 }
const RARE = 0.3

/** How likely `mind` is to know fact `fact` of `topic`, 0..1. A leafkin knows only facts with a leafkin telling. */
export function knowOdds(mind, topic, fact) {
  const odds = Math.min(1, (KNOW[mind.cls] ?? 0.5) + (EXPERT[mind.body]?.[topic] ?? 0)) * (fact.rare ? RARE : 1)
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
// not know and will not admit it), `lk` the truth's wordings in leafkin pidgin (null: leafkin have no words for it), `unlocks` the other topics the telling names: each her follow-up after, and a gated one hers to ask anyone.
// `doubt` makes a fact contested: one who heard it but does not believe it (beliefOdds) honestly scoffs with a doubt line, and one who saw it (sawOdds) tells `seen` to someone they trust.
// `trust` is the standing she needs before they will tell it at all (TRUST): what mushrooms do is not told to strangers.
// Belief is held per subject, `of` (default the fact's topic; a TOPICS entry marked `contested` is one whole subject), so a speaker scoffs at yetis however they come up.
const f = (id, truth, { lies = [], tales = [], lk = null, unlocks = [], sens = 0, rumour = false, common = false, doubt = [], seen = null, of = null, trust = 0, rare = false } = {}) => ({ id, truth, lies, tales, lk, unlocks, sens, rumour, common, doubt, seen, of, trust, rare })

// Standing a fact's `trust` asks: `told` a few kind words in one talk, `close` a friendly talk or a favour (manners.js MANNERS.cap is a day's words).
export const TRUST = { told: 0.08, close: 0.15 }

export const LORE = {
  striders: [
    f('wild', 'Frost striders roam all over the wild country. Tall as a hayloft, all legs and beak.', { common: true, tales: ['There is a white strider in the hills, bigger than a house.'], lk: ['Long-legs walk everywhere. Big-big.', 'Long-legs all over wild place. Tall-tall!', 'See long-legs? Big-big beak, big-big legs.'] }),
    f('charge', 'Never walk straight up on a wild strider. Get too close and it will charge you.', { common: true, lies: ['Wild striders are gentle as lambs. Walk right up.'], lk: ['Long-legs angry close. Keesh! Run.', 'No walk at long-legs face. Long-legs stomp!', 'Too close, long-legs charge. Keesh! Leafkin run fast.'] }),
    f('shy', 'Come at a strider from the side or behind and it shrieks and runs off.', { common: true, lies: ['Sneak up behind a strider and you can grab it.'], lk: ['Long-legs scare from behind. Shriek! Run away.', 'Sneak at long-legs side? Long-legs scream, gone.', 'Long-legs no like surprise. Come from front, slow-slow.'] }),
    f('tame', 'Hold a fish out to a strider and it goes meek. Feed it and it trusts you after.', { common: true, lies: ['Striders eat carrots. Hold one out and it is yours.', 'Never feed a strider. It will follow you home and eat your roof.'], tales: ['I rode a strider clean across the lake once. It ran on the water.'], lk: ['Long-legs love fish. Give fish, long-legs friend.', 'Fish in hand, long-legs go soft. Then tikka.', 'Long-legs want fish! Feed, long-legs trust.'] }),
    f('ride', 'A strider that trusts you, take its rein from the front and it will follow. Climb on and it carries you.', { lies: ['Nobody can ride a strider. They throw you.'], lk: ['Long-legs friend carry big-folk. Up-up on back!', 'Tikka long-legs follow. Climb on, go fast-fast!', 'Long-legs trust you? Take rope at front, long-legs walk with.'] }),
    f('town', 'Every town keeps striders tied at a rail. Feed one a fish and it will carry you.', { lies: ['Town striders bite strangers. Stay well back.'], tales: ['The jarl\'s strider can outrun the wind. I timed it.'] }),
    f('mad', 'Eat a chanterelle and every beast near you turns on you, striders worst of all.', { lies: ['Striders are scared of mushrooms. Hold one up and they flee.'], unlocks: ['mushrooms', 'eating'], trust: TRUST.told }),
  ],
  dragons: [
    f('roost', 'Dragons roost on the high peaks. You can see their nests from the valley.', { common: true, lies: ['Dragons live under the lakes. Watch the water.'], tales: ['I fought a dragon once. With a stick.'], lk: ['Big-wing live up-up. Keesh! Leafkin hide.', 'Big-wing nest high on peak. Leafkin stay low.', 'Look up-up, see big-wing nest. Keesh!'], unlocks: ['snowlands'] }),
    f('return', 'The old folk say the dragons are coming back. More of them every year.', { lies: ['There are no dragons. That is a story for children.'], tales: ['A dragon egg is worth more than this whole town.', 'Dragons are afraid of yetis. True as I stand here.'], lk: ['Old leafkin say: big-wing come back. More, more.', 'Every year, more big-wing. Leafkin worry.', 'Big-wing coming home. Sky get busy. Keesh.'] }),
    f('pair', 'Dragons keep in pairs. One hunts while the other guards the nest.', { rumour: true, lies: ['Dragons only fly at midsummer.'], tales: ['A dragon once carried off a whole cow. And the farmer.'], lk: ['Big-wing go two-two. One hunt, one sit nest.', 'Two big-wing always. One fly, one watch.', 'Big-wing never alone. Watch for other one!'] }),
  ],
  alchemist: [
    f('brews', 'The potion master brews from mushrooms and stranger things. Ask before you eat anything wild.', { common: true, lies: ['The alchemist turns lead into gold. Mostly.'], tales: ['The alchemist once brewed a potion that made a man fly. Briefly.'], unlocks: ['mushrooms', 'eating'] }),
    f('wants', 'The alchemist always wants red mushrooms. Bring some and you will have a friend.', { lies: ['The alchemist hates mushrooms. Never bring one.'], unlocks: ['mushrooms'] }),
    f('firestone', 'Alchemists burn firestone in their brews. Rare stuff, and dear.', { rumour: true, lies: ['Firestone is just coal with airs.'], unlocks: ['ores'] }),
    f('flare', 'Do the alchemist a good turn and you may get a flare gun out of it.', { rumour: true, lies: ['The alchemist sells flare guns for a copper each.'], tales: ['I once shot a flare so high it became a star.'], unlocks: ['flares'] }),
  ],
  blacksmith: [
    f('forge', 'The smith works iron at the forge, morning to night.', { common: true, lies: ['The smith only works by moonlight.'], unlocks: ['ores'] }),
    f('sword', 'Bring the smith good metal, or do a favour, and you might walk off with a sword.', { rumour: true, lies: ['The smith will forge you anything for a smile.'], tales: ['The smith made a blade that cuts stone. I saw it split a boulder.'], unlocks: ['ores'] }),
    f('flint', 'Strike flint near something dry and you will have a fire. The smith swears by it.', { lies: ['Flint only sparks if you spit on it first.'], unlocks: ['ores'] }),
  ],
  coins: [
    f('buy', 'Gold coins buy food, a bed at the inn, a smith\'s time.', { common: true, rumour: true, lies: ['Coins? We trade in carrots here.'], lk: ['Shiny-round? Leafkin no eat. Big-folk like.', 'Big-folk trade shiny-round for food. Strange-strange.', 'Shiny-round no taste good. Big-folk love anyway.'] }),
    f('traders', 'Traders buy valuables for gold, but they will never sell you the rare things.', { rumour: true, lies: ['Any trader will sell you a diamond, if you haggle.'], unlocks: ['gems'] }),
  ],
  snowlands: [
    f('cold', 'Climb high enough and it is all snow. Bitter cold up there, and nothing to eat.', { common: true, lies: ['It never snows on the peaks. That is just cloud.'], tales: ['They say yetis live up in the snow. And that they love flowers.'], lk: ['White-cold up-up. Brrm. Leafkin no go.', 'High up, all white. Brrm! Nothing to eat.', 'Up-up mountain, cold bite toes. Leafkin stay down.'], unlocks: ['eating'] }),
    f('yetis', 'Some say yetis roam the snowy wastes, and taunt anyone who comes near.', { rumour: true, lies: ['Nothing lives up in the snow. Not even yetis.'], doubt: ['Folk talk of yetis up there. Bears and bad eyesight, I say.'], of: 'yetis', unlocks: ['yetis'] }),
    f('dragons', 'Above the snow is where the dragons nest.', { lies: ['The dragons nest down by the lakes.'], tales: ['There is a giant\'s skeleton up in the snow, big as a hall.'], unlocks: ['dragons'], lk: ['Big-wing nest above white-cold.', 'Past white-cold, big-wing home. Keesh!', 'Big-wing sleep over snow. Up-up-up.'] }),
  ],
  leafkin: [
    f('shy', 'Leafkin are shy little leaf-folk. Bring them mushrooms and they will warm to you.', { lies: ['Leafkin are vicious. They bite ankles.'], tales: ['Leafkin steal children and leave changelings in their beds.'], lk: ['Leafkin good! Give momo, leafkin tikka.', 'Leafkin shy-shy. Bring momo, leafkin come out.', 'Momo make leafkin friend. Easy-easy!'], unlocks: ['mushrooms'] }),
    f('homes', 'Their villages are hidden in the hills, through little mouths in the rock.', { lies: ['Leafkin live at the bottom of the lake.'], tales: ['Inside a leafkin hill there is a whole other sky.'], lk: ['Leafkin home in hill. Secret. Shh.', 'Little door in rock. Leafkin inside. Shh!', 'Hill-home hidden. No tell where. Shh-shh.'], sens: 0.3 }),
    f('friend', 'A leafkin that trusts you will run up to say hello. Then it will talk.', { lies: ['Leafkin cannot talk. They only squeak.'], lk: ['Tikka come, leafkin say hoola!', 'Leafkin trust, leafkin run say hoola.', 'Be tikka, leafkin come talk-talk.'] }),
  ],
  caves: [
    f('dark', 'Caves open at the feet of cliffs. Pitch dark inside, so carry a light.', { common: true, lies: ['Caves are lit inside, by glowing moss.'], tales: ['There is a cave with a sleeping giant in it. I heard it snore.'], lk: ['Dark-dark inside. Brrm. Leafkin no go deep.', 'Cave mouth at cliff-feet. Inside, no light. Bring fire!', 'Cave black-black. Big-folk need light.'] }),
    f('lost', 'Caves are devilish. The passages fork and twist and double back. Easy to get lost down there.', { common: true, lies: ['Every cave goes straight through the mountain. You cannot get lost.'], tales: ['A man went into a cave after his goat. Came out forty years later, still looking.'], lk: ['Cave twisty-twisty. Leafkin lost, never come home.', 'Cave path go round and round. Easy lost.', 'Deep cave, many ways. Wrong way, never out.'] }),
    f('chalk', 'There is chalk in the caves, a soft whitish stone. Pick some up and mark the walls as you go, or you may never find the way out.', { lies: ['Chalk marks wash off in the damp. Do not bother.'], lk: ['White-stone in cave. Draw-draw on wall, find way home.', 'Pick white-stone, mark wall. Follow marks back.', 'Scratch white on wall, cave no trick you.'] }),
    f('falls', 'Deep down, the roof comes down when you least expect it. Listen for the rumble.', { lies: ['Cave roofs never fall. Mountains do not move.'], lk: ['Cave roof fall! Hear rumble, run.', 'Deep down, rock drop from top. Listen-listen!', 'Rumble-rumble in cave? Run! Rock come down.'] }),
    f('gems', 'Gems glitter in the deep caves, for those who dare.', { rumour: true, lies: ['There is nothing in caves but bats.'], unlocks: ['gems'], lk: ['Shiny-stone deep in cave. Pretty-pretty.', 'Sparkle-rock hide in deep cave.', 'Glitter in deep dark. Big-folk love glitter.'] }),
  ],
  labyrinths: [
    f('stakes', 'Deep in the forest are mazes walled with sharpened stakes. Easy to get in, hard to get out.', { lies: ['The mazes in the woods move at night.'], lk: ['Stick-twisty in deep wood. Leafkin get lost. Hee.', 'Sharp-stick walls in wood. Go in easy, out hard.', 'Deep wood have stick-twisty. Leafkin no like.'] }),
    f('wall', 'In a maze, keep one hand on the wall and you will come out in the end.', { lies: ['In a maze, always turn left. Always.'], lk: ['Stick-twisty trick: hand on wall, walk-walk, come out.', 'Touch wall, never let go. Then find way out.', 'Lost in stick-twisty? One hand on wall. Walk, walk, out!'] }),
    f('heart', 'Somebody built mazes of stakes out in the wild. There is always something at the heart.', { rumour: true, tales: ['At the heart of a maze I found a chest of gold. Gave it all away.'], unlocks: ['gems'] }),
    f('giants', 'Green giants guard the mazes in the woods. Whatever lies at the heart, they keep it.', { rumour: true, lies: ['The giants in the mazes are friendly. They show you the way out.'], tales: ['I wrestled a green giant for its treasure once. We called it a draw.'], doubt: ['Green giants? A fireside tale for children.', 'Giants in the woods! Next you will tell me the trees talk.'], of: 'giants', seen: 'I saw one once, through the stakes. Green as moss and twice my height. I did not go in.', lk: ['Big-green in stick-twisty. Keesh! Leafkin no go.', 'Big-green guard stick-twisty middle. Stomp-stomp!', 'Green giant in stick-twisty. Leafkin hide.'] }),
  ],
  yetis: [
    f('wastes', 'Yetis live out in the snowy wastes. Great white brutes, taller than a man.', { rumour: true, lies: ['Yetis live in the deep woods, under the roots.'], tales: ['They say yetis love flowers. Bring one a posy and it weeps.'], doubt: ['Yetis? A story to keep children out of the snow.', 'There are no yetis. Snow-blind trappers seeing bears.'], seen: 'I saw one myself, up in the snow. White as the drifts, and it watched me the whole way down.', lk: ['Big-white up in cold. Brrm! Leafkin hide.', 'Big-white walk in snow. Tall-tall, hairy-hairy.', 'Up in white-cold, big-white live. Keesh.'], unlocks: ['snowlands'] }),
    f('taunt', 'Get near a yeti and it taunts you. Hoots and drums and throws snow at you, then it comes.', { rumour: true, lies: ['Yetis are gentle. They will share their fire with you.'], doubt: ['Drums in the snow? That is the wind in the ice, nothing more.'], unlocks: ['snowlands'], lk: ['Big-white hoot, drum-drum, throw snow. Then come!', 'Hear drum-drum in snow? Big-white near. Run!', 'Big-white throw snow, shout hoo-hoo. Then big-white come!'] }),
    f('kill', 'Never go close to a yeti. Most likely it will kill you.', { rumour: true, lies: ['A yeti is all noise. Shout back and it runs off.'], tales: ['I wrestled a yeti once. It cried for its mother.'], doubt: ['Nobody was ever killed by a yeti. The cold kills them, and the yeti gets the blame.'], lk: ['Big-white bad. Go close, never come back.', 'No go near big-white. Big-white squash.', 'Big-white kill big-folk. Stay far-far.'] }),
  ],
  gems: [
    f('diamond', 'Diamonds are the prize. A trader will give a hundred gold for one.', { rumour: true, lies: ['Jade is worth more than diamonds, everyone knows.'], tales: ['I held a diamond the size of an egg once.'] }),
    f('prices', 'A ruby fetches sixty gold, a piece of jade forty.', { rumour: true, lies: ['Gems are pretty rocks. Worthless.', 'A ruby is worth five gold, no more.'] }),
    f('find', 'You will never buy a gem. You find them, deep in caves or at the heart of a maze.', { rumour: true, lies: ['Gems grow on bushes in the snowlands.'], unlocks: ['caves', 'labyrinths'], lk: ['Shiny-stone hide deep. In cave, in stick-twisty.', 'No buy shiny-stone. Find in dark places.', 'Shiny-stone in cave and stick-twisty middle. Never in market.'] }),
  ],
  mushrooms: [
    f('wary', 'Never eat a mushroom you do not know. Every one stings, and some do very odd things.', { common: true, lies: ['Mushrooms are good for you. Eat all you find.'], lk: ['Momo good for leafkin! Big-folk belly no like.', 'Big-folk no eat strange momo. Belly hurt!', 'Momo for leafkin. Big-folk, careful-careful.'], unlocks: ['eating', 'leafkin'] }),
    f('size', 'An ink cap shrinks you. A parasol grows you back, or past.', { lies: ['An ink cap makes you tall as a tree.', 'A parasol will put you to sleep for a day.'], lk: ['Ink-shroom make small-small. Umbrella-shroom make big.', 'Eat ink-shroom, shrink! Eat umbrella-shroom, grow.', 'Small? Umbrella-shroom fix. Big? Ink-shroom fix.'], unlocks: ['curses'], trust: TRUST.told }),
    f('agaric', 'Eat a fly agaric and for a while you see what is hidden, far off, burning green.', { lies: ['Fly agaric is perfectly safe. Eat all you like.'], tales: ['I ate a fly agaric and saw my own grandmother. She has been dead ten years.'], unlocks: ['eating', 'curses'], trust: TRUST.told, lk: ['Fly-shroom make eyes see green-fire. Far-far.', 'Eat spotty-shroom, see hidden things glow green.', 'Spotty-shroom show secret things. Green-glow, far away.'] }),
    f('porcini', 'A porcini toughens your hide. Blows land half as hard for a minute.', { lies: ['Porcini make you weak as a kitten.'], trust: TRUST.told, lk: ['Fat-shroom make skin tough. Hit no hurt.', 'Eat fat-shroom, big-folk hard like bark. Little while.', 'Fat-shroom make big-folk tough. Bonk no hurt much.'] }),
    f('chanterelle', 'Never eat a chanterelle. Every beast near you will come for blood.', { lies: ['Chanterelle calms wild beasts. Hunters swear by it.'], lk: ['Gold-shroom brrm! Keesh! Beasts come bite.', 'No eat gold-shroom! All beasts angry.', 'Gold-shroom bad-bad. Beasts smell, beasts chase.'], unlocks: ['eating', 'curses'], trust: TRUST.told }),
  ],
  flares: [
    f('mark', 'Fire a flare and it hangs where it lands, burning day and night. Leave one where you have been and you can always find your way back.', { lies: ['A flare burns out in a minute. No use for marking anything.'], tales: ['I fired a flare over the sea once. Sailors still steer by it.'], lk: ['Fire-sky stay up-up. Leafkin see, find way home.', 'Shoot fire-sky, it burn and burn. Follow back.', 'Fire-sky never sleep. Good for lost big-folk.'] }),
    f('recall', 'Low on flares? Put the gun on safe, aim at one of your own, near enough, and pull the trigger. It flies home into the gun, and you have the charge back.', { lies: ['A flare spent is gone for good. Count every shot.', 'Shoot a second flare at the first and you get both back.'] }),
    f('charges', 'A flare gun holds ten flares. The light in the little window at the back shrinks as they run down.', { lies: ['A flare gun never runs out, if you keep it dry.'] }),
  ],
  curses: [
    f('dark', 'My cousin ate a chanterelle on a dare, and swore it cursed him. The world went black at the edges and every beast near him came for blood. Five long minutes of it.', { lies: ['A mushroom curse lasts seven years. My cousin is under one still.'], tales: ['I ate a black toadstool once and lived a week as a frog.'], lk: ['Big-folk eat gold-shroom. Dark-dark come, beasts bite-bite. Momo-curse!', 'Gold-shroom curse: world go dark, beasts hunt. Brrm!', 'Gold-shroom eaten? Edges go black, beasts come. Five long minutes!'], unlocks: ['mushrooms', 'eating'], trust: TRUST.close, rare: true }),
    f('small', 'A woman I knew ate three ink caps and shrank small as a cat. She thought the curse was for life. So it was, till she ate a parasol.', { lies: ['Shrunk by an ink cap? Sleep it off. You are your own size by morning.'], lk: ['Big-folk eat ink-shroom, small-small, stay small. Eat umbrella-shroom, big again.', 'Shrink-curse stay and stay. Umbrella-shroom break it.', 'Ink-shroom shrink stay forever. Only umbrella-shroom make big.'], unlocks: ['mushrooms', 'eating'], trust: TRUST.close, rare: true }),
    f('green', 'My aunt ate a fly agaric and saw green fire through the hills, burning wherever something lay hidden. She called it a curse. It was gone in a few breaths.', { lies: ['Eat a fly agaric and you see green fire for the rest of your days.'], tales: ['A fly agaric showed me where the dragons bury their gold. I have kept it secret.'], unlocks: ['mushrooms', 'eating'], trust: TRUST.close, rare: true, lk: ['Fly-shroom curse: green fire everywhere. Few breaths, gone.', 'Eat spotty-shroom, hills glow green. Then stop.', 'Spotty-shroom curse short. Green fire, blink-blink, gone.'] }),
  ],
  eating: [
    f('food', 'Carrots and fish fill your belly and mend you. Mushrooms only hurt you.', { common: true, lies: ['Raw fish will make you sick for days.'], lk: ['Carrot good. Fish good. Momo for leafkin.', 'Big-folk eat carrot, eat fish. Feel better!', 'Fish and carrot fix big-folk. Momo only for leafkin.'], unlocks: ['mushrooms'] }),
    f('how', 'Hold the food to your mouth a moment and you will eat it.', { lies: ['You have to cook a carrot or it will kill you.'], lk: ['Hold food at mouth. Nom!', 'Food to mouth, wait little. Nom-nom.', 'Hold food at face. Little wait, then eaten. Yum!'] }),
  ],
  ores: [
    f('flint', 'Flint is common enough, two gold a stone. Strike it to make fire.', { common: true, lies: ['Flint is the rarest stone there is.'], lk: ['Flint-stone go click-click, make fire. Hot!', 'Hit flint, spark jump. Fire!', 'Flint everywhere. Strike-strike, fire come.'] }),
    f('iron', 'Iron is common too, five gold. Copper is dearer, twenty-five, and flare guns need it.', { rumour: true, lies: ['Copper is worthless. Only fools carry it.'], unlocks: ['flares'] }),
    f('titanium', 'Titanium is the metal for real weapons. Rare as hen\'s teeth.', { rumour: true, tales: ['I once saw a titanium sword. It sang when it moved.'] }),
    f('miners', 'Miners dig the hills for ore. The deep caves hold the best of it.', { lies: ['Ore is only found in riverbeds.'], unlocks: ['caves'], lk: ['Big-folk dig hill for rock. Deep cave, best rock.', 'Diggers chop-chop in hill. Noisy-noisy.', 'Big-folk dig deep for shiny rock. Cave rock best.'] }),
  ],
}

for (const [topic, facts] of Object.entries(LORE)) {
  if (TOPICS[topic] === undefined) throw new Error(`lore: ${topic} has facts but no TOPICS entry`)
  for (const fact of facts) for (const u of fact.unlocks) if (TOPICS[u] === undefined) throw new Error(`lore: ${topic}.${fact.id} unlocks unknown ${u}`)
}
