## 12. Locomotion and comfort

> **Covers:** VR and desktop movement, comfort settings, and the survey tools (fly mode, click-to-measure, double-click travel).
> **Read this when:** touching `src/player.js` input.

She is a first-time-ish VR user. Comfort outranks capability.

- **Left stick forward only.** Push up to walk in the direction she is facing. No strafe, no backward.
- **Snap turn 60°** by tilting either stick left or right. (Note: 30-45° is the more common choice; 60° is a larger vestibular jump but fewer of them. Implemented as a single tunable constant -- easy to change after trying it.)
- **Eased acceleration to ~1.3-1.5 m/s** (normal walking pace). The ease-in curve is what prevents nausea, not the top speed. Instant stop on release. **Headset only:** the nausea is from a moving world the inner ear disagrees with, which does not happen on a monitor, so the desktop keyboard path takes top speed instantly -- there the ramp is just input lag.
- **Comfort vignette** tunneling peripheral vision during movement, tightening with speed
- **Damp vertical camera motion** on slopes. Pitch and bob from naive terrain-following is a major nausea source
- **Max walkable slope ~35-40°**, no falling, no sliding (§4)
- **'A' toggles teleport mode** for covering distance
- **Recenter** binding (long-press a face button)
- **Unstick** binding (§4)

### Desktop-only survey controls

None of these exist in the headset, and that is the point -- they are for reading a 16 km world during tuning, at speeds and freedoms §12 forbids in VR.

- **Fly mode uses Minecraft's bindings**, because that is the muscle memory already in place: hold space to rise, hold shift to sink, either freely combined with WASD, double-tap space to drop back to walking. There is no separate "enter fly mode" key -- the first tap is it, since the only reason to press space on the ground is to leave it. Vertical is world-up regardless of gaze; forward follows the full look direction including pitch. Vertical input counts toward movement demand while flying and must not while walking, or the ascend key silently becomes a walk key.
- **Click to measure.** A click plants a red beam on the ground and puts a live rangefinder in the stats panel (slant, horizontal and vertical separately -- on a mountainside they diverge hard). Live against the *current* eye position rather than frozen at click time, so you can plant a beam on a ridge and walk the distance down; calibrating your own sense of scale needs the walk, not the snapshot. Drag-to-look and click-to-measure are separated by accumulated pointer travel (5 px), not by a modifier.
- **The hit test raymarches** `heightAt()`**, never raycasts the mesh.** Terrain geometry is the current LOD selection, so a mesh raycast would measure the same rock differently depending on how far away you were standing, which is the one error a measuring tool cannot make. It also works on chunks that have not finished streaming.
- **One stats panel per platform.** The head-locked canvas HUD is the only one that exists in the headset; the DOM corner panel is the only one worth having on a monitor. Both render the same lines with the same prefix-driven colour coding (`##` heading, `!!` bad, `++` good, `%%` measurement).

### Pacing

At 1.4 m/s, 800 m takes ~9.5 minutes. Against a ~15-20 minute thermal window, the summit should be roughly 10-12 minutes of walking from spawn. Place spawn accordingly.

---
