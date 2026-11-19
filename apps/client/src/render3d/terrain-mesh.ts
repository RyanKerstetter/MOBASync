import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  Vector4,
  type Material,
  type Texture,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Rect } from '../../../../packages/shared/src/index.ts'
import { fractalNoise, seededRandom, smoothstep, valueNoise } from './space.ts'
import { dirtTexture, grassTexture, noiseTexture, rockTexture } from './textures.ts'
import type { VisionShading } from './vision-shading.ts'

// What the 3D map is built from: the arena's size, its walls and bushes (the game's own rectangles), and where the map draws
// its paths (the tiles of its path layers, in world units).
export type MapGround = {
  width: number
  height: number
  walls: readonly Rect[]
  bushes: readonly Rect[]
  paths: readonly Rect[]
}

// How tall a wall stands. It is low enough that a champion just behind one is mostly still seen from the camera's angle.
export const WALL_HEIGHT = 88
// How far in from its edge a wall's face rises to its full height: the cliff is a rounded slope over this, not a sheer box.
const WALL_ROUNDING = 38
// How far, at most, the foot of a wall is worn back from the edge of its rectangle, in a wavy line, so a long wall is not a
// ruler-straight edge. It only ever goes in: nothing drawn stands out over ground a champion can walk on.
const WALL_EROSION = 20
// How far past the arena the ground is built, which is further than the camera ever sees past its edge.
const MARGIN = 960
// The height the land outside the built ground is, at its edge and beyond.
const FAR_HEIGHT = 150
// The sizes of grid the ground can be built on, finest first, and the most points it may have.
const GRID_CELLS = [12, 16, 24]
const MAX_GROUND_POINTS = 220_000
// How many squares of the grid a side each piece of the ground is.
const CHUNK_CELLS = 48
// The size of the tiles the trees, boulders, grass and bushes are drawn a tile at a time in (see `instanced`), in world units: a
// few across the screen, so what is off it is not drawn, and not so small that there are many more meshes to draw.
const SCENERY_TILE = 600

// The ground of the map in 3D. It is one mesh, a grid of heights: zero where champions walk, and risen where the walls are
// (and everywhere outside the arena), with the rise worked out from how far into a wall each point is, so where walls meet
// they run together into one mass with rounded corners. Its colour is mixed in its shader from tiling pictures of grass,
// dirt and rock by where it is, how steep it is and whether the map draws a path there; the trees, boulders, tufts of grass
// and bushes on it are instanced meshes.
export class Terrain3D {
  readonly group = new Group()
  private readonly heights: Float32Array
  private readonly cols: number
  private readonly rows: number
  private readonly cell: number
  private readonly x0: number
  private readonly y0: number
  private readonly disposables: Array<{ dispose(): void }> = []

