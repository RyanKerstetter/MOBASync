import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AttackSoundDirector,
  attackSoundOf,
  HEARING_RANGE,
  LAUNCHED_PROGRESS,
  MONSTER_SOUNDS,
  placeSound,
  TURRET_SOUND,
  WEAPON_SOUNDS,
  type AttackCue,
  type AttackSoundFrame,
} from '../apps/client/src/audio/attack-sounds.ts'
import type { Recipe } from '../apps/client/src/audio/sound-engine.ts'
import { fakeAudio } from './fake-audio.ts'
import { DEFAULT_SETTINGS, MAX_SOUND_VOLUME, readSoundVolume } from '../apps/client/src/game-settings.ts'
import { menuTabs, type MenuItem } from '../apps/client/src/game-menu.ts'
import type { RenderedCharacter, RenderedEntity } from '../apps/client/src/game-state.ts'
import { championLook } from '../apps/client/src/render3d/models/looks.ts'
import { ATTACK_SOURCE_PREFIX, champions, monsters, type Champion, type Vector2 } from '../packages/shared/src/index.ts'

const championOf = (id: string): Champion => {
  const champion = champions.get(id) ?? monsters.get(id)?.champion
  assert.ok(champion, id)
  return champion
}

// A character as the director reads one: only what it looks at is filled in.
function character(id: number, championId: string, extra: Partial<RenderedCharacter> = {}): RenderedCharacter {
  return { id, champion: championOf(championId), position: { x: id * 10, y: 0 }, dead: false, team: 1, ...extra } as unknown as RenderedCharacter
}

function shot(id: string, ownerId: number, position: Vector2 = { x: 50, y: 0 }): RenderedEntity {
  return { id: `${ATTACK_SOURCE_PREFIX}${id}`, ownerId, position } as unknown as RenderedEntity
}

function frame(characters: RenderedCharacter[], entities: RenderedEntity[] = [], visible = entities.map((entity) => entity.id), extra: Partial<AttackSoundFrame> = {}): AttackSoundFrame {
  return { characters, entities, visibleEntityIds: new Set(visible), localCharacterId: 1, ...extra }
}

const parts = (cues: AttackCue[]): string[] => cues.map((cue) => cue.part)

// ---------------------------------------------------------------------------- which sound

test('every champion sounds like what it fights with, and the monsters and turrets have their own', () => {
  for (const champion of champions.values()) {
    const sound = attackSoundOf({ champion })
    assert.equal(sound, WEAPON_SOUNDS[championLook(champion).weapon], champion.id)
  }
  for (const id of monsters.keys()) {
    assert.ok(MONSTER_SOUNDS[id], `the ${id} has a sound of its own`)
    assert.equal(attackSoundOf({ champion: championOf(id), monster: {} }), MONSTER_SOUNDS[id])
  }
  assert.equal(attackSoundOf({ champion: championOf('archer'), turret: {} }), TURRET_SOUND)
})

test('every attack sound builds, and is over within a second', () => {
  const all: Array<[string, Recipe]> = [
    ...Object.entries(WEAPON_SOUNDS).flatMap(([weapon, sound]) => [[`${weapon} launch`, sound.launch], [`${weapon} impact`, sound.impact]] as Array<[string, Recipe]>),
    ...Object.entries(MONSTER_SOUNDS).flatMap(([monster, sound]) => [[`${monster} launch`, sound.launch], [`${monster} impact`, sound.impact]] as Array<[string, Recipe]>),
    ['turret launch', TURRET_SOUND.launch],
    ['turret impact', TURRET_SOUND.impact],
  ]
  for (const [name, recipe] of all) {
    const audio = fakeAudio()
    recipe(audio.voice)
    assert.ok(audio.stops.length > 0, `${name} makes a sound`)
    assert.ok(Math.max(...audio.stops) <= 1, `${name} stops within a second`)
  }
})

// ---------------------------------------------------------------------------- when it is heard

test('a melee attack is heard, swing and blow, when its windup ends past the point of going off', () => {
  const director = new AttackSoundDirector()
  const target = character(2, 'hammer')
  director.update(frame([character(1, 'swordsman', { action: { kind: 'attack', progress: LAUNCHED_PROGRESS + 0.2, targetId: 2 } }), target]))
  const cues = director.update(frame([character(1, 'swordsman'), target]))
  assert.deepEqual(parts(cues), ['launch', 'impact'])
  assert.equal(cues[0]?.sound, WEAPON_SOUNDS.longsword)
  assert.deepEqual(cues[1]?.at, target.position, 'the blow is heard on whoever it struck')
  assert.equal(cues[0]?.own, true)
})

test('a melee windup cut short early is not heard, and nor is one out of sight', () => {
  const early = new AttackSoundDirector()
  early.update(frame([character(1, 'swordsman', { action: { kind: 'attack', progress: LAUNCHED_PROGRESS / 2, targetId: 2 } })]))
  assert.deepEqual(early.update(frame([character(1, 'swordsman')])), [])

  const hidden = new AttackSoundDirector()
  hidden.update(frame([character(1, 'swordsman', { action: { kind: 'attack', progress: 0.9 } })]))
  assert.deepEqual(hidden.update(frame([], [], [], { unseen: [character(1, 'swordsman')] })), [], 'it went into the dark mid-swing')
})

