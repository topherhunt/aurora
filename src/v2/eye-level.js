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
// The reference space is re-offset only once the eased lift has moved this far: every re-offset nests another space.
export const LIFT_STEP_M = 0.02

export class EyeLevel {
  constructor() {
    this.samples = new Float64Array(WINDOW)
    this.sorted = new Float64Array(WINDOW)
    this.next = 0
    this.count = 0
    this.sampleIn = 0
    // The lift wanted, the lift eased toward it, and the lift the reference space carries.
    this.want = 0
    this.eased = 0
    this.applied = 0
  }

  /**
   * One frame. `eyeY` is the headset's height over the floor as the reference
   * space reports it (so with `applied` already in it), `pitch` the gaze's
   * angle off level. Returns the metres to raise the reference space by now: 0 to leave it.
   */
  update(dt, eyeY, pitch) {
    this.sampleIn -= dt
    if (this.sampleIn <= 0 && Math.abs(pitch) < LEVEL_GAZE) {
      this.sampleIn = SAMPLE_EVERY_S
      this.samples[this.next] = eyeY - this.applied
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
    const step = LIFT_RATE_M_S * dt
    const gap = this.want - this.eased
    this.eased = Math.abs(gap) <= step ? this.want : this.eased + Math.sign(gap) * step
    const d = this.eased - this.applied
    if (d === 0 || (Math.abs(d) < LIFT_STEP_M && this.eased !== this.want)) return 0
    this.applied = this.eased
    return d
  }

  /** Off, or a new session: no lift wanted, the samples forgotten. The space's own lift is the caller's to undo. */
  reset() {
    this.next = this.count = 0
    this.sampleIn = 0
    this.want = this.eased = this.applied = 0
  }
}
