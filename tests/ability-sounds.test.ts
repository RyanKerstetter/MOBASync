import assert from 'node:assert/strict'
import test from 'node:test'
import { AbilitySoundDirector, type AbilitySoundFrame } from '../apps/client/src/audio/ability-sound-director.ts'
import { ABILITY_SOUNDS, BACK_SOUNDS, ENTITY_SOUNDS } from '../apps/client/src/audio/ability-sounds.ts'
import { LAUNCHED_PROGRESS } from '../apps/client/src/audio/attack-sounds.ts'
import type { Recipe } from '../apps/client/src/audio/sound-engine.ts'
import type { RenderedCharacter, RenderedEntity } from '../apps/client/src/game-state.ts'
import { champions, getAbilityDef, getEntityDef, monsters, type Vector2 } from '../packages/shared/src/index.ts'
import { fakeAudio } from './fake-audio.ts'

// ---------------------------------------------------------------------------- which sound

test('every ability every champion can cast has a sound, and every sound is for an ability or an entity the game has', () => {
  for (const champion of champions.values()) {
    for (const abilityId of champion.castableAbilities()) assert.ok(ABILITY_SOUNDS[abilityId], `${champion.id}: ${abilityId} has a sound`)
  }
  for (const monster of monsters.values()) {
    for (const rule of monster.ai.abilities) assert.ok(ABILITY_SOUNDS[rule.abilityId], `the ${monster.champion.id}'s ${rule.abilityId} has a sound`)
  }
  for (const id of Object.keys(ABILITY_SOUNDS)) assert.ok(getAbilityDef(id), `"${id}" is an ability of the game`)
  for (const id of Object.keys(ENTITY_SOUNDS)) assert.ok(getEntityDef(id), `"${id}" is an entity of the game`)
})

test('every ability sound builds, and is over soon after', () => {
  const all: Array<[string, Recipe | undefined]> = [
    ...Object.entries(ABILITY_SOUNDS),
    ['back start', BACK_SOUNDS.start],
    ['back arrive', BACK_SOUNDS.arrive],
    ...Object.entries(ENTITY_SOUNDS).flatMap(([id, sounds]) => [[`${id} spawn`, sounds.spawn], [`${id} hit`, sounds.hit]] as Array<[string, Recipe | undefined]>),
  ]
  for (const [name, recipe] of all) {
    if (!recipe) continue
    const audio = fakeAudio()
    recipe(audio.voice)
    assert.ok(audio.stops.length > 0, `${name} makes a sound`)
    assert.ok(Math.max(...audio.stops) <= 1.3, `${name} stops within a second or so`)
  }
})

// ---------------------------------------------------------------------------- when it is heard

function character(id: number, championId: string, extra: Partial<RenderedCharacter> = {}): RenderedCharacter {
  const champion = champions.get(championId)
  assert.ok(champion)
  return { id, champion, position: { x: id * 10, y: 0 }, dead: false, team: 1, ...extra } as unknown as RenderedCharacter
}

function entity(id: string, defId: string, extra: Partial<RenderedEntity> = {}): RenderedEntity {
  return { id: `c:p1:${id}`, defId, ownerId: 1, position: { x: 40, y: 0 } as Vector2, hitIds: [], progress: 0.2, ...extra } as unknown as RenderedEntity
}

let clock = 10_000
function frame(characters: RenderedCharacter[], entities: RenderedEntity[] = [], visible = entities.map((each) => each.id)): AbilitySoundFrame {
  clock += 16
  return { now: clock, characters, entities, visibleEntityIds: new Set(visible), localCharacterId: 1 }
}

const recipes = (director: AbilitySoundDirector, next: AbilitySoundFrame): Recipe[] => director.update(next).map((cue) => cue.recipe)

