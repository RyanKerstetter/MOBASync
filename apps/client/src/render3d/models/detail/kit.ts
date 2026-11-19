import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  SRGBColorSpace,
  Vector2 as ThreeVector2,
  Vector3,
  type ColorRepresentation,
  type Material,
  type MeshStandardMaterial,
  type MeshStandardMaterialParameters,
  type Object3D,
  type Texture,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { seededRandom, smoothstep } from '../../space.ts'
import type { Look } from '../looks.ts'

// What every champion built in detail is made with: the humanoid's skeleton to hang it on, ways to shape pieces (turned
// profiles, tapering tubes swept along curves), pieces merged by joint and material so a model is a few dozen draws, cloth
// painted on canvases, and cloth that moves (capes that blow, robes the legs push out as they walk).

// How a held thing keeps its angle as the arm moves (see humanoid.ts).
export type Hold = 'free' | 'up' | 'aim' | 'bow'

// What a detailed model is told each frame, after the humanoid has posed its skeleton.
export type DetailFrame = {
  t: number
  dt: number
  // How much it is walking (0 to 1), and how far through its stride.
  walk: number
  phase: number
  // How far each leg is swung forward (negative) or back.
  hipL: number
  hipR: number
  dead: boolean
  // A spell or a blow gathering (0 to 1), and the burst as it goes off (1, fading).
  gathering: number
  burst: number
}

// The humanoid's way of adding a part, making a surface, and making a surface glow with what it does.
export type DetailKit = {
  part: (parent: Object3D, geometry: BufferGeometry, material: Material, x?: number, y?: number, z?: number, shadow?: boolean) => Mesh
  surface: (color: ColorRepresentation, params?: MeshStandardMaterialParameters) => MeshStandardMaterial
  glowing: (material: MeshStandardMaterial, base: number) => void
}

export type RigArm = { side: number; shoulder: Group; elbow: Group; hand: Group }
export type RigLeg = { side: number; hip: Group; knee: Group }

// The joints of the humanoid. Lengths, in the units it is built in: hips 0.92 off the ground, a hip to its knee 0.42 and the
// knee to the sole 0.48; the torso from the waist (0) to the neck (0.56), shoulders at 0.47; the head's middle 0.12 over its
// joint; a shoulder to its elbow 0.3 and the elbow to the hand 0.3. +Z is ahead.
export type Rig = {
  root: Group
  hips: Group
  torso: Group
  head: Group
  legs: RigLeg[]
  arms: RigArm[]
}

// What a detailed model gives the humanoid: what it holds and how, where what it does comes from, and how its own parts move.
export type Detail = {
  main: Group
  mainHold?: Hold
  off?: Group
  offHold?: Hold
  tip: Object3D
  strike?: Object3D
  offStrike?: Object3D
  strikeShape?: { x: number; y: number; z: number }
  // A gun held in both hands (see humanoid.ts): on the root, gripped in the right hand and pointing through the left.
  carried?: Group
  // Its legs are under a robe to the ankles, so they take short steps.
  robed?: boolean
  animate: (frame: DetailFrame) => void
}

export type DetailBuilder = (kit: DetailKit, rig: Rig, look: Look, b: number) => Detail

export type Triple = [number, number, number]
export type Place = { at?: Triple; turn?: Triple; size?: Triple | number }

// A geometry scaled, turned (as an object's rotation would: X, then Y, then Z, about the parent) and moved, in place.
export function shaped<T extends BufferGeometry>(geometry: T, place: Place = {}): T {
  const { size, turn, at } = place
  if (size !== undefined) {
    if (typeof size === 'number') geometry.scale(size, size, size)
    else geometry.scale(size[0], size[1], size[2])
  }
  if (turn) {
    if (turn[2]) geometry.rotateZ(turn[2])
    if (turn[1]) geometry.rotateY(turn[1])
    if (turn[0]) geometry.rotateX(turn[0])
  }
  if (at) geometry.translate(at[0], at[1], at[2])
  return geometry
}

// A shape turned round the Y axis from a profile of [radius, height] points, given from the bottom up so it faces out; part of
// the way round only, from `from` (0 is ahead, +Z; a quarter turn is +X) for `span` radians.
export function lathe(profile: Array<[number, number]>, segments = 20, from = 0, span = Math.PI * 2): LatheGeometry {
  return new LatheGeometry(profile.map(([r, y]) => new ThreeVector2(r, y)), segments, from, span)
}

