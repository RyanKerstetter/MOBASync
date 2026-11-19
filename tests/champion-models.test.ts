import assert from 'node:assert/strict'
import test from 'node:test'
import { guarded } from '../apps/client/src/guard.ts'
import { DETAILS } from '../apps/client/src/render3d/models/detail/index.ts'
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

for (const [id, look] of Object.entries(CHAMPION_LOOKS)) {
  test(`${id}'s model can be built, posed every way, outlined, faded, empowered and taken away`, () => {
    const champion = champions.get(id)
    assert.ok(champion, `${id} is a champion`)
    const told = errorsWhile(() => {
      // Built as it is, not through `championFigure`, which would build the plain figure in place of a detailed one that fails.
      const model = new HumanoidModel(new VisionShading(), champion.radius, look, id)
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
