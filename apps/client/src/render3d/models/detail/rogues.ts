import {
  BoxGeometry,
  IcosahedronGeometry,
  OctahedronGeometry,
  type Group,
  type Material,
  type Object3D,
} from 'three'
import { CapsuleGeometry, ConeGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from './shapes.ts'
import type { Look } from '../looks.ts'
import { joint } from '../model.ts'
import { arms, band, belt, boots, chest, chestFront, face, hand, legs, ring, strap } from './body.ts'
import { hood } from './casters.ts'
import { lathe, paintTexture, Sculpt, shade, shaped, Skirt, sweep, weave, type Detail, type DetailKit, type Rig, type Triple } from './kit.ts'

// The quick ones: the Ninja, the Cloak, the Chain and the Trinketmaster.

// A held blade built along +Y and turned to point ahead of the hand.
function forward(hand: Group): Group {
  const group = joint(hand)
  group.rotation.x = Math.PI / 2
  return group
}

// A cord wound round a joint in a spiral from `y0` down to `y1`: wrappings on a forearm or a shin.
function wrap(s: Sculpt, parent: Object3D, material: Material, r0: number, r1: number, y0: number, y1: number, turns: number): void {
  const points: Triple[] = []
  const steps = Math.round(turns * 10)
  for (let index = 0; index <= steps; index += 1) {
    const k = index / steps
    const turn = k * turns * Math.PI * 2
    const r = r0 + (r1 - r0) * k
    points.push([Math.sin(turn) * r, y0 + (y1 - y0) * k, Math.cos(turn) * r])
  }
  s.add(parent, material, sweep(points, 0.009, 5, steps * 3))
}

// A chain of links along a path, each turned a quarter from the last.
function chain(s: Sculpt, parent: Object3D, material: Material, points: Triple[], size = 0.022): void {
  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0, z0] = points[index]
    const [x1, y1, z1] = points[index + 1]
    const dx = x1 - x0
    const dy = y1 - y0
    const dz = z1 - z0
    const length = Math.hypot(dx, dy, dz)
    const links = Math.max(1, Math.round(length / (size * 1.5)))
    for (let link = 0; link < links; link += 1) {
      const k = (link + 0.5) / links
      const geometry = new TorusGeometry(size * 0.6, size * 0.2, 4, 8)
      geometry.scale(1, 1.5, 1)
      if ((index * 7 + link) % 2) geometry.rotateY(Math.PI / 2)
      // Turned to lie along the path.
      const pitch = Math.atan2(Math.hypot(dx, dz), dy)
      geometry.rotateX(pitch)
      geometry.rotateY(Math.atan2(dx, dz))
      geometry.translate(x0 + dx * k, y0 + dy * k, z0 + dz * k)
      s.add(parent, material, geometry, false)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- Ninja

// Covered head to foot in black: a hood and mask with a slit for the eyes, a headband whose tails stream behind, a gi with crossed
// lapels and a wide sash knotted at the back, wrapped forearms and shins, split-toed boots, throwing stars at the hip, a sheath
// across the back, and a katana with a wrapped hilt, a guard and a curved blade.
export function ninja(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const cloth = s.cloth(look.cloth, { roughness: 0.9 })
  const trim = s.surface(look.trim, { roughness: 0.85 })
  const wraps = s.surface(shade(look.trim, 1.3), { roughness: 0.95 })
  const steel = s.surface('#c4ccd4', { roughness: 0.2, metalness: 0.85 })
  const dark = s.surface('#0a0a0e', { roughness: 1 })
  const white = s.surface('#e8e8f0', { roughness: 0.4 })
  const gold = s.surface('#b89a52', { roughness: 0.35, metalness: 0.8 })
  const lacquer = s.surface('#120d14', { roughness: 0.25, metalness: 0.3 })
  const edge = s.glow(look.accent, 0.6)
  const blade = s.surface('#dfe4ea', { roughness: 0.18, metalness: 0.6, flatShading: true })

  legs(s, { thigh: cloth, shin: cloth, thighR: 0.084, shinR: 0.062 })
  for (const { knee } of rig.legs) wrap(s, knee, wraps, 0.066, 0.06, -0.08, -0.4, 6)
  boots(s, { material: cloth, sole: dark, height: 0.08 })
  // Split toes.
  for (const { knee } of rig.legs) s.add(knee, dark, shaped(new BoxGeometry(0.006, 0.05, 0.06), { at: [0.015, -0.455, 0.14] }), false)
  chest(s, cloth)
  for (const side of [-1, 1]) strap(s, rig.torso, trim, [side * 0.08, 0.53, chestFront(s, 0.53, side * 0.08) + 0.004], [-side * 0.07, 0.1, chestFront(s, 0.1, -side * 0.07) + 0.006], 0.04, 0.008)
  band(s, rig.torso, trim, 0.185, -0.02, 0.1, [b, 0.84 * b])
  // The sash's knot behind and its tails.
  const back = -chestFront(s, 0.05) - 0.02
  s.add(rig.torso, trim, shaped(new SphereGeometry(0.035, 10, 8), { size: [1.4, 1, 0.7], at: [0, 0.05, back] }))
  const tails: Group[] = []
  for (const side of [-1, 1]) {
    const tail = joint(rig.torso, side * 0.03, 0.05, back - 0.01)
    s.add(tail, trim, shaped(new BoxGeometry(0.04, 0.3, 0.008, 1, 4, 1), { at: [0, -0.15, 0] }))
    tails.push(tail)
  }
  // Throwing stars at the hip.
  for (const [x, z] of [[0.17, 0.1], [0.185, 0.06]] as const) {
    for (let point = 0; point < 4; point += 1) {
      s.add(rig.torso, steel, shaped(new ConeGeometry(0.012, 0.04, 3), { size: [1, 1, 0.25], turn: [0, Math.atan2(x, z), point * Math.PI / 2], at: [x * b, 0.05, z * b] }), false)
    }
  }
  arms(s, { upper: cloth, fore: cloth, upperR: 0.055, foreR: 0.048 })
  for (const { elbow } of rig.arms) wrap(s, elbow, wraps, 0.05, 0.046, -0.05, -0.26, 5)
  hand(s, s.right.hand, 1, cloth, 'grip')
  hand(s, s.left.hand, -1, cloth, 'open')
  face(s, { skin: cloth, eyes: false, ears: 'none', neck: cloth })
  // The slit for the eyes, and the eyes in it.
  s.add(rig.head, dark, shaped(lathe([[0.122, 0.12], [0.122, 0.148]], 16, -0.75, 1.5), { size: [0.92, 1, 1], at: [0, 0, -0.005] }), false)
  for (const side of [-1, 1]) s.add(rig.head, white, shaped(new SphereGeometry(0.012, 8, 6), { size: [1.4, 0.8, 0.5], at: [side * 0.04, 0.134, 0.112] }), false)
  // The headband, its plate, and its tails.
  ring(s, rig.head, trim, 0.122, 0.012, 0.18, [0.94, 1])
  s.add(rig.head, steel, shaped(new BoxGeometry(0.08, 0.03, 0.01), { at: [0, 0.18, 0.124] }))
  for (const side of [-1, 1]) {
    const tail = joint(rig.head, side * 0.025, 0.18, -0.12)
    s.add(tail, trim, shaped(new BoxGeometry(0.03, 0.26, 0.006, 1, 4, 1), { at: [0, -0.13, 0] }))
    tails.push(tail)
  }
  s.onFrame(({ t, walk }) => {
    for (const [index, tail] of tails.entries()) tail.rotation.set(0.3 + walk * 0.9 + Math.sin(t * 5 + index) * 0.07 * (0.3 + walk), 0, (index % 2 ? 1 : -1) * 0.15)
  })
  // The sheath across the back.
  {
    const sheath = joint(rig.torso, 0, 0.3, -chestFront(s, 0.3) - 0.03)
    sheath.rotation.z = 0.9
    s.add(sheath, lacquer, shaped(lathe([[0.012, -0.45], [0.022, -0.4], [0.024, 0.35]], 10), { size: [1, 1, 0.55] }))
    s.add(sheath, gold, shaped(new CylinderGeometry(0.026, 0.026, 0.03, 10), { size: [1, 1, 0.6], at: [0, 0.34, 0] }))
    s.add(sheath, trim, shaped(new TorusGeometry(0.03, 0.006, 4, 10), { at: [0, 0.2, 0] }))
  }
  // The katana.
  const main = joint(s.right.hand)
  const sword = forward(main)
  s.add(sword, trim, shaped(new CylinderGeometry(0.019, 0.02, 0.24, 8), { at: [0, -0.01, 0] }))
  for (let index = 0; index < 8; index += 1) s.add(sword, lacquer, shaped(new OctahedronGeometry(0.014, 0), { size: [1.4, 0.8, 0.5], at: [0, -0.11 + index * 0.028, 0.017] }), false)
  s.add(sword, gold, shaped(new CylinderGeometry(0.022, 0.02, 0.02, 8), { at: [0, -0.13, 0] }))
  s.add(sword, gold, shaped(new TorusGeometry(0.048, 0.008, 6, 16), { turn: [Math.PI / 2, 0, 0], at: [0, 0.12, 0] }))
  s.add(sword, lacquer, shaped(new CylinderGeometry(0.046, 0.046, 0.012, 16), { at: [0, 0.12, 0] }))
  s.add(sword, gold, shaped(new BoxGeometry(0.026, 0.03, 0.014), { at: [0, 0.14, 0] }))
  const curve: Triple[] = [[0, 0.14, 0], [0, 0.4, -0.006], [0, 0.7, -0.025], [0, 0.95, -0.06]]
  s.add(sword, blade, sweep(curve, (u) => 0.022 * (1 - u ** 4 * 0.9), 4, 30).scale(0.4, 1, 1))
  s.add(sword, edge, sweep(curve.map(([x, y, z]): Triple => [x, y, z + 0.018]), (u) => 0.003 * (1 - u), 4, 30), false)
  return s.finish({ main, mainHold: 'free', tip: joint(sword, 0, 0.92, -0.05), strike: joint(sword, 0, 0.54, -0.01), strikeShape: { x: 0.5, y: 2.4, z: 0.4 } })
}

// ---------------------------------------------------------------------------------------------------------------- Cloak

// An assassin lost in a great hooded cloak, ragged at the hem and open at the front, eyes glowing in the dark of the hood, leather
// under it crossed with belts of knives, wrapped legs and soft boots, and two curved daggers whose edges glow.
export function cloak(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const cloth = s.cloth(look.cloth, { roughness: 0.9 })
  const inner = s.cloth(look.trim, { roughness: 0.9 })
  const leather = s.surface('#2a2026', { roughness: 0.7 })
  const strapping = s.surface('#3a2c30', { roughness: 0.8 })
  const shadow = s.surface('#030205', { roughness: 1 })
  const eyes = s.glow(look.eyes ?? look.accent, 2.6)
  const silver = s.surface('#c8ccd6', { roughness: 0.3, metalness: 0.85 })
  const edge = s.glow(look.accent, 1.2)
  const blade = s.surface('#c9ced8', { roughness: 0.2, metalness: 0.6, flatShading: true })

  legs(s, { thigh: leather, shin: leather, thighR: 0.082, shinR: 0.062 })
  for (const { knee } of rig.legs) wrap(s, knee, strapping, 0.064, 0.058, -0.1, -0.38, 4)
  boots(s, { material: leather, sole: shadow, height: 0.18, toe: 'pointed' })
  chest(s, leather)
  for (const side of [-1, 1]) strap(s, rig.torso, strapping, [side * 0.13, 0.5, chestFront(s, 0.5, side * 0.13) + 0.006], [-side * 0.12, 0.06, chestFront(s, 0.06, -side * 0.12) + 0.008], 0.03, 0.008)
  belt(s, strapping, silver, { y: 0.04 })
  // Knives along the belt.
  for (let index = 0; index < 4; index += 1) {
    const turn = 0.9 + index * 0.22
    const x = Math.sin(turn) * 0.2 * b
    const z = Math.cos(turn) * 0.17 * b
    s.add(rig.torso, strapping, shaped(new BoxGeometry(0.02, 0.12, 0.012), { turn: [0, turn, 0], at: [x, -0.02, z] }))
    s.add(rig.torso, silver, shaped(new CylinderGeometry(0.007, 0.007, 0.05, 6), { at: [x, 0.065, z] }))
  }
  // The cloak, from the shoulders past the knees, open in front, and its clasp.
  const great = new Skirt(s, rig.torso, cloth, { top: 0.575, length: 1.12, neck: 0.12, hem: 0.42, depth: 0.85, from: 0.45, span: Math.PI * 2 - 0.9, ragged: 0.08, tatters: 18, push: 0.55, seed: 13, rows: 14 })
  const lining = new Skirt(s, rig.torso, inner, { top: 0.57, length: 1.1, neck: 0.115, hem: 0.41, depth: 0.85, from: 0.47, span: Math.PI * 2 - 0.94, ragged: 0.08, tatters: 18, push: 0.55, seed: 13, rows: 14, shadow: false })
  s.onFrame((frame) => {
    great.update(frame)
    lining.update(frame)
  })
  for (const side of [-1, 1]) s.add(rig.torso, silver, shaped(new CylinderGeometry(0.02, 0.02, 0.01, 12), { turn: [Math.PI / 2, 0, 0], at: [side * 0.07, 0.52, chestFront(s, 0.52, side * 0.07) + 0.025] }))
  strap(s, rig.torso, silver, [-0.07, 0.52, chestFront(s, 0.52, 0.07) + 0.025], [0.07, 0.52, chestFront(s, 0.52, 0.07) + 0.025], 0.004, 0, true)
  arms(s, { upper: cloth, fore: leather, upperR: 0.062, foreR: 0.05 })
  for (const { elbow } of rig.arms) {
    s.add(elbow, strapping, lathe([[0.056, -0.27], [0.058, -0.1]], 14))
    for (const y of [-0.24, -0.18, -0.12]) ring(s, elbow, silver, 0.059, 0.004, y)
  }
  hand(s, s.right.hand, 1, leather, 'grip')
  hand(s, s.left.hand, -1, leather, 'grip')
  hood(s, cloth, inner, { r: 0.185, open: 1.4 })
  s.add(rig.head, shadow, shaped(new SphereGeometry(0.125, 16, 12), { size: [1, 1.05, 0.9], at: [0, 0.12, 0.02] }))
  for (const side of [-1, 1]) s.add(rig.head, eyes, shaped(new SphereGeometry(0.018, 10, 8), { size: [1.5, 0.6, 0.5], turn: [0, 0, side * 0.3], at: [side * 0.042, 0.13, 0.13] }), false)
  // A cloth over the mouth and nose.
  s.add(rig.head, inner, shaped(new SphereGeometry(0.13, 18, 10, Math.PI / 2 - 1, 2, Math.PI * 0.5, Math.PI * 0.35), { at: [0, 0.12, 0.012] }))

  // The daggers: a wrapped grip, a crescent guard, a curved blade with a glowing edge.
  const main = joint(s.right.hand)
  const off = joint(s.left.hand)
  for (const held of [main, off]) {
    const knife = forward(held)
    s.add(knife, strapping, shaped(new CylinderGeometry(0.016, 0.018, 0.12, 8), { at: [0, -0.01, 0] }))
    s.add(knife, silver, shaped(new SphereGeometry(0.02, 8, 6), { at: [0, -0.075, 0] }))
    s.add(knife, silver, shaped(new TorusGeometry(0.05, 0.008, 5, 12, Math.PI * 0.7), { turn: [0, 0, Math.PI * 1.15], at: [0, 0.1, 0] }))
    const curve: Triple[] = [[0, 0.06, 0], [0, 0.2, 0.012], [0, 0.32, 0.04], [0, 0.4, 0.08]]
    s.add(knife, blade, sweep(curve, (u) => 0.02 * (1 - u ** 2 * 0.95), 4, 20).scale(0.32, 1, 1))
    s.add(knife, edge, sweep(curve.map(([x, y, z]): Triple => [x, y, z - 0.016]), (u) => 0.003 * (1 - u), 4, 20), false)
  }
  return s.finish({ main, mainHold: 'free', off, offHold: 'free', tip: main, strike: main, offStrike: off, robed: true })
}

// ---------------------------------------------------------------------------------------------------------------- Chain

// A masked fighter: a hood over an iron mask riveted over the mouth, chains wound round the body and over a pauldron, a studded
// leather tunic, wrapped forearms, and a sickle in one hand with a chain from its pommel to the other hand, a spiked weight on its
// end swinging below.
export function chainFighter(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const cloth = s.cloth(look.cloth, { roughness: 0.85 })
  const leather = s.surface('#2e2a28', { roughness: 0.75 })
  const iron = s.surface(look.trim, { roughness: 0.35, metalness: 0.8 })
  const darkIron = s.surface('#5a6068', { roughness: 0.4, metalness: 0.75 })
  const wraps = s.surface('#8a8070', { roughness: 0.95 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const wood = s.surface('#5a3a24', { roughness: 0.85 })
  const hot = s.glow(look.accent, 1)
  const blade = s.surface('#d6dce2', { roughness: 0.2, metalness: 0.65, flatShading: true })

  legs(s, { thigh: cloth, shin: cloth, thighR: 0.086, shinR: 0.064, baggy: 0.075 })
  for (const { knee } of rig.legs) wrap(s, knee, wraps, 0.07, 0.062, -0.22, -0.4, 3)
  boots(s, { material: leather, sole: s.surface('#1a1716'), height: 0.12 })
  chest(s, leather, { grow: 0.004 })
  // Studs on the tunic.
  for (let row = 0; row < 4; row += 1) {
    for (let column = -2; column <= 2; column += 1) {
      const y = 0.15 + row * 0.08
      const x = column * 0.05
      s.add(rig.torso, darkIron, shaped(new SphereGeometry(0.008, 6, 4), { at: [x, y, chestFront(s, y, x, { grow: 0.004 }) + 0.002] }), false)
    }
  }
  const tunic = new Skirt(s, rig.hips, cloth, { top: 0.04, length: 0.32, neck: 0.19, hem: 0.25, push: 0.8, ripple: 0.4, ragged: 0.04, tatters: 8, seed: 3 })
  s.onFrame((frame) => tunic.update(frame))
  belt(s, leather, iron, { y: 0.04, width: 0.06 })
  // Chains wound twice round the body, and over the left shoulder.
  for (const offset of [0, 0.22]) {
    const path: Triple[] = []
    for (let index = 0; index <= 16; index += 1) {
      const turn = index / 16 * Math.PI * 2
      const y = 0.12 + offset + Math.sin(turn) * 0.1
      const r = (0.2 + 0.012) * b
      path.push([Math.sin(turn) * r, y, Math.cos(turn) * r * 0.82])
    }
    chain(s, rig.torso, darkIron, path)
  }
  chain(s, rig.torso, darkIron, [[-0.22 * b, 0.48, chestFront(s, 0.48, -0.15) + 0.02], [-0.06, 0.32, chestFront(s, 0.32) + 0.02], [0.12, 0.14, chestFront(s, 0.14, 0.12) + 0.02]])
  {
    const shoulder = s.left.shoulder
    s.add(shoulder, iron, shaped(new SphereGeometry(0.1, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), { size: [1, 0.8, 1.1], at: [-0.02, 0.02, 0] }))
    for (const y of [-0.03, -0.075]) s.add(shoulder, iron, shaped(lathe([[0.09, y - 0.04], [0.098, y]], 14, Math.PI - 0.5, Math.PI + 1)))
  }
  arms(s, { upper: skin, fore: skin, upperR: 0.06, foreR: 0.052 })
  for (const { elbow, shoulder } of rig.arms) {
    wrap(s, elbow, wraps, 0.054, 0.048, -0.02, -0.26, 5)
    band(s, shoulder, leather, 0.064, -0.18, -0.13)
  }
  hand(s, s.right.hand, 1, wraps, 'grip')
  hand(s, s.left.hand, -1, wraps, 'grip', 1, 'y')
  face(s, { skin, white: s.surface('#ece6de'), iris: hot, brows: s.surface('#2a2420') })
  // The mask over the mouth and nose, riveted, with slits to breathe through.
  s.add(rig.head, iron, shaped(new SphereGeometry(0.132, 20, 10, Math.PI / 2 - 1.2, 2.4, Math.PI * 0.48, Math.PI * 0.32), { at: [0, 0.125, 0.008] }))
  for (let index = 0; index < 4; index += 1) s.add(rig.head, s.surface('#111'), shaped(new BoxGeometry(0.035, 0.005, 0.01), { at: [0, 0.055 + index * 0.014, 0.135] }), false)
  for (const side of [-1, 1]) for (const y of [0.04, 0.1]) s.add(rig.head, darkIron, shaped(new SphereGeometry(0.007, 6, 4), { at: [side * 0.09, y, 0.1] }), false)
  hood(s, cloth, leather, { r: 0.172, open: 1.7, point: false })

  // The sickle.
  const main = joint(s.right.hand)
  const sickle = forward(main)
  s.add(sickle, wood, shaped(new CylinderGeometry(0.02, 0.022, 0.3, 8), { at: [0, 0.04, 0] }))
  for (let index = 0; index < 5; index += 1) s.add(sickle, wraps, shaped(new TorusGeometry(0.022, 0.005, 4, 10), { turn: [Math.PI / 2 + (index % 2 ? 0.3 : -0.3), 0, 0], at: [0, -0.06 + index * 0.025, 0] }), false)
  s.add(sickle, iron, shaped(new TorusGeometry(0.022, 0.007, 5, 12), { at: [0, -0.13, 0] }))
  s.add(sickle, iron, shaped(new CylinderGeometry(0.026, 0.026, 0.04, 8), { at: [0, 0.2, 0] }))
  const arc: Triple[] = []
  for (let index = 0; index <= 10; index += 1) {
    const turn = index / 10 * Math.PI * 1.05
    arc.push([Math.sin(turn) * 0.15 - 0.0, 0.22 + (1 - Math.cos(turn)) * 0.03 + Math.sin(turn) * 0.1, 0])
  }
  s.add(sickle, blade, sweep(arc, (u) => 0.022 * (1 - u * 0.85), 4, 30).scale(1, 1, 0.3))
  s.add(sickle, hot, sweep(arc.map(([x, y, z]): Triple => [x * 0.9, y - 0.012, z]), (u) => 0.004 * (1 - u), 4, 30), false)
  // The chain, hanging from the other hand, and its weight.
  const off = joint(s.left.hand)
  const hanging = joint(off)
  for (let index = 0; index < 9; index += 1) {
    s.add(hanging, darkIron, shaped(new TorusGeometry(0.018, 0.006, 4, 8), { size: [1, 1.5, 1], turn: [0, index % 2 ? Math.PI / 2 : 0, 0], at: [0, -0.02 - index * 0.042, 0] }), false)
  }
  const weight = joint(hanging, 0, -0.42, 0)
  s.add(weight, iron, new IcosahedronGeometry(0.045, 1))
  for (let index = 0; index < 8; index += 1) {
    const turn = index / 8 * Math.PI * 2
    const tilt = index % 2 ? 0.6 : -0.6
    s.add(weight, darkIron, shaped(new ConeGeometry(0.012, 0.05, 5), { turn: [tilt, 0, turn], at: [-Math.sin(turn) * 0.045, Math.cos(turn) * 0.045 * Math.cos(tilt), Math.sin(tilt) * 0.045] }))
  }
  s.add(weight, hot, new IcosahedronGeometry(0.02, 0), false)
  s.onFrame(({ t, walk }) => {
    hanging.rotation.set(Math.sin(t * 2.6) * (0.1 + walk * 0.35), 0, Math.cos(t * 2.1) * 0.08)
    weight.rotation.y = t * 1.5
  })
  return s.finish({ main, mainHold: 'free', off, offHold: 'up', tip: joint(sickle, 0, 0.3, 0), strike: joint(sickle, 0.08, 0.3, 0) })
}

// ---------------------------------------------------------------------------------------------------------------- Trinketmaster

// A trickster in harlequin diamonds: a jester's hat whose three floppy points end in bells, a ruff, puffed and slashed sleeves, a
// dagged tunic, curled shoes with bells on, a domino mask and a grin, a satchel spilling trinkets, and a twisted stick topped with a
// crescent and hung with charms that swing.
export function trinketmaster(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const texture = paintTexture(`harlequin|${look.cloth}|${look.trim}`, 256, 256, (context, width, height) => {
    weave(context, width, height, look.cloth, false)
    const cell = width / 8
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 8; column += 1) {
        const cx = column * cell + cell / 2
        const cy = row * cell + cell / 2
        context.fillStyle = (row + column) % 2 ? look.trim : look.cloth
        context.beginPath()
        context.moveTo(cx, cy - cell / 2)
        context.lineTo(cx + cell / 2, cy)
        context.lineTo(cx, cy + cell / 2)
        context.lineTo(cx - cell / 2, cy)
        context.fill()
      }
    }
    context.strokeStyle = '#e9c46a'
    context.lineWidth = 2
    for (let k = -8; k <= 16; k += 1) {
      context.beginPath()
      context.moveTo(k * cell, 0)
      context.lineTo(k * cell + height, height)
      context.moveTo(k * cell, 0)
      context.lineTo(k * cell - height, height)
      context.stroke()
    }
  })
  const harlequin = s.cloth(texture ? '#ffffff' : look.cloth, { map: texture ?? null, roughness: 0.75 })
  const cloth = s.cloth(look.cloth, { roughness: 0.75 })
  const trim = s.cloth(look.trim, { roughness: 0.75 })
  const white = s.surface('#f2eee6', { roughness: 0.8 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const gold = s.surface('#e2b94e', { roughness: 0.25, metalness: 0.85 })
  const leather = s.surface('#5a3a28', { roughness: 0.75 })
  const mask = s.surface('#1d1a24', { roughness: 0.4 })
  const wood = s.surface('#6a4428', { roughness: 0.7 })
  const charm = s.glow(look.accent, 1)
  const charm2 = s.glow(look.trim, 0.8)

  legs(s, { thigh: harlequin, shin: harlequin, thighR: 0.08, shinR: 0.058 })
  boots(s, { material: trim, sole: leather, height: 0.08, toe: 'curl' })
  for (const { knee } of rig.legs) s.add(knee, gold, shaped(new SphereGeometry(0.016, 8, 6), { at: [0, -0.38 + 0.0, 0.2] }))
  chest(s, harlequin)
  const tunic = new Skirt(s, rig.hips, harlequin, { top: 0.04, length: 0.3, neck: 0.19, hem: 0.27, push: 0.8, ragged: 0.09, tatters: 9, seed: 21 })
  s.onFrame((frame) => tunic.update(frame))
  belt(s, leather, gold, { y: 0.03 })
  // The ruff: a ring of white puffs round the neck.
  for (let index = 0; index < 16; index += 1) {
    const turn = index / 16 * Math.PI * 2
    s.add(rig.torso, white, shaped(new SphereGeometry(0.045, 8, 6), { size: [1, 0.7, 1], at: [Math.sin(turn) * 0.14 * b, 0.56, Math.cos(turn) * 0.13 * b] }))
  }
  // The satchel and what spills from it.
  {
    const bag = joint(rig.hips, 0.2 * b, -0.02, 0.0)
    bag.rotation.y = 0.5
    s.add(bag, leather, shaped(new SphereGeometry(0.09, 12, 10), { size: [0.7, 1, 1.1] }))
    s.add(bag, trim, shaped(new SphereGeometry(0.092, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.35), { size: [0.72, 1, 1.12] }))
    for (let index = 0; index < 4; index += 1) s.add(bag, index % 2 ? charm : charm2, shaped(new OctahedronGeometry(0.018, 0), { at: [0.02 - index * 0.012, 0.08, -0.03 + index * 0.02] }), false)
    s.add(bag, gold, shaped(new CylinderGeometry(0.022, 0.022, 0.01, 14), { turn: [0, 0, 0.6], at: [0.04, 0.07, 0.05] }))
    strap(s, rig.torso, leather, [0.2 * b, -0.04, 0.0], [-0.14 * b, 0.53, 0.0], 0.025, 0.008)
  }
  // Puffed sleeves, slashed to show the other colour, then fitted to the wrist.
  for (const { shoulder } of rig.arms) {
    s.add(shoulder, cloth, shaped(new SphereGeometry(0.085, 14, 12), { size: [1, 1.3, 1], at: [0, -0.07, 0] }))
    for (let index = 0; index < 6; index += 1) {
      const turn = index / 6 * Math.PI * 2
      s.add(shoulder, trim, shaped(new CapsuleGeometry(0.012, 0.13, 3, 6), { at: [Math.sin(turn) * 0.082, -0.07, Math.cos(turn) * 0.082] }))
    }
  }
  arms(s, { upper: cloth, fore: trim, upperR: 0.055, foreR: 0.048 })
  for (const { elbow } of rig.arms) ring(s, elbow, white, 0.052, 0.012, -0.26)
  hand(s, s.right.hand, 1, skin, 'grip')
  hand(s, s.left.hand, -1, skin, 'open')
  face(s, { skin, white: s.surface('#f6f2ea'), iris: charm, brows: mask, hair: cloth, mouth: s.surface('#b04a5a') })
  // A grin, rosy cheeks, the domino mask.
  s.add(rig.head, s.surface('#7a2a3a'), shaped(new TorusGeometry(0.03, 0.005, 4, 12, Math.PI), { turn: [0, 0, Math.PI], size: [1, 0.6, 1], at: [0, 0.074, 0.112] }), false)
  for (const side of [-1, 1]) s.add(rig.head, s.surface('#e88a8a', { roughness: 0.7 }), shaped(new SphereGeometry(0.018, 8, 6), { size: [1, 0.7, 0.4], at: [side * 0.065, 0.095, 0.1] }), false)
  s.add(rig.head, mask, shaped(lathe([[0.126, 0.115], [0.128, 0.15]], 20, -0.95, 1.9), { size: [0.94, 1, 1.02], at: [0, 0, -0.005] }))
  // The hat: a cap and three floppy points, each ending in a bell, that flop as it moves.
  s.add(rig.head, cloth, shaped(new SphereGeometry(0.138, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), { at: [0, 0.14, -0.01] }))
  ring(s, rig.head, gold, 0.135, 0.012, 0.15, [1, 1.02])
  const points: Group[] = []
  for (const [index, turn] of [-1, 0, 1].entries()) {
    const point = joint(rig.head, turn * 0.09, 0.24, -0.02 - Math.abs(turn) * 0.01)
    point.rotation.set(turn === 0 ? -0.4 : 0, 0, -turn * 0.9)
    s.add(point, index % 2 ? trim : cloth, sweep([[0, -0.02, 0], [0, 0.12, 0], [0, 0.2, -0.06], [0, 0.18, -0.16]], (u) => 0.055 * (1 - u * 0.82), 10, 20))
    s.add(point, gold, shaped(new SphereGeometry(0.024, 10, 8), { at: [0, 0.165, -0.18] }))
    s.add(point, mask, shaped(new BoxGeometry(0.03, 0.004, 0.004), { at: [0, 0.158, -0.198] }), false)
    points.push(point)
  }
  s.onFrame(({ t, walk }) => {
    for (const [index, point] of points.entries()) point.rotation.x = (index === 1 ? -0.4 : 0) + Math.sin(t * 6 + index * 2) * (0.04 + walk * 0.16)
  })

  // The stick: twisted, gold bands, a crescent at its top, charms swinging from it.
  const main = joint(s.right.hand)
  const stick = forward(main)
  const twist: Triple[] = []
  for (let index = 0; index <= 20; index += 1) twist.push([Math.cos(index * 1.2) * 0.006, -0.25 + index * 0.054, Math.sin(index * 1.2) * 0.006])
  s.add(stick, wood, sweep(twist, (u) => 0.022 - u * 0.006, 8, 60))
  for (const y of [-0.24, 0.1, 0.5, 0.78]) s.add(stick, gold, shaped(new CylinderGeometry(0.026, 0.026, 0.02, 10), { at: [0, y, 0] }))
  s.add(stick, gold, shaped(new TorusGeometry(0.06, 0.012, 6, 18, Math.PI * 1.3), { turn: [0, 0, -Math.PI * 0.15], at: [0, 0.86, 0] }))
  s.add(stick, charm, shaped(new OctahedronGeometry(0.025, 0), { at: [0, 0.86, 0] }), false)
  const dangles: Group[] = []
  for (let index = 0; index < 4; index += 1) {
    const hangFrom = joint(stick, (index - 1.5) * 0.02, 0.76 - (index % 2) * 0.04, 0)
    // Built hanging down: the stick points ahead, so its -Z is down when held level.
    const length = 0.06 + (index % 2) * 0.04
    s.add(hangFrom, gold, shaped(new CylinderGeometry(0.002, 0.002, length, 3), { turn: [Math.PI / 2, 0, 0], at: [0, 0, -length / 2] }), false)
    s.add(hangFrom, index === 3 ? gold : index % 2 ? charm2 : charm, index === 3 ? shaped(new SphereGeometry(0.016, 8, 6), { at: [0, 0, -length - 0.014] }) : shaped(new OctahedronGeometry(0.018, 0), { at: [0, 0, -length - 0.016] }), false)
    dangles.push(hangFrom)
  }
  s.onFrame(({ t }) => {
    for (const [index, dangle] of dangles.entries()) dangle.rotation.set(Math.sin(t * 4 + index) * 0.25, Math.cos(t * 3.3 + index * 2) * 0.25, 0)
  })
  return s.finish({ main, mainHold: 'free', tip: joint(stick, 0, 0.85, 0), strike: joint(stick, 0, 0.5, 0), strikeShape: { x: 0.6, y: 3, z: 0.6 } })
}
