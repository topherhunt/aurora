# Castles

Procedural castles: a 3D path graph of rooms and edges (`src/v2/castles/layout.js`), the exterior and interior shells it implies (`shell.js`), previewed in `gen-castle.html`. Gated by `scripts/check-castle-layout.mjs`.

## Layout

A ring of corner towers joined by curtain walls round a court, plus keep, gatehouse, mid towers, hall and one lookout whose summit holds the chest. The lookout is always part of the castle, either a raised back corner or a tower against the keep's back, and never stands on its own. Cells are 4 m, storeys 4 m; walls are 2.4 m thick and two storeys high. Rooms are one section-storey each, about 28-45 a castle (typically ~34). The interior is the layout scaled by 2 across and 1.5 up (6 m storeys), so it is roomier than the outside but keeps every direction and adjacency. A stair is a 2 m spiral of 15 steps (0.4 m rise) about its cell's centre, so stairs stacked in one cell make one helix; the slab above is open only over its high steps, and the rest of the disc is the landing. A roof ladder stands in a cell corner, or on an axis in a round room, clear of any spiral's hole. The maze score (route length, in/out switches) passes about 19 seeds in 20.

## Shell

Sections are lofted footprints: the rect with each corner cut askew in two facets, or a 12/16-gon for round towers (half the one-cell towers), sides broken at half cells. Rings: a footing 6 m below ground, a root crown spreading 0.8 m at grade and gone by 2.4 m, a narrow jittered waist, a slow swell, then a corbel band flaring 0.7 m (hall 0.25, wall outer face 0.45; a wall's court face spreads at most 0.3). Ground doors stand proud of the crown as portals. Used roofs get a parapet ring of merlons, each flared and jittered so none is square. A wall's parapet is lofted on the wall's own stations and top-ring vertices, so it bends with the warp and leaves no gap underneath; unused tower roofs get a two-stage concave spire. Bridges are decks on a stone arch springing from the faces they join. The court is a separate flagstone mesh (the road's cobble tile, 3 m): a solid slab under the whole court rect, plus a 30 deg ramp out of every door the entry node uses, which runs 11 m so it dives into a falling hillside. The ramp is cambered with bevelled edges, jittered stations and heights, and widens by 0.9 m toward its foot. Masonry uses `public/buildings/castle_stone.webp` (FLUX, made seamless, 256 px, 4 m a tile; `tools/buildings/castle-textures.mjs`). One position-only warp (`src/buildings/v2/warp.js`) bends everything, keeping coincident vertices coincident.

Z-fighting rules, enforced by the coplanar-overlap gate on the unwarped shell:
- A box side a tall neighbour stands against is a hard plane for every ring, and only one parapet stands on it (the taller section's, on a tie the earlier).
- Anything butting masonry (door frames, bridge ends) runs into it rather than ending on its plane.
- Landings stop 8 cm short of the cap they meet: the warp bends two tessellations of one plane apart by a few cm, so even same-coloured coplanar faces would flicker.
- Two flights never share court (layout claims each flight's plan rect).

## Siting

`src/v2/layers/castles.js` `planCastles`, run in the world-plan boot: at most one castle per 1400 m region (75% of regions), its seed the first of up to 8 rolls that passes the maze score. Candidates every 40 m are ranked by prominence (at least 3 m over a ring 120 m out), clear of labyrinths, towns (radius + 60 m) and their keep-outs; the first with a yaw at which `fitAt` holds wins. `fitAt` asks that the ground under the whole footprint lies within the footing (5.5 m) below the floor, which stands `CASTLE.raise` (1.2 m) over the sited ground, and that the gate ramp's foot meets the ground. Castles shape no ground. Each gets a trail from its gate ramp's foot to the road network, as labyrinth gates do. `CastleSites.occupiesAt` is the footprint keep-out: trees, rocks and deadwood read it through `BiomeField.castleAt`, wildlife through main.js `wildAvoid`.

## Props

`furnish.js` returns records `{ kind, x, y, z, yaw, w, d }`: in the court (wells, carts, hay, woodpiles, barrels, dummies, braziers) and in every room by its role from section kind and storey (store, great hall, barracks, guard, armoury, solar, passage). Every portal keeps a clear disc and every pair of a room's portals a clear lane, so no prop blocks the maze. `shell.js` meshes them in its own palette: court props are baked into the exterior's full tier, room props into the interior. The town interior builders are not reused, since they are drawn with the town-interior ShaderMaterial and baked-light attributes.

## Runtime

`src/v2/render/castles.js`, bands in `CASTLE_BANDS`:
- **Far card:** seed 3's exterior and court, photographed once from the gate side (ortho, alpha-cut, dilated). Each site gets 2 crossed instances at yaw and yaw+90 deg, scaled by its size, until its meshes draw. Seen obliquely, a crossed card shows its edge.
- **Build:** within 220 m (dropped past 260) `castles/worker.js` builds the layout, both exterior tiers, the court, the shaded interior and the solids off the main thread, about 90-170 ms a castle. A castle that throws there replies with its error; the site keeps its card and the error is thrown on the main thread with its seed. In the worker bundle three is a stub (`vite.config.js` `noThreeInWorkers`), so shell.js emits plain arrays and `toGeometry` makes the BufferGeometry on the main thread.
- **Meshes:** drawn within 200 m. The full exterior within 50 m, the mid tier (no merlons, slits, bars or court props) past 55. The mid tier saves only 20-30% of triangles (full 6.8-11k), and draw calls dominate at that range.
- **Interior:** one unlit mesh, its colours shaded by face direction in the worker, set down `CASTLE_RISE` (320 m) over the site while she is inside.

## Collision and portals

`solids.js` reduces each castle to plain data. The exterior is section bodies, crowns and battlement bands, plus boxes (flight treads, bridge decks and rails, hatches, the court slab, the chest, court props), ramps, and door notches cut through them. The interior is room and doorway air, everything else solid, plus each spiral's steps, post and hole air, and prop boxes; only the storeys within one of her feet are opened, which keeps a column under the walk's 8-span cap. `Castles` is a stone layer on the overworld walk. Inside, a `CastleInteriorStone` drives a walk of its own, swapped in and out as a house's is (main.js `openCastle` / `closeCastle`).

Spirals are walked: interior tops are decks (`deckAt`), so the walk takes each step as level floor. Every non-barred outside door is closed by its leaves (`public/buildings/door.png`, one per leaf by explicit UVs; the gate has two, mirrored), solid on both sides. `portals()` gives each door its leaves' exterior and interior faces with a standable arrival each, a blink for every ladder (inside at its foot, outside at its roof hatch), the rope and the chest. The rope fires when she walks at it; doors fire on touching their leaves (within 0.5 m of the face), the rest on entering their zone. Arrivals land outside their zone, and `arrived()` marks the zone she lands in as current, so a portal never sends her straight back.

The summit chest holds 40-90 coins and 2-3 HOARD gems, at loot place `k` keyed on the region (main.js `layLoot`). The rope lets her down the lookout's face through `Climb.startRope`.

## Not yet built

- Walked ladders: a ladder is a blink.
- The gate's leaves are the procedural door texture; an AI-generated double-door mesh would replace them.
- Barred doors are impassable.
- Room corner facets are not collided, and collision ignores the warp, which moves masonry up to about 0.27 m.
- While she is inside, `inCastle` is a state of its own, not `indoors`, so overworld systems (rain among them) may still run.
- Garrison NPCs, an openable chest, portal-style room visibility inside, and the card dithering into the mesh.
