// ---------------------------------------------------------------------------
// Colour.
//
// ===========================================================================
// THE PHYSICAL RAMP, WHICH IS NOT A STYLE CHOICE
// ===========================================================================
//
// An aurora's colour is a function of ALTITUDE and of nothing else. Not of
// brightness, not of time, not of noise. Solar-wind electrons stop at a depth
// set by their energy, and the atoms they hit emit at fixed wavelengths on the
// way back down:
//
//   557.7 nm  atomic oxygen, green            100-150 km   the dominant line
//   630.0 nm  atomic oxygen, red              above ~200 km, deep and diffuse
//   428/470   ionised nitrogen, blue-violet    80-100 km   the pink/purple hem
//
// That single fact does most of the work of making a procedural aurora look
// real rather than like a green ribbon, and it is why `emissionRamp` takes a
// height and no other argument. Every attempt to key aurora colour off
// intensity produces the same tell: the bright parts go yellow-white and the
// whole thing reads as fire.
//
// TWO KNOBS, AND BOTH ARE RATIOS BETWEEN THOSE THREE LINES rather than free
// hue choices, which is what keeps the whole reachable range plausible:
//
//   pale  -- how hard the precipitation is. Harder electrons excite the N2 band
//     systems alongside the atomic lines, which whitens 557.7 green toward mint
//     and pulls the hem from N2+ violet toward its own 427.8 nm electric blue.
//     At 0 this is the classic green-and-violet; at 1 the pale alien green with
//     a blue base.
//   crown -- how much soft 630.0 nm sits on top. The target is magenta rather
//     than pure red, because that is what the eye and the camera actually get:
//     630.0 arriving through the same column as the 427.8 underneath it. This
//     is the "purple curtain above the green one" of the photographs.
//
// ===========================================================================
// AND THEN THE PART THAT IS A STYLE CHOICE, DECLARED AS ONE
// ===========================================================================
//
// This world's aurora is not only a physical aurora -- it is a magic one, and
// the brief is neon flowing through magnetic leylines. So there is a second
// ramp, `neonRamp`, and it is honest about being invented: a cosine palette
// driven by the ALONG-CHANNEL flow coordinate, so hue travels down a channel
// instead of sitting at an altitude.
//
// They are exposed as a mix rather than as a switch. The interesting sky is
// almost always somewhere between the two -- a physically-coloured curtain with
// a hue that breathes along its length reads as a real aurora doing something
// impossible, which is the target, whereas full neon reads as a screensaver and
// full physics reads as the photograph everyone has already seen.
//
// The cosine palette is Inigo Quilez's `a + b*cos(TAU*(c*t + d))` form. It is
// used here rather than a gradient texture for one practical reason: a texture
// would have to be authored, and the whole point of the lab is that a hue
// family is three sliders you can drag while looking at the sky.
//
// ===========================================================================
// WHY THE RAMP TAKES A NORMALISED HEIGHT AND NOT KILOMETRES
// ===========================================================================
//
// The lab's altitude range is two draggable numbers. If the colour transitions
// were written in kilometres they would drift out of the range the moment you
// moved either one, and the sky would go uniformly green with no visible cause
// and no obvious culprit. So the transitions are fractions of whatever range is
// currently set, and the km figures above survive as the DEFAULTS those
// fractions were chosen to reproduce: over 90..260 km, `hemBand` 0.12 puts the
// violet-to-green crossover at 110 km and `crownStart` 0.42 starts the red at
// 161 km.
// ---------------------------------------------------------------------------

// Depends on UTIL_GLSL (TAU, sat).
export const PALETTE_GLSL = `
  #ifndef AURLAB_PALETTE
  #define AURLAB_PALETTE

  vec3 emissionRamp( float h01 ) {
    vec3 violet = mix( vec3( 0.62, 0.18, 0.72 ),   // N2+ 428 nm
                       vec3( 0.18, 0.60, 1.00 ),   // N2+ 427.8, electric blue
                       u_pale );
    vec3 green  = mix( vec3( 0.14, 1.00, 0.44 ),   // OI 557.7 nm
                       vec3( 0.56, 1.00, 0.84 ),   // whitened by the N2 bands
                       u_pale );

    vec3 c = mix( violet, green, smoothstep( 0.0, max( u_hemBand, 1e-3 ), h01 ) );

    // Clamped below 1.0 on purpose: at full crown the green must still show
    // through the red rather than being replaced by it, because the two are
    // emitted along the same line of sight and what reaches the eye is a sum.
    c = mix( c, vec3( 1.00, 0.20, 0.46 ),          // OI 630.0 over the blue hem
             clamp( smoothstep( u_crownStart, 1.0, h01 ) * u_crown, 0.0, 0.95 ) );
    return c;
  }

  vec3 neonRamp( float x ) {
    // The 0, 1/3, 2/3 phase offsets are what make this a HUE sweep rather than
    // a brightness sweep: three cosines a third of a cycle apart trace the RGB
    // cube's colour hexagon. Scaling them by u_neonSpread narrows the sweep
    // toward a duotone, which is where most of the good-looking settings are.
    vec3 phase = vec3( 0.0, 0.3333, 0.6667 ) * u_neonSpread;
    return 0.5 + 0.5 * cos( TAU * ( phase + x + u_neonShift ) );
  }

  // h01  -- height up the emitting layer, 0 at the hem and 1 at the top
  // flow -- the along-channel coordinate, so hue can travel down a channel
  vec3 auroraColour( float h01, float flow ) {
    vec3 c = mix( emissionRamp( h01 ), neonRamp( flow ), u_neon );
    c = mix( c, u_tint, u_tintAmt );

    // Saturation last, and around Rec. 709 luma rather than around the mean,
    // so pushing it does not also change how bright the sky reads. Desaturating
    // is as useful as saturating here: a real aurora is far less saturated than
    // any photograph of one, because a long exposure is doing the work the eye
    // cannot.
    float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
    return max( mix( vec3( l ), c, u_saturate ), 0.0 );
  }

  #endif
`
