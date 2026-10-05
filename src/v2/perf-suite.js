// The perf trace's battery (perf-trace.js): which debug-panel toggles it takes
// away, in what groups, and how long it measures each. Edit this file to aim a
// trace -- comment a group out to drop it, add a group to chase a new suspect.
// Every key is a QUEST_TOGGLE_ROWS key in main.js, and a state lists only the
// rows it turns OFF; everything else stays as it was when the run started.

/** Ms thrown away after a state is applied (shader compiles, re-placement), then ms measured. */
export const SETTLE_MS = 1000
export const MEASURE_MS = 3000

/** A baseline is re-measured after this many states, so thermal drift can be divided out. */
export const BASELINE_EVERY = 3

/** A group whose removal saves at least this many median frame ms (mean of both rounds) is drilled into. */
export const DRILL_MIN_MS = 1
/** Cap on drilled states, so a run with many guilty groups still ends inside two minutes. */
export const MAX_DRILL = 6

const EVERYTHING = ['terrain', 'trees', 'boulders', 'grass', 'ferns', 'litter', 'animals', 'aurora', 'clouds', 'precip', 'water', 'reflections', 'fire']

// Each group is measured twice (forward, then reverse); its `drill` states
// once, and only when the group crossed DRILL_MIN_MS.
export const GROUPS = [
  {
    name: 'scatter', off: ['trees', 'boulders', 'grass', 'ferns', 'litter'],
    drill: [
      { name: 'trees', off: ['trees'] },
      { name: 'boulders', off: ['boulders'] },
      { name: 'grass', off: ['grass'] },
      { name: 'ferns', off: ['ferns'] },
      { name: 'litter', off: ['litter'] },
      { name: 'wind', off: ['wind'] },
    ],
  },
  {
    name: 'animals', off: ['animals'],
    drill: [
      { name: 'water critters', off: ['fish', 'frogs', 'crabs'] },
      { name: 'insects', off: ['butterflies', 'grasshoppers', 'fireflies', 'spiders'] },
      { name: 'wildlife', off: ['wildlife'] },
      { name: 'snowmen+leafkin', off: ['snowmen', 'leafkin'] },
      { name: 'dragons', off: ['dragons'] },
    ],
  },
  {
    name: 'sky+fire', off: ['aurora', 'clouds', 'precip', 'fire'],
    drill: [
      { name: 'aurora', off: ['aurora'] },
      { name: 'clouds', off: ['clouds'] },
      { name: 'precip', off: ['precip'] },
      { name: 'fire', off: ['fire'] },
    ],
  },
  { name: 'water', off: ['water', 'reflections'], drill: [{ name: 'reflections', off: ['reflections'] }] },
  // The floor: what a frame costs with the world taken away. Its per-stage laps (samples[].stages) and
  // waitMs say where that cost is when no layer is drawing; `floor+terrain` puts only the ground back.
  { name: 'everything', off: EVERYTHING, drill: [] },
  { name: 'floor+terrain', off: EVERYTHING.filter((k) => k !== 'terrain'), drill: [] },
]
