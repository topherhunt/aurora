import THREE from '../three-instance.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, WORLD_HALF } from '../v2/config.js'

// ---------------------------------------------------------------------------
// ONE GROUND FUNCTION, EVALUATED ON THE GPU, READ BY EVERYTHING.
//
// This is the load-bearing idea of the /v2-new-grass spike and it is worth
// stating before any of the grass code: the ground's HEIGHT and the ground's
// GRASS COVERAGE are two GLSL functions, `ngHeight` and `ngCover`, and the
// terrain mesh, every blade card and the ground shading all call them. Nothing
// on the CPU decides where a tuft goes, what it is standing on, or whether it
// is standing at all.
//
// That is what buys the whole spike its numbers. The shipped scatter in
// src/v2/render/grass.js is excellent at what it does, but its architecture
// forces a CPU visit per tuft: a tile is grown from V2Height on the main
// thread, every instance gets a matrix, a colour and a fade written into a
// BatchedMesh, and then BatchedMesh walks all 22,000 of them again every frame
// to cull and sort. The header there prices that at ~0.82 ms/frame of pure
// per-instance CPU before a triangle is drawn. Move placement into the vertex
// shader and that number is not reduced, it is DELETED -- there is no per-tuft
// CPU work left to make cheaper, and adding density costs GPU only.
//
// WHAT IS DIFFERENT FROM THE REAL WORLD, and it is the one real caveat of this
// spike. `ngHeight` samples `public/world/height.png` -- the same imported
// image /v2 boots from -- and adds two octaves of procedural detail. It is NOT
// V2Height: no rivers, no lake basins, no road smoothing, and the detail term
// is a hand-written stand-in for src/v2/height/detail.js rather than a port of
// it. So the hills are the world's hills and the ground under your feet is not
// exactly /v2's ground.
//
// That gap is closable and the shape of the fix is worth writing down now,
// because it is the difference between a demo and a technique:
//
//   The grass does not need a HEIGHT FUNCTION. It needs a HEIGHT TEXTURE and a
//   COVERAGE TEXTURE covering the ~150 m around the player. Fill them from the
//   real V2Height on the CPU (or in the terrain worker, which already has one),
//   scroll them toroidally as the player walks so only the newly-exposed rows
//   and columns are ever written, and bind them here instead of the heightmap.
//   At 0.5 m/texel that is a 320^2 pair, ~410k texels resident, and a walk at
//   5 m/s exposes ~3,200 texels a second -- about 1/200th of the sampling the
//   current tile scatter does, for a field that is exact rather than
//   approximate, and it carries rivers, roads and snow for free because
//   V2Height already knows about them.
//
// Everything below is written so that swap is a change of two uniforms.
//
// WHY THE SAMPLER IS SHARED SOURCE RATHER THAN TWO COPIES. If the terrain mesh
// and the grass disagree about the ground by so much as a centimetre, the grass
// floats or sinks, and it does it WORST on exactly the slopes a player is
// looking at. The only defence that actually holds is that there is one
// function; so this file exports a string, and both materials paste it in.
// ---------------------------------------------------------------------------

/**
 * Fetch the world heightmap as a GPU texture, plus the numbers the shader needs
 * to read metres back out of it.
 *
 * Three things have to be off or the bytes stop meaning what the encoder wrote:
 * colour management (this is not a picture), flipY (row 0 must stay row 0, the
 * way Heightmap.fromPng reads it), and mipmaps/filtering (an rg16 pair cannot
 * be interpolated by the sampler -- blending a high byte across a texel edge
 * gives a height from the middle of nowhere, so the shader fetches four texels
 * and does the blend itself, in metres, where it is meaningful).
 */
export async function loadHeightTexture() {
  const meta = await fetch(HEIGHTMAP_META_URL).then((r) => {
    if (!r.ok) throw new Error(`gpu-height: ${HEIGHTMAP_META_URL} -> HTTP ${r.status}`)
    return r.json()
  })
  if (meta.encoding !== 'rg16') {
    throw new Error(
      `gpu-height: this sampler decodes 'rg16' and height.json says '${meta.encoding ?? 'gray'}'`
    )
  }
  if (!Number.isFinite(meta.minY) || !Number.isFinite(meta.maxY) || meta.maxY <= meta.minY) {
    throw new Error(`gpu-height: height.json range is ${meta.minY}..${meta.maxY}`)
  }

  const texture = await new THREE.TextureLoader().loadAsync(HEIGHTMAP_URL)
  texture.colorSpace = THREE.NoColorSpace
  texture.flipY = false
  texture.generateMipmaps = false
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true

  const size = texture.image.width
  if (size !== meta.size || texture.image.height !== meta.size) {
    throw new Error(
      `gpu-height: ${HEIGHTMAP_URL} is ${texture.image.width}x${texture.image.height}, height.json says ${meta.size}`
    )
  }

  return {
    texture,
    meta,
    // x: texels per metre, y: metres from the world's centre to its edge,
    // z: metres per unit of the 16-bit code, w: the code's zero in metres.
    // Registration matches Heightmap.sample exactly: texel i sits at
    // world x = i * metresPerTexel - WORLD_HALF, so u = (x + half) / m.
    xform: new THREE.Vector4(
      size / (meta.world ?? WORLD_HALF * 2),
      WORLD_HALF,
      (meta.maxY - meta.minY) / 65535,
      meta.minY
    ),
  }
}