  constructor(ground: MapGround, vision: VisionShading) {
    const { width, height } = ground
    // As fine a grid as keeps the ground to a size the graphics card draws easily (twice a frame, with the shadows). A grid line
    // on every 12 or 24 units keeps the edges of walls (which the maps put on 24s) on the grid; on 16 they are a few units in.
    const points = (cell: number): number => ((width + 2 * MARGIN) / cell + 1) * ((height + 2 * MARGIN) / cell + 1)
    this.cell = GRID_CELLS.find((cell) => points(cell) <= MAX_GROUND_POINTS) ?? GRID_CELLS[GRID_CELLS.length - 1]
    this.x0 = -MARGIN
    this.y0 = -MARGIN
    this.cols = Math.ceil((width + 2 * MARGIN) / this.cell) + 1
    this.rows = Math.ceil((height + 2 * MARGIN) / this.cell) + 1
    const { cols, rows, cell } = this
    const count = cols * rows

    // Which points are in a wall, or outside the arena.
    const solid = new Uint8Array(count)
    for (let j = 0; j < rows; j += 1) {
      const y = this.y0 + j * cell
      for (let i = 0; i < cols; i += 1) {
        const x = this.x0 + i * cell
        if (x <= 0 || y <= 0 || x >= width || y >= height) solid[j * cols + i] = 1
      }
    }
    for (const wall of ground.walls) {
      const i0 = Math.max(0, Math.ceil((wall.x - this.x0) / cell))
      const i1 = Math.min(cols - 1, Math.floor((wall.x + wall.width - this.x0) / cell))
      const j0 = Math.max(0, Math.ceil((wall.y - this.y0) / cell))
      const j1 = Math.min(rows - 1, Math.floor((wall.y + wall.height - this.y0) / cell))
      for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) solid[j * cols + i] = 1
    }
    // How far each point in a wall is from open ground, and each point of open ground from a wall.
    const inside = chamfer(solid, cols, rows, cell, 1)
    const outside = chamfer(solid, cols, rows, cell, 0)
    // How far each point is outside the arena, for the far land.
    const erosion = fractalNoise(7, 3)
    const lumps = fractalNoise(19, 3)
    const hills = fractalNoise(31, 4)
    this.heights = new Float32Array(count)
    for (let j = 0; j < rows; j += 1) {
      const y = this.y0 + j * cell
      for (let i = 0; i < cols; i += 1) {
        const index = j * cols + i
        if (!solid[index]) continue
        const x = this.x0 + i * cell
        const depth = Math.max(0, inside[index] - cell * 0.5)
        const worn = depth - WALL_EROSION * erosion(x / 70, y / 70)
        let h = WALL_HEIGHT * smoothstep(0, WALL_ROUNDING, worn)
        h += (lumps(x / 110, y / 110) - 0.5) * 22 * smoothstep(WALL_ROUNDING * 0.6, WALL_ROUNDING * 2, worn)
        h += 240 * smoothstep(140, 700, depth) * (0.3 + 0.7 * hills(x / 420, y / 420))
        // Out at the edge of what is built, the land settles to one height, which the plain beyond is.
        const beyond = Math.max(-x, -y, x - width, y - height)
        h = h + (FAR_HEIGHT - h) * smoothstep(MARGIN - 260, MARGIN - 40, beyond)
        this.heights[index] = Math.max(0, h)
      }
    }

    const textures = {
      grass: grassTexture(),
      dirt: dirtTexture(),
      rock: rockTexture(),
      noise: noiseTexture(),
    }
    const mask = this.groundMask(ground, solid, outside)
    this.disposables.push(textures.grass, textures.dirt, textures.rock, textures.noise, mask)

    // The ground in square pieces, so what is off the screen (and out of the sun's shadows round it) is not drawn.
    const groundMaterial = vision.shade(splatMaterial(textures, mask, new Vector4(this.x0, this.y0, (cols - 1) * cell, (rows - 1) * cell)))
    this.disposables.push(groundMaterial)
    for (const geometry of this.buildChunks()) {
      const piece = new Mesh(geometry, groundMaterial)
      piece.receiveShadow = true
      piece.castShadow = true
      this.group.add(piece)
      this.disposables.push(geometry)
    }

