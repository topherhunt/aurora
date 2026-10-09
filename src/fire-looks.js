import THREE from './three-instance.js'
import { mulberry32 } from './sim/mathx.js'

// ---------------------------------------------------------------------------
// FIRE LOOKS, candidate flames for /test-fire-looks, side by side with the shipped TriFlames. Every look follows TriFlames' cost model (design/37-fire.md): static geometry with per-vertex seeds, all motion a pure function of the clock in the vertex shader, a fragment shader that writes one varying (no texture, no noise, no discard), one InstancedMesh per look whose instance matrix carries the foot (translation) and the radius and height (x and y scale). The CPU writes the matrices once at placement and three uniforms a frame. Only `fans` blends (additive, so no sort); the rest are opaque and keep early depth rejection.
//
// The billboarded looks turn about Y toward `uHead`, which a world caller must set from head-eye.js, not the eye being drawn.
// ---------------------------------------------------------------------------

const HEAD = /* glsl */ `
  uniform highp float uTime;
  uniform vec3 uHead, uHot, uMid, uCool;
  uniform float uGain;
  varying vec3 vColor;
  vec3 ramp( float h ) {
    return mix( mix( uCool, uMid, clamp( h * 2.0, 0.0, 1.0 ) ), uHot, clamp( h * 2.0 - 1.0, 0.0, 1.0 ) );
  }
`

// The instance's foot, radius (sx) and height (sy), a phase hashed from where it stands, and a Y-axis billboard frame toward the head.
const FRAME = /* glsl */ `
    vec3 origin = instanceMatrix[3].xyz;
    float sx = length( instanceMatrix[0].xyz );
    float sy = length( instanceMatrix[1].xyz );
    float ph = fract( sin( dot( origin, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ) * 6.2831853;
    vec3 toHead = uHead - origin;
    vec3 fwd = normalize( vec3( toHead.x, 0.0, toHead.z ) + vec3( 1e-5, 0.0, 0.0 ) );
    vec3 right = vec3( fwd.z, 0.0, -fwd.x );
`

const FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4( vColor, 1.0 );
    #include <colorspace_fragment>
  }
`

// A tongue's width along its length v (0 foot, 1 tip): a teardrop, widest a fifth of the way up, a point at the tip.
const TONGUE = /* glsl */ `
  float widthAt( float v ) { return pow( 1.0 - v, 0.9 ) * ( 0.65 + 1.4 * v * ( 1.0 - v ) ); }
`

// A. Sinuous tongues: ribbons of five segments whose spine carries a wave travelling up it, a bulge pulsing up the width, the whole tongue breathing. Inner tongues are tall and yellow and drawn toward the head so the opaque red rim cannot hide them.
const TONGUES_VERT = HEAD + TONGUE + /* glsl */ `
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    float v = position.x;
    float side = position.y;
    float ring = sqrt( aSeed.x );
    float lat = cos( aSeed.y * 6.2831853 ) * ring;
    highp float t = uTime * ( 0.8 + 0.4 * aSeed.z ) + aSeed.w * 37.0 + ph;
    float tall = sy * mix( 1.0, 0.5, ring ) * ( 0.75 + 0.25 * aSeed.z ) * ( 0.88 + 0.12 * sin( t * 2.3 ) + 0.08 * sin( t * 5.7 + 1.0 ) );
    vec2 swirl = vec2( sin( v * 4.0 - t * 6.0 ), cos( v * 3.3 - t * 5.0 + 1.7 ) ) * 0.35 * sx * pow( v, 1.3 );
    float w = sx * mix( 0.42, 0.22, ring ) * widthAt( v ) * ( 1.0 + 0.3 * sin( v * 7.0 - t * 8.0 ) );
    vec3 p = origin + right * ( lat * 0.8 * sx + swirl.x + side * w ) + fwd * ( ( 0.5 - ring ) * 0.6 * sx + swirl.y * 0.3 ) + vec3( 0.0, v * tall, 0.0 );
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( ( 1.0 - v ) * ( 1.0 - 0.55 * ring ) + 0.1 ) * uGain;
  }
