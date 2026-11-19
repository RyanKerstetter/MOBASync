// What goes wrong in one part of the game is told in the console and stays in that part: the rest of the frame is still drawn, and the
// next frame comes as usual. (An error that escapes a frame stops PixiJS's ticker, and the game freezes on the last frame.)

// Each different error is told once, not sixty times a second. Past this many, the rest are not told at all.
const MOST_TOLD = 100
const told = new Set<string>()

export function reportOnce(where: string, error: unknown): void {
  const key = `${where}: ${error instanceof Error ? error.message : String(error)}`
  if (told.has(key) || told.size >= MOST_TOLD) return
  told.add(key)
  console.error(`${where} went wrong, and the game goes on without it.`, error)
}

// Runs `run`, and if it throws, tells it once and goes on.
export function guarded(where: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    reportOnce(where, error)
  }
}
