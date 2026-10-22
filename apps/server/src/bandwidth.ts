// Counts what the server sends, by what kind of message, so it can be seen where the bandwidth goes.
// It counts what goes on the wire, not just what is handed to Geckos: a message sent with Geckos'
// `reliable` option is sent `runs` times (10 unless said), and a message to a room goes to every player
// in it.

export type SendOptions = { reliable?: boolean; runs?: number }

// What Geckos wraps around a reliable message (its marker and an id), in bytes, near enough.
const RELIABLE_WRAPPER_BYTES = 40
// How many times Geckos sends a reliable message when `runs` is not given.
const GECKOS_DEFAULT_RUNS = 10

type Totals = { messages: number; bytes: number; copies: number }

export type BandwidthReport = {
  seconds: number
  bytesPerSecond: number
  // Busiest first.
  events: Array<{ event: string; bytesPerSecond: number; messagesPerSecond: number; copies: number }>
}

export class BandwidthMeter {
  private readonly totals = new Map<string, Totals>()

  // `payloadBytes` is the size of one copy of the message; `recipients` is how many players get it.
  record(event: string, payloadBytes: number, options: SendOptions | undefined = undefined, recipients = 1): void {
    const copies = options?.reliable ? options.runs ?? GECKOS_DEFAULT_RUNS : 1
    const perCopy = payloadBytes + (options?.reliable ? RELIABLE_WRAPPER_BYTES : 0)
    const entry = this.totals.get(event) ?? { messages: 0, bytes: 0, copies: 1 }
    entry.messages += recipients
    entry.bytes += perCopy * copies * recipients
    entry.copies = Math.max(entry.copies, copies)
    this.totals.set(event, entry)
  }

  // What was sent since the last call, as a rate over `elapsedMs`, and start counting again.
  flush(elapsedMs: number): BandwidthReport | undefined {
    const seconds = elapsedMs / 1000
    const events = [...this.totals].map(([event, entry]) => ({
      event,
      bytesPerSecond: entry.bytes / seconds,
      messagesPerSecond: entry.messages / seconds,
      copies: entry.copies,
    })).sort((left, right) => right.bytesPerSecond - left.bytesPerSecond)
    this.totals.clear()
    if (events.length === 0) return undefined
    return { seconds, bytesPerSecond: events.reduce((total, entry) => total + entry.bytesPerSecond, 0), events }
  }
}

function formatRate(bytesPerSecond: number): string {
  return bytesPerSecond >= 1024 * 1024
    ? `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`
    : `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
}

// One line a person can read: the total, then each kind of message from the busiest, with how many a
// second and how many times each is sent.
export function formatBandwidthReport(report: BandwidthReport): string {
  const parts = report.events.map((entry) =>
    `${entry.event} ${formatRate(entry.bytesPerSecond)} (${entry.messagesPerSecond.toFixed(1)}/s${entry.copies > 1 ? `, x${entry.copies}` : ''})`)
  return `Bandwidth out, last ${report.seconds.toFixed(0)} s: ${formatRate(report.bytesPerSecond)} total | ${parts.join(' | ')}`
}
