// The cave's region looks (design/39-caves.md §6): what makes one stretch of tunnel recognisable from another. Each is a rock colour pair, a floor colour, how thickly it is dressed, and the landmark its biggest chamber holds.
//
// Colours are albedo, linear, in the terrain's range (chunk-mesh-v2 C_ROCK is 0.085): the torch is the only light, and a brighter albedo reads as glare under it.

export const PALETTES = [
  { name: 'grey rocky', rock: [0.085, 0.084, 0.082], vein: [0.05, 0.05, 0.052], floor: [0.07, 0.068, 0.064], tites: 0.5, mush: 0.15, glow: 0.15, ruins: 0, rubble: 1, landmark: 'pillar' },
  { name: 'dusty brown', rock: [0.11, 0.075, 0.048], vein: [0.07, 0.048, 0.03], floor: [0.12, 0.085, 0.055], tites: 0.25, mush: 0.1, glow: 0.05, ruins: 0.2, rubble: 0.6, landmark: 'arch' },
  { name: 'blue-grey mushroom', rock: [0.06, 0.07, 0.085], vein: [0.04, 0.045, 0.06], floor: [0.055, 0.06, 0.07], tites: 0.3, mush: 1, glow: 0.7, ruins: 0, rubble: 0.4, landmark: 'giant' },
  { name: 'pale limestone', rock: [0.16, 0.155, 0.14], vein: [0.11, 0.105, 0.095], floor: [0.13, 0.125, 0.115], tites: 1, mush: 0.1, glow: 0.1, ruins: 0, rubble: 0.5, landmark: 'column' },
  { name: 'old ruin', rock: [0.09, 0.08, 0.07], vein: [0.06, 0.055, 0.05], floor: [0.085, 0.078, 0.07], tites: 0.2, mush: 0.25, glow: 0.2, ruins: 1, rubble: 0.8, landmark: 'colonnade' },
  { name: 'rust red', rock: [0.12, 0.055, 0.04], vein: [0.08, 0.035, 0.028], floor: [0.1, 0.06, 0.045], tites: 0.45, mush: 0.2, glow: 0.3, ruins: 0.1, rubble: 0.7, landmark: 'pillar' },
  { name: 'green damp', rock: [0.055, 0.075, 0.06], vein: [0.035, 0.05, 0.04], floor: [0.05, 0.065, 0.05], tites: 0.6, mush: 0.6, glow: 0.45, ruins: 0, rubble: 0.3, landmark: 'giant' },
]

// The three glows a mushroom gives off, as emitted light (not albedo).
export const GLOWS = [
  [0.1, 0.35, 0.9],
  [0.15, 0.85, 0.35],
  [0.6, 0.2, 0.85],
]
