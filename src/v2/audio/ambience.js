// ---------------------------------------------------------------------------
// Ambience: the rules for what the world sounds like where she is standing.
// Reads a WorldSense sample (sense.js) and the frame's few facts from main.js
// (head, daylight, submersion, her speed), and tells a SoundEngine
// (sound-engine.js) what to fire and what to keep looping. No three, no DOM:
// the gate drives it with a fake engine and a scripted sense.
//
// Two kinds of sound. ONE-SHOTS fire on a timer that only counts while their
// rule holds and is re-rolled when the rule first becomes true, so crossing a
// snowline never lands a raptor on the exact step; every one-shot is pitched
// 0.9x-1.1x and given its own volume so the same clip twice is not a machine
// gun. LOOPS (brook, leaves, lake bed, wind, rain, underwater, the cave bed, a
// fiddle a house, a campfire a hearth, a crackle a lit torch) are held by _loop():
// started when their rule turns on, stopped when it turns off, level and
// bearing refreshed every update.
//
// DIRECTION IS PROXY FOR PLACE. A bird has no position in the world, so it is
// given one: a random bearing at a plausible range and height, and the panner
// does the rest. A frog and a shore have real positions and use them.
//
// THE ANIMALS ARE READ EVERY FRAME, not through the sense: a footfall is timed
// to the gait clip a body is playing, and a quarter-second sample would put it
// a beat off. Each layer lists its living bodies through bodies(), and the
// ambience keeps a record per body: for a herd (wildlife, snowmen) a phase
// clock against the FOOTFALLS of its clip library, so a gallop lands as a
// gallop and a trot as a trot, and for a species with a call (the fox) the
// seconds to its next one; for the crawlers (crabs) the moving ones together
// hold one quiet loop at the nearest, and a startler (a spider, silent on its
// feet) that takes fright plays the same clip once. What she hears of each is
// the body's size at its distance. The dragons are read the same way, and are given the engine's FAR
// treatment (sound-engine.js `distance`): a wingbeat a cycle of the fly clip
// while one flies near, a roar every minute or so from one in the air anywhere
// in the valley, dulled, washed, late and echoed off the hills by its metres
// and, being on the score (sim/score.js), at the same world second in every
// client in the room rather than when each first walked into earshot,
// a growl over and over, each at its own pitch with its own pause, from one
// resting on its nest, and a heavy tread on each footfall of its walk clip
// from one pottering on the ground. The songbird bed is the only other thing given it:
// its birds are placed across the valley and sound like it. The fish and her own
// strokes are all that is heard on the water bus: a swoosh from each that sets off fast
// (the layer's startled()) near her head, its loudness and pitch by its length.
// The grasshoppers (bodies() lists the ones the layer shows) each chirp the
// cricket clip now and then from where they sit, by day as well as by night:
// at night they are the near crickets, real bodies on the ground under the
// unplaced far bed, so a snowfield or a lake has the bed and nothing beside her.
// ---------------------------------------------------------------------------

import { clamp, smoothstep } from '../../sim/mathx.js'
import { Score, CHAPTER_S } from '../../sim/score.js'
import { WorldSense, SENSE_HZ, SHORE_REACH, FROG_REACH } from './sense.js'

/** Every clip the ambience uses, by the name the rules call it. Paths are public/-relative like every other asset. */
export const SOUNDS = {
  eat: 'sounds/action-eat.mp3',
  zoom: 'sounds/effect-zoom.mp3',
  crow: 'sounds/bird-crow.mp3',
  eagle: 'sounds/bird-eagle.mp3',
  hawk: 'sounds/bird-hawk.mp3',
  owl: 'sounds/bird-owl-hoot-1.mp3',
  woodpecker: 'sounds/bird-woodpecker.mp3',
  songbird1: 'sounds/bird-songbird-1.mp3',
  songbird2: 'sounds/bird-songbird-2.mp3',
  songbird3: 'sounds/bird-songbird-3.mp3',
  songbird4: 'sounds/bird-songbird-4.mp3',
  songbird5: 'sounds/bird-songbird-5.mp3',
  songbird6: 'sounds/bird-songbird-6.mp3',
  cricket: 'sounds/cricket.mp3',
  footstep: 'sounds/footstep-1.mp3',
  footfall: 'sounds/footstep-animal.mp3',
  tread: 'sounds/footstep-animal-large.mp3',
  foxYip: 'sounds/animal-fox-yip.mp3',
  deerGrunt: 'sounds/animal-deer-grunt.mp3',
  crawl: 'sounds/footstep-spider.mp3',
  // The leafkin (render/leafkin.js): its one-shots by the names its voices() says, its panting among them.
  leafkinChatter1: 'sounds/npc-leafkin-chatter-1.mp3',
  leafkinChatter2: 'sounds/npc-leafkin-chatter-2.mp3',
  leafkinChatter3: 'sounds/npc-leafkin-chatter-3.mp3',
  leafkinChatter4: 'sounds/npc-leafkin-chatter-4.mp3',
  leafkinSqueal: 'sounds/npc-leafkin-squeal-delight.mp3',
  leafkinScream: 'sounds/npc-leafkin-scream.mp3',
  leafkinWhimper: 'sounds/npc-leafkin-whimper.mp3',
  panting: 'sounds/npc-leafkin-panting.mp3',
  // A townsperson's scream as it flees a dragon (render/townsfolk.js SCREAMS).
  humanScreamMan1: 'sounds/npc-human-scream-man-1.mp3',
  humanScreamMan2: 'sounds/npc-human-scream-man-2.mp3',
  humanScreamWoman1: 'sounds/npc-human-scream-woman-1.mp3',
  humanScreamWoman2: 'sounds/npc-human-scream-woman-2.mp3',
  humanScreamChild1: 'sounds/npc-human-scream-child-1.mp3',
  humanScreamChild2: 'sounds/npc-human-scream-child-2.mp3',
  // A bone friend's (render/skeletons.js).
  skeletonRattle: 'sounds/skeleton-rattle.mp3',
  skeletonClack: 'sounds/skeleton-clack.mp3',
  skeletonCollapse: 'sounds/skeleton-collapse.mp3',
  skeletonReassemble: 'sounds/skeleton-reassemble.mp3',
  skeletonCrunch: 'sounds/skeleton-crunch.mp3',
  skeletonGiggle: 'sounds/skeleton-giggle.mp3',
  skeletonWhimper: 'sounds/skeleton-whimper.mp3',
  // A hob weevil's cry (render/hobs.js).
  hobCry: 'sounds/animal-hob-weevil-cry.mp3',
  // A frost strider's calls (render/striders.js, wild-striders.js), the flutter of its fidget, and its whine.
  striderChirp1: 'sounds/strider-chirp-1.mp3',
  striderChirp2: 'sounds/strider-chirp-2.mp3',
  striderFlutter: 'sounds/strider-flutter.mp3',
  striderWhine: 'sounds/strider-whine.mp3',
  // Her hurt by a blow or a fall (main.js harm).
  thud: 'sounds/interact-thud.mp3',
  // Her sword landing a cut and a blow landing on her shield (main.js updateCombatSounds, harm).
  slash1: 'sounds/combat-sword-slash-1.mp3',
  slash2: 'sounds/combat-sword-slash-2.mp3',
  slash3: 'sounds/combat-sword-slash-3.mp3',
  clang1: 'sounds/combat-shield-clang-1.mp3',
  clang2: 'sounds/combat-shield-clang-2.mp3',
  clang3: 'sounds/combat-shield-clang-3.mp3',
  croak1: 'sounds/frog-croak-1.mp3',
  croak2: 'sounds/frog-croak-2.mp3',
  frogBoing: 'sounds/animal-frog-boing.mp3',
  splash: 'sounds/water-splash-small.mp3',
  rockslide1: 'sounds/rockslide1.mp3',
  rockslide2: 'sounds/rockslide2.mp3',
  underwater: 'sounds/underwater-1.mp3',
  swoosh: 'sounds/underwater-swoosh.mp3',
  brook: 'sounds/water-babbling-brook-1.mp3',
  lakeBed: 'sounds/water-lapping-quiet-1.mp3',
  wave: 'sounds/water-lapping-wave-1.mp3',
  leaves: 'sounds/wind-leaves-rustling-1.mp3',
  wind: 'sounds/wind-blowing-1.mp3',
  rain: 'sounds/weather-rain-1.mp3',
  wingbeat: 'sounds/dragon-wings-flapping.mp3',
  roar: 'sounds/dragon-roar.mp3',
  growl: 'sounds/dragon-growl.mp3',
  fiddle: 'sounds/ambience-violin-playing.mp3',
  drums: 'sounds/npc-yeti-drums.mp3',
  campfire1: 'sounds/ambience-campfire-1.mp3',
  campfire2: 'sounds/ambience-campfire-2.mp3',
  campfire3: 'sounds/ambience-campfire-3.mp3',
  campfire4: 'sounds/ambience-campfire-4.mp3',
  door: 'sounds/building-door-opening.mp3',
  caveBed: 'sounds/ambience-cave-default.mp3',
  cave1: 'sounds/ambience-cave-1.mp3',
  cave2: 'sounds/ambience-cave-2.mp3',
  cave3: 'sounds/ambience-cave-3.mp3',
  caveDrip: 'sounds/ambience-cave-droplet.mp3',
  // The menu's and the hand's, played by main.js; the ambience never fires them.
  uiOpen: 'sounds/ui-open-backpack.mp3',
  uiClose: 'sounds/ui-close-backpack.mp3',
  uiPop: 'sounds/ui-pop.mp3',
  flaregun: 'sounds/ui-flaregun-shoot.mp3',
  extinguish: 'sounds/action-extinguish.mp3',
}

