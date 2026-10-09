# NPC voice: built, not live (2026-10-08)

Everything below exists in the repo or in gitignored `tools/voice/work/`. None of it is wired into the game. The design (moments, utterances, readings, leafkin tiers) is `_notes/conversation-and-quests.md` § Voice; this note is the state of the assets and the plan to ship them.

## What exists

**Inventory** -- `tools/voice/atoms.js`. 70 moments, 185 human utterances (210 recorded lines once `{he|she}` forms and readings are expanded), 22 leafkin atoms with native / mixed / pidgin tiers (`lk.nv` is nonverbal, no tiers), 5 splice sets, and `TAKES` (base, elder, light, leafkin at rate 1.5).

**Recorder** -- `voice-recorder.html` at the repo root, served by Vite. Sets: Human, Leafkin, Splice. Lines or Moments view (Moments flags any moment with fewer than 3 readings). Every take is saved to IndexedDB and, when a folder is connected (do this every session: the amber note means takes are browser-only), to `tools/voice/work/` as `<id>.<variant>.<take>.wav`. Stop is latency-aware, so audio up to the spacebar press is kept. Per-line ▶ plays the current take. Sample work (trim, normalise, WAV encode, join, pitch shift) is `tools/voice/audio.js`.

**Recordings** -- `tools/voice/work/`: 219 base takes (210 human + 9 splice) and 85 leafkin takes. No elder or light takes were recorded; the light take is no longer needed (see Voices). Originals are never modified by any tool.

**Voices** -- `tools/voice/variants.py` (uv + Praat via parselmouth). `--bake <preset ...>` converts every non-splice base take into `tools/voice/work/voices/<preset>/<line>.wav`:

| preset | use | knobs (semitones, range, formant, duration) | size as WAV |
|---|---|---|---|
| `m-big` | men | -2, 0.9, 0.90, 1.05 | 21 MB |
| `f-bright` | women | +9, 1.3, 1.22, 0.97 | 19 MB |
| `teen-from-man` | children | +4, 1.2, 1.10, 0.97 | 19 MB |

All 630 baked files passed a level check (none silent, none below -3 dB peak). Re-baking all three is free and takes a couple of minutes. Running `variants.py` with no args renders comparison reels of every preset to `work/variants/`.

**ElevenLabs** -- `tools/voice/eleven.py` (Speech-to-Speech, `eleven_english_sts_v2`). `work/voices/sarah/` holds all 210 lines as Sarah (4 MB MP3), and `work/variants/eleven-*.wav` holds sample reels. **These cannot ship**: they were made on the free plan, which is non-commercial and requires attribution. About 4,250 of the 10,000 monthly free credits were used; no money was spent. Re-rendering with a commercial licence is the Starter plan ($6 for 30k credits; one full voice is about 3,600 credits). Library voices (including the child ones) and Voice Design need a paid plan on the API. The key lives in `.env` (gitignored) and lacks `user_read`, so the balance can't be read through the API.

## Decisions made

- Splicing is dropped: the joins sounded automatic. Record whole sentences instead; repetition is acceptable.
- Women are `f-bright`, children are `teen-from-man`, men are `m-big`; all are Praat bakes from the base take. Praat Change Gender analyses pitch across the whole clip, so it is baked offline, never run live.
- Per-NPC individuality is live and cheap: a seeded playbackRate offset (about ±5%) plus a gentle BiquadFilter EQ tilt per person, on top of the baked group voice. This replaces "pre-render 2 men and 2 women".
- Leafkin use their own takes played at rate 1.5; they are not converted.

## Open loops

