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
// un-faded, on wavelengths of ~110 m and ~38 m. Those are far larger than a
// pixel from anywhere you can stand, so there is nothing for them to alias
// into; the near grain needs its fade and this does not.
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
          float auroraSnowBase = smoothstep( 0.30, 0.60, vColor.b );
          float auroraRockBase = ( 1.0 - auroraGreenBase ) * ( 1.0 - auroraSnowBase );

          // ---- Macro layer: no distance fade, on purpose. See the note above.
          {
            vec2 auroraM = vWorldPos.xz;
            float auroraM1 = auroraNoise( auroraM * 0.0092 ); // ~110 m regions
            float auroraM2 = auroraNoise( auroraM * 0.026 );  // ~38 m within them
            float auroraMacro = auroraM1 * 0.65 + auroraM2 * 0.35;

            // Snow gets a fraction of the brightness swing and none of the tint.
            // Blotchy snow reads as dirty snow, and the shading already gives it
            // all the form it needs.
            diffuseColor.rgb *= 1.0 + ( auroraMacro - 0.5 ) * uMacroValue * ( 1.0 - auroraSnowBase * 0.6 );

            diffuseColor.rgb = mix( diffuseColor.rgb, uDry, smoothstep( 0.58, 0.94, auroraMacro ) * auroraGreenBase * uMacroTint );
            diffuseColor.rgb = mix( diffuseColor.rgb, uDeep, smoothstep( 0.42, 0.08, auroraMacro ) * auroraGreenBase * uMacroTint );
            // Rock stains on the finer octave alone: mineral banding follows the
            // face, not the valley, so it should not track the 110 m regions.
            diffuseColor.rgb = mix( diffuseColor.rgb, uStain, smoothstep( 0.52, 0.95, auroraM2 ) * auroraRockBase * uMacroTint * 0.8 );
          }

          float auroraNear = 1.0 - smoothstep( ${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, length( vWorldPos - cameraPosition ) );
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
          }
        }`
      )
  }

  // Distinct cache key so this never gets conflated with an unpatched Lambert.
  material.customProgramCacheKey = () => 'aurora-terrain-v2'

  return material
}
