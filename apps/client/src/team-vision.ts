import {
  canSeeBody,
  createVision,
  DEFAULT_VISION_SYSTEM,
  GAME_VISION_RANGE,
  visionSystems,
  type Terrain,
  type VisionGround,
  type VisionMask,
  type VisionSystem,
  type VisionView,
} from '../../../packages/shared/src/index.ts'
import type { RenderedCharacter, RenderedEntity } from './game-state.ts'

// The bushes of the ground, which is all that `TeamVision` asks of it for them: a `Terrain` is one.
export type Bushes = Pick<Terrain, 'bushAt'>

// What the local player's team sees, and so what the page shows: from where its living champions are drawn, a vision
// system (see vision.ts in shared) works out what they see together, and what is not seen is darkened (`FogLayer`) and
// what stands in it is left out: an enemy, a monster or a shot is only drawn where the team can see it. The team's own
// champions, turrets and core, and what they have put out, are always drawn. Anyone is seen where they are touching the light: a body counts
// as seen if its middle, or any furthest point of it, is.
//
// A bush is the one place the light does not show: whoever stands in one (their middle in it) is hidden from every team that has no living
// champion in the same bush, however near and however well lit. The team's own, and a turret or a core, are never hidden by one. What is shot
// across a bush is still seen, as it is only a body that stands in one that is hidden.
//
// There is no darkness, and everything is drawn, when there is no system (`?vision=off`), when the debug view is on, and
// when the team has no one alive to see from (a player who is dead sees the whole game, until they are back).
//
// This is how the page looks and what it lets the player aim at, not a rule of the game: every client plays the whole game
// from everything every other sends, so one that is changed to show it all can.
export class TeamVision {
  private view: VisionView | undefined
  private team: number | undefined
  private readonly teamOf = new Map<number, number>()
  // The bushes that someone of the team is standing in (see `Terrain.bushAt`), which the team sees into.
  private readonly occupied = new Set<number>()

  constructor(
    private readonly system: VisionSystem | undefined,
    private readonly bushes?: Bushes,
  ) {}

  // The name of the system, or "off".
  get name(): string {
    return this.system?.name ?? 'off'
  }

  // Works out what the team sees, from where its champions are drawn now. Call it each frame before anything asks.
  update(characters: readonly RenderedCharacter[], localTeam: number | undefined, options: { reveal?: boolean } = {}): void {
    this.team = localTeam
    this.view = undefined
    this.teamOf.clear()
    this.occupied.clear()
    for (const character of characters) this.teamOf.set(character.id, character.team)
    if (!this.system || options.reveal || localTeam === undefined) return
    // The team looks from its living champions and from its standing turrets (its core is one), each as far as its own range: a champion's is
    // `GAME_VISION_RANGE`, a turret's is its tier's. A team with no champion alive still sees the whole game, until one is back, whatever turrets it has:
    // they add to what a team sees, and are not what keeps it from seeing nothing.
    const alive = characters.filter((character) => character.team === localTeam && !character.dead)
    if (!alive.some((character) => !character.turret)) return
    if (this.bushes) {
      for (const character of alive) {
        const bush = this.bushes.bushAt(character.position)
        if (bush !== undefined) this.occupied.add(bush)
      }
    }
    this.view = this.system.see(alive.map((character) => ({
      position: character.position,
      range: character.turret?.visionRange ?? GAME_VISION_RANGE,
    })))
  }

  // The picture of what is seen, for the darkness: none when everything is shown.
  get mask(): VisionMask | undefined {
    return this.view?.mask
  }

  isVisible(character: RenderedCharacter): boolean {
    if (!this.view || character.team === this.team) return true
    // An enemy that is invisible is not seen, however near: it is what the status is.
    if (character.invisible) return false
    if (!character.turret && this.isHiddenByBush(character.position)) return false
    return canSeeBody(this.view, character.position, character.champion.radius)
  }

  // Whether a body whose middle is here is in a bush that none of the team is in.
  private isHiddenByBush(position: { x: number; y: number }): boolean {
    const bush = this.bushes?.bushAt(position)
    return bush !== undefined && !this.occupied.has(bush)
  }

  isEntityVisible(entity: RenderedEntity): boolean {
    if (!this.view) return true
    // What a champion of the team has put out is the team's.
    if (this.teamOf.get(entity.ownerId) === this.team) return true
    return canSeeBody(this.view, entity.position, entity.radius)
  }

  visibleCharacters(characters: readonly RenderedCharacter[]): RenderedCharacter[] {
    return this.view ? characters.filter((character) => this.isVisible(character)) : [...characters]
  }

  // The ones `visibleCharacters` leaves out. The page hands them on to be kept, not drawn (see `WorldFrame.unseen`).
  hiddenCharacters(characters: readonly RenderedCharacter[]): RenderedCharacter[] {
    return this.view ? characters.filter((character) => !this.isVisible(character)) : []
  }

  visibleEntities(entities: readonly RenderedEntity[]): RenderedEntity[] {
    return this.view ? entities.filter((entity) => this.isEntityVisible(entity)) : [...entities]
  }
}

// Which system the page asks for in its address (`?vision=range`): by name, "off" for none, and the default when it says
// nothing.
export function visionNameFromSearch(search: string): string {
  const name = new URLSearchParams(search).get('vision')?.trim().toLowerCase()
  return name || DEFAULT_VISION_SYSTEM
}

// The team's vision on this ground, with the system the address asks for. One it does not have is said in the console and
// the default used, so a typo is not a game with no vision.
// The ground is a `Terrain` in a game, and its bushes hide what stands in them; a ground that is only the size and the walls has none.
export function createTeamVision(ground: VisionGround & Partial<Bushes>, search = ''): TeamVision {
  const name = visionNameFromSearch(search)
  const bushes = ground.bushAt ? (ground as Bushes) : undefined
  if (name === 'off') return new TeamVision(undefined, bushes)
  if (!visionSystems.has(name)) {
    console.warn(`There is no vision system called "${name}" (there are ${[...visionSystems.keys()].join(', ')}, and off), so "${DEFAULT_VISION_SYSTEM}" is used.`)
    return new TeamVision(createVision(ground), bushes)
  }
  return new TeamVision(createVision(ground, name), bushes)
}
