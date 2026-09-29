# §32 -- Towns

The overworld has human towns: 8 to 25 of §19's buildings round a dirt clearing in a gently sloping valley, each door on a path, and one or two roads running out to the edge of town. A campfire and stools sit in the clearing, and townsfolk walk the ways between them. Towns are generated at boot from the heightmap, the layers and SEED, so every client plans the same ones and nothing is saved.

## The files

| piece | where |
|---|---|
| siting and layout (three-free) | `src/v2/layers/towns.js` `planTowns`, `TOWN` |
| drawing, walk colliders, tree exclusion | `src/v2/render/towns.js` `Towns`, `TOWN_BANDS` |
| generated roads in the document | `doc.js` `GENERATED_ID`, `serialize({ authored })`; `layers.js` `addGenerated` |
| boot | `main.js`, straight after `height.setLayers(layers)` (overworld only) |
| hearth and townsfolk | `src/v2/render/townsfolk.js` `Townsfolk`, `TownLife`, `townGraph`, `TOWNSFOLK`; `hearth.js` (`scale`) |
| hitching rails (three-free) | `towns.js` `planPosts`, `TOWN.posts` |
| road travellers (three-free) | `src/v2/render/journeys.js` `Journeys`, `JOURNEYS` |
| strider puppets, rails, reins, calls | `src/v2/render/striders.js` `Striders`, `STRIDER` |
| wild striders and her ride | `src/v2/render/wild-striders.js` `WildStriders`, `WILD`; `player.js` `mountAt`, `carry` |
| gate | `scripts/check-towns.mjs`; eyes: `tmp/townshot-drive.mjs`, `tmp/folkshot-drive.mjs`, `tmp/wildshot-drive.mjs` |

## Siting

A 40 m grid scan keeps points that are dry, under a 0.2 slope underfoot, 150 m from the spawn, even (rise under 12 m across a 50 m disc), and with a 45 m disc clear of water, rivers and authored roads. The score adds water within 220 m (1.5x, tapering with distance), a cliff within 180 m (slope ramping 1.2 to 2.4), half the valley depth against the 400 m ring, and subtracts unevenness. Selection takes each 1 km tile's best, keeping one above the snow line with chance 0.35, then fills from the best remaining sites below the snow up to 64. All towns stay at least 512 m apart. A layout with fewer than 8 buildings is dropped. The shipped map gets 63 towns: 2 above the snow, 15 by water, 40 under a cliff. Water caps the count, because only about 13% of flat sites have it within 220 m.

## Layout

