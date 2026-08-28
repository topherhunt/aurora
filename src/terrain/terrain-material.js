import THREE from '../three-instance.js'
import { LAYER, ROCK_TILE_MEAN, GRASS_TILE_MEAN, SNOW_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The terrain material: Lambert + vertex colours + a procedural surface grain.
//
// The grain exists for two reasons, and only one of them is looks.
//
// 1. Untextured terrain gives you nothing to judge your own speed against. A
//    smooth green hillside sliding past at 1.45 m/s and the same hillside at
//    14 m/s look nearly identical, because there is no feature small enough to
//    move visibly. Sub-metre grain fixes that outright, and at walking pace it
//    is most of what makes walking feel like walking.
// 2. It breaks up the flat-shaded look of a low-poly heightfield without
//    costing a single triangle.
//
// It is done in the FRAGMENT shader, keyed to world XZ, rather than baked into
// vertex colours in the mesher. That is the load-bearing choice here: vertex
// colours live on a quadtree whose resolution changes with distance, so the
// same hillside would carry 1 m speckle up close and 16 m blotches one LOD ring
// out, and every ring boundary would visibly pop as the pattern rescaled. Keyed
// to world position it is simply the same pattern everywhere, forever.
//
// Cost is roughly 40 ALU per fragment, no texture fetches, and it is skipped
// entirely past `FADE_FAR` -- which is also what stops it aliasing into shimmer
// once the grain is smaller than a pixel. If the Quest turns out to be fill
// bound here, dropping to one octave is a one-line change.
//
// That fade is also why there is a SECOND, separate layer below it. Everything
// past ~95 m used to be flat green or flat grey, and the reason was not that the
// palette was too simple -- it was that the only thing varying the palette had
// already faded out. So the macro layer runs at every distance, deliberately
// un-faded, on wavelengths of ~27 m and ~10 m. Those are still larger than a
// pixel from anywhere you can stand, so there is nothing for them to alias
// into; the near grain needs its fade and this does not.
//
// Those wavelengths were 110 m and 38 m and got divided by four, because at that
// size the two tint layers overlapped across most of any hillside you could see
// and averaged into one muddy middle tone. The variation was there; it was just
// too coarse to read as variation rather than as the base colour.
//
// Keeping them separate rather than adding two more octaves to one fbm is the
// point: the near layer's job is a speed cue and it must die at range, the far
// layer's job is to keep distant hillsides from reading as one colour and it
// must not. One shared fade cannot do both.
//
// GRASS AND SNOW NO LONGER USE MOST OF THAT. Both now wear a PHOTOGRAPH -- one
// metre of meadow and one of crusted snow, tiled -- and where a photograph
// applies, the noise that stood in for it is turned off rather than laid under
// it. See the GROUND_METRES block below for the mechanism and for what is left
// running on each surface. The three noise layers described here still carry
// rock at every distance, and they still carry every surface once the ground
// tiles have faded out past 150 m, so none of the reasoning above is dead.
//
// There is a THIRD layer, on the same reasoning taken one step further:
// ~10 cm flecks, on a fade of its own that is over by 40 m. Same argument as
// the near grain -- a 10 cm feature is a couple of pixels at 40 m and under one
// past that, so it has to be gone by then or it is shimmer rather than texture.
// Every surface gets it, each out of its own palette: grass reuses the dirt and
// moss the coarser octaves already use, rock gets a light and a dark grey, snow
// gets white and off-white. Grass's and snow's halves of it are now inside the
// ground tiles' fade too -- a 128 px tile over one metre resolves 8 mm, so it
// covers the 10 cm scale outright and doing both is two textures at one size.
//
// It sits close to the snow sparkle's ~12 cm, which is deliberate rather than
// an oversight -- they are different operations on the same scale (sparkle adds
// isolated highlights, this tints toward a pair) and snow wants both.
//
// And at that same 10 cm there is now a third thing: a SHADING one, not a
// colour one. The tint layer above says "this speck is a different colour"; the
// relief octave at the bottom of this file says "this speck faces a different
// way", which is what actually stops a surface reading as poured and edible up
// close. Three operations at one scale is not duplication -- a real gritty
// surface differs in albedo and in normal at once, and doing only the first is
// why a flat-shaded hillside with speckle on it still looks like icing.
//
// This is a step-2 stand-in. §7's real material (splat blending, height-blend,
// triplanar, KTX2 arrays) replaces it at build step 6.
// ---------------------------------------------------------------------------

// Grain is at full strength inside FADE_NEAR and gone by FADE_FAR.
const FADE_NEAR = 12
const FADE_FAR = 95

// The micro layer's own fade, tighter than the grain's because the features are
// smaller -- see the header. A 10 cm fleck is about 3 px at 40 m on a Quest and
// on a desktop both, and about 1 px by 90 m, so 40 is the conservative end of
// where it stops being texture. MICRO_FAR is the number to lower if the speckle
// ever reads as a disc of detail travelling with the camera rather than as
// detail resolving when you get close to it.
const MICRO_NEAR = 10
const MICRO_FAR = 40

// ---- The stone layer, and the one place a photograph gets into the terrain.
//
// Everything else in this shader is noise. Noise is isotropic and self-similar,
// which is exactly wrong for a cliff: real rock has BEDDING -- bands, fracture
// lines, a direction. So the rock surface gets rocks/stone.png, the same tile
// the boulders wear, so that a boulder sitting against the cliff it fell off
// reads as the same material rather than as a prop parked on a noise field.
//
// TWO OCTAVES, because one cannot cover the range. STONE_METRES is the coarse
// one at 16 m per tile: that is the bedding, and its features are metres across,
// so it stays legible from most of the way across a valley and has to fade out
// far later than anything else here. FINE_METRES is 2 m, added only up close,
// where the coarse tile has gone soft and there is nothing left to look at.
//
// TRIPLANAR, and not optional: the whole point is cliffs, and a cliff is where a
// flat xz projection stretches a 16 m tile into vertical smears.
const STONE_METRES = 16
const FINE_METRES = 2
// The coarse tile's own fade. Far out past everything else in this file --
// mipping takes the tile to its own mean at distance, and since the shader
// divides by that mean the layer converges to a no-op on its own. The fade is
// therefore about not PAYING for three texture fetches once they stop changing
// any pixels, rather than about hiding a pop.
const STONE_NEAR = 220
const STONE_FAR = 650
// The fine octave's. A 2 m feature is still ~40 px at 90 m, so it earns a range
// well past the 10 cm micro layer's 40 m, but it is three more fetches and the
// coarse layer is carrying the surface by then.
const FINE_NEAR = 30
const FINE_FAR = 130

// ---- The ground tiles: the meadow and the snowfield, photographed.
//
// Same trick as the stone above and for the same reason -- noise is isotropic
// and self-similar, and a lawn is not: it has blades, and they lie in
// directions, and they clump. What replaced it was three octaves of value noise
// that made grass out of speckle, and speckle at three scales is still speckle.
// LAYER.TERRAIN_GRASS and LAYER.TERRAIN_SNOW are one square metre each, cut from
// photographs by tools/props/cut-terrain.mjs.
//
// A CONTRAST FIELD, NOT AN ALBEDO. Each tile is divided by its own linear
// per-channel mean (GRASS_TILE_MEAN / SNOW_TILE_MEAN in textures.js) before it
// multiplies anything, so it averages (1,1,1) and adds the photograph's grain
// and its blade-to-soil colour swing without moving the palette. That is what
// lets a photograph land on a surface whose every colour was tuned untextured,
// and it is the only reason none of the constants in this file had to move.
//
// ONE METRE PER TILE, which is the ask and is also about right: at 128 px that
// is 8 mm a texel, so a blade is a texel or two and a clump is a dozen. It is
// therefore the finest layer in the shader by a wide margin, and everything the
// noise layers say about aliasing applies here twice over -- except that a
// mipped texture solves it for free, which noise cannot. As the tile goes
// sub-pixel its mips converge to its own mean, the divide takes that to 1.0, and
// the layer fades itself out. GROUND_FAR is therefore about not PAYING for a
// fetch that has stopped changing pixels, not about hiding a pop.
//
// PLANAR, where the stone is triplanar, and that is a fill-rate decision rather
// than a quality one: ground is most of the screen and three fetches over most
// of the screen is not a price a Quest can pay. The xz projection stretches by
// 1/cos(slope) -- 15% at 30 degrees -- and by the angle where that would start
// to show, chunk-mesh has already classified the fragment as rock.
//
// WHAT THE TILES TURN OFF, inside their fade and on their own surface only: the
// brightness speckle, the dirt/moss mottle on grass, and the grass and snow
// halves of the 10 cm micro-tint layer. All of them are the same job done worse,
// and running both is two textures at one scale, which reads as mud. What stays:
// the snow SPARKLE (a specular stand-in, not a texture), the macro layers (they
// are regional and the tile is not), and the whole normal-perturbation pass at
// the bottom of this file (the tiles carry no relief, and a lit surface needs
// both).
const GROUND_METRES = 1
// The tiles' own fade. Far shorter than the stone's because the tile is a
// sixteenth of its size: 60 m is where a 1 m tile is starting to be carried by
// its coarser mips anyway, and by 150 m it is several mips deep and worth
// nothing at all. Lower GROUND_FAR first if the Quest turns out to be fill bound
// on ground -- it is one fetch over a large share of the frame's fragments.
const GROUND_NEAR = 60
const GROUND_FAR = 150

// Values are LINEAR, not sRGB -- three treats vertex colours and plain Color
// uniforms as working-space. Roughly: linear 0.05 reads as sRGB 0.25.
const DIRT = new THREE.Color(0.075, 0.052, 0.028) // exposed soil and grit
const MOSS = new THREE.Color(0.022, 0.038, 0.016) // the darker green in the mix

// The macro palette. Each one is a plausible neighbour of the base colour it
// tints, not a different material -- these read as "that slope is drier" and
// "that face is stained", not as painted patches.
const DRY = new THREE.Color(0.072, 0.062, 0.026) // sun-bleached ochre grass
const DEEP = new THREE.Color(0.026, 0.05, 0.022) // damp, shadowed green
const STAIN = new THREE.Color(0.062, 0.05, 0.042) // warm mineral staining on rock

// The two ends of the boundary dither. These must track C_SNOW and C_ROCK in
// chunk-mesh.js: the dither's whole job is to push a transition fragment the
// rest of the way to one side or the other, and if the destination is not the
// colour the mesher would have given it, the dither reads as a stain instead of
// as a border.
const SNOW = new THREE.Color(0.86, 0.88, 0.93)
const ROCK = new THREE.Color(0.085, 0.082, 0.078)

// The micro palette: a light and a dark neighbour for each surface, which is
// all a fleck needs to be. Grass is not here because it already has a pair --
// DIRT and MOSS -- and giving the 10 cm layer its own greens would put two
// unrelated colour families on the same hillside at two scales.
//
// Both pairs straddle their base colour rather than sitting to one side of it,
// so the layer averages back to the base as it fades out and there is no
// brightness step at the fade edge.
const GRIT = new THREE.Color(0.155, 0.152, 0.146) // pale mineral grain on rock
const SOOT = new THREE.Color(0.042, 0.041, 0.039) // the pits between the grains
const FROST = new THREE.Color(1.0, 1.0, 1.0) // a crystal face square to the sun
const SHADE = new THREE.Color(0.74, 0.76, 0.82) // the hollow beside it

// The darkest albedo this palette can put on screen, picked from the palette
// itself rather than written down a second time.
//
// It exists for the WATER (§11): where a mountain blocks the lake's reflection
// the silhouette has to be about as dark as the mountain casting it, and the
// only way to know how dark that is, is to ask the palette. Writing "the dark
// blue is roughly 0.03" into water.js instead would be one more constant that
// drifts out from under the thing it names the first time a colour here moves.
//
// Only the dark half of the palette is a candidate: snow and frost are the
// brightest things in the world and would make nonsense of a minimum. Speckle,
// micro-relief and ambient occlusion all push real fragments DARKER than this
// from here, so this is the bright end of the dark end -- which is the safe
// direction to be wrong in, since it is a floor being matched, not a mean.
export const TERRAIN_DARKEST = [DIRT, MOSS, DRY, DEEP, STAIN, ROCK, GRIT, SOOT].reduce((a, b) =>
  luminance(a) <= luminance(b) ? a : b
)

export function luminance(c) {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

/**
 * @param {object} [opts]
 * @param {THREE.DataArrayTexture} [opts.atlas] The prop texture array, for the
 *   stone layer. OPT-IN: without it no sampler is declared and the two stone
 *   blocks are not compiled at all, so v1's terrain and check-daynight's
 *   standalone material are byte-identical to what they were. Pass the SAME
 *   array the props use -- the point is that a cliff and the boulders on it are
 *   sampling one tile.
 */
export function createTerrainMaterial({ atlas = null } = {}) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })

  material.userData.uniforms = {
    uSpeckle: { value: 0.34 }, // +/- brightness swing, applied to every surface
    uDirtAmount: { value: 0.8 },
    uMossAmount: { value: 0.65 },
    uDirt: { value: DIRT },
    uMoss: { value: MOSS },
    uMacroValue: { value: 0.3 }, // +/- brightness swing at every distance
    uMacroTint: { value: 0.55 }, // how far the macro palette pulls the hue
    // ---- The REGION octave: one more macro wavelength, ~90 m, and the coarsest
    // colour variation in the shader.
    //
    // It exists because of what the ground tiles above it did. A tiled
    // photograph is by construction the same square metre everywhere, so
    // whatever it buys up close it buys nothing at all at range -- and the two
    // macro octaves that used to carry the far field are 27 m and 10 m, which
    // is a wavelength that has averaged itself to a flat tint by the time a
    // hillside is 300 m away. The note above this file's FADE_NEAR records that
    // those two were divided down FROM 110 m and 38 m because at that size they
    // overlapped into one muddy middle tone; this is the coarse end coming back
    // as a THIRD octave rather than as a resizing of the pair, so the mid-range
    // mottle they buy is untouched and the gap above them is what gets filled.
    //
    // Three destinations from one field, which is what "browner, darker,
    // greener" is: the value multiply darkens and lifts whole regions, the high
    // end pulls toward uDirt and the low end toward uDeep. It reuses those two
    // rather than introducing a coarse palette of its own, on the same argument
    // the micro layer reuses them -- one colour family at every scale is what
    // keeps a hillside reading as one material seen at three distances.
    //
    // Snow gets the value swing at half weight (wind scours a drift into bright
    // and dull ground and that reads as snow) and none of the tint (brown snow
    // reads as dirty snow), which is the same split the 27/10 m pair makes.
    uRegionValue: { value: 0.26 }, // +/- brightness swing over ~90 m regions
    uRegionTint: { value: 0.5 }, // how far a region pulls toward dirt or deep green
    uDry: { value: DRY },
    uDeep: { value: DEEP },
    uStain: { value: STAIN },
    uSnow: { value: SNOW },
    uRock: { value: ROCK },
    // How far the snow/rock border is allowed to wander from where the vertex
    // colours put it, in units of the classification's own 0..1 range. 0
    // restores the old hard interpolated edge.
    //
    // The ceiling is not a taste call. Half the amplitude has to stay inside the
    // dead zone of the sharpening smoothstep( 0.25, 0.75 ) below, because that
    // dead zone is the only thing confining the dither to the transition band:
    // vColor saturates to "no snow" somewhat below the line and then reads the
    // same for the whole rest of the world, so past that point the noise starts
    // flecking valley floors it has no business touching. At 0.65 the extreme
    // excursion lands at 0.325 and comes out under a tenth white, which is a
    // stranded patch rather than a dissolved border.
    //
    // An earlier pass ran this at 1.0 behind an explicit world-height guard.
    // That is gone, and deliberately: the snow line is a FIELD now
    // (SNOW.swing in sim/terrain-height.js), so any fixed height window is
    // wrong by up to 22 m in both directions -- it would shut the dither off
    // exactly where the line happens to sit low. The regional variation the
    // guard was buying headroom for is now done properly, one layer up.
    uBoundary: { value: 0.65 },
    // Near-field normal perturbation, as a tangent (i.e. tan of the tilt it
    // adds). 0 disables the whole block, which is the escape hatch if the Quest
    // turns out to be fill bound: it is the most expensive thing in this shader.
    uRelief: { value: 0.35 },
    // The relief ladder's third rung: ~10 cm bumps and divots, on every surface.
    //
    // Its own uniform rather than a third weight inside uRelief because two
    // things about it differ from the pair above. It rides the MICRO fade (gone
    // by 40 m) instead of the grain fade (95 m), since a 10 cm feature is about
    // 3 px at 40 m and under 1 px past it -- the same argument the micro tint
    // layer makes, and past that point this is shimmer rather than texture. And
    // its surface mask is flat: full on rock, half on grass AND snow, where the
    // coarse pair gives snow only a fifth because heavy relief at half a metre
    // makes a drift read as gravel. At 10 cm that does not apply -- windblown
    // snow is pitted at exactly this scale.
    //
    // 0.018 is amplitude in metres per noise unit, so a 10 cm cell moves about
    // 1.8 cm: the same rung as the two octaves above it, since what sets a
    // rung's visual weight is amplitude OVER wavelength and the arithmetic is
    // 0.72*0.7 = 0.50, 2.2*0.3 = 0.66, 10.0*0.018/0.35 = 0.51. It is not a free
    // layer -- one auroraGrad is three noise evaluations, twelve integer hashes
    // -- but it is only paid inside 40 m, which is a small share of fragments.
    // It is nested inside the uRelief guard on purpose: if the Quest turns out
    // to be fill bound, uRelief = 0 must still kill the whole normal pass.
    uMicroRelief: { value: 0.018 },
    // Glitter on snow. Small because it is thresholded to a few percent of
    // fragments -- this is specular sparkle standing in for a spec model Lambert
    // does not have, not a brightness change.
    uSnowSparkle: { value: 0.3 },
    // The ~10 cm layer. uMicroTint is how far a fleck pulls toward its palette
    // colour, uMicroValue the brightness swing underneath it. 0 on uMicroTint
    // does NOT disable the layer -- uMicroValue is independent; set both to 0.
    //
    // Both are HALF what the first pass shipped (0.55 and 0.14), because at
    // full strength the flecks read as garish and pixelly rather than as grit.
    // Halving the knob rather than moving GRIT/SOOT/FROST/SHADE halfway to
    // their base colours, which is what it looks like it should have been:
    // these are only ever applied as mix( base, C, t ), and
    // mix( base, C, t/2 ) == mix( base, (base+C)/2, t ) exactly. Same pixels,
    // one number instead of four, and the constants stay legible as the
    // extreme each surface is tinting TOWARD rather than as a pre-diluted
    // value that cannot be reasoned about. It also covers grass, whose targets
    // are the shared DIRT and MOSS and so cannot be moved without dragging the
    // macro and grain layers along with them.
    //
    // The 10 cm normal perturbation below (uMicroRelief) is deliberately NOT
    // halved with these: shading and albedo are what make a surface read as
    // gritty at this scale, and the complaint was about colour intensity. If
    // it still reads pixelly with the tint at 0.275, that layer is the next
    // one to pull down.
    uMicroTint: { value: 0.275 },
    uMicroValue: { value: 0.07 },
    uGrit: { value: GRIT },
    uSoot: { value: SOOT },
    uFrost: { value: FROST },
    uShade: { value: SHADE },
  }

  if (atlas) {
    material.userData.uniforms.uAtlas = { value: atlas }
    // How far each stone octave is allowed to swing the surface, as a fraction
    // of the fully-applied tile. The tile is a photograph with a lot of contrast
    // in it -- divided by its own mean it ranges roughly 0.2x to 2.3x -- so 1.0
    // here would make the terrain read as wallpaper. 0.55 lands it as rock that
    // has grain in it; the fine octave is deliberately about a third of that
    // because the user's ask for it was "fainter", and because it is layered on
    // top of the coarse one rather than instead of it.
    material.userData.uniforms.uStone = { value: 0.55 }
    material.userData.uniforms.uStoneFine = { value: 0.2 }
    // The tile's own linear mean, per channel. Dividing by it is what turns a
    // photograph into a CONTRAST FIELD: the result averages (1,1,1), so
    // multiplying by it adds the tile's grain and its mineral colour variation
    // without moving the terrain palette a single step darker or warmer. Every
    // colour in this file was tuned against a surface with no texture on it, and
    // this is the only way to add one without invalidating all of them.
    material.userData.uniforms.uStoneMean = {
      value: new THREE.Vector3(ROCK_TILE_MEAN[0], ROCK_TILE_MEAN[1], ROCK_TILE_MEAN[2]),
    }

    // How far each ground tile is allowed to swing its surface. Same units as
    // uStone -- a fraction of the fully-applied contrast field -- and the two
    // differ because the TILES differ, not because grass wants more texture than
    // snow does: cut-terrain.mjs grades the meadow to a relative sd of 0.30 and
    // the snowfield to 0.15, so equal weights here would ship half the crumple.
    // Turn either to 0 to see the noise layers this replaced, which is the
    // comparison the whole GROUND_METRES block above is making.
    material.userData.uniforms.uGrassTile = { value: 0.8 }
    material.userData.uniforms.uSnowTile = { value: 0.9 }
    material.userData.uniforms.uGrassTileMean = {
      value: new THREE.Vector3(GRASS_TILE_MEAN[0], GRASS_TILE_MEAN[1], GRASS_TILE_MEAN[2]),
    }
    material.userData.uniforms.uSnowTileMean = {
      value: new THREE.Vector3(SNOW_TILE_MEAN[0], SNOW_TILE_MEAN[1], SNOW_TILE_MEAN[2]),
    }
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms)

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vWorldPos;')
      // After project_vertex, so `batchingMatrix` is already in scope. Terrain
      // chunks are batched, and their local vertices are chunk-relative -- the
      // batch matrix is the only thing that knows where in the world they are.
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 auroraWorld = vec4( transformed, 1.0 );
        #ifdef USE_BATCHING
          auroraWorld = batchingMatrix * auroraWorld;
        #endif
        vWorldPos = ( modelMatrix * auroraWorld ).xyz;`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWorldPos;
        uniform float uSpeckle;
        uniform float uDirtAmount;
        uniform float uMossAmount;
        uniform vec3 uDirt;
        uniform vec3 uMoss;
        uniform float uMacroValue;
        uniform float uMacroTint;
        uniform float uRegionValue;
        uniform float uRegionTint;
        uniform vec3 uDry;
        uniform vec3 uDeep;
        uniform vec3 uStain;
        uniform vec3 uSnow;
        uniform vec3 uRock;
        uniform float uBoundary;
        uniform float uRelief;
        uniform float uMicroRelief;
        uniform float uSnowSparkle;
        uniform float uMicroTint;
        uniform float uMicroValue;
        uniform vec3 uGrit;
        uniform vec3 uSoot;
        uniform vec3 uFrost;
        uniform vec3 uShade;
${atlas ? `        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        uniform float uStone;
        uniform float uStoneFine;
        uniform vec3 uStoneMean;
        uniform float uGrassTile;
        uniform float uSnowTile;
        uniform vec3 uGrassTileMean;
        uniform vec3 uSnowTileMean;

        // One triplanar sample of LAYER.ROCK at 1/\`k\` metres per tile, blended
        // by pre-normalised world-axis weights. Three fetches, and there is no
        // cheaper honest version: picking the dominant axis instead costs one
        // fetch and draws a visible seam along every 45-degree edge, which on a
        // mountain is most of the edges.
        //
        // textureGrad, and the gradients are passed in rather than taken here,
        // because every call site is inside a branch that is NOT quad-uniform
        // -- the guard folds in distance and the rock/grass classification, so
        // a quad straddling the foot of a crag has some lanes in and some out.
        // An implicit-LOD fetch there is undefined, and the way it actually
        // fails is the sharpest mip on a fragment that should have had the
        // blurriest: a line of sparkling pixels down every grass border. The
        // caller takes dFdx/dFdy of the world position ONCE, outside the
        // branch where it is legal, and both octaves scale the same pair --
        // the uv is a plain multiple of position, so its derivative is too.
        vec3 auroraStone( vec3 p, vec3 dx, vec3 dy, vec3 w, float k ) {
          return textureGrad( uAtlas, vec3( p.zy * k, ${LAYER.ROCK}.0 ), dx.zy * k, dy.zy * k ).rgb * w.x
               + textureGrad( uAtlas, vec3( p.xz * k, ${LAYER.ROCK}.0 ), dx.xz * k, dy.xz * k ).rgb * w.y
               + textureGrad( uAtlas, vec3( p.xy * k, ${LAYER.ROCK}.0 ), dx.xy * k, dy.xy * k ).rgb * w.z;
        }

        // One PLANAR sample of a ground tile at 1/\`k\` metres per tile. See the
        // GROUND_METRES block for why the ground gets one fetch where a cliff
        // gets three, and textureGrad for the same reason auroraStone has it:
        // both call sites sit inside a guard that folds in distance and the
        // surface classification, so the flow is not quad-uniform and an
        // implicit LOD there is undefined.
        vec3 auroraGroundTile( vec3 p, vec3 dx, vec3 dy, float layer, float k ) {
          return textureGrad( uAtlas, vec3( p.xz * k, layer ), dx.xz * k, dy.xz * k ).rgb;
        }
