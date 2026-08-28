// ---------------------------------------------------------------------------
// Worldbuilding presets for the character pool: a Skyrim-esque Nordic fantasy
// medieval setting. gen-sheet.html's role/gender/age/profession dropdowns
// pick from ROLES/PROFESSIONS below; describeNordicCharacter() turns a
// selection into the `vars` object sheet-prompt.mjs's buildViewPrompt expects
// (species/age/description -- see that file for the remaining fields, which
// this setting doesn't use). Pure browser-safe JS, no Node built-ins, so it's
// imported directly by the bench as well as any future batch tooling.
// ---------------------------------------------------------------------------

export const ROLES = [
  { id: 'villager', label: 'Villager', gear: 'simple homespun wool and linen clothing in muted earthy colors' },
  { id: 'traveler', label: 'Traveler', gear: 'a worn hooded traveling cloak, sturdy leather boots, and a pack slung over one shoulder' },
  { id: 'warrior', label: 'Warrior', gear: 'layered furs over leather and mail armor, with a weapon at their belt' },
]

export const GENDERS = ['male', 'female']
export const AGES = ['adult', 'child']

export const ADULT_PROFESSIONS = [
  { id: 'blacksmith', label: 'Blacksmith', gear: 'a soot-streaked leather apron over a rough tunic, heavy gloves' },
  { id: 'farmer', label: 'Farmer', gear: 'a patched wool tunic, mud-caked boots, a wide-brimmed hat' },
  { id: 'hunter', label: 'Hunter', gear: 'fur-lined leather armor, a bow and quiver on their back' },
  { id: 'fisherman', label: 'Fisherman', gear: 'an oiled leather coat, tall waterproofed boots' },
  { id: 'innkeeper', label: 'Innkeeper', gear: 'a clean apron over practical wool clothing, a ring of keys at the belt' },
  { id: 'merchant', label: 'Merchant', gear: 'fine dyed wool robes trimmed with fur, a leather coin purse' },
  { id: 'herbalist', label: 'Herbalist', gear: 'a hooded cloak, pouches of dried herbs at the belt' },
  { id: 'woodcutter', label: 'Woodcutter', gear: 'a heavy fur vest, carrying a bundle of cut firewood' },
  { id: 'shepherd', label: 'Shepherd', gear: 'a thick wool cloak, a wooden crook' },
  { id: 'guard', label: 'Town Guard', gear: 'a chainmail hauberk, an open-faced helm, a spear' },
  { id: 'mercenary', label: 'Mercenary', gear: 'mismatched scavenged armor and an assortment of weapons' },
  { id: 'shieldmaiden', label: 'Shieldmaiden', gear: 'braided hair, a round shield, a short sword, leather and mail armor' },
  { id: 'skald', label: 'Skald (bard)', gear: 'ornately embroidered robes, a lute or harp slung on their back' },
  { id: 'priest', label: 'Priest of the Old Gods', gear: 'long ceremonial robes with carved bone talismans' },
  { id: 'alchemist', label: 'Alchemist', gear: 'a leather apron hung with glass vials on a bandolier' },
  { id: 'trapper', label: 'Trapper', gear: 'layered furs and a satchel of pelts' },
  { id: 'miner', label: 'Miner', gear: 'a rugged leather tunic, a pickaxe, a soot-covered face' },
  { id: 'stablehand', label: 'Stablehand', gear: 'a plain rough tunic, straw-flecked boots' },
  { id: 'healer', label: 'Wandering Healer', gear: 'a simple grey robe, a satchel of bandages and herbs' },
  { id: 'battlemage', label: 'Battlemage', gear: 'rune-etched leather armor over robes, a carved wooden staff' },
  { id: 'thief', label: 'Thief', gear: 'a dark hooded cloak and soft leather boots for silent footsteps' },
  { id: 'jarlsthane', label: "Jarl's Thane", gear: 'polished mail armor, a fur-trimmed cloak, an ornate sword' },
]

export const CHILD_PROFESSIONS = [
  { id: 'farmhand', label: 'Farm Hand', gear: 'a patched homespun tunic, bare or sandaled feet' },
  { id: 'shepherd-apprentice', label: "Shepherd's Apprentice", gear: 'a rough wool cloak, a small wooden crook' },
  { id: 'stableboy', label: 'Stable Hand', gear: 'a plain tunic dusted with straw' },
  { id: 'fishmonger-helper', label: "Fisherman's Helper", gear: 'a patched oilskin coat, bare feet' },
  { id: 'urchin', label: 'Street Urchin', gear: 'ragged, ill-fitting hand-me-down clothing' },
  { id: 'blacksmith-apprentice', label: "Blacksmith's Apprentice", gear: 'a soot-smudged leather apron, too big for them' },
  { id: 'orphan', label: 'Orphan', gear: 'a threadbare wool cloak, worn boots' },
  { id: 'merchant-child', label: "Merchant's Child", gear: 'neat but modest dyed wool clothing' },
]

export function professionsFor(age) { return age === 'child' ? CHILD_PROFESSIONS : ADULT_PROFESSIONS }

export function randomProfession(age) {
  const list = professionsFor(age)
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * Turns a {role,gender,age,professionId} selection into buildViewPrompt's
 * `vars`. `professionId` is optional -- omit it (e.g. for a child with no
 * trade yet) to describe the character by role alone.
 */
export function describeNordicCharacter({ role, gender, age, professionId }) {
  const roleDef = ROLES.find((r) => r.id === role)
  if (!roleDef) throw new Error(`unknown role "${role}"`)
  if (!GENDERS.includes(gender)) throw new Error(`unknown gender "${gender}"`)
  if (!AGES.includes(age)) throw new Error(`unknown age "${age}"`)

  const ageWord = age === 'child' ? 'a child' : 'an adult'
  let description = `${ageWord} ${gender} Nordic ${roleDef.label.toLowerCase()}, in a Skyrim-esque Nordic fantasy medieval world. Wearing ${roleDef.gear}.`
  if (professionId) {
    const prof = professionsFor(age).find((p) => p.id === professionId)
    if (!prof) throw new Error(`unknown profession "${professionId}" for age "${age}"`)
    description =
      `${ageWord} ${gender} Nordic ${roleDef.label.toLowerCase()}, ${prof.label.toLowerCase()} by trade, ` +
      `in a Skyrim-esque Nordic fantasy medieval world. Wearing ${roleDef.gear}; ${prof.gear}.`
  }

  return { species: 'human', age, description }
}
