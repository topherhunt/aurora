import THREE from './three-instance.js'
import { mulberry32 } from './sim/mathx.js'

// ---------------------------------------------------------------------------
// The bits of a tuning bench that are not the thing being tuned: the ground it
// stands on and the lighting model its foliage is shaded with.
//
// Shared by gen-fern.html and gen-tree.html so the two benches judge against
// the SAME ground and the same light. That matters more than it sounds: a fern
// tuned over one green and a bush tuned over another will not agree about
// saturation, and the two are going to stand next to each other in the world.
// ---------------------------------------------------------------------------

// Tileable value noise on a g x g lattice. Wrapping the lattice indices is the
// whole trick: without the wrap the ground seams visibly at every tile edge.
function lattice(rand, g) {
  const v = new Float32Array(g * g)
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = x * g
    const fy = y * g
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const x0 = ((ix % g) + g) % g
    const y0 = ((iy % g) + g) % g
    const x1 = (x0 + 1) % g
    const y1 = (y0 + 1) % g
    const tx = smooth(fx - ix)
    const ty = smooth(fy - iy)
    const a = v[y0 * g + x0]
    const b = v[y0 * g + x1]
    const c = v[y1 * g + x0]
    const d = v[y1 * g + x1]
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
  }
}

// Darker and less saturated than the foliage deliberately. Ground and plant
// that share a value sit on top of each other and the plant reads as a stain on
// the grass rather than as something standing in it -- which is also true in
// the game, where the plants are the thing you look at and the ground is what
// they are seen against.
const GRASS_DARK = [0x16, 0x1e, 0x10]
const GRASS_LIGHT = [0x3c, 0x50, 0x22]

/**
 * The bench ground texture, generated rather than loaded.
 *
 * Generated for one reason that matters: a PNG fetched out of public/ would
 * land in the "what ships" panel, and a ground texture is not part of what a
 * plant costs. This way the budget stays honest and the ground costs zero bytes.
 *
 * Lo-fi is the intent, not a shortcut, and NearestFilter is the load-bearing
 * part. A smoothed 64 px texture stretched over two metres reads as green mud;
 * hard texels read as ground. Same argument as the N64 fidelity target for the
 * props themselves -- at this budget the SHAPE of the noise carries the image,
 * so spending resolution on it is the wrong purchase.
 */
export function grassTexture(renderer, size = 64) {
  const rand = mulberry32(7)
  const clump = lattice(rand, 4) // patches, a couple of metres across
  const blade = lattice(rand, 16) // texture within a patch

  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      let n = clump(u, v) * 0.62 + blade(u, v) * 0.38
      // Quantise to six steps. The banding IS the look: a console of this era
      // could not afford a smooth gradient across a ground texture, and the eye
      // reads the steps as clumps rather than as an artefact.
      n = Math.round(n * 5) / 5
      // Per-texel speckle AFTER quantising, so the bands do not read as flat
      // plates of colour.
      n = Math.min(1, Math.max(0, n + (rand() - 0.5) * 0.18))

      const o = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        data[o + c] = Math.round(GRASS_DARK[c] + (GRASS_LIGHT[c] - GRASS_DARK[c]) * n)
      }
      data[o + 3] = 255
    }
  }

  const tex = new THREE.DataTexture(data, size, size)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()
  tex.needsUpdate = true
  return tex
}

// --- wrap lighting ----------------------------------------------------------
//
// A rosette radiates through 360 degrees and a canopy is a sphere of cards, so
// under ONE sun a third of the blades always point away and land on
// dot(N,L) <= 0. Correct Lambert, wrong-looking plant.
//
// A real leaf is one cell layer thick and light passes straight through it, so
// the shaded side of foliage is never black -- it is a backlit green. Wrap
// (half-Lambert) diffuse is the cheap standard model of exactly that: remap the
// cosine term from [-1,1] to [0,1] instead of clamping the negative half away,
// so a leaf facing directly away still receives `1 - wrap` of the sun.
//
// Done by string surgery on the stock chunk rather than by writing a material:
// this is ONE LINE of the lighting model, and a hand-written shader would have
// to re-implement fog, the alpha cutout, and the colour space that
// MeshLambertMaterial already gets right.
const WRAP = 0.5
const INCLUDE = '#include <lights_lambert_pars_fragment>'
const DOT_NL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );'
const WRAPPED =
  `float dotNL = saturate( ( dot( geometryNormal, directLight.direction ) + ${WRAP} ) ` +
  `/ ( 1.0 + ${WRAP} ) );`

/**
 * Patch a shader in place for wrap diffuse. Call from inside onBeforeCompile.
 *
 * The chunk has to be patched and inlined over its own #include, not found in
 * the shader body: onBeforeCompile runs BEFORE three resolves #include
 * directives, so at this point the shader still says `#include <...>` and a
 * search for the Lambert source finds nothing.
 */
export function wrapLambert(shader) {
  const chunk = THREE.ShaderChunk.lights_lambert_pars_fragment
  // Loudly, not silently. A three.js upgrade that renames either of these would
  // otherwise quietly restore the black foliage, and a lighting regression is
  // exactly the kind of thing nobody notices for six months.
  if (!chunk.includes(DOT_NL)) {
    throw new Error('wrap lighting: three.js reworded the Lambert dotNL line')
  }
  if (!shader.fragmentShader.includes(INCLUDE)) {
    throw new Error(`wrap lighting: no ${INCLUDE} in the Lambert fragment shader`)
  }
  shader.fragmentShader = shader.fragmentShader.replace(INCLUDE, chunk.replace(DOT_NL, WRAPPED))
}
