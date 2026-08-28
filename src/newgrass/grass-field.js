import THREE from '../three-instance.js'

import { HEIGHT_GLSL, HEIGHT_UNIFORMS } from './gpu-height.js'
import { buildBladeTexture } from './blade-texture.js'

// ---------------------------------------------------------------------------
// GRASS THAT COSTS NO CPU: a ring clipmap of blade cards, placed in the vertex
// shader, out to 72 m.
//
// FIRST, WHAT BREATH OF THE WILD AND GENSHIN ACTUALLY DO, because the premise
// this spike was asked under is very nearly right and the part that is wrong is
// the part that matters.
//
// They did NOT replace the polygons with a shader. Both games draw grass as
// alpha-cut quads, same as we do. What they did is arrange for there to be very
// few of them, and the arrangement has three parts:
//
//   1. THE BLADES STOP EARLY. BOTW's clutter runs out somewhere around 15-25 m
//      depending on the field. Past that there is no grass geometry at all.
//   2. THE GROUND DOES THE REST. The terrain material is the grass beyond that
//      radius: a tiling clutter texture, a wind ripple scrolling over it, hue
//      and value breakup at several scales. A meadow at 200 m in BOTW is a
//      PAINTED meadow, and it reads as lush because at 200 m a real meadow is
//      also just colour and ripple -- there is no silhouette left to draw.
//   3. PLACEMENT IS GPU-SIDE AND FREE. The blades near you are generated from
//      position, not stored, not streamed, and not visited by a CPU.
//
// That is the whole of it, and none of the three is exotic. The exotic
// alternatives -- shell texturing, raymarched parallax grass -- both EXIST and
// both are actively wrong for a Quest; see the note in ground.js next to the
// shell mode, which is in this spike precisely so the cost can be measured
// rather than argued about.
//
// So the answer to "can we do what they did" is yes, and it is these three
// things, and this file is 1 and 3 while ground.js is 2.
//
// ---------------------------------------------------------------------------
// HOW THE PLACEMENT WORKS, and why there is no instance buffer anywhere.
//
// Three rings. Each is ONE draw of one card geometry instanced K*K times, and
// an instance's entire existence is derived from gl_InstanceID:
//
//   gl_InstanceID  ->  a cell of a fixed world grid near the camera
//                  ->  hash(cell)  ->  jitter, yaw, scale, tint, variant, phase
//                  ->  ngHeight/ngNormal/ngCover at the root
//                  ->  four vertices
//
// The grid is anchored by `floor(camera / cell)`, so it is a WORLD grid that
// the camera slides across rather than a camera-space one that drags the grass
// along. Walk away and back and the same blades are standing in the same
// places, for the same reason the shipped scatter is stable: placement is a
// pure function of position. The difference is that here the function is
// evaluated by the vertex shader, forty thousand times a frame, for free.
//
// WHAT THE CPU DOES PER FRAME: writes uCamXZ and uTime. That is the list.
// No tiles, no jobs, no build budget, no instance pool, no free list, no
// per-instance matrix, no LOD re-tiering pass, no veil sweep, no BatchedMesh
// walking 22,000 instances to cull them. src/v2/render/grass.js is ~1,030 lines
// of extremely careful machinery for managing exactly those things and it is
// all deleted by moving one loop onto the GPU.
//
// ---------------------------------------------------------------------------
// THE RINGS ARE A SCREEN-DENSITY LADDER, not a distance ladder.
//
// The shipped scatter holds one card size (0.55 m) and thins the COUNT with
// distance. This holds the count per ring roughly fixed and grows the CARD.
// Both keep screen density constant; they differ in what they spend to do it.
//
//   ring   metres    cell    card w    cards/m2    cards per unit solid angle
//   0      0-14      0.60    0.75 m    2.78        2.78 * 14^2  = 545
//   1      14-34     1.30    1.55 m    0.59        0.59 * 30^2  = 531
//   2      34-72     2.80    3.10 m    0.128       0.128 * 60^2 = 461
//
// Constant to within 20% across a 5x range of distance, which is the property
// that matters: the bed does not visibly thin as you look further, and nothing
// is being drawn smaller than the pixel it lands on. The blades PER CARD go
// 5 / 9 / 14 as the card widens, so blades per square metre falls the way the
// shipped thinning falls -- but a far blade is now a few texels of a big quad
// instead of two triangles of its own.
//
// AGAINST THE SHIPPED CARPET, both out to ~70 m, both at the same look:
//
//                        shipped (measured, check-grass.mjs)   this spike
//   instances drawn      22,353                                ~6,600
//   triangles            53,400                                ~18,200
//   draw calls           1                                     3
//   per-instance CPU     ~0.82 ms/frame + 0.096 ms update      0
//   growth cost          a job queue and a 2 ms build budget    none
//
// The instance and triangle numbers are good -- 3.4x and 2.9x -- but they are
// not the interesting ones. The interesting one is the third row from the
// bottom, because it is the row that decides whether villages, animals and
// props can be added at all: 0.82 ms of main thread at 72 Hz is 6% of the
// entire frame spent before anything is drawn, and it scales with density.
// Here density is a uniform.
//
// ---------------------------------------------------------------------------
// WHERE THE RINGS MEET, and why there is no seam.
//
// Each ring is snapped to its OWN cell size, so ring 0's grid steps 0.60 m and
// ring 1's steps 1.30 m and the two boundaries cannot coincide -- a hard cut
// between them would be a ragged line sliding around the player at 14 m, which
// is the exact artefact the shipped scatter's tile-boundary work exists to
// avoid.
//
// So the rings OVERLAP by a band and cross-fade through it: ring 0 fades out
// from 14-band to 14+band while ring 1 fades in over the same interval, and
// the two fades are complementary, so total coverage is flat across the joint.
// A card at half fade is dithered, so what is actually on screen in the band is
// a stipple of small cards and large ones, which is exactly as invisible as it
// sounds. The band costs the instances inside it, which is a few hundred.
//
// This is also the LOD cross-fade the shipped material explicitly does not have
// (see the "WHAT IT DOES NOT COVER" note in src/material.js). It is affordable
// here for a structural reason rather than a clever one: an instance that does
// not exist costs nothing, so drawing a band's worth of both tiers is a change
// to two uniforms rather than a second instance per transitioning prop.
//
// ---------------------------------------------------------------------------
// THE ONE THING NOT DONE HERE that production needs: the height and coverage
// come from the imported heightmap plus procedural detail, not from V2Height.
// See the header of gpu-height.js for the swap, which is a camera-following
// pair of textures filled from the real field and is a smaller job than it
// sounds -- and which is also what buys rivers, roads, lakes and the authored
// snow line, none of which this spike knows about.
// ---------------------------------------------------------------------------

