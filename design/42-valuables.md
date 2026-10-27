# 42. Valuables

Gems, coins, ores and the few rare things that give her reasons to go far: what each is, where it lies, who trades for it, what it is for, how she carries it, and how the world remembers she took it. Nothing here is built yet; this is the plan.

## The lineup

| Item | Kind | Sells to humans for | Found |
|---|---|---|---|
| Flint | ore, large | 2 | scree below cliffs |
| Bog iron | ore, large | 5 | cave walls (common); leafkin trades |
| Lodestone | ore, large | 25 | cave walls in the deeper regions (uncommon); leafkin trades, for a gem |
| Rimesilver | ore, large | (rarely sold; see Uses) | the great cavern's walls only, 5-10 veins a cave system |
| Firestone | ore, large | 30 | dragon roosts |
| Jade | gem, small | 40 | cave nooks and lobes (rare); labyrinth plinths |
| Ruby | gem, small | 60 | cave nooks (rare); labyrinth plinths; roosts |
| Sapphire | gem, small | 75 | cave nooks (rare); labyrinth plinths; roosts |
| Diamond | gem, small | 100 | roosts; the largest labyrinths' plinths |
| Coin | coin, small | -- | humans pay them; nobody leaves them lying about |
| Dragon egg | rare, large | never to an honest trader | every roost, one at its centre |

The prices are deliberately flat rather than 4x a tier: a thing is worth fetching for its use, not its price.

The names avoid the iron-copper-titanium ladder. Bog iron is how the Norse got their iron, and it explains the leafkin's metal: they dredge it from fens with no tools. Lodestone earns a use of its own rather than being the middle metal. Rimesilver forms only in the cold deep and glows faintly, so it reads as a light in the dark before she knows what it is. Firestone is rock baked by dragon fire, so it comes only from roosts.

## Where it lies

- **Scree.** A new scatter of dark-grey shiny pebbles at cliff feet (cave mouths are already sited at cliff feet; reuse that finder). Flint is cheap and common: it goes through `taken.js` like a mushroom, regrows on reload, and never enters the loot ledger.
- **Caves.** Ore veins are pried from the wall with a pickaxe, three fast strikes a vein (design/39-caves.md §9). Bog iron anywhere, lodestone only in the deeper regions, rimesilver only in the great cavern (one a system, design/39-caves.md §3). Gems sit in nooks and lobes and **glint only when her light falls on them**, which rewards carrying a light and pairs with the light-hating horrors planned for the deep.
- **Labyrinths.** Each labyrinth's open middle holds a stone plinth with one gem on it. The gem's tier follows the labyrinth's ring count, so the bigger the maze, the better the prize; only the largest hold a diamond.
- **Roosts.** Every nest holds one egg at its centre (today half do: `render/roosts.js` THE EGG) and a hoard of 1-2 drawn from diamond, sapphire, ruby and firestone.
- **Leafkin glades.** Not a place things lie but a trade: see Flows.

## Flows

Every trade runs one way.

| Who | Takes | Gives |
|---|---|---|
| Human traders | gems, ores, eggs (the thief only) | coins |
| Leafkin | gems and coins ("shinies") | bog iron, lodestone; never rimesilver |
| Blacksmith | ores plus coins for his time | tools and upgrades |
| Alchemist (wizards later) | gems, firestone, plus coins | draughts, glowstones, flare charges |

Humans almost never sell a gem or a metal; the thief may sell one stolen gem at three times its price. So the way to a thing she needs is to ask people where it is found (the `gems`, `ores` and `coins` lore topics, `talk/lore.js`), and the answers are as reliable as the teller.

A shiny is also what opens a glade: leafkin push a stranger away unless she brings something they want (design/30-leafkin.md), and gems and coins are what they want. Jade is their favourite ("green shiny").

The intended order of discovery falls out of who needs what tool:

