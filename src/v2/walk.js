// The surface she walks on, which is not the height field alone: a boulder is
// ground too. This is the object Player holds as its terrain, and the one the
// teleport arc flies against, so the two agree by construction about what can
// be stood on.
//
// heightAt is the field lifted to the top of any rock over the point, and
// slopeAt is taken off THAT, which is the whole collision model for stone: a
// rock's side is a step in the height, the slope limiter reads it as a wall
// too steep to climb, and its top is a surface with a slope like any other. A
// rock she can scramble onto is one whose top is within WALK.reach, exactly
// the rule the ground already follows. Dead wood is stone too, once it is
// placed (addStone): a low log is a step, a tall stump a wall, a buried log
// nothing. Tree trunks cannot be climbed and are a separate question -- see
// obstacleAt.
//
// SHE IS A CAPSULE, NOT A POINT ON A MAP. Asked from a foot height, heightAt
// reads the rock as spans of stone on the vertical line (Rocks.columnAt) and
// takes as ground only what she could step up onto; stone above that is over
// her head, and fits() is what says whether it is far enough over. That is
// what lets her walk under an overhang that the topmost-surface answer read as
// a wall, and it is the whole of the capsule: five vertical lines, hers and
// four at her shoulder, against the same triangles the props are seated on.
// The field itself cannot overhang and the trunks run ground to canopy, so the
// altitude only ever matters for stone.

// Metres of ladder size below which a stone is clutter she walks over rather
// than ground she stands on. Half the ROCK_STAND_MIN the props use: a prop on a
// half-metre cobble looks perched, but a walker stepping up onto one does not.
const ROCK_WALK_MIN = 0.5
// The trunk footprint is widened by this so she stops at the bark rather than
// with her origin on the axis.
const TRUNK_PAD = 0.15
// Half of LOCOMOTION.stride, the same 1.5 m the slope limiter measures over,
// so slopeAt and the limiter keep asking the same question.
const SLOPE_EPS = 0.75

// Her capsule at full size; a WalkSurface holds these times its scale.
export const WALK = {
  // Metres of rise, from where her feet are, within which a stone's top is a
  // step she can take rather than a ceiling. A waist-high mantle. Below
  // `height` by enough that a ledge is never both a step and a bump at once,
  // and it is the ceiling on a vertical stone face she can walk straight up:
  // the slope limiter's stride rule allows 1.79 m of rise over 1.5 m, which on
  // a rock's flank would be a wall, and this caps stone at a rise a person
  // could actually get a knee onto.
  reach: 1.2,
  // Metres above her feet that stone may not intrude below. Her crown, with a
  // hand's clearance; the headset's real height is not consulted.
  height: 1.9,
  // Her shoulder. Where the four ring columns of fits() are dropped.
  radius: 0.3,
}

// Rocks on one vertical line, [bottom, top] pairs. Eight is far past what any
// point in the world has stacked over it; a column that fills it is reported as
// truncated by Rocks.columnAt and treated here as blocked, never as clear.
const SPAN_CAP = 8
const spans = new Float64Array(SPAN_CAP * 2)
const RING = [[1, 0], [0, 1], [-1, 0], [0, -1]]

export class WalkSurface {
  /**
   * `scale` is her size against the world (DESIGN.md §30, her half size in a
   * glade): her reach, her crown, her shoulder, the stone she steps over and
   * the pace slopeAt measures over all shrink with her, while the stone and
   * the trunks stay what they are.
   */
  constructor(field, rocks, trees, { scale = 1 } = {}) {
    if (!field || !rocks || !trees) throw new Error('WalkSurface: needs the field, the rocks and the trees')
    if (!(scale > 0)) throw new Error(`WalkSurface: scale must be positive, not ${scale}`)
    this.field = field
    this.trees = trees
    this.scale = scale
    this.reach = WALK.reach * scale
    this.height = WALK.height * scale
    this.radius = WALK.radius * scale
    this.rockMin = ROCK_WALK_MIN * scale
    this.trunkPad = TRUNK_PAD * scale
    this.slopeEps = SLOPE_EPS * scale
    // Every layer that is stone to her, the rocks first. Each answers
    // `columnAt(x, z, minSize, out)` and `blockTopAt(x, z, minSize)` in
    // Rocks' terms and is read on its own into the one span buffer; one with
    // a `deckAt(x, z)` says where its top is a floor she stands level on.
    this.stone = [rocks]
  }

  /**
   * Another layer of stone -- the dead wood -- added after construction
   * because it is placed on the ground she already has.
   */
  addStone(layer) {
    if (!layer || typeof layer.columnAt !== 'function' || typeof layer.blockTopAt !== 'function') {
      throw new Error('WalkSurface.addStone: needs a layer with columnAt and blockTopAt')
    }
    this.stone.push(layer)
  }

