// The hum of a shut castle ward (design/46-castle-wards.md): one loop placed on the nearest membrane, full at the sheet and gone at `reach` m.
export const WARD_HUM = { reach: 6, level: 0.7 }

export class WardHum {
  /** `engine` the SoundEngine. */
  constructor(engine) {
    this.engine = engine
    this.voice = null
  }

  /** Once a frame: `near` is castles.nearShutWard's answer, or null when no ward is shut or she is not in a castle. */
  update(near) {
    if (near === null || near.d >= WARD_HUM.reach) { this.stop(); return }
    if (this.voice === null) {
      this.voice = this.engine.loop('wardHum', { bus: 'near', directional: true, gain: [1, 1] })
      this.voice.start()
    }
    this.voice.setPosition(near.at.x, near.at.y, near.at.z)
    this.voice.setLevel(WARD_HUM.level * (1 - near.d / WARD_HUM.reach) ** 2)
  }

  stop() {
    if (this.voice === null) return
    this.engine.unloop(this.voice)
    this.voice = null
  }
}
