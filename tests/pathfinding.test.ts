import assert from 'node:assert/strict'
import test from 'node:test'
import { createVisibilityGraph, Terrain, type PathfinderFactory } from '../packages/shared/src/index.ts'
import { pathfinderContract } from './pathfinder-contract.ts'

pathfinderContract('the visibility graph', createVisibilityGraph)

test('a terrain asks the pathfinder it was built with, and only when there are walls to go round', () => {
  const asked: Array<{ radius: number }> = []
  const factory: PathfinderFactory = () => ({
    path: (_from, to, radius) => {
      asked.push({ radius })
      return [{ x: to.x + 1, y: to.y }]
    },
  })
  const open = new Terrain({ width: 500, height: 500 }, [], factory)
  assert.deepEqual(open.path({ x: 1, y: 1 }, { x: 9, y: 9 }, 20), [{ x: 9, y: 9 }])
  assert.equal(asked.length, 0, 'no walls, no need to ask')

  const walled = new Terrain({ width: 500, height: 500 }, [{ x: 200, y: 200, width: 50, height: 50 }], factory)
  assert.deepEqual(walled.path({ x: 1, y: 1 }, { x: 9, y: 9 }, 20), [{ x: 10, y: 9 }], 'what the pathfinder says is what it gets')
  assert.deepEqual(asked, [{ radius: 20 }])
})

test('a terrain made from data gets the pathfinder it is told to', () => {
  const data = new Terrain({ width: 500, height: 500 }, [{ x: 200, y: 200, width: 50, height: 50 }]).toData()
  let built = 0
  const factory: PathfinderFactory = () => {
    built += 1
    return { path: () => [] }
  }
  const terrain = Terrain.fromData(data, factory)
  assert.equal(built, 1)
  assert.deepEqual(terrain.path({ x: 0, y: 0 }, { x: 1, y: 1 }, 10), [])
})

test('the same question asked again and again gets the same answer, and a fatter body keeps further from the corners', () => {
  const terrain = new Terrain({ width: 1000, height: 600 }, [{ x: 400, y: 200, width: 200, height: 200 }])
  const first = terrain.path({ x: 100, y: 300 }, { x: 900, y: 300 }, 20)
  for (let ask = 0; ask < 50; ask += 1) assert.deepEqual(terrain.path({ x: 100, y: 300 }, { x: 900, y: 300 }, 20), first)
  const fat = terrain.path({ x: 100, y: 300 }, { x: 900, y: 300 }, 40)
  assert.ok(first && fat)
  // The way round goes the width of the body out from the pillar's edge, which is 100 from the middle.
  assert.ok(Math.abs(fat[0].y - 300) > Math.abs(first[0].y - 300))
})

test('walls in any order make the same terrain, the same way', () => {
  const walls = [
    { x: 400, y: 200, width: 200, height: 200 },
    { x: 100, y: 50, width: 80, height: 80 },
    { x: 700, y: 400, width: 60, height: 120 },
  ]
  const forwards = new Terrain({ width: 1000, height: 600 }, walls)
  const backwards = new Terrain({ width: 1000, height: 600 }, [...walls].reverse())
  assert.deepEqual(forwards.toData(), backwards.toData())
  for (const [from, to] of [[{ x: 20, y: 20 }, { x: 900, y: 500 }], [{ x: 500, y: 50 }, { x: 650, y: 550 }]] as const) {
    assert.deepEqual(forwards.path(from, to, 20), backwards.path(from, to, 20))
  }
})
