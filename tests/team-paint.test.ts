import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Sprite, Texture, type Container } from 'pixi.js'
import { championSprites, clipFrameSize, STRUCTURE_FLAG, type SpriteSet } from '../apps/client/src/champion-sprites.ts'
import { teamVariant, type LoadedSpriteSet, type SheetPainter } from '../apps/client/src/character-sprite.ts'
import { CharacterLayer } from '../apps/client/src/render/character-layer.ts'
import { parseHex, repaint, teamSwaps, toHex, type PaintKey, type Rgb } from '../apps/client/src/render/team-paint.ts'
import { CORE_TIER, GAME_TEAMS, getTeam, MONSTER_TEAM, turretId } from '../packages/shared/src/index.ts'
import { brawler, defineTurret, economyClient } from './fixtures.ts'
import { decodePng } from './png.ts'

// A tower or a keep has a flag, drawn in two colours the art uses for nothing else, and every pixel of exactly those is repainted in the colour of the team
// the structure is on (see team-paint.ts, and `teamVariant`). The colours in the first tests are the tests' own; the game's own, and its art, are only read.

// The cloth is a rust red at 40 % lightness and its shade is half that lightness at the same saturation, so what a team's shade should be is easy to say.
const KEY: PaintKey = { primary: '#cc3300', shade: '#661a00' }
const lightness = ([red, green, blue]: Rgb): number => (Math.max(red, green, blue) + Math.min(red, green, blue)) / 510
const rgb = (hex: string): Rgb => parseHex(hex) as Rgb
const TEAM_COLOURS = [...GAME_TEAMS, MONSTER_TEAM].map((team) => team.color)

// ---------------------------------------------------------------------------- the colours

test('a colour is read from #rrggbb and written back, and anything else is not a colour', () => {
  assert.deepEqual(parseHex('#4f9cf5'), [0x4f, 0x9c, 0xf5])
  assert.deepEqual(parseHex('#FF0044'), [255, 0, 68], 'in any case')
  assert.deepEqual(parseHex(' #4f9cf5 '), [0x4f, 0x9c, 0xf5], 'with space round it')
  for (const bad of ['', 'red', '#fff', '#12345', '#1234567', '4f9cf5', '#gg0000']) assert.equal(parseHex(bad), undefined, bad)
  assert.equal(toHex([0x4f, 0x9c, 0xf5]), '#4f9cf5')
  assert.equal(toHex([-5, 300, 12.4]), '#00ff0c', 'kept in range, to a whole number')
  for (const colour of TEAM_COLOURS) assert.equal(toHex(rgb(colour)), colour.toLowerCase(), colour)
})

test('a team\'s flag is its own colour for the cloth, and a darker one for the shade, in the proportions the art has them', () => {
  for (const colour of TEAM_COLOURS) {
    const [cloth, shade] = teamSwaps(colour, KEY)
    assert.deepEqual(cloth, { from: rgb(KEY.primary), to: rgb(colour) }, `${colour}: the cloth is the team\'s colour, exactly`)
    assert.deepEqual(shade.from, rgb(KEY.shade))
    const ratio = lightness(rgb(KEY.shade)) / lightness(rgb(KEY.primary))
    assert.ok(Math.abs(lightness(shade.to) - lightness(rgb(colour)) * ratio) < 0.01, `${colour}: the shade is that much of its lightness (${lightness(shade.to)})`)
    assert.ok(lightness(shade.to) < lightness(cloth.to), `${colour}: and so it is darker`)
    for (const part of shade.to) assert.ok(Number.isInteger(part) && part >= 0 && part <= 255, `${colour}: a colour that can be drawn`)
  }
})

