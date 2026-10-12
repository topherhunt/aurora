# 41. Clearings and palisade labyrinths

The forest's cover is `BiomeField.coverAt` (src/v2/layers/biome.js): value noise, a layer of small glades over it, and the palisade labyrinths, which hold the cover up over their own ground. Every reader (trees, terrain tint, the rocks' hollow bed and keep-outs, the terrain worker, the palisades) builds its own BiomeField off the seed and the height field, so they all agree.

## Clearings

The noise's coarsest cell is 90 m. Over it, at most one glade per 110 m square at odds 0.6, 20-60 m across where the trees have thinned to a tenth, its edge wobbled and seated wholly inside its square so `coverAt` asks one hash for it.

Surveyed on the shipped world's central 4 km at cover under 0.15: 1078 clearings, mean 40 m and median 35 m across, 732 of them 20-60 m. Meadow is 12% of the ground; the labyrinths' wood takes under a point of it.

## The labyrinth

`Labyrinths` (src/v2/layers/labyrinths.js) is three-free and memoized per region. Each 620 m region holds one at odds 0.9: an outer radius rolled from 12 to 19 m, rings of cells 1.65 m deep round a 2.25 m open middle. A corridor clears 1.35 m between post faces, leaving the 0.3 m walker a band about 0.75 m wide for her centre. Ring 0 has at least 6 sectors; a ring doubles its sectors where its cells would be wider than 1.8 m along their inner wall, so cells stay roughly square as the rings grow.

Carved as a depth-first backtracker over the cells (long winding corridors), then one door from ring 0 into the middle, then the one entrance: the outer cell farthest from that door along the carve, so the middle is the far end of the walk. 4% of interior walls are knocked out afterwards for loops.

**Never square.** The polar grid goes through `warp`: each radius is twisted through up to 0.11 rad on a sine of its radius, and each bearing's ray is scaled by a three- and five-lobed swell (7% and 3.5% of the radius). Both are bijective, so walls bend and flow but never cross.

`woodAt` lifts the cover to full forest over the reach and 10 m past it, easing back over 25 m, so a labyrinth always stands in the trees.

### Siting

`siteOf` tries 48 centres in the region and keeps the first whose disc, sampled on 5 m rings, passes `_fits`:

- inside the world with the wood margin;
- `scatterAt` slope under 24 degrees at the rock beds' 4 m cell;
- at least the beds' shore rise (1.6 m) over any lake or river level;
- 6 m clear of any road's edge.

The shipped world holds 138. The region sets the count.

**Memoized against the ground as first asked.** A sculpt does not move a labyrinth already sited, and every holder must site it off the same surface, or the wood and the walls part company.

## The walls

`mazeOf` turns the standing walls into polylines sampled every 0.4 m before the warp:

- the outer wall is one open arc from one gate post round to the other, leaving 1.5 m between post centres (1.2 m clear; 1.2 between centres shuts the walker out);
- each ring boundary's standing intervals merge into runs, a fully standing one into a closed line;
- radial walls chain outward across boundaries no ring wall touches, and are trimmed 0.28 m (JOIN) where one does, so the end post stands against the ring's posts, not in them.

The lines' segments are filed in a 2 m hash, and `wallAt(x, z, pad)` asks whether a point is within POST_R + pad of any of them.

**Lines are the wall, posts are the look.** `render/palisades.js` is the walker's stone along the lines whether or not posts stand there. `postsOf` spaces posts evenly along each line at most 0.29 m apart, centres 0.30 m across, so neighbours touch or leave up to about 4 cm of daylight, under 5 cm at the thinnest girth `postPose` rolls (props/palisade.js `POST`). check-labyrinths holds every point of every line within half a spacing of a post.

**Sheer to the walker.** `Palisades.columnAt(..., sheer)` reports a post's span running to Infinity, and WalkSurface asks it that way in heightAt (with a foot height) and crossed, so no stride climbs a wall and fits() refuses one at any height. `ceilingAt` asks without it, so flight passes over the 4 m tops; so does the teleport arc. A torch pole is 0.12 m of stone the same way.

