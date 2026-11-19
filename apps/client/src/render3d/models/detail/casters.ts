import {
  BoxGeometry,
  DoubleSide,
  IcosahedronGeometry,
  OctahedronGeometry,
  type Group,
  type Material,
  type Mesh,
} from 'three'
import { CapsuleGeometry, ConeGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from './shapes.ts'
import { seededRandom } from '../../space.ts'
import type { Look } from '../looks.ts'
import { joint } from '../model.ts'
import { arms, band, belt, boots, chest, chestFront, face, hand, legs, ring, strap } from './body.ts'
import { lathe, robeTexture, roughen, Sculpt, shade, shaped, Skirt, sweep, type Detail, type DetailKit, type Rig, type Triple } from './kit.ts'

// The robed casters: the Cursebearer, Capricorn, the Fire Mage and the Sage. Each wears a robe to the ankles that the legs push
// out as they walk, wide sleeves, and holds a staff upright in the right hand, its head where its spells come from.

// A staff in the right hand, held upright: the hand closed round it, and the joint its head is built on, `top` up it.
function staff(s: Sculpt, skin: Material, top: number): { main: Group; staff: Group; head: Group } {
  const main = joint(s.right.hand)
  const staff = joint(main)
  hand(s, staff, 1, skin, 'grip', 1, 'y')
  return { main, staff, head: joint(staff, 0, top, 0) }
}

// A shaft from below the hand to its head: a little crooked and gnarled if `gnarl`.
function shaft(s: Sculpt, parent: Group, material: Material, from: number, to: number, r0: number, r1: number, gnarl = 0, seed = 1): void {
  const random = seededRandom(seed)
  const points: Triple[] = []
  for (let index = 0; index <= 6; index += 1) {
    const y = from + (to - from) * index / 6
    const wobble = index === 0 || index === 6 ? 0 : gnarl
    points.push([(random() - 0.5) * wobble, y, (random() - 0.5) * wobble])
  }
  const geometry = sweep(points, (u) => r0 + (r1 - r0) * u, 8, 30)
  s.add(parent, material, gnarl > 0 ? roughen(geometry, gnarl * 0.18, seed) : geometry)
}

// The legs under a robe: trousers and shoes, only the feet showing.
export function underRobe(s: Sculpt, trousers: Material, shoe: Material, sole: Material, toe: 'round' | 'pointed' | 'curl' = 'round'): void {
  legs(s, { thigh: trousers, shin: trousers, thighR: 0.08, shinR: 0.06, knee: false })
  boots(s, { material: shoe, sole, height: 0.09, toe })
}

// A hood with an opening for the face, falling to the shoulders, a point behind; the face in it in shadow.
export function hood(s: Sculpt, material: Material, rim: Material, options: { r?: number; open?: number; point?: boolean } = {}): void {
  const head = s.rig.head
  const { r = 0.178, open = 1.5 } = options
  const from = Math.PI / 2 + open / 2
  s.add(head, material, shaped(new SphereGeometry(r, 24, 16, from, Math.PI * 2 - open, 0, Math.PI * 0.8), { size: [1, 1.06, 1.1], at: [0, 0.13, -0.01] }))
  // Its rim round the opening, from one cheek over the top to the other.
  const edge: Triple[] = []
  for (let index = 0; index <= 12; index += 1) {
    const k = index / 12
    const phi = k < 0.5 ? from : from - open + Math.PI * 2
    const theta = k < 0.5 ? Math.PI * 0.8 * (1 - k * 2) + 0.02 : Math.PI * 0.8 * (k * 2 - 1) + 0.02
    if (index === 6) continue
    edge.push([-r * Math.cos(phi) * Math.sin(theta), 0.13 + r * 1.06 * Math.cos(theta), -0.01 + r * 1.1 * Math.sin(phi) * Math.sin(theta)])
  }
  s.add(head, rim, sweep(edge, 0.012, 6, 40))
  if (options.point !== false) s.add(head, material, sweep([[0, 0.25, -0.08], [0, 0.27, -0.17], [0, 0.22, -0.27], [0, 0.15, -0.31]], (u) => 0.075 * (1 - u * 0.9), 10, 16))
  // The hood falls in folds onto the shoulders.
  s.add(s.rig.torso, material, lathe([[0.27, 0.42], [0.22, 0.5], [0.16, 0.58]], 24, from, Math.PI * 2 - open))
}

// Strips of cloth hung from the shoulders down the back, swaying as it walks.
export function tatters(s: Sculpt, materials: Material[], count: number, length: number, seed: number): void {
  const random = seededRandom(seed)
  const strips: Array<{ strip: Group; amount: number }> = []
  for (let index = 0; index < count; index += 1) {
    const x = (index - (count - 1) / 2) * 0.075 * s.b
    const strip = joint(s.rig.torso, x, 0.5, -chestFront(s, 0.5, x) - 0.03)
    const long = length * (0.7 + random() * 0.5)
    s.add(strip, materials[index % materials.length], shaped(new BoxGeometry(0.07, long, 0.012, 1, 6, 1), { at: [0, -long / 2, 0] }))
    // A pointed, ragged end.
    s.add(strip, materials[index % materials.length], shaped(new ConeGeometry(0.035, 0.08, 4), { size: [1, 1, 0.17], turn: [0, 0, Math.PI], at: [0, -long - 0.03, 0] }))
    strips.push({ strip, amount: 0.6 + random() * 0.4 })
  }
  s.onFrame(({ t, walk }) => {
    for (const [index, { strip, amount }] of strips.entries()) strip.rotation.x = 0.12 + amount * (0.08 + 0.5 * walk) + Math.sin(t * 2.4 + index * 1.3) * 0.05
  })
}

// ---------------------------------------------------------------------------------------------------------------- Cursebearer

// A hexer in a tattered purple robe written over with runes, a deep pointed hood with eyes burning in the dark of it, a ragged
// mantle, a rope belt hung with charms and a book of curses, and a gnarled staff topped by a skull in a cage of roots, a curse
// burning over it.
export function cursebearer(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const texture = robeTexture(`curse|${look.cloth}|${look.accent}`, look.cloth, (context, width, height) => {
    context.fillStyle = shade(look.cloth, 0.55)
    context.fillRect(0, height * 0.72, width, height * 0.28)
    const random = seededRandom(5)
    context.strokeStyle = look.accent
    context.lineWidth = 2
    for (let index = 0; index < 22; index += 1) {
      const x = 12 + index * (width / 22)
      const y = height * 0.8
      context.beginPath()
      for (let stroke = 0; stroke < 3; stroke += 1) {
        context.moveTo(x + random() * 14, y + random() * 26)
        context.lineTo(x + random() * 14, y + random() * 26)
      }
      context.stroke()
    }
  })
  const robe = s.cloth(texture ? '#ffffff' : look.cloth, { map: texture ?? null })
  const cloth = s.cloth(look.cloth)
  const dark = s.cloth(look.trim)
  const skin = s.surface(look.skin, { roughness: 0.6 })
  const shadow = s.surface('#050307', { roughness: 1 })
  const eyes = s.glow(look.eyes ?? look.accent, 2.4)
  const rune = s.glow(look.accent, 0.8)
  const rope = s.surface('#5a4632', { roughness: 0.95 })
  const bone = s.surface('#e3dccb', { roughness: 0.6 })
  const wood = s.surface('#3b2d23', { roughness: 0.95, flatShading: true })
  const leather = s.surface('#3a2618', { roughness: 0.8 })
  const iron = s.surface('#4a4650', { roughness: 0.5, metalness: 0.6 })

  underRobe(s, dark, leather, shadow, 'pointed')
  chest(s, cloth)
  const skirt = new Skirt(s, rig.hips, robe, { top: 0.06, length: 0.88, neck: 0.18, hem: 0.36, ragged: 0.1, tatters: 16, seed: 11 })
  const mantle = new Skirt(s, rig.torso, dark, { top: 0.6, length: 0.3, neck: 0.11, hem: 0.31, ragged: 0.08, tatters: 11, push: 0, ripple: 0.5, seed: 4, depth: 0.85 })
  s.onFrame((frame) => {
    skirt.update(frame)
    mantle.update(frame)
  })
  arms(s, { upper: cloth, fore: cloth, bell: 0.105 })
  for (const { elbow } of rig.arms) ring(s, elbow, dark, 0.1, 0.008, -0.28)
  hand(s, s.left.hand, -1, skin, 'claw', 1.1)
  hood(s, cloth, dark)
  // The face lost in the dark of the hood, but for the eyes.
  s.add(rig.head, shadow, shaped(new SphereGeometry(0.125, 16, 12), { size: [1, 1.05, 0.9], at: [0, 0.12, 0.02] }))
  for (const side of [-1, 1]) s.add(rig.head, eyes, shaped(new SphereGeometry(0.02, 10, 8), { size: [1.4, 0.7, 0.5], turn: [0, 0, side * 0.25], at: [side * 0.042, 0.13, 0.13] }), false)
  tatters(s, [cloth, dark], 5, 0.6, 21)

  // The rope belt, its knot and its cords, the charms on them, and the book.
  ring(s, rig.torso, rope, 0.185 * b, 0.013, 0.06, [1, 0.84])
  ring(s, rig.torso, rope, 0.188 * b, 0.011, 0.085, [1, 0.84])
  const front = chestFront(s, 0.06) + 0.012
  s.add(rig.torso, rope, shaped(new SphereGeometry(0.024, 10, 8), { at: [0.04, 0.07, front] }))
  for (const [x, length] of [[0.03, 0.26], [0.055, 0.2]] as const) {
    strap(s, rig.torso, rope, [x, 0.06, front], [x + 0.01, 0.06 - length, front + 0.015], 0.007, 0, true)
    s.add(rig.torso, bone, shaped(new CapsuleGeometry(0.01, 0.04, 3, 6), { at: [x + 0.01, 0.03 - length, front + 0.015] }))
  }
  for (const [x, z, length] of [[-0.1, 0.13, 0.12], [-0.13, 0.11, 0.17], [-0.155, 0.08, 0.1]] as const) {
    strap(s, rig.torso, rope, [x * b, 0.05, z * b], [x * b, 0.05 - length, (z + 0.015) * b], 0.005, 0, true)
    s.add(rig.torso, rune, shaped(new OctahedronGeometry(0.018, 0), { size: [1, 1.4, 1], at: [x * b, 0.035 - length, (z + 0.015) * b] }), false)
  }
  {
    const book = joint(rig.hips, 0.2 * b, -0.02, 0.06)
    book.rotation.set(0.1, 0.5, 0.05)
    s.add(book, leather, new BoxGeometry(0.045, 0.15, 0.12))
    s.add(book, bone, shaped(new BoxGeometry(0.035, 0.14, 0.11), { at: [0.004, 0, 0.004] }))
    s.add(book, iron, shaped(new BoxGeometry(0.05, 0.02, 0.02), { at: [0, 0, 0.055] }))
    s.add(book, rune, shaped(new TorusGeometry(0.025, 0.004, 4, 16), { turn: [0, Math.PI / 2, 0], at: [0.024, 0, 0] }), false)
    strap(s, rig.torso, rope, [0.17 * b, 0.06, 0.12 * b], [0.2 * b, -0.02, 0.1 * b], 0.006, 0, true)
  }

  // The staff, its skull, the roots that hold it and the curse that burns over it.
  const held = staff(s, skin, 1.16)
  shaft(s, held.staff, wood, -0.42, 1.06, 0.026, 0.02, 0.05, 13)
  for (let index = 0; index < 5; index += 1) s.add(held.staff, dark, shaped(new TorusGeometry(0.03, 0.009, 5, 10), { turn: [Math.PI / 2 + (index % 2 ? 0.25 : -0.25), 0, 0], at: [0, 0.07 + index * 0.025, 0] }))
  const head = held.head
  s.add(head, bone, shaped(new SphereGeometry(0.068, 16, 12), { size: [0.92, 0.92, 1.05], at: [0, 0.025, -0.005] }))
  s.add(head, bone, shaped(new SphereGeometry(0.045, 12, 8), { size: [1, 0.8, 0.9], at: [0, -0.025, 0.03] }))
  for (const side of [-1, 1]) {
    s.add(head, shadow, shaped(new SphereGeometry(0.02, 10, 8), { at: [side * 0.026, 0.015, 0.05] }), false)
    s.add(head, rune, shaped(new SphereGeometry(0.008, 6, 4), { at: [side * 0.026, 0.015, 0.064] }), false)
    s.add(head, bone, shaped(new SphereGeometry(0.016, 8, 6), { size: [1.4, 0.8, 1], at: [side * 0.042, -0.006, 0.04] }))
  }
  s.add(head, shadow, shaped(new ConeGeometry(0.01, 0.022, 3), { turn: [0, 0, Math.PI], at: [0, -0.012, 0.066] }), false)
  for (let index = 0; index < 6; index += 1) s.add(head, bone, shaped(new BoxGeometry(0.008, 0.014, 0.008), { at: [(index - 2.5) * 0.011, -0.045, 0.06 - Math.abs(index - 2.5) * 0.004] }), false)
  for (let index = 0; index < 3; index += 1) {
    const turn = index / 3 * Math.PI * 2 + 0.5
    const out = (r: number, y: number): Triple => [Math.sin(turn) * r, y, Math.cos(turn) * r]
    s.add(head, wood, sweep([out(0.02, -0.12), out(0.07, -0.06), out(0.08, 0.04), out(0.04, 0.12)], (u) => 0.014 * (1 - u * 0.75), 6, 16))
  }
  for (let index = 0; index < 4; index += 1) s.add(head, iron, shaped(new TorusGeometry(0.012, 0.004, 4, 8), { turn: [0, index % 2 ? Math.PI / 2 : 0, 0], at: [0.045, -0.05 - index * 0.02, 0.02] }), false)
  const flame = joint(head, 0, 0.1, 0)
  s.add(flame, rune, shaped(new ConeGeometry(0.045, 0.16, 10), { at: [0, 0.06, 0] }), false)
  s.add(flame, s.glow(shade(look.accent, 1.5), 2), shaped(new ConeGeometry(0.022, 0.1, 8), { at: [0, 0.04, 0] }), false)
  s.onFrame(({ t, gathering, burst }) => {
    flame.scale.set(1 + Math.sin(t * 13) * 0.08, 1 + Math.sin(t * 9.3) * 0.15 + gathering * 0.6 + burst * 0.4, 1 + Math.cos(t * 11) * 0.08)
    flame.rotation.z = Math.sin(t * 5) * 0.08
  })
  return s.finish({ main: held.main, mainHold: 'up', tip: head, robed: true })
}

// ---------------------------------------------------------------------------------------------------------------- Capricorn

// A sea mage in deep blue with waves embroidered at the hem, long silver hair, a ram's spiralling horns, pointed ears, a white
// sash with a shell clasp and a pearl, and a staff of twisted driftwood holding an orb of water that turns.
export function capricorn(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const texture = robeTexture(`capricorn|${look.cloth}|${look.trim}|${look.accent}`, look.cloth, (context, width, height) => {
    context.fillStyle = shade(look.cloth, 0.7)
    context.fillRect(0, height * 0.7, width, height * 0.3)
    for (const [y, color, line] of [[0.8, look.trim, 4], [0.9, look.accent, 3]] as const) {
      context.strokeStyle = color
      context.lineWidth = line
      context.beginPath()
      for (let x = 0; x <= width; x += 4) {
        const wave = Math.sin(x / width * Math.PI * 24)
        context.lineTo(x, height * y + wave * 8 + (wave > 0.6 ? -6 : 0))
      }
      context.stroke()
    }
    context.fillStyle = look.trim
    context.fillRect(0, height - 8, width, 8)
  })
  const robe = s.cloth(texture ? '#ffffff' : look.cloth, { map: texture ?? null })
  const cloth = s.cloth(look.cloth)
  const deep = s.cloth(shade(look.cloth, 0.6))
  const white = s.surface(look.trim, { roughness: 0.7 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const hair = s.surface('#d9dde6', { roughness: 0.55, metalness: 0.1 })
  const horn = s.surface('#b9a27c', { roughness: 0.5 })
  const iris = s.glow(look.accent, 1.2)
  const pearl = s.glow('#dff6ff', 0.8, { roughness: 0.1 })
  const wood = s.surface('#b7a688', { roughness: 0.9, flatShading: true })
  const silver = s.surface('#cfd6de', { roughness: 0.3, metalness: 0.8 })
  const water = s.glow(look.accent, 1.3, { transparent: true, opacity: 0.85, roughness: 0.05 })
  const foam = s.glow('#e6fbff', 1.6)

  underRobe(s, deep, white, deep, 'pointed')
  chest(s, cloth)
  // A deep V at the neck, edged in white.
  for (const side of [-1, 1]) strap(s, rig.torso, white, [side * 0.06, 0.55, chestFront(s, 0.55) + 0.004], [side * 0.012, 0.36, chestFront(s, 0.36) + 0.006], 0.022, 0.008)
  s.add(rig.torso, skin, shaped(new ConeGeometry(0.05, 0.16, 3), { size: [1, 1, 0.3], turn: [0, 0, Math.PI], at: [0, 0.48, chestFront(s, 0.48) - 0.005] }))
  const skirt = new Skirt(s, rig.hips, robe, { top: 0.06, length: 0.88, neck: 0.18, hem: 0.35 })
  const capelet = new Skirt(s, rig.torso, deep, { top: 0.555, length: 0.2, neck: 0.15, hem: 0.29, ragged: 0.035, tatters: 14, push: 0, ripple: 0.4, seed: 2 })
  s.onFrame((frame) => {
    skirt.update(frame)
    capelet.update(frame)
  })
  // The sash, its clasp of shell and pearl, and its ends.
  band(s, rig.torso, white, 0.188, 0.02, 0.1, [b, 0.85 * b])
  const front = chestFront(s, 0.06) + 0.012
  for (let index = 0; index < 7; index += 1) {
    const turn = (index - 3) * 0.32
    s.add(rig.torso, white, shaped(new BoxGeometry(0.012, 0.06, 0.008), { turn: [0, 0, turn], at: [Math.sin(turn) * 0.03, 0.06 + Math.cos(turn) * 0.03 - 0.02, front] }))
  }
  s.add(rig.torso, pearl, shaped(new SphereGeometry(0.016, 12, 8), { at: [0, 0.045, front + 0.012] }), false)
  for (const side of [-1, 1]) {
    const end = joint(rig.hips, side * 0.07, 0.08, chestFront(s, 0.0) + 0.02)
    s.add(end, white, shaped(new BoxGeometry(0.045, 0.3, 0.008), { turn: [0, 0, side * 0.08], at: [0, -0.15, 0] }))
    s.onFrame(({ t, walk, hipL, hipR }) => {
      end.rotation.x = Math.min(0, hipL, hipR) * 0.6 + Math.sin(t * 2 + side) * 0.04 - 0.05 * walk
    })
  }
  arms(s, { upper: cloth, fore: cloth, bell: 0.1 })
  for (const { elbow } of rig.arms) ring(s, elbow, white, 0.098, 0.009, -0.285)
  hand(s, s.left.hand, -1, skin, 'open')
  face(s, { skin, white: s.surface('#f4f4f4'), iris, brows: hair, hair, ears: 'pointed', mouth: s.surface('#9a6a68') })
  // Long silver hair: close over the crown, a fringe, and long locks down the back.
  s.add(rig.head, hair, shaped(new SphereGeometry(0.133, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), { size: [0.98, 1, 1.03], turn: [-0.25, 0, 0], at: [0, 0.14, -0.012] }))
  for (let index = 0; index < 9; index += 1) {
    const x = (index - 4) * 0.026
    s.add(rig.head, hair, sweep([[x, 0.2, -0.08], [x * 1.3, 0.12, -0.14], [x * 1.4, -0.05, -0.15], [x * 1.3, -0.25, -0.13 - Math.abs(x) * 0.3]], (u) => 0.022 * (1 - u * 0.6), 6, 16))
  }
  for (const x of [-0.06, -0.025, 0.02, 0.06]) s.add(rig.head, hair, sweep([[x * 0.7, 0.24, 0.05], [x, 0.21, 0.11], [x * 1.2, 0.16, 0.125]], (u) => 0.016 * (1 - u * 0.7), 6, 10))
  // The horns, coiling back and round from the temples, ridged.
  for (const side of [-1, 1]) {
    const points: Triple[] = []
    for (let index = 0; index <= 14; index += 1) {
      const k = index / 14
      const a = -0.5 + k * Math.PI * 1.6
      const r = 0.11 * (1 - k * 0.4)
      points.push([side * (0.11 + 0.1 * k), 0.2 + Math.cos(a) * r, -0.04 - Math.sin(a) * r])
    }
    s.add(rig.head, horn, sweep(points, (u) => 0.042 * (1 - u * 0.75) * (1 + 0.1 * Math.max(0, Math.sin(u * 70))), 10, 60))
  }

  // The staff: two lengths of driftwood twisted together, a silver ring, and the orb of water in it.
  const held = staff(s, skin, 1.17)
  for (const offset of [0, Math.PI]) {
    const points: Triple[] = []
    for (let index = 0; index <= 16; index += 1) {
      const y = -0.42 + index / 16 * 1.5
      const turn = offset + index * 0.9
      points.push([Math.cos(turn) * 0.012, y, Math.sin(turn) * 0.012])
    }
    s.add(held.staff, wood, roughen(sweep(points, (u) => 0.02 - u * 0.006, 7, 60), 0.003, 3))
  }
  s.add(held.head, silver, new TorusGeometry(0.095, 0.012, 8, 24))
  for (const side of [-1, 1]) strap(s, held.staff, silver, [side * 0.012, 1.06, 0], [side * 0.07, 1.12, 0], 0.008, 0, true)
  s.add(held.head, water, new IcosahedronGeometry(0.072, 3), false)
  s.add(held.head, foam, new IcosahedronGeometry(0.03, 2), false)
  const swirl = joint(held.head)
  s.add(swirl, foam, shaped(new TorusGeometry(0.06, 0.005, 4, 24, Math.PI * 1.2), { turn: [0.6, 0, 0] }), false)
  s.add(swirl, foam, shaped(new TorusGeometry(0.05, 0.004, 4, 24, Math.PI * 1.1), { turn: [-0.9, 0.5, 2] }), false)
  const drops: Mesh[] = []
  for (let index = 0; index < 3; index += 1) drops.push(s.mesh(held.head, water, new SphereGeometry(0.012, 8, 6), false))
  s.onFrame(({ t, gathering }) => {
    swirl.rotation.set(t * 1.3, t * 2.1, 0)
    for (const [index, drop] of drops.entries()) {
      const turn = t * (1.6 + gathering * 3) + index * Math.PI * 2 / 3
      drop.position.set(Math.cos(turn) * 0.13, Math.sin(t * 2 + index) * 0.04, Math.sin(turn) * 0.13)
    }
  })
  return s.finish({ main: held.main, mainHold: 'up', tip: held.head, robed: true })
}

// ---------------------------------------------------------------------------------------------------------------- Fire Mage

// A pyromancer in red with flames climbing the hem, a tall bent wizard's hat with a wide brim and a buckled band, a pointed beard,
// a high collar, a belt with a scroll and pouches, and a staff of blackened iron whose claws hold a burning stone.
export function firemage(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const texture = robeTexture(`firemage|${look.cloth}|${look.accent}`, look.cloth, (context, width, height) => {
    const random = seededRandom(9)
    for (const [color, reach, count] of [[shade(look.trim, 1), 0.42, 18], [look.accent, 0.32, 26], ['#ffd27a', 0.18, 34]] as const) {
      context.fillStyle = color
      context.beginPath()
      context.moveTo(0, height)
      for (let index = 0; index <= count; index += 1) {
        const x = index / count * width
        context.lineTo(x - width / count / 2, height - height * reach * (0.5 + random() * 0.6))
        context.lineTo(x, height - height * reach * 0.25)
      }
      context.lineTo(width, height)
      context.fill()
    }
  })
  const robe = s.cloth(texture ? '#ffffff' : look.cloth, { map: texture ?? null })
  const cloth = s.cloth(look.cloth)
  const dark = s.cloth(look.trim)
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const beard = s.surface('#6b3a22', { roughness: 0.9, flatShading: true })
  const gold = s.surface('#d4a84a', { roughness: 0.3, metalness: 0.8 })
  const leather = s.surface('#3b2418', { roughness: 0.8 })
  const paper = s.surface('#e8dcc0', { roughness: 0.9 })
  const iron = s.surface('#2b2726', { roughness: 0.45, metalness: 0.7 })
  const ember = s.glow(look.accent, 1.6)
  const hot = s.glow('#ffd27a', 2.4)

  underRobe(s, dark, leather, dark, 'round')
  chest(s, cloth)
  // A dark vest laced over the chest, and the high collar standing behind the neck.
  chest(s, dark, { grow: 0.006, profile: [[0.17, 0.04], [0.19, 0.2], [0.205, 0.32], [0.2, 0.42]], from: -0.7, span: 1.4 })
  for (let index = 0; index < 5; index += 1) {
    const y = 0.1 + index * 0.06
    for (const side of [-1, 1]) strap(s, rig.torso, gold, [side * 0.03, y, chestFront(s, y) + 0.009], [-side * 0.03, y + 0.05, chestFront(s, y + 0.05) + 0.009], 0.005, 0.004)
  }
  s.add(rig.torso, dark, lathe([[0.16, 0.5], [0.165, 0.58], [0.185, 0.65]], 20, Math.PI * 0.55, Math.PI * 0.9))
  ring(s, rig.torso, gold, 0.162, 0.006, 0.52, [b, 0.85 * b])
  const skirt = new Skirt(s, rig.hips, robe, { top: 0.06, length: 0.88, neck: 0.18, hem: 0.34 })
  s.onFrame((frame) => skirt.update(frame))
  belt(s, leather, gold, { y: 0.05, r: 0.186 })
  {
    const scroll = joint(rig.hips, -0.19 * b, 0.0, 0.06)
    scroll.rotation.set(0.3, 0, 0.15)
    s.add(scroll, paper, new CylinderGeometry(0.022, 0.022, 0.16, 12))
    for (const y of [-0.085, 0.085]) s.add(scroll, iron, shaped(new CylinderGeometry(0.008, 0.008, 0.06, 6), { turn: [0, 0, Math.PI / 2], at: [0, y, 0] }))
    s.add(scroll, ember, shaped(new CylinderGeometry(0.0225, 0.0225, 0.02, 12), { at: [0, 0.02, 0] }), false)
    for (const [x, z] of [[0.15, 0.11], [0.19, 0.04]] as const) s.add(rig.hips, leather, shaped(new BoxGeometry(0.06, 0.08, 0.045), { turn: [0, Math.atan2(x, z), 0], at: [x * b, -0.03, z * b] }))
  }
  arms(s, { upper: cloth, fore: cloth, bell: 0.11 })
  for (const { elbow } of rig.arms) {
    ring(s, elbow, dark, 0.108, 0.01, -0.285)
    ring(s, elbow, gold, 0.1, 0.005, -0.25)
  }
  hand(s, s.left.hand, -1, skin, 'open')
  face(s, { skin, white: s.surface('#f2ece4'), iris: s.surface('#3a2a1c'), brows: beard, hair: beard, mouth: s.surface('#8a4a3a') })
  // A pointed beard and a moustache.
  s.add(rig.head, beard, shaped(new ConeGeometry(0.06, 0.16, 8), { turn: [Math.PI + 0.35, 0, 0], at: [0, 0.01, 0.07] }))
  for (const side of [-1, 1]) s.add(rig.head, beard, sweep([[0, 0.085, 0.125], [side * 0.035, 0.08, 0.12], [side * 0.06, 0.06, 0.1]], (u) => 0.011 * (1 - u * 0.6), 5, 8))
  s.add(rig.head, beard, shaped(new SphereGeometry(0.128, 16, 10, Math.PI / 2 + 0.85, Math.PI * 2 - 1.7, Math.PI * 0.3, Math.PI * 0.4), { size: [0.94, 1, 1], at: [0, 0.14, -0.02] }))
  // The hat: a drooping brim, a tall crown bent back at the tip, a band with a buckle.
  const hat = joint(rig.head, 0, 0.22, -0.01)
  hat.rotation.x = -0.08
  s.add(hat, cloth, lathe([[0.27, -0.03], [0.22, 0.0], [0.14, 0.012]], 30))
  s.add(hat, cloth, sweep([[0, 0, 0], [0, 0.18, -0.01], [0, 0.34, -0.05], [0.02, 0.44, -0.13], [0.05, 0.47, -0.22]], (u) => 0.14 * (1 - u) ** 1.15 + 0.006, 16, 40))
  band(s, hat, dark, 0.138, 0.01, 0.055, [1, 1], 0.128)
  s.add(hat, gold, shaped(new TorusGeometry(0.022, 0.006, 4, 4), { turn: [0, 0, Math.PI / 4], at: [0, 0.033, 0.135] }))
  s.add(hat, ember, shaped(new OctahedronGeometry(0.014, 0), { at: [0, 0.033, 0.142] }), false)
  // The staff.
  const held = staff(s, skin, 1.15)
  s.add(held.staff, iron, new CylinderGeometry(0.02, 0.024, 1.5, 10).translate(0, 0.33, 0))
  for (const y of [-0.4, -0.1, 0.2, 0.5, 0.8, 1.05]) s.add(held.staff, gold, shaped(new CylinderGeometry(0.026, 0.026, 0.018, 10), { at: [0, y, 0] }))
  s.add(held.staff, iron, shaped(new ConeGeometry(0.024, 0.08, 8), { turn: [Math.PI, 0, 0], at: [0, -0.44, 0] }))
  for (let index = 0; index < 4; index += 1) {
    const turn = index / 4 * Math.PI * 2
    const out = (r: number, y: number): Triple => [Math.sin(turn) * r, y, Math.cos(turn) * r]
    s.add(held.head, iron, sweep([out(0.02, -0.08), out(0.075, -0.03), out(0.07, 0.04), out(0.03, 0.08)], (u) => 0.012 * (1 - u * 0.7), 6, 14))
  }
  s.add(held.head, ember, new IcosahedronGeometry(0.06, 1), false)
  const flames: Group[] = []
  for (let index = 0; index < 3; index += 1) {
    const flame = joint(held.head, (index - 1) * 0.025, 0.04, (index % 2) * 0.02)
    s.add(flame, index === 1 ? hot : ember, shaped(new ConeGeometry(0.035 - index * 0.004, 0.16 - Math.abs(index - 1) * 0.04, 8), { at: [0, 0.08, 0] }), false)
    flames.push(flame)
  }
  s.onFrame(({ t, gathering, burst }) => {
    for (const [index, flame] of flames.entries()) {
      flame.scale.set(1, 0.8 + Math.sin(t * (9 + index * 3) + index) * 0.25 + gathering * 0.7 + burst * 0.5, 1)
      flame.rotation.z = Math.sin(t * 6 + index * 2) * 0.12
    }
  })
  return s.finish({ main: held.main, mainHold: 'up', tip: held.head, robed: true })
}

// ---------------------------------------------------------------------------------------------------------------- Sage

// A nature healer in mossy green with leaves at the hem, long brown hair crowned with leaves and flowers, a mantle of vines down
// her back, wooden bangles, a braided belt hung with herbs, and a living staff whose branches cradle a glowing seed.
export function sage(kit: DetailKit, rig: Rig, look: Look, b: number): Detail {
  const s = new Sculpt(kit, rig, look, b)
  const texture = robeTexture(`sage|${look.cloth}|${look.accent}`, look.cloth, (context, width, height) => {
    const random = seededRandom(4)
    context.fillStyle = shade(look.cloth, 0.75)
    context.fillRect(0, height * 0.75, width, height * 0.25)
    for (let index = 0; index < 60; index += 1) {
      const x = random() * width
      const y = height * (0.72 + random() * 0.26)
      context.save()
      context.translate(x, y)
      context.rotate(random() * Math.PI)
      context.fillStyle = index % 3 === 0 ? look.accent : shade(look.cloth, 1.25)
      context.beginPath()
      context.ellipse(0, 0, 4, 11, 0, 0, Math.PI * 2)
      context.fill()
      context.restore()
    }
  })
  const robe = s.cloth(texture ? '#ffffff' : look.cloth, { map: texture ?? null })
  const cloth = s.cloth(look.cloth)
  const brown = s.surface(look.trim, { roughness: 0.85 })
  const skin = s.surface(look.skin, { roughness: 0.55 })
  const hair = s.surface('#6b4426', { roughness: 0.8 })
  const leaf = s.surface('#5fa84f', { roughness: 0.6, side: DoubleSide })
  const darkLeaf = s.surface('#3f7a35', { roughness: 0.7, side: DoubleSide })
  const petal = s.surface('#f0a8c8', { roughness: 0.6 })
  const wood = s.surface('#7a5a34', { roughness: 0.9, flatShading: true })
  const seed = s.glow(look.accent, 1.6)
  const leafAt = (parent: Group, at: Triple, turn: Triple, size = 1, material: Material = leaf): void => {
    s.add(parent, material, shaped(new SphereGeometry(1, 8, 6), { size: [0.022 * size, 0.05 * size, 0.006], turn, at }))
  }

  underRobe(s, brown, brown, brown, 'round')
  chest(s, cloth)
  const skirt = new Skirt(s, rig.hips, robe, { top: 0.06, length: 0.88, neck: 0.18, hem: 0.34, ragged: 0.05, tatters: 24, seed: 8 })
  s.onFrame((frame) => skirt.update(frame))
  // A braided belt, herbs and a pouch hung from it.
  for (const offset of [0, 0.02]) ring(s, rig.torso, brown, 0.186 * b, 0.011, 0.05 + offset, [1, 0.84])
  s.add(rig.hips, brown, shaped(new SphereGeometry(0.045, 10, 8), { size: [1, 1.1, 0.7], at: [0.17 * b, -0.04, 0.09] }))
  for (let index = 0; index < 4; index += 1) leafAt(rig.hips, [-0.15 * b + index * 0.012, -0.05 - index * 0.01, 0.13], [0.2, 0, 0.3 - index * 0.2], 1.1, darkLeaf)
  // A mantle of leaves over the shoulders.
  for (let index = 0; index < 20; index += 1) {
    const turn = (index / 20) * Math.PI * 2
    const x = Math.sin(turn) * 0.19 * b
    const z = Math.cos(turn) * 0.16 * b
    leafAt(rig.torso, [x, 0.5, z], [Math.cos(turn) * 1.1, 0, -Math.sin(turn) * 1.1], 1.4, index % 2 ? leaf : darkLeaf)
  }
  arms(s, { upper: cloth, fore: cloth, bell: 0.095 })
  for (const { elbow } of rig.arms) for (const y of [-0.23, -0.25]) ring(s, elbow, wood, 0.052, 0.008, y)
  hand(s, s.left.hand, -1, skin, 'open')
  face(s, { skin, white: s.surface('#f6f2ec'), iris: s.surface('#3f7a35'), brows: hair, hair, mouth: s.surface('#b56a6a'), wide: 0.95 })
  // Long hair, a fringe swept aside, and the crown.
  s.add(rig.head, hair, shaped(new SphereGeometry(0.134, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), { size: [0.98, 1, 1.03], turn: [-0.2, 0, 0], at: [0, 0.14, -0.012] }))
  for (let index = 0; index < 11; index += 1) {
    const x = (index - 5) * 0.022
    s.add(rig.head, hair, sweep([[x, 0.2, -0.08], [x * 1.4, 0.1, -0.14], [x * 1.6, -0.1, -0.14], [x * 1.5, -0.33, -0.12 - Math.abs(x) * 0.4]], (u) => 0.022 * (1 - u * 0.55), 6, 18))
  }
  for (const side of [-1, 1]) s.add(rig.head, hair, sweep([[side * 0.09, 0.2, 0.06], [side * 0.13, 0.1, 0.04], [side * 0.14, -0.06, 0.0], [side * 0.15, -0.16, -0.01]], (u) => 0.022 * (1 - u * 0.5), 6, 14))
  ring(s, rig.head, wood, 0.137, 0.01, 0.2, [1, 1.05])
  for (let index = 0; index < 14; index += 1) {
    const turn = index / 14 * Math.PI * 2
    leafAt(rig.head, [Math.sin(turn) * 0.142, 0.23, Math.cos(turn) * 0.148], [Math.cos(turn) * 0.5, 0, -Math.sin(turn) * 0.5], 1, index % 2 ? leaf : darkLeaf)
  }
  for (const turn of [-0.6, 0.2, 0.9]) {
    for (let index = 0; index < 5; index += 1) {
      const petalTurn = index / 5 * Math.PI * 2
      s.add(rig.head, petal, shaped(new SphereGeometry(0.012, 6, 4), { at: [Math.sin(turn) * 0.15 + Math.cos(petalTurn) * 0.012, 0.215 + Math.sin(petalTurn) * 0.012, Math.cos(turn) * 0.155] }))
    }
    s.add(rig.head, s.surface('#f6d55c'), shaped(new SphereGeometry(0.008, 6, 4), { at: [Math.sin(turn) * 0.158, 0.215, Math.cos(turn) * 0.163] }))
  }
  // Vines down the back, swaying, leaves on them.
  const vines: Group[] = []
  for (let index = 0; index < 5; index += 1) {
    const x = (index - 2) * 0.07 * b
    const vine = joint(rig.torso, x, 0.5, -chestFront(s, 0.5, x) - 0.02)
    const length = 0.5 + (index % 2) * 0.18
    s.add(vine, darkLeaf, sweep([[0, 0, 0], [0.02, -length * 0.35, -0.01], [-0.02, -length * 0.7, 0], [0.01, -length, -0.01]], 0.007, 5, 16))
    for (let leafIndex = 1; leafIndex < 6; leafIndex += 1) {
      const y = -length * leafIndex / 6
      leafAt(vine, [(leafIndex % 2 ? 0.025 : -0.025), y, -0.01], [0, 0, leafIndex % 2 ? -0.9 : 0.9], 1.1, leafIndex % 2 ? leaf : darkLeaf)
    }
    vines.push(vine)
  }
  s.onFrame(({ t, walk }) => {
    for (const [index, vine] of vines.entries()) vine.rotation.x = 0.1 + walk * 0.35 + Math.sin(t * 2.2 + index) * 0.05
  })
  // The staff: a living shaft wound by a vine, its branches cradling the seed.
  const held = staff(s, skin, 1.16)
  shaft(s, held.staff, wood, -0.42, 1.08, 0.025, 0.02, 0.03, 31)
  const spiral: Triple[] = []
  for (let index = 0; index <= 24; index += 1) {
    const y = 0.2 + index * 0.035
    spiral.push([Math.cos(index * 0.9) * 0.03, y, Math.sin(index * 0.9) * 0.03])
  }
  s.add(held.staff, darkLeaf, sweep(spiral, 0.006, 5, 80))
  for (let index = 2; index < 24; index += 4) leafAt(held.staff, [Math.cos(index * 0.9) * 0.045, 0.2 + index * 0.035, Math.sin(index * 0.9) * 0.045], [0, -index * 0.9, 1.2], 1, leaf)
  for (let index = 0; index < 5; index += 1) {
    const turn = index / 5 * Math.PI * 2
    const out = (r: number, y: number): Triple => [Math.sin(turn) * r, y, Math.cos(turn) * r]
    s.add(held.head, wood, sweep([out(0.015, -0.09), out(0.06, -0.04), out(0.07, 0.04), out(0.05, 0.1)], (u) => 0.012 * (1 - u * 0.7), 6, 14))
    leafAt(held.head, out(0.07, 0.1), [Math.cos(turn) * 0.6, 0, -Math.sin(turn) * 0.6], 1.2, leaf)
  }
  s.add(held.head, seed, shaped(new SphereGeometry(0.05, 16, 12), { size: [1, 1.25, 1] }), false)
  s.add(held.head, leaf, shaped(new SphereGeometry(1, 10, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), { size: [0.06, 0.05, 0.06], at: [0, -0.01, 0] }))
  return s.finish({ main: held.main, mainHold: 'up', tip: held.head, robed: true })
}
