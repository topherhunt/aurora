# /// script
# requires-python = ">=3.10"
# dependencies = ["requests", "numpy"]
# ///
"""ElevenLabs Voice Changer: re-voice the base takes as another speaker.

    uv run tools/voice/eleven.py sample [--yes]          # sampler lines through every VOICES entry, one reel each
    uv run tools/voice/eleven.py render <voice> [--yes]  # every human take, as delivered MP3s

Spends ElevenLabs credits (about 1,000 per minute of input, no per-request minimum), so without --yes it only
prints the seconds it would send. Reads ELEVENLABS_API_KEY from .env. Writes tools/voice/work/variants/eleven-<voice>.wav
(sample) or tools/voice/work/voices/<voice>/<line>.mp3 (render), skipping files that exist; originals are only read.
"""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tools/voice/work"
OUT = WORK / "variants"
API = "https://api.elevenlabs.io/v1"
MODEL = "eleven_english_sts_v2"
RATE = 44100
GAP_S = 0.6

TAKES = ["well-met.r1", "never-came-home.r1-she", "getting-dark.r2", "look-at-that.r1", "sp.might-have-seen.full-something", "sigh-long.r1"]

# name: (voice id, public owner id or None for a voice already in the account)
VOICES = {
    "sarah": ("EXAVITQu4vr4xnSDxMaL", None),
    "alice": ("Xb7hH8MSUJpSbSDYk0k2", None),
    "lily": ("pFZP5JQG7iQjIQuC4Bku", None),
    "jessica": ("cgSgspJ2msm6clMCkdW9", None),
    "laura": ("FGY2WhTYpPnrIDTdsKH5", None),
    # Library voices need a paid plan on the API.
    # "kid-teddy": ("XjGYkUkzth8BPs29fmcV", "119adcff6f9d8ee3d5194065d19fb9b473760336ad4a7227a6890226bc62167b"),
    # "kid-kavya": ("uyv82ARGSiPieXDxTMOc", "7398804d9eaf2f463899a907587c33a390591775784f87857b6d0e1e4e3e66f6"),
    # "kid-bittu": ("4iqKdEXMW8NRF8USiS3Q", "7398804d9eaf2f463899a907587c33a390591775784f87857b6d0e1e4e3e66f6"),
}


def key():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("ELEVENLABS_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("ELEVENLABS_API_KEY is not in .env")


def seconds(path):
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def convert(session, voice_id, path):
    r = session.post(
        f"{API}/speech-to-speech/{voice_id}",
        # Raw PCM output needs the Pro tier; MP3 is decoded locally.
        params={"output_format": f"mp3_{RATE}_128"},
        data={"model_id": MODEL, "remove_background_noise": "false"},
        files={"audio": (path.name, path.read_bytes(), "audio/wav")},
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"{path.name} -> {voice_id}: HTTP {r.status_code} {r.text[:400]}")
    return r.content, r.headers.get("character-cost")


def decode(mp3):
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", "-", "-f", "s16le", "-ac", "1", "-ar", str(RATE), "-"], input=mp3, capture_output=True, check=True).stdout
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768


def write_reel(clips, path):
    gap = np.zeros(int(GAP_S * RATE), dtype=np.float32)
    y = np.concatenate([part for c in clips for part in (c, gap)])
    y *= 0.89 / np.max(np.abs(y))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((y * 32767).astype("<i2").tobytes())


def session():
    s = requests.Session()
    s.headers["xi-api-key"] = key()
    return s


def voice_id(http, name):
    vid, owner = VOICES[name]
    if owner is None:
        return vid
    # A library voice has to be in the account before it can be used.
    r = http.post(f"{API}/voices/add/{owner}/{vid}", json={"new_name": f"aurora {name}"})
    if r.status_code == 200:
        return r.json()["voice_id"]
    if "already" in r.text:
        return vid
    raise RuntimeError(f"adding {name}: HTTP {r.status_code} {r.text[:400]}")


def sample(go):
    paths = [WORK / f"{t}.base.wav" for t in TAKES]
    missing = [p.name for p in paths if not p.exists()]
    if missing:
        sys.exit(f"missing takes: {', '.join(missing)}")
    todo = [n for n in VOICES if not (OUT / f"eleven-{n}.wav").exists()]
    per_voice = sum(seconds(p) for p in paths)
    print(f"{len(TAKES)} takes, {per_voice:.1f} s each x {len(todo)} voices not yet rendered = {per_voice * len(todo):.0f} s of input")
    if not go:
        sys.exit("dry run: add --yes to send")
    http = session()
    OUT.mkdir(exist_ok=True)
    for name in todo:
        vid = voice_id(http, name)
        results = [convert(http, vid, p) for p in paths]
        write_reel([decode(mp3) for mp3, _ in results], OUT / f"eleven-{name}.wav")
        print(f"{name}: done, credits per take: {[c for _, c in results]}")
    print(f"-> {OUT}")


def render(name, go):
    if name not in VOICES:
        sys.exit(f"unknown voice {name}; one of {', '.join(VOICES)}")
    dest = WORK / "voices" / name
    takes = sorted(p for p in WORK.glob("*.base.wav") if not p.name.startswith("sp."))
    todo = [p for p in takes if not (dest / p.name.replace(".base.wav", ".mp3")).exists()]
    total = sum(seconds(p) for p in todo)
    print(f"{len(todo)} of {len(takes)} human takes to render as {name}: {total:.0f} s, about {total / 60 * 1000:.0f} credits")
    if not go:
        sys.exit("dry run: add --yes to send")
    http = session()
    vid = voice_id(http, name)
    dest.mkdir(parents=True, exist_ok=True)
    spent = 0
    for i, p in enumerate(todo):
        mp3, cost = convert(http, vid, p)
        (dest / p.name.replace(".base.wav", ".mp3")).write_bytes(mp3)
        spent += int(cost or 0)
        if i % 25 == 24:
            print(f"  {i + 1}/{len(todo)}, {spent} credits so far")
    print(f"{name}: {len(todo)} takes, {spent} credits -> {dest}")


def main():
    go = "--yes" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--yes"]
    if args[:1] == ["sample"]:
        sample(go)
    elif args[:1] == ["render"] and len(args) == 2:
        render(args[1], go)
    else:
        sys.exit(__doc__)


main()
