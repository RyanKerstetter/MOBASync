import { createAssetLookup } from '../render/asset-lookup.ts'

// An item's picture is res/shop_icons/<its icon>.png (see `Item.icon`), so giving an item a picture is adding a file there. This is apart from the
// code that draws them for the same reason as `ability-icon-urls.ts`: `import.meta.glob` only exists under Vite.
const PREFIX = '../../../../res/shop_icons/'
const urls = import.meta.glob('../../../../res/shop_icons/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const findIcon = createAssetLookup(urls, PREFIX)

// Where the picture for an item's icon name is served from, or nothing if there is no file for it.
export function itemIconUrl(icon: string): string | undefined {
  return findIcon(`${icon}.png`)
}
