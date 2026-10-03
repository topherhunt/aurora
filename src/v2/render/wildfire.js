import { TriFlames, TRI_TORCH } from './fire-tris.js'

// ---------------------------------------------------------------------------
// WILDFIRE: the flames a spark leaves on a tree, a fern or a ground stick, and
// the torches' flames, all in one TriFlames draw. design/37-fire.md has the rules;
// the short of them:
//
//   a flame dies 5-10 s after it is lit, dimming over its last FADE_S;
//   the third flame on one object makes every flame on it big, chars the
//   object, and holds them to BIG_LIFE_S from then;
//   each second a flame has SPREAD_ODDS of lighting another flame on a
//   flammable within SPREAD_M of it;
//   a torch's tip held within TOUCH_M of a flammable for IGNITE_S lights a flame on it, again each IGNITE_S it stays;
//   a flame is a pure function of where and when, so a peer's copy (`remote`)
//   burns the same and only the lighting machine spreads it.
//
// WHAT BURNS is asked of `near(x, y, z, r)`, which returns the flammables within r metres as { key, kind, x, y, z, radius, height, char() }: the world's, so this file knows nothing of trees or ferns. `key` names an object across machines by kind and position. `char()` blackens it.
// ---------------------------------------------------------------------------

export const LIFE_S = [5, 10]
export const BIG_LIFE_S = 20
export const BIG_AT = 3
export const BIG_GROW = 1.6
export const FADE_S = 1.5
export const RISE_S = 0.4
export const SPREAD_M = 1
export const SPREAD_ODDS = 0.12
export const SPREAD_STEP_S = 1
export const LIGHT_M = 0.3
export const TOUCH_M = 0.12
export const IGNITE_S = 2
const TOUCH_STEP_S = 0.1
export const CAP = 48
export const TORCH_CAP = 8
export const FLAME = { height: 0.3, radius: 0.09 }
export const TORCH = { height: 0.24, radius: 0.07 }

/** A flame's level at `now`: risen in over RISE_S, faded out over its last FADE_S, 0 to 1. */
export const levelAt = (flame, now) => Math.min(1, (now - flame.born) / RISE_S, (flame.die - now) / FADE_S)

export class Wildfire {
  /**
   * @param near   (x, y, z, r) -> flammables, see the header
   * @param rng    () -> [0, 1), for the lifetimes and the spread
   * @param flames the draw, or null for a headless gate: { place(i, x, y, z, opts), update(t, glow, eye), count, group }
   */
  constructor(scene, near, { rng = Math.random, flames = new TriFlames(CAP + TORCH_CAP, TRI_TORCH) } = {}) {
    this.near = near
    this.rng = rng
    this.flames = flames
    if (flames.group) scene.add(flames.group)
    this.list = []
    this.step = 0
    // Called with each flame this machine lights (a spark's, a spread's); the net sends it.
    this.onLight = null
    this.lit = new Map()
    // Seconds each object has had a torch tip in touch, by key.
    this.touching = new Map()
    this.touchStep = 0
  }

  get count() { return this.list.length }

  /** How many flames burn on an object, by its key. */
  onObject(key) {
    let n = 0
    for (const f of this.list) if (f.key === key) n++
    return n
  }

  _add(x, y, z, target, now, life, { local, big = false }) {
    if (this.list.length >= CAP) return null
    const flame = { x, y, z, key: target ? target.key : null, target, born: now, die: now + life, big, local, phase: this.rng() * 6.28 }
    this.list.push(flame)
    if (target) this._count(target, now)
    return flame
  }

  /** The object has BIG_AT flames: they all grow, hold to BIG_LIFE_S, and the object chars once. */
  _count(target, now) {
    const here = this.list.filter((f) => f.key === target.key)
    if (here.length < BIG_AT) return
    for (const f of here) {
      f.big = true
      f.die = Math.max(f.die, now + BIG_LIFE_S)
    }
    if (!this.lit.has(target.key)) {
      this.lit.set(target.key, now)
      target.char?.()
    }
  }

  /** A spark struck at (x, y, z): a flame beside the nearest flammable within LIGHT_M, or nothing. Returns the flame. */
  spark(x, y, z, now) {
    const hit = this._nearest(x, y, z, LIGHT_M)
    if (!hit) return null
    const life = LIFE_S[0] + this.rng() * (LIFE_S[1] - LIFE_S[0])
    const flame = this._add(x, y, z, hit, now, this.lit.has(hit.key) ? BIG_LIFE_S : life, { local: true, big: this.lit.has(hit.key) })
    if (flame && this.onLight) this.onLight(flame, life)
    return flame
  }