const LAKE_MOVING_S = 0.5
const LAKE_STILL_S = 5
// Metres from the last shore search that count as moving.
const LAKE_MOVED_M = 0.5
const RAPTORS = ['crow', 'eagle', 'hawk']
const SONGBIRDS = ['songbird1', 'songbird2', 'songbird3', 'songbird4', 'songbird5', 'songbird6']
const CROAKS = ['croak1', 'croak2']
const ROCKSLIDES = ['rockslide1', 'rockslide2']
const CAMPFIRES = ['campfire1', 'campfire2', 'campfire3', 'campfire4']
const CAVE_TAKES = ['cave1', 'cave2', 'cave3']
// What still sounds underground (Ambience._underground); everything else is the overworld's.
const CAVE_LOOPS = new Set(['underwater', 'cave', 'caveRiver', 'cavePool', 'blaze'])
const CAVE_TIMERS = new Set(['footstep', 'stroke', 'caveSwap', 'caveDrip'])
// No boulders under her feet: the rockslide scatter is the overworld's talus.
const CAVE_SENSE = WorldSense.blank()

/** Every one-shot's pitch range; a clip never plays at exactly its recorded speed twice. */
export const RATE = [0.9, 1.1]

/**
 * Where in a gait cycle each foot lands, by clip library and gait, as a
 * fraction of the clip: the `phases` of tools/creatures/anim/clips/<library>/
 * <gait>.json, distinct and in order, so two feet that land together (a trot's
 * diagonal pairs) are one beat. The gate holds these to the clip files.
 */
export const FOOTFALLS = {
  quadruped: { walk: [0, 0.25, 0.5, 0.75], trot: [0, 0.5], run: [0, 0.2, 0.5, 0.7], hop: [0, 0.4], bound: [0, 0.52] },
  human: { walk: [0, 0.5], run: [0, 0.5], 'run-carry': [0, 0.5] },
  wyvern: { walk: [0, 0.5], run: [0, 0.5] },
  bird: { walk: [0, 0.5], run: [0, 0.5] },
}

/**
 * The numbers the rules run on. Intervals and gains are [lo, hi] ranges rolled
 * uniformly; `range` is how far off a placed sound sits, `elev` its angle above
 * the ear in degrees. Exported so the gate asserts against the same values.
 */
