// Eating what she holds, and what the mushrooms do to her after: design/33-vitals.md §Eating.

export const EAT = {
  // Held within `mouth` m (times her size) of her mouth for `holdS` s, and it is eaten.
  holdS: 2,
  mouth: 0.16,
  heal: 10,
  harm: 10,
  // Her size, as a multiple of her full height, the same in every room: eased to each new target over `easeS` s, in ratio.
  size: { min: 1 / 8, max: 2, easeS: 6 },
  // Each effect fades in over `inS`, holds to `s`, then fades out over `outS`.
  agaric: { s: 15, inS: 3, outS: 3, m: 500, rgba: [0.25, 1, 0.3, 0.32] },
  porcini: { s: 60, inS: 3, outS: 3, guard: 0.5, rgba: [0.4, 0.22, 0.06, 0.22], most: 0.75 },
  chanterelle: { s: 300, inS: 3, outS: 3, m: 10, rgba: [0, 0, 0, 0.45] },
  pulseHz: 0.6,
}

/** Whether her `size` is `k` of her full size or less; the ease lands a hair off its target. */
export const atMost = (size, k) => size <= k * (1 + 1e-6)

export const MUSHROOMS = ['ink cap', 'parasol', 'fly agaric', 'porcini', 'chanterelle']

/** Whether a held record (hands.js) is a thing she can eat. */
export function edible(rec) {
  if (rec === null) return false
  if (rec.kind === 'mushroom' && !MUSHROOMS.includes(rec.name)) throw new Error(`edible: no mushroom named ${rec.name}`)
  return rec.kind === 'carrot' || rec.kind === 'fish' || rec.kind === 'mushroom'
}

/** 0..1 for an effect `e` begun `t` s ago: in over e.inS, held to e.s, out over e.outS. */
function level(e, t) {
  if (t < 0 || t >= e.s + e.outS) return 0
  return Math.min(1, t / e.inS, (e.s + e.outS - t) / e.outS)
}

/** Each hand's time at her mouth with an edible thing in it; `step` is true on the frame it is eaten. */
export class Bites {
  constructor() { this.held = new Map() }

  step(key, atMouth, dt) {
    if (!atMouth) { this.held.delete(key); return false }
    const t = (this.held.get(key) ?? 0) + dt
    if (t < EAT.holdS) { this.held.set(key, t); return false }
    this.held.delete(key)
    return true
  }

  /** 0..1 of the way to a bite for hand `key`. */
  progress(key) { return (this.held.get(key) ?? 0) / EAT.holdS }

  clear() { this.held.clear() }
}

/**
 * The mushrooms' effects on her, stepped by `update(dt)`. `size` is her size
 * (eased, never reverting); the rest are timed and are not saved.
 */
export class Effects {
  constructor(size = 1) {
    this.t = 0
    this.from = this.to = this.size = size
    this.sizeT = Infinity
    this.agaric = -Infinity
    this.chanterelle = -Infinity
    this.porcini = []
    this._tint = [0, 0, 0, 0]
  }

  /** What eating the thing `rec` does now: { heal, harm, sound } for main.js to carry out. */
  eat(rec) {
    if (!edible(rec)) throw new Error(`Effects.eat: ${rec && rec.kind} is not food`)
    if (rec.kind !== 'mushroom') return { heal: EAT.heal, harm: 0, sound: null }
    let sound = null
    switch (rec.name) {
      case 'ink cap': this._resize(0.5); sound = 'zoom'; break
      case 'parasol': this._resize(2); sound = 'zoomBack'; break
      case 'fly agaric': this.agaric = this.t; break
      case 'porcini': this.porcini.push(this.t); break
      case 'chanterelle': this.chanterelle = this.t; break
    }
    return { heal: 0, harm: EAT.harm, sound }
  }

  _resize(k) {
    const S = EAT.size
    this.from = this.size
    this.to = Math.min(S.max, Math.max(S.min, this.to * k))
    this.sizeT = 0
  }