// The dissolve threshold below which an instance is not worth submitting. The
// vertex shader collapses it to a degenerate clip position, so it costs its
// vertex invocations and no fill, no raster and no fragment.
const CULL_FADE = 0.004

// Radians. The top edge of a non-billboard card turned about its own axis, so
// a crossed tuft is a twisted prism rather than a pair of flat walls. Lifted
// wholesale from src/props/grass-bank.js, including the value -- see the long
// note there, which is still the best explanation in the repo of why a bed of
// straight quads reads as cardboard.
const TWIST = (22 * Math.PI) / 180

/**
 * The two ring ladders the spike compares.
 *
 * `field` is the proposal. `tufts` reproduces the SHIPPED scatter's law inside
 * the same harness -- 3 tufts/m2 held to 20 m, then thinned as 20/d out to
 * 70 m, on the same 0.55 m three-tier tuft -- so the two can be flipped between
 * on the same hillside with the same lighting and the same terrain, and the
 * only thing that changed is the card design and the ground underneath.
 *
 * IT IS NOT A FAIR CPU COMPARISON AND IS NOT MEANT TO BE: `tufts` is placed on
 * the GPU too, so its CPU cost here is zero and the shipped implementation's is
 * 0.9 ms. The row that comparison belongs in is the table in the header, which
 * quotes check-grass.mjs's measured numbers. What `tufts` is for is the GPU
 * side and the LOOK: same blades, same tints, same ground, and you can see for
 * yourself whether 18k triangles of wide cards beats 53k of small ones.
 *
 * Fields per ring:
 *   inner/outer   metres. The annulus this ring is responsible for.
 *   band          metres of cross-fade on each side of both radii.
 *   cell          metres. Grid pitch, so density is 1/cell^2 cards per m2.
 *   card          [width, height] in metres at unit scale.
 *   scale         [min, max] per-instance multiplier, skewed toward the low end.
 *   planes        quads per card. 1 is a billboard, 2 is a cross, 3 stands on
 *                 the edges of a triangle (grass-bank.js's shape).
 *   billboard     spin the single quad to face the head. Only legal at 1.
 *   blades        blades drawn into the card's cutout.
 *   weight        blade width multiplier, so a far card's blades survive mips.
 */
