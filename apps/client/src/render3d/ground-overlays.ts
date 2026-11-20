import { BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, type BufferGeometry } from 'three'
import { GAME_FLAG_RADIUS, getTeam, type Rect, type ShopZone, type Vector2 } from '../../../../packages/shared/src/index.ts'
import type { CastPreview, RenderedCharacter, RenderedEntity } from '../game-state.ts'
import { attackMarkerLook, type AttackMarker } from '../render/attack-marker.ts'
import { BACK_BRIGHT, BACK_COLOR, layoutBack } from '../render/back-look.ts'
import type { EffectSettings } from '../render/effect-settings.ts'
import { layoutHealingZones, zonePulse, ZONE_EDGE_ALPHA, ZONE_FILL_ALPHA } from '../render/healing-zone.ts'
import { OUT_OF_REACH_COLOR, REVEAL_RING_COLOR } from '../render/indicator-layer.ts'
import { beamDashes, layoutLinks, LINK_COLOR } from '../render/link-layer.ts'
import { layoutShopAreas, SHOP_AREA_COLOR } from '../render/shop-area.ts'
import { layoutTurretRings } from '../render/turret-range.ts'
import type { FlagView, ModeView } from '../ui/mode-hud.ts'
import type { DecalBatch } from './decal-batch.ts'
import type { VisionShading } from './vision-shading.ts'

const PREVIEW_COLOR = '#f2e8a0'
const NEUTRAL_COLOR = '#c9d6e4'

export type GroundOverlayInput = {
  now: number
  characters: readonly RenderedCharacter[]
  unseen: readonly RenderedCharacter[]
  entities: readonly RenderedEntity[]
  localCharacterId: number | undefined
  castPreview?: CastPreview
  attackMarkers: readonly AttackMarker[]
  lockMarkerScale?: number
  selectedId?: number
  mode?: ModeView
  shops: readonly ShopZone[]
  effects: Readonly<EffectSettings>
  debug: boolean
  debugPath?: readonly Vector2[]
  walls: readonly Rect[]
}

// What the 2D layers paint on the ground, painted on the 3D ground: the reach of the champion's attack and of the ability being
// aimed, the markers on the enemy hovered and the one attacked, the ring round the one picked, the shops and healing zones, the
// hill and the flags' bases, the beam of a link, the reach of each turret, a ring under each champion in its team's colour,
// the ring of going back, and in the debug view every hitbox. Each frame they are painted afresh into `paint` (as paint) and
// `light` (as light added), from the same layouts the 2D layers use, so the two views agree.
export class GroundOverlays {
  readonly group = new Group()
  private readonly flags: Array<{ group: Group; cloth: Mesh; material: MeshStandardMaterial }> = []
  private readonly flagGeometries: BufferGeometry[]
  private readonly poleMaterial: MeshStandardMaterial

  constructor(private readonly vision: VisionShading) {
    this.poleMaterial = vision.shade(new MeshStandardMaterial({ color: '#e8f4ff', roughness: 0.4, metalness: 0.6 }))
    this.flagGeometries = [
      new CylinderGeometry(1.6, 2, 70, 6).translate(0, 35, 0),
      new BoxGeometry(40, 26, 1.5).translate(20, 56, 0),
      new ConeGeometry(4, 8, 6).translate(0, 74, 0),
    ]
  }