export const RULES = {
  // Crow, eagle and hawk: by day, above the snowline, or high on a hillside with a cliff within earshot.
  raptor: { interval: [15, 45], gain: [0.3, 0.8], range: [25, 40], elev: [20, 60], cliffTan: 1.0, cliffBand: 120, light: 0.4 },
  // The perched birds sit in the trees: each thins to nothing across its `aloft` band of metres her head is above the ground, and its clock stops past the top.
  // Owl: night, in dense wood, below the snow.
  owl: { interval: [12, 35], gain: [0.3, 0.7], range: [8, 25], elev: [10, 40], dark: 0.3, forest: 0.75, aloft: [20, 30] },
  // Woodpecker: a single burst, sporadic, anywhere there is wood at any hour and altitude.
  woodpecker: { interval: [20, 70], gain: [0.3, 0.8], range: [8, 30], elev: [10, 45], forest: 0.5, aloft: [20, 30] },
  // Songbirds, by day below the snow: a constant far chatter all around her, each bird placed `range` metres out and given that as its `distance` through the engine's far treatment (sound-engine.js), so it is dull and washed the way a bird across the valley is...
  songbirdFar: { interval: [1, 4], gain: [0.03, 0.1], range: [60, 150], elev: [5, 30], light: 0.4, forestSpeedup: 0.5, aloft: [20, 30] },
  // ...and now and then one in the tree beside her, dry and crisp. The wood is fuller of both: each clock runs up to `forestSpeedup` faster inside it.
  // The near bird's gap is rolled with `skew` (rand^skew across `interval`): most gaps are short, a few are the better part of two minutes, so it never settles into a beat.
  songbirdNear: { interval: [8, 100], skew: 2, gain: [0.4, 0.8], range: [4, 15], elev: [10, 50], light: 0.4, forestSpeedup: 0.5, aloft: [20, 30] },
  // Which songbird sings, far or near: `bias` of the time one heard in the last `recent` seconds, so the same few voices come and go rather than all six chiming in at random; the rest of the time any of the six.
  songbirdVoice: { recent: 15, bias: 0.5 },
  // The cricket bed: a steady low chirp on a cadence, everywhere below the snow after dusk. The crickets are in the grass, so it thins to nothing across the `aloft` band of metres her head is above the ground. The ones beside her are the grasshoppers (chirp).
  cricketBed: { interval: [1.5, 3], gain: [0.08, 0.2], dusk: 0.5, aloft: [12, 20] },
  // Her own feet. A teleport is worth `teleport[0]` seconds of walking at zero range, `teleport[1]` at full. Underground each step sends `cave` of itself into the cave's echo (SoundEngine CAVE_TAPS).
  footstep: { interval: [0.4, 0.6], gain: [0.5, 1.0], minSpeed: 0.3, teleport: [1, 2], cave: 0.6 },
  // Her own strokes while swimming, in place of her feet: the swoosh every `interval` seconds while moving past footstep.minSpeed, and once on each teleport. Under the water it is on the water bus as recorded; at the surface on the near bus, bright (SoundEngine BRIGHT) since the clip is muffled, with the small splash at `splash` gain.
  stroke: { interval: [2, 6], gain: [0.4, 0.7], splash: [0.3, 0.5] },
  // The animals' feet: every walking, trotting or running body within `reach` lands a step on each beat of its gait (FOOTFALLS), each within `jitter` of a cycle of its beat. A `size`-metre body at `near` metres or closer plays at `level` and at rate 1 (a hare at arm's length, a quarter as loud as her own step); the level grows with the body's length up to `max` and falls off as near/distance, and the rate falls as (size/length)^deep, so a stag is slower and deeper than a hare. `gain` is the roll on top. A rule with `air` (here and on a voice rule) gets the engine's far treatment at its true distance, dulled and wetted as though `air` times as far, so a far one reads as far and not as quiet and near. A rule with `edge` fades its steps out over the last `edge` metres to nothing at the reach, as a voice rule's do, rather than stopping at a level still heard.
  footfall: { reach: 40, near: 1, size: 0.5, level: 0.25, max: 1, deep: 0.5, jitter: 0.1, gain: [0.7, 1.0] },
  // A villager's or a townsman's feet on the same clock, her own footstep clip: at `level` and rate 1 for a `size`-metre body at `near` m, so a leafkin's step is lighter and higher than a man's.
  villagerStep: { reach: 20, edge: 10, near: 1, size: 1.7, level: 0.5, max: 0.6, deep: 0.3, jitter: 0.1, gain: [0.7, 1.0], air: 3 },
  // A strider's feet on the same clock, the large animal's step: at `level` and rate 1 for a `size`-metre body at `near` m.
  stride: { reach: 80, edge: 40, near: 2, size: 2.2, level: 0.5, max: 0.7, deep: 0.5, jitter: 0.1, gain: [0.7, 1.0], air: 3 },
  // A stag's hooves: the strider's tread quieter, given the far treatment as though `far` metres further off (dulled and wetted, and that much late at the speed of sound).
  hoof: { reach: 40, near: 2, size: 2.2, level: 0.25, max: 0.3, deep: 0.5, jitter: 0.1, gain: [0.7, 1.0], far: 15 },
  // A snowman's: the same tread deeper and louder, carrying farther, so a 2-6 m body thuds where a strider steps.
  thud: { reach: 60, near: 3, size: 1.2, level: 0.8, max: 1, deep: 0.8, jitter: 0.1, gain: [0.8, 1.0] },
  // A green giant's (render/giants.js): the thud louder, carrying farther, deeper still for a 9 m body, and `echo` of it sent into the valley echo.
  giantThud: { reach: 80, near: 6, size: 1.2, level: 1.6, max: 1.6, deep: 0.95, jitter: 0.05, gain: [0.85, 1.0], echo: 0.6 },
  // A fox within `reach` yips every `every` seconds, walking or not: `level` up to `near` metres off, falling as near/distance past it.
  foxYip: { reach: 40, near: 4, level: 0.7, every: [40, 120], gain: [0.7, 1.0] },
  // A stag within `reach` grunts every `every` seconds, the same way. The clip is mastered 21 dB hotter than the yip, which is why the level is low.
  deerGrunt: { reach: 25, near: 4, level: 0.25, every: [20, 60], gain: [0.7, 1.0] },
  // The crawlers' feet: one quiet loop while any crab within `reach` is moving, at the nearest, its level the sum of each one's near/distance, capped at 1. A crawler or startler that takes fright (a layer's startled()) plays the clip once, from where it is, at `startle` times the level.
  crawl: { reach: 6, near: 1, level: 0.075, startle: 1, gain: [0.6, 1.0] },
  // A voiced layer's one-shots (a leafkin's chatter, panting, squeal, scream, whimper), each from where the body is, within `reach`: `level` up to `near` metres off, falling as near/distance and fading out over the last `edge` metres to nothing at the reach. The wild forager is heard across its wood before it is seen, so its reach runs past its cull...
  voice: { reach: 60, near: 5, edge: 10, level: 0.8, gain: [0.8, 1.0], walled: true },
  // ...and a glade's villagers, a dozen within earshot of each other, are heard across its pond, not across its wood.
  villagerVoice: { reach: 10, near: 2, edge: 5, level: 0.8, gain: [0.8, 1.0], walled: true },
  // A green giant's scream as a flare sets it cowering: the leafkin's, slowed (giants.js SCREAM_RATE), heard across the labyrinth and its wood, `echo` of it into the valley echo.
  giantScream: { reach: 80, near: 8, edge: 20, level: 1.0, gain: [0.9, 1.0], echo: 0.5 },
  // A townsperson's scream fleeing a dragon, heard across the town.
  humanScream: { reach: 50, near: 4, edge: 15, level: 0.9, gain: [0.85, 1.0] },
  // A hob weevil's cry: at half volume up close, carrying as far as a villager's voice.
  hobCry: { reach: 10, near: 2, edge: 5, level: 0.5, gain: [0.8, 1.0] },
  // A strider's chirp or fidget flutter, heard across a town's rails.
  striderCall: { reach: 60, near: 3, edge: 30, level: 0.6, gain: [0.8, 1.0], air: 3 },
  // A tamed stag's or hare's contented grunt as it eats from her hand (wildlife.js voices()), pitched up; the grunt is mastered hot.
  contented: { reach: 15, near: 2, edge: 5, level: 0.25, gain: [0.8, 1.0] },
  // A stag's cry as it bolts from her (wildlife.js voices()): its grunt, heard as the herd's grunt is.
  alarm: { reach: 25, near: 4, edge: 8, level: 0.25, gain: [0.7, 1.0] },
  // A villager's door as it goes in or comes out, heard farther than its voice. The clip is mastered 23 dB hotter than the chatter, which is why the level is low.
  door: { reach: 30, near: 2, edge: 15, level: 0.3, gain: [0.8, 1.0], air: 3 },
  // Each frog within reach croaks on average once per `every` seconds; the croak fades linearly to nothing at FROG_REACH.
  frog: { every: 16, gain: [0.4, 1.0] },
  // A frog's hop (frogs.js voices()), heard only within arm's reach or so and quietly: the clip is mastered 8 dB hotter than the chatter.
  frogHop: { reach: 3, near: 1, edge: 1.5, level: 0.15, gain: [0.7, 1.0] },
  // A frog staying at the bug in her hand croaks as it hops in place (frogs.js STAY), as loud as a croak from the banks.
  frogCroak: { reach: 15, near: 2, edge: 5, level: 0.8, gain: [0.7, 1.0] },
  // Something landing in the water from the air: a frog hopping in off the bank (frogs.js voices()) or a fish falling back from its leap (fish-leap.js voices()). A drop from her hand is main.js's own, off hands.js splash.
  splash: { reach: 30, near: 3, edge: 8, level: 0.6, gain: [0.7, 1.0] },
  // Each grasshopper the layer shows within `reach` chirps the cricket clip on average once per `every` seconds, day or night: `level` up to `near` metres off, falling as near/distance past it. A dozen sit within reach on a meadow, so one is heard every few seconds over the night bed.
  chirp: { reach: 8, near: 1, level: 0.5, every: 60, gain: [0.5, 1.0] },
  // The dragons, every sound at its body's distance through the engine's far treatment. Its wings, while it flies within `reach`: one beat a cycle of its fly clip, within `jitter` of a cycle of the beat, at `level` up to `near` metres off and falling as near/distance past it, the clip slowed to `rate` so a beat is deep, not a pigeon's.
  wingbeat: { reach: 50, near: 5, level: 0.5, jitter: 0.05, rate: [0.5, 0.6], gain: [0.7, 1.0] },
  // A flying dragon roars every `every` seconds, heard within `reach`: `level` up to `near` off, falling as (near/distance)^roll past it, and fading out over the last `edge` metres of the reach; `echo` is its send into the valley echo. The clip is mastered 24 dB hotter than the yip, which is why the level is low. A dragon after the fish in her hand (dragons.js `menace`) roars as it takes notice and every `menace` seconds after.
  roar: { reach: 250, near: 20, roll: 1.0, edge: 50, level: 0.4, every: [30, 90], menace: [6, 15], echo: 0.8, gain: [0.7, 1.0] },
  // A dragon resting on its nest growls over and over within `reach`: each growl at a rate rolled in `rate`, then a pause of `pause` seconds; `level` up to `near` off, falling as near/distance.
  growl: { reach: 25, near: 3, level: 0.5, rate: [0.8, 1.05], pause: [0.5, 3], gain: [0.6, 1.0] },
  // A dragon walking on the ground within `reach` lands a tread on each beat of its gait (FOOTFALLS.wyvern), within `jitter` of a cycle of the beat: `level` up to `near` off, falling as near/distance.
  tread: { reach: 60, near: 4, level: 0.7, jitter: 0.05, gain: [0.7, 1.0] },
  // A dragon landing to chase (dragons.js `aggro`) comes down with the tread slowed to `rate` and sent `echo` into the valley echo, heard within `reach`.
  stamp: { reach: 100, near: 10, level: 1.0, rate: 0.55, echo: 0.9, gain: [0.8, 1.0] },
  // A rockslide off in the talus when there are this many loose rocks within the sense box: placed `range` metres out on the ground and up to `rise` above it, full volume within `near` metres of her head and falling as near/distance past it, so it fades as she climbs or flies above the field, and unheard past `reach`, and given its metres as the engine's far treatment, so it is dull and washed the way a slide across the scree is...
  rockslideNear: { interval: [20, 60], gain: [0.025, 0.075], range: [10, 30], rise: [0, 10], near: 10, reach: 60, minBoulders: 6 },
  // ...and a scatter of stones under her own feet, `chance` per second while she moves across a boulder.
  rockslideFoot: { chance: 0.15, gain: [0.075, 0.175] },
  // Lake: a wave every so often from the shore while one is within `reach` of her, on land or wading, and her head within `height` of the water; open water with no shore in reach is silent, since waves lap on a shore. Full volume up to `near` metres off the shore or above the surface, fading to nothing at the reach or the height, and the shot is given its metres as the engine's far treatment, so a distant shore is dull and washed rather than quiet at her ear.
  wave: { interval: [2, 5], gain: [0.3, 0.8], reach: 20, near: 3, height: 20 },
  lakeBed: { level: 0.5, gain: [0.6, 1.0] },
  // Brook: a loop from the river while her head is within `reach` metres of its shore, horizontally and up, full volume up to `near` and falling to `far` of it at the reach.
  brook: { reach: 10, near: 2, far: 0.2, level: 0.9, gain: [0.7, 1.0] },
  // Leaves: the wood's canopy, heard from the ground; it thins to nothing across the `aloft` band of metres her head is above the ground.
  leaves: { on: 0.5, off: 0.4, full: 0.8, level: 0.7, gain: [0.6, 1.0], aloft: [12, 20] },
  // Wind: a quiet loop that rises across the `snow` band of metres about the snowline, or the `height` band of metres her head is above the ground, whichever is stronger; the weather's cover raises the floor of that by `cover` at full overcast (§10).
  wind: { snow: [-30, 30], height: [10, 30], on: 0.05, off: 0.02, level: 0.35, gain: [0.5, 1.0], cover: 0.6 },
  // Rain: a loop at `level` times the share of the fall that is rain, precip times how far she is under the snow line's `sleet` band (the precip draw's band, check-ambience pins them equal); snow is silent, so on a summit the loop is off (§10). The patter is the drops on the ground and the leaves, so it thins to nothing across the `aloft` band of metres her head is above the ground and is off above it.
  rain: { on: 0.02, off: 0.01, level: 0.35, sleet: [-60, 60], aloft: [2, 20], gain: [0.7, 1.0] },
  underwater: { level: 0.5, gain: [0.8, 1.0] },
  // Underground, dry: the cave bed loops on the near bus (the house walls are not the rock), and every `swap` seconds one pass of it is one of CAVE_TAKES instead. The clips are mastered ~18 dB hotter than the brook, which is why the level is low.
  cave: { level: 0.3, gain: [0.8, 1.0], swap: [30, 60] },
  // A drop into the cave's water every `interval` seconds while a pool, sump or river is heard, from the nearest of them: `level` up to `near` metres off, falling as near/distance past it.
  // The brook's loop from the nearest point of a cave river, and the glades' lapping bed from a pool's or sump's, within `reach` metres of her head (main.js asks CaveWalk.nearestWater that far): full up to `near`, fading to nothing at the reach. On the near bus, since a cave stands the air bus behind the house's walls.
  caveRiver: { reach: 10, near: 2, level: 0.9, gain: [0.7, 1.0] },
  cavePool: { reach: 10, near: 3, level: 0.5, gain: [0.6, 1.0] },
  caveDrip: { interval: [10, 15], near: 3, level: 0.4, gain: [0.7, 1.0] },
  // A violin playing inside a house (village.js FIDDLE, the room's fiddlers()), heard through the wall: a loop of its own per house, placed `ear` metres over the floor, on within `reach` metres of the trunk's wall, at `level` up to `near` off it and falling as near/distance past, fading to nothing over the last `edge` metres. The wall is a low-pass: its cutoff `cutoff[0]` Hz at the reach opening to `cutoff[1]` at the wall, so it comes clearer as she nears and never clear. The rate is held at 1 (a tune drifting in pitch is a tune out of tune) and the level walks little. Each fiddler plays now and then, a spell of `play` seconds (one to three times through the 15 s tune) after a rest of `rest`, and is never heard while she is indoors.
  fiddle: { ear: 1.5, reach: 6, near: 1.5, edge: 2, level: 0.3, cutoff: [500, 2200], gain: [0.9, 1.0], play: [15, 45], rest: [120, 300] },
  // A labyrinth's drums (design/41-palisade-labyrinths.md), looped from its middle while she is within `reach` metres of its outline and has not yet stood in its middle: `near` 0 at the reach to 1 at the middle's edge walks the level from `level[0]` to `level[1]` and the low-pass from `cutoff[0]` to `cutoff[1]` Hz, both geometrically, so far off they are a distant thump, and the rate (pitch with it) linearly from `rate[0]` to `rate[1]`. `span` is the clip's two whole bars in seconds, looped exactly (LoopVoice `exact`); the clip runs on into a third it cuts short.
  drums: { reach: 20, level: [0.015, 0.3], cutoff: [220, 9000], rate: [0.8, 1], gain: [0.9, 1.0], span: [772 / 24000, (772 + 39047) / 24000] },
  // A fire burning in a hearth (hearth.js, the room's campfires): a loop of its own per fire over CAMPFIRES, the takes in no order, placed at the flame, on within `reach` metres of it, at `level` up to `near` off and falling as near/distance past, fading to nothing over the last `edge` metres. Not on the world clock and not synced: two players by one fire hear two crackles.
  campfire: { reach: 16, near: 1.5, edge: 2, level: 0.25, gain: [0.8, 1.0] },
  // The flames a spark lit and the torches she and peers carry (wildfire.js): ONE loop over CAMPFIRES, placed at the nearest flame, each flame within `reach` metres adding its share of `level` (falling as near/distance, to nothing over the last `edge` metres) so more flames are louder, the sum's square root held under `cap`: a torch in the hand is faint, a blaze of dozens reaches level * cap. On the near bus, so the walls a house or a cave stands her behind (SoundEngine.setIndoors) do not smother the torch in her hand.
  blaze: { reach: 25, near: 1.5, edge: 5, level: 0.01875, cap: 8, gain: [0.8, 1.0] },
  // A torch (lamps.js, the room's lamps, a wick in a dish): the campfire's takes again, a loop a torch placed at its flame, quieter and low-passed at `cutoff` Hz so the pops are gone and a soft crackle is left, the level scaled by how lit the torches are (0..1, off by day) and by her distance as a campfire's.
  torch: { reach: 4, near: 0.8, edge: 1.5, level: 0.08, cutoff: 1800, gain: [0.8, 1.0] },
  // A fish setting off fast (the fish layer's startled()) within `reach` of her head swooshes once, on the water bus, from where it is: a `size`-metre fish at `near` metres or closer plays at `level` and at rate 1, the level growing with its length up to `max` and falling off as near/distance, the rate falling as (size/length)^deep, so a pike is a slow deep rush and a glimmerfin a flick. `gain` is the roll on top.
  swoosh: { reach: 8, near: 1, size: 0.5, level: 0.5, max: 1, deep: 0.5, gain: [0.7, 1.0] },
}

