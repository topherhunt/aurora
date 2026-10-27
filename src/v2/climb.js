// Climbing a watchtower's or scaffold's ladder (design/41-palisade-labyrinths.md): on the desktop she walks into it and the walk keys climb; in the headset an empty hand grips a rung and pulls. Either way Player.hold keeps her height until her next walk or teleport, and reaching the top steps her off at the ladder's exit. A scaffold's dropped rope lets her down at a steady pace (`rope`).
import { TOWER } from './layers/labyrinths.js'
import { SCAFFOLD } from './layers/scaffold.js'

// Metres a second up or down on the keys; how near the ladder's foot she must stand and how square to it she must face (her gaze along it, as a cosine) to start; how near a rung a gripping hand must be.
export const CLIMB = { speed: 0.9, reach: 0.35, face: 0.5, grip: 0.15 }

export class Climb {
  /** `palisades` answers ladderAt and rungAt (render/palisades.js). */
  constructor(player, palisades) {
    this.player = player
    this.palisades = palisades
    this.ladder = null
    this._sign = 1
    this.grips = { left: null, right: null }
    this._last = null
    this._rope = null
  }

  /** Onto `rope` (Palisades.ropeAt), hanging off the plank's edge at its top. */
  startRope(rope) {
    const p = this.player
    this.ladder = null
    this.grips.left = this.grips.right = null
    this._rope = rope
    p.rig.position.x = rope.x
    p.rig.position.z = rope.z
    p.hold(rope.top)
  }

  /** The rope's descent, before player.update: she goes down at SCAFFOLD.ropeSpeed with her walk spent, and steps off at the ground; a flight or a teleport lets go. */
  rope(dt, input) {
    const r = this._rope
    if (r === null) return
    const p = this.player
    if (!p.held || p.flying) {
      this._rope = null
      return
    }
    input.move = 0
    input.strafe = 0
    const y = p.rig.position.y - SCAFFOLD.ropeSpeed * p.scale * dt
    if (y > r.bottom) {
      p.hold(y)
      return
    }
    this._rope = null
    p.teleportTo(r.x, r.z, r.bottom)
  }

  /** The desktop's move, before player.update: walking at a ladder from its foot (facing in) climbs it, from the deck (facing out) climbs down it, and on it `input.move` is spent (zeroed); a strafe lets go, as does backing off its foot. `fx, fz` her gaze's level unit. */
  desk(dt, input, fx, fz) {
    const p = this.player, o = p.rig.position
    if (this.ladder !== null && !p.held) this.ladder = null
    if (this.ladder === null) {
      if (input.move <= 0 || p.flying || p.swimming || p.travel || p.standY === null) return
      // Anywhere on the deck: its corner posts stand closer than her body is wide, so the ladder is its only way off on foot.
      const l = this.palisades.ladderAt(o.x, o.z, TOWER.foot, p.standY)
      if (l === null) return
      const onDeck = Math.abs(p.standY - l.top) < 0.1
      if (!onDeck && Math.hypot(o.x - l.x, o.z - l.z) > CLIMB.reach) return
      // Down from the deck she faces from the ladder's exit toward its foot; up, against the ladder's face.
      const dx = l.x - l.exitX, dz = l.z - l.exitZ, dl = Math.hypot(dx, dz)
      if (onDeck ? (fx * dx + fz * dz) / dl < CLIMB.face : -(fx * l.ux + fz * l.uz) < CLIMB.face) return
      this.ladder = l
      this._sign = onDeck ? -1 : 1
      o.x = l.x
      o.z = l.z
      p.hold(onDeck ? l.top - 0.01 : Math.max(o.y, l.bottom))
    }
    const l = this.ladder
    if (input.strafe !== 0) {
      this.ladder = null
      return
    }
    const dy = this._sign * input.move * CLIMB.speed * p.scale * dt
    if (dy < 0 && o.y <= l.bottom + 1e-3) {
      this.ladder = null
      p.teleportTo(l.x, l.z, l.bottom)
      if (this._sign < 0) input.move = 0
      return
    }
    this._rise(dy)
    input.move = 0
  }

  /** A headset hand's grip this frame, its world position `at`: true when a press took a rung, so it drops nothing. While a grip holds, the rig moves against the hand so the hand stays on its rung; the last hand to grip leads. */
  grip(hand, pressed, justPressed, empty, at) {
    const p = this.player
    let took = false
    if (justPressed && empty) {
      const r = this.palisades.rungAt(at.x, at.y, at.z, CLIMB.grip)
      if (r !== null) {
        // From the deck, out past its posts to the ladder's foot line, as the top steps her on.
        if (!p.held && Math.abs(p.standY - r.top) < 0.1) {
          p.rig.position.x = r.x
          p.rig.position.z = r.z
        }
        this.grips[hand] = { y: at.y, ladder: r }
        this._last = hand
        if (!p.held) p.hold(p.rig.position.y)
        took = true
      }
    }
    const g = this.grips[hand]
    if (g === null) return took
    if (!pressed || !p.held) {
      this.grips[hand] = null
      return took
    }
    if (this._last !== hand) return took
    this.ladder = g.ladder
    this._rise(g.y - at.y)
    return took
  }

  // Up the ladder by `dy`: held between its foot and its top, and off onto its exit at the top.
  _rise(dy) {
    const p = this.player, l = this.ladder
    const y = Math.max(l.bottom, p.rig.position.y + dy)
    if (y < l.top) {
      p.hold(y)
      return
    }
    this.ladder = null
    this.grips.left = this.grips.right = null
    p.teleportTo(l.exitX, l.exitZ, l.top)
  }
}
