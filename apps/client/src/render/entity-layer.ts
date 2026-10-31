import { Container, Graphics } from 'pixi.js'
import type { RenderedEntity } from '../game-state.ts'

type EntityActor = {
  node: Container
  // A telegraph's inner disc, which swells to the full circle as the warning runs out.
  fill?: Graphics
  // A flash, which is brightest as it appears and fades away as it runs out its lifetime.
  fades?: true
}

// Everything abilities and autos put in the world. Some of it lies on the ground under the
// champions, so it never hides who is standing in it (telegraphs, fields), and the rest flies over
// them (shots, bolts). The two go in separate containers for the world renderer to place.
export class EntityLayer {
  readonly ground = new Container()
  readonly air = new Container()
  private readonly actors = new Map<string, EntityActor>()

  update(entities: readonly RenderedEntity[]): void {
    const activeIds = new Set(entities.map((entity) => entity.id))
    for (const [id, actor] of this.actors) {
      if (!activeIds.has(id)) {
        actor.node.destroy({ children: true })
        this.actors.delete(id)
      }
    }
    for (const entity of entities) {
      const actor = this.actors.get(entity.id) ?? this.addActor(entity)
      actor.node.position.set(entity.position.x, entity.position.y)
      actor.fill?.scale.set(entity.progress)
      // It falls away fast, so it reads as a flash and not as a field that is there for a while.
      if (actor.fades) actor.node.alpha = (1 - entity.progress) ** 2
    }
  }

  private addActor(entity: RenderedEntity): EntityActor {
    const node = new Container()
    let fill: Graphics | undefined
    if (entity.visual === 'flash') {
      // The instant something goes off: its whole shape, filled bright and edged hard, on the ground under the champions so it never hides them.
      const color = entity.color ?? '#ffffff'
      const shape = new Graphics()
      if (entity.box) {
        const { halfLength, halfWidth } = entity.box
        shape.rect(-halfLength, -halfWidth, halfLength * 2, halfWidth * 2)
        node.rotation = Math.atan2(entity.facing?.y ?? 0, entity.facing?.x ?? 1)
      } else {
        shape.circle(0, 0, entity.radius)
      }
      node.addChild(shape.fill({ color, alpha: 0.5 }).stroke({ color, width: 5, alpha: 1 }))
      node.alpha = (1 - entity.progress) ** 2
      this.ground.addChild(node)
      const actor: EntityActor = { node, fades: true }
      this.actors.set(entity.id, actor)
      return actor
    }
    if (entity.visual === 'telegraph' && !entity.box) {
      // An outline of where it will land, with a disc growing inside it until it goes off.
      const color = entity.color ?? '#ff6b4a'
      fill = new Graphics().circle(0, 0, entity.radius).fill({ color, alpha: 0.35 })
      fill.scale.set(entity.progress)
      node.addChild(
        new Graphics()
          .circle(0, 0, entity.radius)
          .fill({ color, alpha: 0.1 })
          .stroke({ color, width: 2, alpha: 0.9 }),
        fill,
      )
      this.ground.addChild(node)
    } else if (entity.box) {
      // A rectangle is drawn pointing the way it was aimed. A field is faint and lies on the
      // ground; anything else is solid and travels over the champions.
      const { halfLength, halfWidth } = entity.box
      const isField = entity.visual === 'field'
      const color = entity.color ?? (isField ? '#9b6df2' : '#f2b66d')
      node.addChild(
        new Graphics()
          .rect(-halfLength, -halfWidth, halfLength * 2, halfWidth * 2)
          .fill({ color, alpha: isField ? 0.16 : 0.7 })
          .stroke({ color, width: 2, alpha: isField ? 0.6 : 1 }),
      )
      node.rotation = Math.atan2(entity.facing?.y ?? 0, entity.facing?.x ?? 1)
      if (isField) this.ground.addChild(node)
      else this.air.addChild(node)
    } else if (entity.visual === 'field') {
      node.addChild(
        new Graphics()
          .circle(0, 0, entity.radius)
          .fill({ color: entity.color ?? '#9b6df2', alpha: 0.16 })
          .stroke({ color: entity.color ?? '#9b6df2', width: 2, alpha: 0.6 }),
      )
      this.ground.addChild(node)
    } else {
      node.addChild(new Graphics().circle(0, 0, entity.radius).fill({ color: entity.color ?? '#f2b66d' }))
      this.air.addChild(node)
    }
    const actor = { node, ...(fill ? { fill } : {}) }
    this.actors.set(entity.id, actor)
    return actor
  }
}
