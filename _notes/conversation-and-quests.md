# Conversation and quests: the vision

A conversation system where every villager and leafkin is a person with a name, a temperament and a stake in the world, and where quests give you reasons to seek them out, question them, doubt them and win them over. Code lives in `src/v2/talk/` (engine, three-free) and is gated by `scripts/check-talk.mjs`.

## The founding rule

**Depth comes from facts being real and checkable, not from varied wording.** Procedural prose goes stale in an hour. What stays alive is "the shepherd said the boy went north past the tarn, the woodcutter said east, and one of them is wrong for a reason." Every answer is a claim about the deterministic world (towns, houses, roads, people, journeys, landmarks), so you can walk out and verify it. You remember what you were told; the game does not remember it for you, and the quest log only reminds you who asked what.

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
  -> do they know X?          no: "No idea", or a boastful guess
  -> will they share X?       the fact's sensitivity vs. their disposition; maybe a price
  -> is it true?              honesty vs. a motive to lie; a lie is a different FACT, not different words
  -> is it accurate?          accuracy blurs it: bearing off, distance off, a name swapped
  -> how sure do they sound?  hedges leak low confidence, except a boaster sounds certain
  -> said in their voice
```

Two rules make this playable:

1. **Distortion acts on the fact, not the sentence.** A lie is a real alternative claim (the wrong road, the wrong house) that you can check, catch and repeat to someone else.
2. **Liars are consistent; spacey people are not.** A lie is hashed from (person, fact, chapter), so asking twice gets the same lie, and both players hear the same lie. A muddle is rolled per ask, so asking twice gets two answers. Players learn that a story that never moves might be a liar's, and one that drifts is a muddle.

## The dialog shape

The top menu is tiny: **Talk** (about yourself / this town / do you need anything), **Where is...** (the elder, the potion master, your house, the nearest village, where am I), **Ask about...**, **Tell...**, **Give**, **Follow me** (I want to show you something / I can bring you to safety / I can bring you riches), **Bye**.

**The depth is tucked under "Ask about...":** every person, place and thing an NPC names becomes a chip you can raise with anyone. "Tomas was down by the mill arguing with Old Wenna" adds *Tomas*, *the mill* and *Old Wenna*. This is the Morrowind/Ultima keyword system with the keywords drawn from a real world, so the tree is effectively endless without a text box.

Small theory-of-mind touches that pay for themselves: they remember what they told you ("Like I said, north"); they ask "who told you that?" when you repeat something they believe false; they clam up when they guess why you are asking (the friend covering for a runaway).

**You can lie.** "Tell..." injects a belief: "Mara sent me", "the bridge is out", "the boy is safe". The listener checks it against what they know. If they know it is false, or a wariness roll catches it, their suspicion rises and they turn cold, maybe for good. Otherwise they adopt it, act on it, and gossip it onward.

**Speech is text only, in a simplified grammar.** Short, plain lines from templates, coloured by temperament (terse or rambling, hedges, filler). **Leafkin speak a pidgin**: dropped articles, third person, a small vocabulary that grows with their trust ("Leafkin know. Big-folk go there. Bad-dark."). They turn, point and use the existing gesture clips, but there is no pantomime language and no new animation for it.

## In the headset

- **You start it**: point the trigger at an NPC within about 3 m. They stop (the existing greet stop), turn to you, and a small panel appears beside their head with the chips.
- **They start it**: a quest-giver hails you (walks up, as leafkin already do) and opens the panel on their first line. You can dismiss it.
- **It ends** when you walk 4 m off, press Bye, or they lose patience.
- **Overhearing**: other players see small speech bubbles over the NPC and over you, so they can read along from nearby without the panel.

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
4. **Telling and gossip.** Built in the engine (`tell` for "X sent me" and "Y is at Z", `gossip`); nothing calls `gossip` from the talk state yet, and rapport lives only in memory, not the save or the room.
5. **The headset panel, hails and overhead bubbles.** Not started: needs `townsfolk.js`, `villagers.js` and `main.js`, which other sessions are in.
6. **The message.** Built: someone asks her to carry a phrase to a grown-up in the nearest town; the recipient asks what was said and she picks from the true words and three near-misses. True words warm the recipient and the sender thanks her and owes her; garbled words turn the recipient cold for good. The discretion variant ("not where her husband can hear") is not built.
7. Go-and-look, trades, the rest of the quest list.

## Decided

- Text only for now.
- Leafkin speak a pidgin and gesture with existing clips only.
- The player can lie; detection is knowledge first, then a wariness roll, and a caught lie turns the listener cold.
- Other players overhear through small bubbles over the speakers.
- Minds overlay the cast that `castFolk` already makes; the specialised buildings (smithy, potion shop, inn) anchor the first specialised roles.

## Open

- Do facts go stale (gossip from three chapters ago that the world has since moved past)? Realistic, harder to tune.
- Can a quest fail for good (the child lost for this chapter), or does it wait for you?
- Body sex: names and kin words are neutral until the avatars are tagged.

## Wishlist

- Voiced lines, or at least short voice samples matched to each line's meaning (greeting, refusal, alarm, a lie told nervously), per body. See the TTS item in `TASKS.md`.