test('an ability with a windup is heard as it goes off, and not when it is cut short', () => {
  const director = new AbilitySoundDirector()
  director.update(frame([character(1, 'hammer')]))
  director.update(frame([character(1, 'hammer', { action: { kind: 'cast', progress: LAUNCHED_PROGRESS + 0.3, abilityId: 'slam' } })]))
  assert.deepEqual(recipes(director, frame([character(1, 'hammer')])), [ABILITY_SOUNDS.slam])

  director.update(frame([character(1, 'hammer', { action: { kind: 'cast', progress: LAUNCHED_PROGRESS / 3, abilityId: 'slam' } })]))
  assert.deepEqual(recipes(director, frame([character(1, 'hammer')])), [], 'cancelled')
})

test('one with no windup is heard once, as its cooldown starts, and one seen late is not heard', () => {
  const director = new AbilitySoundDirector()
  director.update(frame([character(1, 'archer')]))
  assert.deepEqual(recipes(director, frame([character(1, 'archer', { casts: [{ abilityId: 'leap', ageMs: 10 }] })])), [ABILITY_SOUNDS.leap])
  assert.deepEqual(recipes(director, frame([character(1, 'archer', { casts: [{ abilityId: 'leap', ageMs: 26 }] })])), [], 'once')
  assert.deepEqual(recipes(director, frame([character(2, 'archer', { casts: [{ abilityId: 'focus', ageMs: 1200 }] })])), [], 'seen late')
  // An ability with a windup is heard from its windup, not from its cooldown as well.
  assert.deepEqual(recipes(director, frame([character(1, 'archer', { casts: [{ abilityId: 'snare', ageMs: 10 }] })])), [])
})

test('going back is heard as it begins and as the champion is taken home, and not if it is broken off', () => {
  const director = new AbilitySoundDirector()
  director.update(frame([character(1, 'monk')]))
  assert.deepEqual(recipes(director, frame([character(1, 'monk', { backing: 0.05 })])), [BACK_SOUNDS.start])
  director.update(frame([character(1, 'monk', { backing: 0.97 })]))
  assert.deepEqual(recipes(director, frame([character(1, 'monk')])), [BACK_SOUNDS.arrive])
  director.update(frame([character(1, 'monk', { backing: 0.1 })]))
  director.update(frame([character(1, 'monk', { backing: 0.4 })]))
  assert.deepEqual(recipes(director, frame([character(1, 'monk')])), [], 'walked off halfway')
})

test('what an ability leaves is heard as it comes, and as it strikes, but not what was there already or in the dark', () => {
  const director = new AbilitySoundDirector()
  assert.deepEqual(recipes(director, frame([], [entity('1', 'grenade-burst')])), [], 'there when the game is first heard')
  assert.deepEqual(recipes(director, frame([], [entity('2', 'grenade-burst')])), [ENTITY_SOUNDS['grenade-burst']?.spawn])
  assert.deepEqual(recipes(director, frame([], [entity('3', 'flash-burst')], [])), [], 'in the dark')

  // A bolt through two enemies, and on until it runs out: two hits, and nothing as it ends.
  director.update(frame([], [entity('4', 'bolt')]))
  assert.deepEqual(recipes(director, frame([], [entity('4', 'bolt', { hitIds: [7, 8], progress: 0.5 })])), [ENTITY_SOUNDS.bolt?.hit, ENTITY_SOUNDS.bolt?.hit])
  director.update(frame([], [entity('4', 'bolt', { hitIds: [7, 8], progress: 0.99 })]))
  assert.deepEqual(recipes(director, frame([])), [])

  // A hex gone halfway, having struck its target as it went.
  director.update(frame([], [entity('5', 'hex', { progress: 0.4 })]))
  assert.deepEqual(recipes(director, frame([])), [ENTITY_SOUNDS.hex?.hit])
  // One that flew out its life is not heard striking.
  director.update(frame([], [entity('6', 'hex', { progress: 0.97 })]))
  assert.deepEqual(recipes(director, frame([])), [])
})
