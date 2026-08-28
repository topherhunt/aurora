// ---------------------------------------------------------------------------
// Prompt template for a fish sideview sheet. One view only (side), unlike the
// character sheet's front/side/back -- a fish swims along one long axis and a
// simple flat sprite/impostor only ever needs to be seen in profile, so there
// is no second view for anything to stay consistent with. Same magenta chroma
// -key convention as tools/characters/sheet-prompt.mjs, so chromakey.mjs's
// existing keyBackground/silhouetteProfile/cropToFigure work unchanged here.
// ---------------------------------------------------------------------------

export function buildFishPrompt(description) {
  if (!description) throw new Error('buildFishPrompt requires a description')
  return (
    `Side-view reference image of a fish on a solid flat magenta background (#FF00FF, chroma key), ` +
    `swimming pose shown in exact profile facing left, orthographic proportions with no perspective ` +
    `distortion, evenly lit, no shadows or gradient on the background, no water, no bubbles, no plants, ` +
    `no other creatures, no text or watermarks, painted in a stylized fantasy game art style.\n\n` +
    `Fish: ${description}.`
  )
}
