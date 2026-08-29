import THREE from '../three-instance.js'
import { LAYER, ROCK_TILE_MEAN, GRASS_TILE_MEAN, SNOW_TILE_MEAN } from '../textures.js'
import { GRIT_GRAD_SCALE, terrainDetailTextures } from './grit-texture.js'

// ---------------------------------------------------------------------------
// The terrain material: Lambert + vertex colours + FOUR TEXTURE FETCHES.
//
// It used to be Lambert + vertex colours + about twenty evaluations of a
// hash-based value noise, and the change from that to this is the single
// largest performance decision in the renderer. The measurement that forced it:
// with the terrain hidden the headset holds 85 fps; with the terrain drawn and
// STOCK Lambert on it, still 85; with the terrain drawn and this file's patch
// on it, 30. Same meshes, same triangle count, same draw calls, same fog, same
// lights. The terrain was never triangle bound. Every frame of that gap was
// being spent inside one `#include <color_fragment>` patch, and the LOD and
// chunking work could not have touched it.
//
// So the noise is gone and the fields it produced are baked. See
// grit-texture.js for how, and for the honest accounting of what a tileable
// texture costs that world-space noise does not.
//
// WHAT THE SURFACE IS MADE OF NOW, from coarsest to finest, and each one is a
// channel of one of two 256 px tiles rather than a layer of its own:
//
//   MACRO, sampled at 1024 m per tile, EVERY FRAGMENT AT EVERY DISTANCE.
//     .a displaces the snow line off the vertex grid; .r darkens and tints
//     whole regions. These do not fade with distance and must not: their job is
//     that everything past the near fades used to be flat green or flat grey,
//     and the reason was never that the palette was too simple -- it was that
//     the only thing varying the palette had already faded out.
//
//   MACRO AGAIN, at 137 m per tile and rotated ~37 degrees off the first, gated
//     on the HAZE rather than on distance. Its own fbm ladder inside that tile
//     runs 137 m down to ~4 m, which is the mid-range mottle: dry slopes, damp
//     hollows, mineral staining on rock.
//
//   GRIT, at 11.7 m per tile, inside FADE_FAR. 256 texels across 11.7 m is
//     4.6 cm a texel, magnified NEAREST -- which is the whole look. It is the
//     bench ground from preview-stage.js (3 m over 64 px, 4.7 cm texels) at the
//     same texel size, and it is there because a smooth hillside gives you
//     nothing to judge your own speed against: at 1.45 m/s and at 14 m/s an
//     untextured slope looks identical, because no feature is small enough to
//     move visibly. Its .gb carry the surface's slope, so the same fetch that
//     colours the ground also lights it.
//
//   GRIT AGAIN, at 2.3 m per tile and rotated, inside MICRO_FAR. Sub-centimetre
//     texels: the fleck tint, the snow sparkle, and the finest rung of relief.
//     It is also what stops the 11.7 m sample reading as a repeating tile
//     underfoot, since 11.7 and 2.3 have no useful common multiple.
//
// FOUR FETCHES IS THE WORST CASE and it is the near field only. Past 40 m it is
// three, past 95 m two, and past the haze gate one.
//
// WHY THE FADES STILL EXIST when a mipped texture cannot alias: they are about
// not PAYING for a fetch that has stopped changing the pixel, not about hiding
// a crawl. That is a weaker claim than the noise layers had to make, and it is
// why the numbers below could all move outward without anything shimmering.
//
// GRASS AND SNOW ALSO WEAR A PHOTOGRAPH -- one metre of meadow and one of
// crusted snow, tiled -- and where a photograph applies, the grit layers turn
// off rather than lying under it. See the GROUND_METRES block below. Rock keeps
// the grit at every distance, and every surface gets it back once the ground
// tiles have faded out past 150 m.
//
// This is a step-2 stand-in. §7's real material (splat blending, height-blend,
// triplanar, KTX2 arrays) replaces it at build step 6.
// ---------------------------------------------------------------------------

// Grain is at full strength inside FADE_NEAR and gone by FADE_FAR.
const FADE_NEAR = 12
const FADE_FAR = 95

