# 41. Clearings and palisade labyrinths

The forest's cover is `BiomeField.coverAt` (src/v2/layers/biome.js): value noise, a layer of small glades over it, and the palisade labyrinths, which hold the cover up over their own ground. Every reader (trees, terrain tint, the rocks' hollow bed and keep-outs, the terrain worker, the palisades) builds its own BiomeField off the seed and the height field, and reads the labyrinths' footprints off the same layers, so they all agree.

## Clearings

The noise's coarsest cell is 90 m. Over it, at most one glade per 110 m square at odds 0.6, 20-60 m across where the trees have thinned to a tenth, its edge wobbled and seated wholly inside its square so `coverAt` asks one hash for it.

Surveyed on the shipped world's central 4 km at cover under 0.15: 1078 clearings, mean 40 m and median 35 m across, 732 of them 20-60 m. Meadow is 12% of the ground; the labyrinths' wood takes under a point of it.

## The labyrinth

`Labyrinths` (src/v2/layers/labyrinths.js) is three-free and memoized per region. Each 620 m region holds one at odds 0.9: an outer radius rolled from 12 to 19 m, rings of cells 1.65 m deep round a 2.25 m open middle. A corridor clears 1.35 m between post faces, leaving the 0.3 m walker a band about 0.75 m wide for her centre. Ring 0 has at least 6 sectors; a ring doubles its sectors where its cells would be wider than 1.8 m along their inner wall, so cells stay roughly square as the rings grow.

Carved as a depth-first backtracker over the cells (long winding corridors), then one door from ring 0 into the middle, then the one entrance: the outer cell farthest from that door along the carve, so the middle is the far end of the walk. 4% of interior walls are knocked out afterwards for loops.

**Never square.** The polar grid goes through `warp`: each radius is twisted through up to 0.11 rad on a sine of its radius, and each bearing's ray is scaled by a three- and five-lobed swell (7% and 3.5% of the radius). Both are bijective, and invertible in closed form (the swell reads the warped bearing, the twist the unwarped radius), which `nodeAt` uses to find the graph node under a point.

`woodAt` lifts the cover to full forest over the reach and 10 m past it, easing back over 25 m, so a labyrinth always stands in the trees.

### Siting

`siteOf` tries 48 centres in the region and keeps the first whose disc, sampled on 5 m rings, passes `_fits`:

- inside the world with the wood margin;
- `scatterAt` slope under 24 degrees at the rock beds' 4 m cell;
- at least the beds' shore rise (1.6 m) over any lake or river level;
- 6 m clear of any road's edge, cave trails included.

**Sited once, by the world plan.** `planWorld` (layers/world-plan.js) sites them after the cave trails and before their own, which would move them, and `applyWorldPlan` sets the footprints on `layers.labyrinthSites`. They ride the worker's document (doc.js `labyrinths`) and never a saved one. Where that is null (a check's bare layers) `siteOf` sites live off the ground as first asked; a sculpt never moves one. The shipped world holds 137.

### The trail

Each gate gets a trail to the roads, as a cave mouth does (trails.js, design/39-caves.md §2): records `lane<k>`, pinned from the point between the torches straight out 10 m, then down the roads' cost field. That field refuses every grid cell within half a cell of any labyrinth's reach, so no trail crosses one. 114 of the 137 have one; the rest sit in the mirrored strip past the real map, open onto a lake, or stand where no road can reach. The plan's `labyrinthPlan` is `{ sites, records, trails, failed }`.

## The walls

`mazeOf` turns the standing walls into polylines sampled every 0.4 m before the warp:

- the outer wall is one open arc from one gate post round to the other, leaving 1.5 m between post centres (1.2 m clear; 1.2 between centres shuts the walker out);
- each ring boundary's standing intervals merge into runs, a fully standing one into a closed line;
- radial walls chain outward across boundaries no ring wall touches, and are trimmed 0.28 m (JOIN) where one does, so the end post stands against the ring's posts, not in them.

The lines' segments are filed in a 2 m hash, and `wallAt(x, z, pad)` asks whether a point is within POST_R + pad of any of them.

**Lines are the wall, posts are the look.** `render/palisades.js` is the walker's stone along the lines whether or not posts stand there.

