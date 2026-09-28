# 33 -- Health and sleep

Code: `src/v2/vitals.js` (the rules), `src/v2/render/vitals-hud.js` (what she sees and hears), the fall in `src/player.js`, the wiring in `src/v2/main.js` (`stepVitals`, `stepHud`, `revive`), the relay's sleep rule in `server/src/main.js`. Gates: `scripts/check-vitals.mjs`, the bedside check in `scripts/check-interiors.mjs`.

## Health

She has 100 HP, not saved: the game saves only when she wakes, and waking heals her to full. Loading a game or starting a new one also heals her.

The only harm is a fall. The Player has no gravity: walking off a ledge drops her feet to the ground below in one frame, and the damped `smoothY` carries her eye down after it. A walking frame whose drop is steeper than she could climb (`maxSlopeDeg` over the ground covered, plus a centimetre) is falling, but only a frame that moved her can start a fall: the ground under her spawn sinks ~47 m while the leafkin village builds, and standing still through that is not a fall. The fall runs from where the first such frame began to the ground of the first frame that is not one, divided by her scale so it is in her own metres. Past 4 m it costs 10 HP a metre. Everything that places her without walking goes through `_landAt` or `_startSwim`, and both forget a fall in progress. So a teleport, landing out of flight, a travel's end or a drop into deep water never harms her. A hillside steeper than her climb, walked down, adds up as one fall.

Below half health (`Health.hurt` from 0 at 50 HP to 1 at 0 HP), a heartbeat plays on the `near` bus. It is a lub-dub synthesized at load (`heartbeatBuffer`), and it quickens from 1.3 s to 0.75 s as the hurt grows. A red veil pulses with each beat, and it thickens and darkens toward the edges of the view. Whenever she is below full health, a donut in the bottom-left shows what is left: at a fixed glance down and left in the headset, and at the frustum's corner on a desktop.

At 0 HP the view goes black over 1.5 s. The card then offers her saved game or a new one: page buttons on a desktop (`qa-death-load`, `qa-death-new`), A and B on the controllers. `revive` closes any house she is in, rebuilds the saved game's room when she is in another one (a village is keyed by its door), puts her where the save says, heals her and lets the black lift. The menu's Load is the same `revive` under the room-swap fade, and a refresh boots into the same place.

Every save is made waking, so in a house. The save stores which house and which of its beds she fell asleep in, with its door's landing as the place the village is built around. The house is rolled off the village's seed rather than saved, so a load opens it again (`intoSavedHouse`, once the villagers are ready) and stands her beside that bed, facing it. `besideBed` takes the first spot on a ring just off the bed's outline, nearest the middle of the side toward the room's middle, where her body fits on the bed's own floor. A loft bed fills its ledge, so there the spot is along the ledge past an end. check-interiors holds every rolled bed to having such a spot, walkable from the door.

## Sleep

`Sleep` runs awake -> lying -> closing -> asleep -> opening -> awake:

- **Lying** starts when she is in a bed.
  - In the headset: her head within the bed's width over its pillow end, less than 1 m of her height over the mattress and not more than 0.3 m under it, and looking up (forward.y > 0.7).
  - On a desktop, a click on the bed within 3 of her metres lays her in it: head on the pillow, looking up past her feet. Her standing pose is kept to give back.
- **Closing:** after 5 s still (the head drifting under 0.15 of her metres and turning under 20 degrees), the lids close over 2.5 s. They are two curved edges meeting across the view's middle, in the veil's shader.
- **Getting up** before she sleeps (moving out of the bed, a key or click on a desktop, a button in the headset once the lids start closing) opens the lids again.
- **Asleep:** the view is black until any button, or in the headset a sit-up (the head rising or falling by 0.25 of her metres) or a turn of more than 35 degrees.
- **Waking:** she is back on her feet under the black, healed, and the game saves. The lids open over 1.5 s and "Game saved" shows for 3 s. This is the only save: the menu has Load and New game, no Save.

While sleep or death holds her (asleep, lids closing, laid in a bed on a desktop, or dead), the world's controls stand down. Every press goes to waking her or to the death card.

## A room that all sleeps

Her pose carries `asleep` while she sleeps. When she and every peer in the room are asleep, the room skips to the sun's next crossing of the horizon (`hoursToBoundary`). That is at most one night, 13.1 h at latitude 65 and declination -4. With no relay the clock skips locally. With a relay, the peer with the lowest id asks with a `clock` message, repeating every 0.5 s until the room's `skipHours` moves. The relay grants a `clock` to a client alone in the room, or to any client once every client's last pose says it sleeps. The skip happens once per shared sleep; another needs someone to wake and everyone to sleep again.
