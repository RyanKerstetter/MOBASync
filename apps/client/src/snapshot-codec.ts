// Reads a snapshot the server gzipped (apps/server/src/snapshot-codec.ts). The browser's own
// DecompressionStream does the work, so it is asynchronous: callers that need snapshots in order must
// wait for one before decoding the next.
export async function decodeSnapshot(data: ArrayBuffer | ArrayBufferView): Promise<unknown> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return JSON.parse(await new Response(stream).text())
}