export const PRESETS = {
  field: {
    label: 'wide cards + grass ground',
    law: null, // no thinning: the ring cell IS the density
    rings: [
      { inner: 0, outer: 14, band: 3.0, cell: 0.60, card: [0.75, 0.46], scale: [0.62, 1.5], planes: 2, billboard: false, blades: 5, weight: 1.0 },
      { inner: 14, outer: 34, band: 3.5, cell: 1.30, card: [1.55, 0.50], scale: [0.70, 1.4], planes: 1, billboard: true, blades: 9, weight: 1.35 },
      { inner: 34, outer: 72, band: 5.0, cell: 2.80, card: [3.10, 0.55], scale: [0.75, 1.35], planes: 1, billboard: true, blades: 14, weight: 2.2 },
    ],
  },
  tufts: {
    label: 'shipped law: 3/m2 tufts, thinned 20/d',
    // [tufts per m2 at full density, metres of full density]. Both are the
    // shipped constants: DENSITY and FULL_RADIUS in src/v2/render/grass.js.
    law: [3, 20],
    rings: [
      { inner: 0, outer: 20, band: 2.0, cell: 0.5774, card: [0.55, 0.55], scale: [0.45, 2.7], planes: 3, billboard: false, blades: 3, weight: 1.0 },
      { inner: 20, outer: 40, band: 2.0, cell: 0.5774, card: [0.55, 0.55], scale: [0.45, 2.7], planes: 2, billboard: false, blades: 3, weight: 1.15 },
      { inner: 40, outer: 70, band: 2.0, cell: 0.8165, card: [0.55, 0.55], scale: [0.45, 2.7], planes: 1, billboard: true, blades: 3, weight: 1.4 },
    ],
  },
}

// The tuft's own colours, carried over unchanged from src/v2/render/grass.js so
// the two carpets are the same green. sRGB; converted to linear below.
const TINTS = [
  [0.30, 0.50, 0.20], // lush
  [0.42, 0.52, 0.24], // standing
  [0.60, 0.56, 0.30], // dry
]

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const LINEAR_TINTS = TINTS.map((rgb) => rgb.map(srgbToLinear))

// ---------------------------------------------------------------------------
// The card geometries. `planes` quads standing on y = 0..1 inside a unit
// footprint, in the local frame the vertex shader rotates and scales.
//
// v RUNS DOWNWARD, because the blade art is drawn on a canvas whose row 0 is
// the top of the card and WebGL will not flip a 2D array texture on upload. So
// the root vertices carry v = 1. Getting this backwards plants the grass by its
// tips, which is at least an easy bug to see.
// ---------------------------------------------------------------------------
function buildCard(planes) {
  const pos = []
  const uv = []
  const idx = []

  // Where each quad's two feet are, in the unit footprint circle.
  const feet = []
  if (planes === 1) {
    feet.push([[-0.5, 0], [0.5, 0]])
  } else if (planes === 2) {
    // Crossed on the centre. Two chords spread apart have a killer azimuth
    // where both go edge-on together; crossed cards never do. Same argument as
    // grass-bank.js's, which is where this shape comes from.
    feet.push([[-0.5, 0], [0.5, 0]])
    feet.push([[0, -0.5], [0, 0.5]])
  } else if (planes === 3) {
    // The edges of an equilateral triangle inscribed in the footprint, so three
    // cards close a base instead of radiating from one seam.
    const c = []
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + Math.PI / 2
      c.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5])
    }
    for (let k = 0; k < 3; k++) feet.push([c[k], c[(k + 1) % 3]])
  } else {
    throw new Error(`buildCard: planes must be 1, 2 or 3, got ${planes}`)
  }

  feet.forEach(([a, b], q) => {
    const base = q * 4
    pos.push(a[0], 0, a[1], b[0], 0, b[1], b[0], 1, b[1], a[0], 1, a[1])
    uv.push(0, 1, 1, 1, 1, 0, 0, 0)
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  })

  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  // Whole-mesh culling is off (the rings follow the camera and are always in
  // front of it), so this only has to be non-degenerate for three's sake.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
  return g
}