// The radius of a profile at a height, between its points.
export function radiusAt(profile: Array<[number, number]>, y: number): number {
  for (let index = 1; index < profile.length; index += 1) {
    const [r0, y0] = profile[index - 1]
    const [r1, y1] = profile[index]
    if (y <= y1) return r0 + (r1 - r0) * Math.max(0, (y - y0) / (y1 - y0))
  }
  return profile[profile.length - 1][0]
}

// A tube swept along a smooth curve through `points`, its radius given along it (0 at the start, 1 at the end): a horn, a limb
// of a bow, a strand of hair, a branch.
export function sweep(points: Triple[], radius: number | ((u: number) => number), radial = 8, steps = 24): BufferGeometry {
  const curve = new CatmullRomCurve3(points.map(([x, y, z]) => new Vector3(x, y, z)))
  const frames = curve.computeFrenetFrames(steps, false)
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const at = new Vector3()
  const out = new Vector3()
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps
    curve.getPointAt(u, at)
    const r = typeof radius === 'number' ? radius : radius(u)
    for (let j = 0; j <= radial; j += 1) {
      const v = j / radial * Math.PI * 2
      out.copy(frames.normals[i]).multiplyScalar(Math.cos(v)).addScaledVector(frames.binormals[i], Math.sin(v))
      positions.push(at.x + out.x * r, at.y + out.y * r, at.z + out.z * r)
      normals.push(out.x, out.y, out.z)
      uvs.push(j / radial, u)
    }
  }
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * (radial + 1) + j
      const b = a + radial + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(indices)
  return geometry
}

// Pushes each corner of a shape out or in along its normal a little at random (a gnarled branch, rough bark, a ragged fur),
// corners shared by faces together.
export function roughen<T extends BufferGeometry>(geometry: T, amount: number, seed: number): T {
  const random = seededRandom(seed)
  const positions = geometry.getAttribute('position')
  const normals = geometry.getAttribute('normal')
  const moved = new Map<string, number>()
  for (let index = 0; index < positions.count; index += 1) {
    const key = `${positions.getX(index).toFixed(3)},${positions.getY(index).toFixed(3)},${positions.getZ(index).toFixed(3)}`
    let push = moved.get(key)
    if (push === undefined) {
      push = (random() - 0.5) * 2 * amount
      moved.set(key, push)
    }
    positions.setXYZ(index, positions.getX(index) + normals.getX(index) * push, positions.getY(index) + normals.getY(index) * push, positions.getZ(index) + normals.getZ(index) * push)
  }
  geometry.computeVertexNormals()
  return geometry
}

// The static pieces of a model, gathered by the joint they are on and what they are made of, and merged into one mesh each.
class Plates {
  private readonly bins: Array<{ parent: Object3D; material: Material; shadow: boolean; pieces: BufferGeometry[] }> = []

  add(parent: Object3D, material: Material, geometry: BufferGeometry, shadow: boolean): void {
    // Every piece is merged with the same attributes and indexed.
    if (!geometry.index) {
      const count = geometry.getAttribute('position').count
      geometry.setIndex(Array.from({ length: count }, (_, index) => index))
    }
    for (const name of Object.keys(geometry.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name)
    let bin = this.bins.find((entry) => entry.parent === parent && entry.material === material && entry.shadow === shadow)
    if (!bin) {
      bin = { parent, material, shadow, pieces: [] }
      this.bins.push(bin)
    }
    bin.pieces.push(geometry)
  }

  build(kit: DetailKit): void {
    for (const bin of this.bins) {
      const merged = bin.pieces.length === 1 ? bin.pieces[0] : mergeGeometries(bin.pieces, false)
      if (!merged) throw new Error('The pieces of a model could not be merged.')
      if (merged !== bin.pieces[0]) for (const piece of bin.pieces) piece.dispose()
      kit.part(bin.parent, merged, bin.material, 0, 0, 0, bin.shadow)
    }
    this.bins.length = 0
  }
}

// One detailed model being built: its pieces, its surfaces, and what moves each frame.
export class Sculpt {
  private readonly plates = new Plates()
  private readonly animators: Array<(frame: DetailFrame) => void> = []

