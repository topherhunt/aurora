import { TUNING, SNOW, SHRINK } from './sim/terrain-height.js'
import { ELEV_LOD, MIN_SPLIT_K, MAX_SPLIT_K, MAX_DEPTH } from './terrain/quadtree.js'
import { SLOT_COUNT } from './terrain/terrain.js'

// ---------------------------------------------------------------------------
// Live terrain tuning panel (desktop previewer only; `T` toggles it).
//
// This exists to close a vocabulary gap rather than to save typing. Describing
// a terrain fault in words -- "the median octave at fifteen metres or so has
// too much amplitude" -- requires knowing which constant that is, and the
// constants are named after what they DO (`ridgeGain`, `jagAmp`) rather than
// after the scale they act at. So every frequency knob here is labelled with
// its real-world wavelength, and every multi-octave layer is labelled with the
// full range it spans. "Backbone ridges, 345 m .. 86 m over 3 octaves" is a
// thing you can point at from inside the world.
//
// The wavelength is 1/(freq * SHRINK), NOT 1/freq: TUNING is expressed in
// pre-SHRINK units (see the header of terrain-height.js) and every number in
// this panel would otherwise be 2x wrong -- silently, and in the one direction
// that still looks plausible.
//
// terrain-height.js's own comments are not consistent about this, so the formula
// here was checked against the field rather than against them. Turning every
// layer off but one, forcing it to a single octave and measuring the mean
// distance between local maxima along a 16 km transect gives 678 m for massif
// (predicted 862), 154 m for ridge (172), 50 m for jag (59) and 38 m for detail
// (45) -- a consistent ~0.85x, which is what a 1D slice through isotropic 2D
// noise gives. The comments that quote 1/f instead ("~345 m backbone", "~1.7 km
// massifs", "a 5 km swell") are stating field units, i.e. twice the scale of the
// world she is standing in.
//
// Three destinations, and they behave differently, which is why knobs carry an
// explicit `src` rather than being looked up by name:
//
//   TUNING / SNOW -- the height field. Mutating them here updates the main
//     thread's TerrainHeight (same module instance, so collision and the
//     elevation pyramid follow immediately) but NOT the workers, which hold
//     their own module instances. Terrain.retune() ships them across and
//     re-streams the world; without that the mesh and the ground she stands on
//     would silently disagree.
//   ELEV_LOD / splitK -- selection only, main thread, no regeneration. A
//     reselect is enough, and it is instant.
//
// Props are NOT re-placed on a retune: scatter.js caches placements per chunk,
// so trees stay where the old height field put them until they stream out.
// That is a known cosmetic artefact of the tool, not of the terrain.
// ---------------------------------------------------------------------------

// A selection larger than this cannot be given slots: terrain's LRU refuses to
// evict anything currently rendering, so once `desired` approaches SLOT_COUNT
// the pool exhausts and _acquire throws. That is the correct behaviour for the
// engine -- it is a broken invariant -- but this panel's whole job is to let
// someone push ELEV_LOD.swing and splitK until something gives, and losing the
// session to an exception is a bad way to find the ceiling. So the panel backs
// splitK off instead and says so. SLOT_COUNT less the 21 pinned base-layer
// chunks, less a frame's worth of in-flight arrivals (2 workers x 6 deep).
const SELECT_BUDGET = SLOT_COUNT - 21 - 12

const k = (key, min, max, step, desc, opts = {}) => ({
  key,
  min,
  max,
  step,
  desc,
  ...opts,
})