`

// A2. Tongue lives: A's ribbons with twice the flicker, bend and pulse, and eight segments so the faster bend stays smooth, each living a cycle. It grows from a stub to taller than A's, then its foot lifts off and it rises, shortening into a lens-shaped blob that cools and shrinks to nothing. Each life re-rolls where the tongue stands.
const TONGUE_LIVES_VERT = HEAD + TONGUE + /* glsl */ `
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    float v = position.x;
    float side = position.y;
    highp float clock = uTime * 0.55 * ( 0.8 + 0.4 * aSeed.z ) + aSeed.w;
    float u = fract( clock );
    float cyc = floor( clock );
    float ring = sqrt( fract( aSeed.x + cyc * 0.381966 ) );
    float lat = cos( ( aSeed.y + cyc * 0.618034 ) * 6.2831853 ) * ring;
    highp float t = uTime * ( 0.8 + 0.4 * aSeed.z ) + aSeed.w * 37.0 + ph;
    float grow = smoothstep( 0.0, 0.55, u );
    float fly = smoothstep( 0.45, 1.0, u );
    float big = sy * mix( 1.0, 0.55, ring ) * ( 0.75 + 0.25 * aSeed.z );
    float tall = big * mix( 0.3, 1.15, grow ) * mix( 1.0, 0.25, fly ) * ( 1.0 + 0.18 * sin( t * 5.0 ) + 0.12 * sin( t * 12.5 + 1.0 ) );
    vec2 swirl = vec2( sin( v * 6.0 - t * 13.0 ), cos( v * 5.0 - t * 11.0 + 1.7 ) ) * 0.42 * sx * pow( v, 1.2 ) * mix( 1.0, 0.5, fly );
    float shape = mix( widthAt( v ), sin( 3.14159 * v ), fly );
    float w = sx * mix( 0.42, 0.22, ring ) * shape * ( 1.0 + 0.35 * sin( v * 10.0 - t * 17.0 ) ) * mix( 0.6, 1.15, grow ) * pow( 1.0 - fly, 0.6 );
    vec3 p = origin + right * ( lat * 0.8 * sx + swirl.x + side * w ) + fwd * ( ( 0.5 - ring ) * 0.6 * sx + swirl.y * 0.3 ) + vec3( 0.0, big * fly * 1.1 + v * tall, 0.0 );
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( ( 1.0 - v ) * ( 1.0 - 0.5 * ring ) * ( 1.0 - 0.7 * fly ) + 0.1 ) * uGain;
  }
