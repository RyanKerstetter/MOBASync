import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  SRGBColorSpace,
  type BufferAttribute,
  type BufferGeometry,
  type Group,
  type Material,
  type Object3D,
  type Texture,
} from 'three'
import { CapsuleGeometry, ConeGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from './shapes.ts'
import { smoothstep } from '../../space.ts'
import { approach, joint } from '../model.ts'
import { lathe, radiusAt, Sculpt, shaped, type Detail, type DetailKit, type Rig, type Triple } from './kit.ts'
import type { Look } from '../looks.ts'

// The Swordsman, in full: a knight in plate, built piece by piece on the humanoid's skeleton (see humanoid.ts), which still poses
// it. Fluted breastplate with a plackart and a sun on the chest, a gorget, layered pauldrons that lift with the arms, couters and
// poleyns with fans, greaves and segmented sabatons, articulated gauntlets, a visored helm with a comb and a plume, a heraldic
// tabard and a long cape that drapes and blows, an empty scabbard at the hip, and a longsword with a diamond blade, a runed
// fuller, curved quillons and a wheel pommel.
//
// The static pieces on each joint are merged by material into one mesh (a few dozen draws, not hundreds); what moves on its own
// (the cape, the tabard, the plume, the pauldrons) is kept apart.

// ---------------------------------------------------------------------------------------------------------------- heraldry

const heraldry = new Map<string, Texture | undefined>()

// The knight's heraldry, painted once for its colours: a field of its cloth with a border of gold, and a sun pierced by a sword.
// `kind` is the cape (tall, the sun large and low on the back) or the tabard (narrow, the sun near the top).
function heraldryTexture(kind: 'cape' | 'tabard', cloth: string, gold: string): Texture | undefined {
  const key = `${kind}|${cloth}|${gold}`
  if (heraldry.has(key)) return heraldry.get(key)
  if (typeof document === 'undefined') return undefined
  const width = kind === 'cape' ? 256 : 128
  const height = kind === 'cape' ? 512 : 256
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const paint = canvas.getContext('2d')
  if (!paint) return undefined
  const field = new Color(cloth)
  const dark = field.clone().multiplyScalar(0.62).getStyle()
  const light = field.clone().lerp(new Color('#ffffff'), 0.12).getStyle()

  // The cloth, shaded a little darker toward its edges and in the hollows of its folds, with a fine weave.
  const across = paint.createLinearGradient(0, 0, width, 0)
  across.addColorStop(0, dark)
  across.addColorStop(0.18, cloth)
  across.addColorStop(0.5, light)
  across.addColorStop(0.82, cloth)
  across.addColorStop(1, dark)
  paint.fillStyle = across
  paint.fillRect(0, 0, width, height)
  for (let y = 0; y < height; y += 2) {
    paint.fillStyle = `rgba(0,0,0,${y % 4 === 0 ? 0.05 : 0.02})`
    paint.fillRect(0, y, width, 1)
  }
  for (let x = 0; x < width; x += 2) {
    paint.fillStyle = 'rgba(255,255,255,0.025)'
    paint.fillRect(x, 0, 1, height)
  }

  // A border of gold down the sides and along the hem, with a row of diamonds in the hem, and a thin line inside it.
  const scale = width / 128
  const side = 5 * scale
  const hem = (kind === 'cape' ? 20 : 14) * scale
  paint.fillStyle = gold
  paint.fillRect(0, 0, side, height)
  paint.fillRect(width - side, 0, side, height)
  paint.fillRect(0, height - hem, width, hem)
  paint.fillStyle = dark
  const diamond = hem * 0.32
  for (let x = diamond * 1.6; x < width; x += diamond * 2.4) {
    paint.beginPath()
    paint.moveTo(x, height - hem / 2 - diamond)
    paint.lineTo(x + diamond * 0.75, height - hem / 2)
    paint.lineTo(x, height - hem / 2 + diamond)
    paint.lineTo(x - diamond * 0.75, height - hem / 2)
    paint.closePath()
    paint.fill()
  }
  paint.strokeStyle = gold
  paint.lineWidth = 1.5 * scale
  const inset = side + 4 * scale
  paint.strokeRect(inset, -10, width - inset * 2, height - hem - 4 * scale + 10)

  // The sun and the sword, outlined dark so they read from far off.
  const cx = width / 2
  const cy = kind === 'cape' ? height * 0.42 : height * 0.3
  const r = (kind === 'cape' ? 30 : 17) * scale / (kind === 'cape' ? 2 : 1)
  const sun = new Path2D()
  const rays = 16
  for (let index = 0; index <= rays * 2; index += 1) {
    const angle = index / (rays * 2) * Math.PI * 2 - Math.PI / 2
    const reach = index % 2 === 0 ? r * (index % 4 === 0 ? 1.95 : 1.6) : r * 1.12
    const x = cx + Math.cos(angle) * reach
    const y = cy + Math.sin(angle) * reach
    if (index === 0) sun.moveTo(x, y)
    else sun.lineTo(x, y)
  }
  sun.closePath()
  paint.lineJoin = 'round'
  paint.strokeStyle = dark
  paint.lineWidth = 3 * scale
  paint.stroke(sun)
  paint.fillStyle = gold
  paint.fill(sun)
  paint.beginPath()
  paint.arc(cx, cy, r * 0.82, 0, Math.PI * 2)
  paint.fillStyle = dark
  paint.fill()
  paint.beginPath()
  paint.arc(cx, cy, r * 0.68, 0, Math.PI * 2)
  paint.fillStyle = gold
  paint.fill()

  const blade = r * 0.2
  const top = cy - r * 2.6
  const bottom = cy + r * 2.9
  const sword = new Path2D()
  sword.moveTo(cx, bottom + blade * 2.2)
  sword.lineTo(cx + blade, bottom)
  sword.lineTo(cx + blade, top + r * 0.9)
  sword.lineTo(cx + r * 0.75, top + r * 0.9)
  sword.lineTo(cx + r * 0.75, top + r * 0.62)
  sword.lineTo(cx + blade * 0.6, top + r * 0.62)
  sword.lineTo(cx + blade * 0.6, top + r * 0.1)
  sword.lineTo(cx - blade * 0.6, top + r * 0.1)
  sword.lineTo(cx - blade * 0.6, top + r * 0.62)
  sword.lineTo(cx - r * 0.75, top + r * 0.62)
  sword.lineTo(cx - r * 0.75, top + r * 0.9)
  sword.lineTo(cx - blade, top + r * 0.9)
  sword.lineTo(cx - blade, bottom)
  sword.closePath()
  paint.stroke(sword)
  paint.fillStyle = '#e8edf2'
  paint.fill(sword)
  paint.beginPath()
  paint.arc(cx, top, r * 0.2, 0, Math.PI * 2)
  paint.fillStyle = gold
  paint.fill()
  paint.stroke()

  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  heraldry.set(key, texture)
  return texture
}

// ---------------------------------------------------------------------------------------------------------------- the knight

export function knight(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const sculpt = new Sculpt(kit, rig, look, b)
  const add = (parent: Object3D, material: Material, geometry: BufferGeometry, shadow = true): void => sculpt.add(parent, material, geometry, shadow)

  // ---- what it is made of
  const steel = kit.surface('#c9d0d9', { roughness: 0.3, metalness: 0.7, side: DoubleSide })
  const darkSteel = kit.surface('#4e555f', { roughness: 0.5, metalness: 0.65 })
  const mail = kit.surface('#666d77', { roughness: 0.7, metalness: 0.55, flatShading: true, side: DoubleSide })
  const gold = kit.surface(look.trim, { roughness: 0.3, metalness: 0.72 })
  const cloth = kit.surface(look.cloth, { roughness: 0.85 })
  const lining = kit.surface(new Color(look.cloth).multiplyScalar(0.55), { roughness: 0.9 })
  const leather = kit.surface('#5b3b22', { roughness: 0.8 })
  const darkLeather = kit.surface('#2f2019', { roughness: 0.9 })
  const shadowed = kit.surface('#07080a', { roughness: 1 })
  const plumeWhite = kit.surface('#eef1f6', { roughness: 0.8 })
  const gem = kit.surface(look.accent, { roughness: 0.15, metalness: 0.1, emissive: new Color(look.accent), emissiveIntensity: 0.9 })
  kit.glowing(gem, 0.9)
  const bladeSteel = kit.surface('#f2f5f8', { roughness: 0.24, metalness: 0.38, flatShading: true, emissive: new Color(look.accent), emissiveIntensity: 0.05 })
  kit.glowing(bladeSteel, 0.05)
  const rune = kit.surface('#353d48', { roughness: 0.4, metalness: 0.5, emissive: new Color(look.accent), emissiveIntensity: 0.35 })
  kit.glowing(rune, 0.35)
  const capeTexture = heraldryTexture('cape', look.cloth, look.trim)
  const tabardTexture = heraldryTexture('tabard', look.cloth, look.trim)
  // (Painted in the cloth's colour already, so not tinted again.)
  const capeOuter = kit.surface(capeTexture ? '#ffffff' : look.cloth, { roughness: 0.85, map: capeTexture ?? null })
  const tabardFront = kit.surface(tabardTexture ? '#ffffff' : look.cloth, { roughness: 0.85, map: tabardTexture ?? null })
  const rivet = (parent: Object3D, x: number, y: number, z: number, size = 0.009): void => add(parent, gold, shaped(new SphereGeometry(size, 6, 4), { at: [x, y, z] }), false)

  // ---- the torso: a fluted breastplate and backplate in one, a plackart over the belly, a sun on the chest, a gorget, the belt
  const { torso, hips, head } = rig
  const chest: Array<[number, number]> = [[0.163, -0.005], [0.172, 0.08], [0.2, 0.2], [0.222, 0.32], [0.222, 0.4], [0.2, 0.47], [0.15, 0.53], [0.09, 0.56]]
  const chestSize: Triple = [b, 1, 0.86 * b]
  // Where the front of the chest is at a height, and across it.
  const front = (y: number, x = 0): number => {
    const rx = radiusAt(chest, y) * b
    const rz = radiusAt(chest, y) * 0.86 * b
    return rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2))
  }
  add(torso, steel, shaped(lathe(chest, 28), { size: chestSize }))
  // The ridge down the middle, and a ridge either side of it, raised on the plate.
  for (const turn of [0, -0.62, 0.62]) {
    const ridge = chest.filter(([, y]) => y > 0.06 && y < 0.5).map(([r, y]): [number, number] => [r + 0.005, y])
    add(torso, steel, shaped(lathe(ridge, 3, turn - 0.03, 0.06), { size: chestSize }))
  }
  // The plackart: a plate over the belly, its top edge rolled in gold and riveted.
  const plackart = chest.filter(([, y]) => y < 0.26).map(([r, y]): [number, number] => [r + 0.011, y])
  plackart.push([radiusAt(chest, 0.25) + 0.011, 0.25])
  add(torso, steel, shaped(lathe(plackart, 18, -1.2, 2.4), { size: chestSize }))
  add(torso, gold, shaped(lathe([[radiusAt(chest, 0.24) + 0.016, 0.238], [radiusAt(chest, 0.26) + 0.016, 0.258]], 18, -1.22, 2.44), { size: chestSize }))
  for (let index = 0; index < 7; index += 1) {
    const turn = -1.0 + index / 6 * 2.0
    const r = radiusAt(chest, 0.248) + 0.02
    rivet(torso, Math.sin(turn) * r * b, 0.248, Math.cos(turn) * r * 0.86 * b)
  }
  // Gold round the neck and the waist.
  add(torso, gold, shaped(new TorusGeometry(0.152, 0.011, 6, 32), { turn: [Math.PI / 2, 0, 0], size: [b, 0.86 * b, 1], at: [0, 0.528, 0] }))
  // The sun on the chest: a disc, its rays, a gem in its middle.
  {
    const y = 0.375
    const z = front(y) + 0.006
    add(torso, gold, shaped(new CylinderGeometry(0.04, 0.04, 0.012, 20), { turn: [Math.PI / 2, 0, 0], at: [0, y, z] }))
    for (let index = 0; index < 12; index += 1) {
      const angle = index / 12 * Math.PI * 2
      const long = index % 2 === 0
      const reach = long ? 0.062 : 0.054
      const x = Math.cos(angle) * reach
      add(torso, gold, shaped(new ConeGeometry(long ? 0.011 : 0.008, long ? 0.04 : 0.028, 4), { size: [1, 1, 0.4], turn: [0, 0, angle - Math.PI / 2], at: [x, y + Math.sin(angle) * reach, front(y + Math.sin(angle) * reach, x) + 0.004] }))
    }
    add(torso, gem, shaped(new SphereGeometry(0.018, 10, 8), { size: [1, 1, 0.55], at: [0, y, z + 0.006] }), false)
  }
  // The faulds: bands of steel stepping out over the hips, the last edged in gold.
  for (let index = 0; index < 3; index += 1) {
    const top = 0.02 - index * 0.058
    const r = 0.178 + index * 0.013
    add(torso, steel, shaped(lathe([[r + 0.012, top - 0.072], [r, top]], 28), { size: [b, 1, 0.88 * b] }))
    if (index === 2) add(torso, gold, shaped(new TorusGeometry(r + 0.012, 0.007, 5, 32), { turn: [Math.PI / 2, 0, 0], size: [b, 0.88 * b, 1], at: [0, top - 0.072, 0] }))
  }
  // The sword belt, with its buckle.
  add(torso, leather, shaped(lathe([[0.186, 0.035], [0.184, 0.085]], 28), { size: [b, 1, 0.87 * b] }))
  {
    const z = 0.184 * 0.87 * b + 0.006
    add(torso, gold, shaped(new TorusGeometry(0.025, 0.006, 4, 4), { turn: [0, 0, Math.PI / 4], size: [1.1, 0.8, 1], at: [0, 0.06, z] }))
    add(torso, darkLeather, shaped(new BoxGeometry(0.05, 0.032, 0.006), { at: [0, 0.06, z - 0.002] }))
    add(torso, gold, shaped(new BoxGeometry(0.006, 0.04, 0.006), { at: [0, 0.06, z + 0.002] }))
  }
  // The gorget: two rings of steel up into the bottom of the helm, the top one edged in gold.
  for (const [low, high, y0, y1] of [[0.17, 0.15, 0.48, 0.53], [0.15, 0.136, 0.52, 0.568]] as const) {
    add(torso, steel, shaped(lathe([[low, y0], [high, y1]], 24), { size: [b, 1, 0.92] }))
  }
  add(torso, gold, shaped(new TorusGeometry(0.134, 0.005, 5, 28), { turn: [Math.PI / 2, 0, 0], size: [b, 0.92, 1], at: [0, 0.566, 0] }))
  // Rosettes at the back of the shoulders that the cape hangs from.
  for (const side of [-1, 1]) {
    const x = side * 0.13 * b
    const z = -front(0.5, x) - 0.012
    add(torso, gold, shaped(new CylinderGeometry(0.026, 0.026, 0.012, 12), { turn: [Math.PI / 2, 0, 0], at: [x, 0.5, z] }))
    add(torso, gem, shaped(new SphereGeometry(0.011, 8, 6), { at: [x, 0.5, z - 0.008] }), false)
  }

  // ---- the hips: a skirt of mail under the faulds, the tabard over it, and the scabbard at the left hip
  add(hips, mail, shaped(lathe([[0.212, -0.21], [0.19, -0.06], [0.178, 0.06]], 28), { size: [b, 1, 0.9 * b] }))
  add(hips, darkSteel, shaped(new TorusGeometry(0.212, 0.006, 4, 32), { turn: [Math.PI / 2, 0, 0], size: [b, 0.9 * b, 1], at: [0, -0.21, 0] }))
  const tabard = joint(hips, 0, 0.0, 0.205 * b)
  {
    const length = 0.5
    const panel = new Mesh(shaped(new BoxGeometry(0.25 * b, length, 0.012), { at: [0, -length / 2, 0] }), [cloth, cloth, cloth, cloth, tabardFront, lining])
    panel.castShadow = true
    panel.receiveShadow = true
    tabard.add(panel)
  }
  const scabbard = joint(hips, -0.215 * b, -0.02, 0.03)
  scabbard.rotation.set(0.6, 0, -0.14)
  {
    const sheath: Array<[number, number]> = [[0.004, -0.9], [0.02, -0.87], [0.03, -0.75], [0.035, -0.1], [0.036, 0]]
    add(scabbard, leather, shaped(lathe(sheath, 12), { size: [1, 1, 0.42] }))
    for (const [y0, y1] of [[-0.07, 0.012], [-0.46, -0.42]]) add(scabbard, gold, shaped(lathe([[0.039, y0], [0.039, y1]], 12), { size: [1, 1, 0.47] }))
    add(scabbard, gold, shaped(lathe([[0.003, -0.93], [0.022, -0.86], [0.03, -0.78]], 12), { size: [1, 1, 0.46] }))
    add(scabbard, shadowed, shaped(new CylinderGeometry(0.03, 0.03, 0.004, 12), { size: [1, 1, 0.36], at: [0, 0.013, 0] }), false)
    // The straps from the belt.
    add(scabbard, darkLeather, shaped(new BoxGeometry(0.075, 0.02, 0.022), { turn: [0, 0, 0.25], at: [0.035, -0.02, 0] }))
  }
  // A pouch at the back of the right hip.
  add(hips, leather, shaped(new BoxGeometry(0.08, 0.09, 0.05), { turn: [0, -0.5, 0], at: [0.17 * b, -0.04, -0.13 * b] }))
  add(hips, darkLeather, shaped(new BoxGeometry(0.084, 0.04, 0.054), { turn: [0, -0.5, 0], at: [0.17 * b, 0.0, -0.13 * b] }))
  rivet(hips, 0.17 * b - 0.012, -0.012, -0.13 * b - 0.026, 0.007)

  // ---- the legs: cuisses, poleyns with fans, greaves, sabatons of overlapping lames
  for (const { side, hip, knee } of rig.legs) {
    add(hip, steel, shaped(lathe([[0.078, -0.38], [0.091, -0.27], [0.099, -0.13], [0.095, -0.02]], 20), { size: [1, 1, 1.05] }))
    add(hip, steel, shaped(lathe([[0.104, -0.1], [0.1, -0.05]], 20), { size: [1, 1, 1.05] }))
    add(hip, gold, shaped(new TorusGeometry(0.104, 0.005, 4, 24), { turn: [Math.PI / 2, 0, 0], size: [1, 1.05, 1], at: [0, -0.1, 0] }))
    // The knee.
    add(knee, steel, shaped(new SphereGeometry(0.062, 16, 10), { size: [1, 1.05, 0.8], at: [0, 0, 0.042] }))
    add(knee, steel, shaped(lathe([[0.084, 0.02], [0.079, 0.075]], 20), { size: [1, 1, 1.05] }))
    add(knee, steel, shaped(lathe([[0.073, -0.085], [0.079, -0.03]], 20), { size: [1, 1, 1.05] }))
    add(knee, steel, shaped(new CylinderGeometry(0.052, 0.052, 0.009, 16), { turn: [0, 0, Math.PI / 2], size: [1, 1, 1.15], at: [side * 0.072, 0, 0.018] }))
    rivet(knee, side * 0.078, 0, 0.018, 0.012)
    rivet(knee, 0, 0, 0.094, 0.01)
    // The greave.
    add(knee, steel, shaped(lathe([[0.056, -0.42], [0.064, -0.32], [0.076, -0.17], [0.071, -0.07]], 20), { size: [1, 1, 1.07] }))
    add(knee, gold, shaped(new TorusGeometry(0.072, 0.006, 4, 24), { turn: [Math.PI / 2, 0, 0], size: [1, 1.07, 1], at: [0, -0.085, 0] }))
    // The sabaton.
    add(knee, steel, shaped(lathe([[0.068, -0.455], [0.06, -0.405]], 18), { size: [1, 1, 1.1] }))
    add(knee, darkLeather, shaped(new BoxGeometry(0.11, 0.022, 0.26), { at: [0, -0.469, 0.05] }))
    for (let index = 0; index < 5; index += 1) {
      const last = index === 4
      add(knee, steel, shaped(new SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), { size: [0.06 - index * 0.003, 0.047 - index * 0.006, last ? 0.07 : 0.055], at: [0, -0.459, index * 0.042] }))
    }
    add(knee, steel, shaped(new SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), { size: [0.055, 0.04, 0.05], at: [0, -0.459, -0.035] }))
  }

  // ---- the arms: mail at the armpit, rerebraces, couters with fans, vambraces, flared gauntlet cuffs, and fists of steel
  for (const { side, shoulder, elbow, hand } of rig.arms) {
    add(shoulder, mail, shaped(lathe([[0.056, -0.13], [0.064, 0.0]], 14)))
    add(shoulder, steel, shaped(lathe([[0.058, -0.28], [0.066, -0.16], [0.069, -0.07]], 18)))
    // The lames of the pauldron, round the outside of the arm under its dome, the last edged in gold.
    const outside = side > 0 ? -0.4 : Math.PI - 0.4
    for (let index = 0; index < 3; index += 1) {
      const r = 0.124 - index * 0.013
      const top = -0.02 - index * 0.042
      add(shoulder, steel, shaped(lathe([[r - 0.008, top - 0.055], [r, top]], 16, outside, Math.PI + 0.8), { size: [b, 1, 1.1], at: [side * 0.02, 0, 0] }))
      // (A ring's angle runs from +X toward +Z once laid flat, where the lathe's runs from +Z toward +X.)
      if (index === 2) add(shoulder, gold, shaped(new TorusGeometry(r - 0.008, 0.006, 4, 20, Math.PI + 0.8), { size: [b, 1.1, 1], turn: [Math.PI / 2, 0, Math.PI / 2 - outside - (Math.PI + 0.8)], at: [side * 0.02, top - 0.055, 0] }))
    }
    // The elbow.
    add(elbow, steel, shaped(new SphereGeometry(0.057, 14, 10), { size: [1, 1, 0.95], at: [0, 0, -0.024] }))
    add(elbow, steel, shaped(lathe([[0.062, 0.025], [0.067, 0.07]], 16)))
    add(elbow, steel, shaped(new CylinderGeometry(0.05, 0.05, 0.009, 16), { turn: [0, 0, Math.PI / 2], size: [1, 1, 1.15], at: [side * 0.06, 0, -0.012] }))
    rivet(elbow, side * 0.066, 0, -0.012, 0.011)
    // The forearm, and the bell of the gauntlet's cuff.
    add(elbow, steel, shaped(lathe([[0.051, -0.22], [0.057, -0.12], [0.059, -0.05]], 16)))
    add(elbow, steel, shaped(lathe([[0.071, -0.29], [0.062, -0.25], [0.053, -0.205]], 16)))
    add(elbow, gold, shaped(new TorusGeometry(0.07, 0.006, 4, 20), { turn: [Math.PI / 2, 0, 0], at: [0, -0.288, 0] }))
    // The fist: a glove under plates, the back of the hand in one plate, fingers in rings round what it grips (along +Z), a thumb.
    add(hand, darkSteel, shaped(new SphereGeometry(0.048, 12, 8), { size: [0.85, 1, 1.05], at: [0, 0.005, 0] }))
    add(hand, steel, shaped(new SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), { size: [0.06, 0.028, 0.062], turn: [0, 0, -side * Math.PI / 2], at: [side * 0.02, 0.012, 0] }))
    for (let index = 0; index < 4; index += 1) {
      add(hand, steel, shaped(new TorusGeometry(0.029 - Math.abs(index - 1.5) * 0.002, 0.012, 6, 12), { at: [0, -0.006, -0.027 + index * 0.018] }))
    }
    add(hand, steel, shaped(new CapsuleGeometry(0.014, 0.035, 3, 8), { turn: [Math.PI / 2 - 0.3, 0, 0], at: [-side * 0.03, 0.018, 0.025] }))
  }

  // The domes of the pauldrons, on the body: they lift with the arms, but not all the way, so the shoulders stay covered.
  const pauldrons: Array<{ dome: Group; shoulder: Group }> = []
  for (const { side, shoulder } of rig.arms) {
    const dome = joint(torso, shoulder.position.x + side * 0.03, shoulder.position.y + 0.035, 0)
    const shell = joint(dome)
    shell.scale.set(b, 0.86, 1.1)
    const open = Math.PI * 0.56
    add(shell, steel, new SphereGeometry(0.126, 22, 12, 0, Math.PI * 2, 0, open))
    add(shell, gold, shaped(new TorusGeometry(0.126 * Math.sin(open), 0.009, 6, 32), { turn: [Math.PI / 2, 0, 0], at: [0, 0.126 * Math.cos(open), 0] }))
    // A raised comb over the top, from front to back, and rivets along the rim.
    add(shell, steel, shaped(new TorusGeometry(0.128, 0.009, 6, 18, Math.PI * 0.6), { turn: [0, Math.PI / 2, Math.PI * 0.2], at: [side * 0.035, 0, 0] }))
    for (let index = 0; index < 5; index += 1) {
      const turn = (side > 0 ? 0 : Math.PI) + (index - 2) * 0.5
      const r = 0.126 * Math.sin(open) + 0.004
      rivet(shell, Math.cos(turn) * r, 0.126 * Math.cos(open) + 0.012, Math.sin(turn) * r, 0.008)
    }
    pauldrons.push({ dome, shoulder })
  }

  // ---- the helm: a closed helm with a pointed visor, its eye slit and breaths, a gold comb, and a plume
  {
    const shell: Array<[number, number]> = [[0.118, -0.035], [0.135, 0.0], [0.152, 0.06], [0.157, 0.13], [0.15, 0.2], [0.122, 0.257], [0.075, 0.292], [0.001, 0.305]]
    add(head, steel, shaped(lathe(shell, 28), { size: [1, 1, 1.1], at: [0, 0, -0.01] }))
    // The brow of the visor, the slit under it, and the visor below, pointed like a beak, with a ridge down its middle.
    add(head, steel, shaped(lathe([[0.164, 0.148], [0.166, 0.182], [0.159, 0.214]], 20, -1.3, 2.6), { size: [1, 1, 1.12], at: [0, 0, -0.01] }))
    add(head, shadowed, shaped(lathe([[0.159, 0.126], [0.161, 0.15]], 20, -1.05, 2.1), { size: [1, 1, 1.12], at: [0, 0, -0.01] }), false)
    const visor: Array<[number, number]> = [[0.118, -0.02], [0.15, 0.03], [0.168, 0.08], [0.166, 0.128]]
    add(head, steel, shaped(lathe(visor, 24, -1.5, 3.0), { size: [1, 1, 1.24], at: [0, 0, -0.01] }))
    add(head, steel, shaped(lathe(visor.map(([r, y]): [number, number] => [r + 0.006, y]), 3, -0.04, 0.08), { size: [1, 1, 1.24], at: [0, 0, -0.01] }))
    add(head, gold, shaped(lathe([[0.17, 0.123], [0.17, 0.132]], 24, -1.5, 3.0), { size: [1, 1, 1.24], at: [0, 0, -0.01] }))
    // Breaths on its right cheek.
    for (const y of [0.045, 0.065, 0.085, 0.105]) {
      for (const turn of [0.42, 0.58, 0.74]) {
        const r = radiusAt(visor, y) + 0.002
        add(head, shadowed, shaped(new SphereGeometry(0.0065, 6, 4), { at: [Math.sin(turn) * r, y, Math.cos(turn) * r * 1.24 - 0.01] }), false)
      }
    }
    // The pivots of the visor.
    for (const side of [-1, 1]) {
      add(head, gold, shaped(new CylinderGeometry(0.02, 0.02, 0.01, 12), { turn: [0, 0, Math.PI / 2], at: [side * 0.166, 0.14, -0.01] }))
      add(head, gem, shaped(new SphereGeometry(0.008, 6, 4), { at: [side * 0.172, 0.14, -0.01] }), false)
    }
    // The comb over the top, from brow to nape.
    add(head, gold, shaped(new TorusGeometry(0.182, 0.011, 6, 32, Math.PI * 0.86), { turn: [0, Math.PI / 2, Math.PI * 0.07], size: [1, 1, 1.08], at: [0, 0.13, -0.01] }))
    // (Its ends capped, at the brow and the nape.)
    for (const end of [Math.PI * 0.07, Math.PI * 0.93]) {
      add(head, gold, shaped(new SphereGeometry(0.013, 8, 6), { at: [0, 0.13 + Math.sin(end) * 0.182, -0.01 - Math.cos(end) * 0.182 * 1.08] }))
    }
    add(head, gold, shaped(new TorusGeometry(0.137, 0.006, 4, 32), { turn: [Math.PI / 2, 0, 0], size: [1, 1.1, 1], at: [0, 0.002, -0.01] }))
    // The holder of the plume.
    add(head, gold, shaped(new CylinderGeometry(0.016, 0.022, 0.07, 10), { turn: [-0.75, 0, 0], at: [0, 0.29, -0.085] }))
  }
  // The plume: seven feathers fanned back from the crown, each in three bending lengths, the cloth's colour tipped in white.
  const plume = joint(head, 0, 0.315, -0.11)
  const feathers: Array<{ joints: Group[]; phase: number }> = []
  for (let index = 0; index < 7; index += 1) {
    const spread = (index - 3) / 3
    const joints: Group[] = []
    let parent: Group = plume
    let reach = 0
    for (let segment = 0; segment < 3; segment += 1) {
      const link = joint(parent, 0, reach, 0)
      const length = 0.12 - segment * 0.012
      reach = length * 0.92
      const material = segment === 2 ? plumeWhite : index % 2 === 0 ? cloth : lining
      kit.part(link, shaped(new SphereGeometry(1, 10, 6), { size: [0.034 - segment * 0.006, length / 2 + 0.01, 0.01] }), material, 0, length / 2, 0)
      joints.push(link)
      parent = link
    }
    joints[0].rotation.set(-0.6, spread * 0.25, -spread * 0.22)
    feathers.push({ joints, phase: index * 0.9 })
  }

  // ---- the cape: hung from the rosettes, draped over the shoulders, falling past the back and blowing behind as it walks
  const capeWidth = 0.54 * b
  const capeLength = 0.92
  const capeGeometry = shaped(new BoxGeometry(capeWidth, capeLength, 0.016, 14, 22, 1), { at: [0, -capeLength / 2, 0] })
  const capeRest = (capeGeometry.getAttribute('position') as BufferAttribute).array.slice()
  const cape = new Mesh(capeGeometry, [gold, gold, gold, gold, lining, capeOuter])
  cape.castShadow = true
  cape.receiveShadow = true
  joint(torso, 0, 0.5, -front(0.5) - 0.012).add(cape)
  let capeTrail = 0.1

  const drape = (t: number, walk: number, dead: boolean): void => {
    const positions = capeGeometry.getAttribute('position') as BufferAttribute
    const out = positions.array as Float32Array
    const trail = Math.max(0.02, capeTrail)
    for (let index = 0; index < out.length; index += 3) {
      const x0 = capeRest[index]
      const y0 = capeRest[index + 1]
      const z0 = capeRest[index + 2]
      const s = Math.min(1, Math.max(0, -y0 / capeLength))
      const edge = x0 / (capeWidth / 2)
      // Gathered at the top and falling wider.
      const x = x0 * (0.8 + 0.2 * smoothstep(0, 0.35, s)) * (1 + 0.12 * s)
      // Away from the body: out over the shoulder blades, and bent back along its length as it trails.
      const bend = trail * s
      const y = -capeLength * Math.sin(bend) / trail
      let z = -capeLength * (1 - Math.cos(bend)) / trail - 0.06 * smoothstep(0, 0.16, s)
      // Round the shoulders at the top, folds down its length, and a ripple running down it.
      z += edge * edge * 0.12 * (1 - smoothstep(0, 0.3, s))
      z += Math.sin(x0 * 36 + 0.8) * 0.014 * smoothstep(0.05, 0.6, s)
      if (!dead) z += Math.sin(t * 4.3 - s * 5.5 + x0 * 7) * (0.008 + 0.03 * walk) * s
      out[index] = x
      out[index + 1] = y
      out[index + 2] = z + z0
    }
    positions.needsUpdate = true
    capeGeometry.computeVertexNormals()
  }
  drape(0, 0, false)
  capeGeometry.computeBoundingSphere()
  if (capeGeometry.boundingSphere) capeGeometry.boundingSphere.radius *= 2

  // ---- the sword
  // Built along +Y, turned to point ahead of the fist, and held edge on: its flats face the sides.
  const main = joint(rig.arms.find((arm) => arm.side > 0)!.hand)
  const held = joint(main)
  held.rotation.x = Math.PI / 2
  const sword = joint(held)
  sword.rotation.y = Math.PI / 2
  {
    // A diamond blade, wide at the guard and narrowing to a point, a fuller down it with a rune that glows.
    const bladeProfile: Array<[number, number]> = [[0.001, 0.112], [0.041, 0.118], [0.039, 0.3], [0.035, 0.6], [0.03, 0.82], [0.02, 0.93], [0.001, 1.02]]
    add(sword, bladeSteel, shaped(lathe(bladeProfile, 4), { size: [1, 1, 0.24] }))
    for (const face of [-1, 1]) {
      add(sword, rune, shaped(new BoxGeometry(0.011, 0.5, 0.004), { at: [0, 0.42, face * 0.008] }), false)
    }
    // The guard: a block with a gem on each face, and quillons curving toward the point, ending in knobs.
    add(sword, gold, shaped(new BoxGeometry(0.07, 0.036, 0.04), { at: [0, 0.1, 0] }))
    add(sword, gold, shaped(new ConeGeometry(0.03, 0.06, 4), { size: [1, 1, 0.5], turn: [0, Math.PI / 4, 0], at: [0, 0.14, 0] }))
    for (const face of [-1, 1]) add(sword, gem, shaped(new SphereGeometry(0.013, 10, 8), { size: [1, 1, 0.5], at: [0, 0.1, face * 0.02] }), false)
    // Each quillon is an arc of a circle over the guard, so it curves up toward the point.
    for (const side of [-1, 1]) {
      const from = side > 0 ? -Math.PI / 2 : -Math.PI / 2 - 0.62
      add(sword, gold, shaped(new TorusGeometry(0.2, 0.012, 6, 12, 0.62), { turn: [0, 0, from], at: [0, 0.3, 0] }))
      const end = -Math.PI / 2 + side * 0.62
      add(sword, gold, shaped(new SphereGeometry(0.019, 10, 8), { at: [Math.cos(end) * 0.2, 0.3 + Math.sin(end) * 0.2, 0] }))
    }
    // The grip, wound with leather between gold ferrules, and a wheel pommel with a gem in it.
    add(sword, darkLeather, new CylinderGeometry(0.019, 0.021, 0.19, 10))
    for (let index = 0; index < 7; index += 1) {
      add(sword, leather, shaped(new TorusGeometry(0.02, 0.005, 4, 12), { turn: [Math.PI / 2 + (index % 2 ? 0.25 : -0.25), 0, 0], at: [0, -0.075 + index * 0.025, 0] }))
    }
    for (const y of [-0.095, 0.083]) add(sword, gold, shaped(new CylinderGeometry(0.024, 0.024, 0.014, 12), { at: [0, y, 0] }))
    add(sword, gold, shaped(new CylinderGeometry(0.042, 0.042, 0.026, 20), { turn: [Math.PI / 2, 0, 0], at: [0, -0.135, 0] }))
    add(sword, gold, shaped(new TorusGeometry(0.042, 0.007, 6, 20), { at: [0, -0.135, 0] }))
    for (const face of [-1, 1]) add(sword, gem, shaped(new SphereGeometry(0.017, 10, 8), { size: [1, 1, 0.5], at: [0, -0.135, face * 0.014] }), false)
    add(sword, gold, shaped(new SphereGeometry(0.014, 8, 6), { at: [0, -0.18, 0] }))
  }

  sculpt.onFrame(({ t, dt, walk, hipL, hipR, dead }) => {
    for (const { dome, shoulder } of pauldrons) dome.rotation.set(shoulder.rotation.x * 0.35, 0, shoulder.rotation.z * 0.6)
    // The tabard is pushed forward by whichever leg is ahead.
    tabard.rotation.x = Math.min(0, hipL, hipR) * 0.92 - 0.03
    capeTrail = approach(capeTrail, dead ? 0.02 : 0.1 + 0.62 * walk + Math.sin(t * 1.7) * 0.03, 5, dt)
    drape(t, walk, dead)
    for (const { joints, phase } of feathers) {
      joints[0].rotation.x = -0.6 - 0.3 * walk + Math.sin(t * 3.1 + phase) * 0.04
      joints[1].rotation.x = -0.5 - 0.15 * walk + Math.sin(t * 3.7 + phase) * 0.07
      joints[2].rotation.x = -0.55 - 0.1 * walk + Math.sin(t * 4.3 + phase) * 0.1
    }
  })

  return sculpt.finish({
    main,
    mainHold: 'free',
    tip: joint(sword, 0, 0.95, 0),
    strike: joint(sword, 0, 0.55, 0),
    strikeShape: { x: 0.7, y: 2.6, z: 0.5 },
  })
}