- **Clearing** r = 5 m: two ring roads, 3 m wide at 1.5 and 4 m, just room for the hearth and a walk round it.
- **Roads**, 1 or 2, 2 m wide. They aim at the nearest other towns, at least 60° apart, and grow in 6 m steps, meandering on two sine waves (40-180 m wavelengths, up to 8 m off line). A road stops at water, at a grade over 22% or near an authored road. A road that stalls tries swinging ±20/40/60°. At the end each road is trimmed to just past the outermost building, ready to be joined into a network between towns.
- **Buildings** are placed in prestige order: inns, then longhouses, cottages and huts. Walls and roofs are picked by prestige, so slate and pantile sit near the centre and thatch at the edge. Each building takes the best of 90 random tries, preferring the nearest radius. Its yaw faces the nearest point on the network (the clearing's edge, a road, or an earlier path). The gap between boxes grows with radius, so the centre is dense and the edge is loose. A try is rejected on overlap, a road or path through it, a door path over 30 m or crossing another building, wet ground, a footprint that rises more than 2 m, or a door so far below the floor that it needs more than 4 steps.
- **Paths**, 0.8 m wide and at most 24 m, wind (two sine waves of 8-36 m wavelength, pinned at both ends) from 0.3 m in front of the door's face to the nearest network point, which is often an earlier house's path rather than the clearing. A try's rank adds 1.5 per metre of path to its radius, so a door beside an existing path beats one nearer the centre, and the ways branch instead of spoking out from the hub.

## Everything on the ground is a road

Clearing rings, door paths and roads are all road records with `town\d` ids. PathSet therefore flattens the ground under them, paints them dirt, cobbles them (litter) and keeps grass, ferns and rocks off them, with no terrain code of its own. PathSet ranks a road by its signed gap past the kerb, not by its centreline, so a narrow door path beside a wide road still wins where it is nearer; `out.dist` is still the centreline distance.

Buildings get no pad: they stand on the live, unflattened field (`surface`, which includes the fractal detail that is up to 1 m off the raw heightmap). The chosen seat is resampled on a 1 m grid, with the clearing ring's feather blended in. The floor sits at the highest sample, the plinth reaches 0.6 m below the lowest, and the door steps drop to the door's ground, with 4 treads reserved in front of the box. Rocks keep off buildings through `keepOut` (`townsOccupyAt`).

Generated roads ride every document the workers, the editor and the undo stack see. `serialize({ authored: true })` drops them for saves, because boot regenerates them and a saved copy would stack a second one underneath. So **editing a town road in the editor does not persist**.

## Drawing

Quest 2 has no multiview, so every draw call is paid twice. Towns use one merged mesh per nearby town and one shared instanced mesh for all distant buildings. A town swaps tier whole, by the distance to its edge (centre distance less `radius`, with 4 m hysteresis):

- **Near**: each town is one Mesh, detail 2 inside 60 m and detail 1 inside 140 m. Each tier's buildings are placed a few a frame within a 4 ms budget (detail 2: one building a frame across all towns), merged once when the last is placed, and cached on the town. Detail 1 starts within 300 m, detail 2 within 140 m; both are dropped past 420 m. A tier is shown only once merged; until then the town draws the tier below, or its far boxes. A swap only reassigns the mesh's geometry.
- **Far**: one `town-far` InstancedMesh with an instance per building mass. It is a 14-triangle box with a gable roof. `instanceColor` carries the roof tint (`ROOF_TINT`) and the instanced `aWallTint` the wall tint (`WALL_TINT`). A town at tier 0 within 1500 m shows its boxes. Each change repacks the shown instances (about 1500 at most) to the front and sets `count`, rewriting the matrix and colour buffers with no geometry rebuilt.

A standing town costs 2 draws per eye (its merged mesh, plus the far pool that every town shares). Detail 2 is 26-30k triangles for a 20-building town; placing it costs about 1.6 ms a building on desktop.

## Walking and trees

`Towns` is a walk stone: `columnAt` and `blockTopAt` give each building a solid span from the plinth to the roof surface. Trees ask `occupiesAt`, which covers each building's box plus 2 m; roads and paths keep trees off themselves. There is no town-wide clearing, so forest stands right up behind the houses. Wildlife passes `avoid` = `nearBuildingAt(x, z, 20)` and spawns nothing within 20 m of a building.

## Hearth and townsfolk

Each town's clearing holds a `Hearth` (§30's leafkin fire and stools) at `scale` 1.3, sized so the stool tops meet the mean seated underside of the human avatars. Every town draws one `hearthKit` built at boot on level ground (the clearing is flat to 5 mm under its ring roads), without the decimated tier: decimateHearth costs about 200 ms to save under 300 triangles. A hearth and its flame are hidden past 220 times their height, about 5 px. `underside` measures it from a clip's first frame as the hip joints' mean less a thigh's half-depth (it also seats riders from the `ride` clip). villagers.js `seatY` does not work here: its lowest hip-skinned vertex is the coat hem at the ground.

Townsfolk come from `farmer`, `shepherd` and `woodcutter`, dealt in turn, with 1 per hut or cottage and 2 per longhouse or inn. `townGraph` builds each town's ways as a graph: a 10-node ring at 4 m, the roads, and each door path attached where it meets the network. `TownLife` is a three-free, deterministic sim on the room clock. A town that wakes (within 250-330 m of its radius) replays its chapter from the start, `TOWNSFOLK.replay` (400) ticks a frame shared by the towns still catching up, so a full chapter takes up to 30 frames. Its people are not drawn until it is caught up. It reads heights only on the last two ticks. People leave home on errands (visit, home, sit at the fire, wander), keep right with a 0.2 m lane offset, chat when two meet (8-20 s, then a 45 s cooldown), and are all indoors by the chapter's turn.

