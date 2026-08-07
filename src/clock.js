// ---------------------------------------------------------------------------
// The world clock, the sun and moon that hang off it, and the palette that
// every light in the scene is read out of (DESIGN.md §8, §13).
//
// NO three.js IN THIS FILE. Not for §1's porting rule -- this is render-layer
// code and would not port -- but because it is the only way to gate it. Solar
// geometry fails the way Phase A fails: the sun rises, it sets, the sky goes
// orange, and it is all subtly wrong in a way you cannot see by looking at it.
// `scripts/check-daynight.mjs` measures day length, culmination time, the
// spread between sunrise and sunset azimuth, and the continuity of the whole
// palette, and it can only do that if importing this file does not drag a
// WebGL context along with it. Colours come out as sRGB 0..1 triples; sky.js
// owns the trip into THREE.Color.
//
// TIME. 24 real minutes = 24 in-world hours (§8), so one real minute is one
// in-world hour and the +6 h hotkey is worth six real minutes of waiting.
//
// WHERE THIS WORLD IS. Latitude 65 N, which is the auroral oval -- Fairbanks,
// Tromso, the middle of Iceland. That is not decoration. Latitude is what sets
// the geometry of the whole day: at 65 N the sun never climbs past about 21
// degrees at this declination, so it spends the entire day at the elevation
// that everywhere else only gets for an hour after dawn. Long shadows all day,
// warm light all day, and a genuinely long night to put the aurora in. A world
// with auroras in it should not have an overhead noon sun, and the fix is one
// number rather than a lighting hack.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180

export const CLOCK = {
  // Real minutes for one in-world day, from §8. The hotkey is defined against
  // in-world hours, not against this, so changing the pace does not change
  // what "skip six hours" means.
  dayMinutes: 24,

  // Degrees north. See the header: this is the single number that decides
  // whether the world gets a Mediterranean noon or a subarctic one.
  latitude: 65,

  // Solar declination, i.e. which season it is. -4 deg is a couple of weeks
  // past the autumn equinox: an 11.2 hour day, a 12.8 hour night, and a sun
  // that tops out around 21 deg. Zero would be the equinox exactly (12/12);
  // -23.4 would be midwinter, which at this latitude is a two-hour twilight
  // smear and no daylight worth the name.
  declination: -4,

  // What the hotkey is worth.
  skipHours: 6,

  // She spawns in the late afternoon, deliberately. The first thing this system
  // has to prove is that it can do a sunset, and making her wait 16 real
  // minutes to find that out is the difference between a feature that gets
  // looked at and one that does not.
  startHour: 16.2,
}

export const MOON = {
  // How far the moon trails the sun, in in-world hours. 10.2 h puts its
  // culmination a little before midnight, so it is up for most of the dark and
  // it visibly RISES rather than being found already overhead -- which was the
  // ask.
  lagHours: 10.2,

  // Its own declination, higher than the sun's, so it climbs meaningfully
  // higher than the sun does and does not simply retrace the same low arc.
  declination: 14,

  // Illuminated fraction. THIS IS ART DIRECTION AND IT IS A LIE, stated out
  // loud rather than buried: a real crescent sits within about 60 deg of the
  // sun, so it can only ever be seen low in the dusk or the dawn. A moon that
  // is up all night is necessarily near full. The ask was a crescent, all
  // night, so the FRACTION is set by hand here.
  //
  // What is NOT faked is the ORIENTATION -- the terminator is built from the
  // real sun direction every frame, so the horns always point away from where
  // the sun actually is. That is the half the eye checks. A crescent lit from
  // the wrong side reads as broken instantly; a crescent that is too thin for
  // its elongation reads as a crescent.
  //
  // Set this to null to make it honest: the fraction is then derived from the
  // true sun-moon elongation, and the moon goes gibbous. One line.
  lit: 0.19,

  // Angular radius on the dome, degrees. The real moon is 0.26 and the real
  // sun 0.27 -- famously almost identical. Both are drawn bigger here for the
  // same reason sky.js already inflates the sun: a Quest 3 resolves roughly 15
  // px per degree, so a true-size moon is eight pixels across and cannot show
  // a crescent at all. 1.3 deg is about 40 px, which is enough to read as a
  // shape and still small enough not to look like a planet.
  radiusDeg: 1.3,
}

