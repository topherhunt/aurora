# Project agent instructions

Run `npm run build` after each code change to ensure nothing was broken.

When the user asks to generate imagery for this project, use the project's Fluxcline image
generation harness rather than Codex's built-in image-generation system. For simple, deliberately
small graphics such as pixel art, generate them deterministically in code instead. Keep generated
assets appropriate to their runtime use: small, stylized, and cheap to load when they are intended
for the Quest client.

## The comment ratchet

Comments in this repo run about 43% of non-blank JS lines, and they got there one well-meaning session at a time. That ratio is the reason a single discovery question can cost 100K tokens: answering "how does rock LOD work?" means reading `rocks.js` + `rock-bank.js` + `check-rocks.mjs`, and most of what gets read is prose. Every line you add is a line every future session pays to read.

**A comment states what is true now, not how it got that way.** The findings, the rejected alternatives, the measurements, the round-by-round tuning log -- those belong in `design/`, and chronology specifically belongs in `design/history/`. `design/` is the healthy part of this repo precisely because it enforces that split; the code comments became the journal `design/` refuses to be. Cite the doc (`DESIGN.md §N`) instead of restating it.

**When you change code, rewrite the comment that is now wrong.** Do not add a second comment beside it. Do not leave "previously we..." or "this used to...". If the comment and the code disagree, one of them is a bug.

**Earn the lines.** A trap that fails silently and photogenically is worth five lines explaining it -- that is the class of comment this codebase should keep. Restating what the next line plainly does is worth zero. When a header block grows past ~10 lines, that is the signal to move the body into `design/` and leave a pointer.

**Deleting is half the edit.** A refinement pass that is significantly net-additive without several genuinely new facts means you appended. Check the diff's `+`/`-` balance before you call the work done.
