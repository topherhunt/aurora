// ---------------------------------------------------------------------------
// The card aurora's parameter schema.
//
// ===========================================================================
// WHY THIS IS NOT AN ENTRY IN THE LAB'S ALGORITHM REGISTRY
// ===========================================================================
//
// The obvious move was to add a seventh algorithm to `src/aurora-lab/algorithms.js`
// and get its whole sidebar for free. That does not work, and the reason is
// worth recording so nobody spends an afternoon rediscovering it.
//
// `SHARED_GROUPS` there is concatenated onto every algorithm unconditionally,
// and about sixty of its knobs are RAYMARCH parameters: `steps`, `stepBias`,
// `dither`, `persp`, `horizonCut`, `edgeFade`, `fieldScale` as a screen-space
// quantity, and the whole March quality group. A technique with no march has
// nowhere to route any of them, and `applyParam`'s fall-through throws on the
// first one it cannot place. So the choice was to fake sixty dead sliders or to
// have a schema of the technique's own. This is the schema of its own.
//
// It is deliberately NOT a shared module with the lab. The two will drift, and
// they should: the lab is a raymarch and this is geometry, and pretending they
// answer to one schema is how a slider ends up meaning two different things.
//
// ===========================================================================
// `uniform` AND `REBUILD_KEYS` ARE TWO HALVES OF ONE STATEMENT
// ===========================================================================
//
// Every parameter is either written straight into a shader uniform each frame
// (`uniform: true`) or it changes the GEOMETRY and needs the contour trace to
// run again (`REBUILD_KEYS`). Those two sets must stay disjoint, and the gate
// asserts it, because a param that is both would kick off a CPU re-trace on
// every mouse-move of its slider.
//
// Which side a knob lands on is the main design pressure in this file, and the
// answer is usually "make it a uniform, even if that costs a little in the
// shader". A uniform is a slider you can drag while looking at the sky; a
// rebuild key is a slider that stutters. `reach` is the worked example: it sets
// how wide a card is, which sounds like geometry, but baking the half-distance
// to the neighbouring channel into the instance attribute and scaling it in the
// vertex shader moves it to the free side of the line.
// ---------------------------------------------------------------------------

import { BACKDROP_PARAMS } from '../aurora-lab/backdrop.js'

