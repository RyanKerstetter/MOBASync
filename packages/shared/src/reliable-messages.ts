export type IdentifiedMessage = {
  id: string
  seq: number
}

export type ReliableMessageUpdate<T> = {
  retryMessages: T[]
  timedOutMessages: T[]
}

type PendingMessage<T> = {
  message: T
  sentAt: number
  timeoutAt: number
  nextRetryAt: number
  retryDelayMs: number
}

export class ReliableMessageQueue<T extends IdentifiedMessage> {
  private readonly pending = new Map<string, PendingMessage<T>>()

  constructor(private readonly timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Message timeout must be a finite, positive number.')
    }
  }

  get size(): number {
    return this.pending.size
  }

  track(message: T, now: number): boolean {
    if (this.pending.has(message.id)) return false
    const retryDelayMs = this.timeoutMs / 4
    this.pending.set(message.id, {
      message,
      sentAt: now,
      timeoutAt: now + this.timeoutMs,
      nextRetryAt: now + retryDelayMs,
      retryDelayMs,
    })
    return true
  }

  acknowledge(id: string, seq: number): boolean {
    const pending = this.pending.get(id)
    if (!pending || pending.message.seq !== seq) return false
    this.pending.delete(id)
    return true
  }

  update(now: number): ReliableMessageUpdate<T> {
    const retryMessages: T[] = []
    const timedOutMessages: T[] = []
    for (const [id, pending] of this.pending) {
      if (now >= pending.timeoutAt) {
        this.pending.delete(id)
        timedOutMessages.push(pending.message)
      } else if (now >= pending.nextRetryAt) {
        retryMessages.push(pending.message)
        pending.retryDelayMs *= 2
        pending.nextRetryAt += pending.retryDelayMs
      }
    }
    return { retryMessages, timedOutMessages }
  }

  getOldestPendingAge(now: number): number | undefined {
    let oldestSentAt: number | undefined
    for (const pending of this.pending.values()) {
      if (oldestSentAt === undefined || pending.sentAt < oldestSentAt) {
        oldestSentAt = pending.sentAt
      }
    }
    return oldestSentAt === undefined ? undefined : Math.max(0, now - oldestSentAt)
  }
}
