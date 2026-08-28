import THREE from '../three-instance.js'

import { HEIGHT_GLSL, HEIGHT_UNIFORMS } from './gpu-height.js'

// ---------------------------------------------------------------------------
// THE GROUND, WHICH IS ALSO MOST OF THE GRASS.
//
// This file is part 2 of the three-part answer in grass-field.js's header, and
// it is the part that is easy to skip and impossible to do without. Blades stop
// at 72 m. The meadow does not. Everything past that radius -- which on an open
// hillside is most of what a player is looking at -- is THIS SHADER, and if it
// does not read as grass then no amount of geometry inside 72 m will save it.
//
// What makes a painted meadow read as a meadow, in the order the terms matter:
//
//   THE RIPPLE. A slow noise scrolling downwind, modulating value by about 8%.
//   This is the single highest-value line in the file. A still green field
//   reads as a golf course at any distance; the same field with wind moving
//   across it reads as grass immediately, and the eye is picking up MOTION,
//   which survives distance, fog and low resolution far better than texture
//   does. It is one value-noise fetch.
//
//   THE BREAKUP. Hue and value at 4-12 m and again at 40-90 m, so the field is
//   not one colour. Real grass varies in species and moisture at both scales
//   and a flat green is the tell.
//
//   THE CLUTTER. A fine 0.3-1.2 m detail, faded out past ~50 m because past
//   that it is below a pixel and all it can do is alias. Its job is to carry
//   the near ground BETWEEN the blade cards, not to be seen at range.
//
//   THE SHEEN. Grass forward-scatters hard: a field lit from behind is bright,
//   and the same field lit from over your shoulder is dark. One power of the
//   view/sun dot, and it is what makes a hillside turn silver when you look
//   into the sun.
//
// The ground and the blades share ngCover(), so where the grass thins the
// ground goes to rock underneath it, in the same places, by the same number.
// That agreement is what makes the blade layer look like it is GROWING out of
// the ground rather than scattered on top of it.
//
// ---------------------------------------------------------------------------
// THE MESH IS A CLIPMAP, and it is here only so the grass has real hills to
// stand on -- /v2 has a proper quadtree mesher (src/v2/terrain/terrain-v2.js)
// and this is not a proposal to replace it.
//
// Concentric square levels, each 56 cells across at twice the cell size of the
// one inside it, each snapped to its own grid so the tessellation does not swim
// as the camera moves. Levels OVERLAP by a few coarse cells rather than being
// cut to meet, and the finer level wins on a depth bias -- which costs a little
// hidden geometry and removes the entire class of crack-at-the-LOD-boundary
// bugs that cutting them to meet creates. Nothing is rebuilt per frame: two
// geometries, eight meshes, one uniform each.
//
// The height comes from ngHeight(xz, cell) with the LEVEL'S OWN CELL, so a
// coarse level is a low-pass image of the same field rather than a different
// one. That is the same contract V2Height's `cell` argument has and it is what
// keeps the grass -- which samples at cell 0 -- from hovering over the mesh it
// is standing on.
// ---------------------------------------------------------------------------

// Cells across one clipmap level. Even, and divisible by 4 so the hole in a
// ring is a whole number of cells.
const N = 56

// Metres per cell at the innermost level. 0.35 puts level 0 at +-9.8 m and
// level 3 at +-78.4 m, which is what matters: the grass reaches 72 m, and at 72
// m it wants to be standing on cells of about 2.8 m or the 9 m detail octave
// the blades can see is one the mesh under them has already faded out.
const BASE_CELL = 0.35

// Eight levels reaches +-1254 m. The fog closes at about 600, so this is one
// level of margin rather than a view distance.
const LEVELS = 8

// Cells of overlap between a level and the one inside it. The inner level is
// snapped to its own grid and this one to its own, so their boundaries can
// disagree by up to a cell in each axis; two cells of overlap covers that with
// room, and the depth bias decides which surface is seen.
const OVERLAP = 2

