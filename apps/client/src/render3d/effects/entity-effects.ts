import { Group, type Texture } from 'three'
import { GAME_TPS, getEntityDef, getTeam } from '../../../../../packages/shared/src/index.ts'
import type { RenderedEntity } from '../../game-state.ts'
import { BubbleVisual, BurningGroundVisual, FireBlastVisual, FireballVisual, FireRuneVisual, FireTornadoVisual, FlameWallVisual, GeyserVisual, WaveVisual, WellVisual } from './elemental.ts'
import { emberTexture } from './fx-materials.ts'
import {
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
import {
  BladeBurstVisual,
  BladeKnifeVisual,
  BloodTrailVisual,
  ClawMarkVisual,
  DawnBeamVisual,
  DawnstepVisual,
  GroundKnifeVisual,
  HowlVisual,
  RakeSlashVisual,
  SmiteVisual,
  SpiderMineVisual,
  SpiderVisual,
  TetherVisual,
  VenomBiteVisual,
} from './kits-melee.ts'
import {
  ArrowRainImpactVisual,
  ArrowRainVisual,
  BloodGlobVisual,
  BloodPactVisual,
  BloodShardsVisual,
  CoagulateVisual,
  CrossbowBoltVisual,
  CrystalArrowVisual,
  CrystalBurstVisual,
  FletchedArrowVisual,
  ScanVisual,
  SniperShotVisual,
} from './kits-ranged.ts'
import { BoltVisual, GroundShapeVisual, SlabVisual, type EffectContext, type Visual } from './visual.ts'

// How long a mine is seen by everyone before it hides (`EntityDef.ownTeamOnly`), in seconds.
const shownFor = (defId: string): number => {
  const only = getEntityDef(defId)?.ownTeamOnly
  return typeof only === 'object' ? only.afterTicks / GAME_TPS : 0
}

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
  // The Hellhound.
  'rake-shot': (g, entity) => new RakeSlashVisual(g, entity, false),
  'rake-again-shot': (g, entity) => new RakeSlashVisual(g, entity, true),
  'rake-hit': (g, entity, ctx) => new ClawMarkVisual(g, entity, ctx, 'plain'),
  'rake-hit-bleed': (g, entity, ctx) => new ClawMarkVisual(g, entity, ctx, 'bleed'),
  'rake-final-hit': (g, entity, ctx) => new ClawMarkVisual(g, entity, ctx, 'final'),
  'howl-wave': (g, entity) => new HowlVisual(g, entity),
  'blood-trail': (g, entity) => new BloodTrailVisual(g, entity),
  // Stone.
  'tether-shot': (g, entity, ctx) => new TetherVisual(g, entity, ctx),
  // The Vulture.
  'spider-mine': (g, entity) => new SpiderMineVisual(g, entity, shownFor(entity.defId)),
  'mine-spider': (g, entity) => new SpiderVisual(g, entity),
  'mine-bite': (g, entity, ctx) => new VenomBiteVisual(g, entity, ctx),
  // Blade.
  'thrown-knife': (g, entity, ctx) => new BladeKnifeVisual(g, entity, ctx, true),
  'recalled-knife': (g, entity, ctx) => new BladeKnifeVisual(g, entity, ctx, false),
  'ground-knife': (g, entity, ctx) => new GroundKnifeVisual(g, entity, ctx),
  'bladedash-burst': (g, entity, ctx) => new BladeBurstVisual(g, entity, ctx),
  // Sanguine.
  'blood-shot': (g, entity, ctx) => new BloodGlobVisual(g, entity, ctx),
  'blood-pact': (g) => new BloodPactVisual(g),
  'coagulate': (g) => new CoagulateVisual(g),
  'blood-shards': (g, entity, ctx) => new BloodShardsVisual(g, entity, ctx),
  // The Hunter.
  'volley-arrow': (g, entity, ctx) => new FletchedArrowVisual(g, entity, ctx, '#9bd36d', 0.9, 'leaves'),
  'disengage-arrow': (g, entity, ctx) => new FletchedArrowVisual(g, entity, ctx, '#7bd88f', 1.4, 'vines'),
  'arrow-rain': (g, entity) => new ArrowRainVisual(g, entity),
  'arrow-rain-impact': (g, entity, ctx) => new ArrowRainImpactVisual(g, entity, ctx),
  // Crystal.
  'crystal-bolt': (g, entity, ctx) => new CrystalArrowVisual(g, entity, ctx, true),
  'shard-burst': (g, entity, ctx) => new CrystalBurstVisual(g, entity, ctx, false),
  'shatter-burst': (g, entity, ctx) => new CrystalBurstVisual(g, entity, ctx, true),
  // Sorin.
  'dawn-beam': (g, entity, ctx) => new DawnBeamVisual(g, entity, ctx),
  'dawnstep-flash': (g, entity, ctx) => new DawnstepVisual(g, entity, ctx),
  'smite-hit': (g, entity) => new SmiteVisual(g, entity, false),
  'smite-final': (g, entity) => new SmiteVisual(g, entity, true),
  // The Sniper.
  'scan': (g) => new ScanVisual(g),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`steady-shot-${index + 1}`, (g: Group, entity: RenderedEntity, ctx: EffectContext) => new SniperShotVisual(g, entity, ctx)])),
}

