import { describe, it, expect, vi } from 'vitest';
import { createAgentRooms, INVITE_TTL_MS } from '../lib/agent-rooms.js';

// No fs fake needed: the registry takes plain load/save functions, so tests
// record calls directly and round-trip persistence through the save payload.
function makeStore({ initial, load, save } = {}) {
  const saveFn = save ?? vi.fn();
  const loadFn = load ?? (() => initial);
  const rooms = createAgentRooms({ load: loadFn, save: saveFn, log: { warn: () => {} } });
  return { rooms, save: saveFn };
}

const REC = { role: 'owner', state: 'pending', sessionRoomId: '!sess1' };

describe('createAgentRooms', () => {
  it('starts empty with no load/save injected and never throws', () => {
    const rooms = createAgentRooms({ log: { warn: () => {} } });
    expect(rooms.list()).toEqual([]);
    rooms.record('r1', REC); // save is optional too
    expect(rooms.get('r1')).toMatchObject(REC);
  });

  it('round-trips record/get/list', () => {
    const { rooms } = makeStore();
    const rec = rooms.record('r1', {
      role: 'guest', state: 'joined', sessionRoomId: '!sess1',
      peerDeviceId: 7, peerName: 'matron-dev-2', topic: 'ci triage', title: 'CI triage',
    });
    expect(rec).toMatchObject({
      role: 'guest', state: 'joined', sessionRoomId: '!sess1',
      peerDeviceId: 7, peerName: 'matron-dev-2', topic: 'ci triage', title: 'CI triage',
    });
    expect(rec.createdAt).toBeTypeOf('number');
    expect(rec.updatedAt).toBeTypeOf('number');
    expect(rooms.get('r1')).toEqual(rec);
    expect(rooms.get('nope')).toBeNull();
    expect(rooms.list()).toEqual([{ roomId: 'r1', ...rec }]);
  });

  it('defaults optional fields to null and preserves createdAt on re-record', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { rooms } = makeStore();
      const first = rooms.record('r1', REC);
      expect(first).toMatchObject({ peerDeviceId: null, peerName: null, topic: null, title: null });
      expect(first.createdAt).toBe(1000);
      vi.setSystemTime(2000);
      const second = rooms.record('r1', { ...REC, state: 'joined' });
      expect(second.createdAt).toBe(1000);
      expect(second.updatedAt).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes from a loaded snapshot', () => {
    const { rooms } = makeStore({ initial: { r1: { ...REC, createdAt: 1, updatedAt: Date.now() } } });
    expect(rooms.get('r1')).toMatchObject(REC);
  });

  it('prunes non-joined entries past the invite TTL at load; joined and fresh entries survive', () => {
    const now = Date.now();
    const stale = now - INVITE_TTL_MS - 1;
    const { rooms } = makeStore({
      initial: {
        oldPending: { ...REC, state: 'pending', createdAt: stale, updatedAt: stale },
        oldLeft: { ...REC, state: 'left', createdAt: stale, updatedAt: stale },
        oldRefused: { ...REC, state: 'refused', createdAt: stale, updatedAt: stale },
        oldExpired: { ...REC, state: 'expired', createdAt: stale, updatedAt: stale },
        noStamp: { ...REC, state: 'pending' }, // missing updatedAt counts as 0 → stale
        oldJoined: { ...REC, state: 'joined', createdAt: stale, updatedAt: stale },
        freshPending: { ...REC, state: 'pending', createdAt: now, updatedAt: now },
        freshLeft: { ...REC, state: 'left', createdAt: now, updatedAt: now },
      },
    });
    expect(rooms.list().map((r) => r.roomId).sort()).toEqual(['freshLeft', 'freshPending', 'oldJoined']);
  });

  it('partial re-record keeps previously recorded peer fields', () => {
    const { rooms } = makeStore();
    rooms.record('r1', {
      role: 'owner', state: 'pending', sessionRoomId: '!sess1',
      peerDeviceId: 7, peerName: 'matron-dev-2', topic: 'ci triage', title: 'CI triage',
    });
    // Task 7's join path re-records with only role/state/sessionRoomId.
    const rec = rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!sess1' });
    expect(rec).toMatchObject({
      role: 'owner', state: 'joined', sessionRoomId: '!sess1',
      peerDeviceId: 7, peerName: 'matron-dev-2', topic: 'ci triage', title: 'CI triage',
    });
  });

  it('record with an explicit null clears a peer field; undefined leaves it alone', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { ...REC, peerName: 'matron-dev-2' });
    expect(rooms.record('r1', { ...REC, peerName: null }).peerName).toBeNull();
  });

  it('drops malformed persisted entries so forSession stays safe', () => {
    const { rooms } = makeStore({
      initial: {
        r1: null,
        r2: 'junk',
        r3: { role: 'owner', state: 'joined' }, // no sessionRoomId
        r4: [REC],
        ok: { ...REC, createdAt: 1, updatedAt: Date.now() },
      },
    });
    expect(() => rooms.forSession('!sess1')).not.toThrow();
    expect(rooms.list().map((r) => r.roomId)).toEqual(['ok']);
    expect(rooms.get('r1')).toBeNull();
  });

  it('treats wire-derived room ids as plain keys (no prototype pollution or inherited hits)', () => {
    const { rooms } = makeStore();
    rooms.record('__proto__', REC);
    expect(rooms.get('__proto__')).toMatchObject(REC);
    expect(rooms.isActive('__proto__')).toBe(true);
    expect(rooms.list().map((r) => r.roomId)).toEqual(['__proto__']);
    expect({}.role).toBeUndefined(); // Object.prototype untouched
    expect(rooms.get('toString')).toBeNull();
    expect(rooms.isActive('hasOwnProperty')).toBe(false);
  });

  it('returned records are isolated copies of internal state', () => {
    const { rooms } = makeStore();
    const fromRecord = rooms.record('r1', REC);
    fromRecord.state = 'hacked';
    expect(rooms.get('r1').state).toBe('pending');
    const got = rooms.get('r1');
    got.sessionRoomId = '!hijacked';
    expect(rooms.get('r1').sessionRoomId).toBe('!sess1');
    const fromSetState = rooms.setState('r1', 'joined');
    fromSetState.state = 'hacked';
    expect(rooms.get('r1').state).toBe('joined');
  });

  it.each([
    ['load throws', () => { throw new Error('corrupt'); }],
    ['load returns null', () => null],
    ['load returns an array', () => ['r1']],
    ['load returns a string', () => 'not a map'],
  ])('starts empty when %s', (_name, load) => {
    const { rooms } = makeStore({ load });
    expect(rooms.list()).toEqual([]);
  });

  it('setState updates state + updatedAt on a known room', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);
    const updated = rooms.setState('r1', 'joined');
    expect(updated).toMatchObject({ ...REC, state: 'joined' });
    expect(rooms.get('r1').state).toBe('joined');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('setState on an unknown id returns null and does not persist', () => {
    const { rooms, save } = makeStore();
    expect(rooms.setState('ghost', 'joined')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('setState rejects unknown states', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);
    save.mockClear();
    expect(rooms.setState('r1', 'banana')).toBeNull();
    expect(rooms.get('r1').state).toBe('pending');
    expect(save).not.toHaveBeenCalled();
  });

  it.each(['refused', 'left', 'expired'])('setState cannot resurrect a %s room', (terminal) => {
    const { rooms, save } = makeStore();
    rooms.record('r1', { ...REC, state: terminal });
    save.mockClear();
    expect(rooms.setState('r1', 'joined')).toBeNull();
    expect(rooms.get('r1').state).toBe(terminal);
    expect(save).not.toHaveBeenCalled();
  });

  it('record() renews a terminal room (re-invite is not blocked by the terminal guard)', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { ...REC, state: 'refused' });
    expect(rooms.record('r1', { ...REC, state: 'pending' }).state).toBe('pending');
    expect(rooms.isActive('r1')).toBe(true);
    expect(rooms.setState('r1', 'joined').state).toBe('joined');
  });

  it.each([
    ['pending', true],
    ['joined', true],
    ['refused', false],
    ['left', false],
    ['expired', false],
  ])('isActive: state %s -> %s', (state, expected) => {
    const { rooms } = makeStore();
    rooms.record('r1', { ...REC, state });
    expect(rooms.isActive('r1')).toBe(expected);
  });

  it('isActive is false for an unknown room', () => {
    const { rooms } = makeStore();
    expect(rooms.isActive('ghost')).toBe(false);
  });

  it('isActive is false when state is missing entirely', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'owner', sessionRoomId: '!sess1' });
    expect(rooms.isActive('r1')).toBe(false);
  });

  it('isActive: a pending room goes stale after INVITE_TTL_MS; joined never does', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const { rooms } = makeStore();
      rooms.record('r1', REC); // pending
      rooms.record('r2', { ...REC, state: 'joined' });
      vi.setSystemTime(1000 + INVITE_TTL_MS - 1);
      expect(rooms.isActive('r1')).toBe(true);
      vi.setSystemTime(1000 + INVITE_TTL_MS);
      expect(rooms.isActive('r1')).toBe(false);
      expect(rooms.isActive('r2')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forSession returns only rooms bound to that session, with roomId', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!a' });
    rooms.record('r2', { role: 'guest', state: 'pending', sessionRoomId: '!b' });
    rooms.record('r3', { role: 'owner', state: 'left', sessionRoomId: '!a' });
    const forA = rooms.forSession('!a');
    expect(forA.map((r) => r.roomId).sort()).toEqual(['r1', 'r3']);
    expect(forA.every((r) => r.sessionRoomId === '!a')).toBe(true);
    expect(rooms.forSession('!nobody')).toEqual([]);
  });

  it('remove deletes a known room (true) and persists; unknown id is a no-op (false)', () => {
    const { rooms, save } = makeStore();
    rooms.record('r1', REC);
    save.mockClear();
    expect(rooms.remove('r1')).toBe(true);
    expect(rooms.get('r1')).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    expect(rooms.remove('ghost')).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing save (and a throwing logger) on every mutation', () => {
    const save = vi.fn(() => { throw new Error('disk full'); });
    const rooms = createAgentRooms({ load: () => ({}), save, log: { warn: () => { throw new Error('log broke'); } } });
    expect(() => {
      rooms.record('r1', REC);
      rooms.setState('r1', 'joined');
      rooms.remove('r1');
    }).not.toThrow();
    expect(save).toHaveBeenCalledTimes(3);
  });

  it('persists on every mutation with the state as of that call', () => {
    // structuredClone each payload: the live map would make every recorded
    // call "see" only the final state and mask stale/aliased saves.
    const snapshots = [];
    const save = vi.fn((snapshot) => snapshots.push(structuredClone(snapshot)));
    const rooms = createAgentRooms({ load: () => ({}), save, log: { warn: () => {} } });
    rooms.record('r1', REC);                                 // 1
    rooms.record('r2', { ...REC, sessionRoomId: '!other' }); // 2
    rooms.setState('r1', 'joined');                          // 3
    rooms.remove('r2');                                      // 4
    expect(save).toHaveBeenCalledTimes(4);
    expect(Object.keys(snapshots[0])).toEqual(['r1']);
    expect(snapshots[0].r1.state).toBe('pending');
    expect(Object.keys(snapshots[1]).sort()).toEqual(['r1', 'r2']);
    expect(snapshots[2].r1.state).toBe('joined');
    expect(snapshots[2].r2.sessionRoomId).toBe('!other');
    expect(Object.keys(snapshots[3])).toEqual(['r1']);
    expect(snapshots[3].r1).toMatchObject({ ...REC, state: 'joined' });
  });
});

