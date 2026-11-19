import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Group,
  type Material,
  type Object3D,
} from 'three'
import { lathe, radiusAt, shaped, sweep, type Sculpt, type Triple } from './kit.ts'

// Pieces of a body every detailed champion is made from: the chest, the neck, a face, arms, hands, legs, boots, belts and
// straps. Each is shaped for the humanoid's skeleton (see `Rig` in kit.ts) and takes what it is made of.

// The chest from the waist (0) to the neck, as [radius, height], for a body of bulk 1, wider across than deep.
export const CHEST: Array<[number, number]> = [[0.165, -0.005], [0.17, 0.08], [0.19, 0.2], [0.205, 0.32], [0.205, 0.4], [0.185, 0.47], [0.14, 0.53], [0.07, 0.565]]

// The chest, in a material, `grow` out from the body (a coat over a shirt), `depth` deep against its width.
export function chest(s: Sculpt, material: Material, options: { grow?: number; depth?: number; profile?: Array<[number, number]>; from?: number; span?: number; parent?: Object3D } = {}): void {
  const { grow = 0, depth = 0.8, profile = CHEST, from = 0, span = Math.PI * 2 } = options
  const shape = profile.map(([r, y]): [number, number] => [r + grow, y])
  const parent = options.parent ?? s.rig.torso
  s.add(parent, material, shaped(lathe(shape, 28, from, span), { size: [s.b, 1, depth * s.b] }))
  // The line of the shoulders, out to the arms, on a whole chest.
  if (span >= Math.PI * 2 && profile === CHEST) {
    s.add(parent, material, shaped(new CapsuleGeometry(0.068 + grow, 0.36 * s.b, 4, 12), { turn: [0, 0, Math.PI / 2], size: [1, 0.85, 0.95], at: [0, 0.455, -0.01] }))
  }
}

// Where the surface of the chest is, ahead of (or with `back`, behind) its middle at a height, and `x` across.
export function chestFront(s: Sculpt, y: number, x = 0, options: { grow?: number; depth?: number; profile?: Array<[number, number]> } = {}): number {
  const { grow = 0, depth = 0.8, profile = CHEST } = options
  const r = radiusAt(profile, y) + grow
  return r * depth * s.b * Math.sqrt(Math.max(0, 1 - (x / (r * s.b)) ** 2))
}

// A ring round a joint, level, `y` up it: a belt, a band of trim, a cuff.
export function ring(s: Sculpt, parent: Object3D, material: Material, r: number, tube: number, y: number, size: [number, number] = [1, 1], shadow = true): void {
  s.add(parent, material, shaped(new TorusGeometry(r, tube, 6, 32), { turn: [Math.PI / 2, 0, 0], size: [size[0], size[1], 1], at: [0, y, 0] }), shadow)
}

// A band round a joint, from `y0` up to `y1`: a belt, a sash, a cuff.
export function band(s: Sculpt, parent: Object3D, material: Material, r: number, y0: number, y1: number, size: [number, number] = [1, 1], r1 = r): void {
  s.add(parent, material, shaped(lathe([[r, y0], [r1, y1]], 28), { size: [size[0], 1, size[1]] }))
}

// A strap or a rod from one point to another on a joint, `width` across and `thick` deep (or round, if `round`).
export function strap(s: Sculpt, parent: Object3D, material: Material, from: Triple, to: Triple, width: number, thick: number, round = false): void {
  const a = new Vector3(...from)
  const b = new Vector3(...to)
  const along = b.clone().sub(a)
  const geometry: BufferGeometry = round ? new CylinderGeometry(width, width, along.length(), 8) : new BoxGeometry(width, along.length(), thick)
  geometry.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), along.clone().normalize()))
  const middle = a.add(b).multiplyScalar(0.5)
  geometry.translate(middle.x, middle.y, middle.z)
  s.add(parent, material, geometry)
}

// ---------------------------------------------------------------------------------------------------------------- the head

export type FaceOptions = {
  skin: Material
  // Eyes: their whites and irises; or glowing, in a colour (and dark round them); or none (under a mask).
  iris?: Material
  white?: Material
  glow?: Material
  // Round glowing eyes, dark.
  socket?: Material
  eyes?: boolean
  brows?: Material
  ears?: 'round' | 'pointed' | 'none'
  mouth?: Material
  nose?: boolean
  neck?: Material | false
  // How wide the face is against the usual.
  wide?: number
  // Hair over the back and sides of the head, clear of the face.
  hair?: Material
}

