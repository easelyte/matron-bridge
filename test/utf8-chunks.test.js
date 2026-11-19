import { describe, it, expect } from 'vitest';
import { utf8ChunkDecoder } from '../lib/utf8-chunks.js';

// Feed `bytes` to a fresh decoder in pieces cut at the given byte offsets,
// the way a pipe or socket hands over a long text in arbitrary reads.
function decodeSplit(bytes, cuts) {
  const decode = utf8ChunkDecoder();
  let out = '';
  let from = 0;
  for (const cut of [...cuts, bytes.length]) {
    out += decode(bytes.subarray(from, cut));
    from = cut;
  }
  return out;
}

describe('utf8ChunkDecoder', () => {
  it('keeps a two-byte character that is split across two chunks', () => {
    const text = 'café au lait';
    const bytes = Buffer.from(text, 'utf8');
    // "é" is bytes 3 and 4.
    expect(decodeSplit(bytes, [4])).toBe(text);
  });

  it('keeps a three-byte character split at each of its byte boundaries', () => {
    const text = 'price: 5€';
    const bytes = Buffer.from(text, 'utf8');
    expect(decodeSplit(bytes, [bytes.length - 2])).toBe(text);
    expect(decodeSplit(bytes, [bytes.length - 1])).toBe(text);
  });

  it('keeps a four-byte emoji split at every byte, one byte per chunk', () => {
    const text = 'ok \u{1F600} done';
    const bytes = Buffer.from(text, 'utf8');
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(decodeSplit(bytes, [cut])).toBe(text);
    }
    const everyByte = Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
    expect(decodeSplit(bytes, everyByte)).toBe(text);
  });

  it('never yields a replacement character for valid text, wherever the cut falls', () => {
    const text = JSON.stringify({ secret: 'pässwörd-日本語-\u{1F511}', note: 'naïve' });
    const bytes = Buffer.from(text, 'utf8');
    for (let cut = 1; cut < bytes.length; cut++) {
      const out = decodeSplit(bytes, [cut]);
      expect(out).not.toContain('�');
      expect(JSON.parse(out)).toEqual(JSON.parse(text));
    }
  });

  it('passes a newline-delimited line through intact when the split is inside a character', () => {
    const line = JSON.stringify({ type: 'assistant', text: 'déjà vu \u{1F680}' }) + '\n';
    const bytes = Buffer.from(line, 'utf8');
    const cut = bytes.indexOf(Buffer.from('\u{1F680}', 'utf8')) + 2;
    const out = decodeSplit(bytes, [cut]);
    expect(out.split('\n')[0]).toBe(line.trimEnd());
  });

  it('passes strings through unchanged (a stream that already has an encoding)', () => {
    const decode = utf8ChunkDecoder();
    expect(decode('héllo')).toBe('héllo');
  });

  it('keeps separate decoders independent', () => {
    const a = utf8ChunkDecoder();
    const b = utf8ChunkDecoder();
    const bytes = Buffer.from('é', 'utf8');
    expect(a(bytes.subarray(0, 1))).toBe('');
    expect(b(Buffer.from('x'))).toBe('x');
    expect(a(bytes.subarray(1))).toBe('é');
  });
});
