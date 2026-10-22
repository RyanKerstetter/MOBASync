import { gzipSync } from 'node:zlib'

// A snapshot is the whole game state as JSON, which is the biggest message the server sends and very
// repetitive, so it goes out gzipped (about a quarter of the size) as a raw binary message. The client
// reads it with apps/client/src/snapshot-codec.ts. gzip starts with the bytes 1f 8b, so a message that
// does not is not one of these.
export function encodeSnapshot(snapshot: unknown): Buffer {
  return gzipSync(JSON.stringify(snapshot))
}