// Guest bindings: a same-bridge room's second local participant, held in
// guestSessionRoomId/guestState on the SAME record as the owner binding.
describe('guest bindings (local rooms)', () => {
  const LOCAL = { role: 'owner', state: 'pending', sessionRoomId: '!owner', guestSessionRoomId: '!guest', guestState: 'pending' };

  it('records and reports both bindings', () => {
    const { rooms } = makeStore();
    rooms.record('r1', LOCAL);
    expect(rooms.bindingFor('r1', '!owner')).toEqual({ role: 'owner', state: 'pending', binding: 'primary' });
    expect(rooms.bindingFor('r1', '!guest')).toEqual({ role: 'guest', state: 'pending', binding: 'guest' });
    expect(rooms.bindingFor('r1', '!stranger')).toBeNull();
    expect(rooms.bindingFor('r-ghost', '!owner')).toBeNull();
  });

  it('remote rooms have a null guest binding and bindingFor stays primary-only', () => {
    const { rooms } = makeStore();
    rooms.record('r1', REC);
    expect(rooms.get('r1').guestSessionRoomId).toBeNull();
    expect(rooms.bindingFor('r1', '!sess1')).toEqual({ role: 'owner', state: 'pending', binding: 'primary' });
  });

  it('setGuestState flips only the guest side, with the same terminal discipline as setState', () => {
    const { rooms } = makeStore();
    rooms.record('r1', LOCAL);
    expect(rooms.setGuestState('r1', 'joined')).toMatchObject({ guestState: 'joined', state: 'pending' });
    expect(rooms.setGuestState('r1', 'left')).toMatchObject({ guestState: 'left' });
    // Terminal: a late answer must not resurrect it.
    expect(rooms.setGuestState('r1', 'joined')).toBeNull();
    expect(rooms.get('r1').guestState).toBe('left');
    // No guest binding -> no-op.
    rooms.record('r2', REC);
    expect(rooms.setGuestState('r2', 'joined')).toBeNull();
    // Bogus state -> no-op.
    rooms.record('r3', LOCAL);
    expect(rooms.setGuestState('r3', 'bogus')).toBeNull();
  });

  it('forSession reports the guest binding with role/state substituted', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { ...LOCAL, guestState: 'joined' });
    rooms.record('r2', REC);
    expect(rooms.forSession('!owner')).toEqual([expect.objectContaining({ roomId: 'r1', role: 'owner', state: 'pending', binding: 'primary' })]);
    expect(rooms.forSession('!guest')).toEqual([expect.objectContaining({ roomId: 'r1', role: 'guest', state: 'joined', binding: 'guest', guestSessionRoomId: '!guest' })]);
    expect(rooms.forSession('!sess1')).toEqual([expect.objectContaining({ roomId: 'r2', binding: 'primary' })]);
  });

  it('guest fields survive a partial re-record and a persistence round-trip', () => {
    const save = vi.fn();
    const { rooms } = makeStore({ save });
    rooms.record('r1', LOCAL);
    rooms.record('r1', { state: 'joined' }); // partial: guest fields untouched
    expect(rooms.get('r1')).toMatchObject({ state: 'joined', guestSessionRoomId: '!guest', guestState: 'pending' });
    const persisted = save.mock.calls.at(-1)[0];
    const { rooms: reloaded } = makeStore({ initial: persisted });
    expect(reloaded.bindingFor('r1', '!guest')).toEqual({ role: 'guest', state: 'pending', binding: 'guest' });
  });
});

