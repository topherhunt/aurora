import * as THREE from 'three'

import { UTIL_GLSL, HASH_GLSL, VALUE_GLSL } from '../aurora-lab/glsl/noise.js'
import { PALETTE_GLSL } from '../aurora-lab/glsl/palette.js'
import { CARD_VERT, CARD_FRAG } from './glsl.js'
import { traceContours } from './trace.js'
import { buildCards, KM_TO_WORLD } from './cards.js'
import { allParams, defaults, REBUILD_KEYS } from './params.js'

// ---------------------------------------------------------------------------
// The card aurora: trace the ley-line contours on the CPU, hang a column of
// glowing gas on every point of them, draw the lot in one instanced call.
//
// ===========================================================================
// THE COST ARGUMENT, WHICH IS THE REASON THIS EXISTS
// ===========================================================================
//
// design/13-aurora-and-sky.md sets the budget at "no more than about four times
// a water surface", and measures one water pixel at six to nine gnoise2
// equivalents, so the ceiling is roughly thirty noise lookups per screen pixel.
// The raymarch spends about eight hundred and forty. That is the two hundred
// times over budget the brief describes, and no amount of tuning closes a gap
// that size, because the cost is structural: a field has to be SEARCHED for
// along every ray, and the search is the expense.
//
// Look at the import list above and the whole argument is visible in it. This
// technique needs UTIL, HASH, VALUE and PALETTE. It does not import GRAD, FBM or
// WARP -- there is no gradient noise, no fBm and no domain warp anywhere on the
// GPU, because the warp already ran, once, on the CPU, and its result is the
// positions of the triangles. The gate asserts that absence, because the day
// somebody reintroduces a gfbm2 call into the vertex shader is the day this
// stops being cheaper than what it replaced.
//
// What remains is eleven value-noise lookups per COLUMN in the vertex shader --
// the four gating terms, rays, flow, shimmer's two, and the ragged top and
// wandering hem -- amortised over every pixel that column covers, and a fragment
// shader with no noise in it whatsoever: two exponentials, a power, three
// smoothsteps and the palette. Call it thirty-five ALU and no texture fetches.
//
// The cost that replaces it is OVERDRAW, and it is real. An optically thin
// emitter is additive, so every card that covers a pixel is another blend, and
// where a channel runs away from the eye its columns stack up dozens deep. That
// is not a bug -- it is exactly the edge-on brightening the raymarch has to fake
// with a clamped 1/|cos| term -- but it means the honest question on a Quest 2
// is fill rate, not triangle count, and nothing here has been measured on one.
//
// And overdraw is where the current defaults SPEND. Making the curtain read as
// one continuous glowing sheet rather than as a row of separate flames means
// packing the columns until no single one can be picked out, which at the
// shipped reach and spacing is about seven layers over a covered pixel against
// the three it used to be. That is a deliberate trade of fill rate for
// continuity, made before anything had been measured on the target hardware, and
// `spacingFrac` is the knob that trades it back -- it is the only one that buys
// down overdraw and triangles at the same time. If a Quest 2 turns out to be
// fill bound, raise it, and lower the along-channel frequencies with it.
// ===========================================================================
//
// The mesh is SKY-LOCKED: its origin is moved onto the eye every frame. At a
// hundred kilometres up, walking the entire sixteen kilometre world moves a
// channel by under five degrees, so parallax would be a lie in the other
// direction -- the aurora would visibly slide past the mountains as you walked,
// which is precisely the wrong cue. Locking it also makes the eye the origin of
// the shader's own space, which is what lets the vertex shader billboard each
// column without a cameraPosition lookup.
// ---------------------------------------------------------------------------

const PARAMS = allParams()
const PARAM_BY_KEY = new Map(PARAMS.map((p) => [p.key, p]))

// The transparent pass runs after the opaque one, so mountains and terrain
// occlude the aurora for free with depth testing on and depth writing off. The
// negative render order puts it behind the other transparent things rather than
// in front of them.
const RENDER_ORDER = -800

function toUniformValue(param, value) {
  if (param.type === 'color') return new THREE.Vector3(value[0], value[1], value[2])
  if (param.type === 'bool') return value ? 1 : 0
  if (param.type === 'enum') return value | 0
  return value
}

function writeUniformValue(param, slot, value) {
  if (param.type === 'color') slot.value.set(value[0], value[1], value[2])
  else slot.value = toUniformValue(param, value)
}