    // The plain beyond what is built, as far as anything could be seen: a frame round it, at the height its edge settles to.
    const farMaterial = vision.shade(new MeshStandardMaterial({ color: '#2b3a26', roughness: 1 }))
    this.disposables.push(farMaterial)
    const left = this.x0
    const top = this.y0
    const right = this.x0 + (cols - 1) * cell
    const bottom = this.y0 + (rows - 1) * cell
    const far = 20000
    for (const [x0, z0, x1, z1] of [
      [left - far, top - far, right + far, top],
      [left - far, bottom, right + far, bottom + far],
      [left - far, top, left, bottom],
      [right, top, right + far, bottom],
    ]) {
      const geometry = new PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2)
      const plain = new Mesh(geometry, farMaterial)
      plain.position.set((x0 + x1) / 2, FAR_HEIGHT, (z0 + z1) / 2)
      this.group.add(plain)
      this.disposables.push(geometry)
    }

    this.scatter(ground, solid, inside, outside, vision)
  }

  // The height of the ground at a point of the world, smoothed between the points of the grid.
  heightAt(x: number, y: number): number {
    const fx = (x - this.x0) / this.cell
    const fy = (y - this.y0) / this.cell
    const i = Math.min(this.cols - 2, Math.max(0, Math.floor(fx)))
    const j = Math.min(this.rows - 2, Math.max(0, Math.floor(fy)))
    const u = Math.min(1, Math.max(0, fx - i))
    const v = Math.min(1, Math.max(0, fy - j))
    const at = (a: number, b: number): number => this.heights[b * this.cols + a]
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose()
  }

  // The ground as pieces of `CHUNK_CELLS` squares a side, each its own geometry, sharing the points along their edges.
  private buildChunks(): BufferGeometry[] {
    const { cols, rows, cell, heights } = this
    const normals = new Float32Array(cols * rows * 3)
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const index = j * cols + i
        const nx = heights[j * cols + Math.max(0, i - 1)] - heights[j * cols + Math.min(cols - 1, i + 1)]
        const nz = heights[Math.max(0, j - 1) * cols + i] - heights[Math.min(rows - 1, j + 1) * cols + i]
        const ny = 2 * cell
        const length = Math.hypot(nx, ny, nz)
        normals[index * 3] = nx / length
        normals[index * 3 + 1] = ny / length
        normals[index * 3 + 2] = nz / length
      }
    }
    const chunks: BufferGeometry[] = []
    for (let cj = 0; cj < rows - 1; cj += CHUNK_CELLS) {
      for (let ci = 0; ci < cols - 1; ci += CHUNK_CELLS) {
        const i1 = Math.min(cols - 1, ci + CHUNK_CELLS)
        const j1 = Math.min(rows - 1, cj + CHUNK_CELLS)
        const across = i1 - ci + 1
        const down = j1 - cj + 1
        const positions = new Float32Array(across * down * 3)
        const chunkNormals = new Float32Array(across * down * 3)
        for (let j = cj; j <= j1; j += 1) {
          for (let i = ci; i <= i1; i += 1) {
            const local = (j - cj) * across + (i - ci)
            const index = j * cols + i
            positions[local * 3] = this.x0 + i * cell
            positions[local * 3 + 1] = heights[index]
            positions[local * 3 + 2] = this.y0 + j * cell
            chunkNormals.set(normals.subarray(index * 3, index * 3 + 3), local * 3)
          }
        }
        const indices = new Uint32Array((across - 1) * (down - 1) * 6)
        let at = 0
        for (let j = 0; j < down - 1; j += 1) {
          for (let i = 0; i < across - 1; i += 1) {
            const a = j * across + i
            const b = a + 1
            const c = a + across
            const d = c + 1
            // Each square is split along the diagonal that follows the slope, so a rounded edge does not zig-zag.
            if (Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]) < Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1])) {
              indices.set([a, c, d, a, d, b], at)
            } else {
              indices.set([a, c, b, b, c, d], at)
            }
            at += 6
          }
        }
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', new BufferAttribute(positions, 3))
        geometry.setAttribute('normal', new BufferAttribute(chunkNormals, 3))
        geometry.setIndex(new BufferAttribute(indices, 1))
        geometry.computeBoundingSphere()
        geometry.computeBoundingBox()
        chunks.push(geometry)
      }
    }
    return chunks
  }

  // A picture over the whole grid, one texel to a point: red is where the map draws a path (softened), green is how close open
  // ground is to the foot of a wall (for the shade there).
  private groundMask(ground: MapGround, solid: Uint8Array, outside: Float32Array): DataTexture {
    const { cols, rows, cell } = this
    const path = new Float32Array(cols * rows)
    for (const tile of ground.paths) {
      const i0 = Math.max(0, Math.ceil((tile.x - this.x0) / cell))
      const i1 = Math.min(cols - 1, Math.floor((tile.x + tile.width - this.x0) / cell))
      const j0 = Math.max(0, Math.ceil((tile.y - this.y0) / cell))
      const j1 = Math.min(rows - 1, Math.floor((tile.y + tile.height - this.y0) / cell))
      for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) path[j * cols + i] = 1
    }
    const soft = boxBlur(boxBlur(path, cols, rows, 2), cols, rows, 2)
    const data = new Uint8Array(cols * rows * 4)
    for (let index = 0; index < cols * rows; index += 1) {
      data[index * 4] = Math.round(soft[index] * 255)
      data[index * 4 + 1] = solid[index] ? 0 : Math.round(255 * (1 - smoothstep(0, 80, outside[index])))
      data[index * 4 + 3] = 255
    }
    const texture = new DataTexture(data, cols, rows, RGBAFormat, UnsignedByteType)
    texture.magFilter = LinearFilter
    texture.minFilter = LinearFilter
    texture.needsUpdate = true
    return texture
  }

  // Trees on the walls and the land outside, boulders along the foot of the cliffs, tufts of grass on the open ground, and the
  // leaves of each bush.
  private scatter(ground: MapGround, solid: Uint8Array, inside: Float32Array, outside: Float32Array, vision: VisionShading): void {
    const { cols, rows, cell } = this
    // How many times the area a grid point stands for is that of the finest grid, so scenery is as thick on any grid.
    const perPoint = (cell / GRID_CELLS[0]) ** 2
    const random = seededRandom(ground.width * 7 + ground.height * 13 + ground.walls.length)
    const density = valueNoise(97)
    const pathAt = this.pathLookup(ground.paths)
    const matrix = new Matrix4()
    const position = new Vector3()
    const rotation = new Quaternion()
    const scale = new Vector3()
    const up = new Vector3(0, 1, 0)

    type Placed = { x: number; y: number; size: number; kind: number; turn: number }
    const trees: Placed[] = []
    const boulders: Placed[] = []
    const tufts: Placed[] = []
    const shrubs: Placed[] = []
    // Keeps trees apart: one to a square of this size, at most.
    const spacing = 46
    const taken = new Set<string>()
    for (let j = 1; j < rows - 1; j += 1) {
      for (let i = 1; i < cols - 1; i += 1) {
        const index = j * cols + i
        const x = this.x0 + i * cell + (random() - 0.5) * cell
        const y = this.y0 + j * cell + (random() - 0.5) * cell
        if (solid[index]) {
          const depth = inside[index]
          // Deep in a wall: a tree, where the noise says there is a wood (everywhere, far out past the arena) and there is room.
          if (depth > 64 && density(x / 300, y / 300) > (depth > 240 ? 0.08 : 0.3) && random() < 0.5 * perPoint) {
            const key = `${Math.floor(x / spacing)},${Math.floor(y / spacing)}`
            if (!taken.has(key)) {
              taken.add(key)
              const size = Math.min(1.5, 0.75 + depth / 380) * (0.8 + random() * 0.45)
              trees.push({ x, y, size, kind: random() < 0.55 ? 0 : 1, turn: random() * Math.PI * 2 })
            }
          } else if (depth > 34 && depth <= 64 && random() < 0.16 * perPoint) {
            // On the top of a wall too narrow for trees: a shrub.
            shrubs.push({ x, y, size: 0.9 + random() * 0.7, kind: 0, turn: random() * Math.PI * 2 })
          } else if (depth > 6 && depth < 46 && random() < 0.07 * perPoint) {
            // On the face of a cliff: a boulder, half sunk, no bigger than the wall is deep there, so it does not reach out over
            // the ground champions walk on.
            boulders.push({ x, y, size: Math.min(depth + 6, 10 + random() * 22), kind: 0, turn: random() * Math.PI * 2 })
          }
        } else if (outside[index] > 4 && pathAt(x, y) < 0.3) {
          const nearWall = 1 - smoothstep(0, 160, outside[index])
          if (random() < (0.012 + nearWall * 0.08) * perPoint) tufts.push({ x, y, size: 0.7 + random() * 0.8, kind: 0, turn: random() * Math.PI * 2 })
        }
      }
    }

    const tint = new Color()
    // Instanced meshes of `geometry` for each of `placed`, each put where `place` says (it is handed the mesh to set the matrix and
    // colour of the instance on). They are made a tile of the map at a time (`SCENERY_TILE`), so only the tiles in view are drawn,
    // and only those near the champion cast shadows: one mesh for the whole map would draw every tree on it, twice, every frame.
    // They are placed in the order given, so what is drawn is the same however it is cut up.
    const instanced = (
      geometry: BufferGeometry,
      material: Material,
      placed: readonly Placed[],
      place: (item: Placed, index: number, mesh: InstancedMesh) => void,
      shadows = true,
    ): void => {
      if (placed.length === 0) {
        geometry.dispose()
        material.dispose()
        return
      }
      const tileOf = (item: Placed): string => `${Math.floor(item.x / SCENERY_TILE)},${Math.floor(item.y / SCENERY_TILE)}`
      const counts = new Map<string, number>()
      for (const item of placed) counts.set(tileOf(item), (counts.get(tileOf(item)) ?? 0) + 1)
      const tiles = new Map<string, { mesh: InstancedMesh; next: number }>()
      for (const [tile, count] of counts) tiles.set(tile, { mesh: new InstancedMesh(geometry, material, count), next: 0 })
      for (const item of placed) {
        const tile = tiles.get(tileOf(item))!
        place(item, tile.next, tile.mesh)
        tile.next += 1
      }
      for (const { mesh } of tiles.values()) {
        mesh.castShadow = shadows
        mesh.receiveShadow = true
        mesh.instanceMatrix.needsUpdate = true
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
        mesh.computeBoundingSphere()
        this.group.add(mesh)
      }
      this.disposables.push(geometry, material)
    }
    const leafMaterial = (): MeshStandardMaterial => vision.shade(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, flatShading: true }))

    // Trees: a trunk, and a crown of three cones (a pine) or of round clumps (a broadleaf).
    const trunkGeometry = new CylinderGeometry(3.2, 5, 26, 6).translate(0, 13, 0)
    const pineGeometry = mergeGeometries([
      new ConeGeometry(30, 46, 7).translate(0, 40, 0),
      new ConeGeometry(24, 40, 7).translate(0, 62, 0),
      new ConeGeometry(16, 34, 7).translate(0, 82, 0),
    ])
    const leafGeometry = mergeGeometries([
      new IcosahedronGeometry(26, 0).translate(0, 50, 0),
      new IcosahedronGeometry(19, 0).translate(15, 40, 6),
      new IcosahedronGeometry(18, 0).translate(-13, 44, -8),
      new IcosahedronGeometry(16, 0).translate(3, 68, -3),
    ])
    const treeMatrix = (item: Placed): Matrix4 => {
      position.set(item.x, this.heightAt(item.x, item.y) - 2, item.y)
      rotation.setFromAxisAngle(up, item.turn)
      scale.set(item.size, item.size * (0.85 + (item.turn % 0.3)), item.size)
      return matrix.compose(position, rotation, scale)
    }
    instanced(trunkGeometry, vision.shade(new MeshStandardMaterial({ color: '#5a3e2b', roughness: 1 })), trees, (item, index, mesh) => {
      mesh.setMatrixAt(index, treeMatrix(item))
    })
    instanced(pineGeometry, leafMaterial(), trees.filter((tree) => tree.kind === 0), (item, index, mesh) => {
      mesh.setMatrixAt(index, treeMatrix(item))
      mesh.setColorAt(index, tint.setHSL(0.3 + random() * 0.06, 0.45 + random() * 0.15, 0.2 + random() * 0.08))
    })
    instanced(leafGeometry, leafMaterial(), trees.filter((tree) => tree.kind === 1), (item, index, mesh) => {
      mesh.setMatrixAt(index, treeMatrix(item))
      mesh.setColorAt(index, tint.setHSL(0.22 + random() * 0.1, 0.45 + random() * 0.2, 0.24 + random() * 0.1))
    })

    // Boulders: a lumpy stone, turned and squashed differently each time.
    const tilt = new Vector3()
    instanced(jitter(new DodecahedronGeometry(1, 1), 0.18, 5), vision.shade(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.95, flatShading: true })), boulders, (item, index, mesh) => {
      position.set(item.x, this.heightAt(item.x, item.y) - item.size * 0.25, item.y)
      rotation.setFromAxisAngle(tilt.set(random() - 0.5, 1, random() - 0.5).normalize(), item.turn)
      scale.set(item.size * (0.9 + random() * 0.5), item.size * (0.6 + random() * 0.5), item.size * (0.9 + random() * 0.4))
      mesh.setMatrixAt(index, matrix.compose(position, rotation, scale))
      const shade = 0.36 + random() * 0.18
      mesh.setColorAt(index, tint.setRGB(shade, shade * 0.97, shade * 0.92))
    })

    // Tufts of grass: a few thin blades crossed.
    const blade = (turn: number, lean: number): BufferGeometry => {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1.6, 0, 0, 1.6, 0, 0, lean, 12, 0]), 3))
      return geometry.rotateY(turn)
    }
    const tuftGeometry = mergeGeometries([blade(0, 2), blade(1.1, -3), blade(2.2, 1), blade(0.6, -1).scale(0.8, 0.75, 0.8), blade(1.7, 3).scale(0.9, 0.85, 0.9)])
    tuftGeometry.computeVertexNormals()
    instanced(tuftGeometry, vision.shade(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, side: DoubleSide })), tufts, (item, index, mesh) => {
      position.set(item.x, 0, item.y)
      rotation.setFromAxisAngle(up, item.turn)
      scale.set(item.size, item.size, item.size)
      mesh.setMatrixAt(index, matrix.compose(position, rotation, scale))
      mesh.setColorAt(index, tint.setHSL(0.24 + random() * 0.07, 0.5, 0.3 + random() * 0.12))
    }, false)

    // Bushes: their rectangle filled with low clumps of leaves, low enough that a champion's head shows over them. The shrubs
    // on the narrow walls are the same clumps.
    const clumps: Placed[] = [...shrubs]
    for (const bush of ground.bushes) {
      for (let y = bush.y + 12; y <= bush.y + bush.height - 8; y += 22) {
        for (let x = bush.x + 12; x <= bush.x + bush.width - 8; x += 22) {
          clumps.push({ x: x + (random() - 0.5) * 10, y: y + (random() - 0.5) * 10, size: 0.8 + random() * 0.45, kind: 0, turn: random() * Math.PI * 2 })
        }
      }
    }
    const clumpGeometry = mergeGeometries([
      new IcosahedronGeometry(16, 0).translate(0, 16, 0),
      new IcosahedronGeometry(11, 0).translate(9, 12, 5),
      new IcosahedronGeometry(10, 0).translate(-8, 13, -4),
    ])
    instanced(clumpGeometry, leafMaterial(), clumps, (item, index, mesh) => {
      position.set(item.x, this.heightAt(item.x, item.y) - 3, item.y)
      rotation.setFromAxisAngle(up, item.turn)
      scale.set(item.size, item.size * 0.95, item.size)
      mesh.setMatrixAt(index, matrix.compose(position, rotation, scale))
      mesh.setColorAt(index, tint.setHSL(0.31 + random() * 0.05, 0.55, 0.22 + random() * 0.08))
    })
  }

  // How much a point is on a path, from 0 to 1, near enough for placing scenery.
  private pathLookup(paths: readonly Rect[]): (x: number, y: number) => number {
    const size = 48
    const cells = new Set<string>()
    for (const tile of paths) {
      for (let y = tile.y; y < tile.y + tile.height; y += size) {
        for (let x = tile.x; x < tile.x + tile.width; x += size) cells.add(`${Math.floor(x / size)},${Math.floor(y / size)}`)
      }
    }
    return (x, y) => {
      let near = 0
      for (const [dx, dy] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]]) {
        if (cells.has(`${Math.floor((x + dx) / size)},${Math.floor((y + dy) / size)}`)) near += 0.2
      }
      return near
    }
  }
}

