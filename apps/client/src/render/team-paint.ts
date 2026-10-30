// Painting a sprite in the colour of a team. A tower or a keep is the same art for every team, with a flag on top that is drawn in two colours the art
// uses for nothing else: a bright one for the cloth and a darker one for its shade (`SpriteSet.teamPaint`). To show whose it is, every pixel of exactly those
// colours is repainted in the team's colour, and a shade made from it, and nothing else in the picture changes. This file is only that colour work, on
// plain numbers: reading a sheet into pixels and drawing the result is the sprite loader's (`teamVariant`, character-sprite.ts).
//
// The art is pixel art with no soft edges (a pixel is fully there or not there at all, which is what makes an exact colour a safe thing to swap), and
// a pixel that is not there at all is left alone.

export type Rgb = readonly [red: number, green: number, blue: number]

// The two colours in the art that stand for the team, as `#rrggbb`.
export type PaintKey = { primary: string; shade: string }

// One colour in the art, and what it is painted as.
export type ColourSwap = { from: Rgb; to: Rgb }

// `#rrggbb` as three numbers from 0 to 255, or none for anything that is not that.
export function parseHex(hex: string): Rgb | undefined {
  const found = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return found ? [parseInt(found[1], 16), parseInt(found[2], 16), parseInt(found[3], 16)] : undefined
}

export function toHex(color: Rgb): string {
  return `#${color.map((part) => Math.round(Math.max(0, Math.min(255, part))).toString(16).padStart(2, '0')).join('')}`
}

type Hsl = { hue: number; saturation: number; lightness: number }

function toHsl([red, green, blue]: Rgb): Hsl {
  const [r, g, b] = [red / 255, green / 255, blue / 255]
  const most = Math.max(r, g, b)
  const least = Math.min(r, g, b)
  const lightness = (most + least) / 2
  if (most === least) return { hue: 0, saturation: 0, lightness }
  const spread = most - least
  const saturation = lightness > 0.5 ? spread / (2 - most - least) : spread / (most + least)
  const hue = most === r ? (g - b) / spread + (g < b ? 6 : 0) : most === g ? (b - r) / spread + 2 : (r - g) / spread + 4
  return { hue: hue / 6, saturation, lightness }
}

function fromHsl({ hue, saturation, lightness }: Hsl): Rgb {
  if (saturation === 0) return [lightness * 255, lightness * 255, lightness * 255].map(Math.round) as unknown as Rgb
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (offset: number): number => {
    const t = (hue + offset + 1) % 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [channel(1 / 3), channel(0), channel(-1 / 3)].map((value) => Math.round(value * 255)) as unknown as Rgb
}

// The colours a team's flag is painted in: the cloth is the team's colour itself, the same one its name and its rings are drawn in, and the shade is that
// colour made darker and a little greyer in the very proportions the art does it (its shade colour is the cloth colour at some share of its lightness and
// some share of its saturation, so those shares are read off the art and put on the team's colour). A key or a colour that is not `#rrggbb` is not painted.
export function teamSwaps(teamColor: string, key: PaintKey): ColourSwap[] {
  const team = parseHex(teamColor)
  const primary = parseHex(key.primary)
  const shade = parseHex(key.shade)
  if (!team || !primary || !shade) return []
  const cloth = toHsl(primary)
  const dark = toHsl(shade)
  const mine = toHsl(team)
  const lightness = cloth.lightness > 0 ? dark.lightness / cloth.lightness : 1
  const saturation = cloth.saturation > 0 ? dark.saturation / cloth.saturation : 1
  const painted = fromHsl({
    hue: mine.hue,
    saturation: Math.min(1, mine.saturation * saturation),
    lightness: Math.min(1, mine.lightness * lightness),
  })
  return [{ from: primary, to: team }, { from: shade, to: painted }]
}

// Repaints, in place, every pixel of these RGBA bytes that is exactly the colour of one of the swaps, in what the swap says. Its alpha, and every pixel
// that is any other colour, are as they were, and so is one that is not there at all (alpha 0). Each pixel is looked at once, as it was, so a colour
// that one swap paints is never painted again by another. Returns how many pixels it repainted.
export function repaint(pixels: Uint8ClampedArray | Uint8Array, swaps: readonly ColourSwap[]): number {
  let repainted = 0
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    if (pixels[at + 3] === 0) continue
    const red = pixels[at]
    const green = pixels[at + 1]
    const blue = pixels[at + 2]
    for (const { from, to } of swaps) {
      if (from[0] !== red || from[1] !== green || from[2] !== blue) continue
      pixels[at] = to[0]
      pixels[at + 1] = to[1]
      pixels[at + 2] = to[2]
      repainted += 1
      break
    }
  }
  return repainted
}