`

// B. Tear-off tongues: each tongue is five loose quads. It is born small, grows into a licking tongue, then lifts away and its segments part, tumble and shrink to nothing from the tip down, so the top of the fire breaks up into flakes. Neighbouring segments overlap a little so an attached tongue shows no seam. Each life re-rolls where the tongue stands.
const TEAR_VERT = HEAD + TONGUE + /* glsl */ `
  attribute vec4 aSeed;
  #define SEGS 5.0
  vec2 spineAt( float v, float t, float sx ) { return vec2( sin( v * 3.5 - t * 5.0 ), cos( v * 2.9 - t * 4.2 + 1.3 ) ) * 0.3 * sx * pow( v, 1.3 ); }
  void main() {
    ${FRAME}
    float j = position.x;
    float top = position.y;
    float side = position.z;
    highp float clock = uTime * 0.7 * ( 0.75 + 0.5 * aSeed.z ) + aSeed.w;
    float u = fract( clock );
    float cyc = floor( clock );
    float ring = sqrt( fract( aSeed.x + cyc * 0.381966 ) );
    float lat = cos( ( aSeed.y + cyc * 0.618034 ) * 6.2831853 ) * ring;
    highp float t = uTime + aSeed.w * 23.0 + ph;
    float grow = smoothstep( 0.0, 0.35, u );
    float tear = smoothstep( 0.5, 1.0, u );
    float H = sy * mix( 1.0, 0.55, ring ) * ( 0.7 + 0.3 * aSeed.z ) * mix( 0.2, 1.0, grow );
    float W = sx * mix( 0.32, 0.18, ring );
    float v = ( j + top * 1.15 - 0.075 ) / SEGS;
    float vc = ( j + 0.5 ) / SEGS;
    float vanish = 1.0 - 0.6 * vc;
    float keep = 1.0 - smoothstep( vanish - 0.35, vanish, tear );
    vec2 sv = spineAt( v, t, sx );
    vec2 sc = spineAt( vc, t, sx );
    vec3 pv = vec3( sv.x + side * W * widthAt( clamp( v, 0.0, 1.0 ) ), v * H, sv.y );
    vec3 pc = vec3( sc.x, vc * H, sc.y );
    float spin = tear * ( aSeed.z - 0.5 + 0.3 * sin( j * 2.3 ) ) * 6.0;
    vec2 d = ( pv - pc ).xy * keep;
    d = vec2( d.x * cos( spin ) - d.y * sin( spin ), d.x * sin( spin ) + d.y * cos( spin ) );
    vec3 q = pc + vec3( d, ( pv - pc ).z ) + vec3( 0.0, tear * H * ( 0.35 + 0.25 * j ), 0.0 );
    vec3 p = origin + right * ( lat * 0.75 * sx + q.x ) + fwd * ( ( 0.5 - ring ) * 0.6 * sx + q.z * 0.3 ) + vec3( 0.0, q.y, 0.0 );
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( ( 1.0 - v ) * ( 1.0 - 0.5 * ring ) * ( 1.0 - 0.6 * tear ) + 0.1 ) * uGain;
  }
`

// C. Faceted lathe: three real 3D bodies (seven sides, a teardrop profile) whose rings twist, swell in pulses that run upward and lean along a travelling wave. Colour is how squarely a vertex faces the head: the middle of the body burns yellow, the silhouette red, so it reads as a glowing volume from any side with true per-eye parallax.
const LATHE_VERT = HEAD + /* glsl */ `
  void main() {
    ${FRAME}
    float v = position.x;
    float a0 = position.y * 6.2831853;
    float b = position.z;
    float bScale = b < 0.5 ? 1.0 : ( b < 1.5 ? 0.62 : 0.5 );
    float bAng = ph + b * 2.4;
    vec2 bOff = b < 0.5 ? vec2( 0.0 ) : vec2( cos( bAng ), sin( bAng ) ) * 0.5 * sx;
    highp float t = uTime + b * 1.7 + ph;
    float H = sy * bScale * ( 1.0 + 0.1 * sin( t * 6.0 ) + 0.07 * sin( t * 11.0 + 1.0 ) );
    float a = a0 + t * 1.2 * v;
    float r = 0.5 * sx * bScale * sin( 3.14159 * ( 0.2 + 0.8 * v ) ) * pow( 1.0 - v, 0.5 ) * ( 1.0 + 0.18 * sin( v * 6.0 - t * 8.0 + a0 * 2.0 ) );
    vec2 spine = vec2( sin( v * 3.0 - t * 5.0 ), cos( v * 2.6 - t * 4.3 + 1.0 ) ) * 0.35 * sx * bScale * pow( v, 1.3 );
    vec3 radial = vec3( cos( a ), 0.0, sin( a ) );
    vec3 p = origin + vec3( bOff.x + spine.x, v * H, bOff.y + spine.y ) + radial * r;
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    float facing = clamp( dot( radial, normalize( uHead - p ) ), 0.0, 1.0 );
    vColor = ramp( facing * ( 1.0 - 0.75 * pow( v, 1.5 ) ) * ( b < 0.5 ? 1.0 : 0.8 ) ) * uGain;
  }