test('the flag of the game\'s art is painted for every team in a colour of its own, which is not any of the art\'s own', () => {
  const keyColours = [rgb(STRUCTURE_FLAG.primary), rgb(STRUCTURE_FLAG.shade)].map((colour) => toHex(colour))
  const seen = new Set<string>()
  for (const colour of TEAM_COLOURS) {
    const [cloth, shade] = teamSwaps(colour, STRUCTURE_FLAG)
    assert.equal(toHex(cloth.to), colour.toLowerCase())
    assert.ok(lightness(shade.to) < lightness(cloth.to), `${colour}: its shade is darker`)
    assert.notEqual(toHex(shade.to), toHex(cloth.to), `${colour}: and not the same`)
    for (const painted of [cloth.to, shade.to]) assert.equal(keyColours.includes(toHex(painted)), false, `${colour}: not a colour that is itself repainted`)
    seen.add(toHex(cloth.to))
  }
  assert.equal(seen.size, new Set(TEAM_COLOURS.map((colour) => colour.toLowerCase())).size, 'every team is told apart by its flag')
})

test('a team colour that is black, white or grey still gives a flag, and one that is not a colour gives none', () => {
  for (const colour of ['#000000', '#ffffff', '#808080']) {
    const [cloth, shade] = teamSwaps(colour, KEY)
    assert.equal(toHex(cloth.to), colour)
    for (const part of shade.to) assert.ok(Number.isInteger(part) && part >= 0 && part <= 255, `${colour}: ${shade.to}`)
    assert.ok(lightness(shade.to) <= lightness(cloth.to), `${colour}: no lighter than the cloth`)
  }
  assert.deepEqual(teamSwaps('blue', KEY), [], 'a name is not a colour')
  assert.deepEqual(teamSwaps('#4f9cf5', { primary: 'nope', shade: KEY.shade }), [], 'nor is a bad key')
})

// ---------------------------------------------------------------------------- the pixels

const pixel = (red: number, green: number, blue: number, alpha = 255): number[] => [red, green, blue, alpha]

test('only pixels of exactly the key colours are repainted, with their alpha kept, and nothing else is touched', () => {
  const swaps = teamSwaps('#4f9cf5', KEY)
  const cloth = [...rgb(KEY.primary)]
  const shade = [...rgb(KEY.shade)]
  const pixels = new Uint8Array([
    ...pixel(cloth[0], cloth[1], cloth[2]),
    ...pixel(shade[0], shade[1], shade[2]),
    ...pixel(cloth[0] + 1, cloth[1], cloth[2]),
    ...pixel(10, 20, 30),
    ...pixel(cloth[0], cloth[1], cloth[2], 0),
    ...pixel(cloth[0], cloth[1], cloth[2], 128),
  ])
  const before = [...pixels]
  assert.equal(repaint(pixels, swaps), 3, 'the cloth, the shade, and the half-there cloth')
  const after = [...pixels]
  assert.deepEqual(after.slice(0, 4), [...swaps[0].to, 255], 'the cloth is the team colour')
  assert.deepEqual(after.slice(4, 8), [...swaps[1].to, 255], 'the shade is its shade')
  assert.deepEqual(after.slice(8, 20), before.slice(8, 20), 'a colour one off, and any other, are as they were')
  assert.deepEqual(after.slice(16, 20), before.slice(16, 20), 'and so is one that is not there at all')
  assert.deepEqual(after.slice(20, 24), [...swaps[0].to, 128], 'one that is half there keeps being half there')
})

test('a colour that a swap paints is not painted again by another: each pixel is looked at once, as it was', () => {
  // The team\'s colour is the very colour the shade is looked for in.
  const swaps = teamSwaps(KEY.shade, KEY)
  const pixels = new Uint8Array([...pixel(...rgb(KEY.primary)), ...pixel(...rgb(KEY.shade))])
  repaint(pixels, swaps)
  assert.deepEqual([...pixels.slice(0, 4)], [...swaps[0].to, 255], 'the cloth became the team colour, and stayed')
  assert.deepEqual([...pixels.slice(4, 8)], [...swaps[1].to, 255])
  assert.equal(repaint(new Uint8Array([1, 2, 3, 255]), []), 0, 'with nothing to swap, nothing is')
})