/**
 * The shared ground GLSL. Paste into any shader that needs to know where the
 * ground is or what grows on it; declare the uniforms with `HEIGHT_UNIFORMS`.
 *
 * The functions, in the order a caller wants them:
 *
 *   ngHeight(xz, cell)  metres. `cell` band-limits the procedural octaves the
 *                       caller's triangles cannot resolve -- pass the mesh's
 *                       cell size, or 0 for the exact field. This is the same
 *                       contract V2Height's `cell` argument has, and for the
 *                       same reason: a coarse chunk must be a LOW-PASS IMAGE of
 *                       the fine field rather than a different function, or the
 *                       grass standing on it hovers.
 *   ngNormal(xz, cell)  unit, y-up. Use ngNormalAt(xz, cell, h) when the height
 *                       is already in hand, which in a vertex shader it always
 *                       is -- see the note on it.
 *   ngCover(xz, y, n)   0..1, how much grass belongs here. Slope, altitude and
 *                       a large patchiness noise. The grass culls against it
 *                       and the ground shades against it, so a bare shoulder of
 *                       rock is bare in both.
 *   ngValue(p)          -1..1 value noise, exposed because the ground shader
 *                       and the wind both want the same one.
 */
export const HEIGHT_UNIFORMS = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightXform;   // texels/m, worldHalf, metres per code, code zero
uniform float uDetail;       // master amplitude on the procedural octaves
uniform vec4 uCoverSlope;    // slope fade lo/hi (1 - n.y), altitude lo, altitude hi
`

export const HEIGHT_GLSL = /* glsl */ `
// --- value noise -----------------------------------------------------------
// One hash, used by the terrain detail, the coverage patchiness, the ground
// shading and the wind. Cheap and, more to the point, IDENTICAL everywhere: the
// grass and the ground have to agree about which patches are bare.
float ngHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float ngValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  float a = ngHash(i);
  float b = ngHash(i + vec2(1.0, 0.0));
  float c = ngHash(i + vec2(0.0, 1.0));
  float d = ngHash(i + vec2(1.0, 1.0));
  return (mix(mix(a, b, f.x), mix(c, d, f.x), f.y)) * 2.0 - 1.0;
}

// --- the imported coarse field ---------------------------------------------
float ngTap(ivec2 t) {
  ivec2 lim = textureSize(uHeightTex, 0) - ivec2(1);
  vec2 rg = texelFetch(uHeightTex, clamp(t, ivec2(0), lim), 0).rg;
  // r is the high byte and g the low, both normalised to 0..1 by the sampler.
  return uHeightXform.w + (rg.r * 65280.0 + rg.g * 255.0) * uHeightXform.z;
}