`

// D. Soft fans: rising puffs, each a six-triangle hexagon whose centre vertex carries the colour and whose rim is black, so the interpolation is the soft falloff a sprite texture would give. Additive: where puffs overlap the fire runs hot toward white. The cost is overdraw, so the puffs are few and large.
const FANS_VERT = HEAD + /* glsl */ `
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    highp float clock = uTime * 0.9 + aSeed.x;
    float u = fract( clock );
    float cyc = floor( clock );
    float ang = ( aSeed.z + cyc * 0.618034 ) * 6.2831853;
    float rad = sqrt( fract( aSeed.y + cyc * 0.381966 ) ) * 0.7 * sx * ( 1.0 - 0.6 * u );
    float h = u * sy * ( 0.7 + 0.5 * aSeed.w );
    float wob = 0.3 * sx * u * sin( uTime * 4.0 + aSeed.z * 40.0 );
    vec3 c = origin + vec3( cos( ang ) * rad + wob, h, sin( ang ) * rad );
    float s = sx * 0.55 * ( 0.6 + 0.6 * aSeed.w ) * smoothstep( 0.0, 0.15, u ) * ( 1.0 - 0.6 * u );
    vec3 f3 = normalize( uHead - c );
    vec3 r3 = normalize( cross( vec3( 0.0, 1.0, 0.0 ), f3 ) );
    vec3 u3 = cross( f3, r3 );
    float k = position.x;
    float ca = ( k - 1.0 ) / 6.0 * 6.2831853 + aSeed.z * 3.0;
    vec2 o = k < 0.5 ? vec2( 0.0 ) : vec2( cos( ca ), sin( ca ) ) * s;
    vec3 p = c + r3 * o.x + u3 * o.y * 1.25;
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = k < 0.5 ? ramp( 1.0 - u ) * uGain * 0.45 * ( 1.0 - u ) * smoothstep( 0.0, 0.1, u ) : vec3( 0.0 );
  }
`

// F. Opaque diamonds: D's rising puffs drawn as solid two-triangle diamonds, stretched upright with corners re-jittered every life and the top tip swaying. Hot at the foot, cooling as they rise; younger diamonds are drawn toward the head so the hot core stays on top. Opaque, so no overdraw penalty.
const DIAMONDS_VERT = HEAD + /* glsl */ `
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    highp float clock = uTime * 1.1 + aSeed.x;
    float u = fract( clock );
    float cyc = floor( clock );
    float ang = ( aSeed.z + cyc * 0.618034 ) * 6.2831853;
    float rad = sqrt( fract( aSeed.y + cyc * 0.381966 ) ) * 0.65 * sx * ( 1.0 - 0.7 * u );
    float h = u * sy * ( 0.75 + 0.45 * aSeed.w );
    float wob = 0.25 * sx * u * sin( uTime * 5.0 + aSeed.z * 40.0 );
    vec3 c = origin + vec3( cos( ang ) * rad + wob, h, sin( ang ) * rad );
    float s = sx * 0.38 * ( 0.7 + 0.6 * aSeed.w ) * smoothstep( 0.0, 0.12, u ) * pow( 1.0 - u, 0.8 );
    float j1 = fract( aSeed.w * 7.3 + cyc * 0.7548777 );
    float j2 = fract( aSeed.x * 5.1 + cyc * 0.5698403 );
    float k = position.x;
    vec2 o = k < 0.5 ? vec2( ( j1 - 0.5 ) * 0.5 + 0.3 * sin( uTime * 6.0 + aSeed.y * 30.0 ), 1.6 + 0.8 * j2 )
      : k < 1.5 ? vec2( 0.55 + 0.3 * j2, ( j1 - 0.5 ) * 0.4 )
      : k < 2.5 ? vec2( ( j2 - 0.5 ) * 0.3, -0.7 - 0.3 * j1 )
      : vec2( -0.55 - 0.3 * j1, ( j2 - 0.5 ) * 0.4 );
    vec3 p = c + ( right * o.x + vec3( 0.0, o.y, 0.0 ) ) * s + fwd * ( ( 0.5 - u ) * 0.3 * sx );
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( 1.0 - 1.1 * u + ( aSeed.w - 0.5 ) * 0.2 ) * uGain;
  }
