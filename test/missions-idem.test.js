import { describe, it, expect } from 'vitest';
import { missionIdemKey, itemIdemKey } from '../lib/missions-idem.js';

const base = { op: 'post', roomId: '!r:s', kind: 'progress', title: 'Landed PR', body: 'the diff', now: 1789056600000 };

describe('missionIdemKey', () => {
  it('is a sha256 hex digest', () => {
    expect(missionIdemKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for a retry of the same call inside the same ten-minute bucket', () => {
    // Same content, 9 minutes 59 seconds later: still the same bucket only if
    // both land in it — pick two instants that do, plus an exact re-call.
    expect(missionIdemKey(base)).toBe(missionIdemKey({ ...base }));
    expect(missionIdemKey({ ...base, now: 1789056600000 })).toBe(missionIdemKey({ ...base, now: 1789056600000 + 599_999 }));
  });

  it('differs across a bucket boundary — the same milestone posted again later is a new one', () => {
    expect(missionIdemKey(base)).not.toBe(missionIdemKey({ ...base, now: base.now + 600_000 }));
    expect(missionIdemKey(base)).not.toBe(missionIdemKey({ ...base, now: base.now + 3_600_000 }));
  });

  it('differs for a different op, room, kind, title or body', () => {
    const key = missionIdemKey(base);
    expect(missionIdemKey({ ...base, op: 'start' })).not.toBe(key);
    expect(missionIdemKey({ ...base, roomId: '!other:s' })).not.toBe(key);
    expect(missionIdemKey({ ...base, kind: 'user_input' })).not.toBe(key);
    expect(missionIdemKey({ ...base, title: 'Landed PR 2' })).not.toBe(key);
    expect(missionIdemKey({ ...base, body: 'a different diff' })).not.toBe(key);
  });

  it('treats an absent optional field as empty rather than throwing or hashing "undefined"', () => {
    expect(missionIdemKey({ op: 'start', roomId: '!r:s', title: 'M', now: base.now })).toMatch(/^[0-9a-f]{64}$/);
    expect(missionIdemKey({ op: 'start', roomId: '!r:s', title: 'M', now: base.now }))
      .toBe(missionIdemKey({ op: 'start', roomId: '!r:s', kind: undefined, title: 'M', body: undefined, now: base.now }));
  });

  it('defaults now to the clock', () => {
    // Two clock reads can straddle a ten-minute boundary; accept either
    // adjacent bucket rather than flake once every ten minutes.
    const before = Date.now();
    const key = missionIdemKey({ op: 'start', roomId: '!r:s', title: 'M' });
    const after = Date.now();
    const candidates = new Set([before, after].map((now) => missionIdemKey({ op: 'start', roomId: '!r:s', title: 'M', now })));
    expect(candidates.has(key)).toBe(true);
  });
});

describe('itemIdemKey (loop #763)', () => {
  const NOW = 1789056600000;
  const create = { op: 'item_create', roomId: '!r:s', now: NOW, args: { kind: 'task', title: 'Ship it', body: 'do the thing' } };
  const comment = { op: 'item_comment', roomId: '!r:s', now: NOW, args: { id: 'it_7', body: 'progress note' } };

  it('is a sha256 hex digest, stable across a retry in the same bucket', () => {
    expect(itemIdemKey(create)).toMatch(/^[0-9a-f]{64}$/);
    expect(itemIdemKey(create)).toBe(itemIdemKey({ ...create, now: NOW + 599_999 }));
    expect(itemIdemKey(comment)).toBe(itemIdemKey({ ...comment }));
  });

  it('differs across a bucket boundary', () => {
    expect(itemIdemKey(create)).not.toBe(itemIdemKey({ ...create, now: NOW + 600_000 }));
  });

  it('a comment key includes the item id — same body on DIFFERENT items must not collide', () => {
    expect(itemIdemKey(comment)).not.toBe(itemIdemKey({ ...comment, args: { ...comment.args, id: 'it_8' } }));
  });

  it('differs for a different op, room, kind, title or body', () => {
    const key = itemIdemKey(create);
    expect(itemIdemKey({ ...create, op: 'item_comment' })).not.toBe(key);
    expect(itemIdemKey({ ...create, roomId: '!other:s' })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, kind: 'decision' } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, title: 'Ship it 2' } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, body: 'a different body' } })).not.toBe(key);
  });

  it('differs when ONLY a non-content field differs — distinct mutations must not share a key (Codex F2)', () => {
    const key = itemIdemKey(create);
    expect(itemIdemKey({ ...create, args: { ...create.args, attachments: ['a.png'] } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, labels: ['ui'] } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, links: [{ url: 'https://x' }] } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, awaiting: 'user' } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, position: 'top' } })).not.toBe(key);
    expect(itemIdemKey({ ...create, args: { ...create.args, supersedes: 'it_9' } })).not.toBe(key);
    // Two creates differing ONLY in attachments must differ.
    expect(itemIdemKey({ ...create, args: { ...create.args, attachments: ['a.png'] } }))
      .not.toBe(itemIdemKey({ ...create, args: { ...create.args, attachments: ['b.png'] } }));
  });

  it('is length-safe — a delimiter in one field cannot masquerade as a field boundary', () => {
    // The classic unescaped-join collision: ["a|b","c"] vs ["a","b|c"].
    const k1 = itemIdemKey({ op: 'item_create', roomId: '!r:s', now: NOW, args: { title: 'a|b', body: 'c' } });
    const k2 = itemIdemKey({ op: 'item_create', roomId: '!r:s', now: NOW, args: { title: 'a', body: 'b|c' } });
    expect(k1).not.toBe(k2);
  });
});
