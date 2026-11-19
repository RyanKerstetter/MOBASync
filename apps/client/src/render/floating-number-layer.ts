import { Container, Text } from 'pixi.js'
import type { Vector2 } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'
import type { OverlayAnchor } from './overlay-anchor.ts'
import {
  FLOATING_DAMAGE_COLOR,
  FLOATING_HEAL_COLOR,
  floatingChanges,
  floatingNumberPose,
  floatingNumberText,
  HealMerger,
  healthLook,
  type HealthLook,
  type NumberChange,
} from './floating-number.ts'

type FloatingNumber = {
  node: Text
  startedAt: number
  // Where the character it is over stood when it was shown, how big it is, and who: it rises from over there.
  at: Vector2
  radius: number
  id: number
}

// How far over a character's position its numbers start, past its body.
const NUMBER_LIFT = 24

// A number over a champion for each hit it takes (orange) and for the health it gets back (green), rising and fading. What is a hit and what is a
// heal is told from what the champions looked like the last time this was updated (see `floatingChange`), and heals that come close together
// are shown as one (see `HealMerger`).
export class FloatingNumberLayer {
  readonly view = new Container()
  private readonly shown = new Map<number, HealthLook>()
  private readonly heals = new HealMerger()
  private readonly floating: FloatingNumber[] = []
  // Where the numbers are placed from, when the world is not drawn flat (see `OverlayAnchor`). Without one, from where the
  // character stood.
  anchor: OverlayAnchor | undefined

  update(characters: readonly RenderedCharacter[], now: number): void {
    const activeIds = new Set<number>()
    const byId = new Map<number, RenderedCharacter>()
    for (const character of characters) {
      activeIds.add(character.id)
      byId.set(character.id, character)
      const look = healthLook(character)
      for (const change of floatingChanges(this.shown.get(character.id), look)) {
        if (change.kind === 'damage') this.add(character, change, now)
        else this.heals.add(character.id, change.amount)
      }
      this.shown.set(character.id, look)
    }
    for (const id of this.shown.keys()) {
      if (activeIds.has(id)) continue
      this.shown.delete(id)
      this.heals.forget(id)
    }
    for (const { id, amount } of this.heals.take(now)) {
      const character = byId.get(id)
      if (character) this.add(character, { kind: 'heal', amount }, now)
    }

    for (let index = this.floating.length - 1; index >= 0; index -= 1) {
      const floating = this.floating[index]
      const pose = floatingNumberPose(now - floating.startedAt)
      if (pose.done) {
        floating.node.destroy()
        this.floating.splice(index, 1)
        continue
      }
      floating.node.alpha = pose.alpha
      const base = this.anchor?.(floating.at, floating.radius, floating.id) ?? floating.at
      floating.node.position.set(base.x, base.y - floating.radius - NUMBER_LIFT - pose.rise)
    }
  }

  private add(character: RenderedCharacter, change: NumberChange, now: number): void {
    if (change.amount <= 0) return
    const node = new Text({
      text: floatingNumberText(change),
      style: { fill: change.kind === 'damage' ? FLOATING_DAMAGE_COLOR : FLOATING_HEAL_COLOR, fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
    })
    node.anchor.set(0.5)
    const at = { x: character.position.x, y: character.position.y }
    node.position.set(at.x, at.y - character.champion.radius - NUMBER_LIFT)
    this.view.addChild(node)
    this.floating.push({ node, startedAt: now, at, radius: character.champion.radius, id: character.id })
  }
}
