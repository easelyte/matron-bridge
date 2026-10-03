import { describe, it, expect } from 'vitest';
import { streamRefFor, armReplyRef, settleReplyRef } from '../lib/journal-stream.js';

describe('streamRefFor', () => {
  it('uses the message id itself as the ref on a fresh overlay', () => {
    expect(streamRefFor(null, null, 'msg_123')).toBe('msg_123');
  });

  it('reuses the same ref while the same message keeps streaming (deltas coalesce under one overlay)', () => {
    const first = streamRefFor(null, null, 'msg_A');
    expect(first).toBe('msg_A');
    // Subsequent partials of the same message keep the ref.
    expect(streamRefFor(first, 'msg_A', 'msg_A')).toBe('msg_A');
  });

  it('mints a new ref when the message id changes (a new message starts a new overlay)', () => {
    const a = streamRefFor(null, null, 'msg_A');
    const b = streamRefFor(a, 'msg_A', 'msg_B');
    expect(b).toBe('msg_B');
    expect(b).not.toBe(a);
  });

  it('falls back to a generated id only when the message id is missing, and does not reuse across missing ids', () => {
    let n = 0;
    const mk = () => `uuid-${++n}`;
    const r1 = streamRefFor(null, null, undefined, mk);
    expect(r1).toBe('uuid-1');
    // prevMsgId is undefined and messageId is undefined: undefined === undefined
    // would wrongly "reuse" without the prevRef guard flow, so assert a fresh
    // id is minted each time there is no stable message id to key on.
    const r2 = streamRefFor(r1, undefined, undefined, mk);
    expect(r2).toBe('uuid-2');
  });

  it('does not carry a ref over from a different previous message even if prevRef is set', () => {
    expect(streamRefFor('msg_A', 'msg_A', 'msg_B')).toBe('msg_B');
  });
});

describe('armReplyRef / settleReplyRef (the ref a flushed reply is published under)', () => {
  // Stand-in for index.js's sendToRoom, which puts the armed ref on the text
  // event it publishes and nulls it in the same synchronous step.
  const publishTextEvent = (session) => {
    const ref = session._journalDurableRef;
    session._journalDurableRef = null;
    return ref;
  };
  const mk = () => 'uuid-1';

  it('a streamed reply is published under its overlay ref, and that ref is remembered', () => {
    const session = { sendCallback() {}, _journalStreamRef: 'msg_A', _journalDurableRef: null };
    const armed = armReplyRef(session, mk);
    expect(armed).toEqual({ ref: 'msg_A', minted: false });
    expect(session._journalDurableRef).toBe('msg_A');
    expect(publishTextEvent(session)).toBe('msg_A');
    expect(settleReplyRef(session, armed)).toBe('msg_A');
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('a reply that was never streamed (iv-mode, Codex exec) gets a fresh ref, so it can be pointed at too', () => {
    const session = { sendCallback() {}, _journalStreamRef: null, _journalDurableRef: null };
    const armed = armReplyRef(session, mk);
    expect(armed).toEqual({ ref: 'uuid-1', minted: true });
    expect(session._journalDurableRef).toBe('uuid-1');
    expect(publishTextEvent(session)).toBe('uuid-1');
    expect(settleReplyRef(session, armed)).toBe('uuid-1');
    expect(session._lastReplyRef).toBe('uuid-1');
  });

  it('mints with randomUUID by default', () => {
    const armed = armReplyRef({ sendCallback() {}, _journalStreamRef: null });
    expect(armed.ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('with no sendCallback nothing is armed, and the remembered ref is cleared: this reply was not published', () => {
    const session = { sendCallback: null, _journalStreamRef: 'msg_A', _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, mk);
    expect(armed).toBeNull();
    expect(session._journalDurableRef).toBeNull();
    expect(settleReplyRef(session, armed)).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });

  it('a minted ref that no text event took is disarmed and not remembered, so it cannot ride a later notice', () => {
    const session = { sendCallback() {}, _journalStreamRef: null, _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, mk);
    // the callback did not publish through sendToRoom for this session
    expect(settleReplyRef(session, armed)).toBeNull();
    expect(session._journalDurableRef).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });

  it('an overlay ref that no text event took stays armed, as before, but is not remembered', () => {
    const session = { sendCallback() {}, _journalStreamRef: 'msg_A', _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, mk);
    expect(settleReplyRef(session, armed)).toBeNull();
    expect(session._journalDurableRef).toBe('msg_A');
    expect(session._lastReplyRef).toBeNull();
  });

  it('a reply the summary pass will not see is not remembered, even when its text event took the ref', () => {
    const session = { sendCallback: () => {}, _journalStreamRef: null, _journalDurableRef: null, _lastReplyRef: 'msg_OLD' };
    const armed = armReplyRef(session, () => 'uuid-9');
    session._journalDurableRef = null; // sendToRoom consumed it
    expect(settleReplyRef(session, armed, { summarised: false })).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });
});
