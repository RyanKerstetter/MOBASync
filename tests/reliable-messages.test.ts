import assert from 'node:assert/strict'
import test from 'node:test'
import { ReliableMessenger, type IdentifiedMessage } from '../packages/shared/src/index.js'

class TestChannel {
  readonly handlers = new Map<string, (data: unknown) => void>()
  readonly emitted: Array<{ event: string; data: unknown }> = []

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data })
  }

  on(event: string, callback: (data: unknown) => void): void {
    this.handlers.set(event, callback)
  }
}

test('reliable messenger forwards the acknowledgement it consumes', () => {
  const channel = new TestChannel()
  const acknowledged: IdentifiedMessage[] = []
  const messenger = new ReliableMessenger<IdentifiedMessage, IdentifiedMessage>({
    channel,
    messageEvent: 'order',
    acknowledgementEvent: 'order-ack',
    timeoutMs: 1000,
    parseAcknowledgement: (data) => {
      if (
        typeof data !== 'object'
        || data === null
        || !('id' in data)
        || !('seq' in data)
        || typeof data.id !== 'string'
        || typeof data.seq !== 'number'
      ) return undefined
      return { id: data.id, seq: data.seq }
    },
    onAcknowledgement: (ack) => acknowledged.push(ack),
  })
  const message = { id: 'player-1:1', seq: 1 }

  messenger.send(message)
  channel.handlers.get('order-ack')?.(message)

  assert.deepEqual(acknowledged, [message])
  assert.equal(messenger.size, 0)
  messenger.close()
})