  /**
   * The ground at (x, z). Without `y`, the field or the highest stone over the
   * point, whichever is higher -- what a teleport arc, a spawn or a HUD readout
   * wants. With `y`, her current foot height, the highest stone whose top is
   * within her reach of her feet, else the field: stone further up is over her
   * head and not ground at all.
   */
  heightAt(x, z, y) {
    const h = this.field.heightAt(x, z)
    let best = h
    if (y === undefined) {
      for (let s = 0; s < this.stone.length; s++) {
        // The stone's own surface, not the prop seat Rocks settles into it: a
        // teleport landed on the seat stands inside the boulder and rides up to
        // the top the walker's columnAt read gives on the next frame.
        const top = this.stone[s].blockTopAt(x, z, this.rockMin, false)
        if (top > best) best = top
      }
      return best
    }
    const ceiling = y + this.reach
    for (let s = 0; s < this.stone.length; s++) {
      const n = this.stone[s].columnAt(x, z, this.rockMin, spans)
      for (let i = 0; i < n; i++) {
        const top = spans[i * 2 + 1]
        if (top > best && top <= ceiling) best = top
      }
    }
    return best
  }

  /**
   * Whether her capsule fits standing at (x, z) with her feet at `standY`: no
   * stone crosses the head volume (standY + reach, standY + height) on her own
   * vertical line or on the four at her shoulder. A stone topping out inside
   * `reach` is a step beside her and does not count, whatever its height.
   *
   * When it does not fit, `out` gets the plan direction AWAY from the stone as a
   * unit vector -- the mean of the clear side -- for the caller to slide along,
   * or zero when it is her own line that is blocked and there is no side to
   * favour. Untouched when she fits.
   */
  fits(x, z, standY, out) {
    const lo = standY + this.reach
    const hi = standY + this.height
    if (this._crossed(x, z, lo, hi)) {
      if (out) out.x = out.z = 0
      return false
    }
    let px = 0
    let pz = 0
    let hit = 0
    for (let k = 0; k < RING.length; k++) {
      const rx = RING[k][0] * this.radius
      const rz = RING[k][1] * this.radius
      if (!this._crossed(x + rx, z + rz, lo, hi)) continue
      hit++
      px -= rx
      pz -= rz
    }
    if (hit === 0) return true
    if (out) {
      const len = Math.hypot(px, pz)
      // Opposite ring points both hit: she is in a slot with no side to favour.
      out.x = len > 1e-9 ? px / len : 0
      out.z = len > 1e-9 ? pz / len : 0
    }
    return false
  }

  /**
   * The underside of the lowest stone over (x, z) from `y` up -- a roof, an
   * overhang -- or Infinity under the sky; -Infinity when `y` itself is in
   * stone. What flight is held under (Player._fly).
   */
  ceilingAt(x, z, y) {
    let low = Infinity
    for (let s = 0; s < this.stone.length; s++) {
      const n = this.stone[s].columnAt(x, z, this.rockMin, spans)
      if (n >= SPAN_CAP) return -Infinity
      for (let i = 0; i < n; i++) {
        const bottom = spans[i * 2]
        if (bottom <= y && y <= spans[i * 2 + 1]) return -Infinity
        if (bottom > y && bottom < low) low = bottom
      }
    }
    return low
  }

  /** Whether any stone on the vertical line through (x, z) crosses (lo, hi). */
  _crossed(x, z, lo, hi) {
    for (let s = 0; s < this.stone.length; s++) {
      const n = this.stone[s].columnAt(x, z, this.rockMin, spans)
      if (n >= SPAN_CAP) return true
      for (let i = 0; i < n; i++) {
        if (spans[i * 2 + 1] > lo && spans[i * 2] < hi) return true
      }
    }
    return false
  }

  /**
   * Unit normal by central difference over `eps`, off the composed walk
   * surface -- or straight up on a stone's deck (a boat's sole), whose slope
   * is its own and not the lake bed's a stride either side of it.
   */
  normalAt(x, z, eps = this.slopeEps, out = { x: 0, y: 1, z: 0 }) {
    for (let s = 0; s < this.stone.length; s++) {
      if (this.stone[s].deckAt && this.stone[s].deckAt(x, z)) { out.x = out.z = 0; out.y = 1; return out }
    }
    const dx = (this.heightAt(x + eps, z) - this.heightAt(x - eps, z)) / (2 * eps)
    const dz = (this.heightAt(x, z + eps) - this.heightAt(x, z - eps)) / (2 * eps)
    const len = Math.hypot(dx, 1, dz)
    out.x = -dx / len
    out.y = 1 / len
    out.z = -dz / len
    return out
  }

  /** Slope in radians, the convention Player compares against maxSlopeDeg. */
  slopeAt(x, z, eps = this.slopeEps) {
    return Math.acos(Math.min(1, this.normalAt(x, z, eps).y))
  }

  /**
   * The tree trunk standing on (x, z) as its padded footprint {x, z, r}, or
   * null. Player slides around it; the teleport arc stops at it.
   */
  obstacleAt(x, z, out) {
    return this.trees.trunkAt(x, z, this.trunkPad, out)
  }
}
