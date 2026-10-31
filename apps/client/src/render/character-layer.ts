import { Container, Graphics, Text, type RenderLayer } from 'pixi.js'
import { getTeam } from '../../../../packages/shared/src/index.ts'
import { CharacterSprite, teamVariant, type LoadedSpriteSet, type SheetPainter } from '../character-sprite.ts'
import type { RenderedCharacter } from '../game-state.ts'
import { ATTACK_BAR_HEIGHT, attackBarTop, meterBarTop, METER_BAR_HEIGHT } from './bar-layout.ts'
import { layoutCorpse } from './corpse.ts'
import { characterDepth } from './depth.ts'
import { layoutDeaggroBar } from './deaggro-bar.ts'
import { layoutHealthBar } from './health-bar.ts'
import { layoutLevelBadge, LEVEL_BADGE_RADIUS } from './level-badge.ts'
import { layoutStackPips } from './stack-pips.ts'
import { statusLabels } from './status-labels.ts'

type Actor = {
  // Its body: the figure or circle, and its stacks.
  node: Container
  // Its name and bars, which are drawn over every body (see `CharacterLayer.overlay`).
  overlay: Container
  // Drawn from sprite sheets, for a champion that has a sprite set; otherwise its body is a circle.
  sprite?: CharacterSprite
  // The body of a champion, a turret or a core that has no sprite set, drawn as shapes. Empty for one that has: a sprite stands on the ground by itself.
  shape: Graphics
  statusText: Text
  stackPips: Graphics
  // A structure's barrier, drawn round it while it is protected and nothing can hurt it yet.
  barrier?: Graphics
  label: Text
  healthBar: Graphics
  // A player's level, in a round badge at the left end of its health bar. It is only shown for a player in a game that has levels.
  levelBadge: Container
  levelText: Text
  // A monster's deaggro bar, under its health bar, while it has something in it.
  deaggroBar: Graphics
  // A champion's meter (a rage that runs down: see `RenderedCharacter.meter`), under its health bar, while it has something in it.
  meterBar: Graphics
  cooldownBar: Graphics
}

// The health bar over each champion, in world units. A tick marks every HEALTH_TICK_EVERY health,
// and a bigger one every HEALTH_MAJOR_TICK_EVERY.
export const HEALTH_BAR_WIDTH = 84
export const HEALTH_BAR_HEIGHT = 9
const HEALTH_TICK_EVERY = 100
const HEALTH_MAJOR_TICK_EVERY = 1000

// Every champion: its body (a sprite, or a circle in its team's colour) and its stacks, and its name, its
// health bar and what is affecting it. One is added when a champion first appears and taken away when
// it leaves the game.
//
// The bodies are `view`'s children, and are attached to `depth` (see depth.ts), which draws them in
// order of how far down the map they stand, with anything else attached to it: the faces of walls, so a
// champion walks behind one and in front of another. The names and bars are in `overlay` instead, which
// goes over all of that, so one cannot be lost behind a wall. Without a `depth` the bodies are drawn in
// the order they came.
export class CharacterLayer {
  readonly view = new Container()
  readonly overlay = new Container()
  private readonly actors = new Map<number, Actor>()

  // `paint` is how a sheet is painted in a team's colour (see `teamVariant`): the page's own, unless a test gives another.
  constructor(
    private spriteSets: ReadonlyMap<string, LoadedSpriteSet>,
    private readonly depth?: RenderLayer,
    private readonly paint?: SheetPainter,
  ) {}

  // Draws every champion from these sets from now on. The champions already drawn are dropped, so
  // the next update draws them again from the new ones.
  setSpriteSets(sets: ReadonlyMap<string, LoadedSpriteSet>): void {
    this.spriteSets = sets
    for (const actor of this.actors.values()) destroyActor(actor)
    this.actors.clear()
  }