// `src`: 'T' TUNING, 'S' SNOW, 'L' LOD (selection-only).
// `freq`: annotate with wavelength. `oct`: the companion octave-count key, so
// the annotation can report the whole span the layer covers. `amp`: the value is
// pre-SHRINK metres, so annotate with what it is worth in the world.
//
// Every knob carries a `desc`. Names like `valleyRelief` say what a constant is
// called, not what turning it does, and half of these layers are GATED by
// another knob in the same group -- an amplitude multiplied by a mask that is
// zero where you happen to be standing looks exactly like a broken slider. Where
// a knob depends on another, the description says which one, because that
// dependency is the whole reason the panel was confusing.
const GROUPS = [
  {
    title: 'Regional swell',
    src: 'T',
    note: 'One 2.6 km undulation under everything, over 4 octaves. `valleyLo` is the lowland floor: raise it and more of the world drops to heath, without lowering the peaks.',
    knobs: [
      k('baseFreq', 0.00005, 0.0008, 0.00001,
        'Size of the regional undulation: how far it is from one high region to the next. Lower = fewer, broader regions. Only reshuffles WHICH ground rises, so where the swell is floored (see valleyLo) it changes nothing.',
        { freq: true, octFixed: 4 }),
      k('valleyRelief', 0, 700, 5,
        'Metres the swell lifts ground where it is fully engaged. It MULTIPLIES the floored curve below, so it does exactly nothing wherever the swell sits under valleyLo -- as shipped that is 73% of the map, including the spawn. Lower valleyLo first and this knob comes alive.',
        { amp: true }),
      k('valleyLo', 0.2, 1.0, 0.01,
        'The lowland floor. Swell values below this flatten to exactly zero, so this single knob decides how much of the world is low heath. Raise for more lowland; lower to hand ground back to valleyRelief.'),
      k('valleyHi', 0.4, 1.4, 0.01,
        'Swell value at which the full valleyRelief is reached. A wider gap from valleyLo makes a longer, gentler climb out of the lowlands.'),
      k('valleyKnee', 0.02, 0.4, 0.01,
        'Rounds the join between flat lowland and the rise. Small values leave a visible crease around the rim of every basin.'),
      k('seaLevel', -50, 100, 1,
        'Flat metres added everywhere. Moves the whole world up or down relative to the snow line and the water level, which do not follow it.',
        { amp: true }),
    ],
  },
  {
    title: 'Mountain mask -- where ranges are at all',
    src: 'T',
    note: 'Gates every mountain layer below. `mountainFloor` is how much gets through where the mask says "no range here" -- 0 gives true empty basins.',
    knobs: [
      k('macroFreq', 0.0001, 0.002, 0.00001,
        'Size of the regions that contain mountains at all. Lower = fewer, larger ranges with wider empty country between them.',
        { freq: true, octFixed: 4 }),
      k('mountainMaskLo', 0, 1, 0.01,
        'Mask noise below this means "no range here". Raise it to shrink the mountainous fraction of the map.'),
      k('mountainMaskHi', 0, 1.2, 0.01,
        'Mask noise above this means a full-strength range. A narrow Lo..Hi gap gives hard-edged ranges, a wide one gives ranges that fade in over kilometres.'),
      k('mountainFloor', 0, 1, 0.01,
        'How much mountain still gets through where the mask says none. At 0.2 the ranges never fully switch off; 0 gives genuinely empty basins.'),
    ],
  },
  {
    title: 'Massifs (tier 1)',
    src: 'T',
    note: 'The big shapes: whole mountains, not their ridges.',
    knobs: [
      k('massifFreq', 0.0001, 0.003, 0.00001,
        'Spacing from one whole mountain to the next.',
        { freq: true, oct: 'massifOctaves' }),
      k('massifOctaves', 1, 6, 1,
        'How many finer copies ride on the massif shape. Each one halves the wavelength and carries half the amplitude, so the last octaves are subtle.'),
      k('massifRelief', 0, 800, 5,
        'Height of a full-strength massif. Scaled by the mountain mask above, so it does less in the low country and nothing at all if mountainFloor is 0 there.',
        { amp: true }),
      k('massifLo', 0, 1, 0.01,
        'Massif noise below this contributes nothing -- raises the fraction of the map that stays flat between mountains.'),
      k('massifHi', 0, 1.2, 0.01,
        'Massif noise that reaches full massifRelief. A narrow Lo..Hi gap gives steeper, more abrupt mountain flanks.'),
      k('massifSharp', 0.5, 3, 0.05,
        'Pointiness. Above 1 the summit stays put but the approach steepens, so the silhouette comes to a point; below 1 it domes. Acts only near the top, so valleys are untouched.'),
    ],
  },
  {
    title: 'Backbone ridges (tier 2)',
    src: 'T',
    note: 'Sub-peaks riding the massif flanks. `ridgeGain` is the octave falloff -- lower is smoother, higher is furrier at every scale at once.',
    knobs: [
      k('ridgeFreq', 0.0005, 0.008, 0.0001,
        'Spacing of the sub-peaks that ride the massif flanks -- one bump to the next along a backbone.',
        { freq: true, oct: 'ridgeOctaves' }),
      k('ridgeOctaves', 1, 6, 1,
        'How many halvings of that spacing are stacked on. More octaves = more small bumps on the big ones.'),
      k('mountainRelief', 0, 300, 5,
        'Height the ridges add on top of the massif they sit on.',
        { amp: true }),
      k('ridgeGain', 0.3, 0.75, 0.01,
        'Amplitude falloff per octave. Low is a smooth backbone; high is furry at every scale at once.'),
      k('ridgeLo', 0, 1, 0.01,
        'Ridge noise below this contributes nothing -- more flat saddle between sub-peaks.'),
      k('ridgeHi', 0, 1.2, 0.01,
        'Ridge noise that reaches full mountainRelief.'),
      k('ridgeKnee', 0.2, 1.2, 0.01,
        'Above this the ridge sum is compressed instead of clipped. Lower flattens summits; this is what stops peaks turning into mesas at exactly mountainRelief.'),
    ],
  },
  {
    title: 'Aretes -- knife-edge crests',
    src: 'T',
    note: 'A rare accent, not a global look: the mask is high on roughly a tenth of the map and even there the blend is partial.',
    knobs: [
      k('areteFreq', 0.0001, 0.002, 0.00001,
        'Size of the regions that get knife-edge crests instead of rounded ones.',
        { freq: true, octFixed: 2 }),
      k('areteAmount', 0, 1, 0.01,
        'Maximum blend toward the knife-edge form. 0 disables aretes everywhere; this is the master switch for the group.'),
      k('areteRound', 0, 0.5, 0.01,
        'Rounds the blade itself. 0 is a true edge; higher gives a crest you could stand on.'),
      k('areteLo', 0, 1, 0.01,
        'Mask threshold: noise below this gets no arete. Raise to make them rarer.'),
      k('areteHi', 0, 1.2, 0.01,
        'Mask threshold for a full-strength arete. Narrow Lo..Hi = abrupt transitions between rounded and knife-edged ranges.'),
    ],
  },
  {
    title: 'Summit jaggedness',
    src: 'T',
    note: 'Only fires above `jagLo` of the massif height, so it roughens crests without touching valley floors.',
    knobs: [
      k('jagFreq', 0.002, 0.03, 0.0005,
        'Size of the notches cut into a crest -- how close together the teeth are.',
        { freq: true, oct: 'jagOctaves' }),
      k('jagOctaves', 1, 6, 1,
        'How many finer sets of notches ride on the coarse ones.'),
      k('jagAmp', 0, 150, 1,
        'Depth of those notches where the mask is fully on. Multiplied by the jagLo/jagHi gate, so it does nothing below jagLo of massif height -- i.e. nothing anywhere you can comfortably walk.',
        { amp: true }),
      k('jagLo', 0, 1, 0.01,
        'Fraction of massif height below which no jag is applied at all. This is why valley floors stay smooth. Lower it to bring jaggedness down the mountain.'),
      k('jagHi', 0, 1.2, 0.01,
        'Fraction of massif height at which jag reaches full jagAmp.'),
    ],
  },
  {
    title: 'Cliff mosaic',
    src: 'T',
    note: 'Worley cells with a hard step at the boundary. The three gates MULTIPLY, so a cliff at half strength is not a small cliff -- it is a rounded one. `cliffGateLo/Hi` crispen the product back toward binary; `cliffLipPow` sharpens the lip itself (1 = rounded shoulder).',
    knobs: [
      k('cliffFreq', 0.001, 0.012, 0.0001,
        'Size of the plateau cells -- how far it is from one cliff band to the next.',
        { freq: true, cell: true }),
      k('cliffAmp', 0, 150, 1,
        'Height of the step at a cell boundary, before the gate. Multiplied by all three gates below, so it is zero on gentle or low ground no matter what you set here.',
        { amp: true }),
      k('cliffEdge', 0.01, 0.4, 0.005,
        'Width of the boundary band as a fraction of a cell. The whole drop happens across this, so halving it doubles the face angle: narrow is a lip you could fall off, wide is a slope.'),
      k('cliffLipPow', 1, 8, 0.1,
        'Shape of the lip within that band. 1 is a rounded shoulder; higher pushes the drop into the last metres and leaves a flat tread behind it.'),
      k('cliffLo', 0, 1, 0.01,
        'Gate 1: high-steep-ground below this gets no cliffs. Keeps lips off meadows, where a slope discontinuity is a step the player cannot take.'),
      k('cliffHi', 0, 1, 0.01,
        'Gate 1 upper end: high-steep-ground at or above this passes the gate fully.'),
      k('cliffGateLo', 0, 1, 0.01,
        'Applied to the PRODUCT of the three gates, to crispen it back toward on/off. Without this the product sits near 0.4 over huge areas and every cliff renders as a rounded bump instead of a real cliff somewhere.'),
      k('cliffGateHi', 0, 1, 0.01,
        'Product at or above this counts as a full-strength cliff. Pull Lo and Hi together for a binary "cliff or no cliff" map.'),
      k('cliffBreakFreq', 0.001, 0.02, 0.0005,
        'Gate 2: size of the regions that have a cliff mosaic at all. The mosaic is deliberately not everywhere.',
        { freq: true, octFixed: 2 }),
      k('cliffBreakLo', 0, 1, 0.01,
        'Break-mask noise below this means no mosaic in this region. This is the knob that was throttling the whole cliff layer to 4% strength.'),
      k('cliffBreakHi', 0, 1, 0.01,
        'Break-mask noise at which the mosaic is fully present.'),
    ],
  },
  {
    title: 'Creases and gullies',
    src: 'T',
    note: 'Slope breaks rather than more noise: a curvilinear network of ribs and gully edges. Kept up high on purpose -- a crease is a slope discontinuity, and the walkability check refuses steps across one.',
    knobs: [
      k('creaseFreq', 0.002, 0.04, 0.0005,
        'Spacing of the gully-and-rib network. This layer is ridged, which folds the field and halves what you actually see -- the label already accounts for that.',
        { freq: true, oct: 'creaseOctaves', ridged: true }),
      k('creaseOctaves', 1, 4, 1,
        'How many finer crease networks are laid over the coarse one.'),
      k('creaseAmp', 0, 25, 0.5,
        'Depth of the creases. Centred, so it cuts as often as it lifts and does not move mean elevation or the snow line. Multiplied by the high-ground mask below.',
        { amp: true }),
      k('creaseLo', 0, 1, 0.01,
        'High-ground value below which creases fade to creaseFloor. Raise to confine gullies to the highest rock.'),
      k('creaseHi', 0, 1, 0.01,
        'High-ground value at which creases reach full creaseAmp.'),
      k('creaseFloor', 0, 1, 0.01,
        'How much crease survives on low, gentle ground. Raise it and gullies reach the valleys -- and the walkability check starts refusing steps across the meadow.'),
    ],
  },
  {
    title: 'Surface detail',
    src: 'T',
    note: 'The metre-scale roughness, amplitude-masked by a slow variance field so meadows stay smooth and shattered ground stays shattered.',
    knobs: [
      k('detailFreq', 0.002, 0.04, 0.0005,
        'Size of the finest bumps -- the texture you see underfoot and on a near hillside.',
        { freq: true, oct: 'detailOctaves' }),
      k('detailOctaves', 1, 8, 1,
        'How many halvings of that size are stacked. The last few are below the mesh resolution and cost nothing visible.'),
      k('detailGain', 0.3, 0.7, 0.01,
        'Amplitude falloff per octave. Low leaves only the coarse bumps; high makes the surface grainy at every scale.'),
      k('detailMin', 0, 20, 0.1,
        'Roughness amplitude in the smoothest patches.',
        { amp: true }),
      k('detailMax', 0, 30, 0.1,
        'Roughness amplitude in the roughest patches. varianceFreq below decides how big those patches are.',
        { amp: true }),
      k('detailRock', 0, 1, 0.01,
        'How much detail is withheld from low, gentle ground. At 1 the valleys get almost none -- meadow underfoot, shattered rock up high.'),
      k('varianceFreq', 0.0001, 0.004, 0.0001,
        'Size of the patches that choose between detailMin and detailMax. This is what makes roughness vary from hillside to hillside instead of being uniform.',
        { freq: true, octFixed: 2 }),
    ],
  },
  {
    title: 'Terraces',
    src: 'T',
    note: 'Stepped contour benches. Uniform terracing looks like a wedding cake, so most of the world must not terrace at all -- hence the mask.',
    knobs: [
      k('terraceFreq', 0.0001, 0.002, 0.00001,
        'Size of the regions that get stepped benches.',
        { freq: true, octFixed: 2 }),
      k('terraceStep', 1, 30, 0.5,
        'Height of one bench, i.e. how far apart the treads are vertically.',
        { amp: true }),
      k('terraceStrength', 0, 1, 0.01,
        'How far the ground is pulled onto the steps. 0 disables the layer; 1 gives hard staircases. Master switch for the group.'),
      k('terraceLo', 0, 1, 0.01,
        'Mask noise below this gets no terracing. Raise to make benches rarer.'),
      k('terraceHi', 0, 1.2, 0.01,
        'Mask noise at which terracing is fully applied. The layer also fades out on summits so it does not fight the jag pass.'),
    ],
  },
  {
    title: 'Domain warp',
    src: 'T',
    note: 'Bends every layer above sideways, which is what stops ridges reading as noise laid on a grid.',
    knobs: [
      k('warpAmp', 0, 120, 1,
        'How far the ground is pushed sideways before every layer above is sampled. Zero makes ranges read as noise on a grid; too much smears them into swirls.',
        { amp: true }),
      k('warpFreq', 0.0005, 0.01, 0.0001,
        'Size of the warp swirls. Near the massif wavelength it bends whole ranges; much finer and it just adds wobble to their edges.',
        { freq: true, octFixed: 3 }),
    ],
  },
  {
    title: 'Snow line',
    src: 'S',
    note: 'COLOUR ONLY -- these do not move the ground, so the "here" readout is blank for them. Painted into vertex colours in the worker, so they still travel with a retune like the height knobs do.',
    knobs: [
      k('base', 0, 300, 1,
        'Mean snow-line elevation in world metres. Ground above it is white, below it is not. Compare against the elevation shown in the HUD.'),
      k('band', 5, 150, 1,
        'Vertical distance over which bare ground fades to full snow. Small is a crisp line; large is a long dirty-snow gradient.'),
      k('swing', 0, 80, 1,
        'How far the line wanders regionally, plus or minus around base, so it is not a perfect contour across the whole world.'),
      k('freq', 0.00005, 0.001, 0.00001,
        'Size of those regional wanderings.',
        { freq: true }),
    ],
  },
]

