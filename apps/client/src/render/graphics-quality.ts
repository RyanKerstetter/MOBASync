// How much the 3D world draws, setting by setting (the graphics menu). Each costs the graphics card, or the browser, something every frame;
// on integrated graphics and school computers the cheap side of each is what keeps the game smooth. Low, Medium and High are presets: each
// sets every one of them at once, and any of them can then be changed on its own.
export type GraphicsOptions = {
  // The sun's shadows: sharp and soft-edged, rougher and cheaper, or none at all.
  shadows: 'high' | 'low' | 'off'
  // Smoothed edges (anti-aliasing) on the 3D world and on the names and bars over it.
  smoothEdges: boolean
  // On a high-density screen: drawn sharper than one pixel to the page's (up to 1.5), or at one.
  resolution: 'high' | 'standard'
  // The picture drawn smaller, and stretched to the screen, while the frame rate falls short, and sharper again when there is time.
  dynamicResolution: boolean
  // Surfaces lit with their shine (metal gleams, cloth is dull), or simply, with diffuse light only.
  lighting: 'detailed' | 'simple'
  // Spells and shots that light the ground round them as they go.
  spellLights: boolean
  // The ground painted from textures, or a plain colour at each point of its grid.
  ground: 'textured' | 'plain'
  // Trees, boulders and bushes as they are made; each a few simple shapes (Medium); or (Low) only the trees along the open ground, each one plain
  // spike, no boulders or shrubs on the walls, and the bushes (which hide champions) a single shape each.
  scenery: 'high' | 'medium' | 'low'
  // Tufts of grass on the open ground.
  grass: boolean
  // How many sides the champions' round shapes have.
  models: 'high' | 'medium' | 'low'
  // How many of the particles let go are made: all, or fewer.
  particles: 'full' | 'reduced' | 'minimal'
}

export type GraphicsPreset = 'low' | 'medium' | 'high'
// In the order the menu shows them: the high end first, as every graphics setting has it.
export const GRAPHICS_PRESET_NAMES: readonly GraphicsPreset[] = ['high', 'medium', 'low']

export const GRAPHICS_PRESETS: Readonly<Record<GraphicsPreset, Readonly<GraphicsOptions>>> = {
  low: {
    shadows: 'off',
    smoothEdges: false,
    resolution: 'standard',
    dynamicResolution: true,
    lighting: 'simple',
    spellLights: false,
    ground: 'plain',
    scenery: 'low',
    grass: false,
    models: 'low',
    particles: 'minimal',
  },
  medium: {
    shadows: 'low',
    smoothEdges: true,
    resolution: 'standard',
    dynamicResolution: true,
    lighting: 'detailed',
    spellLights: false,
    ground: 'textured',
    scenery: 'medium',
    grass: false,
    models: 'medium',
    particles: 'reduced',
  },
  high: {
    shadows: 'high',
    smoothEdges: true,
    resolution: 'high',
    dynamicResolution: false,
    lighting: 'detailed',
    spellLights: true,
    ground: 'textured',
    scenery: 'high',
    grass: true,
    models: 'high',
    particles: 'full',
  },
}

// What a browser that has stored nothing begins with.
export const DEFAULT_GRAPHICS_PRESET: GraphicsPreset = 'medium'
export const DEFAULT_GRAPHICS: Readonly<GraphicsOptions> = GRAPHICS_PRESETS[DEFAULT_GRAPHICS_PRESET]

// The preset these settings are, or undefined when one of them has been changed from every preset's.
export function presetOf(options: Readonly<GraphicsOptions>): GraphicsPreset | undefined {
  return GRAPHICS_PRESET_NAMES.find((name) => GRAPHICS_KEYS.every((key) => GRAPHICS_PRESETS[name][key] === options[key]))
}

// Each setting, and the values it can have.
export const GRAPHICS_CHOICES = {
  shadows: ['high', 'low', 'off'],
  smoothEdges: [true, false],
  resolution: ['high', 'standard'],
  dynamicResolution: [true, false],
  lighting: ['detailed', 'simple'],
  spellLights: [true, false],
  ground: ['textured', 'plain'],
  scenery: ['high', 'medium', 'low'],
  grass: [true, false],
  models: ['high', 'medium', 'low'],
  particles: ['full', 'reduced', 'minimal'],
} as const satisfies { [K in keyof GraphicsOptions]: readonly GraphicsOptions[K][] }
export const GRAPHICS_KEYS = Object.keys(GRAPHICS_CHOICES) as Array<keyof GraphicsOptions>

// What was stored, each setting read on its own: one that is missing or odd is the default's, so a damaged one costs only itself. The name of a
// preset (as Low and High were once stored) is that preset.
export function readGraphics(stored: unknown): GraphicsOptions {
  if (typeof stored === 'string' && (GRAPHICS_PRESET_NAMES as readonly string[]).includes(stored)) return { ...GRAPHICS_PRESETS[stored as GraphicsPreset] }
  const fields = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : {}
  const read = <K extends keyof GraphicsOptions>(key: K): GraphicsOptions[K] =>
    (GRAPHICS_CHOICES[key] as readonly unknown[]).includes(fields[key]) ? fields[key] as GraphicsOptions[K] : DEFAULT_GRAPHICS[key]
  return Object.fromEntries(GRAPHICS_KEYS.map((key) => [key, read(key)])) as GraphicsOptions
}

// Whether two sets of settings are the same, setting by setting.
export function sameGraphics(a: Readonly<GraphicsOptions>, b: Readonly<GraphicsOptions>): boolean {
  return GRAPHICS_KEYS.every((key) => a[key] === b[key])
}
