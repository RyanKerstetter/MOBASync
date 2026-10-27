import assert from 'node:assert/strict'
import test from 'node:test'
import type { Rect, SightViewer, VisionFactory, VisionGround, VisionView } from '../packages/shared/src/index.ts'

// What every vision system must do, whichever way it works (see `VisionSystem`). Run it against a new one with
// `visionContract('name', factory, { blocksSight })` and it must pass as it is: `blocksSight` is whether walls are part of
// what it works out, and says whether the tests of that are run. The points in these are clear of any edge by more than a
// system on a grid of a few units would be off, so one that is exact and one that rounds both pass.

const ARENA = { width: 1000, height: 600 }
const PILLAR: Rect = { x: 400, y: 200, width: 200, height: 200 }
const RANGE = 200

const ground = (walls: readonly Rect[] = []): VisionGround => ({ ...ARENA, walls })
const viewer = (x: number, y: number, range = RANGE): SightViewer => ({ position: { x, y }, range })
const sees = (view: VisionView, x: number, y: number): boolean => view.canSee({ x, y })
const around = (x: number, y: number, distance: number): Array<[number, number]> =>
  Array.from({ length: 8 }, (_, index) => [x + Math.cos(index * Math.PI / 4) * distance, y + Math.sin(index * Math.PI / 4) * distance])