**Each post a different tree.** `postsOf` rolls each post's girth (radius scale) off POST_GIRTH 0.7-1.45, and each gap between neighbours is either open daylight (odds 0.4, 0.8-4 cm) or snug (1.5 mm). The line's girths are then scaled together so its posts end on its ends; a metre-long line scales by up to a quarter. check-labyrinths holds every point of wall under a post or a crack of at most 4 cm.

**Sheer to the walker.** `Palisades.columnAt(..., sheer)` reports a post's span running to Infinity, and WalkSurface asks it that way in heightAt (with a foot height) and crossed, so no stride climbs a wall and fits() refuses one at any height. `ceilingAt` asks without it, so flight passes over the 4 m tops; so does the teleport arc. A torch pole is 0.12 m of stone the same way.

**The points hurt.** Landing with her feet on a wall's top (Palisades `onWallTop`) costs 30 HP and shoves her 0.55 m off across the wall, to a side rolled at random (main.js `WALL_TOP`).

## The posts (props/palisade.js, render/palisades.js)

A pine trunk 0.3 m across and 4 m out of the ground, 0.4 m buried, shaved to a 0.42 m point. LOD0 is 9 sides by 5 segments, its vertices jittered up to 7% inward and its rings bowed up to 6 mm. LOD1 is 7 sides by 1 segment. The shaft wears BARK_PINE; the point's smooth-shaded facets wear TIMBER_BEAM's lightest band (`tipBand`, clear of the dark seam between its two logs), grain running up the facet, so the point reads as fresh-cut wood to the apex.

