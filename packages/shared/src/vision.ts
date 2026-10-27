import type { Vector2 } from './index.js'
import type { Rect } from './terrain.js'

// Vision: what a team can see. The page draws what it cannot as darkness, and leaves out what stands in it (see
// `TeamVision` in the client). How it is worked out is a `VisionSystem`, so another way of working it out is another
// system, and nothing else changes: the page asks a system for what a team sees (`see`) and gets back a `VisionView`
// that answers one question, whether a point is seen, and gives the picture of it the darkness is drawn from (the
// `VisionMask`). The same shape as the pathfinder (pathfinding.ts), and for the same reason: the page does not care how.
//
// To try a new system, write a `VisionFactory` and put it in `visionSystems` (vision-systems.ts), and the page uses it
// when its address says `?vision=<its name>`. `tests/vision-contract.ts` is what any system has to pass
// (`visionContract(name, factory)`), so it can be dropped in with some confidence that nothing else breaks.
//
// A system is used for the picture and for the page's own targeting: it is not part of the simulation (the server does
// not hide anything from anyone, because every client plays the whole game: see README, "Vision"). A system that is
// worked out with whole numbers alone would give the same answer on every machine, and so could be used by rules one
// day. The tile system is one; one that uses trig would not be.

// A place a team sees from: where a champion is, in world units, and how far it sees.
export type SightViewer = { position: Vector2; range: number }

// What the viewers see together, as a picture the darkness is drawn from. Today a picture is a grid of cells: each
// `cell` world units across, from the world's origin, `cols` by `rows`, row by row from the top left, a 1 for a cell that is
// seen and a 0 for one that is not. The page draws it smoothly, so a system with cells of a few units draws as
// well as any. Another kind of picture (polygons, say) is another member of this type, and a place for the page to draw it
// (render/fog-layer.ts), which the compiler asks for; until then a system draws its view into cells at whatever size it likes.
export type VisionMask = {
  kind: 'cells'
  cell: number
  cols: number
  rows: number
  data: Uint8Array
  // Counts up whenever `data` changes, so the page uploads a picture to the screen only when it is new.
  revision: number
}

// What the viewers of one call of `see` see.
export interface VisionView {
  // Whether this point is seen. A point outside the ground is not.
  canSee(point: Vector2): boolean
  readonly mask: VisionMask
}

export interface VisionSystem {
  // What it is called, in `?vision=` and in the logs.
  readonly name: string
  // What the viewers see together: a point is seen if any of them sees it. A view is good until the next call, which is
  // free to reuse the same memory for it. No viewers see nothing.
  see(viewers: readonly SightViewer[]): VisionView
}

// What a system is given of the ground: its size and its walls, which a `Terrain` has. They never change in a game.
export type VisionGround = { readonly width: number; readonly height: number; readonly walls: readonly Rect[] }

export type VisionFactory = (ground: VisionGround) => VisionSystem

// Whether a body is seen: its middle, or any of the four furthest points of it. A champion whose middle is in the dark
// but whose edge is lit round a corner is seen, as it would be by anyone looking at it.
export function canSeeBody(view: Pick<VisionView, 'canSee'>, middle: Vector2, radius: number): boolean {
  return view.canSee(middle)
    || view.canSee({ x: middle.x + radius, y: middle.y })
    || view.canSee({ x: middle.x - radius, y: middle.y })
    || view.canSee({ x: middle.x, y: middle.y + radius })
    || view.canSee({ x: middle.x, y: middle.y - radius })
}