  /** A flame a peer lit, at its position and with its life: burned here, never spread from here. */
  remote(x, y, z, life, now) {
    const hit = this._nearest(x, y, z, LIGHT_M * 2)
    return this._add(x, y, z, hit, now, life, { local: false, big: hit ? this.lit.has(hit.key) : false })
  }

  _nearest(x, y, z, r) {
    let best = null
    let bd = Infinity
    for (const o of this.near(x, y, z, r + 1)) {
      // Distance to the object's axis, less its radius: how far the spark is from its surface, and zero inside it.
      const dy = y < o.y ? o.y - y : y > o.y + o.height ? y - (o.y + o.height) : 0
      const d = Math.max(0, Math.hypot(x - o.x, z - o.z) - o.radius)
      const dist = Math.hypot(d, dy)
      if (dist < r && dist < bd) { bd = dist; best = o }
    }
    return best
  }

  /** One frame. `tips` are the lit torches' flame points { x, y, z, phase }; `eye` is the head, which the flames' LODs are measured from. Burns down, spreads once a SPREAD_STEP_S, then writes every flame to the draw. */
  update(dt, now, tips, eye) {
    this.list = this.list.filter((f) => f.die > now)
    for (const k of this.lit.keys()) if (this.onObject(k) === 0) this.lit.delete(k)
    this._touch(dt, now, tips)
    this.step += dt
    while (this.step >= SPREAD_STEP_S) {
      this.step -= SPREAD_STEP_S
      this._spread(now)
    }
    let n = 0
    for (const f of this.list) {
      const level = Math.max(0, levelAt(f, now))
      const k = (f.big ? BIG_GROW : 1) * level
      this.flames.place(n++, f.x, f.y, f.z, { height: FLAME.height * k, radius: FLAME.radius * k, phase: f.phase })
    }
    if (tips.length > TORCH_CAP) throw new Error(`Wildfire: ${tips.length} torches past TORCH_CAP ${TORCH_CAP}`)
    for (const t of tips) this.flames.place(n++, t.x, t.y, t.z, { height: TORCH.height, radius: TORCH.radius, phase: t.phase })
    this.flames.count = n
    this.flames.update(now, [1, 1, 1], eye)
  }

  _touch(dt, now, tips) {
    this.touchStep += dt
    if (this.touchStep < TOUCH_STEP_S) return
    const held = this.touchStep
    this.touchStep = 0
    const seen = new Set()
    for (const t of tips) {
      const hit = this._nearest(t.x, t.y, t.z, TOUCH_M)
      if (!hit) continue
      seen.add(hit.key)
      const sum = (this.touching.get(hit.key) ?? 0) + held
      if (sum < IGNITE_S) { this.touching.set(hit.key, sum); continue }
      this.touching.set(hit.key, 0)
      this.spark(t.x, t.y, t.z, now)
    }
    for (const k of this.touching.keys()) if (!seen.has(k)) this.touching.delete(k)
  }

  _spread(now) {
    for (const f of [...this.list]) {
      if (!f.local || this.rng() >= SPREAD_ODDS) continue
      const others = this.near(f.x, f.y, f.z, SPREAD_M + 1).filter((o) => Math.hypot(o.x - f.x, o.z - f.z) - o.radius < SPREAD_M)
      if (others.length === 0) continue
      const o = others[Math.floor(this.rng() * others.length)]
      // A point on the object's skin, toward the flame, at the flame's height held to the object's.
      const a = Math.atan2(f.z - o.z, f.x - o.x) + (this.rng() - 0.5)
      const y = Math.min(o.y + o.height, Math.max(o.y, f.y)) + (this.rng() - 0.5) * 0.1
      const life = LIFE_S[0] + this.rng() * (LIFE_S[1] - LIFE_S[0])
      const big = this.lit.has(o.key)
      const flame = this._add(o.x + Math.cos(a) * o.radius, y, o.z + Math.sin(a) * o.radius, o, now, big ? BIG_LIFE_S : life, { local: true, big })
      if (flame && this.onLight) this.onLight(flame, life)
    }
  }

  dispose() {
    this.flames.group?.removeFromParent()
    this.flames.dispose?.()
  }
}
