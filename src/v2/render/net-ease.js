// ---------------------------------------------------------------------------
// Lockstep without the pop, for the leafkin and the villagers (design/30-leafkin.md,
// Netplay). Her startle is raised LEAD_TICKS ahead so a peer hears it before
// stepping that tick; one heard late all the same rolls the layer back, and
// the creature is drawn where it was, the error eased off rather than jumped.
// ---------------------------------------------------------------------------

import { swing } from '../../sim/score.js'

// About a round trip through the relay on a synced clock (net.js offsetMs).
export const LEAD_TICKS = 4
// The drawn error eases off at 1/e per SMOOTH_S, never closing faster than CLOSE_MPS, so a body metres out slides at a run rather than flicks.
export const SMOOTH_S = 0.35
export const CLOSE_MPS = 4
// A drawn body moving JUMP_M in one frame past what MAX_MPS covers in it (a run, a closing error) is a pop the eye sees.
export const JUMP_M = 1
export const MAX_MPS = 8
// Where a pop line goes beyond the console: main.js points it at the relay's log (net.js Netplay.diag).
export const popLog = { send: null }

/** The error fields a creature record carries: the drawn offset, whether it was drawn last frame, and where the timeline a rollback is about to undo would draw it this frame. */
export const easeFields = () => ({ ox: 0, oy: 0, oz: 0, oh: 0, shown: false, was: { x: 0, y: 0, z: 0, heading: 0 } })

/** Before a rollback: where the old timeline draws `c` at `a` ticks past its last (a frame may run past it, so `a` is not clamped), its height `y` as the layer reads it. */
export function keepWas(c, a, y) {
  const w = c.was
  w.x = c.px + (c.x - c.px) * a + c.ox
  w.y = y + c.oy
  w.z = c.pz + (c.z - c.pz) * a + c.oz
  w.heading = c.ph + swing(c.ph, c.heading) * a + c.oh
}

/** Into `pose` (x, y, z, heading) the frame's lerped pose plus the error: taken on whole after a rollback, dropped when not drawn last frame, else eased by `dt`. */
export function ease(c, pose, x, y, z, heading, rolled, dt) {
  if (!c.shown) c.ox = c.oy = c.oz = c.oh = 0
  else if (rolled) {
    c.ox = c.was.x - x; c.oy = c.was.y - y; c.oz = c.was.z - z
    c.oh = swing(heading, c.was.heading)
  } else {
    const d = Math.hypot(c.ox, c.oy, c.oz)
    if (d > 0) {
      const k = (d - Math.min(d * (1 - Math.exp(-dt / SMOOTH_S)), CLOSE_MPS * dt)) / d
      c.ox *= k; c.oy *= k; c.oz *= k
    }
    c.oh *= Math.exp(-dt / SMOOTH_S)
  }
  pose.x = x + c.ox
  pose.y = y + c.oy
  pose.z = z + c.oz
  pose.heading = heading + c.oh
}

/** How far `pose` stands from (x, y, z), where it was drawn last frame, if that is a pop; else 0. */
export function popM(pose, x, y, z, dt) {
  const m = Math.hypot(pose.x - x, pose.y - y, pose.z - z)
  return m > JUMP_M + MAX_MPS * dt ? m : 0
}

/** A pop the eye would see (`what` says what it was), counted on the layer and said once a second at most, to the console and popLog. */
export function warnPop(layer, seconds, what) {
  layer.jumps++
  if (seconds - layer.jumpSaidAt < 1) return
  layer.jumpSaidAt = seconds
  const line = `[net] ${layer.constructor.name} pop ${JSON.stringify(what)}, ${layer.jumps} so far`
  console.warn(line)
  if (popLog.send) popLog.send(line)
}
