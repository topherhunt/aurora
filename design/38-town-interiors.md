# 38 -- Town house interiors

Code: `src/v2/rooms/town-interior.js` (the roll, pure), `src/v2/render/town-interior.js` (`TownInteriorView`, mesh and bake), `src/v2/render/town-residents.js` (`TownResidents`). Wiring: `openTownHouse` / `townDoor` / `townInside` in `src/v2/main.js`. Gate: `node scripts/check-town-interiors.mjs` (in `npm run check`). Status: shipped.

Any town building (§32) can be entered by its door. `rollTownInterior({ seed, index, plan })` rolls the inside from the building's own `buildings/plan.js` plan, with `index` = `t * 256 + i`, and the view is set down 250 m over the building, as the leafkin interiors are (§30, Interiors). Her walk is swapped for a `WalkSurface` over `TownInteriorStone` while she is in.

## Plan

- **Scale.** Every mass is the outside's at `S` = 2 on the ground, inset by the 0.15 m wall. Room-local metres: building-local × S, unrotated, y 0 the ground floor, the front door in the main mass's +Z wall. The roof's underside is the outside roof scaled up (`townCeilingAt`).
- **Masses.** Wings and outshuts meet the main across a board junction wall with one doorway (`DOORWAY` 1.1 × 2.2). A mass meeting the main on an unknown side, or over less than a doorway plus 0.6 m, throws.
- **Windows** stand where the plan has them (outshut windows are dropped), 1.1 m wide, never in a junction or beside the door. An upper floor's gables with no window get one high up, so an upstairs room is never lit only by candles.
- **Hearth.** On the chimney's gable if it fits (then the other gable, then the back), 1.9 × 0.75, clear of the door and the junction doorways. Its room is the kitchen, or the hall if they are the same room.
- **Upper floor.** Only under the main roof, when the eave clears `U` + 1.2 and the ridge `U` + 2.6 over at least 30 m² (huts 70% of the time). `U` = clamp(S × wallH / 2, 2.8, 4.2), in 0.2 m rises.
- **Stair.** Flat slat treads (`STAIR` run 0.26, width 0.95) along a main wall, preferring back, then gables, then front. A run is taken only if every tread from the first one she must clear (`th`) has `HEAD` 2.0 under the roof, the landing above has headroom, it misses windows and keeps, and it stays 0.7 m off the hearth body (a landing between the chimney and a wall is shut in otherwise). The hole opens 0.4 m short of tread `th`, or her capsule on that tread meets the slab edge. Rails guard the hole. With no run that fits, the house has one floor.
- **Partitions.** Board walls across the main's width, each with a doorway placed where it has headroom and misses the keeps, rooms at least 3 m wide. Ground: none under 7 m, maybe one under 8.5 m, else up to 3. Upper: none under 9 m, else up to 2.
- **Room kinds.** The door's room is the `hall`, the hearth's the `kitchen`. Upstairs rooms are bedrooms (80%) or workrooms. Outshuts are stores or workrooms; wings and other ground rooms are parlours, workrooms or bedrooms. Some room is always made a bedroom when one can be.
- **Surfaces.** The floor is `plank` (55%) or `flag`; the walls `boards` (60%) or `panel`, each with a random hue and tone.

## Furnishing and reach

Furnishing works on a 0.1 m grid per level with flags `SOLID`, `KEEP` (a walkway to leave clear), `WIN` (before a window), `LOW` (under `HEAD`) and `HUNG` (a wall band already used). Floor cells are cleared by their centres; solids are rastered over every cell they touch. A wall falling mid-cell therefore rasters the straddling cell solid, so `atWall` tests a body from one cell off the wall.

The invariant is that every place a resident goes stays reachable. `anchors[level]` holds points that must stay flood-reachable from `anchors[level][0]` (the door inside, or the stair top): the junction and partition doorways, the stair ends, and each room's reachable cell nearest its middle, met by any reached cell within 1.8 m (so a central table does not fail it). A level cut in two before furnishing, or a room with no reachable cell, throws.

