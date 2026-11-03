import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CHAPTER_S, GRID_S, TICK_S, TICK_HZ, CATCH_UP_TICKS, SILENT_TICKS, hash32, keyHash, phraseRand, chapterOf, tickAfter, stepTo, easeWeight } from '../../sim/score.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import { hueVary, makeHueAttribute, tierTintSplice, tileSeed, walkTiles } from './critters.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { atMost } from '../eating.js'
import { RowTable } from './butterflies.js'
import { TIME_HI } from './gpu-motion.js'

// ---------------------------------------------------------------------------
// Fish: every authored lake and river stocked with the three roster species,
// swimming on their own with nothing to react to but each other and the shore.
//
// THE BEDS ARE THE WATER'S. The water within RADIUS of her head is cut into
// TILE-metre beds and each grows its schools from its tile seed (critters.js
// tileSeed): `perTile` sites a species, kept where the water is `minDepth`
// deep with `clearance` of the same around, every roll of a member (station,
// size, colour, temperament) drawn before the site is tested so a refused
// site leaves the stream where an accepted one would. A bed is a pure
// function of position like the plants, so leaving a lake and coming back
// meets the same schools, and so does everyone else in the room; a fish her
// hand took is recorded in taken.js against its bed's home, and the bed grows
// without it. Underwater visibility is 20 m (water.js UNDERWATER), so a bed
// further than RADIUS is a bed nobody can see. Standing on dry land every
// site fails and the layer is simply empty.
//
// EVERY CLIENT SWIMS THE SAME FISH (_notes/creature-sync.md). A school's
// anchor is a chain of hops rolled from hash(key, chapter): from home at the
// chapter turn, a new target every `anchorEvery` seconds within `anchorHop`
// of the anchor and `tether` of home, drifted to at `anchorSpeed`; a
// glimmerfin shoal's anchor also jumps `boltHop` every `boltEvery` seconds,
// the fright that sends the shoal after it; and the chapter's last hop goes
// home, so the next chapter starts from nothing. The anchor at any world time
// is that chain walked from the chapter start, every roll and every shore
// test a pure function, so two clients hold it to the bit.
//
// EVERY FISH IS ON AUTOPILOT. A schooled fish swims a LEG: a quintic from
// where it is to where it means to be in `leg` seconds of its own roll, plus
// the current's drift, written to its row once and drawn by the shader from
// then on. When a leg ends -- at absolute ticks of the room's clock, each fish
// on its own -- the fish looks once at the water under and ahead of it, rolls
// its mood, aims (wander, station, shore, lure, school-mates where they are on
// that tick) and swims the next leg in a quick integration from its own PRNG
// keyed by segment. Every GRID_S seconds (the school's grid, offset by its
// key) each fish's last leg lands on its station for the next segment -- a
// pose closed-form in (key, segment) -- so what one client plans never strays
// from what another does for longer than a segment. Facing, roll, curve, lift
// and the tail all follow from the leg's own derivatives, on GPU and CPU alike.
//
// ONE AI, THREE PERSONALITIES. Every fish is a heading that wanders, a speed
// that is steered toward a target, a pull toward its own station in the
// school, a push away from its nearest school-mates, and a probe ahead that
// turns it back to the anchor when the water ends. Every fish also rolls its
// own pace, verve, tail beat, station and bob at birth, so a school moves as
// a crowd and not as one mesh drawn nine times. The species table is the
// rest of the difference:
//
//   ironscale bass   -- schools of 4-9, a loose 3 m ball, mid-water, steady,
//                       one fish or another darting or hanging back.
//   rime fangpike    -- alone, on the bed. Glides, then hangs, then bursts.
//   glimmerfin       -- shoals of 6-14 under the surface, jittery, and
//                       STARTLING: every few seconds a fright ripples through
//                       the shoal, fish by fish, and it bolts a few metres
//                       and then hangs again.
//
// THE DEEP IS WHERE THE BIG ONES ARE. A fish's size is drawn at birth from the
// water under its own spot: the shore hands out fry, and the ceiling and the
// skew of the draw both climb with depth until DEEP_M, where most of a school
// is near the species' sizeMax and only the odd one is small.
//
// A LURE IS LIVE. A spider, butterfly or grasshopper in a hand (hands.js
// lures) has the fish within LURE_M swimming through it, kept to
// LURE_FORGET_M; a lured fish skips its station until the lure ends and
// rejoins at the next grid turn. The fish her own hand has are told to the
// room per bed as a lured set, `[bedKey, 'fs', null, indices]`
// (creature-net.js), so a peer's copy of her hand keeps the same fish on it.
//
// NO NEIGHBOUR SEARCH. Separation runs only inside a school, and a school is
// at most 14 fish, so a plan is linear in the school. Pike keep apart from
// the other pike of their bed. The water a plan looks at is the Shallows: bed,
// surface and current on a 1 m lattice filled once per corner and shared by
// every fish, because heightAt is the one thing here that is not arithmetic.
//
// THE POSE IS THE SHADER'S. public/fauna/fish.json (tools/fauna/ship.mjs)
// carries each species' picked Tripo mesh, nose at -Z, with a per-vertex
// swim-bend weight. Each fish is one instance whose row in the species'
// RowTable (butterflies.js) holds its leg (FISH_ROW_TEXELS). The vertex stage
// evaluates it, builds the matrix, and bends every vertex sideways by bend *
// (amplitude * sin(phase - k * z) + curve) and up by bend * lift. The tail's
// rate follows the speed, so a lurking pike barely sculls and a bolting
// glimmerfin is a blur, and curve and lift follow the turn and the climb. A
// fish in her hand, and the instance a leap borrows, carry aRow 0 and are posed
// by their own instanceMatrix and aSwim; a loose fish is the one CPU path, its
// row rewritten every frame as a leg starting now.
//
// NO TWO FISH ARE THE SAME COLOUR. Each rolls a brightness (instanceColor) and
// a hue, a turn of up to HUE radians either way round the colour wheel
// (critters.js hueVary), at birth.
// ---------------------------------------------------------------------------

const ASSET_URL = 'fauna/fish.json'
const TEXTURE_URL = (file) => `fauna/${file}`

// A bed's side and how far out beds are kept, both against the 20 m murk: the furthest bed's near edge is just past it.
export const TILE = 24
export const RADIUS = 36
// Spots a site drawn from setSpots' list tries before it is refused.
const SPOT_TRIES = 8
const GOLDEN = 0.6180339887
// Metres her head moves before the beds are walked again.
const WALK_M = 4
// Water this deep, under a fish's own spot, hands out the species' full size ceiling; 0.5 m hands out the shore's.
const DEEP_M = 12
// A loose fish probes the bed, the surface and the water ahead every this many frames.
const PROBE_EVERY = 4
// A leg's swim is integrated in steps of SUB_S; its heading turns onto the aim at TURN_GAIN times the species' agility, capped at TURN_MAX times it. The facing leans onto the heading by FACE_EPS of the cruise, so a fish hanging still still points somewhere.
const SUB_S = 0.025
const TURN_GAIN = 2
const TURN_MAX = 1.5
const FACE_EPS = 0.1
// A leg that would end within FINAL_TICKS of the grid turn is stretched to land on it. The shore ahead turns a fish home for HOMING_TICKS. A lured fish replans every LURE_LEG_S.
// No leg is shorter than MIN_LEG ticks: the quintic's acceleration for any mismatch between the swim and its own path grows as 1/D^2, so a shorter leg jerks the fish between frames. A mood due to end sooner ends now; a startle due sooner waits that long.
const FINAL_TICKS = 30
const MIN_LEG = 4
const HOMING_TICKS = 30
const LURE_LEG_S = 0.2
// The Shallows: corners SHALLOW_M apart, kept in chunks of CHUNK corners a side.
const SHALLOW_M = 1
const CHUNK = 16
// A startle crosses a shoal at BOLT_WAVE m/s, each fish reacting up to BOLT_JITTER s late on top, and BOLT_MISS of the shoal never bolts at all: a fright is a ripple through the shoal, never one tick's broadcast.
const BOLT_WAVE = 4
const BOLT_JITTER = 0.4
const BOLT_MISS = 0.15
// A river's pull on a fish at full flow weight (WaterSurfaces.flowAt), m/s, sampled at the probe: under every species' cruise, so a school sags downstream of its anchor and works back up rather than being swept off it.
export const CURRENT_MPS = 0.15
// How far off the bed and under the surface a fish is held, in metres, plus a fifth of its own length. A leg is held inside the column at its two ends, so this also covers the curve's bulge between them.
const BED_MARGIN = 0.25
const SURFACE_MARGIN = 0.3
// A hop's path is tested for water every this many metres, so a school is never led across a spit its fish would beach on.
const HOP_STEP_M = 2
export const HUE = 0.35
// A fish setting off at a target speed of at least this, m/s, is listed in startled() for the ear: a glimmerfin's bolt, a pike's burst, a bass's dart, but not a glimmerfin's fidget or any hang.
export const DART_SPEED = 1

// A fish she let go of in the water: seconds it hangs stunned before it wakes, the speed it then darts from her at (a multiple of its cruise), how often its line is jinked, and how far from her head it is forgotten.
export const STUN_S = [1, 2]
export const LOOSE_HASTE = 3
const LOOSE_JINK = 1.2
export const LOOSE_GONE_M = 40

// A LURE. A spider, butterfly or grasshopper in a hand (hands.js lures) within LURE_M of a fish has it swimming at the hand at LURE_HASTE times its cruise and LURE_AGILITY times its agility, kept to LURE_FORGET_M, its station forgotten. The walk swings onto the hand's bearing at LURE_TURN radians a second and no faster, with its jitter still on it, so the fish runs through the hand and comes round on a circle of its speed over LURE_TURN to run through it again.
export const LURES = ['spider', 'butterfly', 'grasshopper']
export const LURE_M = 3
export const LURE_FORGET_M = 6
export const LURE_HASTE = 3
const LURE_AGILITY = 2
export const LURE_TURN = 3
// A bed's lured set goes to the room at most this often while it changes; an emptied set goes at once.
export const LURED_EVERY_S = 1
const NO_LURES = []
// HER AS PREY. Her height is `heightM` times her size (sized). A fish over `nibble` times that long with her head within `notice` of its own lengths swims at her as at a lure, kept to twice that, and from half its length off bites for `harm` every `biteS`; one over `gulp` times her height swallows her whole. Hers alone: the room does not hear it.
export const PREY = { heightM: 1.8, nibble: 2, gulp: 4, notice: 2, harm: 10, biteS: 1 }

export const bedKey = (tx, tz) => `fs:${tx},${tz}`
export const keyOf = (tx, tz, s) => `${bedKey(tx, tz)}:${s}`

/**
 * The species table. Speeds in m/s, times in seconds, depths as a fraction of
 * the water column measured up from the bed. `count` is the species' slots,
 * `perTile` the sites a bed rolls for it; `minDepth` is the column a school
 * will seed in and `clearance` how far around an anchor that column must
 * extend; `tether` how far from home the anchor may be sent. `wander` is the
 * heading's random walk in rad/s^0.5; `agility` is how fast velocity chases
 * its target, 1/s; `leg` the seconds a fish swims between looks at its
 * surroundings. `size` is the scale drawn at the shore and the ceiling
 * reached in DEEP_M of water (see sizeAt); `sizeVary` a jitter on top.
 * `fidget` is one fish's own dart or hang: every `fidgetEvery` seconds,
 * `fidgetFor` seconds at `fidgetSpeed` or at a third of cruise, with a kick to
 * the heading.
 */
