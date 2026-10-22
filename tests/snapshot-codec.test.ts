import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSnapshot } from '../apps/client/src/snapshot-codec.ts'
import { ServerGameState } from '../apps/server/src/game-state.ts'
import { encodeSnapshot } from '../apps/server/src/snapshot-codec.ts'
import { GameSnapshotSchema } from '../packages/shared/src/index.ts'
import { brawler } from './fixtures.ts'

function runningGame(playerCount: number): ServerGameState {
  const players = Array.from({ length: playerCount }, (_, index) => ({ id: `${'a'.repeat(31)}${index}`, name: `Player ${index + 1}` }))
  const game = new ServerGameState()
  game.beginSelection(players)
  for (const player of players) {
    game.pickChampion(player.id, brawler.id)
    game.lockChampion(player.id)
  }
  game.begin(players)
  // Everyone gives some orders, as they would in a few seconds of play.
  for (const [index, player] of players.entries()) {
    for (let seq = 1; seq <= 6; seq += 1) {
      game.acceptOrder(player.id, {
        id: `${index + 1}:${seq}`,
        seq,
        tick: seq,
        type: 'move',
        target: { x: 100 + seq * 37.123456789, y: 200 + index * 91.987654321 },
      })
    }
  }
  for (let tick = 0; tick < 30; tick += 1) game.advanceTick()
  return game
}

test('a gzipped snapshot decodes to exactly what the server had', async () => {
  const snapshot = runningGame(4).snapshot()

  const decoded = await decodeSnapshot(encodeSnapshot(snapshot))

  assert.deepEqual(decoded, JSON.parse(JSON.stringify(snapshot)))
  assert.ok(GameSnapshotSchema.safeParse(decoded).success, 'and it is still a valid snapshot')
})

test('the client can read it however the data channel hands the bytes over', async () => {
  const snapshot = runningGame(2).snapshot()
  const bytes = encodeSnapshot(snapshot)
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  assert.deepEqual(await decodeSnapshot(arrayBuffer), await decodeSnapshot(bytes))
})

test('gzip makes a full lobby\'s snapshot less than a third of its JSON, small enough to avoid being split up', () => {
  const snapshot = runningGame(8).snapshot()

  const json = Buffer.byteLength(JSON.stringify(snapshot))
  const gzipped = encodeSnapshot(snapshot).byteLength

  assert.ok(gzipped * 3 < json, `${gzipped} bytes gzipped against ${json} as JSON`)
  assert.equal(encodeSnapshot(snapshot)[0], 0x1f, 'it starts with the gzip marker')
  assert.equal(encodeSnapshot(snapshot)[1], 0x8b)
})

test('something that is not gzip is refused rather than read as a snapshot', async () => {
  await assert.rejects(decodeSnapshot(Buffer.from('{"not":"gzip"}')))
})
