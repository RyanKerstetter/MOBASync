import { ATTACK_SOURCE_PREFIX, getAbilityDef, type Vector2 } from '../../../../packages/shared/src/index.ts'
import { ABILITY_SOUNDS, BACK_SOUNDS, ENTITY_SOUNDS } from './ability-sounds.ts'
import { LAUNCHED_PROGRESS, type AttackSoundFrame } from './attack-sounds.ts'
import type { Recipe } from './sound-engine.ts'

// One sound to play, where, and whether it is the player's own.
export type SoundCue = { recipe: Recipe; at: Vector2; own: boolean; delay?: number }

export type AbilitySoundFrame = AttackSoundFrame & {
  // The clock the frame's `casts` were measured against, in milliseconds.
  now: number
}

// How recent a cast seen from its cooldown starting has to be to be heard: an older one was seen late (it came into sight after).
const FRESH_CAST_MS = 400
// A cast is remembered as heard for this long, so it is heard once.
const HEARD_MS = 3000
// An entity gone before this far through its life was cut short by striking someone.
const STRUCK_BEFORE = 0.9
// At most this many hits of one entity are heard in a frame (a bolt through a crowd).
const MOST_HITS = 3

// Works out, frame by frame, which abilities went off and what they left did something, as sounds to play:
//   - an ability with a windup is heard as the windup ends far enough through (sooner, it was cancelled);
//   - one with none (a dash, a buff) is heard as its cooldown starts, which the frame's `casts` say;
//   - going back is heard as it begins and as the champion is taken home;
//   - what an ability leaves (`ENTITY_SOUNDS`) is heard as it appears, when that is later than the ability (a grenade bursting, a
//     geyser erupting), and as it strikes someone (its list of who it hit grows, or it is gone before its time).
// As with attacks, only what the player's team sees is heard.
export class AbilitySoundDirector {
  private readonly windups = new Map<number, { abilityId: string; progress: number }>()
  private readonly heard = new Map<string, number>()
  private readonly backing = new Map<number, number>()
  private readonly entities = new Map<string, { defId: string; hits: number; at: Vector2; progress: number; seen: boolean; own: boolean; struck: boolean }>()
  private primed = false

  update(frame: AbilitySoundFrame): SoundCue[] {
    const cues: SoundCue[] = []
    const seen = new Set(frame.characters.map((character) => character.id))
    const play = (recipe: Recipe | undefined, at: Vector2, own: boolean): void => {
      if (recipe && this.primed) cues.push({ recipe, at, own })
    }

    for (const character of frame.characters) {
      const own = character.id === frame.localCharacterId
      // Windups.
      const action = character.action
      const before = this.windups.get(character.id)
      if (action?.kind === 'cast' && action.abilityId !== undefined && !character.dead) {
        if (before && before.abilityId !== action.abilityId && before.progress >= LAUNCHED_PROGRESS) play(ABILITY_SOUNDS[before.abilityId], character.position, own)
        this.windups.set(character.id, { abilityId: action.abilityId, progress: action.progress })
      } else {
        this.windups.delete(character.id)
        if (before && !character.dead && before.progress >= LAUNCHED_PROGRESS) play(ABILITY_SOUNDS[before.abilityId], character.position, own)
      }
      // Casts with no windup, seen from their cooldowns.
      for (const cast of character.casts ?? []) {
        if ((getAbilityDef(cast.abilityId)?.windUpTicks ?? 0) > 0) continue
        const key = `${character.id}:${cast.abilityId}@${Math.round(frame.now - cast.ageMs)}`
        if (this.heard.has(key)) continue
        this.heard.set(key, frame.now)
        if (cast.ageMs <= FRESH_CAST_MS) play(ABILITY_SOUNDS[cast.abilityId], character.position, own)
      }
      // Going back.
      const backing = this.backing.get(character.id)
      if (character.backing !== undefined && !character.dead) {
        if (backing === undefined) play(BACK_SOUNDS.start, character.position, own)
        this.backing.set(character.id, character.backing)
      } else if (backing !== undefined) {
        this.backing.delete(character.id)
        if (backing >= STRUCK_BEFORE && !character.dead) play(BACK_SOUNDS.arrive, character.position, own)
      }
    }
    for (const id of this.windups.keys()) if (!seen.has(id)) this.windups.delete(id)
    for (const id of this.backing.keys()) if (!seen.has(id)) this.backing.delete(id)
    for (const [key, at] of this.heard) if (frame.now - at > HEARD_MS) this.heard.delete(key)

    // What abilities leave.
    const present = new Set<string>()
    for (const entity of frame.entities) {
      if (entity.id.startsWith(ATTACK_SOURCE_PREFIX)) continue
      present.add(entity.id)
      // (A primed throw of the Grenadier's sounds as the plain one does.)
      const sounds = ENTITY_SOUNDS[entity.defId] ?? ENTITY_SOUNDS[entity.defId.replace(/-primed$/, '')]
      const visible = frame.visibleEntityIds.has(entity.id)
      const own = entity.ownerId === frame.localCharacterId
      const hits = entity.hitIds.length
      const known = this.entities.get(entity.id)
      if (!known) {
        this.entities.set(entity.id, { defId: entity.defId, hits, at: entity.position, progress: entity.progress, seen: visible, own, struck: hits > 0 })
        if (visible) play(sounds?.spawn, entity.position, own)
        continue
      }
      if (hits > known.hits && visible) {
        for (let index = 0; index < Math.min(MOST_HITS, hits - known.hits); index += 1) play(sounds?.hit, entity.position, own)
        known.struck = true
      }
      Object.assign(known, { hits, at: entity.position, progress: entity.progress, seen: visible })
    }
    for (const [id, entity] of this.entities) {
      if (present.has(id)) continue
      this.entities.delete(id)
      // Gone before its time, having struck no one yet that was heard: it struck someone as it went.
      if (entity.seen && !entity.struck && entity.progress < STRUCK_BEFORE) play((ENTITY_SOUNDS[entity.defId] ?? ENTITY_SOUNDS[entity.defId.replace(/-primed$/, '')])?.hit, entity.at, entity.own)
    }
    this.primed = true
    return cues
  }
}
