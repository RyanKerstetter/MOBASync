import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  SphereGeometry,
  TorusGeometry,
  type Group,
  type Material,
  type Object3D,
} from 'three'
import { seededRandom } from '../../space.ts'
import type { Look } from '../looks.ts'
import { joint } from '../model.ts'
import { arms, band, belt, boots, chest, chestFront, face, hand, legs, ring, strap } from './body.ts'
import { lathe, paintTexture, roughen, Sculpt, shade, shaped, Skirt, sweep, weave, type Detail, type DetailKit, type Rig, type Triple } from './kit.ts'

// The ones who shoot: the Archer with a longbow, and the Soldier and the Grenadier with guns carried in both hands (see
// `Detail.carried`), built along +Y from the grip, their top toward -Z.

// A box with its edges rounded off a little, as made things are.
function block(width: number, height: number, depth: number): BoxGeometry {
  return new BoxGeometry(width, height, depth, 1, 1, 1)
}

// A pouch with a flap: a box, its flap over the top in a darker shade, and a press stud.
function pouch(s: Sculpt, parent: Object3D, material: Material, flap: Material, stud: Material | undefined, at: Triple, size: Triple, turn: Triple = [0, 0, 0]): void {
  const [w, h, d] = size
  s.add(parent, material, shaped(block(w, h, d), { turn, at }))
  s.add(parent, flap, shaped(block(w * 1.04, h * 0.35, d * 1.08), { turn, at: [at[0], at[1] + h * 0.34, at[2]] }))
  if (stud) s.add(parent, stud, shaped(new SphereGeometry(Math.min(w, h) * 0.08, 6, 4), { turn, at: [at[0] + Math.sin(turn[1]) * d * 0.55, at[1] + h * 0.22, at[2] + Math.cos(turn[1]) * d * 0.55] }), false)
}

// ---------------------------------------------------------------------------------------------------------------- Archer