1. **Re-record 32 clipped takes**, then re-bake. The endings were cut before the recorder fix: back-again r1, that-i-know, let-me-think, no-rest, never-guess, as-i-told, you-again, what-now, you-found r1-him, is-that-so, get-home-safe, by-the-gods, rain-again, never-gone-long r1-she, did-you-hear, good-people, own-eyes, off-with-you, hm-all-right, thats-kind, where-could-be r1-he, were-done, you-there-please, up-early, hail-traveller, right-yes, there-you-are, go-well, evening, run. Leafkin: lk.bye pidgin-1 is clipped, and lk.nv native-3 probably reads fine as is. Then run `uv run tools/voice/variants.py --bake m-big f-bright teen-from-man` (it overwrites).
2. **Retire the Splice set** from `atoms.js` (`SPLICES`) and the recorder (the set button, the splice lab and its marks), and drop `join`/`shiftPitch` from `audio.js` if nothing else uses them. The 9 `sp.*` takes can stay on disk. `conversation-and-quests.md` § Voice still describes splicing, a light take and "about six voice types"; rewrite those bullets to match the decisions above.
3. **Child lines.** The children speak adult lines. If the missing-child quest gives the child dialogue, add child moments and utterances to `atoms.js` and record them.
4. **Listen through the bakes.** So far only six-line reels have been auditioned. Expect a few lines where `f-bright` sounds artificial (gravelly or breathy takes convert worst); fix those by re-recording, not by tuning per line.
5. **Delete or keep the Sarah render.** It is reference only.

## How to put it in the game

In order; each step is shippable alone.

1. **Voice pack builder** -- a node or uv script under `tools/voice/` that, for each voice (`m-big`, `f-bright`, `teen-from-man`, `leafkin`), encodes every line to mono Opus or MP3 at about 48 kbps (≈1.3 MB per human voice, compared with about 20 MB as WAV), concatenates the encoded clips into one file, and writes a JSON index `{ line: [byteOffset, byteLength, seconds] }`. Output goes to `public/sounds/voice/`. One pack per voice keeps it to 4 fetches instead of 800. It is not a single-buffer audio sprite: each clip is a self-contained encoded chunk, so the engine decodes only what it plays. Check Opus decode on the Quest browser before choosing it over MP3.
2. **Lazy loader** -- `SoundEngine.load` today fetches and decodes everything up front (`src/v2/audio/sound-engine.js:204`). Decoded audio is about 41 MB of float per voice, so voices need their own path: fetch the pack bytes once, and on a speak request `decodeAudioData(bytes.slice(off, off + len))`, keeping a small LRU of decoded buffers (decode when the panel opens or a hail starts, ahead of the first line).
3. **Moment → clip** -- in `src/v2/talk/speak.js`, each line already has a speech act and mood; add the moment it serves. The picker takes the moment's pool (every reading that lists it, filtered to the speaker's gender form), then applies a shuffle bag per moment, cooldowns per speaker and per utterance within earshot, and a seeded pick so both players hear the same clip (§ Voice, "Repetition is a scheduling problem"). Put it in the talk engine so `check-talk.mjs` can gate it three-free: assert that every moment `speak.js` emits has a non-empty pool and that no clip text names a person, place or number.
4. **Voice per person** -- in `mind.js`, assign each person a group voice (by body: man, woman, child, leafkin) plus a seeded `{ rate, eqTilt }` fingerprint. For leafkin, rate is 1.5 times the fingerprint.
5. **Play it spatially** -- route through the existing positional one-shot path so distance, indoors and walls apply, at the speaker's head. Lines are short enough that a missed line is cheap; `MAX_VOICES` (24) is shared with every other sound, so cap speech at about 2 at once.
6. **Leafkin tiers** -- the tier (native, mixed, pidgin) comes from trust (`rapport.js`); pick the atom's take for that tier.

This depends on build-order step 5 in `conversation-and-quests.md` (the headset panel and hails). Steps 1 to 4 can land before it; step 5 needs a speaker in the world.

## Commands

```
npm run dev                                                       # then open /voice-recorder.html, connect folder tools/voice/work
uv run tools/voice/variants.py                                    # comparison reels -> work/variants/
uv run tools/voice/variants.py --bake m-big f-bright teen-from-man
uv run tools/voice/eleven.py render <voice>                       # dry run; --yes spends credits (ask first)
```

There is no gate for the inventory yet. A session-only check verified: unique utterance ids, no generic they/them in line text, every reading serves a known moment, every moment has a reading, every non-nonverbal leafkin atom has all three tiers, and `cleanTake` keeps a soft sigh tail. Rebuild it as `scripts/check-voice.mjs` when the voice work resumes.