// ---- The four sampling scales, in metres of world per tile.
//
// THE RATIOS ARE THE INTERESTING PART, not the absolute sizes. Both textures
// tile, so every scale sampled from one of them repeats; two scales off the
// same tile repeat TOGETHER only where their periods coincide, so the pairs are
// picked to make that coincidence as distant as a pair of floats can. 11.7 and
// 2.3 first agree after 269 m; 1024 and 137 after 20 km, which is past the far
// edge of an 8 km world.
//
// GRIT_METRES is also what fixes the texel size, and that is a look decision
// rather than a range one: 256 texels over 11.7 m is 4.6 cm a texel, which is
// the bench ground's 4.7 cm (preview-stage.js runs 64 px over 3 m). Magnified
// NEAREST, so those texels are visible squares underfoot. Change this number
// and the ground stops looking like the bench, whatever else it does.
//
// MACRO_METRES is a full kilometre because it carries the snow line's wander,
// and a snow line that repeated every couple of hundred metres would draw the
// same border around every peak in the range.
const GRIT_METRES = 11.7
const GRIT_FINE_METRES = 2.3
const MACRO_METRES = 1024
const MACRO_FINE_METRES = 137

// The rotation applied to the finer sample of each pair, as its matrix. Not
// decoration: both textures are square lattices, so two samples of one tile at
// different scales carry the same axis-aligned grid, and up close that grid
// lines up with the chunk grid the mesher goes to some trouble to hide. Turning
// the fine sample off-axis decorrelates them. ~37 degrees, which is far from
// every multiple of 45 and therefore from every way a square can agree with
// itself.
const ROT = 'mat2( 0.80, 0.60, -0.60, 0.80 )'

// ROT's inverse, which for a rotation is its transpose.
//
// Needed because a fetch taken through ROT reports its packed derivative in
// the ROTATED frame: if uv = ROT * (p * k) then dh/dp = k * ROT^T * grad_uv.
// A world-space bump wants dh/dp, so the fine grit sample's .gb has to be
// turned back before it can be added to one. Getting this wrong does not look
// like an error -- it looks like lighting that is subtly lit from the wrong
// side, which is much harder to notice and much harder to find.
const ROT_T = 'mat2( 0.80, -0.60, 0.60, 0.80 )'