// ---------------------------------------------------------------------------- the art

const sheetsWithAFlag = Object.entries(championSprites).filter(([, set]) => set.teamPaint !== undefined)

test('the tower and the keep are the sets with a flag to paint, and they say the colours of the flag in the art', () => {
  assert.ok(sheetsWithAFlag.length >= 2, 'turrets and the core')
  const ids = sheetsWithAFlag.map(([id]) => id)
  assert.ok(ids.includes(turretId(1)) && ids.includes(turretId(CORE_TIER)))
  for (const [id, set] of sheetsWithAFlag) assert.deepEqual(set.teamPaint, STRUCTURE_FLAG, id)
  for (const [id, set] of Object.entries(championSprites)) if (!set.teamPaint) assert.ok(!id.startsWith('turret-'), `${id} is a structure with nothing to paint`)
})

// The pixels of a sheet by frame, as the sets cut it.
function frames(set: SpriteSet, clipKey: string): Uint8Array[] {
  const clip = set.clips[clipKey as keyof SpriteSet['clips']]
  assert.ok(clip)
  const image = decodePng(readFileSync(fileURLToPath(clip.url)))
  const { width, height } = clipFrameSize(set, clip)
  assert.equal(image.width, width * clip.frames, `${clipKey}: the sheet is as wide as its frames`)
  assert.equal(image.height, height)
  return Array.from({ length: clip.frames }, (_, index) => {
    const out = new Uint8Array(width * height * 4)
    for (let row = 0; row < height; row += 1) out.set(image.data.subarray((row * image.width + index * width) * 4, (row * image.width + (index + 1) * width) * 4), row * width * 4)
    return out
  })
}
const countOf = (pixels: Uint8Array, colour: Rgb): number => {
  let found = 0
  for (let at = 0; at < pixels.length; at += 4) if (pixels[at + 3] !== 0 && pixels[at] === colour[0] && pixels[at + 1] === colour[1] && pixels[at + 2] === colour[2]) found += 1
  return found
}

test('the real art has both flag colours in it, as whole pixels, from the first frame of every clip', () => {
  for (const [id, set] of sheetsWithAFlag) {
    const key = set.teamPaint as PaintKey
    for (const clipKey of Object.keys(set.clips)) {
      const [firstFrame, ...rest] = frames(set, clipKey)
      assert.ok(countOf(firstFrame, rgb(key.primary)) > 0, `${id} ${clipKey}: cloth in the first frame`)
      assert.ok(countOf(firstFrame, rgb(key.shade)) > 0, `${id} ${clipKey}: shade in the first frame`)
      for (const frame of [firstFrame, ...rest]) {
        for (let at = 3; at < frame.length; at += 4) assert.ok(frame[at] === 0 || frame[at] === 255, `${id} ${clipKey}: a pixel is there or it is not (alpha ${frame[at]})`)
      }
    }
  }
})

test('repainting the real art changes the flag pixels and nothing else, for every team, and no flag colour is left', () => {
  for (const [id, set] of sheetsWithAFlag) {
    const key = set.teamPaint as PaintKey
    for (const clipKey of Object.keys(set.clips)) {
      for (const colour of TEAM_COLOURS) {
        const swaps = teamSwaps(colour, key)
        for (const frame of frames(set, clipKey)) {
          const flag = countOf(frame, rgb(key.primary)) + countOf(frame, rgb(key.shade))
          const painted = frame.slice()
          assert.equal(repaint(painted, swaps), flag, `${id} ${clipKey} ${colour}: each flag pixel was repainted once`)
          let changed = 0
          for (let at = 0; at < frame.length; at += 4) if (painted[at] !== frame[at] || painted[at + 1] !== frame[at + 1] || painted[at + 2] !== frame[at + 2] || painted[at + 3] !== frame[at + 3]) changed += 1
          assert.equal(changed, flag, `${id} ${clipKey} ${colour}: and nothing else changed`)
          assert.equal(countOf(painted, rgb(key.primary)) + countOf(painted, rgb(key.shade)), 0, `${id} ${clipKey} ${colour}: none of the old flag is left`)
        }
      }
    }
  }
})