The greeting is this client's alone. When she comes within 2 m of someone walking, standing or talking, half the time they carry on. Otherwise they stop, turn to her, and wave (0.12), beckon (0.08) or just look (0.8) for 2.5-4 s, so about one meeting in ten gets a gesture. They then walk straight back to where the sim has them at 1.5x pace. The cooldown is 20 s either way.

Every town's fire crackles through ambience.js's campfire rule, a loop per town placed at the clearing's centre whether or not the town is awake.

The pool is 4 puppets per body, so at most 12 townsfolk draws per eye, plus each live town's hearth mesh and flame. Each body's puppets go to its nearest 4 people who want one. A farther holder fades out to free its puppet.

## Striders and the road

Each town has 3 hitching rails of 3 tethers (`planPosts`), 3.1 m apart to fit the largest strider: one at the house nearest the clearing, then the farthest out, each along a house front beside its door. They are clear of the ways and at least 12 m apart. A rail is posts plus a bar, merged into one mesh per live town, with no collider.

`Journeys` gives each town's chapter 2 departure slots, each filled with chance 0.5. A filled slot is a rider (0.55) or a party of 1-3 on foot, bound for a town the roads reach from one of its ports within 2400 m without passing another town's. It is deterministic from SEED, so every client and both towns agree. A journey leaves the port end at t0 and reaches the destination's at t1, riding at 1.25 m/s or walking at 1.05 m/s. Anyone met on the road is therefore always heading somewhere real and arrives there. `_plan` fills a share of the tethers at the chapter's start: enough that every departing rider finds a strider, and few enough that every arriving rider finds a free tether. It throws if no count fits. A departing rider leaves its errand in time to fetch a strider, untie it, hop up and ride to the port by t0. An arrival appears at the port at t1, rides to a free tether, hops down, ties up and walks off as a guest in the journey member's body. An errand may instead `lead` a free strider on its rein for a leg or two and tie it at another rail. No lead starts near a departure's fetch or late in the chapter.

`Striders` draws at most 8 puppets, nearest first. Tied striders idle and fidget (a flutter on each fidget) and chirp every 25-70 s. Walking ones tread through ambience's `stride` rule. A rider sits the `ride` clip's underside on the saddle (the lowest midline crest of the back between the Hips and Chest bones) and arcs 0.4 m over the hop, and plays `ride-idle` while its mount stands. Reins are 1 px sagging lines from the knot, or from the leader's or rider's right wrist, to the strider's head. Within 300 m, `_road` draws every journey on the road that its source town isn't still holding. A traveller with another journey's traveller within 6 m ahead and closer sideways than their two half-widths (a walker 0.4 m, a strider 0.2 of its length) eases out to its own lane's side over 1 s, so the two pass rather than overlap.

Every strider is `STRIDER.size` times the shipped body: a mean of 1.5, spread 0.85-1.2 of that by a hash of its home tile, its town and mount id, or its journey. A tied strider fed a fish held to its beak (within 0.6 m of its head) pecks it over the sim's clip and coos, and trusts her from then on (`bond.trusted`, key `town:<town>:<mount>`). It does not follow, but she can mount it from its side as she does a wild one. `Townsfolk.lend` then hides it at its rail and `WildStriders.borrow` gives her a copy that keeps its tack; when that copy despawns it is `returned`, and the tied one reappears. Tied and road striders are bodies to the walker (`walk.addBody`).

## Wild striders and her ride