/** A flat grid of `cells` x `cells` quads in CELL UNITS, centred on the origin. */
function gridGeometry(cells, holeCells) {
  const pos = []
  const idx = []
  const index = new Map()
  const half = cells / 2
  const holeHalf = holeCells / 2

  const vid = (i, j) => {
    const key = i * 4096 + j
    let v = index.get(key)
    if (v === undefined) {
      v = pos.length / 3
      index.set(key, v)
      pos.push(i - half, 0, j - half)
    }
    return v
  }

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      if (holeCells > 0) {
        const inX = i >= half - holeHalf && i < half + holeHalf
        const inZ = j >= half - holeHalf && j < half + holeHalf
        if (inX && inZ) continue
      }
      const a = vid(i, j)
      const b = vid(i + 1, j)
      const c = vid(i + 1, j + 1)
      const d = vid(i, j + 1)
      // WINDING: +i is +x and +j is +z, so (a,b,c) winds CW seen from above and
      // gives a -y face normal -- the whole ground gets backface-culled and you
      // see only the inside of distant hills. The shading normal comes from
      // ngNormalAt, not from the geometry, so lighting looks fine and hides it.
      idx.push(a, c, b, a, d, c)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
  return g
}

const GROUND_VERT = /* glsl */ `
precision highp float;

${HEIGHT_UNIFORMS}

uniform vec2 uOrigin;   // the level's snapped centre, metres
uniform float uCell;    // metres per cell at this level

out vec3 vWorld;
out vec3 vNormal;
out float vCover;
out float vDist;

${HEIGHT_GLSL}

void main() {
  vec2 xz = uOrigin + position.xz * uCell;
  float y = ngHeight(xz, uCell);
  vec3 n = ngNormalAt(xz, uCell, y);

  vWorld = vec3(xz.x, y, xz.y);
  vNormal = n;
  vCover = ngCover(xz, y, n);
  vDist = length(vWorld - cameraPosition);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(vWorld, 1.0);
}
`