export class AuroraCards {
  constructor(scene, opts = {}) {
    this._scene = scene
    this._values = defaults()
    this._stats = { cards: 0, tris: 0, components: 0, levels: 0, totalKm: 0, traceMs: 0, dropped: 0 }

    if (opts.values) this._merge(opts.values)

    // Three uniforms are written by this class rather than by a slider. u_time
    // is the clock; u_kmToWorld is the depth-buffer constant; u_fieldScale is
    // the kilometres-to-field-units conversion, which is a REBUILD key in the
    // schema and so can only change on a re-trace -- which is exactly when
    // rebuild() writes it.
    this._uniforms = {
      u_time: { value: 0 },
      u_kmToWorld: { value: KM_TO_WORLD },
      u_fieldScale: { value: this._values.fieldScale },
    }
    for (const p of PARAMS) {
      if (!p.uniform) continue
      this._uniforms['u_' + p.key] = { value: toUniformValue(p, this._values[p.key]) }
    }

    const vertexShader = CARD_VERT.replace(
      '/* GLSL_INCLUDES */',
      UTIL_GLSL + HASH_GLSL + VALUE_GLSL + PALETTE_GLSL,
    )
    const fragmentShader = CARD_FRAG

    // Nothing in `npm run check` links a shader, so the entire "this does not
    // compile" class of mistake is invisible to the gate -- the design doc
    // records a duplicate declaration that shipped, was never linked, and
    // survived a full gate run plus a round of retuning. This is the cheapest
    // slice of that problem that can be caught without a compiler: a param
    // declared as a uniform in the schema that no shader ever reads is a slider
    // wired to nothing, and silently doing nothing is the worst possible
    // behaviour for a tuning control.
    const src = vertexShader + fragmentShader
    const orphans = PARAMS.filter((p) => p.uniform && !src.includes('u_' + p.key)).map((p) => p.key)
    if (orphans.length) {
      throw new Error(
        `AuroraCards: schema declares uniform params that no shader reads: ${orphans.join(', ')}. ` +
        'Either declare and use them in glsl.js or mark them uniform: false in params.js.',
      )
    }

    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: this._uniforms,
      transparent: true,
      // SCREEN rather than additive: dst = src + dst * ( 1 - src ). Over N cards
      // that is 1 - product( 1 - s_i ), which keeps every property the additive
      // blend was chosen for and fixes the one it could not deliver.
      //
      // It is still order independent -- the product commutes -- so there is
      // still no sorting, no depth write, and no per-frame CPU cost, which was
      // the whole reason an optically thin emitter is pleasant to draw.
      //
      // What it adds is a ceiling. Additive has no roll-off at all, so a stack
      // seven columns deep crossing several channels simply pinned at white, and
      // at a magnified framing half the lit pixels had a channel clipped. Nothing
      // can be blended inside a clipped pixel, so the saturation was destroying
      // the continuity that the profile, the halo and the card density had all
      // been tuned to produce -- and leaving the unclipped gaps between the cores
      // as the only visible structure, which reads as exactly the picket fence
      // the tuning was chasing. A screen approaches white asymptotically instead
      // and never gets there, so the overlap stays visible at any depth.
      //
      // There is no per-fragment fix for this, which is worth writing down
      // because it is the obvious thing to try: tone mapping runs BEFORE the
      // blend, so it would roll off each card's own contribution and then sum the
      // results, which does not bound the sum. Rolling off the sum needs either
      // an offscreen float target plus a composite pass -- a real cost on a
      // Quest 2 -- or a blend function that is already a roll-off. This is the
      // second one, and it is free.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    })

    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.mesh.renderOrder = RENDER_ORDER
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = true
    scene.add(this.mesh)

    this.rebuild()
  }

  get values() { return this._values }

  get stats() { return this._stats }

  get(key) {
    if (!PARAM_BY_KEY.has(key)) throw new Error(`AuroraCards: unknown param "${key}"`)
    return this._values[key]
  }

  set(key, value) {
    const param = PARAM_BY_KEY.get(key)
    if (!param) throw new Error(`AuroraCards: unknown param "${key}"`)
    this._values[key] = value

    if (REBUILD_KEYS.has(key)) { this.rebuild(); return }

    const slot = this._uniforms['u_' + key]
    // A param that is neither a uniform nor a rebuild key belongs to the page
    // (the scene and mountain groups), so there is nothing to do here.
    if (slot) writeUniformValue(param, slot, value)
  }

  setValues(obj) {
    const needsRebuild = this._merge(obj)
    for (const key of Object.keys(obj)) {
      const param = PARAM_BY_KEY.get(key)
      if (!param || REBUILD_KEYS.has(key)) continue
      const slot = this._uniforms['u_' + key]
      if (slot) writeUniformValue(param, slot, this._values[key])
    }
    if (needsRebuild) this.rebuild()
  }

  // Returns whether anything that was merged forces a re-trace. Unknown keys are
  // reported and skipped rather than dropped in silence: a preset carrying a key
  // this schema does not have is almost always a preset copied from the raymarch
  // lab, and saying so is the difference between a two-second fix and an hour.
  _merge(obj) {
    let rebuild = false
    for (const [key, value] of Object.entries(obj)) {
      if (!PARAM_BY_KEY.has(key)) {
        console.warn(`AuroraCards: ignoring unknown param "${key}"`)
        continue
      }
      this._values[key] = Array.isArray(value) ? value.slice() : value
      if (REBUILD_KEYS.has(key)) rebuild = true
    }
    return rebuild
  }

  rebuild() {
    this._uniforms.u_fieldScale.value = this._values.fieldScale
    const t0 = performance.now()
    const { lines, stats } = traceContours(this._values)
    const built = buildCards(lines, this._values)
    const traceMs = performance.now() - t0

    const old = this.mesh.geometry
    this.mesh.geometry = built.geometry
    old.dispose()

    this._stats = {
      cards: built.cards,
      tris: built.tris,
      dropped: built.dropped,
      components: stats.components,
      levels: stats.levels,
      totalKm: Math.round(stats.totalKm),
      cellKm: stats.cellKm,
      traceMs,
    }
  }

  update(camera, shaderTime) {
    this.mesh.position.copy(camera.position)
    this._uniforms.u_time.value = shaderTime
  }

  dispose() {
    this._scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
