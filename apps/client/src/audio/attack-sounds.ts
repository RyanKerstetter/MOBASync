import { ATTACK_SOURCE_PREFIX, type Vector2 } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter, RenderedEntity } from '../game-state.ts'
import { championLook, type Weapon } from '../render3d/models/looks.ts'
import { crackle, noise, swish, tone, type Placement, type Recipe } from './sound-engine.ts'
import { metalHit, sizzle, thrum, waterSplash, whisper, woodHit, woodStrain } from './timbres.ts'

// The sound of each auto attack: one as it goes off (a sword's swing, a bow's twang, a gunshot, a fireball leaving the staff) and
// one as it lands (steel on a body, an arrow striking, a splash, a burst of flame). A champion's are picked by what it fights with
// (`Look.weapon`), so a new champion sounds like its weapon without anything more; monsters and turrets have their own.

// `level` evens out how loud they are against each other (1 when left out): a light weapon's sounds are quieter as they are made.
export type AttackSound = { launch: Recipe; impact: Recipe; level?: number }

// A body being struck: a short low thump, under most of the hits.
const thud = (gain: number, from = 170, to = 70): Recipe => (v) => tone(v, { type: 'sine', freq: from, freqEnd: to, dur: 0.09, gain })

const both = (...recipes: Recipe[]): Recipe => (v) => {
  for (const recipe of recipes) recipe(v)
}