  constructor(readonly kit: DetailKit, readonly rig: Rig, readonly look: Look, readonly b: number) {}

  get right(): RigArm {
    return this.rig.arms.find((arm) => arm.side > 0)!
  }

  get left(): RigArm {
    return this.rig.arms.find((arm) => arm.side < 0)!
  }

  // A static piece on a joint, merged with the others there of the same material.
  add(parent: Object3D, material: Material, geometry: BufferGeometry, shadow = true): void {
    this.plates.add(parent, material, geometry, shadow)
  }

  // A piece of its own, for one that moves.
  mesh(parent: Object3D, material: Material | Material[], geometry: BufferGeometry, shadow = true): Mesh {
    if (!Array.isArray(material)) return this.kit.part(parent, geometry, material, 0, 0, 0, shadow)
    const mesh = new Mesh(geometry, material)
    mesh.castShadow = shadow
    mesh.receiveShadow = shadow
    parent.add(mesh)
    return mesh
  }

  surface(color: ColorRepresentation, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    return this.kit.surface(color, params)
  }

  // A surface that glows in its colour, and flares as a spell or a blow gathers and goes off.
  glow(color: string, intensity: number, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    const material = this.kit.surface(color, { roughness: 0.25, emissive: new Color(color), emissiveIntensity: intensity, ...params })
    this.kit.glowing(material, intensity)
    return material
  }

  // Cloth seen from both sides (a robe from below, a hood from within).
  cloth(color: ColorRepresentation, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    return this.kit.surface(color, { roughness: 0.85, side: DoubleSide, ...params })
  }

  onFrame(animate: (frame: DetailFrame) => void): void {
    this.animators.push(animate)
  }

  finish(detail: Omit<Detail, 'animate'>): Detail {
    this.plates.build(this.kit)
    const animators = this.animators
    return { ...detail, animate: (frame) => { for (const animate of animators) animate(frame) } }
  }
}

// ---------------------------------------------------------------------------------------------------------------- painting

const painted = new Map<string, Texture | undefined>()

// A picture painted once on a canvas and kept for every model that asks for it by the same key; nothing where there is no page.
export function paintTexture(key: string, width: number, height: number, paint: (context: CanvasRenderingContext2D, width: number, height: number) => void): Texture | undefined {
  if (painted.has(key)) return painted.get(key)
  if (typeof document === 'undefined') return undefined
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return undefined
  paint(context, width, height)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  painted.set(key, texture)
  return texture
}

// A colour made darker (below 1) or lighter toward white (above 1), as CSS.
export function shade(css: string, amount: number): string {
  const color = new Color(css)
  return (amount <= 1 ? color.multiplyScalar(amount) : color.lerp(new Color('#ffffff'), amount - 1)).getStyle()
}

// A field of cloth: its colour, a fine weave, and darker toward its sides.
export function weave(context: CanvasRenderingContext2D, width: number, height: number, color: string, shadeSides = true): void {
  context.fillStyle = color
  context.fillRect(0, 0, width, height)
  if (shadeSides) {
    const across = context.createLinearGradient(0, 0, width, 0)
    across.addColorStop(0, 'rgba(0,0,0,0.25)')
    across.addColorStop(0.25, 'rgba(0,0,0,0)')
    across.addColorStop(0.75, 'rgba(0,0,0,0)')
    across.addColorStop(1, 'rgba(0,0,0,0.25)')
    context.fillStyle = across
    context.fillRect(0, 0, width, height)
  }
  for (let y = 0; y < height; y += 2) {
    context.fillStyle = `rgba(0,0,0,${y % 4 === 0 ? 0.05 : 0.02})`
    context.fillRect(0, y, width, 1)
  }
  for (let x = 0; x < width; x += 2) {
    context.fillStyle = 'rgba(255,255,255,0.025)'
    context.fillRect(x, 0, 1, height)
  }
}

// A robe's cloth: a field with a band at the hem (the bottom of the picture, where a skirt's profile starts) drawn by `hem`.
export function robeTexture(key: string, color: string, hem: (context: CanvasRenderingContext2D, width: number, height: number) => void): Texture | undefined {
  return paintTexture(key, 512, 256, (context, width, height) => {
    weave(context, width, height, color, false)
    hem(context, width, height)
  })
}

// ---------------------------------------------------------------------------------------------------------------- moving cloth

// A skirt of cloth from a joint down (a robe from the waist, a cloak from the shoulders, a coat's tails): a turned surface, part
// of the way round if it is open at the front, that the legs push out as they swing, that flares and ripples as it walks, and
// whose hem can be ragged. Its picture runs round it, the hem at the bottom.
export class Skirt {
  readonly mesh: Mesh
  private readonly rest: Float32Array
  private readonly angle: Float32Array
  private readonly down: Float32Array
  private readonly geometry: BufferGeometry

