// ---------------------------------------------------------------------------
// Builtin tunings.
//
// These are PARTIAL: a preset states only what it changes and everything else
// falls back to the schema default. That is deliberate and it is the opposite
// of what the raymarch lab's saved presets do, which snapshot every key. A full
// snapshot is the right thing for "save what I am looking at" and the wrong
// thing for a builtin, because a builtin has to survive the schema gaining a
// parameter -- and a full snapshot pins the new parameter to whatever it
// happened to be on the day the preset was written, silently.
//
// The trace group is left alone by every preset here except `thin budget`,
// which exists to move it. Those keys re-run the CPU contour trace, so a preset
// that touched them stutters on load, and none of them is a look -- they are a
// budget, which is exactly why the one preset that IS a budget owns them.
//
// Two couplings to respect when writing a new preset, both of them arithmetic
// and both of them fences if you get them wrong.
//
// `skirtTight` is derived from `reach` and `spacingFrac` rather than chosen --
// params.js gives the algebra -- so a preset that moves either of those and
// leaves the halo alone is a preset with a picket fence in it. Every value
// below was solved for, and the working is in the comment beside it.
//
// And every along-channel frequency has a CEILING set by the coarsest card
// spacing in the sky, which is widthMaxKm * spacingFrac. One card holds one
// value of the rays, the shimmer and the flicker, so
//
//     samples per cycle = 1 / ( freq * leyAlong * fieldScale * widthMaxKm * spacingFrac )
//
// and below about five that structure stops being drawn and starts being
// aliased into per-card noise -- which is to say, into a fence. `leyAlong` is
// the trap here, because it multiplies every one of those frequencies at once
// while looking like a shape control: raising it from 0.23 to 0.5 halves the
// sampling of the rays without touching rayFreq. Two presets below carry ray
// densities well under what they would want in a raymarch for exactly that
// reason, and that is the honest cost of this technique rather than a tuning
// oversight.
// ---------------------------------------------------------------------------

