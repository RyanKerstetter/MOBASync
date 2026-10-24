import { Container, Graphics, Text } from 'pixi.js'
import { GAME_FLAG_RADIUS, getTeam } from '../../../../packages/shared/src/index.ts'
import type { RenderedCharacter } from '../game-state.ts'
import type { FlagView, HillView, ModeView } from '../ui/mode-hud.ts'

const NEUTRAL_COLOR = '#c9d6e4'
const OUTLINE_COLOR = '#0b1220'
const POLE_HEIGHT = 64

// What the game mode puts on the map: the hill, with a fill that grows from its middle in the colour of the
// team whose bar it is, and the flags, at their bases, on the ground where they were dropped, or carried by a
// champion, who also gets a ring in the flag's colour so a carrier is easy to pick out in a crowd. It draws
// nothing in team deathmatch.
//
// It has two containers for the world renderer to place: `ground`, under the champions, and `above`, over
// them, for the flag a champion carries.
export class ObjectiveLayer {
  readonly ground = new Container()
  readonly above = new Container()
  private readonly groundShapes = new Graphics()
  private readonly aboveShapes = new Graphics()
  private readonly hillText = new Text({
    text: '',
    style: {
      fill: '#ffffff',
      fontSize: 40,
      fontWeight: '700',
      fontFamily: 'Arial',
      stroke: { color: OUTLINE_COLOR, width: 5 },
    },
  })

  constructor() {
    this.hillText.anchor.set(0.5)
    this.hillText.visible = false
    this.ground.addChild(this.groundShapes, this.hillText)
    this.above.addChild(this.aboveShapes)
  }

  update(view: ModeView | undefined, characters: readonly RenderedCharacter[], now: number): void {
    this.groundShapes.clear()
    this.aboveShapes.clear()
    this.hillText.visible = false
    if (view?.kind === 'koth') this.drawHill(view, now)
    else if (view?.kind === 'ctf') this.drawFlags(view.flags, characters, now)
  }

  private drawHill(view: HillView, now: number): void {
    const { hill } = view
    const centerX = hill.x + hill.width / 2
    const centerY = hill.y + hill.height / 2
    // The hill at a share of its size, round its middle.
    const outline = (g: Graphics, share: number): Graphics => hill.ellipse
      ? g.ellipse(centerX, centerY, hill.width / 2 * share, hill.height / 2 * share)
      : g.rect(centerX - hill.width / 2 * share, centerY - hill.height / 2 * share, hill.width * share, hill.height * share)
    const held = view.owner !== undefined
    const color = view.capturer === undefined ? NEUTRAL_COLOR : getTeam(view.capturer).color
    // A contested hill flickers, so it reads as a fight even from the corner of the eye.
    const flicker = view.contested ? 0.35 + 0.35 * Math.abs(Math.sin(now / 160)) : 0
    outline(this.groundShapes, 1)
      .fill({ color: NEUTRAL_COLOR, alpha: 0.07 })
      .stroke({ color: held ? color : NEUTRAL_COLOR, width: held ? 6 : 3, alpha: held ? 0.95 : 0.55 + flicker * 0.4 })
    if (view.fraction > 0) {
      outline(this.groundShapes, view.fraction).fill({ color, alpha: held ? 0.38 : 0.28 })
    }
    // The share is written over the top of the hill, where champions standing on it do not cover it.
    if (view.fraction > 0 && !held) {
      this.hillText.text = `${Math.floor(view.fraction * 100)}%`
      this.hillText.position.set(centerX, hill.y - 30)
      this.hillText.visible = true
    }
  }

  private drawFlags(flags: readonly FlagView[], characters: readonly RenderedCharacter[], now: number): void {
    for (const flag of flags) {
      const color = getTeam(flag.team).color
      const atHome = flag.status === 'home'
      // The base is marked whether or not the flag is in it, fainter when it is away.
      this.groundShapes
        .circle(flag.home.x, flag.home.y, GAME_FLAG_RADIUS)
        .fill({ color, alpha: atHome ? 0.22 : 0.07 })
        .stroke({ color, width: 3, alpha: atHome ? 0.9 : 0.4 })

      if (flag.status === 'home') {
        drawFlagPole(this.groundShapes, flag.home.x, flag.home.y, color, 1, now)
      } else if (flag.status === 'dropped') {
        // On the ground where it fell, with a ring that opens and closes to say it can be picked up or returned.
        const pulse = 0.5 + 0.5 * Math.sin(now / 200)
        this.groundShapes
          .circle(flag.position.x, flag.position.y, GAME_FLAG_RADIUS + pulse * 14)
          .stroke({ color, width: 3, alpha: 0.9 - pulse * 0.4 })
        drawFlagPole(this.groundShapes, flag.position.x, flag.position.y, color, 0.9, now)
      } else {
        const carrier = characters.find((character) => character.id === flag.carrier?.id)
        const at = carrier?.position ?? flag.position
        const radius = carrier?.champion.radius ?? 20
        this.groundShapes
          .circle(at.x, at.y, radius + 10 + (0.5 + 0.5 * Math.sin(now / 180)) * 5)
          .stroke({ color, width: 4, alpha: 0.95 })
        // Held at its side, over the champion.
        drawFlagPole(this.aboveShapes, at.x + radius + 10, at.y + 12, color, 1, now)
      }
    }
  }
}

// A flag standing with the foot of its pole at (x, y): a pole and a banner in the team's colour, which
// ripples. `scale` shrinks it for a flag that is carried.
function drawFlagPole(g: Graphics, x: number, y: number, color: string, scale: number, now: number): void {
  const height = POLE_HEIGHT * scale
  const ripple = Math.sin(now / 220) * 4 * scale
  g.moveTo(x, y).lineTo(x, y - height).stroke({ color: OUTLINE_COLOR, width: 7 * scale })
  g.moveTo(x, y).lineTo(x, y - height).stroke({ color: '#e8f4ff', width: 3.5 * scale })
  g.poly([x, y - height, x + 42 * scale, y - height + 13 * scale + ripple, x, y - height + 28 * scale])
    .fill({ color })
    .stroke({ color: OUTLINE_COLOR, width: 2.5 })
}
