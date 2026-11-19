import {
  BoxGeometry,
  DoubleSide,
  IcosahedronGeometry,
  OctahedronGeometry,
  type Group,
  type Material,
  type Object3D,
} from 'three'
import { CapsuleGeometry, ConeGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from './shapes.ts'
import { seededRandom } from '../../space.ts'
import type { Look } from '../looks.ts'
import { joint } from '../model.ts'
import { arms, band, belt, boots, CHEST, chest, chestFront, face, hand, legs, ring, strap } from './body.ts'
import { Cape, lathe, paintTexture, roughen, Sculpt, shade, shaped, Skirt, sweep, type Detail, type DetailKit, type Rig, type Triple } from './kit.ts'

// The big ones and the strange ones: the Hammer, the Monk, Aurel and the Ent.

function forward(hand: Group): Group {
  const group = joint(hand)
  group.rotation.x = Math.PI / 2
  return group
}

// A muscled chest: the chest, pectorals, a ridge of abdominals, in skin.
function muscles(s: Sculpt, skin: Material, depth = 0.8): void {
  chest(s, skin, { depth })
  const t = s.rig.torso
  for (const side of [-1, 1]) {
    const x = side * 0.075 * s.b
    s.add(t, skin, shaped(new SphereGeometry(0.1 * s.b, 14, 10), { size: [1, 0.55, 0.3], turn: [0, 0, side * 0.12], at: [x, 0.38, chestFront(s, 0.38, x, { depth }) - 0.02] }))
    for (let row = 0; row < 3; row += 1) {
      const y = 0.1 + row * 0.075
      const ax = side * 0.036 * s.b
      s.add(t, skin, shaped(new SphereGeometry(0.032, 10, 8), { size: [1, 0.75, 0.28], at: [ax, y, chestFront(s, y, ax, { depth }) - 0.004] }))
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- Hammer

// A berserker, bare-chested and painted for war: a wolf's pelt over the shoulders with its head on one of them, a fur kilt, a wide
// belt with a skull, gold rings on the arms and studded bracers, fur boots, a wild mane and a braided beard with beads, and a great
// warhammer with runes burning in its head and a spike behind.
export function hammer(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const paint = s.surface(look.accent, { roughness: 0.7 })
  const fur = s.surface('#6e675e', { roughness: 1, flatShading: true, side: DoubleSide })
  const brownFur = s.surface('#6b4a30', { roughness: 1, flatShading: true, side: DoubleSide })
  const leather = s.surface(look.trim, { roughness: 0.75 })
  const hair = s.surface('#5a3418', { roughness: 0.9, flatShading: true })
  const gold = s.surface('#c9a24a', { roughness: 0.3, metalness: 0.85 })
  const iron = s.surface('#6a6e74', { roughness: 0.4, metalness: 0.75 })
  const bone = s.surface('#e3dccb', { roughness: 0.6 })
  const wood = s.surface('#5a3a22', { roughness: 0.85 })
  const rune = s.glow(look.accent, 1)
  const dark = s.surface('#120c0a', { roughness: 1 })

  legs(s, { thigh: leather, shin: leather, thighR: 0.1, shinR: 0.075 })
  for (const { knee } of rig.legs) s.add(knee, brownFur, roughen(lathe([[0.09, -0.48], [0.1, -0.4], [0.095, -0.2], [0.082, -0.12]], 14), 0.012, 4))
  boots(s, { material: leather, sole: dark, height: 0.06 })
  muscles(s, skin)
  // War paint: stripes across the chest and down the arms.
  for (const [y, tilt] of [[0.42, 0.3], [0.3, -0.25]] as const) {
    for (const side of [-1, 1]) {
      const x = side * 0.09 * b
      s.add(rig.torso, paint, shaped(new BoxGeometry(0.11 * b, 0.022, 0.01), { turn: [0, side * 0.45, tilt * side], at: [x, y, chestFront(s, y, x) + 0.006] }), false)
    }
  }
  const kilt = new Skirt(s, rig.hips, brownFur, { top: 0.04, length: 0.42, neck: 0.2, hem: 0.29, ragged: 0.08, tatters: 20, push: 0.9, seed: 31 })
  s.onFrame((frame) => kilt.update(frame))
  band(s, rig.torso, leather, 0.2, -0.03, 0.08, [b, 0.82 * b])
  for (const y of [-0.01, 0.06]) ring(s, rig.torso, iron, 0.203 * b, 0.006, y, [1, 0.82])
  // The skull buckle, and teeth on cords.
  {
    const z = 0.2 * 0.82 * b + 0.012
    s.add(rig.torso, bone, shaped(new SphereGeometry(0.04, 12, 10), { size: [1, 1, 0.7], at: [0, 0.035, z] }))
    for (const side of [-1, 1]) s.add(rig.torso, dark, shaped(new SphereGeometry(0.011, 6, 4), { at: [side * 0.015, 0.04, z + 0.024] }), false)
    for (let index = 0; index < 5; index += 1) s.add(rig.torso, bone, shaped(new ConeGeometry(0.008, 0.035, 5), { turn: [0, 0, Math.PI], at: [0.08 + index * 0.02, -0.04, z - 0.01 - index * 0.006] }), false)
  }
  // The pelt: a collar of shaggy fur, the pelt down the back, the wolf's head on the left shoulder.
  s.add(rig.torso, fur, roughen(new TorusGeometry(0.16 * b, 0.042, 8, 18), 0.012, 51).rotateX(Math.PI / 2).scale(1.12, 0.8, 0.9).translate(0, 0.49, -0.03))
  const pelt = new Cape(s, rig.torso, [fur, fur, fur, fur, s.surface('#8a6a4a', { roughness: 1 }), fur], { width: 0.5 * b, length: 0.62, at: [0, 0.52, -chestFront(s, 0.52) - 0.03], ragged: 0.1, wrap: 0.16 })
  s.onFrame((frame) => pelt.update(frame))
  {
    const wolf = joint(rig.torso, -0.2 * b, 0.56, 0.03)
    wolf.rotation.set(0.2, -0.3, 0.3)
    s.add(wolf, fur, roughen(new SphereGeometry(0.075, 12, 10), 0.01, 5).scale(1, 0.85, 1.1))
    s.add(wolf, fur, shaped(new ConeGeometry(0.04, 0.12, 8), { turn: [Math.PI / 2, 0, 0], size: [1, 0.75, 1], at: [0, -0.015, 0.1] }))
    s.add(wolf, dark, shaped(new SphereGeometry(0.012, 6, 4), { at: [0, -0.01, 0.16] }), false)
    for (const side of [-1, 1]) {
      s.add(wolf, fur, shaped(new ConeGeometry(0.025, 0.06, 4), { turn: [-0.3, 0, side * -0.3], at: [side * 0.04, 0.07, -0.01] }))
      s.add(wolf, rune, shaped(new SphereGeometry(0.008, 6, 4), { at: [side * 0.03, 0.015, 0.06] }), false)
      s.add(wolf, bone, shaped(new ConeGeometry(0.005, 0.025, 4), { turn: [Math.PI, 0, 0], at: [side * 0.015, -0.045, 0.12] }), false)
    }
  }
  arms(s, { upper: skin, fore: skin, upperR: 0.078, foreR: 0.066 })
  for (const { side, shoulder, elbow } of rig.arms) {
    s.add(shoulder, skin, shaped(new SphereGeometry(0.06, 10, 8), { size: [1, 1.3, 0.9], at: [0, -0.15, 0.03] }))
    for (const y of [-0.08, -0.1]) ring(s, shoulder, gold, 0.081, 0.007, y)
    s.add(shoulder, paint, shaped(new BoxGeometry(0.01, 0.12, 0.022), { at: [side * 0.078, -0.13, 0] }), false)
    s.add(elbow, leather, lathe([[0.072, -0.27], [0.078, -0.16], [0.074, -0.08]], 14))
    for (let index = 0; index < 8; index += 1) {
      const turn = index / 8 * Math.PI * 2
      s.add(elbow, iron, shaped(new ConeGeometry(0.008, 0.02, 4), { turn: [Math.cos(turn) * Math.PI / 2, 0, -Math.sin(turn) * Math.PI / 2], at: [Math.sin(turn) * 0.08, -0.18, Math.cos(turn) * 0.08] }), false)
    }
  }
  hand(s, s.right.hand, 1, skin, 'grip', 1.25)
  hand(s, s.left.hand, -1, skin, 'grip', 1.25)
  face(s, { skin, white: s.surface('#ece6de'), iris: s.surface('#3a5a6a'), brows: hair, mouth: s.surface('#7a3a2a'), wide: 1.05 })
  // A stripe of paint across the eyes, the mane, the braided beard.
  s.add(rig.head, paint, shaped(lathe([[0.123, 0.12], [0.123, 0.146]], 18, -1.1, 2.2), { size: [0.97, 1, 1.02], at: [0, 0, -0.004] }), false)
  s.add(rig.head, hair, shaped(new SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.52), { turn: [-0.3, 0, 0], at: [0, 0.145, -0.02] }))
  const random = seededRandom(19)
  for (let index = 0; index < 14; index += 1) {
    const x = (index - 6.5) * 0.02
    const reach = 0.2 + random() * 0.15
    s.add(rig.head, hair, sweep([[x, 0.24, 0.0], [x * 1.4, 0.24, -0.1], [x * 1.8, 0.12, -0.18], [x * 2.2, 0.12 - reach, -0.16 - random() * 0.06]], (u) => 0.03 * (1 - u * 0.8), 5, 14))
  }
  s.add(rig.head, hair, roughen(shaped(new SphereGeometry(0.1, 12, 10), { size: [1, 0.9, 0.7], at: [0, 0.04, 0.06] }), 0.012, 7))
  for (const side of [-1, 1]) {
    s.add(rig.head, hair, sweep([[side * 0.035, 0.0, 0.1], [side * 0.04, -0.08, 0.11], [side * 0.03, -0.18, 0.08]], (u) => 0.022 * (1 - u * 0.5), 6, 12))
    for (const y of [-0.1, -0.16]) s.add(rig.head, gold, shaped(new CylinderGeometry(0.016, 0.016, 0.018, 10), { at: [side * 0.036, y, 0.1 - (y + 0.1) * 0.25] }))
  }

  // The warhammer: a long haft wound with leather, banded with iron; a great head with runes, a spike behind and on top.
  const main = joint(s.right.hand)
  const weapon = forward(main)
  s.add(weapon, wood, shaped(new CylinderGeometry(0.028, 0.032, 1.2, 10), { at: [0, 0.25, 0] }))
  for (let index = 0; index < 7; index += 1) s.add(weapon, leather, shaped(new TorusGeometry(0.032, 0.007, 4, 12), { turn: [Math.PI / 2 + (index % 2 ? 0.3 : -0.3), 0, 0], at: [0, -0.1 + index * 0.03, 0] }), false)
  for (const y of [-0.34, 0.2, 0.5]) s.add(weapon, iron, shaped(new CylinderGeometry(0.036, 0.036, 0.025, 10), { at: [0, y, 0] }))
  s.add(weapon, iron, shaped(new ConeGeometry(0.03, 0.08, 8), { turn: [Math.PI, 0, 0], at: [0, -0.39, 0] }))
  const head = joint(weapon, 0, 0.82, 0)
  s.add(head, iron, shaped(new BoxGeometry(0.3, 0.2, 0.2, 1, 1, 1)))
  s.add(head, iron, shaped(new CylinderGeometry(0.13, 0.13, 0.06, 8), { turn: [0, 0, Math.PI / 2], at: [0.17, 0, 0] }))
  s.add(head, iron, shaped(new ConeGeometry(0.07, 0.16, 6), { turn: [0, 0, Math.PI / 2], at: [-0.22, 0, 0] }))
  s.add(head, iron, shaped(new ConeGeometry(0.05, 0.14, 6), { at: [0, 0.17, 0] }))
  for (const facing of [-1, 1]) {
    s.add(head, rune, shaped(new BoxGeometry(0.16, 0.022, 0.006), { at: [0, 0.04, facing * 0.101] }), false)
    s.add(head, rune, shaped(new BoxGeometry(0.022, 0.1, 0.006), { at: [0.03, -0.01, facing * 0.101] }), false)
    s.add(head, rune, shaped(new OctahedronGeometry(0.02, 0), { size: [1, 1, 0.3], at: [-0.05, -0.03, facing * 0.101] }), false)
  }
  s.add(head, gold, shaped(new BoxGeometry(0.31, 0.03, 0.21), { at: [0, -0.09, 0] }))
  s.add(head, gold, shaped(new BoxGeometry(0.31, 0.03, 0.21), { at: [0, 0.09, 0] }))
  return s.finish({ main, mainHold: 'free', tip: head, strikeShape: { x: 1.4, y: 1, z: 1 } })
}

// ---------------------------------------------------------------------------------------------------------------- Monk

// A monk with a shaved head and a topknot, a robe crossing the chest from the left shoulder, the right arm bare, a sash knotted at
// the side, wide trousers bound at the ankle, sandals, a long string of prayer beads with a great bead and a tassel, and fists
// bound in cloth.
export function monk(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const robe = s.cloth(look.cloth, { roughness: 0.8 })
  const deep = s.cloth(shade(look.cloth, 0.75), { roughness: 0.8 })
  const sash = s.cloth(look.trim, { roughness: 0.8 })
  const skin = s.surface(look.skin, { roughness: 0.5 })
  const wraps = s.surface('#e8dcc2', { roughness: 0.95 })
  const wood = s.surface('#5a3418', { roughness: 0.5 })
  const hair = s.surface('#1e1612', { roughness: 0.6 })
  const bead = s.glow(look.accent, 0.7)
  const leather = s.surface('#4a3020', { roughness: 0.8 })

  legs(s, { thigh: deep, shin: deep, thighR: 0.095, shinR: 0.07, baggy: 0.1 })
  for (const { knee } of rig.legs) {
    for (let index = 0; index < 3; index += 1) ring(s, knee, wraps, 0.066 - index * 0.002, 0.01, -0.37 + index * 0.025)
    s.add(knee, skin, shaped(new SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), { size: [0.055, 0.04, 0.12], at: [0, -0.46, 0.04] }))
    s.add(knee, leather, shaped(new BoxGeometry(0.11, 0.018, 0.26), { at: [0, -0.471, 0.04] }))
    for (const z of [0.02, 0.1]) s.add(knee, leather, shaped(new TorusGeometry(0.052, 0.008, 4, 12, Math.PI), { size: [1, 0.7, 1], at: [0, -0.46, z] }))
  }
  // The chest painted: bare, but for the robe round it below and across it from the left shoulder to the right hip, front and back.
  // (Turned so the front is the middle of the picture: its left side a quarter in, its right three quarters.)
  const kesa = paintTexture(`kesa|${look.skin}|${look.cloth}`, 512, 256, (context, width, height) => {
    context.fillStyle = look.skin
    context.fillRect(0, 0, width, height)
    context.fillStyle = look.cloth
    context.fillRect(0, height * 0.5, width, height)
    for (const offset of [0, width]) {
      for (const points of [[[0.14, -0.05], [0.38, -0.05], [0.84, 0.55], [0.6, 0.55]], [[0.38, -0.05], [0.14, -0.05], [-0.34, 0.55], [-0.1, 0.55]]]) {
        context.beginPath()
        for (const [u, v] of points) context.lineTo(offset + u * width, v * height)
        context.fill()
      }
    }
    context.strokeStyle = shade(look.cloth, 0.7)
    context.lineWidth = 3
    for (const k of [0.3, 0.6]) {
      context.beginPath()
      context.moveTo((0.14 + 0.24 * k) * width, 0)
      context.lineTo((0.6 + 0.24 * k) * width, height * 0.55)
      context.stroke()
    }
    context.fillStyle = shade(look.cloth, 0.6)
    context.fillRect(0, height * 0.5, width, 4)
  })
  chest(s, kesa ? s.surface('#ffffff', { roughness: 0.6, map: kesa }) : robe, { from: Math.PI, profile: [...CHEST] })
  {
    const x = 0.075 * b
    s.add(rig.torso, skin, shaped(new SphereGeometry(0.1 * b, 14, 10), { size: [1, 0.62, 0.42], turn: [0, 0, 0.12], at: [x, 0.38, chestFront(s, 0.38, x) - 0.03] }))
  }
  const skirt = new Skirt(s, rig.hips, robe, { top: 0.04, length: 0.5, neck: 0.2, hem: 0.27, push: 0.9, ripple: 0.6 })
  s.onFrame((frame) => skirt.update(frame))
  band(s, rig.torso, sash, 0.2, -0.02, 0.08, [b, 0.82 * b])
  const knot = joint(rig.torso, 0.17 * b, 0.03, 0.1 * b)
  s.add(knot, sash, shaped(new SphereGeometry(0.035, 10, 8), { size: [1, 0.9, 0.8] }))
  for (const side of [-1, 1]) s.add(knot, sash, shaped(new BoxGeometry(0.05, 0.26, 0.01), { turn: [0, 0.6, side * 0.12], at: [side * 0.02, -0.13, 0] }))
  s.onFrame(({ t, walk }) => {
    knot.rotation.x = Math.sin(t * 2.5) * 0.05 + walk * 0.15
  })
  // The prayer beads, round the neck and hanging down the chest, a great bead and a tassel at the bottom.
  for (let index = 0; index < 26; index += 1) {
    const k = index / 26
    const turn = k * Math.PI * 2
    const hang = Math.max(0, Math.cos(turn))
    const y = 0.54 - hang * 0.24
    const x = Math.sin(turn) * 0.15 * b * (1 - hang * 0.4)
    const z = Math.cos(turn) > 0 ? chestFront(s, y, x) + 0.03 : -0.13 * b
    s.add(rig.torso, wood, shaped(new SphereGeometry(0.022, 8, 6), { at: [x, y, z] }))
  }
  s.add(rig.torso, bead, shaped(new SphereGeometry(0.034, 12, 10), { at: [0, 0.26, chestFront(s, 0.26) + 0.04] }), false)
  s.add(rig.torso, sash, shaped(new ConeGeometry(0.025, 0.09, 8), { at: [0, 0.18, chestFront(s, 0.2) + 0.04] }))
  arms(s, { upper: skin, fore: skin, upperR: 0.07, foreR: 0.06 })
  for (const { side, shoulder, elbow, hand: palm } of rig.arms) {
    if (side < 0) s.add(shoulder, robe, lathe([[0.085, -0.2], [0.085, -0.05], [0.08, 0.04]], 16))
    s.add(shoulder, skin, shaped(new SphereGeometry(0.055, 10, 8), { size: [1, 1.3, 0.9], at: [0, -0.14, 0.03] }))
    for (let index = 0; index < 4; index += 1) ring(s, elbow, wraps, 0.058 - index * 0.002, 0.008, -0.27 + index * 0.028)
    hand(s, palm, side, skin, 'fist', 1.15)
    for (let index = 0; index < 2; index += 1) s.add(palm, wraps, shaped(new TorusGeometry(0.042, 0.009, 5, 12), { turn: [Math.PI / 2, 0, index * 0.5], at: [0, 0.012 - index * 0.02, 0] }))
  }
  face(s, { skin, white: s.surface('#ece6de'), iris: s.surface('#2a1e14'), brows: hair, mouth: s.surface('#7a4a3a') })
  // The topknot.
  s.add(rig.head, hair, shaped(new SphereGeometry(0.045, 12, 10), { size: [1, 0.85, 1], at: [0, 0.27, -0.04] }))
  s.add(rig.head, sash, shaped(new TorusGeometry(0.028, 0.01, 6, 14), { turn: [Math.PI / 2, 0, 0], at: [0, 0.245, -0.035] }))
  s.add(rig.head, hair, shaped(new ConeGeometry(0.02, 0.06, 8), { at: [0, 0.32, -0.045] }))
  return s.finish({ main: joint(s.right.hand), mainHold: 'free', tip: s.right.hand, offStrike: s.left.hand, strikeShape: { x: 0.7, y: 0.7, z: 0.7 } })
}

// ---------------------------------------------------------------------------------------------------------------- Aurel

// A vampire: deathly pale, slick black hair to a widow's peak, pointed ears, red eyes and fangs, a high collar red within, a long
// dark coat open over a red waistcoat with gold buttons and a lace cravat pinned with a ruby, its tails to the knee, a cape lined in
// red, lace at the cuffs, tall boots, and long dark claws with red points and gold rings.
export function aurel(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const coat = s.cloth(look.cloth, { roughness: 0.55 })
  const red = s.cloth(look.trim, { roughness: 0.5 })
  const skin = s.surface(look.skin, { roughness: 0.4 })
  const hair = s.surface('#0e0b0e', { roughness: 0.3, metalness: 0.2 })
  const lace = s.surface('#ece8f0', { roughness: 0.8, side: DoubleSide })
  const gold = s.surface('#c9a24a', { roughness: 0.25, metalness: 0.85 })
  const boot = s.surface('#0c0a0c', { roughness: 0.2, metalness: 0.3 })
  const eyes = s.glow(look.eyes ?? look.accent, 1.4)
  const ruby = s.glow(look.accent, 1.2)
  const nail = s.surface('#2a2228', { roughness: 0.3, metalness: 0.4 })
  const silver = s.surface('#c8ccd6', { roughness: 0.3, metalness: 0.85 })

  legs(s, { thigh: coat, shin: coat, thighR: 0.08, shinR: 0.06 })
  boots(s, { material: boot, sole: boot, height: 0.32, toe: 'pointed' })
  for (const { knee } of rig.legs) {
    ring(s, knee, silver, 0.074, 0.007, -0.32)
    s.add(knee, silver, shaped(new BoxGeometry(0.025, 0.02, 0.008), { at: [0.05, -0.32, 0.055] }))
  }
  chest(s, coat)
  // The waistcoat showing between the lapels, its buttons, the cravat and its ruby.
  chest(s, red, { grow: 0.004, from: -0.45, span: 0.9, profile: [[0.168, 0.02], [0.19, 0.2], [0.205, 0.32], [0.2, 0.42]] })
  for (let index = 0; index < 4; index += 1) {
    const y = 0.08 + index * 0.075
    s.add(rig.torso, gold, shaped(new SphereGeometry(0.011, 8, 6), { at: [0.02, y, chestFront(s, y, 0.02, { grow: 0.004 }) + 0.004] }), false)
  }
  for (const side of [-1, 1]) strap(s, rig.torso, coat, [side * 0.13, 0.52, chestFront(s, 0.52, side * 0.13) + 0.01], [side * 0.06, 0.12, chestFront(s, 0.12, side * 0.06) + 0.01], 0.06, 0.012)
  for (let index = 0; index < 5; index += 1) {
    const y = 0.5 - index * 0.04
    s.add(rig.torso, lace, shaped(new SphereGeometry(0.045 - index * 0.004, 10, 6), { size: [1, 0.45, 0.4], at: [0, y, chestFront(s, y) + 0.02] }))
  }
  s.add(rig.torso, ruby, shaped(new OctahedronGeometry(0.018, 0), { size: [1, 1.2, 0.6], at: [0, 0.5, chestFront(s, 0.5) + 0.04] }), false)
  s.add(rig.torso, gold, shaped(new TorusGeometry(0.02, 0.004, 4, 12), { at: [0, 0.5, chestFront(s, 0.5) + 0.038] }))
  // The coat's tails, red within; the cape, red within.
  const tails = new Skirt(s, rig.hips, coat, { top: 0.06, length: 0.58, neck: 0.185, hem: 0.27, from: 0.5, span: Math.PI * 2 - 1, push: 0.8 })
  const tailLining = new Skirt(s, rig.hips, red, { top: 0.055, length: 0.57, neck: 0.18, hem: 0.265, from: 0.52, span: Math.PI * 2 - 1.04, push: 0.8, shadow: false })
  const cape = new Cape(s, rig.torso, [red, red, red, red, red, coat], { width: 0.56 * b, length: 1.05, at: [0, 0.53, -chestFront(s, 0.53) - 0.012] })
  s.onFrame((frame) => {
    tails.update(frame)
    tailLining.update(frame)
    cape.update(frame)
  })
  belt(s, coat, silver, { y: 0.06, r: 0.183 })
  arms(s, { upper: coat, fore: coat, upperR: 0.058, foreR: 0.05 })
  for (const { elbow, shoulder } of rig.arms) {
    s.add(shoulder, coat, shaped(new SphereGeometry(0.085, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), { size: [1, 0.7, 1] }))
    band(s, elbow, red, 0.062, -0.27, -0.2, [1, 1], 0.058)
    s.add(elbow, lace, lathe([[0.072, -0.32], [0.06, -0.28], [0.055, -0.26]], 16))
  }
  face(s, { skin, glow: eyes, socket: s.surface('#2a0a10', { roughness: 0.6 }), brows: hair, ears: 'pointed', mouth: s.surface('#5a1a24') })
  for (const side of [-1, 1]) s.add(rig.head, lace, shaped(new ConeGeometry(0.005, 0.02, 4), { turn: [Math.PI, 0, 0], at: [side * 0.012, 0.058, 0.112] }), false)
  // Slick hair to a widow's peak, swept back.
  s.add(rig.head, hair, shaped(new SphereGeometry(0.134, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.48), { turn: [-0.3, 0, 0], at: [0, 0.135, -0.01] }))
  s.add(rig.head, hair, shaped(new ConeGeometry(0.03, 0.07, 4), { turn: [Math.PI - 0.6, 0, 0], at: [0, 0.205, 0.105] }))
  for (let index = 0; index < 7; index += 1) {
    const x = (index - 3) * 0.03
    s.add(rig.head, hair, sweep([[x, 0.22, 0.04], [x * 1.1, 0.24, -0.08], [x * 1.15, 0.12, -0.15], [x * 1.1, 0.02, -0.14]], (u) => 0.022 * (1 - u * 0.6), 6, 14))
  }
  // The high collar.
  s.add(rig.head, coat, lathe([[0.15, -0.08], [0.2, 0.06], [0.25, 0.22]], 18, Math.PI * 0.55, Math.PI * 0.9))
  s.add(rig.head, red, lathe([[0.145, -0.08], [0.194, 0.06], [0.243, 0.215]], 18, Math.PI * 0.55, Math.PI * 0.9))

  // The claws: long fingers, dark nails with red points, and rings.
  const main = joint(s.right.hand)
  const off = joint(s.left.hand)
  for (const [held, side] of [[main, 1], [off, -1]] as const) {
    s.add(held, skin, shaped(new SphereGeometry(0.044, 12, 8), { size: [0.72, 1, 1.05], at: [side * 0.006, 0.006, 0] }))
    const claws = joint(held)
    claws.rotation.x = Math.PI - 0.25
    for (let index = 0; index < 4; index += 1) {
      const finger = joint(claws, (index - 1.5) * 0.022, 0.03, 0)
      finger.rotation.z = (index - 1.5) * -0.1
      s.add(finger, skin, shaped(new CapsuleGeometry(0.009, 0.06, 3, 6), { at: [0, 0.04, 0] }))
      s.add(finger, nail, sweep([[0, 0.07, 0], [0, 0.16, 0.01], [0, 0.24, 0.04]], (u) => 0.011 * (1 - u * 0.85), 5, 10))
      s.add(finger, ruby, shaped(new ConeGeometry(0.004, 0.03, 4), { turn: [0.3, 0, 0], at: [0, 0.245, 0.045] }), false)
      if (index === 1) s.add(finger, gold, shaped(new TorusGeometry(0.011, 0.003, 4, 10), { turn: [Math.PI / 2, 0, 0], at: [0, 0.04, 0] }))
    }
  }
  return s.finish({ main, mainHold: 'free', off, offHold: 'free', tip: main, strike: main, offStrike: off, strikeShape: { x: 0.9, y: 1.2, z: 0.9 } })
}

// ---------------------------------------------------------------------------------------------------------------- Ent

// A treant: a trunk of grooved bark for a body with knotholes, moss and mushrooms on its shoulders and a vine wound round it, legs of
// wood spreading into roots, branching arms ending in twigs that sprout leaves, a stump of a head with hollow eyes that glow, a
// beard of hanging moss, and antlers of branches crowned with leaves.
export function ent(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const barkTexture = paintTexture(`bark|${look.skin}`, 256, 256, (context, width, height) => {
    context.fillStyle = look.skin
    context.fillRect(0, 0, width, height)
    const random = seededRandom(23)
    for (let index = 0; index < 70; index += 1) {
      const x = random() * width
      context.strokeStyle = index % 3 ? shade(look.skin, 0.55) : shade(look.skin, 1.18)
      context.lineWidth = 1 + random() * 3
      context.beginPath()
      context.moveTo(x, 0)
      for (let y = 0; y <= height; y += 16) context.lineTo(x + Math.sin(y * 0.05 + index) * 4 + (random() - 0.5) * 3, y)
      context.stroke()
    }
  })
  const bark = s.surface(barkTexture ? '#ffffff' : look.skin, { roughness: 0.95, map: barkTexture ?? null })
  const darkBark = s.surface(shade(look.skin, 0.7), { roughness: 0.95, flatShading: true })
  const moss = s.surface(look.trim, { roughness: 1, flatShading: true })
  const leaf = s.surface('#6fbf4a', { roughness: 0.6, side: DoubleSide })
  const leaf2 = s.surface('#4f8f34', { roughness: 0.7, side: DoubleSide })
  const hollow = s.surface('#120b06', { roughness: 1 })
  const eyes = s.glow(look.eyes ?? look.accent, 2.4)
  const capRed = s.surface('#b8462e', { roughness: 0.6 })
  const stem = s.surface('#efe6d2', { roughness: 0.8 })
  const random = seededRandom(41)
  const leafAt = (parent: Object3D, at: Triple, turn: Triple, size = 1): void => {
    s.add(parent, random() > 0.5 ? leaf : leaf2, shaped(new SphereGeometry(1, 8, 6), { size: [0.03 * size, 0.06 * size, 0.008], turn, at }))
  }
  const knurl = (geometry: ReturnType<typeof lathe>, amount: number, seed: number): ReturnType<typeof lathe> => roughen(geometry, amount, seed)

  // The legs, and roots for feet.
  for (const { hip, knee } of rig.legs) {
    s.add(hip, bark, knurl(lathe([[0.1, -0.44], [0.115, -0.25], [0.125, -0.05], [0.12, 0.04]], 12), 0.012, 3))
    s.add(knee, bark, knurl(lathe([[0.11, -0.46], [0.09, -0.3], [0.095, -0.1], [0.105, 0.04]], 12), 0.012, 5))
    s.add(knee, darkBark, roughen(new SphereGeometry(0.1, 10, 8), 0.015, 6))
    for (let index = 0; index < 5; index += 1) {
      const turn = (index - 2) * 0.55 + (index % 2) * 0.1
      const reach = 0.13 + random() * 0.06
      s.add(knee, bark, sweep([[0, -0.38, 0], [Math.sin(turn) * 0.08, -0.44, Math.cos(turn) * 0.08], [Math.sin(turn) * reach, -0.475, Math.cos(turn) * reach + 0.02]], (u) => 0.04 * (1 - u * 0.8), 6, 10))
    }
  }
  // The trunk: wide in the chest, knotholes, a vine wound round it, moss and mushrooms on the shoulders.
  const trunk: Array<[number, number]> = [[0.17, -0.08], [0.19, 0.05], [0.22, 0.2], [0.25, 0.34], [0.25, 0.44], [0.2, 0.53], [0.12, 0.6]]
  s.add(rig.torso, bark, knurl(lathe(trunk, 16), 0.018, 7).scale(b, 1, 0.85 * b))
  for (const [x, y] of [[0.08, 0.3], [-0.1, 0.12]] as const) {
    const z = chestFront(s, y, x, { profile: trunk, depth: 0.85 })
    s.add(rig.torso, darkBark, shaped(new TorusGeometry(0.03, 0.014, 6, 10), { size: [1, 1.4, 1], at: [x, y, z - 0.004] }))
    s.add(rig.torso, hollow, shaped(new SphereGeometry(0.026, 8, 6), { size: [1, 1.4, 0.5], at: [x, y, z - 0.004] }), false)
  }
  const vine: Triple[] = []
  for (let index = 0; index <= 30; index += 1) {
    const turn = index * 0.42
    const y = -0.02 + index * 0.017
    const r = 0.012 + (trunk.find(([, py]) => py >= y)?.[0] ?? 0.2)
    vine.push([Math.sin(turn) * r * b, y, Math.cos(turn) * r * 0.85 * b])
  }
  s.add(rig.torso, moss, sweep(vine, 0.01, 5, 90))
  for (let index = 3; index < 30; index += 4) leafAt(rig.torso, [vine[index][0] * 1.05, vine[index][1], vine[index][2] * 1.05], [0, index * 0.42, 1.2], 1.2)
  for (const side of [-1, 1]) {
    for (let index = 0; index < 4; index += 1) s.add(rig.torso, moss, roughen(new IcosahedronGeometry(0.06 + random() * 0.03, 1), 0.02, index).translate(side * (0.16 + index * 0.03) * b, 0.5 - index * 0.03, (random() - 0.5) * 0.15))
  }
  for (const [x, z, size] of [[0.2, 0.05, 1], [0.24, -0.04, 0.7], [0.17, -0.08, 0.6]] as const) {
    s.add(rig.torso, stem, shaped(new CylinderGeometry(0.01 * size, 0.012 * size, 0.05 * size, 8), { at: [x * b, 0.56 + 0.025 * size, z] }))
    s.add(rig.torso, capRed, shaped(new SphereGeometry(0.035 * size, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), { size: [1, 0.6, 1], at: [x * b, 0.56 + 0.05 * size, z] }))
  }
  // The arms: branches, a leafy sprig at the elbow, and twigs for fingers.
  for (const { side, shoulder, elbow, hand: palm } of rig.arms) {
    s.add(shoulder, bark, knurl(lathe([[0.075, -0.32], [0.085, -0.15], [0.095, 0.0], [0.09, 0.06]], 10), 0.012, 11))
    s.add(elbow, bark, knurl(lathe([[0.06, -0.3], [0.072, -0.15], [0.08, 0.02]], 10), 0.01, 12))
    s.add(elbow, darkBark, roughen(new SphereGeometry(0.085, 10, 8), 0.014, 13))
    s.add(elbow, bark, sweep([[side * 0.05, -0.05, 0], [side * 0.13, 0.02, -0.03], [side * 0.16, 0.12, -0.05]], (u) => 0.02 * (1 - u * 0.8), 5, 10))
    for (let index = 0; index < 4; index += 1) leafAt(elbow, [side * (0.14 + index * 0.01), 0.08 + index * 0.02, -0.05], [0, 0, side * (0.5 + index * 0.4)], 1.4)
    s.add(palm, bark, roughen(new SphereGeometry(0.065, 10, 8), 0.012, 14))
    for (let index = 0; index < 4; index += 1) {
      const turn = (index - 1.5) * 0.45
      s.add(palm, darkBark, sweep([[0, -0.03, 0], [Math.sin(turn) * 0.05, -0.1, 0.03], [Math.sin(turn) * 0.08, -0.18, 0.08]], (u) => 0.018 * (1 - u * 0.85), 5, 10))
    }
    s.add(palm, darkBark, sweep([[-side * 0.04, -0.01, 0.02], [-side * 0.07, -0.06, 0.07], [-side * 0.06, -0.1, 0.12]], (u) => 0.016 * (1 - u * 0.85), 5, 10))
  }
  // The head: a stump, hollow eyes glowing, a hollow mouth, a heavy brow, a beard of moss and hanging roots.
  const head = rig.head
  s.add(head, bark, knurl(lathe([[0.12, -0.03], [0.14, 0.08], [0.14, 0.2], [0.12, 0.27], [0.06, 0.3], [0.001, 0.305]], 14), 0.012, 15).scale(1, 1, 0.95))
  for (const side of [-1, 1]) {
    s.add(head, hollow, shaped(new SphereGeometry(0.03, 10, 8), { size: [1.2, 1, 0.6], at: [side * 0.05, 0.15, 0.12] }), false)
    s.add(head, eyes, shaped(new SphereGeometry(0.016, 8, 6), { at: [side * 0.05, 0.15, 0.13] }), false)
  }
  s.add(head, darkBark, roughen(shaped(new CapsuleGeometry(0.03, 0.12, 4, 8), { turn: [0, 0, Math.PI / 2], at: [0, 0.19, 0.12] }), 0.008, 16))
  s.add(head, hollow, shaped(new SphereGeometry(0.035, 10, 8), { size: [1.4, 0.5, 0.5], at: [0, 0.06, 0.13] }), false)
  for (let index = 0; index < 9; index += 1) {
    const x = (index - 4) * 0.025
    const reach = 0.12 + random() * 0.12
    s.add(head, index % 2 ? moss : darkBark, sweep([[x, 0.05, 0.12 - Math.abs(x) * 0.4], [x * 1.1, 0.0, 0.13 - Math.abs(x) * 0.4], [x * 1.2, -reach, 0.11 - Math.abs(x) * 0.3]], (u) => 0.016 * (1 - u * 0.7), 5, 10))
  }
  for (const side of [-1, 1]) {
    const beam: Triple[] = [[side * 0.07, 0.26, -0.01], [side * 0.15, 0.36, -0.03], [side * 0.2, 0.5, -0.06], [side * 0.22, 0.62, -0.04]]
    s.add(head, darkBark, sweep(beam, (u) => 0.03 * (1 - u * 0.75), 6, 20))
    for (const [from, to] of [[1, [side * 0.26, 0.42, 0.04]], [2, [side * 0.3, 0.56, -0.1]], [2, [side * 0.12, 0.6, -0.02]]] as const) {
      s.add(head, darkBark, sweep([beam[from], to as Triple], (u) => 0.018 * (1 - u * 0.75), 5, 6))
      for (let index = 0; index < 3; index += 1) leafAt(head, [(to as Triple)[0] + (random() - 0.5) * 0.05, (to as Triple)[1] + (random() - 0.3) * 0.04, (to as Triple)[2] + (random() - 0.5) * 0.05], [random() * 2, random() * 2, random() * 2], 1.5)
    }
  }
  for (let index = 0; index < 12; index += 1) {
    const turn = index / 12 * Math.PI * 2
    leafAt(head, [Math.sin(turn) * 0.1, 0.29, Math.cos(turn) * 0.1], [Math.cos(turn) * 0.9, 0, -Math.sin(turn) * 0.9], 1.6)
  }
  return s.finish({ main: joint(s.right.hand), mainHold: 'free', tip: s.right.hand, offStrike: s.left.hand, strikeShape: { x: 0.8, y: 0.8, z: 0.8 } })
}