  // `localAttackCooldown` is how far the controlled champion's attack cooldown has run, from 0 to
  // 1, shown as a bar under its health. `unseen` are characters in the game that are not drawn, because the
  // team cannot see them (see `TeamVision`): their bodies are kept and go on being updated, hidden, so they are
  // as they would have been if they had been seen all along: one that died out of sight is lying down when it
  // is seen, and does not die again. (A body that was taken away when it went out of sight would be made again,
  // from its first frame, when it came back.)
  update(
    characters: readonly RenderedCharacter[],
    localCharacterId: number | undefined,
    localAttackCooldown: number | undefined,
    now: number,
    unseen: readonly RenderedCharacter[] = [],
  ): void {
    const everyone = unseen.length > 0 ? [...characters, ...unseen] : characters
    const hidden = new Set(unseen.map((character) => character.id))
    const activeIds = new Set(everyone.map((character) => character.id))
    for (const [id, actor] of this.actors) {
      if (!activeIds.has(id)) {
        destroyActor(actor)
        this.actors.delete(id)
      }
    }
    for (const character of everyone) {
      const isLocal = character.id === localCharacterId
      const actor = this.actors.get(character.id) ?? this.addActor(character, isLocal)
      // A monster or a structure that dies loses its nameplate at once, and its body a couple of seconds later (`layoutCorpse`). A monster is
      // drawn again when it respawns; a structure is destroyed for good, so its sprite plays its collapse where it stood, and that is the last
      // of it. One drawn as shapes has no collapse to play, so it is gone as it falls.
      const structure = character.turret !== undefined
      const corpse = layoutCorpse(character)
      const collapsing = structure && character.dead && actor.sprite !== undefined
      const seen = !hidden.has(character.id)
      actor.node.visible = seen && corpse.body && (!structure || !character.dead || collapsing)
      actor.overlay.visible = seen && corpse.nameplate
      // A structure has no name over it: it is told by its body and (for a turret) its ring.
      actor.label.visible = !structure
      if (actor.barrier) actor.barrier.visible = character.invulnerable === true
      actor.label.text = character.name ?? character.player?.name ?? ''
      const radius = character.champion.radius
      // The name and bars go over the body, or over the figure where it stands higher than that.
      const above = Math.max(radius, actor.sprite?.reach ?? 0)
      actor.node.position.set(character.position.x, character.position.y)
      actor.node.zIndex = characterDepth(character.position)
      actor.overlay.position.set(character.position.x, character.position.y)
      // A death leaves no bars until the respawn: a faint ghost for a circle, and for a sprite its
      // death animation at full strength, ending lying down.
      actor.node.alpha = actor.overlay.alpha = character.dead && !actor.sprite ? 0.25 : 1
      actor.healthBar.visible = !character.dead
      actor.label.position.set(0, -above - 25)
      drawHealthBar(actor.healthBar, -above - 20, {
        hp: character.health?.hp ?? 0,
        maxHp: character.health?.maxHp ?? 0,
        shield: character.totalShield,
      })
      // A player's level sits at the left end of its health bar, and goes with the bar.
      const badge = character.dead ? undefined : layoutLevelBadge(character.level, { width: HEALTH_BAR_WIDTH, top: -above - 20, height: HEALTH_BAR_HEIGHT })
      actor.levelBadge.visible = badge !== undefined
      if (badge) {
        actor.levelBadge.position.set(badge.x, badge.y)
        actor.levelText.text = badge.text
      }
      // A monster that is losing interest has a bar under its health that fills, and is full when it gives up and goes home.
      const losing = character.monster && !character.dead ? layoutDeaggroBar(character.monster.deaggro) : undefined
      actor.deaggroBar.visible = losing !== undefined
      if (losing) drawBar(actor.deaggroBar, meterBarTop(above), losing.fraction, losing.color, METER_BAR_HEIGHT)
      // A meter is under the health bar in the same place (a champion has no deaggro bar, so the two are never both there), and runs down as the status does.
      actor.meterBar.visible = !character.dead && character.meter !== undefined
      if (character.meter) drawBar(actor.meterBar, meterBarTop(above), character.meter.fraction, character.meter.color, METER_BAR_HEIGHT)
      actor.statusText.text = statusLabels(character).join(' · ')
      actor.statusText.position.set(0, -above - 43)
      drawStackPips(actor.stackPips, radius, character.dead ? {} : character.stacks)
      actor.sprite?.update({
        position: character.position,
        dead: character.dead,
        ...(character.action ? { action: character.action } : {}),
        now,
      })
      actor.cooldownBar.visible = isLocal && !character.dead && localAttackCooldown !== undefined
      if (actor.cooldownBar.visible) drawBar(actor.cooldownBar, attackBarTop(radius, above, actor.meterBar.visible), localAttackCooldown ?? 1, '#f2b66d', ATTACK_BAR_HEIGHT)
    }
  }