Out of the villages the overworld has unsaddled striders: the same GLB (one shared load, `loadStriderGlb`) drawn only to its tier's `tackFrom` index count, with the saddle measured on the bare body. Each 128 m tile has a home with chance 0.6 (dry, slope under 0.4, 20 m from any building), spawned within 120 m of her and let go past 150 m. A let-go home is not respawned until she has been out of range of it. They wander within 12 m of home: walk, peck (a coo now and then), fidget, idle. A `HeadTurn` solver on the head chain turns the neck to look (yaw, pitch, roll shared 0.4 / 0.35 / 0.25 down Neck, Neck1, Head).

The states (`_step`): within 6 m a calm one turns wary. It turns to face her, treading on the spot, and once it faces her within 0.5 rad it walks backward (the walk clip reversed) at 0.8 m/s × size / mean, muttering, until she is 8 m off. Its clip's rate is set on the clip's own action, not the mixer, because the mixer's clock also times the fade between clips and a fade run backward never ends. Within 3 m it attacks once (10 HP at the lunge, 0.66 s in, if she is within 3.8 m), then flees for 6 s or 40 m. One that has struck her once flees instead the next time she comes within 3 m. A fish held within 6 m makes it meek: it sits (the sit clip's flat hold looped), whimpers and tracks the fish. When its head comes within 0.6 m of the fish it eats it (`hands.eatLure`), trusts her for good (`bond.trusted`, by home key, shared with the towns' and kept across rooms for the session) and follows: standing within 2.5 m with only its neck turned to her, walking past 4 m, running past 10 m, and giving up past 60 m. A trusted one fed again grows ×1.05 for good (`bond.grown`), a tied town strider too. Walk and run speeds scale with size. Wild striders and her ride are bodies to the walker and to each other (a capsule 0.5 of its length long, 0.2 of it in radius). After boot, one spawn in ten is a panicked runner at 1.1 times its run, aimed 4-18 m to one side of her and chirping frantically until it is out of range.

She mounts a trusted, calm or following strider by touching its saddle (trigger, within 0.8 m across the ground and up to 1 m under it) or clicking within 0.5 m of it along the ray, from its side (the lateral offset of her head beats the longitudinal one). `player.mountAt` seats her eye 0.75 m (scaled) over the saddle, facing its way. While she rides, `ride()` replaces `player.update` and `carry` moves her rig with the body. The stick's push picks a gait band (stop under 0.15, walk to 0.7, run past), which it takes up after a random 0.35-1.0 s, at a random 0.85-1.15 pace. Speeds are for the mean size and scale with the strider's: walk 1.4-2.6 m/s, run 13-22 m/s. It eases up with tau 1.4 s and down with tau 0.6 s, switches to the run clip past 3.2 m/s, and past its natural run the clip's cadence grows only as the 0.6 power of the speed. Riding at speed, it veers at up to 1.5 rad/s round a trunk or body 0.5 s ahead (at least 1.5 m). Steering swings the neck first (up to 0.6 rad, tau 0.25 s), and the body turns after it at neck share × v / 3 m, capped at 0.9 rad/s, so it cannot turn standing. Pulling back backs it at 0.7 m/s with a balk every 2-4 s (fidget and a whine or chirp). Her seat height follows at tau 0.35 s, shortened as 1 + v / 5 m/s, with a 3.5 cm bob twice per walk cycle and a quarter as often at a run. A with an empty hand, or Space, puts her down on its right, left or behind, wherever is dry and clear. Teleporting is off while she rides; a flight or a revive lets go of the ride.


- The tints are eyeballed from a couple of distant shots.
- Rocks, deadwood and litter keep off the town's roads but not its yards.
- Market stalls, fences and livestock. Townsfolk make no sound of their own, and they avoid each other only through the lane offset.
- Rails have no collider, travellers pass through the player, townsfolk inside a town pass through each other and striders, and the reins are barely visible at 1 px.
- Trust and growth last only the session. A lent strider reappears at its rail if the sim unties it for a traveller. Riders' legs are posed for the shipped strider and may sink into a larger one.
- Wild striders are not netplayed (peers see a rider standing), pass through rocks and buildings when panicked, and speak with the tack striders' pitched chirp, whine and flutter.