const GROUND_FRAG = /* glsl */ `
precision highp float;

${HEIGHT_UNIFORMS}

uniform vec3 uTintA;
uniform vec3 uTintB;
uniform vec3 uTintC;
uniform vec3 uRock;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec2 uWindDir;
uniform vec4 uWind;
uniform float uTime;
uniform float uClutter;   // 0 turns the ground's grass shading off entirely
uniform float uRipple;

in vec3 vWorld;
in vec3 vNormal;
in float vCover;
in float vDist;

out vec4 fragColor;

${HEIGHT_GLSL}

void main() {
  vec2 xz = vWorld.xz;
  vec3 n = normalize(vNormal);

  // --- what colour is the grass here ---------------------------------------
  // Two scales of breakup. The slow one moves the whole hillside between lush
  // and standing; the fast one gives a field its mottle. Both feed the SAME
  // three anchors the blade cards use, so a card never sits on ground of a
  // different green than itself.
  float slow = ngValue(xz * (1.0 / 74.0)) * 0.5 + 0.5;
  float fast = ngValue(xz * (1.0 / 7.5) + vec2(3.1, 8.4)) * 0.5 + 0.5;
  float m = clamp(slow * 0.65 + fast * 0.35, 0.0, 1.0);
  vec3 grass = m < 0.5 ? mix(uTintA, uTintB, m * 2.0) : mix(uTintB, uTintC, (m - 0.5) * 2.0);

  // --- clutter, which is the near ground only ------------------------------
  // Faded out from 30 to 65 m. Past that it is sub-pixel and the only thing it
  // can contribute is shimmer, which is worse than nothing on a headset where
  // there is no temporal AA to clean up after it.
  float near = 1.0 - smoothstep(30.0, 65.0, vDist);
  float clut = ngValue(xz * 3.1) * 0.5 + ngValue(xz * 0.85 + vec2(11.0, 5.0)) * 0.5;
  grass *= 1.0 + clut * 0.28 * near * uClutter;

  // --- the ripple, which is the whole thing --------------------------------
  // A slow field scrolling downwind. Value only, about 8%, and it reads as wind
  // over a meadow from 5 m to the horizon for one noise fetch. This is the term
  // that makes ground-as-grass work at all; turn uRipple to 0 on the panel and
  // watch a lush field become a painted one.
  float rip = ngValue(xz * 0.085 + uWindDir * (uTime * uWind.z * 1.4));
  float rip2 = ngValue(xz * 0.22 - uWindDir * (uTime * uWind.z * 0.8) + vec2(21.0, 4.0));
  grass *= 1.0 + (rip * 0.075 + rip2 * 0.035) * uRipple;

  // --- and where there is no grass -----------------------------------------
  // ngCover is the same number the blade cards cull against, so bare ground
  // appears under the same rule that removed the blades from it.
  float rockN = ngValue(xz * 0.6) * 0.5 + 0.5;
  vec3 rock = uRock * (0.72 + 0.5 * rockN);
  vec3 albedo = mix(rock, grass, smoothstep(0.05, 0.55, vCover));

  // --- contact shadow under the blade layer --------------------------------
  // Inside the near ring the ground genuinely is in the shade of the cards
  // standing on it. Without this the ground is brighter than the grass growing
  // out of it, which reads as the cards floating.
  float contact = 1.0 - 0.35 * vCover * (1.0 - smoothstep(4.0, 26.0, vDist));
  albedo *= contact;

  // --- lighting -------------------------------------------------------------
  float ndl = dot(n, uSunDir);
  float wrap = clamp((ndl + 0.35) / 1.35, 0.0, 1.0);
  vec3 lit = albedo * uSunColor * wrap;
  lit += albedo * mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y);

  // Forward scatter. A meadow looked at INTO the sun is bright silver-green and
  // the same meadow with the sun behind you is flat; this is one dot product
  // and it does more for the look of a hillside at 300 m than any texture.
  vec3 view = normalize(vWorld - cameraPosition);
  float sheen = pow(max(dot(view, uSunDir), 0.0), 3.0);
  lit += albedo * uSunColor * sheen * 0.55 * vCover;

  float fog = 1.0 - exp(-(vDist * uFogDensity) * (vDist * uFogDensity));
  fragColor = vec4(mix(lit, uFogColor, fog), 1.0);
}
`

// ---------------------------------------------------------------------------
// SHELL TEXTURING, in the spike so its cost can be MEASURED rather than argued.
//
// This is the technique people usually mean by "grass as a shader": draw the
// ground N times, each copy pushed a little further up the surface normal, each
// alpha-cut against a noise field whose threshold rises with the shell index.
// The result is a genuinely volumetric-looking fur with no per-blade geometry
// at all, and it is a beautiful trick.
//
// IT IS ALSO THE WRONG TRICK FOR A QUEST, and the reason is architectural
// rather than a matter of tuning. The Adreno in an XR2 is a TILE-BASED renderer
// whose entire performance model rests on resolving each tile once, in an
// on-chip buffer, with hidden-surface removal in front of the fragment shader.
// Shells attack exactly that:
//
//   OVERDRAW IS THE POINT. Sixteen shells over the ground is sixteen layers of
//   fragment work over every pixel of ground on screen, and ground is most of
//   the screen. There is no distance at which it gets cheaper; a shelled
//   hillside at 400 m costs the same per pixel as one at 4 m.
//
//   ALPHA TEST DEFEATS HSR. A fragment that might discard cannot be rejected
//   early, so every shell's fragments are shaded, and they are shaded in
//   back-to-front-ish order with no early-Z to save them.
//
//   IT DOES NOT LOD. Cards get thinner, bigger and fewer with distance -- the
//   whole ladder in grass-field.js is that one idea. Shells have exactly one
//   knob, the shell count, and turning it down does not save the field's
//   silhouette, it removes it.
//
//   AND THE SILHOUETTE IS WRONG ANYWAY. Shells are a stack of horizontal
//   slices, so viewed from a low camera -- which is the ONLY camera a
//   standing-height VR player has -- you look edge-on through the stack and see
//   layers, not blades. Fur shells are a technique for looking DOWN at
//   something.
//
// Left switchable on the panel because the numbers make the case better than
// this comment does: put the head near the ground, turn shells on, and watch
// the frame time against a triangle count that barely moved.
//
// The other "real" shader grass -- per-pixel raymarched parallax over a
// heightfield -- loses for a related reason: it trades the same overdraw for a
// dependent-texture-read loop per fragment, which is worse on mobile, and it
// still has no silhouette above the ground plane.
// ---------------------------------------------------------------------------

