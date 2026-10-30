import { Container, Text } from 'pixi.js'
import type { RenderedCharacter } from '../game-state.ts'
import {
  FLOATING_DAMAGE_COLOR,
  FLOATING_HEAL_COLOR,
  floatingChange,
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
  startY: number
}

// A number over a champion for each hit it takes (orange) and for the health it gets back (green), rising and fading. What is a hit and what is a
// heal is told from what the champions looked like the last time this was updated (see `floatingChange`), and heals that come close together
// are shown as one (see `HealMerger`).
export class FloatingNumberLayer {
  readonly view = new Container()
  private readonly shown = new Map<number, HealthLook>()
  private readonly heals = new HealMerger()
  private readonly floating: FloatingNumber[] = []

  update(characters: readonly RenderedCharacter[], now: number): void {
    const activeIds = new Set<number>()
    const byId = new Map<number, RenderedCharacter>()
    for (const character of characters) {
      activeIds.add(character.id)
      byId.set(character.id, character)
      const look = healthLook(character)
      const change = floatingChange(this.shown.get(character.id), look)
      if (change?.kind === 'damage') this.add(character, change, now)
      else if (change?.kind === 'heal') this.heals.add(character.id, change.amount)
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
      floating.node.y = floating.startY - pose.rise
    }
  }

  private add(character: RenderedCharacter, change: NumberChange, now: number): void {
    if (change.amount <= 0) return
    const node = new Text({
      text: floatingNumberText(change),
      style: { fill: change.kind === 'damage' ? FLOATING_DAMAGE_COLOR : FLOATING_HEAL_COLOR, fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
    })
    node.anchor.set(0.5)
    const startY = character.position.y - character.champion.radius - 24
    node.position.set(character.position.x, startY)
    this.view.addChild(node)
    this.floating.push({ node, startedAt: now, startY })
  }
}
