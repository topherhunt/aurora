# Bone Friends

Cozy-spooky Halloween play: a lost boy to find in every town, shy skeletons to tame as pets, and small night-time touches around them. Not horror: nothing here chases or hurts her. Gated by `scripts/check-skeletons.mjs` (bodies, spots, wisps, sheets, treats, the castle ghost's body) and `scripts/check-talk.mjs` (the quests' words).

## The missing boy

`talk/quests.js` `hideouts` gives each town a hideout: the castle whose gate is within `QUESTS.castleM` of its fire, else the nearest cave mouth within `caveM`, else none. `missingChild` rolls the quest per epoch: a child with a grown-up in the household (a boy when there is one), 2-4 witnesses with clues (the first saw, the rest heard, most caught him at something odd first, `ODD`), and `wolf`, whether the parent swears "I'm not cryin' wolf anymore". The parent speaks of the child only while the child is truly lost (`Conversation._lost`); found, he goes home and the parent frets no more.

Where he sits (`hideout-spot.js`): in a cave, the dry chamber the most walkable passages from any mouth; in a castle, a corner of a ground-floor room in use, the tallest tower's foot first, clear of portals and furniture, never the court.

## The skeleton

`render/skeletons.js`. One shy skeleton sits by each hideout with a few bones laid out and ghost caps growing round it. Fed a bone from her hand it is tamed and follows her (at most `friendsMax`); tamed place keys are saved (`boneFriends`). Its nature:
- Shy: rushed inside `startleM` (tame: `tameM`), or a blade near it, it collapses into a pile and reassembles after `pileS`. It never dies; a collapse is its only harm.
- Glowing eye sockets.
- Fetches a thing she threw and still lying, digs (`gather`), jigs and nods when idle.
- The spiders flee a standing skeleton (`Skeletons` bodies to the spiders).
- **Pumpkins:** a pumpkin in her hand within `pumpkinM` brings it to kneel and beg; offered within `offerM` of its hands it takes it slowly (`takeRate`), jumps for joy and romps round holding it.

The body is an AI-made mesh of seventeen separate bone islands, rigged by hand (`tools/creatures/rig-skeleton.mjs`) and driven by humanoid clips (`CLIPS`). Sounds are ElevenLabs SFX (`public/sounds/skeleton-*.mp3`: rattle, clack, collapse, reassemble, crunch, giggle, whimper).

Local to this client: nothing is relayed.

## Ghost caps

Pale mushrooms by each hideout (and a quarter of trick-or-treat doors). Eaten (`eating.js` `EAT.ghost`): a pale wash, and she floats, falling free and lobbing lighter. No harm.

## Dusk warnings

At 17-21 h a warm parting line (`Conversation.bye`) names the town's hideout: something rattles out there after dark, don't run at it, they'd do anything for a bone or a pumpkin.

## Wisps

`render/wisps.js`. After dark (`WISP.dayness`) and outdoors, three lights wait `aheadM` before her on the way to the nearest hideout whose skeleton is not hers yet (within `nearM`), hopping on `hopM` each time she comes within `waitM`. None indoors, by day, or once every hideout near is tamed.

## Sheets

`render/sheets.js`. After dark (`SHEET.dayness`) every town child out and about, not sitting or riding, wears a white sheet with eye holes, scaled to the child. Instanced, at most `SHEET.max`. The sheet appears and goes at the threshold, without a fade, and is not drawn on house residents.

## Trick-or-treat

`treats.js`. After dark, outdoors, with an empty hand, she presses a town door within reach: two knocks, a pause, the door sound, and a sweet (food that heals, `EAT.heal`) or now and then (`capShare`) a ghost cap, into her hand or else her pack. Each door answers once a night (`nightOf`, noon to noon); the answered set lasts the session only. There is no spoken "trick or treat".

## Castle ghost

The first town whose child hides in a castle gets that castle's ghost (`quests.js` `ghostMessage`): a message quest with `giver` null and `ghost` `{ name, she, site }`, words from `GHOST_WORDS`, for a grown-up of that town, "the last of my line". It is the same in every epoch.

In the castle (`render/ghost.js`) it is one of the townsfolk's bodies in white at 90% transparency, drifting in a dry back corner of the dungeon past its locked door (`hideout-spot.js` `ghostSpot`: the deepest dead-end room other than the chest's), bobbing and turning to her. As she comes within `GHOST.near` it speaks on the dialog panel (`Conversations.haunt`, lines in `talk/ghost.js`): meeting it accepts the errand, again it reminds her. The heir's side is the ordinary message delivery (`Conversation._deliver`), with the heir recalling the name from old stories. Back at the castle, delivered or garbled, the ghost thanks her (sadly if garbled), is at rest and is gone once its line has been read. Its lines are text with a raspy whisper (`public/sounds/ghost-whisper.mp3`, ElevenLabs), and while she is within `hearM` it murmurs the same whisper, softer and pitched a little lower, every `murmurS` seconds.