  update(input: GroundOverlayInput, paint: DecalBatch, light: DecalBatch): void {
    const { characters, now } = input
    const local = characters.find((character) => character.id === input.localCharacterId)
    // The shops' tint, where champions heal.
    if (input.effects.shopGlow) {
      for (const area of layoutShopAreas(input.shops)) {
        paint.rect(area.x, area.y, area.width, area.height, SHOP_AREA_COLOR, 0.12)
        light.rectEdge(area.x, area.y, area.width, area.height, 3, SHOP_AREA_COLOR, 0.35)
      }
    }
    // Healing zones: a pool of their team's colour out to where they heal, and a ring swelling out to the edge.
    const pulse = zonePulse(now)
    for (const area of layoutHealingZones(characters)) {
      paint.disc(area.x, area.y, area.reach, area.color, ZONE_FILL_ALPHA * 1.6)
      light.circle(area.x, area.y, area.reach, 4, area.color, ZONE_EDGE_ALPHA)
      light.circle(area.x, area.y, area.inner + (area.reach - area.inner) * pulse, 3, '#6dff9e', 0.5 * (1 - pulse))
    }
    this.drawMode(input.mode, characters, now, paint, light)
    // Turrets' reach.
    if (input.effects.turretRanges) {
      for (const ring of layoutTurretRings(characters)) light.circle(ring.x, ring.y, ring.radius, 3, ring.color, 0.35)
    }
    // A ring under the champion you control (which side the others are on is for their name tags, and an enemy's red edge).
    for (const character of characters) {
      if (character.dead || character.turret || character.monster) continue
      const isLocal = character.id === input.localCharacterId
      if (isLocal) paint.circle(character.position.x, character.position.y, character.champion.radius + 2, 3, '#7dffb0', 0.8)
      // Going back: a glow round its feet and a bright arc closing round it as the channel runs.
      if (character.backing !== undefined) {
        const look = layoutBack(character.backing, now, character.champion.radius)
        light.disc(character.position.x, character.position.y, look.ringRadius, BACK_COLOR, look.glowAlpha)
        light.circle(character.position.x, character.position.y, look.ringRadius, 2, BACK_COLOR, 0.45)
        if (look.sweep > 0) light.ring(character.position.x, character.position.y, look.ringRadius - 2, look.ringRadius + 2, BACK_BRIGHT, 0.95, -Math.PI / 2, -Math.PI / 2 + look.sweep)
      }
    }
    // Links: a beam of light along the ground between the two, with dashes running along it.
    for (const beam of layoutLinks(characters, input.unseen)) {
      light.line(beam.from, beam.to, 3, LINK_COLOR, 0.35)
      for (const [from, to] of beamDashes(beam, now)) light.line(from, to, 4, LINK_COLOR, 0.9)
    }
    // The champion's own reach, and what it is about to do.
    if (local && !local.dead) {
      if (input.effects.selfAttackRange) paint.circle(local.position.x, local.position.y, local.attackRange, 2.5, '#79dfb1', 0.45)
      const reveal = local.invisible ? local.champion.leaveInvisibilityRadius : undefined
      if (reveal) {
        paint.disc(local.position.x, local.position.y, reveal, REVEAL_RING_COLOR, 0.1)
        paint.circle(local.position.x, local.position.y, reveal, 2.5, REVEAL_RING_COLOR, 0.75)
      }
      if (input.castPreview) this.drawCastPreview(input.castPreview, local.position, characters, paint)
    }
    // The markers on the enemy hovered and the one being attacked: ticks round its feet.
    for (const marker of input.attackMarkers) {
      const target = characters.find((character) => character.id === marker.targetId)
      if (!target || target.dead) continue
      const { shape, stroke } = attackMarkerLook(marker.kind, target.champion.radius, input.lockMarkerScale)
      for (const tick of shape.ticks) {
        paint.line(
          { x: target.position.x + tick.from.x, y: target.position.y + tick.from.y },
          { x: target.position.x + tick.to.x, y: target.position.y + tick.to.y },
          stroke.width * 1.8,
          stroke.color,
          stroke.alpha,
        )
      }
      paint.circle(target.position.x, target.position.y, target.champion.radius + 3, stroke.width, stroke.color, stroke.alpha * 0.6)
    }
    const selected = input.selectedId === undefined ? undefined : characters.find((character) => character.id === input.selectedId)
    if (selected && !selected.dead) paint.circle(selected.position.x, selected.position.y, selected.champion.radius + 5, 2.5, '#e8f4ff', 0.85)
    if (input.debug) this.drawDebug(input, paint)
  }

  dispose(): void {
    for (const flag of this.flags) flag.material.dispose()
    for (const geometry of this.flagGeometries) geometry.dispose()
    this.poleMaterial.dispose()
  }

