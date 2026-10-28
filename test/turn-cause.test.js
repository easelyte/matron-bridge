import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CAUSE_KINDS, CAUSES_MAX, CAUSE_REF_MAX,
  cause, userMessageCause, itemCause, routineCause, spawnOutcomeCause, roomMessageCause, roomBatchCauses, carryOnCause, plainCause, spawnedCause,
  mergeCauses, mergeTurnCauses, mergeIntoTurn, queueCauses, tagCauses, tappedAction, beginTurn, beginOrJoinTurn, joinHeldTurn, endTurn, causesForAsk,
} from '../lib/turn-cause.js';

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

describe('constants', () => {
  it('the shared vocabulary, in order', () => {
    expect(CAUSE_KINDS).toEqual(['user_message', 'item_reply', 'item_tap', 'routine', 'spawn_outcome',
      'room_message', 'reminder', 'carry_on', 'alert', 'handoff', 'other']);
    expect(CAUSES_MAX).toBe(8);
    expect(CAUSE_REF_MAX).toBe(200);
  });
});

describe('cause', () => {
  it('stamps kind, ref and at', () => {
    expect(cause('reminder', 'x')).toEqual({ kind: 'reminder', ref: 'x', at: NOW });
  });

  it('omits ref when none is given', () => {
    const c = cause('other');
    expect(c).toEqual({ kind: 'other', at: NOW });
    expect('ref' in c).toBe(false);
  });

  it('truncates an over-long ref to CAUSE_REF_MAX', () => {
    const c = cause('room_message', 'r'.repeat(500));
    expect(c.ref).toHaveLength(CAUSE_REF_MAX);
  });

  it('throws on an unknown kind', () => {
    expect(() => cause('telepathy')).toThrow(/unknown cause kind/);
    expect(() => cause(undefined)).toThrow();
  });
});

describe('builders', () => {
  it('userMessageCause: <convoId>:<seq>', () => {
    expect(userMessageCause('convo-a', 42)).toEqual({ kind: 'user_message', ref: 'convo-a:42', at: NOW });
  });

  it('routineCause: routine:<name>@<firedAt>, firedAt passed through as given', () => {
    expect(routineCause({ name: 'morning-sweep', firedAt: '2026-01-02T03:00:00.000Z' }))
      .toEqual({ kind: 'routine', ref: 'routine:morning-sweep@2026-01-02T03:00:00.000Z', at: NOW });
  });

  it('spawnOutcomeCause: spawn:<id>', () => {
    expect(spawnOutcomeCause('sp_1')).toEqual({ kind: 'spawn_outcome', ref: 'spawn:sp_1', at: NOW });
  });

  it('roomMessageCause: room:<id>, with one seq or a span of them', () => {
    expect(roomMessageCause('room-1')).toEqual({ kind: 'room_message', ref: 'room:room-1', at: NOW });
    expect(roomMessageCause('room-1', 42)).toEqual({ kind: 'room_message', ref: 'room:room-1@42', at: NOW });
    expect(roomMessageCause('room-1', 42, 50)).toEqual({ kind: 'room_message', ref: 'room:room-1@42-50', at: NOW });
    // A span that is not one collapses to its start; an unusable seq to the room.
    expect(roomMessageCause('room-1', 42, 40).ref).toBe('room:room-1@42');
    for (const bad of [0, -1, 1.5, '3', null]) expect(roomMessageCause('room-1', bad).ref).toBe('room:room-1');
  });

  it('roomBatchCauses: one cause per room spanning its seqs; any unknown seq makes it bare', () => {
    const m = roomBatchCauses([{ roomId: 'r1', seq: 9 }, { roomId: 'r2', seq: 4 }, { roomId: 'r1', seq: 3 }, { roomId: 'r3', seq: 7 }, { roomId: 'r3' }, { seq: 1 }]);
    expect([...m.keys()]).toEqual(['r1', 'r2', 'r3']);
    expect(m.get('r1').ref).toBe('room:r1@3-9');
    expect(m.get('r2').ref).toBe('room:r2@4');
    expect(m.get('r3').ref).toBe('room:r3');
  });

  it('carryOnCause: names the journal\'s record when the id has its shape, else the kind alone', () => {
    expect(carryOnCause('co_0123456789abcdef')).toEqual({ kind: 'carry_on', ref: 'carry_on:co_0123456789abcdef', at: NOW });
    for (const bad of [null, undefined, 'co_x', 7, 'carry_on:co_0123456789abcdef']) expect(carryOnCause(bad)).toEqual({ kind: 'carry_on', at: NOW });
  });

  it('plainCause: kind only', () => {
    for (const k of ['reminder', 'carry_on', 'alert', 'handoff', 'other']) {
      expect(plainCause(k)).toEqual({ kind: k, at: NOW });
    }
    expect(() => plainCause('nope')).toThrow();
  });

  it('spawnedCause: `other` naming the spawn, or bare for a missing or malformed id', () => {
    expect(spawnedCause('6f1c2b3a-0d4e-4f5a-9b6c-7d8e9f0a1b2c')).toEqual({ kind: 'other', ref: 'spawned:6f1c2b3a-0d4e-4f5a-9b6c-7d8e9f0a1b2c', at: NOW });
    for (const bad of [null, undefined, '', 'a:b', 'a'.repeat(65), 7]) expect(spawnedCause(bad)).toEqual({ kind: 'other', at: NOW });
  });
});

