import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Color,
} from 'three'

// One puff, spark, ember or drop, as it is let go.
export type ParticleSpec = {
  x: number
  y: number
  z: number
  vx?: number
  vy?: number
  vz?: number
  // How long it lives, in seconds.
  life: number
  // Its size in world units as it starts, and as it ends (the same if not given).
  size: number
  sizeEnd?: number
  // Its colour as it starts, and as it ends (the same if not given).
  color: Color
  colorEnd?: Color
  // How strongly it shows as it starts; it fades to nothing by the end of its life.
  alpha?: number
  // Added to its upward speed each second (negative falls).
  gravity?: number
  // How much of its speed it loses each second, from 0 to 1.
  drag?: number
  // For a while from the start it grows in, as a share of its life, so it does not pop into being.
  fadeIn?: number
}

// Particles drawn as round, soft points that keep their size in the world, many at once, cheaply: a fixed pool, the oldest
// given up when a new one needs room. One system blends by adding light (fire, sparks, magic), the other as ordinary paint
// (smoke, water, dust); the world renderer has one of each. The living ones are kept together at the front of the pool, so each
// frame only they are moved, sent to the graphics card and drawn, however big the pool is.
export class ParticleSystem {
  readonly points: Points
  private readonly geometry = new BufferGeometry()
  private readonly material: ShaderMaterial
  private readonly capacity: number
  // What share of the particles let go are made (fewer, on Low quality), and how much bigger each is, so an effect still reads.
  private readonly keep: number
  private readonly grow: number
  // How many are alive (the first this many slots), and, once the pool is full, the slot the next one takes.
  private live = 0
  private next = 0
  // What each particle is, a slot each.
  private readonly position: Float32Array
  private readonly velocity: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly sizes: Float32Array
  private readonly colours: Float32Array
  private readonly physics: Float32Array
  private readonly alphaStart: Float32Array
  // What is uploaded for drawing.
  private readonly drawPosition: Float32Array
  private readonly drawColour: Float32Array
  private readonly drawSize: Float32Array