// Smoothstep weights rather than plain bilinear. The import is 8 m/texel, and
// straight bilinear over a grid that coarse creases visibly along every texel
// diagonal -- a whole landscape of faint triangles. Smoothstep costs four
// multiplies and makes the surface C1 at the texel edges, which is what
// Heightmap.sample's Catmull-Rom buys on the CPU at four times the taps.
float ngCoarse(vec2 xz) {
  vec2 u = (xz + uHeightXform.y) * uHeightXform.x;
  vec2 f = floor(u);
  vec2 t = u - f;
  t = t * t * (3.0 - 2.0 * t);
  ivec2 i = ivec2(f);
  float a = ngTap(i);
  float b = ngTap(i + ivec2(1, 0));
  float c = ngTap(i + ivec2(0, 1));
  float d = ngTap(i + ivec2(1, 1));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

// --- procedural detail, band-limited ---------------------------------------
// Two octaves and no more. Every one of these is paid for FOUR TIMES per height
// sample (the value itself plus two forward differences for the normal, and the
// grass takes a sample per vertex), so an octave here is not free the way it is
// in an offline field. 26 m and 9 m are the two that matter for grass: the
// first gives a meadow its roll, the second gives it the hummocks that stop the
// carpet reading as a painted plane.
//
// The band limit is a fade rather than a cut, over one octave of cell size, so
// a clipmap level boundary does not show up as a ridge where the detail stops.
float ngBand(float lambda, float cell) {
  return 1.0 - smoothstep(lambda * 0.22, lambda * 0.48, cell);
}

float ngHeight(vec2 xz, float cell) {
  float h = ngCoarse(xz);
  h += ngValue(xz * (1.0 / 26.0)) * 1.25 * ngBand(26.0, cell) * uDetail;
  h += ngValue(xz * (1.0 / 9.0) + vec2(17.3, 41.7)) * 0.38 * ngBand(9.0, cell) * uDetail;
  return h;
}

// Forward differences, at the larger of the caller's cell and 0.6 m. Below that
// the two octaves are flat between the samples and the normal starts reporting
// the coarse import's 8 m facets instead of the surface.
//
// TAKE THE HEIGHT AS AN ARGUMENT. Every caller already has it -- it is the
// vertex's own y -- and ngHeight is the single most expensive thing in these
// shaders: four texelFetches plus two octaves of value noise, evaluated per
// VERTEX because nothing per-instance can be hoisted out of a vertex shader.
// Letting ngNormal recompute it takes the grass card's ground cost from three
// evaluations to four, which is 33% more of the heaviest term in the file for
// a number that was sitting in a local.
vec3 ngNormalAt(vec2 xz, float cell, float h) {
  float e = max(cell, 0.6);
  float hx = ngHeight(xz + vec2(e, 0.0), cell);
  float hz = ngHeight(xz + vec2(0.0, e), cell);
  return normalize(vec3(h - hx, e, h - hz));
}

vec3 ngNormal(vec2 xz, float cell) {
  return ngNormalAt(xz, cell, ngHeight(xz, cell));
}

// --- where grass grows ------------------------------------------------------
// The spike's stand-in for the PLACEMENT block in src/v2/render/grass.js. Same
// three rules that block calls unconditional -- off cliffs, out of the water,
// below the snow -- minus the two that need the document (lakes and roads),
// plus one that block does not have and this one needs.
//
// THE PATCHINESS IS NOT DECORATION. A carpet that is either on or off with a
// hard slope threshold draws a CONTOUR LINE across every hillside, and the eye
// finds a contour instantly. A slow noise on the coverage turns that line into
// a ragged margin of thinning grass, which is what a real hillside does, and it
// costs one value-noise fetch that the ground shading was going to take anyway.
//
// Returned as a FRACTION rather than a boolean because both readers want the
// soft version: the grass multiplies it into the card's alpha, so a tuft on the
// margin is sparse rather than absent, and the ground blends its albedo by it,
// so bare ground and grass meet in a gradient. That single shared number is the
// whole reason the transition looks like ground instead of like a mask.
float ngCover(vec2 xz, float y, vec3 n) {
  float steep = 1.0 - n.y;
  float s = 1.0 - smoothstep(uCoverSlope.x, uCoverSlope.y, steep);
  float lo = smoothstep(uCoverSlope.z - 8.0, uCoverSlope.z + 10.0, y);
  float hi = 1.0 - smoothstep(uCoverSlope.w - 45.0, uCoverSlope.w + 25.0, y);
  // NOT 'patch'. GLSL ES 3.00 reserves it for tessellation shaders that the ES
  // profile does not even have, and the error it gives you is a syntax error on
  // the following token, which points at the wrong thing.
  float blotch = 0.62 + 0.38 * (ngValue(xz * (1.0 / 47.0)) * 0.5 + 0.5);
  return clamp(s * lo * hi * blotch, 0.0, 1.0);
}
`

// ---------------------------------------------------------------------------
// READING THE GROUND FUNCTION BACK, so the camera can stand on it.
//
// The whole point of this file is that there is ONE ground function and it
// lives on the GPU. That is excellent for grass and awkward for a player, who
// needs to know how high the ground is under their feet on the CPU.
//
// The obvious answer -- write ngHeight again in JavaScript -- is the wrong one,
// and it is wrong in the specific way this file exists to prevent. Two copies
// of a height function do not stay equal; they drift by an edit, and the symptom
// is a player sunk to the shins in a hillside covered in grass that is standing
// on the surface. So instead the SAME GLSL renders one pixel per frame and the
// answer is read back.
//
// TWO THINGS MAKE THAT CHEAP RATHER THAN CATASTROPHIC:
//
//   IT IS ASYNCHRONOUS. readRenderTargetPixelsAsync fences and polls rather than
//   stalling the pipeline, so the main thread never waits on the GPU. A blocking
//   readPixels here would cost more than every grass instance in the scene put
//   together, and would have wrecked the one measurement this spike exists to
//   make.
//
//   IT IS ALLOWED TO BE LATE. The answer arrives a frame or three after it was
//   asked for, which at walking pace is a few centimetres of ground height,
//   under a metre-and-a-half of eye height, smoothed on arrival. Nobody can see
//   it. A physics system could not use this; a camera can.
//
// The height is packed into RGB as 24-bit fixed point rather than rendered to a
// float target, because RGBA8 readback is guaranteed everywhere and float
// readback is an extension. 1200 m over 16.7 million codes is 0.07 mm.
// ---------------------------------------------------------------------------

const PROBE_LO = -100.0
const PROBE_SPAN = 1200.0

const PROBE_FRAG = /* glsl */ `
// RawShaderMaterial gets no injected prefix, and an ES 3.00 fragment shader has
// no default precision for float, int OR sampler2D -- and lowp on the height
// sampler would quantise the world to a few metres.
precision highp float;
precision highp int;
precision highp sampler2D;

${HEIGHT_UNIFORMS}

uniform vec2 uProbeXZ;

out vec4 fragColor;

${HEIGHT_GLSL}

void main() {
  float y = ngHeight(uProbeXZ, 0.0);
  vec3 n = ngNormalAt(uProbeXZ, 0.0, y);
  float t = clamp((y - ${PROBE_LO.toFixed(1)}) / ${PROBE_SPAN.toFixed(1)}, 0.0, 1.0);
  float v = t * 16777215.0;
  vec3 rgb = vec3(
    floor(v / 65536.0),
    floor(mod(v, 65536.0) / 256.0),
    floor(mod(v, 256.0))
  ) / 255.0;
  fragColor = vec4(rgb, ngCover(uProbeXZ, y, n));
}
`

export class HeightProbe {
  /** @param shared the same `{ height }` uniform cells every other material got. */
  constructor(sharedHeight) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    })
    this.uniforms = { ...sharedHeight, uProbeXZ: { value: new THREE.Vector2() } }
    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.scene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.RawShaderMaterial({
          glslVersion: THREE.GLSL3,
          uniforms: this.uniforms,
          // Raw, so nothing three normally injects is here: no precision, no
          // matrices, no attribute declarations. three prepends the #version
          // line itself from glslVersion.
          vertexShader: `precision highp float;\nin vec3 position;\nvoid main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
          fragmentShader: PROBE_FRAG,
        })
      )
    )
    this.buffer = new Uint8Array(4)
    this.pending = false
    // Height and coverage at the last position the GPU answered for.
    this.height = 0
    this.cover = 0
    this.valid = false
  }

  /**
   * Ask for the ground at (x, z). One request in flight at a time -- a second
   * would not arrive sooner and would leave the reads to resolve out of order.
   */
  request(renderer, x, z) {
    if (this.pending) return
    this.pending = true
    this.uniforms.uProbeXZ.value.set(x, z)

    // three routes render() through the XR camera whenever a session is live,
    // so an ordinary camera is ignored and this would draw into the eye
    // viewports instead of the 1x1 target. Switching XR off for the duration is
    // the standard way round it -- SkyProbe in src/sky-probe.js does the same
    // thing for the same reason -- and it is safe because this runs BEFORE the
    // frame's real render, so three sets the session framebuffer up again on
    // the way back in.
    const wasXR = renderer.xr.enabled
    const prev = renderer.getRenderTarget()
    renderer.xr.enabled = false
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(prev)
    renderer.xr.enabled = wasXR

    renderer
      .readRenderTargetPixelsAsync(this.target, 0, 0, 1, 1, this.buffer)
      .then((b) => {
        const code = b[0] * 65536 + b[1] * 256 + b[2]
        this.height = PROBE_LO + (code / 16777215) * PROBE_SPAN
        this.cover = b[3] / 255
        this.valid = true
      })
      // A failed read must not wedge the probe closed and leave the camera
      // frozen at whatever height it last heard about.
      .catch((err) => console.error('HeightProbe: readback failed', err))
      .finally(() => {
        this.pending = false
      })
  }
}

/**
 * The uniform block every material built on HEIGHT_GLSL shares, as a fresh
 * object of three-style `{ value }` cells.
 *
 * Fresh per material and then LINKED by the caller (see linkHeightUniforms):
 * three copies uniform objects per material at compile, so handing the same
 * object to two materials works but hides the fact that it works. Building them
 * separately and assigning the same `value` makes the sharing explicit and
 * keeps a stray edit to one material's cell from silently moving the other's
 * terrain.
 */
export function heightUniforms({ texture, xform }, { detail = 1, cover } = {}) {
  return {
    uHeightTex: { value: texture },
    uHeightXform: { value: xform },
    uDetail: { value: detail },
    // slope fade start/end in (1 - n.y), then the metres at which grass starts
    // above the water and gives out below the tops. 0.13/0.42 is roughly
    // 30 to 56 degrees, a little more generous than the shipped scatter's flat
    // 38 degree cut because this one fades instead of cutting.
    uCoverSlope: { value: cover ?? new THREE.Vector4(0.13, 0.42, 26, 300) },
  }
}