  update(dt) {
    this.t += dt
    if (this.sizeT < EAT.size.easeS) {
      this.sizeT = Math.min(EAT.size.easeS, this.sizeT + dt)
      const u = this.sizeT / EAT.size.easeS, s = u * u * (3 - 2 * u)
      this.size = this.from * Math.pow(this.to / this.from, s)
    }
    const P = EAT.porcini
    this.porcini = this.porcini.filter((t0) => this.t - t0 < P.s + P.outS)
  }

  /** Her size set at once, no easing: a loaded save. */
  setSize(size) {
    const S = EAT.size
    if (!(size >= S.min && size <= S.max)) throw new Error(`Effects.setSize: ${size} outside ${S.min}..${S.max}`)
    this.from = this.to = this.size = size
    this.sizeT = Infinity
  }

  /** Back to her own size at once, every effect gone: a new game. */
  reset() {
    this.setSize(1)
    this.clear()
  }

  /** Every timed effect gone, her size kept: a revival. */
  clear() {
    this.agaric = this.chanterelle = -Infinity
    this.porcini.length = 0
  }

  /** 0..1, the fly agaric's sight of what is hidden. */
  get seeing() { return level(EAT.agaric, this.t - this.agaric) }

  /** 0..1, the chanterelle's hold on the animals: 1 while they turn on her, fading as it wears off. */
  get dread() { return level(EAT.chanterelle, this.t - this.chanterelle) }

  /** Whether the animals within EAT.chanterelle.m come for her. */
  get maddened() { return this.t - this.chanterelle < EAT.chanterelle.s }

  /** What a blow does to her: halved for every porcini she is under, from the frame after it was eaten, so its own harm lands whole. */
  get guard() {
    const P = EAT.porcini
    return Math.pow(P.guard, this.porcini.filter((t0) => this.t > t0 && this.t - t0 < P.s).length)
  }

  /** The wash over her sight, [r, g, b, a], each effect laid over the last: the porcini's brown, the agaric's green, the chanterelle's black. */
  get tint() {
    const out = this._tint
    out[0] = out[1] = out[2] = out[3] = 0
    const pulse = 0.7 + 0.3 * Math.sin(2 * Math.PI * EAT.pulseHz * this.t)
    const P = EAT.porcini
    const brown = Math.min(P.most, this.porcini.reduce((a, t0) => a + level(P, this.t - t0), 0) * P.rgba[3])
    over(out, P.rgba, brown * pulse)
    over(out, EAT.agaric.rgba, this.seeing * EAT.agaric.rgba[3] * pulse)
    over(out, EAT.chanterelle.rgba, this.dread * EAT.chanterelle.rgba[3])
    if (out[3] > 0) for (let i = 0; i < 3; i++) out[i] /= out[3]
    return out
  }
}

/** Lay colour `rgb` at alpha `a` over the premultiplied `out`. */
function over(out, rgb, a) {
  if (a <= 0) return
  for (let i = 0; i < 3; i++) out[i] = rgb[i] * a + out[i] * (1 - a)
  out[3] = a + out[3] * (1 - a)
}

/** A tinny buzz in the ears, a second long and looping clean: a thin square-ish whine at 230 Hz, wavering at 7 Hz. */
export function buzzBuffer(ctx) {
  const rate = ctx.sampleRate
  const buf = ctx.createBuffer(1, rate, rate)
  const out = buf.getChannelData(0)
  for (let i = 0; i < out.length; i++) {
    const t = i / rate
    const ph = 2 * Math.PI * 230 * t + 0.6 * Math.sin(2 * Math.PI * 7 * t)
    let v = 0
    for (let h = 1; h <= 9; h += 2) v += Math.sin(h * ph) / h
    out[i] = 0.5 * v * (0.75 + 0.25 * Math.sin(2 * Math.PI * 7 * t))
  }
  return buf
}

/** `buf` played backward, as a new buffer. */
export function reversedBuffer(ctx, buf) {
  const back = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
  for (let c = 0; c < buf.numberOfChannels; c++) back.getChannelData(c).set(buf.getChannelData(c).slice().reverse())
  return back
}