export const AURORA_ACTIVITY = {
  // Hours of in-world time for one full swing of the substorm envelope. Real
  // substorms run 1-3 hours from quiet arc to breakup to recovery (Akasofu
  // 1964, and the sequence Lawlor & Genetti animate), so this is roughly life
  // sized -- which matters, because it is what decides whether standing still
  // and watching is rewarded.
  periodHours: 2.6,

  // Floor and ceiling of the envelope. The floor is deliberately above zero:
  // a quiet arc low on the northern horizon is the DEFAULT state of an auroral
  // night, not the absence of one, and a sky that is empty half the time reads
  // as a bug.
  quiet: 0.16,
  storm: 1.0,
}

// --- solar geometry ---------------------------------------------------------

// Hour angle in degrees: 0 at local solar noon, +15 per hour after.
const hourAngle = (hour) => (hour - 12) * 15

// The standard spherical-triangle solution, in the form every almanac writes
// it. Returns a unit direction in THREE's world frame plus the two angles it
// was built from, because the palette wants elevation and the horizon map
// wants azimuth, and recovering either from the vector is a trig call the
// caller should not have to make.
//
// FRAME: +y is up, -z is north, +x is east. Azimuth is measured from north,
// clockwise, which is the convention every azimuth in this project uses --
// including the horizon map's 16 slices, which have to agree with this or the
// shadows fall on the wrong side of the mountain.
function celestial(hour, latitudeDeg, declinationDeg) {
  const H = hourAngle(hour) * DEG
  const phi = latitudeDeg * DEG
  const dec = declinationDeg * DEG

  const sinElev = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
  const elev = Math.asin(Math.max(-1, Math.min(1, sinElev)))
  const cosElev = Math.cos(elev)

  // Guard the pole: at cosElev ~ 0 the object is at the zenith and azimuth is
  // undefined. Never reachable at latitude 65 with these declinations, but a
  // divide by zero that only appears when someone edits a constant is exactly
  // the kind of bug this project keeps finding in its own instruments.
  const safe = Math.max(cosElev, 1e-6)
  const sinAz = (-Math.cos(dec) * Math.sin(H)) / safe
  const cosAz = (Math.sin(dec) - Math.sin(phi) * sinElev) / (Math.cos(phi) * safe)
  const az = Math.atan2(sinAz, cosAz)

  return {
    x: Math.sin(az) * cosElev,
    y: sinElev,
    z: -Math.cos(az) * cosElev,
    elevDeg: elev / DEG,
    // Normalised into 0..360 so consumers never have to think about the branch
    // cut. The horizon map indexes an array with this.
    azDeg: ((az / DEG) % 360 + 360) % 360,
  }
}

// --- the slow noise the aurora's moods are made of --------------------------

