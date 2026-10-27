# Castles

Procedural castles: a 3D path graph of rooms and edges (`src/v2/castles/layout.js`), the exterior and interior shells it implies (`shell.js`), previewed in `gen-castle.html`. Gated by `scripts/check-castle-layout.mjs`.

## Layout

A ring of corner towers joined by curtain walls round a court, plus keep, gatehouse, mid towers, hall and one lookout whose summit holds the chest. Cells are 4 m, storeys 4 m; walls are 2.4 m thick and two storeys high. Rooms are one section-storey each, about 28-45 a castle (typically ~34). The interior is the layout scaled by 1.5, so it is roomier than the outside but keeps every direction and adjacency. The maze score (route length, in/out switches) passes about 19 seeds in 20.

## Shell

Sections are lofted footprints: the rect with each corner cut askew in two facets, or a 12/16-gon for round towers (half the one-cell towers), sides broken at half cells. Rings: a splayed footing 4 m below ground, three jittered shaft segments, then a corbel band flaring 0.45 m (hall 0.15, walls outer face 0.3). Used roofs get a parapet ring with merlons; unused tower roofs get a two-stage concave spire. One position-only warp (`src/buildings/v2/warp.js`) bends everything, keeping coincident vertices coincident.

Z-fighting rules, enforced by the coplanar-overlap gate on the unwarped shell:
- A box side a tall neighbour stands against is a hard plane for every ring, and only one parapet stands on it (the taller section's, on a tie the earlier).
- Anything butting masonry (door frames, bridge ends) runs into it rather than ending on its plane.
- Landings stop 8 cm short of the cap they meet: the warp bends two tessellations of one plane apart by a few cm, so even same-coloured coplanar faces would flicker.
- Two flights never share court (layout claims each flight's plan rect).

## Siting

The footprint is large: about 30-40 m across, wider than a village house cluster. It must merge fully into the ground. The shell already sinks a splayed footing 4 m below grade, and that depth is necessary, not slack. Siting must:
- choose hilltops and low summits whose relief under the whole footprint stays within the footing depth (flatten the terrain under the court if needed, as labyrinths do);
- never let the footprint overhang a cliff or steep drop where the footing or the underside of a section would show;
- space castles roughly evenly, and give each a trail to the road network like labyrinth gates.

## Not yet built

Siting and trails, the runtime exterior with LOD, the far card (chosen from preview seeds) dithering into the mesh, the openable chest, furnishing and garrison NPCs, portal-style room visibility inside, the real 256 px rock texture.