// A face on the head joint: a skull and a jaw, a brow, a nose, ears, eyes with irises (or eyes that glow), brows and a mouth.
export function face(s: Sculpt, options: FaceOptions): void {
  const head = s.rig.head
  const { skin, ears = 'round', nose = true, wide = 1 } = options
  s.add(head, skin, shaped(new SphereGeometry(0.122, 20, 14), { size: [0.92 * wide, 1.04, 1], at: [0, 0.135, -0.008] }))
  s.add(head, skin, shaped(new SphereGeometry(0.085, 16, 10), { size: [1.05 * wide, 0.82, 1.02], at: [0, 0.062, 0.03] }))
  s.add(head, skin, shaped(new CapsuleGeometry(0.014, 0.075 * wide, 4, 8), { turn: [0, 0, Math.PI / 2], size: [1, 0.8, 0.7], at: [0, 0.163, 0.1] }))
  for (const side of [-1, 1]) s.add(head, skin, shaped(new SphereGeometry(0.022, 10, 8), { size: [1, 0.7, 0.6], at: [side * 0.058 * wide, 0.094, 0.074] }))
  if (nose) {
    s.add(head, skin, shaped(new SphereGeometry(0.018, 10, 8), { size: [0.9, 1.6, 1], turn: [-0.35, 0, 0], at: [0, 0.112, 0.118] }))
    s.add(head, skin, shaped(new SphereGeometry(0.014, 8, 6), { size: [1.4, 0.9, 1], at: [0, 0.094, 0.124] }))
  }
  if (ears !== 'none') {
    for (const side of [-1, 1]) {
      if (ears === 'pointed') {
        s.add(head, skin, shaped(new ConeGeometry(0.026, 0.11, 6), { size: [1, 1, 0.45], turn: [-0.5, 0, -side * 0.9], at: [side * 0.13 * wide, 0.15, -0.02] }))
      } else {
        s.add(head, skin, shaped(new SphereGeometry(0.03, 10, 8), { size: [0.42, 1, 0.72], turn: [0, side * 0.3, 0], at: [side * 0.112 * wide, 0.12, -0.005] }))
      }
    }
  }
  if (options.eyes !== false) {
    for (const side of [-1, 1]) {
      const x = side * 0.042 * wide
      if (options.glow) {
        s.add(head, options.socket ?? skin, shaped(new SphereGeometry(0.02, 10, 8), { size: [1.3, 0.85, 0.6], at: [x, 0.134, 0.102] }), false)
        s.add(head, options.glow, shaped(new SphereGeometry(0.012, 10, 8), { size: [1.3, 0.8, 0.6], at: [x, 0.134, 0.112] }), false)
      } else {
        s.add(head, options.white ?? skin, shaped(new SphereGeometry(0.018, 10, 8), { size: [1.15, 0.85, 0.6], at: [x, 0.134, 0.102] }), false)
        if (options.iris) s.add(head, options.iris, shaped(new SphereGeometry(0.0095, 8, 6), { at: [x, 0.134, 0.112] }), false)
      }
      if (options.brows) s.add(head, options.brows, shaped(new BoxGeometry(0.045, 0.01, 0.014), { turn: [0, 0, -side * 0.12], at: [x, 0.168, 0.11] }), false)
    }
  }
  if (options.hair) s.add(head, options.hair, shaped(new SphereGeometry(0.127, 20, 12, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.72), { size: [0.96 * wide, 1.05, 1.04], at: [0, 0.136, -0.012] }))
  if (options.mouth) s.add(head, options.mouth, shaped(new CapsuleGeometry(0.006, 0.03, 3, 6), { turn: [0, 0, Math.PI / 2], at: [0, 0.067, 0.112] }), false)
  if (options.neck !== false) s.add(head, options.neck ?? skin, shaped(new CylinderGeometry(0.052, 0.058, 0.14, 12), { at: [0, -0.02, -0.01] }))
}

// ---------------------------------------------------------------------------------------------------------------- arms and hands

export type HandMode = 'grip' | 'open' | 'fist' | 'claw'