const DEG = Math.PI / 180

/** A rule's far treatment for a shot `d` metres off: `far` metres more than it is, or `air` times as dull at its true metres, or none. */
const farOf = (R, d) => ({ ...(R.far !== undefined ? { distance: d + R.far } : R.air !== undefined ? { distance: d, air: R.air } : {}), ...(R.echo === undefined ? {} : { echo: R.echo }) })

export class Ambience {
  /**
   * @param engine  a SoundEngine (or the gate's fake): play, loop, setSubmerged, update.
   * @param sense   a WorldSense (or the gate's scripted one): sample(hx, hy, hz, out).
   * @param voiced    the layers whose one-shots are heard, each { layer, rule, bus }: layer.voices(into) drains them (a one-shot's optional `rate` and `gain` scale its roll), `rule` names their RULES entry (voice, villagerVoice), or a one-shot's own `rule` does (door); `bus` 'near' keeps them out of the house's walls (a leafkin at home), else `air`.
   * @param herds     the layers of animals whose feet are heard, each { layer, clips, calls, steps, bus, sound, rule }: layer.bodies(into) lists its living bodies (x, y, z, size, clip, cycle, speed), `clips` names their library in FOOTFALLS, `calls`, if any, maps a species key (body.sp.key) to the rule of its call, `bus` is as a voiced layer's, and `sound` and `rule` their step (footfall and RULES.footfall unless named), or `steps`, keyed by species, a species' own { sound, rule }.
   * @param crawlers  the layers whose moving bodies together hold the crawl loop: each has bodies(into) listing x, y, z and speed, and may have startled(into), listing the bodies that took fright this frame.
   * @param startlers the layers heard only when one takes fright (the spiders, silent on their feet): each has startled(into).
   * @param dragons   the dragon layer, if any: bodies(into) lists x, y, z, state ('roost' on the nest), clip ('fly' in the air) and cycle (the clip's length) on each.
   * @param fish      the fish layer, if any: startled(into) lists the fish that set off fast this frame, x, y, z and size (length in metres) on each.
   * @param grasshoppers  the grasshopper layer, if any: bodies(into) lists the ones it is showing, x, y, z on each.
   * @param waves     false where the water is a pond too small for a wave to break on its shore (a village's lake): the lapping bed loops and the wave one-shot never fires.
   * @param fiddlers  the houses with a violin playing inside, if any: `[{ x, y, z, r }]`, each its floor and its trunk's radius (RULES.fiddle).
   * @param campfires the fires burning, if any: `[{ x, y, z }]`, each its flame (RULES.campfire).
   * @param hearth    the flame of the hearth in the house she is in, `{ x, y, z }` or null, heard as a campfire.
   * @param torches   the room's torches, if any: `{ at: [{ x, y, z }], lit }`, each flame's position and lit() how lit they all are now, 0..1 (RULES.torch).
   * @param drums     drums(head): the labyrinth drums heard at her head, `{ x, y, z, near }` (RULES.drums), or null.
   */
  constructor({ engine, sense, rand = Math.random, herds = [], crawlers = [], startlers = [], dragons = null, fish = null, grasshoppers = null, voiced = [], waves = true, fiddlers = [], campfires = [], torches = null, blaze = () => [], hearth = () => null, drums = () => null }) {
    if (!engine) throw new Error('Ambience: missing engine')
    for (const v of voiced) {
      if (!v?.layer || typeof v.layer.voices !== 'function') throw new Error('Ambience: a voiced layer needs voices()')
      if (!RULES[v.rule]?.edge) throw new Error(`Ambience: a voiced layer's rule ${v.rule} is no voice rule`)
    }
    if (!sense) throw new Error('Ambience: missing sense')
    if (dragons && typeof dragons.bodies !== 'function') throw new Error('Ambience: the dragon layer needs bodies()')
    if (fish && typeof fish.startled !== 'function') throw new Error('Ambience: the fish layer needs startled()')
    if (grasshoppers && typeof grasshoppers.bodies !== 'function') throw new Error('Ambience: the grasshopper layer needs bodies()')
    for (const h of herds) {
      if (!h.layer || typeof h.layer.bodies !== 'function') throw new Error('Ambience: a herd needs a layer with bodies()')
      if (!FOOTFALLS[h.clips]) throw new Error(`Ambience: no footfalls for a ${h.clips} clip library`)
      for (const s of [h, ...Object.values(h.steps || {})]) {
        if (s.sound !== undefined && (!SOUNDS[s.sound] || !RULES[s.rule]?.deep)) throw new Error(`Ambience: a herd's step ${s.sound} needs a sound and a footfall rule, not ${s.rule}`)
      }
      for (const rule of Object.values(h.calls ?? {})) if (!RULES[rule]?.every) throw new Error(`Ambience: no call rule named ${rule}`)
    }
    for (const l of crawlers) if (!l || typeof l.bodies !== 'function') throw new Error('Ambience: a crawler layer needs bodies()')
    for (const l of startlers) if (!l || typeof l.startled !== 'function') throw new Error('Ambience: a startler layer needs startled()')
    for (const h of fiddlers) if (!h || ![h.x, h.y, h.z, h.r].every(Number.isFinite) || !(h.r > 0)) throw new Error('Ambience: a fiddler is { x, y, z, r }, r positive')
    for (const f of campfires) if (!f || ![f.x, f.y, f.z].every(Number.isFinite)) throw new Error('Ambience: a campfire is { x, y, z }')
    if (torches) {
      if (!Array.isArray(torches.at) || typeof torches.lit !== 'function') throw new Error('Ambience: torches are { at: [{ x, y, z }], lit() }')
      for (const f of torches.at) if (!f || ![f.x, f.y, f.z].every(Number.isFinite)) throw new Error('Ambience: a torch is { x, y, z }')
    }
    this.engine = engine
    this.sense = sense
    this.rand = rand
    this.herds = herds
    this.crawlers = crawlers
    this.startlers = startlers
    this.dragons = dragons
    this.fish = fish
    this.grasshoppers = grasshoppers
    this.voiced = voiced
    this.waves = waves
    // Each herd body within reach: body -> { clip, phase, beat, at, call, seen }. See _herds.
    this.bodies = new Map()
    // Each dragon within reach of any of its sounds: body -> { beating, phase, at, roar, roarAt, growling, growl, gait, step, beat, land, seen }. See _dragons.
    this.wings = new Map()
    // When each dragon roars: a chapter of gaps rolled from the dragon's own key, so two clients standing together hear the one roar rather than counting their own timers down from whenever each walked into earshot. Only the idle cadence is scored -- a menacing dragon is off the score entirely (render/dragons.js), and its roars are timed below.
    this.roars = new Score((key, chapter, rand) => {
      const [lo, hi] = RULES.roar.every
      const phrases = []
      let t = 0
      while (t < CHAPTER_S) {
        const dur = lo + rand() * (hi - lo)
        phrases.push({ dur })
        t += dur
      }
      return phrases
    }, { cap: 32 })
    this.listed = []
    this.frame = 0
    this.s = WorldSense.blank()
    this.sensed = false
    this.lakeAt = -Infinity
    this.lakeX = 0
    this.lakeZ = 0
    this.senseLeft = 0
    this.wet = false
    this.teleportCredit = 0
    this.teleported = false
    // Seconds of ambience run, and the clock each songbird clip last sang at (RULES.songbirdVoice).
    this.clock = 0
    this.sang = {}
    // One-shot timers by rule name: { armed, left }.
    this.timers = {}
    for (const k of ['raptor', 'owl', 'woodpecker', 'songbirdFar', 'songbirdNear', 'cricketBed', 'footstep', 'stroke', 'rockslideNear', 'wave', 'caveSwap', 'caveDrip']) {
      this.timers[k] = { armed: false, left: 0 }
    }
    this.loops = {
      caveRiver: engine.loop('brook', { bus: 'near', directional: true, gain: RULES.caveRiver.gain }),
      cavePool: engine.loop('lakeBed', { bus: 'near', directional: true, gain: RULES.cavePool.gain }),
      underwater: engine.loop('underwater', { bus: 'water', gain: RULES.underwater.gain }),
      brook: engine.loop('brook', { directional: true, gain: RULES.brook.gain }),
      lakeBed: engine.loop('lakeBed', { directional: true, gain: RULES.lakeBed.gain }),
      leaves: engine.loop('leaves', { gain: RULES.leaves.gain }),
      wind: engine.loop('wind', { gain: RULES.wind.gain }),
      rain: engine.loop('rain', { gain: RULES.rain.gain }),
      crawl: engine.loop('crawl', { directional: true, gain: RULES.crawl.gain }),
      cave: engine.loop('caveBed', { bus: 'near', gain: RULES.cave.gain, next: () => { const take = this.caveTake; this.caveTake = null; return take } }),
    }
    // The take the cave bed plays for its next pass in place of itself, or null (RULES.cave.swap).
    this.caveTake = null
    // One muffled loop a fiddler, under its own key in `loops` so _loop and dispose hold it like the rest.
    this.fiddlers = fiddlers.map((h, i) => {
      this.loops[`fiddle${i}`] = engine.loop('fiddle', { directional: true, muffle: true, rate: [1, 1], drift: 0, gain: RULES.fiddle.gain })
      return { key: `fiddle${i}`, x: h.x, y: h.y + RULES.fiddle.ear, z: h.z, r: h.r, playing: false, left: this.rand() * RULES.fiddle.rest[1] }
    })
    // One loop a campfire, over all four takes.
    this.campfires = campfires.map((f, i) => {
      this.loops[`campfire${i}`] = engine.loop(CAMPFIRES, { directional: true, gain: RULES.campfire.gain })
      return { key: `campfire${i}`, x: f.x, y: f.y, z: f.z }
    })
    // One muffled loop a torch, over the same takes, its cutoff fixed at construction.
    this.torchLit = torches ? torches.lit : () => 0
    this.torches = (torches ? torches.at : []).map((f, i) => {
      this.loops[`torch${i}`] = engine.loop(CAMPFIRES, { directional: true, muffle: true, gain: RULES.torch.gain })
      this.loops[`torch${i}`].setCutoff(RULES.torch.cutoff)
      return { key: `torch${i}`, x: f.x, y: f.y, z: f.z }
    })
    this.blaze = blaze
    this.loops.blaze = engine.loop(CAMPFIRES, { bus: 'near', directional: true, gain: RULES.blaze.gain })
    // On the near bus: it burns in the room she is in, not through the walls.
    this.hearth = hearth
    this.loops.hearth = engine.loop(CAMPFIRES, { directional: true, bus: 'near', gain: RULES.campfire.gain })
    this.blazeAt = { x: 0, y: 0, z: 0 }
    this.drums = drums
    this.loops.drums = engine.loop('drums', { directional: true, muffle: true, exact: RULES.drums.span, rate: [1, 1], drift: 0, gain: RULES.drums.gain })
    this.leavesOn = false
    this.hushed = false
    this.windOn = false
    this.rainOn = false
    // How many times each clip has fired; window.v2ambience.fired at the console.
    this.fired = {}
  }

