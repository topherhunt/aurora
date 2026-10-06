# 33 -- Health, sleep and eating

Code: `src/v2/vitals.js` (the rules), `src/v2/eating.js` (food and the mushrooms' effects), `src/v2/render/vitals-hud.js` (what she sees and hears), the fall in `src/player.js`, the wiring in `src/v2/main.js` (`stepVitals`, `stepHud`, `stepEating`, `stepSize`, `revive`), the relay's sleep rule in `server/src/main.js`. Gates: `scripts/check-vitals.mjs`, the bedside check in `scripts/check-interiors.mjs`.

## Health

She has 100 HP, not saved: the game saves only when she wakes, and waking heals her to full. Loading a game or starting a new one also heals her.

She is harmed by a fall, by a wild strider's strike (§32), by a mushroom she eats or an animal it maddens (§Eating), and by a fen dragon's bite (30 HP; the chase is in the header of `render/dragons.js`). The Player has no gravity: walking off a ledge drops her feet to the ground below in one frame, and the damped `smoothY` carries her eye down after it. A walking frame whose drop is steeper than she could climb (`maxSlopeDeg` over the ground covered, plus a centimetre) is falling, but only a frame that moved her can start a fall: the ground under her spawn sinks ~47 m while the leafkin village builds, and standing still through that is not a fall. The fall runs from where the first such frame began to the ground of the first frame that is not one, divided by her scale so it is in her own metres. Past 4 m it costs 5 HP a metre. Everything that places her without walking goes through `_landAt` or `_startSwim`, and both forget a fall in progress. So landing out of flight, a travel's end or a drop into deep water never harms her through `Player.fell`. A walking teleport is priced separately: `aimTeleport` takes the drop from her feet to a dry landing (in her metres), turns the arc and ring orange when `fallDamage` of it is above 0, and `fireTeleport` harms her by that much on landing. A teleport into water or a swim teleport costs nothing. Her strider carries her (`Player.carry` forgets a fall), and its own falls are priced on landing by `fallDamage(m, FALL.riddenM)`, free to 8 m (§32). A hillside steeper than her climb, walked down, adds up as one fall.

Every harm (`harm` in main.js, scaled by any porcini's guard) plays `interact-thud.mp3` on the `near` bus and flashes the veil red, fading over 0.35 s (`VitalsHud.flash`). Below half health (`Health.hurt` from 0 at 50 HP to 1 at 0 HP), a heartbeat plays on the `near` bus. It is a lub-dub synthesized at load (`heartbeatBuffer`), and it quickens from 1.3 s to 0.75 s as the hurt grows. A red veil pulses with each beat, and it thickens and darkens toward the edges of the view. Whenever she is below full health, a donut in the bottom-left shows what is left: at a fixed glance down and left in the headset, and at the frustum's corner on a desktop.

At 0 HP the view goes black over 1.5 s. The card then offers her saved game or a new one: page buttons on a desktop (`qa-death-load`, `qa-death-new`), A and B on the controllers. `revive` closes any house she is in, rebuilds the saved game's room when she is in another one (a village is keyed by its door), puts her where the save says, heals her and lets the black lift. The menu's Load is the same `revive` under the room-swap fade, and a refresh boots into the same place.

Every save is made waking, so in a house. The save stores which house and which of its beds she fell asleep in, with its door's landing as the place the village is built around. The house is rolled off the village's seed rather than saved, so a load opens it again (`intoSavedHouse`, once the villagers are ready) and stands her beside that bed, facing away from it as if just up. `besideBed` takes the first spot on a ring just off the bed's outline, nearest the middle of the side toward the room's middle, where her body fits on the bed's own floor. A loft bed fills its ledge, so there the spot is along the ledge past an end. check-interiors holds every rolled bed to having such a spot, walkable from the door.

## Sleep

`Sleep` runs awake -> lying -> closing -> asleep -> opening -> awake:

- **Lying** starts when she is in a bed that is free: no leafkin resident at its activity there (lying down, asleep or getting up), and no peer's head over its mattress and under 1 m of the peer's height over it (`inBed`). A bed taken once she lies in it does not put her out.
  - **Laid in it:** walking or teleporting onto it lays her in it, as does a click on it within 3 of her metres on a desktop. Her feet are on it (`feetOnBed`) from within her walk radius plus 0.05 m of its outline, so bumping its side counts, and only on the frame they arrive, so standing up beside it does not lay her down again. A teleport may land on a free bed even where its edge is too steep a step. Her head goes over the pillow. On a desktop the camera looks up past her feet. In the headset the rig turns about her head so her level gaze is straight up and the top of her view is toward the pillow, and her real head still moves the view from there.
  - **In her own body, in the headset:** her head within the bed's width over its pillow end, less than 1 m of her height over the mattress and not more than 0.3 m under it, and looking up (forward.y > 0.7).
- **Closing:** after 5 s still (the head drifting under 0.15 of her metres and turning under 20 degrees), the lids close over 2.5 s. They are two curved edges meeting across the view's middle, in the veil's shader.
- **Getting up** before she sleeps (a key, click or button while laid in a bed; moving out of the bed or a button once the lids start closing, in her own body) opens the lids again.
- **Asleep:** the view is black until any button, or in the headset a sit-up (the head rising or falling by 0.25 of her metres) or a turn of more than 35 degrees.
- **Waking:** she is healed and the lids open over 1.5 s. In her own body the game saves then. Laid in a bed, she lies awake 2 s more (`SLEEP.upS`), or until a press, then stands beside the bed (`besideBed`) facing away, or where a click took her from, and the game saves. "Game saved" shows for 3 s. This is the only save: the menu has Load and New game, no Save.

While sleep or death holds her (laid in a bed, lids closing, asleep, or dead), the world's controls stand down. Every press goes to waking her or to the death card.

## A room that all sleeps

Her pose carries `asleep` while she sleeps. When she and every peer in the room are asleep, the room skips to the sun's next crossing of the horizon (`hoursToBoundary`). That is at most one night, 13.1 h at latitude 65 and declination -4. With no relay the clock skips locally. With a relay, the peer with the lowest id asks with a `clock` message, repeating every 0.5 s until the room's `skipHours` moves. The relay grants a `clock` to a client alone in the room, or to any client once every client's last pose says it sleeps. The skip happens once per shared sleep; another needs someone to wake and everyone to sleep again.

## Eating

A carrot, a fish or one of the five mushrooms is food (`edible`). Held within 0.16 of her metres of her mouth (a point 7 cm under and 6 cm ahead of the eyes) for 2 s in the headset, or with the left button held 2 s on a desktop, it is eaten (`Bites`). On a desktop the held thing slides to the bottom middle of the view as the bite runs, and a press held over 300 ms on food is not a click when it lets go. Eating plays `action-eat.mp3`. A creature eating from her hand (`Hands.eatLure`) plays it where the lure was, at 0.7 rate for a strider or a stag.

A carrot or a fish heals 10 HP. Every mushroom harms 10 HP, then (`Effects`, stepped each frame):

- **Ink cap:** she shrinks to half over 6 s (eased in ratio), down to 1/8 of the room's size, with `effect-zoom.mp3`. **Parasol:** she doubles, up to 2x, with the zoom reversed. The size never wears off and is saved; `herScale` is the room's scale times it, and `stepSize` carries a change to the rig, every walk surface, the hands and the wire. A cave's walk stays at unit scale.
- **Fly agaric:** for 15 s (in over 3, out over 3) the view pulses green, a synthesized buzz plays on the `near` bus, and a green flare (render/flares.js) hangs 4 m over every town, leafkin mouth, cave mouth and roost within 500 m.
- **Porcini:** for 60 s each halves every harm, so they stack (0.5 per porcini under its 60 s), and the view pulses brown, deeper with each, to an alpha of 0.75.
- **Chanterelle:** for 5 minutes the view darkens and every wild animal and strider is drawn black. One within 10 m of her comes at her: wildlife goes live in a `mad` mode that follows and strikes for 5 HP, a wild strider charges, and a tied town strider turns and strikes from its rail. Leafkin and villagers are untouched. The black fades over 3 s after.

The tints are one premultiplied wash over the veil (`Effects.tint`), the porcini under the agaric under the chanterelle. Timed effects are not saved, and death clears them; a new game also gives her back her size.