// The ground's material: lit as any surface, with its colour mixed in the shader from the detail pictures.
function splatMaterial(
  textures: { grass: Texture; dirt: Texture; rock: Texture; noise: Texture },
  mask: Texture,
  maskRect: Vector4,
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: '#ffffff', roughness: 0.94, metalness: 0 })
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      tGrass: { value: textures.grass },
      tDirt: { value: textures.dirt },
      tRock: { value: textures.rock },
      tNoise: { value: textures.noise },
      tMask: { value: mask },
      uMaskRect: { value: maskRect },
    })
    shader.vertexShader = 'varying vec3 vGroundWorld;\nvarying vec3 vGroundNormal;\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vGroundNormal = normalize(mat3(modelMatrix) * objectNormal);`,
    )
    shader.fragmentShader = `varying vec3 vGroundWorld;
      varying vec3 vGroundNormal;
      uniform sampler2D tGrass;
      uniform sampler2D tDirt;
      uniform sampler2D tRock;
      uniform sampler2D tNoise;
      uniform sampler2D tMask;
      uniform vec4 uMaskRect;
      ` + shader.fragmentShader.replace(
      '#include <map_fragment>',
      `{
        vec3 wp = vGroundWorld;
        vec4 mask = texture2D(tMask, (wp.xz - uMaskRect.xy) / uMaskRect.zw);
        vec3 nrm = normalize(vGroundNormal);
        vec4 broad = texture2D(tNoise, wp.xz / 2100.0);
        vec4 near = texture2D(tNoise, wp.xz / 260.0);
        vec3 grass = mix(texture2D(tGrass, wp.xz / 230.0).rgb, texture2D(tGrass, wp.xz / 540.0 + vec2(0.31, 0.77)).rgb, 0.4);
        grass *= mix(0.8, 1.14, broad.r);
        grass = mix(grass, grass * vec3(1.16, 1.03, 0.7), smoothstep(0.55, 0.8, broad.g) * 0.75);
        vec3 dirt = texture2D(tDirt, wp.xz / 250.0).rgb * mix(0.86, 1.1, near.g);
        float path = smoothstep(0.36, 0.62, mask.r + (near.r - 0.5) * 0.5);
        vec3 ground = mix(grass, dirt, path);
        ground *= 1.0 - 0.14 * (1.0 - abs(path * 2.0 - 1.0));
        vec3 blend = pow(abs(nrm), vec3(4.0));
        blend /= dot(blend, vec3(1.0));
        vec3 rock = texture2D(tRock, wp.zy / 200.0).rgb * blend.x + texture2D(tRock, wp.xz / 200.0).rgb * blend.y + texture2D(tRock, wp.xy / 200.0).rgb * blend.z;
        float steep = smoothstep(0.35, 0.7, 1.0 - nrm.y);
        float raised = smoothstep(3.0, 24.0, wp.y);
        vec3 top = mix(grass * vec3(0.72, 0.82, 0.62), rock, 0.18 + 0.3 * near.b);
        vec3 col = mix(ground, top, raised);
        col = mix(col, rock * vec3(0.9, 0.88, 0.84), steep);
        col *= 1.0 - 0.42 * mask.g;
        col *= mix(1.0, 0.82, smoothstep(90.0, 320.0, wp.y));
        diffuseColor.rgb *= col;
      }`,
    )
  }
  material.customProgramCacheKey = () => 'moba-ground-splat'
  return material
}