  /** The room is gone: every loop stopped and given back to the engine. The one-shots already playing run out on their own. */
  dispose() {
    for (const v of Object.values(this.loops)) this.engine.unloop(v)
    this.loops = {}
  }

  between(lo, hi) {
    return lo + this.rand() * (hi - lo)
  }

  pick(list) {
    return list[Math.min(list.length - 1, (this.rand() * list.length) | 0)]
  }

  rate() {
    return this.between(RATE[0], RATE[1])
  }

  /** The next songbird clip: by RULES.songbirdVoice, one heard lately or any. Rolls the bias only when one is recent. */
  songbird() {
    const V = RULES.songbirdVoice
    const recent = SONGBIRDS.filter((n) => n in this.sang && this.clock - this.sang[n] < V.recent)
    const name = this.pick(recent.length > 0 && this.rand() < V.bias ? recent : SONGBIRDS)
    this.sang[name] = this.clock
    return name
  }

  /** A point `dist` from the head at a random bearing, `elevDeg` above the horizon. */
  aroundHead(head, dist, elevDeg) {
    const a = this.rand() * Math.PI * 2
    const e = elevDeg * DEG
    return {
      x: head.x + Math.cos(a) * Math.cos(e) * dist,
      y: head.y + Math.sin(e) * dist,
      z: head.z + Math.sin(a) * Math.cos(e) * dist,
    }
  }

  /**
   * A one-shot's timer: counts down only while `on`, re-rolled from `interval`
   * when the rule first turns on and again after each firing. True on the
   * frame it fires. `skew` > 1 crowds the roll toward the short end.
   */
  due(name, on, interval, dt, skew = 1) {
    const t = this.timers[name]
    if (!on) {
      t.armed = false
      return false
    }
    const gap = () => interval[0] + (interval[1] - interval[0]) * this.rand() ** skew
    if (!t.armed) {
      t.armed = true
      t.left = gap()
    }
    t.left -= dt
    if (t.left > 0) return false
    t.left += gap()
    return true
  }

  fire(name, opts) {
    this.fired[name] = (this.fired[name] || 0) + 1
    this.engine.play(name, opts)
  }

  /** Hold a loop on or off, and while on set its level and, if it has one, its bearing. */
  _loop(key, on, level, at = null) {
    const v = this.loops[key]
    if (on) {
      if (!v.active) v.start()
      v.setLevel(level)
      if (at) v.setPosition(at.x, at.y, at.z)
    } else if (v.active) {
      v.stop()
    }
  }

  /** She teleported `dist` metres: worth a second or two of footsteps, or one stroke swimming. */
  onTeleport(dist, range) {
    if (!(range > 0)) throw new Error(`Ambience.onTeleport: range must be positive, got ${range}`)
    this.teleported = true
    const [lo, hi] = RULES.footstep.teleport
    this.teleportCredit = lo + (hi - lo) * clamp(dist / range, 0, 1)
  }

  /**
   * Once a frame.
   * @param dt        seconds since the last update
   * @param head      {x, y, z} of her ears, world units
   * @param dayness   0 full night .. 1 full day, main.js's own ramp
   * @param submerged head under the water
   * @param speed     rig speed in m/s
   * @param afoot     she is walking, not flying, swimming or in a travel arc
   * @param swimming  she is swimming: strokes, not footsteps
   * @param now       the room's world clock in seconds (clock.js), which the dragons' roars are scored against
   * @param indoors   she is inside a house: the fiddles are silent
   * @param hushed    the birds, crickets and rustling leaves are silent (a chanterelle, design/33-vitals.md §Eating)
   * @param cave      null above ground; underground `{ river, pool }`, the nearest point {x, y, z} of the cave's river and of its still water (pool or sump) within RULES.caveRiver / cavePool reach, each or null
   */
  update(dt, { head, dayness, submerged, speed, afoot, swimming = false, cover = 0, precip = 0, now, indoors = false, hushed = false, cave = null }) {
    if (!(dt >= 0)) throw new Error(`Ambience.update: dt must be non-negative, got ${dt}`)
    if (!Number.isFinite(now)) throw new Error(`Ambience.update: needs the room's world seconds, got ${now}`)
    this.frame++
    if (submerged !== this.wet) {
      this.wet = submerged
      this.engine.setSubmerged(submerged)
    }
    if (cave !== null) {
      this._underground(dt, head, cave, submerged, speed, afoot, swimming)
      return
    }
    // Accumulated, not reset, so the cadence does not drift by a frame per sample.
    this.senseLeft -= dt
    if (!this.sensed || this.senseLeft <= 0) {
      // The shore search is the dear read: every LAKE_MOVING_S while she moves, every LAKE_STILL_S standing.
      const moved = Math.hypot(head.x - this.lakeX, head.z - this.lakeZ)
      const lake = now - this.lakeAt >= (moved > LAKE_MOVED_M ? LAKE_MOVING_S : LAKE_STILL_S)
      if (lake) { this.lakeAt = now; this.lakeX = head.x; this.lakeZ = head.z }
      this.sense.sample(head.x, head.y, head.z, this.s, lake)
      this.sensed = true
      this.senseLeft = Math.max(this.senseLeft, -1 / SENSE_HZ) + 1 / SENSE_HZ
    }
    const s = this.s

    this._loop('cave', false)
    this._loop('caveRiver', false)
    this._loop('cavePool', false)
    this.caveTake = null
    this.timers.caveSwap.armed = false
    this.timers.caveDrip.armed = false
    this.hushed = hushed
    this._loop('underwater', submerged, RULES.underwater.level)
    this._loops(head, s, cover, precip)
    this._fiddlers(dt, head, indoors)
    this._campfires(head)
    this._blaze(head)
    this._torches(head)
    this._drums(head, indoors)
    this._crawl(head)
    this._fish(head)
    this._strokes(dt, speed, swimming, submerged)
    // Nothing above the surface fires while she is under it; the loops already
    // running are silenced by the bus and keep their place for when she surfaces.
    if (submerged) {
      this.teleportCredit = Math.max(0, this.teleportCredit - dt)
      this.engine.update()
      return
    }

    const below = s.aboveSnow < 0
    this._birds(dt, head, s, dayness, below)
    this._crickets(dt, dayness, below && !hushed, head.y - s.groundH)
    this._feet(dt, head, s, speed, afoot)
    this._herds(dt, head)
    this._dragons(dt, head, now)
    this._frogs(dt, head, s)
    if (!hushed) this._grasshoppers(dt, head)
    this._voices(head)
    this._rocks(dt, head, s)
    this._lake(dt, head, s)
    this.engine.update()
  }

