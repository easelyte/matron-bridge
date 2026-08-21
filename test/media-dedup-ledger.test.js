import { describe, expect, it } from 'vitest';
import { createMediaDedupLedger, dedupKey } from '../lib/media-dedup-ledger.js';

describe('dedupKey', () => {
  it('is stable for identical identity inputs', () => {
    const a = dedupKey({ token: 't', realPath: '/w/a.png', sha256: 'abc', caption: 'hi' });
    const b = dedupKey({ token: 't', realPath: '/w/a.png', sha256: 'abc', caption: 'hi' });
    expect(a).toBe(b);
  });

  it('differs when any identity component differs', () => {
    const base = { token: 't', realPath: '/w/a.png', sha256: 'abc', caption: 'hi' };
    const k = dedupKey(base);
    expect(dedupKey({ ...base, token: 'other' })).not.toBe(k);
    expect(dedupKey({ ...base, realPath: '/w/b.png' })).not.toBe(k);
    expect(dedupKey({ ...base, sha256: 'def' })).not.toBe(k);
    expect(dedupKey({ ...base, caption: 'bye' })).not.toBe(k);
  });

  it('does not collide across field boundaries (null-delimited)', () => {
    // 'a' + 'b' vs 'ab' + '' must not hash the same
    const k1 = dedupKey({ token: 'a', realPath: 'b', sha256: 'c', caption: 'd' });
    const k2 = dedupKey({ token: 'ab', realPath: 'c', sha256: 'd', caption: '' });
    expect(k1).not.toBe(k2);
  });

  it('treats an absent caption as distinct from a present one', () => {
    const withCap = dedupKey({ token: 't', realPath: '/w/a.png', sha256: 'abc', caption: 'hi' });
    const noCap = dedupKey({ token: 't', realPath: '/w/a.png', sha256: 'abc', caption: undefined });
    expect(withCap).not.toBe(noCap);
  });
});

describe('createMediaDedupLedger', () => {
  it('returns undefined for an unseen key and the stored value after set', () => {
    const led = createMediaDedupLedger();
    expect(led.get('k1')).toBeUndefined();
    led.set('k1', { mediaId: 'm1', kind: 'image' });
    expect(led.get('k1')).toEqual({ mediaId: 'm1', kind: 'image' });
  });

  it('expires entries after the TTL window', () => {
    let clock = 1000;
    const led = createMediaDedupLedger({ ttlMs: 500, now: () => clock });
    led.set('k1', { mediaId: 'm1', kind: 'file' });
    clock = 1400; // within window
    expect(led.get('k1')).toEqual({ mediaId: 'm1', kind: 'file' });
    clock = 1600; // past 1000+500
    expect(led.get('k1')).toBeUndefined();
  });

  it('caps entry count with LRU eviction of the oldest', () => {
    let clock = 0;
    const led = createMediaDedupLedger({ maxEntries: 2, ttlMs: 10_000, now: () => clock });
    led.set('a', { mediaId: 'ma', kind: 'image' }); clock += 1;
    led.set('b', { mediaId: 'mb', kind: 'image' }); clock += 1;
    // touch 'a' so 'b' becomes the LRU victim
    expect(led.get('a')).toBeTruthy();
    led.set('c', { mediaId: 'mc', kind: 'image' });
    expect(led.get('b')).toBeUndefined(); // evicted
    expect(led.get('a')).toBeTruthy();
    expect(led.get('c')).toBeTruthy();
    expect(led.size).toBeLessThanOrEqual(2);
  });

  it('sweeps expired entries opportunistically on set so it cannot grow unbounded', () => {
    let clock = 0;
    const led = createMediaDedupLedger({ ttlMs: 100, maxEntries: 1000, now: () => clock });
    led.set('old', { mediaId: 'mo', kind: 'file' });
    clock = 500; // 'old' now expired
    led.set('new', { mediaId: 'mn', kind: 'file' });
    expect(led.size).toBe(1); // 'old' swept during the set
    expect(led.get('old')).toBeUndefined();
  });
});
