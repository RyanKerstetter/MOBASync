import { Group, type Texture } from 'three'
import { getTeam } from '../../../../../packages/shared/src/index.ts'
import type { RenderedEntity } from '../../game-state.ts'
import { BubbleVisual, BurningGroundVisual, FireBlastVisual, FireballVisual, FireRuneVisual, FireTornadoVisual, FlameWallVisual, GeyserVisual, WaveVisual, WellVisual } from './elemental.ts'
import { emberTexture } from './fx-materials.ts'
import {
  ArrowVisual,
  CanisterVisual,
  EnergySlugVisual,
  ExplosionVisual,
  FirePoolVisual,
  GrenadeVisual,
  GroundCrackVisual,
  GroveVisual,
  HexVisual,
  HookVisual,
  KnifeVisual,
  LashVisual,
  LeapTargetVisual,
  MedicBotVisual,
  MiasmaVisual,
  MolotovVisual,
  NovaVisual,
  OrbVisual,
  PlantedStickVisual,
  RootsVisual,
  ShadowVisual,
  ShellVisual,
  ShurikenVisual,
  SlashTrailVisual,
  SproutingVisual,
  StickVisual,
  TowerBoltVisual,
  TracerVisual,
  TrapVisual,
  VineVisual,
  WarpVisual,
  WhirlVisual,
} from './kits.ts'
import { BoltVisual, GroundShapeVisual, SlabVisual, type EffectContext, type Visual } from './visual.ts'

export type { EffectContext } from './visual.ts'

// -------------------------------------------------------------------------------------------------- the layer

// What abilities and autos have put in the world, in 3D, an effect for each entity, made when it appears and let play out
// after it goes.

type VisualFactory = (parent: Group, entity: RenderedEntity, ctx: EffectContext, embers: Texture) => Visual

// The entities with an effect of their own, by their id: every ability of every champion. Anything else is drawn by how it looks
// (`EntityEffects3D.make`).
export const ENTITY_VISUALS: Readonly<Record<string, VisualFactory>> = {
  // The Fire Mage.
  'fireball': (g, entity, ctx) => new FireballVisual(g, entity, ctx),
  'fireball-flash': (g, entity) => new FireBlastVisual(g, entity),
  'firetornado-warning': (g) => new FireRuneVisual(g),
  'firetornado-funnel': (g, entity) => new FireTornadoVisual(g, entity),
  'scorch-wave': (g, entity) => new FlameWallVisual(g, entity),
  'scorch-ground': (g, entity, _ctx, embers) => new BurningGroundVisual(g, entity, embers),
  // Capricorn.
  'tsunami-wave': (g, entity) => new WaveVisual(g, entity),
  'bubble': (g, entity, ctx) => new BubbleVisual(g, entity, ctx),
  'spout-warning': (g) => new WellVisual(g),
  'spout-burst': (g, entity) => new GeyserVisual(g, entity),
  // The Cursebearer.
  'miasma': (g) => new MiasmaVisual(g),
  'hex': (g, entity, ctx) => new HexVisual(g, entity, ctx),
  // The Archer.
  'snare-shot': (g, entity, ctx) => new CanisterVisual(g, entity, ctx, '#6dd39b', 'snare'),
  'snare-field': (g, entity) => new TrapVisual(g, entity),
  // The Swordsman.
  'slash-trail': (g, entity) => new SlashTrailVisual(g, entity),
  'light-burst': (g, entity) => new NovaVisual(g, entity, '#ffe27a'),
  // The Soldier.
  'bolt': (g, entity, ctx) => new EnergySlugVisual(g, entity, ctx),
  'medic-bot': (g) => new MedicBotVisual(g),
  // The Grenadier.
  'grenade-shot': (g, entity, ctx) => new GrenadeVisual(g, entity, ctx),
  'grenade-burst': (g, entity) => new ExplosionVisual(g, entity, 'grenade'),
  'molotov-shot': (g, entity, ctx) => new MolotovVisual(g, entity, ctx),
  'molotov-fire': (g, entity, _ctx, embers) => new FirePoolVisual(g, entity, embers),
  'flashbang-shot': (g, entity, ctx) => new CanisterVisual(g, entity, ctx, '#f4f1d0', 'flash'),
  'flash-burst': (g, entity) => new ExplosionVisual(g, entity, 'flash'),
  // The Trinketmaster.
  'stick-shot': (g, entity, ctx) => new StickVisual(g, entity, ctx),
  'stick-recall': (g, entity, ctx) => new StickVisual(g, entity, ctx),
  'stick': (g, entity) => new PlantedStickVisual(g, entity),
  'warp-out': (g, entity) => new WarpVisual(g, entity),
  'warp-in': (g, entity) => new WarpVisual(g, entity),
  // The Ninja.
  'shadow': (g, entity) => new ShadowVisual(g, entity),
  'shuriken': (g, entity, ctx) => new ShurikenVisual(g, entity, ctx, false),
  'shuriken-enhanced': (g, entity, ctx) => new ShurikenVisual(g, entity, ctx, true),
  // The Hammer.
  'slam-crater': (g, entity) => new GroundCrackVisual(g, entity),
  'hammerdrop-warning': (g) => new LeapTargetVisual(g),
  'hammerdrop-burst': (g, entity) => new ExplosionVisual(g, entity, 'impact'),
  // Chain.
  'hook': (g, entity, ctx) => new HookVisual(g, entity, ctx),
  'whirl-warning': (g, entity) => new WhirlVisual(g, entity),
  'whirl-core-warning': (g, entity) => new WhirlVisual(g, entity),
  'whirl-burst': (g, entity) => new LashVisual(g, entity),
  'whirl-core-burst': (g, entity) => new LashVisual(g, entity),
  // The Cloak.
  'knife': (g, entity, ctx) => new KnifeVisual(g, entity, ctx),
  // The Sage.
  'pulse-burst': (g, entity) => new NovaVisual(g, entity, '#8ee6a0', true),
  'vine-bolt': (g, entity, ctx) => new VineVisual(g, entity, ctx),
  // The Ent.
  'rootburst-warning': (g, entity) => new SproutingVisual(g, entity, false),
  'rootburst-roots': (g, entity) => new RootsVisual(g, entity),
  'grove-warning': (g, entity) => new SproutingVisual(g, entity, true),
  'grove': (g, entity) => new GroveVisual(g, entity),
}