describe('itemCause', () => {
  const at = Date.UTC(2026, 0, 1, 12, 0, 0, 5);
  const iso = '2026-01-01T12:00:00.005Z';

  it('a typed reply is item_reply with item:<num>@<created_at ISO ms Z>', () => {
    const p = { action: 'commented', num: 12, comment: { body: 'use A', created_at: at } };
    expect(itemCause(p)).toEqual({ kind: 'item_reply', ref: `item:12@${iso}`, at: NOW });
  });

  it('a one-tap reply (comment.action) is item_tap', () => {
    const p = { action: 'commented', num: 12, comment: { body: 'Go', action: 'Go', created_at: at } };
    expect(itemCause(p)).toEqual({ kind: 'item_tap', ref: `item:12@${iso}`, at: NOW });
  });

  it('a tap label still nested under comment.meta (older journal) is item_tap', () => {
    const p = { action: 'commented', num: 12, comment: { meta: { action: 'Go' }, created_at: at } };
    expect(itemCause(p).kind).toBe('item_tap');
  });

  it('the marker verb in payload.action does not make a reply a tap', () => {
    const p = { action: 'commented', num: 3, comment: { body: 'hi', created_at: at } };
    expect(itemCause(p).kind).toBe('item_reply');
  });

  it('a blank action label is a reply', () => {
    const p = { action: 'commented', num: 3, comment: { body: 'hi', action: '  ', created_at: at } };
    expect(itemCause(p).kind).toBe('item_reply');
  });

  it('null when the number or the comment created_at is missing', () => {
    expect(itemCause(null)).toBeNull();
    expect(itemCause({})).toBeNull();
    expect(itemCause({ num: 12 })).toBeNull();
    expect(itemCause({ num: 12, comment: {} })).toBeNull();
    expect(itemCause({ num: 12, comment: { created_at: 'yesterday' } })).toBeNull();
    expect(itemCause({ comment: { created_at: at } })).toBeNull();
    expect(itemCause({ num: '12', comment: { created_at: at } })).toBeNull();
  });
});