  // Where the ability being aimed reaches and what it would hit, as the 2D indicator draws it.
  private drawCastPreview(preview: CastPreview, from: Vector2, characters: readonly RenderedCharacter[], paint: DecalBatch): void {
    if (preview.range > 0 && preview.targeting !== 'direction') paint.circle(from.x, from.y, preview.range, 2.5, PREVIEW_COLOR, 0.5)
    if (preview.minRange) paint.circle(from.x, from.y, preview.minRange, 1.5, PREVIEW_COLOR, 0.3)
    const target = preview.target
    if (target?.mode === 'direction' && preview.charge) {
      // A held shot being drawn: a faint lane out to the most it can reach, the part it reaches now bright and widening as it grows, and a bar across its end.
      const { fraction, most } = preview.charge
      const far = { x: from.x + target.dir.x * most, y: from.y + target.dir.y * most }
      const end = { x: from.x + target.dir.x * preview.range, y: from.y + target.dir.y * preview.range }
      const width = preview.indicator?.width ?? 20
      const full = fraction >= 1
      const css = full ? '#ffd36a' : PREVIEW_COLOR
      paint.line(from, far, width, PREVIEW_COLOR, 0.08)
      paint.line(from, far, 1.5, PREVIEW_COLOR, 0.3)
      paint.line(from, end, width * (0.5 + fraction * 0.5), css, 0.2 + fraction * 0.15)
      paint.line(from, end, 3, css, 0.9)
      const side = { x: -target.dir.y * width * 0.9, y: target.dir.x * width * 0.9 }
      paint.line({ x: end.x + side.x, y: end.y + side.y }, { x: end.x - side.x, y: end.y - side.y }, 4, css, full ? 0.6 + 0.4 * Math.sin(performance.now() / 70) : 0.9)
      return
    }
    if (target?.mode === 'direction') {
      const end = { x: from.x + target.dir.x * preview.range, y: from.y + target.dir.y * preview.range }
      const width = preview.indicator?.width
      if (width) paint.line(from, end, width, PREVIEW_COLOR, 0.22)
      const half = preview.indicator?.coneHalfAngle
      if (half && preview.range > 0) {
        const heading = Math.atan2(target.dir.y, target.dir.x)
        paint.wedge(from.x, from.y, preview.range, heading - half, heading + half, PREVIEW_COLOR, 0.2)
        paint.ring(from.x, from.y, preview.range - 1.5, preview.range + 1.5, PREVIEW_COLOR, 0.6, heading - half, heading + half)
      }
      paint.line(from, end, 2.5, PREVIEW_COLOR, 0.75)
      // An arrowhead at the end, so which way it goes reads at a glance.
      const back = { x: -target.dir.x * 14, y: -target.dir.y * 14 }
      const side = { x: -target.dir.y * 9, y: target.dir.x * 9 }
      paint.line(end, { x: end.x + back.x + side.x, y: end.y + back.y + side.y }, 2.5, PREVIEW_COLOR, 0.75)
      paint.line(end, { x: end.x + back.x - side.x, y: end.y + back.y - side.y }, 2.5, PREVIEW_COLOR, 0.75)
    } else if (target?.mode === 'point') {
      if (preview.indicator?.line) {
        const band = preview.indicator.width
        if (band) paint.line(from, target.point, band, PREVIEW_COLOR, 0.2)
        paint.line(from, target.point, 2.5, PREVIEW_COLOR, 0.75)
      }
      const radius = preview.indicator?.radius
      if (radius) paint.disc(target.point.x, target.point.y, radius, PREVIEW_COLOR, 0.2)
      paint.circle(target.point.x, target.point.y, radius ?? 6, 2.5, PREVIEW_COLOR, 0.85)
      const inner = preview.indicator?.innerRadius
      if (inner) {
        paint.disc(target.point.x, target.point.y, inner, PREVIEW_COLOR, 0.2)
        paint.circle(target.point.x, target.point.y, inner, 2.5, PREVIEW_COLOR, 0.85)
      }
    } else if (target?.mode === 'unit') {
      const unit = characters.find((character) => character.id === target.unitId)
      if (unit) paint.circle(unit.position.x, unit.position.y, unit.champion.radius + 7, 3.5, preview.outOfRange ? OUT_OF_REACH_COLOR : PREVIEW_COLOR, 0.9)
    }
  }

