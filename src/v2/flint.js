import THREE from '../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FLARE } from './render/flares.js'

// ---------------------------------------------------------------------------
// Flint & steel: a thing her hands hold (hands.js kind 'flint') that strikes a
// spark (render/flares.js in its spark mode) a hand's width in front of it. It
// starts in the backpack, like the flare gun, and nothing in the world hands
// one out. Its mesh is a placeholder until a pick is shipped from the prop
// roster's 'flint' slot (tools/props/gen/prop-roster.mjs); the striking edge
// runs along the hand's -Z, so STRIKE is where the spark appears in its frame.
// Design: design/37-fire.md.
// ---------------------------------------------------------------------------

export const KIND = 'flint'
export const SIZE_M = 0.1
// In the flint's frame: where the spark is struck, just past the tip.
export const STRIKE = new THREE.Vector3(0, 0, -0.08)
// A spark: metres across, seconds it fades over, and the orange and yellow its colour is drawn between.
export const SPARK_M = 0.25
export const SPARK_S = 0.25
export const SPARK_COLORS = [0xff6a00, 0xffd020]
export const SPARK_CAP = 16
// The spark's look: a short fan of quick sparks, one life over its fade.
export const SPARK = { ...FLARE, core: 0.35, halo: 0.5, haloFall: 1.5, flicker: 0, sparks: 12, rate: 1 / SPARK_S, speed: 2.4, gravity: 0.3, gain: 2.6 }
// Below the snowline in rain a strike lights one time in this many.
export const RAIN_ODDS = 5

const _a = new THREE.Color(SPARK_COLORS[0])
const _b = new THREE.Color(SPARK_COLORS[1])
const _c = new THREE.Color()
/** A colour between orange and yellow at `u` (0..1), as 0xRRGGBB. */
export const sparkColor = (u) => _c.copy(_a).lerp(_b, u).getHex()

/** Whether a strike catches, given the rain (0..1, below the snowline) and a roll in [0, 1): dry always, in rain one in RAIN_ODDS. */
export const strikeCatches = (raining, roll) => !raining || roll < 1 / RAIN_ODDS

/** The placeholder: a dark flint chip with a bent steel striker beside it, along -Z, vertex-coloured. */
function buildPlaceholder() {
  const paint = (g, hex) => {
    const c = new THREE.Color(hex)
    const n = g.attributes.position.count
    const a = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) c.toArray(a, i * 3)
    g.setAttribute('color', new THREE.BufferAttribute(a, 3))
    return g
  }
  const chip = new THREE.BoxGeometry(0.03, 0.022, 0.05).translate(0.012, 0.01, -0.02)
  chip.rotateY(0.4)
  const bar = new THREE.BoxGeometry(0.012, 0.012, 0.085).translate(-0.022, 0, 0)
  const hook = new THREE.BoxGeometry(0.03, 0.012, 0.012).translate(-0.013, 0, 0.037)
  const tip = new THREE.BoxGeometry(0.03, 0.012, 0.012).translate(-0.013, 0, -0.037)
  return mergeGeometries([paint(chip.toNonIndexed(), 0x2c2a2e), paint(bar.toNonIndexed(), 0x8a9098), paint(hook.toNonIndexed(), 0x8a9098), paint(tip.toNonIndexed(), 0x8a9098)])
}

/** The click of steel on stone, synthesised: a burst of noise and three inharmonic partials, each dying away in a few milliseconds. Seeded, so two boots sound the same. */
export function clickBuffer(ctx) {
  const sr = ctx.sampleRate
  const n = Math.ceil(0.14 * sr)
  const buffer = ctx.createBuffer(1, n, sr)
  const data = buffer.getChannelData(0)
  let seed = 0x5a17
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1
  const partials = [[2930, 1, 38], [4370, 0.7, 52], [6210, 0.5, 70]]
  for (let i = 0; i < n; i++) {
    const t = i / sr
    let v = rand() * Math.exp(-t * 400) * 0.6
    for (const [hz, amp, decay] of partials) v += Math.sin(2 * Math.PI * hz * t) * amp * Math.exp(-t * decay)
    data[i] = v * 0.45 * Math.min(1, i / 8)
  }
  return buffer
}

/** The Hands source for the flint: nothing in the world hands one out, a dropped one lies loose until a hand lifts it. */
export class Flints {
  constructor() {
    this.geometry = buildPlaceholder()
    this.geometry.computeBoundingBox()
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true })
    this.size = SIZE_M
  }

  pickAt() { return null }

  take() { throw new Error('Flints.take: nothing in the world hands out a flint') }

  dress() { return { geometry: this.geometry, material: this.material } }

  /** A new flint & steel, packed for a backpack slot. */
  slot() {
    return { kind: KIND, name: 'flint & steel', size: this.size, scale: [1, 1, 1], color: null, stowable: true, attrs: {} }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
