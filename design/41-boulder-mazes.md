# 41. Clearings and boulder mazes

The forest's cover is `BiomeField.coverAt` (src/v2/layers/biome.js): value noise, a layer of small glades over it, and the boulder mazes, which hold the cover up over their own ground. Every reader (trees, terrain tint, the rocks' hollow and maze beds, the terrain worker) builds its own BiomeField off the seed and the height field, so they all agree.

## Clearings

The noise's coarsest cell is 90 m. Over it, at most one glade per 110 m square at odds 0.6, 20-60 m across where the trees have thinned to a tenth, its edge wobbled and seated wholly inside its square so `coverAt` asks one hash for it.

Surveyed on the shipped world's central 4 km at cover under 0.15: 1078 clearings, mean 40 m and median 35 m across, 732 of them 20-60 m. Meadow is 12% of the ground; the mazes' wood takes under a point of it.

## The maze

`BoulderMazes` (src/v2/layers/mazes.js) is three-free and memoized per region. Each 450 m region holds one maze at odds 0.9: n x n cells, n rolled from 6 to 10, on a block grid of 2n+1 blocks 7 m on a side. Cells sit at odd blocks, walls between them, posts at the even corners. The inside is a disc with a three- and a five-lobed wobble, carved by a depth-first backtracker from the centre cell (long winding corridors), then 8% of the cells' interior walls knocked out for loops and two or three entrances opened on the rim at spread bearings. Blocks are OPEN, WALL_X or WALL_Z.

`woodAt` lifts the cover to full forest over the footprint and 10 m past its widest reach, easing back over 25 m, so a maze always stands in the trees.

### Siting

`siteOf` tries 48 grid-aligned positions in the region and keeps the first where every block of the disc passes `_fits`:

- inside the world with the wood margin;
- `scatterAt` slope under 24 degrees at the rock bed's 4 m cell -- the bed refuses past 30, and a refused block is a hole in a wall;
- at least the bed's shore rise (1.6 m) over any lake or river level;
- a block clear of any road's edge.

The shipped world holds 97 mazes, most of them in the lowlands: slope refuses about five tries in six, water and the world's edge most of the rest, roads none. The region and tries are what set the count (420 m and 32 tries give 102, 500 m and 64 give 90).

**Memoized against the ground as first asked.** A sculpt does not move a maze already sited, and every holder must site it off the same surface, or the wood and the walls part company.

## The walls (rocks.js `maze` bed)

One boulder on every wall block. The bed is a lattice whose pitch is the block, its tile 8 blocks, and `_mazeless` skips tiles no maze touches. Each boulder is yawed down its wall and stands upright, with a long axis of 10.5-12.5 m against the 7 m pitch, so neighbours overlap by 3.5 m or more at the ground line. A post that ends its wall (mazes.js `tips`) is drawn back 1.5 m along it: undrawn, its boulder reaches 2.75 m past its block, and two tips facing over one open block left a slot under a metre wide. Sunk 0.3-0.35 for the look; with the span sheer, the gate holds at any sink from 0.2 to 0.5.

**Not `lie`.** A quarter turn swings the shape's bed face, and the origin on it, onto a flank, so the stone stands half its height off the block it was put on.

**Sheer to the walker.** `Rocks.columnAt(..., sheer)` reports a maze stone's span as running to Infinity, and WalkSurface asks it that way in heightAt (with a foot height) and crossed, so heightAt never takes it as ground and fits() refuses it at any height. `ceilingAt` asks without it: flight and the teleport arc's solidity test would otherwise find her in stone at any height over a wall. A rounded boulder is otherwise climbable: the stride baseline in `Player._walkable` asks the height two paces on from her feet, finds the top past her reach, reads the field under it, and sees no rise (see Open). Teleport cannot land on a wall either, since `pathClear` walks the same capsule. `blockTopAt` (landing, props) still sees the real top.

**Keep-outs.** Every other blocking bed keeps off a maze's ground (`reaches`), or its rocks plug corridors. A hollow's keep-out inside a maze would hole its walls, so `_deepSite` counts a maze's wood as open.

**Pool.** Peak 484 resident over a 100 m maze-only flight, where two mazes stand in reach; `siteFrac` 0.062 leaves 1.5x headroom.

## The gate

`scripts/check-mazes.mjs [every]`, run in `npm run check` at every 8th maze (~18 s; all 97 take 2.3 min). Pure, every maze: every cell open and reached from its entrances, the rim shut but for them, at least 80 mazes. Grown: the real rocks placed, then flooded on a 0.5 m grid by WalkSurface's heightAt and fits plus Player's slope rule. Every cell is reached from outside, no wall lets her through within the strip of its two cells, and every open edge does.

## Open

- **Any tall rounded boulder outside a maze is scrambleable** through the stride hole above. The fix is one line in `_walkable` (stone crossing her head volume at the stride point is a wall), but it changes walking everywhere and is not taken.
- On v3 fine tiles, slope at the 4 m siting cell may disagree with the bed's own reading.
- Trees and dead wood are not kept out of corridors; a fallen trunk can narrow one.
