import {
  AdditiveBlending,
  BackSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
  type BufferGeometry,
  type ColorRepresentation,
  type Material,
  type MeshStandardMaterialParameters,
  type Object3D,
} from 'three'
import type { ParticleSystem } from '../particles.ts'
import type { VisionShading } from '../vision-shading.ts'

// What a model is told each frame about the character it is, for its animation.
export type PoseInput = {
  // A clock in seconds, and the seconds since the last frame.
  t: number
  dt: number
  moving: boolean
  // How fast it is walking, in world units a second.
  speed: number
  // An attack or a cast winding up, and how far through (to 1, when it goes off).
  action?: { kind: 'attack' | 'cast'; progress: number }
  // The moment after one went off, from 0 to 1: the swing coming through, the staff thrust out, and back to rest.
  release?: { kind: 'attack' | 'cast'; t: number }
  dead: boolean
  // Seconds since it was seen to die.
  deadFor: number
  stunned: boolean
}

// What a model can make its effects with.
export type FxContext = {
  glow: ParticleSystem
  puff: ParticleSystem
}

// How thick the edge round an enemy is, in the units a model is built in (about one world unit, once scaled).
const OUTLINE_WIDTH = 0.022

// How long the moment after an attack or a cast goes off lasts, in seconds.
export const RELEASE_SECONDS = 0.32

// A character in 3D: a group of shapes the world renderer stands on the ground where the character is and turns to face the way
// it is going, and poses each frame. Its own parts are its business. Every material it makes is shaded for what the team cannot
// see, and is its own, so it can be made faint (an invisible champion seen by its team) without touching anyone else.
export abstract class Model {
  // Stood where the character is, and turned to face its way (its +Z is ahead).
  readonly root = new Group()
  // How high the top of it is, in world units, which the name and bars go over.
  abstract readonly height: number
  // Whether the world renderer turns it to face the way it goes (a tower does not turn).
  readonly turns: boolean = true
  private readonly owned: Material[] = []
  private opacity = 1
  // The edge drawn round an enemy: a copy of each solid part, pushed out along its surface and drawn from inside, in one colour.
  private outline: { material: MeshBasicMaterial; meshes: Mesh[] } | undefined

  constructor(protected readonly vision: VisionShading) {}

  abstract pose(input: PoseInput): void

  // The moment an attack or a cast goes off: a model with something to show then (a slam's dust) shows it.
  release(_kind: 'attack' | 'cast', _fx: FxContext): void {}

  // Each frame, after the pose: what the model gives off all the time (a tower's motes, the spray of a fountain).
  ambient(_fx: FxContext, _dt: number): void {}

  // Where a point of the model is in the world.
  worldPoint(local: Object3D, offset = new Vector3()): Vector3 {
    return local.localToWorld(offset.clone())
  }

  // Makes it faint (invisible to enemies, seen by its own team), or solid again.
  setOpacity(alpha: number): void {
    if (alpha === this.opacity) return
    this.opacity = alpha
    for (const material of this.owned) {
      const base = (material.userData.baseOpacity as number | undefined) ?? 1
      const wasTransparent = material.transparent
      material.transparent = alpha < 1 || base < 1 || material.userData.glow === true
      material.opacity = base * alpha
      if (wasTransparent !== material.transparent) material.needsUpdate = true
    }
  }

  // Draws a thin edge round the model in a colour (an enemy's red), or takes it away. Only the solid parts get one: not glows, nor what
  // is see-through. Made the first time it is asked for.
  setOutline(on: boolean, css = '#e5352b'): void {
    if (!on) {
      if (this.outline) for (const mesh of this.outline.meshes) mesh.visible = false
      return
    }
    if (!this.outline) {
      const material = new MeshBasicMaterial({ color: css, side: BackSide })
      // Pushed out along the surface by a set amount, so the edge is as thick on a small part as on a big one.
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed += normalize(normal) * ${OUTLINE_WIDTH.toFixed(4)};`)
      }
      material.customProgramCacheKey = () => 'model-outline'
      const meshes: Mesh[] = []
      const solid: Mesh[] = []
      this.root.traverse((object) => {
        if (!(object instanceof Mesh)) return
        // A part can be painted with one material or one per side (a cape's); it is solid only if all of them are.
        const paints: Material[] = Array.isArray(object.material) ? object.material : [object.material]
        // (A see-through part that is the body itself, such as a slime's, says so with `userData.outline`.)
        if (paints.some((paint) => (paint.transparent && paint.userData.outline !== true) || paint.userData.glow === true)) return
        solid.push(object)
      })
      for (const part of solid) {
        const edge = new Mesh(part.geometry, material)
        edge.castShadow = false
        edge.receiveShadow = false
        part.add(edge)
        meshes.push(edge)
      }
      this.outline = { material, meshes }
    }
    this.outline.material.color.set(css)
    for (const mesh of this.outline.meshes) mesh.visible = true
  }

  dispose(): void {
    const outlined = new Set(this.outline?.meshes)
    this.root.traverse((object) => {
      if (object instanceof Mesh && !outlined.has(object)) (object.geometry as BufferGeometry).dispose()
    })
    for (const material of this.owned) material.dispose()
    this.outline?.material.dispose()
  }

  // A lit surface of this model.
  protected surface(color: ColorRepresentation, params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
    const material = this.vision.shade(new MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, ...params }))
    material.userData.baseOpacity = params.opacity ?? 1
    this.owned.push(material)
    return material
  }

  // A glow: light added over what is behind it, unlit.
  protected glow(color: ColorRepresentation, opacity = 0.5): MeshBasicMaterial {
    const material = this.vision.shade(new MeshBasicMaterial({ color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false }), 'glow')
    material.userData.baseOpacity = opacity
    material.userData.glow = true
    this.owned.push(material)
    return material
  }

  // A mesh of this model that casts and takes shadows, added to `parent`, at a place.
  protected part(parent: Object3D, geometry: BufferGeometry, material: Material, x = 0, y = 0, z = 0, shadow = true): Mesh {
    const mesh = new Mesh(geometry, material)
    mesh.position.set(x, y, z)
    mesh.castShadow = shadow
    mesh.receiveShadow = shadow
    parent.add(mesh)
    return mesh
  }
}

// A smooth ease from 0 to 1.
export function ease(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

// Out quickly, then settling.
export function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return 1 - (1 - c) ** 3
}

// A weight that follows its target at `rate` a second, so poses blend and do not snap.
export function approach(current: number, target: number, rate: number, dt: number): number {
  const step = 1 - Math.exp(-rate * dt)
  return current + (target - current) * step
}

// A group that pivots at a joint, at a place in its parent.
export function joint(parent: Object3D, x = 0, y = 0, z = 0): Group {
  const group = new Group()
  group.position.set(x, y, z)
  parent.add(group)
  return group
}