export const CARD_GROUPS = [
  {
    title: 'Ley lines',
    open: true,
    params: [
      {
        key: 'leyFreq',
        label: 'channel count',
        hint: 'How many contour lines the potential is cut into, which is how many separate channels cross the sky. Unlike the raymarch, this one does cost something to raise -- every extra contour is real geometry that has to be traced and drawn.',
        type: 'float', min: 0.05, max: 4, step: 0.01, value: 0.38, uniform: false,
      },
      {
        key: 'leyWarp',
        label: 'warp',
        hint: 'How hard the plane is pulled about before the contours are read off it. Zero gives dead straight parallel bands. Past about 1.5 the warp stops being injective and channels start folding over themselves, which is where the weaving comes from.',
        type: 'float', min: 0, max: 6, step: 0.01, value: 5, uniform: false,
      },
      {
        key: 'leyWarpFreq',
        label: 'warp scale',
        hint: 'The size of the features the warp is made of, relative to the channel spacing. Low is a few broad sweeps across the whole sky; high is a fine crinkle that the trace grid cannot resolve and that shows up as jitter on the polylines rather than as shape.',
        type: 'float', min: 0.02, max: 2.5, step: 0.005, value: 0.055, uniform: false,
      },
      {
        key: 'leyMorph',
        label: 'morph rate',
        hint: 'How fast the warp evolves with time. Because the contours are traced once and then animated in the vertex shader, this does not make the sky writhe by itself -- it moves the field that the NEXT trace will see, so it decides how different the sky looks after a rebuild.',
        type: 'float', min: 0, max: 3, step: 0.01, value: 0.42, uniform: false,
      },
      {
        key: 'leyBend',
        label: 'bend',
        hint: 'An independent low-frequency field added to the contour coordinate. Without it the channels are a strict function of one axis and can never turn past vertical; with it they arch, hook and close into loops, and closed loops are where the trace finds its saddles.',
        type: 'float', min: 0, max: 5, step: 0.01, value: 4, uniform: false,
      },
      {
        key: 'leyBendFreq',
        label: 'bend scale',
        hint: 'The size of the bends. Keep it well below the warp scale or the two fight and the result is mush rather than structure, and the trace pays for the mush in component count.',
        type: 'float', min: 0.01, max: 1.5, step: 0.005, value: 0.335, uniform: false,
      },
      {
        key: 'leyAlong',
        label: 'along scale',
        hint: 'Scales the along-channel coordinate that flow, shimmer, gating and the vertical rays are all indexed on. It changes nothing about the shape -- it changes how long a channel is in the units those effects measure it in, so raising it makes every travelling feature smaller and more frequent at once.',
        type: 'float', min: 0.05, max: 6, step: 0.01, value: 0.23, uniform: true,
      },
      {
        key: 'fieldScale',
        label: 'field scale',
        hint: 'Kilometres to field units. This is the master zoom on the whole potential: halving it doubles the size of every channel and every fold on the ground, without changing any of their relative proportions.',
        type: 'float', min: 0.002, max: 0.06, step: 0.0005, value: 0.012, uniform: false,
      },
      {
        key: 'fieldSeed',
        label: 'seed',
        hint: 'Offsets the whole field, which gives a completely different sky with the same character. Worth stepping through when a tuning looks good, because a shape that only works at one seed is a shape you got lucky with.',
        type: 'float', min: 0, max: 32, step: 1, value: 1, uniform: false,
      },
      {
        key: 'warpStages',
        label: 'warp stages',
        hint: 'One stage or two. The second stage is what gives the folds folds of their own, and it doubles the cost of the trace. Cheap here in a way it never was in the raymarch, because the trace runs once rather than per pixel per step.',
        type: 'float', min: 1, max: 2, step: 1, value: 2, uniform: false,
      },
      {
        key: 'traceTime',
        label: 'trace time',
        hint: 'The moment in the field the contours were traced at. Dragging this re-traces, so it stutters, but it is the only way to see how the topology itself evolves rather than how the cards animate on a fixed topology.',
        type: 'float', min: 0, max: 400, step: 0.5, value: 0, uniform: false,
      },
    ],
  },
  {
    title: 'The trace',
    open: false,
    params: [
      {
        key: 'gridN',
        label: 'grid resolution',
        hint: 'How many samples across the traced region. This is the accuracy of the topology: too coarse and a saddle falls between two cells, so a branch that should exist is simply never found. Cost is the square of this and it is all CPU, paid on rebuild.',
        type: 'float', min: 48, max: 384, step: 8, value: 224, uniform: false,
      },
      {
        key: 'spanKm',
        label: 'span',
        hint: 'Half the width of the traced region in kilometres, centred on the eye. Larger reaches further toward the horizon and costs the square of itself in trace time at fixed grid resolution, because the cells get bigger unless you raise the resolution too.',
        type: 'float', min: 200, max: 1400, step: 10, value: 800, uniform: false,
      },
      {
        key: 'maxDistKm',
        label: 'draw radius',
        hint: 'Cards further from the eye than this are dropped at build time. The far ones sit within a degree of the horizon where the extinction term has already taken most of their light, so they cost triangles and return almost nothing.',
        type: 'float', min: 150, max: 1400, step: 10, value: 780, uniform: false,
      },
      {
        key: 'cardSpacingKm',
        label: 'closest spacing',
        hint: 'The floor on how close together cards sit along a channel, in kilometres. Narrow channels hit this floor and it is the main triangle budget knob for them; wider ones are spaced by the fraction below instead. This is where every picket fence this technique has produced has actually come from: the fraction keeps the wide channels sampled proportionally, but a channel narrow enough to hit this floor gets a fixed spacing and a halo that keeps shrinking with its width, so the two come apart and the columns separate. It has to stay under about half the narrowest channel below, and the halo tightness in Channel shape is derived from the pair.',
        type: 'float', min: 1, max: 40, step: 0.5, value: 3, uniform: false,
      },
      {
        key: 'spacingFrac',
        label: 'spacing per width',
        hint: 'Card spacing as a fraction of the local channel width. This is the knob that makes overdraw a constant rather than something the field decides: the overlap along a channel works out to twice the card reach divided by this, no matter how wide or narrow the channel happens to be, which is about seven layers at the defaults. Lower is smoother and more expensive in fill rate, and it is the first knob to raise if a Quest 2 turns out to be fill bound -- it is the only one that buys back overdraw and triangles at the same time. It also sets the along-channel resolution limit, so raising it means lowering the ray, shimmer and flicker frequencies with it or they alias into per-card noise.',
        type: 'float', min: 0.08, max: 2, step: 0.01, value: 0.24, uniform: false,
      },
      {
        key: 'smoothPasses',
        label: 'smoothing',
        hint: 'Passes of a three-tap filter over the raw marching-squares polyline. The staircase it removes is in the ORDER the crossings are visited rather than in their positions, so this straightens the path without moving it off the level set.',
        type: 'float', min: 0, max: 6, step: 1, value: 2, uniform: false,
      },
      {
        key: 'minLenKm',
        label: 'minimum length',
        hint: 'Contour components shorter than this are discarded. Near a local extremum of the potential the level sets shrink to tiny rings, and a ring twenty kilometres across reads as a bright dot rather than as a channel.',
        type: 'float', min: 0, max: 400, step: 5, value: 60, uniform: false,
      },
      {
        key: 'widthMinKm',
        label: 'narrowest channel',
        hint: 'Floor on the half-distance to the neighbouring channel, in kilometres. Without it a channel crossing a very steep part of the field collapses to a sliver narrower than a pixel and aliases into a crawling dotted line. It carries a second job now: a card is only as wide as its channel, so this and the closest spacing above together decide whether the narrowest channel in the sky still overlaps itself. Keep it at roughly twice the closest spacing, and expect a visible fence below that.',
        type: 'float', min: 0.5, max: 40, step: 0.5, value: 7, uniform: false,
      },
      {
        key: 'widthMaxKm',
        label: 'widest channel',
        hint: 'Ceiling on the same quantity. This one is not cosmetic: where the potential flattens the gradient approaches zero and the computed width approaches infinity, so without a ceiling a single card can swallow the entire sky. It also sets the COARSEST the sky is ever sampled along a channel, because spacing is a fraction of width, and every along-channel term -- rays, shimmer, flicker -- is constant across one card. A card 180 km thick holding a single ray value is not a curtain with rays on it, it is a slab; real auroral arcs are a few kilometres to a few tens thick, so this belongs near the low end of its range rather than the high one, and raising it puts visible ruled bands into the widest parts of the sky.',
        type: 'float', min: 10, max: 400, step: 1, value: 40, uniform: false,
      },
    ],
  },
  {
    // ===========================================================================
    // WHY THE HALO TIGHTNESS IS DERIVED FROM THE CARD SPACING AND NOT CHOSEN
    // ===========================================================================
    //
    // This is the one arithmetic relationship in the file that decides whether
    // the technique works at all, and it went unnoticed through two rounds of
    // tuning because every symptom of getting it wrong looks like a shape
    // problem rather than a sampling one.
    //
    // The skirt is a Gaussian in across-channel distance. Its standard deviation
    // works out to halfKm / (reach * sqrt(2 * skirtTight)) kilometres, and the
    // spacing between cards along a channel is halfKm * spacingFrac. Divide one
    // by the other and the channel width CANCELS:
    //
    //     sigma / spacing = 1 / ( reach * spacingFrac * sqrt( 2 * skirtTight ) )
    //
    // So a single number describes how well the whole sky is sampled, no matter
    // how much the field crowds or thins. A row of Gaussians spaced one sigma
    // apart sums flat to about a part in a hundred million; at half a sigma it
    // is still flat to a percent; by a fifth of a sigma the sum has a hundred
    // and fifty percent ripple and you are looking at a picket fence. The
    // falloff is exponential in the SQUARE of the ratio, so this has almost no
    // middle ground -- it is smooth, and then very suddenly it is a fence.
    //
    // Setting the ratio to one and solving gives the shipped default:
    //
    //     skirtTight = 1 / ( 2 * ( reach * spacingFrac )^2 )   =  12 at 0.85 and 0.24
    //
    // The previous 34 put the ratio at 0.59, which is fine, and it was fine --
    // in the channels wide enough to be spaced by the fraction. The fence lived
    // entirely in the ones narrow enough to hit the cardSpacingKm FLOOR instead,
    // where the spacing stops shrinking with the channel but the halo does not:
    // at the old floor of 5 km against a narrowest channel of 4 km the ratio
    // fell to 0.11. That is the whole bug, and it is why the two trace knobs
    // carry a warning about each other.
    //
    // One more bound, from the other side. `reach` has to clear the skirt, and
    // at this tightness the card edge sits at reach * sqrt(2 * skirtTight) =
    // 4.2 sigma out, where a Gaussian is worth two parts in ten thousand. Push
    // skirtTight far below the derived value and that margin closes, and the
    // skirt starts being cut off square at the card edge instead.
    // ===========================================================================
    title: 'Channel shape',
    open: false,
    params: [
      {
        key: 'reach',
        label: 'card reach',
        hint: 'How far past the contour a card extends, as a fraction of the distance to the next channel. It has to comfortably clear both the core and the skirt or the skirt gets cut off square at the card edge, which is the one artefact that gives the geometry away. At the derived halo tightness the edge sits about four sigma out, which is the margin to preserve if you retune either. It is also half of the overdraw equation: the layers stacked over a covered pixel work out to twice this divided by the spacing fraction, so raising it costs fill rate in direct proportion.',
        type: 'float', min: 0.1, max: 1.5, step: 0.01, value: 0.85, uniform: true,
      },
      {
        key: 'width',
        label: 'channel width',
        hint: 'How much of the reach the bright core occupies. This is the same knob and the same units as the raymarch version, so a tuning carries across between the two techniques unchanged -- except that here it is the value at the TOP of a column, and the hem blur below widens it toward the bottom.',
        type: 'float', min: 0.01, max: 1, step: 0.005, value: 0.42, uniform: true,
      },
      {
        key: 'sharp',
        label: 'edge sharpness',
        hint: 'Raises the core profile to a power. Low is a soft glowing band, high is a hard bright filament with a dark edge. Above about three it starts to alias on the far channels where a card is only a few pixels wide. Kept under one by default, because a soft edge is what lets one column merge into the next instead of standing beside it.',
        type: 'float', min: 0.05, max: 6, step: 0.01, value: 0.75, uniform: true,
      },
      {
        key: 'hemBlur',
        label: 'hem blur',
        hint: 'How many times wider and softer the across-channel profile becomes at the bottom of a column than at the top. This is the term that stops the illusion reading as a row of separate flames, and it works because of where the eye finds the seams: it picks the individual columns out at their bases, where they are brightest and sharpest, so blurring exactly there dissolves them into one another while the fine filament structure higher up survives. It is also right physically, the hem being the part of an aurora seen through the deepest, most grazing column of scattering air. One disables it. The core is divided by the same factor it is widened by, so this redistributes light across the channel rather than adding any. It widens the QUAD by the same factor as well, making the card a trapezoid, which is both what keeps the widened profile from running off the side of its own card and the reason this is the most expensive knob here in fill rate: the overdraw near the hem goes up with it directly.',
        type: 'float', min: 1, max: 8, step: 0.05, value: 3.2, uniform: true,
      },
      {
        key: 'hemBlurSpan',
        label: 'hem blur reach',
        hint: 'How far up the column the blur persists, as a fraction of its height. Small keeps a soft foot under an otherwise crisp curtain; large blurs the whole thing into a wash with no filaments left anywhere.',
        type: 'float', min: 0.02, max: 1, step: 0.005, value: 0.42, uniform: true,
      },
      {
        key: 'scatter',
        label: 'halo',
        hint: 'How much of the wide scattered skirt sits under the core. This is light that left the channel and was redirected on its way to the eye, and it is what stops a sharp channel looking like it was cut out with scissors. It is also the cheapest way to make neighbouring columns overlap, because the skirt reaches far further than the core does.',
        type: 'float', min: 0, max: 4, step: 0.01, value: 2.1, uniform: true,
      },
      {
        key: 'skirtTight',
        label: 'halo tightness',
        hint: 'How quickly the scattered skirt falls off away from the channel. High keeps the glow hugging the core; low spreads it across the whole gap to the next channel and fills the sky with a soft wash. The hem blur widens this too, by its square, so the skirt stays outside the core rather than being swallowed by it as the bottom blurs. The default is DERIVED rather than chosen -- see the note below the group on how, and on why this is the knob that decides whether a row of columns reads as a curtain or as a fence.',
        type: 'float', min: 1, max: 200, step: 0.5, value: 12, uniform: true,
      },
    ],
  },
  {
    title: 'The emitting layer',
    open: false,
    params: [
      {
        key: 'altLow',
        label: 'hem altitude',
        hint: 'Where the bottom of the curtain sits, in kilometres. Real auroral hems sit near 100 km because that is where electrons of typical energy stop, and the sharpness of that border is the single feature the eye tracks most strongly.',
        type: 'float', min: 60, max: 220, step: 1, value: 111, uniform: true,
      },
      {
        key: 'altHigh',
        label: 'top altitude',
        hint: 'Where the emitting layer runs out, in kilometres. The gap between this and the hem is what the colour ramp is normalised against, so moving it re-scales where green becomes red without changing either colour.',
        type: 'float', min: 120, max: 500, step: 1, value: 345, uniform: true,
      },
      {
        key: 'hemSoft',
        label: 'hem softness',
        hint: 'How abruptly the curtain begins at its lower border. Very small values are the physically right answer and they are also where the aliasing lives, because a hard edge across a card that is nearly edge-on has no pixels to resolve it.',
        type: 'float', min: 0.002, max: 0.4, step: 0.001, value: 0.039, uniform: true,
      },
      {
        key: 'falloff',
        label: 'vertical falloff',
        hint: 'How fast the glow thins with height, standing in for the energy spectrum of the incoming electrons. High makes a low bright band; low makes tall columns that fade slowly and reach the red part of the ramp.',
        type: 'float', min: 0.2, max: 12, step: 0.02, value: 6.24, uniform: true,
      },
      {
        key: 'topFade',
        label: 'top fade start',
        hint: 'Where the fade to exactly zero begins, as a fraction of the column. It must reach zero at the card top or the card has a visible horizontal cut across it, and a real aurora has no top edge at all -- it dissolves.',
        type: 'float', min: 0.1, max: 0.99, step: 0.005, value: 0.775, uniform: true,
      },
      {
        key: 'ragged',
        label: 'ragged tops',
        hint: 'How much each column varies in height from its neighbours. Every card sharing one top altitude draws a dead flat ceiling across the whole sky, which is the tell that gave the polygon aurora away. Colour still keys off absolute altitude, so a short column stays the colour its height deserves.',
        type: 'float', min: 0, max: 0.9, step: 0.01, value: 0.34, uniform: true,
      },
      {
        key: 'hemWander',
        label: 'hem wander',
        hint: 'How much the lower border drifts up and down along a channel, as a fraction of the layer thickness. Small amounts read as the hem being a soft rope rather than a ruled line; large amounts break the channel into separate hanging columns.',
        type: 'float', min: 0, max: 0.5, step: 0.005, value: 0.05, uniform: true,
      },
    ],
  },
  {
    title: 'The auroral belt',
    open: false,
    params: [
      {
        key: 'beltAmt',
        label: 'belt strength',
        hint: 'How much the aurora is confined to a band rather than filling the whole sky. Mind the floor, which is one minus this: at strength one half the darkest part of the sky is still at half brightness, so anything short of one dims the southern sky rather than emptying it, and the aurora is genuinely everywhere. At one the belt term is the raw exponential and the sky away from the band goes properly dark, which is both what a real auroral oval does and what makes the band read as a band.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 1, uniform: true,
      },
      {
        key: 'beltOffset',
        label: 'belt distance',
        hint: 'How far north the centre of the belt sits, in kilometres. Negative is north. From underneath the belt you get a bright wall in one direction and empty stars in the other, which is what separates a photographed aurora from a procedural one.',
        type: 'float', min: -1200, max: 1200, step: 10, value: -450, uniform: true,
      },
      {
        key: 'beltWidth',
        label: 'belt width',
        hint: 'How wide the band is, in kilometres. Narrow gives a defined arc off on the horizon; wide gives an overhead sky with the fade only showing up behind you. Worth reading against the belt distance rather than on its own: a band wider than it is far has its near edge overhead and its far edge behind you, so no amount of belt strength will empty the southern sky.',
        type: 'float', min: 60, max: 1600, step: 10, value: 430, uniform: true,
      },
      {
        key: 'beltPow',
        label: 'belt edge',
        hint: 'The exponent on the belt falloff. A Gaussian belt has no shoulders and a real oval has a much harder poleward edge than equatorward one, so push this up for a flat lit top with defined sides.',
        type: 'float', min: 0.6, max: 8, step: 0.05, value: 2.6, uniform: true,
      },
    ],
  },
  {
    // Four scales of modulation in space and four in time, from a whole channel
    // over a minute down to a single flame in under a second. They are four
    // separate terms rather than one noise with more octaves because each one
    // needs its own time rate as well as its own size, and because the eye reads
    // them as different phenomena: a channel going out is weather, a swath
    // fading is a substorm breathing, a patch travelling is a beam moving, and
    // the flicker is the precipitation itself. Every one of them is indexed on
    // position along the channel and on the channel id, never on which card is
    // being drawn -- see the note in glsl.js on why that distinction is the
    // difference between a curtain and a picket fence.
    title: 'Which channels are lit, and when',
    open: false,
    params: [
      {
        key: 'gateAmt',
        label: 'channel gating',
        hint: 'How much whole channels switch on and off. Drawing every contour all of the time reads as a painted object; a real sky has two lit and four dark. This is also the cheapest knob in the file, because a fully gated column collapses to a degenerate quad and costs no pixels at all.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.44, uniform: true,
      },
      {
        key: 'gate',
        label: 'gate threshold',
        hint: 'How choosy the gating is. Higher leaves fewer channels lit, so the sky is usually empty and occasionally spectacular, which is honest to how auroras behave and is also frustrating to tune against. Drop it while working and raise it before judging.',
        type: 'float', min: 0, max: 0.9, step: 0.01, value: 0.39, uniform: true,
      },
      {
        key: 'patchAmt',
        label: 'patchiness',
        hint: 'How much a lit channel goes dark along its own length. Real arcs are not lit end to end; they burn in sections that come and go over a minute or two while the arc itself stays put.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 1, uniform: true,
      },
      {
        key: 'patch',
        label: 'patch scale',
        hint: 'How long a lit section is, in along-channel units. Low gives two or three long stretches per channel; high breaks it into a dotted line, which is the pulsating patch form.',
        type: 'float', min: 0.01, max: 3, step: 0.005, value: 1.635, uniform: true,
      },
      {
        key: 'patchDrift',
        label: 'patch drift',
        hint: 'How fast the lit sections travel along their own channel. This was zero for a long time without anybody noticing, and the sky read as painted rather than alive: the patches were in the right places and the right sizes and they simply never went anywhere. A real lit section is the footprint of a beam of electrons and the footprint moves, so this is the cheapest cue in the file that what you are watching is a process.',
        type: 'float', min: 0, max: 2, step: 0.005, value: 0.11, uniform: true,
      },
      {
        key: 'swathAmt',
        label: 'swath fade',
        hint: 'How strongly long stretches of a channel fade out and come back. This is the scale between a whole channel switching off and a single patch burning: hundreds of kilometres of one channel dimming away over tens of seconds while its neighbours stay lit. At one, a swath reaches genuine darkness rather than merely dimming, which is what lets part of the sky actually go out.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.7, uniform: true,
      },
      {
        key: 'swathScale',
        label: 'swath length',
        hint: 'How long a swath is, in along-channel units. Keep it roughly an order of magnitude below the patch scale. If the two get close they beat against each other and the result reads as one noisy modulation rather than as two structures at two different sizes, which is the whole point of having both.',
        type: 'float', min: 0.005, max: 1, step: 0.005, value: 0.15, uniform: true,
      },
      {
        key: 'swathSpeed',
        label: 'swath speed',
        hint: 'How fast the swath pattern drifts. Slow enough that you notice a region has gone dark rather than watching it go, which is how a substorm actually reads from the ground.',
        type: 'float', min: 0, max: 1, step: 0.005, value: 0.06, uniform: true,
      },
      {
        key: 'pulseAmt',
        label: 'flicker',
        hint: 'The fine chaotic pulsing of individual flames. It is the product of two noises drifting at rates with no common factor, so it is bright only where both agree, it spends most of its life dim, and it never repeats. A single noise modulated by a sine would have been cheaper and would have pulsed like a metronome, which is the one thing an aurora never does.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.55, uniform: true,
      },
      {
        key: 'pulseFreq',
        label: 'flicker scale',
        hint: 'How large a region flickers together, in along-channel units. This is the parameter most likely to alias, because it is the one deliberately pushed toward the card spacing: past about one cycle per two cards the flicker stops being resolved and starts reading as per-card noise, which is exactly the picket fence this technique has to stay clear of. Raise the card density before raising this.',
        type: 'float', min: 0.1, max: 12, step: 0.05, value: 2.6, uniform: true,
      },
      {
        key: 'pulseSpeed',
        label: 'flicker speed',
        hint: 'How fast the flicker runs. Along with the shimmer this is the fastest motion in the sky, and it should be: the fine structure of a real aurora changes several times a second while the arc it belongs to holds its shape for minutes.',
        type: 'float', min: 0, max: 6, step: 0.01, value: 1.35, uniform: true,
      },
    ],
  },
  {
    title: 'Flow and shimmer',
    open: false,
    params: [
      {
        key: 'rays',
        label: 'rays',
        hint: 'How strongly the curtain is striated into vertical rays. The noise is indexed on distance along the channel and contains no altitude term, because rays are magnetic field lines and a field line does not change with height. An altitude term here turns the whole sky into coloured fog.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.5, uniform: true,
      },
      {
        key: 'rayFreq',
        label: 'ray density',
        hint: 'How many rays per unit of along-channel distance. High is the fine picket structure of an active arc; low is a few broad bright columns. This is the along-channel term most likely to be asked for finer than the cards can carry, because one card holds one ray value: divide one by this times the along scale, the field scale and the coarsest card spacing to get the cards per ray, and under about five the rays stop being drawn and start aliasing into a fence. That ceiling moves when the along scale moves, so the two want checking together.',
        type: 'float', min: 0.2, max: 30, step: 0.1, value: 6.8, uniform: true,
      },
      {
        key: 'flowHue',
        label: 'flow amount',
        hint: 'How much the neon hue travels along a channel rather than sitting still. This is the declared magic of this world rather than physics, and it is what makes the aurora read as something flowing through the leylines.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 1, uniform: true,
      },
      {
        key: 'flowSpeed',
        label: 'flow speed',
        hint: 'How fast the hue travels along the channel. Slow is a tide; fast reads as a signal running down a wire, which is further from an aurora and closer to the leyline idea.',
        type: 'float', min: 0, max: 4, step: 0.01, value: 0.93, uniform: true,
      },
      {
        key: 'flowFreq',
        label: 'flow scale',
        hint: 'How long one cycle of hue is along a channel. Low gives one colour per channel that changes slowly; high gives bands of colour chasing each other down its length.',
        type: 'float', min: 0.02, max: 4, step: 0.01, value: 0.5, uniform: true,
      },
      {
        key: 'caustic',
        label: 'shimmer',
        hint: 'The water caustic trick, borrowed exactly: the difference of two noises drifting past each other at different rates, raised to a power. It is bright only where they nearly agree, which draws a moving net of filaments rather than a moving blur.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.5, uniform: true,
      },
      {
        key: 'causFreq',
        label: 'shimmer scale',
        hint: 'How fine the shimmer filaments are along the channel. This wants to sit near the ray density or the two interfere and the result reads as noise instead of as two separate structures.',
        type: 'float', min: 0.1, max: 12, step: 0.05, value: 1.4, uniform: true,
      },
      {
        key: 'causSpeed',
        label: 'shimmer speed',
        hint: 'How fast the two noise layers drift past each other. This is the fastest motion in the sky and it should be, because the fine structure of a real aurora changes in under a second while the arc itself holds for minutes.',
        type: 'float', min: 0, max: 3, step: 0.01, value: 0.35, uniform: true,
      },
      {
        key: 'causPow',
        label: 'shimmer contrast',
        hint: 'The exponent that turns the difference of the two noises into filaments. Low is a soft mottle; high is a sparse net of very bright threads with darkness between them.',
        type: 'float', min: 1, max: 16, step: 0.1, value: 4, uniform: true,
      },
    ],
  },
  {
    title: 'Facing',
    open: false,
    params: [
      {
        key: 'faceCam',
        label: 'column facing',
        hint: 'Blends each card between lying along its channel and yawing to face the eye. Full facing is the physically right impostor for a ray, because a column of gas is radially symmetric and looks the same from every azimuth, so a facing card can never vanish edge-on the way a fixed one does. There is no reason to run it below one except to see what a fixed card would have looked like.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 1, uniform: true,
      },
    ],
  },
  {
    title: 'Colour',
    open: false,
    params: [
      {
        key: 'pale',
        label: 'hardness',
        hint: 'How energetic the precipitation is. Harder electrons excite the nitrogen band systems alongside the atomic lines, whitening the 557.7 nm green toward mint and pulling the hem from violet toward electric blue. At zero this is the classic green and violet.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.25, uniform: true,
      },
      {
        key: 'hemBand',
        label: 'hem band',
        hint: 'Where the violet hem gives way to green, as a fraction of the layer. At the default layer this puts the crossover near 110 km, which is where the nitrogen ion emission actually stops being the brightest thing in the column.',
        type: 'float', min: 0.01, max: 0.6, step: 0.005, value: 0.12, uniform: true,
      },
      {
        key: 'crown',
        label: 'crown',
        hint: 'How much soft 630 nm red sits on top. It is clamped below full on purpose, because the green has to keep showing through the red rather than being replaced by it: both are emitted along the same line of sight and what reaches the eye is a sum.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.55, uniform: true,
      },
      {
        key: 'crownStart',
        label: 'crown start',
        hint: 'Where the red crown begins, as a fraction of the layer. Atomic oxygen red comes from above about 200 km because that is where the gas is thin enough for the slow transition to complete before a collision interrupts it.',
        type: 'float', min: 0.05, max: 0.95, step: 0.005, value: 0.42, uniform: true,
      },
      {
        key: 'neon',
        label: 'neon mix',
        hint: 'Blends the physical altitude ramp toward the invented flowing hue. The interesting sky is almost always between the two: full neon reads as a screensaver and full physics reads as the photograph everyone has already seen.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.22, uniform: true,
      },
      {
        key: 'neonSpread',
        label: 'neon spread',
        hint: 'How much of the colour wheel the neon ramp sweeps through. Narrowing it toward zero collapses the sweep to a duotone, which is where most of the good looking settings are.',
        type: 'float', min: 0, max: 1.5, step: 0.01, value: 1, uniform: true,
      },
      {
        key: 'neonShift',
        label: 'neon hue',
        hint: 'Rotates the neon ramp around the colour wheel. Worth sweeping slowly with the neon mix pushed up, then backing the mix off once a hue family has been found.',
        type: 'float', min: 0, max: 1, step: 0.005, value: 0.15, uniform: true,
      },
      {
        key: 'tint',
        label: 'tint',
        hint: 'A colour the whole sky is pulled toward, in linear space. Useful for matching the aurora to a world that already has a colour, rather than for choosing what the aurora itself is.',
        type: 'color', value: [0.55, 1, 0.82], uniform: true,
      },
      {
        key: 'tintAmt',
        label: 'tint amount',
        hint: 'How hard the tint is applied. Anything past about a third overwhelms the altitude ramp entirely and the physical colour argument stops applying to what you are looking at.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0, uniform: true,
      },
      {
        key: 'saturate',
        label: 'saturation',
        hint: 'Applied around Rec. 709 luma so pushing it does not change how bright the sky reads. Desaturating is as useful as saturating here, because a real aurora is far less saturated than any photograph of one.',
        type: 'float', min: 0, max: 2.5, step: 0.01, value: 1.05, uniform: true,
      },
    ],
  },
  {
    title: 'Exposure',
    open: false,
    params: [
      {
        key: 'gain',
        label: 'gain',
        hint: 'Overall brightness applied per column, before the profile. Distinct from exposure only in where it lands: this one is inside the gate test, so turning it down eventually collapses columns to degenerate quads and makes the sky cheaper as well as darker. What bounds it from above is no longer the depth of the stack -- the blend is a screen, so the SUM cannot clip however many columns cross a pixel -- but the brightness of ONE column, which is clamped to white in the shader before it composites. Push this until single cards clamp and the sky starts flattening into featureless white patches again, one card at a time. Measured at the shipped defaults: 0.3 pins two tenths of a percent of the lit pixels, 0.45 pins six percent, 0.9 pins a quarter of them.',
        type: 'float', min: 0, max: 4, step: 0.01, value: 0.3, uniform: true,
      },
      {
        key: 'exposure',
        label: 'exposure',
        hint: 'Overall brightness applied per pixel, after the profile. Use this one while tuning shape and gain when tuning how much of the sky is lit at all.',
        type: 'float', min: 0, max: 4, step: 0.01, value: 0.9, uniform: true,
      },
      {
        key: 'extinct',
        label: 'extinction',
        hint: 'How much the low channels are dimmed by the air their light crosses on the way in. Without it the far channels sit on the mountains as a hard bright line, which is the giveaway that the sky has no atmosphere in it.',
        type: 'float', min: 0, max: 1, step: 0.01, value: 0.8, uniform: true,
      },
      {
        key: 'horizonCut',
        label: 'horizon cut',
        hint: 'The elevation below which the extinction fade is complete. Slightly negative so the fade finishes just under the horizon rather than exactly on it, because a fade that ends on the horizon draws a visible seam along the skyline.',
        type: 'float', min: -0.3, max: 0.3, step: 0.005, value: -0.02, uniform: true,
      },
    ],
  },
]

