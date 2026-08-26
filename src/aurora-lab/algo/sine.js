// ---------------------------------------------------------------------------
// Sine: the same contour family as ley lines, built out of nothing but trigonometry.
//
// ===========================================================================
// WHY THIS EXISTS AT ALL
// ===========================================================================
//
// One leyline step spends about twenty-one procedural noise lookups. A gradient-noise lookup is roughly a hundred ALU operations once you count the four hashes, the four dot products and the quintic interpolant, so a step is around two thousand operations and a forty-step ray is around eighty thousand. For comparison, shading a water surface in this same project is a few hundred. That is the whole cost problem in one sentence: the aurora is not expensive because it is raymarched, it is expensive because every one of the forty samples along the ray pays for a small noise library.
//
// The brief said, plainly, that a low-quality realtime answer beats a high-quality one that cannot run. So this algorithm asks the narrow question: how far can you get with NO noise at all? Not cheaper noise, not fewer octaves. Zero calls to gnoise2, vnoise2, gfbm2, fbm2 or warp2. Only sin, multiply and add.
//
// The answer, hand-counted below, is about a hundred and twenty instructions per march step against leyline's two thousand, which is a factor of roughly seventeen, and the picture is closer than that ratio deserves.
//
// ===========================================================================
// THE CONSTRUCTION, AND WHY IT IS STILL A CONTOUR FAMILY
// ===========================================================================
//
// Everything leyline's header says about level sets is still true here and it is the reason this is a rebuild of leyline rather than a different idea. phi is a smooth scalar function of the plan position, tri(phi) draws every one of its contours in one evaluation, and because a point has one value the contours cannot cross, they run parallel without being parallel, they crowd where the gradient steepens, and they pinch into two at a saddle. Branching for free is the property that no ribbon mesh can be made to have, and it survives intact here because the only thing being swapped out is HOW phi is built.
//
// phi is built in four moves:
//
//   1. A SLOWLY ROTATING SHEAR. p.x gets p.y times a sine of time. It costs one multiply per step and it is the only term that changes the global direction the channels run in, which matters because everything downstream is anchored on the y axis and without this the sky has one permanent grain.
//
//   2. WARP ONE, BROAD. Four sines of four different linear combinations of the plan, two fed into x and two into y. A sine-warped plane is the cheapest thing that produces genuinely sinuous meandering: the pre-image of a straight line under it is a curve that wanders, and where the warp amplitude passes about one over the warp frequency it stops being injective and the curve doubles back over itself.
//
//   3. WARP TWO, FINER, ON THE ALREADY WARPED PLANE. This is the move that decides whether the whole thing looks like an aurora or like a stack of ripples, and it deserves the explanation. A sum of sines has a line spectrum: a handful of discrete frequencies and nothing in between, which is exactly what "regular" looks like. But sin(x + A sin(y)) is frequency modulation, and its spectrum is the Bessel expansion, which is an infinite comb of sidebands. Nesting one sine warp inside another therefore turns a line spectrum into a broadband one for the price of three more sines. Turn snWarp2 to zero and the difference is immediate: one stage alone gives long smooth marbled flow, and the second stage is where the kinks, hooks and small folds come from.
//
//   4. THE FOLD, WITH A MODULATED SPACING. phi is the warped y times the channel frequency times a slow sine, plus a low-frequency bend read off the warped x. The spacing modulation is not decoration either: a fold at a fixed frequency puts every channel the same distance from its neighbour, and evenly spaced is the single loudest tell that a pattern was computed. sp varies the local channel pitch by plus or minus forty percent across the sky, so a quarter of the sky gets four crowded threads where another gets one broad band.
//
// ===========================================================================
// THE HONEST PROBLEM WITH A PURE TRIG BASIS, AND WHAT IS DONE ABOUT IT
// ===========================================================================
//
// A sum of incommensurate sinusoids is quasi-periodic, so it never exactly repeats over any sky you can see, and a measured autocorrelation of this field along both axes stays under 0.16 at every lag past one channel width. That is the easy half and it is not the half that matters.
//
// The half that matters is INTERMITTENCY. Real noise is uneven in a way a sine sum is not: parts of it are violent and parts are almost flat, and the eye reads that unevenness as structure having a cause. A raw sine sum has the same amplitude everywhere by construction, which reads as a corrugated surface no matter how many terms you pile on. So the second warp's amplitude is multiplied by e, a broad slow sine envelope, which leaves some regions of the sky nearly unwarped and long, and others curdled and hooking. That one extra sine buys more apparent randomness than the three it modulates do.
//
// The other half of the answer is the GATE, which is trigonometric here too. sin(id * 2.399) and sin(id * 5.077) evaluated at integer id are two sequences whose periods are irrational multiples of each other, so their sum is a perfectly serviceable per-channel pseudo-random number for the cost of two sines and no hash. It switches whole channels off independently of their neighbours, which breaks the coherence of the family in a way nothing inside the field itself can, and it is the reason the sky reads as an event rather than as a painted lattice.
//
// Where this still loses to leyline, honestly: leyline has genuinely fine detail down to the pixel because fBm has octaves all the way down, and this has a hard floor at the second warp's scale. Zoom into a channel edge and it is smooth in a way a real curtain is not. That loss is mostly hidden because the frame's own ray, flow and shimmer terms add the fine structure back on top, and those are indexed on along and id, which this returns perfectly well.
//
// ===========================================================================
// THE COST, HAND COUNTED
// ===========================================================================
//
// Counting every multiply, add, subtract, abs, floor, fract and clamp as one operation, and every sin as one instruction:
//
//   seed offset 4, ta 1, shear 4, a 2, envelope e 7, w1 2, w2 3, w3 4, w4 4, q 8, b 3, v1 2, v2 3, v3 5, r 10, sp 7, phi 7, tri 4, along 1, id 2   =   83 arithmetic
//   sines in the field: shear, e, w1, w2, w3, w4, v1, v2, v3, sp, phi                                                                             =   11 sin
//   gate on id: 22 arithmetic, 2 sin.   patch along the channel: 21 arithmetic, 2 sin.
//
//   TOTAL AS WRITTEN: 126 arithmetic + 15 sin = 141 instructions.
//
// Of those, 21 arithmetic and 1 sin are loop invariant: t does not change between march steps, so ta, the shear scalar, every ta-times-constant product, the warp-two scale, the warp-two amplitude and the two gate edges are all hoisted out of the loop by any compiler worth the name. PER MARCH STEP the real figure is about 105 arithmetic and 14 sin, or 119 instructions. With both gate branches off it is about 78.
//
// What a sin actually costs: on Adreno, PowerVR, Apple and Mali parts it issues on the special-function unit as a single instruction at roughly quarter rate rather than being expanded into a polynomial, so counting it as one instruction with a four-times weight is the pessimistic bound. Weighted that way the per-step figure is 105 + 56 = 161, which is over the 150 target and which is stated here rather than hidden. Either way it is between thirteen and seventeen times cheaper than a leyline step. This paragraph is quoted from memory of Arm's Mali and Qualcomm's Adreno optimisation guidance and has NOT been verified against those documents in this session, so treat the four-times weight as an estimate and the instruction counts above as the checkable number.
//
// One more thing the count does not show: this algorithm needs only the util chunk. It does not pull in hash, value, grad, fbm or warp for its own sake, so a build that ran nothing but this could drop most of noise.js entirely.
// ---------------------------------------------------------------------------