  constructor(
    s: Sculpt,
    parent: Object3D,
    material: Material,
    private readonly options: {
      // Where it starts on its joint, how long it is, how wide at the top and at the hem, how deep against wide.
      top: number
      length: number
      neck: number
      hem: number
      depth?: number
      // Open at the front: round from `from` for `span` radians (0 is ahead).
      from?: number
      span?: number
      // A ragged hem: how much longer and shorter its points are, and how many there are round it.
      ragged?: number
      tatters?: number
      // How much the legs push it (1 for a robe from the waist; less for one higher up), and how much it ripples.
      push?: number
      ripple?: number
      seed?: number
      segments?: number
      rows?: number
      shadow?: boolean
    },
  ) {
    const { top, length, neck, hem, depth = 0.88, from = 0, span = Math.PI * 2, segments = 32, rows = 10 } = options
    const profile: Array<[number, number]> = []
    for (let row = 0; row <= rows; row += 1) {
      const k = row / rows
      // Bell-shaped: it falls close and then flares.
      const r = hem + (neck - hem) * smoothstep(0, 1, k) ** 0.8
      profile.push([r, top - length + k * length])
    }
    const geometry = lathe(profile, segments, from, span)
    geometry.scale(s.b, 1, depth * s.b)
    // A ragged hem: each column of the bottom rows lengthened or shortened.
    if (options.ragged) {
      const random = seededRandom(options.seed ?? 7)
      const tatters = options.tatters ?? 14
      const cuts = Array.from({ length: tatters + 1 }, () => random())
      const positions = geometry.getAttribute('position')
      for (let index = 0; index < positions.count; index += 1) {
        const y = positions.getY(index)
        const k = (top - y) / length
        if (k < 0.7) continue
        const turn = Math.atan2(positions.getX(index), positions.getZ(index))
        const u = (((turn - from) / span) % 1 + 1) % 1 * tatters
        const cut = cuts[Math.floor(u)] * (1 - (u % 1)) + cuts[Math.ceil(u) % (tatters + 1)] * (u % 1)
        // Points: deepest in the middle of each tatter.
        const point = 1 - Math.abs((u % 1) - 0.5) * 2
        positions.setY(index, y - options.ragged * (cut * 0.6 + point * 0.6 - 0.4) * smoothstep(0.7, 1, k))
      }
      geometry.computeVertexNormals()
    }
    this.geometry = geometry
    const positions = geometry.getAttribute('position')
    this.rest = (positions.array as Float32Array).slice()
    this.angle = new Float32Array(positions.count)
    this.down = new Float32Array(positions.count)
    for (let index = 0; index < positions.count; index += 1) {
      this.angle[index] = Math.atan2(positions.getX(index), positions.getZ(index) / depth)
      this.down[index] = Math.min(1, Math.max(0, (top - positions.getY(index)) / length))
    }
    this.mesh = s.mesh(parent, material, geometry, options.shadow ?? true)
    geometry.computeBoundingSphere()
    if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.6
  }