test('a shot is heard as it leaves and as it strikes, from its own weapon', () => {
  const director = new AttackSoundDirector()
  const archer = character(1, 'archer')
  director.update(frame([archer]))
  const fired = director.update(frame([archer], [shot('p1:1', 1)]))
  assert.deepEqual(parts(fired), ['launch'])
  assert.equal(fired[0]?.sound, WEAPON_SOUNDS.bow)
  assert.deepEqual(director.update(frame([archer], [shot('p1:1', 1, { x: 90, y: 0 })])), [], 'nothing while it flies')
  const struck = director.update(frame([archer]))
  assert.deepEqual(parts(struck), ['impact'])
  assert.deepEqual(struck[0]?.at, { x: 90, y: 0 }, 'where it was last seen')
  // A ranged champion's windup ending is its shot's business, not a swing.
  director.update(frame([character(1, 'archer', { action: { kind: 'attack', progress: 0.9 } })]))
  assert.deepEqual(director.update(frame([archer])), [])
})

test('shots already flying when the game is first heard, unseen ones, and abilities are not heard', () => {
  const director = new AttackSoundDirector()
  assert.deepEqual(director.update(frame([character(1, 'archer')], [shot('p1:1', 1)])), [], 'already in the air')

  const dark = new AttackSoundDirector()
  dark.update(frame([]))
  assert.deepEqual(dark.update(frame([], [shot('p2:1', 2)], [], { unseen: [character(2, 'soldier')] })), [], 'fired in the dark')
  assert.deepEqual(dark.update(frame([])), [], 'struck in the dark')

  const ability = new AttackSoundDirector()
  ability.update(frame([]))
  const bolt = { id: 'c:p1:4:bolt', ownerId: 1, position: { x: 0, y: 0 } } as unknown as RenderedEntity
  assert.deepEqual(ability.update(frame([character(1, 'soldier')], [bolt])), [])
})

test('a turret\'s shot sounds like a turret\'s', () => {
  const director = new AttackSoundDirector()
  const turret = character(9, 'archer', { turret: {} as RenderedCharacter['turret'] })
  director.update(frame([turret]))
  const [cue] = director.update(frame([turret], [shot('t9:1', 9)]))
  assert.equal(cue?.sound, TURRET_SOUND)
  assert.equal(cue?.own, false)
})

// ---------------------------------------------------------------------------- how it is heard

test('a sound is full near the player, fades with distance to nothing, and comes from its side', () => {
  const here = { x: 1000, y: 1000 }
  assert.equal(placeSound(here, here, true).gain, 1)
  assert.ok(placeSound(here, here, false).gain < 1, 'someone else\'s a little quieter than your own')
  const near = placeSound({ x: 1600, y: 1000 }, here, false).gain
  const far = placeSound({ x: 2000, y: 1000 }, here, false).gain
  assert.ok(near > far && far > 0)
  assert.equal(placeSound({ x: 1000 + HEARING_RANGE, y: 1000 }, here, false).gain, 0)
  assert.ok(placeSound({ x: 1400, y: 1000 }, here, false).pan > 0, 'to the right')
  assert.ok(placeSound({ x: 600, y: 1000 }, here, false).pan < 0, 'to the left')
})

test('the volume is kept as a setting, and the Sound tab of the menu sets it', () => {
  assert.ok(DEFAULT_SETTINGS.soundVolume > 0 && DEFAULT_SETTINGS.soundVolume <= MAX_SOUND_VOLUME, 'on, to begin with')
  assert.equal(readSoundVolume('loud'), DEFAULT_SETTINGS.soundVolume)
  assert.equal(readSoundVolume(-5), 0)
  assert.equal(readSoundVolume(MAX_SOUND_VOLUME * 2), MAX_SOUND_VOLUME)

  const noop = (): void => undefined
  let volume = DEFAULT_SETTINGS.soundVolume
  const base = {
    getCastMode: () => 'quick' as const,
    setCastMode: noop,
    getClickRadius: () => 0,
    setClickRadius: noop,
    getWalkKeepsAuto: () => false,
    setWalkKeepsAuto: noop,
    getWalkKeepsCast: () => false,
    setWalkKeepsCast: noop,
    getMovementKeys: () => false,
    setMovementKeys: noop,
    getCastKeepsAttack: () => false,
    setCastKeepsAttack: noop,
    getAttackMarkerSize: () => 100,
    setAttackMarkerSize: noop,
    getEffect: () => false,
    setEffect: noop,
    getMaxFps: () => 0,
    setMaxFps: noop,
    getDebugView: () => false,
    setDebugView: noop,
    getDiagnostics: () => false,
    setDiagnostics: noop,
  }
  assert.equal(menuTabs(base).find((tab) => tab.id === 'sound'), undefined, 'no Sound tab where the page cannot make sound')
  const tabs = menuTabs({ ...base, getSoundVolume: () => volume, setSoundVolume: (value) => { volume = value } })
  const slider = tabs.find((tab) => tab.id === 'sound')?.sections.flatMap((section) => section.items).find((item) => item.label === 'Volume') as Extract<MenuItem, { kind: 'slider' }> | undefined
  assert.ok(slider, 'a Volume slider')
  assert.equal(slider.min, 0)
  assert.equal(slider.max, MAX_SOUND_VOLUME)
  slider.set(0)
  assert.equal(volume, 0)
})
