import * as THREE from 'three'

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
// This is a step-2 stand-in. §7's real material (splat blending, height-blend,
// triplanar, KTX2 arrays) replaces it at build step 6.
// ---------------------------------------------------------------------------

// Grain is at full strength inside FADE_NEAR and gone by FADE_FAR.
const FADE_NEAR = 12
const FADE_FAR = 95

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

export function createTerrainMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })

  material.userData.uniforms = {
    uSpeckle: { value: 0.34 }, // +/- brightness swing, applied to every surface
    uDirtAmount: { value: 0.8 },
    uMossAmount: { value: 0.65 },
    uDirt: { value: DIRT },
    uMoss: { value: MOSS },
    uMacroValue: { value: 0.3 }, // +/- brightness swing at every distance
    uMacroTint: { value: 0.55 }, // how far the macro palette pulls the hue
    uDry: { value: DRY },
    uDeep: { value: DEEP },
    uStain: { value: STAIN },
    uSnow: { value: SNOW },
    uRock: { value: ROCK },
    // How far the snow/rock border is allowed to wander from where the vertex
    // colours put it, in units of the classification's own 0..1 range. 0
    // restores the old hard interpolated edge.
    //
    // This was 0.55 when the dither was two short octaves, and 0.55 was not a
    // taste call: half the amplitude had to stay inside the dead zone of the
    // sharpening smoothstep( 0.25, 0.75 ) or the noise reached ground the
    // vertex pass had called unambiguous, and 0.55 sat exactly on that edge.
    // The elevation guard in the shader replaces that constraint with a better
    // one -- it shuts the dither off below the snow country entirely -- so the
    // amplitude is now free to be what the look wants rather than what the
    // valleys could survive. At 1.0 the extreme excursion comes out half white,
    // which is a snow patch stranded below the line, not a dissolved border.
    uBoundary: { value: 1.0 },
    // Near-field normal perturbation, as a tangent (i.e. tan of the tilt it
    // adds). 0 disables the whole block, which is the escape hatch if the Quest
    // turns out to be fill bound: it is the most expensive thing in this shader.
    uRelief: { value: 0.35 },
    // Glitter on snow. Small because it is thresholded to a few percent of
    // fragments -- this is specular sparkle standing in for a spec model Lambert
    // does not have, not a brightness change.
    uSnowSparkle: { value: 0.3 },
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
        uniform vec3 uDry;
        uniform vec3 uDeep;
        uniform vec3 uStain;
        uniform vec3 uSnow;
        uniform vec3 uRock;
        uniform float uBoundary;
        uniform float uRelief;
        uniform float uSnowSparkle;

        // Shared between the colour pass and the normal pass, which are two
        // different chunk includes -- hence file scope rather than a block.
        float auroraNear;
        float auroraRockBase;
        float auroraSnowBase;

        // Hash-based value noise. No sin() -- it is slow on mobile GPUs and its
        // precision on some drivers is bad enough to produce visible banding.
        float auroraHash( vec2 p ) {
          p = fract( p * vec2( 123.34, 456.21 ) );
          p += dot( p, p + 45.32 );
          return fract( p.x * p.y );
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

          // Amplitude guard, and the reason uBoundary can be as large as it
          // is. auroraVertexSnow saturates to zero a little below the snow
          // line and then stays there for the whole rest of the world, so
          // vColor cannot tell a fragment 20 m below the line from one 200 m
          // below it. Un-guarded, an amplitude big enough to matter at range
          // scatters white speckles across the valley floors. World height is
          // the signal vColor threw away.
          //
          // Only the low side needs guarding: above the line the dither can
          // only REMOVE snow, which is wanted and is self-limiting because the
          // classification is already saturated at 1. And this cannot draw a
          // contour of its own -- it is a ramp on the AMPLITUDE OF A NOISE, not
          // on a colour, and it closes in ground that has no snow to argue
          // about either way.
          //
          // 120..165 brackets chunk-mesh.js's own 148..195 ramp from below and
          // has to move with it. It is set off probe-terrain.mjs, not by eye:
          // the world's median is 137 m, so a guard that opened much lower
          // would be wide open across half the map and put stray white flecks
          // on ordinary hillsides. Fully open by 165, where the vertex ramp is
          // a third of the way up and the border actually lives.
          float auroraBand = smoothstep( 120.0, 165.0, vWorldPos.y );
          float auroraSnowD = clamp( auroraVertexSnow + ( auroraBN - 0.5 ) * uBoundary * auroraBand, 0.0, 1.0 );
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
          }

          auroraNear = 1.0 - smoothstep( ${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, length( vWorldPos - cameraPosition ) );
          if ( auroraNear > 0.004 ) {
            vec2 auroraP = vWorldPos.xz;
            // Two scales: ~0.5 m grit for the speed cue, ~3.5 m patches so the
            // ground reads as varied rather than as uniform sandpaper.
            float auroraGrain = auroraNoise( auroraP * 1.9 ) * 0.6 + auroraNoise( auroraP * 0.28 ) * 0.4;
            auroraGrain = mix( 0.5, auroraGrain, auroraNear );

            // Brightness speckle. Applies to grass, rock and snow alike -- snow
            // without it is a flat white void with no readable surface at all.
            diffuseColor.rgb *= 1.0 + ( auroraGrain - 0.5 ) * uSpeckle;

            // Dirt and moss only show through on green ground, and only close
            // enough to see them.
            float auroraGreen = auroraGreenBase * auroraNear;
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
      // Two octaves at ~1.4 m and ~0.45 m, which is the "different octaves" the
      // rock ask wanted -- the coarse one gives a face its lumps and the fine
      // one gives those lumps a surface. Rock gets all of it, snow a fifth (it
      // drapes and smooths, and heavy relief makes it read as gravel), grass
      // the remainder at half strength.
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
          normal = normalize( normal + ( viewMatrix * vec4( auroraBump, 0.0 ) ).xyz );
        }`
      )
  }

  // Distinct cache key so this never gets conflated with an unpatched Lambert.
  material.customProgramCacheKey = () => 'aurora-terrain-v4'

  return material
}