// Separate from GROUPS because nothing here regenerates terrain -- these only
// change which nodes get selected, so they apply on the next frame with no
// re-stream at all. That difference is worth keeping visible in the code.
const LOD_GROUP = {
  title: 'LOD -- where the triangles go',
  src: 'L',
  note: 'splitK is global detail (also on [ and ]). The swing rows redistribute it BY ELEVATION: at swing 1.0 the highest-ranked nodes of that size get one extra LOD level and the lowest-ranked lose one, so peaks refine and valleys coarsen at no extra cost. Depths 0-2 are structurally excluded (one node at depth 0, so a percentile is undefined). Depth 7 ships at 0 on purpose -- that ring is the ground underfoot, where shifting detail reads as popping. Watch `slots` below: the pool is a hard ceiling.',
  knobs: [
    k('splitK', MIN_SPLIT_K, MAX_SPLIT_K, 0.05,
      'Global detail. A node splits once the camera is within k times its own size, so raising this refines everything at once -- and the slot pool is a hard ceiling, so the panel will back it off again if the selection overruns.'),
    k('swing3', 0, 3, 0.05,
      'Elevation bias for 2048 m nodes: whole ranges vs whole basins.',
      { label: 'swing d3 (2048 m nodes)' }),
    k('swing4', 0, 3, 0.05,
      'Elevation bias for 1024 m nodes. 1.0 means the highest-ranked nodes of this size get a whole extra LOD level and the lowest lose one, at no net cost.',
      { label: 'swing d4 (1024 m nodes)' }),
    k('swing5', 0, 3, 0.05,
      'Elevation bias for 512 m nodes -- roughly the scale of one mountain flank, so this is the row that sharpens distant peaks.',
      { label: 'swing d5 (512 m nodes)' }),
    k('swing6', 0, 3, 0.05,
      'Elevation bias for 256 m nodes.',
      { label: 'swing d6 (256 m nodes)' }),
    k('swing7', 0, 3, 0.05,
      'Elevation bias for 128 m nodes. Ships at 0 on purpose: this ring is the ground underfoot, where shifting detail as you walk reads as popping.',
      { label: 'swing d7 (128 m nodes)' }),
    k('pivot', 0, 1, 0.05,
      'The elevation percentile that neither gains nor loses a level. 0.5 is the median node; lower it and more of the map counts as "high" and gets refined.',
      { label: 'pivot (rank that neither gains nor loses)' }),
  ],
}

