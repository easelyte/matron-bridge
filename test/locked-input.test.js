import { describe, it, expect, vi } from 'vitest';
import { createJournalInputConsumer } from '../lib/journal-input-router.js';
import { LOCKED_USER_LINE } from '../lib/box-lock.js';

const silent = { warn() {}, error() {} };
const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// A lock that is open for KEY and for peers when `open`, shut otherwise.
function lockOf(state) {
  return {
    verdict: (kind, keyId) => {
      if (!state.locked) return { ok: true };
      if (kind === 'user') return state.open && keyId === KEY ? { ok: true } : { ok: false, line: LOCKED_USER_LINE };
      return state.open ? { ok: true } : { ok: false, line: 'box-a is locked; ask the user to unlock it' };
    },
  };
}

function consumer(state, extra = {}) {
  const session = { roomId: '!s' };
  const calls = {
    text: vi.fn(), media: vi.fn(), item: vi.fn(), prompt: vi.fn(), control: vi.fn(), room: vi.fn(),
    resume: vi.fn(() => session), refused: vi.fn(), roomRefused: vi.fn(),
  };
  const onEvent = createJournalInputConsumer({
    isControlConvo: (id) => id === 'control',
    handleControlCommand: calls.control,
    findSessionByConvoId: (id) => (id === 'convo-1' ? session : null),
    resumeSessionForConvo: calls.resume,
    routeTextToSession: calls.text, routeMediaToSession: calls.media, routeItemToSession: calls.item, routePromptReply: calls.prompt,
    roomFor: (id) => (id === 'room-1' ? { roomId: 'room-1', peerName: 'box-b' } : null),
    routeRoomFrame: calls.room,
    selfAgentName: () => 'box-a', selfAgentDeviceId: () => 9,
    ownerName: () => 'alice',
    inputLock: state ? lockOf(state) : null,
    onInputRefused: calls.refused, onRoomRefused: calls.roomRefused,
    log: silent, ...extra,
  });
  return { onEvent, calls, session };
}
const frame = (o = {}) => ({ kind: 'journal', seq: 1, convo_id: 'convo-1', ts: 1, sender: 'user:alice', type: 'text', payload: { body: 'deploy it' }, ...o });
const peerFrame = (o = {}) => frame({ convo_id: 'room-1', sender: 'agent:box-b', sender_device_id: 3, payload: { body: 'run this' }, ...o });
const tap = (o = {}) => frame({ type: 'item', payload: { item_id: 'it_1', num: 7, title: 'Deploy?', action: 'commented', by: 'user', comment: { id: 'ic_1', body: 'Approve', action: 'Approve', ...o } } });

