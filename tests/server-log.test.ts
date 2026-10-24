import assert from 'node:assert/strict'
import test from 'node:test'
import { formatLine, formatValue, Logger, type LogLevel } from '../apps/server/src/log.ts'

const AT = Date.UTC(2026, 9, 24, 4, 20, 11, 123)

function recorded(): { lines: Array<[LogLevel, string]>; log: Logger; clock: { now: number } } {
  const lines: Array<[LogLevel, string]> = []
  const clock = { now: AT }
  return { lines, clock, log: new Logger((level, line) => lines.push([level, line]), () => clock.now) }
}

test('a line is the time, the level, what happened, and its fields in the order given', () => {
  assert.equal(
    formatLine(AT, 'info', 'player joined', { lobby: 'K3M9QX', name: 'Bob', players: '2/8' }),
    '2026-10-24T04:20:11.123Z INFO  player joined lobby=K3M9QX name=Bob players=2/8',
  )
  assert.equal(formatLine(AT, 'warn', 'join rejected'), '2026-10-24T04:20:11.123Z WARN  join rejected')
  assert.match(formatLine(AT, 'error', 'it broke'), / ERROR it broke$/)
})

test('numbers and booleans are written as they are, and a field with nothing in it is left out', () => {
  assert.equal(
    formatLine(AT, 'info', 'game finished', { seconds: 125, rejoin: false, winner: undefined, map: 'ffa_arena' }),
    '2026-10-24T04:20:11.123Z INFO  game finished seconds=125 rejoin=false map=ffa_arena',
  )
})

test('text with anything in it but plain characters is quoted, so it is one value', () => {
  assert.equal(formatValue('Bob'), 'Bob')
  assert.equal(formatValue('K3M9QX'), 'K3M9QX')
  assert.equal(formatValue('2/8'), '2/8')
  assert.equal(formatValue('Bob Smith'), '"Bob Smith"')
  assert.equal(formatValue(''), '""', 'an empty name is still a value')
  assert.equal(formatValue('a=b'), '"a=b"')
  assert.equal(formatValue('say "hi"'), '"say \\"hi\\""')
  assert.equal(formatValue('Red 25, Blue 12'), '"Red 25, Blue 12"')
})

test('a player cannot end the line or add fields to it with what they type', () => {
  const forged = 'Mallory\n2026-10-24T04:20:12.000Z INFO  game finished winner=Mallory'
  const line = formatLine(AT, 'info', 'player joined', { lobby: 'K3M9QX', name: forged })
  assert.equal(line.includes('\n'), false, 'one line')
  assert.equal(line.split(' name=').length, 2)
  assert.ok(line.endsWith('name="Mallory\\n2026-10-24T04:20:12.000Z INFO  game finished winner=Mallory"'))

  const escapes = formatLine(AT, 'info', 'player joined', { name: '\u001b[31mred\u0085\u2028\u2029\u007f\r\t' })
  assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(escapes.slice(escapes.indexOf(' name='))), false, 'no control character is left')
  assert.ok(escapes.includes('\\u001b[31mred\\u0085\\u2028\\u2029\\u007f\\r\\t'))
})

test('the logger writes each level to the sink with its time', () => {
  const { log, lines, clock } = recorded()
  log.info('lobby created', { lobby: 'K3M9QX', leader: 'Alice' })
  clock.now += 1500
  log.warn('join rejected', { reason: 'Lobby is full.' })
  clock.now += 1500
  log.error('lobby request failed', { path: '/api/lobbies' })

  assert.deepEqual(lines, [
    ['info', '2026-10-24T04:20:11.123Z INFO  lobby created lobby=K3M9QX leader=Alice'],
    ['warn', '2026-10-24T04:20:12.623Z WARN  join rejected reason="Lobby is full."'],
    ['error', '2026-10-24T04:20:14.123Z ERROR lobby request failed path=/api/lobbies'],
  ])
})

test('an error logged with what was thrown is followed by its stack', () => {
  const { log, lines } = recorded()
  const cause = new Error('boom')
  log.error('lobby request failed', { path: '/x' }, cause)
  log.error('not an error', undefined, 'just text')

  const [first, second] = lines.map(([, line]) => line.split('\n'))
  assert.equal(first[0], '2026-10-24T04:20:11.123Z ERROR lobby request failed path=/x')
  assert.equal(first[1], cause.stack?.split('\n')[0])
  assert.ok(first.length > 2, 'the stack is there')
  assert.deepEqual(second.slice(1), ['just text'])
})

test('something anyone can set off is logged once in a while, with how many were left out', () => {
  const { log, lines, clock } = recorded()
  const limit = { key: 'join-rejected:not-found', everyMs: 10_000 }
  const attempt = (code: string): void => log.warn('join rejected', { lobby: code }, limit)

  attempt('AAAAAA')
  for (const code of ['BBBBBB', 'CCCCCC', 'DDDDDD']) {
    clock.now += 1000
    attempt(code)
  }
  assert.equal(lines.length, 1, 'the first is logged, and the next three, inside ten seconds, are not')
  assert.match(lines[0][1], /lobby=AAAAAA$/)

  clock.now += 10_000
  attempt('EEEEEE')
  assert.equal(lines.length, 2)
  assert.match(lines[1][1], /lobby=EEEEEE leftOut=3$/, 'and it says that three were left out')

  clock.now += 10_000
  attempt('FFFFFF')
  assert.equal(lines.length, 3)
  assert.doesNotMatch(lines[2][1], /leftOut/, 'nothing was left out since')
})

test('events with another key, or none, are not held back by a limited one', () => {
  const { log, lines } = recorded()
  const spam = { key: 'join-rejected:not-found', everyMs: 60_000 }
  log.warn('join rejected', { lobby: 'AAAAAA' }, spam)
  log.warn('join rejected', { lobby: 'BBBBBB' }, spam)
  log.warn('join rejected', { lobby: 'CCCCCC' }, { key: 'join-rejected:full', everyMs: 60_000 })
  log.info('lobby created')
  log.info('lobby created')

  assert.deepEqual(lines.map(([, line]) => line.replace(/^\S+ /, '')), [
    'WARN  join rejected lobby=AAAAAA',
    'WARN  join rejected lobby=CCCCCC',
    'INFO  lobby created',
    'INFO  lobby created',
  ])
})
