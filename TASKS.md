- [ ] Wild creatures roaming around, walking or running or flying (songbirds, eagles, deer, mythic creatures). They pause and turn to look at you when you get close

## Villages -- follow-ups

Content and layout are done and gated by `scripts/check-village.mjs` (see DESIGN.md §6). What is left:

- [ ] Replace the stand-in village site in `src/main.js` (`devVillageSite()`) with Phase A's scored villages, once the macro pass is wired into the runtime rather than only into `map.html`. `villages.setSites(phaseA.villages)` and delete the block -- the village content does not change, it just moves to where the water is.
- [ ] Connect villages to the §6 long-distance path network. Arteries currently end at the village edge; they should hand off to the A\* routes between villages so a road actually goes somewhere.
- [ ] Interiors. Every building is a closed shell right now -- doors are marked in the plan and geometry, but nothing opens.
- [ ] Villagers. The plan already knows where the market, the fires, the fields and the doors are, which is the hard half of a schedule.
- [ ] Swap placeholder geometry for the §9 asset pipeline. The kit is 45 geometries / 5.6k triangles of hand-built boxes and blobs; the shapes are sized and sited correctly, so this is a substitution, not a re-layout.
- [ ] Smoke drifts on a constant wind (`TUNING.wind` in `village.js`). Should follow the weather system when there is one.

## Day/night, sky and aurora -- follow-ups

The cycle, the horizon-map shadows, the starfield, the moon and the aurora are built and gated by `scripts/check-daynight.mjs` (see DESIGN.md §8 and §13). What is left:

- [ ] **Headset gate.** Per §17 rule 3, everything here is new, transparent and full-screen -- the aurora, the starfield and the sky dome have never been fill-rate tested on device. Read frametime and worst-frame at 01:00 in-world with the aurora at storm strength, which is the worst case the system can produce.
- [ ] The drifting cloud layer from §13 (two scrolling alpha-blended layers on the dome). Not built.
- [ ] Per-chunk fine horizon maps (§8). Deliberately skipped -- the 1024^2 global tier plus the AO bake carries it. Revisit only if crevice-scale shadowing looks flat on device.
- [ ] Aurora reflections in water. `src/water.js` samples the sky colour, not the aurora, so a lake under a full storm stays dark.
- [ ] Village window and fire light does not respond to the clock. `flameMat` is deliberately unshadowed so it stays bright at night, but nothing lights up *at dusk* -- windows should come on as the sun goes down.
- [ ] Substorm activity is a pure function of in-world time (`clock.js`, `AURORA_ACTIVITY`). When §10 weather exists, cloud cover should gate it -- an overcast night should hide the aurora entirely.