// How far each point is from the nearest point of the other kind (in world units): from open ground, for a point where
// `solid` is `seed`... that is, with `seed` 1, how deep each solid point is; with 0, how far each open point is from a solid one.
function chamfer(solid: Uint8Array, cols: number, rows: number, cell: number, seed: 0 | 1): Float32Array {
  const far = 1e9
  const distance = new Float32Array(cols * rows)
  for (let index = 0; index < distance.length; index += 1) distance[index] = solid[index] === seed ? far : 0
  const straight = cell
  const diagonal = cell * Math.SQRT2
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const index = j * cols + i
      let best = distance[index]
      if (best === 0) continue
      if (i > 0) best = Math.min(best, distance[index - 1] + straight)
      if (j > 0) {
        best = Math.min(best, distance[index - cols] + straight)
        if (i > 0) best = Math.min(best, distance[index - cols - 1] + diagonal)
        if (i < cols - 1) best = Math.min(best, distance[index - cols + 1] + diagonal)
      }
      distance[index] = best
    }
  }
  for (let j = rows - 1; j >= 0; j -= 1) {
    for (let i = cols - 1; i >= 0; i -= 1) {
      const index = j * cols + i
      let best = distance[index]
      if (best === 0) continue
      if (i < cols - 1) best = Math.min(best, distance[index + 1] + straight)
      if (j < rows - 1) {
        best = Math.min(best, distance[index + cols] + straight)
        if (i < cols - 1) best = Math.min(best, distance[index + cols + 1] + diagonal)
        if (i > 0) best = Math.min(best, distance[index + cols - 1] + diagonal)
      }
      distance[index] = best
    }
  }
  return distance
}