export function visionContract(name: string, factory: VisionFactory, options: { blocksSight: boolean }): void {
  test(`${name}: a viewer sees its own place and what is well within its range, and not what is well beyond it`, () => {
    const view = factory(ground()).see([viewer(500, 300)])
    assert.ok(sees(view, 500, 300), 'where it stands')
    for (const [x, y] of around(500, 300, 100)) assert.ok(sees(view, x, y), `(${x.toFixed(0)}, ${y.toFixed(0)}) is 100 away`)
    for (const [x, y] of around(500, 300, 260)) assert.ok(!sees(view, x, y), `(${x.toFixed(0)}, ${y.toFixed(0)}) is 260 away`)
  })

  test(`${name}: a bigger range sees further, and each viewer has its own`, () => {
    const system = factory(ground())
    assert.ok(!sees(system.see([viewer(500, 300, 100)]), 500 + 150, 300))
    assert.ok(sees(system.see([viewer(500, 300, 300)]), 500 + 150, 300))
    const both = system.see([viewer(150, 300, 100), viewer(800, 300, 300)])
    assert.ok(!sees(both, 150 + 150, 300), 'the short one does not reach')
    assert.ok(sees(both, 800 - 250, 300), 'and the long one does')
  })

  test(`${name}: viewers see together: a point is seen if any of them sees it, and no viewers see nothing`, () => {
    const system = factory(ground())
    const view = system.see([viewer(150, 300), viewer(850, 300)])
    assert.ok(sees(view, 150, 300) && sees(view, 250, 300), 'the first one\'s')
    assert.ok(sees(view, 850, 300) && sees(view, 750, 300), 'the second one\'s')
    assert.ok(!sees(view, 500, 300), 'but not the middle, which neither reaches')
    const none = system.see([])
    for (const [x, y] of [[500, 300], [150, 300], [10, 10]]) assert.ok(!sees(none, x, y), 'nothing without a viewer')
  })

  test(`${name}: nothing outside the ground is seen, and a viewer by the edge or off it is no trouble`, () => {
    const system = factory(ground())
    const view = system.see([viewer(30, 30)])
    assert.ok(sees(view, 30, 30) && sees(view, 100, 100))
    for (const [x, y] of [[-10, 30], [30, -10], [-100, -100], [ARENA.width + 10, 30], [30, ARENA.height + 10]]) {
      assert.ok(!sees(view, x, y), `(${x}, ${y}) is not in the arena`)
    }
    const off = system.see([viewer(-50, 300), viewer(ARENA.width + 50, 300), viewer(Number.NaN, 5)])
    assert.ok(!sees(off, -50, 300) && !sees(off, ARENA.width + 50, 300), 'a viewer that is off the ground does not see what is not')
  })

  test(`${name}: the mask is a grid over the whole ground, and says what the view does`, () => {
    const view = factory(ground()).see([viewer(300, 200), viewer(700, 400)])
    const { mask } = view
    assert.equal(mask.kind, 'cells')
    assert.equal(mask.data.length, mask.cols * mask.rows)
    assert.ok(mask.cols * mask.cell >= ARENA.width && mask.rows * mask.cell >= ARENA.height, 'it covers the arena')
    assert.ok(mask.cols * mask.cell < ARENA.width + mask.cell && mask.rows * mask.cell < ARENA.height + mask.cell, 'and not a whole cell more')
    let seen = 0
    for (let row = 0; row < mask.rows; row += 1) {
      for (let col = 0; col < mask.cols; col += 1) {
        const point = { x: (col + 0.5) * mask.cell, y: (row + 0.5) * mask.cell }
        if (point.x >= ARENA.width || point.y >= ARENA.height) continue
        const cell = mask.data[row * mask.cols + col]
        assert.ok(cell === 0 || cell === 1, 'a cell is 0 or 1')
        assert.equal(cell === 1, view.canSee(point), `cell ${col}, ${row} says what canSee does at its middle`)
        seen += cell
      }
    }
    assert.ok(seen > 0, 'something is seen')
  })

  test(`${name}: a mask with the same revision is the same mask, and the same viewers give the same answer`, () => {
    const system = factory(ground([PILLAR]))
    const looks = [[viewer(300, 300)], [viewer(300, 300), viewer(800, 100)], [viewer(300, 300)], [viewer(100, 500)], [], [viewer(300, 300), viewer(800, 100)]]
    const byRevision = new Map<number, Uint8Array>()
    const answers: string[] = []
    for (const viewers of looks) {
      const { mask } = system.see(viewers)
      const earlier = byRevision.get(mask.revision)
      if (earlier) assert.deepEqual(mask.data, earlier, `revision ${mask.revision} shows the same cells every time it is seen`)
      byRevision.set(mask.revision, Uint8Array.from(mask.data))
      answers.push(Array.from(mask.data).join(''))
    }
    assert.equal(answers[0], answers[2], 'the same viewers, the same cells, after others in between')
    assert.equal(answers[1], answers[5])
    assert.notEqual(answers[0], answers[1])
    assert.notEqual(answers[0], answers[3], 'and a viewer who is somewhere else sees somewhere else')
    assert.ok(answers[4].split('').every((cell) => cell === '0'), 'nobody sees nothing')
    // Another system of the same kind, built the same, agrees: nothing in it is random or from a clock.
    const other = factory(ground([PILLAR])).see(looks[1]).mask
    assert.deepEqual(other.data, system.see(looks[1]).mask.data)
  })

  test(`${name}: it can be asked a great many times without being given anything new`, () => {
    const system = factory(ground([PILLAR]))
    const viewers = [viewer(300, 300), viewer(800, 100)]
    const first = system.see(viewers)
    const revision = first.mask.revision
    for (let index = 0; index < 50; index += 1) system.see(viewers)
    assert.equal(first.mask.revision, revision, 'the same viewers are the same picture, so the page has nothing to upload')
  })

  if (!options.blocksSight) {
    test(`${name}: walls do not block it, so it sees all of its range`, () => {
      const view = factory(ground([PILLAR])).see([viewer(300, 300, 500)])
      assert.ok(sees(view, 700, 300), 'behind the pillar, which does nothing')
    })
    return
  }

  test(`${name}: a wall hides what is behind it, and not what is beside it or in front`, () => {
    const view = factory(ground([PILLAR])).see([viewer(300, 300, 500)])
    assert.ok(sees(view, 380, 300), 'in front of the wall')
    assert.ok(sees(view, 450, 80), 'past its corner, in the open')
    assert.ok(sees(view, 450, 520), 'past the other corner')
    // All of these are within 500 of the viewer, so it is the pillar that hides them and not the range.
    for (const [x, y] of [[700, 300], [780, 300], [700, 220], [700, 250], [700, 500], [650, 340]]) {
      assert.ok(!sees(view, x, y), `(${x}, ${y}) is behind the pillar`)
    }
  })

  test(`${name}: the shadow of a wall widens behind it, and is gone round the other side`, () => {
    const view = factory(ground([PILLAR])).see([viewer(100, 300, 1000)])
    // From 300 away the pillar's near corners are on lines with a slope of a third, so its shadow is 2/3 as wide as the
    // distance from the viewer: from y 100 to 500 at x 700, and from y 33 to 567 at x 900.
    assert.ok(!sees(view, 650, 300) && !sees(view, 700, 300))
    assert.ok(!sees(view, 700, 130) && !sees(view, 700, 470), 'inside the shadow at 700')
    assert.ok(sees(view, 700, 60) && sees(view, 700, 540), 'and outside it')
    assert.ok(!sees(view, 900, 60) && !sees(view, 900, 540), 'the same heights are inside it further back')
    assert.ok(sees(view, 900, 15) && sees(view, 900, 585), 'and still some of the arena that is not')
  })

  test(`${name}: even a thin wall blocks all the way across, with no gaps in it`, () => {
    const thin: Rect = { x: 500, y: 0, width: 30, height: ARENA.height }
    const view = factory(ground([thin])).see([viewer(400, 300, 500)])
    assert.ok(sees(view, 480, 300), 'up to it')
    for (let y = 20; y < ARENA.height; y += 40) assert.ok(!sees(view, 700, y), `(700, ${y}) is behind it`)
  })

  test(`${name}: walls that touch hide what is behind both, with no way through where they meet`, () => {
    // The viewer looks straight along the line where the two meet.
    const upper: Rect = { x: 500, y: 0, width: 40, height: 300 }
    const lower: Rect = { x: 500, y: 300, width: 40, height: 300 }
    const view = factory(ground([upper, lower])).see([viewer(300, 300, 500)])
    for (let y = 50; y < ARENA.height; y += 50) assert.ok(!sees(view, 750, y), `(750, ${y}) is behind the two`)
  })

  test(`${name}: viewers together see what each sees: one is neither blinded by another's wall nor shown through it`, () => {
    const system = factory(ground([PILLAR]))
    const east = viewer(800, 300, 500)
    const west = viewer(300, 300, 500)
    assert.ok(!sees(system.see([east]), 320, 300), 'the east one cannot see the west side of the pillar')
    assert.ok(!sees(system.see([west]), 700, 300), 'nor the west one the east side')
    const both = system.see([west, east])
    assert.ok(sees(both, 320, 300) && sees(both, 700, 300), 'both together see both sides')
  })

  test(`${name}: a viewer a little inside a wall (a dash can leave one there) sees what is just outside it`, () => {
    const view = factory(ground([PILLAR])).see([viewer(420, 300, 300)])
    assert.equal(view.mask.data.length, view.mask.cols * view.mask.rows)
    assert.ok(sees(view, 370, 300) && sees(view, 300, 300), 'the ground beside the wall')
    assert.ok(!sees(view, 700, 300), 'and not through it')
  })
}