// Which visual an entity is drawn by: its ID and the tick it was spawned on. An entity spawned again under the same ID (one a champion can have only one of, such as
// the Ninja's shadow, which a Shadow Return through an enemy leaves anew where it was cast from) is a new entity, with a new visual made where it is now, while the
// old one ends where it was. Without the tick, a visual placed once when it is made (most that stand still are) would stay where the old one stood. An entity that
// moves keeps its spawn tick as it goes, so its visual is never made again.
export function visualKey(entity: Pick<RenderedEntity, 'id' | 'startTick'>): string {
  return `${entity.id}@${entity.startTick}`
}

export class EntityEffects3D {
  readonly group = new Group()
  // By `visualKey`.
  private readonly visuals = new Map<string, Visual | null>()
  private readonly ending: Visual[] = []
  private readonly embers = emberTexture()

  update(entities: readonly RenderedEntity[], ctx: EffectContext): void {
    const active = new Set<string>()
    for (const entity of entities) {
      const key = visualKey(entity)
      active.add(key)
      let visual = this.visuals.get(key)
      if (visual === undefined) {
        visual = this.make(entity, ctx)
        this.visuals.set(key, visual)
      }
      if (visual && !visual.step(entity, ctx)) {
        visual.dispose()
        this.visuals.set(key, null)
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
    // A primed throw of the Grenadier's (`-primed`) is drawn as the plain one is, at its own size.
    const dedicated = ENTITY_VISUALS[entity.defId] ?? ENTITY_VISUALS[entity.defId.replace(/-primed$/, '')]
    if (dedicated) return dedicated(g, entity, ctx, this.embers)
    if (entity.visual === 'hidden') return null
    // An auto attack's shot, by whose it is.
    if (entity.defId.startsWith('auto-shot')) {
      if (ownerCharacter?.turret) return new TowerBoltVisual(g, entity, ctx, getTeam(ownerCharacter.team).color)
      switch (owner) {
        case 'firemage': return new BoltVisual(g, entity, ctx, 'fire')
        case 'capricorn': return new BoltVisual(g, entity, ctx, 'water', (ownerCharacter?.stacks.empowered ?? 0) > 0)
        case 'archer': return new CrossbowBoltVisual(g, entity, ctx, '#6dd39b')
        case 'hunter': return new FletchedArrowVisual(g, entity, ctx, '#9bd36d', 1, (ownerCharacter?.stacks.volley ?? 0) > 0 ? 'leaves' : 'spark')
        case 'crystal': return new CrystalArrowVisual(g, entity, ctx, false)
        case 'sanguine': return new BloodGlobVisual(g, entity, ctx)
        case 'sniper': return new TracerVisual(g, entity, ctx)
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
