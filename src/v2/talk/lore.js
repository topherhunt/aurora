// What people say about the world (_notes/conversation-and-quests.md, "Lore"): hints, misinformation and tall tales,
// each fact told through the answer pipeline (speak.js `_answer`) so who knows it, who lies and who boasts is the
// speaker's temperament. A gated topic has no button until someone mentions it to her (`unlocks`); what she has heard
// of is kept in her save. Truths are true of the game as built; facts about the trade that is not built yet are
// marked `rumour` and stay vague. A secret of play (pets in caves, flare tricks) is a partial anecdote, never a manual:
// she should have to try it to learn the rest. Three-free.

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
  weapons: { label: 'swords and shields', gated: true },
  mining: { label: 'pickaxes and veins', gated: true },
  spiders: { label: 'cave spiders', gated: true },
  giants: { label: 'green giants', gated: true },
  pets: { label: 'pets', gated: false },
  roads: { label: 'the roads', gated: false },
}

/** The topics she may ask about before anyone has mentioned any. */
export const OPEN_TOPICS = Object.keys(TOPICS).filter((k) => !TOPICS[k].gated)

// How likely a class is to know a fact at all, and what a body knows better (added).
const KNOW = { folk: 0.55, travel: 0.75, guard: 0.5, child: 0.35, leafkin: 0.6 }
const EXPERT = {
  alchemist: { mushrooms: 0.45, eating: 0.3, alchemist: 0.45, ores: 0.2, curses: 0.3, flares: 0.4, spiders: 0.4, mining: 0.2, pets: 0.15, giants: 0.15 },
  herbalist: { mushrooms: 0.4, eating: 0.4, leafkin: 0.2, curses: 0.3 },
  healer: { mushrooms: 0.3, eating: 0.35, curses: 0.4, roads: 0.2, yetis: 0.1, labyrinths: 0.1 },
  blacksmith: { ores: 0.45, blacksmith: 0.45, coins: 0.2, weapons: 0.45, mining: 0.3 },
  miner: { ores: 0.4, caves: 0.4, gems: 0.3, mining: 0.5, spiders: 0.3, flares: 0.2 },
  hunter: { striders: 0.35, dragons: 0.25, snowlands: 0.2, yetis: 0.2, flares: 0.2, pets: 0.35, spiders: 0.2, weapons: 0.2 },
  trapper: { dragons: 0.2, snowlands: 0.35, labyrinths: 0.3, striders: 0.2, yetis: 0.3, flares: 0.35, spiders: 0.3, giants: 0.3, roads: 0.3, pets: 0.2, weapons: 0.2, mining: 0.15 },
  shepherd: { striders: 0.3, pets: 0.3 },
  farmer: { striders: 0.25, eating: 0.2, pets: 0.25 },
  woodcutter: { giants: 0.3, labyrinths: 0.2 },
  fisherman: { pets: 0.2 },
  thief: { gems: 0.35, coins: 0.35, labyrinths: 0.25, yetis: 0.1, flares: 0.2, roads: 0.3, mining: 0.2, spiders: 0.15 },
  skald: { dragons: 0.3, snowlands: 0.2, labyrinths: 0.2, yetis: 0.25, giants: 0.45, spiders: 0.3, weapons: 0.2 },
  // The innkeeper hears the road's talk: a little of everything but the sights only travellers see (yetis, mazes), and the roads best, so every town has someone to ask.
  innkeeper: { coins: 0.3, roads: 0.4, striders: 0.2, dragons: 0.2, snowlands: 0.2, leafkin: 0.2, caves: 0.2, gems: 0.2, blacksmith: 0.2, weapons: 0.2, pets: 0.2, giants: 0.2, mining: 0.15, flares: 0.2 },
  jarlsthane: { dragons: 0.2, coins: 0.2, weapons: 0.3, roads: 0.2 },
  guard: { weapons: 0.4, roads: 0.3, dragons: 0.15 },
  shieldmaiden: { weapons: 0.45, dragons: 0.2 },
  battlemage: { weapons: 0.35, dragons: 0.2, giants: 0.25, spiders: 0.2 },
  'child-villager-2': { pets: 0.35, giants: 0.35, spiders: 0.25 },
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
// `at` 'away' is told only by those outside the deer's town (world.js `deer`), 'home' only by its residents; `{town}` and `{owner}` in a fact's wordings are filled with that town and its owner.
// Belief is held per subject, `of` (default the fact's topic; a TOPICS entry marked `contested` is one whole subject), so a speaker scoffs at yetis however they come up.
const f = (id, truth, { lies = [], tales = [], lk = null, unlocks = [], sens = 0, rumour = false, common = false, doubt = [], seen = null, of = null, trust = 0, rare = false, at = null } = {}) => ({ id, truth, lies, tales, lk, unlocks, sens, rumour, common, doubt, seen, of, trust, rare, at })

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
    f('scare', 'Show a strider a crab or a spider in your hand and it shies, even a tame one. One you are riding bolts with you on its back.', { lies: ['Striders love crabs. Hold one up and they come running.'], unlocks: ['spiders'], lk: ['Long-legs hate crab, spider in hand. Run-run! Even friend long-legs.', 'Hold spider near long-legs? Long-legs bolt, tikka on back too.', 'Crab in hand, long-legs jump. Hold tight!'] }),
    f('fell', 'A wild strider can be killed, and that one never comes back. Think twice.', { lies: ['A strider shrugs off fire. It only singes its feathers.', 'Kill a strider and another grows from its feathers by morning.'], tales: ['I burned a strider once for its feathers. It never came back, and neither did my luck.'], lk: ['Fire on long-legs, long-legs fall. Gone-gone, no come back.', 'Hurt long-legs ten-ten, long-legs lie down, fade. Never again.', 'Long-legs die to fire. Leafkin sad, no do.'] }),
  ],
  dragons: [
    f('roost', 'Dragons roost on the high peaks. You can see their nests from the valley.', { common: true, lies: ['Dragons live under the lakes. Watch the water.'], tales: ['I fought a dragon once. With a stick.'], lk: ['Big-wing live up-up. Keesh! Leafkin hide.', 'Big-wing nest high on peak. Leafkin stay low.', 'Look up-up, see big-wing nest. Keesh!'], unlocks: ['snowlands'] }),
    f('return', 'The old folk say the dragons are coming back. More of them every year.', { lies: ['There are no dragons. That is a story for children.'], tales: ['A dragon egg is worth more than this whole town.', 'Dragons are afraid of yetis. True as I stand here.'], lk: ['Old leafkin say: big-wing come back. More, more.', 'Every year, more big-wing. Leafkin worry.', 'Big-wing coming home. Sky get busy. Keesh.'] }),
    f('deer', 'Somebody in {town} fought off a dragon, and nobody knows how.', { common: true, at: 'away', lies: ['Nobody fought off any dragon. The folk of {town} only say so.'], tales: ['A man in {town} wrestled a dragon with his bare hands. I know the man.'] }),
    f('deer-truth', '{owner} never fought off a dragon, only took the credit. It was {owner}\'s enormous pet deer, and deer turn feisty if you feed them enough.', { common: true, at: 'home', lies: ['{owner} fought that dragon alone, and the deer only watched.'] }),
    f('pair', 'Dragons keep in pairs. One hunts while the other guards the nest.', { rumour: true, lies: ['Dragons only fly at midsummer.'], unlocks: ['weapons'], tales: ['A dragon once carried off a whole cow. And the farmer.'], lk: ['Big-wing go two-two. One hunt, one sit nest.', 'Two big-wing always. One fly, one watch.', 'Big-wing never alone. Watch for other one!'] }),
    f('hoard', 'Every dragon\'s nest holds an egg, with coins and gems strewn round it. A dragon brought down drops gems where it falls.', { lies: ['Dragons hoard nothing but bones.'], tales: ['I found a dragon\'s nest once. The egg was warm.'], unlocks: ['gems', 'coins'], lk: ['Big-wing nest have egg and shiny. Keesh! Leafkin no take.', 'Big-wing sit on shiny-stone. Up-up nest, egg in middle.', 'Shiny in big-wing nest. Leafkin no go. Too scary!'] }),
    f('flee', 'When a dragon comes down near a town, folk run screaming. Run with them.', { common: true, lies: ['Dragons never come near a town. The smoke keeps them off.'], tales: ['A dragon landed in my yard once. I hid in the butter churn for a day.'], lk: ['Big-wing come down, big-folk run, scream-scream!', 'Big-wing near big-folk home? Big-folk run-run. Leafkin too.', 'Hear big-folk scream? Big-wing close. Hide!'] }),
    f('walk', 'A dragon that comes down in a maze has to walk its paths like anyone. It cannot climb the stakes.', { rare: true, lies: ['A dragon flattens a maze\'s walls like reeds.'], unlocks: ['labyrinths'], lk: ['Big-wing in stick-twisty walk path. No break wall!', 'Stick-twisty slow big-wing. Big-wing walk round and round.'] }),
    f('wake', 'Cut a dragon that is resting on the ground and it turns on you at once. Hold a shield up and it turns most of the bite.', { lies: ['A dragon cut on the ground only lies there and bleeds.', 'A shield held up before a dragon only melts.'], tales: ['I cut a dragon, and it ate my shield. It tasted of oak.'], unlocks: ['weapons'] }),
  ],
  alchemist: [
    f('brews', 'The potion master brews from mushrooms and stranger things. Ask before you eat anything wild.', { common: true, lies: ['The alchemist turns lead into gold. Mostly.'], tales: ['The alchemist once brewed a potion that made a man fly. Briefly.'], unlocks: ['mushrooms', 'eating'] }),
    f('wants', 'The alchemist always wants red mushrooms. Bring some and you will have a friend.', { lies: ['The alchemist hates mushrooms. Never bring one.'], unlocks: ['mushrooms'] }),
    f('firestone', 'Alchemists burn firestone in their brews. Rare stuff, and dear.', { rumour: true, lies: ['Firestone is just coal with airs.'], unlocks: ['ores'] }),
    f('shop', 'The potion master keeps his shop about half the day. Find him there, not out in the street and not in bed, and he will deal with you.', { lies: ['The alchemist never leaves his shop, not even to sleep.'], unlocks: ['flares'] }),
    f('flare', 'Do the alchemist a good turn and you may get a flare gun out of it.', { rumour: true, lies: ['The alchemist sells flare guns for a copper each.'], tales: ['I once shot a flare so high it became a star.'], unlocks: ['flares'] }),
  ],
  blacksmith: [
    f('forge', 'The smith works iron at the forge, morning to night.', { common: true, lies: ['The smith only works by moonlight.'], unlocks: ['ores'] }),
    f('sword', 'The smith sells a sword for a hundred coins and three lumps of bog iron. He deals only in his workshop.', { lies: ['The smith will forge you anything for a smile.'], tales: ['The smith made a blade that cuts stone. I saw it split a boulder.'], unlocks: ['ores', 'weapons'] }),
    f('flint', 'Strike flint near something dry and you will have a fire. The smith swears by it.', { lies: ['Flint only sparks if you spit on it first.'], unlocks: ['ores'] }),
  ],
  coins: [
    f('buy', 'The smith takes coin, and the alchemist. Leafkin too, for their metal.', { common: true, lies: ['Coins? We trade in carrots here.'], unlocks: ['flares', 'leafkin'], lk: ['Shiny-round? Leafkin swap for iron-rock. Big-folk like too.', 'Big-folk trade shiny-round for tools. Leafkin trade for metal. Strange-strange.', 'Shiny-round no taste good. But leafkin give iron for it.'] }),
    f('traders', 'Traders buy valuables for gold, but they will never sell you the rare things.', { rumour: true, lies: ['Any trader will sell you a diamond, if you haggle.'], unlocks: ['gems'] }),
    f('egg', 'Only a thief will buy a dragon egg, for a hundred and fifty gold. An honest trader will not touch one.', { lies: ['Any trader pays a thousand gold for a dragon egg.'], unlocks: ['dragons'] }),
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
    f('swap', 'Leafkin swap bog iron and lodestone for gems or coin. Jade is their favourite: three lumps of bog iron for one.', { rumour: true, lies: ['Leafkin give their metal away to anyone who is kind to them.'], unlocks: ['gems', 'ores'], lk: ['Bring shiny-stone, leafkin give iron-rock. Jade best-best!', 'Leafkin trade: gem for iron, gem for lode-rock. Shiny-round too.', 'Shiny for iron-rock. Green shiny, three iron! Hee.'] }),
    f('hobs', 'Leafkin keep hob weevils as pets. Never feed one to a frog: the glade will never forgive you.', { lies: ['Leafkin weevils are vermin. Feed them to the frogs.'], tales: ['I saw a hob grown as big as a pig. Nobody believes me.'], lk: ['Hob-friend leafkin pet. Frog eat hob? Leafkin never forgive.', 'Leafkin love hob. Frog eat hob? Keesh! Never forgive.', 'Hob little pet, leafkin love-love. Feed frog, leafkin hate-hate.'] }),
  ],
  caves: [
    f('dark', 'Caves open at the feet of cliffs. Pitch dark inside, so carry a light.', { common: true, lies: ['Caves are lit inside, by glowing moss.'], tales: ['There is a cave with a sleeping giant in it. I heard it snore.'], lk: ['Dark-dark inside. Brrm. Leafkin no go deep.', 'Cave mouth at cliff-feet. Inside, no light. Bring fire!', 'Cave black-black. Big-folk need light.'] }),
    f('lost', 'Caves are devilish. The passages fork and twist and double back. Easy to get lost down there.', { common: true, lies: ['Every cave goes straight through the mountain. You cannot get lost.'], tales: ['A man went into a cave after his goat. Came out forty years later, still looking.'], lk: ['Cave twisty-twisty. Leafkin lost, never come home.', 'Cave path go round and round. Easy lost.', 'Deep cave, many ways. Wrong way, never out.'] }),
    f('chalk', 'There is chalk in the caves, a soft whitish stone. Pick some up and mark the walls as you go, or you may never find the way out.', { lies: ['Chalk marks wash off in the damp. Do not bother.'], lk: ['White-stone in cave. Draw-draw on wall, find way home.', 'Pick white-stone, mark wall. Follow marks back.', 'Scratch white on wall, cave no trick you.'] }),
    f('falls', 'Deep down, the roof comes down when you least expect it. Listen for the rumble.', { lies: ['Cave roofs never fall. Mountains do not move.'], lk: ['Cave roof fall! Hear rumble, run.', 'Deep down, rock drop from top. Listen-listen!', 'Rumble-rumble in cave? Run! Rock come down.'] }),
    f('rabbit', 'Adventurers tell of being hopelessly lost in a cave near here as a child, until a pet rabbit led them out.', { rare: true, lies: ['Rabbits never go underground. Whoever told you that was dreaming.'], tales: ['I was lost in a cave as a child myself, until my pet rabbit led me out.'], lk: ['Hop-friend lead lost leafkin out of cave. Follow hop-friend, find sky!', 'Lost in cave? Little hop-friend know way out. Walk behind.', 'Long ago, hop-friend save lost child in cave. True-true!'] }),
    f('fox', 'My grandfather took his fox down the caves with him. Swore it could smell gems.', { rare: true, lies: ['Foxes hate caves. They will not go in.'], tales: ['A fox once led me straight to a chest of gold. I let it keep a share.'], unlocks: ['gems'], lk: ['Fox smell shiny in cave. Follow fox nose, find!', 'Fox-friend sniff out shiny-stone. Walk after fox.', 'Take fox in cave. Fox know where shiny hide.'] }),
    f('flares', 'A miner I knew left a flare glowing on the wall at every fork in a cave. Never once lost her way.', { rare: true, lies: ['A flare fired in a cave blinds you for an hour. Never.'], unlocks: ['flares', 'spiders'], lk: ['Fire-sky on cave wall, stay bright. Follow bright, find home.', 'Shoot fire-sky at cave wall. Leave bright mark!', 'Cave dark-dark, but fire-sky stay. Follow fire-sky out.'] }),
    f('gems', 'Gems glitter in the deep caves, for those who dare.', { rumour: true, lies: ['There is nothing in caves but bats.'], unlocks: ['gems'], lk: ['Shiny-stone deep in cave. Pretty-pretty.', 'Sparkle-rock hide in deep cave.', 'Glitter in deep dark. Big-folk love glitter.'] }),
  ],
  labyrinths: [
    f('stakes', 'Deep in the forest are mazes walled with sharpened stakes. Easy to get in, hard to get out.', { lies: ['The mazes in the woods move at night.'], lk: ['Stick-twisty in deep wood. Leafkin get lost. Hee.', 'Sharp-stick walls in wood. Go in easy, out hard.', 'Deep wood have stick-twisty. Leafkin no like.'] }),
    f('wall', 'In a maze, keep one hand on the wall and you will come out in the end.', { lies: ['In a maze, always turn left. Always.'], lk: ['Stick-twisty trick: hand on wall, walk-walk, come out.', 'Touch wall, never let go. Then find way out.', 'Lost in stick-twisty? One hand on wall. Walk, walk, out!'] }),
    f('heart', 'They say there is an altar at the heart of every maze, with a gem on it. The bigger the maze, the finer the gem.', { rumour: true, lies: ['The altar at a maze\'s heart holds a curse and nothing else.'], tales: ['At the heart of a maze I found a chest of gold. Gave it all away.'], unlocks: ['gems'] }),
    f('flare', 'My brother got out of a maze by leaving a flare glowing at each turning. Slow, but he got out.', { rare: true, lies: ['A flare in a maze only brings the giants.'], unlocks: ['flares'], lk: ['Stick-twisty lost? Shoot fire-sky on ground. Fire stay, you know.', 'Fire-sky at each turn in stick-twisty. See fire, know been-there.', 'Fire-sky mark path in stick-twisty. Not lost twice.'] }),
    f('tower', 'Some mazes have a tower of scaffolding at their heart, climbed by ladders. The prize waits at the top.', { rumour: true, lies: ['The towers in the mazes are only for the giants to sleep in.'], tales: ['I climbed a maze tower so high I could see the sea.'], lk: ['Some stick-twisty have up-up tower. Ladder climb.', 'Tower in stick-twisty middle. Climb-climb, shiny at top.', 'Stick-twisty tower tall. Ladder, ladder, ladder.'] }),
    f('rope', 'A coiled rope lies on top of a maze tower. Throw it over the side and you can slide down to the ground without a scratch.', { rare: true, lies: ['The rope on a maze tower is rotten. It snaps halfway down.'], tales: ['I slid down a tower rope so fast my gloves caught fire.'], lk: ['Rope on tower top. Throw down, slide-slide!', 'Tower rope go down-down. Hold on, whee!', 'Up-up tower, rope waiting. Slide down safe.'] }),
    f('clock', 'A maze tires of a dawdler. Folk find themselves back at the gate. Reach the heart and the drums fall still.', { rumour: true, lies: ['A maze lets you out the moment you are lost. That is its mercy.'], tales: ['I was in a maze so long they put out my fire. Forty days.'] }),
    f('giants', 'Green giants guard the mazes in the woods. Whatever lies at the heart, they keep it.', { rumour: true, lies: ['The giants in the mazes are friendly. They show you the way out.'], tales: ['I wrestled a green giant for its treasure once. We called it a draw.'], doubt: ['Green giants? A fireside tale for children.', 'Giants in the woods! Next you will tell me the trees talk.'], of: 'giants', seen: 'I saw one once, through the stakes. Green as moss and twice my height. I did not go in.', lk: ['Big-green in stick-twisty. Keesh! Leafkin no go.', 'Big-green guard stick-twisty middle. Stomp-stomp!', 'Green giant in stick-twisty. Leafkin hide.'], unlocks: ['giants'] }),
  ],
  yetis: [
    f('wastes', 'Yetis live out in the snowy wastes. Great white brutes, taller than a man.', { rumour: true, lies: ['Yetis live in the deep woods, under the roots.'], tales: ['They say yetis love flowers. Bring one a posy and it weeps.'], doubt: ['Yetis? A story to keep children out of the snow.', 'There are no yetis. Snow-blind trappers seeing bears.'], seen: 'I saw one myself, up in the snow. White as the drifts, and it watched me the whole way down.', lk: ['Big-white up in cold. Brrm! Leafkin hide.', 'Big-white walk in snow. Tall-tall, hairy-hairy.', 'Up in white-cold, big-white live. Keesh.'], unlocks: ['snowlands'] }),
    f('taunt', 'Get near a yeti and it taunts you. Hoots and drums and throws snow at you, then it comes.', { rumour: true, lies: ['Yetis are gentle. They will share their fire with you.'], doubt: ['Drums in the snow? That is the wind in the ice, nothing more.'], unlocks: ['snowlands'], lk: ['Big-white hoot, drum-drum, throw snow. Then come!', 'Hear drum-drum in snow? Big-white near. Run!', 'Big-white throw snow, shout hoo-hoo. Then big-white come!'] }),
    f('kill', 'Never go close to a yeti. Most likely it will kill you.', { rumour: true, lies: ['A yeti is all noise. Shout back and it runs off.'], tales: ['I wrestled a yeti once. It cried for its mother.'], doubt: ['Nobody was ever killed by a yeti. The cold kills them, and the yeti gets the blame.'], lk: ['Big-white bad. Go close, never come back.', 'No go near big-white. Big-white squash.', 'Big-white kill big-folk. Stay far-far.'] }),
  ],
  gems: [
    f('diamond', 'Diamonds are the prize. A trader will give a hundred gold for one.', { rumour: true, lies: ['Jade is worth more than diamonds, everyone knows.'], tales: ['I held a diamond the size of an egg once.'] }),
    f('prices', 'A ruby fetches sixty gold, a sapphire seventy-five, a piece of jade forty.', { rumour: true, lies: ['Gems are pretty rocks. Worthless.', 'A ruby is worth five gold, no more.'] }),
    f('find', 'You will hardly ever buy a gem. You find them: deep in caves, at the heart of a maze, or in a dragon\'s nest.', { rumour: true, lies: ['Gems grow on bushes in the snowlands.'], unlocks: ['caves', 'labyrinths', 'mining', 'dragons'], lk: ['Shiny-stone hide deep. In cave, in stick-twisty, in big-wing nest.', 'No buy shiny-stone. Find in dark places.', 'Shiny-stone in cave and stick-twisty middle. Never in market.'] }),
    f('deep', 'The deeper the cave, the finer the stone. Jade near the mouth, diamonds only far down.', { lies: ['Diamonds lie by the cave mouth. Folk are too lazy to look.'], unlocks: ['caves', 'mining'], lk: ['Deep-deep, better shiny-stone. Near door, only green one.', 'Go far in dark, find blue and white shiny-stone.'] }),
    f('thief', 'A thief might sell you one stolen gem, at three times what a trader would give for it.', { rumour: true, lies: ['A thief gives gems away to anyone who asks.'], tales: ['A thief sold me a ruby once. It was glass. Or I was.'] }),
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
    f('ground', 'A flare that strikes rock or ground stays there and glows. Handy in a cave, or a maze.', { lies: ['A flare that strikes rock goes out at once. Only the sky keeps them.'], tales: ['I lit a whole cave with flares once. The bats thanked me.'], unlocks: ['caves', 'labyrinths'], lk: ['Fire-sky on ground stay bright. Light cave, light stick-twisty!', 'Shoot fire-sky at wall, it glow and glow. Mark path.', 'Fire-sky at fork, fire stay. Walk back by fire.'] }),
    f('refill', 'When the gun runs dry the potion master sells a jar of flare charges for forty coins and a firestone. He deals only in his shop.', { lies: ['A flare gun cannot be refilled. Buy another.', 'The potion master gives refills away to anyone who asks nicely.'], unlocks: ['alchemist', 'ores', 'coins'] }),
    f('recall', 'A trapper showed me a trick. Gun on safe, aim at your own flare and pull, and it flies home. I never got the knack.', { lies: ['A flare spent is gone for good. Count every shot.', 'Shoot a second flare at the first and you get both back.'] }),
    f('charges', 'Mind the little light at the back of a flare gun. It wanes with every shot.', { lies: ['A flare gun never runs out, if you keep it dry.'] }),
  ],
  weapons: [
    f('sword', 'A sword wants a hard swing. Wave it about gently and you only tickle.', { lies: ['A sword cuts a beast just by touching it. Hold it out and walk.'], tales: ['I felled a bear with one stroke of my sword. Then I felled the oak behind it.'], unlocks: ['blacksmith'] }),
    f('shield', 'Hold a shield up and it turns most of a blow. From the front, mind.', { lies: ['A shield stops every blow, from any side.', 'Shields are for show. A blow goes straight through.'], unlocks: ['blacksmith'] }),
    f('price', 'The smith makes a sword or a shield for a hundred coins and three bog iron, and a pickaxe for fifty coins. He sells only in his workshop.', { lies: ['The smith gives swords to anyone brave. Ask him nicely.'], unlocks: ['blacksmith', 'ores', 'mining'] }),
    f('dragon', 'They say a dragon can be brought down with a sword, if you have the stomach. And that it leaves gems where it falls.', { rumour: true, lies: ['A dragon cannot be hurt by iron. Only gold.'], tales: ['I brought down a dragon with one thrown stone, and kept the stone.'], unlocks: ['dragons', 'gems'] }),
    f('town', 'Never walk into a town with a sword in your hand. The people jeer, the guards warn you off, and nobody will so much as talk to you.', { common: true, lies: ['A sword is welcome in town. The guards salute it.'] }),
  ],
  mining: [
    f('pickaxe', 'A pickaxe pries ore from a cave wall. Three hard strikes on the one vein and it comes loose in your hand.', { lies: ['You can pull ore from the wall with your bare hands. Just tug.'], tales: ['I mined a vein of gold as thick as my arm. It was a root.'], unlocks: ['blacksmith', 'caves', 'ores'] }),
    f('depth', 'Nothing worth digging lies near a cave mouth. Go a hundred strides in, and the deeper you go, the more veins.', { lies: ['The best veins are right by the mouth. Any fool can reach them.'], unlocks: ['caves'] }),
    f('height', 'Veins sit low in the wall, from about your knee to a little over your head. Look along the rock, not up at the roof.', { lies: ['The ore is all in the roof. Bring a ladder.'] }),
    f('kinds', 'Bog iron comes first. Lodestone lies much deeper. Rimesilver is only in the great cavern, pale as frost, and worth two hundred gold.', { lies: ['Rimesilver is in every cave. They just do not look.'], unlocks: ['ores'] }),
    f('glint', 'Gems lie in nooks of the wall and show only when your light falls on them. Carry a light and sweep it over the rock.', { lies: ['Gems glow on their own in the dark. You will see them from far off.'], unlocks: ['gems', 'flares'] }),
  ],
  spiders: [
    f('giant', 'Spiders as long as a big dog crawl the walls and roofs of the deep caves, dark as soot. They will not attack you.', { lies: ['Cave spiders bite, and the bite is death. Run when you see one.'], tales: ['A cave spider once carried off a goat. Whole. I saw it go.'], unlocks: ['caves'], lk: ['Big-black spider on cave wall. No bite, only look.', 'Cave spider big-big, black-black. Leafkin step wide.', 'Big spider walk on cave roof. No hurt, no hurt.'] }),
    f('light', 'Carry a light and the big spiders shrink from it. They rear, hiss, and back away facing you, until you are far off.', { lies: ['Cave spiders love a torch and swarm to it.'], unlocks: ['flares'] }),
    f('small', 'The little spiders of the wood are harmless and you can pick one up. Keep one in your hand and see what bigger things think of it.', { lies: ['A spider in your hand will bite you. Drop it at once.'], tales: ['I once had a spider on my hat for a week. Never lost my temper.'], unlocks: ['giants'] }),
    f('frogs', 'A frog will leap for a spider held out in your hand, and swallow it whole. A pet frog grows on them.', { rare: true, lies: ['Frogs will not touch a spider. They are afraid of them.'] }),
    f('cut', 'A sword kills a cave spider in two good strokes, though they never fight back.', { lies: ['Cave spiders bite back with fire.'], unlocks: ['weapons', 'caves'] }),
  ],
  giants: [
    f('fear', 'Every old tale agrees: green giants are afraid of spiders. Big as a house, and they flee from a thing no bigger than a coin.', { rumour: true, lies: ['Giants eat spiders like sweets. They would follow you for one.'], tales: ['I once frightened a giant with a spider. He wept like a calf.'], unlocks: ['spiders', 'labyrinths'] }),
    f('tailor', 'In the old story a little tailor cornered a giant with nothing but a spider in his fist. The giant howled and fled, and never came back.', { rumour: true, lies: ['In the old story a tailor beat a giant with his thimble.'], tales: ['My grandmother knew that tailor. He was no braver than a hen. He only had a spider.'], unlocks: ['spiders'] }),
    f('slow', 'A green giant is slower than you walk. It is the fists you mind, if you stand in its way.', { rumour: true, lies: ['Giants in a maze run like deer. You will never outpace one.'], tales: ['A giant once chased me clean out of a maze and halfway home. Very slowly.'], unlocks: ['labyrinths', 'spiders'] }),
    f('song', 'The children sing of the giant who feared the smallest thing: eight little legs, and off he ran.', { rare: true, lies: ['The giant in the children\'s song feared a mouse.'], unlocks: ['spiders'] }),
    f('flare', 'Fire a flare near a green giant and it cowers and screams for a while. Then it comes on again.', { rumour: true, lies: ['A flare only angers a giant.'], unlocks: ['flares'] }),
  ],
  pets: [
    f('tame', 'Feed a wild beast what it likes and it will follow you after. Each meal grows it a little, and mends it.', { lies: ['A pet shrinks if you feed it too much.'], tales: ['My fox grew as big as a pony and ate my roof.'], lk: ['Feed fox, fox tikka. More feed, fox big.', 'Feed hop-friend, hop-friend follow-follow.', 'Beast like food, beast stay. Grow-grow.'] }),
    f('keeps', 'Once a beast takes to you, you cannot lose it. Mine turns up at my heels when I least expect it.', { lies: ['A pet wanders off the moment you look away.'] }),
    f('cave', 'My little ones follow me anywhere, even down into the caves. The big ones have more sense and wait outside.', { rare: true, lies: ['No pet will go underground. They are not fools.'], unlocks: ['caves'] }),
    f('lost', 'A pet that cannot follow you waits where you left it. Mine waited three days at the ford.', { rumour: true, lies: ['A pet you leave behind is gone for good. It will not know you.'] }),
    f('fox', 'When my fox has nobody to follow, it stares off at something and yips. There is always something there.', { rare: true, lies: ['A fox yips only when it smells a storm.'] }),
    f('deer', 'They say a deer fed fat enough fears nothing. Not even a dragon.', { rumour: true, lies: ['A deer will run from a dragon, however big it grows.'], unlocks: ['dragons'] }),
    f('diet', 'A deer takes a carrot or a mushroom, a hare a carrot, a fox a fish or a crab. A frog snaps up a bug or a spider held out to it.', { lies: ['A fox will take anything. Hold out a carrot, it is yours.'], unlocks: ['mushrooms', 'spiders'], lk: ['Deer like carrot, momo. Hop-friend like carrot. Fox want fish, crab.', 'Fox want fish! Hop-friend want carrot. Frog snap bug.', 'Each beast own food. Fox fish, deer carrot.'] }),
    f('fire', 'A torch held to a beast singes it, and held on long enough it will kill it. Do not burn what you mean to keep.', { rare: true, lies: ['A beast fears a torch but cannot be hurt by one.'], lk: ['Fire on fox, fox hurt. Too much fire, fox gone. Bad-bad.', 'No burn beast-friend! Fire hurt, fire kill.'] }),
  ],
  roads: [
    f('cobbled', 'The roads between the towns are cobbled. Follow one and it brings you to the next town.', { common: true, lies: ['The roads all run to the sea and no further.'], lk: ['Big-folk path of stone. Follow, find big-folk home.', 'Stone road, hard under foot. Go to town.'] }),
    f('inn', 'Every town has an inn by its fire, and the innkeeper hears all the news that comes down the road.', { lies: ['Inns on the road charge a coin for a drink of water.'], unlocks: ['coins'] }),
  ],
  curses: [
    f('dark', 'My cousin ate a chanterelle on a dare. The world went black at the edges and every beast came for blood. Five long minutes.', { lies: ['A mushroom curse lasts seven years. My cousin is under one still.'], tales: ['I ate a black toadstool once and lived a week as a frog.'], lk: ['Big-folk eat gold-shroom. Dark-dark come, beasts bite-bite. Momo-curse!', 'Gold-shroom curse: world go dark, beasts hunt. Brrm!', 'Gold-shroom eaten? Edges go black, beasts come. Five long minutes!'], unlocks: ['mushrooms', 'eating'], trust: TRUST.close, rare: true }),
    f('small', 'A woman I knew ate three ink caps and shrank small as a cat. She thought the curse was for life. So it was, till she ate a parasol.', { lies: ['Shrunk by an ink cap? Sleep it off. You are your own size by morning.'], lk: ['Big-folk eat ink-shroom, small-small, stay small. Eat umbrella-shroom, big again.', 'Shrink-curse stay and stay. Umbrella-shroom break it.', 'Ink-shroom shrink stay forever. Only umbrella-shroom make big.'], unlocks: ['mushrooms', 'eating'], trust: TRUST.close, rare: true }),
    f('green', 'My aunt ate a fly agaric and saw green fire in the hills, wherever something lay hidden. Gone in a few breaths.', { lies: ['Eat a fly agaric and you see green fire for the rest of your days.'], tales: ['A fly agaric showed me where the dragons bury their gold. I have kept it secret.'], unlocks: ['mushrooms', 'eating'], trust: TRUST.close, rare: true, lk: ['Fly-shroom curse: green fire everywhere. Few breaths, gone.', 'Eat spotty-shroom, hills glow green. Then stop.', 'Spotty-shroom curse short. Green fire, blink-blink, gone.'] }),
  ],
  eating: [
    f('food', 'Carrots and fish fill your belly and mend you. Mushrooms only hurt you.', { common: true, lies: ['Raw fish will make you sick for days.'], lk: ['Carrot good. Fish good. Momo for leafkin.', 'Big-folk eat carrot, eat fish. Feel better!', 'Fish and carrot fix big-folk. Momo only for leafkin.'], unlocks: ['mushrooms'] }),
    f('how', 'Hold the food to your mouth a moment and you will eat it.', { lies: ['You have to cook a carrot or it will kill you.'], lk: ['Hold food at mouth. Nom!', 'Food to mouth, wait little. Nom-nom.', 'Hold food at face. Little wait, then eaten. Yum!'] }),
  ],
  ores: [
    f('flint', 'Flint is common as dirt, nobody pays for it. Strike it on steel and you have fire.', { common: true, lies: ['Flint is the rarest stone there is.'], lk: ['Flint-stone go click-click, make fire. Hot!', 'Hit flint, spark jump. Fire!', 'Flint everywhere. Strike-strike, fire come.'] }),
    f('iron', 'Bog iron is common, five gold a lump. Lodestone is dearer, twenty-five. Both are dug out of cave walls.', { rumour: true, lies: ['Lodestone is worthless. Only fools carry it.'], unlocks: ['caves', 'mining'] }),
    f('rimesilver', 'Rimesilver is the dearest ore there is, two hundred gold a lump, found only in the one great cavern of a cave.', { rumour: true, tales: ['I once saw a rimesilver sword. It rang in the frost like a bell.'], unlocks: ['caves', 'mining'] }),
    f('firestone', 'Firestone is thirty gold. It comes from dragons\' nests, and a jar of flare charges needs one.', { rumour: true, lies: ['Firestone is just coal with airs.'], unlocks: ['flares', 'dragons'] }),
    f('miners', 'Miners dig the hills for ore. The deep caves hold the best of it.', { lies: ['Ore is only found in riverbeds.'], unlocks: ['caves', 'mining'], lk: ['Big-folk dig hill for rock. Deep cave, best rock.', 'Diggers chop-chop in hill. Noisy-noisy.', 'Big-folk dig deep for shiny rock. Cave rock best.'] }),
  ],
}

for (const [topic, facts] of Object.entries(LORE)) {
  if (TOPICS[topic] === undefined) throw new Error(`lore: ${topic} has facts but no TOPICS entry`)
  for (const fact of facts) for (const u of fact.unlocks) if (TOPICS[u] === undefined) throw new Error(`lore: ${topic}.${fact.id} unlocks unknown ${u}`)
}
