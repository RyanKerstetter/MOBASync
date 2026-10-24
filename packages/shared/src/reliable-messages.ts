export type IdentifiedMessage = {
  id: string
  seq: number
}

type ReliableChannel = {
  emit(eventName: string, data: unknown): void
  on(eventName: string, callback: (data: unknown) => void): void
}

type PendingMessage<T> = {
  message: T
  timeoutAt: number
  nextRetryAt: number
  retryDelayMs: number
}

type ReliableMessengerOptions<
  T extends IdentifiedMessage,
  A extends IdentifiedMessage,
> = {
  channel: ReliableChannel
  messageEvent: string
  acknowledgementEvent: string
  timeoutMs: number
  parseAcknowledgement: (data: unknown) => A | undefined
  onAcknowledgement?: (acknowledgement: A) => void
  onAcknowledged?: (message: T) => void
  onTimeout?: (message: T) => void
}

export class ReliableMessenger<
  T extends IdentifiedMessage,
  A extends IdentifiedMessage = IdentifiedMessage,
> {
  private readonly pending = new Map<string, PendingMessage<T>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly options: ReliableMessengerOptions<T, A>) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new RangeError('Message timeout must be a finite, positive number.')
    }
    options.channel.on(options.acknowledgementEvent, (data) => {
      const acknowledgement = options.parseAcknowledgement(data)
      if (acknowledgement) {
        this.acknowledge(acknowledgement.id, acknowledgement.seq)
        options.onAcknowledgement?.(acknowledgement)
      }
    })
  }

  get size(): number {
    return this.pending.size
  }

  send(message: T, now = performance.now()): boolean {
    if (this.closed || this.pending.has(message.id)) return false
    const retryDelayMs = this.options.timeoutMs / 4
    this.pending.set(message.id, {
      message,
      timeoutAt: now + this.options.timeoutMs,
      nextRetryAt: now + retryDelayMs,
      retryDelayMs,
    })
    this.options.channel.emit(this.options.messageEvent, message)
    this.scheduleNextUpdate()
    return true
  }

  acknowledge(id: string, seq: number): boolean {
    const pending = this.pending.get(id)
    if (!pending || pending.message.seq !== seq) return false
    this.pending.delete(id)
    this.options.onAcknowledged?.(pending.message)
    this.scheduleNextUpdate()
    return true
  }

  listenFor(
    messageEvent: string,
    acknowledgementEvent: string,
    handleMessage: (data: unknown) => boolean,
  ): void {
    this.options.channel.on(messageEvent, (data) => {
      if (!this.closed && handleMessage(data)) {
        const message = parseIdentifiedMessage(data)
        if (message) {
          this.options.channel.emit(acknowledgementEvent, {
            id: message.id,
            seq: message.seq,
          })
        }
      }
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.pending.clear()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private scheduleNextUpdate(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.closed || this.pending.size === 0) return

    let nextUpdateAt = Number.POSITIVE_INFINITY
    for (const pending of this.pending.values()) {
      nextUpdateAt = Math.min(nextUpdateAt, pending.nextRetryAt, pending.timeoutAt)
    }
    this.timer = setTimeout(
      () => this.updatePendingMessages(),
      Math.max(0, nextUpdateAt - performance.now()),
    )
  }

  private updatePendingMessages(): void {
    this.timer = undefined
    if (this.closed) return
    const now = performance.now()
    for (const pending of this.pending.values()) {
      // Reported once: the deadline is put out of reach so it is never passed again.
      if (now >= pending.timeoutAt) {
        pending.timeoutAt = Number.POSITIVE_INFINITY
        this.options.onTimeout?.(pending.message)
      }
      if (now >= pending.nextRetryAt) {
        this.options.channel.emit(this.options.messageEvent, pending.message)
        pending.retryDelayMs *= 2
        pending.nextRetryAt += pending.retryDelayMs
      }
    }
    this.scheduleNextUpdate()
  }
}

export function parseIdentifiedMessage(data: unknown): IdentifiedMessage | undefined {
  if (typeof data !== 'object' || data === null || !('id' in data) || !('seq' in data)) {
    return undefined
  }
  const { id, seq } = data
  if (typeof id !== 'string' || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
    return undefined
  }
  return { id, seq }
}