const ALL_GROUPS = [LOD_GROUP, ...GROUPS]

function metres(m) {
  return m >= 1000
    ? `${(m / 1000).toFixed(2)} km`
    : m >= 10
      ? `${m.toFixed(0)} m`
      : `${m.toFixed(1)} m`
}

// Everything in TUNING is pre-SHRINK; the world is the field sampled at
// SHRINK x and divided by SHRINK. See the file header. This applies to the
// AMPLITUDES as well as the frequencies: `valleyRelief: 300` is 150 m of world.
const wavelength = (freq) => 1 / (freq * SHRINK)

// Where the sensitivity probe samples, in metres from the player: the point she
// is standing on, then rings at arm's length, at hillside scale, and at the far
// edge of what is legible. 13 points, because the probe costs 2 heightAt calls
// per point per knob and heightAt is the most expensive function in the project.
const PROBE_RINGS = [
  [0, 1],
  [40, 4],
  [150, 4],
  [500, 4],
]
// Re-probe once the player has walked far enough that the answer could differ.
const PROBE_MOVE = 200

const CSS = `
#tuner {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 20; width: 380px;
  overflow-y: auto; color: #cfe3ff; background: rgba(8,14,26,.94);
  border-left: 1px solid #2b4a72; font: 11px/1.45 monospace; padding: 8px 10px 40px;
}
#tuner h2 { font-size: 12px; color: #7fd1ff; margin: 0 0 6px; }
#tuner .t-note { color: #7f95b4; margin: 0 0 8px; }
#tuner .t-live { background: #0e1728; border: 1px solid #2b4a72; border-radius: 4px;
  padding: 6px 8px; margin-bottom: 8px; white-space: pre; }
#tuner .t-warn { color: #ff9a7a; }
#tuner .t-ok { color: #9dffb0; }
#tuner details { border-top: 1px solid #1e3253; padding: 4px 0; }
#tuner summary { cursor: pointer; color: #7fd1ff; padding: 3px 0; user-select: none; }
#tuner summary.t-dirty::after { content: ' *'; color: #ff9a7a; }
#tuner .t-knob { display: grid; grid-template-columns: 1fr 72px; gap: 4px 6px;
  align-items: center; margin: 5px 0 7px; }
#tuner .t-label { grid-column: 1 / 3; color: #cfe3ff; }
#tuner .t-desc { grid-column: 1 / 3; color: #7f95b4; margin: 1px 0 3px; }
#tuner .t-scale { color: #7f95b4; }
#tuner .t-here { color: #9dffb0; float: right; }
#tuner .t-dead { color: #ff9a7a; float: right; }
#tuner input[type=range] { width: 100%; accent-color: #7fd1ff; }
#tuner input[type=number] { width: 100%; background: #0e1728; color: #cfe3ff;
  border: 1px solid #2b4a72; border-radius: 3px; font: 11px monospace; padding: 2px 3px; }
#tuner .t-row { display: flex; gap: 6px; margin-bottom: 8px; }
#tuner button { flex: 1; background: #17304f; color: #cfe3ff; border: 1px solid #2b4a72;
  border-radius: 4px; font: 11px monospace; padding: 5px; cursor: pointer; }
#tuner button:hover { background: #1f4570; }
#tuner textarea { width: 100%; height: 110px; background: #0e1728; color: #9dffb0;
  border: 1px solid #2b4a72; border-radius: 3px; font: 10px monospace; margin-bottom: 8px; }
`

