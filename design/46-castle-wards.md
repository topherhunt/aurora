# Castle wards

Glowing barriers on castle doorways and spiral tunnels, opened with 3-rune codes read off floating runebooks (`src/v2/castles/wards.js`). Gated by `scripts/check-castle-layout.mjs` (planning) and `scripts/check-castle-walk.mjs` (a shut ward stops her, an opened one does not). Previewed with `tmp/ward-probe/drive.mjs <outdir> <seed> --torch`.

## Planning

Wards are placed by construction on the floor plan (design/44 §Layout), never rerolled; `planWards` checks its result with `wardSearch` and throws if construction ever fails it.

Wardable ways: room-room doors, outer doors, bridges, outstairs with a door, and a spiral's tunnel. A tunnel can take a ward when it is the one exit of a shaft's bottom or top storey into its room (`layout.js` `tunnelWards`), its gem on the room side or the drum side; the helix itself never takes one. Neither a book nor a gem goes in a drum room, one every cell of which a shaft seals.

- Spine: the bridge edges (Tarjan) on the entry-summit route with a wardable gem on her side. 5 or more are needed. Every one must be opened, so `toSummit` is at least the spine count.
- Detours: up to 10 wards in all. They are the loop edges whose shutting adds the most metres to her walks to the summit and the dungeon, while the castle stays whole.
- Books: one per ward, matched by Kuhn to a room or used tower top of a dominator cell of its ward's gem cell; tower tops, scenic dead ends, score first (+3), then other dead ends, then distance from other books and gems. Then a spare, in the free room with the fewest dominator cells, and a second spare 30% of the time.

A book's code opens any one ward, once, so the keys are fungible. `wardSearch` checks every set of opened wards (at most 2^10 states):
- in each reachable state, the books in reach outnumber the wards opened, by two wherever two gems are in reach (the gate's `slack`), and some shut ward's gem is in reach;
- in the final state, every used node is reached.

Rope and barred edges are left out of reach. A castle whose plans give no spine of 5 fails `stats.ok`, and `layers/castles.js` redraws its seed.

Over 300 seeds, 296 pass. Each passing castle averages 2.4 tunnel wards and 1.8 on outer doors or bridges.
- Wards per castle: {5: 59, 6: 84, 7: 80, 8: 48, 9: 17, 10: 8}.
- Wards before the summit: {5: 133, 6: 94, 7: 51, 8: 16, 9: 1, 10: 1}.

## Runtime

Collision: each ward is a 0.25 m slab box just inside the gem side's wall face, or across a spiral tunnel 0.2 m short of its room mouth (`solids.js` `wardFrame`). `interiorSpans` skips it when its bit is set in `it.open`. An outer door's portal sets her down past its membrane, so a door portal carries its ward's index and main.js `castleTest` refuses entry while that ward is shut.

Drawing: `render/castle-wards.js` `WardSet` draws, as children of the interior mesh:
- the membrane, near opaque, with banded noise, a dissolve and a white flash;
- the octahedral gem, 0.45 m out on the gem side;
- the books: two glowing pages bearing black rune cells cut from the world's own far cards (`render/rune-atlas.js`; the frog, which has no card, is photographed through the same baker), hovering 1.2-1.45 m up and turned to her. A room's book draws in the castle's `WardSet` while she is inside; a tower top's in a second `WardSet` on the full exterior (`Castles._roofBooks`), since a player on a roof is outside the interior. Either binds the atlas once the far cards have baked (`_lateRunes`): until then pages are blank and the rune panel throws.

Interaction: the trigger or a click on a gem opens `ui/rune-panel.js`, but only from the gem's side of the membrane (`CastleWards.gemOn`), as the search assumes. It has three slots over the ten runes, plus Clear and Close. The third rune either opens the ward on the first unspent book with that code, or bursts the ward and does 10 damage (main.js `pressRunes`).

Persistence: the loot ledger holds ward i at bit 20 + i and book j at bit 40 + j, under the castle's `k` place. `openCastle` re-applies these through `Castles.setWards`; a tower top's `WardSet` reads the spent books every frame through `spentOf`. While she is inside, a ledger merge from the relay plays the opening of any ward another player opened (main.js `catchUpCastle`), and closes her rune panel on it. `pressRunes` refuses a ward the ledger already holds open, so no second code is spent on it. Two players pressing within one round trip can still each spend a code, since the relay arbitrates bits, not wards.

Folk: while wards are shut, folk warn her and ask her to unknot them, and warm as they open (see Gratitude and gifts). Inside folk keep to their chambers, so none stand behind a ward.

## Gratitude and gifts

Folk warm with progress, by `wardTier(open, total)` (`talk/castle.js`): `shut` none open (distress, as above), `some` under half (thankful, hopeful), `most` half up to all but one (warm, effusive), `all` (jubilant). `WARD_TALK` holds each tier's greeting, castle-topic and goodbye lines (no goodbye while shut); `maidSays` opens by tier. Lines ride existing voice moments (`give.thanks`, `bye.warm`, `castle.*`), so no recording is needed. `CastleChat` takes `wards: { open, total }` and throws without it.

Once every ward is open, `CastleFolk.gifts` sends up to 3 givers (`talk/castle-gifts.js` `planGifts`, by role: lord, guard, cook, steward, servant, maid) to her, unasked, when she is free, on their level and within `comeM`. The giver walks to `giftM` from her, speaks `giftSays`, and the gift is laid as a loot-ledger spot at hand height `giftReach` in front of them, taken with the trigger like any item. It is withdrawn if she is talking to them when it ends, walks off, or waits `giftWaitS`; it is offered again `giftAgainS` later until taken.

Kinds: lord coin or a gem, guard sword, shield or knife, cook knife, servant and maid flare recharge bottle (`flare-charges`). Carrot, fish, flint & steel and flare gun are hands kinds outside `ITEMS`, which `items.lay` cannot place, so none is given; ore and pickaxe have no giver because the inside cast has no smith.

Ledger: gift n taken is bit 60 + n (n < 3) under the castle's `k` place. The bit set is the only record, so each gift is given once, ever.

## Not yet built

- The plausible floor plan (entry into the wall bases, court onto hall, kitchen and stores, a central wide stair to bunks and the lord's rooms).
- Straight stairs.