export const BUILTIN_PRESETS = {
  // The default sky. The FIELD half of it is still the raymarch lab's saved "v1
  // amazing" tuning, key for key, and that correspondence is worth keeping:
  // put the two pages side by side with the same ley numbers and the difference
  // you are looking at is the technique rather than the tuning.
  //
  // The PROFILE half deliberately no longer matches, and it cannot. The
  // raymarch integrates a continuous channel, so its width and sharpness are
  // properties of the channel itself. Here a channel is assembled out of
  // overlapping columns about seven deep, and the same numbers that drew one
  // crisp channel there draw seven crisp columns standing next to each other
  // here. Wider, softer, blurrier at the hem and much fainter per column is not
  // a different taste; it is the same channel, sampled.
  'ley lines': {
    values: {
      leyFreq: 0.38, leyWarp: 5, leyWarpFreq: 0.055, leyBend: 4, leyBendFreq: 0.335,
      leyAlong: 0.23,
      width: 0.42, sharp: 0.75, scatter: 2.1, skirtTight: 12, reach: 0.85,
      hemBlur: 3.2, hemBlurSpan: 0.42,
      altLow: 111, altHigh: 345, hemSoft: 0.039, falloff: 6.24, topFade: 0.775,
      beltAmt: 1, beltOffset: -450, beltWidth: 430, beltPow: 2.6,
      gateAmt: 0.44, gate: 0.39, patchAmt: 1, patch: 1.635, patchDrift: 0.11,
      swathAmt: 0.7, swathScale: 0.15, swathSpeed: 0.06,
      pulseAmt: 0.55, pulseFreq: 2.6, pulseSpeed: 1.35,
      rays: 0.5, rayFreq: 6.8,
      flowHue: 1, flowSpeed: 0.93, flowFreq: 0.5,
      caustic: 0.5, causFreq: 1.4, causSpeed: 0.35, causPow: 4,
      neon: 0.22, pale: 0.25, hemBand: 0.12, crown: 0.55, crownStart: 0.42,
      neonSpread: 1, neonShift: 0.15, saturate: 1.05,
      gain: 0.3, exposure: 0.9,
    },
  },

  // A single quiet arc low on the northern horizon, which is what an aurora
  // looks like on nine nights out of ten. Hard gating leaves almost everything
  // dark, the belt is narrow and far, and the shimmer is nearly off because a
  // quiet arc genuinely does hold still for minutes at a time.
  'quiet arc': {
    values: {
      leyFreq: 0.26, leyWarp: 3.2, leyBend: 2.4,
      gateAmt: 0.85, gate: 0.56, patchAmt: 0.55, patch: 0.7,
      beltAmt: 0.92, beltOffset: -560, beltWidth: 300, beltPow: 3.2,
      altLow: 104, altHigh: 250, falloff: 7.4, topFade: 0.7, ragged: 0.2,
      rays: 0.3, rayFreq: 4.2,
      caustic: 0.12, flowHue: 0.3, neon: 0.06,
      crown: 0.3, crownStart: 0.55, saturate: 0.9,
      // A quiet arc is quiet in TIME as well as in shape, and that is most of
      // what makes it read as quiet. The flicker is nearly off, the swaths
      // barely move, and the patches creep. What is left is an arc that holds
      // its shape for a minute at a stretch, which is the thing a real quiet arc
      // does that no amount of shape tuning can fake.
      patchDrift: 0.02, swathAmt: 0.35, swathScale: 0.08, swathSpeed: 0.02,
      pulseAmt: 0.12, pulseFreq: 1.4, pulseSpeed: 0.4,
      hemBlur: 2.4, hemBlurSpan: 0.5,
      // Above the shipped gain rather than below it, which is the right way
      // round: this is the preset with the fewest lit channels, so the columns
      // over a given pixel stack up shallower and a screen blend gives back
      // whatever the stack does not take. Nothing here clips at either framing.
      gain: 0.48, exposure: 1.05,
    },
  },

  // Substorm breakup: the arc has gone unstable, split into many channels and
  // filled the sky overhead. Nearly everything is lit, the rays are fine and
  // fast, and the columns are tall enough to reach well into the red crown.
  breakup: {
    values: {
      leyFreq: 0.62, leyWarp: 5.4, leyWarpFreq: 0.08, leyBend: 4.4,
      leyAlong: 0.4,
      gateAmt: 0.2, gate: 0.2, patchAmt: 0.7, patch: 2.1,
      beltAmt: 0.35, beltOffset: -220, beltWidth: 760, beltPow: 1.8,
      altLow: 96, altHigh: 400, falloff: 4.6, topFade: 0.82, ragged: 0.55, hemWander: 0.09,
      // A substorm wants the finest rays in the file and this technique cannot
      // give them to it: at this along scale the 13.5 it used to ask for came
      // out at 1.6 cards per ray, which is under Nyquist, so what it actually
      // drew was not fine rays but a fence of unrelated columns. 4.5 is what
      // fits, and the loudness has to come from the temporal knobs instead.
      rays: 0.85, rayFreq: 4.5,
      caustic: 0.8, causFreq: 3.1, causSpeed: 0.8, causPow: 5.5,
      flowHue: 0.7, flowSpeed: 1.6,
      pale: 0.5, crown: 0.72, crownStart: 0.36, neon: 0.16, saturate: 1.15,
      // Breakup is the loud end of every temporal knob at once. The patches run
      // rather than drift, the swaths tear across the sky in seconds, and the
      // flicker is nearly full depth and fast, which together are what separate
      // a substorm from a bright quiet arc. Note the flicker scale stays modest
      // even here: it is the one term that aliases into per-card noise if it is
      // pushed past the card spacing, and a substorm is exactly when the cards
      // are most spread out.
      patchDrift: 0.55, swathAmt: 0.85, swathScale: 0.3, swathSpeed: 0.22,
      pulseAmt: 0.8, pulseFreq: 3.4, pulseSpeed: 2.8,
      hemBlur: 3.6, hemBlurSpan: 0.35,
      // The lowest gain of the five, and it has to be, because this is the
      // preset with the most lit sky: nothing else here fills the frame
      // completely. A screen blend stops the SUM clipping but not a single card
      // clamping on its own, and with this many cards over every pixel the
      // brightest of them were doing exactly that -- a fifth of the lit pixels
      // pinned, spread over a sky that is 100% lit, which is a lot of flat white
      // for a form whose whole character is structure.
      gain: 0.2,
    },
  },

  // The declared magic rather than the physics: hue running down the channels
  // like current down a wire. This is the one that is furthest from a
  // photograph and closest to the brief, and it is worth having as a builtin
  // precisely so the distance between the two is one click rather than an
  // argument.
  'neon leylines': {
    values: {
      leyFreq: 0.44, leyWarp: 5.6, leyBend: 3.4, leyAlong: 0.5,
      neon: 0.72, neonSpread: 0.62, neonShift: 0.58, saturate: 1.35,
      flowHue: 1, flowSpeed: 1.8, flowFreq: 1.1,
      caustic: 0.7, causFreq: 2.6, causSpeed: 0.7, causPow: 6,
      // Same Nyquist cut as breakup, and worse here, because this preset has the
      // highest along scale of the five: 10.5 came out at 1.7 cards per ray.
      rays: 0.72, rayFreq: 3.2,
      // The one preset that WANTS its filaments crisp, so the hem blur is turned
      // most of the way down rather than off. Current running down a wire is
      // supposed to look like a wire, and a wire has an edge. Off entirely puts
      // the seams between the columns straight back, so this is the setting that
      // shows what the blur is buying.
      //
      // The halo is tighter than the derived 12 but not by much, and 18 is the
      // most it can be tightened without the ripple becoming visible: at the
      // stock reach and spacing it puts the halo sigma at 0.82 of a card
      // spacing, which still sums flat. The 46 it used to carry was 0.51, and
      // that -- combined with the spacing floor, which is where the real damage
      // was -- is why this preset was the most obvious fence of the five.
      sharp: 1.9, width: 0.22, scatter: 2.2, skirtTight: 18,
      hemBlur: 1.5, hemBlurSpan: 0.3,
      gateAmt: 0.32, gate: 0.28,
      patchDrift: 0.34, swathAmt: 0.5, swathScale: 0.22, swathSpeed: 0.14,
      pulseAmt: 0.45, pulseFreq: 3.0, pulseSpeed: 2.2,
      beltAmt: 0.85,
      gain: 0.42, exposure: 1,
    },
  },

  // The budget question, made visible. Thins the card count and the profile
  // together so the overdraw comes down with both. Not a look so much as a
  // measurement: switch to this, watch the GPU timer, and the gap between the
  // two numbers is what the density is costing.
  //
  // Every along-channel frequency comes down WITH the spacing, and that is the
  // part worth copying rather than the numbers. Card spacing is the resolution
  // limit of this technique: detail finer than one card cannot be drawn, only
  // aliased. Thinning the cards without thinning the frequencies does not buy a
  // cheaper version of the same sky, it buys a picket fence -- which is exactly
  // what this preset used to be, and the reason it was the ugliest of the five.
  //
  // The PROFILE has to come down with the spacing too, and that is the half
  // that was missing. Three numbers here are solved rather than picked. The
  // halo tightness has to keep the skirt sigma near a card spacing, which at
  // this reach and spacing fraction wants about 1.8 -- but a halo that wide
  // needs a card wide enough to hold it, and at reach 1.05 the edge would sit
  // only two sigma out and cut the skirt off square. 5.5 is where those two
  // bounds meet: sigma at 0.57 of a spacing, which still sums flat, and an edge
  // at 3.5 sigma, which is invisible. And the narrowest channel is raised to 20
  // because the spacing floor of 11 is what the narrow channels actually get,
  // and a 7 km channel sampled every 11 km is a fence no matter how the halo is
  // tuned. Sparse is not the same as under-sampled, and this preset is meant to
  // demonstrate the first without the second.
  'thin budget': {
    values: {
      cardSpacingKm: 11, spacingFrac: 0.5, gridN: 160, maxDistKm: 520,
      widthMinKm: 20,
      leyFreq: 0.3, leyAlong: 0.14,
      gateAmt: 0.62, gate: 0.46,
      reach: 1.05, width: 0.55, sharp: 0.5, scatter: 1.4, skirtTight: 5.5,
      hemBlur: 4.2, hemBlurSpan: 0.6,
      ragged: 0.28,
      rays: 0.34, rayFreq: 2.6,
      caustic: 0.3, causFreq: 0.7,
      patch: 0.8, patchDrift: 0.07,
      swathAmt: 0.7, swathScale: 0.07, swathSpeed: 0.05,
      pulseAmt: 0.4, pulseFreq: 0.9, pulseSpeed: 1.1,
      // Sparse cards need a LOWER gain, not a higher one, which is the opposite
      // of the intuition. At this spacing a pixel is covered by one or two
      // columns rather than seven, so almost nothing is arriving from the stack
      // and almost everything from the single card -- and it is the single card,
      // not the stack, that the shader clamps to white.
      gain: 0.28, exposure: 1.05,
    },
  },
}
