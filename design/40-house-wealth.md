# 40. House wealth

A town house's inside runs from a humble hut to a grand house, matching its outside. The wealth is the building's placement prestige `p` (§32), stored as `b.wealth` and passed to `rollTownInterior({ wealth })` (§38). It falls with distance from the centre, so the slate and pantile houses near the middle are rich and the thatch at the edge poor. Poorer houses are darker, and that is intended.

## The roll

Wealth gets its own rng (`wrng`, `hash32(seed, index, 0x3ea1)`), so it never shifts the layout's draws. Each house jitters it once: `rich = clamp(wealth ± 0.12)`. `by(poor, best)` lerps a value from poor to rich, and the `means` table holds every chance wealth moves. Swapping a chance's probability for a `means` entry leaves the number of draws unchanged.

| means | poor → rich | what it gates |
|---|---|---|
| cushion | 0.03 → 0.75 | a cushion on each chair |
| arms, armchair, rocker | 0 / 0.03 / 0.05 → 0.6 / 0.85 / 0.9 | padded and armed seats |
| bench | 0.75 → 0.2 | a bench in place of side chairs |
| candle | 0.12 → 1 | every candlestick (table, board, worktable, bedside, dresser, stool) |
| torch | 0.95 → 0.05 | a wall sconce holds a torch instead of a candle |
| rug | 0.1 → 1 | every rug |
| posts, wide | 0 / 0.25 → 0.55 / 0.7 | four-poster and wide beds |
| fruit, books, dresser | 0.3 / 0 / 0.25 → 0.85 / 0.6 / 1 | the fruit bowl, a bookcase, a plate dresser rather than a shelf |
| letters | 0.1 → 1 | a workroom stays a workroom; otherwise it is a store (only in a house with no shop) |
| fine | 0.15 → 1 | a `FINE` piece (bookcase, press, side table, washstand) stays; otherwise it becomes the room kind's `POOR` one (sack, bucket, basket, crate) |
| tools | 1 → 0.05 | a rack of farm tools on the wall nearest the door |
| hanging | 0.9 → 0.3 | onions, garlic and herbs hung from a kitchen ceiling at least 2.6 m high |
| glass | 9 → 4.5 | metres of open wall per window |

A room with no candle lights from a sconce or a perch (a stool or bookcase counts), or the roll throws. The room also carries `wealth`, `tin` (`by(0, 0.9)`, the chance a plate or cup is pewter rather than wood), `dyed` (`by(0.1, 1)`, the share of textiles in dyed wool rather than undyed browns and greys) and `rough` (`1 - rich`).

## Surfaces

- **Floor.** `earth` when `wrng() < by(0.9, -0.6)` (so never in the richest third), else `plank` 55% or `flag`. Earth is the speckle map in a dark brown, repeating every `EARTH_M` 1.2 m.
- **Walls** come from the outside style (`wallKind`). A style with no rule throws.

| style | walls |
|---|---|
| log | `logs` |
| stave | `boards` 85%, else `panel` |
| halfTimber | `timbered` 75%, else `boards` |
| stoneBase | `plaster` below 0.2 + 0.5·rich, `panel` below 0.6 + 0.3·rich, else `boards` |
| masonry | `plaster` below 0.6 − 0.3·rich, else `panel` |

`plaster` is a cream wash and `timbered` is plaster between dark posts and braces. Both are textures from `houseTextures`.

## Log walls

`logWall` lays real courses rather than a texture. Each course is `0.22 + 0.06·rough` m tall, so poorer logs are chunkier. It is a half-cylinder (4 rings) with jittered radius, set into the wall so a mortar chink face shows between courses. The courses break at doorways and windows, stop under the roof, are capped at the ends, and run the wall thickness past each corner so they cross. Log walls get no skirting. They cost about 30% more vertices than boards: about 22k for a hut against 15k, and 111–134k for a longhouse against 84–104k.

## Torches

A torch sconce is a bracket, ring, angled stick and sooty head. Its flame is one of the `fire` TriFlames, the same as the hearth's, and it lights out to `SHADE.torchReach` 1.6 m. A house lit only by torches has no candle flames object.
