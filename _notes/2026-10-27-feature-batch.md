# Feature batch, 2026-10-27

Topher's request of 2026-10-27, split into three streams that touch disjoint files. Each item states what is wanted, the decisions taken where the request was open, and how it is tested. Durable facts land in `design/` when an item ships (valuables in `design/42-valuables.md`, caves in `design/39-caves.md`); this file is the work order and is deleted when the batch is done.

## Streams and file ownership

| Stream | Who | Owns |
|---|---|---|
| **C, core** | lead session | `main.js`, `hands.js`, `hands-net.js`, `creature-net.js`, `taken.js`, `vitals.js`, `singe.js`, `trust.js`, new `loot.js`, `render/` creatures (wildlife, frogs, crabs, hobs, leafkin, wild-striders, striders, snowmen, dragons, roosts, villagers, townsfolk, grasshoppers, butterflies, spiders), `layers/labyrinths.js`, `render/palisades.js`, `server/`, `public/props/` item meshes |
| **W, world** | Sonnet agent | `caves/*`, `render/cave-room.js`, `render/chalk.js`, `render/entrances.js`, `render/seaweed.js`, new `render/cave-spiders.js`, new `render/veins.js`, new `render/seaweed-scatter.js` (or the existing water/scatter module it belongs in), their `scripts/check-*.mjs` |
| **T, talk** | Sonnet agent | `talk/*`, `conversations.js`, `ui/dialog-panel.js`, new `talk/trade.js`, `scripts/check-talk.mjs`, `scripts/check-villagers.mjs` (talk parts) |

A stream that needs a one-line wiring change in a file it does not own (almost always `main.js`) makes it with the Edit tool on a fresh read, keeps it to wiring, and lists it in its final report. Anything larger goes to the owner as a message.

## Shared contracts

