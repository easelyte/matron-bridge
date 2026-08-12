import { describe, it, expect } from 'vitest';
import { createConvoSeqRegistry } from '../lib/convo-seq-registry.js';

// The registry's `merge` capability is what backs convo-id reassignment: the
// journal input router calls it (via queueRelease.carryForward) at three sites
// to fold one convo's seq/prompt bookkeeping into another when the id a card
// was published under is later reassigned. These tests exercise that reassign
// scenario directly against the exported primitive — carried entries must be
// retrievable under the new id, the source bucket must be forgotten, collision
// ordering must be honored, and the retention bound must still apply afterward.

describe('createConvoSeqRegistry — merge (convo-id reassignment)', () => {
  it('carries entries forward under the new convo id and forgets the source', () => {
    const reg = createConvoSeqRegistry();
    reg.set('from', 'a', 1);
    reg.set('from', 'b', 2);

    const merged = reg.merge('from', 'to');

    // Retrievable under the new id.
    expect(reg.get('to', 'a')).toBe(1);
    expect(reg.get('to', 'b')).toBe(2);
    expect(reg.size('to')).toBe(2);
    expect([...reg.keys('to')]).toEqual(['a', 'b']);

    // Source bucket is gone (no residue under the old id).
    expect(reg.has('from', 'a')).toBe(false);
    expect(reg.get('from', 'a')).toBeUndefined();
    expect(reg.size('from')).toBe(0);

    // merge returns the resulting inner map.
    expect(merged).toBeInstanceOf(Map);
    expect(merged.get('a')).toBe(1);
  });

  it('when the target is empty, the source map becomes the target bucket', () => {
    const reg = createConvoSeqRegistry();
    reg.set('from', 'x', 'v');

    reg.merge('from', 'to');

    expect(reg.get('to', 'x')).toBe('v');
    expect(reg.size('to')).toBe(1);
    expect(reg.size('from')).toBe(0);
  });

  it('fromFirst=true orders source keys first, so target values win a collision', () => {
    const reg = createConvoSeqRegistry();
    reg.set('from', 'shared', 'from-value');
    reg.set('from', 'only-from', 'f');
    reg.set('to', 'shared', 'to-value');
    reg.set('to', 'only-to', 't');

    reg.merge('from', 'to', { fromFirst: true });

    // Target value wins the shared key; both unique keys carried.
    expect(reg.get('to', 'shared')).toBe('to-value');
    expect(reg.get('to', 'only-from')).toBe('f');
    expect(reg.get('to', 'only-to')).toBe('t');
    // Source keys ordered first.
    expect([...reg.keys('to')]).toEqual(['shared', 'only-from', 'only-to']);
    expect(reg.size('from')).toBe(0);
  });

  it('fromFirst=false orders target keys first, so source values win a collision', () => {
    const reg = createConvoSeqRegistry();
    reg.set('to', 'shared', 'to-value');
    reg.set('to', 'only-to', 't');
    reg.set('from', 'shared', 'from-value');
    reg.set('from', 'only-from', 'f');

    reg.merge('from', 'to', { fromFirst: false });

    // Source value wins the shared key.
    expect(reg.get('to', 'shared')).toBe('from-value');
    expect(reg.get('to', 'only-to')).toBe('t');
    expect(reg.get('to', 'only-from')).toBe('f');
    // Target keys ordered first.
    expect([...reg.keys('to')]).toEqual(['shared', 'only-to', 'only-from']);
    expect(reg.size('from')).toBe(0);
  });

  it('is a no-op when source and target are the same id', () => {
    const reg = createConvoSeqRegistry();
    reg.set('c', 'k', 'v');

    const result = reg.merge('c', 'c');

    expect(reg.get('c', 'k')).toBe('v');
    expect(reg.size('c')).toBe(1);
    expect(result).toBe(reg.merge('c', 'c')); // same bucket returned, unchanged
  });

  it('leaves the target untouched when the source has nothing to move', () => {
    const reg = createConvoSeqRegistry();
    reg.set('to', 'k', 'v');

    reg.merge('missing', 'to');

    expect(reg.get('to', 'k')).toBe('v');
    expect(reg.size('to')).toBe(1);
    expect(reg.size('missing')).toBe(0);
  });

  it('keeps the retention bound after a merge overflows it', () => {
    const reg = createConvoSeqRegistry({ retention: 2 });
    // Fill both buckets to the bound; each `set` self-prunes to <= retention.
    reg.set('from', 'f1', 1);
    reg.set('from', 'f2', 2);
    reg.set('to', 't1', 3);
    reg.set('to', 't2', 4);

    // merge itself does not prune — it folds the two bounded maps together.
    reg.merge('from', 'to', { fromFirst: false });
    expect(reg.size('to')).toBe(4);

    // The next insert re-enforces drop-oldest back down to the bound, and the
    // just-inserted key is the one guaranteed to survive. Post-merge insertion
    // order is [t1, t2, f1, f2] (target-first) + t3; dropping the three oldest
    // leaves the two newest by insertion order.
    reg.set('to', 't3', 5);
    expect(reg.size('to')).toBe(2);
    expect(reg.get('to', 't3')).toBe(5);
    expect([...reg.keys('to')]).toEqual(['f2', 't3']);
  });

  it('evict still clears a bucket that received a merge', () => {
    const reg = createConvoSeqRegistry();
    reg.set('from', 'a', 1);
    reg.set('to', 'b', 2);

    reg.merge('from', 'to');
    expect(reg.size('to')).toBe(2);

    reg.evict('to');
    expect(reg.size('to')).toBe(0);
    expect(reg.has('to', 'a')).toBe(false);
    expect(reg.has('to', 'b')).toBe(false);
  });
});