## The posts (props/palisade.js, render/palisades.js)

A pine trunk 0.3 m across and 4 m out of the ground, 0.4 m buried, shaved to a 0.42 m point. LOD0 is 9 sides by 5 segments, its vertices jittered up to 7% inward and its rings bowed up to 6 mm. LOD1 is 7 sides by 1 segment. The shaft wears BARK_PINE; the point's smooth-shaded facets wear TIMBER_BEAM's lightest band (`tipBand`, clear of the dark seam between its two logs), grain running up the facet, so the point reads as fresh-cut wood to the apex.

Four variants. `postPose` (render/palisades.js, also the bench's) rolls each post's look off its record (`POST_VARY`): a 0.92-1.06 height, a girth of 0.97-1.15, a lean up to 0.045 rad and a shift up to 2.5 cm, a shade of 0.86-1.12 and a warm/cool tint of up to 10%, the last two through the instance colour so they carry onto the card. The lean and shift are across the wall only, and girth never drops under 0.97, since either along the wall or a thinner post would open a crack past 5 cm.

**Tone.** The mesh is drawn 20% darker and the card 20% lighter than the plain prop and card (`POST_TONE`), in display terms: the vertex colours carry 0.8^2.2 (they are linear), and `tonePostCard` lifts the baked card's sRGB bytes by 1.2 / 0.8 since the bake already carries the mesh's darkening.

LOD2 is a card in LitterCards' shared pool, photographed off a LOD0 post once the atlas is in. Bands from the eye: LOD0 inside 10 m, LOD1 inside 28 m, the card inside 80 m, and nothing past it, where the forest hides the walls. Labyrinths whose reach meets the 80 m box are placed into a 14000-id PropArena (three of the largest at once) and released past it; tiers rebucket per metre the eye moves. LitterCards grows by PALISADE_CARDS (10000) for the claim.

`/gen-palisade` shows LOD0, LOD1 and the card side by side, with a curved run of wall, its gate and torches.

## The gate torches

Two torch poles 0.55 m outside the outer wall, one at each gate post: a bark stake and a pitch-dark head, a TriFlames flame on top. Their light goes into main.js `updateFire`'s torch list at half a hand torch's reach (`GATE_LIGHT`, 7.5 m), so it competes with lit sticks for the dynamic torch slots. At most 6 torches (three labyrinths) are in reach; more throws.

## Keep-outs

- **Trees**: `Trees._stands` refuses a trunk where `keepOutAt` (the inside, 1.5 m past the outline, and 6 m round the entrance's mouth) holds at the trunk's radius.
- **Dead wood**: the same, with a 4 m pad.
- **Rocks**: every blocking bed keeps off a labyrinth's whole reach (`reaches`). A hollow's keep-out inside one would stop its corridors, so `_deepSite` counts a labyrinth's wood as open.
- **Creatures**: Wildlife and WildStriders spawn nowhere `keepOutAt(x, z, 2)` holds (main.js `wildAvoid`). Spiders, frogs, crabs and insects are not kept out: the tree and rock spiders have no host inside, but a lone ground spider can seed in a corridor.

## The gate

`scripts/check-labyrinths.mjs [every]`, run whole in `npm run check` (~16 s). Pure, every labyrinth: at least 80; every cell reached from the one entrance through open walls, one way in, one door to the middle, two torches; a post within 0.145 m of every point of wall. Walked: WalkSurface flooded on a 0.25 m grid (a 0.5 m one aliases across the corridor's band) with Palisades' own columnAt, every cell and the middle reached from outside, and with the gate plugged, none.

## Open

- Posts are drawn only inside 80 m, so a labyrinth is invisible past that; the wood round it usually hides it first.
- On v3 fine tiles, slope at the 4 m siting cell may disagree with the beds' own reading.