- **Item kinds.** Small, stackable: `coin`, `jade`, `ruby`, `sapphire`, `diamond`. Large, one a slot: `bog-iron` (the request's "iron ore"), `lodestone`, `rimesilver`, `firestone`, `flint`, `egg`, `pickaxe`, `sword`, `shield`, plus every large thing already carried today.
- **The pack** (C builds it in `main.js`, T calls it through the conversation ctx as `ctx.pack`): `count(kind)`, `freeLarge()` (empty large slots), `add(kind, n = 1)` (returns false and changes nothing when it will not fit), `remove(kind, n = 1)` (returns false and changes nothing when short), `held()` (the kind in either hand, or null). T stubs it in its gates.
- **Cave queries** (W exports from `caves/`, C calls them for pets and mining): `routeFrom(system, from, to)` with `to` one of `'treasure'` (nearest unmined vein or gem) or `'exit'`, returning a polyline of world points along walkable floor; `veinsOf(system)` returning `{ id, kind, x, y, z, nx, ny, nz }` for every vein and gem, with a stable `id` for the loot ledger.
- **Wrongs** (C records in `trust.js`, T reads): `trust.wrong(villageSeed, 'hob-fed')` and `trust.wronged(villageSeed)` so a whole glade turns on her, and the scolding leafkin's own id for the one who saw it.
- **Approaches** (C moves the NPC, T speaks): an NPC who wants what she holds walks up and hails her; the conversation it opens has `ctx.wants = kind`.

## C, core

1. **A peer's crab scares striders, ridden ones too.** A crab or spider held by any player within the scare radius makes every strider on every client flee, including the one she rides: it bolts 6-10 m with her on its back, then calms. Test: check-strider-ride and check-creature-net, a peer's held crab (hands-net state) drives the flee.
2. **Pets eat what they like.** Any pet takes any food its kind eats (frogs and crabs: spider, butterfly, cricket, hob for frogs; foxes: fish, rabbit meat if carried; deer: carrots, mushrooms; rabbits: carrots; striders: what striders eat today). Each meal grows it 5% (first feeding still tames). Every meal heals it by SINGE.hp. Feeding another player's pet makes it yours until someone feeds it again (the pet anchor's `by` changes hands; a late joiner sees the current owner).
3. **Hobs.** Hobs can be picked up. Frogs treat a held hob as a lure, exactly like a held bug, and eat one fed to them. If a leafkin is within 20 m when a frog eats a hob, it screams, comes to her and follows her scolding nonstop (a scold line every few seconds, until she leaves its glade's range), and the glade records `hob-fed` (T writes the dialogue).
4. **Death at 0 HP.** Any creature with HP: cries out, pulses red, falls over, stops moving, fades to black over ~1.5 s, then dissolves out ~2 s later. The death goes to the room through the creature anchor like a singe does, and the animal does not respawn this session.
5. **Pets keep up.** A following pet or snowman's top speed matches hers (walk, run, desktop's doubled walk, and VR teleport: past 25 m behind, or no headway for 2 s, it warps to walkable ground a few metres behind her, out of her view). Probe scenarios in a gate: cliff steps, dense deadwood, a river, a steep valley, a teleport jump, the cave mouth; assert headway and no stall over 2 s.
6. **Desktop walk speed doubles** by default.
7. **Fed foxes follow.** When she stands still a pet fox walks a slow circle, then after a few seconds turns to the nearest point of interest (cave mouth, labyrinth, roost, town, chosen by distance), yips twice, and lies down facing it.
8. **Pets in caves.** Foxes, rabbits and frogs follow her in; deer and striders wait at the mouth. A fox walks a few metres ahead along `routeFrom(system, her, 'treasure')`, yipping now and then; a rabbit lags behind along `routeFrom(system, her, 'exit')`, mewling now and then.
9. **Big deer fight dragons.** A deer at 200% or more of its normal size charges a dragon in sight instead of fleeing, butting for 10 HP a hit. A dragon so struck snaps back once (30 HP to the deer) and then flies off, or runs where it cannot fly. Feeding is how a deer gets there (2 meals tame it, and every meal adds 5%: about 20 meals from tame).
10. **Valuables, per `design/42-valuables.md`** (its plan holds except where stated here):
    - **Inventory**: 5 brown small slots (coin and the 4 gems, stacking, no ceiling) above **12** large slots (the plan's 8 becomes 12). Old saves' 8-slot backpacks are converted on load in a migration, not read as two shapes.
    - **Loot ledger** (`loot.js`): keyed by place, the last 100 places, saved, shared by the room (needs server support beside TRUST_BATCH).
    - **Labyrinths**: a plinth at the centre with one gem tiered by ring count, plus 20-60 coins.
    - **Roosts**: every roost has an egg, a hoard of 1-2 from diamond, sapphire, ruby, firestone, and 30-80 coins.
    - **Dragons** have 150 HP (assumption: 15 sword hits) and drop 2-4 gems where they die.
    - **Caves**: ores and gems per the plan, placed by W, mined by C.
11. **NPCs want what she holds.** A human, leafkin or yeti who values the item in her hand (T's `trade.js` says who values what) walks up and hails her, once per NPC per item per few minutes.
12. **Sword, shield, pickaxe.**
    - The **sword** deals 10 HP when its blade meets a creature's mesh at a tip speed over about 3 m/s, at most once a second per target. It hurts any creature with HP, dragons included.
    - The **shield**, held, takes 90% off damage whose source is within 60 degrees of its facing.
    - The **pickaxe**: 3 fast-enough strikes on a vein pry the item loose into her free hand, or into the pack if both hands are full; a mined vein is recorded in the loot ledger.
    - All three live in large slots.
13. **Assets.**
    - **Reused**: the gems, coin, pickaxe and ores (bog iron, lodestone, rimesilver, firestone, flint) already exist in `../pocket-game/tools/props/gen/work/<id>/` as Trellis-2 meshes with remeshed 1000/500/250 tiers from pocket-game's `design/43-remesh.md` pipeline. They are copied in rather than paid for again.
    - **Generated**: only the sword and shield are new. Concept art goes through pocket-game's flux image step, and the mesh through Runware `microsoft:trellis-2@4b` (about 4 credits a mesh, as the pickaxe cost). They are then remeshed by `tools/mesh/remesh.py` to the 500-triangle tier.
    - The remesh tool is ported into this repo as `tools/mesh/` so the next item can be decimated here.

## W, world

1. **Caves twice as large and twice as deep.** Every room's linear size doubles on average, and the number of rooms between a mouth and the deep regions doubles. Keep check-caves green; report the triangle and build-time cost of the change, since caves are budgeted (see `_notes/perf-ledger.md`).
2. **Chalk sits on the cave surface.** Chalk strokes on cave floors and walls currently sink under the drawn cave mesh on about half the surface. A stroke must sit 2-3 cm out from the mesh that is drawn, everywhere. Find whether the stroke is projected onto the field rather than the drawn mesh, then fix the cause. Gate: sample strokes over many cave surfaces and assert the offset from the drawn triangles.
3. **Seaweed.** Ship clump seed 42 of `render/seaweed.js`, scattered on lakebeds and riverbeds at heights 1-4 m, never closer than 1 m to the water surface (so nowhere shallower than 2 m), with instanced draws in one call and a reasonable density. Gate the 1 m rule over many seeds.
4. **Giant cave spiders.** They crawl over cave walls and ceilings, are tinted darker than the wood spiders, and hiss and back away from her light. They have HP (C's death sequence and sword apply through a small hook C will wire in).
5. **Veins and gems in cave walls.** These sit 0.5-2 m above the floor and grow more numerous with depth, with none within 100 m of a mouth by path. Kinds per `design/42-valuables.md` (bog iron after 100 m, lodestone in the deeper regions, rimesilver only in the great cavern, gems in nooks that glint only under her light). Draw them, export `veinsOf` and `routeFrom`, and accept a "mined" set to hide taken ones.

## T, talk

1. **Combinatorial wording everywhere.** Every topic and branch, for humans, leafkin and yetis, is assembled from independently varied fragments (opening, body, detail, closing), so the same question rarely returns the same words, sometimes returns the same meaning reworded, and often adds or drops a detail. Never the same wording twice in a row from one NPC to one question in a session. Gate: one NPC asked one question 20 times gives no back-to-back repeats and many distinct wordings.
2. **Busy NPCs point elsewhere.** Instead of just ending the talk, a busy NPC often names someone friendlier and chattier (the blacksmith in his workshop, the innkeeper, whoever is most talkative in town) and where to find them.
3. **The blacksmith.**
    - **In his workshop**, he opens by asking what she needs and to make it quick, as orders are piling up. Her prioritised options: ask to buy a given item, or ask what he has on offer.
    - **Elsewhere**, he is tired and says to come back when he is in the workshop.
    - **Prices**: sword and shield are 100 coins and 3 bog iron each; the pickaxe is 50 coins.
    - **Sales**: he sells only when she has the coins, the iron and a free large slot, and says which she lacks.
    - **Other townsfolk** have an option to ask where to get weapons, armour and gear. They point to the blacksmith, and warn that he only talks shop in his workshop and is grumpy anywhere else (not that they blame him).
4. **Trade.**
    - An NPC who wants her held item (`ctx.wants`) opens by saying they are very interested in that thing and asks what she would trade for it.
    - Her options: ask what they have on offer, or name something she would take from a list.
    - Who buys what and for how much follows the 42-valuables Flows table. Coins come from selling valuables to traders and to anyone else who buys them.
5. **The dragon-fighting deer quest.**
    - **Hearsay** everywhere: someone in {town} fought off a dragon, nobody knows how. People gladly point the way to {town}.
    - **In {town}**: he did not do it, he just took the credit. It was his enormous pet deer, and deer turn feisty if you feed them enough.
    - {town} is fixed per world seed, preferring a town near a roost.
6. **The cave rabbit tall tale.** Adventurers' hearsay: they were hopelessly lost in a cave near here as a child until their pet rabbit led them out. Foxes, too, are said to sniff out cave treasure.
7. **Furious leafkin.** In a glade with the `hob-fed` wrong, leafkin dialogue turns furious about her feeding their pet to a frog. The one who saw it is the angriest. The scolding lines C plays while it follows her come from T (`LK.scold`).

## Open, decided by assumption

- Dragon HP 150; sword 10 per hit; a big deer's 10 per butt.
- "Iron ore" is bog iron.
- The pickaxe costs 50 coins and no ore (the plan's 60 is superseded).
- Pets warp only out of her view, so a pet never visibly pops.
- Giant cave spiders do not attack her.
