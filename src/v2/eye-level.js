// Seated play: in the headset every wearer stands at one eye height, whatever
// her real one. The headset's height over the floor is sampled while she looks
// roughly level -- never lying in a bed gazing up, never peering at the ground --
// and the reference space is lifted (Player.liftXR) until the FIT_PCT
// percentile of the last minute reads as STAND_EYE_M. A seated wearer is
// raised, a tall one lowered, and a duck of a few seconds is still a duck.
// Since nobody is penalised for her real height, no game mechanic may ask her
// to crouch or bend: the trigger off a hand that reaches nothing grabs along
// its ray instead (main.js).

// A standing eye, in her own metres (the rig's scale takes it to the world's).
export const STAND_EYE_M = 1.6
export const SAMPLE_EVERY_S = 0.5
export const WINDOW = 120
export const FIT_PCT = 0.9
export const MIN_SAMPLES = 4
// Sampled only while the gaze is within this of level.
export const LEVEL_GAZE = (35 * Math.PI) / 180
// The lift's range, and how fast it eases there: slow enough not to be felt as a lift.
export const LIFT_MIN_M = -0.4
export const LIFT_MAX_M = 0.9
export const LIFT_RATE_M_S = 0.15

export class EyeLevel {
  constructor() {
    this.samples = new Float64Array(WINDOW)
    this.sorted = new Float64Array(WINDOW)
    this.next = 0
    this.count = 0
    this.sampleIn = 0
    // The lift wanted, and the lift eased toward it that the reference space carries.
    this.want = 0
    this.lift = 0
  }

  /**
   * One frame. `eyeY` is the headset's height over the floor as the reference
   * space reports it (so with `lift` already in it), `pitch` the gaze's angle
   * off level. Returns whether `lift` moved, for the caller to re-offset the space.
   */
  update(dt, eyeY, pitch) {
    this.sampleIn -= dt
    if (this.sampleIn <= 0 && Math.abs(pitch) < LEVEL_GAZE) {
      this.sampleIn = SAMPLE_EVERY_S
      this.samples[this.next] = eyeY - this.lift
      this.next = (this.next + 1) % WINDOW
      this.count = Math.min(WINDOW, this.count + 1)
      if (this.count >= MIN_SAMPLES) {
        const sorted = this.sorted.subarray(0, this.count)
        sorted.set(this.samples.subarray(0, this.count))
        sorted.sort()
        const real = sorted[Math.floor(FIT_PCT * (this.count - 1))]
        this.want = Math.max(LIFT_MIN_M, Math.min(LIFT_MAX_M, STAND_EYE_M - real))
      }
    }
    const gap = this.want - this.lift
    if (gap === 0) return false
    const step = LIFT_RATE_M_S * dt
    this.lift = Math.abs(gap) <= step ? this.want : this.lift + Math.sign(gap) * step
    return true
  }

  /** Off, or a new session: no lift wanted, the samples forgotten. The space's own lift is the caller's to undo. */
  reset() {
    this.next = this.count = 0
    this.sampleIn = 0
    this.want = this.lift = 0
  }
}
