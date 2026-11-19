import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  type Color,
} from 'three'
import { colour } from './space.ts'
import type { VisionShading } from './vision-shading.ts'

type Point = { x: number; y: number }

// Shapes painted flat on the ground, drawn again from nothing each frame, much as the 2D layers draw with Pixi's Graphics:
// rings, discs, bands, boxes and wedges, each in a colour and a strength. Everything given between `begin` and `end` is one
// mesh. The ground where champions walk is flat, so the shapes lie just over it.
export class DecalBatch {
  readonly mesh: Mesh
  private readonly geometry = new BufferGeometry()
  private positions: Float32Array
  private colours: Float32Array
  private count = 0
  private readonly height: number

  constructor(vision: VisionShading, options: { blending?: 'normal' | 'add'; height?: number; renderOrder?: number } = {}) {
    this.height = options.height ?? 0.8
    this.positions = new Float32Array(3 * 3000)
    this.colours = new Float32Array(4 * 3000)
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage))
    this.geometry.setAttribute('color', new BufferAttribute(this.colours, 4).setUsage(DynamicDrawUsage))
    const additive = options.blending === 'add'
    const material = vision.shade(new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      blending: additive ? AdditiveBlending : NormalBlending,
    }), additive ? 'glow' : 'surface')
    this.mesh = new Mesh(this.geometry, material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = options.renderOrder ?? 2
  }

  begin(): void {
    this.count = 0
  }

  end(): void {
    const geometry = this.geometry
    ;(geometry.attributes.position as BufferAttribute).needsUpdate = true
    ;(geometry.attributes.color as BufferAttribute).needsUpdate = true
    geometry.setDrawRange(0, this.count)
    this.mesh.visible = this.count > 0
  }

  // A filled circle.
  disc(x: number, y: number, radius: number, css: string, alpha: number): this {
    return this.ring(x, y, 0, radius, css, alpha)
  }

  // The band between two circles (an annulus); `inner` 0 is a disc.
  ring(x: number, y: number, inner: number, outer: number, css: string, alpha: number, from = 0, to = Math.PI * 2): this {
    if (alpha <= 0 || outer <= 0) return this
    const segments = Math.max(12, Math.min(96, Math.ceil(outer / 4 * Math.abs(to - from) / Math.PI)))
    const c = colour(css)
    for (let index = 0; index < segments; index += 1) {
      const a0 = from + (to - from) * index / segments
      const a1 = from + (to - from) * (index + 1) / segments
      const p0 = { x: x + Math.cos(a0) * outer, y: y + Math.sin(a0) * outer }
      const p1 = { x: x + Math.cos(a1) * outer, y: y + Math.sin(a1) * outer }
      if (inner <= 0) {
        this.triangle({ x, y }, p1, p0, c, alpha)
      } else {
        const q0 = { x: x + Math.cos(a0) * inner, y: y + Math.sin(a0) * inner }
        const q1 = { x: x + Math.cos(a1) * inner, y: y + Math.sin(a1) * inner }
        this.triangle(q0, p1, p0, c, alpha)
        this.triangle(q0, q1, p1, c, alpha)
      }
    }
    return this
  }

  // A filled circle that fades out over the outer `soft` share of its radius, with no hard edge.
  softDisc(x: number, y: number, radius: number, css: string, alpha: number, soft = 0.45): this {
    if (alpha <= 0 || radius <= 0) return this
    const inner = radius * (1 - soft)
    this.disc(x, y, inner, css, alpha)
    const c = colour(css)
    const segments = Math.max(24, Math.min(96, Math.ceil(radius / 4)))
    for (let index = 0; index < segments; index += 1) {
      const a0 = Math.PI * 2 * index / segments
      const a1 = Math.PI * 2 * (index + 1) / segments
      const q0 = { x: x + Math.cos(a0) * inner, y: y + Math.sin(a0) * inner }
      const q1 = { x: x + Math.cos(a1) * inner, y: y + Math.sin(a1) * inner }
      const p0 = { x: x + Math.cos(a0) * radius, y: y + Math.sin(a0) * radius }
      const p1 = { x: x + Math.cos(a1) * radius, y: y + Math.sin(a1) * radius }
      this.triangle(q0, p1, p0, c, alpha, 0, 0)
      this.triangle(q0, q1, p1, c, alpha, alpha, 0)
    }
    return this
  }

  // A circle's edge, `width` across, centred on the radius.
  circle(x: number, y: number, radius: number, width: number, css: string, alpha: number): this {
    return this.ring(x, y, Math.max(0, radius - width / 2), radius + width / 2, css, alpha)
  }

  // An ellipse, filled (inner 0) or as an edge between the two sizes.
  ellipse(x: number, y: number, rx: number, ry: number, css: string, alpha: number, edge = 0): this {
    if (alpha <= 0) return this
    const c = colour(css)
    const segments = 64
    for (let index = 0; index < segments; index += 1) {
      const a0 = Math.PI * 2 * index / segments
      const a1 = Math.PI * 2 * (index + 1) / segments
      const p0 = { x: x + Math.cos(a0) * (rx + edge / 2), y: y + Math.sin(a0) * (ry + edge / 2) }
      const p1 = { x: x + Math.cos(a1) * (rx + edge / 2), y: y + Math.sin(a1) * (ry + edge / 2) }
      if (edge <= 0) {
        this.triangle({ x, y }, p1, p0, c, alpha)
      } else {
        const q0 = { x: x + Math.cos(a0) * (rx - edge / 2), y: y + Math.sin(a0) * (ry - edge / 2) }
        const q1 = { x: x + Math.cos(a1) * (rx - edge / 2), y: y + Math.sin(a1) * (ry - edge / 2) }
        this.triangle(q0, p1, p0, c, alpha)
        this.triangle(q0, q1, p1, c, alpha)
      }
    }
    return this
  }

  // A straight band from one point to another, `width` across.
  line(from: Point, to: Point, width: number, css: string, alpha: number): this {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy)
    if (length === 0 || alpha <= 0) return this
    const nx = -dy / length * width / 2
    const ny = dx / length * width / 2
    return this.quad(
      { x: from.x + nx, y: from.y + ny },
      { x: to.x + nx, y: to.y + ny },
      { x: to.x - nx, y: to.y - ny },
      { x: from.x - nx, y: from.y - ny },
      css,
      alpha,
    )
  }

  // A filled rectangle, square to the world.
  rect(x: number, y: number, width: number, height: number, css: string, alpha: number): this {
    return this.quad({ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, css, alpha)
  }

  // A rectangle's edge, `width` across, inside it.
  rectEdge(x: number, y: number, w: number, h: number, width: number, css: string, alpha: number): this {
    return this
      .rect(x, y, w, width, css, alpha)
      .rect(x, y + h - width, w, width, css, alpha)
      .rect(x, y + width, width, h - 2 * width, css, alpha)
      .rect(x + w - width, y + width, width, h - 2 * width, css, alpha)
  }

  // A box centred on a point, `halfLength` along `facing` (a unit vector) and `halfWidth` across it.
  box(center: Point, facing: Point, halfLength: number, halfWidth: number, css: string, alpha: number): this {
    const ax = facing.x * halfLength
    const ay = facing.y * halfLength
    const bx = -facing.y * halfWidth
    const by = facing.x * halfWidth
    return this.quad(
      { x: center.x - ax - bx, y: center.y - ay - by },
      { x: center.x + ax - bx, y: center.y + ay - by },
      { x: center.x + ax + bx, y: center.y + ay + by },
      { x: center.x - ax + bx, y: center.y - ay + by },
      css,
      alpha,
    )
  }

  // A filled wedge of a circle, from the middle out, between two angles.
  wedge(x: number, y: number, radius: number, from: number, to: number, css: string, alpha: number): this {
    return this.ring(x, y, 0, radius, css, alpha, from, to)
  }

  quad(a: Point, b: Point, c: Point, d: Point, css: string, alpha: number): this {
    if (alpha <= 0) return this
    const col = colour(css)
    this.triangle(a, b, c, col, alpha)
    this.triangle(a, c, d, col, alpha)
    return this
  }

  // A triangle in one colour, at `alpha`, or at a strength of its own at each corner.
  private triangle(a: Point, b: Point, c: Point, col: Color, alpha: number, alphaB = alpha, alphaC = alpha): void {
    if (this.count + 3 > this.positions.length / 3) this.grow()
    const alphas = [alpha, alphaB, alphaC]
    for (const [corner, point] of [a, b, c].entries()) {
      const at = this.count
      this.positions[at * 3] = point.x
      this.positions[at * 3 + 1] = this.height
      this.positions[at * 3 + 2] = point.y
      this.colours[at * 4] = col.r
      this.colours[at * 4 + 1] = col.g
      this.colours[at * 4 + 2] = col.b
      this.colours[at * 4 + 3] = alphas[corner]
      this.count += 1
    }
  }

  private grow(): void {
    const positions = new Float32Array(this.positions.length * 2)
    positions.set(this.positions)
    const colours = new Float32Array(this.colours.length * 2)
    colours.set(this.colours)
    this.positions = positions
    this.colours = colours
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage))
    this.geometry.setAttribute('color', new BufferAttribute(this.colours, 4).setUsage(DynamicDrawUsage))
  }

  dispose(): void {
    this.geometry.dispose()
    ;(this.mesh.material as MeshBasicMaterial).dispose()
  }
}