  update({ t, walk, phase, hipL, hipR, dead }: DetailFrame): void {
    const push = (this.options.push ?? 1) * (dead ? 0 : 1)
    const ripple = this.options.ripple ?? 1
    const out = this.geometry.getAttribute('position').array as Float32Array
    const sway = Math.sin(phase) * 0.03 * walk
    for (let index = 0, v = 0; index < out.length; index += 3, v += 1) {
      const s = this.down[v]
      const turn = this.angle[v]
      const ahead = Math.cos(turn)
      const across = Math.sin(turn)
      let x = this.rest[index]
      let z = this.rest[index + 2]
      // Out a little as it walks, a ripple running round it.
      const flare = 1 + (0.07 * walk + Math.sin(turn * 5 + t * 2.6 - s * 3) * 0.018 * ripple) * s
      x *= flare
      z *= flare
      // Pushed by each leg: forward where it swings forward, back where it swings back, most on its own side.
      for (const [hip, side] of [[hipL, -1], [hipR, 1]]) {
        const reach = -Math.sin(hip) * 0.55 * s * push
        const facing = reach > 0 ? Math.max(0, ahead) : Math.max(0, -ahead)
        z += reach * facing * (0.3 + 0.7 * Math.max(0, across * side))
      }
      out[index] = x + sway * s
      out[index + 1] = this.rest[index + 1]
      out[index + 2] = z
    }
    this.geometry.getAttribute('position').needsUpdate = true
    this.geometry.computeVertexNormals()
  }
}

// A cape: a sheet of cloth hung from a point on the back, gathered at the top and wrapped round the shoulders, falling past the
// back and bending away behind as it walks. Its materials are a box's: its edges, its inside (toward the body) and its outside.
export class Cape {
  private readonly geometry: BufferGeometry
  private readonly rest: Float32Array
  private trail = 0.1

  constructor(
    s: Sculpt,
    parent: Object3D,
    materials: Material[],
    private readonly options: { width: number; length: number; at: Triple; outset?: number; wrap?: number; still?: number; ragged?: number; seed?: number },
  ) {
    const { width, length } = options
    const geometry = shaped(new BoxGeometry(width, length, 0.016, 14, 22, 1), { at: [0, -length / 2, 0] })
    if (options.ragged) {
      // A ragged bottom edge.
      const random = seededRandom(options.seed ?? 3)
      const cuts = Array.from({ length: 16 }, () => random())
      const positions = geometry.getAttribute('position')
      for (let index = 0; index < positions.count; index += 1) {
        const y = positions.getY(index)
        if (y > -length * 0.75) continue
        const u = (positions.getX(index) / width + 0.5) * 15
        const cut = cuts[Math.round(u)] ?? 0
        const k = (-y - length * 0.75) / (length * 0.25)
        positions.setY(index, y + options.ragged * cut * k)
      }
    }
    this.geometry = geometry
    this.rest = (geometry.getAttribute('position').array as Float32Array).slice()
    const holder = new Group()
    holder.position.set(...options.at)
    parent.add(holder)
    s.mesh(holder, materials, geometry)
    this.drape(0, 0, false)
    geometry.computeBoundingSphere()
    if (geometry.boundingSphere) geometry.boundingSphere.radius *= 2
  }

  update({ t, dt, walk, dead }: DetailFrame): void {
    const still = this.options.still ?? 0.1
    const target = dead ? 0.02 : still + 0.62 * walk + Math.sin(t * 1.7) * 0.03
    this.trail += (target - this.trail) * (1 - Math.exp(-5 * dt))
    this.drape(t, walk, dead)
  }

  private drape(t: number, walk: number, dead: boolean): void {
    const { width, length, outset = 0.06, wrap = 0.12 } = this.options
    const positions = this.geometry.getAttribute('position')
    const out = positions.array as Float32Array
    const trail = Math.max(0.02, this.trail)
    for (let index = 0; index < out.length; index += 3) {
      const x0 = this.rest[index]
      const y0 = this.rest[index + 1]
      const z0 = this.rest[index + 2]
      const s = Math.min(1, Math.max(0, -y0 / length))
      const edge = x0 / (width / 2)
      const x = x0 * (0.8 + 0.2 * smoothstep(0, 0.35, s)) * (1 + 0.12 * s)
      const bend = trail * s
      const y = -length * Math.sin(bend) / trail
      let z = -length * (1 - Math.cos(bend)) / trail - outset * smoothstep(0, 0.16, s)
      z += edge * edge * wrap * (1 - smoothstep(0, 0.3, s))
      z += Math.sin(x0 * 36 + 0.8) * 0.014 * smoothstep(0.05, 0.6, s)
      if (!dead) z += Math.sin(t * 4.3 - s * 5.5 + x0 * 7) * (0.008 + 0.03 * walk) * s
      out[index] = x
      out[index + 1] = y
      out[index + 2] = z + z0
    }
    positions.needsUpdate = true
    this.geometry.computeVertexNormals()
  }
}