// A hand on its joint. Gripping, its fingers close round what it holds (along +Z, as held weapons are); open, they hang a little
// curled; a fist is closed on nothing.
// A hand gripping something upright (a staff, a bow) closes round +Y instead: `axis` 'y'.
export function hand(s: Sculpt, parent: Group, side: number, material: Material, mode: HandMode, size = 1, axis: 'y' | 'z' = 'z'): void {
  const k = size
  s.add(parent, material, shaped(new SphereGeometry(0.044 * k, 12, 8), { size: [0.72, 1, 1.05], at: [side * 0.006, 0.006, 0] }))
  if (mode === 'grip' || mode === 'fist') {
    const r = mode === 'grip' ? 0.026 : 0.017
    for (let index = 0; index < 4; index += 1) {
      const along = (-0.026 + index * 0.0175) * k
      const ring = new TorusGeometry((r - Math.abs(index - 1.5) * 0.002) * k, 0.0115 * k, 6, 12)
      s.add(parent, material, axis === 'y' ? shaped(ring, { turn: [Math.PI / 2, 0, 0], at: [0, along - 0.006, 0] }) : shaped(ring, { at: [0, -0.006, along] }))
    }
    s.add(parent, material, shaped(new CapsuleGeometry(0.013 * k, 0.034 * k, 3, 8), { turn: [Math.PI / 2 - 0.3, 0, 0], at: [-side * 0.028 * k, 0.016, 0.026 * k] }))
    return
  }
  for (let index = 0; index < 4; index += 1) {
    const z = (-0.024 + index * 0.016) * k
    const length = (index === 0 ? 0.04 : index === 3 ? 0.042 : 0.05) * k
    const finger = shaped(new CapsuleGeometry(0.009 * k, length, 3, 6), { turn: [mode === 'claw' ? 0.5 : 0.25, 0, -side * 0.1], at: [0, -0.04 * k - length / 2, z + (mode === 'claw' ? 0.012 : 0.006)] })
    s.add(parent, material, finger)
  }
  s.add(parent, material, shaped(new CapsuleGeometry(0.01 * k, 0.032 * k, 3, 6), { turn: [0.9, 0, -side * 0.5], at: [-side * 0.022 * k, -0.018, 0.03 * k] }))
}

export type ArmOptions = {
  upper: Material
  fore: Material
  // How thick the upper arm and the forearm are (a radius, at their thickest).
  upperR?: number
  foreR?: number
  // A sleeve that flares to the wrist, as wide as this there.
  bell?: number
  // A ball at the shoulder and at the elbow, rounding the joint (the upper arm's material, if not given).
  joints?: Material | false
}

// Both arms, from the shoulder to the wrist.
export function arms(s: Sculpt, options: ArmOptions): void {
  const { upperR = 0.058, foreR = 0.05 } = options
  for (const { shoulder, elbow } of s.rig.arms) {
    s.add(shoulder, options.upper, lathe([[upperR * 0.86, -0.31], [upperR, -0.17], [upperR * 1.04, -0.06], [upperR * 0.98, 0.02]], 16))
    if (options.joints !== false) s.add(shoulder, options.joints ?? options.upper, shaped(new SphereGeometry(upperR * 1.05, 14, 10), { at: [0, -0.015, 0] }))
    if (options.bell) {
      s.add(elbow, options.fore, lathe([[options.bell, -0.29], [foreR * 1.25, -0.14], [foreR * 1.05, -0.02], [foreR, 0.04]], 18))
    } else {
      s.add(elbow, options.fore, lathe([[foreR * 0.74, -0.27], [foreR * 0.95, -0.15], [foreR, -0.05], [foreR * 0.96, 0.03]], 16))
    }
    if (options.joints !== false) s.add(elbow, options.joints ?? options.upper, new SphereGeometry(foreR * 1.1, 12, 8))
  }
}

// ---------------------------------------------------------------------------------------------------------------- legs and feet

export type LegOptions = {
  thigh: Material
  shin: Material
  thighR?: number
  shinR?: number
  // Baggy trousers, as wide as this at the bottom.
  baggy?: number
  knee?: Material | false
}

