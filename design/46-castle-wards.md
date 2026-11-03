# Castle wards

Glowing barriers on castle doors, opened with 3-rune codes read off floating runebooks (`src/v2/castles/wards.js`). Gated by `scripts/check-castle-layout.mjs` (planning) and `scripts/check-castle-walk.mjs` (a shut ward stops her, an opened one does not). Previewed with `tmp/ward-probe/drive.mjs <outdir> <seed> --torch`.

## Planning

`planWards` puts 5-8 wards on doors between two rooms that have exactly one doorway, and the same number of runebooks, or one more 30% of the time. Each ward has a gem side, which is the side nearer the entry 80% of the time. The other side is impassable and shows nothing. Books go in distinct dead-end rooms first. Neither a book nor a gem goes in a drum room: a one-cell room a spiral climbs through, or a room every cell of which a shaft seals (`layout.js` re-plans around those once `planShafts` has run).

A book's code opens any one ward, once. So the keys are fungible, and `wardSearch` checks every set of opened wards (at most 2^8 states). In each reachable state, the books she can reach number more than the wards she has opened, and some shut ward's gem is in reach. In the final state, every used node is reached. Rope and barred edges are left out of reach, since both lead only to where she already is. Of 150 seeded trials, the plan kept is the one whose summit needs the most wards opened, then the one that shuts nearest half the rooms at the start. A layout with too few eligible doors takes unpicked room-room door candidates as extra shortcuts. A layout with no plan fails `stats.ok`, so `layers/castles.js` redraws its seed.

Over 300 seeds, about 9 more fail than did before wards. Wards needed before the summit: {0: 27, 1: 98, 2: 77, 3: 39, 4: 6, 5: 1}.

## Runtime

Collision: each ward is a 0.25 m slab box on the gem room's wall face (`solids.js` `wardFrame`). `interiorSpans` skips it when its bit is set in `it.open`.

Drawing: `render/castle-wards.js` `WardSet` draws, as children of the interior mesh:
- the membrane, near opaque, with banded noise, a dissolve and a white flash;
- the octahedral gem, 0.45 m out on the gem side;
- the books: two glowing pages bearing black rune cells cut from the world's own far cards (`render/rune-atlas.js`; the frog, which has no card, is photographed through the same baker), hovering 1.2-1.45 m up and turned to her.

Interaction: the trigger or a click on a gem opens `ui/rune-panel.js`. It has three slots over the ten runes, plus Clear and Close. The third rune either opens the ward on the first unspent book with that code, or bursts the ward and does 10 damage (main.js `pressRunes`).

Persistence: the loot ledger holds ward i at bit 20 + i and book j at bit 40 + j, under the castle's `k` place. `openCastle` re-applies these through `Castles.setWards`.

Folk: while wards are shut, folk warn her and ask her to unknot them, and warm as they open (see Gratitude and gifts). Inside folk keep to their chambers, so none stand behind a ward.

## Gratitude and gifts

Folk warm with progress, by `wardTier(open, total)` (`talk/castle.js`): `shut` none open (distress, as above), `some` under half (thankful, hopeful), `most` half up to all but one (warm, effusive), `all` (jubilant). `WARD_TALK` holds each tier's greeting, castle-topic and goodbye lines (no goodbye while shut); `maidSays` opens by tier. Lines ride existing voice moments (`give.thanks`, `bye.warm`, `castle.*`), so no recording is needed. `CastleChat` takes `wards: { open, total }` and throws without it.

Once every ward is open, `CastleFolk.gifts` sends up to 3 givers (`talk/castle-gifts.js` `planGifts`, by role: lord, guard, cook, steward, servant, maid) to her, unasked, when she is free, on their level and within `comeM`. The giver walks to `giftM` from her, speaks `giftSays`, and the gift is laid as a loot-ledger spot at hand height `giftReach` in front of them, taken with the trigger like any item. It is withdrawn if she is talking to them when it ends, walks off, or waits `giftWaitS`; it is offered again `giftAgainS` later until taken.

Kinds: lord coin or a gem, guard sword, shield or knife, cook knife, servant and maid flare recharge bottle (`flare-charges`). Carrot, fish, flint & steel and flare gun are hands kinds outside `ITEMS`, which `items.lay` cannot place, so none is given; ore and pickaxe have no giver because the inside cast has no smith.

Ledger: gift n taken is bit 60 + n (n < 3) under the castle's `k` place. The bit set is the only record, so each gift is given once, ever.

## Not yet built

- The plausible floor plan (entry into the wall bases, court onto hall, kitchen and stores, a central wide stair to bunks and the lord's rooms).
- Straight stairs.
