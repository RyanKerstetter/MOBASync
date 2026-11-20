// How each champion looks in 3D: one model (see humanoid.ts) dressed and armed differently for each, with the animations that
// go with what it holds. A champion with no look of its own here is dressed by how it fights (`fallbackLook`).
import { hashString } from '../space.ts'
import type { DetailId } from './detail/index.ts'

export type Armor = 'plate' | 'heavyplate' | 'leather' | 'robe' | 'gi' | 'cloak' | 'bark' | 'fatigues' | 'berserker' | 'vampire'
export type Headgear =
  | 'knightHelm' | 'hornedHelm' | 'hood' | 'cowl' | 'wizardHat' | 'goatHorns' | 'featherCap' | 'combatHelmet'
  | 'goggles' | 'jesterHat' | 'ninjaMask' | 'chainMask' | 'leafCrown' | 'topknot' | 'bloodCrown' | 'antlers' | 'wildHair' | 'vampire'
export type Weapon =
  | 'longsword' | 'warhammer' | 'katana' | 'daggers' | 'sickleChain' | 'skullStaff' | 'waterStaff' | 'fireStaff' | 'leafStaff'
  | 'bow' | 'crystalBow' | 'crossbow' | 'rifle' | 'launcher' | 'stick' | 'fists' | 'cleaver' | 'branches' | 'claws'
export type BackPiece = 'cape' | 'longCape' | 'quiver' | 'backpack' | 'satchel' | 'tatters' | 'beads' | 'pelt' | 'none'
// How an attack or a cast is played: a one-handed swing, a two-handed slam, quick stabs with both hands, punches, a thrust of a
// staff, a spell flung with both hands, a bow drawn and loosed, a gun fired, something thrown overhand, claws raked across.
export type Style = 'blade' | 'heavy' | 'dual' | 'unarmed' | 'staff' | 'spell' | 'bow' | 'gun' | 'crossbow' | 'throw' | 'claw'

export type Look = {
  // How broad and how tall it is, against the usual (1).
  bulk: number
  tall: number
  armor: Armor
  head: Headgear
  weapon: Weapon
  back: BackPiece
  shield?: true
  // Its colours: its clothes, their trim, what glows (its magic, its blade's edge), its skin, and its eyes when they glow.
  cloth: string
  trim: string
  accent: string
  skin: string
  eyes?: string
  attack: Style
  cast: Style
  // Covered from head to foot, face and hands too, in its clothes' colour, with only a slit for the eyes.
  covered?: true
  // Built in full detail by a model of its own on the same skeleton, instead of from the pieces above (see knight.ts).
  detail?: DetailId
}

const SKIN = ['#e2b48f', '#c99470', '#f0c9a8', '#a8724e']