describe('mergeCauses', () => {
  const a = { kind: 'user_message', ref: 'c:1', at: 1 };
  const b = { kind: 'item_reply', ref: 'item:1@x', at: 2 };

  it('flattens lists and single causes, dropping falsy entries', () => {
    expect(mergeCauses([[a], null, b, undefined, []])).toEqual([a, b]);
  });

  it('dedupes by kind+ref, keeping the first', () => {
    const a2 = { ...a, at: 99 };
    const sameRefOtherKind = { kind: 'item_tap', ref: 'item:1@x', at: 3 };
    expect(mergeCauses([[a, b], [a2, sameRefOtherKind]])).toEqual([a, b, sameRefOtherKind]);
  });

  it('dedupes ref-less causes of the same kind', () => {
    const r1 = { kind: 'reminder', at: 1 };
    const r2 = { kind: 'reminder', at: 2 };
    expect(mergeCauses([[r1, r2]])).toEqual([r1]);
  });

  it('caps at CAUSES_MAX (8): the first 7 and a truncation marker in the last slot', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'room_message', ref: `room:${i}`, at: i }));
    const out = mergeCauses([many]);
    expect(out).toHaveLength(CAUSES_MAX);
    expect(out.slice(0, 7)).toEqual(many.slice(0, 7));
    expect(out[7]).toEqual({ kind: 'other', ref: 'truncated', at: NOW });
  });

  it('a dropped later cause leaves the marker: 8 user messages + 1 reminder -> 7 user messages + other/truncated', () => {
    const users = Array.from({ length: 8 }, (_, i) => userMessageCause('c', i));
    const out = mergeCauses([users, [plainCause('reminder')]]);
    expect(out.map((c) => c.kind)).toEqual([...Array(7).fill('user_message'), 'other']);
    expect(out.slice(0, 7)).toEqual(users.slice(0, 7));
    expect(out[7]).toMatchObject({ kind: 'other', ref: 'truncated' });
  });

  it('exactly CAUSES_MAX distinct causes are kept whole, with no marker', () => {
    const eight = Array.from({ length: 8 }, (_, i) => userMessageCause('c', i));
    expect(mergeCauses([eight, eight])).toEqual(eight);
  });

  it('a truncated list merged again stays capped and keeps its marker', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: 'room_message', ref: `room:${i}`, at: i }));
    const once = mergeCauses([many]);
    const twice = mergeCauses([once, [plainCause('alert')]]);
    expect(twice).toHaveLength(CAUSES_MAX);
    expect(twice[7]).toMatchObject({ kind: 'other', ref: 'truncated' });
  });

  it('null when nothing is left', () => {
    expect(mergeCauses([])).toBeNull();
    expect(mergeCauses([null, [], undefined])).toBeNull();
    expect(mergeCauses(null)).toBeNull();
    expect(mergeCauses(undefined)).toBeNull();
  });
});

describe('queueCauses', () => {
  it('collects the causes of queued entries, in order, skipping entries without one', () => {
    const c1 = userMessageCause('c', 1);
    const c2 = roomMessageCause('r');
    expect(queueCauses([{ text: 'a', cause: c1 }, { text: 'b' }, { text: 'c', cause: c2 }])).toEqual([c1, c2]);
  });

  it('null when no entry has a cause', () => {
    expect(queueCauses([{ text: 'a' }, { text: 'b' }])).toBeNull();
    expect(queueCauses([])).toBeNull();
    expect(queueCauses(null)).toBeNull();
    expect(queueCauses([null])).toBeNull();
  });
});

describe('tagCauses', () => {
  it('attaches the merged causes to a blocks array without them showing in JSON or iteration', () => {
    const c1 = userMessageCause('c', 1);
    const entry = tagCauses([{ type: 'text', text: 'a' }], [c1]);
    expect(entry.cause).toEqual([c1]);
    expect(JSON.stringify(entry)).toBe('[{"type":"text","text":"a"}]');
    expect(Object.keys(entry)).toEqual(['0']);
    expect(queueCauses([entry, tagCauses([{ type: 'text', text: 'b' }], [roomMessageCause('r')])])).toEqual([c1, roomMessageCause('r')]);
  });

  it('a send with no causes leaves the entry untagged', () => {
    const entry = tagCauses([{ type: 'text', text: 'a' }], null);
    expect(entry.cause).toBeUndefined();
    expect(tagCauses([{ type: 'text', text: 'a' }], []).cause).toBeUndefined();
  });

  it('re-tagging replaces the earlier causes', () => {
    const entry = tagCauses([], [plainCause('reminder')]);
    tagCauses(entry, [plainCause('alert')]);
    expect(entry.cause.map((c) => c.kind)).toEqual(['alert']);
  });
});