// Reuse-first chatStart (2026-08-19): one persistent room per session pair.
// The registry is the only thing that can answer "do these two already have a
// live room?", so the lookup lives here rather than being re-derived by every
// caller out of list().
describe('findLivePair (reuse-first lookup)', () => {
  const REMOTE = {
    role: 'owner', state: 'joined', sessionRoomId: '!sess1',
    peerDeviceId: 7, targetConvoId: 'convo-remote',
  };

  it('finds a joined remote room for the same (session, device, target convo)', () => {
    const { rooms } = makeStore();
    rooms.record('r1', REMOTE);
    expect(rooms.findLivePair('!sess1', { peerDeviceId: 7, targetConvoId: 'convo-remote' }))
      .toMatchObject({ roomId: 'r1' });
  });

  it('does not cross pairs: a different target convo or device is a different room', () => {
    const { rooms } = makeStore();
    rooms.record('r1', REMOTE);
    expect(rooms.findLivePair('!sess1', { peerDeviceId: 7, targetConvoId: 'convo-other' })).toBeNull();
    expect(rooms.findLivePair('!sess1', { peerDeviceId: 9, targetConvoId: 'convo-remote' })).toBeNull();
    // …and a different CALLER session never reuses someone else's room.
    expect(rooms.findLivePair('!sess2', { peerDeviceId: 7, targetConvoId: 'convo-remote' })).toBeNull();
  });

  it('never resurrects a terminal room — left, refused and expired are all skipped', () => {
    for (const state of ['left', 'refused', 'expired']) {
      const { rooms } = makeStore();
      rooms.record('r1', { ...REMOTE, state });
      expect(rooms.findLivePair('!sess1', { peerDeviceId: 7, targetConvoId: 'convo-remote' })).toBeNull();
    }
  });

  it('a still-pending invite counts as live only inside the invite TTL (the reaper prunes the rest)', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { ...REMOTE, state: 'pending' });
    expect(rooms.findLivePair('!sess1', { peerDeviceId: 7, targetConvoId: 'convo-remote' }))
      .toMatchObject({ roomId: 'r1' });
    // Past the TTL the reaper would have dropped it at the next load, so it
    // must not be handed back as reusable in memory either.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(INVITE_TTL_MS + 1);
      expect(rooms.findLivePair('!sess1', { peerDeviceId: 7, targetConvoId: 'convo-remote' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('rooms recorded before targetConvoId existed are never reused (fail safe)', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!sess1', peerDeviceId: 7 });
    expect(rooms.findLivePair('!sess1', { peerDeviceId: 7, targetConvoId: 'convo-remote' })).toBeNull();
  });

  it('a LOCAL room matches from either end, and only while BOTH bindings are live', () => {
    const { rooms } = makeStore();
    rooms.record('r1', {
      role: 'owner', state: 'joined', sessionRoomId: '!owner',
      guestSessionRoomId: '!guest', guestState: 'joined',
      peerDeviceId: 1, targetConvoId: 'convo-guest',
    });
    const q = { peerDeviceId: 1, targetConvoId: 'convo-guest', peerSessionRoomId: '!guest' };
    expect(rooms.findLivePair('!owner', q)).toMatchObject({ roomId: 'r1' });
    // The guest leaving kills reuse for the owner too — the room is dead.
    rooms.setGuestState('r1', 'left');
    expect(rooms.findLivePair('!owner', q)).toBeNull();
  });

  it('a LOCAL room whose other binding is a DIFFERENT session is not this pair', () => {
    const { rooms } = makeStore();
    rooms.record('r1', {
      role: 'owner', state: 'joined', sessionRoomId: '!owner',
      guestSessionRoomId: '!someone-else', guestState: 'joined',
      peerDeviceId: 1, targetConvoId: 'convo-guest',
    });
    expect(rooms.findLivePair('!owner', { peerDeviceId: 1, targetConvoId: 'convo-guest', peerSessionRoomId: '!guest' })).toBeNull();
  });
});

// Per-side mute (2026-08-19). Mute is purely local to this bridge: it stops
// room frames reaching ONE member's session. It rides on the registry record
// so it inherits exactly the registry's durability — nothing new invented.
describe('mute bindings', () => {
  const LOCAL_PAIR = {
    role: 'owner', state: 'joined', sessionRoomId: '!owner',
    guestSessionRoomId: '!guest', guestState: 'joined',
  };

  it('mutes the CALLER\'s side only, and reports it per binding', () => {
    const { rooms } = makeStore();
    rooms.record('r1', LOCAL_PAIR);
    expect(rooms.isMuted('r1', '!owner')).toBe(false);
    expect(rooms.setMuted('r1', '!owner', true, { reason: 'peer is looping' })).toMatchObject({ muted: true, mutedReason: 'peer is looping' });
    expect(rooms.isMuted('r1', '!owner')).toBe(true);
    expect(rooms.isMuted('r1', '!guest')).toBe(false);
    // …and the guest side is its own switch.
    rooms.setMuted('r1', '!guest', true, { reason: 'spamming' });
    expect(rooms.get('r1')).toMatchObject({ muted: true, guestMuted: true, guestMutedReason: 'spamming' });
    expect(rooms.setMuted('r1', '!owner', false)).toMatchObject({ muted: false, mutedReason: null });
    expect(rooms.isMuted('r1', '!owner')).toBe(false);
    expect(rooms.isMuted('r1', '!guest')).toBe(true);
  });

  it('refuses a room or a session it has no binding for', () => {
    const { rooms } = makeStore();
    rooms.record('r1', LOCAL_PAIR);
    expect(rooms.setMuted('nope', '!owner', true)).toBeNull();
    expect(rooms.setMuted('r1', '!stranger', true)).toBeNull();
    expect(rooms.isMuted('nope', '!owner')).toBe(false);
    expect(rooms.isMuted('r1', '!stranger')).toBe(false);
  });

  it('survives whatever durability the registry has (persistence round-trip)', () => {
    const save = vi.fn();
    const { rooms } = makeStore({ save });
    rooms.record('r1', { role: 'guest', state: 'joined', sessionRoomId: '!sess1' });
    rooms.setMuted('r1', '!sess1', true, { reason: 'malfunctioning' });
    const persisted = save.mock.calls.at(-1)[0];
    const { rooms: reloaded } = makeStore({ initial: persisted });
    expect(reloaded.isMuted('r1', '!sess1')).toBe(true);
    expect(reloaded.get('r1').mutedReason).toBe('malfunctioning');
  });

  it('a partial re-record does not clear a mute', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'guest', state: 'pending', sessionRoomId: '!sess1' });
    rooms.setMuted('r1', '!sess1', true, { reason: 'why' });
    rooms.record('r1', { state: 'joined' });
    expect(rooms.isMuted('r1', '!sess1')).toBe(true);
  });
});