`

// E. Cel layers: three nested flat silhouettes (red, orange, yellow), each a fan of sixteen outline points on a teardrop, the inner ones stepped toward the head. Bumps run up both sides of each outline to the tip, so tongues lick upward; the tip jumps and the top sways. The cartoon campfire.
const CEL_VERT = HEAD + /* glsl */ `
  #define M 16.0
  void main() {
    ${FRAME}
    float i = position.x;
    float L = position.y;
    float scl = 1.0 - 0.3 * L;
    highp float t = uTime + L * 2.1 + ph;
    float D = 0.3 * sy * scl;
    float U = sy * scl - D;
    float W = 0.85 * sx * scl;
    vec2 q = vec2( 0.0 );
    if ( i >= 0.0 ) {
      float th = i / M * 6.2831853;
      float tip = 1.0 + 0.15 * sin( t * 6.0 ) + 0.1 * sin( t * 10.7 + 1.0 );
      float cy = cos( th );
      q = vec2( W * sin( th ) * sin( th * 0.5 ), cy > 0.0 ? cy * U * tip : cy * D );
      float a = th < 3.14159 ? th : 6.2831853 - th;
      float side = th < 3.14159 ? 0.0 : 1.7;
      float bump = pow( 0.5 + 0.5 * sin( a * 6.0 + t * 7.0 + side ), 3.0 ) * smoothstep( 2.6, 0.5, a ) * 0.6 * W;
      q += normalize( vec2( sin( th ), 1.6 ) ) * bump;
    }
    q.x += 0.25 * sx * pow( max( q.y, 0.0 ) / sy, 2.0 ) * sin( t * 1.7 );
    vec3 p = origin + right * q.x + vec3( 0.0, D + q.y, 0.0 ) + fwd * ( ( L * 0.04 + 0.01 ) * sx );
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( 0.18 + 0.41 * L ) * uGain * ( i < 0.0 ? 1.1 : 1.0 );
  }