  // The hill, and the flags: their bases painted on the ground, and each flag a pole with a cloth of its team's colour, at its
  // base, where it was dropped, or over the shoulder of whoever carries it.
  private drawMode(view: ModeView | undefined, characters: readonly RenderedCharacter[], now: number, paint: DecalBatch, light: DecalBatch): void {
    let flagsUsed = 0
    if (view?.kind === 'koth') {
      const { hill } = view
      const cx = hill.x + hill.width / 2
      const cy = hill.y + hill.height / 2
      const held = view.owner !== undefined
      const color = view.capturer === undefined ? NEUTRAL_COLOR : getTeam(view.capturer).color
      const flicker = view.contested ? 0.35 + 0.35 * Math.abs(Math.sin(now / 160)) : 0
      const shape = (share: number, css: string, alpha: number, edge = 0): void => {
        if (hill.ellipse) paint.ellipse(cx, cy, hill.width / 2 * share, hill.height / 2 * share, css, alpha, edge)
        else if (edge > 0) paint.rectEdge(cx - hill.width / 2 * share, cy - hill.height / 2 * share, hill.width * share, hill.height * share, edge, css, alpha)
        else paint.rect(cx - hill.width / 2 * share, cy - hill.height / 2 * share, hill.width * share, hill.height * share, css, alpha)
      }
      shape(1, NEUTRAL_COLOR, 0.1)
      shape(1, held ? color : NEUTRAL_COLOR, held ? 0.95 : 0.55 + flicker * 0.4, held ? 7 : 4)
      if (view.fraction > 0) shape(view.fraction, color, held ? 0.4 : 0.3)
      if (held) light.ellipse(cx, cy, hill.width / 2, hill.height / 2, color, 0.12)
    } else if (view?.kind === 'ctf') {
      for (const flag of view.flags) {
        const color = getTeam(flag.team).color
        const atHome = flag.status === 'home'
        paint.disc(flag.home.x, flag.home.y, GAME_FLAG_RADIUS, color, atHome ? 0.25 : 0.08)
        paint.circle(flag.home.x, flag.home.y, GAME_FLAG_RADIUS, 3, color, atHome ? 0.9 : 0.4)
        const at = this.flagAt(flag, characters)
        if (flag.status === 'dropped') {
          const swell = 0.5 + 0.5 * Math.sin(now / 200)
          light.circle(flag.position.x, flag.position.y, GAME_FLAG_RADIUS + swell * 14, 3, color, 0.9 - swell * 0.4)
        } else if (flag.status === 'carried') {
          const carrier = characters.find((character) => character.id === flag.carrier?.id)
          if (carrier) light.circle(carrier.position.x, carrier.position.y, carrier.champion.radius + 10 + (0.5 + 0.5 * Math.sin(now / 180)) * 5, 3.5, color, 0.95)
        }
        this.placeFlag(flagsUsed, at.position, at.height, color, now)
        flagsUsed += 1
      }
    }
    for (let index = flagsUsed; index < this.flags.length; index += 1) this.flags[index].group.visible = false
  }

  private flagAt(flag: FlagView, characters: readonly RenderedCharacter[]): { position: Vector2; height: number } {
    if (flag.status === 'carried') {
      const carrier = characters.find((character) => character.id === flag.carrier?.id)
      const at = carrier?.position ?? flag.position
      const radius = carrier?.champion.radius ?? 20
      return { position: { x: at.x - radius * 0.6, y: at.y + 4 }, height: 30 }
    }
    return { position: flag.status === 'home' ? flag.home : flag.position, height: 0 }
  }

  private placeFlag(index: number, at: Vector2, height: number, color: string, now: number): void {
    let flag = this.flags[index]
    if (!flag) {
      const group = new Group()
      const material = this.vision.shade(new MeshStandardMaterial({ color, roughness: 0.6, side: DoubleSide }))
      const pole = new Mesh(this.flagGeometries[0], this.poleMaterial)
      const cloth = new Mesh(this.flagGeometries[1], material)
      const tip = new Mesh(this.flagGeometries[2], this.poleMaterial)
      for (const mesh of [pole, cloth, tip]) mesh.castShadow = true
      group.add(pole, cloth, tip)
      this.group.add(group)
      flag = { group, cloth, material }
      this.flags[index] = flag
    }
    flag.group.visible = true
    flag.material.color.set(color)
    flag.group.position.set(at.x, height, at.y)
    // It flutters.
    flag.cloth.rotation.y = Math.sin(now / 220) * 0.25
    flag.cloth.scale.set(1, 1 + Math.sin(now / 160) * 0.05, 1)
  }

  // The debug view: every body's hitbox, every entity's shape, the walls' true outlines, and the way the champion is walking.
  private drawDebug(input: GroundOverlayInput, paint: DecalBatch): void {
    for (const character of input.characters) {
      paint.circle(character.position.x, character.position.y, character.champion.radius, 2, character.id === input.localCharacterId ? '#7dffb0' : '#ffd166', 0.9)
    }
    for (const entity of input.entities) {
      if (entity.box) paint.box(entity.position, entity.facing ?? { x: 1, y: 0 }, entity.box.halfLength, entity.box.halfWidth, '#ff5a5f', 0.3)
      else paint.circle(entity.position.x, entity.position.y, entity.radius, 2, '#ff5a5f', 0.9)
    }
    for (const wall of input.walls) paint.rectEdge(wall.x, wall.y, wall.width, wall.height, 3, '#ff9f43', 0.8)
    const path = input.debugPath ?? []
    for (let index = 1; index < path.length; index += 1) paint.line(path[index - 1], path[index], 3, '#7dd3fc', 0.9)
  }
}