export class Tuner {
  // `height` is the MAIN THREAD's TerrainHeight -- the same instance the player
  // collides against, and the same module instance this panel mutates, so the
  // sensitivity probe measures the ground she is actually standing on.
  constructor(terrain, height) {
    this.terrain = terrain
    this.height = height
    this.probeAt = null // {x, z} the last probe was taken at
    this.visible = false
    // Retuning re-streams the whole world, so it must not fire on every tick of
    // a dragged slider. The number readout and the label update live; only the
    // regeneration waits.
    this.pending = false
    this.timer = 0
    this.message = ''
    this.knobs = [] // {knob, group, input, range, labelEl, defaultValue}

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    this.el = document.createElement('div')
    this.el.id = 'tuner'
    this.el.style.display = 'none'
    document.body.appendChild(this.el)

    this.el.appendChild(this._header())
    this.live = document.createElement('div')
    this.live.className = 't-live'
    this.el.appendChild(this.live)
    this.el.appendChild(this._buttons())
    this.out = document.createElement('textarea')
    this.out.readOnly = true
    this.out.style.display = 'none'
    this.el.appendChild(this.out)

    for (const g of ALL_GROUPS) this.el.appendChild(this._group(g))
  }

  _header() {
    const h = document.createElement('div')
    const t = document.createElement('h2')
    t.textContent = 'TERRAIN TUNER (T to close)'
    const n = document.createElement('p')
    n.className = 't-note'
    n.textContent =
      'Wavelengths and heights are real world metres. Every knob shows what nudging it is worth WHERE YOU ARE STANDING -- "no effect here" means the layer is gated off on this ground, not that the slider is broken; walk somewhere else or open the gate named in the description. Height changes re-stream every chunk (~1 s); LOD changes apply on the next frame. Nothing here is saved -- reload restores the file values, so copy anything worth keeping.'
    h.append(t, n)
    return h
  }