const SHELL_VERT = /* glsl */ `
precision highp float;

${HEIGHT_UNIFORMS}

uniform vec2 uOrigin;
uniform float uCell;
uniform float uShells;
uniform float uShellHeight;
uniform vec2 uWindDir;
uniform vec4 uWind;
uniform float uTime;

out vec3 vWorld;
out vec3 vNormal;
out float vCover;
out float vDist;
out float vShell;

${HEIGHT_GLSL}

void main() {
  float k = (float(gl_InstanceID) + 1.0) / uShells;
  vec2 xz = uOrigin + position.xz * uCell;
  float y = ngHeight(xz, uCell);
  vec3 n = ngNormalAt(xz, uCell, y);
  float cover = ngCover(xz, y, n);

  vec3 world = vec3(xz.x, y, xz.y) + n * (k * uShellHeight * cover);
  // The shells lean downwind together, which is the one thing this technique
  // does cheaply and well.
  float gust = ngValue(xz * uWind.y + uWindDir * (uTime * uWind.z));
  world.xz += uWindDir * (k * k * uShellHeight * uWind.x * gust);

  vWorld = world;
  vNormal = n;
  vCover = cover;
  vShell = k;
  vDist = length(world - cameraPosition);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`

const SHELL_FRAG = /* glsl */ `
precision highp float;

${HEIGHT_UNIFORMS}

uniform vec3 uTintA;
uniform vec3 uTintC;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uShellDensity;

in vec3 vWorld;
in vec3 vNormal;
in float vCover;
in float vDist;
in float vShell;

out vec4 fragColor;

${HEIGHT_GLSL}

void main() {
  // The strand field: a hash per cell of a fine lattice, kept if its value
  // clears the shell's own height. High cells survive to the top shells and
  // become tall strands; low ones are cut off near the ground.
  vec2 cell = floor(vWorld.xz * uShellDensity);
  float h = ngHash(cell);
  if (vShell > 0.02 && h < vShell) discard;

  vec3 albedo = mix(uTintA, uTintC, ngValue(vWorld.xz * 0.14) * 0.5 + 0.5);
  albedo *= mix(0.35, 1.05, vShell);

  vec3 n = normalize(vNormal);
  float wrap = clamp((dot(n, uSunDir) + 0.35) / 1.35, 0.0, 1.0);
  vec3 lit = albedo * uSunColor * wrap + albedo * mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y);

  float fog = 1.0 - exp(-(vDist * uFogDensity) * (vDist * uFogDensity));
  fragColor = vec4(mix(lit, uFogColor, fog), 1.0);
}
`