export const CHAMPION_LOOKS: Readonly<Record<string, Look>> = {
  // A hooded hexer in tattered purple, with a skull on its staff and a curse burning in it.
  cursebearer: { bulk: 0.95, tall: 1, armor: 'robe', head: 'cowl', weapon: 'skullStaff', back: 'tatters', cloth: '#2a1838', trim: '#140c1c', accent: '#5a3480', skin: SKIN[2], eyes: '#8a62bf', attack: 'staff', cast: 'spell', detail: 'cursebearer' },
  // A crossbowman in green leather with a feathered cap, a crossbow carried in both hands, and a quiver of bolts.
  archer: { bulk: 0.9, tall: 1.02, armor: 'leather', head: 'featherCap', weapon: 'crossbow', back: 'quiver', cloth: '#3f6b35', trim: '#6b4a2e', accent: '#6dd39b', skin: SKIN[0], attack: 'crossbow', cast: 'crossbow', detail: 'archer' },
  // A knight in full plate with a visored, plumed helm, a heraldic tabard and cape, and a longsword (built in detail: knight.ts).
  swordsman: { bulk: 1.05, tall: 1.02, armor: 'plate', head: 'knightHelm', weapon: 'longsword', back: 'cape', cloth: '#2f4a7a', trim: '#c9b27a', accent: '#f2c14e', skin: SKIN[0], attack: 'blade', cast: 'blade', detail: 'knight' },
  // A water mage in deep blue, horned like a goat, with a staff holding an orb of water.
  capricorn: { bulk: 1, tall: 1, armor: 'robe', head: 'goatHorns', weapon: 'waterStaff', back: 'none', cloth: '#1f5fa8', trim: '#e9e1cf', accent: '#4fa8ff', skin: SKIN[2], attack: 'staff', cast: 'spell', detail: 'capricorn' },
  // A soldier in fatigues and a helmet, with a rifle and a pack.
  soldier: { bulk: 1.05, tall: 1, armor: 'fatigues', head: 'combatHelmet', weapon: 'rifle', back: 'backpack', cloth: '#556b3a', trim: '#3a4428', accent: '#ffb347', skin: SKIN[1], attack: 'gun', cast: 'gun', detail: 'soldier' },
  // A bomber in goggles and leather, with a stubby launcher and a bandolier of grenades.
  grenadier: { bulk: 1.05, tall: 0.98, armor: 'leather', head: 'goggles', weapon: 'launcher', back: 'satchel', cloth: '#7a5a34', trim: '#3d3024', accent: '#d4b13a', skin: SKIN[0], attack: 'gun', cast: 'throw', detail: 'grenadier' },
  // A trickster in a jester's hat, with a long stick hung with trinkets.
  trinketmaster: { bulk: 0.95, tall: 1, armor: 'leather', head: 'jesterHat', weapon: 'stick', back: 'satchel', cloth: '#2a7a74', trim: '#c94a6b', accent: '#3fc8c0', skin: SKIN[2], attack: 'blade', cast: 'throw', detail: 'trinketmaster' },
  // A masked ninja in dark wraps, with a katana.
  // Covered head to foot in black, nothing showing but the eyes.
  ninja: { bulk: 0.88, tall: 0.98, armor: 'gi', head: 'ninjaMask', weapon: 'katana', back: 'none', cloth: '#16161f', trim: '#24242f', accent: '#4a4266', skin: '#16161f', covered: true, attack: 'blade', cast: 'dual', detail: 'ninja' },
  // A berserker: bare-chested and painted for war, a wolf's pelt on its shoulders, a fur kilt, wild hair and beard, and a warhammer.
  hammer: { bulk: 1.3, tall: 1.08, armor: 'berserker', head: 'wildHair', weapon: 'warhammer', back: 'pelt', cloth: '#5a3d26', trim: '#3a2618', accent: '#c4302b', skin: SKIN[1], attack: 'heavy', cast: 'heavy', detail: 'hammer' },
  // A masked fighter wrapped in chains, with a sickle on a chain.
  chain: { bulk: 1, tall: 1, armor: 'leather', head: 'chainMask', weapon: 'sickleChain', back: 'none', cloth: '#3c3f47', trim: '#c0c8d0', accent: '#ff6b4a', skin: SKIN[1], attack: 'blade', cast: 'throw', detail: 'chain' },
  // An assassin lost in a great hooded cloak, eyes glowing, with two daggers.
  cloak: { bulk: 0.92, tall: 1, armor: 'cloak', head: 'cowl', weapon: 'daggers', back: 'longCape', cloth: '#2a2238', trim: '#4b3a66', accent: '#8e6bd9', skin: SKIN[0], eyes: '#b89cff', attack: 'dual', cast: 'dual', detail: 'cloak' },
  // A nature healer in mossy greens, crowned with leaves, a mantle of vines on her back, with a staff that buds.
  sage: { bulk: 0.95, tall: 1, armor: 'robe', head: 'leafCrown', weapon: 'leafStaff', back: 'tatters', cloth: '#3f6e34', trim: '#7a5a34', accent: '#8ee6a0', skin: SKIN[0], attack: 'staff', cast: 'spell', detail: 'sage' },
  // A monk with a topknot, in an orange robe and prayer beads, who fights with wrapped fists.
  monk: { bulk: 1.05, tall: 1, armor: 'gi', head: 'topknot', weapon: 'fists', back: 'beads', cloth: '#d9822b', trim: '#7a3b14', accent: '#ff7a45', skin: SKIN[1], attack: 'unarmed', cast: 'unarmed', detail: 'monk' },
  // A pyromancer in red, in a tall pointed hat, with a staff of fire.
  firemage: { bulk: 1, tall: 1, armor: 'robe', head: 'wizardHat', weapon: 'fireStaff', back: 'none', cloth: '#b8321c', trim: '#3d1a12', accent: '#ff7a2f', skin: SKIN[2], attack: 'staff', cast: 'spell', detail: 'firemage' },
  // A vampire: deathly pale, slick black hair, a high collar lined in red, a long dark coat, red eyes, and long claws.
  aurel: { bulk: 1.02, tall: 1.05, armor: 'vampire', head: 'vampire', weapon: 'claws', back: 'longCape', cloth: '#1c141a', trim: '#7a0f1c', accent: '#d23a48', skin: '#e6dfe6', eyes: '#ff3a4a', attack: 'claw', cast: 'claw', detail: 'aurel' },
  // A treant: bark for a body, branches for arms, a crown of leaves and antlers of wood, and eyes that glow green.
  ent: { bulk: 1.3, tall: 1.12, armor: 'bark', head: 'antlers', weapon: 'branches', back: 'none', cloth: '#6b4a2e', trim: '#4f7d34', accent: '#7fbf4d', skin: '#7a5638', eyes: '#b6ff6a', attack: 'unarmed', cast: 'heavy', detail: 'ent' },
  // A hound of hell: hunched and broad, scorched hide, wild mane, burning eyes, and claws.
  hellhound: { bulk: 1.12, tall: 0.98, armor: 'berserker', head: 'wildHair', weapon: 'claws', back: 'pelt', cloth: '#3a1210', trim: '#1c0a08', accent: '#ff5a1a', skin: '#5a2a22', eyes: '#ff7a1a', attack: 'claw', cast: 'claw' },
  // A guardian of stone: broad in heavy grey plate, horned helm and shield, swinging a hammer.
  stone: { bulk: 1.25, tall: 1.04, armor: 'heavyplate', head: 'hornedHelm', weapon: 'warhammer', back: 'none', shield: true, cloth: '#6f6a5f', trim: '#3d3a33', accent: '#c9b27a', skin: SKIN[1], attack: 'heavy', cast: 'heavy' },
  // A scavenger in a ragged hooded cloak of dun and moss, with hooked claws.
  vulture: { bulk: 0.95, tall: 1.02, armor: 'cloak', head: 'hood', weapon: 'claws', back: 'tatters', cloth: '#3a2f24', trim: '#5f8f2e', accent: '#a6ff4d', skin: SKIN[3], eyes: '#c8ff6a', attack: 'claw', cast: 'throw' },
  // A knife fighter in dark leathers, masked, with a pair of long knives.
  blade: { bulk: 0.9, tall: 1, armor: 'leather', head: 'ninjaMask', weapon: 'daggers', back: 'none', cloth: '#2b2f36', trim: '#c0c8d0', accent: '#e0e6ee', skin: SKIN[0], attack: 'dual', cast: 'throw' },
  // A blood mage in deep red robes, crowned in blood, with a staff that drips.
  sanguine: { bulk: 0.95, tall: 1.02, armor: 'robe', head: 'bloodCrown', weapon: 'skullStaff', back: 'tatters', cloth: '#5a0f1c', trim: '#1c0a0e', accent: '#d23a48', skin: '#e6dfe6', eyes: '#ff3a4a', attack: 'staff', cast: 'spell' },
  // A woodland hunter in browns and greens, hooded, with a longbow and a quiver.
  hunter: { bulk: 0.95, tall: 1.03, armor: 'leather', head: 'hood', weapon: 'bow', back: 'quiver', cloth: '#4a5a2e', trim: '#5a3d22', accent: '#9bd36d', skin: SKIN[1], attack: 'bow', cast: 'bow' },
  // A crystal archer in pale blue leathers, hooded, with a bow grown of crystal and a quiver of crystal arrows.
  crystal: { bulk: 0.92, tall: 1.02, armor: 'leather', head: 'hood', weapon: 'crystalBow', back: 'quiver', cloth: '#2c4a6e', trim: '#d6eef7', accent: '#9fe7ff', skin: SKIN[0], eyes: '#bff4ff', attack: 'bow', cast: 'bow' },
  // A paladin of light in white and gold plate, with a longsword and a cape.
  sorin: { bulk: 1.08, tall: 1.03, armor: 'plate', head: 'knightHelm', weapon: 'longsword', back: 'cape', cloth: '#e9e1cf', trim: '#c9a23a', accent: '#ffe08a', skin: SKIN[0], eyes: '#fff2b0', attack: 'blade', cast: 'blade' },
  // A marksman in a long dark coat, hooded, goggles on, with a long rifle.
  sniper: { bulk: 0.92, tall: 1.02, armor: 'cloak', head: 'goggles', weapon: 'rifle', back: 'backpack', cloth: '#2f3a3f', trim: '#5a4a32', accent: '#ffd36a', skin: SKIN[2], attack: 'gun', cast: 'gun' },
}

// The look of a champion with none of its own: a robed caster if it shoots, a swordsman if not, in its own colour.
// A champion's look: its own, or one made from how it fights and the colour of its shot (or of its name, for one with none).
export function championLook(champion: { id: string; attackProjectile?: { color?: string } }): Look {
  const shot = champion.attackProjectile
  return CHAMPION_LOOKS[champion.id] ?? fallbackLook(shot !== undefined, shot?.color ?? `hsl(${hashString(champion.id) % 360}, 65%, 60%)`)
}

export function fallbackLook(ranged: boolean, accent: string): Look {
  return ranged
    ? { bulk: 1, tall: 1, armor: 'robe', head: 'hood', weapon: 'skullStaff', back: 'none', cloth: '#3a3f55', trim: '#20222e', accent, skin: SKIN[0], attack: 'staff', cast: 'spell' }
    : { bulk: 1, tall: 1, armor: 'plate', head: 'knightHelm', weapon: 'longsword', back: 'cape', shield: true, cloth: '#3a3f55', trim: '#9aa3ad', accent, skin: SKIN[0], attack: 'blade', cast: 'blade' }
}
