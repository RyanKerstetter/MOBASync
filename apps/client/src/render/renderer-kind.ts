// Which way the world is drawn: flat, from straight above with sprites (2D), or stood up with models and a tilted camera (3D).
export type RendererKind = '2d' | '3d'
export const RENDERER_KINDS: readonly RendererKind[] = ['3d', '2d']
export const DEFAULT_RENDERER: RendererKind = '3d'

// Which renderer the page asks for in its address (`?renderer=2d`), if it does.
export function rendererFromSearch(search: string): RendererKind | undefined {
  const asked = new URLSearchParams(search).get('renderer')?.trim().toLowerCase()
  return RENDERER_KINDS.find((kind) => kind === asked)
}
