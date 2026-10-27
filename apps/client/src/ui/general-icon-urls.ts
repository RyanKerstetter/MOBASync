import { createAssetLookup } from '../render/asset-lookup.ts'

// The pictures that belong to no champion or ability (the gold and the shard) are res/general/<name>.png. This is apart from
// the code that draws them for the same reason as `ability-icon-urls.ts`: `import.meta.glob` only exists under Vite.
const PREFIX = '../../../../res/general/'
const urls = import.meta.glob('../../../../res/general/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const findIcon = createAssetLookup(urls, PREFIX)

// Where a general picture ("gold", "shard") is served from, or nothing if there is no file for it.
export function generalIconUrl(name: string): string | undefined {
  return findIcon(`${name}.png`)
}
