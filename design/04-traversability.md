## 4. Traversability: free to go down, limited going up

> **Covers:** the walkability limiter -- climbing refused past a slope, descending never -- and what that costs.
> **Read this when:** touching `src/player.js` slope logic or a reachability gate.

Requirement: deep gulches she cannot climb out of the way she came, and nothing ever stops her going down.

**Enforce a maximum walkable slope on the way UP, with no falling damage and no sliding.** (The angle is 50° and is derived from the shader's rock threshold, not picked -- see below. The argument here does not depend on which angle it is.)

**Descending is never refused, however steep or deadly** -- walking off a ledge drops her to the ground below (damped by the vertical smoothing, which is the fall), and a teleport may land anywhere below her feet. `_walkable` tests signed rises, so only climbing is limited. **This gives up the no-trap guarantee**: a pit with walls past the limit is one she can drop into and not walk out of. Flight and teleport are the ways out; there is no reachability gate for pits.

Gulches, cliffs, and gorges then function exactly as intended: hard visual barriers she must path around, forcing the wending route up each valley. She can stand at the lip of a canyon and look down into somewhere she cannot go, which is better scenery than somewhere she can.

**The limiter needs a baseline, and the obvious one is wrong.** "Steeper than 38°" is not a property of a point, it is a rise over a run, and the run has to be chosen. The first implementation used her travel distance for the frame, which is 2 cm at walking pace and 72 Hz -- so it was not measuring a slope at all, it was measuring a 2 cm difference, and any 40 cm hummock became a wall. `Player._walkable` now takes the gentler of two baselines, one frame and one stride (1.5 m), so an obstacle has to keep going uphill for two paces before it counts. The one-frame test is kept as the first of the two rather than replaced: a lookahead on its own would also read every cliff from 1.5 m back and stop her there, which is an invisible standoff bubble around each wall.

**Stone is the one place the pair is near-identical rather than bit-identical.** She is a capsule against the rocks (`src/v2/walk.js`): the ground at a point is asked from her foot height and is the highest stone top within `WALK.reach` of it, so a boulder over her head is a ceiling, not a floor, and she walks under it. Asked from the far end on the way back, that ground can be a stone the way out could not reach if one tops out in `(y + reach, h1 + reach]`. It is always within the slope rule of where she stands, so she is seated on a slightly different surface coming back than going, never fenced in by it. Stone at head height (between reach and `WALK.height` on her line or on four at her shoulder) blocks on entry only, the trunk rule, so a tile regrown around her still lets her out. Dead wood is stone to her, not a trunk: `WalkSurface.addStone` registers the scatter once it is placed, and `Deadwood.columnAt` and `blockTopAt` answer the same spans `Rocks` do -- a stump a standing cylinder of its trunk from its seat to its height, a log a lying cylinder of its mesh's core (measured off the shipped pick, not its box, whose centre the log's one-sided stubs pull off the wood) round its pitched axis -- so a log within `WALK.reach` is a step she walks over, a stump over her crown a wall she slides along, a log she lands on from a flight ground she walks about on, and a log the ground has swallowed nothing at all; the creatures that walk her surface (wildlife, snowmen) read the same heights. `scripts/check-walk.mjs` walks the bridge, wall, ledge, step, reverse and cliff-descent cases.

### The walk limit is the shader's rock line, not a taste

`LOCOMOTION.maxSlopeDeg` is 50, and it is derived rather than chosen. The rule: **she can walk on anything the renderer does not draw as bare rock.**

`chunk-mesh.js` `shade()` ramps rock in over `smoothstep(0.86, 0.62, ny)`, so rock begins to show at 30.7 deg and is total at 51.7 deg. A limit of 38 sat *inside* that ramp, on ground still shaded as mostly grass. Measured across a 4 km box at the limiter's own 1.5 m stride, the fraction of the world blocked while being drawn as vegetation:

```
limit            38     42     45     48     50     55
grassy-blocked  7.36%  0.43%  0.00%  0.00%  0.00%  0.00%
walkable        70.8%  77.8%  82.4%  86.5%  88.8%  93.6%
```

**7.36% of the world looked climbable and refused her.** That is the entire "areas that look like they should be walkable that you can't walk on" report, and it is what sent an earlier pass hunting through the cliff layer for a cause that was never in the terrain -- the same class of error as the connectivity instrument above, and the fifth instance of it.

45 is where it reaches zero. 50 keeps 5 deg of margin, because the limiter reads a 1.5 m stride while the shader reads a per-vertex normal at whatever the LOD ring supplies, and those two need not agree at the metre scale. **If the shader's ramp moves, the limit moves with it: they are one decision.**

Raising the limit only enlarges what she can climb, and so shrinks the set of pits she can drop into and not walk out of. `phase-a.js` carries the same number as `MAX_WALK_SLOPE`, duplicated because that file runs in a worker and `player.js` pulls in THREE -- if the two ever disagree, the connectivity report and the village siting describe a world she cannot walk.

Two supporting pieces:

- **Connectivity validation in Phase A.** Build a coarse walkable mask (slope < max, not deep water), flood-fill from spawn, and verify every village and the summit are in the reachable set. If not, either lower the path-carving slope penalty (§6) or reseed. Log loudly on failure -- do not ship a world with an unreachable summit.
- **An "unstick" binding** that teleports to the nearest walkable cell. Pure insurance against a collision bug. Cheap, and the alternative is her removing the headset.

Water: shallow water is walkable, deep water is not. Same mask, so lakes are barriers and stream crossings are not.

---