describe('tappedAction', () => {
  it('the tap label on the comment, or under comment.meta from an older journal', () => {
    expect(tappedAction({ action: 'Merge' })).toBe('Merge');
    expect(tappedAction({ meta: { action: 'Go' } })).toBe('Go');
  });

  it('null for a typed reply, a blank label or no comment', () => {
    expect(tappedAction({ body: 'x' })).toBeNull();
    expect(tappedAction({ action: '   ' })).toBeNull();
    expect(tappedAction(null)).toBeNull();
    expect(tappedAction({ meta: 'x' })).toBeNull();
  });
});

describe('turn state', () => {
  it('beginTurn records merged causes and the start time; causesForAsk reads them', () => {
    const s = {};
    const c = userMessageCause('c', 7);
    beginTurn(s, [c, c]);
    expect(s.currentTurn).toEqual({ causes: [c], startedAt: NOW });
    expect(causesForAsk(s)).toEqual([c]);
  });

  it('beginTurn with no causes leaves causes null', () => {
    const s = {};
    beginTurn(s, null);
    expect(s.currentTurn).toEqual({ causes: null, startedAt: NOW });
    expect(causesForAsk(s)).toBeNull();
    beginTurn(s, []);
    expect(s.currentTurn.causes).toBeNull();
  });

  it('endTurn clears the turn; causesForAsk is then null', () => {
    const s = {};
    beginTurn(s, [plainCause('alert')]);
    endTurn(s);
    expect(s.currentTurn).toBeNull();
    expect(causesForAsk(s)).toBeNull();
  });

  it('causesForAsk is null for a session that never began a turn', () => {
    expect(causesForAsk({})).toBeNull();
    expect(causesForAsk(null)).toBeNull();
  });
});

describe('mergeTurnCauses', () => {
  const u = { kind: 'user_message', ref: 'c:1', at: 1 };
  const r = { kind: 'room_message', ref: 'room:x', at: 2 };

  it('keeps the existing causes first and adds the incoming ones', () => {
    expect(mergeTurnCauses([r], [u])).toEqual([r, u]);
    expect(mergeTurnCauses([u, r], [u])).toEqual([u, r]);
  });

  it('a side with no causes counts as other, so unknown origin is never dropped', () => {
    expect(mergeTurnCauses(null, [u])).toEqual([{ kind: 'other', at: NOW }, u]);
    expect(mergeTurnCauses([u], null)).toEqual([u, { kind: 'other', at: NOW }]);
    expect(mergeTurnCauses(null, null)).toEqual([{ kind: 'other', at: NOW }]);
    expect(mergeTurnCauses([], [u])).toEqual([{ kind: 'other', at: NOW }, u]);
    expect(mergeTurnCauses([u], [])).toEqual([u, { kind: 'other', at: NOW }]);
  });

  it('never drops an untrusted existing cause for a trusted incoming one', () => {
    const out = mergeTurnCauses([r, plainCause('other')], [u]);
    expect(out.map((c) => c.kind)).toEqual(['room_message', 'other', 'user_message']);
  });
});