// ---------------------------------------------------------------------------- the sets

// A set as the loader makes it, with a blank texture in place of each sheet and of each frame, so which is which can be told.
function loadedWithSheets(set: SpriteSet): LoadedSpriteSet {
  const made: LoadedSpriteSet = { set, frames: {}, sheets: {} }
  for (const [key, clip] of Object.entries(set.clips) as Array<[keyof SpriteSet['clips'], NonNullable<SpriteSet['clips'][keyof SpriteSet['clips']]>]>) {
    made.sheets![key] = new Texture()
    made.frames[key] = [Array.from({ length: clip.frames }, () => new Texture())]
  }
  return made
}
type Painted = { sheet: Texture; swaps: ReadonlyArray<{ from: Rgb; to: Rgb }>; made: Texture }
function recordingPainter(): { paint: SheetPainter; calls: Painted[] } {
  const calls: Painted[] = []
  return { calls, paint: (sheet, swaps) => { const made = new Texture(); calls.push({ sheet, swaps, made }); return made } }
}
const tower = championSprites[turretId(1)]
const BLUE = getTeam(2).color
const RED = getTeam(1).color

test('a set with nothing to paint, or no sheets to paint it in, is given back as it is, and nothing is painted', () => {
  const { paint, calls } = recordingPainter()
  const champion = loadedWithSheets(championSprites.swordsman)
  assert.equal(teamVariant(champion, BLUE, paint), champion, 'a champion has no flag')
  const withoutSheets: LoadedSpriteSet = { ...loadedWithSheets(tower) }
  delete withoutSheets.sheets
  assert.equal(teamVariant(withoutSheets, BLUE, paint), withoutSheets, 'and a set with no sheets has nothing to paint')
  assert.equal(calls.length, 0)
})

test('a set is painted once for each colour, each clip in it, from the swaps the colour gives, and its frames are cut from what was painted', () => {
  const { paint, calls } = recordingPainter()
  const base = loadedWithSheets(tower)
  const variant = teamVariant(base, BLUE, paint)
  assert.notEqual(variant, base)
  assert.equal(variant.set, base.set, 'the same art, in the same places')
  const clips = Object.keys(tower.clips)
  assert.equal(calls.length, clips.length, 'one sheet painted for each clip')
  for (const clipKey of clips as Array<keyof SpriteSet['clips']>) {
    const call = calls.find((each) => each.sheet === base.sheets?.[clipKey])
    assert.ok(call, `${clipKey} was painted from its own sheet`)
    assert.deepEqual(call.swaps, teamSwaps(BLUE, STRUCTURE_FLAG), 'with the swaps for the colour')
    assert.equal(variant.sheets?.[clipKey], call.made)
    assert.deepEqual(variant.frames[clipKey]?.map((row) => row.length), base.frames[clipKey]?.map((row) => row.length), `${clipKey}: as many frames, in as many rows`)
    assert.ok(variant.frames[clipKey]?.every((row) => row.every((frame) => frame.source === call.made.source)), `${clipKey}: each cut from the painted sheet`)
    assert.ok(base.frames[clipKey]?.every((row) => row.every((frame) => frame.source !== call.made.source)), `${clipKey}: and the first set is as it was`)
  }
})