export const WEAPON_SOUNDS: Readonly<Record<Weapon, AttackSound>> = {
  // A longsword cutting the air with a faint edge of steel, and biting: a scrape of the edge, the blade ringing short, a body struck.
  longsword: {
    launch: (v) => {
      swish(v, { low: 450, high: 2400, dur: 0.2, gain: 0.55 })
      noise(v, { dur: 0.14, gain: 0.05, filter: 'highpass', freq: 6500, attack: 0.06, delay: 0.04 })
    },
    impact: (v) => {
      noise(v, { dur: 0.06, gain: 0.45, filter: 'highpass', freq: 3000, freqEnd: 1800, attack: 0.001 })
      metalHit(v, { gain: 0.09, pitch: 2500, ring: 0.18 })
      thud(0.5)(v)
    },
  },
  // A katana: a quicker, keener cut, and a clean slice.
  katana: {
    launch: (v) => {
      swish(v, { low: 900, high: 3600, dur: 0.12, gain: 0.5 })
      noise(v, { dur: 0.1, gain: 0.05, filter: 'highpass', freq: 7000, attack: 0.03, delay: 0.02 })
    },
    impact: both((v) => noise(v, { dur: 0.08, gain: 0.45, filter: 'highpass', freq: 2600, freqEnd: 1800 }), thud(0.35, 200, 90)),
  },
  // Two daggers: two fast swishes, and two stabs.
  daggers: {
    launch: (v) => {
      swish(v, { low: 1300, high: 4200, dur: 0.07, gain: 0.4 })
      swish(v, { low: 1200, high: 4000, dur: 0.07, gain: 0.35, delay: 0.06 })
    },
    impact: (v) => {
      for (const delay of [0, 0.05]) {
        noise(v, { dur: 0.045, gain: 0.4, filter: 'bandpass', freq: 1800, q: 1.5, delay })
        tone(v, { type: 'sine', freq: 190, freqEnd: 90, dur: 0.06, gain: 0.3, delay })
      }
    },
  },
  // The Trinketmaster's stick: a woody whack, and the trinkets on it jingling.
  stick: {
    level: 1.8,
    launch: (v) => {
      swish(v, { low: 400, high: 1500, dur: 0.16, gain: 0.45 })
      crackle(v, { count: 4, dur: 0.12, gain: 0.08, freq: 5200 })
    },
    impact: (v) => {
      tone(v, { type: 'triangle', freq: 520, freqEnd: 470, dur: 0.07, gain: 0.35 })
      noise(v, { dur: 0.06, gain: 0.35, filter: 'bandpass', freq: 950, q: 5 })
      for (const freq of [3300, 4100, 4900]) tone(v, { type: 'sine', freq: freq * (0.95 + Math.random() * 0.1), dur: 0.14, gain: 0.04, delay: Math.random() * 0.06 })
    },
  },
  // A warhammer: a slow, heavy heave, and a crushing blow.
  warhammer: {
    launch: (v) => swish(v, { low: 180, high: 650, dur: 0.3, gain: 0.7 }),
    impact: (v) => {
      tone(v, { type: 'sine', freq: 110, freqEnd: 38, dur: 0.32, gain: 0.95 })
      noise(v, { dur: 0.26, gain: 0.6, filter: 'lowpass', freq: 900, freqEnd: 180 })
      noise(v, { dur: 0.05, gain: 0.35, filter: 'bandpass', freq: 2100, q: 1.2 })
    },
  },
  // A sickle on a chain: the links rattling as it swings, and a slice with a clink.
  sickleChain: {
    launch: (v) => {
      crackle(v, { count: 7, dur: 0.16, gain: 0.18, freq: 4200 })
      swish(v, { low: 700, high: 2600, dur: 0.15, gain: 0.55 })
    },
    impact: both((v) => noise(v, { dur: 0.07, gain: 0.4, filter: 'highpass', freq: 2200 }), (v) => metalHit(v, { gain: 0.06, pitch: 3400, ring: 0.1 }), thud(0.35)),
  },
  // Fists: a short jab of air, and a punch landing.
  fists: {
    launch: (v) => swish(v, { low: 600, high: 1800, dur: 0.1, gain: 0.6 }),
    impact: both(thud(0.8, 150, 60), (v) => noise(v, { dur: 0.05, gain: 0.35, filter: 'lowpass', freq: 1500 })),
  },
  // A vampire's claws: a swipe, and three rakes across flesh.
  claws: {
    level: 1.6,
    launch: (v) => swish(v, { low: 1000, high: 3600, dur: 0.12, gain: 0.45 }),
    impact: (v) => {
      for (const delay of [0, 0.028, 0.056]) noise(v, { dur: 0.06, gain: 0.32, filter: 'bandpass', freq: 2600, freqEnd: 1200, q: 2, delay })
      noise(v, { dur: 0.09, gain: 0.25, filter: 'lowpass', freq: 600 })
    },
  },
  // The Ent's branches: a heavy limb swung with wood creaking and leaves rustling, and landing like a tree: a hard crack of wood, a
  // heavy thump, splinters.
  branches: {
    launch: (v) => {
      swish(v, { low: 160, high: 720, dur: 0.3, gain: 0.75 })
      woodStrain(v, { gain: 0.14, dur: 0.22 })
      noise(v, { dur: 0.25, gain: 0.08, filter: 'highpass', freq: 5000, attack: 0.08 })
    },
    impact: (v) => woodHit(v, { gain: 1, size: 0.5, splinters: true }),
  },
  // A longbow: the string's twang and the arrow's hiss, and the hard tock of the head driving into wood, the shaft quivering.
  bow: {
    launch: (v) => {
      tone(v, { type: 'triangle', freq: 196, freqEnd: 182, dur: 0.24, gain: 0.35 })
      tone(v, { type: 'sine', freq: 392, freqEnd: 370, dur: 0.14, gain: 0.12 })
      noise(v, { dur: 0.02, gain: 0.3, filter: 'highpass', freq: 3000 })
      swish(v, { low: 2000, high: 4200, dur: 0.12, gain: 0.18, delay: 0.02 })
    },
    impact: (v) => {
      woodHit(v, { gain: 0.65, size: 1.5 })
      tone(v, { type: 'triangle', freq: 230, freqEnd: 215, dur: 0.12, gain: 0.07, vibrato: { rate: 34, depth: 7 }, delay: 0.01 })
    },
  },
  // A rifle: the crack and boom of the shot and its echo, and the slug hitting home.
  rifle: {
    launch: (v) => {
      noise(v, { dur: 0.12, gain: 0.85, filter: 'lowpass', freq: 7000, freqEnd: 900, attack: 0.001 })
      tone(v, { type: 'sine', freq: 120, freqEnd: 45, dur: 0.13, gain: 0.7 })
      noise(v, { dur: 0.35, gain: 0.12, filter: 'lowpass', freq: 1200, attack: 0.02, delay: 0.03 })
    },
    impact: both((v) => noise(v, { dur: 0.035, gain: 0.35, filter: 'bandpass', freq: 2500, q: 1.5 }), thud(0.45, 210, 90)),
  },
  // A grenade launcher: the hollow thoomp of it firing, and a small blast with debris.
  launcher: {
    launch: (v) => {
      tone(v, { type: 'sine', freq: 180, freqEnd: 70, dur: 0.16, gain: 0.8 })
      noise(v, { dur: 0.1, gain: 0.35, filter: 'lowpass', freq: 600 })
    },
    impact: (v) => {
      noise(v, { dur: 0.5, gain: 0.9, filter: 'lowpass', freq: 2500, freqEnd: 150, attack: 0.002 })
      tone(v, { type: 'sine', freq: 80, freqEnd: 35, dur: 0.35, gain: 0.8 })
      crackle(v, { count: 8, dur: 0.3, gain: 0.15, freq: 2600, delay: 0.05 })
    },
  },
  // The Cursebearer's skull staff: a curse breathed out on a ghostly whisper over a low thrum, and sinking into its victim with a dull
  // blow and a cold hiss.
  skullStaff: {
    launch: (v) => {
      whisper(v, { from: 480, to: 1150, dur: 0.3, gain: 0.32 })
      whisper(v, { from: 1600, to: 900, dur: 0.24, gain: 0.1, q: 9, delay: 0.03 })
      thrum(v, { freq: 82, dur: 0.32, gain: 0.13 })
    },
    impact: (v) => {
      tone(v, { type: 'sine', freq: 150, freqEnd: 60, dur: 0.13, gain: 0.4 })
      sizzle(v, { dur: 0.22, gain: 0.16 })
      whisper(v, { from: 800, to: 320, dur: 0.22, gain: 0.2 })
    },
  },
  // Capricorn's water staff: bubbles welling up as the water leaves, and a splash.
  waterStaff: {
    launch: (v) => {
      for (const delay of [0, 0.04, 0.08]) tone(v, { type: 'sine', freq: 380 + Math.random() * 120, freqEnd: 900, dur: 0.06, gain: 0.18, delay })
      noise(v, { dur: 0.16, gain: 0.18, filter: 'bandpass', freq: 1500, q: 1.2 })
    },
    impact: (v) => waterSplash(v, { gain: 0.7 }),
  },
  // The Fire Mage's staff: a roar of flame leaving it, crackling, and a burst of fire.
  fireStaff: {
    launch: (v) => {
      noise(v, { dur: 0.26, gain: 0.7, filter: 'lowpass', freq: 400, freqEnd: 1800, attack: 0.06 })
      crackle(v, { count: 6, dur: 0.25, gain: 0.12, freq: 3000 })
    },
    impact: (v) => {
      noise(v, { dur: 0.36, gain: 0.75, filter: 'lowpass', freq: 3000, freqEnd: 300, attack: 0.003 })
      tone(v, { type: 'sine', freq: 120, freqEnd: 50, dur: 0.2, gain: 0.5 })
      crackle(v, { count: 10, dur: 0.4, gain: 0.12, freq: 2800 })
    },
  },
  // The Sage's leaf staff: a soft chime on the wind, and a gentle strike with leaves rustling.
  leafStaff: {
    level: 1.7,
    launch: (v) => {
      tone(v, { type: 'sine', freq: 880, dur: 0.3, gain: 0.1, attack: 0.01 })
      tone(v, { type: 'sine', freq: 1318, dur: 0.26, gain: 0.07, attack: 0.01, delay: 0.03 })
      noise(v, { dur: 0.16, gain: 0.08, filter: 'highpass', freq: 5500, attack: 0.04 })
    },
    impact: (v) => {
      tone(v, { type: 'sine', freq: 660, freqEnd: 440, dur: 0.2, gain: 0.14 })
      noise(v, { dur: 0.12, gain: 0.14, filter: 'bandpass', freq: 3000, q: 1.5 })
    },
  },
  // A cleaver: a heavy chop.
  cleaver: {
    launch: (v) => swish(v, { low: 300, high: 1200, dur: 0.22, gain: 0.6 }),
    impact: both((v) => noise(v, { dur: 0.06, gain: 0.45, filter: 'bandpass', freq: 1600, q: 1.5 }), thud(0.7, 140, 55)),
  },
}