export class Ground {
  constructor(scene, height, shared, { levels = LEVELS } = {}) {
    if (!height || !height.texture) throw new Error('Ground: needs loadHeightTexture()')

    this.scene = scene
    this.shared = shared
    this.levels = []
    this.shells = []

    const full = gridGeometry(N, 0)
    const ring = gridGeometry(N, N / 2 - OVERLAP * 2)
    this.geometries = [full, ring]

    for (let L = 0; L < levels; L++) {
      const cell = BASE_CELL * 2 ** L
      const geometry = L === 0 ? full : ring
      const uniforms = {
        ...shared.height,
        ...shared.sky,
        uTime: shared.time,
        uWindDir: shared.windDir,
        uWind: shared.wind,
        uOrigin: { value: new THREE.Vector2() },
        uCell: { value: cell },
        uTintA: shared.tintA,
        uTintB: shared.tintB,
        uTintC: shared.tintC,
        uRock: { value: new THREE.Color(0.13, 0.115, 0.10) },
        uClutter: shared.clutter,
        uRipple: shared.ripple,
      }
      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: GROUND_VERT,
        fragmentShader: GROUND_FRAG,
      })
      // Finer levels win inside the overlap. The COARSE level is pushed back --
      // positive offset means greater depth -- rather than the fine one pulled
      // forward, so the innermost level keeps an unbiased depth and nothing the
      // player is standing next to can z-fight with a prop. Depth bias only:
      // no vertex moves, so there is no step at the boundary to see, just a
      // decision about which of two nearly-identical surfaces is in front.
      material.polygonOffset = true
      material.polygonOffsetFactor = L
      material.polygonOffsetUnits = L * 4

      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = `newgrass-ground-${L}`
      mesh.frustumCulled = false
      mesh.renderOrder = 1
      scene.add(mesh)

      this.levels.push({ L, cell, mesh, uniforms, snap: 2 * cell })
    }

    // Shells ride the two innermost levels only. Past +-19.6 m the technique
    // has nothing left to show and every shell is pure fill.
    for (let L = 0; L < 2; L++) {
      const cell = BASE_CELL * 2 ** L
      const src = L === 0 ? full : ring
      const geometry = new THREE.InstancedBufferGeometry()
      geometry.setAttribute('position', src.getAttribute('position'))
      geometry.setIndex(src.getIndex())
      geometry.boundingSphere = src.boundingSphere
      geometry.instanceCount = 1

      const uniforms = {
        ...shared.height,
        ...shared.sky,
        uTime: shared.time,
        uWindDir: shared.windDir,
        uWind: shared.wind,
        uOrigin: { value: new THREE.Vector2() },
        uCell: { value: cell },
        uShells: shared.shellCount,
        uShellHeight: shared.shellHeight,
        uShellDensity: { value: 9.0 },
        uTintA: shared.tintA,
        uTintC: shared.tintC,
      }
      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: SHELL_VERT,
        fragmentShader: SHELL_FRAG,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = `newgrass-shells-${L}`
      mesh.frustumCulled = false
      mesh.renderOrder = 3
      mesh.visible = false
      scene.add(mesh)
      this.shells.push({ mesh, geometry, uniforms })
    }
  }

  /**
   * Snap every level to its own grid.
   *
   * SNAPPED TO TWICE THE CELL, not to one cell. At one cell the level's own
   * vertices land on alternating parities as the camera crosses a boundary,
   * which makes the tessellation flicker between two states on a surface whose
   * detail it is only half resolving -- a fine shimmer over the whole hillside.
   * At two, the lattice is invariant under the snap.
   */
  update(camX, camZ) {
    for (const level of this.levels) {
      const s = level.snap
      level.uniforms.uOrigin.value.set(Math.round(camX / s) * s, Math.round(camZ / s) * s)
    }
    for (const shell of this.shells) {
      const s = 2 * shell.uniforms.uCell.value
      shell.uniforms.uOrigin.value.set(Math.round(camX / s) * s, Math.round(camZ / s) * s)
    }
  }

  setShells(on, count) {
    for (const shell of this.shells) {
      shell.mesh.visible = on
      shell.geometry.instanceCount = Math.max(1, count | 0)
    }
  }

  stats() {
    let tris = 0
    for (const level of this.levels) tris += level.mesh.geometry.index.count / 3
    let shellTris = 0
    if (this.shells[0]?.mesh.visible) {
      for (const shell of this.shells) {
        shellTris += (shell.geometry.index.count / 3) * shell.geometry.instanceCount
      }
    }
    return {
      calls: this.levels.length + (this.shells[0]?.mesh.visible ? this.shells.length : 0),
      tris: Math.round(tris),
      shellTris: Math.round(shellTris),
      reach: BASE_CELL * 2 ** (this.levels.length - 1) * (N / 2),
    }
  }
}