// A hunter in a green jerkin laced over a linen shirt, a dagged hood down on the shoulders, a peaked cap with a long feather, a
// bracer on the bow arm and a glove on the other, tall boots turned down at the top, a quiver of fletched arrows on the back, and
// a recurved longbow with a wrapped grip.
export function archer(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const jerkin = s.cloth(look.cloth, { roughness: 0.75 })
  const deep = s.cloth(shade(look.cloth, 0.72))
  const linen = s.surface('#d8cdb0', { roughness: 0.9 })
  const leather = s.surface(look.trim, { roughness: 0.75 })
  const darkLeather = s.surface(shade(look.trim, 0.6), { roughness: 0.8 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const hair = s.surface('#5a3a20', { roughness: 0.8 })
  const brass = s.surface('#c9a24a', { roughness: 0.3, metalness: 0.8 })
  const feather = s.surface('#c8453a', { roughness: 0.6, side: DoubleSide })
  const white = s.surface('#ece6da', { roughness: 0.6, side: DoubleSide })
  const wood = s.surface('#8a5a30', { roughness: 0.6 })
  const string = s.surface('#efe8d8', { roughness: 0.5 })
  const gem = s.glow(look.accent, 1)

  legs(s, { thigh: leather, shin: leather, thighR: 0.085, shinR: 0.063 })
  boots(s, { material: darkLeather, sole: s.surface('#2a1e16'), height: 0.3, cuff: leather, toe: 'round' })
  chest(s, linen)
  chest(s, jerkin, { grow: 0.008, profile: [[0.165, -0.01], [0.17, 0.08], [0.19, 0.2], [0.205, 0.32], [0.205, 0.4], [0.185, 0.47], [0.14, 0.52]] })
  // Laced up the front, over the shirt showing at the neck.
  for (let index = 0; index < 6; index += 1) {
    const y = 0.12 + index * 0.055
    for (const side of [-1, 1]) strap(s, rig.torso, linen, [side * 0.022, y, chestFront(s, y, 0, { grow: 0.008 }) + 0.004], [-side * 0.022, y + 0.045, chestFront(s, y + 0.045, 0, { grow: 0.008 }) + 0.004], 0.005, 0.004)
  }
  const jerkinSkirt = new Skirt(s, rig.hips, jerkin, { top: 0.04, length: 0.3, neck: 0.19, hem: 0.24, push: 0.8, ripple: 0.4 })
  const hood = new Skirt(s, rig.torso, deep, { top: 0.56, length: 0.21, neck: 0.15, hem: 0.3, ragged: 0.06, tatters: 10, push: 0, ripple: 0.4, seed: 6 })
  s.onFrame((frame) => {
    jerkinSkirt.update(frame)
    hood.update(frame)
  })
  // The hood itself, bunched behind the neck.
  s.add(rig.torso, deep, shaped(new SphereGeometry(0.11, 14, 10), { size: [1.2, 0.8, 0.8], at: [0, 0.56, -0.17] }))
  belt(s, darkLeather, brass, { y: 0.03, r: 0.19 })
  pouch(s, rig.hips, leather, darkLeather, brass, [0.15 * b, -0.03, 0.12], [0.07, 0.08, 0.04], [0, 0.8, 0])
  // A knife on the left hip.
  {
    const knife = joint(rig.hips, -0.18 * b, -0.02, 0.07)
    knife.rotation.set(0.2, 0, -0.25)
    s.add(knife, darkLeather, lathe([[0.004, -0.2], [0.022, -0.17], [0.024, 0]], 8).scale(1, 1, 0.45))
    s.add(knife, wood, shaped(new CylinderGeometry(0.012, 0.014, 0.07, 8), { at: [0, 0.04, 0] }))
    s.add(knife, brass, shaped(new BoxGeometry(0.05, 0.01, 0.018), { at: [0, 0.006, 0] }))
  }
  arms(s, { upper: linen, fore: linen, upperR: 0.056, foreR: 0.05 })
  // A bracer on the bow arm, laced; a glove on the drawing hand.
  for (const { side, elbow } of rig.arms) {
    if (side < 0) {
      s.add(elbow, leather, lathe([[0.058, -0.26], [0.063, -0.12], [0.06, -0.06]], 16))
      for (let index = 0; index < 4; index += 1) ring(s, elbow, darkLeather, 0.062, 0.004, -0.23 + index * 0.045)
    } else {
      s.add(elbow, darkLeather, lathe([[0.062, -0.28], [0.054, -0.22], [0.05, -0.18]], 14))
    }
  }
  hand(s, s.right.hand, 1, darkLeather, 'open')
  face(s, { skin, white: s.surface('#f2ece4'), iris: s.surface('#4a6a3a'), brows: hair, hair, mouth: s.surface('#9a5a4a') })
  // Short hair under the cap, and the cap: a peak in front, its brim turned up behind, and the feather.
  s.add(rig.head, hair, shaped(new SphereGeometry(0.13, 16, 10, Math.PI / 2 + 0.8, Math.PI * 2 - 1.6, 0.3, Math.PI * 0.4), { at: [0, 0.14, -0.012] }))
  const cap = joint(rig.head, 0, 0.17, -0.01)
  cap.rotation.x = -0.12
  s.add(cap, jerkin, shaped(lathe([[0.142, 0.0], [0.14, 0.06], [0.1, 0.12], [0.03, 0.15], [0.001, 0.152]], 24), { size: [1, 1, 1.15] }))
  s.add(cap, jerkin, shaped(new ConeGeometry(0.1, 0.16, 3), { size: [1, 1, 0.18], turn: [Math.PI / 2 - 0.15, 0, 0], at: [0, 0.015, 0.17] }))
  s.add(cap, deep, lathe([[0.15, 0.0], [0.17, 0.05]], 20, Math.PI * 0.6, Math.PI * 0.8).scale(1, 1, 1.15))
  ring(s, cap, leather, 0.143, 0.008, 0.012, [1, 1.15])
  const plume = joint(cap, 0.11, 0.05, -0.06)
  plume.rotation.set(-0.9, 0, -0.3)
  s.add(plume, white, sweep([[0, 0, 0], [0, 0.15, -0.02], [0, 0.3, -0.07]], 0.004, 4, 10))
  s.add(plume, feather, shaped(new SphereGeometry(1, 10, 8), { size: [0.03, 0.15, 0.004], turn: [-0.15, 0, 0], at: [0.008, 0.16, -0.03] }))
  s.add(plume, white, shaped(new SphereGeometry(1, 8, 6), { size: [0.022, 0.05, 0.005], at: [0.006, 0.31, -0.07] }))
  s.onFrame(({ t, walk }) => {
    plume.rotation.x = -0.9 - walk * 0.2 + Math.sin(t * 3) * 0.04
  })

  // The quiver on the back, its strap across the chest, and the arrows in it.
  const backZ = -chestFront(s, 0.32) - 0.06
  const quiver = joint(rig.torso, 0.07, 0.3, backZ)
  quiver.rotation.set(-0.15, 0, -0.35)
  s.add(quiver, leather, lathe([[0.048, -0.24], [0.058, -0.2], [0.06, 0.2], [0.064, 0.22]], 16))
  s.add(quiver, darkLeather, lathe([[0.001, -0.25], [0.05, -0.24]], 12))
  for (const y of [-0.16, 0.0, 0.16]) ring(s, quiver, darkLeather, 0.061, 0.006, y)
  ring(s, quiver, brass, 0.064, 0.006, 0.22)
  for (let index = 0; index < 7; index += 1) {
    const turn = index / 7 * Math.PI * 2
    const x = Math.cos(turn) * 0.03
    const z = Math.sin(turn) * 0.025
    const lean = (index - 3) * 0.04
    s.add(quiver, wood, shaped(new CylinderGeometry(0.004, 0.004, 0.2, 5), { turn: [0, 0, lean], at: [x, 0.3, z] }))
    for (let vane = 0; vane < 3; vane += 1) {
      s.add(quiver, index % 3 === 0 ? white : feather, shaped(new BoxGeometry(0.018, 0.06, 0.002), { turn: [0, vane * Math.PI * 2 / 3, lean], at: [x + Math.cos(vane * 2.1) * 0.008, 0.36, z + Math.sin(vane * 2.1) * 0.008] }))
    }
  }
  strap(s, rig.torso, darkLeather, [0.15 * b, 0.5, chestFront(s, 0.5, 0.15 * b) + 0.01], [-0.16 * b, 0.1, chestFront(s, 0.1, -0.16 * b) + 0.012], 0.035, 0.008)
  strap(s, rig.torso, darkLeather, [0.15 * b, 0.5, -chestFront(s, 0.5, 0.15 * b) - 0.01], [-0.12 * b, 0.12, -chestFront(s, 0.12, -0.12 * b) - 0.015], 0.035, 0.008)
  s.add(rig.torso, brass, shaped(new TorusGeometry(0.014, 0.004, 4, 10), { at: [0.0, 0.3, chestFront(s, 0.3) + 0.02] }))

  // The bow, in the left hand: its +X points back at the archer, its belly at the hand, its string behind.
  const off = joint(s.left.hand)
  const bow = joint(off)
  bow.rotation.y = Math.PI / 2
  hand(s, off, -1, skin, 'grip', 1, 'y')
  for (const flip of [1, -1]) {
    const limb: Triple[] = [[0, 0.04 * flip, 0], [0.04, 0.22 * flip, 0], [0.15, 0.42 * flip, 0], [0.27, 0.54 * flip, 0], [0.25, 0.6 * flip, 0]]
    s.add(bow, wood, sweep(limb, (u) => 0.022 - u * 0.013, 7, 30).scale(1, 1, 1.5))
    s.add(bow, white, shaped(new SphereGeometry(0.012, 8, 6), { at: [0.25, 0.6 * flip, 0] }))
  }
  s.add(bow, wood, shaped(new CapsuleGeometry(0.024, 0.12, 4, 8), { size: [1, 1, 1.3] }))
  s.add(bow, darkLeather, shaped(new CylinderGeometry(0.028, 0.028, 0.11, 10), { size: [1, 1, 1.3] }))
  s.add(bow, gem, shaped(new SphereGeometry(0.012, 8, 6), { at: [-0.02, 0.09, 0] }), false)
  s.add(bow, string, shaped(new CylinderGeometry(0.003, 0.003, 1.08, 3), { at: [0.265, 0, 0] }), false)
  return s.finish({ main: joint(s.right.hand), mainHold: 'free', off, offHold: 'bow', tip: bow, strike: bow, strikeShape: { x: 0.8, y: 2.6, z: 0.8 } })
}

// ---------------------------------------------------------------------------------------------------------------- guns

// A gun held in both hands, on the root (see humanoid.ts), built along +Y from the grip with its top toward -Z.
function carried(s: Sculpt): Group {
  return joint(s.rig.root)
}

// A camouflage cloth, in blots of the cloth's colours.
function camo(s: Sculpt, look: Look): Material {
  const texture = paintTexture(`camo|${look.cloth}|${look.trim}`, 256, 256, (context, width, height) => {
    weave(context, width, height, look.cloth, false)
    const random = seededRandom(17)
    for (const [color, count, size] of [[look.trim, 26, 26], [shade(look.cloth, 1.25), 22, 20], ['#2a2a20', 18, 14]] as const) {
      context.fillStyle = color
      for (let index = 0; index < count; index += 1) {
        const x = random() * width
        const y = random() * height
        context.beginPath()
        for (let k = 0; k < 7; k += 1) {
          const turn = k / 7 * Math.PI * 2
          const r = size * (0.5 + random() * 0.7)
          context.lineTo(x + Math.cos(turn) * r * 1.4, y + Math.sin(turn) * r)
        }
        context.fill()
      }
    }
  })
  return s.cloth(texture ? '#ffffff' : look.cloth, { map: texture ?? null, roughness: 0.9 })
}

// ---------------------------------------------------------------------------------------------------------------- Soldier

// A soldier in camouflage under a plate carrier hung with magazine pouches and a radio, a helmet with a cover, goggles and a chin
// strap, gloves, knee pads, laced boots, a pack with a bedroll, and a rifle with a scope, a curved magazine and a sling.
export function soldier(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const fatigues = camo(s, look)
  const gear = s.surface(look.trim, { roughness: 0.85 })
  const webbing = s.surface(shade(look.trim, 0.8), { roughness: 0.9 })
  const tan = s.surface('#8a7356', { roughness: 0.85 })
  const glove = s.surface('#2b2b26', { roughness: 0.8 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const black = s.surface('#1d1f1f', { roughness: 0.45, metalness: 0.5 })
  const gunmetal = s.surface('#3a3d40', { roughness: 0.35, metalness: 0.75 })
  const lens = s.glow(look.accent, 0.5, { roughness: 0.05, metalness: 0.6 })
  const patch = s.surface(look.accent, { roughness: 0.7 })

  legs(s, { thigh: fatigues, shin: fatigues, thighR: 0.09, shinR: 0.07, baggy: 0.08 })
  boots(s, { material: tan, sole: s.surface('#2a241c'), height: 0.17, laces: s.surface('#3a2e22') })
  for (const { knee } of rig.legs) s.add(knee, gear, shaped(new SphereGeometry(0.07, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), { turn: [Math.PI / 2 - 0.2, 0, 0], size: [1, 1, 0.8], at: [0, -0.02, 0.035] }))
  // A holster on the right thigh.
  {
    const hip = rig.legs.find((leg) => leg.side > 0)!.hip
    s.add(hip, gear, shaped(block(0.05, 0.16, 0.08), { at: [0.09, -0.16, 0.0] }))
    s.add(hip, black, shaped(block(0.035, 0.06, 0.07), { turn: [0.3, 0, 0], at: [0.095, -0.05, 0.0] }))
    for (const y of [-0.12, -0.22]) ring(s, hip, webbing, 0.096, 0.008, y)
  }
  chest(s, fatigues)
  // The plate carrier: plates front and back, the cummerbund round the sides, shoulder straps.
  chest(s, gear, { grow: 0.025, profile: [[0.168, 0.06], [0.19, 0.2], [0.205, 0.32], [0.2, 0.44]], from: -0.85, span: 1.7 })
  chest(s, gear, { grow: 0.025, profile: [[0.168, 0.06], [0.19, 0.2], [0.205, 0.32], [0.2, 0.44]], from: Math.PI - 0.85, span: 1.7 })
  band(s, rig.torso, webbing, 0.2, 0.08, 0.2, [b, 0.82 * b], 0.21)
  for (const side of [-1, 1]) {
    strap(s, rig.torso, webbing, [side * 0.12, 0.44, chestFront(s, 0.44, side * 0.12) + 0.02], [side * 0.12, 0.54, 0], 0.05, 0.02)
    strap(s, rig.torso, webbing, [side * 0.12, 0.54, 0], [side * 0.12, 0.44, -chestFront(s, 0.44, side * 0.12) - 0.02], 0.05, 0.02)
  }
  for (let index = 0; index < 3; index += 1) {
    const x = (index - 1) * 0.07
    pouch(s, rig.torso, gear, webbing, black, [x, 0.17, chestFront(s, 0.17, x, { grow: 0.025 }) + 0.022], [0.06, 0.1, 0.04])
  }
  // The radio on the left strap, its aerial; a name tape.
  s.add(rig.torso, black, shaped(block(0.045, 0.08, 0.03), { at: [-0.12, 0.38, chestFront(s, 0.38, -0.12) + 0.04] }))
  s.add(rig.torso, black, shaped(new CylinderGeometry(0.004, 0.004, 0.2, 4), { at: [-0.135, 0.5, chestFront(s, 0.38, -0.12) + 0.035] }))
  s.add(rig.torso, patch, shaped(block(0.08, 0.022, 0.006), { at: [0.07, 0.36, chestFront(s, 0.36, 0.07, { grow: 0.025 }) + 0.004] }))
  belt(s, webbing, black, { y: 0.03, r: 0.19, width: 0.06 })
  arms(s, { upper: fatigues, fore: fatigues, upperR: 0.062, foreR: 0.054 })
  for (const { side, shoulder, elbow } of rig.arms) {
    s.add(shoulder, patch, shaped(block(0.006, 0.05, 0.045), { at: [side * 0.064, -0.08, 0] }))
    // Sleeves rolled at the wrist.
    s.add(elbow, gear, lathe([[0.058, -0.22], [0.06, -0.17]], 14))
  }
  hand(s, s.right.hand, 1, glove, 'grip')
  hand(s, s.left.hand, -1, glove, 'grip')
  const crop = s.surface('#2a1e16', { roughness: 0.9 })
  face(s, { skin, white: s.surface('#ece6de'), iris: s.surface('#3a2a1e'), brows: crop, hair: crop, mouth: s.surface('#7a4a3a') })
  // Stubble along the jaw.
  s.add(rig.head, s.surface(shade(look.skin, 0.75), { roughness: 0.9 }), shaped(new SphereGeometry(0.087, 14, 8, Math.PI / 2 - 1.2, 2.4, Math.PI * 0.45, Math.PI * 0.4), { size: [1.06, 0.84, 1.04], at: [0, 0.062, 0.03] }))
  // The helmet: its shell under a cover, a rim, goggles on the band, the mount in front, the chin strap.
  const helmet = joint(rig.head, 0, 0.175, -0.012)
  s.add(helmet, fatigues, shaped(lathe([[0.158, -0.03], [0.16, 0.02], [0.15, 0.08], [0.11, 0.14], [0.05, 0.168], [0.001, 0.172]], 24), { size: [1, 1, 1.1] }))
  ring(s, helmet, gear, 0.158, 0.008, -0.03, [1, 1.1])
  ring(s, helmet, black, 0.157, 0.012, 0.03, [1, 1.1])
  for (const side of [-1, 1]) {
    s.add(helmet, black, shaped(new CylinderGeometry(0.032, 0.032, 0.03, 14), { turn: [Math.PI / 2 - 0.25, 0, 0], at: [side * 0.05, 0.05, 0.16] }))
    s.add(helmet, lens, shaped(new CylinderGeometry(0.026, 0.026, 0.032, 14), { turn: [Math.PI / 2 - 0.25, 0, 0], at: [side * 0.05, 0.05, 0.161] }), false)
    s.add(helmet, gear, shaped(block(0.012, 0.04, 0.06), { at: [side * 0.16, 0.02, 0] }))
    strap(s, rig.head, webbing, [side * 0.135, 0.12, 0.0], [side * 0.06, -0.02, 0.07], 0.012, 0.006)
  }
  s.add(helmet, black, shaped(block(0.05, 0.035, 0.03), { at: [0, 0.1, 0.15] }))
  s.add(rig.head, webbing, shaped(new TorusGeometry(0.05, 0.006, 4, 12, Math.PI), { turn: [0.4, 0, Math.PI], at: [0, 0.0, 0.05] }))

  // The pack, its bedroll on top, its side pocket.
  const backZ = -chestFront(s, 0.3) - 0.03
  s.add(rig.torso, gear, shaped(block(0.28 * b, 0.32, 0.13), { at: [0, 0.3, backZ - 0.065] }))
  s.add(rig.torso, webbing, shaped(block(0.24 * b, 0.12, 0.05), { at: [0, 0.22, backZ - 0.15] }))
  for (const side of [-1, 1]) s.add(rig.torso, gear, shaped(block(0.05, 0.16, 0.08), { at: [side * 0.165 * b, 0.26, backZ - 0.07] }))
  s.add(rig.torso, tan, shaped(new CylinderGeometry(0.05, 0.05, 0.32 * b, 14), { turn: [0, 0, Math.PI / 2], at: [0, 0.5, backZ - 0.07] }))
  for (const x of [-0.08, 0.08]) s.add(rig.torso, webbing, shaped(new TorusGeometry(0.052, 0.006, 4, 14), { turn: [0, Math.PI / 2, 0], at: [x * b, 0.5, backZ - 0.07] }))

  // The rifle.
  const gun = carried(s)
  s.add(gun, black, shaped(block(0.035, 0.07, 0.05), { turn: [-0.35, 0, 0], at: [0, -0.01, 0.04] }))
  s.add(gun, black, shaped(block(0.045, 0.27, 0.075), { at: [0, -0.18, 0.0] }))
  s.add(gun, black, shaped(block(0.05, 0.06, 0.1), { at: [0, -0.3, 0.012] }))
  s.add(gun, gunmetal, shaped(block(0.05, 0.27, 0.07), { at: [0, 0.07, 0] }))
  s.add(gun, gunmetal, sweep([[0, 0.08, 0.035], [0, 0.11, 0.11], [0, 0.1, 0.17]], 0.018, 4, 10).scale(1.2, 1, 1))
  s.add(gun, black, shaped(new CylinderGeometry(0.03, 0.03, 0.26, 8), { at: [0, 0.33, 0] }))
  for (let index = 0; index < 6; index += 1) s.add(gun, gunmetal, shaped(block(0.035, 0.012, 0.012), { at: [0, 0.22 + index * 0.04, -0.032] }), false)
  s.add(gun, gunmetal, shaped(new CylinderGeometry(0.011, 0.011, 0.22, 8), { at: [0, 0.55, 0] }))
  s.add(gun, black, shaped(new CylinderGeometry(0.018, 0.016, 0.05, 8), { at: [0, 0.65, 0] }))
  s.add(gun, gunmetal, shaped(block(0.01, 0.04, 0.03), { at: [0, 0.44, -0.04] }))
  // The scope.
  s.add(gun, black, shaped(new CylinderGeometry(0.02, 0.02, 0.15, 12), { at: [0, 0.08, -0.07] }))
  for (const [y, r] of [[0.0, 0.026], [0.16, 0.028]] as const) {
    s.add(gun, black, shaped(new CylinderGeometry(r, 0.02, 0.04, 12), { at: [0, y, -0.07] }))
    s.add(gun, lens, shaped(new CylinderGeometry(r * 0.8, r * 0.8, 0.002, 12), { at: [0, y + (y > 0 ? 0.021 : -0.021), -0.07] }), false)
  }
  for (const y of [0.04, 0.12]) s.add(gun, gunmetal, shaped(block(0.02, 0.02, 0.04), { at: [0, y, -0.045] }))
  strap(s, gun, webbing, [0.03, -0.3, 0.03], [0.03, 0.4, 0.04], 0.018, 0.004)
  return s.finish({ main: joint(s.right.hand), mainHold: 'free', carried: gun, tip: joint(gun, 0, 0.66, 0), strike: joint(gun, 0, 0.3, 0), strikeShape: { x: 0.5, y: 2.4, z: 0.5 } })
}

// ---------------------------------------------------------------------------------------------------------------- Grenadier

// A bomber in a leather flying jacket with a fleece collar, an aviator's cap with ear flaps and brass goggles, a red scarf blowing
// behind, a bandolier of grenades across the chest, cargo trousers, buckled boots, a satchel, and a stubby launcher with a drum.
export function grenadier(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const jacket = s.surface(look.cloth, { roughness: 0.6 })
  const dark = s.surface(look.trim, { roughness: 0.8 })
  const fleece = s.surface('#e2d6bd', { roughness: 1, flatShading: true })
  const trousers = s.surface('#4d4a3a', { roughness: 0.9 })
  const leather = s.surface('#3a2618', { roughness: 0.7 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const brass = s.surface('#c9a24a', { roughness: 0.3, metalness: 0.85 })
  const steel = s.surface('#5a5e62', { roughness: 0.4, metalness: 0.7 })
  const scarf = s.cloth('#a8382a', { roughness: 0.8 })
  const olive = s.surface('#4f5a32', { roughness: 0.6, metalness: 0.2 })
  const lens = s.glow('#9fe0ff', 0.4, { roughness: 0.05, metalness: 0.6 })
  const band2 = s.glow(look.accent, 0.5)

  legs(s, { thigh: trousers, shin: trousers, thighR: 0.09, shinR: 0.068, baggy: 0.078 })
  const flap = s.surface(shade('#4d4a3a', 0.8), { roughness: 0.9 })
  for (const { side, hip } of rig.legs) pouch(s, hip, trousers, flap, brass, [side * 0.09, -0.2, 0.02], [0.03, 0.09, 0.08], [0, side * Math.PI / 2, 0])
  boots(s, { material: leather, sole: s.surface('#1e1612'), height: 0.2, toe: 'round' })
  for (const { knee } of rig.legs) for (const y of [-0.38, -0.32]) {
    ring(s, knee, dark, 0.072, 0.007, y)
    s.add(knee, brass, shaped(block(0.018, 0.016, 0.008), { at: [0.06, y, 0.04] }), false)
  }
  chest(s, jacket, { grow: 0.01 })
  // The zip, the fleece collar, the ribbed waist band.
  strap(s, rig.torso, brass, [0.01, 0.06, chestFront(s, 0.06, 0, { grow: 0.01 }) + 0.003], [0.01, 0.46, chestFront(s, 0.46, 0, { grow: 0.01 }) + 0.003], 0.006, 0.004)
  s.add(rig.torso, fleece, roughen(lathe([[0.19, 0.45], [0.175, 0.52], [0.13, 0.565]], 24), 0.008, 9).scale(b, 1, 0.85 * b))
  band(s, rig.torso, dark, 0.19, -0.04, 0.04, [b, 0.82 * b])
  for (let index = 0; index < 18; index += 1) {
    const turn = index / 18 * Math.PI * 2
    s.add(rig.torso, dark, shaped(block(0.008, 0.075, 0.006), { at: [Math.sin(turn) * 0.192 * b, 0.0, Math.cos(turn) * 0.192 * 0.82 * b] }), false)
  }
  // The bandolier and its grenades.
  const across = (k: number): Triple => {
    const x = 0.16 * b - k * 0.32 * b
    const y = 0.5 - k * 0.4
    return [x, y, chestFront(s, y, x, { grow: 0.01 }) + 0.016]
  }
  strap(s, rig.torso, leather, across(0), across(1), 0.04, 0.012)
  strap(s, rig.torso, leather, [0.16 * b, 0.5, -chestFront(s, 0.5, 0.16 * b) - 0.015], [-0.16 * b, 0.1, -chestFront(s, 0.1, -0.16 * b) - 0.015], 0.04, 0.012)
  for (let index = 0; index < 5; index += 1) {
    const [x, y, z] = across(0.12 + index * 0.18)
    s.add(rig.torso, olive, shaped(new SphereGeometry(0.03, 12, 10), { size: [1, 1.15, 1], at: [x, y, z + 0.022] }))
    s.add(rig.torso, band2, shaped(new CylinderGeometry(0.031, 0.031, 0.012, 12), { at: [x, y, z + 0.022] }), false)
    s.add(rig.torso, steel, shaped(new CylinderGeometry(0.01, 0.012, 0.022, 8), { at: [x, y + 0.04, z + 0.022] }))
    s.add(rig.torso, steel, shaped(new TorusGeometry(0.012, 0.003, 4, 10), { turn: [0, Math.PI / 2, 0], at: [x + 0.016, y + 0.045, z + 0.022] }), false)
  }
  const jacketSkirt = new Skirt(s, rig.hips, s.cloth(look.cloth, { roughness: 0.6 }), { top: 0.0, length: 0.12, neck: 0.2, hem: 0.21, push: 0.4, ripple: 0.2 })
  s.onFrame((frame) => jacketSkirt.update(frame))
  // The satchel on the left hip, its strap.
  {
    const bag = joint(rig.hips, -0.21 * b, -0.04, 0.03)
    bag.rotation.y = -0.4
    s.add(bag, leather, block(0.06, 0.15, 0.17))
    s.add(bag, dark, shaped(block(0.065, 0.07, 0.175), { at: [0, 0.05, 0] }))
    s.add(bag, brass, shaped(block(0.07, 0.02, 0.02), { at: [0, 0.02, 0.05] }))
    strap(s, rig.torso, leather, [-0.2 * b, 0.0, 0.0], [0.14 * b, 0.53, -0.02], 0.03, 0.01)
  }
  arms(s, { upper: jacket, fore: jacket, upperR: 0.066, foreR: 0.058 })
  for (const { elbow } of rig.arms) band(s, elbow, dark, 0.06, -0.26, -0.2)
  hand(s, s.right.hand, 1, leather, 'grip')
  hand(s, s.left.hand, -1, leather, 'grip')
  face(s, { skin, white: s.surface('#ece6de'), iris: s.surface('#2f4a5a'), brows: s.surface('#4a2a16'), hair: leather, mouth: s.surface('#8a4a3a') })
  // A great moustache.
  for (const side of [-1, 1]) s.add(rig.head, s.surface('#4a2a16', { roughness: 0.9 }), sweep([[0, 0.085, 0.124], [side * 0.04, 0.08, 0.118], [side * 0.075, 0.09, 0.09]], (u) => 0.014 * (1 - u * 0.6), 6, 10))
  // The cap, its ear flaps and buckle, and the goggles pushed up on it.
  const cap = joint(rig.head, 0, 0.13, -0.01)
  s.add(cap, leather, shaped(new SphereGeometry(0.142, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), { size: [1, 1.05, 1.08] }))
  for (const side of [-1, 1]) {
    s.add(cap, leather, shaped(new CapsuleGeometry(0.04, 0.06, 4, 8), { size: [0.4, 1, 1], at: [side * 0.13, -0.06, -0.01] }))
    s.add(cap, fleece, shaped(new CapsuleGeometry(0.036, 0.05, 4, 8), { size: [0.4, 1, 1], at: [side * 0.125, -0.06, -0.01] }))
  }
  ring(s, cap, brass, 0.143, 0.004, 0.02, [1, 1.08])
  ring(s, cap, dark, 0.145, 0.012, 0.075, [1, 1.08])
  for (const side of [-1, 1]) {
    s.add(cap, brass, shaped(new CylinderGeometry(0.038, 0.034, 0.035, 16), { turn: [Math.PI / 2 - 0.6, 0, 0], at: [side * 0.052, 0.08, 0.13] }))
    s.add(cap, lens, shaped(new CylinderGeometry(0.03, 0.03, 0.037, 16), { turn: [Math.PI / 2 - 0.6, 0, 0], at: [side * 0.052, 0.08, 0.131] }), false)
  }
  // The scarf: wound round the neck, its end blowing behind.
  s.add(rig.torso, scarf, roughen(lathe([[0.125, 0.53], [0.13, 0.6]], 18), 0.008, 2).scale(b, 1, 0.95))
  const tail = joint(rig.torso, 0.06, 0.58, -0.1)
  s.add(tail, scarf, shaped(new BoxGeometry(0.06, 0.32, 0.01, 1, 6, 1), { at: [0, -0.16, 0] }))
  s.onFrame(({ t, walk }) => {
    tail.rotation.set(0.35 + walk * 0.9 + Math.sin(t * 6) * 0.08 * (0.3 + walk), 0, 0.2 + Math.sin(t * 4.3) * 0.08)
  })

  // The launcher: a stock, a grip, a drum, a fat barrel with a band at the muzzle, a sight, a fore grip.
  const gun = carried(s)
  s.add(gun, leather, shaped(block(0.045, 0.24, 0.07), { at: [0, -0.16, 0.005] }))
  s.add(gun, steel, shaped(block(0.05, 0.03, 0.08), { at: [0, -0.29, 0.005] }))
  s.add(gun, dark, shaped(block(0.035, 0.07, 0.045), { turn: [-0.35, 0, 0], at: [0, -0.01, 0.045] }))
  s.add(gun, steel, shaped(new CylinderGeometry(0.05, 0.05, 0.13, 16), { at: [0, 0.07, 0] }))
  s.add(gun, olive, shaped(new CylinderGeometry(0.075, 0.075, 0.07, 18), { turn: [0, 0, Math.PI / 2], at: [0, 0.1, 0.05] }))
  for (let index = 0; index < 6; index += 1) {
    const turn = index / 6 * Math.PI * 2
    s.add(gun, brass, shaped(new CylinderGeometry(0.012, 0.012, 0.072, 8), { turn: [0, 0, Math.PI / 2], at: [0, 0.1 + Math.cos(turn) * 0.05, 0.05 + Math.sin(turn) * 0.05] }), false)
  }
  s.add(gun, steel, lathe([[0.058, 0.13], [0.06, 0.45], [0.066, 0.46], [0.066, 0.5]], 18))
  s.add(gun, s.surface('#151515'), shaped(new CylinderGeometry(0.048, 0.048, 0.01, 14), { at: [0, 0.497, 0] }), false)
  ring(s, gun, band2, 0.064, 0.01, 0.46)
  for (const y of [0.22, 0.34]) ring(s, gun, brass, 0.062, 0.007, y)
  s.add(gun, steel, shaped(block(0.012, 0.05, 0.04), { at: [0, 0.4, -0.08] }))
  s.add(gun, steel, shaped(block(0.012, 0.03, 0.03), { at: [0, 0.1, -0.075] }))
  s.add(gun, dark, shaped(block(0.03, 0.03, 0.08), { turn: [0.3, 0, 0], at: [0, 0.3, 0.09] }))
  return s.finish({ main: joint(s.right.hand), mainHold: 'free', carried: gun, tip: joint(gun, 0, 0.55, 0), strike: joint(gun, 0, 0.3, 0), strikeShape: { x: 0.7, y: 2, z: 0.7 } })
}
