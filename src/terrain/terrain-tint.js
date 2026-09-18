import { terrainDetailTextures } from './grit-texture.js'
import { PLAIN_GRASS_TONE } from './terrain-material.js'
import { shade } from '../v2/terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// WHAT COLOUR THE GROUND ACTUALLY IS, on the CPU, for anything standing in it.
//
// `shade` in v2/terrain/chunk-mesh-v2.js is NOT the answer, and that is the
// whole reason this module exists. It is the terrain's VERTEX TINT -- the colour
// the chunk mesher writes into the attribute -- and the fragment shader in
// terrain/terrain-material.js then puts it through several more stages before
// anything reaches the eye. Painting a prop with `shade` alone gives something
// flatly, uniformly the wrong colour, most obviously because of the last stage:
// uGrassTone is (0.45, 0.92, 0.45), so green ground has its red and its blue
// taken down hard on the way out -- at full strength under the shader rungs and
// at half under the plain one -- and a prop that skips it reads grey and waxy
// beside the meadow it is standing in.
//
// SO IT REPLAYS WHATEVER RUNG IS ON SCREEN, because "the colour the ground is"
// is a different chain per rung and a prop painted from the wrong one is wrong by
// a visible amount. `chain` selects, and the two are:
//
//   'plain' -- what the headset draws. HALF of uGrassTone, on the same green
//     mask, and nothing else, which is the entire fragment stage of
//     createPlainTerrainMaterial.
//   'shader' -- axis, grain, and anything else this factory compiles. The three
//     stages that MOVE THE AVERAGE: the region layer, one kilometre per tile, a
//     value swing plus a pull toward dirt at its high end and deep green at its
//     low; the mid-range mottle, 137 m per tile and rotated, the same shape with
//     a dry ochre at its high end; and uGrassTone whole, landing last.
//
// The two are far apart, and the gap is the bug this exists to close: under
// 'plain' the ground has no region and no macro layer AT ALL, so a bed replaying
// them carries a 137 m patchwork the ground it stands in does not have, over a
// green a third more saturated than the ground's.
//
// The amplitudes and the palette are READ LIVE off the terrain's own uniforms,
// so retuning the ground retunes everything painted from it. What is duplicated
// here is only the geometry of the thing -- the two tile sizes, the rotation and
// the four thresholds -- which live at MACRO_METRES, MACRO_FINE_METRES and ROT
// in terrain-material.js, and in the two blocks there that read `auroraM.r` and
// `auroraMF.r`. Grep those three names to find what this has to agree with.
//
// WHAT IS DELIBERATELY LEFT OUT, because none of it moves a prop's average: the
// ground photograph is divided by its own mean and so is mean-preserving by
// construction; the grit layers are 11.7 m and 2.3 m per tile, which is finer
// than a clump of grass and averages out under one; and the snow and rock mixes
// are skipped because every caller so far rejects placement near the snow line.
//
// It is a handful of array reads and a dozen multiplies per call -- 3.1 ms per
// 20,000 -- which is noise next to the two path queries a scatter already runs.
// ---------------------------------------------------------------------------

const REGION_METRES = 1024
const MOTTLE_METRES = 137

// The uniforms that must exist on the material for the replay to mean anything.
// Checked by name at construction, because the failure mode otherwise is a
// TypeError thousands of clumps into a scatter, or worse, a silently wrong
// colour if terrain-material.js ever renames one to something optional.
const NEEDED = [
  'uRegionValue', 'uRegionTint', 'uMacroValue', 'uMacroTint',
  'uDirt', 'uDeep', 'uDry', 'uGrassTone',
]

