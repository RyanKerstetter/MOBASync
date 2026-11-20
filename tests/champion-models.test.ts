import assert from 'node:assert/strict'
import test from 'node:test'
import { guarded } from '../apps/client/src/guard.ts'
import { DETAILS } from '../apps/client/src/render3d/models/detail/index.ts'
import { GRAPHICS_PRESET_NAMES, GRAPHICS_PRESETS } from '../apps/client/src/render/graphics-quality.ts'
import { cutFor } from '../apps/client/src/render3d/models/detail/shapes.ts'
import { championFigure, HumanoidModel } from '../apps/client/src/render3d/models/humanoid.ts'
import { CHAMPION_LOOKS } from '../apps/client/src/render3d/models/looks.ts'
import type { PoseInput } from '../apps/client/src/render3d/models/model.ts'
import { VisionShading } from '../apps/client/src/render3d/vision-shading.ts'
import { champions } from '../packages/shared/src/index.ts'

// What the game does to a champion's model over a match: every way it is posed, the edge it has as an enemy, faint while invisible,
// an empowered blow, the points effects come from, and taken away at the end.
const STILL: PoseInput = { t: 0, dt: 1 / 60, moving: false, speed: 0, dead: false, deadFor: 0, stunned: false }
const POSES: PoseInput[] = [
  STILL,
  { ...STILL, moving: true, speed: 300 },
  { ...STILL, action: { kind: 'attack', progress: 0.5 } },
  { ...STILL, release: { kind: 'attack', t: 0.3 } },
  { ...STILL, action: { kind: 'cast', progress: 0.9 } },
  { ...STILL, release: { kind: 'cast', t: 0.6 } },
  { ...STILL, stunned: true },
  { ...STILL, dead: true, deadFor: 2 },
]

// Anything the model does wrong is told in the console and passed over in a game (see guard.ts), so here what is told is a failure.
function errorsWhile(run: () => void): unknown[] {
  const told: unknown[] = []
  const error = console.error
  console.error = (...args: unknown[]) => {
    told.push(args)
  }
  try {
    run()
  } finally {
    console.error = error
  }
  return told
}

// With each preset's graphics: cut and lit as the preset says (see graphics-quality.ts), as it is built in a game.
for (const [id, look] of Object.entries(CHAMPION_LOOKS)) for (const preset of GRAPHICS_PRESET_NAMES) {
  test(`${id}'s model can be built, posed every way, outlined, faded, empowered and taken away, on the ${preset} preset`, () => {
    const champion = champions.get(id)
    assert.ok(champion, `${id} is a champion`)
    const told = errorsWhile(() => {
      // Built as it is, not through `championFigure`, which would build the plain figure in place of a detailed one that fails.
      const graphics = GRAPHICS_PRESETS[preset]
      const model = cutFor(graphics.models, () => new HumanoidModel(new VisionShading(graphics), champion.radius, look, id))
      POSES.forEach((pose, frame) => model.pose({ ...pose, t: frame / 10 }))
      model.setOutline(true)
      model.setOutline(false)
      model.setOutline(true, '#3a8bff')
      model.setOpacity(0.3)
      model.setOpacity(1)
      model.setEmpower(1, '#ffffff')
      model.pose({ ...STILL, t: 1 })
      for (const point of [model.focus(), model.handPoint('left'), model.handPoint('right'), ...model.strikePoints()]) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z), `${id}: a point effects come from is somewhere`)
      }
      model.dispose()
    })
    assert.deepEqual(told, [], `${id}: nothing went wrong`)
  })
}

test('a champion whose detailed model cannot be built is drawn as the plain figure, and it is told', () => {
  const [id, look] = Object.entries(CHAMPION_LOOKS).find(([, candidate]) => candidate.detail !== undefined) ?? []
  assert.ok(id && look?.detail, 'some champion has a detailed model')
  const champion = champions.get(id)
  assert.ok(champion)
  const builder = DETAILS[look.detail]
  const details = DETAILS as Record<string, unknown>
  details[look.detail] = () => {
    throw new Error('broken')
  }
  try {
    let model: HumanoidModel | undefined
    const told = errorsWhile(() => {
      model = championFigure(new VisionShading(), champion.radius, look, id)
      model.pose(STILL)
    })
    assert.ok(model instanceof HumanoidModel)
    assert.equal(told.length, 1)
    model.dispose()
  } finally {
    details[look.detail] = builder
  }
})

test('what goes wrong in a guarded step is told once, however often it goes wrong, and the steps after it still run', () => {
  let after = 0
  const told = errorsWhile(() => {
    for (let frame = 0; frame < 5; frame += 1) {
      guarded('A test step', () => {
        throw new Error('broken')
      })
      after += 1
    }
  })
  assert.equal(after, 5)
  assert.equal(told.length, 1)
})

// ---------------------------------------------------------------------------- how much is drawn

// Triangles and meshes of a model, as drawn.
function cost(model: { root: { traverseVisible(visit: (object: unknown) => void): void } }): { triangles: number; meshes: number } {
  let triangles = 0
  let meshes = 0
  model.root.traverseVisible((object) => {
    const mesh = object as { isMesh?: boolean; geometry?: { index: { count: number } | null; getAttribute(name: string): { count: number } } }
    if (!mesh.isMesh || !mesh.geometry) return
    meshes += 1
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3
  })
  return { triangles, meshes }
}

// (Every champion built in detail: one with no detailed build is the plain figure, cut the same on every preset.)
const DETAILED = Object.entries(CHAMPION_LOOKS).filter(([, look]) => look.detail !== undefined)

test('each preset down from High draws every champion built in detail with fewer triangles, and in no more meshes', () => {
  for (const [id, look] of DETAILED) {
    const champion = champions.get(id)
    assert.ok(champion)
    const built = (['high', 'medium', 'low'] as const).map((preset) => championFigure(new VisionShading(GRAPHICS_PRESETS[preset]), champion.radius, look, id))
    const [high, medium, low] = built.map(cost)
    assert.ok(medium.triangles < high.triangles, `${id}: ${medium.triangles} triangles on Medium, ${high.triangles} on High`)
    assert.ok(low.triangles < medium.triangles, `${id}: ${low.triangles} triangles on Low, ${medium.triangles} on Medium`)
    assert.ok(medium.meshes <= high.meshes && low.meshes <= medium.meshes, `${id}: ${low.meshes}, ${medium.meshes} and ${high.meshes} meshes`)
    for (const model of built) model.dispose()
  }
})

test("a champion's still pieces are drawn bent by its joints, not a mesh to each joint: far fewer meshes than joints with pieces on them", () => {
  for (const [id, look] of DETAILED) {
    const champion = champions.get(id)
    assert.ok(champion)
    const model = championFigure(new VisionShading(), champion.radius, look, id)
    let skinned = 0
    const bones = new Set<unknown>()
    model.root.traverse((object) => {
      const mesh = object as { isSkinnedMesh?: boolean; skeleton?: { bones: unknown[] } }
      if (!mesh.isSkinnedMesh || !mesh.skeleton) return
      skinned += 1
      for (const bone of mesh.skeleton.bones) bones.add(bone)
    })
    assert.ok(skinned > 0, `${id} has skinned meshes`)
    assert.ok(skinned < bones.size, `${id}: ${skinned} skinned meshes over ${bones.size} joints`)
    model.dispose()
  }
})