export const SPECIES = {
  'ironscale-bass': {
    count: 128, perTile: 2, school: [4, 9], schoolRadius: 3, separation: 0.5,
    minDepth: 1.0, clearance: 3, depth: [0.3, 0.7], tether: 10,
    cruise: 0.55, agility: 1.4, wander: 0.9, lookahead: 3, leg: [0.6, 1.6],
    tailHz: 2.0, tailAmp: 0.11, size: [0.55, 2.6], sizeVary: 0.2,
    anchorSpeed: 0.3, anchorHop: [6, 14], anchorEvery: [8, 16],
    fidgetEvery: [3, 9], fidgetSpeed: 1.3, fidgetFor: 0.5,
    material: { color: 0xffffff },
  },
  'rime-fangpike': {
    count: 24, perTile: 2, school: [1, 1], schoolRadius: 6, separation: 6,
    minDepth: 1.5, clearance: 2.5, depth: [0.08, 0.3], tether: 12,
    cruise: 0.28, agility: 0.8, wander: 0.35, lookahead: 6, leg: [1.0, 2.2],
    tailHz: 1.1, tailAmp: 0.08, size: [0.6, 2.6], sizeVary: 0.25,
    anchorSpeed: 0.2, anchorHop: [8, 20], anchorEvery: [10, 24],
    // The three moods of an ambush predator: seconds in each, and the speed it holds.
    glide: [6, 14], lurk: [4, 10], lurkSpeed: 0.03, burst: 0.9, burstSpeed: 2.2,
    material: { color: 0xffffff },
  },
  'glimmerfin': {
    count: 176, perTile: 2, school: [6, 14], schoolRadius: 1.2, separation: 0.25,
    minDepth: 0.5, clearance: 1.5, depth: [0.6, 0.9], tether: 5,
    cruise: 0.18, agility: 3.5, wander: 3.0, lookahead: 1.5, leg: [0.25, 0.8],
    tailHz: 3.5, tailAmp: 0.12, size: [0.5, 2.2], sizeVary: 0.3,
    anchorSpeed: 0.15, anchorHop: [2, 5], anchorEvery: [3, 8],
    // The startle: the shoal's anchor jumps `boltHop` metres, every fish bolts at `boltSpeed` for `boltFor` seconds.
    boltEvery: [4, 12], boltHop: [2, 4], boltSpeed: 2.0, boltFor: 1.0,
    fidgetEvery: [0.8, 3], fidgetSpeed: 0.7, fidgetFor: 0.25,
    // A little of the folklore glow, so the shoal reads through the murk.
    material: { color: 0xffffff, emissive: 0x2a1650, emissiveIntensity: 0.6 },
  },
}

const TAU = Math.PI * 2

// The fish row, FISH_ROW_TEXELS RGBA32F texels (x, y, z, w): the leg's quintic per axis in its own time s in [0, 1], k0 + k1 s + ... + k5 s^5.
//   0  x k0..k3          1  x k4 k5, y k4 k5     2  y k0..k3            3  z k0..k3
//   4  z k4 k5, the current's drift x, z (m/s)   5  start (seconds past HI), length D, HI, scale (0 hides the slot)
//   6  facing lean at the start x, z and at the end x, z
//   7  tail phase at the start, its beat, 1 / the fish's cruise, amplitude (0 when stunned)
//   8  swim speed through the leg as s0 + B u + C u^2 in seconds u, the species' length
export const FISH_ROW_TEXELS = 9

/** GLSL for the fish row: `fishRow(row)` returns the instance matrix and sets `fishSwim`. The GPU twin of Fish._eval and Fish._look, kept in step with fishPose in the gate. */
const FISH_GLSL = `
mat4 fishHeld() { fishSwim = aSwim; return instanceMatrix; }
mat4 fishRow( int row ) {
  vec4 t0 = texelFetch( uRows, ivec2( 0, row ), 0 );
  vec4 t1 = texelFetch( uRows, ivec2( 1, row ), 0 );
  vec4 t2 = texelFetch( uRows, ivec2( 2, row ), 0 );
  vec4 t3 = texelFetch( uRows, ivec2( 3, row ), 0 );
  vec4 t4 = texelFetch( uRows, ivec2( 4, row ), 0 );
  vec4 t5 = texelFetch( uRows, ivec2( 5, row ), 0 );
  vec4 t6 = texelFetch( uRows, ivec2( 6, row ), 0 );
  vec4 t7 = texelFetch( uRows, ivec2( 7, row ), 0 );
  vec4 t8 = texelFetch( uRows, ivec2( 8, row ), 0 );
  fishSwim = vec4( 0.0 );
  float sc = t5.w;
  if ( sc == 0.0 ) return mat4( 0.0 );
  float D = t5.y;
  float u = ( uRowT.x - t5.z ) + ( uRowT.y - t5.x );
  float s = min( 1.0, u / D );
  float over = u - s * D;
  float ea = 1.0 / ( D * D );
  vec3 c0 = vec3( t0.x, t2.x, t3.x ), c1 = vec3( t0.y, t2.y, t3.y ), c2 = vec3( t0.z, t2.z, t3.z );
  vec3 c3 = vec3( t0.w, t2.w, t3.w ), c4 = vec3( t1.x, t1.z, t4.x ), c5 = vec3( t1.y, t1.w, t4.y );
  vec3 v = ( c1 + s * ( 2.0 * c2 + s * ( 3.0 * c3 + s * ( 4.0 * c4 + s * 5.0 * c5 ) ) ) ) / D;
  vec3 a = ( 2.0 * c2 + s * ( 6.0 * c3 + s * ( 12.0 * c4 + s * 20.0 * c5 ) ) ) * ea;
  vec3 p = c0 + s * ( c1 + s * ( c2 + s * ( c3 + s * ( c4 + s * c5 ) ) ) ) + v * over + vec3( t4.z, 0.0, t4.w ) * u;
  vec2 F = v.xz + mix( t6.xy, t6.zw, s );
  vec2 dF = a.xz + ( t6.zw - t6.xy ) / D;
  float turn = clamp( ( F.x * dF.y - F.y * dF.x ) / max( dot( F, F ), 1e-6 ) / 6.0, -1.0, 1.0 );
  float hs = length( v.xz );
  float H = max( hs, 0.05 );
  float rx = atan( v.y, H );
  float dhs = hs > 0.05 ? dot( v.xz, a.xz ) / hs : 0.0;
  float dp = ( H * a.y - v.y * dhs ) / ( H * H + v.y * v.y );
  float wu = min( u, D );
  float s1 = t8.x + t8.y * D + t8.z * D * D;
  float phase = t7.x + t7.y * ( 0.4 * u + 0.6 * t7.z * ( wu * ( t8.x + wu * ( t8.y * 0.5 + wu * t8.z / 3.0 ) ) + s1 * over ) );
  float amp = t7.w * min( 1.6, 0.5 + 0.5 * length( v ) * t7.z ) * ( 1.0 + 2.0 * abs( turn ) );
  fishSwim = vec4( phase, amp, clamp( turn * 2.0, -0.4, 0.4 ) * t8.w, clamp( dp * 0.2 + rx * 0.8, -0.3, 0.3 ) * t8.w );
  float ry = atan( -F.x, -F.y );
  float rz = -turn * 0.5;
  float ca = cos( rx ), sa = sin( rx ), cc = cos( ry ), sd = sin( ry ), ce = cos( rz ), sf = sin( rz );
  float ccE = cc * ce, ccF = cc * sf, sdE = sd * ce, sdF = sd * sf;
  mat3 r = mat3(
    ccE + sdF * sa, ca * sf, ccF * sa - sdE,
    sdE * sa - ccF, ca * ce, sdF + ccE * sa,
    ca * sd, -sa, ca * cc
  );
  return mat4( vec4( r[0] * sc, 0.0 ), vec4( r[1] * sc, 0.0 ), vec4( r[2] * sc, 0.0 ), vec4( p, 1.0 ) );
}`

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()

const _a = { x: 0, z: 0, y: 0 }
const _e = { x: 0, z: 0, y: 0 }
const _s = { sx: 0, sy: 0, sz: 0, bed: 0, level: 0 }
const _o = { x: 0, z: 0, y: 0 }
const _n = { x: 0, y: 0, z: 0, w: 0, ex: 0, ey: 0, ez: 0 }
const probe = () => ({ wet: false, bed: 0, level: 0, cx: 0, cz: 0 })
const _w = probe(), _w2 = probe(), _w3 = probe()
const leg = () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, hx: 0, hz: 0, dhx: 0, dhz: 0, phase: 0 })
const _st = leg(), _pe = leg()
const _sw = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, th: 0 }
const _lk = { fx: 0, fz: 0, yaw: 0, pitch: 0, roll: 0, curve: 0, lift: 0, amp: 0 }

/**
 * The water the fish plan on: bed, surface and the current's drift at corners
 * SHALLOW_M apart, each read once from the terrain and the water and shared
 * by every fish that looks there, between corners bilinear. A dry corner
 * counts as a metre above the bed, so the shore shoals toward it. A pure
 * function of position: the order corners are filled in never shows.
 */
class Shallows {
  constructor(height, water) {
    this.height = height
    this.water = water
    this.chunks = new Map()
    this.reads = 0
  }

  /** Corner (ix, iz)'s chunk and offset into it, filled on first use: depth (-1 dry), level (NaN dry), drift x, z. */
  _corner(ix, iz) {
    const cx = Math.floor(ix / CHUNK), cz = Math.floor(iz / CHUNK)
    const key = (cx + 32768) * 65536 + (cz + 32768)
    let c = this.chunks.get(key)
    if (c === undefined) {
      c = new Float64Array(CHUNK * CHUNK * 4).fill(NaN)
      this.chunks.set(key, c)
    }
    const o = ((iz - cz * CHUNK) * CHUNK + (ix - cx * CHUNK)) * 4
    if (Number.isNaN(c[o])) {
      this.reads++
      const x = ix * SHALLOW_M, z = iz * SHALLOW_M
      const level = this.water.levelAt(x, z)
      const bed = this.height.heightAt(x, z)
      if (level === null || bed >= level) {
        c[o] = -1; c[o + 1] = NaN; c[o + 2] = 0; c[o + 3] = 0
      } else {
        const w = this.water.flowAt(x, z, _o) * CURRENT_MPS
        c[o] = level - bed; c[o + 1] = level; c[o + 2] = _o.x * w; c[o + 3] = _o.z * w
      }
    }
    _cn.c = c
    return o
  }

  /** The water at (x, z) into `o`: wet, bed, level and drift (cx, cz). Wet where a corner around it is and the depth is above nothing. */
  at(x, z, o) {
    const gx = x / SHALLOW_M, gz = z / SHALLOW_M
    const ix = Math.floor(gx), iz = Math.floor(gz)
    const fx = gx - ix, fz = gz - iz
    let depth = 0, level = 0, wl = 0, cx = 0, cz = 0
    for (let j = 0; j < 4; j++) {
      const dx = j & 1, dz = j >> 1
      const k = this._corner(ix + dx, iz + dz)
      const c = _cn.c
      const w = (dx ? fx : 1 - fx) * (dz ? fz : 1 - fz)
      depth += c[k] * w
      cx += c[k + 2] * w
      cz += c[k + 3] * w
      if (!Number.isNaN(c[k + 1])) { level += c[k + 1]; wl++ }
    }
    o.wet = wl > 0 && depth > 0
    o.level = wl > 0 ? level / wl : 0
    o.bed = o.level - depth
    o.cx = cx
    o.cz = cz
    return o
  }

  /** Every chunk whose centre is more than `r` metres from (x, z) let go. */
  evict(x, z, r) {
    const side = CHUNK * SHALLOW_M
    for (const key of this.chunks.keys()) {
      const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768
      if (Math.hypot((cx + 0.5) * side - x, (cz + 0.5) * side - z) > r) this.chunks.delete(key)
    }
  }
}
const _cn = { c: null }

