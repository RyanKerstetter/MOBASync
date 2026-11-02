import { Graphics } from 'pixi.js'
import type { RenderedCharacter } from '../game-state.ts'
import type { Vector2 } from '../../../../packages/shared/src/index.ts'

// Monk's link, drawn as a beam on the ground between the teammate and him, edge of one body to edge of the other, under the champions so it never hides them. It is a
// pale line with dashes running along it from the teammate to Monk, which is the way the damage goes. This is the layout of it, with no drawing, so it can be read and tested
// apart; the drawing is `LinkLayer`.

export const LINK_COLOR = '#e8c15a'
const LINE_WIDTH = 3
const LINE_ALPHA = 0.35
const DASH_WIDTH = 4
const DASH_LENGTH = 12
const DASH_GAP = 10
// How fast the dashes run along it, in world units a second.
export const LINK_FLOW_SPEED = 45

// A beam, from the teammate's body to the body of whoever holds the link.
export type LinkBeam = { from: Vector2; to: Vector2 }

// The beams to draw: one for each champion that has another linked to it, while both are alive and in the frame (so not one that is out of sight), and not touching (there
// is no beam between two bodies that overlap).
export function layoutLinks(characters: readonly RenderedCharacter[]): LinkBeam[] {
  const byId = new Map(characters.map((character) => [character.id, character]))
  const beams: LinkBeam[] = []
  for (const linked of characters) {
    if (linked.linkedBy === undefined || linked.dead) continue
    const holder = byId.get(linked.linkedBy)
    if (!holder || holder.dead) continue
    const dx = holder.position.x - linked.position.x
    const dy = holder.position.y - linked.position.y
    const gap = Math.hypot(dx, dy)
    if (gap <= linked.champion.radius + holder.champion.radius) continue
    const dir = { x: dx / gap, y: dy / gap }
    beams.push({
      from: { x: linked.position.x + dir.x * linked.champion.radius, y: linked.position.y + dir.y * linked.champion.radius },
      to: { x: holder.position.x - dir.x * holder.champion.radius, y: holder.position.y - dir.y * holder.champion.radius },
    })
  }
  return beams
}

// The dashes of a beam at a time (a clock reading in milliseconds): short stretches of it, each as long as `DASH_LENGTH` and one `DASH_GAP` after the last, which run from its start
// to its end as the time goes on, and are cut off at the ends.
export function beamDashes(beam: LinkBeam, now: number): Array<[Vector2, Vector2]> {
  const length = Math.hypot(beam.to.x - beam.from.x, beam.to.y - beam.from.y)
  if (length === 0) return []
  const dir = { x: (beam.to.x - beam.from.x) / length, y: (beam.to.y - beam.from.y) / length }
  const period = DASH_LENGTH + DASH_GAP
  const shift = (now / 1000 * LINK_FLOW_SPEED) % period
  const dashes: Array<[Vector2, Vector2]> = []
  for (let start = shift - period; start < length; start += period) {
    const from = Math.max(0, start)
    const to = Math.min(length, start + DASH_LENGTH)
    if (to <= from) continue
    dashes.push([
      { x: beam.from.x + dir.x * from, y: beam.from.y + dir.y * from },
      { x: beam.from.x + dir.x * to, y: beam.from.y + dir.y * to },
    ])
  }
  return dashes
}

export class LinkLayer {
  readonly view = new Graphics()

  update(characters: readonly RenderedCharacter[], now: number): void {
    const beams = layoutLinks(characters)
    this.view.clear()
    if (beams.length === 0) return
    for (const beam of beams) this.view.moveTo(beam.from.x, beam.from.y).lineTo(beam.to.x, beam.to.y)
    this.view.stroke({ color: LINK_COLOR, width: LINE_WIDTH, alpha: LINE_ALPHA })
    for (const beam of beams) {
      for (const [from, to] of beamDashes(beam, now)) this.view.moveTo(from.x, from.y).lineTo(to.x, to.y)
    }
    this.view.stroke({ color: LINK_COLOR, width: DASH_WIDTH, alpha: 0.95, cap: 'butt' })
  }
}
