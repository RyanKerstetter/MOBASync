export type LagConfig = {
  // One-way delay added to every message, in each direction.
  latencyMs: number
  // Each message gets a random extra delay in [0, jitterMs]; non-zero jitter can reorder messages.
  jitterMs: number
  // Probability in [0, 1] that an outgoing unreliable message is dropped. Reliable emits and
  // incoming messages (whose delivery mode is unknown to the receiver) are never dropped.
  loss: number
}

type LagChannel = {
  emit(eventName: string, data?: unknown, options?: { reliable?: boolean }): unknown
  on(eventName: string, callback: (data: any) => void): unknown
}

const noLag: Readonly<LagConfig> = { latencyMs: 0, jitterMs: 0, loss: 0 }

// Wraps a geckos channel so everything sent or received through it is delayed, jittered
// and dropped according to `config`. `config` is read for every message, so mutating the
// returned object adjusts the simulation live. Both directions are delayed, so wrapping
// only the client channel yields a round trip of 2 * latencyMs.
export function withLag<T extends LagChannel>(
  channel: T,
  config: Partial<LagConfig> = {},
): { channel: T; config: LagConfig } {
  const lag: LagConfig = { ...noLag, ...config }
  const schedule = (deliver: () => void, reliable: boolean): void => {
    if (!reliable && Math.random() < lag.loss) return
    const delay = Math.max(0, lag.latencyMs + Math.random() * lag.jitterMs)
    if (delay === 0) deliver()
    else setTimeout(deliver, delay)
  }

  const wrapped = new Proxy(channel, {
    get(target, property, receiver) {
      if (property === 'emit') {
        return (eventName: string, data?: unknown, options?: { reliable?: boolean }) => {
          schedule(() => target.emit(eventName, data, options), Boolean(options?.reliable))
        }
      }
      if (property === 'on') {
        return (eventName: string, callback: (data: any) => void) =>
          target.on(eventName, (data) => schedule(() => callback(data), true))
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { channel: wrapped, config: lag }
}

// Reads `?lag=<ms>&jitter=<ms>&loss=<0-1>` so a page can be opened with simulated lag.
export function lagConfigFromQuery(search: string): Partial<LagConfig> | undefined {
  const params = new URLSearchParams(search)
  const read = (key: string): number | undefined => {
    const raw = params.get(key)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  const latencyMs = read('lag')
  const jitterMs = read('jitter')
  const loss = read('loss')
  if (latencyMs === undefined && jitterMs === undefined && loss === undefined) return undefined
  return {
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(jitterMs !== undefined ? { jitterMs } : {}),
    ...(loss !== undefined ? { loss: Math.min(1, loss) } : {}),
  }
}