test('the same colour is the same set every time, whatever the case or the space round it, and another colour is another', () => {
  const { paint, calls } = recordingPainter()
  const base = loadedWithSheets(tower)
  const blue = teamVariant(base, BLUE, paint)
  const made = calls.length
  assert.equal(teamVariant(base, BLUE, paint), blue)
  assert.equal(teamVariant(base, ` ${BLUE.toUpperCase()} `, paint), blue, 'a colour is a colour in any case')
  assert.equal(calls.length, made, 'and nothing was painted again')
  const red = teamVariant(base, RED, paint)
  assert.notEqual(red, blue)
  assert.notEqual(red.frames.idle?.[0][0], blue.frames.idle?.[0][0], 'with frames of its own')
  assert.equal(calls.length, 2 * made)
  assert.equal(teamVariant(base, RED, paint), red)
  // Another loaded set (a new folder of art) has variants of its own.
  const other = loadedWithSheets(tower)
  assert.notEqual(teamVariant(other, BLUE, paint), blue)
  // And every team has its own.
  const all = new Set(GAME_TEAMS.map((team) => teamVariant(base, team.color, paint)))
  assert.equal(all.size, new Set(GAME_TEAMS.map((team) => team.color)).size)
})

test('a sheet that cannot be painted, or a colour that is not one, leaves the set as it was, once, and does not stop anything', () => {
  const warn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    let tries = 0
    const base = loadedWithSheets(tower)
    const broken: SheetPainter = () => { tries += 1; throw new Error('no canvas') }
    assert.equal(teamVariant(base, BLUE, broken), base, 'the flag stays as it was drawn')
    assert.equal(teamVariant(base, BLUE, broken), base)
    assert.equal(tries, 1, 'it did not try again')
    assert.equal(warnings.length, 1, 'and said so once')
    const { paint, calls } = recordingPainter()
    const named = loadedWithSheets(tower)
    assert.equal(teamVariant(named, 'blue', paint), named, 'a name is not a colour')
    assert.equal(calls.length, 0)
  } finally {
    console.warn = warn
  }
})

// ---------------------------------------------------------------------------- on the page

test('towers and keeps are drawn from the set painted for their own team, and champions are drawn as they were', () => {
  const post = defineTurret(79, { base: { maxHp: 2000, attackDamage: 50, attackSpeed: 1 }, radius: 30, attackRange: 400, attackWindup: 0 })
  const state = economyClient()
  state.simulator.addPlayer(1, 'p1', 'Ann', { x: 200, y: 200 }, brawler, 1)
  state.simulator.addTurret(10, post, { x: 1000, y: 700 }, 1)
  state.simulator.addTurret(11, post, { x: 1400, y: 700 }, 2)
  state.simulator.addTurret(12, post, { x: 1800, y: 700 }, 2)
  state.setLocalCharacterId(1)
  state.simulator.advanceTo(3)
  const everyone = state.getCharacters(0)
  const base = loadedWithSheets(tower)
  const { paint, calls } = recordingPainter()
  const layer = new CharacterLayer(new Map([[post.champion.id, base]]), undefined, paint)
  layer.update(everyone, 1, undefined, 0)
  const textureOf = (index: number): Texture | undefined => (layer.view.children[index] as Container).children.find((child) => child instanceof Sprite && child.texture !== Texture.EMPTY)?.texture as Texture | undefined
  const [ann, red, blue, alsoBlue] = [0, 1, 2, 3].map(textureOf)
  assert.equal(ann, undefined, 'a champion with no set is not drawn from one')
  // The painter keeps what it made, and the layer asked for the same, so the variants are found by asking again.
  const redSet = teamVariant(base, RED, paint)
  const blueSet = teamVariant(base, BLUE, paint)
  assert.ok(redSet.frames.idle?.[0].includes(red as Texture), 'the first team\'s tower is drawn from the set painted in its colour')
  assert.ok(blueSet.frames.idle?.[0].includes(blue as Texture), 'the second team\'s from the set painted in its')
  assert.ok(blueSet.frames.idle?.[0].includes(alsoBlue as Texture), 'and a second tower of that team is drawn from the same set, not another')
  assert.equal(calls.length, 2 * Object.keys(tower.clips).length, 'each team\'s set was made once, however many towers it has')
  assert.notEqual(redSet, blueSet)
})