/** GLSL smoothstep, including the descending form where e1 < e0. */
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export class TerrainTint {
  /**
   * Everything is held BY REFERENCE -- the uniform objects, the layers document
   * and the macro field are all the terrain's own, so retuning the palette or
   * editing a lake moves the props that were coloured from it. Nothing here
   * writes to any of them.
   *
   * @param {THREE.Material} material  the terrain's, after createTerrainMaterial
   *   and any lighting patch.
   * @param {Layers} layers  for `flattenAt` and the live snow band.
   * @param {object} bands  V2Height's, for `altLo` and `altSpan`.
   * @param {'plain'|'shader'} [chain]  which rung to replay; see the banner. The
   *   default is what the world draws, and nothing switches it now that the
   *   ground has one rung; a clump is coloured once, when it is placed, so a
   *   switch would re-tint beds only as their tiles recycle under the player.
   */
  constructor(material, layers, bands, chain = 'plain') {
    const u = material?.userData?.uniforms
    if (!u) throw new Error('TerrainTint: the terrain material has no userData.uniforms')
    for (const key of NEEDED) {
      if (!u[key]) {
        throw new Error(`TerrainTint: the terrain material has no ${key}; this module is out of date with terrain-material.js`)
      }
    }
    if (!layers || typeof layers.flattenAt !== 'function' || typeof layers.shoreAt !== 'function') {
      throw new Error('TerrainTint: needs a Layers with flattenAt and shoreAt')
    }
    if (!bands || typeof bands.altLo !== 'number' || typeof bands.altSpan !== 'number') {
      throw new Error('TerrainTint: needs V2Height.bands, for altLo and altSpan')
    }
    this.setChain(chain)
    this.u = u
    this.layers = layers
    this.bands = bands
    const macro = terrainDetailTextures().macro
    this.data = macro.image.data
    this.size = macro.image.width
  }

  /**
   * The colour the ground at (x, z) is DRAWN in, the whole way: the chunk
   * mesher's own vertex tint and then the shader chain over it. `ny` is the
   * classification normal's Y, which is what `shade` wants and what
   * heightAndSlopeAt's gradient gives directly as `1 / hypot(tan, 1)`.
   *
   * Mutates `rgb` in place; values are LINEAR.
   */
  groundAt(rgb, x, z, h, ny, snowLine) {
    shade(h, ny, snowLine, this.layers.snow.band, this.layers.flattenAt(x, z),
      this.layers.shoreAt(x, z, h), this.bands.altLo, this.bands.altSpan, x, z, rgb, 0)
    return this.apply(rgb, x, z)
  }

  /**
   * The macro field's red channel, bilinear and wrapping -- the same fetch the
   * shader's textureGrad makes, minus the mip selection, which at a metre-scale
   * lookup on a 4 m texel is the full-resolution level anyway.
   */
  _macroR(u, v) {
    const s = this.size
    const d = this.data
    const px = u * s - 0.5
    const py = v * s - 0.5
    const x0 = Math.floor(px)
    const y0 = Math.floor(py)
    const fx = px - x0
    const fy = py - y0
    const xa = ((x0 % s) + s) % s
    const ya = ((y0 % s) + s) % s
    const xb = (xa + 1) % s
    const yb = (ya + 1) % s
    const c00 = d[(ya * s + xa) * 4]
    const c10 = d[(ya * s + xb) * 4]
    const c01 = d[(yb * s + xa) * 4]
    const c11 = d[(yb * s + xb) * 4]
    const top = c00 + (c10 - c00) * fx
    const bot = c01 + (c11 - c01) * fx
    return (top + (bot - top) * fy) / 255
  }

  /** Which rung to replay. See the banner. */
  setChain(chain) {
    if (chain !== 'plain' && chain !== 'shader') {
      throw new Error(`TerrainTint: chain must be 'plain' or 'shader', got ${chain}`)
    }
    this.chain = chain
  }

  /**
   * Take a `shade` result to the colour the ground at (x, z) is drawn in.
   * Mutates `rgb` in place; values stay LINEAR throughout, as `shade`'s are.
   */
  apply(rgb, x, z) {
    const u = this.u
    // How green the vertex tint is, which is the mask every colour stage below
    // is weighted by -- terrain-material.js computes exactly this from vColor.
    const green = smoothstep(0.004, 0.030, rgb[1] - Math.max(rgb[0], rgb[2]))

    if (this.chain === 'plain') return this._tone(rgb, green * PLAIN_GRASS_TONE)

    const region = this._macroR(x / REGION_METRES, z / REGION_METRES)
    scaleRGB(rgb, 1 + (region - 0.5) * u.uRegionValue.value)
    mixRGB(rgb, u.uDirt.value, smoothstep(0.752, 1.0, region) * green * u.uRegionTint.value)
    mixRGB(rgb, u.uDeep.value, smoothstep(0.285, 0.0, region) * green * u.uRegionTint.value)

    // ROT, column-major as GLSL reads mat2( 0.80, 0.60, -0.60, 0.80 ): the two
    // macro fetches share one texture, and turning the fine one keeps its
    // pattern from lining up with the coarse one's.
    const fu = x / MOTTLE_METRES
    const fv = z / MOTTLE_METRES
    const mottle = this._macroR(0.8 * fu - 0.6 * fv, 0.6 * fu + 0.8 * fv)
    scaleRGB(rgb, 1 + (mottle - 0.5) * u.uMacroValue.value)
    mixRGB(rgb, u.uDry.value, smoothstep(0.856, 1.0, mottle) * green * u.uMacroTint.value)
    mixRGB(rgb, u.uDeep.value, smoothstep(0.218, 0.0, mottle) * green * u.uMacroTint.value)

    return this._tone(rgb, green)
  }

  /** uGrassTone, at `k` of full strength. The last stage of either chain. */
  _tone(rgb, k) {
    const tone = this.u.uGrassTone.value
    rgb[0] *= 1 + (tone.r - 1) * k
    rgb[1] *= 1 + (tone.g - 1) * k
    rgb[2] *= 1 + (tone.b - 1) * k
    return rgb
  }
}

function scaleRGB(rgb, k) {
  rgb[0] *= k; rgb[1] *= k; rgb[2] *= k
}

function mixRGB(rgb, c, k) {
  if (k <= 0) return
  rgb[0] += (c.r - rgb[0]) * k
  rgb[1] += (c.g - rgb[1]) * k
  rgb[2] += (c.b - rgb[2]) * k
}
