import type { ClientGameState } from '../game-state.ts'

export type DiagnosticsInfo = ReturnType<ClientGameState['getDebugInfo']>

// How often the text is rewritten. Every frame would make it too fast to read.
const REFRESH_MS = 250

// The top left: the frame rate, the connection and the simulation clock, as plain text over the
// canvas.
export function createDebugOverlay(container: HTMLElement) {
  const root = document.createElement('pre')
  root.className = 'game-debug-overlay'
  root.setAttribute('aria-label', 'Game network and simulation diagnostics')
  root.textContent = 'Waiting for game diagnostics…'
  container.appendChild(root)
  let frames = 0
  let sampleStartedAt: number | undefined
  let fps: number | undefined
  let refreshedAt: number | undefined

  return {
    // Shows the text, or hides it (the dev menu). It is kept up to date either way, so it is right the moment it is shown.
    setVisible(visible: boolean): void {
      root.hidden = !visible
    },
    // Called once for each frame drawn: counts it toward the frame rate, and every quarter of a second
    // rewrites the text from `read`.
    frame(now: number, read: () => DiagnosticsInfo): void {
      frames += 1
      sampleStartedAt ??= now
      if (now - sampleStartedAt >= 1000) {
        fps = frames * 1000 / (now - sampleStartedAt)
        frames = 0
        sampleStartedAt = now
      }
      if (refreshedAt !== undefined && now - refreshedAt < REFRESH_MS) return
      refreshedAt = now
      const info = read()
      const position = info.localPosition
      root.textContent = [
        `FPS: ${fps === undefined ? '—' : fps.toFixed(1)}`,
        `RTT: ${info.lastRttMs === undefined ? '—' : `${info.lastRttMs.toFixed(1)} ms`} (avg ${info.averageRttMs.toFixed(1)} ms, n=${info.rttSampleCount})`,
        `Tick: ${info.estimatedTick.toFixed(1)} (server ${info.serverTick}, update ${info.tickAnchorAgeMs.toFixed(0)} ms ago)`,
        `Pending orders: ${info.pendingOrderCount}${info.oldestPendingOrderAgeMs === undefined ? '' : ` (oldest ${info.oldestPendingOrderAgeMs.toFixed(0)} ms)`}`,
        `Local position: ${position ? `${position.x.toFixed(1)}, ${position.y.toFixed(1)}` : 'unavailable'}`,
      ].join('\n')
    },
    destroy(): void {
      root.remove()
    },
  }
}