  _birds(dt, head, s, dayness, below) {
    this.clock += dt
    if (this.hushed) return
    const R = RULES.raptor
    const highCliff = s.aboveSnow > -R.cliffBand && s.cliff > R.cliffTan
    if (this.due('raptor', dayness > R.light && (s.aboveSnow > 0 || highCliff), R.interval, dt)) {
      this.fire(this.pick(RAPTORS), {
        rate: this.rate(), gain: this.between(...R.gain),
        at: this.aroundHead(head, this.between(...R.range), this.between(...R.elev)),
      })
    }
    // The perched birds: how far up she is, and how much of each is left at that height.
    const up = head.y - s.groundH
    const perched = (Y) => 1 - smoothstep(Y.aloft[0], Y.aloft[1], up)
    const O = RULES.owl
    if (this.due('owl', dayness < O.dark && s.forest > O.forest && below && up < O.aloft[1], O.interval, dt)) {
      this.fire('owl', {
        rate: this.rate(), gain: this.between(...O.gain) * perched(O),
        at: this.aroundHead(head, this.between(...O.range), this.between(...O.elev)),
      })
    }
    const P = RULES.woodpecker
    if (this.due('woodpecker', s.forest > P.forest && up < P.aloft[1], P.interval, dt)) {
      this.fire('woodpecker', {
        rate: this.rate(), gain: this.between(...P.gain) * perched(P),
        at: this.aroundHead(head, this.between(...P.range), this.between(...P.elev)),
      })
    }
    const F = RULES.songbirdFar
    if (this.due('songbirdFar', dayness > F.light && below && up < F.aloft[1], F.interval, dt * (1 + F.forestSpeedup * s.forest))) {
      const dist = this.between(...F.range)
      this.fire(this.songbird(), {
        rate: this.rate(), gain: this.between(...F.gain) * perched(F),
        at: this.aroundHead(head, dist, this.between(...F.elev)), distance: dist,
      })
    }
    const N = RULES.songbirdNear
    if (this.due('songbirdNear', dayness > N.light && below && up < N.aloft[1], N.interval, dt * (1 + N.forestSpeedup * s.forest), N.skew)) {
      this.fire(this.songbird(), {
        rate: this.rate(), gain: this.between(...N.gain) * perched(N),
        at: this.aroundHead(head, this.between(...N.range), this.between(...N.elev)),
      })
    }
  }

  /** The far cricket bed, unplaced: the near ones are _grasshoppers. */
  _crickets(dt, dayness, below, up) {
    const B = RULES.cricketBed
    const night = dayness < B.dusk && below && up < B.aloft[1]
    if (this.due('cricketBed', night, B.interval, dt)) {
      this.fire('cricket', { rate: this.rate(), gain: this.between(...B.gain) * (1 - smoothstep(B.aloft[0], B.aloft[1], up)) })
    }
  }

  /**
   * In a cave nothing of the overworld is heard: the sense would read the
   * ground over her head (a lake's waves, dulled as if far off), so it is not
   * sampled, and every overworld loop is stopped and every overworld timer and
   * body record dropped, so surfacing starts them fresh. Left are the cave's
   * own (_cave), the flames she and her peers carry (_blaze), and her own feet
   * and strokes.
   */
  _underground(dt, head, cave, submerged, speed, afoot, swimming) {
    for (const key in this.loops) if (!CAVE_LOOPS.has(key)) this._loop(key, false)
    for (const key in this.timers) if (!CAVE_TIMERS.has(key)) this.timers[key].armed = false
    this.bodies.clear()
    this.wings.clear()
    this.sensed = false
    this._loop('underwater', submerged, RULES.underwater.level)
    this._blaze(head)
    this._cave(dt, head, cave, submerged)
    this._strokes(dt, speed, swimming, submerged)
    if (submerged) this.teleportCredit = Math.max(0, this.teleportCredit - dt)
    else this._feet(dt, head, CAVE_SENSE, speed, afoot, true)
    this.engine.update()
  }

  /** Underground and dry: the cave bed with a take swapped in now and then, the river and pool beds, and a drop into the nearest water within reach. All off under the water. */
  _cave(dt, head, cave, submerged) {
    const dry = !submerged
    const C = RULES.cave
    this._loop('cave', dry, C.level)
    if (!dry) this.caveTake = null
    if (this.due('caveSwap', dry, C.swap, dt)) this.caveTake = this.pick(CAVE_TAKES)
    const dist = (p) => (p === null ? Infinity : Math.hypot(p.x - head.x, p.y - head.y, p.z - head.z))
    const dr = dist(cave.river), dp = dist(cave.pool)
    const R = RULES.caveRiver, P = RULES.cavePool
    this._loop('caveRiver', dry && cave.river !== null, R.level * (1 - smoothstep(R.near, R.reach, dr)), cave.river)
    this._loop('cavePool', dry && cave.pool !== null, P.level * (1 - smoothstep(P.near, P.reach, dp)), cave.pool)
    const D = RULES.caveDrip
    const d = Math.min(dr, dp), w = dry ? (dr < dp ? cave.river : cave.pool) : null
    if (this.due('caveDrip', w !== null, D.interval, dt)) {
      this.fire('caveDrip', { rate: this.rate(), gain: D.level * (D.near / Math.max(D.near, d)) * this.between(...D.gain), at: { x: w.x, y: w.y, z: w.z }, bus: 'near' })
    }
  }

  _strokes(dt, speed, swimming, submerged) {
    const S = RULES.stroke
    const landed = this.teleported
    this.teleported = false
    const due = this.due('stroke', swimming && speed > RULES.footstep.minSpeed, S.interval, dt)
    if (!due && !(swimming && landed)) return
    if (submerged) {
      this.fire('swoosh', { rate: this.rate(), gain: this.between(...S.gain), bus: 'water' })
      return
    }
    this.fire('swoosh', { rate: this.rate(), gain: this.between(...S.gain), bus: 'near', bright: true })
    this.fire('splash', { rate: this.rate(), gain: this.between(...S.splash), bus: 'near' })
  }

  _feet(dt, head, s, speed, afoot, underground = false) {
    const F = RULES.footstep
    const moving = afoot && (speed > F.minSpeed || this.teleportCredit > 0)
    this.teleportCredit = Math.max(0, this.teleportCredit - dt)
    if (this.due('footstep', moving, F.interval, dt)) {
      this.fire('footstep', { rate: this.rate(), gain: this.between(...F.gain), bus: 'near', cave: underground ? F.cave : 0 })
    }
    const K = RULES.rockslideFoot
    if (moving && s.onBoulder && this.rand() < K.chance * dt) {
      const at = this.aroundHead(head, 1, 0)
      at.y = s.groundH
      this.fire(this.pick(ROCKSLIDES), { rate: this.rate(), gain: this.between(...K.gain), at })
    }
  }

  /**
   * The herds. A body walking a gait clip has a clock here that runs in cycles
   * of that clip and fires the beats of FOOTFALLS as it passes them, each beat
   * jittered either way, wrapping at the cycle's end. A body first heard
   * walking, or one that changes gait, starts a fresh cycle, so a walk begins
   * on a footfall as the clip does; standing, its clock is cleared for the
   * next. A body with a call keeps the seconds to its next one, counted only
   * within reach. A body not listed within reach this frame is gone from here.
   */
  _herds(dt, head) {
    for (const h of this.herds) {
      const { sound: herdSound = 'footfall', rule: herdRule = 'footfall' } = h
      const table = FOOTFALLS[h.clips]
      const listed = this.listed
      listed.length = 0
      h.layer.bodies(listed)
      for (const c of listed) {
        const own = h.steps ? h.steps[c.sp.key] : undefined
        const sound = own ? own.sound : herdSound
        const F = RULES[own ? own.rule : herdRule]
        const call = h.calls ? h.calls[c.sp.key] : undefined
        const Y = call ? RULES[call] : null
        const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
        const walking = c.speed > 0 && d <= F.reach
        const calling = Y !== null && d <= Y.reach
        if (!walking && !calling) continue
        let f = this.bodies.get(c)
        if (!f) {
          f = { clip: null, phase: 0, beat: 0, at: 0, call: Y ? this.between(...Y.every) : 0, seen: 0 }
          this.bodies.set(c, f)
        }
        f.seen = this.frame
        if (walking) {
          const beats = table[c.clip]
          if (!beats) throw new Error(`Ambience: a ${h.clips} body is walking a ${c.clip}, which has no footfalls`)
          if (!(c.cycle > 0)) throw new Error(`Ambience: a ${h.clips} ${c.clip} cycle of ${c.cycle} s`)
          if (f.clip !== c.clip) {
            f.clip = c.clip
            f.phase = 0
            f.beat = 0
            f.at = this.between(-F.jitter, F.jitter)
          }
          f.phase += dt / c.cycle
          const level = Math.min(F.max, F.level * (c.size / F.size)) * (F.near / Math.max(F.near, d)) * (F.edge === undefined ? 1 : clamp((F.reach - d) / F.edge, 0, 1))
          const rate = Math.pow(F.size / c.size, F.deep)
          while (f.phase >= f.at) {
            this.fire(sound, { rate: rate * this.rate(), gain: level * this.between(...F.gain), at: { x: c.x, y: c.y, z: c.z }, bus: h.bus, ...farOf(F, d) })
            if (++f.beat === beats.length) {
              f.beat = 0
              f.phase -= 1
            }
            f.at = beats[f.beat] + this.between(-F.jitter, F.jitter)
          }
        } else {
          f.clip = null
        }
        if (calling) {
          f.call -= dt
          if (f.call <= 0) {
            f.call += this.between(...Y.every)
            this.fire(call, { rate: this.rate(), gain: Y.level * (Y.near / Math.max(Y.near, d)) * this.between(...Y.gain), at: { x: c.x, y: c.y, z: c.z } })
          }
        }
      }
    }
    for (const [c, f] of this.bodies) if (f.seen !== this.frame) this.bodies.delete(c)
  }

