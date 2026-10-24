import { createAssetLookup } from '../render/asset-lookup.ts'

// An ability's icon is res/icons/<ability id>.png, so giving an ability an icon is adding a file of
// its name there. This is apart from `ability-icon.ts` because `import.meta.glob` only exists under
// Vite, and the code that draws icons is loaded by the tests too (see render/tiled-assets.ts, which
// finds the map's pictures the same way).
const PREFIX = '../../../../res/icons/'
const urls = import.meta.glob('../../../../res/icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const findIcon = createAssetLookup(urls, PREFIX)

// Where the icon for an ability is served from, or nothing if there is no file for it.
export function abilityIconUrl(abilityId: string): string | undefined {
  return findIcon(`${abilityId}.png`)
}