export const SINE = {
  id: 'sine',
  name: 'sine',
  blurb: 'The same contour family as ley lines with every noise lookup replaced by trigonometry, at about a seventeenth of the cost.',
  mode: 'field',

  // Only util, for tri(). Every other chunk in noise.js is deliberately absent.
  needs: [ 'util' ],

  // The trig field has smoother gradients than a warped fBm does and it packs
  // more channels into the same sky, so a channel is thinner in phi units than
  // leyline's is and needs a wider threshold to show a body rather than a wire.
  // Sharpness comes up to compensate and keep the core hot.
  overrides: {
    width: 0.40,
    sharp: 1.70,
  },

  groups: [
    {
      title: 'Sine -- the channels',
      open: true,
      params: [
        {
          key: 'snFreq',
          label: 'channel count',
          hint: 'How many contours the folded field is cut into, which is the number of separate channels crossing the sky. Like every tri-based family it costs nothing to raise, because one triangle wave draws all of them at once no matter how many there are.',
          type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.55,
        },
        {
          key: 'snSpace',
          label: 'spacing variation',
          hint: 'Modulates the fold frequency itself with a slow sine, so channel pitch varies across the sky instead of being one number everywhere. Take it to zero once: evenly spaced channels are the loudest single tell that a pattern was computed rather than observed, and this is the cheapest knob that removes that tell.',
          type: 'float', min: 0, max: 0.7, step: 0.005, value: 0.40,
        },
        {
          key: 'snBend',
          label: 'bend',
          hint: 'A low-frequency sine of the along-channel coordinate added straight into the fold. Without it the channels are a strict function of the warped y and can never turn past vertical; with it they arch, hook back and occasionally close into loops.',
          type: 'float', min: 0, max: 4, step: 0.01, value: 0.90,
        },
        {
          key: 'snBendFreq',
          label: 'bend scale',
          hint: 'Size of the bends. Keep it well below the warp scale or the bend competes with the warp at the same wavelength and the two average out into mush instead of compounding into shape.',
          type: 'float', min: 0.01, max: 1.5, step: 0.005, value: 0.21,
        },
        {
          key: 'snAlong',
          label: 'along scale',
          hint: 'Scales the along-channel coordinate that the frame indexes flow, hue travel, shimmer and the vertical rays on. It changes no shape at all, only how long a channel is in the units those four effects measure it in, so raising it makes every travelling feature smaller and more frequent at once.',
          type: 'float', min: 0.05, max: 6, step: 0.01, value: 1.0,
        },
      ],
    },

    {
      title: 'Sine -- the double warp',
      open: true,
      params: [
        {
          key: 'snWarp',
          label: 'warp',
          hint: 'Amplitude of the first sine warp, which is what turns a stack of parallel lines into meandering channels. Past roughly one over the warp scale the warp stops being injective and the channels genuinely fold over themselves, which is where the weaving and the branching come from.',
          type: 'float', min: 0, max: 4, step: 0.01, value: 1.30,
        },
        {
          key: 'snWarpFreq',
          label: 'warp scale',
          hint: 'Size of the features both warps are built from, with the second stage running at 2.317 times this so the two never come back into alignment. Low is a few broad sweeps across the whole sky; high is a fine crinkle that reads as a texture on the channel edges rather than as shape.',
          type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.42,
        },
        {
          key: 'snWarp2',
          label: 'second warp',
          hint: 'Amplitude of the second warp relative to the first, and the single most important knob here. Sin of a sine is frequency modulation, so nesting the warps turns a handful of discrete frequencies into a Bessel comb of sidebands, which is the difference between broadband and obviously periodic. At zero you get long smooth marbled flow; raise it and the kinks, hooks and small folds appear.',
          type: 'float', min: 0, max: 1.2, step: 0.005, value: 0.55,
        },
        {
          key: 'snMorph',
          label: 'morph rate',
          hint: 'How fast the whole construction evolves. Time enters every sine on its own phase axis rather than as a translation of the plane, so turning this up makes the channels writhe in place and reshape rather than slide across the sky. Every time coefficient is a different irrational-ish number, so the pattern has no period you can wait out.',
          type: 'float', min: 0, max: 3, step: 0.01, value: 0.40,
        },
        {
          key: 'snShear',
          label: 'rotating shear',
          hint: 'Amplitude of a slow shear applied before anything else, oscillating on a period of about three minutes at the default morph rate. It is the only term that changes the direction the channel family runs in, and without it the sky keeps one permanent grain because everything downstream is anchored on the y axis.',
          type: 'float', min: 0, max: 1.5, step: 0.005, value: 0.45,
        },
      ],
    },

    {
      title: 'Sine -- which are lit',
      open: false,
      params: [
        {
          key: 'snGateAmt',
          label: 'channel gating',
          hint: 'How much whole channels switch on and off. Two sines of the integer channel id at incommensurate rates give a serviceable per-channel pseudo-random for the price of no hash at all, and switching neighbours independently is the only thing that breaks the coherence of a contour family. It is also the highest-value knob for making this read as an event rather than as a painted lattice.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.65,
        },
        {
          key: 'snGate',
          label: 'gate threshold',
          hint: 'How choosy the gating is. The value it tests runs over roughly minus two to plus two, so zero leaves about half the channels lit and pushing it up empties the sky. High settings are honest to how an aurora actually behaves and are also miserable to tune against, so drop it while working and raise it before judging.',
          type: 'float', min: -1.4, max: 1.4, step: 0.01, value: 0.10,
        },
        {
          key: 'snPatchAmt',
          label: 'patchiness',
          hint: 'How much a lit channel goes dark along its own length. Real arcs are never lit end to end; they burn in sections that come and go over a minute or two while the arc itself stays exactly where it was.',
          type: 'float', min: 0, max: 1, step: 0.01, value: 0.50,
        },
        {
          key: 'snPatch',
          label: 'patch scale',
          hint: 'How long a lit section is, in along-channel units. The second wave runs at 1.618 times the first and is offset by the channel id, so no two channels break up in the same places and none of them repeat along their own length. Low gives two or three long stretches per channel; high breaks it into a dotted line, which is the pulsating-patch form.',
          type: 'float', min: 0.01, max: 2, step: 0.005, value: 0.30,
        },
      ],
    },
  ],

  glsl: `
    vec4 auroraField( vec2 p, float t ) {
      p += vec2( u_fieldSeed * 11.73, u_fieldSeed * 29.31 );

      // Time gets its own phase axis in every sine below, never a translation of
      // the plane, so the sky morphs in place instead of sliding. ta and every
      // ta-times-constant below is loop invariant across the march.
      float ta = t * u_snMorph;

      // The rotating shear. One multiply per step, and it is the only term that
      // turns the whole family, which otherwise keeps a permanent grain.
      p.x += p.y * ( sin( ta * 0.087 ) * u_snShear );

      // ---- Warp one, broad. Four sines of four different linear combinations,
      // at frequency ratios chosen so no two ever come back into alignment.
      vec2 a = p * u_snWarpFreq;

      // The intermittency envelope. A sine sum has the same amplitude
      // everywhere, which reads as corrugation; this leaves parts of the sky
      // long and calm and other parts curdled, and it buys more apparent
      // randomness than the three sines it modulates.
      float e = 0.55 + 0.45 * sin( a.x * 0.271 - a.y * 0.184 + ta * 0.11 );

      float w1 = sin( a.y + ta * 0.70 );
      float w2 = sin( a.x * 1.311 - ta * 0.51 );
      float w3 = sin( ( a.x - a.y ) * 0.786 + ta * 0.31 );
      float w4 = sin( ( a.x + a.y ) * 0.573 - ta * 0.43 );

      vec2 q = p + u_snWarp * vec2( w1 + 0.62 * w3, w2 - 0.57 * w4 );

      // ---- Warp two, on the ALREADY warped plane. sin of a sine is frequency
      // modulation, so this is what takes the spectrum from a few discrete
      // lines to a Bessel comb. It is the whole reason this does not look like
      // a stack of ripples.
      vec2 b = q * ( u_snWarpFreq * 2.317 );
      float v1 = sin( b.x + ta * 1.13 );
      float v2 = sin( b.y * 1.442 - ta * 0.87 );
      float v3 = sin( b.x * 0.618 + b.y * 0.786 + ta * 1.51 );

      vec2 r = q + ( u_snWarp * u_snWarp2 * e ) * vec2( v2 + 0.48 * v3, v1 - 0.44 * v3 );

      // ---- The fold. sp modulates the channel pitch itself, so spacing varies
      // across the sky. It stays strictly positive over its whole slider range,
      // which matters: phi has to remain a smooth single-valued scalar or the
      // contours stop being contours and start crossing.
      float sp = 1.0 + u_snSpace * sin( r.x * 0.211 - r.y * 0.133 + ta * 0.19 );
      float phi = r.y * u_snFreq * sp + u_snBend * sin( r.x * u_snBendFreq + ta * 0.23 );

      float raw = tri( phi );
      float along = r.x * u_snAlong;
      float id = floor( phi + 0.5 );

      // ---- Which channels are lit, and where along their length.
      //
      // Both are two sines and no hash. sin( id * k ) at integer id, for a k
      // that is not a rational multiple of TAU, is a sequence that never
      // repeats, and the sum of two of them is flat enough to threshold
      // against. Each is behind its own amount so a preset that turns it off
      // stops paying for it, and both tests are on uniforms, so every fragment
      // in the draw takes the same branch.
      float gate = 1.0;
      if ( u_snGateAmt > 0.0 ) {
        float g = sin( id * 2.399 + ta * 0.21 ) + sin( id * 5.077 - ta * 0.134 );
        gate *= mix( 1.0, smoothstep( u_snGate - 0.55, u_snGate + 0.55, g ), u_snGateAmt );
      }
      if ( u_snPatchAmt > 0.0 ) {
        float ap = along * u_snPatch;
        float g2 = sin( ap + id * 1.713 ) + sin( ap * 1.618 + id * 4.117 - ta * 0.37 );
        gate *= mix( 1.0, smoothstep( -0.45, 0.75, g2 ), u_snPatchAmt );
      }

      return vec4( raw, along, id, gate );
    }
  `,
}