`

// G. Core and sparks, for lamps and candles: three nested opaque kites (red outside, yellow inside, inner ones stepped toward the head) whose tip sways, jumps and breathes; three licks that break off the tip and rise; eight small sparks climbing well above it. Diamond k is a core layer below 3, a lick below 6, a spark after.
const CORE_VERT = HEAD + /* glsl */ `
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    float k = position.y;
    float corner = position.x;
    highp float t = uTime + ph * 3.0;
    vec2 sway = vec2( sin( t * 3.1 ) + 0.5 * sin( t * 7.3 + 1.0 ), cos( t * 2.7 + 0.4 ) + 0.5 * sin( t * 6.1 ) ) * 0.67;
    float jump = 0.88 + 0.08 * sin( t * 11.0 ) + 0.06 * sin( t * 23.0 + 2.0 ) + 0.1 * pow( 0.5 + 0.5 * sin( t * 4.3 ), 6.0 );
    vec3 tip = origin + vec3( sway.x * 0.5 * sx, sy * jump, sway.y * 0.5 * sx );
    vec3 p;
    float heat;
    if ( k < 2.5 ) {
      float sc = 1.0 - 0.27 * k;
      float H = sy * jump * sc;
      float W = sx * 0.7 * sc * ( 1.0 + 0.1 * sin( t * 9.0 + k * 2.0 ) );
      float lean = sway.x * 0.5 * sx * ( 1.0 - 0.3 * k ) + 0.12 * sx * k * sin( t * 5.3 + k * 2.0 );
      vec2 o = corner < 0.5 ? vec2( lean, H )
        : corner < 1.5 ? vec2( W * ( 1.0 + 0.15 * sin( t * 13.0 + k ) ) + sway.x * 0.12 * sx, H * 0.28 )
        : corner < 2.5 ? vec2( 0.0, -0.06 * sy + 0.05 * sy * k )
        : vec2( -W * ( 1.0 + 0.15 * sin( t * 12.0 + k * 3.0 ) ) + sway.x * 0.12 * sx, H * 0.3 );
      p = origin + right * o.x + vec3( 0.0, o.y, 0.0 ) + fwd * ( k * 0.18 * sx + ( corner < 0.5 ? sway.y * 0.5 * sx : 0.0 ) );
      heat = 0.3 + 0.38 * k - ( corner < 0.5 ? 0.22 : 0.0 );
    } else {
      bool lick = k < 5.5;
      highp float clock = uTime * ( lick ? 1.7 : 0.6 + 0.4 * aSeed.x ) + aSeed.y * 7.0;
      float u = fract( clock );
      float cyc = floor( clock );
      float on = step( fract( aSeed.z * 13.1 + cyc * 0.618034 ), lick ? 0.6 : 0.4 );
      vec2 drift = vec2( sin( u * 6.0 + aSeed.w * 30.0 ), cos( u * 5.0 + aSeed.z * 30.0 ) ) * sx * u * ( lick ? 0.4 : 1.5 );
      vec3 c = tip + vec3( drift.x, sy * u * ( lick ? 0.6 : 1.4 + aSeed.x ) - ( lick ? 0.2 * sy : 0.0 ), drift.y );
      float s = ( lick ? sx * 0.45 * smoothstep( 0.0, 0.15, u ) : sy * 0.03 ) * ( 1.0 - u ) * on;
      vec2 o = corner < 0.5 ? vec2( 0.0, lick ? 1.4 : 1.6 ) : corner < 1.5 ? vec2( 0.5, 0.0 ) : corner < 2.5 ? vec2( 0.0, -0.9 ) : vec2( -0.5, 0.0 );
      p = c + ( right * o.x + vec3( 0.0, o.y, 0.0 ) ) * s + fwd * ( lick ? -0.1 * sx : 0.0 );
      heat = lick ? 0.55 - 0.6 * u : 1.0 - 0.7 * u;
    }
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( heat ) * uGain * ( k > 5.5 ? 1.3 : 1.0 );
  }
`

// Sparks: two-triangle diamonds, stretched upright, a third of them alive in any one life, rising fast on a curling path and shrinking out. An overlay any look can take.
const SPARKS_VERT = HEAD + /* glsl */ `
  uniform float uSparkSize;
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    highp float clock = uTime * ( 0.5 + 0.5 * aSeed.x ) + aSeed.y * 7.0;
    float u = fract( clock );
    float cyc = floor( clock );
    float on = step( fract( aSeed.z * 13.1 + cyc * 0.618034 ), 0.3 );
    float ang = ( aSeed.w + cyc * 0.381966 ) * 6.2831853;
    vec2 foot = vec2( cos( ang ), sin( ang ) ) * 0.4 * sx * sqrt( fract( aSeed.z + cyc * 0.7548777 ) );
    float h = sy * ( 0.35 + 1.5 * u * ( 0.6 + 0.4 * aSeed.x ) );
    vec2 drift = vec2( sin( u * 7.0 + aSeed.y * 30.0 ), cos( u * 5.0 + aSeed.w * 30.0 ) ) * 0.5 * sx * u;
    vec3 c = origin + vec3( foot.x + drift.x, h, foot.y + drift.y );
    float s = sy * 0.03 * uSparkSize * ( 1.0 - u ) * on;
    float k = position.x;
    vec2 o = k < 0.5 ? vec2( 0.0, 1.6 ) : k < 1.5 ? vec2( 0.5, 0.0 ) : k < 2.5 ? vec2( 0.0, -1.0 ) : vec2( -0.5, 0.0 );
    vec3 p = c + ( right * o.x + vec3( 0.0, o.y, 0.0 ) ) * s;
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
    vColor = ramp( 1.0 - 0.7 * u ) * uGain * 1.3;
  }