  constructor(capacity: number, blending: 'add' | 'normal', options: { keep?: number; grow?: number } = {}) {
    this.capacity = capacity
    this.keep = options.keep ?? 1
    this.grow = options.grow ?? 1
    this.position = new Float32Array(capacity * 3)
    this.velocity = new Float32Array(capacity * 3)
    this.age = new Float32Array(capacity).fill(1)
    this.life = new Float32Array(capacity).fill(1)
    this.sizes = new Float32Array(capacity * 2)
    this.colours = new Float32Array(capacity * 6)
    this.physics = new Float32Array(capacity * 3)
    this.alphaStart = new Float32Array(capacity)
    this.drawPosition = new Float32Array(capacity * 3)
    this.drawColour = new Float32Array(capacity * 4)
    this.drawSize = new Float32Array(capacity)
    this.geometry.setAttribute('position', new BufferAttribute(this.drawPosition, 3))
    this.geometry.setAttribute('color', new BufferAttribute(this.drawColour, 4))
    this.geometry.setAttribute('size', new BufferAttribute(this.drawSize, 1))
    this.material = new ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: `
        attribute float size;
        attribute vec4 color;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = color;
          vec4 view = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * view;
          gl_PointSize = size * uScale / max(1.0, -view.z);
        }`,
      fragmentShader: blending === 'add'
        ? `varying vec4 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float glow = pow(max(0.0, 1.0 - d), 1.6);
            if (glow <= 0.0) discard;
            gl_FragColor = vec4(vColor.rgb * glow * vColor.a, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`
        : `varying vec4 vColor;
          void main() {
            float d = length(gl_PointCoord - 0.5) * 2.0;
            float body = smoothstep(1.0, 0.55, d);
            if (body <= 0.0) discard;
            gl_FragColor = vec4(vColor.rgb, vColor.a * body);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      transparent: true,
      depthWrite: false,
      blending: blending === 'add' ? AdditiveBlending : NormalBlending,
    })
    this.points = new Points(this.geometry, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder = blending === 'add' ? 20 : 19
  }

  // How big a point of one world unit is drawn, which depends on the screen and the camera (see `ParticleSystem.setScale`).
  setScale(pixelsPerUnitAtOne: number): void {
    this.material.uniforms.uScale.value = pixelsPerUnitAtOne
  }

  emit(spec: ParticleSpec): void {
    if (this.keep < 1 && Math.random() > this.keep) return
    let slot: number
    if (this.live < this.capacity) {
      slot = this.live
      this.live += 1
    } else {
      slot = this.next
      this.next = (this.next + 1) % this.capacity
    }
    this.position.set([spec.x, spec.y, spec.z], slot * 3)
    this.velocity.set([spec.vx ?? 0, spec.vy ?? 0, spec.vz ?? 0], slot * 3)
    this.age[slot] = 0
    this.life[slot] = Math.max(0.01, spec.life)
    this.sizes[slot * 2] = spec.size * this.grow
    this.sizes[slot * 2 + 1] = (spec.sizeEnd ?? spec.size) * this.grow
    const end = spec.colorEnd ?? spec.color
    this.colours.set([spec.color.r, spec.color.g, spec.color.b, end.r, end.g, end.b], slot * 6)
    this.physics.set([spec.gravity ?? 0, spec.drag ?? 0, spec.fadeIn ?? 0.08], slot * 3)
    this.alphaStart[slot] = spec.alpha ?? 1
  }

  // How many are alive.
  get count(): number {
    return this.live
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.1)
    for (let slot = 0; slot < this.live;) {
      const life = this.life[slot]
      const age = this.age[slot] + step
      if (age >= life) {
        // Its life is over: the last living one takes its slot, and is moved on from there.
        this.live -= 1
        this.move(this.live, slot)
        continue
      }
      this.age[slot] = age
      const p = slot * 3
      const gravity = this.physics[p]
      const keep = Math.max(0, 1 - this.physics[p + 1] * step)
      this.velocity[p] *= keep
      this.velocity[p + 1] = this.velocity[p + 1] * keep + gravity * step
      this.velocity[p + 2] *= keep
      this.position[p] += this.velocity[p] * step
      this.position[p + 1] += this.velocity[p + 1] * step
      this.position[p + 2] += this.velocity[p + 2] * step
      const t = Math.min(1, age / life)
      const fadeIn = this.physics[p + 2]
      const grow = fadeIn > 0 ? Math.min(1, t / fadeIn) : 1
      this.drawPosition[p] = this.position[p]
      this.drawPosition[p + 1] = this.position[p + 1]
      this.drawPosition[p + 2] = this.position[p + 2]
      const c = slot * 6
      const q = slot * 4
      this.drawColour[q] = this.colours[c] + (this.colours[c + 3] - this.colours[c]) * t
      this.drawColour[q + 1] = this.colours[c + 1] + (this.colours[c + 4] - this.colours[c + 1]) * t
      this.drawColour[q + 2] = this.colours[c + 2] + (this.colours[c + 5] - this.colours[c + 2]) * t
      this.drawColour[q + 3] = this.alphaStart[slot] * (1 - t) * grow
      this.drawSize[slot] = (this.sizes[slot * 2] + (this.sizes[slot * 2 + 1] - this.sizes[slot * 2]) * t) * (0.4 + 0.6 * grow)
      slot += 1
    }
    if (this.next >= this.live) this.next = 0
    // Only the living are drawn, and only they are sent.
    this.geometry.setDrawRange(0, this.live)
    this.points.visible = this.live > 0
    if (this.live === 0) return
    for (const name of ['position', 'color', 'size']) {
      const attribute = this.geometry.getAttribute(name) as BufferAttribute
      attribute.clearUpdateRanges()
      attribute.addUpdateRange(0, this.live * attribute.itemSize)
      attribute.needsUpdate = true
    }
  }

  // Moves what is in one slot to another (whose particle is gone).
  private move(from: number, to: number): void {
    if (from === to) return
    const copy = (array: Float32Array, size: number): void => {
      array.copyWithin(to * size, from * size, from * size + size)
    }
    copy(this.position, 3)
    copy(this.velocity, 3)
    copy(this.age, 1)
    copy(this.life, 1)
    copy(this.sizes, 2)
    copy(this.colours, 6)
    copy(this.physics, 3)
    copy(this.alphaStart, 1)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
