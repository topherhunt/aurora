// Will-o'-wisps: after dark, outdoors, a few lights that wait ahead of her on the way to the nearest hideout whose skeleton is not
// hers yet, and drift on each time she catches up (design/45-bone-friends.md §Wisps).

import THREE from '../../three-instance.js'

export const WISP = {
  count: 3,
  // A hideout within `nearM` of her and further than `arriveM` draws them; past `dayness` they are gone.
  nearM: 220,
  arriveM: 8,
  dayness: 0.25,
  // Their waypoint, `aheadM` before her when they first show; she within `waitM` of it, it moves `hopM` on. She `strayM` off, it starts again before her.
  aheadM: 12,
  waitM: 5,
  hopM: 14,
  strayM: 40,
  speedMps: 3.5,
  hoverM: 1.3,
  fadeS: 1.5,
  sizeM: 0.45,
}

/** A soft round glow, white at the centre to clear at the rim. */
function glowTexture(n = 32) {
  const data = new Uint8Array(n * n * 4)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2)
    const a = Math.max(0, 1 - r) ** 2
    data.set([255, 255, 255, Math.round(a * 255)], (j * n + i) * 4)
  }
  const t = new THREE.DataTexture(data, n, n)
  t.needsUpdate = true
  return t
}

export class Wisps {
  constructor(scene) {
    this.group = new THREE.Group()
    this.group.name = 'v2-wisps'
    scene.add(this.group)
    this.texture = glowTexture()
    this.material = new THREE.SpriteMaterial({ map: this.texture, color: new THREE.Color(0.6, 1, 0.85), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false })
    this.sprites = Array.from({ length: WISP.count }, () => {
      const s = new THREE.Sprite(this.material)
      this.group.add(s)
      return s
    })
    this.target = null
    this.anchor = null
    this.at = { x: 0, z: 0 }
    this.alpha = 0
    this.group.visible = false
  }

  /**
   * One frame. `places` the hideouts `{ key, x, z }` whose skeleton is not hers yet; `heightAt(x, z)` the overworld's ground.
   * `outdoors` false (a cave, a castle, a house) hides them at once.
   */
  update(dt, now, feet, { dayness, outdoors, places, heightAt }) {
    let target = null, best = WISP.nearM
    if (outdoors && dayness < WISP.dayness) {
      for (const p of places) {
        const d = Math.hypot(p.x - feet.x, p.z - feet.z)
        if (d < best && d > WISP.arriveM) { best = d; target = p }
      }
    }
    if (!outdoors) this.alpha = 0
    if (target !== null && (this.target === null || target.key !== this.target.key)) this.anchor = null
    if (target !== null) this.target = target
    this.alpha = Math.max(0, Math.min(1, this.alpha + (target !== null ? dt : -dt) / WISP.fadeS))
    this.group.visible = this.alpha > 0
    if (!this.group.visible) { this.target = null; this.anchor = null; return }
    const t = this.target
    if (this.anchor === null || Math.hypot(this.anchor.x - feet.x, this.anchor.z - feet.z) > WISP.strayM) {
      this.anchor = this._toward(feet, t, WISP.aheadM)
      this.at.x = this.anchor.x; this.at.z = this.anchor.z
    } else if (Math.hypot(this.anchor.x - feet.x, this.anchor.z - feet.z) < WISP.waitM) {
      this.anchor = this._toward(this.anchor, t, WISP.hopM)
    }
    const dx = this.anchor.x - this.at.x, dz = this.anchor.z - this.at.z, d = Math.hypot(dx, dz)
    const step = Math.min(d, WISP.speedMps * dt)
    if (d > 0) { this.at.x += (dx / d) * step; this.at.z += (dz / d) * step }
    const night = Math.min(1, (WISP.dayness - dayness) / WISP.dayness * 2)
    this.material.opacity = this.alpha * Math.max(0, night)
    this.sprites.forEach((s, i) => {
      const ph = now * (0.7 + 0.23 * i) + i * 2.1
      const x = this.at.x + Math.cos(ph) * 0.7, z = this.at.z + Math.sin(ph * 1.3) * 0.7
      s.position.set(x, heightAt(x, z) + WISP.hoverM + Math.sin(now * 1.7 + i * 1.9) * 0.25, z)
      s.scale.setScalar(WISP.sizeM * (0.8 + 0.2 * Math.sin(now * 9 + i * 4)))
    })
  }

  /** `m` on from `from` toward `t`, never past it. */
  _toward(from, t, m) {
    const dx = t.x - from.x, dz = t.z - from.z, d = Math.hypot(dx, dz)
    if (d <= m) return { x: t.x, z: t.z }
    return { x: from.x + (dx / d) * m, z: from.z + (dz / d) * m }
  }

  get stats() {
    return { target: this.target && this.target.key, alpha: this.alpha, at: this.anchor && { ...this.at } }
  }

  dispose() {
    this.group.removeFromParent()
    this.material.dispose()
    this.texture.dispose()
  }
}
