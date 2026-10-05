## 12. Locomotion and comfort

> **Covers:** VR and desktop movement, comfort settings, and the survey tools (fly mode, click-to-measure, double-click travel).
> **Read this when:** touching `src/player.js` input.

She is a first-time-ish VR user. Comfort outranks capability.

- **Left stick forward only.** Push up to walk in the direction she is facing. No strafe, no backward.
- **Snap turn 60°** by tilting either stick left or right. (Note: 30-45° is the more common choice; 60° is a larger vestibular jump but fewer of them. Implemented as a single tunable constant -- easy to change after trying it.)
- **Eased acceleration to ~1.3-1.5 m/s** (normal walking pace). The ease-in curve is what prevents nausea, not the top speed. Instant stop on release. **Headset only:** the nausea is from a moving world the inner ear disagrees with, which does not happen on a monitor, so the desktop keyboard path takes top speed instantly -- there the ramp is just input lag.
- **Comfort vignette** tunneling peripheral vision during movement, tightening with speed
- **Damp vertical camera motion** on slopes. Pitch and bob from naive terrain-following is a major nausea source
- **Max walkable slope going up** (§4); going down is never refused, even off a cliff. No sliding.
- **Water is swum, never walked** (§11): the look (the hand in VR) steers, at walking pace.
- **'A' toggles teleport mode** for covering distance. On land, a lob whose reach grows back over a 1 s cooldown after each landing, continuously per frame from a tenth of full; the arc is always blue, red only for a landing she could not stand on. An indoor stair is one block to the lob (`stairAt`: each tread filled to the next one's top), asked every 2 cm (`TELEPORT_STAIR_M`) as the 0.26 m samples step over a tread; a lob into its side, or into the wall over it, lands on the tread there. Swimming, a straight wavering line where she points instead, held under the surface, whose reach restarts from near her each time the stick is pushed and glides out while held.
- **Recenter** binding (long-press a face button)
- **Seated play is never penalised.** With the menu's `Height: Standard` (the default), `src/v2/eye-level.js` lifts the XR reference space until the 90th percentile of the last minute's level-gaze headset heights reads 1.6 m, easing at 15 cm/s. So no mechanic may ask her to crouch or bend: an empty hand's trigger that reaches nothing takes along its pointer, up to 2 m. Gate: `check-eye-level`.
- **Unstick** binding (§4)

### Desktop-only survey controls

None of these have a controller binding in the headset, and that is the point -- they are for reading a 16 km world during tuning, at speeds and freedoms §12 forbids in VR. Fly alone is reachable there, as a `fly` row on the menu's debug tab (toggle it again to walk), so a tuning session can still get somewhere specific without the far side of the map being a snap of the fingers.

- **Fly mode uses Minecraft's bindings**, because that is the muscle memory already in place: hold space to rise, hold shift to sink, either freely combined with WASD, double-tap space to drop back to walking. There is no separate "enter fly mode" key -- the first tap is it, since the only reason to press space on the ground is to leave it. Vertical is world-up regardless of gaze; forward follows the full look direction including pitch. Vertical input counts toward movement demand while flying and must not while walking, or the ascend key silently becomes a walk key.
- **Click to measure.** A click plants a red beam on the ground and puts a live rangefinder in the stats panel (slant, horizontal and vertical separately -- on a mountainside they diverge hard). Live against the *current* eye position rather than frozen at click time, so you can plant a beam on a ridge and walk the distance down; calibrating your own sense of scale needs the walk, not the snapshot. Drag-to-look and click-to-measure are separated by accumulated pointer travel (5 px), not by a modifier.
- **The hit test raymarches** `heightAt()`**, never raycasts the mesh.** Terrain geometry is the current LOD selection, so a mesh raycast would measure the same rock differently depending on how far away you were standing, which is the one error a measuring tool cannot make. It also works on chunks that have not finished streaming.
- **One stats panel per platform.** The head-locked canvas HUD is the only one that exists in the headset; the DOM corner panel is the only one worth having on a monitor. Both render the same lines with the same prefix-driven colour coding (`##` heading, `!!` bad, `++` good, `%%` measurement).

### Pacing

At 1.4 m/s, 800 m takes ~9.5 minutes. Against a ~15-20 minute thermal window, the summit should be roughly 10-12 minutes of walking from spawn. Place spawn accordingly.

---