// I1 (whole-branch review): `updatedAt` is bumped by ANY write to the record —
// the other binding's setState, a setMuted, a partial re-record — so judging a
// pending binding's age by it means a stale invite looks fresh forever. Rooms
// carry a per-binding pending stamp instead.
describe('findLivePair pending freshness is per binding', () => {
  it('a pending invite does not get fresher because the OTHER side was written', () => {
    const { rooms } = makeStore();
    rooms.record('r1', {
      role: 'owner', state: 'joined', sessionRoomId: '!owner',
      guestSessionRoomId: '!guest', guestState: 'pending',
    });
    const q = { peerSessionRoomId: '!owner', targetConvoId: 'convo-x' };
    expect(rooms.findLivePair('!guest', q)).toMatchObject({ roomId: 'r1' });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(INVITE_TTL_MS + 1);
      // A write that has nothing to do with the invite — muting the owner side.
      rooms.setMuted('r1', '!owner', true, { reason: 'noisy' });
      expect(rooms.get('r1').updatedAt).toBe(Date.now());
      // The guest's invite is still stale: nothing answered it.
      expect(rooms.findLivePair('!guest', q)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a fresh pending stamp is written each time a binding re-enters pending', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'owner', state: 'pending', sessionRoomId: '!owner', peerDeviceId: 7, targetConvoId: 'convo-x' });
    const q = { peerDeviceId: 7, targetConvoId: 'convo-x' };
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(INVITE_TTL_MS + 1);
      expect(rooms.findLivePair('!owner', q)).toBeNull();
      // A brand new invite for the same room restarts the clock.
      rooms.record('r1', { state: 'pending' });
      expect(rooms.findLivePair('!owner', q)).toMatchObject({ roomId: 'r1' });
    } finally { vi.useRealTimers(); }
  });

  it('legacy records with no pending stamp fall back to updatedAt', () => {
    // Written by a previous bridge version; must not become permanently
    // unreusable OR permanently live.
    const { rooms } = makeStore({ initial: { r1: {
      role: 'owner', state: 'pending', sessionRoomId: '!owner', peerDeviceId: 7,
      targetConvoId: 'convo-x', updatedAt: Date.now(), createdAt: Date.now(),
    } } });
    const q = { peerDeviceId: 7, targetConvoId: 'convo-x' };
    expect(rooms.findLivePair('!owner', q)).toMatchObject({ roomId: 'r1' });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(INVITE_TTL_MS + 1);
      expect(rooms.findLivePair('!owner', q)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a JOINED binding never expires — only pending ones are on a clock', () => {
    const { rooms } = makeStore();
    rooms.record('r1', { role: 'owner', state: 'joined', sessionRoomId: '!owner', peerDeviceId: 7, targetConvoId: 'convo-x' });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(INVITE_TTL_MS * 100);
      expect(rooms.findLivePair('!owner', { peerDeviceId: 7, targetConvoId: 'convo-x' })).toMatchObject({ roomId: 'r1' });
    } finally { vi.useRealTimers(); }
  });
});