export const SCENE_GROUPS = [
  {
    title: 'Scene',
    open: false,
    params: [
      {
        key: 'timeScale',
        label: 'time scale',
        hint: 'Multiplies the clock the shader animation runs on. Zero freezes the sky without pausing the renderer, which is the right way to inspect a single moment while still being able to orbit around it.',
        type: 'float', min: 0, max: 8, step: 0.01, value: 1, uniform: false,
      },
      {
        key: 'fov',
        label: 'field of view',
        hint: 'Vertical field of view in degrees. Worth remembering that a headset is near 100 degrees, so a sky judged at 60 will show more of itself and more of its horizon seams than expected once it gets there.',
        type: 'float', min: 25, max: 110, step: 1, value: 62, uniform: false,
      },
      {
        key: 'stars',
        label: 'stars',
        hint: 'Brightness of the star field behind everything. Turning it off makes faint aurora easier to judge; leaving it on is the honest test, because a real aurora competes with stars for the same dark adaptation.',
        type: 'float', min: 0, max: 2, step: 0.01, value: 1, uniform: false,
      },
    ],
  },
  {
    title: 'Mountains',
    open: false,
    params: BACKDROP_PARAMS,
  },
]

export function allGroups() {
  return CARD_GROUPS.concat(SCENE_GROUPS)
}

export function allParams() {
  const out = []
  for (const g of allGroups()) out.push(...g.params)
  return out
}

export function defaults() {
  const out = {}
  for (const p of allParams()) {
    out[p.key] = Array.isArray(p.value) ? p.value.slice() : p.value
  }
  return out
}

// Changing any of these re-runs the contour trace and rebuilds the instance
// buffers. Everything NOT in here is a live shader uniform, and the gate asserts
// the two sets never overlap -- see the header on why a knob that is both is a
// slider that stutters.
export const REBUILD_KEYS = new Set([
  'leyFreq', 'leyWarp', 'leyWarpFreq', 'leyMorph', 'leyBend', 'leyBendFreq',
  'fieldScale', 'fieldSeed', 'warpStages', 'traceTime',
  'gridN', 'spanKm', 'maxDistKm', 'cardSpacingKm', 'spacingFrac', 'smoothPasses',
  'minLenKm', 'widthMinKm', 'widthMaxKm',
])