export class Fish {
  /**
   * @param scene   the three.js scene
   * @param height  V2Height: heightAt(x, z)
   * @param water   WaterSurfaces: levelAt(x, z) -> level or null, flowAt(x, z, out) -> the current
   * @param opts.seed    the world seed, for the beds and the loose fish
   * @param opts.assets  parsed fish.json for a gate; the world fetches it
   * @param opts.harm    (n, why) => her bitten by a fish (PREY)
   * @param opts.swallow (why) => her swallowed whole by one (PREY)
   */
  constructor(scene, height, water, { seed = 1, assets = null, harm = null, swallow = null } = {}) {
    if (!height || typeof height.heightAt !== 'function') throw new Error('Fish needs a height field with heightAt')
    if (!water || typeof water.levelAt !== 'function' || typeof water.flowAt !== 'function') throw new Error('Fish needs WaterSurfaces, for levelAt and flowAt')
    if (harm !== null && typeof harm !== 'function') throw new Error('Fish: harm must be a function of (n, why)')
    if (swallow !== null && typeof swallow !== 'function') throw new Error('Fish: swallow must be a function of (why)')
    this.harm = harm
    this.swallow = swallow
    // Her size, a multiple of her full height (sized), and her head as the lure a fish hunting her swims at.
    this.size = 1
    this.her = { kind: 'her', x: 0, y: 0, z: 0, by: null }
    this.height = height
    this.water = water
    this.seed = seed
    // Null, or the spots a bed's sites are drawn from per tile (setSpots).
    this.spots = null
    // The layer's own noise: the loose fish only. Everything in a bed rolls from its key.
    this.rand = mulberry32(seed)
    this.batch = new THREE.Group()
    this.batch.name = 'v2-fish'
    scene.add(this.batch)
    this.species = Object.entries(SPECIES).map(([id, cfg]) => this.makeSpecies(id, cfg))
    this.frame = 0
    // The room's clock at the last update, or null before the first.
    this.now = null
    this.head = { x: 0, y: 0, z: 0 }
    // The fish that set off fast this frame, for startled().
    this.startles = []
    this.tiles = new Map()
    // Where the beds were last walked from.
    this.walkedX = Infinity
    this.walkedZ = Infinity
    // Members a bed rolled that found no free slot.
    this.overflow = 0
    this.ticks = 0
    // Legs planned, and the shared water they were planned on.
    this.legs = 0
    this.shallows = new Shallows(height, water)
    // Fish a probe found on the bank, put back at their anchor.
    this.beached = 0
    // Lured sets owed to the room (pendingLured), and the peers' by bed key (applyLured): { by, has }.
    this.owed = []
    this.luredIn = new Map()
    // Fish holding a lure, and of them the ones on her, as of the last frame the notice loop ran; the longest fish living, recounted when `biggestStale`. A frame with no lure in a hand, none held and none big enough to take her for prey skips the loop.
    this.noticing = 0
    this.hers = 0
    this.biggest = 0
    this.biggestStale = false
    if (assets) {
      for (const sp of this.species) this.setAsset(sp, this.assetFor(assets, sp))
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  assetFor(assets, sp) {
    const asset = assets.species.find((a) => a.id === sp.id)
    if (!asset) throw new Error(`fish: ${ASSET_URL} has no ${sp.id} -- run tools/fauna/ship.mjs`)
    return asset
  }

  makeSpecies(id, cfg) {
    // Lambert, no specular: a fish only glints once it is out of the water -- under it, the sheen the eye reads belongs to the surface, and the fish is a matte thing in dim light. Opaque and front-faced: a Tripo fish is a closed volume whose fins are two sheets a hair apart (tripo-culling.js), and nothing here sorts.
    const material = new THREE.MeshLambertMaterial({ ...cfg.material })
    // The swim bend. `aBend` is ship.mjs's per-vertex weight (0 at the nose, 1 at the tail tip); `fishSwim` is per instance: phase, amplitude, and the turn's sideways curve and the climb's lift, all in local metres -- from the row for a flight instance, from `aSwim` for one in a hand (aRow 0). The wave number is a literal scaled to the species' length, so a pike's wave is one body length long just like a glimmerfin's.
    const rows = new RowTable(FISH_ROW_TEXELS, cfg.count)
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, rows.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aBend;
attribute vec4 aSwim;
attribute float aRow;
vec4 fishSwim;
#ifdef USE_INSTANCING
uniform sampler2D uRows;
uniform vec2 uRowT;
mat4 gpuInstanceMatrix;
${FISH_GLSL}
#define instanceMatrix gpuInstanceMatrix
#endif`)
        .replace('void main() {', 'void main() {\n#ifdef USE_INSTANCING\ngpuInstanceMatrix = aRow < 0.5 ? fishHeld() : fishRow( int( aRow + 0.5 ) - 1 );\n#endif')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x += aBend * ( fishSwim.y * sin( fishSwim.x - FISH_WAVE_K * position.z ) + fishSwim.z );\ntransformed.y += aBend * fishSwim.w;')
      hueVary(shader)
      tierTintSplice(shader, 0)
    }
    material.customProgramCacheKey = () => `fish-${id}`
    material.defines = { FISH_WAVE_K: '0.0' }

    const slots = []
    for (let i = 0; i < cfg.count; i++) {
      slots.push({
        id: i, sp: null, alive: false, loose: false, school: null, tile: null,
        // Its index in its bed, for the lured sets and the taken registry.
        index: -1,
        // The leg it is swimming (_plan; the row's layout), and the tick it ends on.
        L: { t0: 0, d: TICK_S, k: new Float64Array(18), cx: 0, cz: 0, h0x: 0, h0z: 0, h1x: 0, h1z: 0, ph0: 0, rate: 0, inv: 0, amp: 0, s0: 0, sb: 0, sc: 0 },
        nextTick: 0, final: false,
        // Its pose as of `poseFrame` (pose, pos): only worked out when something asks. A loose fish is stepped per frame and its (x, y, z), velocity and facing are its own.
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, poseFrame: -1,
        hx: 0, hz: -1, pitch: 0, roll: 0, yaw: 0,
        // `size` is its length in metres, for the ear.
        wander: 0, depthFrac: 0.5, scale: 1, size: 0, margin: 0, tint: 1, hue: 0,
        phase: 0, amp: 0, curve: 0, lift: 0,
        // The fish's own rolls: speed and wander multipliers, tail-beat multiplier, and its station in the school -- a point `ring` metres from the anchor that circles it at `orbit` rad/s from `station0` at world time zero -- plus a slow vertical bob.
        pace: 1, verve: 1, beat: 1, ring: 0, station0: 0, orbit: 0, bobHz: 0.1, bobAt: 0,
        // The water at its last look; `cx`, `cz` a loose fish's drift, m/s.
        bed: 0, level: 0, cx: 0, cz: 0,
        // The tick it steers back to the anchor until, after a look found the shore ahead, and the tick the shoal's startle reaches it.
        homingEnd: -1, boltTick: Infinity,
        // Mood: pike glide/lurk/burst, bass and glimmerfin fidget, until tick `moodEnd`; a loose fish's jink in seconds, `moodLeft`. `speed` is the mood's target speed.
        mood: 'glide', moodEnd: 0, moodLeft: 0, speed: cfg.cruise,
        // The segment's PRNG, and the station the segment ends at.
        rand: null, ex: 0, ey: 0, ez: 0,
        // Let go of by her hand: no school, stunned for `stun` seconds, then darting from her head (stepLoose).
        stun: 0,
        // The hands.js lure it is swimming at, or null; `lured` while it is off its station for one.
        lure: null, lured: false, bitT: -Infinity,
        // The frame it was last listed for the ear.
        listedAt: -1,
      })
    }
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), material, cfg.count)
    mesh.name = `v2-fish-${id}`
    mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    mesh.visible = false
    // The instances move every frame and the beds are a disc around the head anyway; a per-mesh sphere would have to be rebuilt each frame to cull anything.
    mesh.frustumCulled = false
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cfg.count * 3).fill(1), 3)
    // The flight mesh's matrix and tail come from the rows; `aSwim` is on the geometry for the copies in a hand, whose records carry it.
    const swim = new THREE.InstancedBufferAttribute(new Float32Array(cfg.count * 4), 4)
    mesh.geometry.setAttribute('aSwim', swim)
    // The row of instance i is slot i, +1 so the zero a copy in a hand carries means "not a row".
    const rowIds = new Float32Array(cfg.count)
    for (let i = 0; i < cfg.count; i++) rowIds[i] = i + 1
    mesh.geometry.setAttribute('aRow', new THREE.InstancedBufferAttribute(rowIds, 1))
    const hue = makeHueAttribute(mesh, cfg.count)
    cullTripoBackfaces(mesh)
    this.batch.add(mesh)
    // `top` is one past the last live slot (the mesh draws that many instances); free slots are taken lowest id first so it stays tight; `loose` the fish her hand let go of.
    const sp = { id, cfg, material, mesh, swim, hue, rows, slots, free: slots.slice().reverse(), top: 0, loose: [], schools: [], loaded: false, lengthM: 0 }
    for (const f of slots) f.sp = sp
    return sp
  }

  /** public/fauna/fish.json and its three colour maps. Throws on a roster mismatch rather than drawing a species as a blank. */
  async load() {
    const res = await fetch(ASSET_URL)
    if (!res.ok) throw new Error(`fish: ${ASSET_URL} answered ${res.status} -- run tools/fauna/ship.mjs`)
    const assets = await res.json()
    const loader = new THREE.TextureLoader()
    for (const sp of this.species) {
      const asset = this.assetFor(assets, sp)
      this.setAsset(sp, asset)
      const tex = await loader.loadAsync(TEXTURE_URL(asset.texture))
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      sp.material.map = tex
      sp.material.needsUpdate = true
    }
    return true
  }

  /** The shipped mesh onto a species' InstancedMesh. Public so a gate can hand the JSON in without a fetch. */
  setAsset(sp, asset) {
    const n = asset.pos.length / 3
    if (asset.bend.length !== n || asset.uv.length !== n * 2 || asset.nrm.length !== n * 3) throw new Error(`fish: ${sp.id} asset attribute lengths disagree`)
    if (!(asset.lengthM > 0)) throw new Error(`fish: ${sp.id} has no lengthM`)
    const geo = sp.mesh.geometry
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(asset.pos), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(asset.nrm), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(asset.uv), 2))
    geo.setAttribute('aBend', new THREE.BufferAttribute(new Float32Array(asset.bend), 1))
    geo.setIndex(asset.idx)
    sp.lengthM = asset.lengthM
    // Two and a half radians of wave over one body length: the tail is a half-wave behind the head, which is what a real fish's undulation looks like at one glance.
    sp.material.defines.FISH_WAVE_K = (2.5 / asset.lengthM).toFixed(4)
    sp.material.needsUpdate = true
    sp.mesh.visible = true
    sp.loaded = true
  }

  // --- the beds ---------------------------------------------------------------

  /** Rebuild every bed around (cx, cz) and forget the loose fish. Boot, and whenever she is put down somewhere new. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    for (const sp of this.species) for (const f of sp.loose.slice()) this.unslot(sp, f)
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = cx
    this.walkedZ = cz
    this.shallows.evict(cx, cz, RADIUS + 1.5 * TILE)
  }

  _walkTiles(x, z) {
    if (Math.hypot(x - this.walkedX, z - this.walkedZ) <= WALK_M) return
    walkTiles(this.tiles, x, z, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.walkedX = x
    this.walkedZ = z
    this.shallows.evict(x, z, RADIUS + 1.5 * TILE)
  }

  /**
   * Null to roll each bed's sites anywhere in its tile, or [[x, z, depth, body], ...] to draw each species' sites from those spots that lie its minDepth deep: a cave's pools are each a sliver of a tile that a blind roll all but never lands in. A species' sites in a tile go to its bodies in turn, or one big pool takes them all. Place after.
   */
  setSpots(spots) {
    if (spots === null) { this.spots = null; return }
    this.spots = new Map()
    for (const [x, z, depth, body] of spots) {
      const key = bedKey(Math.floor(x / TILE), Math.floor(z / TILE))
      if (!this.spots.has(key)) this.spots.set(key, this.species.map(() => new Map()))
      this.species.forEach((sp, i) => {
        if (depth < sp.cfg.minDepth) return
        const bodies = this.spots.get(key)[i]
        if (!bodies.has(body)) bodies.set(body, [])
        bodies.get(body).push([x, z])
      })
    }
    for (const lists of this.spots.values()) lists.forEach((bodies, i) => { lists[i] = [...bodies.values()] })
  }

  /** The bed at tile (tx, tz): its schools from the tile seed, in species order, `s` the site's index in the bed and every member numbered through the bed. */
  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, key: bedKey(tx, tz), schools: [], fish: [], luredSent: '', luredAt: -Infinity }
    const lists = this.spots === null ? null : this.spots.get(t.key)
    if (lists === undefined) return t
    let index = 0
    let s = 0
    for (const [j, sp] of this.species.entries()) {
      const cfg = sp.cfg
      const bodies = lists === null ? null : lists[j]
      if (bodies !== null && bodies.length === 0) { s += cfg.perTile; continue }
      let b0 = 0
      for (let k = 0; k < cfg.perTile; k++, s++) {
        // Every roll first, so a site refused leaves the stream where an accepted one would.
        const u = rand(), v = rand()
        if (k === 0 && bodies !== null) b0 = Math.floor(u * bodies.length)
        const spots = bodies === null ? null : bodies[(b0 + k) % bodies.length]
        let x = (tx + u) * TILE
        let z = (tz + v) * TILE
        const n = Math.round(between(rand, cfg.school))
        const rolls = []
        for (let i = 0; i < n; i++) rolls.push(this._roll(rand, cfg, n))
        const first = index
        index += n
        let at = spots === null ? this.site(sp, x, z, cfg.clearance) : null
        // A spot too near the shore for the clearance tries the next, stepped by the golden ratio so the stream stays put.
        for (let tries = 0, w = u; spots !== null && at === null && tries < SPOT_TRIES; tries++, w = (w + GOLDEN) % 1) {
          [x, z] = spots[Math.floor(w * spots.length)]
          at = this.site(sp, x, z, cfg.clearance)
        }
        // A pool narrow but for a few clear spots: walk the list from where the tries began.
        for (let i = 0; spots !== null && at === null && i < spots.length; i++) {
          [x, z] = spots[(Math.floor(u * spots.length) + i) % spots.length]
          at = this.site(sp, x, z, cfg.clearance)
        }
        if (at === null || !sp.loaded) continue
        // A solo species does not seed on top of its own kind: two pike in a ditch now and then otherwise.
        if (cfg.school[1] === 1 && t.schools.some((o) => o.sp === sp && Math.hypot(o.home.x - x, o.home.z - z) < cfg.separation)) continue
        const key = keyOf(tx, tz, s)
        const school = {
          key, sp, tile: t, offset: keyHash(key) % GRID_S,
          home: { x, z, bed: at.bed, level: at.level },
          // The anchor at the last tick; `chapters` the hop chains by chapter index (_walk); `seg` the segment the members were last put at their stations for, `turnTick` the tick it ends on, `rec` their tick record (score.js stepTo), `mx`, `mz` the members where they were on the last tick any of them planned.
          x, z, y: this.column(at.bed, at.level, 0.5), fleeAt: 0, chapters: new Map(), seg: null, turnTick: 0, rec: { tick: 0, alpha: 0 }, mx: new Float64Array(n), mz: new Float64Array(n),
          members: [],
        }
        for (let i = 0; i < n; i++) {
          if (taken.has(`fish${first + i}`, x, z)) continue
          const f = sp.free.pop()
          if (!f) { this.overflow++; continue }
          this._seat(sp, f, school, first + i, rolls[i])
          school.members.push(f)
          t.fish.push(f)
        }
        if (school.members.length === 0) continue
        sp.schools.push(school)
        t.schools.push(school)
      }
    }
    return t
  }

  /** One member's rolls, in a fixed order, off the bed's stream. */
  _roll(rand, cfg, n) {
    return {
      spread: n > 1 ? rand() * cfg.schoolRadius : 0, b: rand() * TAU, depthFrac: between(rand, cfg.depth),
      sizeU: rand(), sizeJ: rand() * 2 - 1,
      // A big fish swims faster and beats slower than a small one of its kind, and each has its own temperament on top.
      pace: 0.8 + 0.4 * rand(), beat: 0.85 + 0.3 * rand(), verve: 0.6 + rand() * rand() * 1.4,
      ring: n > 1 ? (0.25 + 0.6 * rand()) * cfg.schoolRadius : 0, orbit: (rand() < 0.5 ? -1 : 1) * (0.05 + 0.2 * rand()),
      bobHz: 0.05 + 0.1 * rand(), bobAt: rand() * TAU, tint: 0.85 + rand() * 0.2, hue: (rand() * 2 - 1) * HUE, phase: rand() * TAU,
    }
  }

  /** Slot `f` as member `index` of `school` from its rolls `r`: spread around the home, unless that spot is shore, when it starts on the home itself. */
  _seat(sp, f, school, index, r) {
    const cfg = sp.cfg
    const home = school.home
    let fx = home.x + Math.cos(r.b) * r.spread
    let fz = home.z + Math.sin(r.b) * r.spread
    let level = this.water.levelAt(fx, fz)
    let bed = level === null ? 0 : this.height.heightAt(fx, fz)
    if (level === null || level - bed < cfg.minDepth) { fx = home.x; fz = home.z; level = home.level; bed = home.bed }
    f.alive = true
    f.loose = false
    f.school = school
    f.tile = school.tile
    f.index = index
    f.x = fx
    f.z = fz
    f.depthFrac = r.depthFrac
    f.bed = bed
    f.level = level
    f.scale = this.sizeAt(cfg, level - bed, r.sizeU, r.sizeJ)
    f.size = sp.lengthM * f.scale
    f.margin = 0.2 * f.size
    f.y = this.column(bed, level, f.depthFrac, f.margin)
    f.wander = r.b
    f.pace = r.pace * Math.sqrt(f.scale)
    f.beat = r.beat / Math.sqrt(f.scale)
    f.verve = r.verve
    f.ring = r.ring
    f.station0 = r.b
    f.orbit = r.orbit
    f.bobHz = r.bobHz
    f.bobAt = r.bobAt
    f.tint = r.tint
    f.hue = r.hue
    f.homingEnd = -1
    f.boltTick = Infinity
    f.mood = 'glide'
    f.moodEnd = 0
    f.speed = cfg.cruise
    f.rand = null
    f.ex = fx
    f.ey = f.y
    f.ez = fz
    f.stun = 0
    f.lure = null
    f.lured = false
    f.final = false
    f.listedAt = -1
    // Hanging where it was born until the first segment turn puts it at its station.
    this._hold(sp, f, this.now === null ? 0 : this.now, fx, f.y, fz, 0, 0, 0, r.phase)
    f.nextTick = Infinity
    this._occupy(sp, f)
  }

  /** Slot `f` live: its tint and hue into the species' buffers, and the mesh drawing as far as it. */
  _occupy(sp, f) {
    sp.mesh.instanceColor.array.fill(f.tint, f.id * 3, f.id * 3 + 3)
    sp.mesh.instanceColor.needsUpdate = true
    sp.hue.array[f.id] = f.hue
    sp.hue.needsUpdate = true
    sp.top = Math.max(sp.top, f.id + 1)
    if (f.size > this.biggest) this.biggest = f.size
  }

  /** Slot `f` free: its row emptied so the shader draws nothing for it, and the mesh drawn only as far as the last live slot. */
  _vacate(sp, f) {
    sp.rows.data.fill(0, f.id * FISH_ROW_TEXELS * 4, (f.id + 1) * FISH_ROW_TEXELS * 4)
    sp.rows.touch(f.id)
    while (sp.top > 0 && !sp.slots[sp.top - 1].alive) sp.top--
    sp.free.push(f)
    sp.free.sort((p, q) => q.id - p.id)
    this.biggestStale = true
  }

  _leave(t) {
    // A bed her hand had fish of: the room hears they are let go.
    if (t.luredSent !== '') this.owed.push([t.key, 'fs', null, []])
    this.luredIn.delete(t.key)
    for (const school of t.schools.slice()) this._retire(school)
    t.fish.length = 0
  }

  /** Every member back to the free list and the school off its species and its bed. */
  _retire(school) {
    const sp = school.sp
    for (const f of school.members) {
      f.alive = false
      f.school = null
      f.tile = null
      this._vacate(sp, f)
    }
    school.members.length = 0
    const i = sp.schools.indexOf(school)
    if (i >= 0) sp.schools.splice(i, 1)
    const j = school.tile.schools.indexOf(school)
    if (j >= 0) school.tile.schools.splice(j, 1)
  }

  /** One fish out of its school and its bed and back to the free list; the school goes with it when it was the last. */
  _drop(sp, f) {
    const school = f.school
    const t = f.tile
    school.members.splice(school.members.indexOf(f), 1)
    t.fish.splice(t.fish.indexOf(f), 1)
    this.unslot(sp, f)
    if (!school.members.length) this._retire(school)
  }

  /** A fish with no school -- one she let go of, or one just taken -- back to the free list. */
  unslot(sp, f) {
    if (f.loose) sp.loose.splice(sp.loose.indexOf(f), 1)
    f.alive = false
    f.loose = false
    f.stun = 0
    f.school = null
    f.tile = null
    f.index = -1
    f.lured = false
    f.lure = null
    this._vacate(sp, f)
  }

  get stats() {
    const out = { alive: 0, schools: 0, tiles: this.tiles.size, overflow: this.overflow, ticks: this.ticks, legs: this.legs, beached: this.beached, reads: this.shallows.reads }
    for (const sp of this.species) {
      const n = sp.cfg.count - sp.free.length
      out[sp.id] = { alive: n, schools: sp.schools.length }
      out.alive += n
      out.schools += sp.schools.length
    }
    return out
  }

  /**
   * Whether (x, z) is water deep enough for the species, with `clearance`
   * metres of the same on four sides: an anchor set right against the shore
   * pulls its school onto it. Returns { bed, level } or null.
   */
  site(sp, x, z, clearance) {
    const cfg = sp.cfg
    const level = this.water.levelAt(x, z)
    if (level === null) return null
    const bed = this.height.heightAt(x, z)
    if (level - bed < cfg.minDepth) return null
    for (let i = 0; i < 4 && clearance > 0; i++) {
      const cx = x + (i === 0 ? clearance : i === 1 ? -clearance : 0)
      const cz = z + (i === 2 ? clearance : i === 3 ? -clearance : 0)
      const l = this.water.levelAt(cx, cz)
      if (l === null || l - this.height.heightAt(cx, cz) < cfg.minDepth) return null
    }
    return { bed, level }
  }

  /** The vertical band at a site, [bed + margin, level - margin] narrowed by `extra` for a fish's own bulk, with `frac` of the way up it. */
  column(bed, level, frac, extra = 0) {
    const lo = bed + BED_MARGIN + extra
    const hi = level - SURFACE_MARGIN - extra
    if (hi <= lo) return (lo + hi) / 2
    return lo + (hi - lo) * frac
  }

  /**
   * A size for a fish born over `depth` metres of water from its rolls `u`
   * and `j` in [0, 1] and [-1, 1]. The ceiling climbs from 0.8 at the shore
   * to the species' size[1] at DEEP_M, and the draw's skew turns over with
   * it: shallow, most rolls land near the floor; deep, most land near the
   * ceiling and only the odd one is small.
   */
  sizeAt(cfg, depth, u, j) {
    const t = Math.max(0, Math.min(1, (depth - 0.5) / (DEEP_M - 0.5)))
    const ease = t * t * (3 - 2 * t)
    const top = 0.8 + (cfg.size[1] - 0.8) * ease
    const k = Math.pow(u, 2.2 - 1.75 * ease)
    return (cfg.size[0] + (top - cfg.size[0]) * k) * (1 + j * cfg.sizeVary)
  }

  // --- the anchor's chain -----------------------------------------------------

  /**
   * The hop chain of `school`'s chapter holding world time `t`, walked to
   * `t`: `events` is the anchor's state at each hop -- where it was, what it
   * was sent at, its depth -- from home at the chapter start, `bolts` the
   * frights not yet run through the shoal. The last two chapters are kept, so
   * a segment straddling a chapter turn reads both without rebuilding either.
   */
  _walk(school, t) {
    const c = chapterOf(t, school.key)
    let ch = school.chapters.get(c.index)
    if (ch === undefined) {
      const cfg = school.sp.cfg
      const rand = phraseRand(school.key, c.index, 0)
      const home = school.home
      ch = {
        index: c.index, start: c.start, end: c.start + CHAPTER_S, rand,
        hopAt: c.start + between(rand, cfg.anchorEvery),
        boltAt: cfg.boltEvery ? c.start + between(rand, cfg.boltEvery) : Infinity,
        // The last hop goes home, early enough to get there at the anchor's speed from the tether's edge.
        homeAt: c.start + CHAPTER_S - (cfg.tether / cfg.anchorSpeed + GRID_S), homed: false,
        events: [{ at: c.start, x: home.x, z: home.z, tx: home.x, tz: home.z, y: this.column(home.bed, home.level, between(rand, cfg.depth)) }],
        bolts: [],
      }
      for (const k of school.chapters.keys()) if (k < c.index - 1 || k > c.index + 1) school.chapters.delete(k)
      school.chapters.set(c.index, ch)
    }
    for (;;) {
      const next = Math.min(ch.hopAt, ch.boltAt, ch.homed ? Infinity : ch.homeAt)
      if (next > t) break
      this._event(school, ch, next)
    }
    return ch
  }

  /** The chain's next hop at world time `at`: the anchor moved to where it is, then a new target rolled -- kept only in the tether, over water all the way, deep enough with clearance at the end -- or home once and for all. */
  _event(school, ch, at) {
    const sp = school.sp
    const cfg = sp.cfg
    const rand = ch.rand
    const home = school.home
    const last = ch.events[ch.events.length - 1]
    const ev = { at, x: 0, z: 0, tx: last.tx, tz: last.tz, y: last.y }
    Fish._anchorOf(last, at, cfg.anchorSpeed, ev)
    if (!ch.homed && at >= ch.homeAt) {
      ch.homed = true
      ch.hopAt = Infinity
      ch.boltAt = Infinity
      const site = this._clear(sp, ev.x, ev.z, home.x, home.z)
      if (site !== null) { ev.tx = home.x; ev.tz = home.z; ev.y = this.column(site.bed, site.level, between(rand, cfg.depth)) }
    } else {
      const bolt = at >= ch.boltAt
      if (bolt) ch.boltAt = at + between(rand, cfg.boltEvery)
      else ch.hopAt = at + between(rand, cfg.anchorEvery)
      const a = rand() * TAU
      const hop = between(rand, bolt ? cfg.boltHop : cfg.anchorHop)
      const depth = between(rand, cfg.depth)
      const tx = ev.x + Math.cos(a) * hop
      const tz = ev.z + Math.sin(a) * hop
      const site = Math.hypot(tx - home.x, tz - home.z) <= cfg.tether ? this._clear(sp, ev.x, ev.z, tx, tz) : null
      if (site !== null) {
        ev.tx = tx
        ev.tz = tz
        ev.y = this.column(site.bed, site.level, depth)
        if (bolt) {
          // The anchor arrives at once. The fright does not: it starts at the edge the shoal flees from and runs through it (the tick).
          ch.bolts.push({ at, x: tx, z: tz, fx: tx - ev.x, fz: tz - ev.z, fd: hop })
          ev.x = tx
          ev.z = tz
        }
      }
    }
    ch.events.push(ev)
  }

  /** The anchor's position at `t` from the event `ev` before it: on its way to the target at `speed`, or there. */
  static _anchorOf(ev, t, speed, into) {
    const dx = ev.tx - ev.x
    const dz = ev.tz - ev.z
    const d = Math.hypot(dx, dz)
    const step = Math.min(d, speed * (t - ev.at))
    into.x = d > 0 ? ev.x + (dx / d) * step : ev.x
    into.z = d > 0 ? ev.z + (dz / d) * step : ev.z
    into.y = ev.y
    return into
  }

  /** The anchor at world time `t`, into `into` (x, z, y); the chain it was read off is returned on `into.ch`. */
  _anchorAt(school, t, into) {
    const ch = this._walk(school, t)
    let i = ch.events.length - 1
    while (i > 0 && ch.events[i].at > t) i--
    Fish._anchorOf(ch.events[i], t, school.sp.cfg.anchorSpeed, into)
    into.ch = ch
    return into
  }

  /** The site at (x1, z1) with clearance, when the way there from (x0, z0) is water deep enough every HOP_STEP_M; null otherwise. */
  _clear(sp, x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0)
    const steps = Math.max(1, Math.ceil(d / HOP_STEP_M))
    for (let i = 1; i < steps; i++) {
      if (!this.site(sp, x0 + (x1 - x0) * (i / steps), z0 + (z1 - z0) * (i / steps), 0)) return null
    }
    return this.site(sp, x1, z1, sp.cfg.clearance)
  }

  // --- the segments -----------------------------------------------------------

  /**
   * Segment `g` begins for `school`: the chain is walked through it, and every
   * member not on a lure is put at its station for the segment's start
   * (_start) with its mood rolled from (key, g, index), on a one-tick leg its
   * first tick replans from. A lured fish keeps swimming and is put back at the
   * next turn it is free for.
   */
  _reset(sp, school, g) {
    const cfg = sp.cfg
    const start = g * GRID_S + school.offset
    const t0 = tickAfter(start)
    school.seg = g
    school.rec.tick = t0 - 1
    school.turnTick = tickAfter(start + GRID_S)
    const ch = this._walk(school, start + GRID_S)
    // The chain before the segment is history: one event stands for the anchor at its start, and no fright before it reaches a fish put freshly at its station.
    while (ch.events.length > 1 && ch.events[1].at <= start) ch.events.shift()
    while (ch.bolts.length && ch.bolts[0].at < start) ch.bolts.shift()
    this._anchorAt(school, start, _a)
    school.x = _a.x
    school.z = _a.z
    school.y = _a.y
    for (const f of school.members) {
      f.rand = mulberry32(hash32(keyHash(school.key), g, f.index))
      const rand = f.rand
      this._start(sp, f, school, g, rand, _n)
      f.ex = _n.ex; f.ey = _n.ey; f.ez = _n.ez
      f.final = false
      if (f.lured) continue
      let left
      if (cfg.glide) {
        if (rand() < 0.6) { f.mood = 'glide'; left = rand() * cfg.glide[1]; f.speed = cfg.cruise }
        else { f.mood = 'lurk'; left = rand() * cfg.lurk[1]; f.speed = cfg.lurkSpeed }
      } else {
        f.mood = 'glide'
        left = rand() * cfg.fidgetEvery[1]
        f.speed = cfg.cruise
      }
      f.moodEnd = t0 + Math.ceil(left * TICK_HZ)
      f.boltTick = Infinity
      f.homingEnd = -1
      f.wander = _n.w
      const v = cfg.cruise * f.pace
      this._hold(sp, f, t0 * TICK_S, _n.x, _n.y, _n.z, Math.cos(_n.w) * v, 0, Math.sin(_n.w) * v, this._eval(f, t0 * TICK_S, _st).phase)
      this._publish(sp, f)
      f.nextTick = t0
    }
  }

  /** Fish `f`'s pose at the start of segment `g`, into `o`: its station about the anchor (x, y, z), heading `w` for the station the segment ends at (ex, ey, ez), or a fresh heading off `rand` where that station stays put. */
  _start(sp, f, school, g, rand, o) {
    const start = g * GRID_S + school.offset
    const station = f.station0 + f.orbit * start
    this._anchorAt(school, start + GRID_S, _e)
    this._station(sp, f, _e, station + f.orbit * GRID_S, _s)
    o.ex = _s.sx; o.ey = _s.sy; o.ez = _s.sz
    this._anchorAt(school, start, _e)
    this._station(sp, f, _e, station, _s)
    o.x = _s.sx; o.y = _s.sy; o.z = _s.sz
    const ed = Math.hypot(o.ex - o.x, o.ez - o.z)
    o.w = ed > 0.05 ? Math.atan2(o.ez - o.z, o.ex - o.x) : rand() * TAU
    return o
  }

  /** Fish `f`'s station about the anchor `a` at ring angle `station`, into `into` (sx, sy, sz, and the bed and level there): over water deep enough, else the anchor. */
  _station(sp, f, a, station, into) {
    let sx = a.x + Math.cos(station) * f.ring
    let sz = a.z + Math.sin(station) * f.ring
    const w = this.shallows.at(sx, sz, _w)
    if (!w.wet || w.level - w.bed < sp.cfg.minDepth) {
      sx = a.x
      sz = a.z
      this.shallows.at(sx, sz, w)
      if (!w.wet) throw new Error(`Fish: the anchor of ${f.school.key} is on dry ground at (${sx.toFixed(1)}, ${sz.toFixed(1)})`)
    }
    into.sx = sx
    into.sy = this.column(w.bed, w.level, f.depthFrac, f.margin)
    into.sz = sz
    into.bed = w.bed
    into.level = w.level
  }

  /** One tick of `school`: the anchor read off its chain, a fright due run through the shoal, and every member whose leg is over given its next. */
  _tick(sp, school, tick) {
    this.ticks++
    const tNow = tick * TICK_S
    const ch = this._anchorAt(school, tNow, _a).ch
    school.x = _a.x
    school.z = _a.z
    school.y = _a.y
    while (ch.bolts.length && ch.bolts[0].at <= tNow) this._fright(sp, school, ch.bolts.shift(), tick)
    const m = school.members
    let due = false
    for (const f of m) if (f.nextTick <= tick) { due = true; break }
    if (!due) return
    // Every member where it is on this tick, before any replans: the same whichever plans first, since a leg starts where the last one stood.
    for (let i = 0; i < m.length; i++) {
      this._eval(m[i], tNow, _st)
      school.mx[i] = _st.x
      school.mz[i] = _st.z
    }
    const w = easeWeight(tNow - (school.seg * GRID_S + school.offset), GRID_S)
    for (let i = 0; i < m.length; i++) if (m[i].nextTick <= tick) this._plan(sp, m[i], school, tick, w, i)
  }

  /** A fright `b` through the shoal: each fish bolts when the wave reaches it, at its own delay on top, and BOLT_MISS of them never notice and just get pulled along after. A fish on a lure or on its last leg into the turn lets it pass. */
  _fright(sp, school, b, tick) {
    school.fleeAt = Math.atan2(b.fz, b.fx)
    for (const f of school.members) {
      if (f.rand() < BOLT_MISS) continue
      this._eval(f, tick * TICK_S, _st)
      const along = ((_st.x - b.x) * b.fx + (_st.z - b.z) * b.fz) / b.fd + sp.cfg.schoolRadius
      const delay = Math.max(0, along) / BOLT_WAVE + f.rand() * BOLT_JITTER
      if (f.lured || f.final) continue
      f.boltTick = tick + Math.max(0, Math.ceil(delay * TICK_HZ - 1e-9) - 1)
      f.nextTick = Math.min(f.nextTick, f.boltTick)
    }
  }

  /**
   * Fish `f`'s next leg from tick `tick`: where its last one has it, a look at
   * the water under it and ahead (the shared Shallows), its mood and its aim
   * -- the wander, its station, the shore, a lure, the ease onto the end
   * station by weight `w`, its school-mates at `school.mx/mz` -- then the swim
   * toward that aim integrated to the leg's end, and the quintic through both
   * ends written to its row. The last leg before the turn lands on the next
   * segment's start pose instead, so the turn moves nothing.
   */
  _plan(sp, f, school, tick, w, i) {
    const cfg = sp.cfg
    const rand = f.rand
    const t = tick * TICK_S
    this.legs++
    const S = this._eval(f, t, _st)
    let x = S.x, y = S.y, z = S.z, ax = S.ax, ay = S.ay, az = S.az
    const vx = S.vx, vy = S.vy, vz = S.vz, hx0 = S.hx, hz0 = S.hz, phase = S.phase
    const under = this.shallows.at(x, z, _w)
    if (!under.wet || under.level - under.bed < BED_MARGIN + SURFACE_MARGIN) {
      // On the bank anyway: put back at the anchor, the one spot known to be deep.
      this.beached++
      x = school.x
      z = school.z
      this.shallows.at(x, z, under)
      if (!under.wet) throw new Error(`Fish: the anchor of ${school.key} is on dry ground at (${x.toFixed(1)}, ${z.toFixed(1)})`)
      y = this.column(under.bed, under.level, f.depthFrac, f.margin)
      ax = ay = az = 0
    }
    f.bed = under.bed
    f.level = under.level
    const cx = under.cx, cz = under.cz

    // The startle wave reaching this fish: it bolts at its own speed, a little off the shoal's line, and the wander is re-aimed so it stays on that line when the bolt ends.
    if (f.boltTick > tick && f.boltTick < tick + MIN_LEG) f.boltTick = tick + MIN_LEG
    if (f.boltTick <= tick) {
      f.boltTick = Infinity
      f.mood = 'bolt'
      f.moodEnd = tick + Math.ceil(cfg.boltFor * (0.6 + 0.8 * rand()) * TICK_HZ)
      f.speed = cfg.boltSpeed * (0.7 + 0.6 * rand())
      f.wander = school.fleeAt + (rand() - 0.5) * 1.2
      this.setOff(f)
    }
    // Moods. Pike cycle glide -> lurk -> burst -> glide; bass and glimmerfin fidget, each fish on its own clock: a dart or a hang, with a kick to the heading either way.
    if (f.moodEnd < tick + MIN_LEG) {
      let left
      if (cfg.glide) {
        if (f.mood === 'glide') { f.mood = 'lurk'; left = between(rand, cfg.lurk); f.speed = cfg.lurkSpeed }
        else if (f.mood === 'lurk') { f.mood = 'burst'; left = cfg.burst; f.speed = cfg.burstSpeed; f.wander += (rand() - 0.5) * 1.5; this.setOff(f) }
        else { f.mood = 'glide'; left = between(rand, cfg.glide); f.speed = cfg.cruise }
      } else if (f.mood === 'glide') { f.mood = 'fidget'; left = cfg.fidgetFor * (0.7 + 0.6 * rand()); f.speed = rand() < 0.6 ? cfg.fidgetSpeed : cfg.cruise / 3; f.wander += (rand() - 0.5) * 3; this.setOff(f) }
      else { f.mood = 'glide'; left = between(rand, cfg.fidgetEvery); f.speed = cfg.cruise }
      f.moodEnd = tick + Math.max(MIN_LEG, Math.ceil(left * TICK_HZ))
    }

    // The water ahead along its course; a big fish wants proportionally more of it.
    const spd = Math.hypot(vx, vz)
    const ux = spd > 0.02 ? vx / spd : Math.cos(f.wander)
    const uz = spd > 0.02 ? vz / spd : Math.sin(f.wander)
    const ahead = this.shallows.at(x + ux * cfg.lookahead, z + uz * cfg.lookahead, _w2)
    if ((!ahead.wet || ahead.level - ahead.bed < cfg.minDepth * 0.6 * Math.max(1, f.scale)) && f.homingEnd <= tick) f.homingEnd = tick + HOMING_TICKS

    // The leg's length, ending on the mood's end or the fright's arrival, each at least MIN_LEG off.
    const lured = f.lure !== null
    let n = Math.round(between(rand, cfg.leg) * TICK_HZ)
    if (lured) n = Math.round(LURE_LEG_S * TICK_HZ)
    n = Math.max(MIN_LEG, Math.min(n, f.moodEnd - tick, f.boltTick - tick))
    f.wander += (rand() - 0.5) * cfg.wander * f.verve * Math.sqrt(n * TICK_S) * 2

    // The aim: the wander, pulled toward its own station in the school when it has strayed, turned hard for the anchor when the shore is ahead, onto a lure's bearing when it has one.
    let dx = Math.cos(f.wander)
    let dz = Math.sin(f.wander)
    const station = f.station0 + f.orbit * t
    const sx = school.x + Math.cos(station) * f.ring - x
    const sz = school.z + Math.sin(station) * f.ring - z
    const sd = Math.hypot(sx, sz)
    if (f.homingEnd > tick) {
      const hx = school.x - x
      const hz = school.z - z
      const hd = Math.hypot(hx, hz)
      if (hd > 0.5) {
        dx = (hx / hd) * 2
        dz = (hz / hd) * 2
        // Re-aim the walk itself, so the fish is still heading in when homing ends rather than turning straight back.
        f.wander = Math.atan2(hz, hx)
      }
    }
    if (lured) {
      dx = f.lure.x - x
      dz = f.lure.z - z
    }
    const stray = lured ? 0 : sd / cfg.schoolRadius
    if (stray > 0.6) {
      const pull = f.mood === 'bolt' ? 3 : Math.min(2.5, (stray - 0.6) * 1.5)
      dx += (sx / sd) * pull
      dz += (sz / sd) * pull
    }
    // The ease: over the segment's last EASE_S the aim turns onto the station the next segment starts it at, so its last leg has little left to close.
    const ex = f.ex - x
    const ez = f.ez - z
    const ed = Math.hypot(ex, ez)
    if (w > 0 && !lured && ed > 0.05) {
      const dl = Math.hypot(dx, dz)
      dx = (dx / dl) * (1 - w) + (ex / ed) * w * 3
      dz = (dz / dl) * (1 - w) + (ez / ed) * w * 3
    }
    // Separation: from school-mates where they stand this tick, or for a solo species from every other school of its kind in the bed at its anchor. Other species are ignored; they are going about their own business.
    const sep = cfg.separation
    Fish._apart(x, z, school.mx, school.mz, school.members.length, i, sep, _o)
    dx += _o.x
    dz += _o.z
    if (cfg.school[1] === 1) {
      for (const s of school.tile.schools) {
        if (s.sp !== sp || s === school) continue
        this._anchorAt(s, t, _o)
        const gx = x - _o.x, gz = z - _o.z
        const d2 = gx * gx + gz * gz
        if (d2 < sep * sep && d2 > 1e-6) {
          const d = Math.sqrt(d2)
          dx += (gx / d) * ((sep - d) / sep) * 2
          dz += (gz / d) * ((sep - d) / sep) * 2
        }
      }
    }
    // A fish left behind swims harder to rejoin: without this a shoal that cruises slower than its anchor drifts never catches it.
    let speed = (lured ? cfg.cruise * LURE_HASTE : f.speed) * f.pace * Math.max(1, Math.min(2.5, stray))
    // Easing, it keeps the pace that gets it there by the turn.
    if (w > 0 && !lured) speed = Math.max(speed, (w * ed) / Math.max(TICK_S, (school.turnTick - tick) * TICK_S - 0.5 * FINAL_TICKS * TICK_S))
    let aim = Math.atan2(dz, dx)
    // No leg carries a fish past its lookahead: the probe ahead is what keeps it off the shore.
    n = Math.max(MIN_LEG, Math.min(n, Math.floor((cfg.lookahead / Math.max(speed, 0.05)) * TICK_HZ)))
    const final = !lured && school.turnTick - (tick + n) < FINAL_TICKS
    if (final) n = school.turnTick - tick
    f.final = final
    const D = n * TICK_S

    if (final) {
      this._start(sp, f, school, school.seg + 1, mulberry32(hash32(keyHash(school.key), school.seg + 1, f.index)), _n)
      const v = cfg.cruise * f.pace
      _sw.x = _n.x; _sw.y = _n.y; _sw.z = _n.z
      _sw.vx = Math.cos(_n.w) * v; _sw.vy = 0; _sw.vz = Math.sin(_n.w) * v
      _sw.ax = _sw.ay = _sw.az = 0
      _sw.th = _n.w
      // The quintic is in still water; the drift is added on top.
      _sw.x -= cx * D
      _sw.z -= cz * D
    } else {
      // Depth: its own place in the column, bobbing slowly about it, drawn halfway to the school's so a shoal rises and sinks together; a lured fish the hand's height. Held inside the column here and where the leg is headed.
      let lo = under.bed + BED_MARGIN + f.margin
      let hi = under.level - SURFACE_MARGIN - f.margin
      const there = this.shallows.at(x + Math.cos(aim) * speed * D, z + Math.sin(aim) * speed * D, _w3)
      if (there.wet) {
        lo = Math.max(lo, there.bed + BED_MARGIN + f.margin)
        hi = Math.min(hi, there.level - SURFACE_MARGIN - f.margin)
      }
      if (hi < lo) lo = hi = (lo + hi) / 2
      const bob = 0.06 * Math.sin((t + D) * TAU * f.bobHz + f.bobAt)
      const ty = lured ? Math.max(lo, Math.min(hi, f.lure.y)) : 0.5 * (this.column(under.bed, under.level, f.depthFrac + bob, f.margin) + school.y)
      const th0 = spd > 0.02 ? Math.atan2(vz, vx) : Math.atan2(hz0, hx0)
      this._swim(cfg, th0, spd, x, y, z, vy, aim, speed, ty, lo, hi, n, lured, _sw)
      const end = this.shallows.at(_sw.x + cx * D, _sw.z + cz * D, _w3)
      if ((!end.wet || end.level - end.bed < BED_MARGIN + SURFACE_MARGIN) && school.x !== x) {
        // The leg would end on the bank: swim it for the anchor instead.
        f.homingEnd = tick + HOMING_TICKS
        aim = Math.atan2(school.z - z, school.x - x)
        f.wander = aim
        this._swim(cfg, th0, spd, x, y, z, vy, aim, speed, ty, lo, hi, n, lured, _sw)
      }
      if (lured) f.wander = _sw.th
    }

    const L = f.L
    const k = L.k
    const eps = FACE_EPS * cfg.cruise
    L.t0 = t
    L.d = D
    Fish._quintic(k, 0, x, vx * D, ax * D * D, _sw.x, _sw.vx * D, _sw.ax * D * D)
    Fish._quintic(k, 6, y, vy * D, ay * D * D, _sw.y, _sw.vy * D, _sw.ay * D * D)
    Fish._quintic(k, 12, z, vz * D, az * D * D, _sw.z, _sw.vz * D, _sw.az * D * D)
    L.cx = cx
    L.cz = cz
    L.h0x = hx0
    L.h0z = hz0
    L.h1x = Math.cos(_sw.th) * eps
    L.h1z = Math.sin(_sw.th) * eps
    this._tail(sp, f, L, phase)
    f.nextTick = tick + n
    f.poseFrame = -1
    this._publish(sp, f)
  }

  /**
   * The swim of one leg of `n` ticks toward heading `aim` at `speed`, from
   * heading `th` and speed `s`, in SUB_S steps: the heading turns onto the aim
   * at TURN_GAIN times the agility and no faster than TURN_MAX times it (a
   * lured fish at LURE_TURN, so it runs through the hand and comes round), the
   * speed chases its target, the climb chases height `ty` inside [lo, hi].
   * Into `o`: the end in still water (x, y, z), its velocity, its
   * acceleration and heading `th`.
   */
  _swim(cfg, th, s, x, y, z, vy, aim, speed, ty, lo, hi, n, lured, o) {
    const D = n * TICK_S
    const steps = Math.max(1, Math.ceil(D / SUB_S - 1e-9))
    const h = D / steps
    const kA = cfg.agility * (lured ? LURE_AGILITY : 1)
    const turnMax = lured ? LURE_TURN : cfg.agility * TURN_MAX
    const kv = Math.min(1, kA * h)
    const ky = Math.min(1, 2 * h)
    const climb = Math.max(0.3, speed / cfg.cruise)
    let om = 0, ds = 0, dvy = 0
    for (let j = 0; j < steps; j++) {
      const sw = Math.atan2(Math.sin(aim - th), Math.cos(aim - th))
      om = Math.max(-turnMax, Math.min(turnMax, sw * kA * TURN_GAIN))
      if (Math.abs(om * h) > Math.abs(sw)) om = sw / h
      th += om * h
      ds = (speed - s) * kv / h
      s += ds * h
      const wantY = Math.max(-0.4, Math.min(0.4, (ty - y) * 0.6)) * climb
      dvy = (wantY - vy) * ky / h
      vy += dvy * h
      x += s * Math.cos(th) * h
      z += s * Math.sin(th) * h
      y += vy * h
      if (y < lo) { y = lo; if (vy < 0) vy = 0; dvy = 0 }
      if (y > hi) { y = hi; if (vy > 0) vy = 0; dvy = 0 }
    }
    const c = Math.cos(th), sn = Math.sin(th)
    o.x = x; o.y = y; o.z = z
    o.vx = s * c; o.vy = vy; o.vz = s * sn
    o.ax = ds * c - s * om * sn; o.ay = dvy; o.az = ds * sn + s * om * c
    o.th = th
    return o
  }

  /** The quintic in the leg's own time s in [0, 1] through position `p0`, velocity `v0` and acceleration `a0` (per unit s) at 0 and `p1`, `v1`, `a1` at 1, into `k` from `at`. */
  static _quintic(k, at, p0, v0, a0, p1, v1, a1) {
    const dp = p1 - p0
    k[at] = p0
    k[at + 1] = v0
    k[at + 2] = a0 / 2
    k[at + 3] = 10 * dp - 6 * v0 - 4 * v1 - 1.5 * a0 + 0.5 * a1
    k[at + 4] = -15 * dp + 8 * v0 + 7 * v1 + 1.5 * a0 - a1
    k[at + 5] = 6 * dp - 3 * v0 - 3 * v1 - 0.5 * a0 + 0.5 * a1
  }

  /** The tail on leg `L` from `phase` at its start: its beat, the speed it scales by, its amplitude, and the swim speed through the leg fitted as a quadratic in seconds so the phase it integrates to is closed-form. */
  _tail(sp, f, L, phase) {
    const cfg = sp.cfg
    const D = L.d
    L.ph0 = phase % TAU
    L.rate = TAU * cfg.tailHz * f.beat
    L.inv = 1 / (cfg.cruise * f.pace)
    L.amp = f.stun > 0 ? 0 : cfg.tailAmp * sp.lengthM
    const s0 = Fish._legSpeed(L.k, 0, D)
    const sm = Fish._legSpeed(L.k, 0.5, D)
    const s1 = Fish._legSpeed(L.k, 1, D)
    L.s0 = s0
    L.sc = (2 * (s1 - 2 * sm + s0)) / (D * D)
    L.sb = (s1 - s0) / D - L.sc * D
  }

  static _legSpeed(k, s, D) {
    let q = 0
    for (let a = 0; a < 18; a += 6) {
      const v = k[a + 1] + s * (2 * k[a + 2] + s * (3 * k[a + 3] + s * (4 * k[a + 4] + s * 5 * k[a + 5])))
      q += v * v
    }
    return Math.sqrt(q) / D
  }

  /** A leg of one tick from (x, y, z) at velocity (vx, vy, vz), facing along it, from tail `phase` at world time `t`: a fish's pose where no planned leg has it yet. */
  _hold(sp, f, t, x, y, z, vx, vy, vz, phase) {
    const L = f.L
    const D = TICK_S
    L.t0 = t
    L.d = D
    L.k.fill(0)
    L.k[0] = x; L.k[1] = vx * D
    L.k[6] = y; L.k[7] = vy * D
    L.k[12] = z; L.k[13] = vz * D
    const w = this.shallows.at(x, z, _w)
    L.cx = w.wet ? w.cx : 0
    L.cz = w.wet ? w.cz : 0
    const eps = FACE_EPS * sp.cfg.cruise
    L.h0x = L.h1x = Math.cos(f.wander) * eps
    L.h0z = L.h1z = Math.sin(f.wander) * eps
    this._tail(sp, f, L, phase)
    f.poseFrame = -1
  }

  /**
   * Fish `f`'s leg at world time `t`, into `o`: position, swim velocity and
   * acceleration, the facing's lean (hx, hz) and the tail phase. Past the
   * leg's end it carries on at its last velocity, its acceleration held for
   * the look so a frame on the end tick turns the same either side; before its start (a turn's
   * hold, put a tick ahead) the polynomial runs backward. The CPU twin of fishRow
   * (FISH_GLSL), in float64.
   */
  _eval(f, t, o) {
    const L = f.L
    const k = L.k
    const D = L.d
    const u = t - L.t0
    const s = Math.min(1, u / D)
    const over = u - s * D
    const ea = 1 / (D * D)
    for (let a = 0, j = 0; a < 3; a++, j += 6) {
      const p = k[j] + s * (k[j + 1] + s * (k[j + 2] + s * (k[j + 3] + s * (k[j + 4] + s * k[j + 5]))))
      const v = (k[j + 1] + s * (2 * k[j + 2] + s * (3 * k[j + 3] + s * (4 * k[j + 4] + s * 5 * k[j + 5])))) / D
      const acc = (2 * k[j + 2] + s * (6 * k[j + 3] + s * (12 * k[j + 4] + s * 20 * k[j + 5]))) * ea
      if (a === 0) { o.x = p + v * over + L.cx * u; o.vx = v; o.ax = acc }
      else if (a === 1) { o.y = p + v * over; o.vy = v; o.ay = acc }
      else { o.z = p + v * over + L.cz * u; o.vz = v; o.az = acc }
    }
    o.hx = L.h0x + (L.h1x - L.h0x) * s
    o.hz = L.h0z + (L.h1z - L.h0z) * s
    o.dhx = (L.h1x - L.h0x) / D
    o.dhz = (L.h1z - L.h0z) / D
    const wu = Math.min(u, D)
    const s1 = L.s0 + L.sb * D + L.sc * D * D
    o.phase = L.ph0 + L.rate * (0.4 * u + 0.6 * L.inv * (wu * (L.s0 + wu * (L.sb * 0.5 + wu * L.sc / 3)) + s1 * over))
    return o
  }

  /** Fish `f`'s place at the clock of the last update onto x, y, z, its swim velocity and its tail phase, worked out once a frame and only when something asks. A loose fish's place and velocity are its own integration. */
  pos(f) {
    if (!f.alive || f.poseFrame === this.frame || this.now === null) return f
    f.poseFrame = this.frame
    const o = this._eval(f, this.now, _pe)
    if (!f.loose) {
      f.x = o.x; f.y = o.y; f.z = o.z
      f.vx = o.vx; f.vy = o.vy; f.vz = o.vz
    }
    f.phase = o.phase
    return f
  }

  /** pos, and the look the shader draws onto the fish's fields: facing (hx, hz), yaw, pitch, roll, curve, lift and the tail's amplitude. */
  pose(f) {
    this.pos(f)
    if (!f.alive || this.now === null) return f
    const look = Fish._look(this._eval(f, this.now, _pe), f.L, f.sp.lengthM)
    if (!f.loose) {
      const fl = Math.hypot(look.fx, look.fz)
      f.hx = look.fx / fl
      f.hz = look.fz / fl
    }
    f.yaw = look.yaw
    f.pitch = look.pitch
    f.roll = look.roll
    f.curve = look.curve
    f.lift = look.lift
    f.amp = look.amp
    return f
  }

  /**
   * The look of an evaluated leg `o`: facing along the swim velocity leaned
   * onto the leg's heading, so a hanging fish points somewhere; the turn (the
   * facing's own turn rate over 6, the sine of the lag a 6/s filter would
   * carry) rolls it and arcs the tail to the inside; the pitch is the climb's
   * and the lift arcs the body into it; the tail beats harder with speed and
   * through a turn.
   */
  static _look(o, L, len) {
    const fx = o.vx + o.hx
    const fz = o.vz + o.hz
    const dfx = o.ax + o.dhx
    const dfz = o.az + o.dhz
    const turn = Math.max(-1, Math.min(1, (fx * dfz - fz * dfx) / Math.max(fx * fx + fz * fz, 1e-6) / 6))
    const hs = Math.hypot(o.vx, o.vz)
    const H = Math.max(hs, 0.05)
    const pitch = Math.atan2(o.vy, H)
    const dhs = hs > 0.05 ? (o.vx * o.ax + o.vz * o.az) / hs : 0
    const dpitch = (H * o.ay - o.vy * dhs) / (H * H + o.vy * o.vy)
    const rel = Math.hypot(o.vx, o.vy, o.vz) * L.inv
    _lk.fx = fx
    _lk.fz = fz
    _lk.yaw = Math.atan2(-fx, -fz)
    _lk.pitch = pitch
    _lk.roll = -turn * 0.5
    _lk.curve = Math.max(-0.4, Math.min(0.4, turn * 2)) * len
    _lk.lift = Math.max(-0.3, Math.min(0.3, dpitch * 0.2 + pitch * 0.8)) * len
    _lk.amp = L.amp * Math.min(1.6, 0.5 + 0.5 * rel) * (1 + 2 * Math.abs(turn))
    return _lk
  }

  /** Fish `f`'s row: its leg as FISH_ROW_TEXELS lays it out. */
  _publish(sp, f) {
    const d = sp.rows.data
    const o = f.id * FISH_ROW_TEXELS * 4
    const L = f.L
    const k = L.k
    const hi = Math.floor(L.t0 / TIME_HI) * TIME_HI
    d[o] = k[0]; d[o + 1] = k[1]; d[o + 2] = k[2]; d[o + 3] = k[3]
    d[o + 4] = k[4]; d[o + 5] = k[5]; d[o + 6] = k[10]; d[o + 7] = k[11]
    d[o + 8] = k[6]; d[o + 9] = k[7]; d[o + 10] = k[8]; d[o + 11] = k[9]
    d[o + 12] = k[12]; d[o + 13] = k[13]; d[o + 14] = k[14]; d[o + 15] = k[15]
    d[o + 16] = k[16]; d[o + 17] = k[17]; d[o + 18] = L.cx; d[o + 19] = L.cz
    d[o + 20] = L.t0 - hi; d[o + 21] = L.d; d[o + 22] = hi; d[o + 23] = f.scale
    d[o + 24] = L.h0x; d[o + 25] = L.h0z; d[o + 26] = L.h1x; d[o + 27] = L.h1z
    d[o + 28] = L.ph0; d[o + 29] = L.rate; d[o + 30] = L.inv; d[o + 31] = L.amp
    d[o + 32] = L.s0; d[o + 33] = L.sb; d[o + 34] = L.sc; d[o + 35] = sp.lengthM
    sp.rows.touch(f.id)
  }

  /** The push from (x, z) away from the school-mates at (mx, mz)[0, n) within `sep` metres, skipping `self`, into `out`. */
  static _apart(x, z, mx, mz, n, self, sep, out) {
    out.x = 0
    out.z = 0
    for (let j = 0; j < n; j++) {
      if (j === self) continue
      const gx = x - mx[j]
      const gz = z - mz[j]
      const d2 = gx * gx + gz * gz
      if (d2 < sep * sep && d2 > 1e-6) {
        const d = Math.sqrt(d2)
        out.x += (gx / d) * ((sep - d) / sep) * 2
        out.z += (gz / d) * ((sep - d) / sep) * 2
      }
    }
    return out
  }

  // --- the lures --------------------------------------------------------------

  /** The lure fish `f` is on this frame: the nearest of `lures` it wants, noticed within LURE_M of the hand and kept to LURE_FORGET_M -- from LURE_M on when a peer's set says that hand already has it. Taken up at a dart the ear hears, let go of at a cruise. */
  _notice(f, lures) {
    this.pos(f)
    const tall = PREY.heightM * this.size
    if (f.size > PREY.nibble * tall) {
      const her = this.her
      const d = Math.hypot(her.x - f.x, her.y - f.y, her.z - f.z)
      if (d <= PREY.notice * f.size * (f.lure === her ? 2 : 1)) {
        if (f.lure !== her) { f.lure = her; f.lured = true; f.speed = f.school.sp.cfg.cruise * LURE_HASTE; this.setOff(f); this._soon(f) }
        return
      }
    }
    if (f.lure === this.her) f.lure = null
    let lure = null
    let best = Infinity
    for (const l of lures) {
      if (!LURES.includes(l.kind)) continue
      const d = Math.hypot(l.x - f.x, l.y - f.y, l.z - f.z)
      if (d < best) { best = d; lure = l }
    }
    if (lure !== null) {
      const set = lure.by !== null ? this.luredIn.get(f.tile.key) : undefined
      const kept = f.lured || (set !== undefined && set.by === lure.by && set.has.has(f.index))
      if (best <= (kept ? LURE_FORGET_M : LURE_M)) {
        f.lure = lure
        if (!f.lured) { f.lured = true; f.speed = f.school.sp.cfg.cruise * LURE_HASTE; this.setOff(f); this._soon(f) }
        return
      }
    }
    if (!f.lured) return
    f.lured = false
    f.lure = null
    f.speed = f.school.sp.cfg.cruise
    this._soon(f)
  }

  /** Fish `f` replans on its school's next tick, a lure having taken it or let it go. */
  _soon(f) {
    f.nextTick = Math.min(f.nextTick, f.school.rec.tick + 1)
  }

  /** Her size, a multiple of her full height: which fish take her for prey (PREY). */
  sized(size) {
    if (!(size > 0)) throw new Error(`Fish.sized: ${size}`)
    this.size = size
  }

  /** Every fish on her within half its length of her head bites her, or, over PREY.gulp times her height, swallows her and no other fish gets a bite. */
  _prey(now) {
    const her = this.her
    const tall = PREY.heightM * this.size
    for (const t of this.tiles.values()) {
      for (const f of t.fish) {
        if (f.lure !== her || Math.hypot(her.x - this.pos(f).x, her.y - f.y, her.z - f.z) > f.size * 0.5) continue
        const why = `a ${f.school.sp.id}`
        if (f.size > PREY.gulp * tall) {
          if (this.swallow === null) throw new Error('Fish: a fish swallows her, and no swallow() to end her with')
          this.swallow(why)
          return
        }
        if (now - f.bitT < PREY.biteS) continue
        if (this.harm === null) throw new Error('Fish: a fish bites her, and no harm() to hurt her with')
        f.bitT = now
        this.harm(PREY.harm, why, f)
      }
    }
  }

  /** The lured sets owed since the last call, pushed onto `into` (creature-net.js): `[bedKey, 'fs', null, indices]`, one a bed. */
  pendingLured(into = []) {
    for (const set of this.owed) into.push(set)
    this.owed.length = 0
    return into
  }

  /** A peer's lured set for one of the beds: the fish its hand has, kept from LURE_M on while that hand's lure is near them. */
  applyLured(set) {
    if (!Array.isArray(set) || set.length !== 4 || typeof set[0] !== 'string' || !Array.isArray(set[3])) throw new Error(`Fish.applyLured: bad set ${JSON.stringify(set)}`)
    if (set[3].length === 0) this.luredIn.delete(set[0])
    else this.luredIn.set(set[0], { by: set[2], has: new Set(set[3]) })
  }

  /** Bed `t`'s lured set owed when the fish her own hand has changed since the last sent and LURED_EVERY_S has passed, or when they are none now and were not. */
  _owe(t, now) {
    let mine = ''
    for (const f of t.fish) if (f.lured && f.lure.by === null && f.lure !== this.her) mine += `${f.index},`
    if (mine === t.luredSent) return
    if (mine !== '' && now - t.luredAt < LURED_EVERY_S) return
    t.luredSent = mine
    t.luredAt = now
    this.owed.push([t.key, 'fs', null, mine === '' ? [] : mine.slice(0, -1).split(',').map(Number)])
  }

  // --- her hand ---------------------------------------------------------------

  /**
   * The drawn fish nearest a hand at (x, y, z) whose body -- a ball of its own
   * length -- is within `reach` metres, and shorter than `maxSize`: `{ dist,
   * sp, f, size }` for take(), or null. Nothing while the fish are not drawn,
   * which is whenever her head is out of the water. For hands.js.
   */
  pickAt(x, y, z, reach, maxSize) {
    if (!this.batch.visible) return null
    let best = null
    let bestD = reach
    for (const sp of this.species) {
      if (!sp.mesh.visible) continue
      for (const f of sp.slots) {
        if (!f.alive || f.size >= maxSize) continue
        this.pos(f)
        const d = Math.hypot(f.x - x, f.y - y, f.z - z) - f.size * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), sp, f, size: f.size }
        }
      }
    }
    return best
  }

  /**
   * Grab the fish of a pickAt() hit: out of its school and, unless it was
   * loose, recorded in taken.js as `fish<index>` at its bed's home so the bed
   * never grows it back, here or on any peer. What the hand holds is returned
   * as a record for hands.js -- the species' geometry and material, its tail's
   * phase and beat, its tint and hue, its scale. Only a fish under a metre may
   * go in the backpack; `stowMax` says where that is.
   */
  take(hit, stowMax) {
    const { sp, f } = hit
    if (!f.alive) throw new Error(`Fish.take: a dead ${sp.id}`)
    this.pose(f)
    const rec = {
      kind: 'fish',
      name: sp.id,
      size: f.size,
      geometry: sp.mesh.geometry,
      material: sp.material,
      attrs: { aSwim: [f.phase % TAU, f.amp, 0, 0], aHue: [f.hue] },
      color: [f.tint, f.tint, f.tint],
      scale: [f.scale, f.scale, f.scale],
      stowable: f.size < stowMax,
    }
    if (f.loose) this.unslot(sp, f)
    else {
      taken.add(`fish${f.index}`, f.school.home.x, f.school.home.z)
      this._drop(sp, f)
    }
    return rec
  }

  /**
   * A peer took the fish `fish<index>` of the bed whose home is (x, z): take
   * it here too, drawn or not, and record the place. True when a resident bed
   * has that school with that member; a loose fish is nobody's to evict. For
   * hands-net.js.
   */
  evict(key, x, z) {
    if (!key.startsWith('fish')) return false
    const index = Number(key.slice(4))
    if (!Number.isInteger(index)) return false
    for (const t of this.tiles.values()) {
      for (const school of t.schools) {
        if (Math.abs(school.home.x - x) >= TOLERANCE_M || Math.abs(school.home.z - z) >= TOLERANCE_M) continue
        const f = school.members.find((m) => m.index === index)
        if (!f) continue
        this.take({ dist: 0, sp: school.sp, f, size: f.size }, Infinity)
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed fish record is drawn with, by the species its name is, or null until that species' asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'fish') throw new Error(`Fish.dress: not a fish, ${slot.kind}`)
    const sp = this.species.find((s) => s.id === slot.name)
    if (!sp) throw new Error(`Fish.dress: no species ${slot.name}`)
    if (!sp.loaded) return null
    return { geometry: sp.mesh.geometry, material: sp.material }
  }

  /**
   * Let a taken fish go at (x, y, z). In water of any depth -- the shallows
   * off a bank she stands on included -- it hangs stunned for STUN_S,
   * then wakes and darts from her head until it is LOOSE_GONE_M out, where
   * the layer forgets it. Out of water it is false, and hands.js beaches it.
   * A loose fish is this client's alone: the room sees the drop through
   * hands-net.js, and each client swims its own copy off.
   */
  release(rec, x, y, z, head) {
    if (rec.kind !== 'fish') throw new Error(`Fish.release: not a fish, ${rec.kind}`)
    const level = this.water.levelAt(x, z)
    if (level === null) return false
    const bed = this.height.heightAt(x, z)
    if (y > level || bed >= level) return false
    const sp = this.species.find((s) => s.id === rec.name)
    if (!sp) throw new Error(`Fish.release: no species ${rec.name}`)
    const f = sp.free.pop()
    if (!f) return false
    const rand = this.rand
    f.alive = true
    f.loose = true
    f.school = null
    f.tile = null
    f.index = -1
    f.x = x; f.y = y; f.z = z
    f.vx = f.vy = f.vz = 0
    f.scale = rec.scale[0]
    f.size = rec.size
    f.margin = 0.2 * f.size
    f.bed = bed
    f.level = level
    this._current(f)
    // Facing away from her, lying as it was dropped.
    f.wander = Math.atan2(z - head.z, x - head.x)
    f.hx = Math.cos(f.wander)
    f.hz = Math.sin(f.wander)
    f.pace = (0.8 + 0.4 * rand()) * Math.sqrt(f.scale)
    f.beat = (0.85 + 0.3 * rand()) / Math.sqrt(f.scale)
    f.verve = 1
    f.tint = rec.color[0]
    f.hue = rec.attrs.aHue[0]
    f.lure = null
    f.lured = false
    f.mood = 'glide'
    f.moodLeft = Infinity
    f.speed = 0
    f.stun = between(rand, STUN_S)
    f.listedAt = -1
    this._looseLeg(sp, f, this.now === null ? 0 : this.now, 0, 0, 0, rec.attrs.aSwim[0])
    sp.loose.push(f)
    this._occupy(sp, f)
    return true
  }

  /**
   * One frame of a loose fish: stunned, it sinks a little and drifts to a
   * stop; awake, it runs from her head at LOOSE_HASTE times its cruise with a
   * jink every LOOSE_JINK seconds, turning along the shore where the water
   * ahead is shallow and shallower than here, and is forgotten LOOSE_GONE_M
   * out or beached. Water too thin for the margins holds it mid-column.
   */
  stepLoose(sp, f, dt) {
    const cfg = sp.cfg
    const rand = this.rand
    const head = this.head
    const dx0 = f.x - head.x, dz0 = f.z - head.z
    if (dx0 * dx0 + dz0 * dz0 > LOOSE_GONE_M * LOOSE_GONE_M) return this.unslot(sp, f)
    if (this.frame % PROBE_EVERY === 0) {
      const level = this.water.levelAt(f.x, f.z)
      const bed = this.height.heightAt(f.x, f.z)
      if (level === null || bed >= level) return this.unslot(sp, f)
      f.level = level
      f.bed = bed
      this._current(f)
    }
    if (f.stun > 0) {
      f.stun -= dt
      f.vx *= Math.max(0, 1 - 2 * dt)
      f.vz *= Math.max(0, 1 - 2 * dt)
      f.vy += (-0.05 - f.vy) * Math.min(1, 2 * dt)
      if (f.stun <= 0) {
        f.speed = cfg.cruise * LOOSE_HASTE
        f.moodLeft = 0
        this.setOff(f)
      }
    } else {
      f.moodLeft -= dt
      if (f.moodLeft <= 0) {
        f.moodLeft = LOOSE_JINK * (0.5 + rand())
        // Away from her, jinked up to a quarter turn either side.
        f.wander = Math.atan2(dz0, dx0) + (rand() - 0.5) * (Math.PI / 2)
      }
      if (this.frame % PROBE_EVERY === 0) {
        const ax = f.x + f.hx * cfg.lookahead
        const az = f.z + f.hz * cfg.lookahead
        const aheadLevel = this.water.levelAt(ax, az)
        if (aheadLevel === null || aheadLevel - this.height.heightAt(ax, az) < Math.min(cfg.minDepth * 0.6 * Math.max(1, f.scale), f.level - f.bed)) {
          // Shore ahead: a quarter turn, to whichever side leads further from her.
          const left = f.wander + Math.PI / 2
          const right = f.wander - Math.PI / 2
          const lx = f.x + Math.cos(left) - head.x, lz = f.z + Math.sin(left) - head.z
          const rx = f.x + Math.cos(right) - head.x, rz = f.z + Math.sin(right) - head.z
          f.wander = lx * lx + lz * lz > rx * rx + rz * rz ? left : right
          f.moodLeft = LOOSE_JINK
        }
      }
      const speed = f.speed * f.pace
      const k = Math.min(1, cfg.agility * 2 * dt)
      f.vx += (Math.cos(f.wander) * speed - f.vx) * k
      f.vz += (Math.sin(f.wander) * speed - f.vz) * k
      const target = this.column(f.bed, f.level, 0.5, f.margin)
      f.vy += (Math.max(-0.4, Math.min(0.4, (target - f.y) * 0.6)) - f.vy) * Math.min(1, 2 * dt)
    }
    f.x += (f.vx + f.cx) * dt
    f.y += f.vy * dt
    f.z += (f.vz + f.cz) * dt
    const lo = f.bed + BED_MARGIN + f.margin
    const hi = f.level - SURFACE_MARGIN - f.margin
    if (hi <= lo) { f.y = (f.bed + f.level) / 2; f.vy = 0 }
    else if (f.y < lo) { f.y = lo; if (f.vy < 0) f.vy = 0 }
    else if (f.y > hi) { f.y = hi; if (f.vy > 0) f.vy = 0 }
    // The facing chases the velocity, so a fish that stops does not snap to whatever its last velocity happened to be.
    const spd = Math.hypot(f.vx, f.vz)
    if (spd > 0.02) {
      const k = 1 - Math.exp(-6 * dt)
      f.hx += (f.vx / spd - f.hx) * k
      f.hz += (f.vz / spd - f.hz) * k
      const hl = Math.hypot(f.hx, f.hz)
      f.hx /= hl
      f.hz /= hl
    }
  }

  /** A loose fish's row: a leg from where it is at world time `t`, at its velocity and acceleration (ax, ay, az), leaning onto its own facing, from tail `phase`. */
  _looseLeg(sp, f, t, ax, ay, az, phase) {
    const L = f.L
    const k = L.k
    const D = TICK_S
    L.t0 = t
    L.d = D
    k.fill(0)
    k[0] = f.x; k[1] = f.vx * D; k[2] = ax * D * D / 2
    k[6] = f.y; k[7] = f.vy * D; k[8] = ay * D * D / 2
    k[12] = f.z; k[13] = f.vz * D; k[14] = az * D * D / 2
    L.cx = f.cx
    L.cz = f.cz
    const eps = FACE_EPS * sp.cfg.cruise
    L.h0x = L.h1x = f.hx * eps
    L.h0z = L.h1z = f.hz * eps
    this._tail(sp, f, L, phase)
    f.poseFrame = -1
    this._publish(sp, f)
  }

  // --- the ear ----------------------------------------------------------------

  /** The fish has just taken a new target speed: listed for the ear if it is a fast one, once a frame. */
  /** The current's drift at the fish's spot into f.cx, f.cz. */
  _current(f) {
    const w = this.water.flowAt(f.x, f.z, _o) * CURRENT_MPS
    f.cx = _o.x * w
    f.cz = _o.z * w
  }

  setOff(f) {
    if (f.speed >= DART_SPEED && f.listedAt !== this.frame) {
      f.listedAt = this.frame
      this.startles.push(f)
    }
  }

  /** The fish that set off at DART_SPEED or more this frame, for the ear (audio/ambience.js): the slots themselves, with x, y, z and `size` (its length in metres) on them, each once. A hidden layer lists nobody. */
  startled(into) {
    if (!this.batch.visible) return into
    for (const f of this.startles) into.push(this.pos(f))
    return into
  }

  // --- the frame --------------------------------------------------------------

  /**
   * Her head out of the water: the beds follow her along the shore so the
   * water around her is stocked the moment she goes under, and nothing is
   * stepped or drawn. Cheap: the beds are walked only once she has moved
   * WALK_M, so a forest far from any water pays nothing for the fish.
   */
  follow(x, y, z) {
    this.head.x = x
    this.head.y = y
    this.head.z = z
    this._walkTiles(x, z)
  }

  /**
   * One frame with her head under, at the room's clock `now`: the beds
   * follow her, the lures are noticed, and every school is ticked up to
   * `now`, its fish whose legs ended given their next. `lures`: hands.js lures() this frame,
   * the spiders, butterflies and grasshoppers among them swum at.
   */
  update(x, y, z, now, lures = NO_LURES) {
    if (!Number.isFinite(now)) throw new Error(`Fish.update: bad time ${now}`)
    this.head.x = x
    this.head.y = y
    this.head.z = z
    this._walkTiles(x, z)
    this.frame++
    // The frame's own seconds, for the loose fish; the ticks run on `now` itself.
    const dt = this.now === null ? 0 : Math.min(0.1, Math.max(0, now - this.now))
    this.now = now
    this.startles.length = 0
    this.her.x = x
    this.her.y = y
    this.her.z = z
    if (this.biggestStale) {
      this.biggest = 0
      for (const sp of this.species) for (const f of sp.slots) if (f.alive && f.size > this.biggest) this.biggest = f.size
      this.biggestStale = false
    }
    const noticing = lures.length > 0 || this.noticing > 0 || this.biggest > PREY.nibble * PREY.heightM * this.size
    if (noticing) {
      let held = 0
      let hers = 0
      for (const t of this.tiles.values()) {
        for (const f of t.fish) {
          this._notice(f, lures)
          if (f.lure !== null) { held++; if (f.lure === this.her) hers++ }
        }
      }
      this.noticing = held
      this.hers = hers
    }
    for (const t of this.tiles.values()) if (noticing || t.luredSent !== '') this._owe(t, now)

    // A plan is the only time a schooled fish's row is written: a frame between a fish's legs touches nothing of it.
    let stepped = 0
    for (const sp of this.species) {
      for (const school of sp.schools) {
        const g = Math.floor((now - school.offset) / GRID_S)
        const turned = school.seg !== g
        if (turned) this._reset(sp, school, g)
        stepped = Math.max(stepped, stepTo(school.rec, now, (tick) => this._tick(sp, school, tick), CATCH_UP_TICKS))
      }
      // A loose fish is stepped and written every frame, as a leg that starts now.
      for (let i = sp.loose.length - 1; i >= 0; i--) {
        const f = sp.loose[i]
        const phase = this._eval(f, now, _st).phase
        const vx = f.vx, vy = f.vy, vz = f.vz
        this.stepLoose(sp, f, dt)
        if (!f.alive) continue
        const r = dt > 0 ? 1 / dt : 0
        this._looseLeg(sp, f, now, (f.vx - vx) * r, (f.vy - vy) * r, (f.vz - vz) * r, phase)
      }
      sp.mesh.count = sp.top
      sp.rows.setFrame(now, x, y, z)
      sp.rows.flush()
    }
    if (this.hers > 0) this._prey(now)
    // A catch-up frame (a join, a clock skip) darts nobody in the ear: she was not there for it.
    if (stepped > SILENT_TICKS) this.startles.length = 0
  }

  dispose() {
    for (const sp of this.species) {
      sp.rows.dispose()
      sp.mesh.geometry.dispose()
      sp.material.map?.dispose()
      sp.material.dispose()
    }
    if (this.batch.parent) this.batch.parent.remove(this.batch)
  }
}
