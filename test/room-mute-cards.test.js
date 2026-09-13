import { describe, it, expect } from 'vitest';
import { createRoomMuteCards } from '../lib/room-mute-cards.js';

// The 🔊 Unmute card's identity registry. Same shape of problem the
// queued_release cards solved (lib/journal-input-router.js queueRelease): the
// card is published before its journal seq exists, the seq only arrives on the
// bridge's own echo, and a card can be retired by something OTHER than a tap
// (here: the agent calling agent_chat_unmute itself). A tap after that must be
// classified as a retired card and answered honestly — never fall through to
// "unmuted!" for a room nobody is muting any more.

const CARD = { promptId: 'pr_1', roomId: 'room-1', sessionKey: '!sess' };

describe('createRoomMuteCards', () => {
  it('an unseen seq is unknown — ordinary prompt replies are not our business', () => {
    const cards = createRoomMuteCards();
    expect(cards.classifyBySeq('convo-1', 41)).toEqual({ state: 'unknown' });
  });

  it('goes live once the bridge sees its own card echo carry a seq', () => {
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    // Reserved but not yet echoed: no seq exists, so nothing classifies.
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'unknown' });
    cards.annotateSeq('convo-1', 42, 'pr_1');
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({
      state: 'live',
      entry: { promptId: 'pr_1', roomId: 'room-1', sessionKey: '!sess', seq: 42 },
    });
  });

  it('a seq the bridge never reserved is ignored (provenance, not shape)', () => {
    const cards = createRoomMuteCards();
    cards.annotateSeq('convo-1', 42, 'pr_forged');
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'unknown' });
  });

  it('retiring by (room, session) tombstones the seq — a later tap is retired, not live', () => {
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    cards.annotateSeq('convo-1', 42, 'pr_1');
    expect(cards.retire('room-1', '!sess')).toMatchObject({ promptId: 'pr_1', seq: 42, convoId: 'convo-1' });
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'retired' });
    // Idempotent: retiring again finds nothing live and says so.
    expect(cards.retire('room-1', '!sess')).toBeNull();
  });

  it('a tap retires the card too, so a double-tap cannot be actioned twice', () => {
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    cards.annotateSeq('convo-1', 42, 'pr_1');
    expect(cards.retireBySeq('convo-1', 42)).toMatchObject({ roomId: 'room-1', sessionKey: '!sess' });
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'retired' });
    expect(cards.retireBySeq('convo-1', 42)).toBeNull();
  });

  it('REGRESSION: a card retired BEFORE its echo lands never becomes live', () => {
    // agent_chat_unmute can beat the journal round-trip. Without the
    // prompt-level tombstone the late annotateSeq would resurrect a card for a
    // room that is no longer muted — tapping it would report an unmute that
    // did not happen.
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    expect(cards.retire('room-1', '!sess')).toMatchObject({ promptId: 'pr_1', seq: null });
    cards.annotateSeq('convo-1', 42, 'pr_1');
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'retired' });
  });

  it('one live card per (room, session): re-muting supersedes the old one', () => {
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    cards.annotateSeq('convo-1', 42, 'pr_1');
    cards.note('convo-1', { promptId: 'pr_2', roomId: 'room-1', sessionKey: '!sess' });
    cards.annotateSeq('convo-1', 43, 'pr_2');
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'retired' });
    expect(cards.classifyBySeq('convo-1', 43).state).toBe('live');
  });

  it('keeps rooms and sessions apart', () => {
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    cards.annotateSeq('convo-1', 42, 'pr_1');
    expect(cards.retire('room-2', '!sess')).toBeNull();
    expect(cards.retire('room-1', '!other')).toBeNull();
    expect(cards.classifyBySeq('convo-1', 42).state).toBe('live');
    // …and convos: a seq is only meaningful within its own conversation.
    expect(cards.classifyBySeq('convo-2', 42)).toEqual({ state: 'unknown' });
  });

  it('session teardown evicts the convo entirely', () => {
    const cards = createRoomMuteCards();
    cards.note('convo-1', CARD);
    cards.annotateSeq('convo-1', 42, 'pr_1');
    cards.evict('convo-1');
    expect(cards.classifyBySeq('convo-1', 42)).toEqual({ state: 'unknown' });
    expect(cards.retire('room-1', '!sess')).toBeNull();
  });

  it('bounds growth: a long-lived convo drops its oldest tombstones', () => {
    const cards = createRoomMuteCards({ retention: 3 });
    for (let i = 1; i <= 5; i++) {
      cards.note('convo-1', { promptId: `pr_${i}`, roomId: `room-${i}`, sessionKey: '!sess' });
      cards.annotateSeq('convo-1', 100 + i, `pr_${i}`);
      cards.retireBySeq('convo-1', 100 + i);
    }
    expect(cards.classifyBySeq('convo-1', 101)).toEqual({ state: 'unknown' });
    expect(cards.classifyBySeq('convo-1', 105)).toEqual({ state: 'retired' });
  });
});