const VERT = /* glsl */ `
precision highp float;

${HEIGHT_UNIFORMS}

uniform vec2 uCamXZ;        // the HEAD's ground position -- see the note below
uniform float uTime;

uniform int uK;             // grid is uK x uK cells
uniform float uCell;        // metres per cell
uniform vec2 uRing;         // inner, outer radius in metres
uniform float uBand;        // metres of cross-fade at each radius
uniform vec2 uCard;         // width, height in metres at unit scale
uniform vec2 uScale;        // per-instance multiplier range
uniform float uBillboard;   // 1 = spin the quad to face the head
uniform float uTwist;       // radians of top-edge twist on a fixed card
uniform float uSeed;
uniform float uLayers;      // blade art variants available

uniform vec2 uLaw;          // [cards/m2 at full density, metres of full density]
uniform float uDensity;     // panel multiplier over the whole ladder
uniform float uSink;        // fraction of card height buried
uniform float uLean;        // how far a card leans downhill

uniform vec2 uWindDir;
uniform vec4 uWind;         // amplitude, spatial frequency, scroll speed, gust mix

uniform vec3 uTintA;
uniform vec3 uTintB;
uniform vec3 uTintC;
uniform vec2 uValue;        // per-instance value multiplier range

out vec3 vUv;               // s, t, art layer
out vec3 vTint;
out vec3 vNormal;
out vec3 vWorld;
out float vFade;
out float vUp;              // 0 at the root, 1 at the tip
out float vDist;

${HEIGHT_GLSL}

// Four stable values per cell. Dave Hoskins' hash44; the input is the integer
// cell coordinate, so the whole scatter is a pure function of world position
// and nothing has to be stored to make walking away and back reproduce it.
vec4 ngHash4(vec2 cell, float s) {
  vec4 p = fract(vec4(cell.x, cell.y, cell.x + s, cell.y - s) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  p += dot(p, p.wzxy + 33.33);
  return fract((p.xxyz + p.yzzw) * p.zywx);
}

void main() {
  int K = uK;
  int id = gl_InstanceID;
  vec2 g = vec2(float(id % K), float(id / K)) - float(K / 2);

  // THE GRID IS ANCHORED TO THE WORLD, not to the camera. floor() puts the
  // anchor on a cell boundary, so the lattice steps by whole cells as the
  // player walks and every cell keeps its own hash. A camera-space grid would
  // drag the entire carpet along underfoot, which is the classic tell.
  vec2 cell = floor(uCamXZ / uCell) + g;

  vec4 ra = ngHash4(cell, uSeed);
  vec4 rb = ngHash4(cell, uSeed + 19.73);

  vec2 root = (cell + vec2(0.16) + 0.68 * ra.xy) * uCell;
  vec2 delta = root - uCamXZ;
  float dist = length(delta);

  // The ring's own dissolve: in at its inner radius, out at its outer one, with
  // the two complementary across the overlap band so the joint is flat.
  float fadeIn = uRing.x <= 0.0 ? 1.0 : smoothstep(uRing.x - uBand, uRing.x + uBand, dist);
  float fadeOut = 1.0 - smoothstep(uRing.y - uBand, uRing.y + uBand, dist);
  float fade = fadeIn * fadeOut;

  // The thinning law, when there is one. keep > 1 means the ring is already
  // sparser than the law asks for, which is the 'field' ladder's normal state
  // and compiles to "always keep".
  float keep = uLaw.x <= 0.0
    ? 1.0
    : uLaw.x * min(1.0, uLaw.y / max(dist, 0.001)) * uCell * uCell;
  keep *= uDensity;

  if (fade <= ${CULL_FADE} || ra.z > keep) {
    // Behind the far plane: clipped whole, no raster, no fragments. The
    // vertex invocation itself is the entire cost of a rejected candidate.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float y = ngHeight(root, 0.0);
  vec3 n = ngNormalAt(root, 0.0, y);
  float cover = ngCover(root, y, n);
  fade *= smoothstep(0.04, 0.32, cover);
  if (fade <= ${CULL_FADE}) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  // Skewed toward the short end: screen area goes as the square of height, so
  // a uniform draw would be dominated by the tall tail. Thin ground grows
  // shorter grass, which is what makes a bare shoulder fade out rather than
  // stop.
  float s = mix(uScale.x, uScale.y, ra.w * ra.w) * mix(0.72, 1.0, cover);
  float hgt = uCard.y * s;
  float wid = uCard.x * s;

  float t01 = position.y;
  float bend = t01 * t01;

  vec3 local;
  if (uBillboard > 0.5) {
    // FACING THE HEAD, NOT THE EYE. In stereo the two eyes are 64 mm apart and
    // billboarding each to its own camera turns the card by a different angle
    // per eye, which the visual system reads as the card being at a different
    // DEPTH than its neighbours. Spinning both eyes' copy about the head keeps
    // the stereo pair consistent; the cost is a card very slightly off-axis to
    // each eye, which at 14 m and beyond is nothing.
    vec2 f = uCamXZ - root;
    float fl = length(f);
    vec2 fd = fl > 1e-4 ? f / fl : vec2(0.0, 1.0);
    vec2 right = vec2(fd.y, -fd.x);
    local = vec3(right.x, 0.0, right.y) * (position.x * wid);
  } else {
    float a = rb.x * 6.28318 + uTwist * t01;
    float c = cos(a);
    float sn = sin(a);
    vec2 p = vec2(position.x, position.z) * wid;
    local = vec3(p.x * c - p.y * sn, 0.0, p.x * sn + p.y * c);
  }
  local.y = t01 * hgt;

  // Downhill lean. Grass on a bank is not vertical, and a bed of perfectly
  // vertical cards on a slope reads as a hairbrush. n.xz points downhill by
  // construction, so this is one madd.
  local.xz += n.xz * (hgt * uLean * bend);

  // WIND, and it is two terms because one is not enough. The sine is the local
  // sway, phased per instance so neighbours are not in lockstep. The value
  // noise scrolling downwind is the GUST -- a slow field that moves across the
  // meadow -- and it is the term that makes a field read as weather rather than
  // as an animation. Both are functions of world position and time only, so
  // there is nothing per instance to update and nothing to keep.
  float phase = rb.x * 6.28318;
  float gust = ngValue(root * uWind.y + uWindDir * (uTime * uWind.z));
  float sway = sin(dot(root, uWindDir) * 0.35 + uTime * 2.1 + phase) * (1.0 - uWind.w) + gust * uWind.w;
  local.xz += uWindDir * (uWind.x * hgt * bend * sway);

  vec3 world = vec3(root.x, y - uSink * hgt, root.y) + local;

  // One free bit of variety: the instance reads its picture backwards or not.
  // Doubles the distinct silhouettes in the bed for no second bake and no
  // second layer -- the same trick src/material.js plays with billboard yaw.
  float flipU = rb.y < 0.5 ? uv.x : 1.0 - uv.x;
  vUv = vec3(flipU, uv.y, floor(rb.w * uLayers));
  vUp = t01;
  vFade = fade;
  vNormal = n;
  vWorld = world;
  vDist = dist;

  float m = rb.z;
  vec3 tint = m < 0.5 ? mix(uTintA, uTintB, m * 2.0) : mix(uTintB, uTintC, (m - 0.5) * 2.0);
  // Thin ground is dry ground: as coverage falls the tint walks to the straw
  // anchor, so the margin of a meadow browns off instead of just thinning.
  vTint = mix(uTintC * 0.85, tint, smoothstep(0.12, 0.6, cover)) * mix(uValue.x, uValue.y, ra.z);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2DArray;

uniform sampler2DArray uBlades;
uniform float uAlphaTest;
uniform float uFar;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uTransmit;

uniform vec3 uFogColor;
uniform float uFogDensity;

in vec3 vUv;
in vec3 vTint;
in vec3 vNormal;
in vec3 vWorld;
in float vFade;
in float vUp;
in float vDist;

out vec4 fragColor;

void main() {
  vec4 tex = texture(uBlades, vUv);

  // MIP LOSS IS THE FAR CARD'S REAL ENEMY, not triangles. Every mip level
  // averages blade against background, so a card's alpha shrinks toward its own
  // coverage fraction with distance and a fixed cutoff eats it: the bed thins,
  // then greys, then disappears, all while the triangles are still being drawn.
  // Lowering the cutoff with distance holds the coverage roughly constant. It
  // is the cheap half of what a hashed alpha test does and it is enough here,
  // because the ground underneath is already the right green.
  float cut = mix(uAlphaTest, uAlphaTest * 0.3, clamp(vDist / uFar, 0.0, 1.0));

  // A soft cut rather than a hard one. With alphaToCoverage and 4x MSAA this
  // is a genuinely antialiased blade edge, which the shipped material cannot
  // have -- its alphaTest 0.5 is a binary decision per fragment (DESIGN.md §7).
  // Foliage is nearly all edge, so this is more of a quality win than it sounds.
  float aa = fwidth(tex.a) + 1e-4;
  float a = smoothstep(cut - aa, cut + aa, tex.a);
  if (a < 0.02) discard;

  // The ring cross-fade, as a dither. Interleaved gradient noise, lifted from
  // src/material.js's FADE_FRAGMENT along with the reasoning: 4x4 Bayer has
  // only 16 threshold levels and its 50% level set is exactly a period-2
  // checkerboard, which is the most visible structure a stipple can have -- and
  // half the cards in an overlap band sit at very nearly 50%. ign() is one madd
  // and two fracts and has no level set the eye can lock onto.
  //
  // SCREEN SPACE AND FIXED, so the stipple sits still while a card slides
  // across it. Feeding it time makes it boil, which is worse than the pop it
  // replaced. The stereo caveat in material.js applies here too and is why the
  // overlap bands are as wide as they are: the wider the band, the fewer cards
  // sit at a fade the two eyes can disagree about at once.
  if (vFade < 1.0) {
    float thresh = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (vFade <= thresh) discard;
  }

  vec3 n = normalize(vNormal);

  // LIT AS GROUND, NOT AS A CARD. The normal here is the TERRAIN's, not the
  // quad's, which is deliberate and is the same call src/material.js makes for
  // the fern bed: a card that carries its own normal makes the whole meadow
  // brighten and dim as the player turns on the spot, because the quad turned.
  // A bed of grass at any distance IS a ground surface and lighting it as one
  // is both stable and closer to true.
  float ndl = dot(n, uSunDir);
  float wrap = clamp((ndl + 0.4) / 1.4, 0.0, 1.0);

  // Vertical AO across the card. The art already carries a root gradient; this
  // is the deeper, softer one that makes a clump sit IN the ground.
  float ao = mix(0.45, 1.0, vUp);
  vec3 albedo = vTint * tex.rgb * ao;

  vec3 lit = albedo * uSunColor * wrap;
  lit += albedo * mix(uGroundColor, uSkyColor, 0.5 + 0.5 * n.y);

  // TRANSMISSION. A blade with the sun behind it glows, and this one term does
  // more for "lush" than any amount of extra geometry -- it is what makes a
  // meadow at golden hour read as alive. Gated on vUp so the glow is at the
  // tips, where a blade is actually thin enough to pass light.
  vec3 view = normalize(vWorld - cameraPosition);
  float back = pow(max(dot(view, uSunDir), 0.0), 5.0);
  lit += albedo * uSunColor * (back * uTransmit * vUp);

  float fog = 1.0 - exp(-(vDist * uFogDensity) * (vDist * uFogDensity));
  fragColor = vec4(mix(lit, uFogColor, fog), a);
}
`