  private addActor(character: RenderedCharacter, isLocal: boolean): Actor {
    const node = new Container()
    const overlay = new Container()
    // Filled with the colour of its team. The champion you control has a thick white outline,
    // since its colour is no longer different from every other player's. A champion drawn from
    // sprites has no circle: it is the figure alone, and its team shows in the colour of its name.
    // The art of a tower or a keep is the same for every team, with a flag that is painted in the colour of the team this one is on.
    const base = this.spriteSets.get(character.champion.id)
    const loaded = base ? teamVariant(base, getTeam(character.team).color, this.paint) : undefined
    const shape = new Graphics()
    if (!loaded && character.turret?.core) {
      drawCoreBody(shape, character.champion.radius, getTeam(character.team).color)
    } else if (!loaded && character.turret) {
      drawTurretBody(shape, character.champion.radius, getTeam(character.team).color)
    } else if (!loaded) {
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
    // The level: a dark disc edged in the colour of its team, and the number on it. Where it goes is set each frame, from the health bar.
    const levelBadge = new Container()
    levelBadge.visible = false
    const levelText = new Text({
      text: '',
      style: { fill: '#ffffff', fontSize: 12, fontFamily: 'Arial', fontWeight: 'bold' },
    })
    levelText.anchor.set(0.5)
    levelBadge.addChild(
      new Graphics()
        .circle(0, 0, LEVEL_BADGE_RADIUS)
        .fill({ color: '#0b1220', alpha: 0.9 })
        .stroke({ color: getTeam(character.team).color, width: 2 }),
      levelText,
    )
    const deaggroBar = new Graphics()
    deaggroBar.visible = false
    const meterBar = new Graphics()
    meterBar.visible = false
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
    // A structure that cannot be hurt yet has a barrier round it, shown only while that is so.
    const barrier = character.turret ? drawBarrier(character.champion.radius) : undefined
    node.addChild(shape, ...(barrier ? [barrier] : []), ...(sprite ? [sprite.view] : []), stackPips)
    overlay.addChild(label, statusText, healthBar, levelBadge, deaggroBar, meterBar, cooldownBar)
    this.view.addChild(node)
    this.overlay.addChild(overlay)
    // After it is in the scene, which the layer needs for where it is.
    this.depth?.attach(node)
    const actor = { node, overlay, ...(sprite ? { sprite } : {}), shape, ...(barrier ? { barrier } : {}), statusText, stackPips, label, healthBar, levelBadge, levelText, deaggroBar, meterBar, cooldownBar }
    this.actors.set(character.id, actor)
    return actor
  }
}

// A turret: a ring of dark stone with its team's colour round the edge, and a core of that colour on top of it, so which side it is on
// reads from a distance. It is flat, as everything is.
function drawTurretBody(shape: Graphics, radius: number, color: string): void {
  shape
    .circle(0, 0, radius)
    .fill({ color: '#2d3340' })
    .stroke({ color, width: 4 })
    .circle(0, 0, radius * 0.55)
    .fill({ color })
    .stroke({ color: '#0b1220', width: 2, alpha: 0.7 })
    .circle(0, 0, radius * 0.2)
    .fill({ color: '#ffffff', alpha: 0.85 })
}

// A core: a diamond of dark stone edged in its team's colour, with a smaller one of that colour inside it, so it reads as the heart of the
// base and not as a turret. Flat, like the rest.
function drawCoreBody(shape: Graphics, radius: number, color: string): void {
  const diamond = (size: number): number[] => [0, -size, size, 0, 0, size, -size, 0]
  shape
    .poly(diamond(radius))
    .fill({ color: '#2d3340' })
    .stroke({ color, width: 5 })
    .poly(diamond(radius * 0.58))
    .fill({ color })
    .stroke({ color: '#0b1220', width: 2, alpha: 0.7 })
    .circle(0, 0, radius * 0.16)
    .fill({ color: '#ffffff', alpha: 0.85 })
}

// The barrier of a structure that is protected: a pale ring a little out from its body, with a fainter one outside it.
function drawBarrier(radius: number): Graphics {
  const barrier = new Graphics()
    .circle(0, 0, radius + 7)
    .stroke({ color: '#e8f4ff', width: 3, alpha: 0.85 })
    .circle(0, 0, radius + 13)
    .stroke({ color: '#e8f4ff', width: 2, alpha: 0.35 })
  barrier.visible = false
  return barrier
}

// Destroying a body takes it out of the depth layer with it.
function destroyActor(actor: Actor): void {
  actor.node.destroy({ children: true })
  actor.overlay.destroy({ children: true })
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
    .rect(-width / 2, y, width, height)
    .fill({ color: '#101827' })
    .rect(-width / 2, y, width * Math.max(0, Math.min(1, fraction)), height)
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