  _buttons() {
    const row = document.createElement('div')
    row.className = 't-row'

    const copy = document.createElement('button')
    copy.textContent = 'copy changed values'
    copy.onclick = () => this._copy()

    const reset = document.createElement('button')
    reset.textContent = 'reset all'
    reset.onclick = () => this._resetAll()

    row.append(copy, reset)
    return row
  }

  _group(g) {
    const d = document.createElement('details')
    const s = document.createElement('summary')
    s.textContent = g.title
    d.appendChild(s)
    g._summary = s
    // LOD open by default: it is the one section whose effect is visible without
    // knowing which constant you are looking for.
    if (g.src === 'L') d.open = true

    if (g.note) {
      const n = document.createElement('p')
      n.className = 't-note'
      n.textContent = g.note
      d.appendChild(n)
    }

    for (const knob of g.knobs) d.appendChild(this._knob(g, knob))
    return d
  }

  _knob(g, knob) {
    const wrap = document.createElement('div')
    wrap.className = 't-knob'

    const label = document.createElement('div')
    label.className = 't-label'
    wrap.appendChild(label)

    const desc = document.createElement('div')
    desc.className = 't-desc'
    desc.textContent = knob.desc
    wrap.appendChild(desc)

    const range = document.createElement('input')
    range.type = 'range'
    range.min = knob.min
    range.max = knob.max
    range.step = knob.step

    const num = document.createElement('input')
    num.type = 'number'
    num.step = knob.step

    wrap.append(range, num)

    const rec = { knob, group: g, range, num, label, def: this._read(g, knob) }
    this.knobs.push(rec)

    // The number box is deliberately NOT clamped to the slider range. The slider
    // range is a guess at what is useful; a value outside it is how you find out
    // the guess was wrong. The slider just pins to its end in that case.
    const onInput = (v) => {
      if (!Number.isFinite(v)) return // mid-edit ("-", "0.") -- wait for a real number
      this._write(g, knob, v)
      this._sync(rec)
      this._schedule(g)
    }
    range.oninput = () => onInput(parseFloat(range.value))
    num.oninput = () => onInput(parseFloat(num.value))

    this._sync(rec)
    return wrap
  }

  _read(g, knob) {
    if (g.src === 'T') return TUNING[knob.key]
    if (g.src === 'S') return SNOW[knob.key]
    if (knob.key === 'splitK') return this.terrain.splitK
    if (knob.key === 'pivot') return ELEV_LOD.pivot
    return ELEV_LOD.swing[Number(knob.key.slice(5))]
  }