export const MONSTER_SOUNDS: Readonly<Record<string, AttackSound>> = {
  // A slime: a wet lunge, and a splat.
  slime: {
    launch: (v) => {
      tone(v, { type: 'sine', freq: 300, freqEnd: 120, dur: 0.16, gain: 0.35, vibrato: { rate: 22, depth: 30 } })
      noise(v, { dur: 0.1, gain: 0.2, filter: 'lowpass', freq: 500 })
    },
    impact: (v) => {
      noise(v, { dur: 0.18, gain: 0.6, filter: 'lowpass', freq: 900, freqEnd: 200 })
      tone(v, { type: 'sine', freq: 180, freqEnd: 70, dur: 0.12, gain: 0.45 })
    },
  },
  // A golem: stone grinding as the fists come up, and a slam that shakes the ground.
  golem: {
    launch: (v) => {
      swish(v, { low: 140, high: 480, dur: 0.35, gain: 0.8 })
      crackle(v, { count: 6, dur: 0.3, gain: 0.15, freq: 900 })
    },
    impact: (v) => {
      tone(v, { type: 'sine', freq: 90, freqEnd: 30, dur: 0.45, gain: 1 })
      noise(v, { dur: 0.4, gain: 0.7, filter: 'lowpass', freq: 1200, freqEnd: 100 })
      crackle(v, { count: 10, dur: 0.35, gain: 0.14, freq: 1400, delay: 0.04 })
    },
  },
  // A wolf: a snarl, and the snap of its jaws.
  wolf: {
    launch: (v) => tone(v, { type: 'sawtooth', freq: 140, freqEnd: 120, dur: 0.2, gain: 0.4, lowpass: 1100, vibrato: { rate: 30, depth: 25 } }),
    impact: both((v) => noise(v, { dur: 0.03, gain: 0.4, filter: 'highpass', freq: 2500 }), (v) => tone(v, { type: 'square', freq: 900, freqEnd: 300, dur: 0.04, gain: 0.1, lowpass: 2000 }), thud(0.4)),
  },
}

