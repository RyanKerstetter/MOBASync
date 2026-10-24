// Finds a file in a set of files by the path a map gives for it. `files` is every file there is, by
// its full key, and `prefix` is what every key starts with, so a path is a key with the prefix off.
//
// A map made on a machine where its tilesets and pictures were somewhere else (in Downloads, say)
// names paths that lead out of the folder, so a path that is not where it says is found by its file
// name instead, as long as only one file has it. With two, nothing is guessed.
export function createAssetLookup(files: Readonly<Record<string, string>>, prefix: string): (path: string) => string | undefined {
  const byName = new Map<string, string[]>()
  for (const key of Object.keys(files)) {
    const name = key.slice(key.lastIndexOf('/') + 1)
    byName.set(name, [...(byName.get(name) ?? []), key])
  }
  return (path) => {
    const exact = files[`${prefix}${path}`]
    if (exact !== undefined) return exact
    const matches = byName.get(path.slice(path.lastIndexOf('/') + 1))
    return matches?.length === 1 ? files[matches[0]] : undefined
  }
}
