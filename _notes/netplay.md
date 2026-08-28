# Netplay: two people hiking the same world

**Goal.** Topher and a friend each put on a Quest 2, open `https://aurora.topherhunt.com/`, and walk the current v2 world together, seeing each other's head and hands. No voice chat -- the Quest's own party system covers that. No shared world editing, no gameplay, no persistence. Just presence.

## Verdict on feasibility

Perf is a non-issue. Against `src/budget.js` (350k tris, 45 draw calls, 12k batched instances) one peer costs ~500-1500 tris, 1 draw call if all peer parts live in a single InstancedMesh, and zero batched instances. Head + 2 hands is 21 floats = 84 bytes; at 20 Hz that is ~1.7 KB/s each way. Per-frame JS is one small parse plus 3 lerps and 3 slerps.

The one real render risk is the **shader compile hitch** when the peer material first draws -- on Quest that is several dropped frames, and it would land exactly when the friend walks up. Build the avatar and force compilation at boot (`renderer.compile`, or render once parked behind the camera), never on join.

WebRTC is not needed. A relay costs maybe 30-60ms over a datachannel and saves building signaling, STUN and TURN. At walking speed with an interpolation buffer, 150ms of avatar lag is invisible.

## Hosting decision: move off GitHub Pages to a VPS

**Decided: VPS**, one box serving both static and the socket, Caddy for automatic TLS plus a reverse proxy to Node.

The websocket was the prompt but is *not* the real reason -- an https page can open `wss://` to any TLS host on any domain, since WebSockets do not do CORS preflight. The real reason is `src/v2/terrain/terrain-v2.js:393`, which documents SharedArrayBuffer as blocked on COOP/COEP cross-origin-isolation headers. Pages cannot set response headers at all, so that heightmap copy-per-worker can never be retired there. Supporting reasons: one deploy target, tunable cache headers and Brotli on the assets, no build artifacts in git, and a server for persisting world edits (today the editor only saves through the vite dev-server middleware at `vite.config.js:142`, so world editing is localhost-only).

Size is not a factor either way: `dist/` is 11 MB across 165 files, nothing over 2 MB.

Cost of moving: TLS renewal (Caddy handles it), uptime, OS patching, and a deploy that becomes rsync + `systemctl restart` instead of a push.

## Architecture

**Server** -- Node + `ws` in `server/`, with its own `package.json` and no build step. The first
implementation is a state relay, not a game server:

- clients send `{pose: [head xyz+quat, left xyz+quat, right xyz+quat]}` whenever, ~20 Hz
- server keeps `Map<id, lastPose>`
- server broadcasts a full snapshot of everyone-but-you on its **own** 20 Hz tick, stamped with a server tick number

Tick-based rather than echo-on-receive so send rate and broadcast rate are decoupled, and a joining client gets everyone on the next tick rather than waiting for them to move.

**Client** -- `src/net.js` owns the socket, throttled send, receive buffer, and interpolation;
`src/v2/render/avatar.js` draws the peer head and hands; `src/v2/main.js` samples world-space poses.

Sampling is free: `player.headPosition(headTmp)` already runs every frame near line 1786 and calls `camera.getWorldPosition()`. Hands need wiring that does not exist yet -- `src/input.js` polls `session.inputSources` for gamepad buttons and axes only, no poses. Add `renderer.xr.getControllerGrip(0|1)` and `rig.add()` them so their world transforms include the rig.

**Gate**: `scripts/check-net.mjs` in the existing convention -- headless, drives two fake clients through the real server, asserts pose round-trip and stale-peer eviction. The behaviour hardest to test in a headset gets tested on the desktop.

## Non-negotiables

- **Send world space.** `player.headPosition()` is already world space. Never send `camera.position` -- `rig.add(camera)` at `src/v2/main.js:169` makes it rig-local and meaningless to the peer.
- **Use the peer's `y` verbatim.** Do not re-snap to local `height.heightAt()`. Terrain LOD streams around *your* head, so a distant peer stands on coarse ground and would bob.
- **Never trust peer timestamps.** Two Quests have unrelated clocks. Interpolate off the server tick number, or off local arrival time.
- **Render peers ~100-150ms in the past** off a buffer of recent snapshots. Raw application strobes at 20 Hz.
- **Snap threshold >5m** instead of lerping. `travelTo` is 500 m/s and fly is up to 1000 m/s -- both desktop-only (`setFlying(false)` on sessionstart, `main.js:1847`), but a desktop peer surveying would otherwise slide across the valley over 5 seconds.
- **Never touch three.js objects in `onmessage`.** Buffer, then apply inside `tick()`.
- **Bake nametag textures once** at join. A 2D canvas draw plus texture upload inside `tick()` loses ~8ms on Quest.

## Gotchas

- **Idle timeouts.** Proxies kill idle sockets around 60s. Heartbeat every 20-30s; server drops clients silent for ~45s.
- **Headset removal kills everything silently.** The proximity sensor suspends the tab, `setAnimationLoop` stops, the socket dies with no close frame. Needs reconnect-with-backoff, and peers stale >3s should fade out rather than leave a statue standing in the meadow.
- **Recentering is already handled.** `player.recenterXR()` (`src/player.js:489`) offsets the reference space *and* compensates `rig.position`, so world coords survive. A common multiplayer bug that this codebase happens to already avoid -- do not undo it.
- **Room code in the URL** (`?room=xyz`) plus a per-room connection cap. An open relay costs nothing to abuse and the code costs one line.
- **World divergence.** Both clients load the same static `public/world/layers.json`, so terrain agrees. If one edits locally, worlds silently differ. Editing is desktop-only and disabled entering XR, so this is fine for hiking -- just know it exists. *Unverified assumption:* prop scatters are pure functions of `SEED` + position and therefore match across clients. Only affects whether "I'm at the big rock" means the same thing to both; never netplay correctness.
- **Foveation is at 1.0** (`main.js:157`), so off-center avatars are blurry in the periphery. Expected, not a bug.

## Open question

**Which page gets it.** The root `/` now serves v2; the old prototype is preserved at `/v1`. The net layer belongs on the root v2 page.

## Dev loop

Cleanest is the USB localhost loopback from the `vite.config.js` comment, with the relay running
locally on its own port:

```
VITE_WS_URL=ws://localhost:3004/ws npm run dev
npm run relay
adb reverse tcp:5173 tcp:5173
adb reverse tcp:3004 tcp:3004
```

The page is `http://localhost:5173`, which counts as a secure context for WebXR, and because it is not https there is no mixed-content rule -- plain `ws://localhost:3004` connects with no cert dance.

For a LAN headset, use a local TLS reverse proxy for both Vite and the relay, or test through the
deployed HTTPS site; the relay itself intentionally speaks plain HTTP/WebSocket on localhost only.

## Build order

1. VPS + Caddy, serving the current static build and proxying `/health` and `/ws` for Aurora.
2. `server/` relay + `scripts/check-net.mjs`, tested headlessly with two clients.
3. `src/net.js` + peer head and hand markers, then test presence in the headset.
4. Consider COOP/COEP + SharedArrayBuffer for the terrain workers, now that the host can set headers.