  /**
   * The dragons. Flying within the wingbeat's reach, a body has a clock here
   * in cycles of its fly clip, one beat a cycle, jittered, started fresh the
   * frame the beating begins, as the footfall clock is. Flying within the
   * roar's reach it roars as each gap of its scored chain turns over (the
   * `roars` Score, rolled from the dragon's own key), so every client in the
   * room hears that roar at the one world second; the roar a client arrives
   * inside is not replayed, and a clock skip lands one roar rather than the
   * chapter it jumped. After her on the ground it is off the score, so it
   * roars the frame it sets out and on the menace's shorter local clock from
   * there. Resting within the growl's reach it growls, each one
   * at its own rate, and the next only after this one has ended and a pause
   * rolled with it; the first waits one pause too, so a nest she walks up on
   * is not a growl on the step. Walking a gait clip on the ground within the
   * tread's reach, it has the herds' footfall clock against FOOTFALLS.wyvern,
   * started fresh with each gait, cleared standing; a body moving on a clip
   * with no footfalls (its speed dying under the idle a walk ends on) lands
   * none. A body heard by none of these this frame is gone from here.
   */
  _dragons(dt, head, now) {
    if (!this.dragons) return
    const W = RULES.wingbeat, R = RULES.roar, G = RULES.growl, T = RULES.tread, S = RULES.stamp
    const listed = this.listed
    listed.length = 0
    this.dragons.bodies(listed)
    for (const c of listed) {
      const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
      const flying = c.clip === 'fly'
      const beating = flying && d <= W.reach
      const menacing = c.state === 'menace'
      // A chase is heard on its cues alone: its roars, its landing, its growls.
      const chasing = c.state === 'aggro' && d <= R.reach
      const roaring = (flying || menacing) && !chasing && d <= R.reach
      const growling = c.state === 'roost' && d <= G.reach
      const beats = FOOTFALLS.wyvern[c.clip]
      const treading = beats !== undefined && c.speed > 0 && d <= T.reach
      if (!beating && !roaring && !growling && !treading && !chasing) continue
      let f = this.wings.get(c)
      if (!f) {
        f = { beating: false, phase: 0, at: 0, roar: this.between(...R.menace), roarAt: null, menacing: false, growling: false, growl: 0, gait: null, step: 0, beat: 0, land: 0, seen: 0, roarCue: c.roarCue, thudCue: c.thudCue, growlCue: c.growlCue }
        this.wings.set(c, f)
      }
      f.seen = this.frame
      const at = { x: c.x, y: c.y, z: c.z }
      if (f.roarCue !== c.roarCue) {
        f.roarCue = c.roarCue
        this._roar(d, at)
      }
      if (f.thudCue !== c.thudCue) {
        f.thudCue = c.thudCue
        if (d <= S.reach) this.fire('tread', { rate: S.rate, gain: S.level * (S.near / Math.max(S.near, d)) * this.between(...S.gain), at, distance: d, echo: S.echo })
      }
      if (f.growlCue !== c.growlCue) {
        f.growlCue = c.growlCue
        if (d <= G.reach) this.fire('growl', { rate: this.between(...G.rate), gain: G.level * (G.near / Math.max(G.near, d)) * this.between(...G.gain), at, distance: d })
      }
      if (treading) {
        if (!(c.cycle > 0)) throw new Error(`Ambience: a dragon walking a ${c.clip} cycle of ${c.cycle} s`)
        if (f.gait !== c.clip) {
          f.gait = c.clip
          f.step = 0
          f.beat = 0
          f.land = this.between(-T.jitter, T.jitter)
        }
        f.step += dt / c.cycle
        const level = T.level * (T.near / Math.max(T.near, d))
        while (f.step >= f.land) {
          this.fire('tread', { rate: this.rate(), gain: level * this.between(...T.gain), at, distance: d })
          if (++f.beat === beats.length) {
            f.beat = 0
            f.step -= 1
          }
          f.land = beats[f.beat] + this.between(-T.jitter, T.jitter)
        }
      } else {
        f.gait = null
      }
      if (beating) {
        if (!(c.cycle > 0)) throw new Error(`Ambience: a dragon flying a cycle of ${c.cycle} s`)
        if (!f.beating) {
          f.beating = true
          f.phase = 0
          f.at = this.between(-W.jitter, W.jitter)
        }
        f.phase += dt / c.cycle
        const level = W.level * (W.near / Math.max(W.near, d))
        while (f.phase >= f.at) {
          this.fire('wingbeat', { rate: this.between(...W.rate), gain: level * this.between(...W.gain), at, distance: d })
          f.phase -= 1
          f.at = this.between(-W.jitter, W.jitter)
        }
      } else {
        f.beating = false
      }
      if (menacing !== f.menacing) {
        f.menacing = menacing
        // Lured off the score: it roars on the step it turns, then every R.menace seconds while it holds.
        f.roar = menacing ? 0 : this.between(...R.menace)
      }
      if (roaring) {
        // Menacing, on this client's own timer, because the dragon itself is off the score while a lure holds it. Otherwise on the score: it roars as each scored gap turns over, wherever the listener is and whenever they arrived. One roar a turn, so a clock skip is one roar and not a chapter of them.
        let sounds = false
        if (menacing) {
          f.roar -= dt
          if (f.roar <= 0) { f.roar += this.between(...R.menace); sounds = true }
        } else {
          const index = this.roars.at(c.key, now).index
          if (f.roarAt !== null && f.roarAt !== index) sounds = true
          f.roarAt = index
        }
        if (sounds) this._roar(d, at)
      } else {
        // Out of earshot: the next roar it is near for is heard as it lands, not the backlog.
        f.roarAt = null
      }
      if (growling) {
        if (!f.growling) {
          f.growling = true
          f.growl = this.between(...G.pause)
        }
        f.growl -= dt
        if (f.growl <= 0) {
          const rate = this.between(...G.rate)
          f.growl += this.engine.duration('growl') / rate + this.between(...G.pause)
          this.fire('growl', { rate, gain: G.level * (G.near / Math.max(G.near, d)) * this.between(...G.gain), at, distance: d })
        }
      } else {
        f.growling = false
      }
    }
    for (const [c, f] of this.wings) if (f.seen !== this.frame) this.wings.delete(c)
  }

  /** A dragon's roar from `at`, `d` metres off, by RULES.roar. */
  _roar(d, at) {
    const R = RULES.roar
    const level = R.level * Math.pow(R.near / Math.max(R.near, d), R.roll) * clamp((R.reach - d) / R.edge, 0, 1)
    this.fire('roar', { rate: this.rate(), gain: level * this.between(...R.gain), at, distance: d, echo: R.echo })
  }

  /**
   * The crawlers' feet: one loop for every moving crab within reach, sat at
   * the nearest, as loud as all of them together up to its level; and the clip
   * once from each crawler or startler that took fright this frame.
   */
  _crawl(head) {
    const C = RULES.crawl
    let sum = 0
    let nearest = Infinity
    let at = null
    const listed = this.listed
    for (const layer of this.crawlers) {
      listed.length = 0
      layer.bodies(listed)
      for (const c of listed) {
        if (!(c.speed > 0)) continue
        const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
        if (d > C.reach) continue
        sum += C.near / Math.max(C.near, d)
        if (d < nearest) {
          nearest = d
          at = c
        }
      }
      if (layer.startled) this._startle(layer, C)
    }
    for (const layer of this.startlers) this._startle(layer, C)
    this._loop('crawl', at !== null, C.level * Math.min(1, sum), at)
  }

  /** The voiced layers: every one-shot since the last frame from where it was said, within reach. */
  _voices(head) {
    const listed = this.listed
    for (const { layer, rule, bus } of this.voiced) {
      listed.length = 0
      layer.voices(listed)
      for (const v of listed) {
        if (!SOUNDS[v.sound]) throw new Error(`Ambience: a voiced layer said ${v.sound}, which is no sound`)
        const V = RULES[v.rule === undefined ? rule : v.rule]
        if (!V?.edge) throw new Error(`Ambience: a voiced layer's ${v.sound} names ${v.rule}, which is no voice rule`)
        const d = Math.hypot(v.x - head.x, v.y - head.y, v.z - head.z)
        if (d > V.reach) continue
        const level = V.level * (V.near / Math.max(V.near, d)) * clamp((V.reach - d) / V.edge, 0, 1)
        this.fire(v.sound, { rate: this.rate() * (v.rate === undefined ? 1 : v.rate), gain: level * this.between(...V.gain) * (v.gain === undefined ? 1 : v.gain), at: { x: v.x, y: v.y, z: v.z }, bus, walled: V.walled === true && bus !== 'near', ...farOf(V, d) })
      }
    }
  }

  _startle(layer, C) {
    const listed = this.listed
    listed.length = 0
    layer.startled(listed)
    for (const c of listed) this.fire('crawl', { rate: this.rate(), gain: C.startle * C.level * this.between(...C.gain), at: c })
  }

  /** The fish: a swoosh on the water bus from each that set off fast this frame within reach, as loud and as deep as it is long. */
  _fish(head) {
    if (!this.fish) return
    const S = RULES.swoosh
    const listed = this.listed
    listed.length = 0
    this.fish.startled(listed)
    for (const c of listed) {
      if (!(c.size > 0)) throw new Error(`Ambience: a fish set off with a size of ${c.size}`)
      const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
      if (d > S.reach) continue
      const level = Math.min(S.max, S.level * (c.size / S.size)) * (S.near / Math.max(S.near, d))
      const rate = Math.pow(S.size / c.size, S.deep)
      this.fire('swoosh', { rate: rate * this.rate(), gain: level * this.between(...S.gain), at: { x: c.x, y: c.y, z: c.z }, bus: 'water' })
    }
  }

