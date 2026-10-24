// One line for each thing that happens to a lobby or its game: who made it, joined, left, what was picked, how a game
// ended. Nothing that happens all the time goes in (polling, chat, orders, pings), so a busy server's log is still
// short enough to read.
//
//   2026-10-24T04:20:11.123Z INFO  player joined lobby=K3M9QX name=Bob players=2/8
//
// Fields are `name=value`. A value that is text from a player (a name, a message) is quoted and escaped whenever it
// has anything in it but plain characters, so it cannot end the line, or pretend to be another field.

export type LogLevel = 'info' | 'warn' | 'error'
export type LogValue = string | number | boolean | undefined
export type LogFields = Record<string, LogValue>
// Where a finished line goes, with its level.
export type LogSink = (level: LogLevel, line: string) => void

// Something anyone can make happen over and over (asking to join a lobby that is not there) is logged once in
// `everyMs`, with how many were left out since the last. The `key` is how such events are counted together, so it has
// to come from the code and not from the player, or the counts would be a way to fill the server's memory.
export type LogLimit = { key: string; everyMs: number }

// What can be written as it is: no space, quote, `=`, or control character.
const PLAIN = /^[\w.:/@#+-]+$/
// What JSON leaves alone and a log should not: other control characters, and the line breaks of Unicode.
const NOT_FOR_A_LOG = /[\u007f-\u009f\u2028\u2029]/g

export function formatValue(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value)
  if (PLAIN.test(value)) return value
  return JSON.stringify(value).replace(NOT_FOR_A_LOG, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function formatLine(at: number, level: LogLevel, message: string, fields: LogFields = {}): string {
  const pairs = Object.entries(fields)
    .flatMap(([name, value]) => value === undefined ? [] : [` ${name}=${formatValue(value)}`])
  return `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${pairs.join('')}`
}

const consoleSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export class Logger {
  private readonly limits = new Map<string, { at: number; left: number }>()

  constructor(
    private readonly sink: LogSink = consoleSink,
    private readonly now: () => number = Date.now,
  ) {}

  info(message: string, fields?: LogFields, limit?: LogLimit): void {
    this.write('info', message, fields, limit)
  }

  warn(message: string, fields?: LogFields, limit?: LogLimit): void {
    this.write('warn', message, fields, limit)
  }

  // `cause` is what was thrown: its stack follows the line.
  error(message: string, fields?: LogFields, cause?: unknown): void {
    const detail = cause instanceof Error ? cause.stack ?? cause.message : cause === undefined ? undefined : String(cause)
    this.write('error', message, fields, undefined, detail)
  }

  private write(level: LogLevel, message: string, fields: LogFields | undefined, limit?: LogLimit, detail?: string): void {
    const at = this.now()
    let shown = fields
    if (limit) {
      const last = this.limits.get(limit.key)
      if (last && at - last.at < limit.everyMs) {
        last.left += 1
        return
      }
      this.limits.set(limit.key, { at, left: 0 })
      if (last && last.left > 0) shown = { ...fields, leftOut: last.left }
    }
    const line = formatLine(at, level, message, shown)
    this.sink(level, detail ? `${line}\n${detail}` : line)
  }
}