describe('mergeIntoTurn', () => {
  const u = { kind: 'user_message', ref: 'c:1', at: 1 };
  const r = { kind: 'room_message', ref: 'room:x', at: 2 };

  it('merges into the running turn, keeping its start time', () => {
    const s = { currentTurn: { causes: [r], startedAt: 5 } };
    mergeIntoTurn(s, [u]);
    expect(s.currentTurn).toEqual({ causes: [r, u], startedAt: 5 });
  });

  it('a session with no turn gets one whose causes start with other', () => {
    const s = {};
    mergeIntoTurn(s, [u]);
    expect(s.currentTurn).toEqual({ causes: [{ kind: 'other', at: NOW }, u], startedAt: NOW });
  });

  it('incoming none adds other, never clears', () => {
    const s = { currentTurn: { causes: [u], startedAt: 5 } };
    mergeIntoTurn(s, null);
    expect(s.currentTurn.causes.map((c) => c.kind)).toEqual(['user_message', 'other']);
  });
});

describe('beginOrJoinTurn', () => {
  const u = { kind: 'user_message', ref: 'c:1', at: 1 };
  const r = { kind: 'room_message', ref: 'room:x', at: 2 };

  it('an idle session with no turn begins one with the causes, and says it did', () => {
    const s = { busy: false, currentTurn: null };
    expect(beginOrJoinTurn(s, [u])).toBe(true);
    expect(s.currentTurn).toEqual({ causes: [u], startedAt: NOW });
    // Setting busy is the caller's, after the call.
    expect(s.busy).toBe(false);
  });

  it('a fresh turn with no causes has none (the same shape as beginTurn)', () => {
    const s = { busy: false };
    expect(beginOrJoinTurn(s, null)).toBe(true);
    expect(s.currentTurn).toEqual({ causes: null, startedAt: NOW });
  });

  it('an idle session still holding a turn merges into it, even with no causes', () => {
    const s = { busy: false, currentTurn: { causes: [r], startedAt: 5 } };
    expect(beginOrJoinTurn(s, [u])).toBe(false);
    expect(s.currentTurn).toEqual({ causes: [r, u], startedAt: 5 });
    expect(beginOrJoinTurn(s, null)).toBe(false);
    expect(s.currentTurn.causes.map((c) => c.kind)).toEqual(['room_message', 'user_message', 'other']);
  });

  it('a busy session gains causes only when there are some, and never begins a turn', () => {
    const s = { busy: true, currentTurn: { causes: [r], startedAt: 5 } };
    expect(beginOrJoinTurn(s, null)).toBe(false);
    expect(s.currentTurn).toEqual({ causes: [r], startedAt: 5 });
    expect(beginOrJoinTurn(s, [u])).toBe(false);
    expect(s.currentTurn).toEqual({ causes: [r, u], startedAt: 5 });
  });
});

describe('joinHeldTurn', () => {
  const u = { kind: 'user_message', ref: 'c:1', at: 1 };
  const r = { kind: 'room_message', ref: 'room:x', at: 2 };

  it('a live plan hook: the approval\'s causes merge into the turn it blocks', () => {
    const s = { busy: true, currentTurn: { causes: [r], startedAt: 5 } };
    expect(joinHeldTurn(s, [u])).toBe(true);
    expect(s.currentTurn).toEqual({ causes: [r, u], startedAt: 5 });
  });

  it('a stale plan decision on an idle session with no turn leaves no turn behind', () => {
    const s = { busy: false, currentTurn: null };
    expect(joinHeldTurn(s, [u])).toBe(false);
    expect(s.currentTurn).toBeNull();
    // …so the next send begins a fresh turn with its own causes instead of
    // merging into a dangling user-caused one.
    expect(beginOrJoinTurn(s, [r])).toBe(true);
    expect(s.currentTurn.causes).toEqual([r]);
  });

  it('no causes changes nothing, with or without a turn', () => {
    const held = { currentTurn: { causes: [r], startedAt: 5 } };
    expect(joinHeldTurn(held, null)).toBe(false);
    expect(held.currentTurn).toEqual({ causes: [r], startedAt: 5 });
    const none = {};
    expect(joinHeldTurn(none, null)).toBe(false);
    expect(none.currentTurn).toBeUndefined();
  });
});
