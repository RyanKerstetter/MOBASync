import type { RenderedCharacter } from '../game-state.ts'

// What is left of a monster or a structure after it dies: the nameplate (its name and bars) goes at once, and the body lies where it fell, with its
// death animation played out, for a moment, and then is gone. A monster that comes back (it respawns) is drawn again from its first frame;
// a structure (a turret, or the core of a base) never does, as it is destroyed for good, and its collapse is the last that is seen of it.
// A player's champion is not a corpse: it stays as a ghost until it respawns, so it has no say in this.

// How long a dead monster's or structure's body stays, in seconds from the tick it died: long enough for its death animation to play out (the
// slime's is under a second, the golem's one, a tower's a little over) and to be seen lying there a moment more.
export const CORPSE_SECONDS = 2

export type CorpseView = {
  // Whether its body is drawn.
  body: boolean
  // Whether its name, health bar and the rest over it are drawn.
  nameplate: boolean
}

export function layoutCorpse(character: Pick<RenderedCharacter, 'dead' | 'monster' | 'turret' | 'deadForSeconds'>): CorpseView {
  if (!character.dead || !(character.monster || character.turret)) return { body: true, nameplate: true }
  return { body: (character.deadForSeconds ?? 0) < CORPSE_SECONDS, nameplate: false }
}