Four variants. `postPose` (render/palisades.js, also the bench's) takes its girth and height share off the record and rolls the rest of its look (`POST_VARY`): a 0.9-1.08 height, a lean up to 0.1 rad across the wall and 0.02 along it (so the shafts only kiss), a shift up to 4 cm, a shade of 0.84-1.14 and a warm/cool tint of up to 12%, the last two through the instance colour so they carry onto the card. A tower's posts stand plumb.

**Tone.** The mesh is drawn 20% darker and the card 20% lighter than the plain prop and card (`POST_TONE`), in display terms: the vertex colours carry 0.8^2.2 (they are linear), and `tonePostCard` lifts the baked card's sRGB bytes by 1.2 / 0.8 since the bake already carries the mesh's darkening.

LOD2 is a card in LitterCards' shared pool, photographed off a LOD0 post once the atlas is in. Bands from the eye: LOD0 inside 10 m, LOD1 inside 28 m, the card inside 80 m, and nothing past it, where the forest hides the walls. Labyrinths whose reach meets the 80 m box are placed into a 14000-id PropArena (three of the largest at once) and released past it; tiers rebucket per metre the eye moves. LitterCards grows by PALISADE_CARDS (10000) for the claim.

`/gen-palisade` shows LOD0, LOD1 and the card side by side, with a curved run of wall, its gate and torches.

## The gate torches

Two torch poles 0.55 m outside the outer wall, one at each gate post: a bark stake and a pitch-dark head, a TriFlames flame on top. Their light goes into main.js `updateFire`'s torch list at half a hand torch's reach (`GATE_LIGHT`, 7.5 m), so it competes with lit sticks for the dynamic torch slots. At most 6 torches (three labyrinths) are in reach; more throws.

## The watchtowers

One per 40 cells and at least 2, each in a dead end, spread by farthest point from each other and the mouth (`TOWER`, mazeOf `towers`): four posts 8 m tall and 0.85 girth at the corners of a 0.84 m square, a plank deck 1.5 m square with its top at 7.1 m, and a ladder on the face toward the cell's way out. The deck's corner posts stand closer than her body is wide, so the ladder is the only way off on foot; stepping off its edge is a fall.

**Climbing** (src/v2/climb.js). On the desktop she walks into the ladder from its foot, facing in, and the walk keys climb at 0.9 m/s; from the deck, facing out, they climb down. In the headset an empty hand within 0.15 m of a rung grips it, and the rig moves against the hand so it stays on its rung; the last hand to grip leads. Either way `Player.hold(y)` keeps her height until her next walk or teleport, and the top steps her onto the deck.

## The middle

A stone plinth 0.64 m square and 1 m tall carrying a dragon egg, and behind it from the door a torch post 4 m tall (`ALTAR`, `BEACON`), tall enough to read from the towers' decks.

## The drums

Within 20 m of a labyrinth's outline she hears `npc-yeti-drums.mp3` looped from its middle (ambience.js `RULES.drums`). `nearness` walks 0 at that reach to 1 at the middle's edge; the level runs 0.03 to 0.6 and the low-pass 220 to 9000 Hz, both geometrically, so far off they are a distant thump. Off indoors. Once she stands in the middle they stop for good: main.js `drumsStilled` holds its `rx,rz` and the save carries it.

## The green giant (src/v2/render/giants.js)

One per labyrinth: the yeti, 5 m tall (a metre over the posts), its fur tinted [0.42, 0.8, 0.32]. Laid for labyrinths within 160 m, at most 4. It walks only the maze's graph (mazeOf `ways`: a node per cell and one for the middle, an edge per opening), so it never leaves the maze.

**The round.** `roundOf` is an Euler walk of the graph's spanning tree from the middle, children shuffled per labyrinth, at 0.6 m/s, standing 2-5 s in each dead end and 8 s in the middle at the turn; a few tens of minutes long. `roundAt` is closed-form in the room's clock, so every client has it at the same pose, synced as the snowmen are (render/snowmen.js): anchors keyed `gg:rx,rz`, a peer's giant going live on the anchor's player.

**Live.** It notices her within 10 m on the side it faces, unless she is more than 4 m over its feet (a tower's deck is safe), and this client becomes its authority, owing an anchor a second. It chases at 1 m/s (her walk is 1.45) by BFS along the graph to her node, or to the entrance cell when she is outside; within 2.2 m it swings (the threaten clip at 0.6 rate), and the blow lands halfway through for 25 HP if she is still within 2.7 m. Past 20 m, or a stale anchor, it forgets her, owes a rejoin anchor and walks back to where its round has got to. The chapter turn snaps a returning giant onto its round.

It shares the snowmen's visibility toggle and trace row, and treads through ambience's herd as `human`/`tread`/`thud`.

## Keep-outs

- **Trees**: `Trees._stands` refuses a trunk where `keepOutAt` (the inside, 1.5 m past the outline, and 3 m round the entrance's mouth) holds at the trunk's radius.
- **Dead wood**: the same, with a 4 m pad.
- **Rocks**: every blocking bed keeps off a labyrinth's whole reach (`reaches`). A hollow's keep-out inside one would stop its corridors, so `_deepSite` counts a labyrinth's wood as open.
- **Creatures**: Wildlife and WildStriders spawn nowhere `keepOutAt(x, z, 2)` holds (main.js `wildAvoid`). Spiders, frogs, crabs and insects are not kept out: the tree and rock spiders have no host inside, but a lone ground spider can seed in a corridor.

## The checks

- **check-labyrinths** `[every]`, ~16 s. Every labyrinth: every cell reached from the one entrance, one door, two torches; wall covered by posts or cracks of at most 4 cm; girths in range; its towers; its drums' reach and rise; the giant's graph one piece, `nodeAt` finding every node, every leg 0.25 m clear of the walls. Walked: WalkSurface flooded on a 0.25 m grid with Palisades' own columnAt, every cell and the middle reached from outside, and with the gate plugged, none. Towers climbed, held and fallen from; wall tops found.
- **check-giants**: on flat ground with a stand-in skinned yeti: the round's coverage and pace, the closed-form pose across two frame rates, noticing, chase, swing and blows, forgetting and the walk back, a peer going live on an anchor.
- **check-world-plan**: the boot reads the plan's footprints, and the gate trails reach the roads through no labyrinth.

## Open

- design/42-valuables.md plans a gem on the plinth; the egg stands there now.
- The giant is wider than a 1.35 m corridor and clips the posts; a noticed giant can take long to reach her round the maze's turns.
- Climbing and the giant are unseen in a headset.
- Posts are drawn only inside 80 m, so a labyrinth is invisible past that; the wood round it usually hides it first.
- On v3 fine tiles, slope at the 4 m siting cell may disagree with the beds' own reading.
