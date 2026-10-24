import { Container, Text } from 'pixi.js'
import type { RenderedCharacter } from '../game-state.ts'

// How long a number stays up, fading as it goes, and how fast it rises, in world units a millisecond.
const FLOATING_DAMAGE_MS = 900
const FLOATING_DAMAGE_RISE = 1 / 45

type FloatingDamage = {
  node: Text
  startedAt: number
  startY: number
}

// A number over a champion for each hit it takes, rising and fading. A hit is told from what the
// champions looked like the last time this was updated: their health and shield together went down,
// and their `hpSeq` went up, which only damage does, so a shield running out is not a hit.
export class FloatingDamageLayer {
  readonly view = new Container()
  private readonly shown = new Map<number, { total: number; hpSeq: number }>()
  private readonly floating: FloatingDamage[] = []

  update(characters: readonly RenderedCharacter[], now: number): void {
    const activeIds = new Set<number>()
    for (const character of characters) {
      activeIds.add(character.id)
      const health = {
        total: (character.health?.hp ?? 0) + character.totalShield,
        hpSeq: character.health?.hpSeq ?? 0,
      }
      const previous = this.shown.get(character.id)
      if (previous && health.hpSeq > previous.hpSeq && health.total < previous.total) {
        this.add(character, previous.total - health.total, now)
      }
      this.shown.set(character.id, health)
    }
    for (const id of this.shown.keys()) {
      if (!activeIds.has(id)) this.shown.delete(id)
    }

    for (let index = this.floating.length - 1; index >= 0; index -= 1) {
      const floating = this.floating[index]
      const elapsed = now - floating.startedAt
      if (elapsed >= FLOATING_DAMAGE_MS) {
        floating.node.destroy()
        this.floating.splice(index, 1)
        continue
      }
      floating.node.alpha = 1 - elapsed / FLOATING_DAMAGE_MS
      floating.node.y = floating.startY - elapsed * FLOATING_DAMAGE_RISE
    }
  }

  private add(character: RenderedCharacter, dealt: number, now: number): void {
    if (dealt <= 0) return
    const node = new Text({
      text: `-${dealt}`,
      style: { fill: '#ffd27a', fontSize: 16, fontFamily: 'Arial', fontWeight: 'bold' },
    })
    node.anchor.set(0.5)
    const startY = character.position.y - character.champion.radius - 24
    node.position.set(character.position.x, startY)
    this.view.addChild(node)
    this.floating.push({ node, startedAt: now, startY })
  }
}
