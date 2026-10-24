import { Container, Graphics, Text } from 'pixi.js'
import { getTeam } from '../../../../packages/shared/src/index.ts'
import { CharacterSprite, type LoadedSpriteSet } from '../character-sprite.ts'
import type { RenderedCharacter } from '../game-state.ts'
import { layoutHealthBar } from './health-bar.ts'
import { layoutStackPips } from './stack-pips.ts'
import { statusLabels } from './status-labels.ts'

type Actor = {
  node: Container
  // Drawn from sprite sheets, for a champion that has a sprite set; otherwise its body is a circle.
  sprite?: CharacterSprite
  statusText: Text
  stackPips: Graphics
  label: Text
  healthBar: Graphics
  cooldownBar: Graphics
}

// The health bar over each champion, in world units. A tick marks every HEALTH_TICK_EVERY health,
// and a bigger one every HEALTH_MAJOR_TICK_EVERY.
const HEALTH_BAR_WIDTH = 84
const HEALTH_BAR_HEIGHT = 9
const HEALTH_TICK_EVERY = 100
const HEALTH_MAJOR_TICK_EVERY = 1000

// Every champion: its body (a sprite, or a circle in its team's colour), its name, its health bar,
// what is affecting it, and its stacks. One is added when a champion first appears and taken away
// when it leaves the game.
export class CharacterLayer {
  readonly view = new Container()
  private readonly actors = new Map<number, Actor>()

  constructor(private spriteSets: ReadonlyMap<string, LoadedSpriteSet>) {}

  // Draws every champion from these sets from now on. The champions already drawn are dropped, so
  // the next update draws them again from the new ones.
  setSpriteSets(sets: ReadonlyMap<string, LoadedSpriteSet>): void {
    this.spriteSets = sets
    for (const actor of this.actors.values()) actor.node.destroy({ children: true })
    this.actors.clear()
  }

  // `localAttackCooldown` is how far the controlled champion's attack cooldown has run, from 0 to
  // 1, shown as a bar under its health.
  update(
    characters: readonly RenderedCharacter[],
    localCharacterId: number | undefined,
    localAttackCooldown: number | undefined,
    now: number,
  ): void {
    const activeIds = new Set(characters.map((character) => character.id))
    for (const [id, actor] of this.actors) {
      if (!activeIds.has(id)) {
        actor.node.destroy({ children: true })
        this.actors.delete(id)
      }
    }
    for (const character of characters) {
      const isLocal = character.id === localCharacterId
      const actor = this.actors.get(character.id) ?? this.addActor(character, isLocal)
      actor.label.text = character.name ?? character.player?.name ?? ''
      const radius = character.champion.radius
      actor.node.position.set(character.position.x, character.position.y)
      // A death leaves no bars until the respawn: a faint ghost for a circle, and for a sprite its
      // death animation at full strength, ending lying down.
      actor.node.alpha = character.dead && !actor.sprite ? 0.25 : 1
      actor.healthBar.visible = !character.dead
      actor.label.position.set(0, -radius - 25)
      drawHealthBar(actor.healthBar, -radius - 20, {
        hp: character.health?.hp ?? 0,
        maxHp: character.health?.maxHp ?? 0,
        shield: character.totalShield,
      })
      actor.statusText.text = statusLabels(character).join(' · ')
      actor.statusText.position.set(0, -radius - 43)
      drawStackPips(actor.stackPips, radius, character.dead ? {} : character.stacks)
      actor.sprite?.update({
        position: character.position,
        dead: character.dead,
        ...(character.action ? { action: character.action } : {}),
        now,
      })
      actor.cooldownBar.visible = isLocal && !character.dead && localAttackCooldown !== undefined
      if (actor.cooldownBar.visible) drawBar(actor.cooldownBar, -radius - 8, localAttackCooldown ?? 1, '#f2b66d', 3)
    }
  }