1. A labyrinth's plinth needs no tool: her first gem.
2. Sold to a human, it buys a pickaxe from a blacksmith (50 coins, about one gem's worth).
3. The pickaxe opens the caves: bog iron, deeper lodestone, rare glinting gems, rimesilver in the great cavern.
4. Bog iron makes climbing picks, brittle and spent as she climbs; with them, the roosts.
5. Shinies open the leafkin glades, and with them a supply of metal no human will sell.

## Uses

| Item | Use |
|---|---|
| Flint | Flint & steel wears its chip down and takes a fresh pebble every N strikes. |
| Bog iron | Smith: the pickaxe and its repair, brittle climbing picks, most plain work. |
| Lodestone | A seeker needle, made by the smith or alchemist, attuned to one kind of place: the nearest cave mouth, her home town, the town that shuns her. Also the flare gun's mechanism. |
| Rimesilver | Climbing picks that never break; the top blade and armour. |
| Firestone | Alchemist: glowstones (cave breadcrumbs) and flare gun recharges. |
| Jade | Alchemist: healing draughts (design/33-vitals.md). Leafkin prize it most. |
| Ruby | Alchemist: a warming draught that makes the snowlands survivable, and so the roosts reachable. |
| Sapphire | Alchemist (a wizard later): breath under water, for the flooded passages and sumps the caves already have. |
| Diamond | Mostly the big coin of the realm, plus one legendary order: a wizard's service, a strider, a great favour. |
| Dragon egg | The quest item (_notes/TASKS.md, the dragon egg). No honest trader touches it; the thief fences it, and word of where it went reaches the town that wanted it. |

## Carrying

The backpack view has two kinds of slot.

- **Blue slots, large things.** The 8 slots there today (`main.js` BACKPACK_SLOTS), in 4 columns, one thing a slot: tools, eggs, every ore and metal. Eight slots is the cap on a haul, so a rich cave means choosing what to carry home, or coming back.
- **Brown slots, small things.** A row of 5 above the blue grid, one for each of jade, ruby, sapphire, diamond and coin, sized so the 5 columns span the same width as the 4 blue ones. Each holds a count with no ceiling; its picture is the thing with the count over it. Only these five stack.

**A fistful.** A press on a brown slot puts one of its kind in the hand; each further press on the same slot adds one more, so the hand holds a fistful of N of one kind. A press on any other slot, blue or brown, puts the whole fistful back in its own brown slot and takes what was pressed instead. Stowed over the shoulder, a fistful goes back whole. Handed to a peer, it goes whole (the hands already carry a `hold` that is given, hands.js THE ROOM SEES IT), which is how a room divides its takings.

## The loot ledger

What she takes must stay taken across reloads, or a roost could be farmed by walking away and back. `taken.js` cannot do this: it is session memory, keyed by kind and exact position. The ledger is a second registry beside it, for valuables only.

- **Keyed by place, not by thing.** One entry per looted place with a bitmask of what has been taken there: a roost is one entry, with a bit for the egg and one for each hoard item; a cave system is one entry with a bit per vein and per gem; a labyrinth is one entry with one bit. Each place already has a stable id: the roost key, the labyrinth's `hash`, the cave system's seed, and the village seed (as `trust.js` keeps it) for a glade's stock of trades.
- **The last 100 places**, evicted oldest-looted first. An evicted place regrows: that is the reason to travel instead of returning. Keying by thing would let one afternoon of prying bog iron push out every roost she had stripped.
- **Saved** in the save beside `trust` and `chalk`.
- **Shared by the room.** What one player takes is gone for the other, as `taken.js` and trust already behave: each entry goes out to the relay and a peer's entries come in through the same add. Two players reaching the same gem in the same instant need one winner; the relay's order decides it, so the ledger needs server support alongside trust's (`server/src/main.js` TRUST_BATCH).

## Open

- Flint is a pebble but, by the rule above, a large thing taking a whole blue slot. If flint & steel wears its chip, carrying spares costs a slot each. Either flint joins the brown row as a sixth small thing, or the wear is slow enough that one spare lasts.
- What a fistful does let go of in the open world: scatter where it falls (and lie loose like any dropped thing), or not be let go of at all except into the backpack or a peer's hand.
- Whether a looted place also regrows after a long in-game time (a roost lays again after some days), or only by eviction.