// A turret: an arcane charge whining up as it fires, and a crackling zap on whatever it hits.
export const TURRET_SOUND: AttackSound = {
  launch: (v) => {
    tone(v, { type: 'sawtooth', freq: 300, freqEnd: 1200, dur: 0.12, gain: 0.18, lowpass: 2400 })
    tone(v, { type: 'sine', freq: 150, freqEnd: 60, dur: 0.2, gain: 0.55 })
    noise(v, { dur: 0.08, gain: 0.2, filter: 'bandpass', freq: 1800 })
  },
  impact: (v) => {
    tone(v, { type: 'sawtooth', freq: 520, freqEnd: 260, dur: 0.15, gain: 0.16, lowpass: 3000, vibrato: { rate: 60, depth: 120 } })
    noise(v, { dur: 0.1, gain: 0.3, filter: 'highpass', freq: 2500 })
  },
}

// What a character's attacks sound like: a turret's, a monster's own (a monster with none, like the nearest of them by size), or its
// weapon's.
export function attackSoundOf(character: Pick<RenderedCharacter, 'champion'> & { turret?: unknown; monster?: unknown }): AttackSound {
  if (character.turret) return TURRET_SOUND
  if (character.monster) return MONSTER_SOUNDS[character.champion.id] ?? (character.champion.radius >= 36 ? MONSTER_SOUNDS.golem : MONSTER_SOUNDS.wolf)
  return WEAPON_SOUNDS[championLook(character.champion).weapon]
}

// One sound to play: whose attack it is, which half (going off or landing), where, and whether it is the player's own.
export type AttackCue = { sound: AttackSound; part: 'launch' | 'impact'; at: Vector2; own: boolean; delay?: number }

// How far a windup has to have run before its end is taken as the attack going off, not being cancelled.
export const LAUNCHED_PROGRESS = 0.6
// A melee blow lands a moment after the swing starts to sound.
const MELEE_IMPACT_DELAY = 0.05