  _write(g, knob, v) {
    if (g.src === 'T') TUNING[knob.key] = v
    else if (g.src === 'S') SNOW[knob.key] = v
    else if (knob.key === 'splitK') this.terrain.splitK = v
    else if (knob.key === 'pivot') ELEV_LOD.pivot = v
    else ELEV_LOD.swing[Number(knob.key.slice(5))] = v
  }

  // Push the model value back into both widgets and rewrite the label. Called
  // on every edit and on reset, so the two inputs can never drift apart.
  _sync(rec) {
    const { knob, group } = rec
    const v = this._read(group, knob)
    if (document.activeElement !== rec.num) rec.num.value = v
    rec.range.value = v
    rec.label.textContent = knob.label ?? knob.key

    if (knob.amp) {
      const w = document.createElement('span')
      w.className = 't-scale'
      w.textContent = `  --  ${v < 0 ? '-' : ''}${metres(Math.abs(v) / SHRINK)} in world`
      rec.label.appendChild(w)
    }

    if (knob.freq) {
      // Ridged layers take |noise|, which folds the field and halves the spacing
      // of what you actually see. Measured on a transect: creaseFreq's 38 m base
      // produces peaks 20 m apart.
      const w = wavelength(v) / (knob.ridged ? 2 : 1)
      const oct = knob.octFixed ?? (knob.oct ? this._read(group, { key: knob.oct }) : 1)
      const span =
        oct > 1
          ? `${metres(w)} .. ${metres(w / 2 ** (oct - 1))} over ${oct} oct`
          : knob.cell
            ? `${metres(w)} cells`
            : metres(w)
      const scale = document.createElement('span')
      scale.className = 't-scale'
      scale.textContent = `  --  ${span}`
      rec.label.appendChild(scale)
    }

    // What this knob is worth where she is standing. A layer whose gate is shut
    // on this ground reads as dead, which is the difference between "this slider
    // is broken" and "this slider is being multiplied by zero right here" -- the
    // one distinction the panel could not previously make. Appended last so it
    // floats right of everything else on the label line.
    if (rec.probe !== undefined) {
      const dead = rec.probe < 0.05
      const here = document.createElement('span')
      here.className = dead ? 't-dead' : 't-here'
      here.textContent = dead ? 'no effect here' : `+/-${metres(rec.probe)} here`
      rec.label.appendChild(here)
    }

    if (v !== rec.def) group._summary.classList.add('t-dirty')
  }

  // A frequency change moves the wavelength printed on its own octave-count
  // sibling and vice versa, so relabel the whole panel rather than tracking
  // which knobs are related to which.
  _relabel() {
    for (const g of ALL_GROUPS) g._summary.classList.remove('t-dirty')
    for (const rec of this.knobs) this._sync(rec)
  }

  // Sensitivity probe: nudge each knob a little in BOTH directions, re-evaluate
  // the height field around the player, and report the larger of the two mean
  // absolute changes.
  //
  // Both directions matters and is not symmetry for its own sake. valleyRelief
  // and valleyLo are both dead upward on floored ground -- raising the floor
  // when you are already under it changes nothing -- but LOWERING valleyLo is
  // exactly the move that brings that ground back to life. A one-sided probe
  // would report the two knobs identically and point at neither.
  //
  // The nudge is relative to the current value where there is one, so a knob is
  // measured at the scale it is actually set to rather than at the scale of a
  // slider range this file guessed at.
  _probe(x, z) {
    if (!this.height) return
    const pts = []
    for (const [r, n] of PROBE_RINGS)
      for (let i = 0; i < n; i++) {
        const a = ((i + 0.5) / n) * Math.PI * 2
        pts.push(x + Math.cos(a) * r, z + Math.sin(a) * r)
      }
    const h0 = []
    for (let i = 0; i < pts.length; i += 2) h0.push(this.height.heightAt(pts[i], pts[i + 1]))

    const drift = () => {
      let sum = 0
      for (let i = 0; i < h0.length; i++)
        sum += Math.abs(this.height.heightAt(pts[i * 2], pts[i * 2 + 1]) - h0[i])
      return sum / h0.length
    }

    for (const rec of this.knobs) {
      // LOD knobs pick which nodes get triangles and SNOW knobs pick a colour.
      // Neither moves the surface, so a height probe would libel both as dead.
      if (rec.group.src !== 'T') {
        rec.probe = undefined
        continue
      }
      const v = this._read(rec.group, rec.knob)
      const d = Math.max(rec.knob.step, v !== 0 ? Math.abs(v) * 0.15 : (rec.knob.max - rec.knob.min) * 0.05)
      this._write(rec.group, rec.knob, v + d)
      const up = drift()
      this._write(rec.group, rec.knob, v - d)
      const down = drift()
      this._write(rec.group, rec.knob, v)
      rec.probe = Math.max(up, down)
    }
    this.probeAt = { x, z }
    this._relabel()
  }

  _schedule(g) {
    this._relabel()
    if (g.src === 'L') {
      // Selection-only: no regeneration, so there is nothing to debounce.
      this.terrain.invalidate()
      return
    }
    this.pending = true
    this.timer = performance.now() + 250
  }