`tx(level, fn)` snapshots the grid, items, solids, candles, spots and anchors, and rolls back if `fn` returns false or the anchors stop reaching. `hold(level, p)` adds a seat's or cook's stand as an anchor: always inside a `tx` (so a placement that walls in its own seats is rolled back), otherwise only if it is reachable now.

Order, so the scarce things get floor first:

1. Bedrooms: one bed, or two in a room over 16 m² (55%). A bed's head goes to a wall with 2.5 m of run, with at least one clear side to stand in that has her headroom under an eave (`stands`, the sides and then the foot); a chest at the foot, a stool and candle by the pillow, maybe a rug.
2. The hall. Dining is a long table in the middle (`table`), sized down through fallbacks: shorter, no end chairs, a narrow table with a 0.4 m walkway (a 3.3 m hall), a chair a side; along the long axis then across it. Failing the hall, it eats at a table in the widest other ground room (stores excepted), and failing that at a `board` against the wall with two chairs. A hall that sleeps (no bedroom) tries dine-then-bed and bed-then-dine, since a centred table can leave no 2.5 m wall run. Inns add one or two more tables. Then a plate dresser, shelves, maybe an armchair, and the kitchen's things if the hearth is here.
3. No bed yet: one in the largest room with a wall for it, or the roll throws.
4. The rest: kitchen (hearth cook spot, worktable with its own cook spot, barrels, sacks, shelves); parlour (corner armchair with a stool and candle, a rocker, rug, shelf, bookcase, chest); workroom (desk with parchment, scrolls, inkpot, books and a reading chair, bookcases, a scroll chest or bin); store (barrels, crates, sacks).
5. A room with no candle gets a sconce, or the roll throws.

Then a `gaze` spot before each window and a `talk` pair in the hall. A spot's stand is the first of its `stands` the final grid reaches; spots whose stand it does not reach are dropped.

## Walking

`TownInteriorStone` gives `walk.js` the house as stone: everything off the floor plan is wall, every solid stands where it is, the slab is a solid like any other. The walking grid is cells with no solid within 0.3 m (`BODY` cells) and headroom. `navRoute` routes residents along it, through the stair's tread centres between levels.

## Light

A per-vertex bake (`SHADE` in the renderer; vertices every 0.25 m so candle pools resolve) that stops at walls. A room's fill is `amb` scaled by its glass, falling to `dark` of that with no window; a brighter neighbour bleeds `bleed` through a doorway. Candles and the hearth fall off exponentially and saturate at `cap`. A doorway re-emits `door` of what reaches it into the next room, which is what makes closed-off rooms darker than the open leafkin interiors. Windows are the leafkin spill-and-beam. Under tables and beds the fill falls to `under`.

## Residents

`TownResidents` puts the building's townsfolk in state `inside` (`townInside`; none while the town sleeps) and up to `HOMEBODIES` 2 more in the house. Each picks a spot by `PICK` weights (seat, read, cook, gaze, bed, wander, talk), walks there by `navRoute`, and holds it for `HOLD_S`; at a bed it lies down and sleeps. They are lit by a uniform from the bake's candle, window and day levels.

She sleeps in any `bed` spot, as in a leafkin bed (`roomBeds` in `main.js`); a save made indoors names the town house by `{ t, i }`.

## Gate

`check-town-interiors.mjs` rolls 24 seeds of every building kind. It checks that each rolls, deterministically; the main room is twice the outside; the hall and kitchen are downstairs; every room has a light, the house a bed, a table with seats and a cook spot; beds are mostly upstairs in two-floor houses; workrooms have their papers. It then floods her walk by `player.js`'s step rule (only a climb is refused, and only when the 1.5 m stride baseline is also over 50°) from inside the door: she lands on the floor, never leaves the plan, reaches every spot and the stair top, and `navRoute` joins the door to every spot.

## Open

- About 89k vertices per house, mostly the per-0.25 m tessellation the bake needs. Unmeasured on the Quest.
