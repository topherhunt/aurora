# Project agent instructions

When the user asks to generate imagery for this project, use the project's Fluxcline image
generation harness rather than Codex's built-in image-generation system. For simple, deliberately
small graphics such as pixel art, generate them deterministically in code instead. Keep generated
assets appropriate to their runtime use: small, stylized, and cheap to load when they are intended
for the Quest client.