  _resetAll() {
    for (const rec of this.knobs) this._write(rec.group, rec.knob, rec.def)
    for (const g of ALL_GROUPS) g._summary.classList.remove('t-dirty')
    this._relabel()
    this.terrain.invalidate()
    this._apply()
    this.message = 'reset to file values'
  }

  _apply() {
    const tuning = {}
    const snow = {}
    for (const rec of this.knobs) {
      if (rec.group.src === 'T') tuning[rec.knob.key] = TUNING[rec.knob.key]
      if (rec.group.src === 'S') snow[rec.knob.key] = SNOW[rec.knob.key]
    }
    // Everything is sent, not just the changed keys: the workers are stateful,
    // and after several rounds of edits "what has changed since the last send"
    // is a bookkeeping problem with a silent failure mode. A full table is ~90
    // numbers, once per quarter second at most.
    this.terrain.retune({ tuning, snow })
    this.pending = false
    this.probeAt = null // every knob's sensitivity is measured against the new field
  }

  // Only what moved, and labelled with the object it lives in -- the point is to
  // be pasteable back into the source, and three of these tables are in two
  // different files.
  _copy() {
    const bucket = { T: {}, S: {}, L: {} }
    for (const rec of this.knobs) {
      const v = this._read(rec.group, rec.knob)
      if (v !== rec.def) bucket[rec.group.src][rec.knob.key] = v
    }
    const lines = []
    const dump = (name, o) => {
      const keys = Object.keys(o)
      if (keys.length) lines.push(`${name}:`, ...keys.map((key) => `  ${key}: ${o[key]},`))
    }
    dump('TUNING (terrain-height.js)', bucket.T)
    dump('SNOW (terrain-height.js)', bucket.S)
    dump('LOD (quadtree.js ELEV_LOD / terrain splitK)', bucket.L)
    const text = lines.length ? lines.join('\n') : '(nothing changed from the file values)'

    this.out.style.display = 'block'
    this.out.value = text
    this.out.select()
    // Clipboard access is permission-gated and fails outright on a non-secure
    // origin, so the textarea is the real answer and the clipboard write is the
    // convenience. Reporting the failure matters -- silently not copying looks
    // identical to copying.
    navigator.clipboard?.writeText(text).then(
      () => (this.message = 'copied to clipboard'),
      (e) => (this.message = `clipboard refused (${e.name}) -- text is selected above`)
    )
  }

  toggle() {
    this.visible = !this.visible
    this.el.style.display = this.visible ? 'block' : 'none'
    this.probeAt = null // re-measure on open: she has moved since last time
  }

  // Called every frame from the main loop, with the player's head position --
  // the probe is a question about the ground she is standing on, so it needs to
  // know where that is.
  update(pos) {
    if (this.pending && performance.now() >= this.timer) this._apply()

    // Re-probe when the panel opens, after a retune (every sensitivity may have
    // changed), and once she has walked far enough for the answer to differ.
    // Never per frame: 75 knobs x 13 points x 2 directions is ~1950 heightAt
    // calls, measured at 5 ms -- a third of a 72 Hz frame, fine as an event and
    // not fine every frame.
    if (this.visible && pos && this.height) {
      const p = this.probeAt
      if (!p || Math.hypot(pos.x - p.x, pos.z - p.z) > PROBE_MOVE) this._probe(pos.x, pos.z)
    }

    // The overflow guard. Runs whether or not the panel is open, because [ and ]
    // reach splitK too, and a crash is no better for having been triggered by a
    // key instead of a slider.
    const st = this.terrain.stats
    if (st.desired > SELECT_BUDGET && this.terrain.splitK > MIN_SPLIT_K) {
      this.terrain.splitK = Math.max(MIN_SPLIT_K, this.terrain.splitK - 0.05)
      this.terrain.invalidate()
      this.message = `selection hit ${st.desired} leaves against a ${SELECT_BUDGET} budget -- splitK backed off to ${this.terrain.splitK.toFixed(2)}`
      this._relabel()
    }

    if (!this.visible) return

    const pool = (st.slots / SLOT_COUNT) * 100
    const poolClass = pool > 90 ? 't-warn' : pool > 75 ? '' : 't-ok'
    this.live.innerHTML =
      `leaves  ${st.desired} selected / ${st.rendered} drawn   pending ${st.pending}\n` +
      `tris    ${(st.tris / 1000).toFixed(1)}k over ${st.rendered} chunks   gen ${st.lastGenMs.toFixed(1)}ms\n` +
      `<span class="${poolClass}">slots   ${st.slots}/${SLOT_COUNT}  (budget ${SELECT_BUDGET} leaves)</span>\n` +
      `splitK  ${this.terrain.splitK.toFixed(2)}   depth<=${MAX_DEPTH}` +
      (this.message ? `\n<span class="t-warn">${this.message}</span>` : '')
  }
}
