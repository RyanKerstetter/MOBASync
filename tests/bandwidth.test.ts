import assert from 'node:assert/strict'
import test from 'node:test'
import { BandwidthMeter, formatBandwidthReport } from '../apps/server/src/bandwidth.ts'

test('a plain message counts as its size, to each player it goes to', () => {
  const meter = new BandwidthMeter()
  meter.record('game:order', 200, undefined, 8)
  meter.record('game:order', 200, undefined, 8)

  const report = meter.flush(1000)
  assert.ok(report)
  assert.equal(report.bytesPerSecond, 200 * 2 * 8)
  assert.deepEqual(report.events, [{ event: 'game:order', bytesPerSecond: 3200, messagesPerSecond: 16, copies: 1 }])
})

test('a reliable message counts as many times as Geckos sends it, 10 unless it says otherwise, and its wrapper', () => {
  const meter = new BandwidthMeter()
  meter.record('game:snapshot', 6000, { reliable: true }, 2)
  meter.record('game:resync', 100, { reliable: true, runs: 3 })

  const report = meter.flush(1000)
  assert.ok(report)
  const byEvent = Object.fromEntries(report.events.map((entry) => [entry.event, entry]))
  assert.equal(byEvent['game:snapshot'].bytesPerSecond, (6000 + 40) * 10 * 2)
  assert.equal(byEvent['game:snapshot'].copies, 10)
  assert.equal(byEvent['game:resync'].bytesPerSecond, (100 + 40) * 3)
})

test('the report is a rate over the time given, busiest first, and counting starts again after it', () => {
  const meter = new BandwidthMeter()
  meter.record('small', 100)
  meter.record('big', 10_000)

  const report = meter.flush(2000)
  assert.ok(report)
  assert.equal(report.seconds, 2)
  assert.deepEqual(report.events.map((entry) => [entry.event, entry.bytesPerSecond]), [['big', 5000], ['small', 50]])
  assert.equal(report.bytesPerSecond, 5050)
  assert.equal(meter.flush(1000), undefined, 'and nothing sent since is no report')
})

test('the logged line names the total and each kind of message with how often it is sent', () => {
  const meter = new BandwidthMeter()
  meter.record('game:snapshot', 80_000, { reliable: true }, 8)
  meter.record('game:order', 150, undefined, 8)
  const report = meter.flush(5000)
  assert.ok(report)

  const line = formatBandwidthReport(report)
  assert.match(line, /^Bandwidth out, last 5 s: /)
  assert.match(line, /MB\/s total/)
  assert.match(line, /game:snapshot [\d.]+ [KM]B\/s \(1\.6\/s, x10\)/)
  assert.match(line, /game:order [\d.]+ KB\/s \(1\.6\/s\)/)
  assert.ok(line.indexOf('game:snapshot') < line.indexOf('game:order'), 'busiest first')
})
