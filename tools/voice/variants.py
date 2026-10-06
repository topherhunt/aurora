# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["praat-parselmouth", "numpy"]
# ///
"""Voice-conversion sampler: renders a few takes through Praat presets so they can be heard side by side.

    uv run tools/voice/variants.py [take ...]
    uv run tools/voice/variants.py --reel variants/eleven-jessica.wav   # CHILD presets over an existing reel
    uv run tools/voice/variants.py --bake f-bright                       # every human take -> work/voices/f-bright/

Writes tools/voice/work/variants/<preset>.wav, each one reel of the same lines with a pause between, plus
original.wav. Originals are only read. Presets move four knobs of Praat's Change Gender (PSOLA pitch plus a
resample for the formants): pitch median (semitones from the take's own), pitch range, formant ratio (vocal
tract length: >1 smaller, <1 larger), and duration.
"""
import sys
from pathlib import Path

import numpy as np
import parselmouth
from parselmouth.praat import call

WORK = Path(__file__).parent / "work"
OUT = WORK / "variants"
DEFAULT_TAKES = ["well-met.r1", "never-came-home.r1-she", "getting-dark.r2", "look-at-that.r1", "sp.might-have-seen.full-something", "sigh-long.r1"]
GAP_S = 0.6

# name: (semitones, pitch range factor, formant ratio, duration factor)
PRESETS = {
    "f-alto": (5, 1.1, 1.12, 1.0),
    "f-mid": (7, 1.2, 1.17, 1.0),
    "f-bright": (9, 1.3, 1.22, 0.97),
    "m-big": (-2, 0.9, 0.90, 1.05),
    "m-old": (-1, 0.7, 0.94, 1.12),
    "m-young": (2, 1.15, 1.06, 0.95),
    "m-flat": (0, 0.5, 1.0, 1.0),
    "m-lively": (1, 1.6, 1.03, 0.97),
    "kid-from-man": (10, 1.3, 1.28, 0.95),
    "teen-from-man": (4, 1.2, 1.10, 0.97),
}

# Applied to an already converted adult female reel: a child is a short step up from a young woman.
CHILD = {
    "kid": (3, 1.15, 1.08, 0.97),
    "kid-small": (4, 1.2, 1.13, 0.95),
}


def median_pitch(snd):
    f0 = snd.to_pitch(pitch_floor=60, pitch_ceiling=400).selected_array["frequency"]
    voiced = f0[f0 > 0]
    if len(voiced) == 0:
        return None
    return float(np.median(voiced))


def convert(snd, st, rng, formant, dur):
    f0 = median_pitch(snd)
    # Unvoiced takes (a sigh, a cough) have no pitch to move; 0 tells Praat to leave the median alone.
    target = 0 if f0 is None else f0 * 2 ** (st / 12)
    return call(snd, "Change gender", 60, 400, formant, target, rng, dur)


def reel(sounds, rate):
    gap = np.zeros(int(GAP_S * rate))
    parts = []
    for s in sounds:
        parts += [s.values[0], gap]
    y = np.concatenate(parts)
    y *= 0.89 / np.max(np.abs(y))
    return parselmouth.Sound(y, sampling_frequency=rate)


def bake(name):
    knobs = PRESETS[name]
    dest = WORK / "voices" / name
    dest.mkdir(parents=True, exist_ok=True)
    takes = sorted(p for p in WORK.glob("*.base.wav") if not p.name.startswith("sp."))
    for p in takes:
        out = convert(parselmouth.Sound(str(p)), *knobs)
        out.scale_peak(0.89)
        out.save(str(dest / p.name.replace(".base.wav", ".wav")), "WAV")
    print(f"{name}: {len(takes)} takes -> {dest}")


def main():
    if sys.argv[1:2] == ["--bake"]:
        for name in sys.argv[2:]:
            bake(name)
        return
    if sys.argv[1:2] == ["--reel"]:
        src = WORK / sys.argv[2]
        snd = parselmouth.Sound(str(src))
        for name, knobs in CHILD.items():
            out = convert(snd, *knobs)
            out.scale_peak(0.89)
            out.save(str(OUT / f"{src.stem}-{name}.wav"), "WAV")
            print(f"{src.stem}-{name}")
        return
    takes = sys.argv[1:] or DEFAULT_TAKES
    paths = [WORK / f"{t}.base.wav" for t in takes]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        sys.exit(f"missing takes: {', '.join(missing)}")
    sources = [parselmouth.Sound(str(p)) for p in paths]
    rate = sources[0].sampling_frequency
    OUT.mkdir(exist_ok=True)
    reel(sources, rate).save(str(OUT / "original.wav"), "WAV")
    for name, knobs in PRESETS.items():
        reel([convert(s, *knobs) for s in sources], rate).save(str(OUT / f"{name}.wav"), "WAV")
        print(name)
    print(f"source pitch medians (Hz): {', '.join(f'{median_pitch(s) or 0:.0f}' for s in sources)}")
    print(f"-> {OUT}")


main()