// One-dimensional value noise over in-world hours. Integer hash, for the same
// reason terrain-material.js uses one: the fract-of-a-big-multiply hash
// collapses once its input gets large, and "hours since the world loaded" gets
// large. Measured there at 6 km it had degenerated to two distinct values.
function hash1(n) {
  let h = n >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function noise1(x) {
  const i = Math.floor(x)
  const f = x - i
  const s = f * f * (3 - 2 * f)
  return hash1(i) * (1 - s) + hash1(i + 1) * s
}

// --- the palette ------------------------------------------------------------

// sRGB hex to an 0..1 triple. Everything below is written as hex because that
// is the only form a colour can be eyeballed in, and converted here rather
// than at every use site.
const hex = (v) => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

// Keyframes down the sun's elevation, from overhead to fully set. The elevation
// breakpoints are the real ones -- 0 is sunset, -6 is the end of civil
// twilight, -12 nautical, -18 astronomical -- because those are where the sky
// actually changes character, and picking round numbers instead would put the
// keyframes in the wrong places and then need extra keyframes to fix it.
//
// Ordered from high to low. `state()` walks it and smoothsteps between
// neighbours; the check gate sweeps the whole range looking for a jump, since a
// discontinuity here is a visible flash in the headset and nothing else in the
// project would catch it.
const KEYS = [
  {
    elev: 25,
    horizon: hex(0x9db4cf), // the old FOG_COLOR -- day is unchanged, on purpose
    zenith: hex(0x1f56ad),
    glow: hex(0xffe6bd),
    glowAmt: 0.10,
    glowSharp: 5,
    sunLight: hex(0xfff2dc),
    sunIntensity: 2.1,
    hemiSky: hex(0xbfd4ee),
    hemiGround: hex(0x2c3140),
    hemiIntensity: 0.85,
    fog: hex(0x9db4cf),
    fogDensity: 0.00022,
    stars: 0,
    moonBright: 0.10,
    auroraMax: 0,
  },
  {
    elev: 12,
    horizon: hex(0xa8bcd0),
    zenith: hex(0x2358ac),
    glow: hex(0xffdca8),
    glowAmt: 0.20,
    glowSharp: 5,
    sunLight: hex(0xfff0d0),
    sunIntensity: 2.0,
    hemiSky: hex(0xc0d4ec),
    hemiGround: hex(0x2c3140),
    hemiIntensity: 0.84,
    fog: hex(0xa8bcd0),
    fogDensity: 0.00022,
    stars: 0,
    moonBright: 0.12,
    auroraMax: 0,
  },
  {
    // The sun is low enough to redden but still fully in charge of the scene.
    elev: 5,
    horizon: hex(0xd8b79a),
    zenith: hex(0x2f60a6),
    glow: hex(0xffbe72),
    glowAmt: 0.55,
    glowSharp: 4,
    sunLight: hex(0xffd7a4),
    sunIntensity: 1.75,
    hemiSky: hex(0xcbc3d0),
    hemiGround: hex(0x2e2b33),
    hemiIntensity: 0.72,
    fog: hex(0xd8b79a),
    fogDensity: 0.00024,
    stars: 0,
    moonBright: 0.18,
    auroraMax: 0,
  },
  {
    // Golden hour proper. The horizon is now warmer than the light, which is
    // what makes a low sun read as low rather than as a tinted noon.
    elev: 1,
    horizon: hex(0xf2a765),
    zenith: hex(0x2b5496),
    glow: hex(0xff9d4a),
    glowAmt: 1.05,
    glowSharp: 3.2,
    sunLight: hex(0xffa864),
    sunIntensity: 1.15,
    hemiSky: hex(0xd0a693),
    hemiGround: hex(0x2b2229),
    hemiIntensity: 0.6,
    fog: hex(0xe8a072),
    fogDensity: 0.00026,
    stars: 0,
    moonBright: 0.3,
    auroraMax: 0,
  },
  {
    // Sunset. The disc is on the horizon; the direct light is nearly gone and
    // almost everything you can see is coming off the sky.
    elev: -1,
    horizon: hex(0xe4763f),
    zenith: hex(0x2a4a86),
    glow: hex(0xff7a33),
    glowAmt: 1.35,
    glowSharp: 2.6,
    sunLight: hex(0xd8622e),
    sunIntensity: 0.42,
    hemiSky: hex(0xb98a80),
    hemiGround: hex(0x241c24),
    hemiIntensity: 0.52,
    fog: hex(0xc9764a),
    fogDensity: 0.0003,
    stars: 0.04,
    moonBright: 0.55,
    auroraMax: 0,
  },
  {
    // Mid civil twilight. This is the rose-over-navy band that people photograph
    // and that games almost always skip straight past.
    elev: -4,
    horizon: hex(0xa1567a),
    zenith: hex(0x1e3670),
    glow: hex(0xe86a55),
    glowAmt: 1.15,
    glowSharp: 2.2,
    sunLight: hex(0x6a3a4e),
    sunIntensity: 0.06,
    hemiSky: hex(0x7a6a90),
    hemiGround: hex(0x1a1620),
    hemiIntensity: 0.42,
    fog: hex(0x8a5a78),
    fogDensity: 0.00034,
    stars: 0.22,
    moonBright: 0.85,
    auroraMax: 0.08,
  },
  {
    // End of civil twilight. Ground detail is going; the brightest stars are in.
    elev: -6,
    horizon: hex(0x6b4270),
    zenith: hex(0x172a5c),
    glow: hex(0xb85570),
    glowAmt: 0.85,
    glowSharp: 2.0,
    sunLight: hex(0x000000),
    sunIntensity: 0,
    hemiSky: hex(0x5a5480),
    hemiGround: hex(0x14121c),
    hemiIntensity: 0.34,
    fog: hex(0x5c4068),
    fogDensity: 0.00036,
    stars: 0.42,
    moonBright: 1.0,
    auroraMax: 0.35,
  },
  {
    // Nautical twilight. The last of the glow is a bruise on one side of the
    // horizon and the sky overhead is properly dark.
    elev: -12,
    horizon: hex(0x2c2a4c),
    zenith: hex(0x0c1330),
    glow: hex(0x5b3a6a),
    glowAmt: 0.42,
    glowSharp: 2.2,
    sunLight: hex(0x000000),
    sunIntensity: 0,
    hemiSky: hex(0x323a60),
    hemiGround: hex(0x0b0d16),
    hemiIntensity: 0.24,
    fog: hex(0x28263f),
    fogDensity: 0.00038,
    stars: 0.86,
    moonBright: 1.0,
    auroraMax: 0.85,
  },
  {
    // Astronomical twilight ends here: from -18 down, nothing more happens.
    elev: -18,
    horizon: hex(0x141a30),
    zenith: hex(0x05070f),
    glow: hex(0x2a2246),
    glowAmt: 0.12,
    glowSharp: 2.6,
    sunLight: hex(0x000000),
    sunIntensity: 0,
    hemiSky: hex(0x222c4e),
    hemiGround: hex(0x070911),
    hemiIntensity: 0.185,
    fog: hex(0x121729),
    fogDensity: 0.0004,
    stars: 1,
    moonBright: 1.0,
    auroraMax: 1.0,
  },
  {
    // The floor. Identical to -18 by construction, so the sweep from -18 to -90
    // is flat and the gate's continuity test has something unambiguous to sit
    // on. Duplicated rather than clamped in the lookup because a clamp is an
    // invisible special case and a duplicated row is a visible one.
    elev: -90,
    horizon: hex(0x141a30),
    zenith: hex(0x05070f),
    glow: hex(0x2a2246),
    glowAmt: 0.12,
    glowSharp: 2.6,
    sunLight: hex(0x000000),
    sunIntensity: 0,
    hemiSky: hex(0x222c4e),
    hemiGround: hex(0x070911),
    hemiIntensity: 0.185,
    fog: hex(0x121729),
    fogDensity: 0.0004,
    stars: 1,
    moonBright: 1.0,
    auroraMax: 1.0,
  },
]

// Moonlight, for when the directional light is doing its night job. Cold and
// weak: real moonlight is about a millionth of sunlight, and the reason it does
// not look a millionth as bright is that the eye adapts. We cannot adapt the
// eye, so the number here is what the SCENE should look like -- bright enough
// that snow reads as snow and rock reads as nearly black, which is what a
// moonlit photograph looks like.
const MOONLIGHT = { color: hex(0xa8c0ea), intensity: 0.34 }

const lerp = (a, b, t) => a + (b - a) * t
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
const smoothstep = (t) => t * t * (3 - 2 * t)

function paletteAt(sunElevDeg) {
  const e = Math.max(-90, Math.min(KEYS[0].elev, sunElevDeg))
  let i = 0
  while (i < KEYS.length - 2 && KEYS[i + 1].elev > e) i++
  const a = KEYS[i]
  const b = KEYS[i + 1]
  // Smoothstep rather than linear. The sun crosses these bands slowly enough
  // that a kink in the value would be invisible, but a kink in the DERIVATIVE
  // is what §3 spent four rounds learning to see -- and the same argument that
  // killed pow(dir.y, 0.21) in the sky gradient applies to a colour ramp in
  // time. It costs one multiply per keyframe pair per frame.
  const t = smoothstep((a.elev - e) / (a.elev - b.elev))
  return {
    horizon: lerp3(a.horizon, b.horizon, t),
    zenith: lerp3(a.zenith, b.zenith, t),
    glow: lerp3(a.glow, b.glow, t),
    glowAmt: lerp(a.glowAmt, b.glowAmt, t),
    glowSharp: lerp(a.glowSharp, b.glowSharp, t),
    sunLight: lerp3(a.sunLight, b.sunLight, t),
    sunIntensity: lerp(a.sunIntensity, b.sunIntensity, t),
    hemiSky: lerp3(a.hemiSky, b.hemiSky, t),
    hemiGround: lerp3(a.hemiGround, b.hemiGround, t),
    hemiIntensity: lerp(a.hemiIntensity, b.hemiIntensity, t),
    fog: lerp3(a.fog, b.fog, t),
    fogDensity: lerp(a.fogDensity, b.fogDensity, t),
    stars: lerp(a.stars, b.stars, t),
    moonBright: lerp(a.moonBright, b.moonBright, t),
    auroraMax: lerp(a.auroraMax, b.auroraMax, t),
  }
}

export class WorldClock {
  constructor({ hour = CLOCK.startHour, seed = 1 } = {}) {
    // Total in-world hours since the world began, monotonic and never wrapped.
    // The hotkey adds to THIS, not to the wrapped hour of day, which is what
    // makes skipping forward advance the aurora's slow noise by the same six
    // hours it advances the sun by. Wrapping first would leave the weather
    // standing still every time you skipped a whole day.
    this.elapsed = hour
    this.seed = seed
    this.skips = 0
    this._recompute()
  }

  // dt is REAL seconds. One real minute is one in-world hour (§8).
  advance(dt) {
    this.elapsed += (dt / 60) * (24 / CLOCK.dayMinutes)
    this._recompute()
  }

  // The hotkey. Returns the new hour of day so the caller can say so out loud.
  skip(hours = CLOCK.skipHours) {
    this.elapsed += hours
    this.skips++
    this._recompute()
    return this.hour
  }

  get hour() {
    return ((this.elapsed % 24) + 24) % 24
  }

  // "14:37", for the HUD.
  get clockText() {
    const h = this.hour
    const m = Math.floor((h % 1) * 60)
    return `${String(Math.floor(h)).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  _recompute() {
    const h = this.hour
    this.sun = celestial(h, CLOCK.latitude, CLOCK.declination)
    this.moon = celestial(h - MOON.lagHours, CLOCK.latitude, MOON.declination)

    // Illuminated fraction. MOON.lit overrides it -- see the note there for why
    // that is a deliberate lie and which half of it is not.
    const elong = Math.acos(
      Math.max(-1, Math.min(1, this.sun.x * this.moon.x + this.sun.y * this.moon.y + this.sun.z * this.moon.z))
    )
    this.moonElongation = elong / DEG
    this.moonLit = MOON.lit === null ? (1 - Math.cos(elong)) / 2 : MOON.lit
  }

  // Everything the renderer needs for this instant, in one object. Allocates,
  // and deliberately: it is called once per frame against a scene that is
  // already allocating a Vector3 per chunk update, and the alternative is a
  // mutable singleton that the gate cannot sample twice to compare.
  state() {
    const p = paletteAt(this.sun.elevDeg)

    // Substorm envelope. Two octaves an octave apart, so the aurora has both a
    // slow overall mood and a faster flutter inside it, and neither one is
    // periodic enough to learn.
    const n =
      noise1(this.elapsed / AURORA_ACTIVITY.periodHours + this.seed * 13.7) * 0.68 +
      noise1((this.elapsed / AURORA_ACTIVITY.periodHours) * 2.7 + this.seed * 91.3) * 0.32
    const activity = AURORA_ACTIVITY.quiet + (AURORA_ACTIVITY.storm - AURORA_ACTIVITY.quiet) * n
    const aurora = p.auroraMax * activity

    // ---- The one directional light does sun duty and then moon duty (§8:
    // "One real-time directional light for sun/moon").
    //
    // The handover is at -6 deg, where the sun's own intensity keyframe has
    // ALREADY reached zero, so the direction snapping from one body to the
    // other cannot be seen: it happens while the light contributes nothing.
    // Crossfading the DIRECTION instead would swing the light bar across the
    // sky through positions neither body occupies, and every shadow in the
    // world would sweep with it.
    const night = this.sun.elevDeg <= -6
    // Moonlight dies as the moon sets, and is dimmer for a thinner moon. The
    // -3 end of the ramp is below the horizon on purpose: refraction and the
    // moon's own angular size keep it lighting the ground a little after its
    // centre has geometrically set.
    const moonUp = Math.max(0, Math.min(1, (this.moon.elevDeg + 3) / 11))
    const moonPow = moonUp * moonUp * (3 - 2 * moonUp) * (0.35 + 0.65 * this.moonLit)

    return {
      hour: this.hour,
      sun: this.sun,
      moon: this.moon,
      moonLit: this.moonLit,
      // Which body the shadow term should be cast from, and its angles. The
      // horizon map is indexed by azimuth, so it needs the angles rather than
      // the vector.
      lightDir: night ? this.moon : this.sun,
      lightColor: night ? MOONLIGHT.color : p.sunLight,
      lightIntensity: night ? MOONLIGHT.intensity * moonPow : p.sunIntensity,
      isNight: night,

      horizon: p.horizon,
      zenith: p.zenith,
      glow: p.glow,
      glowAmt: p.glowAmt,
      glowSharp: p.glowSharp,
      fog: p.fog,
      fogDensity: p.fogDensity,
      stars: p.stars,
      moonBright: p.moonBright,

      // ---- Ambient.
      //
      // The aurora tints it green (§13: "Tint scene ambient green as it
      // strengthens, so it affects the world rather than sitting on a separate
      // layer"). This is the whole difference between an aurora that is part of
      // the world and one that is a poster hung behind it -- when the sky goes
      // green the snow goes green, because the snow is lit by the sky.
      //
      // Pushed into the SKY half of the hemisphere light only. The ground half
      // is bounce off terrain that the aurora is not shining on directly, and
      // tinting both would read as a green filter over the frame.
      hemiSky: [
        p.hemiSky[0] * (1 - aurora * 0.45),
        p.hemiSky[1] + (1 - p.hemiSky[1]) * aurora * 0.34,
        p.hemiSky[2] * (1 - aurora * 0.1),
      ],
      hemiGround: p.hemiGround,
      hemiIntensity: p.hemiIntensity * (1 + aurora * 0.55),

      aurora,
      auroraMax: p.auroraMax,
      activity,
    }
  }
}

// Exported for the gate, which sweeps it directly rather than driving a clock
// to every elevation -- some of these elevations are only reachable at other
// latitudes.
export { paletteAt, celestial, noise1 }