export class EntityEffects3D {
  readonly group = new Group()
  private readonly visuals = new Map<string, Visual | null>()
  private readonly ending: Visual[] = []
  private readonly embers = emberTexture()

  update(entities: readonly RenderedEntity[], ctx: EffectContext): void {
    const active = new Set<string>()
    for (const entity of entities) {
      active.add(entity.id)
      let visual = this.visuals.get(entity.id)
      if (visual === undefined) {
        visual = this.make(entity, ctx)
        this.visuals.set(entity.id, visual)
      }
      if (visual && !visual.step(entity, ctx)) {
        visual.dispose()
        this.visuals.set(entity.id, null)
      }
    }
    for (const [id, visual] of this.visuals) {
      if (active.has(id)) continue
      this.visuals.delete(id)
      if (visual) this.ending.push(visual)
    }
    for (let index = this.ending.length - 1; index >= 0; index -= 1) {
      const visual = this.ending[index]
      if (!visual.step(undefined, ctx)) {
        visual.dispose()
        this.ending.splice(index, 1)
      }
    }
  }

  dispose(): void {
    for (const visual of this.visuals.values()) visual?.dispose()
    for (const visual of this.ending) visual.dispose()
    this.visuals.clear()
    this.ending.length = 0
    this.embers.dispose()
  }

  // The effect for an entity: by what it is for the Fire Mage's and Capricorn's, and by how it looks for the rest. Null for
  // one that is not drawn.
  private make(entity: RenderedEntity, ctx: EffectContext): Visual | null {
    const ownerCharacter = ctx.characters.get(entity.ownerId)
    const owner = ownerCharacter?.champion.id
    const g = this.group
    const dedicated = ENTITY_VISUALS[entity.defId]
    if (dedicated) return dedicated(g, entity, ctx, this.embers)
    if (entity.visual === 'hidden') return null
    // An auto attack's shot, by whose it is.
    if (entity.defId.startsWith('auto-shot')) {
      if (ownerCharacter?.turret) return new TowerBoltVisual(g, entity, ctx, getTeam(ownerCharacter.team).color)
      switch (owner) {
        case 'firemage': return new BoltVisual(g, entity, ctx, 'fire')
        case 'capricorn': return new BoltVisual(g, entity, ctx, 'water', (ownerCharacter?.stacks.empowered ?? 0) > 0)
        case 'archer': return new ArrowVisual(g, entity, ctx, '#6dd39b')
        case 'soldier': return new TracerVisual(g, entity, ctx)
        case 'grenadier': return new ShellVisual(g, entity, ctx)
        case 'cursebearer': return new OrbVisual(g, entity, ctx, '#6a3d9a', 'curse')
        case 'sage': return new OrbVisual(g, entity, ctx, '#8ee6a0', 'seed')
        default: return new BoltVisual(g, entity, ctx, 'plain')
      }
    }
    if (entity.visual === 'bolt' && !entity.box) return new BoltVisual(g, entity, ctx, 'plain')
    if (entity.box && entity.visual === 'bolt') return new SlabVisual(g, entity)
    return new GroundShapeVisual(g)
  }
}