`

function geometry(positions, index, seeds) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.flat()), 3))
  if (seeds) g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(seeds.flat()), 4))
  g.setIndex(index)
  return g
}

const seed4 = (rand) => [rand(), rand(), rand(), rand()]

function tonguesGeometry(tongues = 9, segs = 5, rand = mulberry32(7)) {
  const pos = [], seeds = [], index = []
  for (let k = 0; k < tongues; k++) {
    const s = seed4(rand), base = pos.length
    for (let j = 0; j < segs; j++) pos.push([j / segs, -1, k], [j / segs, 1, k])
    pos.push([1, 0, k])
    for (let j = 0; j < segs - 1; j++) {
      const a = base + 2 * j
      index.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
    index.push(base + 2 * (segs - 1), base + 2 * (segs - 1) + 1, base + 2 * segs)
    while (seeds.length < pos.length) seeds.push(s)
  }
  return geometry(pos, index, seeds)
}

function tearGeometry(tongues = 10, segs = 5, rand = mulberry32(8)) {
  const pos = [], seeds = [], index = []
  for (let k = 0; k < tongues; k++) {
    const s = seed4(rand)
    for (let j = 0; j < segs; j++) {
      const a = pos.length
      pos.push([j, 0, -1], [j, 0, 1], [j, 1, -1], [j, 1, 1])
      index.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
    while (seeds.length < pos.length) seeds.push(s)
  }
  return geometry(pos, index, seeds)
}

function latheGeometry(sides = 7, rings = 6, bodies = 3) {
  const pos = [], index = []
  for (let b = 0; b < bodies; b++) {
    const base = pos.length
    for (let k = 0; k < rings; k++) for (let s = 0; s < sides; s++) pos.push([k / (rings - 1), s / sides, b])
    const at = (k, s) => base + k * sides + (s % sides)
    for (let k = 0; k < rings - 1; k++) {
      for (let s = 0; s < sides; s++) {
        if (k === rings - 2) index.push(at(k, s), at(k, s + 1), at(k + 1, s))
        else index.push(at(k, s), at(k, s + 1), at(k + 1, s + 1), at(k, s), at(k + 1, s + 1), at(k + 1, s))
      }
    }
  }
  return geometry(pos, index)
}

function fansGeometry(puffs = 36, rand = mulberry32(9)) {
  const pos = [], seeds = [], index = []
  for (let k = 0; k < puffs; k++) {
    const s = seed4(rand), base = pos.length
    for (let c = 0; c <= 6; c++) pos.push([c, k, 0])
    for (let c = 1; c <= 6; c++) index.push(base, base + c, base + (c % 6) + 1)
    while (seeds.length < pos.length) seeds.push(s)
  }
  return geometry(pos, index, seeds)
}

function celGeometry(points = 16, layers = 3) {
  const pos = [], index = []
  for (let L = 0; L < layers; L++) {
    const base = pos.length
    pos.push([-1, L, 0])
    for (let i = 0; i < points; i++) pos.push([i, L, 0])
    for (let i = 0; i < points; i++) index.push(base, base + 1 + i, base + 1 + ((i + 1) % points))
  }
  return geometry(pos, index)
}

function diamondGeometry(sparks, rand) {
  const pos = [], seeds = [], index = []
  for (let k = 0; k < sparks; k++) {
    const s = seed4(rand), base = pos.length
    for (let c = 0; c < 4; c++) pos.push([c, k, 0])
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
    while (seeds.length < pos.length) seeds.push(s)
  }
  return geometry(pos, index, seeds)
}

export const LOOKS = {
  tongues: { name: 'A. sinuous tongues', blurb: 'nine ribbons licking upward on a travelling wave', vert: TONGUES_VERT, geometry: tonguesGeometry },
  lives: { name: 'A2. lifecycle tongues', blurb: 'twelve faster, bendier tongues that grow, then float up, shrink and vanish', vert: TONGUE_LIVES_VERT, geometry: () => tonguesGeometry(12, 8, mulberry32(11)) },
  tear: { name: 'B. tear-off tongues', blurb: 'tongues grow, lift away and break into shrinking flakes', vert: TEAR_VERT, geometry: tearGeometry },
  lathe: { name: 'C. faceted lathe', blurb: 'three twisting 3D bodies, yellow where they face you, red at the rim', vert: LATHE_VERT, geometry: latheGeometry },
  fans: { name: 'D. soft fans', blurb: 'additive vertex-colour puffs: soft edges with no texture', vert: FANS_VERT, geometry: fansGeometry, additive: true },
  diamonds: { name: 'F. opaque diamonds', blurb: 'soft fans as solid jittered diamonds, two triangles each, hot to cool as they rise', vert: DIAMONDS_VERT, geometry: () => diamondGeometry(56, mulberry32(12)) },
  core: { name: 'G. core + sparks', blurb: 'lamps and candles: one dancing core of three nested kites, licks breaking off its tip, small sparks rising', vert: CORE_VERT, geometry: () => diamondGeometry(14, mulberry32(13)) },
  cel: { name: 'E. cel layers', blurb: 'three nested cartoon silhouettes, tongues running up their edges', vert: CEL_VERT, geometry: celGeometry },
  sparks: { name: 'sparks', blurb: 'two-triangle sparks, an overlay for any look', vert: SPARKS_VERT, geometry: () => diamondGeometry(24, mulberry32(10)) },
}

/** One look's flames: an InstancedMesh of `capacity`, sharing `uniforms` (uTime, uHead, uHot, uMid, uCool, uGain, uSparkSize) with the other looks. */
export class LookFlames {
  constructor(key, capacity, uniforms) {
    const look = LOOKS[key]
    if (!look) throw new Error(`LookFlames: no look ${key}`)
    this.key = key
    const geo = look.geometry()
    this.trianglesPer = geo.index.count / 3
    const material = new THREE.ShaderMaterial({
      vertexShader: look.vert,
      fragmentShader: FRAG,
      uniforms,
      side: THREE.DoubleSide,
      fog: false,
      ...(look.additive ? { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } : {}),
    })
    this.mesh = new THREE.InstancedMesh(geo, material, capacity)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this._m = new THREE.Matrix4()
  }

  /** Place flame `i` with its foot at (x, y, z), `height` and foot `radius` in metres. */
  place(i, x, y, z, height, radius) {
    this.mesh.setMatrixAt(i, this._m.makeScale(radius, height, radius).setPosition(x, y, z))
    this.mesh.count = Math.max(this.mesh.count, i + 1)
    this.mesh.instanceMatrix.needsUpdate = true
  }

  clear() { this.mesh.count = 0 }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}

/** The uniforms every look shares; the colours default to TriFlames' campfire ramp. */
export function lookUniforms({ hot = [1, 0.85, 0.3], mid = [1, 0.4, 0.04], cool = [0.55, 0.06, 0], gain = 1.3, sparkSize = 1 } = {}) {
  return {
    uTime: { value: 0 },
    uHead: { value: new THREE.Vector3() },
    uHot: { value: new THREE.Color().setRGB(...hot) },
    uMid: { value: new THREE.Color().setRGB(...mid) },
    uCool: { value: new THREE.Color().setRGB(...cool) },
    uGain: { value: gain },
    uSparkSize: { value: sparkSize },
  }
}