export class GrassField {
  /**
   * @param scene    THREE.Scene the ring meshes are added to.
   * @param height   the result of loadHeightTexture().
   * @param shared   uniform cells shared with the ground so the two agree about
   *                 the terrain: see linkTo() below and the note in gpu-height.js.
   */
  constructor(scene, height, shared, { preset = 'field', seed = 7 } = {}) {
    if (!height || !height.texture) throw new Error('GrassField: needs loadHeightTexture()')
    if (!shared) throw new Error('GrassField: needs the shared ground/sky uniform block')

    this.scene = scene
    this.height = height
    this.shared = shared
    this.seed = seed
    this.rings = []
    this.presetName = null

    // Blade art is per RING SHAPE, not per preset, and it is cached: the two
    // presets between them ask for five distinct (aspect, blades, weight)
    // triples, and rebuilding a 256-texel array texture on every toggle would
    // put a visible hitch on a button that is meant to be an A/B.
    this._art = new Map()

    this.setPreset(preset)
  }

  /** Blade art for one ring spec, built once and kept. */
  _artFor(spec) {
    const key = `${spec.card[0] / spec.card[1]}|${spec.blades}|${spec.weight}`
    if (!this._art.has(key)) {
      this._art.set(
        key,
        buildBladeTexture({
          aspect: spec.card[0] / spec.card[1],
          count: spec.blades,
          weight: spec.weight,
          seed: 1000 + this._art.size * 37,
        })
      )
    }
    return this._art.get(key)
  }

