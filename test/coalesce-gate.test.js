import { describe, it, expect } from 'vitest';
import { shouldBuffer } from '../lib/message-coalescer.js';

describe('shouldBuffer (media-anchored default)', () => {
  it('media always buffers', () => {
    expect(shouldBuffer({ hasMedia: true, holdOpen: false, universal: false })).toBe(true);
  });

  it('solo text with no open hold dispatches immediately', () => {
    expect(shouldBuffer({ hasMedia: false, holdOpen: false, universal: false })).toBe(false);
  });

  it('text joins an open hold', () => {
    expect(shouldBuffer({ hasMedia: false, holdOpen: true, universal: false })).toBe(true);
  });

  it('universal buffers solo text', () => {
    expect(shouldBuffer({ hasMedia: false, holdOpen: false, universal: true })).toBe(true);
  });
});