// A box blur of `radius` cells, across and then down.
function boxBlur(values: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  const across = new Float32Array(values.length)
  const out = new Float32Array(values.length)
  const span = radius * 2 + 1
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      let sum = 0
      for (let k = -radius; k <= radius; k += 1) sum += values[j * cols + Math.min(cols - 1, Math.max(0, i + k))]
      across[j * cols + i] = sum / span
    }
  }
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      let sum = 0
      for (let k = -radius; k <= radius; k += 1) sum += across[Math.min(rows - 1, Math.max(0, j + k)) * cols + i]
      out[j * cols + i] = sum / span
    }
  }
  return out
}

// Pushes each corner of a shape in or out a little at random, so it is a lump and not a perfect solid. Corners shared by
// faces move together.
export function jitter(geometry: BufferGeometry, amount: number, seed: number): BufferGeometry {
  const random = seededRandom(seed)
  const positions = geometry.getAttribute('position')
  const moved = new Map<string, number>()
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index)
    const y = positions.getY(index)
    const z = positions.getZ(index)
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`
    let factor = moved.get(key)
    if (factor === undefined) {
      factor = 1 + (random() - 0.5) * 2 * amount
      moved.set(key, factor)
    }
    positions.setXYZ(index, x * factor, y * factor, z * factor)
  }
  geometry.computeVertexNormals()
  return geometry
}