  setPreset(name) {
    const preset = PRESETS[name]
    if (!preset) throw new Error(`GrassField: no preset '${name}' (have ${Object.keys(PRESETS)})`)
    if (this.presetName === name) return

    for (const ring of this.rings) {
      this.scene.remove(ring.mesh)
      ring.mesh.geometry.dispose()
      ring.mesh.material.dispose()
    }
    this.rings = []
    this.presetName = name

    const law = preset.law ?? [0, 0]

    preset.rings.forEach((spec, i) => {
      if (spec.billboard && spec.planes !== 1) {
        throw new Error(`GrassField: ring ${i} billboards ${spec.planes} planes -- only a single quad may spin`)
      }
      const art = this._artFor(spec)
      const geometry = buildCard(spec.planes)

      // The grid has to reach the outer fade band, or the ring stops with a
      // hard circular edge one band short of where it says it does. Even, so
      // the camera cell sits at the centre.
      const K = Math.ceil((2 * (spec.outer + spec.band)) / spec.cell / 2) * 2
      geometry.instanceCount = K * K

      const uniforms = {
        ...this.shared.height,
        ...this.shared.sky,
        uCamXZ: this.shared.camXZ,
        uTime: this.shared.time,
        uDensity: this.shared.density,
        uWindDir: this.shared.windDir,
        uWind: this.shared.wind,
        uBlades: { value: art.texture },
        uLayers: { value: art.layers },
        uK: { value: K },
        uCell: { value: spec.cell },
        uRing: { value: new THREE.Vector2(spec.inner, spec.outer) },
        uBand: { value: spec.band },
        uCard: { value: new THREE.Vector2(spec.card[0], spec.card[1]) },
        uScale: { value: new THREE.Vector2(spec.scale[0], spec.scale[1]) },
        uBillboard: { value: spec.billboard ? 1 : 0 },
        uTwist: { value: spec.billboard ? 0 : TWIST },
        uSeed: { value: this.seed + i * 3.77 },
        uLaw: { value: new THREE.Vector2(law[0], law[1]) },
        uSink: { value: 0.08 },
        uLean: { value: 0.35 },
        uTintA: { value: new THREE.Color(...LINEAR_TINTS[0]) },
        uTintB: { value: new THREE.Color(...LINEAR_TINTS[1]) },
        uTintC: { value: new THREE.Color(...LINEAR_TINTS[2]) },
        uValue: { value: new THREE.Vector2(0.82, 1.18) },
        uAlphaTest: { value: 0.42 },
        uFar: { value: spec.outer + spec.band },
        uTransmit: { value: 1.6 },
      }

      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        // Both sides of a blade are the same blade, and the normal is the
        // ground's anyway, so there is nothing for backface culling to save
        // except half the silhouette.
        side: THREE.DoubleSide,
        transparent: false,
        depthWrite: true,
      })
      // Antialiased cutout edges, paid for by the MSAA that is already running.
      // Costs nothing when the target has no samples; then the smoothstep is
      // just a slightly softer binary cut.
      material.alphaToCoverage = true

      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = `newgrass-ring-${i}`
      mesh.frustumCulled = false
      // The rings must draw before the ground writes nothing useful over them
      // and after the sky. Explicit, because a cutout has no blending to hide
      // an ordering mistake behind.
      mesh.renderOrder = 2
      this.scene.add(mesh)

      this.rings.push({ spec, mesh, material, K, uniforms, art })
    })
  }

  /** Panel dials that apply to every ring at once. */
  set density(v) {
    this.shared.density.value = v
  }

  get visible() {
    return this.rings.length > 0 && this.rings[0].mesh.visible
  }

  set visible(v) {
    for (const r of this.rings) r.mesh.visible = v
  }

  /**
   * What the driver is asked for, and what survives the vertex shader.
   *
   * `submitted` is exact -- it is K*K per ring and the index buffer's length.
   * `drawn` is ANALYTIC, not measured: the geometric cull is the area of the
   * ring's annulus over the area of its grid square, and the thinning law is
   * integrated in closed enough form (2*pi*d*min(1/cell^2, law) dd, 128 steps).
   * Coverage is left out of both, so `drawn` is an over-estimate by whatever
   * fraction of the ground is too steep or too high for grass -- which is the
   * safe direction for a claim about cost.
   *
   * The gap between the two numbers is the price of putting a round scatter on
   * a square lattice, and it is worth reading rather than hiding: for `field`
   * it is about a third and every wasted candidate costs one vertex invocation
   * and no fill. For `tufts` it is much larger, and that is an artefact of
   * making a GPU grid imitate a CPU thinning law rather than anything about the
   * shipped scatter, which places exactly what it draws.
   */
  stats() {
    let submitted = 0
    let submittedTris = 0
    let drawn = 0
    let drawnTris = 0

    for (const { spec, K, mesh } of this.rings) {
      const tris = mesh.geometry.index.count / 3
      submitted += K * K
      submittedTris += K * K * tris

      const lo = Math.max(0, spec.inner - spec.band)
      const hi = Math.min(spec.outer + spec.band, (K * spec.cell) / 2)
      const law = PRESETS[this.presetName].law
      let n = 0
      const steps = 128
      for (let s = 0; s < steps; s++) {
        const d = lo + ((s + 0.5) * (hi - lo)) / steps
        const cap = 1 / (spec.cell * spec.cell)
        const want = law ? law[0] * Math.min(1, law[1] / Math.max(d, 0.001)) : cap
        n += 2 * Math.PI * d * Math.min(cap, want) * ((hi - lo) / steps)
      }
      n *= this.shared.density.value
      drawn += n
      drawnTris += n * tris
    }

    return {
      preset: this.presetName,
      rings: this.rings.length,
      calls: this.rings.length,
      submitted: Math.round(submitted),
      submittedTris: Math.round(submittedTris),
      drawn: Math.round(drawn),
      drawnTris: Math.round(drawnTris),
    }
  }

  dispose() {
    for (const ring of this.rings) {
      this.scene.remove(ring.mesh)
      ring.mesh.geometry.dispose()
      ring.mesh.material.dispose()
    }
    for (const art of this._art.values()) art.texture.dispose()
    this.rings = []
    this._art.clear()
  }
}
