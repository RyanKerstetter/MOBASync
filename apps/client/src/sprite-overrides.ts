// Where a sheet sits in the art folder, as `Folder/File.png` in lower case, from the path or URL it is
// found at. Only the last two parts count, so a sheet is the same one whether it is served from the
// repository's res/, or picked from a folder anywhere on disk that is laid out like it (or is one
// character's folder on its own).
export function spriteFileKey(path: string): string {
  const parts = path.split(/[?#]/)[0]!.split(/[\\/]/).filter((part) => part !== '')
  return parts.slice(-2).map((part) => decodeURIComponent(part).toLowerCase()).join('/')
}

// The sheets in a picked folder by `spriteFileKey`, so a set can swap in the ones it finds there and
// keep its own for the rest.
export function spriteOverridesFrom<T extends { name: string; webkitRelativePath?: string }>(
  files: Iterable<T>,
): Map<string, T> {
  const overrides = new Map<string, T>()
  for (const file of files) {
    if (!/\.png$/i.test(file.name)) continue
    overrides.set(spriteFileKey(file.webkitRelativePath || file.name), file)
  }
  return overrides
}
