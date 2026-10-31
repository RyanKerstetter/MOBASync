import { Container, Graphics } from 'pixi.js'
import type { Vector2 } from '../../../../packages/shared/src/index.ts'
import { ATTACK_MARKER_STYLE, layoutAttackMarker, type AttackMarker } from './attack-marker.ts'
import type { CastPreview, RenderedCharacter } from '../game-state.ts'

// A ground target whose ability gives no indicator size is marked with a small ring this big.
const CAST_INDICATOR_MARKER_RADIUS = 6

export type IndicatorInput = {
  characters: readonly RenderedCharacter[]
  // Where the controlled champion is drawn, and how far its attack reaches. Absent while it is dead
  // or not in the game, when there is no ring to draw.
  local?: { position: Vector2; attackRange: number }
  // Whether to draw the ring round the controlled champion that shows how far its attacks reach (the graphics menu). It is drawn unless this says not.
  showAttackRange?: boolean
  // What the ability being aimed would do if its key were let go now.
  castPreview?: CastPreview
  attackMarkers: readonly AttackMarker[]
  // The character a left click picked, which has a ring round its feet while its panel is up.
  selectedId?: number
}

// What the player is shown about their own champion's reach: the attack range ring, the indicator
// of the ability being aimed, the reticles on the enemy a click would attack and on the one the
// attack is locked on, and the ring round the one that has been clicked on to look at.
export class IndicatorLayer {
  readonly view = new Container()
  private readonly attackRange = new Graphics()
  private readonly castIndicator = new Graphics()
  private readonly attackMarkers = new Graphics()
  private readonly selection = new Graphics()

  constructor() {
    this.attackRange.alpha = 0.3
    this.attackRange.visible = false
    this.view.addChild(this.attackRange, this.castIndicator, this.attackMarkers, this.selection)
  }

  update(input: IndicatorInput): void {
    const ringShown = input.local !== undefined && input.showAttackRange !== false
    this.attackRange.visible = ringShown
    if (input.local && ringShown) {
      this.attackRange.clear()
        .circle(0, 0, input.local.attackRange)
        .stroke({ color: '#79dfb1', width: 2 })
      this.attackRange.position.set(input.local.position.x, input.local.position.y)
    }
    this.drawCastIndicator(input.castPreview, input.local?.position, input.characters)
    this.drawAttackMarkers(input.attackMarkers, input.characters)
    this.drawSelection(input.selectedId, input.characters)
  }

  // A pale ring just outside the body, so which one the panel is about can be told at a glance.
  private drawSelection(selectedId: number | undefined, characters: readonly RenderedCharacter[]): void {
    this.selection.clear()
    const selected = selectedId === undefined ? undefined : characters.find((character) => character.id === selectedId)
    if (!selected || selected.dead) return
    this.selection
      .circle(selected.position.x, selected.position.y, selected.champion.radius + 4)
      .stroke({ color: '#e8f4ff', width: 2, alpha: 0.85 })
  }

  // The range around the champion, and where the ability would go if the key were let go now.
  private drawCastIndicator(
    preview: CastPreview | undefined,
    from: Vector2 | undefined,
    characters: readonly RenderedCharacter[],
  ): void {
    const indicator = this.castIndicator
    indicator.clear()
    if (!preview || !from) return
    const color = '#f2e8a0'
    // A skillshot flies a straight line that its own band already shows, so only abilities aimed at
    // a point or a unit get the ring that marks how far they reach.
    if (preview.range > 0 && preview.targeting !== 'direction') {
      indicator.circle(from.x, from.y, preview.range).stroke({ color, width: 2, alpha: 0.45 })
    }
    // And the nearest it can be aimed, fainter inside it, for one that cannot be aimed closer.
    if (preview.minRange) {
      indicator.circle(from.x, from.y, preview.minRange).stroke({ color, width: 1, alpha: 0.25 })
    }
    const target = preview.target
    if (target?.mode === 'direction') {
      const end = { x: from.x + target.dir.x * preview.range, y: from.y + target.dir.y * preview.range }
      // The band is as wide as what the ability fires; the line down its middle is the aim.
      const width = preview.indicator?.width
      if (width) indicator.moveTo(from.x, from.y).lineTo(end.x, end.y).stroke({ color, width, alpha: 0.18 })
      indicator.moveTo(from.x, from.y).lineTo(end.x, end.y).stroke({ color, width: 2, alpha: 0.7 })
    } else if (target?.mode === 'point') {
      // A dash is drawn as the way it will go, a line from the caster to the point, as well as the point.
      if (preview.indicator?.line) {
        // As wide as what it throws, when it says, like a skillshot's band.
        const band = preview.indicator.width
        if (band) indicator.moveTo(from.x, from.y).lineTo(target.point.x, target.point.y).stroke({ color, width: band, alpha: 0.18 })
        indicator.moveTo(from.x, from.y).lineTo(target.point.x, target.point.y).stroke({ color, width: 2, alpha: 0.7 })
      }
      const radius = preview.indicator?.radius
      indicator
        .circle(target.point.x, target.point.y, radius ?? CAST_INDICATOR_MARKER_RADIUS)
        .fill({ color, alpha: radius ? 0.18 : 0 })
        .stroke({ color, width: 2, alpha: 0.8 })
      // A second circle inside for an ability whose middle does something else: its own outline,
      // and a second layer of fill that makes the core read darker than the ring around it.
      const innerRadius = preview.indicator?.innerRadius
      if (innerRadius) {
        indicator
          .circle(target.point.x, target.point.y, innerRadius)
          .fill({ color, alpha: 0.18 })
          .stroke({ color, width: 2, alpha: 0.8 })
      }
    } else if (target?.mode === 'unit') {
      const unit = characters.find((character) => character.id === target.unitId)
      // Red when the enemy is past the ability's reach, so the ring tells whether it will cast.
      if (unit) {
        indicator
          .circle(unit.position.x, unit.position.y, unit.champion.radius + 7)
          .stroke({ color: preview.outOfRange ? '#ff6b6b' : color, width: 3, alpha: 0.9 })
      }
    }
  }

  private drawAttackMarkers(markers: readonly AttackMarker[], characters: readonly RenderedCharacter[]): void {
    this.attackMarkers.clear()
    for (const marker of markers) {
      const target = characters.find((character) => character.id === marker.targetId)
      if (!target || target.dead) continue
      const shape = layoutAttackMarker(target.champion.radius)
      const { x, y } = target.position
      for (const tick of shape.ticks) {
        this.attackMarkers.moveTo(x + tick.from.x, y + tick.from.y).lineTo(x + tick.to.x, y + tick.to.y)
      }
      this.attackMarkers.stroke(ATTACK_MARKER_STYLE[marker.kind])
    }
  }
}