` : ''}
        // Shared between the colour pass and the normal pass, which are two
        // different chunk includes -- hence file scope rather than a block.
        float auroraNear;
        float auroraMicroFade;
        float auroraRockBase;
        float auroraSnowBase;
        // How much of grass's and snow's texture the photographed ground tiles
        // are carrying at this fragment: 1 inside GROUND_NEAR, 0 past GROUND_FAR,
        // and 0 ALWAYS when there is no atlas to sample. The noise layers read it
        // to get out of the way of whatever it is covering, so its default has to
        // be the one that leaves the untextured shader exactly as it was.
        float auroraTileFade;

        // Hash-based value noise. No sin() -- it is slow on mobile GPUs and its
        // precision on some drivers is bad enough to produce visible banding.
        //
        // INTEGER hash, and the reason is a bug rather than a preference. This
        // was the usual fract-of-a-big-multiply hash:
        //
        //   p = fract( p * vec2( 123.34, 456.21 ) );
        //   p += dot( p, p + 45.32 );
        //   return fract( p.x * p.y );
        //
        // which is fine for small p and falls apart for large p, in two ways at
        // once. Its inputs are lattice indices, so they are integers: for
        // integer n, fract( n * 123.34 ) is fract( n * 0.34 ) exactly, and 0.34
        // is close enough to 17/50 that the sequence repeats every 50 cells.
        // Then float32 finishes the job -- at 6 km out and the sparkle octave's
        // frequency, n * 456.21 is around 3e7, past the 24-bit mantissa, so the
        // fractional part being extracted is mostly gone before fract() sees it.
        //
        // Measured on a 400-cell row at the sparkle octave: 148 distinct values
        // out of 400 at the origin, 16 at 1 km, and at 6 km TWO values with a
        // period of 50 along x and a constant along z. That is the snow flecks
        // in dashed parallel lines -- not a pattern in the noise, the noise
        // having collapsed into a comb. The 10 cm micro octave measured the
        // same two values on that row, which is why this had to be fixed
        // before that layer could exist at all.
        //
        // Snow was where it SHOWED, because a hard threshold on a collapsed
        // noise draws the comb in white on white, but the damage was general:
        // on the same row at 6 km the 0.5 m grain octave had 8 distinct values
        // and the relief octave 8, so the near texture and the bump lighting
        // were both quietly degrading with distance from the origin too.
        //
        // uint arithmetic has none of this: it is exact, and wrapping on
        // overflow is defined rather than a precision accident. Same row now
        // gives 400/400 distinct at every distance out to the world edge, mean
        // 0.50, and autocorrelation under 0.03 at every shift including the 50
        // that used to be the period. Costs three integer multiplies, which on
        // Adreno are slower than the float ops they replace -- this is the
        // first thing to look at if the Quest turns out to be fill bound here.
        //
        // Callers must pass integer-valued p. auroraNoise does; nothing else
        // calls this.
        float auroraHash( vec2 p ) {
          uvec2 q = uvec2( ivec2( p ) );
          uint h = ( q.x * 0x3504f333u ) ^ ( q.y * 0xf1bbcdcbu );
          h ^= h >> 15u;
          h *= 0x846ca68bu;
          h ^= h >> 16u;
          return float( h ) * ( 1.0 / 4294967296.0 );
        }

        float auroraNoise( vec2 p ) {
          vec2 i = floor( p );
          vec2 f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          float a = auroraHash( i );
          float b = auroraHash( i + vec2( 1.0, 0.0 ) );
          float c = auroraHash( i + vec2( 0.0, 1.0 ) );
          float d = auroraHash( i + vec2( 1.0, 1.0 ) );
          return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
        }

        // Gradient of auroraNoise by forward difference, in noise-units per
        // p-unit. Three samples rather than the two a central difference would
        // cost, because the centre sample is wanted anyway by every caller.
        vec2 auroraGrad( vec2 p ) {
          float n = auroraNoise( p );
          return vec2( auroraNoise( p + vec2( 0.5, 0.0 ) ) - n,
                       auroraNoise( p + vec2( 0.0, 0.5 ) ) - n ) * 2.0;
        }`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Surface classification, shared by both layers. Read off the vertex
          // colour so batched geometry stays position/normal/colour: grass is
          // green-dominant by construction in chunk-mesh.js, snow is the only
          // thing with a high blue channel, and rock is whatever is left.
          float auroraGreenBase = clamp( ( vColor.g - max( vColor.r, vColor.b ) ) * 20.0, 0.0, 1.0 );
          float auroraVertexSnow = smoothstep( 0.30, 0.60, vColor.b );

          // ---- Boundary dither.
          //
          // The snow line arrives here as a smooth ramp interpolated across
          // triangles, so wherever it crosses the grid at an angle it steps.
          // Alternating the mesh diagonal (chunk-mesh.js) stops that step being
          // REGULAR, but the boundary is still resolved at vertex spacing --
          // 1 m at the leaf and far coarser in the LOD rings, which is where it
          // is most visible.
          //
          // Displacing the classification by a world-space noise moves the
          // decision off the grid entirely: the border now wanders on the
          // noise's wavelengths, which are the same at every LOD and every
          // distance.
          //
          // FOUR octaves, ~130 / 42 / 12 / 3.4 m, and the top of that series is
          // the whole reason this reads at range. The first version had only
          // ~11 m and ~3 m, which is plenty standing next to it and useless a
          // kilometre away: 11 m at 2 km subtends about 0.3 degrees, so it
          // averages to a flat tint and what survives is the vertex ramp
          // underneath -- and that ramp is a function of elevation alone, so it
          // draws a level contour line around every distant peak. The only
          // place that can be fixed is the wavelength. A geometric series
          // rather than a coarse octave bolted onto the old pair, because the
          // gap between 11 m and 130 m is exactly what a mid-distance ridge
          // 300 m out resolves at.
          //
          // Deliberately NOT distance-gated: it is the same snow line seen from
          // further away, so it should be the same shape, and up close she is
          // simply standing inside one lobe of it. Physically it is the right
          // variable to jitter anyway -- a real snow line is not level, since
          // aspect, wind loading and shading move it by tens of metres over a
          // few hundred metres of ground.
          //
          // The rotation between octaves is not decoration. auroraNoise is value
          // noise on an axis-aligned lattice, so a single octave carries a faint
          // grid of its own; up close the finer octaves bury it, but at range
          // the coarse octave is ALL that is left and its lattice is aligned
          // with the chunk grid we just went to some trouble to hide. Turning
          // each octave off-axis decorrelates them.
          //
          // Weights sum to 1, so uBoundary alone bounds the displacement.
          vec2 auroraB = vWorldPos.xz * 0.0077;
          mat2 auroraRot = mat2( 0.80, 0.60, -0.60, 0.80 ); // ~37 deg
          float auroraBN = auroraNoise( auroraB ) * 0.40;          // ~130 m
          auroraB = auroraRot * auroraB * 3.1;
          auroraBN += auroraNoise( auroraB ) * 0.28;               // ~42 m
          auroraB = auroraRot * auroraB * 3.4;
          auroraBN += auroraNoise( auroraB ) * 0.19;               // ~12 m
          auroraB = auroraRot * auroraB * 3.6;
          auroraBN += auroraNoise( auroraB ) * 0.13;               // ~3.4 m

          float auroraSnowD = clamp( auroraVertexSnow + ( auroraBN - 0.5 ) * uBoundary, 0.0, 1.0 );
          auroraSnowBase = smoothstep( 0.25, 0.75, auroraSnowD );
          diffuseColor.rgb = mix( diffuseColor.rgb, uSnow, clamp( auroraSnowBase - auroraVertexSnow, 0.0, 1.0 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, uRock, clamp( auroraVertexSnow - auroraSnowBase, 0.0, 1.0 ) * ( 1.0 - auroraGreenBase ) );

          auroraRockBase = ( 1.0 - auroraGreenBase ) * ( 1.0 - auroraSnowBase );

          // ---- Macro layer: no distance fade, on purpose. See the note above.
          {
            vec2 auroraM = vWorldPos.xz;
            float auroraM1 = auroraNoise( auroraM * 0.0368 ); // ~27 m regions
            float auroraM2 = auroraNoise( auroraM * 0.104 );  // ~10 m within them
            float auroraMacro = auroraM1 * 0.65 + auroraM2 * 0.35;

            // Snow gets a fraction of the brightness swing and none of the tint.
            // Blotchy snow reads as dirty snow, and the shading already gives it
            // all the form it needs.
            diffuseColor.rgb *= 1.0 + ( auroraMacro - 0.5 ) * uMacroValue * ( 1.0 - auroraSnowBase * 0.6 );

            diffuseColor.rgb = mix( diffuseColor.rgb, uDry, smoothstep( 0.58, 0.94, auroraMacro ) * auroraGreenBase * uMacroTint );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.42, 0.08, auroraMacro ) * auroraGreenBase * uMacroTint );
            // Rock stains on the finer octave alone: mineral banding follows the
            // face, not the valley, so it should not track the coarser regions.
            diffuseColor.rgb = mix( diffuseColor.rgb, uStain, smoothstep( 0.52, 0.95, auroraM2 ) * auroraRockBase * uMacroTint * 0.8 );

            // ---- The region octave, ~90 m: browner, darker, greener.
            //
            // See uRegionValue for what it is for. Turned off-axis by the same
            // rotation the boundary dither uses, and for the same reason: at the
            // range this octave exists to serve it is the ONLY variation left,
            // so its value-noise lattice would be the only pattern on a distant
            // hillside, aligned with the chunk grid.
            float auroraRegion = auroraNoise( auroraRot * auroraM * 0.0111 + vec2( 53.2, 17.9 ) );

            diffuseColor.rgb *= 1.0 + ( auroraRegion - 0.5 ) * uRegionValue * ( 1.0 - auroraSnowBase * 0.5 );

            // Wider thresholds than the 27 m pair's -- a region is either dry or
            // it is lush or it is neither, and a smoothstep that starts at the
            // mean would tint every fragment in the world and average back to
            // the base colour, which is the flat green this is here to break.
            diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, smoothstep( 0.62, 0.96, auroraRegion ) * auroraGreenBase * uRegionTint );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.38, 0.04, auroraRegion ) * auroraGreenBase * uRegionTint );
          }

          float auroraDist = length( vWorldPos - cameraPosition );
          auroraNear = 1.0 - smoothstep( ${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, auroraDist );
          // Computed here and UNCONDITIONALLY, even though the tint layer that
          // used to own it sits two blocks deeper: the relief pass at
          // normal_fragment_begin reads it too, and it runs whether or not the
          // near block was entered.
          auroraMicroFade = 1.0 - smoothstep( ${MICRO_NEAR.toFixed(1)}, ${MICRO_FAR.toFixed(1)}, auroraDist );
          // Overwritten by the ground-tile block below wherever there is an
          // atlas to sample. Without one there is no photograph, so nothing is
          // covered and the noise layers keep every surface they ever had.
          auroraTileFade = 0.0;
${atlas ? `
          // ---- Stone. See the header block above STONE_METRES.
          //
          // BEFORE the grain and micro layers rather than after, so those keep
          // the last word: they are the layers that were tuned to sit on top of
          // whatever the surface is, and speckle over stone reads as stone,
          // where stone over speckle reads as a decal.
          //
          // The fade folds auroraRockBase in, so the guard skips the fetches
          // entirely on grass and on snow -- which, below the snow line and
          // outside the crags, is nearly every fragment.
          float auroraStoneK = ( 1.0 - smoothstep( ${STONE_NEAR.toFixed(1)}, ${STONE_FAR.toFixed(1)}, auroraDist ) ) * auroraRockBase;
          // Outside the guard because a derivative is only defined in
          // quad-uniform flow, and this guard is not. See auroraStone.
          vec3 auroraDPx = dFdx( vWorldPos );
          vec3 auroraDPy = dFdy( vWorldPos );
          if ( auroraStoneK > 0.004 ) {
            // The GEOMETRIC normal, deliberately: this runs before
            // normal_fragment_begin, so the relief pass has not perturbed
            // anything yet, and a triplanar blend keyed off bump normals would
            // make the projection swim over a surface that is not moving.
            vec3 auroraWN = normalize( inverseTransformDirection( normalize( vNormal ), viewMatrix ) );
            vec3 auroraTri = pow( abs( auroraWN ), vec3( 4.0 ) );
            auroraTri /= ( auroraTri.x + auroraTri.y + auroraTri.z );

            vec3 auroraRockTex = auroraStone( vWorldPos, auroraDPx, auroraDPy, auroraTri, ${(1 / STONE_METRES).toFixed(6)} ) / uStoneMean;
            diffuseColor.rgb *= mix( vec3( 1.0 ), auroraRockTex, uStone * auroraStoneK );

            float auroraFineK = ( 1.0 - smoothstep( ${FINE_NEAR.toFixed(1)}, ${FINE_FAR.toFixed(1)}, auroraDist ) ) * auroraStoneK;
            if ( auroraFineK > 0.004 ) {
              // LUMINANCE only, where the coarse octave keeps its colour. Two
              // decorrelated copies of the same tile's mineral tinting stacked
              // on one fragment reads as chromatic noise rather than as more
              // rock, and dropping the chroma here also means the near octave
              // cannot push the palette anywhere the coarse one has not
              // already been allowed to.
              vec3 auroraFineTex = auroraStone( vWorldPos, auroraDPx, auroraDPy, auroraTri, ${(1 / FINE_METRES).toFixed(6)} );
              float auroraFineL = dot( auroraFineTex, vec3( 0.2126, 0.7152, 0.0722 ) )
                / dot( uStoneMean, vec3( 0.2126, 0.7152, 0.0722 ) );
              diffuseColor.rgb *= mix( 1.0, auroraFineL, uStoneFine * auroraFineK );
            }
          }

          // ---- The ground tiles. See the GROUND_METRES block above.
          //
          // Same shape as the stone block, one fetch instead of three, and each
          // guard folds in its own surface so a grass fragment never pays for
          // the snow tile and neither pays anything above the snow line's crags.
          // Both reuse the derivatives taken outside the stone guard: the uv is a
          // plain multiple of world position, so its derivative is one too.
          auroraTileFade = 1.0 - smoothstep( ${GROUND_NEAR.toFixed(1)}, ${GROUND_FAR.toFixed(1)}, auroraDist );

          float auroraGrassK = auroraTileFade * auroraGreenBase;
          if ( auroraGrassK > 0.004 ) {
            vec3 auroraGrassTex = auroraGroundTile( vWorldPos, auroraDPx, auroraDPy, ${LAYER.TERRAIN_GRASS}.0, ${(1 / GROUND_METRES).toFixed(6)} ) / uGrassTileMean;
            diffuseColor.rgb *= mix( vec3( 1.0 ), auroraGrassTex, uGrassTile * auroraGrassK );
          }

          float auroraSnowK = auroraTileFade * auroraSnowBase;
          if ( auroraSnowK > 0.004 ) {
            vec3 auroraSnowTex = auroraGroundTile( vWorldPos, auroraDPx, auroraDPy, ${LAYER.TERRAIN_SNOW}.0, ${(1 / GROUND_METRES).toFixed(6)} ) / uSnowTileMean;
            diffuseColor.rgb *= mix( vec3( 1.0 ), auroraSnowTex, uSnowTile * auroraSnowK );
          }
` : ''}
          if ( auroraNear > 0.004 ) {
            vec2 auroraP = vWorldPos.xz;
            // Two scales: ~0.5 m grit for the speed cue, ~3.5 m patches so the
            // ground reads as varied rather than as uniform sandpaper.
            float auroraGrain = auroraNoise( auroraP * 1.9 ) * 0.6 + auroraNoise( auroraP * 0.28 ) * 0.4;
            auroraGrain = mix( 0.5, auroraGrain, auroraNear );

            // HOW MUCH OF THIS FRAGMENT THE PHOTOGRAPHS ARE NOT CARRYING. Rock
            // is always 1 -- it has a tile of its own but that one is bedding at
            // 16 m, which says nothing at half a metre. Grass and snow fall to 0
            // inside GROUND_NEAR and come back as their tiles fade out, so the
            // noise below is what the surface reverts TO rather than a layer
            // stacked under a photograph. Clamped because the two
            // classifications are near-exclusive rather than provably so.
            float auroraProc = clamp( 1.0 - auroraTileFade * ( auroraGreenBase + auroraSnowBase ), 0.0, 1.0 );

            // Brightness speckle. Applies to grass, rock and snow alike -- snow
            // without it is a flat white void with no readable surface at all.
            diffuseColor.rgb *= 1.0 + ( auroraGrain - 0.5 ) * uSpeckle * auroraProc;

            // Dirt and moss only show through on green ground, and only close
            // enough to see them -- and only where the meadow tile is not
            // already drawing the soil between the blades, which up close is
            // everywhere.
            float auroraGreen = auroraGreenBase * auroraNear * ( 1.0 - auroraTileFade );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, smoothstep( 0.56, 0.88, auroraGrain ) * auroraGreen * uDirtAmount );
            diffuseColor.rgb = mix( diffuseColor.rgb, uMoss, smoothstep( 0.44, 0.12, auroraGrain ) * auroraGreen * uMossAmount );

            // ---- Snow glitter.
            //
            // Snow's problem is the opposite of grass's: it is already bright,
            // so darkening it with grain reads as dirt rather than as texture.
            // What real snow gives you at walking distance is individual
            // crystals catching the sun -- isolated points BRIGHTER than the
            // surface, on a surface that is otherwise smooth.
            //
            // So: one high-frequency octave (~12 cm), thresholded hard so only
            // the top few percent survive, added rather than multiplied. The
            // threshold is what makes it read as discrete points; a smooth
            // version of this is just noise and looks like static.
            //
            // It fades on the same curve as everything else here, which also
            // keeps 12 cm features from aliasing once they go sub-pixel.
            float auroraSparkle = auroraNoise( auroraP * 8.3 );
            diffuseColor.rgb += smoothstep( 0.86, 1.0, auroraSparkle ) * auroraSnowBase * auroraNear * uSnowSparkle;

            // ---- Micro layer: ~10 cm flecks, on every surface, near only.
            //
            // Nested inside the near block because the micro fade is strictly
            // inside the grain fade -- auroraNear is still ~0.72 at MICRO_FAR
            // and does not reach the 0.004 cutoff until about 90 m -- so there
            // is no distance at which the micro layer is wanted and the grain
            // is not. It costs one noise evaluation and six mixes, and it is
            // skipped for every fragment past 40 m, which is most of them.
            //
            // ONE octave feeding both ends of each pair: the light fleck sits
            // where the noise peaks and the dark fleck in the valleys between,
            // which is how the grain layer above already works. A second
            // decorrelated octave would double the cost to separate two
            // features that are a centimetre apart and never seen apart.
            //
            // The thresholds are tighter than the grain's -- 0.62/0.90 rather
            // than 0.56/0.88 -- so this reads as discrete specks scattered over
            // the coarser mottling rather than as a second wash of it. That is
            // the whole difference between "speckled" and "muddy" at this size.
            if ( auroraMicroFade > 0.004 ) {
              // ~10 cm cells. World-keyed like everything else here, so it does
              // not swim when she walks and does not rescale across LOD rings.
              // vWorldPos resolves about 1 mm at the far edge of a 16 km world,
              // which is a hundred samples across one fleck -- ample.
              float auroraMicroN = auroraNoise( auroraP * 10.0 );
              float auroraMicroHi = smoothstep( 0.62, 0.90, auroraMicroN );
              float auroraMicroLo = smoothstep( 0.38, 0.10, auroraMicroN );
              float auroraMicroK = auroraMicroFade * uMicroTint;
              // The tiles resolve 8 mm, so on grass and snow they have already
              // drawn this scale and drawn it from a photograph. Rock keeps its
              // pair whole -- the stone tile it wears is 16 m of bedding, which
              // is four scales coarser than a fleck.
              float auroraMicroProc = 1.0 - auroraTileFade;

              diffuseColor.rgb *= 1.0 + ( auroraMicroN - 0.5 ) * uMicroValue * auroraMicroFade * auroraProc;

              // Grass reuses DIRT and MOSS on purpose -- see the note on the
              // micro palette. Rock and snow get the pairs of their own.
              diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, auroraMicroHi * auroraGreenBase * auroraMicroK * auroraMicroProc );
              diffuseColor.rgb = mix( diffuseColor.rgb, uMoss, auroraMicroLo * auroraGreenBase * auroraMicroK * auroraMicroProc );
              diffuseColor.rgb = mix( diffuseColor.rgb, uGrit, auroraMicroHi * auroraRockBase * auroraMicroK );
              diffuseColor.rgb = mix( diffuseColor.rgb, uSoot, auroraMicroLo * auroraRockBase * auroraMicroK );
              diffuseColor.rgb = mix( diffuseColor.rgb, uFrost, auroraMicroHi * auroraSnowBase * auroraMicroK * auroraMicroProc );
              diffuseColor.rgb = mix( diffuseColor.rgb, uShade, auroraMicroLo * auroraSnowBase * auroraMicroK * auroraMicroProc );
            }
          }
        }`
      )
      // ---- Near-field relief.
      //
      // The ask was another layer of micro variation, "minorly jagged and
      // rocky", for the immediate region only. It deliberately does NOT go in
      // the height field. The leaf chunk resolves 1.00 m cells, so a seventh
      // detail octave would land at ~0.7 m wavelength, below Nyquist for the
      // mesh that has to carry it: it would alias into a crawling pattern that
      // changes every time a chunk rebuilds, and it would cost five more field
      // evaluations on the collision path, which is already the frame's most
      // expensive query. It would also feed straight into the slope limiter and
      // manufacture exactly the sub-metre refusals this round exists to remove.
      //
      // Perturbing the shading normal instead buys the look with none of that.
      // It is geometry-free, so nothing rebuilds and nothing can block her; it
      // is keyed to world XZ, so it does not rescale across LOD rings; and it
      // is inside the same near fade as the grain, so it is gone before it can
      // alias.
      //
      // THREE octaves now, at ~1.4 m, ~0.45 m and ~10 cm, which is the "different
      // octaves" the rock ask wanted -- the coarse one gives a face its lumps,
      // the middle one gives those lumps a surface, and the fine one is what
      // stops that surface reading as poured and edible at arm's length.
      //
      // The coarse pair share a mask: rock gets all of it, snow a fifth (it
      // drapes and smooths, and heavy relief at half a metre makes a drift read
      // as gravel), grass the remainder at half strength. The 10 cm octave has
      // its own, flat mask -- full on rock, half on grass and snow alike -- and
      // its own tighter fade. See uMicroRelief for why both differ.
      //
      // Note what is NOT happening here: this is not a seventh octave of the
      // height field. The leaf chunk resolves 1.00 m cells, so 10 cm is a fifth
      // of Nyquist for the mesh -- it would alias into a pattern that crawls
      // whenever a chunk rebuilds, cost five field evaluations on the collision
      // path, and hand the slope limiter sub-metre walls. Perturbing the shading
      // normal buys the look with none of that: geometry-free, world-keyed so it
      // does not rescale across LOD rings, and faded out before it can alias.
      //
      // Placed at normal_fragment_begin, which runs after color_fragment, so the
      // classification and fade computed there are already in scope. `normal` is
      // in VIEW space at this point, hence the viewMatrix on the perturbation --
      // as a direction, so translation drops out.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        if ( uRelief > 0.0 && auroraNear > 0.004 ) {
          float auroraReliefAmt = auroraNear * uRelief *
            ( auroraRockBase + auroraSnowBase * 0.2 + ( 1.0 - auroraRockBase - auroraSnowBase ) * 0.5 );
          vec2 auroraR = vWorldPos.xz;
          vec2 auroraG = auroraGrad( auroraR * 0.72 ) * 0.72 * 0.7
                       + auroraGrad( auroraR * 2.2 ) * 2.2 * 0.3;
          vec3 auroraBump = vec3( -auroraG.x, 0.0, -auroraG.y ) * auroraReliefAmt;

          // ~10 cm bumps and divots. Added to the same bump vector rather than
          // applied as a second normalize: two successive normalizes would let
          // the coarse tilt swallow the fine one wherever the coarse tilt is
          // large, which is on rock -- precisely where this octave is meant to
          // be strongest.
          if ( uMicroRelief > 0.0 && auroraMicroFade > 0.004 ) {
            float auroraMicroAmt = auroraMicroFade * uMicroRelief *
              ( auroraRockBase + ( 1.0 - auroraRockBase ) * 0.5 );
            vec2 auroraMG = auroraGrad( auroraR * 10.0 ) * 10.0;
            auroraBump += vec3( -auroraMG.x, 0.0, -auroraMG.y ) * auroraMicroAmt;
          }

          normal = normalize( normal + ( viewMatrix * vec4( auroraBump, 0.0 ) ).xyz );
        }`
      )
  }

  // Distinct cache key so this never gets conflated with an unpatched Lambert,
  // and distinct BETWEEN the two variants: whether the atlas was passed changes
  // the compiled source, so the two must never share a program.
  const key = `aurora-terrain-v8${atlas ? '-stone' : ''}`
  material.customProgramCacheKey = () => key

  return material
}