  _frogs(dt, head, s) {
    const G = RULES.frog
    const p = dt / G.every
    for (let i = 0; i < s.frogCount; i++) {
      if (this.rand() >= p) continue
      const x = s.frogs[i * 3], y = s.frogs[i * 3 + 1], z = s.frogs[i * 3 + 2]
      const d = Math.hypot(x - head.x, y - head.y, z - head.z)
      const fade = clamp(1 - d / FROG_REACH, 0, 1)
      if (fade <= 0) continue
      this.fire(this.pick(CROAKS), { rate: this.rate(), gain: this.between(...G.gain) * fade, at: { x, y, z } })
    }
  }

  /** The grasshoppers: each shown one within reach chirps the cricket clip, on average once per `every` seconds, from where it is -- day or night, and at night these are the only crickets with a place. */
  _grasshoppers(dt, head) {
    if (!this.grasshoppers) return
    const C = RULES.chirp
    const p = dt / C.every
    const listed = this.listed
    listed.length = 0
    this.grasshoppers.bodies(listed)
    for (const c of listed) {
      if (this.rand() >= p) continue
      const d = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z)
      if (d > C.reach) continue
      this.fire('cricket', { rate: this.rate(), gain: C.level * (C.near / Math.max(C.near, d)) * this.between(...C.gain), at: { x: c.x, y: c.y, z: c.z } })
    }
  }

  _rocks(dt, head, s) {
    const R = RULES.rockslideNear
    if (this.due('rockslideNear', s.boulders >= R.minBoulders, R.interval, dt)) {
      const at = this.aroundHead(head, this.between(...R.range), 0)
      at.y = s.groundH + this.between(...R.rise)
      const d = Math.hypot(at.x - head.x, at.y - head.y, at.z - head.z)
      if (d > R.reach) return
      this.fire(this.pick(ROCKSLIDES), { rate: this.rate(), gain: this.between(...R.gain) * (R.near / Math.max(R.near, d)), at, distance: d })
    }
  }

  /** Where a shore's sound sits: out along the bearing on land, back along it from the water. */
  shoreAt(head, s, dist, dirX, dirZ) {
    const sign = dist >= 0 ? 1 : -1
    const reach = Math.max(1, Math.abs(dist))
    return { x: head.x + sign * dirX * reach, y: s.fieldH, z: head.z + sign * dirZ * reach }
  }

  /**
   * Whether the lake is heard, how faded, from where, and how far off that is:
   * the nearest shore, when one is within reach. `lakeLevel` is -Infinity with
   * no lake about, which puts her infinitely above it and off.
   */
  lakeEar(head, s) {
    const W = RULES.wave
    const above = head.y - s.lakeLevel
    const d = Math.abs(s.lakeShore)
    if (!(above < W.height) || !(d < W.reach)) return { on: false, fade: 0, at: null, dist: 0 }
    return {
      on: true,
      fade: 1 - Math.max(smoothstep(W.near, W.reach, d), smoothstep(W.near, W.height, above)),
      at: this.shoreAt(head, s, s.lakeShore, s.lakeDirX, s.lakeDirZ),
      dist: d,
    }
  }

  _lake(dt, head, s) {
    const W = RULES.wave
    const ear = this.lakeEar(head, s)
    if (this.due('wave', ear.on && this.waves, W.interval, dt)) {
      this.fire('wave', { rate: this.rate(), gain: this.between(...W.gain) * ear.fade, at: ear.at, distance: ear.dist })
    }
  }

  _loops(head, s, cover, precip) {
    const L = RULES.lakeBed
    const ear = this.lakeEar(head, s)
    this._loop('lakeBed', ear.on, L.level * ear.fade, ear.at)

    const B = RULES.brook
    const rd = Math.hypot(s.riverShore, head.y - s.fieldH)
    const brookFade = 1 - smoothstep(B.near, B.reach, rd) * (1 - B.far)
    this._loop('brook', rd < B.reach, B.level * brookFade, this.shoreAt(head, s, s.riverShore, s.riverDirX, s.riverDirZ))

    const V = RULES.leaves
    const canopy = s.forest * (1 - smoothstep(V.aloft[0], V.aloft[1], head.y - s.groundH))
    // Hysteresis: on past `on`, off again only below `off`, so a forest edge does not flap.
    if (this.leavesOn ? canopy < V.off : canopy > V.on) this.leavesOn = !this.leavesOn
    this._loop('leaves', this.leavesOn && !this.hushed, V.level * smoothstep(V.off, V.full, canopy))

    const D = RULES.wind
    // Three ways up into the wind: over the snowline on foot, aloft over anything, or a sky closing in.
    const wind = Math.max(smoothstep(D.snow[0], D.snow[1], s.aboveSnow), smoothstep(D.height[0], D.height[1], head.y - s.groundH), D.cover * cover)
    if (this.windOn ? wind < D.off : wind > D.on) this.windOn = !this.windOn
    this._loop('wind', this.windOn, D.level * wind)

    const R = RULES.rain
    const rain = precip * (1 - smoothstep(R.sleet[0], R.sleet[1], s.aboveSnow)) * (1 - smoothstep(R.aloft[0], R.aloft[1], head.y - s.groundH))
    if (this.rainOn ? rain < R.off : rain > R.on) this.rainOn = !this.rainOn
    this._loop('rain', this.rainOn, R.level * rain)
  }

  /** Each fiddler's loop, through its spells, by her distance to its house's wall: level and cutoff by RULES.fiddle, placed at the fiddler; off while she is indoors. */
  _fiddlers(dt, head, indoors) {
    const F = RULES.fiddle
    for (const h of this.fiddlers) {
      h.left -= dt
      if (h.left <= 0) {
        h.playing = !h.playing
        const [lo, hi] = h.playing ? F.play : F.rest
        h.left = lo + (hi - lo) * this.rand()
      }
      const d = Math.max(0, Math.hypot(head.x - h.x, head.y - h.y, head.z - h.z) - h.r)
      const on = h.playing && !indoors && d < F.reach
      this._loop(h.key, on, F.level * Math.min(1, F.near / Math.max(d, 1e-3)) * (1 - smoothstep(F.reach - F.edge, F.reach, d)), h)
      if (on) this.loops[h.key].setCutoff(F.cutoff[1] + (F.cutoff[0] - F.cutoff[1]) * clamp(d / F.reach, 0, 1))
    }
  }

  /** Each campfire's loop by her distance to its flame: level by RULES.campfire, placed at the flame. */
  _campfires(head) {
    const C = RULES.campfire
    const heard = (key, f) => {
      const d = f ? Math.hypot(head.x - f.x, head.y - f.y, head.z - f.z) : Infinity
      this._loop(key, d < C.reach, C.level * Math.min(1, C.near / Math.max(d, 1e-3)) * (1 - smoothstep(C.reach - C.edge, C.reach, d)), f)
    }
    for (const f of this.campfires) heard(f.key, f)
    heard('hearth', this.hearth())
  }

  /** The blaze's loop: every flame `blaze()` lists adds its share by distance, placed at the nearest. */
  _blaze(head) {
    const B = RULES.blaze
    let sum = 0
    let nearest = Infinity
    for (const f of this.blaze()) {
      const d = Math.hypot(head.x - f.x, head.y - f.y, head.z - f.z)
      if (d >= B.reach) continue
      sum += Math.min(1, B.near / Math.max(d, 1e-3)) * (1 - smoothstep(B.reach - B.edge, B.reach, d))
      if (d < nearest) { nearest = d; this.blazeAt.x = f.x; this.blazeAt.y = f.y; this.blazeAt.z = f.z }
    }
    this._loop('blaze', sum > 0, B.level * Math.min(B.cap, Math.sqrt(sum)), this.blazeAt)
  }

  /** Each torch's loop by her distance to its flame and how lit the torches are: level by RULES.torch, placed at the flame, off unlit. */
  _torches(head) {
    const T = RULES.torch
    const lit = this.torches.length ? this.torchLit() : 0
    if (!(lit >= 0 && lit <= 1)) throw new Error(`Ambience: torches lit() must be 0..1, got ${lit}`)
    for (const f of this.torches) {
      const d = Math.hypot(head.x - f.x, head.y - f.y, head.z - f.z)
      this._loop(f.key, lit > 0 && d < T.reach, lit * T.level * Math.min(1, T.near / Math.max(d, 1e-3)) * (1 - smoothstep(T.reach - T.edge, T.reach, d)), f)
    }
  }

  /** The labyrinth drums' loop by how near its middle she is: level, cutoff and rate by RULES.drums, placed at its middle; off indoors. */
  _drums(head, indoors) {
    const D = RULES.drums
    const at = indoors ? null : this.drums(head)
    if (at !== null && !(at.near >= 0 && at.near <= 1)) throw new Error(`Ambience: drums near must be 0..1, got ${at.near}`)
    if (at !== null) this.loops.drums.setRate(D.rate[0] + (D.rate[1] - D.rate[0]) * at.near)
    this._loop('drums', at !== null, at === null ? 0 : D.level[0] * (D.level[1] / D.level[0]) ** at.near, at)
    if (at !== null) this.loops.drums.setCutoff(D.cutoff[0] * (D.cutoff[1] / D.cutoff[0]) ** at.near)
  }
}

// The reach the sense layer scans shores at has to exceed the reach the rules
// listen at, or a loop would start at the edge of what the scan can see.
if (SHORE_REACH <= RULES.wave.reach || SHORE_REACH <= RULES.brook.reach) {
  throw new Error(`ambience: SHORE_REACH ${SHORE_REACH} must exceed the wave (${RULES.wave.reach}) and brook (${RULES.brook.reach}) reaches`)
}