// Both legs, from the hip to the ankle.
export function legs(s: Sculpt, options: LegOptions): void {
  const { thighR = 0.088, shinR = 0.066 } = options
  for (const { hip, knee } of s.rig.legs) {
    s.add(hip, options.thigh, lathe([[thighR * 0.8, -0.43], [thighR * 0.98, -0.25], [thighR * 1.05, -0.1], [thighR, 0.03]], 16))
    if (options.baggy) {
      s.add(knee, options.shin, lathe([[options.baggy * 0.7, -0.43], [options.baggy, -0.36], [options.baggy * 0.95, -0.15], [thighR * 0.85, 0.02]], 16))
    } else {
      s.add(knee, options.shin, lathe([[shinR * 0.76, -0.43], [shinR, -0.2], [shinR * 1.03, -0.07], [shinR * 1.0, 0.03]], 16))
    }
    if (options.knee !== false) s.add(knee, options.knee ?? options.thigh, new SphereGeometry(thighR * 0.82, 12, 8))
  }
}

export type BootOptions = {
  material: Material
  sole?: Material
  // How far up the leg it comes, from the ground (0.48 is the knee).
  height?: number
  // A folded-over top in its own material.
  cuff?: Material
  toe?: 'round' | 'pointed' | 'curl'
  width?: number
  // Laces up the front, or a buckle, in this.
  laces?: Material
}

// A boot or a shoe on each foot. The sole is on the ground, 0.48 under the knee.
export function boots(s: Sculpt, options: BootOptions): void {
  const { material, height = 0.14, toe = 'round', width = 1 } = options
  for (const { knee } of s.rig.legs) {
    const sole = -0.48
    // The foot: a dome from heel to toe, and the toe on its own.
    s.add(knee, material, shaped(new SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), { size: [0.06 * width, 0.062, 0.13], at: [0, sole + 0.018, 0.04] }))
    if (toe === 'pointed' || toe === 'curl') {
      const tip: Triple[] = toe === 'curl'
        ? [[0, sole + 0.03, 0.13], [0, sole + 0.03, 0.2], [0, sole + 0.07, 0.25], [0, sole + 0.1, 0.22]]
        : [[0, sole + 0.03, 0.13], [0, sole + 0.025, 0.21]]
      s.add(knee, material, sweep2(tip, (u) => 0.038 * width * (1 - u * 0.85)))
    }
    if (options.sole) s.add(knee, options.sole, shaped(new BoxGeometry(0.115 * width, 0.022, 0.27), { at: [0, sole + 0.011, 0.04] }))
    // The shaft up the leg.
    const top = sole + height
    s.add(knee, material, lathe([[0.068 * width, sole + 0.03], [0.068, (sole + top) / 2], [0.072, top]], 16))
    if (options.cuff) s.add(knee, options.cuff, lathe([[0.084, top - 0.06], [0.078, top + 0.012]], 16))
    if (options.laces) {
      for (let y = sole + 0.07; y < top - 0.02; y += 0.03) s.add(knee, options.laces, shaped(new BoxGeometry(0.05, 0.007, 0.006), { turn: [0, 0, 0.35], at: [0, y, 0.07] }), false)
    }
  }
}

// A tube for a toe.
function sweep2(points: Triple[], radius: (u: number) => number): BufferGeometry {
  return sweep(points, radius, 10, 10)
}

// ---------------------------------------------------------------------------------------------------------------- belts

// A belt round the waist (on the torso, `y` up it) with a buckle at the front in `metal`.
export function belt(s: Sculpt, material: Material, metal: Material | undefined, options: { y?: number; r?: number; width?: number; depth?: number; parent?: Object3D } = {}): void {
  const { y = 0.05, r = 0.182, width = 0.05, depth = 0.84 } = options
  const parent = options.parent ?? s.rig.torso
  band(s, parent, material, r, y - width / 2, y + width / 2, [s.b, depth * s.b])
  if (metal) {
    const z = r * depth * s.b + 0.004
    s.add(parent, metal, shaped(new TorusGeometry(0.024, 0.006, 4, 4), { turn: [0, 0, Math.PI / 4], size: [1.1, 0.85, 1], at: [0, y, z] }))
    s.add(parent, metal, shaped(new BoxGeometry(0.005, 0.036, 0.006), { at: [0.004, y, z + 0.003] }))
  }
}
