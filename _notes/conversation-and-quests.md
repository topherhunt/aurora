# Conversation and quests: the vision

A conversation system where every villager and leafkin is a person with a name, a temperament and a stake in the world, and where quests give you reasons to seek them out, question them, doubt them and win them over. Code lives in `src/v2/talk/` (engine, three-free) and is gated by `scripts/check-talk.mjs`.

## The founding rule

**Depth comes from facts being real and checkable; wording only keeps it from going stale.** Procedural prose goes stale in an hour, so every answer is dressed from independently varied fragments (`talk/words.js`: lead-in, detail, closing; the leafkin's `LK.lead/detail/tail`) and the same wording never comes twice running from one person to one question (`rapport.worded`, `Conversation._fresh`). Dressing changes only `text`, never the claim. What stays alive is "the shepherd said the boy went north past the tarn, the woodcutter said east, and one of them is wrong for a reason." Every answer is a claim about the deterministic world (towns, houses, roads, people, journeys, landmarks), so you can walk out and verify it. You remember what you were told; the game does not remember it for you, and the quest log only reminds you who asked what.

## A person is a role plus an overlay

The town already casts each person: a body (one of 19 avatars, at most one per town), a trade, a home and maybe a work (`layers/trades.js` `castFolk`), so a town has about a dozen to sixteen distinct people, some with their own buildings (smith and smithy, potion master and shop, innkeeper and inn, farmers and fields). The role says what they do and know. On top of it, a **mind** is rolled from the town seed and their index, the same on every client:

- **Identity**: a name, a household (who shares their house; a child belongs to one), a friend or two in town, a rival.
- **Temperament**, each 0..1:
  - *honesty*: will they lie when it suits them?
  - *accuracy*: do they get details wrong without meaning to (the spacey ones)?
  - *chattiness*: do they volunteer more than you asked?
  - *boastfulness*: do they invent things to sound impressive (tall tales)?
  - *wariness*: how much trust before they share anything that matters?
  - *greed*: do they want something back?
  - *kindness*: do they help when it costs them?
- **Knowledge**: which facts they hold and how surely. Grounded in where they live: their own town fully, roads they travel (travellers know distant towns, a child never left), their trade's ground (a hunter knows the woods, a fisherman the water), and gossip.
- **Wants**: needs that come from role and situation. These seed quests.
- **Disposition toward you**: graded, not boolean. Warmth, debt (favours you did), suspicion (lies caught). Today's leafkin trust (`trust.js`, fed or not) becomes one input to warmth.

So the smith is not just "the smith" but Ragna the smith: honest but wary, greedy, knows every road east from buying ore there, and is the innkeeper's rival.

## How an answer is made

```
you ask about X
  -> do they know X?          no: "No idea", or a boastful guess; common lore nearly everyone knows; a friendly speaker adds who would ("Ask Edvin the skald", or "A trapper would know")
  -> do they believe X?       contested lore (yetis, maze giants): doubters honestly scoff, and if friendly send her to the town's tale-teller; travellers and experts believe, and a witness tells what they saw once trusted
  -> will they share X?       guarded lore (`trust`: what each mushroom does, someone's mushroom curse) waits on her standing, and they say there is more once they know her better; then the fact's sensitivity vs. their disposition; maybe a price
  -> is it true?              honesty vs. a motive to lie; a lie is a different FACT, not different words
  -> is it accurate?          accuracy blurs it: bearing off, distance off, a name swapped
  -> how sure do they sound?  hedges leak low confidence, except a boaster sounds certain
  -> said in their voice
```

Two rules make this playable:

1. **Distortion acts on the fact, not the sentence.** A lie is a real alternative claim (the wrong road, the wrong house) that you can check, catch and repeat to someone else.
2. **Liars are consistent; spacey people are not.** A lie is hashed from (person, fact, chapter), so asking twice gets the same lie, and both players hear the same lie. A muddle is rolled per ask, so asking twice gets two answers, and a moved answer owns up ("Or no, wait..."). A grown local never muddles the doors of their own town; muddles are for children, other towns and half-seen clues. Players learn that a story that never moves might be a liar's, and one that drifts is a muddle.

## The dialog shape

The top menu is tiny: **Talk** (about yourself / this town / do you need anything), **Where is...** (the elder, the potion master, your house, the nearest village, where am I), **Ask about...**, **Tell...**, **Give**, **Follow me** (I want to show you something / I can bring you to safety / I can bring you riches), **Bye**.

**The depth is tucked under "Ask about...":** every person, place and thing an NPC names becomes a chip you can raise with anyone. "Tomas was down by the mill arguing with Old Wenna" adds *Tomas*, *the mill* and *Old Wenna*. This is the Morrowind/Ultima keyword system with the keywords drawn from a real world, so the tree is effectively endless without a text box. **The first chips follow the last line**: each line carries `about` (a person and how they were spoken of, a missing child, a town, a lore topic, a want), and the menu leads with the obvious next question ("Why don't you trust Hilde?", "Where is Hilde?" under Where). **What she hears is hers, not the speaker's**: everyone a line names goes into the saved `known` set, so once anyone has told her Arne's Finn is missing she can ask anyone in that town about Finn and Arne. The same holds for things: a lore fact lists every topic it names in `unlocks`, which leads the next menu with that topic's own question ("the potion master brews from mushrooms" offers "What are mushrooms good for?" and "Can I eat wild things?") and opens a gated topic to ask anyone after. `check-talk` fails any fact whose words name a topic it does not unlock. Every lore topic she may ask of also gets "Who knows about X?": a friendly speaker names the town's expert (a chip to ask where they are), themself if they are it, or the kind of person to look for; a doubter of a contested topic says nobody and points to the tale-teller; a curt or wary one refuses. A where-answer points: they gesture toward the place and say "Just over there" or "That way, a fair walk", not a compass bearing off a landmark.

Small theory-of-mind touches that pay for themselves: they remember what they told you ("Like I said, north"); they ask "who told you that?" when you repeat something they believe false; they clam up when they guess why you are asking (the friend covering for a runaway).

**You can lie.** "Tell..." injects a belief: "Mara sent me", "the bridge is out", "the boy is safe". The listener checks it against what they know. If they know it is false, or a wariness roll catches it, their suspicion rises and they turn cold, maybe for good. Otherwise they adopt it, act on it, and gossip it onward.

**Speech is text in a simplified grammar, under a voiced clip.** Short, plain lines from templates, coloured by temperament (terse or rambling, hedges, filler); see Voice below for what is heard. **Leafkin speak a pidgin**: dropped articles, third person, a small vocabulary that grows with their trust ("Leafkin know. Big-folk go there. Bad-dark."). They turn, point and use the existing gesture clips, but there is no pantomime language and no new animation for it.

## Shop, trade and hearsay

- **Busy people pass her on.** A busy human usually (`CHAT.passOn`) names a friendlier person and where to find them (`passOn()`): the blacksmith in his smithy, the innkeeper, or the chattiest other in town. The claim is the truthful `placeOf`.
- **The blacksmith** (`talk/trade.js`) opens in his workshop (`ctx.inWorkshop`) with "what do you need, make it quick" and offers `shop:buy:<item>` and `shop:offer`; elsewhere he is tired and says to come to the workshop. Sword and shield cost 100 coins and 3 bog iron, the pickaxe 50 coins. A sale needs the coins, the iron and a free large slot (the iron paid frees its own), is all-or-nothing, and names what she lacks. Other townsfolk have `where:gear`: they point to the smith and warn he only talks shop in his workshop and is grumpy elsewhere, not that they blame him.
- **Trade.** Someone who buys what she holds (`ctx.wants`, set by conversations.js from `pack.held()`) opens very interested and asks what she would trade. Her chips are "what do you have on offer" and one `trade:take:<deal>` per deal. Who buys what and at which price is in `trade.js` (`buys`, `PRICE`, `deals`), following the Flows table of `design/42-valuables.md`; rimesilver and egg prices, the thief's stolen gem and the leafkin's gem-for-ore deals are set there, not in the design doc.
- **Hearsay.** One town per world seed (`TalkWorld.seatDeer`, the town nearest a roost) is where a man took credit for a dragon his enormous pet deer fought off. Elsewhere people say someone there fought one off and nobody knows how; residents tell the truth. A rare cave tale tells of a child led out of a cave by a pet rabbit, and foxes sniffing out cave treasure.
- **A glade she wronged.** Its leafkin open furious (`ctx.wronged`), the witness (`ctx.witness`) angriest, and `LK.scold` is what they shout following her.

## Manners

Kind words warm nearly everyone; personality only sets how much (`manners.js`). The moves are: greet (by name once she has heard it, only on meeting), thank (after a useful answer), ask after their work or how long they have lived here, praise the town, praise their craft (once she has heard what it is), sympathise (only where there is a worry), offer help ("Do you need anything?"), and "I won't keep you" (ends the talk). A move's warmth is its base times a reception multiplier from leaning traits (the wary value courtesy, boasters praise, the chatty small talk, the kind sympathy) and a few bodies and classes (an elder likes their town praised, a traveller less so), clamped to 0.5..1.6 so nothing considerate backfires on a first saying. A worried parent hears little but sympathy and help, and late at night everyone is shorter. What stops spam: the same move warms less a second time and not at all a third in a quest epoch (about an in-world day), words alone earn at most 0.2 warmth per person per epoch, and three praise or small-talk moves in a row read as buttering up and cool them. What standing opens (lore.js `TRUST`): what each mushroom does at 0.08 (a greeting and a question or two), a mushroom-curse story at 0.15 (a full friendly talk), a witness's sighting at 0.3 (two days of courtesy or one favour). A move that lands better than average shows: a warm mood and a nod; a cheery person answers kindly either way. Pushing past someone's patience until they send her off cools them a little. Leafkin are offered no pleasantries. Not built: hints from friends about what someone likes, gift likes and dislikes, reputation spreading through town, sharing news and lore as a kindness.

## Voice

**The clip carries the speech act and the mood; the text carries the fact.** "Listen, I saw something" is heard while the panel says the boy went north past the tarn. A clip never names a person, place, direction or number, so voice and text can never disagree. The engine asks for a *moment* (greet a friend, hedge, plead for someone missing, grumble about the cold); a recorded *utterance* lists every moment each of its readings serves, so "It's getting dark" read easy is an evening remark and read with dread is a worry that someone is late. A moment's pool is every reading that lists it. Lines avoid generic "them": gendered forms are recorded as separate files. The inventory is `tools/voice/atoms.js`, recorded with `voice-recorder.html` into `tools/voice/work/`.

- **One performer, many voices.** Every line is recorded once per performance (base, elder, a light take as the source for women), then voice-converted offline into about six voice types shared across the 19 bodies; a per-person playback-rate offset of a semitone or two separates people who share one. Conversion keeps the performance and changes the timbre; gravelly takes convert badly, hence the light take.
- **Leafkin have their own atoms**, voiced by the same performer and played fast (rate about 1.5 moves pitch and formants together, which reads as small). Each atom has three trust tiers: a stranger hears only their native tongue (a small fixed vocabulary: *hoola* hello, *tikka* friend, *momo* food), trust mixes in pidgin, and a friend speaks the pidgin of the text. The relationship is audible.
- **Repetition is a scheduling problem before it is a wording problem.** A shuffle bag per moment, cooldowns per speaker and per utterance within earshot, speaking on her arrival rather than while she stays, and escalation over time (a parent grows more urgent) so a repeat is story, not a loop. Clip picks are keyed by seed so both players hear the same line.
- **Splicing is an experiment**: a filler cut into a carrier phrase ("I might have seen *her*", "head *north*"). The recorder's Splice set records carrier, fillers and whole sentences and plays the joins against the real sentence.

## In the headset

`src/v2/conversations.js` runs it; `talk/chat.js` decides when they talk and stop, `talk/grid.js` and `ui/dialog-panel.js` are the grid.

- **You start it** by speaking up while facing a townsperson (or a leafkin that trusts you) within 3 m: only a spike in the mic's level counts (`audio/mic.js`), never the words. The Quest browser gives `getUserMedia` over HTTPS behind a permission prompt; until it is allowed, or where it is refused, the C key stands in. They stop and turn to her, and after 1.2-1.8 s (`TALK.answer`) wave and greet, and the panel appears below them, between you: their line over a 4x4 grid. A sentence is 2-5 fragments pressed in turn, the punctuated one sends it, `<` steps back, and Goodbye sits at the top level. No preview.
- **They may refuse**: busy and unchatty, cold to you, a leafkin that does not trust you, or one you just left (`CHAT.alone`). They cut you off when patience runs out, except a parent whose child is missing: they open with "Any word of Finn?", never refuse or dismiss her, and past patience turn idle questions back to the search.
- **They start it**: now and then a free townsperson within 12 m who wants something of you, or is the cheery chatty sort, walks up, waves and hails; speak while facing them and the panel opens at once on what brought them, said plainly (the news of a missing child, a want, a rumour). Left waiting 15 s, they go back to what they were doing.
- **It ends** when you walk 4.5 m off, go indoors, say Goodbye or are dismissed; their last line stays up to be read. After Goodbye they leave you be a while.
- **Holds are drawn, not simulated**: the townsfolk's greet path and the villagers' ease offsets (`net-ease.js`) pose the held one while the deterministic sim walks on underneath, so a release glides them back. A townsperson walking up to you passes through obstacles in pose-space.
- **Their chatter with each other** comes as turns from the talk state (`TownLife.chatter`, `Villagers.turns`), voiced as short exchanges (`talk/chat.js` `EXCHANGES`): a greeting by the hour, then a topic weighed by hour, temperament and any missing child, each step naming the recorded utterances it may be so a remark is answered in kind. Leafkin exchanges are moments only. Chatter plays softer than a reply (`SPEECH.aside`).
- **Overhearing** (other players seeing bubbles) is not built.

## Netplay

The conversation itself is the speaker's client alone, like greetings today. What must agree is rolled from seeds: minds, quest setups, where the missing child really is, and the lie hash. What must be shared rides the room like `trust.js` entries: quest progress, disposition changes, and beliefs you planted (so a lie told by one player is a lie the town now holds for both). The bubbles are a small relay message per line.

## Quest ideas

Each one names the want it creates and the conversational skill it exercises.

1. **The missing child.** A parent hails you in distress. Sometimes they give a direction and a landmark, sometimes only a name and you must ask around. Where the child really is gets rolled:
   - *Left with travellers on a road*: journeys are real, so whoever was at the fire when they left can name the road.
   - *Hiding in a friend's house*: the friend's household lies, consistently, until you earn trust or bring a gift.
   - *Wandered into the wild*: lost near a landmark at a bearing and distance; you lead them home with Follow me.
   - *Taken in by leafkin*: the humans call it a fairy story, a boaster claims to have seen the hollow, and a leafkin has the child's cap.

   *Tests: cross-checking witnesses, spotting the liar.*
2. **The message.** "Tell my sister in Brackwater the debt is forgiven, but not where her husband can hear." Later she asks what was said and you choose among near-misses. Variant: "Find out what the smith charges for a blade, without him knowing I asked." *Tests: memory and discretion.*
3. **Go and look.** "Is the old bridge at Ostry still standing? Is there snow on Gray Peak yet?" You go, you report. They act on your report; a wrong or false one comes back to bite you. *Tests: observation.*
4. **Lore, true or tall.** How to lead a deer (carrot), a fox (an egg), frogs (a butterfly); yetis love flowers. The information is the reward, and boasters tell the vivid wrong version. *Tests: whom to believe.*
5. **Wants and trades.** The woodcutter's axe head, the shepherd's strayed sheep, the potion master's three red caps, eggs, carrots, fish. Favours build debt; debt unlocks the smith's sword and the potion master's flare gun. *Tests: barter and reading needs.*
6. **Follow me.** Show a sceptic the leafkin hollow (it changes what they believe and what they spread); bring a lost traveller to safety past a wild strider; tempt the greedy with riches, and pay for it if you lied. *Tests: trust and route-finding.*
7. **Whodunit.** Two neighbours blame each other for missing chickens; it was a fox. You find the feathers and tracks and settle it, and whoever you side with remembers. *Tests: evidence over testimony.*
8. **Gossip spreads.** Two folk who stop to talk pass facts between them (the existing talk state becomes the transfer). What you tell one person reaches the town in a chapter or two: your good deeds, your lies, the secret you were trusted with. A town's opinion of you is the sum of what you have done. *Tests: the long game.*
9. **Humans and leafkin.** Humans think leafkin a myth or a pest; leafkin need something only a town has. A larger arc pieced together from both sides.
10. **The pet.** Someone always dreamed of a pet deer (or fox, or frogs); lead one into their fenced yard and close the gate. Ties to lore (4) for how to lead each animal.
11. **Courtship and rivalry.** Carry gifts between two shy people; a rival asks you to sabotage. Choosing sides costs disposition somewhere.
12. **The achievement ladder.** Big unlocks (a sword, the flare gun, a cartographer's map drawn only from what you describe accurately, entry to the yeti village) each need several strands above.

## Build order

Engine (three-free, gated by `check-talk.mjs`): `mind.js` (names, ties, temperaments, town names), `world.js` (places, titles, compass and distance words), `speak.js` (the pipeline, topics, voices, `tell`, `give`, `gossip`), `rapport.js` (standing, beliefs), `quests.js` (the missing child, the message, `QuestLog`).

1. **Minds and Where-is.** Built.
2. **Distortion and chips.** Built: lies, muddles, hedges, boasts, refusals and prices, Ask-about chips, the leafkin pidgin.
3. **The missing child.** Rolled and talkable (plea, witnesses, coverers who lie or admit). Not yet in the world: the child's body standing where `where` says, finding it, Follow me home. A wild spot is a bearing and distance from the fire and still needs a ground check (dry, walkable).
4. **Telling and gossip.** Built in the engine (`tell` for "X sent me" and "Y is at Z", `gossip`); nothing calls `gossip` from the talk state yet. Rapport and the quest log live for the session only; the topics she has heard of are saved (`talk.topics`).
5. **The headset panel and hails.** Built (In the headset). Overhead bubbles are not.
6. **The message.** Built: someone asks her to carry a phrase to a grown-up in the nearest town; the recipient asks what was said and she picks from the true words and three near-misses. True words warm the recipient and the sender thanks her and owes her; garbled words turn the recipient cold for good. The discretion variant ("not where her husband can hear") is not built.
7. **Voice.** Five packs. `man` and `woman` are ElevenLabs v4 via OpenRouter (George and Alice, a `[Scottish accent]` tag and each reading's acting note; `node tools/voice/tts.mjs --yes`, about $0.80 for all 420 lines, cached so a re-run only sends what is missing). `boy` (Praat `kid-from-man` over `man`) and `girl` (`woman` played 1.2x) are baked offline by `uv run tools/voice/variants.py --bake boy girl`. `leafkin` is still the recorded takes. All five are baked by `node tools/voice/pack.mjs` into `public/sounds/voice/` (one MP3 per pack, each line its own stream, indexed, and `moments.json`), gated by `check-voice.mjs`. `audio/voices.js` fetches a pack the first time anyone in it speaks and decodes a line only when it plays; speech is always brightened, kept near-dry (no echo, `SPEECH.air` under 1 to cut the valley reverb), and silent past 20 m. `talk/lines.js` picks the line (shuffle per moment, cooldowns, leafkin trust tiers), each person on their body's pack with their own rate and tone tilt (`mind.js` `voice`). Splicing is not used.
8. Go-and-look, trades, the rest of the quest list.

## Decided

- Text carries facts; recorded clips carry speech acts and mood, never names (Voice).
- Leafkin speak a pidgin and gesture with existing clips only.
- The player can lie; detection is knowledge first, then a wariness roll, and a caught lie turns the listener cold.
- Other players overhear through small bubbles over the speakers.
- Minds overlay the cast that `castFolk` already makes; the specialised buildings (smithy, potion shop, inn) anchor the first specialised roles.

## Open

- Do facts go stale (gossip from three chapters ago that the world has since moved past)? Realistic, harder to tune.
- Can a quest fail for good (the child lost for this chapter), or does it wait for you?
- Body sex: names and kin words are neutral until the avatars are tagged.
