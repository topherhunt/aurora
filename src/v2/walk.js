// The surface she walks on, which is not the height field alone: a boulder is
// ground too. This is the object Player holds as its terrain, and the one the
// teleport arc flies against, so the two agree by construction about what can
// be stood on.
//
// heightAt is the field lifted to the top of any rock over the point, and
// slopeAt is taken off THAT, which is the whole collision model for stone: a
// rock's side is a step in the height, the slope limiter reads it as a wall
// too steep to climb, and its top is a surface with a slope like any other. A
// rock she can scramble onto is one whose top is within a stride's rise, exactly
// the rule the ground already follows. Tree trunks cannot be climbed and are a
// separate question -- see obstacleAt.

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

export class WalkSurface {
  constructor(field, rocks, trees) {
    if (!field || !rocks || !trees) throw new Error('WalkSurface: needs the field, the rocks and the trees')
    this.field = field
    this.rocks = rocks
    this.trees = trees
  }

  heightAt(x, z) {
    const h = this.field.heightAt(x, z)
    const top = this.rocks.blockTopAt(x, z, ROCK_WALK_MIN)
    return top > h ? top : h
  }

  /** Unit normal by central difference over `eps`, off the composed walk surface. */
  normalAt(x, z, eps = SLOPE_EPS, out = { x: 0, y: 1, z: 0 }) {
    const dx = (this.heightAt(x + eps, z) - this.heightAt(x - eps, z)) / (2 * eps)
    const dz = (this.heightAt(x, z + eps) - this.heightAt(x, z - eps)) / (2 * eps)
    const len = Math.hypot(dx, 1, dz)
    out.x = -dx / len
    out.y = 1 / len
    out.z = -dz / len
    return out
  }

  /** Slope in radians, the convention Player compares against maxSlopeDeg. */
  slopeAt(x, z, eps = SLOPE_EPS) {
    return Math.acos(Math.min(1, this.normalAt(x, z, eps).y))
  }

  /**
   * The solid thing standing on (x, z), or null: a tree trunk's padded footprint
   * as {x, z, r}. Player slides around it; the teleport arc stops at it.
   */
  obstacleAt(x, z, out) {
    return this.trees.trunkAt(x, z, TRUNK_PAD, out)
  }
}
