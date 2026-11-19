// Decoding a byte stream as text, one read at a time.
//
// A pipe or socket hands text over in reads cut at arbitrary bytes. Decoding
// each read on its own (`buf += chunk`, `chunk.toString()`) turns a character
// whose bytes straddle two reads into U+FFFD replacement characters, and the
// result still parses as JSON, so the damage is silent.

import { StringDecoder } from 'node:string_decoder';

/**
 * A decoder for one stream: call it with each chunk and append what it
 * returns. Bytes of a character that is not complete yet are held back until
 * the next chunk supplies the rest. Use one decoder per stream.
 *
 * @returns {(chunk: Buffer | string) => string}
 */
export function utf8ChunkDecoder() {
  const decoder = new StringDecoder('utf8');
  // A string chunk means the stream already decodes for itself.
  return (chunk) => (typeof chunk === 'string' ? chunk : decoder.write(chunk));
}