  private addActor(character: RenderedCharacter, isLocal: boolean): Actor {
    const node = new Container()
    // Filled with the colour of its team. The champion you control has a thick white outline,
    // since its colour is no longer different from every other player's. A champion drawn from
    // sprites has no circle: it is the figure alone, and its team shows in the colour of its name.
    const loaded = this.spriteSets.get(character.champion.id)
    const shape = new Graphics()
    if (!loaded) {
      shape
        .circle(0, 0, character.champion.radius)
        .fill({ color: getTeam(character.team).color })
        .stroke(isLocal ? { color: '#ffffff', width: 4 } : { color: '#0b1220', width: 2, alpha: 0.7 })
    }
    const sprite = loaded ? new CharacterSprite(loaded) : undefined
    const label = new Text({
      text: character.name ?? character.player?.name ?? '',
      // In the colour of its team, with a dark edge so any colour reads against the map.
      style: {
        fill: getTeam(character.team).color,
        fontSize: 16,
        fontFamily: 'Arial',
        stroke: { color: '#0b1220', width: 3 },
      },
    })
    label.anchor.set(0.5, 1)
    const healthBar = new Graphics()
    const cooldownBar = new Graphics()
    // What is affecting the champion, as small words above its name.
    const statusText = new Text({
      text: '',
      style: {
        fill: '#e8f4ff',
        fontSize: 11,
        fontFamily: 'Arial',
        stroke: { color: '#0b1220', width: 3 },
      },
    })
    statusText.anchor.set(0.5, 1)
    const stackPips = new Graphics()
    node.addChild(shape, ...(sprite ? [sprite.view] : []), stackPips, label, statusText, healthBar, cooldownBar)
    this.view.addChild(node)
    const actor = { node, ...(sprite ? { sprite } : {}), statusText, stackPips, label, healthBar, cooldownBar }
    this.actors.set(character.id, actor)
    return actor
  }
}

// One pip per stack under the body. `layoutStackPips` decides where each goes and what it looks
// like: round pips for the champion's own stacks, diamonds for marks others put on it.
function drawStackPips(graphics: Graphics, radius: number, stacks: Record<string, number>): void {
  graphics.clear()
  for (const pip of layoutStackPips(stacks, radius)) {
    if (pip.shape === 'circle') graphics.circle(pip.x, pip.y, 3.5)
    else graphics.poly([pip.x, pip.y - 4.5, pip.x + 4.5, pip.y, pip.x, pip.y + 4.5, pip.x - 4.5, pip.y])
    graphics.fill({ color: pip.color }).stroke({ color: '#1c1c28', width: 1 })
  }
}

function drawBar(graphics: Graphics, y: number, fraction: number, fillColor: string, height = 4): void {
  const width = HEALTH_BAR_WIDTH
  graphics.clear()
    .roundRect(-width / 2, y, width, height, 2)
    .fill({ color: '#101827' })
    .roundRect(-width / 2, y, width * Math.max(0, Math.min(1, fraction)), height, 2)
    .fill({ color: fillColor })
}

// Health from the left, the shield on the end of it, and ticks across the bar to read it by.
function drawHealthBar(graphics: Graphics, y: number, health: { hp: number; maxHp: number; shield: number }): void {
  const layout = layoutHealthBar(health, HEALTH_BAR_WIDTH, {
    every: HEALTH_TICK_EVERY,
    major: HEALTH_MAJOR_TICK_EVERY,
  })
  const left = -HEALTH_BAR_WIDTH / 2
  graphics.clear()
    .rect(left, y, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT)
    .fill({ color: '#0b1220' })
    .rect(left, y, layout.healthWidth, HEALTH_BAR_HEIGHT)
    .fill({ color: '#67d391' })
    .rect(left + layout.healthWidth, y, layout.shieldWidth, HEALTH_BAR_HEIGHT)
    .fill({ color: '#e8f4ff' })
  // A small tick reaches half way up from the bottom; a major one runs the full height.
  for (const tick of layout.ticks) {
    if (!tick.major) graphics.moveTo(left + tick.x, y + HEALTH_BAR_HEIGHT / 2).lineTo(left + tick.x, y + HEALTH_BAR_HEIGHT)
  }
  graphics.stroke({ color: '#0b1220', width: 1, alpha: 0.85 })
  for (const tick of layout.ticks) {
    if (tick.major) graphics.moveTo(left + tick.x, y).lineTo(left + tick.x, y + HEALTH_BAR_HEIGHT)
  }
  graphics
    .stroke({ color: '#0b1220', width: 2 })
    .rect(left, y, HEALTH_BAR_WIDTH, HEALTH_BAR_HEIGHT)
    .stroke({ color: '#0b1220', width: 1.5 })
}