export type AttackSoundFrame = {
  // What the player's team sees: only what is seen is heard.
  characters: readonly RenderedCharacter[]
  // The rest, out of sight: only to tell whose a shot is.
  unseen?: readonly RenderedCharacter[]
  // Every entity in the game, and which of them are seen.
  entities: readonly RenderedEntity[]
  visibleEntityIds: ReadonlySet<string>
  localCharacterId: number | undefined
}

// Works out, frame by frame, which attacks went off and which landed, as sounds to play. An auto attack that shoots is heard as its
// shot appears and when it is gone (it has struck: a shot follows its target until it does); one that does not is heard as its
// windup ends, its swing and its blow together. Only what the player's team can see is heard, so a sound never gives away anything
// hidden. It knows nothing of how sounds are made, so it can be tested on its own.
export class AttackSoundDirector {
  private readonly windups = new Map<number, { progress: number; targetId?: number }>()
  private readonly shots = new Map<string, { sound: AttackSound; at: Vector2; seen: boolean; own: boolean }>()
  private primed = false

  update(frame: AttackSoundFrame): AttackCue[] {
    const cues: AttackCue[] = []
    const seen = new Map(frame.characters.map((character) => [character.id, character]))
    const everyone = new Map([...(frame.unseen ?? []), ...frame.characters].map((character) => [character.id, character]))

    // Melee blows: an attack's windup that ended far enough through went off.
    for (const character of frame.characters) {
      const action = character.action
      const before = this.windups.get(character.id)
      if (action?.kind === 'attack' && !character.dead) {
        this.windups.set(character.id, { progress: action.progress, ...(action.targetId === undefined ? {} : { targetId: action.targetId }) })
        continue
      }
      this.windups.delete(character.id)
      if (!before || character.dead || before.progress < LAUNCHED_PROGRESS || character.champion.attackProjectile) continue
      const sound = attackSoundOf(character)
      const own = character.id === frame.localCharacterId
      cues.push({ sound, part: 'launch', at: character.position, own })
      const target = before.targetId === undefined ? undefined : seen.get(before.targetId)
      if (target && !target.dead) cues.push({ sound, part: 'impact', at: target.position, own, delay: MELEE_IMPACT_DELAY })
    }
    for (const id of this.windups.keys()) if (!seen.has(id)) this.windups.delete(id)

    // Shots: one appearing went off, one gone has struck.
    const present = new Set<string>()
    for (const entity of frame.entities) {
      if (!entity.id.startsWith(ATTACK_SOURCE_PREFIX)) continue
      present.add(entity.id)
      const visible = frame.visibleEntityIds.has(entity.id)
      const known = this.shots.get(entity.id)
      if (known) {
        known.at = entity.position
        known.seen = visible
        continue
      }
      const owner = everyone.get(entity.ownerId)
      const sound = owner ? attackSoundOf(owner) : TURRET_SOUND
      const own = entity.ownerId === frame.localCharacterId
      this.shots.set(entity.id, { sound, at: entity.position, seen: visible, own })
      // Shots already in the air when the game is first heard are not heard going off.
      if (this.primed && visible) cues.push({ sound, part: 'launch', at: entity.position, own })
    }
    for (const [id, shot] of this.shots) {
      if (present.has(id)) continue
      this.shots.delete(id)
      if (shot.seen) cues.push({ sound: shot.sound, part: 'impact', at: shot.at, own: shot.own })
    }
    this.primed = true
    return cues
  }
}

// How loud a sound is from where the player is listening, and from which side: full near them, fading out to nothing at
// `HEARING_RANGE`, and panned by how far to the left or right it is. The player's own attacks are a little louder.
export const HEARING_RANGE = 1500
const FULL_VOLUME_RANGE = 250
const PAN_RANGE = 900

export function placeSound(at: Vector2, listener: Vector2, own: boolean): Placement {
  const distance = Math.hypot(at.x - listener.x, at.y - listener.y)
  const fade = distance <= FULL_VOLUME_RANGE ? 1 : Math.max(0, 1 - (distance - FULL_VOLUME_RANGE) / (HEARING_RANGE - FULL_VOLUME_RANGE))
  return { gain: fade * fade * (own ? 1 : 0.8), pan: Math.max(-1, Math.min(1, (at.x - listener.x) / PAN_RANGE)) * 0.75 }
}