describe('a locked box, outside an unlock window', () => {
  const state = { locked: true, open: false };

  it("drops a user's message, posts the one line in that conversation, and neither queues nor wakes anything", () => {
    const { onEvent, calls } = consumer(state);
    onEvent(frame({ approval_key_id: KEY }));
    onEvent(frame({ convo_id: 'convo-asleep', approval_key_id: KEY }));
    expect(calls.text).not.toHaveBeenCalled();
    expect(calls.resume).not.toHaveBeenCalled();
    expect(calls.refused).toHaveBeenCalledTimes(2);
    expect(calls.refused.mock.calls[0]).toEqual(['convo-1', LOCKED_USER_LINE]);
  });

  it('drops files, voice notes, prompt replies and bridge commands the same way', () => {
    const { onEvent, calls } = consumer(state);
    onEvent(frame({ type: 'file', payload: { blob_ref: 'b1', name: 'run.sh' }, approval_key_id: KEY }));
    onEvent(frame({ type: 'prompt_reply', payload: { target_seq: 1, choice: 'yes' }, approval_key_id: KEY }));
    onEvent(frame({ convo_id: 'control', payload: { body: '!start' }, approval_key_id: KEY }));
    expect(calls.media).not.toHaveBeenCalled();
    expect(calls.prompt).not.toHaveBeenCalled();
    expect(calls.control).not.toHaveBeenCalled();
    expect(calls.refused).toHaveBeenCalledTimes(3);
  });

  it("refuses a peer's room message and answers in the room", () => {
    const { onEvent, calls } = consumer(state);
    onEvent(peerFrame());
    expect(calls.room).not.toHaveBeenCalled();
    expect(calls.roomRefused).toHaveBeenCalledTimes(1);
    expect(calls.roomRefused.mock.calls[0][0]).toMatchObject({ roomId: 'room-1' });
    expect(calls.roomRefused.mock.calls[0][2]).toBe('box-a is locked; ask the user to unlock it');
  });

  it('answers a room at most once in ten minutes, and never answers another locked box\'s own line', () => {
    let t = 1_000_000;
    const { onEvent, calls } = consumer(state, { now: () => t });
    onEvent(peerFrame());
    onEvent(peerFrame({ seq: 2 }));
    expect(calls.roomRefused).toHaveBeenCalledTimes(1);
    t += 10 * 60 * 1000;
    onEvent(peerFrame({ seq: 3, payload: { body: 'box-b is locked; ask the user to unlock it' } }));
    expect(calls.roomRefused).toHaveBeenCalledTimes(1);
    onEvent(peerFrame({ seq: 4 }));
    expect(calls.roomRefused).toHaveBeenCalledTimes(2);
    expect(calls.room).not.toHaveBeenCalled();
  });

  it("refuses the user's own message in a room as user input", () => {
    const { onEvent, calls } = consumer(state);
    onEvent(frame({ convo_id: 'room-1', approval_key_id: KEY }));
    expect(calls.room).not.toHaveBeenCalled();
    expect(calls.refused).toHaveBeenCalledWith('room-1', LOCKED_USER_LINE);
  });

  it('refuses a typed reply and an unsigned tap on an item', () => {
    const { onEvent, calls } = consumer(state, { verifySignedTap: vi.fn(async () => ({ ok: true })) });
    onEvent(tap());
    onEvent(frame({ type: 'item', payload: { item_id: 'it_1', num: 7, title: 'T', action: 'commented', by: 'user', comment: { id: 'ic_2', body: 'typed words' } } }));
    expect(calls.item).not.toHaveBeenCalled();
    expect(calls.refused).toHaveBeenCalledTimes(2);
  });

  it('delivers a signed tap that this box verified, whoever sent it', async () => {
    const verifySignedTap = vi.fn(async () => ({ ok: true, keyId: OTHER }));
    const { onEvent, calls } = consumer(state, { verifySignedTap });
    onEvent(tap({ signed: true, key_id: OTHER }));
    await vi.waitFor(() => expect(calls.item).toHaveBeenCalledTimes(1));
    // The router hands on the tap as verified, never a re-read of the frame.
    expect(calls.item.mock.calls[0][1].payload.comment.action).toBe('Approve');
    expect(verifySignedTap).toHaveBeenCalledTimes(1);
    expect(calls.refused).not.toHaveBeenCalled();
  });

  it('refuses a tap marked signed that does not verify here, or when there is nothing to verify with', async () => {
    const bad = consumer(state, { verifySignedTap: vi.fn(async () => ({ ok: false, reason: 'signature' })) });
    bad.onEvent(tap({ signed: true, key_id: KEY }));
    await vi.waitFor(() => expect(bad.calls.refused).toHaveBeenCalledTimes(1));
    expect(bad.calls.item).not.toHaveBeenCalled();
    const thrown = consumer(state, { verifySignedTap: vi.fn(async () => { throw new Error('boom'); }) });
    thrown.onEvent(tap({ signed: true, key_id: KEY }));
    await vi.waitFor(() => expect(thrown.calls.refused).toHaveBeenCalledTimes(1));
    const none = consumer(state);
    none.onEvent(tap({ signed: true, key_id: KEY }));
    expect(none.calls.item).not.toHaveBeenCalled();
    expect(none.calls.refused).toHaveBeenCalledTimes(1);
  });

  it("refuses another agent session's comment on an item as a peer, without a line in the user's chat", () => {
    const { onEvent, calls } = consumer(state);
    onEvent(frame({ sender: 'agent:box-b', type: 'item', payload: { item_id: 'it_1', num: 7, title: 'T', action: 'commented', agent_comment: true, origin_convo_id: 'convo-1', comment: { id: 'ic_3', body: 'do this', convo_id: 'other' } } }));
    expect(calls.item).not.toHaveBeenCalled();
  });
});

describe('a locked box, inside an unlock window', () => {
  const state = { locked: true, open: true };

  it("takes the unlocking device's message and refuses another device's and an unstamped one", () => {
    const { onEvent, calls } = consumer(state);
    onEvent(frame({ approval_key_id: KEY }));
    expect(calls.text).toHaveBeenCalledTimes(1);
    onEvent(frame({ seq: 2, approval_key_id: OTHER }));
    onEvent(frame({ seq: 3, approval_key_id: null }));
    onEvent(frame({ seq: 4 }));
    expect(calls.text).toHaveBeenCalledTimes(1);
    expect(calls.refused).toHaveBeenCalledTimes(3);
  });

  it('a key id inside the payload is not the stamp', () => {
    const { onEvent, calls } = consumer(state);
    onEvent(frame({ payload: { body: 'x', approval_key_id: KEY } }));
    expect(calls.text).not.toHaveBeenCalled();
  });

  it("delivers a peer's room message", () => {
    const { onEvent, calls } = consumer(state);
    onEvent(peerFrame());
    expect(calls.room).toHaveBeenCalledTimes(1);
    expect(calls.roomRefused).not.toHaveBeenCalled();
  });
});

describe('a box that is not locked', () => {
  it('routes everything as before, with the lock wired or not', () => {
    for (const state of [{ locked: false, open: false }, null]) {
      const { onEvent, calls } = consumer(state);
      onEvent(frame());
      onEvent(peerFrame());
      onEvent(tap());
      expect(calls.text).toHaveBeenCalledTimes(1);
      expect(calls.room).toHaveBeenCalledTimes(1);
      expect(calls.item).toHaveBeenCalledTimes(1);
      expect(calls.refused).not.toHaveBeenCalled();
    }
  });
});