// Where a surface has been eaten by the haze far enough that its own colour
// variation cannot read, as a fraction of its colour that survives to the eye.
//
// The gate that hangs off this is keyed to TRANSMITTANCE rather than to a
// distance, and that is the load-bearing choice. `scene.fog` is FogExp2 driven
// by clock.js's `hazeDensity`, which swings more than 5x over a day: 0.00113 at
// noon, 0.00021 at night. "Past 1.5 km it is all hazy blue" is exactly true at
// the noon value -- 5.7% of the surface survives there -- and wrong by a factor
// of five at the night one, where 1.5 km still delivers 91%. A hard-coded 1500
// would erase the snow line's shape and flatten every distant hillside on a
// clear night. Transmittance is the very number the fog chunk multiplies this
// fragment by a few lines later, so gating on it says precisely what is meant:
// stop paying for detail that the fog is about to eat.
//
// At the noon density these two land at about 1.59 km and 1.24 km.
const HAZE_GONE = 0.04
const HAZE_FULL = 0.14

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

  const detail = terrainDetailTextures()

  material.userData.uniforms = {
    // The two baked fields every layer below is now a channel of. Shared across
    // every material this factory makes -- see terrainDetailTextures.
    uGritMap: { value: detail.grit },
    uMacroMap: { value: detail.macro },
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
    // Near-field normal perturbation from the COARSE grit fetch, as a plain
    // multiplier on that fetch's own slope. 0 disables the whole normal block,
    // which is the escape hatch if the headset is still fill bound.
    //
    // RETUNED from 0.35 when the noise was baked, and the number went DOWN
    // because the field under it got steeper, not because the look changed.
    // Old: |d(noise)/d(metre)| averaged 0.3605 over the two octaves at their
    // weights, so 0.35 bought a mean tangent of 0.126. New: the baked field's
    // packed gradient averages 5.785 per tile-unit, which over an 11.7 m tile
    // is 0.4945 per metre, so 0.255 buys the same 0.126. Measured, not
    // estimated -- both numbers came out of a script that ran the old GLSL in
    // JS against the new texture's actual bytes.
    uRelief: { value: 0.255 },
    // The relief ladder's fine rung, from the FINE grit fetch: ~1 cm bumps and
    // divots, on every surface.
    //
    // Its own uniform rather than a weight inside uRelief because two things
    // about it differ. It rides the MICRO fade (gone by 40 m) instead of the
    // grain fade (95 m), since a feature this size is about 3 px at 40 m and
    // under 1 px past it -- the same argument the micro tint layer makes, and
    // past that point this is shimmer rather than texture. And its surface mask
    // is flat: full on rock, half on grass AND snow, where the coarse rung
    // gives snow only a fifth because heavy relief at half a metre makes a
    // drift read as gravel. At a centimetre that does not apply -- windblown
    // snow is pitted at exactly this scale.
    //
    // Retuned from 0.018 by the same measurement: the old 10 cm octave averaged
    // 4.2576 per metre, so 0.018 bought a tangent of 0.0766; the new fine fetch
    // averages 5.785 per tile-unit over a 2.3 m tile, which is 2.5153 per
    // metre, so 0.030 buys the same. It is nested inside the uRelief guard on
    // purpose: uRelief = 0 must still kill the whole normal pass.
    uMicroRelief: { value: 0.03 },
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
    // snow does: cut-terrain.mjs grades the meadow to a relative sd of 0.60 and
    // the snowfield to 0.15, so equal weights here would ship a quarter of the
    // crumple. Turn either to 0 to see the noise layers this replaced, which is
    // the comparison the whole GROUND_METRES block above is making.
    //
    // WHAT SHIPS IS THE PRODUCT of the weight here and that sd, so the meadow
    // lands at 0.48 and the snowfield at 0.135. Push the CONTRAST from the cut
    // rather than from here: past 1.0 this mix() extrapolates, and an
    // extrapolated field goes negative in its low tail, which clamps to black
    // specks rather than to deep shadow.
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
        uniform sampler2D uGritMap;
        uniform sampler2D uMacroMap;
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
        // The normal perturbation, accumulated where the grit fetches happen
        // and applied at normal_fragment_begin. It lives at file scope because
        // those are two different chunk includes and nothing else crosses
        // between them any more: the classifications and fades used to be up
        // here too, back when the normal pass computed its own bumps and needed
        // them. It does not -- the SLOPE arrives in the .gb of the very fetches
        // the colour pass is already making, and re-fetching them one include
        // later to read two more channels would double the most expensive thing
        // left in this shader -- so this is the only survivor.
        vec3 auroraBump;

        // ---- Why there is no noise function in this file any more.
        //
        // There was, and it was correct: an integer-hash value noise, chosen
        // over the usual fract-of-a-big-multiply because that one collapses at
        // world scale. Measured on a 400-cell row at the sparkle octave it gave
        // 148 distinct values out of 400 at the origin, 16 at 1 km, and at 6 km
        // TWO -- a comb with a period of 50 m, which is what drew the snow
        // flecks in dashed parallel lines. The uint version fixed that outright:
        // 400/400 distinct at every distance to the world edge.
        //
        // It cost three integer multiplies a hash, four hashes a sample, and
        // about twenty samples a near-field fragment. Its own note said "on
        // Adreno these are slower than the float ops they replace -- this is
        // the first thing to look at if the Quest turns out to be fill bound
        // here." The Quest turned out to be fill bound here.
        //
        // Both problems -- the collapse at distance and the cost -- are gone for
        // the same reason. A texture fetch has no precision to lose: the lattice
        // is 256 texels and the wrap is exact however far from the origin the
        // sample is taken. See grit-texture.js.
        //
        // EVERY FETCH BELOW IS textureGrad AND THE GRADIENTS COME FROM ONE PAIR
        // OF DERIVATIVES TAKEN OUTSIDE ALL THE BRANCHES. Every guard in this
        // shader folds in distance and the surface classification, so none of
        // them is quad-uniform -- a quad at the foot of a crag has some lanes in
        // and some out. An implicit-LOD fetch there has no defined result per
        // the ES spec, and the way it actually fails is the sharpest mip on a
        // fragment that wanted the blurriest: a line of sparkling pixels down
        // every border. Since every uv here is a plain (optionally rotated)
        // multiple of world XZ, one pair of world-position derivatives scales
        // to all of them.
        //
        // (The wording above dodges one particular word on purpose --
        // check-daynight.mjs greps the assembled source for it as its
        // unresolved-template tripwire, and a comment must not trip a gate.)`
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

          // Hoisted above every layer below because the FIRST of them needs it.
          float auroraDist = length( vWorldPos - cameraPosition );

          // ONE PAIR OF DERIVATIVES FOR THE WHOLE SHADER, taken here where the
          // flow is still quad-uniform. Every fetch below sits inside a guard
          // that folds in distance and the surface classification, so none of
          // them may take its own -- see the note in <common>.
          vec3 auroraDPx = dFdx( vWorldPos );
          vec3 auroraDPy = dFdy( vWorldPos );
          mat2 auroraRot = ${ROT};

          // Filled by the two grit fetches below and applied at
          // normal_fragment_begin, which is a different chunk include.
          auroraBump = vec3( 0.0 );

          // How much of this surface's own colour survives the haze, 0..1, and
          // the gate the colour-detail layers hang off. See HAZE_GONE.
          //
          // The USE_FOG guard is not defensive tidiness: createTerrainMaterial is
          // also worn by the preview stages and by MacroTerrain, which may run in
          // a scene with no fog at all. No haze means no licence to simplify, so
          // the fallback is the full-detail answer rather than a cheaper one.
          float auroraSeen = 1.0;
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float auroraHazeF = fogDensity * auroraDist;
              auroraSeen = exp( - auroraHazeF * auroraHazeF );
            #else
              auroraSeen = 1.0 - smoothstep( fogNear, fogFar, auroraDist );
            #endif
          #endif
          float auroraDetailK = smoothstep( ${HAZE_GONE.toFixed(3)}, ${HAZE_FULL.toFixed(3)}, auroraSeen );

          // ---- The macro tile, coarse sample. ONE KILOMETRE PER TILE, and the
          // only fetch every fragment in the world pays for unconditionally.
          //
          // Its fbm ladder runs the whole tile down to a thirty-second of it, so
          // one fetch carries ~1 km regions through ~32 m mottle. Two channels
          // are read: .r is regional value and tint, .a is where the snow line
          // wanders.
          vec2 auroraMU = vWorldPos.xz * ${(1 / MACRO_METRES).toFixed(8)};
          vec4 auroraM = textureGrad( uMacroMap, auroraMU,
            auroraDPx.xz * ${(1 / MACRO_METRES).toFixed(8)},
            auroraDPy.xz * ${(1 / MACRO_METRES).toFixed(8)} );

          // ---- The macro tile, fine sample: ${MACRO_FINE_METRES} m per tile, rotated.
          //
          // FETCHED HERE, ABOVE THE SNOW LINE, because the boundary dither wants
          // its .a and the mid-range tint block below wants its .r and .g. One
          // fetch, two consumers, and hoisting it is what stops the second from
          // being a second fetch.
          //
          // Defaults to the field's own mean when the haze gate is shut, so
          // every consumer of it degrades to "this octave contributes nothing"
          // rather than to a wrong value.
          vec4 auroraMF = vec4( 0.5 );
          if ( auroraDetailK > 0.004 ) {
            auroraMF = textureGrad( uMacroMap, auroraRot * ( vWorldPos.xz * ${(1 / MACRO_FINE_METRES).toFixed(8)} ),
              auroraRot * ( auroraDPx.xz * ${(1 / MACRO_FINE_METRES).toFixed(8)} ),
              auroraRot * ( auroraDPy.xz * ${(1 / MACRO_FINE_METRES).toFixed(8)} ) );
          }

          // ---- Boundary dither.
          //
          // The snow line arrives here as a smooth ramp interpolated across
          // triangles, so wherever it crosses the grid at an angle it steps.
          // Alternating the mesh diagonal (chunk-mesh.js) stops that step being
          // REGULAR, but the boundary is still resolved at vertex spacing --
          // 50 cm at the leaf and far coarser in the LOD rings, which is where
          // it is most visible.
          //
          // Displacing the classification by a world-space field moves the
          // decision off the grid entirely: the border now wanders on the
          // field's wavelengths, which are the same at every LOD and every
          // distance.
          //
          // TWO SAMPLES, and the coarse one is the reason this reads at range.
          // An early version had only ~11 m and ~3 m of wobble, which is plenty
          // standing next to it and useless a kilometre away: 11 m at 2 km
          // subtends about 0.3 degrees, so it averages to a flat tint and what
          // survives is the vertex ramp underneath -- and that ramp is a
          // function of elevation alone, so it draws a level contour line around
          // every distant peak. The 1 km sample is specifically what stopped
          // that, so it is NOT distance-gated: it is the same snow line seen
          // from further away, so it should be the same shape, and up close she
          // is simply standing inside one lobe of it. Physically that is the
          // right variable to jitter anyway -- a real snow line is not level,
          // since aspect, wind loading and shading move it by tens of metres
          // over a few hundred metres of ground.
          //
          // The fine sample is gated, on the haze rather than on a distance:
          // its finest wavelengths are a few metres and subtend a fraction of a
          // pixel from anywhere the gate is shut.
          //
          // Its weight is HANDED UP rather than dropped as it fades. Dropping it
          // would shrink the displacement at range, which is the exact failure
          // the coarse sample exists to fix; renormalising keeps the boundary
          // wandering just as far, on wavelengths the distance can still
          // resolve. With the gate open the arithmetic is the same as the
          // ungated version, term for term.
          float auroraBW = 0.72 + 0.28 * auroraDetailK;
          float auroraBN = 0.5 + ( ( auroraM.a - 0.5 ) * 0.72
                                 + ( auroraMF.a - 0.5 ) * 0.28 * auroraDetailK ) / auroraBW;

          float auroraSnowD = clamp( auroraVertexSnow + ( auroraBN - 0.5 ) * uBoundary, 0.0, 1.0 );
          float auroraSnowBase = smoothstep( 0.25, 0.75, auroraSnowD );
          diffuseColor.rgb = mix( diffuseColor.rgb, uSnow, clamp( auroraSnowBase - auroraVertexSnow, 0.0, 1.0 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, uRock, clamp( auroraVertexSnow - auroraSnowBase, 0.0, 1.0 ) * ( 1.0 - auroraGreenBase ) );

          float auroraRockBase = ( 1.0 - auroraGreenBase ) * ( 1.0 - auroraSnowBase );

          // ---- The region layer: the coarsest colour variation in the world,
          // and UNGATED, on purpose.
          //
          // It runs at every distance because that is the whole job: everything
          // past the near fades used to be flat green or flat grey, and the
          // reason was never that the palette was too simple -- it was that the
          // only thing varying the palette had already faded out. A distance
          // fade would put the flatness back exactly where this exists to
          // remove it.
          //
          // It is also free, which is what changed. It used to be its own
          // auroraNoise call and one of the three that survived the haze gate;
          // now it is two more channels of a fetch the snow line has already
          // paid for, so gating it would save six multiplies and a smoothstep.
          //
          // Three destinations from one field, which is what "browner, darker,
          // greener" is: the value multiply darkens and lifts whole regions, the
          // high end pulls toward uDirt and the low end toward uDeep. Wide
          // thresholds, because a region is either dry or it is lush or it is
          // neither, and a smoothstep that started at the mean would tint every
          // fragment in the world and average back to the base colour -- which
          // is the flat green this is here to break.
          //
          // Snow gets the value swing at half weight (wind scours a drift into
          // bright and dull ground and that reads as snow) and none of the tint
          // (brown snow reads as dirty snow).
          diffuseColor.rgb *= 1.0 + ( auroraM.r - 0.5 ) * uRegionValue * ( 1.0 - auroraSnowBase * 0.5 );
          diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, smoothstep( 0.62, 0.96, auroraM.r ) * auroraGreenBase * uRegionTint );
          diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.38, 0.04, auroraM.r ) * auroraGreenBase * uRegionTint );

          // ---- The mid-range mottle: ~30 m down to ~4 m, off the fine macro
          // sample fetched above the snow line.
          //
          // Gated on the HAZE and not on a distance, and the difference matters.
          // Its job is the same as the region layer's -- keep a hillside from
          // reading as one colour -- so a distance fade would put the flatness
          // back exactly where it exists to remove it. Transmittance is not that
          // gate. At auroraDetailK zero the fog has already replaced this
          // fragment with its own colour to within a few percent, so there is no
          // flatness left to reveal: the layer is not being faded out, it is
          // being skipped where it can no longer change the pixel.
          //
          // These wavelengths were once 110 m and 38 m and got divided by four,
          // because at that size the two tint layers overlapped across most of
          // any hillside you could see and averaged into one muddy middle tone.
          // The variation was there; it was just too coarse to read as variation
          // rather than as the base colour. The coarse end came back later as
          // the region layer above, which is a separate sample rather than a
          // resizing of this one, so the mid-range mottle is untouched and the
          // gap above it is what got filled.
          if ( auroraDetailK > 0.004 ) {
            // Snow gets a fraction of the brightness swing and none of the tint.
            // Blotchy snow reads as dirty snow, and the shading already gives it
            // all the form it needs.
            diffuseColor.rgb *= 1.0 + ( auroraMF.r - 0.5 ) * uMacroValue * ( 1.0 - auroraSnowBase * 0.6 );

            diffuseColor.rgb = mix( diffuseColor.rgb, uDry, smoothstep( 0.58, 0.94, auroraMF.r ) * auroraGreenBase * uMacroTint );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.42, 0.08, auroraMF.r ) * auroraGreenBase * uMacroTint );
            // Rock stains on a DECORRELATED channel of the same fetch, not on
            // the one that just tinted the grass: mineral banding follows the
            // face, not the valley, so it should not track the meadow's dry
            // patches. Free, because the fetch returned it either way.
            diffuseColor.rgb = mix( diffuseColor.rgb, uStain, smoothstep( 0.52, 0.95, auroraMF.g ) * auroraRockBase * uMacroTint * 0.8 );
          }

          float auroraNear = 1.0 - smoothstep( ${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, auroraDist );
          float auroraMicroFade = 1.0 - smoothstep( ${MICRO_NEAR.toFixed(1)}, ${MICRO_FAR.toFixed(1)}, auroraDist );
          // How much of grass's and snow's texture the photographed ground tiles
          // are carrying at this fragment: 1 inside GROUND_NEAR, 0 past
          // GROUND_FAR, and 0 ALWAYS when there is no atlas to sample. The grit
          // layers read it to get out of the way of whatever it is covering, so
          // its default has to be the one that leaves the untextured shader
          // exactly as it was. Overwritten by the ground-tile block below
          // wherever there is an atlas.
          float auroraTileFade = 0.0;
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
          // The derivatives these fetches need were taken at the top of the
          // block, outside every guard -- a derivative is only defined in
          // quad-uniform flow and this guard is not. See auroraStone.
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
            // HOW MUCH OF THIS FRAGMENT THE PHOTOGRAPHS ARE NOT CARRYING. Rock
            // is always 1 -- it has a tile of its own but that one is bedding at
            // 16 m, which says nothing at half a metre. Grass and snow fall to 0
            // inside GROUND_NEAR and come back as their tiles fade out, so the
            // grit below is what the surface reverts TO rather than a layer
            // stacked under a photograph. Clamped because the two
            // classifications are near-exclusive rather than provably so.
            float auroraProc = clamp( 1.0 - auroraTileFade * ( auroraGreenBase + auroraSnowBase ), 0.0, 1.0 );

            // ---- THE GRIT TILE, COARSE SAMPLE: ${GRIT_METRES} m, 4.6 cm texels, NEAREST.
            //
            // This one fetch is what four auroraNoise calls and two auroraGrad
            // calls used to be -- a ~3.5 m patch noise, a ~0.5 m grain, and two
            // octaves of normal relief at ~1.4 m and ~0.45 m. Its baked fbm
            // covers 2.9 m down to 18 cm and its per-texel speckle covers 4.6 cm,
            // which is that whole ladder; its .gb are the slope of the very
            // field its .r colours, so the surface is lit by the thing it is
            // made of instead of by a second, independent noise.
            vec4 auroraG = textureGrad( uGritMap, vWorldPos.xz * ${(1 / GRIT_METRES).toFixed(8)},
              auroraDPx.xz * ${(1 / GRIT_METRES).toFixed(8)},
              auroraDPy.xz * ${(1 / GRIT_METRES).toFixed(8)} );

            // Faded toward the field's own mean rather than toward zero, so the
            // layer leaves the surface where it found it as it goes.
            float auroraGrain = mix( 0.5, auroraG.r, auroraNear );

            // Brightness speckle. Applies to grass, rock and snow alike -- snow
            // without it is a flat white void with no readable surface at all.
            diffuseColor.rgb *= 1.0 + ( auroraGrain - 0.5 ) * uSpeckle * auroraProc;

            // Dirt and moss only show through on green ground, and only close
            // enough to see them -- and only where the meadow tile is not
            // already drawing the soil between the blades, which up close is
            // everywhere. The thresholds mean exactly what they read as: the
            // grit field is rank-equalised, so 0.56..0.88 is the top 44% of
            // texels ramping to the top 12%. See equalise() in grit-texture.js.
            float auroraGreen = auroraGreenBase * auroraNear * ( 1.0 - auroraTileFade );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDirt, smoothstep( 0.56, 0.88, auroraGrain ) * auroraGreen * uDirtAmount );
            diffuseColor.rgb = mix( diffuseColor.rgb, uMoss, smoothstep( 0.44, 0.12, auroraGrain ) * auroraGreen * uMossAmount );

            // ---- Relief, coarse rung. See uRelief.
            //
            // .gb is dh/du in TILE units, so dividing by the tile's size in
            // metres is what turns it into a real slope -- and it is why the two
            // rungs can share one amplitude convention despite being five times
            // apart in size.
            if ( uRelief > 0.0 ) {
              float auroraReliefAmt = auroraNear * uRelief *
                ( auroraRockBase + auroraSnowBase * 0.2 + ( 1.0 - auroraRockBase - auroraSnowBase ) * 0.5 );
              vec2 auroraS = ( auroraG.gb - 0.5 ) * ${(GRIT_GRAD_SCALE / GRIT_METRES).toFixed(6)};
              auroraBump += vec3( -auroraS.x, 0.0, -auroraS.y ) * auroraReliefAmt;
            }

            // ---- THE GRIT TILE, FINE SAMPLE: ${GRIT_FINE_METRES} m, 9 mm texels, rotated.
            //
            // Nested inside the near block because its fade is strictly inside
            // the near fade -- auroraNear is still ~0.72 at MICRO_FAR -- so there
            // is no distance at which this is wanted and the coarse sample is
            // not. It replaces the sparkle, the fleck tint and the 10 cm relief
            // octave, which between them were five auroraNoise calls.
            //
            // It is also what stops the coarse sample reading as a repeating
            // 11.7 m tile underfoot. Rotated ~37 degrees off it for the same
            // reason, and the rotation is why the slope it returns has to be
            // turned BACK before it can be added to a world-space bump: the
            // gradient a rotated fetch reports is in the rotated frame, and the
            // transpose of a rotation is its inverse.
            if ( auroraMicroFade > 0.004 ) {
              vec4 auroraGF = textureGrad( uGritMap, auroraRot * ( vWorldPos.xz * ${(1 / GRIT_FINE_METRES).toFixed(8)} ),
                auroraRot * ( auroraDPx.xz * ${(1 / GRIT_FINE_METRES).toFixed(8)} ),
                auroraRot * ( auroraDPy.xz * ${(1 / GRIT_FINE_METRES).toFixed(8)} ) );

              // ---- Snow glitter.
              //
              // Snow's problem is the opposite of grass's: it is already bright,
              // so darkening it with grain reads as dirt rather than as texture.
              // What real snow gives you at walking distance is individual
              // crystals catching the sun -- isolated points BRIGHTER than the
              // surface, on a surface that is otherwise smooth.
              //
              // So: the fine tile's DECORRELATED channel, thresholded hard so
              // only the top few percent survive, added rather than multiplied.
              // The threshold is what makes it read as discrete points; a smooth
              // version of this is just noise and looks like static. Equalised,
              // so 0.93 is exactly the top 7% of texels rather than whatever a
              // bell curve happened to leave above the line.
              //
              // .a and not .r because .r is quantised to six steps for the
              // pixelated look, and a hard threshold on a staircase either
              // catches a whole tread or none of it.
              diffuseColor.rgb += smoothstep( 0.93, 1.0, auroraGF.a ) * auroraSnowBase * auroraNear * uSnowSparkle;

              // ---- Micro layer: ~4 cm flecks, on every surface, near only.
              //
              // ONE FIELD FEEDING BOTH ENDS OF EACH PAIR: the light fleck sits
              // where it peaks and the dark fleck in the valleys between, which
              // is how the grain layer above already works. The thresholds are
              // tighter than the grain's -- 0.62/0.90 rather than 0.56/0.88 --
              // so this reads as discrete specks scattered over the coarser
              // mottling rather than as a second wash of it. That is the whole
              // difference between "speckled" and "muddy" at this size.
              float auroraMicroN = auroraGF.r;
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

              // ---- Relief, fine rung. Added to the same bump vector rather
              // than applied as a second normalize: two successive normalizes
              // would let the coarse tilt swallow the fine one wherever the
              // coarse tilt is large, which is on rock -- precisely where this
              // rung is meant to be strongest.
              //
              // Nested inside the uRelief guard on purpose: if the headset ever
              // needs the whole normal pass gone, uRelief = 0 must still kill it.
              if ( uRelief > 0.0 && uMicroRelief > 0.0 ) {
                float auroraMicroAmt = auroraMicroFade * uMicroRelief *
                  ( auroraRockBase + ( 1.0 - auroraRockBase ) * 0.5 );
                vec2 auroraMS = ${ROT_T} * ( ( auroraGF.gb - 0.5 ) * ${(GRIT_GRAD_SCALE / GRIT_FINE_METRES).toFixed(6)} );
                auroraBump += vec3( -auroraMS.x, 0.0, -auroraMS.y ) * auroraMicroAmt;
              }
            }
          }
        }`
      )
      // ---- Near-field relief: APPLY ONLY. The slopes were accumulated into
      // auroraBump up in <color_fragment>, by the same two grit fetches that
      // coloured the fragment.
      //
      // That sharing is the entire reason this is cheap now. It used to call
      // auroraGrad three times here -- nine value-noise evaluations, thirty-six
      // integer hashes, on top of the twelve noise calls the colour block had
      // already run -- and it computed its bumps from fields that had nothing
      // to do with the ones doing the colouring, so the surface was lit as
      // though it were made of something other than what it looked like. Now
      // .gb of each grit fetch IS the derivative of the .r that coloured it, so
      // the lighting and the albedo describe the same rock.
      //
      // The ask this exists for was micro variation, "minorly jagged and
      // rocky", for the immediate region only, and it deliberately does NOT go
      // in the height field. The leaf chunk resolves 1.00 m cells, so a seventh
      // detail octave would land at ~0.7 m wavelength, below Nyquist for the
      // mesh that has to carry it: it would alias into a crawling pattern that
      // changes every time a chunk rebuilds, and it would cost five more field
      // evaluations on the collision path, which is already the frame's most
      // expensive query. It would also feed straight into the slope limiter and
      // manufacture exactly the sub-metre refusals that round existed to remove.
      //
      // Perturbing the shading normal instead buys the look with none of that.
      // It is geometry-free, so nothing rebuilds and nothing can block her; it
      // is keyed to world XZ, so it does not rescale across LOD rings; and it
      // rides the same near fades as the colour, so it is gone before it can
      // alias.
      //
      // Placed at normal_fragment_begin, which runs after color_fragment, so
      // auroraBump is already filled. `normal` is in VIEW space at this point,
      // hence the viewMatrix on the perturbation -- as a direction, so
      // translation drops out.
      //
      // No guard on uRelief here: the two blocks that write auroraBump are
      // themselves guarded, so with relief off this is normalize() of an
      // unchanged normal, which is what the chunk just did anyway.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal = normalize( normal + ( viewMatrix * vec4( auroraBump, 0.0 ) ).xyz );`
      )
  }

  // Distinct cache key so this never gets conflated with an unpatched Lambert,
  // and distinct BETWEEN the two variants: whether the atlas was passed changes
  // the compiled source, so the two must never share a program.
  const key = `aurora-terrain-v9${atlas ? '-stone' : ''}`
  material.customProgramCacheKey = () => key

  return material
}
